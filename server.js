const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Check for DATABASE_URL
if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set!');
    process.exit(1);
}

console.log('Starting server...');
console.log('NODE_ENV:', process.env.NODE_ENV);

// PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err);
});

// CRITICAL: Trust proxy - must be before session middleware
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration - ROBUST for Render
app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'ghouenzen-super-secret-key-2025',
    resave: true,
    saveUninitialized: false,
    name: 'sessionId',
    proxy: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
}));

// Serve static files AFTER session middleware
app.use(express.static(path.join(__dirname, 'public')));

// Debug middleware
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
        console.log('  Session ID:', req.sessionID?.substring(0, 8) + '...');
        console.log('  User ID:', req.session?.userId || 'none');
    }
    next();
});

// Initialize Database
async function initDB() {
    let client;
    try {
        client = await pool.connect();
        console.log('Connected to PostgreSQL database');

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

        try {
            await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);
            await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT TRUE`);
        } catch (e) { }

        const adminCheck = await client.query("SELECT id, password_hash FROM users WHERE username = 'admin'");
        if (adminCheck.rows.length === 0) {
            const hash = await bcrypt.hash('12345', 10);
            await client.query(
                `INSERT INTO users (username, email, password_hash, full_name, is_admin, must_change_password)
                 VALUES ('admin', 'admin@ghouenzen.com', $1, 'Administrator', TRUE, TRUE)`,
                [hash]
            );
            console.log('Admin account created (admin/12345)');
        } else {
            const isDefault = await bcrypt.compare('12345', adminCheck.rows[0].password_hash);
            if (isDefault) {
                await client.query(`UPDATE users SET must_change_password = TRUE WHERE username = 'admin'`);
                console.log('Admin must change password');
            }
        }

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

        console.log('Database initialized');
    } catch (err) {
        console.error('DB init error:', err.message);
        throw err;
    } finally {
        if (client) client.release();
    }
}

function requireAuth(req, res, next) {
    if (req.session?.userId) {
        next();
    } else {
        if (req.path.startsWith('/api/')) {
            res.status(401).json({ error: 'Not authenticated' });
        } else {
            res.redirect('/login');
        }
    }
}

function requireAdmin(req, res, next) {
    if (req.session?.userId && req.session?.isAdmin) {
        next();
    } else {
        if (req.path.startsWith('/api/')) {
            res.status(403).json({ error: 'Admin required' });
        } else {
            res.redirect('/dashboard');
        }
    }
}

// LOGIN
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log('Login attempt:', username);

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const result = await pool.query(
            'SELECT * FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)',
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regenerate error:', err);
                return res.status(500).json({ error: 'Session error' });
            }

            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.isAdmin = user.is_admin;
            req.session.mustChangePassword = user.must_change_password;

            req.session.save((err) => {
                if (err) {
                    console.error('Session save error:', err);
                    return res.status(500).json({ error: 'Session error' });
                }

                console.log('Login successful:', username, 'Session:', req.sessionID?.substring(0, 8));
                
                res.json({
                    success: true,
                    user: {
                        id: user.id,
                        username: user.username,
                        full_name: user.full_name,
                        is_admin: user.is_admin,
                        must_change_password: user.must_change_password
                    },
                    redirect: user.must_change_password ? '/change-password' : (user.is_admin ? '/admin' : '/dashboard')
                });
            });
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/auth/status', (req, res) => {
    console.log('Auth status check - userId:', req.session?.userId);
    
    if (req.session?.userId) {
        res.json({
            authenticated: true,
            userId: req.session.userId,
            username: req.session.username,
            isAdmin: req.session.isAdmin,
            mustChangePassword: req.session.mustChangePassword
        });
    } else {
        res.json({ authenticated: false });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        res.clearCookie('sessionId');
        res.json({ success: true });
    });
});

app.get('/api/auth/profile', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, full_name, phone, address, is_admin, must_change_password FROM users WHERE id = $1',
            [req.session.userId]
        );
        res.json(result.rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/auth/profile', requireAuth, async (req, res) => {
    try {
        const { full_name, phone, address } = req.body;
        await pool.query(
            'UPDATE users SET full_name = $1, phone = $2, address = $3 WHERE id = $4',
            [full_name, phone || '', address || '', req.session.userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/auth/password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        
        if (!newPassword || newPassword.length < 5) {
            return res.status(400).json({ error: 'Password must be at least 5 characters' });
        }

        const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
        const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
        
        if (!valid) {
            return res.status(400).json({ error: 'Current password incorrect' });
        }

        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query(
            'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
            [hash, req.session.userId]
        );
        
        req.session.mustChangePassword = false;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/auth/force-password-change', requireAuth, async (req, res) => {
    try {
        const { newPassword } = req.body;
        
        if (!newPassword || newPassword.length < 5) {
            return res.status(400).json({ error: 'Password must be at least 5 characters' });
        }

        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query(
            'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
            [hash, req.session.userId]
        );

        req.session.mustChangePassword = false;
        req.session.save((err) => {
            console.log('Password changed for user:', req.session.userId);
            res.json({ success: true, redirect: req.session.isAdmin ? '/admin' : '/dashboard' });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ADMIN
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, full_name, phone, is_admin, must_change_password, created_at, last_login FROM users ORDER BY id'
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const { username, email, password, full_name, phone, address, is_admin } = req.body;
        const hash = await bcrypt.hash(password || '12345', 10);
        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash, full_name, phone, address, is_admin, must_change_password)
             VALUES (LOWER($1), LOWER($2), $3, $4, $5, $6, $7, TRUE) RETURNING id`,
            [username, email, hash, full_name, phone || '', address || '', is_admin || false]
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const { full_name, email, phone, address, is_admin } = req.body;
        await pool.query(
            'UPDATE users SET full_name = $1, email = LOWER($2), phone = $3, address = $4, is_admin = $5 WHERE id = $6',
            [full_name, email, phone || '', address || '', is_admin || false, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    try {
        const hash = await bcrypt.hash('12345', 10);
        await pool.query(
            'UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2',
            [hash, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        if (parseInt(req.params.id) === req.session.userId) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CREDITORS
app.get('/api/creditors', requireAuth, async (req, res) => {
    try {
        const creditors = await pool.query('SELECT * FROM creditors WHERE user_id = $1 ORDER BY full_name', [req.session.userId]);
        const result = await Promise.all(creditors.rows.map(async (c) => {
            const items = await pool.query('SELECT * FROM creditor_items WHERE creditor_id = $1 ORDER BY id', [c.id]);
            const itemsList = items.rows.map(i => ({ ...i, amount: parseFloat(i.amount) || 0 }));
            return { ...c, items: itemsList, total_amount: itemsList.reduce((s, i) => s + i.amount, 0), pending_amount: itemsList.filter(i => i.status === 'pending').reduce((s, i) => s + i.amount, 0) };
        }));
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/creditors', requireAuth, async (req, res) => {
    try {
        const { full_name, contact, gender, language, items } = req.body;
        const result = await pool.query('INSERT INTO creditors (user_id, full_name, contact, gender, language) VALUES ($1, $2, $3, $4, $5) RETURNING id', [req.session.userId, full_name, contact || '', gender || 'male', language || 'english']);
        const id = result.rows[0].id;
        if (items?.length) for (const item of items) await pool.query('INSERT INTO creditor_items (creditor_id, reason, amount, date_incurred, due_date, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, item.reason || '', item.amount || 0, item.date_incurred || null, item.due_date || null, item.status || 'pending', item.notes || '']);
        res.json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/creditors/:id', requireAuth, async (req, res) => {
    try {
        const { full_name, contact, gender, language, items } = req.body;
        await pool.query('UPDATE creditors SET full_name = $1, contact = $2, gender = $3, language = $4 WHERE id = $5 AND user_id = $6', [full_name, contact || '', gender || 'male', language || 'english', req.params.id, req.session.userId]);
        await pool.query('DELETE FROM creditor_items WHERE creditor_id = $1', [req.params.id]);
        if (items?.length) for (const item of items) await pool.query('INSERT INTO creditor_items (creditor_id, reason, amount, date_incurred, due_date, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)', [req.params.id, item.reason || '', item.amount || 0, item.date_incurred || null, item.due_date || null, item.status || 'pending', item.notes || '']);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/creditors/:id', requireAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM creditor_items WHERE creditor_id = $1', [req.params.id]);
        await pool.query('DELETE FROM creditors WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DEBTORS
app.get('/api/debtors', requireAuth, async (req, res) => {
    try {
        const debtors = await pool.query('SELECT * FROM debtors WHERE user_id = $1 ORDER BY full_name', [req.session.userId]);
        const result = await Promise.all(debtors.rows.map(async (d) => {
            const items = await pool.query('SELECT * FROM debtor_items WHERE debtor_id = $1 ORDER BY id', [d.id]);
            const itemsList = items.rows.map(i => ({ ...i, amount: parseFloat(i.amount) || 0 }));
            return { ...d, items: itemsList, total_amount: itemsList.reduce((s, i) => s + i.amount, 0), pending_amount: itemsList.filter(i => i.status === 'pending').reduce((s, i) => s + i.amount, 0) };
        }));
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/debtors', requireAuth, async (req, res) => {
    try {
        const { full_name, contact, gender, language, items } = req.body;
        const result = await pool.query('INSERT INTO debtors (user_id, full_name, contact, gender, language) VALUES ($1, $2, $3, $4, $5) RETURNING id', [req.session.userId, full_name, contact || '', gender || 'male', language || 'english']);
        const id = result.rows[0].id;
        if (items?.length) for (const item of items) await pool.query('INSERT INTO debtor_items (debtor_id, reason, amount, date_incurred, due_date, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, item.reason || '', item.amount || 0, item.date_incurred || null, item.due_date || null, item.status || 'pending', item.notes || '']);
        res.json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/debtors/:id', requireAuth, async (req, res) => {
    try {
        const { full_name, contact, gender, language, items } = req.body;
        await pool.query('UPDATE debtors SET full_name = $1, contact = $2, gender = $3, language = $4 WHERE id = $5 AND user_id = $6', [full_name, contact || '', gender || 'male', language || 'english', req.params.id, req.session.userId]);
        await pool.query('DELETE FROM debtor_items WHERE debtor_id = $1', [req.params.id]);
        if (items?.length) for (const item of items) await pool.query('INSERT INTO debtor_items (debtor_id, reason, amount, date_incurred, due_date, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)', [req.params.id, item.reason || '', item.amount || 0, item.date_incurred || null, item.due_date || null, item.status || 'pending', item.notes || '']);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/debtors/:id', requireAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM debtor_items WHERE debtor_id = $1', [req.params.id]);
        await pool.query('DELETE FROM debtors WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PAYMENTS
app.get('/api/payments', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM payments WHERE user_id = $1 ORDER BY payment_date DESC', [req.session.userId]);
        res.json(result.rows.map(r => ({ ...r, amount: parseFloat(r.amount) || 0 })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/payments', requireAuth, async (req, res) => {
    try {
        const { type, amount, payment_date, payment_method, reference, notes } = req.body;
        const result = await pool.query('INSERT INTO payments (user_id, type, amount, payment_date, payment_method, reference, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [req.session.userId, type, amount, payment_date || new Date(), payment_method || '', reference || '', notes || '']);
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/payments/:id', requireAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM payments WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// STATS
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
    try {
        const ct = await pool.query(`SELECT COALESCE(SUM(ci.amount), 0) as total FROM creditor_items ci JOIN creditors c ON ci.creditor_id = c.id WHERE c.user_id = $1 AND ci.status = 'pending'`, [req.session.userId]);
        const dt = await pool.query(`SELECT COALESCE(SUM(di.amount), 0) as total FROM debtor_items di JOIN debtors d ON di.debtor_id = d.id WHERE d.user_id = $1 AND di.status = 'pending'`, [req.session.userId]);
        const cc = await pool.query('SELECT COUNT(*) FROM creditors WHERE user_id = $1', [req.session.userId]);
        const dc = await pool.query('SELECT COUNT(*) FROM debtors WHERE user_id = $1', [req.session.userId]);
        res.json({
            total_owed_to_creditors: parseFloat(ct.rows[0].total) || 0,
            total_owed_by_debtors: parseFloat(dt.rows[0].total) || 0,
            net_position: (parseFloat(dt.rows[0].total) || 0) - (parseFloat(ct.rows[0].total) || 0),
            creditor_count: parseInt(cc.rows[0].count) || 0,
            debtor_count: parseInt(dc.rows[0].count) || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PAGE ROUTES
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/change-password', (req, res) => { if (!req.session?.userId) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'public', 'change-password.html')); });
app.get('/dashboard', (req, res) => { if (!req.session?.userId) return res.redirect('/login'); if (req.session.mustChangePassword) return res.redirect('/change-password'); res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/admin', (req, res) => { if (!req.session?.userId) return res.redirect('/login'); if (req.session.mustChangePassword) return res.redirect('/change-password'); if (!req.session.isAdmin) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Start
initDB().then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`))).catch(err => { console.error('Failed:', err); process.exit(1); });
