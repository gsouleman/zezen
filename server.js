const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Debug: Log all environment variables (masked)
console.log('==========================================');
console.log('ENVIRONMENT CHECK:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', process.env.PORT);
console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);
console.log('DATABASE_URL length:', process.env.DATABASE_URL ? process.env.DATABASE_URL.length : 0);
if (process.env.DATABASE_URL) {
    const masked = process.env.DATABASE_URL.substring(0, 20) + '...[MASKED]';
    console.log('DATABASE_URL preview:', masked);
}
console.log('==========================================');

// Check for DATABASE_URL
if (!process.env.DATABASE_URL) {
    console.error('==========================================');
    console.error('ERROR: DATABASE_URL environment variable is not set!');
    console.error('==========================================');
    console.error('Please set DATABASE_URL in your Render environment variables.');
    console.error('Go to: Render Dashboard → Your Web Service → Environment → Add DATABASE_URL');
    console.error('==========================================');
    process.exit(1);
}

console.log('DATABASE_URL is set, attempting connection...');

// PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('render.com') 
        ? { rejectUnauthorized: false } 
        : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err);
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'ghouenzen-secret-key-2025',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
}));

// Initialize Database
async function initDB() {
    let client;
    try {
        client = await pool.connect();
        console.log('Connected to PostgreSQL database');

        // Users table with admin and password change flags
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                address TEXT,
                is_admin BOOLEAN DEFAULT FALSE,
                must_change_password BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        `);

        // Add columns if they don't exist (for existing databases)
        try {
            await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);
            await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT TRUE`);
        } catch (e) {
            console.log('Columns may already exist');
        }

        // Create default admin account if not exists
        const adminCheck = await client.query("SELECT id FROM users WHERE username = 'admin'");
        if (adminCheck.rows.length === 0) {
            const salt = await bcrypt.genSalt(10);
            const defaultPassword = await bcrypt.hash('12345', salt);
            await client.query(`
                INSERT INTO users (username, email, password_hash, full_name, is_admin, must_change_password)
                VALUES ('admin', 'admin@ghouenzen.com', $1, 'Administrator', TRUE, TRUE)
            `, [defaultPassword]);
            console.log('Default admin account created (username: admin, password: 12345)');
        }

        // Creditors table (people the user owes money to)
        await client.query(`
            CREATE TABLE IF NOT EXISTS creditors (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                full_name VARCHAR(255) NOT NULL,
                contact VARCHAR(255),
                gender VARCHAR(10) DEFAULT 'male',
                language VARCHAR(10) DEFAULT 'english',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Creditor items (individual debts to a creditor)
        await client.query(`
            CREATE TABLE IF NOT EXISTS creditor_items (
                id SERIAL PRIMARY KEY,
                creditor_id INTEGER REFERENCES creditors(id) ON DELETE CASCADE,
                reason TEXT,
                amount DECIMAL(15,2) DEFAULT 0,
                date_incurred DATE,
                due_date DATE,
                status VARCHAR(20) DEFAULT 'pending',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Debtors table (people who owe the user money)
        await client.query(`
            CREATE TABLE IF NOT EXISTS debtors (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                full_name VARCHAR(255) NOT NULL,
                contact VARCHAR(255),
                gender VARCHAR(10) DEFAULT 'male',
                language VARCHAR(10) DEFAULT 'english',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Debtor items (individual amounts owed by a debtor)
        await client.query(`
            CREATE TABLE IF NOT EXISTS debtor_items (
                id SERIAL PRIMARY KEY,
                debtor_id INTEGER REFERENCES debtors(id) ON DELETE CASCADE,
                reason TEXT,
                amount DECIMAL(15,2) DEFAULT 0,
                date_incurred DATE,
                due_date DATE,
                status VARCHAR(20) DEFAULT 'pending',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Payments table (track payments made or received)
        await client.query(`
            CREATE TABLE IF NOT EXISTS payments (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                type VARCHAR(20) NOT NULL,
                related_id INTEGER,
                amount DECIMAL(15,2) NOT NULL,
                payment_date DATE DEFAULT CURRENT_DATE,
                payment_method VARCHAR(50),
                reference VARCHAR(100),
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Remove duplicates on startup
        try {
            await client.query(`
                DELETE FROM creditor_items a
                USING creditor_items b
                WHERE a.id > b.id 
                  AND a.creditor_id = b.creditor_id 
                  AND a.amount = b.amount
                  AND COALESCE(a.reason, '') = COALESCE(b.reason, '')
            `);
            await client.query(`
                DELETE FROM debtor_items a
                USING debtor_items b
                WHERE a.id > b.id 
                  AND a.debtor_id = b.debtor_id 
                  AND a.amount = b.amount
                  AND COALESCE(a.reason, '') = COALESCE(b.reason, '')
            `);
        } catch (e) {
            console.log('Duplicate cleanup:', e.message);
        }

        console.log('Database tables initialized successfully');
    } catch (err) {
        console.error('Error initializing database:', err.message);
        throw err;
    } finally {
        if (client) client.release();
    }
}

// Authentication Middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        next();
    } else {
        res.status(401).json({ error: 'Authentication required' });
    }
}

// Admin Middleware
function requireAdmin(req, res, next) {
    if (req.session && req.session.userId && req.session.isAdmin) {
        next();
    } else {
        res.status(403).json({ error: 'Admin access required' });
    }
}

// ============================================
// AUTH ROUTES
// ============================================

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        // Find user
        const result = await pool.query(
            'SELECT * FROM users WHERE username = $1 OR email = $1',
            [username.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];

        // Verify password
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login
        await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

        // Set session
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.isAdmin = user.is_admin;

        res.json({ 
            message: 'Login successful', 
            user: { 
                id: user.id, 
                username: user.username, 
                full_name: user.full_name, 
                email: user.email,
                is_admin: user.is_admin,
                must_change_password: user.must_change_password
            } 
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.json({ message: 'Logged out successfully' });
    });
});

// Check auth status
app.get('/api/auth/status', async (req, res) => {
    if (req.session && req.session.userId) {
        try {
            const result = await pool.query(
                'SELECT must_change_password, is_admin FROM users WHERE id = $1',
                [req.session.userId]
            );
            if (result.rows.length > 0) {
                res.json({ 
                    authenticated: true, 
                    userId: req.session.userId, 
                    username: req.session.username,
                    isAdmin: result.rows[0].is_admin,
                    mustChangePassword: result.rows[0].must_change_password
                });
            } else {
                res.json({ authenticated: false });
            }
        } catch (err) {
            res.json({ authenticated: false });
        }
    } else {
        res.json({ authenticated: false });
    }
});

// Get current user profile
app.get('/api/auth/profile', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, full_name, phone, address, is_admin, must_change_password, created_at, last_login FROM users WHERE id = $1',
            [req.session.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update profile
app.put('/api/auth/profile', requireAuth, async (req, res) => {
    try {
        const { full_name, phone, address } = req.body;
        await pool.query(
            'UPDATE users SET full_name = $1, phone = $2, address = $3 WHERE id = $4',
            [full_name, phone || '', address || '', req.session.userId]
        );
        res.json({ message: 'Profile updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Change password (also clears must_change_password flag)
app.put('/api/auth/password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        
        if (!newPassword || newPassword.length < 5) {
            return res.status(400).json({ error: 'New password must be at least 5 characters' });
        }
        
        const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
        const isValid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
        
        if (!isValid) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }

        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(newPassword, salt);
        
        // Update password and clear must_change_password flag
        await pool.query(
            'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', 
            [newHash, req.session.userId]
        );
        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Force password change (for first login)
app.put('/api/auth/force-password-change', requireAuth, async (req, res) => {
    try {
        const { newPassword } = req.body;
        
        if (!newPassword || newPassword.length < 5) {
            return res.status(400).json({ error: 'New password must be at least 5 characters' });
        }

        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(newPassword, salt);
        
        await pool.query(
            'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', 
            [newHash, req.session.userId]
        );
        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// ADMIN ROUTES - User Management
// ============================================

// Get all users (admin only)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, full_name, phone, is_admin, must_change_password, created_at, last_login FROM users ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create user (admin only)
app.post('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const { username, email, password, full_name, phone, address, is_admin } = req.body;
        
        if (!username || !email || !password || !full_name) {
            return res.status(400).json({ error: 'All required fields must be filled' });
        }

        // Check if user exists
        const existingUser = await pool.query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username.toLowerCase(), email.toLowerCase()]
        );
        
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Create user with must_change_password = true
        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash, full_name, phone, address, is_admin, must_change_password) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) RETURNING id, username, email, full_name`,
            [username.toLowerCase(), email.toLowerCase(), passwordHash, full_name, phone || '', address || '', is_admin || false]
        );

        res.json({ message: 'User created successfully', user: result.rows[0] });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Update user (admin only)
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const { full_name, email, phone, address, is_admin } = req.body;
        
        await pool.query(
            'UPDATE users SET full_name = $1, email = $2, phone = $3, address = $4, is_admin = $5 WHERE id = $6',
            [full_name, email.toLowerCase(), phone || '', address || '', is_admin || false, req.params.id]
        );
        res.json({ message: 'User updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reset user password (admin only)
app.put('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    try {
        const { newPassword } = req.body;
        
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(newPassword || '12345', salt);
        
        await pool.query(
            'UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2',
            [passwordHash, req.params.id]
        );
        res.json({ message: 'Password reset successfully. User must change password on next login.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete user (admin only)
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        // Prevent deleting self
        if (parseInt(req.params.id) === req.session.userId) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ message: 'User deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// CREDITORS ROUTES (People you owe)
// ============================================

app.get('/api/creditors', requireAuth, async (req, res) => {
    try {
        const creditorsResult = await pool.query(
            'SELECT * FROM creditors WHERE user_id = $1 ORDER BY full_name',
            [req.session.userId]
        );
        
        const creditors = await Promise.all(creditorsResult.rows.map(async (creditor) => {
            const itemsResult = await pool.query(
                'SELECT * FROM creditor_items WHERE creditor_id = $1 ORDER BY id',
                [creditor.id]
            );
            const items = itemsResult.rows.map(item => ({
                ...item,
                amount: parseFloat(item.amount) || 0
            }));
            const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);
            const pendingAmount = items.filter(i => i.status === 'pending').reduce((sum, item) => sum + item.amount, 0);
            return {
                ...creditor,
                items,
                total_amount: totalAmount,
                pending_amount: pendingAmount
            };
        }));
        
        res.json(creditors);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/creditors', requireAuth, async (req, res) => {
    try {
        const { full_name, contact, gender, language, items } = req.body;
        
        const result = await pool.query(
            'INSERT INTO creditors (user_id, full_name, contact, gender, language) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [req.session.userId, full_name, contact || '', gender || 'male', language || 'english']
        );
        const creditorId = result.rows[0].id;
        
        if (items && items.length > 0) {
            for (const item of items) {
                await pool.query(
                    `INSERT INTO creditor_items (creditor_id, reason, amount, date_incurred, due_date, status, notes) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [creditorId, item.reason || '', item.amount || 0, item.date_incurred || null, item.due_date || null, item.status || 'pending', item.notes || '']
                );
            }
        }
        
        res.json({ id: creditorId, message: 'Creditor added successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/creditors/:id', requireAuth, async (req, res) => {
    try {
        const { full_name, contact, gender, language, items } = req.body;
        
        // Verify ownership
        const check = await pool.query('SELECT id FROM creditors WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Creditor not found' });
        }
        
        await pool.query(
            'UPDATE creditors SET full_name = $1, contact = $2, gender = $3, language = $4 WHERE id = $5',
            [full_name, contact || '', gender || 'male', language || 'english', req.params.id]
        );
        
        await pool.query('DELETE FROM creditor_items WHERE creditor_id = $1', [req.params.id]);
        
        if (items && items.length > 0) {
            for (const item of items) {
                await pool.query(
                    `INSERT INTO creditor_items (creditor_id, reason, amount, date_incurred, due_date, status, notes) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [req.params.id, item.reason || '', item.amount || 0, item.date_incurred || null, item.due_date || null, item.status || 'pending', item.notes || '']
                );
            }
        }
        
        res.json({ message: 'Creditor updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/creditors/:id', requireAuth, async (req, res) => {
    try {
        const check = await pool.query('SELECT id FROM creditors WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Creditor not found' });
        }
        
        await pool.query('DELETE FROM creditor_items WHERE creditor_id = $1', [req.params.id]);
        await pool.query('DELETE FROM creditors WHERE id = $1', [req.params.id]);
        res.json({ message: 'Creditor deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// DEBTORS ROUTES (People who owe you)
// ============================================

app.get('/api/debtors', requireAuth, async (req, res) => {
    try {
        const debtorsResult = await pool.query(
            'SELECT * FROM debtors WHERE user_id = $1 ORDER BY full_name',
            [req.session.userId]
        );
        
        const debtors = await Promise.all(debtorsResult.rows.map(async (debtor) => {
            const itemsResult = await pool.query(
                'SELECT * FROM debtor_items WHERE debtor_id = $1 ORDER BY id',
                [debtor.id]
            );
            const items = itemsResult.rows.map(item => ({
                ...item,
                amount: parseFloat(item.amount) || 0
            }));
            const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);
            const pendingAmount = items.filter(i => i.status === 'pending').reduce((sum, item) => sum + item.amount, 0);
            return {
                ...debtor,
                items,
                total_amount: totalAmount,
                pending_amount: pendingAmount
            };
        }));
        
        res.json(debtors);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/debtors', requireAuth, async (req, res) => {
    try {
        const { full_name, contact, gender, language, items } = req.body;
        
        const result = await pool.query(
            'INSERT INTO debtors (user_id, full_name, contact, gender, language) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [req.session.userId, full_name, contact || '', gender || 'male', language || 'english']
        );
        const debtorId = result.rows[0].id;
        
        if (items && items.length > 0) {
            for (const item of items) {
                await pool.query(
                    `INSERT INTO debtor_items (debtor_id, reason, amount, date_incurred, due_date, status, notes) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [debtorId, item.reason || '', item.amount || 0, item.date_incurred || null, item.due_date || null, item.status || 'pending', item.notes || '']
                );
            }
        }
        
        res.json({ id: debtorId, message: 'Debtor added successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/debtors/:id', requireAuth, async (req, res) => {
    try {
        const { full_name, contact, gender, language, items } = req.body;
        
        const check = await pool.query('SELECT id FROM debtors WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Debtor not found' });
        }
        
        await pool.query(
            'UPDATE debtors SET full_name = $1, contact = $2, gender = $3, language = $4 WHERE id = $5',
            [full_name, contact || '', gender || 'male', language || 'english', req.params.id]
        );
        
        await pool.query('DELETE FROM debtor_items WHERE debtor_id = $1', [req.params.id]);
        
        if (items && items.length > 0) {
            for (const item of items) {
                await pool.query(
                    `INSERT INTO debtor_items (debtor_id, reason, amount, date_incurred, due_date, status, notes) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [req.params.id, item.reason || '', item.amount || 0, item.date_incurred || null, item.due_date || null, item.status || 'pending', item.notes || '']
                );
            }
        }
        
        res.json({ message: 'Debtor updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/debtors/:id', requireAuth, async (req, res) => {
    try {
        const check = await pool.query('SELECT id FROM debtors WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Debtor not found' });
        }
        
        await pool.query('DELETE FROM debtor_items WHERE debtor_id = $1', [req.params.id]);
        await pool.query('DELETE FROM debtors WHERE id = $1', [req.params.id]);
        res.json({ message: 'Debtor deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// PAYMENTS ROUTES
// ============================================

app.get('/api/payments', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM payments WHERE user_id = $1 ORDER BY payment_date DESC, created_at DESC',
            [req.session.userId]
        );
        res.json(result.rows.map(r => ({ ...r, amount: parseFloat(r.amount) || 0 })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/payments', requireAuth, async (req, res) => {
    try {
        const { type, related_id, amount, payment_date, payment_method, reference, notes } = req.body;
        
        const result = await pool.query(
            `INSERT INTO payments (user_id, type, related_id, amount, payment_date, payment_method, reference, notes) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [req.session.userId, type, related_id || null, amount, payment_date || new Date(), payment_method || '', reference || '', notes || '']
        );
        
        res.json({ id: result.rows[0].id, message: 'Payment recorded successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/payments/:id', requireAuth, async (req, res) => {
    try {
        const check = await pool.query('SELECT id FROM payments WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Payment not found' });
        }
        
        await pool.query('DELETE FROM payments WHERE id = $1', [req.params.id]);
        res.json({ message: 'Payment deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// DASHBOARD STATS
// ============================================

app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
    try {
        // Total owed to creditors
        const creditorTotal = await pool.query(`
            SELECT COALESCE(SUM(ci.amount), 0) as total
            FROM creditor_items ci
            JOIN creditors c ON ci.creditor_id = c.id
            WHERE c.user_id = $1 AND ci.status = 'pending'
        `, [req.session.userId]);

        // Total owed by debtors
        const debtorTotal = await pool.query(`
            SELECT COALESCE(SUM(di.amount), 0) as total
            FROM debtor_items di
            JOIN debtors d ON di.debtor_id = d.id
            WHERE d.user_id = $1 AND di.status = 'pending'
        `, [req.session.userId]);

        // Count of creditors and debtors
        const creditorCount = await pool.query('SELECT COUNT(*) FROM creditors WHERE user_id = $1', [req.session.userId]);
        const debtorCount = await pool.query('SELECT COUNT(*) FROM debtors WHERE user_id = $1', [req.session.userId]);

        // Recent payments
        const recentPayments = await pool.query(
            'SELECT * FROM payments WHERE user_id = $1 ORDER BY payment_date DESC LIMIT 5',
            [req.session.userId]
        );

        res.json({
            total_owed_to_creditors: parseFloat(creditorTotal.rows[0].total) || 0,
            total_owed_by_debtors: parseFloat(debtorTotal.rows[0].total) || 0,
            net_position: (parseFloat(debtorTotal.rows[0].total) || 0) - (parseFloat(creditorTotal.rows[0].total) || 0),
            creditor_count: parseInt(creditorCount.rows[0].count) || 0,
            debtor_count: parseInt(debtorCount.rows[0].count) || 0,
            recent_payments: recentPayments.rows.map(r => ({ ...r, amount: parseFloat(r.amount) || 0 }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// PAGE ROUTES
// ============================================

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/change-password', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'change-password.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize and start
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
