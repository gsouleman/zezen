// Dashboard JavaScript

let creditors = [];
let debtors = [];
let payments = [];
let currentUser = null;

// Helper function for fetch with credentials
async function apiFetch(url, options = {}) {
    const defaultOptions = {
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    };
    return fetch(url, { ...defaultOptions, ...options });
}

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
    // Check authentication
    try {
        const authRes = await apiFetch('/api/auth/status');
        const authStatus = await authRes.json();
        console.log('Dashboard auth status:', authStatus);
        
        if (!authStatus.authenticated) {
            window.location.href = '/login';
            return;
        }
        
        if (authStatus.mustChangePassword) {
            window.location.href = '/change-password';
            return;
        }
    } catch (err) {
        console.error('Auth check failed:', err);
        window.location.href = '/login';
        return;
    }

    // Load user profile
    await loadProfile();
    
    // Set current date
    document.getElementById('current-date').textContent = new Date().toLocaleDateString('en-GB', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    // Setup navigation
    setupNavigation();
    
    // Load data
    await loadDashboardData();
    
    // Setup logout
    document.getElementById('logout-btn').addEventListener('click', logout);
    
    // Setup forms
    document.getElementById('profile-form').addEventListener('submit', updateProfile);
    document.getElementById('password-form').addEventListener('submit', changePassword);
});

// ============================================
// NAVIGATION
// ============================================

function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const viewAllLinks = document.querySelectorAll('.view-all');
    
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const section = item.dataset.section;
            switchSection(section);
        });
    });
    
    viewAllLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const section = link.dataset.section;
            switchSection(section);
        });
    });
}

function switchSection(sectionName) {
    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.section === sectionName);
    });
    
    // Update sections
    document.querySelectorAll('.section').forEach(section => {
        section.classList.toggle('active', section.id === `section-${sectionName}`);
    });
    
    // Update header
    const titles = {
        overview: 'Overview',
        creditors: 'Creditors (People I Owe)',
        debtors: 'Debtors (People Who Owe Me)',
        payments: 'Payment History',
        profile: 'Profile Settings'
    };
    document.getElementById('page-title').textContent = titles[sectionName] || sectionName;
}

// ============================================
// DATA LOADING
// ============================================

async function loadDashboardData() {
    try {
        await Promise.all([
            loadCreditors(),
            loadDebtors(),
            loadPayments(),
            loadStats()
        ]);
    } catch (err) {
        console.error('Error loading data:', err);
    }
}

async function loadStats() {
    try {
        const res = await apiFetch('/api/dashboard/stats');
        const stats = await res.json();
        
        document.getElementById('stat-creditors').textContent = formatCurrency(stats.total_owed_to_creditors);
        document.getElementById('stat-debtors').textContent = formatCurrency(stats.total_owed_by_debtors);
        document.getElementById('stat-net').textContent = formatCurrency(stats.net_position);
        document.getElementById('stat-contacts').textContent = stats.creditor_count + stats.debtor_count;
    } catch (err) {
        console.error('Error loading stats:', err);
    }
}

async function loadCreditors() {
    try {
        const res = await apiFetch('/api/creditors');
        creditors = await res.json();
        renderCreditorsTable();
        renderRecentCreditors();
    } catch (err) {
        console.error('Error loading creditors:', err);
    }
}

async function loadDebtors() {
    try {
        const res = await apiFetch('/api/debtors');
        debtors = await res.json();
        renderDebtorsTable();
        renderRecentDebtors();
    } catch (err) {
        console.error('Error loading debtors:', err);
    }
}

async function loadPayments() {
    try {
        const res = await apiFetch('/api/payments');
        payments = await res.json();
        renderPaymentsTable();
    } catch (err) {
        console.error('Error loading payments:', err);
    }
}

async function loadProfile() {
    try {
        const res = await apiFetch('/api/auth/profile');
        currentUser = await res.json();
        document.getElementById('user-name').textContent = currentUser.full_name;
        document.getElementById('profile-name').value = currentUser.full_name;
        document.getElementById('profile-phone').value = currentUser.phone || '';
        document.getElementById('profile-address').value = currentUser.address || '';
    } catch (err) {
        console.error('Error loading profile:', err);
    }
}

// ============================================
// RENDERING
// ============================================

function renderCreditorsTable() {
    const tbody = document.getElementById('creditors-table');
    
    if (creditors.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No creditors found. Click "Add Creditor" to add one.</td></tr>';
        return;
    }
    
    tbody.innerHTML = creditors.map(c => `
        <tr>
            <td><strong>${c.full_name}</strong></td>
            <td>${c.contact || '-'}</td>
            <td>${formatCurrency(c.total_amount)}</td>
            <td><span style="color: var(--red)">${formatCurrency(c.pending_amount)}</span></td>
            <td>
                <div class="table-actions">
                    <button class="action-btn view" onclick="viewCreditorStatement(${c.id})">Statement</button>
                    <button class="action-btn edit" onclick="editCreditor(${c.id})">Edit</button>
                    <button class="action-btn delete" onclick="deleteCreditor(${c.id})">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderDebtorsTable() {
    const tbody = document.getElementById('debtors-table');
    
    if (debtors.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No debtors found. Click "Add Debtor" to add one.</td></tr>';
        return;
    }
    
    tbody.innerHTML = debtors.map(d => `
        <tr>
            <td><strong>${d.full_name}</strong></td>
            <td>${d.contact || '-'}</td>
            <td>${formatCurrency(d.total_amount)}</td>
            <td><span style="color: var(--green)">${formatCurrency(d.pending_amount)}</span></td>
            <td>
                <div class="table-actions">
                    <button class="action-btn view" onclick="viewDebtorStatement(${d.id})">Statement</button>
                    <button class="action-btn edit" onclick="editDebtor(${d.id})">Edit</button>
                    <button class="action-btn delete" onclick="deleteDebtor(${d.id})">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderPaymentsTable() {
    const tbody = document.getElementById('payments-table');
    
    if (payments.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No payments recorded. Click "Record Payment" to add one.</td></tr>';
        return;
    }
    
    tbody.innerHTML = payments.map(p => `
        <tr>
            <td>${new Date(p.payment_date).toLocaleDateString()}</td>
            <td>${p.type === 'paid' ? 'Paid Out' : 'Received'}</td>
            <td style="color: ${p.type === 'paid' ? 'var(--red)' : 'var(--green)'}">${formatCurrency(p.amount)}</td>
            <td>${p.payment_method || '-'}</td>
            <td>${p.reference || '-'}</td>
            <td>
                <div class="table-actions">
                    <button class="action-btn delete" onclick="deletePayment(${p.id})">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderRecentCreditors() {
    const container = document.getElementById('recent-creditors');
    const recent = creditors.slice(0, 5);
    
    if (recent.length === 0) {
        container.innerHTML = '<p class="empty-state">No creditors yet</p>';
        return;
    }
    
    container.innerHTML = recent.map(c => `
        <div class="recent-item">
            <div class="recent-item-info">
                <span class="recent-item-name">${c.full_name}</span>
                <span class="recent-item-detail">${c.items?.length || 0} items</span>
            </div>
            <span class="recent-item-amount owed">${formatCurrency(c.pending_amount)}</span>
        </div>
    `).join('');
}

function renderRecentDebtors() {
    const container = document.getElementById('recent-debtors');
    const recent = debtors.slice(0, 5);
    
    if (recent.length === 0) {
        container.innerHTML = '<p class="empty-state">No debtors yet</p>';
        return;
    }
    
    container.innerHTML = recent.map(d => `
        <div class="recent-item">
            <div class="recent-item-info">
                <span class="recent-item-name">${d.full_name}</span>
                <span class="recent-item-detail">${d.items?.length || 0} items</span>
            </div>
            <span class="recent-item-amount receivable">${formatCurrency(d.pending_amount)}</span>
        </div>
    `).join('');
}

// ============================================
// MODAL HANDLING
// ============================================

function openModal(type, data = null) {
    const modal = document.getElementById('modal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    
    const isEdit = data !== null;
    
    if (type === 'creditor') {
        title.textContent = isEdit ? 'Edit Creditor' : 'Add Creditor';
        body.innerHTML = getCreditorDebtorForm('creditor', isEdit, data);
    } else if (type === 'debtor') {
        title.textContent = isEdit ? 'Edit Debtor' : 'Add Debtor';
        body.innerHTML = getCreditorDebtorForm('debtor', isEdit, data);
    } else if (type === 'payment') {
        title.textContent = 'Record Payment';
        body.innerHTML = getPaymentForm();
    }
    
    modal.classList.add('active');
    
    // Fill form if editing
    if (data && (type === 'creditor' || type === 'debtor')) {
        setTimeout(() => fillForm(type, data), 50);
    }
    
    // Setup line items
    if (type === 'creditor' || type === 'debtor') {
        setTimeout(() => {
            document.querySelectorAll('.item-amount').forEach(input => {
                input.addEventListener('input', updateItemsTotal);
            });
        }, 100);
    }
}

function closeModal() {
    document.getElementById('modal').classList.remove('active');
}

function getCreditorDebtorForm(type, isEdit, data) {
    const itemsHtml = data?.items?.length > 0 
        ? data.items.map((item, idx) => getLineItemHtml(idx, item)).join('')
        : getLineItemHtml(0);
    
    return `
        <form id="modal-form" class="form" onsubmit="handleFormSubmit(event, '${type}', ${data?.id || 'null'})">
            <div class="form-row">
                <div class="form-group">
                    <label>Full Name *</label>
                    <input type="text" id="f-name" required>
                </div>
                <div class="form-group">
                    <label>Contact</label>
                    <input type="text" id="f-contact">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Gender</label>
                    <select id="f-gender">
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Statement Language</label>
                    <select id="f-language">
                        <option value="english">English</option>
                        <option value="french">French</option>
                    </select>
                </div>
            </div>
            
            <div class="line-items-section">
                <div class="line-items-header">
                    <h4>Debt Items</h4>
                    <button type="button" class="btn btn-sm btn-outline" onclick="addLineItem()">+ Add Item</button>
                </div>
                <div id="line-items-container">
                    ${itemsHtml}
                </div>
                <div class="line-items-total">
                    Total: <span id="items-total">0 XAF</span>
                </div>
            </div>
            
            <button type="submit" class="btn btn-primary">${isEdit ? 'Update' : 'Add'} ${type === 'creditor' ? 'Creditor' : 'Debtor'}</button>
        </form>
    `;
}

function getLineItemHtml(index, item = null) {
    return `
        <div class="line-item" data-index="${index}">
            ${index > 0 ? `<div class="line-item-header"><span>Item ${index + 1}</span><button type="button" class="btn-remove-item" onclick="removeLineItem(this)">×</button></div>` : ''}
            <div class="form-row">
                <div class="form-group">
                    <label>Reason</label>
                    <input type="text" class="item-reason" value="${item?.reason || ''}">
                </div>
                <div class="form-group">
                    <label>Amount (XAF) *</label>
                    <input type="number" class="item-amount" value="${item?.amount || ''}" required>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Date Incurred</label>
                    <input type="date" class="item-date" value="${item?.date_incurred?.split('T')[0] || ''}">
                </div>
                <div class="form-group">
                    <label>Status</label>
                    <select class="item-status">
                        <option value="pending" ${item?.status === 'pending' ? 'selected' : ''}>Pending</option>
                        <option value="partial" ${item?.status === 'partial' ? 'selected' : ''}>Partial</option>
                        <option value="paid" ${item?.status === 'paid' ? 'selected' : ''}>Paid</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label>Notes</label>
                <input type="text" class="item-notes" value="${item?.notes || ''}">
            </div>
        </div>
    `;
}

function getPaymentForm() {
    return `
        <form id="modal-form" class="form" onsubmit="handlePaymentSubmit(event)">
            <div class="form-row">
                <div class="form-group">
                    <label>Type *</label>
                    <select id="f-type" required>
                        <option value="paid">Paid Out (to Creditor)</option>
                        <option value="received">Received (from Debtor)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Amount (XAF) *</label>
                    <input type="number" id="f-amount" required>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Date *</label>
                    <input type="date" id="f-date" value="${new Date().toISOString().split('T')[0]}" required>
                </div>
                <div class="form-group">
                    <label>Method</label>
                    <select id="f-method">
                        <option value="">Select...</option>
                        <option value="cash">Cash</option>
                        <option value="bank">Bank Transfer</option>
                        <option value="mobile">Mobile Money</option>
                        <option value="check">Check</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label>Reference</label>
                <input type="text" id="f-reference" placeholder="Transaction reference">
            </div>
            <div class="form-group">
                <label>Notes</label>
                <textarea id="f-notes" rows="2"></textarea>
            </div>
            <button type="submit" class="btn btn-primary">Record Payment</button>
        </form>
    `;
}

function addLineItem() {
    const container = document.getElementById('line-items-container');
    const index = container.children.length;
    container.insertAdjacentHTML('beforeend', getLineItemHtml(index));
    
    const newAmountInput = container.lastElementChild.querySelector('.item-amount');
    newAmountInput.addEventListener('input', updateItemsTotal);
}

function removeLineItem(btn) {
    const container = document.getElementById('line-items-container');
    if (container.children.length > 1) {
        btn.closest('.line-item').remove();
        updateItemsTotal();
    } else {
        showToast('At least one item is required', 'error');
    }
}

function updateItemsTotal() {
    let total = 0;
    document.querySelectorAll('.item-amount').forEach(input => {
        total += parseFloat(input.value) || 0;
    });
    document.getElementById('items-total').textContent = formatCurrency(total);
}

function fillForm(type, data) {
    document.getElementById('f-name').value = data.full_name;
    document.getElementById('f-contact').value = data.contact || '';
    document.getElementById('f-gender').value = data.gender || 'male';
    document.getElementById('f-language').value = data.language || 'english';
    updateItemsTotal();
}

function getLineItems() {
    const items = [];
    document.querySelectorAll('.line-item').forEach(item => {
        items.push({
            reason: item.querySelector('.item-reason').value,
            amount: parseFloat(item.querySelector('.item-amount').value) || 0,
            date_incurred: item.querySelector('.item-date').value || null,
            status: item.querySelector('.item-status').value,
            notes: item.querySelector('.item-notes').value
        });
    });
    return items;
}

// ============================================
// FORM HANDLERS
// ============================================

async function handleFormSubmit(e, type, id) {
    e.preventDefault();
    
    const data = {
        full_name: document.getElementById('f-name').value,
        contact: document.getElementById('f-contact').value,
        gender: document.getElementById('f-gender').value,
        language: document.getElementById('f-language').value,
        items: getLineItems()
    };
    
    try {
        const endpoint = `/api/${type}s${id ? '/' + id : ''}`;
        const method = id ? 'PUT' : 'POST';
        
        const res = await fetch(endpoint, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (res.ok) {
            showToast(`${type === 'creditor' ? 'Creditor' : 'Debtor'} ${id ? 'updated' : 'added'} successfully`);
            closeModal();
            await loadDashboardData();
        } else {
            const err = await res.json();
            showToast(err.error || 'Error saving', 'error');
        }
    } catch (err) {
        showToast('Error saving', 'error');
    }
}

async function handlePaymentSubmit(e) {
    e.preventDefault();
    
    const data = {
        type: document.getElementById('f-type').value,
        amount: parseFloat(document.getElementById('f-amount').value),
        payment_date: document.getElementById('f-date').value,
        payment_method: document.getElementById('f-method').value,
        reference: document.getElementById('f-reference').value,
        notes: document.getElementById('f-notes').value
    };
    
    try {
        const res = await fetch('/api/payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (res.ok) {
            showToast('Payment recorded successfully');
            closeModal();
            await loadDashboardData();
        } else {
            const err = await res.json();
            showToast(err.error || 'Error saving', 'error');
        }
    } catch (err) {
        showToast('Error saving', 'error');
    }
}

// ============================================
// CRUD OPERATIONS
// ============================================

function editCreditor(id) {
    const creditor = creditors.find(c => c.id === id);
    if (creditor) openModal('creditor', creditor);
}

function editDebtor(id) {
    const debtor = debtors.find(d => d.id === id);
    if (debtor) openModal('debtor', debtor);
}

async function deleteCreditor(id) {
    if (!confirm('Are you sure you want to delete this creditor?')) return;
    
    try {
        const res = await fetch(`/api/creditors/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Creditor deleted');
            await loadDashboardData();
        }
    } catch (err) {
        showToast('Error deleting', 'error');
    }
}

async function deleteDebtor(id) {
    if (!confirm('Are you sure you want to delete this debtor?')) return;
    
    try {
        const res = await fetch(`/api/debtors/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Debtor deleted');
            await loadDashboardData();
        }
    } catch (err) {
        showToast('Error deleting', 'error');
    }
}

async function deletePayment(id) {
    if (!confirm('Are you sure you want to delete this payment?')) return;
    
    try {
        const res = await fetch(`/api/payments/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Payment deleted');
            await loadDashboardData();
        }
    } catch (err) {
        showToast('Error deleting', 'error');
    }
}

// ============================================
// STATEMENTS
// ============================================

function viewCreditorStatement(id) {
    const creditor = creditors.find(c => c.id === id);
    if (!creditor) return;
    
    const modal = document.getElementById('statement-modal');
    const content = document.getElementById('statement-content');
    content.innerHTML = generateCreditorStatement(creditor);
    modal.classList.add('active');
}

function viewDebtorStatement(id) {
    const debtor = debtors.find(d => d.id === id);
    if (!debtor) return;
    
    const modal = document.getElementById('statement-modal');
    const content = document.getElementById('statement-content');
    content.innerHTML = generateDebtorStatement(debtor);
    modal.classList.add('active');
}

function closeStatementModal() {
    document.getElementById('statement-modal').classList.remove('active');
}

function printStatement() {
    window.print();
}

function generateCreditorStatement(creditor) {
    const lang = creditor.language || 'english';
    const title = creditor.gender === 'female' ? (lang === 'french' ? 'Mme' : 'Mrs.') : (lang === 'french' ? 'M.' : 'Mr.');
    const today = new Date().toLocaleDateString(lang === 'french' ? 'fr-FR' : 'en-GB', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    
    const itemsHtml = creditor.items?.length > 0 ? `
        <table class="items-table">
            <thead>
                <tr>
                    <th>#</th>
                    <th>${lang === 'french' ? 'Motif' : 'Reason'}</th>
                    <th>${lang === 'french' ? 'Montant' : 'Amount'}</th>
                    <th>${lang === 'french' ? 'Statut' : 'Status'}</th>
                </tr>
            </thead>
            <tbody>
                ${creditor.items.map((item, idx) => `
                    <tr>
                        <td>${idx + 1}</td>
                        <td>${item.reason || '-'}</td>
                        <td style="text-align: right">${formatCurrency(item.amount)}</td>
                        <td>${item.status}</td>
                    </tr>
                `).join('')}
            </tbody>
            <tfoot>
                <tr style="font-weight: bold; background: #f0f0f0">
                    <td colspan="2">TOTAL</td>
                    <td style="text-align: right">${formatCurrency(creditor.total_amount)}</td>
                    <td></td>
                </tr>
            </tfoot>
        </table>
    ` : '';
    
    if (lang === 'french') {
        return `
            <div class="print-statement">
                <div class="letterhead"><h2>RELEVÉ DE CONFIRMATION DE DETTE</h2></div>
                <div class="date-line"><strong>Date:</strong> ${today}</div>
                <div class="recipient"><p><strong>À:</strong> ${title} ${creditor.full_name}</p></div>
                <div class="body-text">
                    <p>Cher/Chère ${title} ${creditor.full_name},</p>
                    <p>Cette lettre constitue une reconnaissance formelle de la dette que je, 
                    <strong>${currentUser?.full_name || ''}</strong>, vous dois.</p>
                </div>
                ${itemsHtml}
                <div class="amount-box">
                    <p><strong>Montant total dû:</strong></p>
                    <p class="amount-numeric">${formatCurrency(creditor.total_amount)}</p>
                </div>
                <div class="signature-area">
                    <p><strong>Signature:</strong> <span class="sig-line"></span></p>
                    <p><strong>Date:</strong> <span class="sig-line"></span></p>
                </div>
            </div>
        `;
    }
    
    return `
        <div class="print-statement">
            <div class="letterhead"><h2>DEBT CONFIRMATION STATEMENT</h2></div>
            <div class="date-line"><strong>Date:</strong> ${today}</div>
            <div class="recipient"><p><strong>To:</strong> ${title} ${creditor.full_name}</p></div>
            <div class="body-text">
                <p>Dear ${title} ${creditor.full_name},</p>
                <p>This letter serves as a formal acknowledgment of the debt that I, 
                <strong>${currentUser?.full_name || ''}</strong>, owe to you.</p>
            </div>
            ${itemsHtml}
            <div class="amount-box">
                <p><strong>Total Amount Owed:</strong></p>
                <p class="amount-numeric">${formatCurrency(creditor.total_amount)}</p>
            </div>
            <div class="signature-area">
                <p><strong>Signature:</strong> <span class="sig-line"></span></p>
                <p><strong>Date:</strong> <span class="sig-line"></span></p>
            </div>
        </div>
    `;
}

function generateDebtorStatement(debtor) {
    const lang = debtor.language || 'english';
    const title = debtor.gender === 'female' ? (lang === 'french' ? 'Mme' : 'Mrs.') : (lang === 'french' ? 'M.' : 'Mr.');
    const today = new Date().toLocaleDateString(lang === 'french' ? 'fr-FR' : 'en-GB', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    
    const itemsHtml = debtor.items?.length > 0 ? `
        <table class="items-table">
            <thead>
                <tr>
                    <th>#</th>
                    <th>${lang === 'french' ? 'Motif' : 'Reason'}</th>
                    <th>${lang === 'french' ? 'Montant' : 'Amount'}</th>
                    <th>${lang === 'french' ? 'Statut' : 'Status'}</th>
                </tr>
            </thead>
            <tbody>
                ${debtor.items.map((item, idx) => `
                    <tr>
                        <td>${idx + 1}</td>
                        <td>${item.reason || '-'}</td>
                        <td style="text-align: right">${formatCurrency(item.amount)}</td>
                        <td>${item.status}</td>
                    </tr>
                `).join('')}
            </tbody>
            <tfoot>
                <tr style="font-weight: bold; background: #f0f0f0">
                    <td colspan="2">TOTAL</td>
                    <td style="text-align: right">${formatCurrency(debtor.total_amount)}</td>
                    <td></td>
                </tr>
            </tfoot>
        </table>
    ` : '';
    
    if (lang === 'french') {
        return `
            <div class="print-statement">
                <div class="letterhead"><h2>RELEVÉ DE CRÉANCE</h2></div>
                <div class="date-line"><strong>Date:</strong> ${today}</div>
                <div class="recipient"><p><strong>À:</strong> ${title} ${debtor.full_name}</p></div>
                <div class="body-text">
                    <p>Cher/Chère ${title} ${debtor.full_name},</p>
                    <p>Cette lettre constitue un relevé formel de la créance que vous devez à 
                    <strong>${currentUser?.full_name || ''}</strong>.</p>
                </div>
                ${itemsHtml}
                <div class="amount-box">
                    <p><strong>Montant total dû:</strong></p>
                    <p class="amount-numeric">${formatCurrency(debtor.total_amount)}</p>
                </div>
                <div class="signature-area">
                    <p><strong>Signature du débiteur:</strong> <span class="sig-line"></span></p>
                    <p><strong>Date:</strong> <span class="sig-line"></span></p>
                </div>
            </div>
        `;
    }
    
    return `
        <div class="print-statement">
            <div class="letterhead"><h2>OUTSTANDING DEBT STATEMENT</h2></div>
            <div class="date-line"><strong>Date:</strong> ${today}</div>
            <div class="recipient"><p><strong>To:</strong> ${title} ${debtor.full_name}</p></div>
            <div class="body-text">
                <p>Dear ${title} ${debtor.full_name},</p>
                <p>This letter serves as a formal statement of the debt that you owe to 
                <strong>${currentUser?.full_name || ''}</strong>.</p>
            </div>
            ${itemsHtml}
            <div class="amount-box">
                <p><strong>Total Amount Owed:</strong></p>
                <p class="amount-numeric">${formatCurrency(debtor.total_amount)}</p>
            </div>
            <div class="signature-area">
                <p><strong>Debtor's Signature:</strong> <span class="sig-line"></span></p>
                <p><strong>Date:</strong> <span class="sig-line"></span></p>
            </div>
        </div>
    `;
}

// ============================================
// PROFILE
// ============================================

async function updateProfile(e) {
    e.preventDefault();
    
    try {
        const res = await fetch('/api/auth/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                full_name: document.getElementById('profile-name').value,
                phone: document.getElementById('profile-phone').value,
                address: document.getElementById('profile-address').value
            })
        });
        
        if (res.ok) {
            showToast('Profile updated successfully');
            await loadProfile();
        } else {
            showToast('Error updating profile', 'error');
        }
    } catch (err) {
        showToast('Error updating profile', 'error');
    }
}

async function changePassword(e) {
    e.preventDefault();
    
    try {
        const res = await fetch('/api/auth/password', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                currentPassword: document.getElementById('current-password').value,
                newPassword: document.getElementById('new-password').value
            })
        });
        
        if (res.ok) {
            showToast('Password changed successfully');
            document.getElementById('password-form').reset();
        } else {
            const err = await res.json();
            showToast(err.error || 'Error changing password', 'error');
        }
    } catch (err) {
        showToast('Error changing password', 'error');
    }
}

// ============================================
// AUTH
// ============================================

async function logout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/login';
    } catch (err) {
        window.location.href = '/login';
    }
}

// ============================================
// UTILITIES
// ============================================

function formatCurrency(amount) {
    if (amount === null || amount === undefined) return '0 XAF';
    return new Intl.NumberFormat('en-US').format(Math.round(amount)) + ' XAF';
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3000);
}
