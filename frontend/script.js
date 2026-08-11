// ============================================
// CONFIG
// ============================================
// Point this at wherever the backend is actually running.
const API_BASE = window.TENDERFLOW_API_BASE || 'http://localhost:8000/api';

// Mirrors core/pagination.py. MAX_PAGE_SIZE is the server's ceiling — asking for
// more is a 422, not a silent clamp.
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

const AppState = {
    token: localStorage.getItem('tf_token') || null,
    currentUser: null,
    currentPage: 'dashboard',
    departments: [],
    tenders: [],
    submissions: [],
    unreadCount: 0,
    vendorProfile: null, // vendor accounts only
    currentEvaluatingTenderId: null,
    uploadedFiles: [] // vendor submission form, holds real File objects
};

const roleNames = {
    admin: 'System Admin',
    procurement: 'Procurement Team',
    manager: 'Department Manager',
    supply_chain: 'Supply Chain Head',
    finance: 'Finance Team',
    vendor: 'Vendor',
    employee: 'Employee'
};

// Both the tender and the vendor tables draw from one Postgres enum, so these
// are the only four values either side will ever accept.
const CATEGORIES = ['goods', 'services', 'works', 'consulting'];

function isVendor(user) {
    return !!user && user.role === 'vendor';
}

// An employee raises tender requests and waits on the manager. They are on the
// payroll but hold no back-office function, so they sit outside isStaff.
function isEmployee(user) {
    return !!user && user.role === 'employee';
}

// The back-office roles that run the tender process. Mirrors STAFF_ROLES in
// core/deps.py — anything gated on this here is gated on require_staff there,
// so treating an employee as staff would just buy them a screen full of 403s.
function isStaff(user) {
    return !!user && !isVendor(user) && !isEmployee(user);
}

// ============================================
// API CLIENT
// ============================================
async function apiFetch(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const isForm = options.body instanceof FormData;
    if (!isForm && options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (AppState.token) headers['Authorization'] = `Bearer ${AppState.token}`;

    let res;
    try {
        res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    } catch (err) {
        throw new Error('Could not reach the server. Is the API running?');
    }

    if (res.status === 401) {
        const wasLoggedIn = !!AppState.token;
        clearSession();
        if (wasLoggedIn) showLoginPage();
        throw new Error('Your session has expired. Please sign in again.');
    }

    if (!res.ok) {
        let detail = `Request failed (${res.status})`;
        try {
            const data = await res.json();
            if (data.detail) detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
        } catch (e) { /* not json */ }
        throw new Error(detail);
    }

    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

function qs(params) {
    const search = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') search.append(key, value);
    });
    const encoded = search.toString();
    return encoded ? `?${encoded}` : '';
}

// Every list endpoint answers with {items, total, limit, offset}. Going through
// a helper that insists on that shape means a call site which forgets to unwrap
// fails here with a clear message, rather than silently rendering nothing.
async function apiList(path, params = {}) {
    const page = await apiFetch(`${path}${qs({ limit: PAGE_SIZE, offset: 0, ...params })}`);
    if (!page || !Array.isArray(page.items)) {
        throw new Error(`${path} did not return a paged response`);
    }
    return page;
}

// Walks every page and returns one flat array.
//
// Only for the approval screens, which decide what to show from flags the API
// can't filter on (evaluation_submitted, manager_approved, ...). Those pages
// would show a half-truth off a single page — "no pending reviews" when the
// pending one sits on page 2. Everything with a real filter should page instead.
const FETCH_ALL_CAP = 2000;

async function apiAll(path, params = {}) {
    const items = [];
    let offset = 0;
    for (;;) {
        const page = await apiList(path, { ...params, limit: MAX_PAGE_SIZE, offset });
        items.push(...page.items);
        offset += page.items.length;
        if (page.items.length === 0 || items.length >= page.total || items.length >= FETCH_ALL_CAP) break;
    }
    return items;
}

async function apiDownload(path, filename) {
    const headers = {};
    if (AppState.token) headers['Authorization'] = `Bearer ${AppState.token}`;
    const res = await fetch(`${API_BASE}${path}`, { headers });
    if (!res.ok) {
        showToast('error', 'Download Failed', `Could not download ${filename}`);
        return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ============================================
// PAGING
// ============================================
// One cursor per table, kept outside the render so re-rendering after an edit
// lands you back on the page you were looking at instead of jumping to the top.
const pagers = {};
const pagerReloaders = {};

function pagerState(key, overrides) {
    pagers[key] = Object.assign({ limit: PAGE_SIZE, offset: 0 }, pagers[key], overrides);
    return pagers[key];
}

// Filters change what "page 3" even means, so any filter change resets to the
// first page — otherwise a narrow filter lands you past the end of its results.
function pagerFilter(key, overrides) {
    return pagerState(key, { ...overrides, offset: 0 });
}

function pagerParams(key) {
    const { limit, offset } = pagerState(key);
    return { limit, offset };
}

function renderPager(key, total) {
    const state = pagerState(key);
    if (total <= state.limit && state.offset === 0) return '';
    const from = total === 0 ? 0 : state.offset + 1;
    const to = Math.min(state.offset + state.limit, total);
    const hasPrev = state.offset > 0;
    const hasNext = state.offset + state.limit < total;
    return `
        <div class="pager">
            <span class="pager-range">${from}–${to} of ${total}</span>
            <div class="pager-buttons">
                <button class="btn btn-secondary btn-sm" onclick="pagerGo('${key}', -1)" ${hasPrev ? '' : 'disabled'}><i class="fas fa-chevron-left"></i> Prev</button>
                <button class="btn btn-secondary btn-sm" onclick="pagerGo('${key}', 1)" ${hasNext ? '' : 'disabled'}>Next <i class="fas fa-chevron-right"></i></button>
            </div>
        </div>
    `;
}

// For screens that select rows by flags the API can't filter on, so they hold
// the whole set and page it here. Same control, same feel, just client-side.
function pageLocally(key, rows) {
    const { limit, offset } = pagerState(key);
    return rows.slice(offset, offset + limit);
}

function pagerGo(key, direction) {
    const state = pagerState(key);
    const next = state.offset + direction * state.limit;
    if (next < 0) return;
    state.offset = next;
    const reload = pagerReloaders[key];
    if (reload) reload();
}

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const tenderId = urlParams.get('tender');
    if (tenderId) {
        showVendorPage(tenderId);
        return;
    }

    setupEventListeners();
    const today = new Date().toISOString().split('T')[0];
    const deadlineInput = document.getElementById('tenderDeadline');
    if (deadlineInput) deadlineInput.setAttribute('min', today);

    restoreSession();
    setInterval(() => { if (AppState.currentUser) refreshNotificationBadgeOnly(); }, 60000);
});

async function restoreSession() {
    if (!AppState.token) return;
    try {
        const user = await apiFetch('/auth/me');
        onLoginSuccess(user, false);
    } catch (err) {
        clearSession();
    }
}

function clearSession() {
    AppState.token = null;
    AppState.currentUser = null;
    AppState.vendorProfile = null;
    AppState.unreadCount = 0;
    myRequestRows = [];
    // Cursors are per-account: signing in as someone else shouldn't drop you on
    // page 4 of a list you've never seen.
    Object.keys(pagers).forEach(key => delete pagers[key]);
    localStorage.removeItem('tf_token');
}

function setupEventListeners() {
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('menuToggle').addEventListener('click', toggleSidebar);
    document.getElementById('sidebarOverlay').addEventListener('click', closeSidebar);
    document.getElementById('createTenderForm').addEventListener('submit', (e) => e.preventDefault());
    document.getElementById('createUserForm').addEventListener('submit', (e) => e.preventDefault());
    document.getElementById('vendorRegisterForm').addEventListener('submit', handleVendorRegister);
}

// ============================================
// AUTHENTICATION
// ============================================
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    document.getElementById('emailError').classList.remove('show');
    document.getElementById('passwordError').classList.remove('show');
    document.getElementById('loginEmail').classList.remove('error');
    document.getElementById('loginPassword').classList.remove('error');

    const submitBtn = document.getElementById('loginSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Signing in...';

    try {
        const data = await apiFetch('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
        AppState.token = data.access_token;
        localStorage.setItem('tf_token', data.access_token);
        onLoginSuccess(data.user, true);
    } catch (err) {
        document.getElementById('loginPassword').classList.add('error', 'animate-shake');
        document.getElementById('passwordError').textContent = err.message || 'Invalid username or password';
        document.getElementById('passwordError').classList.add('show');
        setTimeout(() => document.getElementById('loginPassword').classList.remove('animate-shake'), 300);
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
    }
}

async function onLoginSuccess(user, isFreshLogin) {
    AppState.currentUser = user;
    const staff = isStaff(user);
    const internal = !isVendor(user);

    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('vendorPage').classList.add('hidden');
    document.getElementById('appContainer').classList.add('active');

    setupRoleBasedNav();
    document.getElementById('userName').textContent = user.name;
    document.getElementById('userRoleDisplay').textContent = roleNames[user.role] || user.role;
    document.getElementById('userAvatar').textContent = user.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);

    // Departments label tenders all through the internal UI, and an employee's
    // request form has to offer them. Only vendors are shut out of the
    // endpoint, so only they would get a guaranteed 403.
    if (internal) {
        try {
            AppState.departments = await apiFetch('/departments');
        } catch (err) { AppState.departments = []; }
    } else {
        AppState.departments = [];
    }

    // Nothing is ever addressed to `vendor`, so the bell would sit permanently
    // empty for them. Employees do get mail — addressed to them personally
    // rather than to their role — so they keep it.
    document.querySelector('.notification-wrapper').style.display = internal ? '' : 'none';

    navigateTo(staff ? 'dashboard' : (isEmployee(user) ? 'my-requests' : 'vendor-tenders'));
    if (internal) refreshNotificationBadgeOnly();

    if (isFreshLogin) showToast('success', 'Welcome!', `Logged in as ${roleNames[user.role] || user.role}`);
}

function showLoginPage() {
    document.getElementById('appContainer').classList.remove('active');
    document.getElementById('vendorPage').classList.add('hidden');
    document.getElementById('loginPage').style.display = 'flex';
    document.getElementById('loginForm').reset();
}

async function logout() {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    clearSession();
    // Drops ?tender=... so logging out of a shared submission link doesn't
    // bounce you straight back onto that tender's public page.
    if (window.location.search) {
        window.location.replace(window.location.pathname);
        return;
    }
    showLoginPage();
}

// ============================================
// VENDOR REGISTRATION (public)
// ============================================
function openVendorRegisterModal() {
    document.getElementById('vendorRegisterForm').reset();
    openModal('vendorRegisterModal');
}

async function handleVendorRegister(e) {
    e.preventDefault();
    const value = (id) => document.getElementById(id).value.trim();

    const payload = {
        username: value('regUsername').toLowerCase(),
        email: value('regEmail').toLowerCase(),
        password: document.getElementById('regPassword').value,
        name: value('regContactName'),
        company_name: value('regCompanyName'),
        vendor_category: document.getElementById('regCategory').value,
        contact_phone: value('regPhone'),
        tax_id: value('regTaxId'),
        address: value('regAddress')
    };
    const contactEmail = value('regContactEmail');
    if (contactEmail) payload.contact_email = contactEmail.toLowerCase();

    if (Object.values(payload).some(v => !v)) {
        showToast('error', 'Validation Error', 'Please fill in every field');
        return;
    }
    if (payload.password.length < 6) {
        showToast('error', 'Validation Error', 'Password must be at least 6 characters');
        return;
    }

    const btn = document.getElementById('vendorRegisterSubmitBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Creating account...';

    try {
        // Registration hands back a token, so the vendor lands in their portal
        // instead of being bounced through the login form they just filled in.
        const data = await apiFetch('/vendor/register', { method: 'POST', body: JSON.stringify(payload) });
        AppState.token = data.access_token;
        localStorage.setItem('tf_token', data.access_token);
        closeModal('vendorRegisterModal');
        await onLoginSuccess(data.user, false);
        showToast('success', 'Welcome to TenderFlow', `${payload.company_name} is registered for ${payload.vendor_category} tenders`);
    } catch (err) {
        showToast('error', 'Registration Failed', err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
    }
}

// ============================================
// NAVIGATION
// ============================================
function setupRoleBasedNav() {
    const role = AppState.currentUser.role;
    const navContainer = document.getElementById('sidebarNav');

    const navConfigs = {
        admin: [
            { section: 'Main', items: [
                { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
                { id: 'tenders', icon: 'fa-file-contract', label: 'Manage Tenders' },
                { id: 'submissions', icon: 'fa-inbox', label: 'Submissions' },
                { id: 'evaluation', icon: 'fa-star', label: 'Evaluation' }
            ]},
            { section: 'Administration', items: [
                { id: 'users', icon: 'fa-users-cog', label: 'User Management' },
                { id: 'vendors', icon: 'fa-building', label: 'Vendor Directory' },
                { id: 'audit', icon: 'fa-history', label: 'Audit Log' }
            ]}
        ],
        procurement: [
            { section: 'Main', items: [
                { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
                { id: 'tenders', icon: 'fa-file-contract', label: 'Manage Tenders' },
                { id: 'submissions', icon: 'fa-inbox', label: 'Submissions' },
                { id: 'evaluation', icon: 'fa-star', label: 'Evaluation' },
                { id: 'vendors', icon: 'fa-building', label: 'Vendor Directory' }
            ]},
            { section: 'Settings', items: [
                { id: 'email-templates', icon: 'fa-envelope', label: 'Email Templates' },
                { id: 'email-log', icon: 'fa-history', label: 'Email Log' }
            ]}
        ],
        manager: [
            { section: 'Main', items: [
                { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
                { id: 'review', icon: 'fa-check-circle', label: 'Pending Reviews' },
                { id: 'history', icon: 'fa-history', label: 'Decision History' }
            ]}
        ],
        supply_chain: [
            { section: 'Main', items: [
                { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
                { id: 'approvals', icon: 'fa-stamp', label: 'Pending Approvals' },
                { id: 'approved', icon: 'fa-check-double', label: 'Approved Tenders' }
            ]}
        ],
        finance: [
            { section: 'Main', items: [
                { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
                { id: 'notifications', icon: 'fa-bell', label: 'Notifications' },
                { id: 'reports', icon: 'fa-file-alt', label: 'Reports' }
            ]}
        ],
        // No dashboard: every stat on it comes from a staff-only route, and a
        // vendor has no business seeing bid counts across the system anyway.
        vendor: [
            { section: 'Main', items: [
                { id: 'vendor-tenders', icon: 'fa-file-contract', label: 'Open Tenders' },
                { id: 'vendor-profile', icon: 'fa-building', label: 'Company Profile' }
            ]}
        ],
        // Also no dashboard, for the same reason: its stats come from
        // /submissions and the company-wide /tenders, neither of which an
        // employee may read. Their world is the requests they filed themselves.
        employee: [
            { section: 'Main', items: [
                { id: 'my-requests', icon: 'fa-file-contract', label: 'My Requests' },
                { id: 'new-request', icon: 'fa-plus-circle', label: 'New Request' }
            ]}
        ]
    };

    const config = navConfigs[role] || navConfigs.admin;
    navContainer.innerHTML = config.map(section => `
        <div class="nav-section">
            <div class="nav-section-title">${section.section}</div>
            ${section.items.map(item => `
                <div class="nav-item" data-page="${item.id}" onclick="navigateTo('${item.id}')">
                    <i class="fas ${item.icon}"></i>
                    <span>${item.label}</span>
                </div>
            `).join('')}
        </div>
    `).join('');
}

function navigateTo(page) {
    AppState.currentPage = page;
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });

    const titles = {
        dashboard: 'Dashboard', tenders: 'Manage Tenders', submissions: 'Submissions',
        users: 'User Management', evaluation: 'Evaluation', review: 'Pending Reviews',
        approvals: 'Pending Approvals', approved: 'Approved Tenders', notifications: 'Notifications',
        reports: 'Reports', audit: 'Audit Log', history: 'Decision History',
        'email-templates': 'Email Templates', 'email-log': 'Email Log',
        vendors: 'Vendor Directory',
        'vendor-tenders': 'Open Tenders', 'vendor-profile': 'Company Profile',
        'my-requests': 'My Requests', 'new-request': 'New Request'
    };
    document.getElementById('pageTitle').textContent = titles[page] || 'Dashboard';
    renderPage(page);
    closeSidebar();
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebarOverlay').classList.toggle('active');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('active');
}

function showLoading(container) {
    container.innerHTML = `<div class="page-loading"><i class="fas fa-circle-notch fa-spin"></i><span>Loading...</span></div>`;
}

function showLoadError(container, err, retryFn) {
    container.innerHTML = `
        <div class="card"><div class="card-body">
            <div class="empty-state">
                <i class="fas fa-triangle-exclamation"></i>
                <h3>Couldn't load this page</h3>
                <p>${escapeHtml(err.message || 'Something went wrong.')}</p>
                ${retryFn ? `<button class="btn btn-accent" onclick="${retryFn}">Retry</button>` : ''}
            </div>
        </div></div>
    `;
}

// ============================================
// PAGE RENDERING DISPATCH
// ============================================
async function renderPage(page) {
    const contentArea = document.getElementById('contentArea');
    showLoading(contentArea);
    try {
        switch (page) {
            case 'dashboard': await renderDashboard(contentArea); break;
            case 'tenders': await renderTendersPage(contentArea); break;
            case 'submissions': await renderSubmissionsPage(contentArea); break;
            case 'users': await renderUsersPage(contentArea); break;
            case 'audit': await renderAuditLog(contentArea); break;
            case 'evaluation': await renderEvaluationPage(contentArea); break;
            case 'review': await renderManagerReviewPage(contentArea); break;
            case 'history': await renderManagerHistoryPage(contentArea); break;
            case 'approvals': await renderSupplyChainApprovalsPage(contentArea); break;
            case 'approved': await renderApprovedTendersPage(contentArea); break;
            case 'notifications': await renderFinanceNotificationsPage(contentArea); break;
            case 'reports': await renderFinanceReportsPage(contentArea); break;
            case 'email-templates': await renderEmailTemplatesPage(contentArea); break;
            case 'email-log': await renderEmailLogPage(contentArea); break;
            case 'vendors': await renderVendorDirectoryPage(contentArea); break;
            case 'vendor-tenders': await renderVendorTendersPage(contentArea); break;
            case 'vendor-profile': await renderVendorProfilePage(contentArea); break;
            case 'my-requests': await renderMyRequestsPage(contentArea); break;
            case 'new-request': await renderNewRequestPage(contentArea); break;
            default:
                if (isStaff(AppState.currentUser)) await renderDashboard(contentArea);
                else if (isEmployee(AppState.currentUser)) await renderMyRequestsPage(contentArea);
                else await renderVendorTendersPage(contentArea);
        }
    } catch (err) {
        showLoadError(contentArea, err, `navigateTo('${page}')`);
    }
}

function deptName(id) {
    const d = AppState.departments.find(d => d.id === id);
    return d ? d.name : 'Not Set';
}

// ============================================
// DASHBOARD
// ============================================
async function renderDashboard(container) {
    // Each stat is a filtered count taken from the page envelope's `total`, not
    // from counting rows — the rows we hold are one page and would undercount.
    const [recent, open, closed, allSubs, pendingSubs] = await Promise.all([
        apiList('/tenders', { limit: 5 }),
        apiList('/tenders', { status: 'open', limit: 1 }),
        apiList('/tenders', { status: 'closed', limit: 1 }),
        apiList('/submissions', { limit: 1 }),
        apiList('/submissions', { status: 'pending', limit: 1 })
    ]);

    const tenders = recent.items;
    const activeTenders = open.total;
    const closedTenders = closed.total;
    const totalSubmissions = allSubs.total;
    const pendingSubmissions = pendingSubs.total;
    const canManage = ['admin', 'procurement'].includes(AppState.currentUser?.role);

    container.innerHTML = `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon blue"><i class="fas fa-file-contract"></i></div>
                <div class="stat-content"><h3>${activeTenders}</h3><p>Active Tenders</p></div>
            </div>
            <div class="stat-card">
                <div class="stat-icon green"><i class="fas fa-check-circle"></i></div>
                <div class="stat-content"><h3>${closedTenders}</h3><p>Closed Tenders</p></div>
            </div>
            <div class="stat-card">
                <div class="stat-icon amber"><i class="fas fa-inbox"></i></div>
                <div class="stat-content"><h3>${totalSubmissions}</h3><p>Total Submissions</p></div>
            </div>
            <div class="stat-card">
                <div class="stat-icon purple"><i class="fas fa-clock"></i></div>
                <div class="stat-content"><h3>${pendingSubmissions}</h3><p>Pending Review</p></div>
            </div>
        </div>
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">Recent Tenders</h3>
                ${canManage ? `<button class="btn btn-accent btn-sm" onclick="openCreateTenderModal()"><i class="fas fa-plus"></i> New Tender</button>` : ''}
            </div>
            <div class="card-body" style="padding: 0;">
                <div class="table-container">
                    <table>
                        <thead><tr><th>Serial</th><th>Name</th><th>Category</th><th>Deadline</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody>
                            ${tenders.map(tender => `
                                <tr>
                                    <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${tender.serial}</code></td>
                                    <td><strong>${escapeHtml(tender.name)}</strong></td>
                                    <td><span class="badge badge-info">${tender.category}</span></td>
                                    <td>${formatDate(tender.deadline_date)} ${tender.deadline_time}</td>
                                    <td><span class="badge ${tender.status === 'open' ? 'badge-success' : 'badge-secondary'}">${tender.status}</span></td>
                                    <td><button class="action-btn" onclick="viewTender('${tender.id}')" title="View"><i class="fas fa-eye"></i></button></td>
                                </tr>
                            `).join('') || `<tr><td colspan="6" style="text-align:center; padding: 30px;">No tenders yet</td></tr>`}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

// ============================================
// TENDERS
// ============================================
async function renderTendersPage(container) {
    pagerReloaders.tenders = () => renderTendersPage(container);
    const state = pagerState('tenders');
    // Status filtering moved server-side with paging: filtering one page in the
    // browser would have hidden matches sitting on every other page.
    const page = await apiList('/tenders', { ...pagerParams('tenders'), status: state.status });
    AppState.tenders = page.items;
    const canManage = ['admin', 'procurement'].includes(AppState.currentUser?.role);
    const tab = (value, label) =>
        `<div class="tab ${(state.status || 'all') === value ? 'active' : ''}" onclick="filterTenders('${value}')">${label}</div>`;

    container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 16px;">
            <div class="tabs" style="margin-bottom: 0; border-bottom: none;">
                ${tab('all', 'All')}${tab('open', 'Open')}${tab('closed', 'Closed')}${tab('awarded', 'Awarded')}
            </div>
            ${canManage ? `<button class="btn btn-accent" onclick="openCreateTenderModal()"><i class="fas fa-plus"></i> Create Tender</button>` : ''}
        </div>
        <div class="card">
            <div class="card-body" style="padding: 0;">
                <div class="table-container">
                    <table>
                        <thead><tr><th>Serial</th><th>Tender Name</th><th>Department</th><th>Category</th><th>Currency</th><th>Deadline</th><th>Status</th><th>Submissions</th><th>Actions</th></tr></thead>
                        <tbody id="tendersTableBody">${renderTendersRows(page.items)}</tbody>
                    </table>
                </div>
                ${renderPager('tenders', page.total)}
            </div>
        </div>
    `;
}

const TENDER_STATUS_BADGE = {
    pending_approval: 'badge-warning',
    open: 'badge-success',
    closed: 'badge-secondary',
    awarded: 'badge-info',
    rejected: 'badge-danger'
};

function tenderStatusLabel(status) {
    return (status || '').replace(/_/g, ' ');
}

function renderTendersRows(tenders) {
    if (tenders.length === 0) return `<tr><td colspan="9" style="text-align: center; padding: 40px;">No tenders found</td></tr>`;
    const canManage = ['admin', 'procurement'].includes(AppState.currentUser?.role);
    return tenders.map(tender => {
        const isExpired = isTenderExpired(tender);
        return `
            <tr>
                <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${tender.serial}</code></td>
                <td><strong>${escapeHtml(tender.name)}</strong><div style="font-size: 12px; color: var(--text-muted); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(tender.description)}</div></td>
                <td><span class="badge badge-warning">${escapeHtml(deptName(tender.department_id))}</span></td>
                <td><span class="badge badge-info">${tender.category}</span></td>
                <td>${tender.currency}</td>
                <td>${formatDate(tender.deadline_date)} ${tender.deadline_time} ${isExpired && tender.status === 'open' ? '<span class="badge badge-danger" style="margin-left: 4px;">Expired</span>' : ''}</td>
                <td><span class="badge ${TENDER_STATUS_BADGE[tender.status] || 'badge-secondary'}">${tenderStatusLabel(tender.status)}</span>
                    ${tender.status === 'rejected' && tender.manager_rejected ? `<div style="font-size: 11px; color: var(--text-muted);">sent back by manager</div>` : ''}</td>
                <td>${tender.submission_count || 0}</td>
                <td>
                    <div class="actions">
                        <button class="action-btn" onclick="viewTender('${tender.id}')" title="View"><i class="fas fa-eye"></i></button>
                        ${tender.status === 'open' ? `<button class="action-btn" onclick="copyTenderLink('${tender.id}')" title="Copy Link"><i class="fas fa-link"></i></button>` : ''}
                        ${canManage && tender.status === 'rejected' && tender.manager_rejected ? `<button class="action-btn success" onclick="resubmitTender('${tender.id}')" title="Resubmit for approval"><i class="fas fa-paper-plane"></i></button>` : ''}
                        ${canManage && tender.status === 'open' ? `<button class="action-btn danger" onclick="closeTender('${tender.id}')" title="Close"><i class="fas fa-lock"></i></button>` : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function filterTenders(status) {
    pagerFilter('tenders', { status: status === 'all' ? null : status });
    renderTendersPage(document.getElementById('contentArea'));
}

function generateSubmissionLink(tenderId) {
    return `${window.location.origin}${window.location.pathname}?tender=${tenderId}`;
}

function isTenderExpired(tender) {
    // The API computes this against the server clock, which is the clock the
    // deadline was written on. Falling back to the browser's would disagree by
    // the viewer's UTC offset — telling someone in another timezone a tender is
    // still open hours after the server stopped taking bids.
    if (typeof tender.is_expired === 'boolean') return tender.is_expired;
    const deadlineDateTime = new Date(`${tender.deadline_date}T${tender.deadline_time}`);
    return new Date() > deadlineDateTime;
}

async function viewTender(tenderId) {
    let tender;
    try {
        tender = await apiFetch(`/tenders/${tenderId}`);
    } catch (err) {
        showToast('error', 'Error', err.message);
        return;
    }
    const link = tender.submission_link || generateSubmissionLink(tenderId);
    const isExpired = isTenderExpired(tender);
    const canManage = ['admin', 'procurement'].includes(AppState.currentUser?.role);

    document.getElementById('viewTenderContent').innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 16px;">
            <div>
                <code style="font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: var(--accent);">${tender.serial}</code>
                <h3 style="font-size: 20px; margin-top: 4px;">${escapeHtml(tender.name)}</h3>
            </div>
            <div class="status-badge-large ${tender.status}${isExpired && tender.status === 'open' ? ' expired' : ''}">
                <i class="fas fa-${tender.status === 'open' ? (isExpired ? 'triangle-exclamation' : 'unlock') : 'lock'}"></i>
                ${tender.status === 'open' && isExpired ? 'EXPIRED' : tenderStatusLabel(tender.status).toUpperCase()}
            </div>
        </div>
        <p style="color: var(--text-secondary); margin-bottom: 24px;">${escapeHtml(tender.description)}</p>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px;">
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Department</label><p style="font-weight: 600;"><span class="badge badge-warning">${escapeHtml(deptName(tender.department_id))}</span></p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Deadline</label><p style="font-weight: 600;">${formatDate(tender.deadline_date)} at ${tender.deadline_time}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Currency</label><p style="font-weight: 600;">${tender.currency}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Category</label><p style="font-weight: 600;">${tender.category}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Submissions</label><p style="font-weight: 600;">${tender.submission_count || 0}</p></div>
        </div>
        <div style="margin-bottom: 24px;"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Required Documents</label><div style="margin-top: 8px;">${(tender.required_docs || []).map(doc => `<span class="chip"><i class="fas fa-file-alt"></i> ${escapeHtml(doc)}</span>`).join('') || '<span style="color:var(--text-muted);">None specified</span>'}</div></div>
        <div style="margin-bottom: 24px;"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Scoring Criteria</label><div style="margin-top: 8px;">${(tender.scoring_criteria || []).map(c => `<div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border);"><span>${escapeHtml(c.name)}</span><span style="font-weight: 600;">${c.weight}%</span></div>`).join('')}</div></div>
        ${tender.status === 'pending_approval' ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--warning);"><strong>Waiting on the department manager.</strong><p style="color: var(--text-secondary); margin-top: 4px;">Vendors can't see this tender and no link works until a manager approves it.</p></div>` : ''}
        ${tender.manager_rejected && tender.manager_feedback ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--danger);"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Manager Sent This Back</label><p style="margin-top: 4px;">${escapeHtml(tender.manager_feedback)}</p></div>` : ''}
        ${tender.supply_chain_rejected && tender.supply_chain_rejection_reason ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--danger);"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Rejected by Supply Chain</label><p style="margin-top: 4px;">${escapeHtml(tender.supply_chain_rejection_reason)}</p></div>` : ''}
        ${tender.status === 'open' && !isExpired ? `<div style="margin-bottom: 24px;"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Vendor Submission Link</label><div class="tender-link"><span style="flex: 1; word-break: break-all;">${link}</span><button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${escapeAttr(link)}')"><i class="fas fa-copy"></i> Copy</button></div><small style="color: var(--text-muted); font-size: 12px;">Only vendors registered for the ${tender.category} category can bid through it.</small></div>` : ''}
        ${tender.awarded_vendor_name ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--accent);"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Awarded To</label><p style="font-weight: 700; font-size: 16px; margin-top: 4px;">${escapeHtml(tender.awarded_vendor_name)}</p><p style="color: var(--text-secondary);">${tender.currency} ${Number(tender.awarded_amount || 0).toLocaleString()} &middot; ${escapeHtml(tender.awarded_email || '')}</p></div>` : ''}
        ${canManage ? `
            <div style="border-top: 1px solid var(--border); padding-top: 20px; margin-top: 24px;">
                <label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 12px; display: block;">Actions</label>
                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                    <button class="btn btn-sm btn-secondary" onclick="openEditTenderModal('${tender.id}')"><i class="fas fa-edit"></i> Edit</button>
                    <button class="btn btn-sm btn-secondary" onclick="duplicateTender('${tender.id}')"><i class="fas fa-copy"></i> Duplicate</button>
                    <button class="btn btn-sm btn-secondary" onclick="extendDeadline('${tender.id}')"><i class="fas fa-calendar-plus"></i> Extend Deadline</button>
                    ${tender.status === 'rejected' && tender.manager_rejected ? `<button class="btn btn-sm btn-success" onclick="resubmitTender('${tender.id}')"><i class="fas fa-paper-plane"></i> Resubmit for Approval</button>` : ''}
                    ${tender.manager_approved ? (
                        tender.status === 'closed' || isExpired
                            ? `<button class="btn btn-sm btn-success" onclick="reopenTender('${tender.id}')"><i class="fas fa-unlock"></i> Re-open</button>`
                            : tender.status === 'open' ? `<button class="btn btn-sm btn-warning" onclick="closeTender('${tender.id}')"><i class="fas fa-lock"></i> Close</button>` : ''
                    ) : ''}
                    <button class="btn btn-sm btn-danger" onclick="resetTenderCycle('${tender.id}')"><i class="fas fa-redo"></i> Reset Cycle</button>
                </div>
            </div>
        ` : ''}
    `;
    openModal('viewTenderModal');
}

function openCreateTenderModal() {
    resetCreateTenderModal();
    populateDepartmentDropdown();
    openModal('createTenderModal');
}

async function openEditTenderModal(tenderId) {
    let tender;
    try {
        tender = await apiFetch(`/tenders/${tenderId}`);
    } catch (err) {
        showToast('error', 'Error', err.message);
        return;
    }
    populateDepartmentDropdown();
    document.getElementById('editTenderId').value = tender.id;
    document.getElementById('tenderName').value = tender.name;
    document.getElementById('tenderDescription').value = tender.description;
    document.getElementById('tenderDeadline').value = tender.deadline_date;
    document.getElementById('tenderDeadlineTime').value = tender.deadline_time;
    document.getElementById('tenderCurrency').value = tender.currency;
    document.getElementById('tenderCategory').value = tender.category;
    document.getElementById('tenderDepartment').value = tender.department_id || '';
    document.getElementById('requiredDocs').value = (tender.required_docs || []).join(', ');
    document.getElementById('scoringCriteria').innerHTML = (tender.scoring_criteria || []).map(c => `
        <div class="criteria-item">
            <input type="text" class="form-control" value="${escapeHtml(c.name)}">
            <input type="number" class="form-control criteria-weight" value="${c.weight}" min="0" max="100">
            <button type="button" class="action-btn danger" onclick="removeCriteria(this)"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
    document.getElementById('tenderModalTitle').textContent = 'Edit Tender';
    const btn = document.getElementById('tenderModalSubmitBtn');
    btn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
    closeModal('viewTenderModal');
    openModal('createTenderModal');
}

function collectTenderFormPayload() {
    const name = document.getElementById('tenderName').value.trim();
    const description = document.getElementById('tenderDescription').value.trim();
    const deadline_date = document.getElementById('tenderDeadline').value;
    const deadline_time = document.getElementById('tenderDeadlineTime').value;
    const currency = document.getElementById('tenderCurrency').value;
    const category = document.getElementById('tenderCategory').value;
    const department_id = document.getElementById('tenderDepartment').value;
    const required_docs = document.getElementById('requiredDocs').value.split(',').map(d => d.trim()).filter(d => d);

    if (!name || !description || !deadline_date || !deadline_time || !department_id) {
        showToast('error', 'Validation Error', 'Please fill in all required fields including department');
        return null;
    }

    const criteriaItems = document.querySelectorAll('#scoringCriteria .criteria-item');
    const scoring_criteria = [];
    let totalWeight = 0;
    criteriaItems.forEach(item => {
        const criteriaName = item.querySelector('input[type="text"]').value.trim();
        const weight = parseInt(item.querySelector('.criteria-weight').value) || 0;
        if (criteriaName) {
            scoring_criteria.push({ name: criteriaName, weight });
            totalWeight += weight;
        }
    });
    if (totalWeight !== 100) {
        showToast('warning', 'Weight Error', `Scoring weights must total 100%. Current: ${totalWeight}%`);
        return null;
    }

    return { name, description, deadline_date, deadline_time, currency, category, department_id, required_docs, scoring_criteria };
}

// Both sides of the tender form land here. Procurement goes back to the
// company-wide list; an employee has no access to that page, so they go back
// to their own requests instead.
function afterTenderSave() {
    return isEmployee(AppState.currentUser) ? 'my-requests' : 'tenders';
}

async function createTender() {
    const payload = collectTenderFormPayload();
    if (!payload) return;
    try {
        const tender = await apiFetch('/tenders', { method: 'POST', body: JSON.stringify(payload) });
        closeModal('createTenderModal');
        resetCreateTenderModal();
        showToast('success', 'Request Submitted', `${tender.serial} is now awaiting manager approval`);
        navigateTo(afterTenderSave());
    } catch (err) {
        showToast('error', 'Error', err.message);
    }
}

async function updateTender(tenderId) {
    const payload = collectTenderFormPayload();
    if (!payload) return;
    try {
        const tender = await apiFetch(`/tenders/${tenderId}`, { method: 'PUT', body: JSON.stringify(payload) });
        closeModal('createTenderModal');
        resetCreateTenderModal();
        showToast('success', 'Tender Updated', `${tender.serial} updated successfully`);
        navigateTo(afterTenderSave());
    } catch (err) {
        showToast('error', 'Error', err.message);
    }
}

function resetCreateTenderModal() {
    document.getElementById('createTenderForm').reset();
    document.getElementById('editTenderId').value = '';
    document.getElementById('tenderDepartment').value = '';
    const forEmployee = isEmployee(AppState.currentUser);
    document.getElementById('tenderModalTitle').textContent = forEmployee ? 'New Request' : 'Create New Tender';
    const btn = document.getElementById('tenderModalSubmitBtn');
    btn.innerHTML = forEmployee
        ? '<i class="fas fa-paper-plane"></i> Submit for Approval'
        : '<i class="fas fa-plus"></i> Create Tender';
    resetScoringCriteria();
}

function resetScoringCriteria() {
    document.getElementById('scoringCriteria').innerHTML = `
        <div class="criteria-item"><input type="text" class="form-control" value="Price"><input type="number" class="form-control criteria-weight" value="40" min="0" max="100"><button type="button" class="action-btn danger" onclick="removeCriteria(this)"><i class="fas fa-trash"></i></button></div>
        <div class="criteria-item"><input type="text" class="form-control" value="Technical"><input type="number" class="form-control criteria-weight" value="30" min="0" max="100"><button type="button" class="action-btn danger" onclick="removeCriteria(this)"><i class="fas fa-trash"></i></button></div>
        <div class="criteria-item"><input type="text" class="form-control" value="Delivery"><input type="number" class="form-control criteria-weight" value="20" min="0" max="100"><button type="button" class="action-btn danger" onclick="removeCriteria(this)"><i class="fas fa-trash"></i></button></div>
        <div class="criteria-item"><input type="text" class="form-control" value="Compliance"><input type="number" class="form-control criteria-weight" value="10" min="0" max="100"><button type="button" class="action-btn danger" onclick="removeCriteria(this)"><i class="fas fa-trash"></i></button></div>
    `;
}

function submitTenderForm() {
    const editId = document.getElementById('editTenderId').value;
    if (editId) updateTender(editId); else createTender();
}

async function closeTender(tenderId) {
    showConfirmDialog('Close Tender', 'No more submissions will be accepted once this tender is closed. Continue?', async () => {
        try {
            const tender = await apiFetch(`/tenders/${tenderId}/close`, { method: 'POST' });
            showToast('success', 'Tender Closed', `${tender.serial} has been closed`);
            closeModal('viewTenderModal');
            renderPage(AppState.currentPage);
        } catch (err) { showToast('error', 'Error', err.message); }
    });
}

async function reopenTender(tenderId) {
    showConfirmDialog('Re-open Tender', 'This will allow new submissions again. Continue?', async () => {
        try {
            const tender = await apiFetch(`/tenders/${tenderId}/reopen`, { method: 'POST' });
            showToast('success', 'Tender Re-opened', `${tender.serial} is now accepting submissions`);
            closeModal('viewTenderModal');
            renderPage(AppState.currentPage);
        } catch (err) { showToast('error', 'Error', err.message); }
    });
}

// A tender the manager sent back can be revised and put in front of them again.
async function resubmitTender(tenderId) {
    showConfirmDialog('Resubmit for Approval', 'This sends the tender back to the department manager for a fresh decision. Make sure you have addressed their feedback first.', async () => {
        try {
            const tender = await apiFetch(`/tenders/${tenderId}/resubmit`, { method: 'POST' });
            showToast('success', 'Resubmitted', `${tender.serial} is awaiting manager approval again`);
            closeModal('viewTenderModal');
            renderPage(AppState.currentPage);
        } catch (err) { showToast('error', 'Error', err.message); }
    });
}

async function duplicateTender(tenderId) {
    try {
        const tender = await apiFetch(`/tenders/${tenderId}/duplicate`, { method: 'POST' });
        showToast('success', 'Tender Duplicated', `${tender.serial} created`);
        closeModal('viewTenderModal');
        renderPage('tenders');
    } catch (err) { showToast('error', 'Error', err.message); }
}

async function resetTenderCycle(tenderId) {
    showConfirmDialog('Reset Tender Cycle', 'This will permanently delete ALL submissions and evaluations for this tender and re-open it. This cannot be undone. Continue?', async () => {
        try {
            const tender = await apiFetch(`/tenders/${tenderId}/reset-cycle`, { method: 'POST' });
            showToast('success', 'Cycle Reset', `${tender.serial} has been reset`);
            closeModal('viewTenderModal');
            renderPage(AppState.currentPage);
        } catch (err) { showToast('error', 'Error', err.message); }
    });
}

async function extendDeadline(tenderId) {
    // Fetched rather than read out of AppState.tenders: that only ever holds the
    // page currently on screen, and this is reachable from the detail modal.
    const tender = await apiFetch(`/tenders/${tenderId}`).catch(() => null);
    document.getElementById('extendDeadlineCurrent').innerHTML = tender
        ? `Current: <strong>${formatDate(tender.deadline_date)} at ${tender.deadline_time}</strong>`
        : '';
    document.getElementById('newDeadlineDate').value = tender ? tender.deadline_date : '';
    document.getElementById('newDeadlineTime').value = tender ? tender.deadline_time : '';
    document.getElementById('extendDeadlineSubmitBtn').onclick = () => saveExtendedDeadline(tenderId);
    openModal('extendDeadlineModal');
}

async function saveExtendedDeadline(tenderId) {
    const deadline_date = document.getElementById('newDeadlineDate').value;
    const deadline_time = document.getElementById('newDeadlineTime').value;
    if (!deadline_date || !deadline_time) {
        showToast('error', 'Error', 'Please select date and time');
        return;
    }
    try {
        const tender = await apiFetch(`/tenders/${tenderId}/extend-deadline`, {
            method: 'POST',
            body: JSON.stringify({ deadline_date, deadline_time })
        });
        showToast('success', 'Deadline Extended', `New deadline: ${formatDate(tender.deadline_date)} at ${tender.deadline_time}`);
        closeModal('extendDeadlineModal');
        closeModal('viewTenderModal');
        renderPage(AppState.currentPage);
    } catch (err) { showToast('error', 'Error', err.message); }
}

function copyTenderLink(tenderId) {
    copyToClipboard(generateSubmissionLink(tenderId));
}

function addCriteria() {
    const container = document.getElementById('scoringCriteria');
    const div = document.createElement('div');
    div.className = 'criteria-item';
    div.innerHTML = `<input type="text" class="form-control" placeholder="Criteria name"><input type="number" class="form-control criteria-weight" placeholder="%" min="0" max="100"><button type="button" class="action-btn danger" onclick="removeCriteria(this)"><i class="fas fa-trash"></i></button>`;
    container.appendChild(div);
}

function removeCriteria(btn) {
    if (document.querySelectorAll('#scoringCriteria .criteria-item').length > 1) {
        btn.closest('.criteria-item').remove();
    } else {
        showToast('warning', 'Cannot Remove', 'At least one criteria is required');
    }
}

function populateDepartmentDropdown() {
    const select = document.getElementById('tenderDepartment');
    if (select) {
        select.innerHTML = '<option value="">Select Department</option>' +
            AppState.departments.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
    }
}

// ============================================
// EMPLOYEE REQUESTS
// ============================================
// An employee raises a tender request and waits on the manager. They never see
// the company-wide tender list, the bids, or the award — /tenders/my-requests
// is their only window, and it returns just the requests they filed.
//
// The rows are kept here because that endpoint is also the only way to read one
// back: GET /tenders/{id} is staff-only, so the edit form has to repopulate
// from the list it was already given rather than re-fetching a single tender.
let myRequestRows = [];

// The two states in which a request is still the requester's to change. Mirrors
// EMPLOYEE_EDITABLE in routers/tenders.py — once a manager opens it, vendors
// are bidding against what it says.
const EMPLOYEE_EDITABLE = ['pending_approval', 'rejected'];

async function renderMyRequestsPage(container) {
    pagerReloaders.myRequests = () => renderMyRequestsPage(container);
    const state = pagerState('myRequests');
    const page = await apiList('/tenders/my-requests', {
        ...pagerParams('myRequests'),
        status: state.status === 'all' ? null : state.status
    });
    myRequestRows = page.items;

    const statusOption = (value, label) =>
        `<option value="${value}" ${(state.status || 'all') === value ? 'selected' : ''}>${label}</option>`;

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">My Requests</h3>
                <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                    <select class="form-control" style="width: auto; display: inline-block;" onchange="filterMyRequests(this.value)">
                        ${statusOption('all', 'All Statuses')}
                        ${statusOption('pending_approval', 'Awaiting Approval')}
                        ${statusOption('rejected', 'Needs Changes')}
                        ${statusOption('open', 'Open to Vendors')}
                        ${statusOption('closed', 'Closed')}
                        ${statusOption('awarded', 'Awarded')}
                    </select>
                    <button class="btn btn-accent btn-sm" onclick="navigateTo('new-request')"><i class="fas fa-plus"></i> New Request</button>
                </div>
            </div>
            <div class="card-body">
                ${page.items.length === 0 ? `
                    <div class="empty-state">
                        <i class="fas fa-file-circle-plus"></i>
                        <h3>No requests yet</h3>
                        <p>Raise a tender request and it will go to your manager for approval.</p>
                        <button class="btn btn-accent" onclick="navigateTo('new-request')"><i class="fas fa-plus"></i> New Request</button>
                    </div>
                ` : `
                    <div class="table-container">
                        <table class="data-table">
                            <thead><tr><th>Serial</th><th>Request</th><th>Category</th><th>Deadline</th><th>Status</th><th>Actions</th></tr></thead>
                            <tbody>
                                ${page.items.map(r => renderMyRequestRow(r)).join('')}
                            </tbody>
                        </table>
                    </div>
                    ${renderPager('myRequests', page.total)}
                `}
            </div>
        </div>
    `;
}

function renderMyRequestRow(request) {
    const editable = EMPLOYEE_EDITABLE.includes(request.status);
    return `
        <tr>
            <td><code style="font-family: 'IBM Plex Mono', monospace;">${escapeHtml(request.serial)}</code></td>
            <td>
                <strong>${escapeHtml(request.name)}</strong>
                ${request.status === 'rejected' && request.manager_feedback ? `
                    <div class="request-feedback">
                        <i class="fas fa-comment-dots"></i>
                        <span><strong>Manager:</strong> ${escapeHtml(request.manager_feedback)}</span>
                    </div>
                ` : ''}
            </td>
            <td><span class="badge badge-secondary">${escapeHtml(request.category)}</span></td>
            <td>${formatDate(request.deadline_date)} ${escapeHtml(request.deadline_time || '')}</td>
            <td><span class="badge ${TENDER_STATUS_BADGE[request.status] || 'badge-secondary'}">${tenderStatusLabel(request.status)}</span></td>
            <td>
                <div class="actions">
                    <button class="action-btn" title="View" onclick="viewMyRequest('${request.id}')"><i class="fas fa-eye"></i></button>
                    ${editable ? `<button class="action-btn" title="Edit" onclick="openEditRequestModal('${request.id}')"><i class="fas fa-pen"></i></button>` : ''}
                    ${request.status === 'rejected' ? `<button class="action-btn success" title="Resubmit for approval" onclick="resubmitMyRequest('${request.id}')"><i class="fas fa-paper-plane"></i></button>` : ''}
                </div>
            </td>
        </tr>
    `;
}

function filterMyRequests(status) {
    pagerFilter('myRequests', { status });
    renderMyRequestsPage(document.getElementById('contentArea'));
}

function findMyRequest(requestId) {
    return myRequestRows.find(r => r.id === requestId);
}

function viewMyRequest(requestId) {
    const r = findMyRequest(requestId);
    if (!r) return;
    const label = 'font-size: 12px; color: var(--text-muted); text-transform: uppercase;';
    const editable = EMPLOYEE_EDITABLE.includes(r.status);
    document.getElementById('viewTenderContent').innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 16px;">
            <div>
                <code style="font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: var(--accent);">${escapeHtml(r.serial)}</code>
                <h3 style="font-size: 20px; margin-top: 4px;">${escapeHtml(r.name)}</h3>
            </div>
            <div class="status-badge-large ${r.status}">${tenderStatusLabel(r.status).toUpperCase()}</div>
        </div>
        <p style="color: var(--text-secondary); margin-bottom: 24px;">${escapeHtml(r.description)}</p>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px;">
            <div><label style="${label}">Department</label><p style="font-weight: 600;"><span class="badge badge-warning">${escapeHtml(deptName(r.department_id))}</span></p></div>
            <div><label style="${label}">Deadline</label><p style="font-weight: 600;">${formatDate(r.deadline_date)} at ${escapeHtml(r.deadline_time || '')}</p></div>
            <div><label style="${label}">Currency</label><p style="font-weight: 600;">${escapeHtml(r.currency)}</p></div>
            <div><label style="${label}">Category</label><p style="font-weight: 600;">${escapeHtml(r.category)}</p></div>
        </div>
        <div style="margin-bottom: 24px;"><label style="${label}">Required Documents</label><div style="margin-top: 8px;">${(r.required_docs || []).map(d => `<span class="chip"><i class="fas fa-file-alt"></i> ${escapeHtml(d)}</span>`).join('') || '<span style="color:var(--text-muted);">None specified</span>'}</div></div>
        <div style="margin-bottom: 24px;"><label style="${label}">Scoring Criteria</label><div style="margin-top: 8px;">${(r.scoring_criteria || []).map(c => `<div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border);"><span>${escapeHtml(c.name)}</span><span style="font-weight: 600;">${c.weight}%</span></div>`).join('')}</div></div>
        ${r.status === 'pending_approval' ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--warning);"><strong>Waiting on your manager.</strong><p style="color: var(--text-secondary); margin-top: 4px;">You'll get a notification once they've decided.</p></div>` : ''}
        ${r.status === 'rejected' && r.manager_feedback ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--danger);"><label style="${label}">Manager Asked For Changes</label><p style="margin-top: 4px;">${escapeHtml(r.manager_feedback)}</p></div>` : ''}
        ${r.status === 'open' ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--accent);"><strong>Approved and open to vendors.</strong><p style="color: var(--text-secondary); margin-top: 4px;">Procurement handles it from here.</p></div>` : ''}
        ${editable ? `
            <div style="border-top: 1px solid var(--border); padding-top: 20px; margin-top: 24px;">
                <label style="${label} margin-bottom: 12px; display: block;">Actions</label>
                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                    <button class="btn btn-sm btn-secondary" onclick="openEditRequestModal('${r.id}')"><i class="fas fa-edit"></i> Edit</button>
                    ${r.status === 'rejected' ? `<button class="btn btn-sm btn-success" onclick="closeModal('viewTenderModal'); resubmitMyRequest('${r.id}')"><i class="fas fa-paper-plane"></i> Resubmit for Approval</button>` : ''}
                </div>
            </div>
        ` : ''}
    `;
    openModal('viewTenderModal');
}

// Populates the shared tender form from the row already in hand. The staff
// version of this fetches /tenders/{id} first; an employee is not allowed to,
// which is why my-requests returns the whole request body rather than a summary.
function openEditRequestModal(requestId) {
    const r = findMyRequest(requestId);
    if (!r) return;
    populateDepartmentDropdown();
    document.getElementById('editTenderId').value = r.id;
    document.getElementById('tenderName').value = r.name;
    document.getElementById('tenderDescription').value = r.description;
    document.getElementById('tenderDeadline').value = r.deadline_date;
    document.getElementById('tenderDeadlineTime').value = r.deadline_time;
    document.getElementById('tenderCurrency').value = r.currency;
    document.getElementById('tenderCategory').value = r.category;
    document.getElementById('tenderDepartment').value = r.department_id || '';
    document.getElementById('requiredDocs').value = (r.required_docs || []).join(', ');
    document.getElementById('scoringCriteria').innerHTML = (r.scoring_criteria || []).map(c => `
        <div class="criteria-item">
            <input type="text" class="form-control" value="${escapeHtml(c.name)}">
            <input type="number" class="form-control criteria-weight" value="${c.weight}" min="0" max="100">
            <button type="button" class="action-btn danger" onclick="removeCriteria(this)"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
    document.getElementById('tenderModalTitle').textContent = 'Edit Request';
    document.getElementById('tenderModalSubmitBtn').innerHTML = '<i class="fas fa-save"></i> Save Changes';
    closeModal('viewTenderModal');
    openModal('createTenderModal');
}

async function resubmitMyRequest(requestId) {
    try {
        const tender = await apiFetch(`/tenders/${requestId}/resubmit`, { method: 'POST' });
        showToast('success', 'Sent Back for Approval', `${tender.serial} is with your manager again`);
        renderMyRequestsPage(document.getElementById('contentArea'));
        refreshNotificationBadgeOnly();
    } catch (err) {
        showToast('error', 'Error', err.message);
    }
}

function renderNewRequestPage(container) {
    container.innerHTML = `
        <div class="card">
            <div class="card-header"><h3 class="card-title">Raise a Tender Request</h3></div>
            <div class="card-body">
                <div class="empty-state">
                    <i class="fas fa-file-circle-plus"></i>
                    <h3>Describe what you need</h3>
                    <p>
                        Your request goes to your manager for approval. If they approve it, procurement
                        opens it to vendors and takes it from there. If they ask for changes, you'll get
                        a notification and can edit and resend it.
                    </p>
                    <button class="btn btn-accent" onclick="openCreateTenderModal()"><i class="fas fa-plus"></i> Start a Request</button>
                </div>
            </div>
        </div>
    `;
    // The form itself lives in the shared tender modal, so there is one
    // definition of it rather than a second that can drift.
    openCreateTenderModal();
}

// ============================================
// SUBMISSIONS
// ============================================
// A submission carries a tender_id and nothing else about its tender, so the
// table needs a lookup to show a serial. Cached: paging through bids shouldn't
// re-walk every page of tenders each time.
let tenderIndex = null;

async function loadTenderIndex(force = false) {
    if (!tenderIndex || force) tenderIndex = await apiAll('/tenders');
    return tenderIndex;
}

async function renderSubmissionsPage(container, { keepIndex = false } = {}) {
    pagerReloaders.submissions = () => renderSubmissionsPage(container, { keepIndex: true });
    const state = pagerState('submissions');

    const [page, tenders] = await Promise.all([
        apiList('/submissions', {
            ...pagerParams('submissions'),
            tender_id: state.tenderId,
            status: state.status
        }),
        loadTenderIndex(!keepIndex)
    ]);
    AppState.submissions = page.items;
    AppState.tenders = tenders;

    const statusOption = (value, label) =>
        `<option value="${value}" ${(state.status || 'all') === value ? 'selected' : ''}>${label}</option>`;

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">All Submissions</h3>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <select class="form-control" style="width: auto; display: inline-block;" onchange="filterSubmissionsByTender(this.value)">
                        <option value="all">All Tenders</option>
                        ${tenders.map(t => `<option value="${t.id}" ${state.tenderId === t.id ? 'selected' : ''}>${t.serial} - ${escapeHtml(t.name)}</option>`).join('')}
                    </select>
                    <select class="form-control" style="width: auto; display: inline-block;" onchange="filterSubmissionsByStatus(this.value)">
                        ${statusOption('all', 'All Statuses')}${statusOption('pending', 'Pending')}${statusOption('validated', 'Validated')}${statusOption('rejected', 'Rejected')}
                    </select>
                </div>
            </div>
            <div class="card-body" style="padding: 0;">
                <div class="table-container">
                    <table>
                        <thead><tr><th>Tender</th><th>Company</th><th>Contact</th><th>Amount</th><th>Submitted</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody id="submissionsTableBody">${renderSubmissionsRows(page.items)}</tbody>
                    </table>
                </div>
                ${renderPager('submissions', page.total)}
            </div>
        </div>
    `;
}

function renderSubmissionsRows(submissions) {
    if (submissions.length === 0) return `<tr><td colspan="7" style="text-align: center; padding: 40px;">No submissions found</td></tr>`;
    const canManage = ['admin', 'procurement'].includes(AppState.currentUser?.role);
    return submissions.map(sub => {
        const tender = AppState.tenders.find(t => t.id === sub.tender_id);
        return `
            <tr>
                <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 11px;">${tender?.serial || 'N/A'}</code><div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(tender?.name || 'Unknown')}</div></td>
                <td><strong>${escapeHtml(sub.company_name)}</strong></td>
                <td>${escapeHtml(sub.contact_name)}<div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(sub.email)}</div></td>
                <td>${tender?.currency || ''} ${Number(sub.total_amount).toLocaleString()}</td>
                <td>${formatDateTime(sub.submitted_at)}</td>
                <td><span class="badge ${sub.status === 'pending' ? 'badge-warning' : sub.status === 'validated' ? 'badge-success' : 'badge-danger'}">${sub.status}</span></td>
                <td>
                    <div class="actions">
                        <button class="action-btn" onclick="viewSubmission('${sub.id}')" title="View"><i class="fas fa-eye"></i></button>
                        ${canManage && sub.status === 'pending' ? `
                            <button class="action-btn success" onclick="updateSubmissionStatus('${sub.id}', 'validated')" title="Validate"><i class="fas fa-check"></i></button>
                            <button class="action-btn danger" onclick="updateSubmissionStatus('${sub.id}', 'rejected')" title="Reject"><i class="fas fa-times"></i></button>
                        ` : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function filterSubmissionsByTender(tenderId) {
    pagerFilter('submissions', { tenderId: tenderId === 'all' ? null : tenderId });
    renderSubmissionsPage(document.getElementById('contentArea'), { keepIndex: true });
}

function filterSubmissionsByStatus(status) {
    pagerFilter('submissions', { status: status === 'all' ? null : status });
    renderSubmissionsPage(document.getElementById('contentArea'), { keepIndex: true });
}

async function viewSubmission(subId) {
    let sub;
    try {
        sub = await apiFetch(`/submissions/${subId}`);
    } catch (err) { showToast('error', 'Error', err.message); return; }
    const tender = AppState.tenders.find(t => t.id === sub.tender_id) || await apiFetch(`/tenders/${sub.tender_id}`).catch(() => null);

    document.getElementById('submissionDetailContent').innerHTML = `
        <div style="margin-bottom: 24px;">
            <span class="badge ${sub.status === 'pending' ? 'badge-warning' : sub.status === 'validated' ? 'badge-success' : 'badge-danger'}" style="font-size: 14px; padding: 6px 12px;">${sub.status.toUpperCase()}</span>
        </div>
        <h3 style="margin-bottom: 16px;">${escapeHtml(sub.company_name)}</h3>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px;">
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Contact Person</label><p>${escapeHtml(sub.contact_name)}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Email</label><p>${escapeHtml(sub.email)}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Phone</label><p>${escapeHtml(sub.phone)}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Bid Amount</label><p style="font-weight: 700; color: var(--accent-light);">${tender?.currency || ''} ${Number(sub.total_amount).toLocaleString()}</p></div>
        </div>
        <div style="margin-bottom: 24px;">
            <label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Tender</label>
            <p>${tender?.serial || ''} - ${escapeHtml(tender?.name || '')}</p>
        </div>
        ${sub.notes ? `<div style="margin-bottom: 24px;"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Notes</label><p>${escapeHtml(sub.notes)}</p></div>` : ''}
        ${sub.files && sub.files.length > 0 ? `
            <div>
                <label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Attached Files</label>
                <div style="margin-top: 8px;">${sub.files.map(f => `<span class="chip" style="cursor: pointer;" onclick="downloadSubmissionFile('${f}')"><i class="fas fa-file-arrow-down"></i> ${escapeHtml(fileDisplayName(f))}</span>`).join('')}</div>
            </div>
        ` : ''}
        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border);">
            <label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Submitted At</label>
            <p>${formatDateTime(sub.submitted_at)}</p>
        </div>
    `;
    openModal('submissionDetailModal');
}

function fileDisplayName(storedPath) {
    const last = storedPath.split('/').pop();
    return last.includes('_') ? last.split('_').slice(1).join('_') : last;
}

function downloadSubmissionFile(storedPath) {
    apiDownload(`/submissions/files/${storedPath}`, fileDisplayName(storedPath));
}

async function updateSubmissionStatus(subId, status) {
    try {
        const sub = await apiFetch(`/submissions/${subId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
        showToast('success', 'Updated', `Submission marked as ${status}`);
        renderPage('submissions');
    } catch (err) { showToast('error', 'Error', err.message); }
}

// ============================================
// USER MANAGEMENT
// ============================================
async function renderUsersPage(container) {
    pagerReloaders.users = () => renderUsersPage(container);
    const state = pagerState('users');
    const page = await apiList('/users', { ...pagerParams('users'), role: state.role });
    const users = page.items;

    const roleOption = (value, label) =>
        `<option value="${value}" ${(state.role || 'all') === value ? 'selected' : ''}>${label}</option>`;

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">System Users</h3>
                <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                    <select class="form-control" style="width: auto; display: inline-block;" onchange="filterUsersByRole(this.value)">
                        ${roleOption('all', 'All Roles')}
                        ${Object.entries(roleNames).map(([value, label]) => roleOption(value, label)).join('')}
                    </select>
                    <button class="btn btn-accent btn-sm" onclick="openCreateUserModal()"><i class="fas fa-user-plus"></i> Add User</button>
                </div>
            </div>
            <div class="card-body" style="padding: 0;">
                <div class="table-container">
                    <table>
                        <thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody>
                            ${users.map(user => `
                                <tr>
                                    <td><strong>${escapeHtml(user.name)}</strong></td>
                                    <td><code style="font-family: 'IBM Plex Mono', monospace;">${escapeHtml(user.username)}</code></td>
                                    <td>${escapeHtml(user.email)}</td>
                                    <td><span class="badge badge-info">${roleNames[user.role] || user.role}</span></td>
                                    <td><span class="badge ${user.status === 'active' ? 'badge-success' : 'badge-danger'}">${user.status}</span></td>
                                    <td>
                                        <div class="actions">
                                            <button class="action-btn" onclick="editUser('${user.id}')" title="${user.role === 'vendor' ? 'Edit login details (role is fixed on a vendor account)' : 'Edit'}"><i class="fas fa-edit"></i></button>
                                            ${user.id !== AppState.currentUser?.id ? `<button class="action-btn danger" onclick="toggleUserStatus('${user.id}', '${escapeAttr(user.name)}', '${user.status}')" title="${user.status === 'active' ? 'Deactivate' : 'Activate'}"><i class="fas fa-${user.status === 'active' ? 'ban' : 'check'}"></i></button>` : ''}
                                        </div>
                                    </td>
                                </tr>
                            `).join('') || `<tr><td colspan="6" style="text-align:center; padding:30px;">No users match this filter</td></tr>`}
                        </tbody>
                    </table>
                </div>
                ${renderPager('users', page.total)}
            </div>
        </div>
    `;
    AppState._users = users;
}

function filterUsersByRole(role) {
    pagerFilter('users', { role: role === 'all' ? null : role });
    renderUsersPage(document.getElementById('contentArea'));
}

// The role field is the one part of a vendor account an admin can't touch:
// converting to or from vendor would strand the company profile that only
// POST /vendor/register writes, and the API rejects it. Everything else on the
// account — name, login, email, password, status — is fair game.
function setRoleFieldLocked(locked) {
    const select = document.getElementById('userRole');
    select.disabled = locked;
    document.getElementById('userRoleHelp').textContent = locked
        ? "A vendor's role is fixed. Deactivate the account instead of converting it."
        : 'An Employee can raise tender requests and track their own, nothing else. Vendors register themselves.';
}

function openCreateUserModal() {
    document.getElementById('userModalTitle').textContent = 'Create New User';
    document.getElementById('createUserForm').reset();
    document.getElementById('editUserId').value = '';
    document.getElementById('userPassword').setAttribute('required', 'required');
    // reset() clears values, not the disabled flag left behind by an edit.
    setRoleFieldLocked(false);
    openModal('createUserModal');
}

function editUser(userId) {
    const user = (AppState._users || []).find(u => u.id === userId);
    if (!user) return;

    document.getElementById('userModalTitle').textContent = 'Edit User';
    document.getElementById('editUserId').value = user.id;
    document.getElementById('userFullName').value = user.name;
    document.getElementById('userUsername').value = user.username;
    document.getElementById('userEmail').value = user.email;
    document.getElementById('userPassword').value = '';
    document.getElementById('userPassword').removeAttribute('required');
    document.getElementById('userRole').value = user.role;
    setRoleFieldLocked(user.role === 'vendor');
    document.getElementById('userStatus').value = user.status;
    openModal('createUserModal');
}

async function saveUser() {
    const editId = document.getElementById('editUserId').value;
    const name = document.getElementById('userFullName').value.trim();
    const username = document.getElementById('userUsername').value.trim().toLowerCase();
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const password = document.getElementById('userPassword').value;
    const role = document.getElementById('userRole').value;
    const status = document.getElementById('userStatus').value;

    if (!name || !username || !email || !role) {
        showToast('error', 'Validation Error', 'Please fill in all required fields');
        return;
    }

    try {
        if (editId) {
            const payload = { username, email, name, role, status };
            if (password) payload.password = password;
            await apiFetch(`/users/${editId}`, { method: 'PATCH', body: JSON.stringify(payload) });
            showToast('success', 'Updated', 'User updated successfully');
        } else {
            if (!password) {
                showToast('error', 'Validation Error', 'Password is required for new users');
                return;
            }
            await apiFetch('/users', { method: 'POST', body: JSON.stringify({ username, email, name, password, role, status }) });
            showToast('success', 'Created', 'User created successfully');
        }
        closeModal('createUserModal');
        renderPage('users');
    } catch (err) {
        showToast('error', 'Error', err.message);
    }
}

function toggleUserStatus(userId, userName, currentStatus) {
    const action = currentStatus === 'active' ? 'deactivate' : 'activate';
    showConfirmDialog('Confirm', `Are you sure you want to ${action} user "${userName}"?`, async () => {
        try {
            await apiFetch(`/users/${userId}/toggle-status`, { method: 'POST' });
            showToast('success', 'Updated', `User ${action}d`);
            renderPage('users');
        } catch (err) { showToast('error', 'Error', err.message); }
    });
}

// ============================================
// AUDIT LOG
// ============================================
async function renderAuditLog(container) {
    pagerReloaders.audit = () => renderAuditLog(container);
    const state = pagerState('audit');
    const page = await apiList('/audit', {
        ...pagerParams('audit'),
        action: state.action,
        user_name: state.userName
    });

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">System Audit Log</h3>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <input type="text" class="form-control" style="width: auto;" placeholder="Filter by user"
                           value="${escapeAttr(state.userName || '')}" onchange="filterAuditByUser(this.value)">
                    <input type="text" class="form-control" style="width: auto;" placeholder="Exact action, e.g. Tender Created"
                           value="${escapeAttr(state.action || '')}" onchange="filterAuditByAction(this.value)">
                </div>
            </div>
            <div class="card-body" style="padding: 0;">
                <div class="table-container">
                    <table>
                        <thead><tr><th>Timestamp</th><th>Action</th><th>Details</th><th>User</th></tr></thead>
                        <tbody>
                            ${page.items.map(log => `
                                <tr>
                                    <td>${formatDateTime(log.created_at)}</td>
                                    <td><span class="badge badge-info" style="cursor: pointer;" title="Filter to this action" onclick="filterAuditByAction('${escapeAttr(log.action)}')">${escapeHtml(log.action)}</span></td>
                                    <td>${escapeHtml(log.details)}</td>
                                    <td>${escapeHtml(log.user_name)}</td>
                                </tr>
                            `).join('') || `<tr><td colspan="4" style="text-align:center; padding:30px;">No activity matches this filter</td></tr>`}
                        </tbody>
                    </table>
                </div>
                ${renderPager('audit', page.total)}
            </div>
        </div>
    `;
}

function filterAuditByUser(userName) {
    pagerFilter('audit', { userName: userName.trim() || null });
    renderAuditLog(document.getElementById('contentArea'));
}

// The action filter is an exact match on the server, which is why the table's
// action badges are clickable — typing "Tender Created" by hand is easy to get
// subtly wrong and an almost-right filter just returns nothing.
function filterAuditByAction(action) {
    pagerFilter('audit', { action: action.trim() || null });
    renderAuditLog(document.getElementById('contentArea'));
}

// ============================================
// EVALUATION (Procurement stage)
// ============================================
async function renderEvaluationPage(container) {
    const overview = await apiFetch('/evaluations/overview');

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">Tender Evaluation</h3>
            </div>
            <div class="card-body">
                ${overview.length === 0 ? `
                    <div class="empty-state">
                        <i class="fas fa-clipboard-check"></i>
                        <h3>No Submissions to Evaluate</h3>
                        <p>Tenders with submissions will appear here for evaluation.</p>
                    </div>
                ` : `
                    <p style="color: var(--text-secondary); margin-bottom: 20px;">Select a tender to evaluate vendor submissions and rank them based on scoring criteria.</p>
                    <div id="tenderEvalList">
                        ${overview.map(t => {
                            const progress = t.submission_count > 0 ? Math.round((t.evaluated_count / t.submission_count) * 100) : 0;
                            return `
                                <div style="padding: 20px; border: 2px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 16px; cursor: pointer; transition: all 0.2s;"
                                        onmouseover="this.style.borderColor='var(--accent)'; this.style.transform='translateY(-2px)'"
                                        onmouseout="this.style.borderColor='var(--border)'; this.style.transform='translateY(0)'"
                                        onclick="openTenderEvaluation('${t.id}')">
                                    <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px;">
                                        <div style="flex: 1; min-width: 200px;">
                                            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                                                <strong style="font-size: 16px;">${escapeHtml(t.name)}</strong>
                                                ${t.evaluation_submitted ? '<span class="badge badge-success"><i class="fas fa-check"></i> Submitted</span>' : ''}
                                            </div>
                                            <div style="font-size: 13px; color: var(--text-muted);">${t.serial}</div>
                                            <div style="display: flex; gap: 16px; margin-top: 12px; font-size: 13px;">
                                                <span><i class="fas fa-inbox" style="color: var(--accent); margin-right: 4px;"></i> ${t.submission_count} submissions</span>
                                                <span><i class="fas fa-star" style="color: var(--accent-light); margin-right: 4px;"></i> ${t.evaluated_count} evaluated</span>
                                            </div>
                                        </div>
                                        <div style="text-align: right; min-width: 150px;">
                                            <span class="badge ${t.status === 'open' ? 'badge-success' : 'badge-secondary'}">${t.status}</span>
                                            <div style="margin-top: 12px;">
                                                <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">Evaluation Progress</div>
                                                <div class="progress-bar" style="width: 120px;">
                                                    <div class="progress-fill" style="width: ${progress}%; background: ${progress === 100 ? 'var(--success)' : 'var(--accent)'};"></div>
                                                </div>
                                                <div style="font-size: 12px; font-weight: 600; margin-top: 4px;">${progress}%</div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `}
            </div>
        </div>
    `;
}

async function openTenderEvaluation(tenderId) {
    AppState.currentEvaluatingTenderId = tenderId;
    const container = document.getElementById('contentArea');
    showLoading(container);

    let tender, rankings;
    try {
        [tender, rankings] = await Promise.all([
            apiFetch(`/tenders/${tenderId}`),
            apiFetch(`/evaluations/tenders/${tenderId}/rankings`)
        ]);
    } catch (err) {
        showLoadError(container, err, `openTenderEvaluation('${tenderId}')`);
        return;
    }

    const evaluatedCount = rankings.filter(r => r.evaluation).length;

    container.innerHTML = `
        <div style="margin-bottom: 24px;">
            <button class="btn btn-secondary btn-sm" onclick="navigateTo('evaluation')">
                <i class="fas fa-arrow-left"></i> Back to Evaluations
            </button>
        </div>

        <div class="card" style="margin-bottom: 24px;">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">${escapeHtml(tender.name)}</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">${tender.serial}</span>
                </div>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    ${tender.evaluation_submitted ? `
                        <span class="badge badge-success" style="padding: 8px 16px;"><i class="fas fa-check"></i> Sent to Supply Chain</span>
                    ` : `
                        <button class="btn btn-accent btn-sm" onclick="sendForAward('${tenderId}')" ${evaluatedCount === 0 ? 'disabled' : ''}>
                            <i class="fas fa-paper-plane"></i> Send for Award
                        </button>
                    `}
                </div>
            </div>
            <div class="card-body">
                <div class="eval-summary">
                    <div class="eval-summary-item">
                        <div class="value">${rankings.length}</div>
                        <div class="label">Total Submissions</div>
                    </div>
                    <div class="eval-summary-item">
                        <div class="value">${evaluatedCount}</div>
                        <div class="label">Evaluated</div>
                    </div>
                    <div class="eval-summary-item">
                        <div class="value">${rankings.length - evaluatedCount}</div>
                        <div class="label">Pending</div>
                    </div>
                    <div class="eval-summary-item">
                        <div class="value" style="color: var(--success);">${rankings.length > 0 && rankings[0].score !== null && rankings[0].score !== undefined ? Number(rankings[0].score).toFixed(1) : '-'}</div>
                        <div class="label">Top Score</div>
                    </div>
                </div>

                <h4 style="margin-bottom: 12px; font-size: 14px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Scoring Criteria</h4>
                <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">
                    ${tender.scoring_criteria.map(c => `
                        <span class="chip" style="background: var(--accent); color: #fff;">
                            ${escapeHtml(c.name)} <strong>(${c.weight}%)</strong>
                        </span>
                    `).join('')}
                </div>
            </div>
        </div>

        ${evaluatedCount >= 3 ? `
            <div class="award-banner">
                <i class="fas fa-trophy"></i>
                <h3>Top 3 Vendors Identified</h3>
                <p style="opacity: 0.85;">Based on weighted scoring criteria</p>
            </div>
        ` : ''}

        <div id="submissionEvalCards">
            ${rankings.map((sub, index) => renderEvalCard(sub, tender, index + 1)).join('')}
        </div>
    `;
}

function renderEvalCard(submission, tender, rank) {
    const evaluation = submission.evaluation;
    const rankClass = evaluation ? (rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : '') : '';
    const rankBadgeClass = evaluation ? (rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : 'default') : 'default';

    return `
        <div class="eval-card ${rankClass}" id="evalCard_${submission.id}">
            <div class="eval-card-header" onclick="toggleEvalCard('${submission.id}')">
                <div style="display: flex; align-items: center; gap: 16px; flex: 1;">
                    <div class="rank-badge ${rankBadgeClass}">
                        ${evaluation ? (rank <= 3 ? `<i class="fas fa-${rank === 1 ? 'trophy' : 'medal'}"></i>` : rank) : '-'}
                    </div>
                    <div style="flex: 1;">
                        <h4 style="font-size: 16px; margin-bottom: 4px;">${escapeHtml(submission.company_name)}</h4>
                        <div style="font-size: 13px; color: var(--text-muted);">${escapeHtml(submission.contact_name)} • ${escapeHtml(submission.email)}</div>
                    </div>
                </div>
                <div style="text-align: right; display: flex; align-items: center; gap: 16px;">
                    <div>
                        <div style="font-size: 12px; color: var(--text-muted);">Bid Amount</div>
                        <div style="font-weight: 700; color: var(--accent-light);">${tender.currency} ${Number(submission.total_amount).toLocaleString()}</div>
                    </div>
                    <div>
                        <div style="font-size: 12px; color: var(--text-muted);">Score</div>
                        <div style="font-size: 24px; font-weight: 700; color: ${evaluation ? 'var(--success)' : 'var(--text-muted)'};">
                            ${evaluation ? Number(evaluation.total_score).toFixed(1) : 'N/A'}
                        </div>
                    </div>
                    <div style="color: var(--text-muted); font-size: 20px;">
                        <i class="fas fa-chevron-down"></i>
                    </div>
                </div>
            </div>
            <div class="eval-card-body">
                <div class="submission-info-grid">
                    <div class="info-item"><label>Company</label><p>${escapeHtml(submission.company_name)}</p></div>
                    <div class="info-item"><label>Contact Person</label><p>${escapeHtml(submission.contact_name)}</p></div>
                    <div class="info-item"><label>Email</label><p>${escapeHtml(submission.email)}</p></div>
                    <div class="info-item"><label>Phone</label><p>${escapeHtml(submission.phone)}</p></div>
                    <div class="info-item"><label>Bid Amount</label><p style="font-weight: 700; color: var(--accent-light);">${tender.currency} ${Number(submission.total_amount).toLocaleString()}</p></div>
                    <div class="info-item"><label>Submitted</label><p>${formatDateTime(submission.submitted_at)}</p></div>
                </div>

                ${submission.notes ? `
                    <div style="margin-bottom: 20px; padding: 12px; background: var(--bg-primary); border-radius: var(--radius); border-left: 3px solid var(--accent);">
                        <label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Vendor Notes</label>
                        <p style="margin-top: 4px;">${escapeHtml(submission.notes)}</p>
                    </div>
                ` : ''}

                ${submission.files && submission.files.length > 0 ? `
                    <div style="margin-bottom: 24px;">
                        <label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Attached Files</label>
                        <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px;">
                            ${submission.files.map(f => `<span class="chip" style="cursor:pointer;" onclick="downloadSubmissionFile('${f}')"><i class="fas fa-file-arrow-down"></i> ${escapeHtml(fileDisplayName(f))}</span>`).join('')}
                        </div>
                    </div>
                ` : ''}

                <h4 style="margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border);">
                    <i class="fas fa-star" style="color: var(--accent-light); margin-right: 8px;"></i>
                    Scoring Evaluation
                </h4>

                <div id="scoringSection_${submission.id}">
                    ${tender.scoring_criteria.map((criteria, idx) => {
                        const score = evaluation ? (evaluation.scores[criteria.name] || 0) : 0;
                        return `
                            <div class="score-slider-container">
                                <div class="score-slider-header">
                                    <div>
                                        <label>${escapeHtml(criteria.name)}</label>
                                        <span class="weight">(Weight: ${criteria.weight}%)</span>
                                    </div>
                                    <span class="score-value" id="scoreValue_${submission.id}_${idx}">${score}/10</span>
                                </div>
                                <input type="range" class="score-slider" min="0" max="10" step="0.5" value="${score}"
                                        id="score_${submission.id}_${idx}"
                                        data-submission="${submission.id}"
                                        data-criteria="${escapeHtml(criteria.name)}"
                                        data-weight="${criteria.weight}"
                                        oninput="updateScoreDisplay('${submission.id}', ${idx}, this.value)">
                            </div>
                        `;
                    }).join('')}

                    <div class="total-score-display">
                        <div>
                            <div class="label">Weighted Total Score</div>
                            <div style="font-size: 12px; opacity: 0.7; margin-top: 2px;">Out of 10 maximum</div>
                        </div>
                        <div class="score" id="totalScore_${submission.id}">${evaluation ? Number(evaluation.total_score).toFixed(1) : '0.0'}</div>
                    </div>
                </div>

                <div class="eval-notes" style="margin-top: 24px;">
                    <label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); display: block; margin-bottom: 8px;">Evaluation Notes & Comments</label>
                    <textarea class="form-control" id="evalNotes_${submission.id}" placeholder="Add notes about this submission (strengths, weaknesses, concerns...)">${evaluation ? escapeHtml(evaluation.notes || '') : ''}</textarea>
                </div>

                <div style="margin-top: 20px; display: flex; justify-content: flex-end; gap: 12px;">
                    <button class="btn btn-secondary btn-sm" onclick="toggleEvalCard('${submission.id}')">
                        <i class="fas fa-times"></i> Cancel
                    </button>
                    <button class="btn btn-accent btn-sm" onclick="saveEvaluation('${submission.id}', '${tender.id}')">
                        <i class="fas fa-save"></i> Save Evaluation
                    </button>
                </div>
            </div>
        </div>
    `;
}

function toggleEvalCard(submissionId) {
    const card = document.getElementById(`evalCard_${submissionId}`);
    if (card) {
        card.classList.toggle('expanded');
        const icon = card.querySelector('.eval-card-header .fa-chevron-down, .eval-card-header .fa-chevron-up');
        if (icon) { icon.classList.toggle('fa-chevron-down'); icon.classList.toggle('fa-chevron-up'); }
    }
}

function updateScoreDisplay(submissionId, criteriaIndex, value) {
    document.getElementById(`scoreValue_${submissionId}_${criteriaIndex}`).textContent = `${value}/10`;
    calculateTotalScore(submissionId, `score_${submissionId}_`, `totalScore_${submissionId}`);
}

function calculateTotalScore(submissionId, sliderPrefix, totalElId) {
    const sliders = document.querySelectorAll(`input[id^="${sliderPrefix}"]`);
    let totalScore = 0;
    sliders.forEach(slider => {
        const score = parseFloat(slider.value) || 0;
        const weight = parseFloat(slider.dataset.weight) || 0;
        totalScore += (score * weight) / 100;
    });
    document.getElementById(totalElId).textContent = totalScore.toFixed(1);
    return totalScore;
}

async function saveEvaluation(submissionId, tenderId) {
    const sliders = document.querySelectorAll(`input[data-submission="${submissionId}"]`);
    const scores = {};
    sliders.forEach(slider => { scores[slider.dataset.criteria] = parseFloat(slider.value) || 0; });
    const notes = document.getElementById(`evalNotes_${submissionId}`).value.trim();

    try {
        const result = await apiFetch(`/evaluations/submissions/${submissionId}/procurement`, {
            method: 'POST', body: JSON.stringify({ scores, notes })
        });
        showToast('success', 'Evaluation Saved', `Score: ${Number(result.score).toFixed(1)}/10`);
        openTenderEvaluation(tenderId);
    } catch (err) { showToast('error', 'Error', err.message); }
}

// Scoring goes straight to supply chain. The manager's involvement ended when
// they approved the tender itself — they never see the scores.
async function sendForAward(tenderId) {
    let rankings;
    try { rankings = await apiFetch(`/evaluations/tenders/${tenderId}/rankings`); } catch (err) { showToast('error', 'Error', err.message); return; }
    const evaluated = rankings.filter(r => r.evaluation);
    if (evaluated.length === 0) {
        showToast('error', 'Cannot Submit', 'Please evaluate at least one submission first');
        return;
    }
    const top = evaluated[0];

    const message = `
        <p style="margin-bottom: 16px;">This hands the scored tender to Supply Chain, who make the award decision.</p>
        <div style="background: var(--bg-tertiary); padding: 16px; border-radius: var(--radius);">
            <ul style="list-style: none; padding: 0;">
                <li style="margin-bottom: 8px;"><strong>Total Submissions:</strong> ${rankings.length}</li>
                <li style="margin-bottom: 8px;"><strong>Evaluated:</strong> ${evaluated.length}</li>
                <li style="margin-bottom: 8px;"><strong>Top Ranked Vendor:</strong> ${escapeHtml(top.company_name)}</li>
                <li><strong>Top Score:</strong> ${Number(top.score).toFixed(1)}/10</li>
            </ul>
        </div>
        <p style="color: var(--text-muted); font-size: 13px; margin-top: 12px;">Unscored submissions rank last and can no longer win.</p>
    `;
    showConfirmDialog('Send for Award', message, async () => {
        try {
            await apiFetch(`/evaluations/tenders/${tenderId}/submit-for-award`, { method: 'POST' });
            showToast('success', 'Sent!', 'Supply Chain has been notified');
            openTenderEvaluation(tenderId);
        } catch (err) { showToast('error', 'Error', err.message); }
    });
}

// ============================================
// DEPARTMENT MANAGER - TENDER APPROVAL
// ============================================
// The manager decides on the tender itself, not on anyone's scores. A new
// tender sits at `pending_approval` and is invisible to vendors until they
// approve it; sending it back returns it to Procurement to revise and resubmit.
async function renderManagerReviewPage(container) {
    pagerReloaders.review = () => renderManagerReviewPage(container);
    const tenders = await apiAll('/tenders', { status: 'pending_approval' });
    AppState.tenders = tenders;
    const rows = pageLocally('review', tenders);

    container.innerHTML = `
        <div class="card" style="margin-bottom: 24px;">
            <div class="card-header">
                <h3 class="card-title">Tenders Awaiting Your Approval</h3>
                <span class="badge ${tenders.length > 0 ? 'badge-warning' : 'badge-secondary'}">${tenders.length} pending</span>
            </div>
            <div class="card-body">
                <p style="color: var(--text-secondary); margin: 0;">Approving opens a tender to vendors in its category. Sending it back returns it to Procurement with your feedback, and they can revise and resubmit it.</p>
            </div>
        </div>
        ${tenders.length === 0 ? `
            <div class="card"><div class="card-body"><div class="empty-state">
                <i class="fas fa-clipboard-check"></i>
                <h3>Nothing Waiting on You</h3>
                <p>Tenders raised by Procurement will appear here for approval.</p>
            </div></div></div>
        ` : rows.map(renderManagerApprovalCard).join('') + renderPager('review', tenders.length)}
    `;
}

function renderManagerApprovalCard(tender) {
    return `
        <div class="card" style="margin-bottom: 16px;">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">${escapeHtml(tender.name)}</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">${tender.serial}</span>
                </div>
                <span class="badge badge-warning"><i class="fas fa-clock"></i> Awaiting Approval</span>
            </div>
            <div class="card-body">
                <p style="color: var(--text-secondary); margin-bottom: 20px;">${escapeHtml(tender.description)}</p>
                <div class="submission-info-grid">
                    <div class="info-item"><label>Department</label><p>${escapeHtml(deptName(tender.department_id))}</p></div>
                    <div class="info-item"><label>Category</label><p>${tender.category}</p></div>
                    <div class="info-item"><label>Currency</label><p>${tender.currency}</p></div>
                    <div class="info-item"><label>Deadline</label><p>${formatDate(tender.deadline_date)} at ${tender.deadline_time}</p></div>
                </div>
                <div style="margin-top: 20px;">
                    <label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Scoring Criteria</label>
                    <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;">
                        ${(tender.scoring_criteria || []).map(c => `<span class="chip">${escapeHtml(c.name)} <strong>(${c.weight}%)</strong></span>`).join('') || '<span style="color: var(--text-muted);">None</span>'}
                    </div>
                </div>
                <div style="margin-top: 16px;">
                    <label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Required Documents</label>
                    <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;">
                        ${(tender.required_docs || []).map(d => `<span class="chip"><i class="fas fa-file-alt"></i> ${escapeHtml(d)}</span>`).join('') || '<span style="color: var(--text-muted);">None specified</span>'}
                    </div>
                </div>
                <div style="margin-top: 24px; display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;">
                    <button class="btn btn-danger btn-sm" onclick="rejectTenderAsManager('${tender.id}')"><i class="fas fa-times"></i> Send Back</button>
                    <button class="btn btn-success btn-sm" onclick="approveTenderAsManager('${tender.id}')"><i class="fas fa-check"></i> Approve &amp; Open</button>
                </div>
            </div>
        </div>
    `;
}

function approveTenderAsManager(tenderId) {
    showConfirmDialog('Approve Tender', 'This opens the tender to vendors in its category. Continue?', async () => {
        try {
            const tender = await apiFetch(`/tenders/${tenderId}/manager-approve`, { method: 'POST' });
            showToast('success', 'Approved', `${tender.serial} is now open for submissions`);
            navigateTo('review');
        } catch (err) { showToast('error', 'Error', err.message); }
    });
}

function rejectTenderAsManager(tenderId) {
    openReasonModal({
        title: 'Send Tender Back',
        description: 'Procurement will see this feedback and can revise and resubmit the tender.',
        label: 'Reason *',
        submitLabel: 'Send Back',
        onSubmit: async (reason) => {
            try {
                await apiFetch(`/tenders/${tenderId}/manager-reject`, { method: 'POST', body: JSON.stringify({ reason }) });
                showToast('info', 'Sent Back', 'Procurement has been notified');
                navigateTo('review');
            } catch (err) { showToast('error', 'Error', err.message); }
        }
    });
}

// 'history' is in the manager's nav but had no case in the render dispatch, so
// the menu item used to quietly land on the dashboard.
async function renderManagerHistoryPage(container) {
    pagerReloaders.history = () => renderManagerHistoryPage(container);
    // There's no "decided by me" filter on the API, so the flags are read off
    // the whole set and the result is paged here instead.
    const decided = (await apiAll('/tenders')).filter(t => t.manager_approved || t.manager_rejected);
    const rows = pageLocally('history', decided);

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">Decision History</h3>
                <span class="badge badge-info">${decided.length} decided</span>
            </div>
            <div class="card-body" style="padding: 0;">
                ${decided.length === 0 ? `
                    <div style="padding: 24px;"><div class="empty-state">
                        <i class="fas fa-history"></i><h3>No Decisions Yet</h3><p>Tenders you approve or send back will appear here.</p>
                    </div></div>
                ` : `
                    <div class="table-container">
                        <table>
                            <thead><tr><th>Tender</th><th>Your Decision</th><th>Reviewed</th><th>Where It Is Now</th></tr></thead>
                            <tbody>
                                ${rows.map(tender => `
                                    <tr>
                                        <td><strong>${escapeHtml(tender.name)}</strong><div style="font-size: 12px; color: var(--text-muted);">${tender.serial}</div></td>
                                        <td><span class="badge ${tender.manager_approved ? 'badge-success' : 'badge-danger'}">${tender.manager_approved ? 'Approved' : 'Sent Back'}</span>
                                            ${tender.manager_feedback ? `<div style="font-size: 12px; color: var(--text-muted); max-width: 260px;">${escapeHtml(tender.manager_feedback)}</div>` : ''}</td>
                                        <td>${tender.manager_reviewed_at ? formatDateTime(tender.manager_reviewed_at) : '-'}</td>
                                        <td><span class="badge badge-info">${tender.status.replace('_', ' ')}</span>
                                            ${tender.awarded_vendor_name ? `<div style="font-size: 12px; color: var(--text-muted);">Awarded to ${escapeHtml(tender.awarded_vendor_name)}</div>` : ''}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                    ${renderPager('history', decided.length)}
                `}
            </div>
        </div>
    `;
}

// ============================================
// SUPPLY CHAIN HEAD APPROVALS
// ============================================
async function renderSupplyChainApprovalsPage(container) {
    pagerReloaders.approvals = () => renderSupplyChainApprovalsPage(container);
    pagerReloaders.scProcessed = () => renderSupplyChainApprovalsPage(container);
    const tenders = await apiAll('/tenders');
    AppState.tenders = tenders;
    const pendingApprovals = tenders.filter(t => t.evaluation_submitted && !t.supply_chain_approved && !t.supply_chain_rejected);
    const processedTenders = tenders.filter(t => t.supply_chain_approved || t.supply_chain_rejected);
    const processedRows = pageLocally('scProcessed', processedTenders);

    const pendingCards = await Promise.all(pageLocally('approvals', pendingApprovals).map(async tender => {
        let rankings = [];
        try { rankings = await apiFetch(`/evaluations/tenders/${tender.id}/rankings`); } catch (e) {}
        // Unscored submissions sort last but are still in the list, so the
        // recommendation has to come from the scored ones, not from rankings[0].
        const scored = rankings.filter(s => s.score !== null && s.score !== undefined);
        const top = scored[0];
        return `
            <div class="card" style="margin-bottom: 16px;">
                <div class="card-header">
                    <div><h3 class="card-title" style="margin-bottom: 4px;">${escapeHtml(tender.name)}</h3><span style="font-size: 13px; color: var(--text-muted);">${tender.serial}</span></div>
                    <span class="badge badge-warning"><i class="fas fa-clock"></i> Awaiting Final Approval</span>
                </div>
                <div class="card-body">
                    <div style="margin-bottom: 20px; padding: 16px; background: linear-gradient(135deg, rgba(63, 174, 114, 0.10) 0%, var(--bg-tertiary) 100%); border-radius: var(--radius); border-left: 4px solid var(--success);">
                        <h4 style="margin-bottom: 4px; color: var(--success);"><i class="fas fa-trophy" style="margin-right: 8px;"></i>Highest Scored</h4>
                        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">Procurement's ranking is a guide — you can award any scored vendor.</p>
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px;">
                            <div><label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Company</label><p style="font-weight: 700; font-size: 16px;">${top ? escapeHtml(top.company_name) : '-'}</p></div>
                            <div><label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Bid Amount</label><p style="font-weight: 700; color: var(--accent-light);">${tender.currency} ${top ? Number(top.total_amount).toLocaleString() : '-'}</p></div>
                            <div><label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Score</label><p style="font-weight: 700; color: var(--success); font-size: 18px;">${top ? Number(top.score).toFixed(1) : '-'}/10</p></div>
                            <div><label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Contact</label><p>${top ? escapeHtml(top.contact_name) : '-'}</p></div>
                        </div>
                    </div>
                    <h4 style="margin-bottom: 12px; font-size: 14px; color: var(--text-muted); text-transform: uppercase;">Scored Vendors</h4>
                    <div class="table-container">
                        <table>
                            <thead><tr><th>Rank</th><th>Vendor</th><th>Score</th><th>Bid Amount</th></tr></thead>
                            <tbody>
                                ${scored.map((sub, idx) => `
                                    <tr style="${idx === 0 ? 'background: rgba(63, 174, 114, 0.06);' : ''}">
                                        <td><span class="rank-badge ${idx === 0 ? 'gold' : idx === 1 ? 'silver' : idx === 2 ? 'bronze' : 'default'}" style="width: 32px; height: 32px; font-size: 14px;">${idx + 1}</span></td>
                                        <td><strong>${escapeHtml(sub.company_name)}</strong><div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(sub.email)}</div></td>
                                        <td style="color: var(--success); font-weight: 700;">${Number(sub.score).toFixed(1)}</td>
                                        <td>${tender.currency} ${Number(sub.total_amount).toLocaleString()}</td>
                                    </tr>
                                `).join('') || `<tr><td colspan="4" style="text-align:center; padding: 20px; color: var(--text-muted);">Nothing scored yet</td></tr>`}
                            </tbody>
                        </table>
                    </div>
                    ${rankings.length > scored.length ? `<p style="margin-top: 12px; font-size: 13px; color: var(--text-muted);"><i class="fas fa-circle-info"></i> ${rankings.length - scored.length} submission(s) went unscored and cannot be awarded.</p>` : ''}
                    <div style="margin-top: 24px; display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;">
                        <button class="btn btn-secondary btn-sm" onclick="openTenderRankings('${tender.id}')"><i class="fas fa-eye"></i> View Full Details</button>
                        <button class="btn btn-danger btn-sm" onclick="rejectSupplyChain('${tender.id}')"><i class="fas fa-times"></i> Reject</button>
                        <button class="btn btn-success" onclick="approveSupplyChain('${tender.id}')" ${top ? '' : 'disabled title="Nothing has been scored yet"'}><i class="fas fa-check"></i> Choose Winner &amp; Award</button>
                    </div>
                </div>
            </div>
        `;
    }));

    container.innerHTML = `
        <div class="tabs">
            <div class="tab active" onclick="switchSupplyChainTab('pending', this)">Pending Approvals (${pendingApprovals.length})</div>
            <div class="tab" onclick="switchSupplyChainTab('processed', this)">Processed (${processedTenders.length})</div>
        </div>
        <div id="scPendingTab">
            ${pendingApprovals.length === 0
                ? `<div class="card"><div class="card-body"><div class="empty-state"><i class="fas fa-stamp"></i><h3>No Pending Approvals</h3><p>A tender reaches you when Procurement scores the bids <em>and</em> clicks Send for Award. Scoring on its own doesn't hand it over, so a tender can be fully scored and still not be here yet.</p></div></div></div>`
                : pendingCards.join('') + renderPager('approvals', pendingApprovals.length)}
        </div>
        <div id="scProcessedTab" style="display: none;">
            ${processedTenders.length === 0 ? `<div class="card"><div class="card-body"><div class="empty-state"><i class="fas fa-history"></i><h3>No Processing History</h3><p>Tenders you award or reject will appear here.</p></div></div></div>` : `
                <div class="card"><div class="card-body" style="padding: 0;"><div class="table-container">
                    <table>
                        <thead><tr><th>Tender</th><th>Awarded Vendor</th><th>Amount</th><th>Decision</th><th>Date</th></tr></thead>
                        <tbody>
                            ${processedRows.map(tender => `
                                <tr>
                                    <td><strong>${escapeHtml(tender.name)}</strong><div style="font-size: 12px; color: var(--text-muted);">${tender.serial}</div></td>
                                    <td>${tender.supply_chain_approved ? escapeHtml(tender.awarded_vendor_name || '-') : '-'}</td>
                                    <td>${tender.supply_chain_approved ? `${tender.currency} ${Number(tender.awarded_amount || 0).toLocaleString()}` : '-'}</td>
                                    <td><span class="badge ${tender.supply_chain_approved ? 'badge-success' : 'badge-danger'}">${tender.supply_chain_approved ? 'Awarded' : 'Rejected'}</span>
                                        ${tender.supply_chain_rejection_reason ? `<div style="font-size: 12px; color: var(--text-muted); max-width: 240px;">${escapeHtml(tender.supply_chain_rejection_reason)}</div>` : ''}</td>
                                    <td>${tender.supply_chain_reviewed_at ? formatDateTime(tender.supply_chain_reviewed_at) : '-'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
                ${renderPager('scProcessed', processedTenders.length)}
                </div></div>
            `}
        </div>
    `;
}

function switchSupplyChainTab(tab, element) {
    document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
    element.classList.add('active');
    document.getElementById('scPendingTab').style.display = tab === 'pending' ? 'block' : 'none';
    document.getElementById('scProcessedTab').style.display = tab === 'processed' ? 'block' : 'none';
}

// Read-only: nobody outside Procurement writes scores, so this shows the
// evaluation rather than offering to change it.
async function openTenderRankings(tenderId) {
    const container = document.getElementById('contentArea');
    showLoading(container);

    let tender, rankings;
    try {
        [tender, rankings] = await Promise.all([
            apiFetch(`/tenders/${tenderId}`),
            apiFetch(`/evaluations/tenders/${tenderId}/rankings`)
        ]);
    } catch (err) { showLoadError(container, err, `openTenderRankings('${tenderId}')`); return; }

    const back = AppState.currentPage === 'approved' ? 'approved' : 'approvals';

    container.innerHTML = `
        <div style="margin-bottom: 24px;">
            <button class="btn btn-secondary btn-sm" onclick="navigateTo('${back}')"><i class="fas fa-arrow-left"></i> Back</button>
        </div>
        <div class="card" style="margin-bottom: 24px;">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">${escapeHtml(tender.name)}</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">${tender.serial}</span>
                </div>
                <span class="badge badge-info">${tender.status.replace('_', ' ')}</span>
            </div>
            <div class="card-body">
                <p style="color: var(--text-secondary); margin-bottom: 20px;">${escapeHtml(tender.description)}</p>
                <div class="submission-info-grid">
                    <div class="info-item"><label>Department</label><p>${escapeHtml(deptName(tender.department_id))}</p></div>
                    <div class="info-item"><label>Category</label><p>${tender.category}</p></div>
                    <div class="info-item"><label>Deadline</label><p>${formatDate(tender.deadline_date)} at ${tender.deadline_time}</p></div>
                    <div class="info-item"><label>Submissions</label><p>${tender.submission_count || 0}</p></div>
                </div>
                <h4 style="margin: 24px 0 12px; font-size: 14px; color: var(--text-muted); text-transform: uppercase;">Scoring Criteria</h4>
                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                    ${(tender.scoring_criteria || []).map(c => `<span class="chip" style="background: var(--accent); color: #fff;">${escapeHtml(c.name)} <strong>(${c.weight}%)</strong></span>`).join('')}
                </div>
            </div>
        </div>
        ${rankings.map((sub, idx) => `
            <div class="card" style="margin-bottom: 16px;">
                <div class="card-header">
                    <div style="display: flex; align-items: center; gap: 16px;">
                        <div class="rank-badge ${sub.evaluation ? (idx === 0 ? 'gold' : idx === 1 ? 'silver' : idx === 2 ? 'bronze' : 'default') : 'default'}">${sub.evaluation ? idx + 1 : '-'}</div>
                        <div>
                            <h3 class="card-title" style="margin-bottom: 4px;">${escapeHtml(sub.company_name)}</h3>
                            <span style="font-size: 13px; color: var(--text-muted);">${escapeHtml(sub.contact_name)} &bull; ${escapeHtml(sub.email)}</span>
                        </div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 12px; color: var(--text-muted);">Score</div>
                        <div style="font-size: 24px; font-weight: 700; color: ${sub.evaluation ? 'var(--success)' : 'var(--text-muted)'};">${sub.score !== null && sub.score !== undefined ? Number(sub.score).toFixed(1) : 'Not scored'}</div>
                    </div>
                </div>
                <div class="card-body">
                    <div class="submission-info-grid">
                        <div class="info-item"><label>Bid Amount</label><p style="font-weight: 700; color: var(--accent-light);">${tender.currency} ${Number(sub.total_amount).toLocaleString()}</p></div>
                        <div class="info-item"><label>Phone</label><p>${escapeHtml(sub.phone)}</p></div>
                        <div class="info-item"><label>Submitted</label><p>${formatDateTime(sub.submitted_at)}</p></div>
                    </div>
                    ${sub.evaluation ? `
                        <div style="margin-top: 16px;">
                            <label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Criterion Scores</label>
                            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;">
                                ${Object.entries(sub.evaluation.scores || {}).map(([name, value]) => `<span class="chip">${escapeHtml(name)} <strong>${value}/10</strong></span>`).join('')}
                            </div>
                        </div>
                        ${sub.evaluation.notes ? `<div style="margin-top: 16px; padding: 12px; background: var(--bg-primary); border-radius: var(--radius); border-left: 3px solid var(--accent);"><label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Evaluator Notes</label><p style="margin-top: 4px;">${escapeHtml(sub.evaluation.notes)}</p></div>` : ''}
                    ` : ''}
                    ${sub.notes ? `<div style="margin-top: 16px; padding: 12px; background: var(--bg-primary); border-radius: var(--radius);"><label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Vendor Notes</label><p style="margin-top: 4px;">${escapeHtml(sub.notes)}</p></div>` : ''}
                    ${sub.files && sub.files.length > 0 ? `
                        <div style="margin-top: 16px;">
                            <label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Attached Files</label>
                            <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px;">
                                ${sub.files.map(f => `<span class="chip" style="cursor:pointer;" onclick="downloadSubmissionFile('${escapeAttr(f)}')"><i class="fas fa-file-arrow-down"></i> ${escapeHtml(fileDisplayName(f))}</span>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `).join('') || `<div class="card"><div class="card-body"><div class="empty-state"><i class="fas fa-inbox"></i><h3>No Submissions</h3></div></div></div>`}
    `;
}

// The award is Supply Chain's call. Procurement's score orders the list and
// pre-selects the top bid, but any scored vendor can be picked — hence a radio
// list rather than a confirm dialog for a decision already taken. Departing
// from the ranking asks for a reason, which lands in the audit log.
async function approveSupplyChain(tenderId) {
    let rankings;
    try { rankings = await apiFetch(`/evaluations/tenders/${tenderId}/rankings`); } catch (err) { showToast('error', 'Error', err.message); return; }
    const scored = rankings.filter(r => r.score !== null && r.score !== undefined);
    if (scored.length === 0) {
        showToast('error', 'Cannot Award', 'No submission on this tender has been scored');
        return;
    }
    const currency = (AppState.tenders || []).find(t => t.id === tenderId)?.currency || '';

    const message = `
        <p style="margin-bottom: 16px;">Choose the winning bid. This is <strong>final approval</strong> — it awards the tender and emails every vendor.</p>
        <div style="display: flex; flex-direction: column; gap: 8px;">
            ${scored.map((sub, idx) => `
                <label style="display: flex; align-items: center; gap: 12px; padding: 12px; border: 2px solid var(--border); border-radius: var(--radius); cursor: pointer;"
                       onclick="document.querySelectorAll('#awardChoices label').forEach(l => l.style.borderColor='var(--border)'); this.style.borderColor='var(--accent)';">
                    <input type="radio" name="awardChoice" value="${sub.id}" ${idx === 0 ? 'checked' : ''} data-rank="${idx + 1}" onchange="onAwardChoiceChange()">
                    <span class="rank-badge ${idx === 0 ? 'gold' : idx === 1 ? 'silver' : idx === 2 ? 'bronze' : 'default'}" style="width: 28px; height: 28px; font-size: 13px;">${idx + 1}</span>
                    <span style="flex: 1;">
                        <strong>${escapeHtml(sub.company_name)}</strong>
                        <span style="display: block; font-size: 12px; color: var(--text-muted);">${escapeHtml(sub.email)}</span>
                    </span>
                    <span style="text-align: right; white-space: nowrap;">
                        <span style="display: block; font-weight: 700; color: var(--success);">${Number(sub.score).toFixed(1)}/10</span>
                        <span style="font-size: 12px; color: var(--text-muted);">${currency} ${Number(sub.total_amount).toLocaleString()}</span>
                    </span>
                </label>
            `).join('')}
        </div>
        <div id="awardReasonWrap" style="margin-top: 16px; display: none;">
            <label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Why not the top-scored bid? *</label>
            <textarea id="awardReason" class="form-control" rows="3" style="margin-top: 6px;" placeholder="Recorded in the audit log alongside the award"></textarea>
        </div>
        <p style="color: var(--text-muted); font-size: 13px; margin-top: 12px;"><i class="fas fa-envelope"></i> Result emails go to all ${rankings.length} vendor(s) who submitted.</p>
        ${rankings.length > scored.length ? `<p style="color: var(--text-muted); font-size: 13px;"><i class="fas fa-circle-info"></i> ${rankings.length - scored.length} unscored submission(s) can't be awarded.</p>` : ''}
    `;

    showConfirmDialog('Award Tender', `<div id="awardChoices">${message}</div>`, async () => {
        const picked = document.querySelector('input[name="awardChoice"]:checked');
        if (!picked) return;
        const rank = Number(picked.dataset.rank);
        const reason = (document.getElementById('awardReason')?.value || '').trim();
        // Reopening keeps the selection and any half-typed reason, which a
        // toast-and-abort would throw away.
        if (rank > 1 && !reason) {
            showToast('error', 'Reason Required', 'Say why you are not awarding the top-scored bid');
            openModal('confirmModal');
            return;
        }
        try {
            const result = await apiFetch(`/evaluations/tenders/${tenderId}/supply-chain-approve`, {
                method: 'POST',
                body: JSON.stringify({ submission_id: picked.value, reason: reason || null })
            });
            showToast('success', 'Tender Awarded!', result.detail || `${result.awarded_vendor} selected`);
            renderSupplyChainApprovalsPage(document.getElementById('contentArea'));
        } catch (err) { showToast('error', 'Error', err.message); }
    });
    onAwardChoiceChange();
}

// Moving a live award, for when the winner can't deliver. Separate from
// approveSupplyChain: the incumbent is excluded rather than pre-selected, and
// the reason is always required — someone is being told a contract is off.
async function openReassignAward(tenderId) {
    let tender, rankings;
    try {
        [tender, rankings] = await Promise.all([
            apiFetch(`/tenders/${tenderId}`),
            apiFetch(`/evaluations/tenders/${tenderId}/rankings`)
        ]);
    } catch (err) { showToast('error', 'Error', err.message); return; }

    const scored = rankings.filter(r => r.score !== null && r.score !== undefined);
    const alternatives = scored.filter(r => r.id !== tender.awarded_vendor_submission_id);
    if (alternatives.length === 0) {
        showToast('error', 'No Alternative', 'No other scored bid on this tender can take the award');
        return;
    }

    const message = `
        <div style="padding: 12px; border-radius: var(--radius); border-left: 3px solid var(--warning); background: var(--bg-primary); margin-bottom: 16px;">
            <strong>Currently awarded to ${escapeHtml(tender.awarded_vendor_name || '-')}</strong>
            <p style="margin-top: 4px; color: var(--text-secondary);">They will be emailed that the award has been withdrawn. The new vendor gets the winner email. Everyone else already had their answer and is not contacted again.</p>
        </div>
        <div id="reassignChoices" style="display: flex; flex-direction: column; gap: 8px;">
            ${alternatives.map(sub => `
                <label style="display: flex; align-items: center; gap: 12px; padding: 12px; border: 2px solid var(--border); border-radius: var(--radius); cursor: pointer;">
                    <input type="radio" name="reassignChoice" value="${sub.id}">
                    <span style="flex: 1;">
                        <strong>${escapeHtml(sub.company_name)}</strong>
                        <span style="display: block; font-size: 12px; color: var(--text-muted);">${escapeHtml(sub.email)}</span>
                    </span>
                    <span style="text-align: right; white-space: nowrap;">
                        <span style="display: block; font-weight: 700; color: var(--success);">${Number(sub.score).toFixed(1)}/10</span>
                        <span style="font-size: 12px; color: var(--text-muted);">${tender.currency} ${Number(sub.total_amount).toLocaleString()}</span>
                    </span>
                </label>
            `).join('')}
        </div>
        <div style="margin-top: 16px;">
            <label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Why is the award being moved? *</label>
            <textarea id="reassignReason" class="form-control" rows="3" style="margin-top: 6px;" placeholder="e.g. supplier cannot source the units within the contract window"></textarea>
        </div>
    `;

    showConfirmDialog('Reassign Award', message, async () => {
        const picked = document.querySelector('input[name="reassignChoice"]:checked');
        const reason = (document.getElementById('reassignReason')?.value || '').trim();
        if (!picked || !reason) {
            showToast('error', 'Incomplete', picked ? 'A reason is required' : 'Choose the vendor taking the award');
            openModal('confirmModal');
            return;
        }
        try {
            const result = await apiFetch(`/evaluations/tenders/${tenderId}/reassign-award`, {
                method: 'POST',
                body: JSON.stringify({ submission_id: picked.value, reason })
            });
            showToast('success', 'Award Moved', result.detail);
            renderPage(AppState.currentPage);
        } catch (err) { showToast('error', 'Error', err.message); }
    });
}

function onAwardChoiceChange() {
    const picked = document.querySelector('input[name="awardChoice"]:checked');
    const wrap = document.getElementById('awardReasonWrap');
    if (!picked || !wrap) return;
    wrap.style.display = Number(picked.dataset.rank) > 1 ? 'block' : 'none';
}

function rejectSupplyChain(tenderId) {
    openReasonModal({
        title: 'Reject Tender',
        description: 'Please provide a reason for rejecting this tender. The department manager will be notified.',
        label: 'Rejection Reason *',
        submitLabel: 'Reject Tender',
        onSubmit: async (reason) => {
            try {
                await apiFetch(`/evaluations/tenders/${tenderId}/supply-chain-reject`, { method: 'POST', body: JSON.stringify({ reason }) });
                showToast('info', 'Tender Rejected', 'Relevant parties have been notified');
                renderSupplyChainApprovalsPage(document.getElementById('contentArea'));
            } catch (err) { showToast('error', 'Error', err.message); }
        }
    });
}

async function renderApprovedTendersPage(container) {
    pagerReloaders.approved = () => renderApprovedTendersPage(container);
    const page = await apiList('/tenders', { ...pagerParams('approved'), status: 'awarded' });

    container.innerHTML = `
        <div class="card">
            <div class="card-header"><h3 class="card-title">Awarded Tenders</h3><span class="badge badge-success">${page.total} awarded</span></div>
            <div class="card-body" style="padding: 0;">
                ${page.total === 0 ? `
                    <div style="padding: 24px;"><div class="empty-state"><i class="fas fa-check-double"></i><h3>No Awarded Tenders</h3><p>Tenders you approve will appear here.</p></div></div>
                ` : `
                    <div class="table-container">
                        <table>
                            <thead><tr><th>Serial</th><th>Tender Name</th><th>Awarded Vendor</th><th>Amount</th><th>Approved Date</th><th>Actions</th></tr></thead>
                            <tbody>
                                ${page.items.map(tender => `
                                    <tr>
                                        <td><code>${tender.serial}</code></td>
                                        <td><strong>${escapeHtml(tender.name)}</strong></td>
                                        <td>${escapeHtml(tender.awarded_vendor_name || '-')}</td>
                                        <td style="font-weight: 700; color: var(--accent-light);">${tender.currency} ${Number(tender.awarded_amount || 0).toLocaleString()}</td>
                                        <td>${tender.supply_chain_reviewed_at ? formatDateTime(tender.supply_chain_reviewed_at) : '-'}</td>
                                        <td>
                                            <div class="actions">
                                                <button class="action-btn" onclick="openTenderRankings('${tender.id}')" title="View evaluation"><i class="fas fa-eye"></i></button>
                                                <button class="action-btn" onclick="openReassignAward('${tender.id}')" title="Move this award to another vendor"><i class="fas fa-right-left"></i></button>
                                            </div>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                    ${renderPager('approved', page.total)}
                `}
            </div>
        </div>
    `;
}

// ============================================
// FINANCE NOTIFICATIONS & REPORTS
// ============================================
async function renderFinanceNotificationsPage(container) {
    pagerReloaders.notifications = () => renderFinanceNotificationsPage(container);
    // The unread tally is its own endpoint: a page of rows can't tell you how
    // many unread ones sit on the pages you aren't looking at.
    const [page, unread] = await Promise.all([
        apiList('/notifications', pagerParams('notifications')),
        apiFetch('/notifications/unread-count')
    ]);
    const notifications = page.items;
    const unreadCount = unread.unread;
    AppState.unreadCount = unreadCount;

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title"><i class="fas fa-bell" style="margin-right: 8px;"></i>Notifications ${unreadCount > 0 ? `<span class="badge badge-danger" style="margin-left: 8px;">${unreadCount} new</span>` : ''}</h3>
                ${notifications.length > 0 ? `<button class="btn btn-secondary btn-sm" onclick="markAllFinanceRead()"><i class="fas fa-check-double"></i> Mark All Read</button>` : ''}
            </div>
            <div class="card-body">
                ${notifications.length === 0 ? `
                    <div class="empty-state"><i class="fas fa-bell-slash"></i><h3>No Notifications</h3><p>Award notifications from Supply Chain will appear here.</p></div>
                ` : `
                    <div style="display: flex; flex-direction: column; gap: 12px;">
                        ${notifications.map(notification => {
                            const isAwarded = notification.type === 'tender_awarded';
                            return `
                                <div style="padding: 20px; background: ${notification.read ? 'var(--bg-tertiary)' : 'linear-gradient(135deg, rgba(59, 125, 221, 0.06) 0%, var(--bg-tertiary) 100%)'}; border: 1px solid ${notification.read ? 'var(--border)' : 'var(--accent)'}; border-radius: var(--radius-lg); ${notification.read ? '' : 'border-left: 4px solid var(--accent);'}">
                                    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap;">
                                        <div style="flex: 1; min-width: 250px;">
                                            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                                                <span class="badge ${isAwarded ? 'badge-success' : 'badge-info'}"><i class="fas fa-${isAwarded ? 'trophy' : 'info-circle'}"></i> ${isAwarded ? 'Tender Awarded' : 'Notification'}</span>
                                                ${!notification.read ? '<span class="badge badge-danger">NEW</span>' : ''}
                                            </div>
                                            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 12px;">${escapeHtml(notification.message)}</p>
                                            ${isAwarded && notification.details ? `
                                                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; padding: 12px; background: var(--bg-secondary); border-radius: var(--radius);">
                                                    <div><label style="font-size: 10px; text-transform: uppercase; color: var(--text-muted);">Vendor</label><p style="font-weight: 600;">${escapeHtml(notification.details.vendor || '')}</p></div>
                                                    <div><label style="font-size: 10px; text-transform: uppercase; color: var(--text-muted);">Amount</label><p style="font-weight: 700; color: var(--accent-light);">${notification.details.currency || ''} ${Number(notification.details.amount || 0).toLocaleString()}</p></div>
                                                    <div><label style="font-size: 10px; text-transform: uppercase; color: var(--text-muted);">Vendor Email</label><p>${escapeHtml(notification.details.email || '')}</p></div>
                                                </div>
                                            ` : ''}
                                        </div>
                                        <div style="text-align: right;">
                                            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">${formatDateTime(notification.created_at)}</div>
                                            ${!notification.read ? `<button class="btn btn-secondary btn-sm" onclick="markNotificationRead('${notification.id}')"><i class="fas fa-check"></i> Mark Read</button>` : ''}
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    ${renderPager('notifications', page.total)}
                `}
            </div>
        </div>
    `;
}

async function markNotificationRead(notificationId) {
    try { await apiFetch(`/notifications/${notificationId}/read`, { method: 'POST' }); renderFinanceNotificationsPage(document.getElementById('contentArea')); refreshNotificationBadgeOnly(); }
    catch (err) { showToast('error', 'Error', err.message); }
}

async function markAllFinanceRead() {
    try {
        await apiFetch('/notifications/mark-all-read', { method: 'POST' });
        showToast('success', 'Done', 'All notifications marked as read');
        renderFinanceNotificationsPage(document.getElementById('contentArea'));
        refreshNotificationBadgeOnly();
    } catch (err) { showToast('error', 'Error', err.message); }
}

async function renderFinanceReportsPage(container) {
    pagerReloaders.report = () => renderFinanceReportsPage(container);
    // The headline figures are aggregated server-side over every awarded tender,
    // so paging the table underneath never moves them.
    const report = await apiFetch(`/reports/finance${qs(pagerParams('report'))}`);
    const currencyEntries = Object.entries(report.by_currency || {});

    container.innerHTML = `
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-icon green"><i class="fas fa-check-circle"></i></div><div class="stat-content"><h3>${report.awarded_count}</h3><p>Awarded Tenders</p></div></div>
            <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-building"></i></div><div class="stat-content"><h3>${report.unique_vendors}</h3><p>Unique Vendors</p></div></div>
            <div class="stat-card"><div class="stat-icon amber"><i class="fas fa-coins"></i></div><div class="stat-content"><h3>${currencyEntries.length}</h3><p>Currencies</p></div></div>
            <div class="stat-card"><div class="stat-icon purple"><i class="fas fa-bell"></i></div><div class="stat-content"><h3>${report.has_pending_actions ? 'Yes' : 'No'}</h3><p>Pending Actions</p></div></div>
        </div>
        ${currencyEntries.length > 0 ? `
            <div class="card" style="margin-bottom: 24px;">
                <div class="card-header"><h3 class="card-title">Awarded Amounts by Currency</h3></div>
                <div class="card-body">
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
                        ${currencyEntries.map(([currency, data]) => `
                            <div style="padding: 20px; background: linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%); border-radius: var(--radius-lg); color: #fff;">
                                <div style="font-size: 14px; opacity: 0.9; margin-bottom: 4px;">${currency}</div>
                                <div style="font-size: 28px; font-weight: 700;">${Number(data.total).toLocaleString()}</div>
                                <div style="font-size: 12px; opacity: 0.8; margin-top: 4px;">${data.count} tender${data.count !== 1 ? 's' : ''}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        ` : ''}
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">Awarded Tenders Report</h3>
                ${report.awarded_count > 0 ? `<button class="btn btn-secondary btn-sm" onclick="exportFinanceReport()"><i class="fas fa-download"></i> Export CSV (all ${report.awarded_count})</button>` : ''}
            </div>
            <div class="card-body">
                ${report.tenders.length === 0 ? `
                    <div class="empty-state"><i class="fas fa-file-invoice-dollar"></i><h3>No Awarded Tenders</h3><p>Financial reports will be generated once tenders are awarded.</p></div>
                ` : `
                    <div class="table-container">
                        <table>
                            <thead><tr><th>Serial</th><th>Tender Name</th><th>Vendor</th><th>Contact</th><th>Currency</th><th>Amount</th><th>Award Date</th></tr></thead>
                            <tbody>
                                ${report.tenders.map(t => `
                                    <tr>
                                        <td><code>${t.serial}</code></td>
                                        <td><strong>${escapeHtml(t.name)}</strong></td>
                                        <td>${escapeHtml(t.vendor || '-')}</td>
                                        <td>${escapeHtml(t.email || '-')}</td>
                                        <td><span class="badge badge-info">${t.currency}</span></td>
                                        <td style="font-weight: 700; color: var(--accent-light);">${Number(t.amount).toLocaleString()}</td>
                                        <td>${t.awarded_at ? formatDateTime(t.awarded_at) : '-'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                    ${renderPager('report', report.awarded_count)}
                `}
            </div>
        </div>
    `;
}

function exportFinanceReport() {
    apiDownload('/reports/finance/export.csv', `finance_report_${new Date().toISOString().split('T')[0]}.csv`);
}

// ============================================
// EMAIL TEMPLATES & LOG
// ============================================
// /emails/config and /emails/test are admin-only, while this page is open to
// procurement too — so the card is fetched separately and simply omitted for
// anyone who can't read it, rather than failing the whole page.
async function mailStatusCard() {
    if (AppState.currentUser?.role !== 'admin') return '';
    let cfg;
    try { cfg = await apiFetch('/emails/config'); } catch (e) { return ''; }

    if (!cfg.configured) {
        return `
            <div class="card" style="margin-bottom: 24px; border-left: 4px solid var(--warning);">
                <div class="card-body">
                    <strong><i class="fas fa-plug-circle-xmark" style="color: var(--warning); margin-right: 8px;"></i>No mail server configured</strong>
                    <p style="color: var(--text-secondary); margin-top: 8px;">Award emails are rendered and logged as <em>simulated</em>, never delivered. Set <code>SMTP_HOST</code> in the backend <code>.env</code> and restart to send for real.</p>
                </div>
            </div>`;
    }

    return `
        <div class="card" style="margin-bottom: 24px; border-left: 4px solid ${cfg.redirect_all_mail_to ? 'var(--warning)' : 'var(--success)'};">
            <div class="card-header">
                <h3 class="card-title"><i class="fas fa-paper-plane" style="margin-right: 8px;"></i>Mail Delivery</h3>
                <button class="btn btn-secondary btn-sm" onclick="sendTestEmail()"><i class="fas fa-vial"></i> Send Test Email</button>
            </div>
            <div class="card-body">
                <div class="submission-info-grid">
                    <div class="info-item"><label>SMTP Host</label><p>${escapeHtml(cfg.host)}:${cfg.port}</p></div>
                    <div class="info-item"><label>Account</label><p>${escapeHtml(cfg.username || 'not set')}</p></div>
                    <div class="info-item"><label>From</label><p>${escapeHtml(cfg.from || 'not set')}</p></div>
                </div>
                ${cfg.redirect_all_mail_to ? `
                    <div style="margin-top: 16px; padding: 12px; background: var(--bg-primary); border-radius: var(--radius); border-left: 3px solid var(--warning);">
                        <strong><i class="fas fa-triangle-exclamation" style="color: var(--warning);"></i> Test redirect is on</strong>
                        <p style="margin-top: 4px; color: var(--text-secondary);">Every vendor email goes to <code>${escapeHtml(cfg.redirect_all_mail_to)}</code> instead of the vendor. Clear <code>MAIL_REDIRECT_TO</code> in <code>.env</code> before going live.</p>
                    </div>` : ''}
            </div>
        </div>`;
}

async function sendTestEmail() {
    const to = prompt('Send a test email to:');
    if (!to) return;
    showToast('info', 'Sending', 'Contacting the mail server...');
    try {
        const result = await apiFetch(`/emails/test?to=${encodeURIComponent(to.trim())}`, { method: 'POST' });
        showToast('success', 'Sent', result.detail);
    } catch (err) { showToast('error', 'Delivery Failed', err.message); }
}

async function renderEmailTemplatesPage(container) {
    const templates = await apiFetch('/emails/templates');
    const mailCard = await mailStatusCard();

    // Driven off a list rather than a tab per hardcoded type — award_revoked was
    // added later, and a fourth would otherwise mean editing four places.
    const TEMPLATE_TABS = [
        { type: 'winner', label: 'Winner Email', icon: 'fa-trophy', badge: 'Sent to winning vendor', badgeClass: 'badge-success' },
        { type: 'loser', label: 'Non-Winner Email', icon: 'fa-envelope', badge: 'Sent to every other bidder', badgeClass: 'badge-secondary' },
        { type: 'award_revoked', label: 'Award Withdrawn', icon: 'fa-right-left', badge: 'Sent when an award is reassigned', badgeClass: 'badge-warning' }
    ];
    const contentOf = t => templates.find(x => x.type === t) || { subject: '', body: '' };

    const placeholders = [
        { key: '{vendor_company}', desc: 'Vendor company name' },
        { key: '{vendor_contact}', desc: 'Contact person name' },
        { key: '{vendor_email}', desc: 'Vendor email address' },
        { key: '{tender_name}', desc: 'Tender name' },
        { key: '{tender_serial}', desc: 'Tender serial number' },
        { key: '{tender_category}', desc: 'Tender category' },
        { key: '{currency}', desc: 'Currency code' },
        { key: '{awarded_amount}', desc: 'Winning bid amount (winner only)' },
        { key: '{bid_amount}', desc: 'Vendor bid amount' },
        // Name kept from when scoring had two stages; it now carries the single
        // procurement score, and renaming it would break every saved template.
        { key: '{combined_score}', desc: "The vendor's evaluation score" }
    ];

    container.innerHTML = `
        ${mailCard}
        <div class="card" style="margin-bottom: 24px;">
            <div class="card-header"><h3 class="card-title"><i class="fas fa-circle-info" style="margin-right: 8px; color: var(--info);"></i>Available Placeholders</h3></div>
            <div class="card-body">
                <p style="color: var(--text-secondary); margin-bottom: 16px;">Use these placeholders in your templates. They are replaced automatically when award emails are sent.</p>
                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                    ${placeholders.map(p => `<span class="chip" style="cursor: pointer;" onclick="copyPlaceholder('${p.key}')" title="${p.desc}"><code style="font-size: 12px;">${p.key}</code> <i class="fas fa-copy" style="font-size: 10px; margin-left: 4px; color: var(--text-muted);"></i></span>`).join('')}
                </div>
            </div>
        </div>
        <div class="tabs">
            ${TEMPLATE_TABS.map((t, i) => `
                <div class="tab ${i === 0 ? 'active' : ''}" onclick="switchEmailTab('${t.type}', this)"><i class="fas ${t.icon}" style="margin-right: 8px;"></i>${t.label}</div>
            `).join('')}
        </div>
        ${TEMPLATE_TABS.map((t, i) => {
            const content = contentOf(t.type);
            return `
                <div id="${t.type}EmailTab" class="card" ${i === 0 ? '' : 'style="display: none;"'}>
                    <div class="card-header">
                        <h3 class="card-title"><i class="fas ${t.icon}" style="margin-right: 8px;"></i>${t.label} Template</h3>
                        <span class="badge ${t.badgeClass}">${t.badge}</span>
                    </div>
                    <div class="card-body">
                        <div class="form-group"><label>Email Subject</label><input type="text" class="form-control" id="${t.type}Subject" value="${escapeAttr(content.subject)}"></div>
                        <div class="form-group"><label>Email Body</label><textarea class="form-control" id="${t.type}Body" style="min-height: 300px; font-family: 'IBM Plex Mono', monospace; font-size: 13px;">${escapeHtml(content.body)}</textarea></div>
                        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
                            <button class="btn btn-secondary btn-sm" onclick="previewEmail('${t.type}')"><i class="fas fa-eye"></i> Preview</button>
                            <button class="btn btn-accent" onclick="saveEmailTemplate('${t.type}')"><i class="fas fa-save"></i> Save Template</button>
                        </div>
                    </div>
                </div>`;
        }).join('')}
    `;
    AppState._emailTemplateTypes = TEMPLATE_TABS.map(t => t.type);
}

function copyPlaceholder(placeholder) {
    navigator.clipboard.writeText(placeholder).then(() => showToast('success', 'Copied', `${placeholder} copied to clipboard`));
}

function switchEmailTab(tab, element) {
    document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
    element.classList.add('active');
    (AppState._emailTemplateTypes || []).forEach(type => {
        const panel = document.getElementById(`${type}EmailTab`);
        if (panel) panel.style.display = type === tab ? 'block' : 'none';
    });
}

async function saveEmailTemplate(type) {
    const subject = document.getElementById(`${type}Subject`).value.trim();
    const body = document.getElementById(`${type}Body`).value.trim();
    if (!subject || !body) { showToast('error', 'Validation Error', 'Subject and body are required'); return; }
    try {
        await apiFetch(`/emails/templates/${type}`, { method: 'PUT', body: JSON.stringify({ subject, body }) });
        showToast('success', 'Saved', `${type === 'winner' ? 'Winner' : 'Non-Winner'} email template updated`);
    } catch (err) { showToast('error', 'Error', err.message); }
}

async function previewEmail(type) {
    const subject = document.getElementById(`${type}Subject`).value;
    const body = document.getElementById(`${type}Body`).value;
    let preview;
    try {
        preview = await apiFetch('/emails/templates/preview', { method: 'POST', body: JSON.stringify({ subject, body }) });
    } catch (err) { showToast('error', 'Error', err.message); return; }

    document.getElementById('emailPreviewContent').innerHTML = `
        <div style="background: var(--bg-tertiary); padding: 16px; border-radius: var(--radius); margin-bottom: 16px;">
            <div style="display: flex; gap: 8px; margin-bottom: 8px;"><strong style="color: var(--text-muted); min-width: 60px;">To:</strong><span>john@acme.com</span></div>
            <div style="display: flex; gap: 8px;"><strong style="color: var(--text-muted); min-width: 60px;">Subject:</strong><span>${escapeHtml(preview.subject)}</span></div>
        </div>
        <div style="background: var(--bg-secondary); border: 1px solid var(--border); padding: 20px; border-radius: var(--radius); white-space: pre-wrap; font-size: 14px; line-height: 1.6;">${escapeHtml(preview.body)}</div>
        <p style="margin-top: 16px; font-size: 12px; color: var(--text-muted);"><i class="fas fa-circle-info"></i> This is a preview with sample data.</p>
    `;
    openModal('emailPreviewModal');
}

const EMAIL_STATUS_BADGE = {
    sent: 'badge-success',
    queued: 'badge-warning',
    failed: 'badge-danger',
    simulated: 'badge-info'
};

async function renderEmailLogPage(container) {
    pagerReloaders.emailLog = () => renderEmailLogPage(container);
    const state = pagerState('emailLog');
    const page = await apiList('/emails/log', { ...pagerParams('emailLog'), status: state.status });
    const statusOption = (value, label) =>
        `<option value="${value}" ${(state.status || 'all') === value ? 'selected' : ''}>${label}</option>`;

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title"><i class="fas fa-history" style="margin-right: 8px;"></i>Email Log</h3>
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                    <span class="badge badge-info">${page.total} email${page.total === 1 ? '' : 's'}</span>
                    <select class="form-control" style="width: auto; display: inline-block;" onchange="filterEmailLog(this.value)">
                        ${statusOption('all', 'All Statuses')}${statusOption('sent', 'Sent')}${statusOption('queued', 'Queued')}${statusOption('failed', 'Failed')}${statusOption('simulated', 'Simulated')}
                    </select>
                </div>
            </div>
            <div class="card-body">
                ${page.total === 0 ? `
                    <div class="empty-state"><i class="fas fa-envelope-open"></i><h3>No Emails Here</h3><p>Result emails are queued when Supply Chain awards a tender.</p></div>
                ` : `
                    <div class="table-container">
                        <table>
                            <thead><tr><th>Queued</th><th>Tender</th><th>Recipient</th><th>Type</th><th>Status</th><th>Subject</th><th>Actions</th></tr></thead>
                            <tbody>
                                ${page.items.map(email => `
                                    <tr>
                                        <td>${formatDateTime(email.created_at)}${email.sent_at ? `<div style="font-size: 12px; color: var(--text-muted);">sent ${formatDateTime(email.sent_at)}</div>` : ''}</td>
                                        <td><code style="font-size: 11px;">${email.tender_serial}</code><div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(email.tender_name)}</div></td>
                                        <td><strong>${escapeHtml(email.vendor_company)}</strong><div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(email.recipient_email)}</div></td>
                                        <td><span class="badge ${email.type === 'winner' ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-${email.type === 'winner' ? 'trophy' : 'envelope'}"></i> ${email.type === 'winner' ? 'Winner' : 'Non-Winner'}</span></td>
                                        <td><span class="badge ${EMAIL_STATUS_BADGE[email.status] || 'badge-secondary'}" ${email.error ? `title="${escapeAttr(email.error)}"` : ''}>${email.status}</span>${email.attempts > 1 ? `<div style="font-size: 11px; color: var(--text-muted);">${email.attempts} attempts</div>` : ''}</td>
                                        <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(email.subject)}</td>
                                        <td>
                                            <div class="actions">
                                                <button class="action-btn" onclick="viewSentEmail('${email.id}')" title="View Email"><i class="fas fa-eye"></i></button>
                                                ${email.status === 'failed' || email.status === 'queued' ? `<button class="action-btn" onclick="resendEmail('${email.id}')" title="Retry delivery"><i class="fas fa-rotate-right"></i></button>` : ''}
                                            </div>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                    ${renderPager('emailLog', page.total)}
                `}
            </div>
        </div>
    `;
}

function filterEmailLog(status) {
    pagerFilter('emailLog', { status: status === 'all' ? null : status });
    renderEmailLogPage(document.getElementById('contentArea'));
}

async function resendEmail(emailId) {
    try {
        // Delivery is handed to a background task, so this comes back `queued`.
        // Refreshing the log a moment later is what shows the real outcome.
        await apiFetch(`/emails/log/${emailId}/resend`, { method: 'POST' });
        showToast('info', 'Re-queued', 'Delivery is being retried — refresh the log to see the result');
        renderEmailLogPage(document.getElementById('contentArea'));
    } catch (err) { showToast('error', 'Resend Failed', err.message); }
}

async function viewSentEmail(emailId) {
    let email;
    try { email = await apiFetch(`/emails/log/${emailId}`); } catch (err) { showToast('error', 'Error', err.message); return; }
    document.getElementById('emailPreviewContent').innerHTML = `
        <div style="margin-bottom: 16px;">
            <span class="badge ${email.type === 'winner' ? 'badge-success' : 'badge-secondary'}"><i class="fas fa-${email.type === 'winner' ? 'trophy' : 'envelope'}"></i> ${email.type === 'winner' ? 'Winner Email' : 'Non-Winner Email'}</span>
            <span style="margin-left: 8px; font-size: 12px; color: var(--text-muted);">${formatDateTime(email.sent_at)}</span>
        </div>
        <div style="background: var(--bg-tertiary); padding: 16px; border-radius: var(--radius); margin-bottom: 16px;">
            <div style="display: flex; gap: 8px; margin-bottom: 8px;"><strong style="color: var(--text-muted); min-width: 60px;">To:</strong><span>${escapeHtml(email.recipient_email)} (${escapeHtml(email.vendor_company)})</span></div>
            <div style="display: flex; gap: 8px; margin-bottom: 8px;"><strong style="color: var(--text-muted); min-width: 60px;">Tender:</strong><span>${email.tender_serial} - ${escapeHtml(email.tender_name)}</span></div>
            <div style="display: flex; gap: 8px;"><strong style="color: var(--text-muted); min-width: 60px;">Subject:</strong><span>${escapeHtml(email.subject)}</span></div>
        </div>
        <div style="background: var(--bg-secondary); border: 1px solid var(--border); padding: 20px; border-radius: var(--radius); white-space: pre-wrap; font-size: 14px; line-height: 1.6; max-height: 400px; overflow-y: auto;">${escapeHtml(email.body)}</div>
    `;
    openModal('emailPreviewModal');
}

// ============================================
// VENDOR PORTAL (signed-in vendors)
// ============================================
async function currentVendorProfile(force = false) {
    if (!AppState.vendorProfile || force) {
        AppState.vendorProfile = await apiFetch('/vendor/me');
    }
    return AppState.vendorProfile;
}

// The feed the API returns is already scoped to this vendor's category and to
// tenders that are open and not past their deadline — there is nothing to
// filter here, and nothing outside that set is reachable.
async function renderVendorTendersPage(container) {
    pagerReloaders.vendorTenders = () => renderVendorTendersPage(container);
    const [profile, page] = await Promise.all([
        currentVendorProfile(),
        apiList('/vendor/tenders', pagerParams('vendorTenders'))
    ]);

    container.innerHTML = `
        <div class="card" style="margin-bottom: 24px;">
            <div class="card-header">
                <h3 class="card-title">${escapeHtml(profile.company_name)}</h3>
                <span class="badge badge-info">${profile.vendor_category}</span>
            </div>
            <div class="card-body">
                <p style="color: var(--text-secondary); margin: 0;">You see open tenders in the <strong>${profile.vendor_category}</strong> category. To bid on another category, change it under Company Profile.</p>
            </div>
        </div>
        ${page.total === 0 ? `
            <div class="card"><div class="card-body"><div class="empty-state">
                <i class="fas fa-file-circle-question"></i>
                <h3>No Open Tenders</h3>
                <p>Nothing in ${escapeHtml(profile.vendor_category)} is accepting bids right now. Check back later.</p>
            </div></div></div>
        ` : `
            <div style="display: flex; flex-direction: column; gap: 16px;">
                ${page.items.map(tender => `
                    <div class="card">
                        <div class="card-header">
                            <div>
                                <h3 class="card-title" style="margin-bottom: 4px;">${escapeHtml(tender.name)}</h3>
                                <span style="font-size: 13px; color: var(--text-muted);">${tender.serial}</span>
                            </div>
                            ${tender.already_submitted
                                ? `<span class="badge badge-success"><i class="fas fa-check"></i> Bid Submitted</span>`
                                : `<span class="badge badge-warning"><i class="fas fa-clock"></i> Open</span>`}
                        </div>
                        <div class="card-body">
                            <p style="color: var(--text-secondary); margin-bottom: 16px;">${escapeHtml(tender.description)}</p>
                            <div class="submission-info-grid">
                                <div class="info-item"><label>Deadline</label><p>${formatDate(tender.deadline_date)} at ${tender.deadline_time}</p></div>
                                <div class="info-item"><label>Currency</label><p>${tender.currency}</p></div>
                                <div class="info-item"><label>Category</label><p>${tender.category}</p></div>
                            </div>
                            ${(tender.required_docs || []).length > 0 ? `
                                <div style="margin-top: 16px;">
                                    <label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Required Documents</label>
                                    <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;">
                                        ${tender.required_docs.map(d => `<span class="chip"><i class="fas fa-file-alt"></i> ${escapeHtml(d)}</span>`).join('')}
                                    </div>
                                </div>
                            ` : ''}
                            <div style="margin-top: 20px; display: flex; justify-content: flex-end;">
                                ${tender.already_submitted
                                    ? `<button class="btn btn-secondary btn-sm" disabled title="One bid per tender">Already Submitted</button>`
                                    : `<button class="btn btn-accent btn-sm" onclick="openVendorBidPage('${tender.id}')"><i class="fas fa-paper-plane"></i> Submit a Bid</button>`}
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
            ${renderPager('vendorTenders', page.total)}
        `}
    `;
}

async function renderVendorProfilePage(container) {
    const profile = await currentVendorProfile(true);

    container.innerHTML = `
        <div class="card" style="max-width: 720px;">
            <div class="card-header">
                <h3 class="card-title">Company Profile</h3>
                <span class="badge badge-info">${profile.vendor_category}</span>
            </div>
            <div class="card-body">
                <div class="form-group"><label>Company Name *</label><input type="text" class="form-control" id="profileCompanyName" value="${escapeAttr(profile.company_name)}"></div>
                <div class="form-group">
                    <label>Category *</label>
                    <select class="form-control" id="profileCategory">
                        ${CATEGORIES.map(c => `<option value="${c}" ${profile.vendor_category === c ? 'selected' : ''}>${c.charAt(0).toUpperCase() + c.slice(1)}</option>`).join('')}
                    </select>
                    <small style="color: var(--text-muted); font-size: 12px;">This decides which tenders you can see and bid on. Changing it does not withdraw bids you have already placed.</small>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>Contact Email *</label><input type="email" class="form-control" id="profileContactEmail" value="${escapeAttr(profile.contact_email)}"></div>
                    <div class="form-group"><label>Contact Phone *</label><input type="tel" class="form-control" id="profileContactPhone" value="${escapeAttr(profile.contact_phone)}"></div>
                </div>
                <div class="form-group"><label>Tax ID *</label><input type="text" class="form-control" id="profileTaxId" value="${escapeAttr(profile.tax_id)}"></div>
                <div class="form-group"><label>Address *</label><input type="text" class="form-control" id="profileAddress" value="${escapeAttr(profile.address)}"></div>
                <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 8px;">
                    <button class="btn btn-secondary" onclick="navigateTo('vendor-profile')">Reset</button>
                    <button class="btn btn-accent" onclick="saveVendorProfile()"><i class="fas fa-save"></i> Save Changes</button>
                </div>
            </div>
        </div>
        <div class="card" style="max-width: 720px; margin-top: 24px;">
            <div class="card-header"><h3 class="card-title">Sign-in Account</h3></div>
            <div class="card-body">
                <div class="submission-info-grid">
                    <div class="info-item"><label>Name</label><p>${escapeHtml(AppState.currentUser?.name || '')}</p></div>
                    <div class="info-item"><label>Username</label><p>${escapeHtml(AppState.currentUser?.username || '')}</p></div>
                    <div class="info-item"><label>Account Email</label><p>${escapeHtml(AppState.currentUser?.email || '')}</p></div>
                </div>
                <p style="color: var(--text-muted); font-size: 13px; margin-top: 16px;">Your login details are separate from the company details above. Contact the procurement team to change them.</p>
            </div>
        </div>
    `;
}

async function saveVendorProfile() {
    const value = (id) => document.getElementById(id).value.trim();
    const payload = {
        company_name: value('profileCompanyName'),
        vendor_category: document.getElementById('profileCategory').value,
        contact_email: value('profileContactEmail').toLowerCase(),
        contact_phone: value('profileContactPhone'),
        tax_id: value('profileTaxId'),
        address: value('profileAddress')
    };
    if (Object.values(payload).some(v => !v)) {
        showToast('error', 'Validation Error', 'Every field is required');
        return;
    }

    try {
        const updated = await apiFetch('/vendor/me', { method: 'PATCH', body: JSON.stringify(payload) });
        AppState.vendorProfile = updated;
        // The feed is keyed off the category, so a change here changes what the
        // vendor can see. Reset the cursor so they don't land past the end of it.
        pagerFilter('vendorTenders', {});
        showToast('success', 'Saved', 'Company profile updated');
        navigateTo('vendor-profile');
    } catch (err) { showToast('error', 'Error', err.message); }
}

// ============================================
// VENDOR DIRECTORY (staff)
// ============================================
async function renderVendorDirectoryPage(container) {
    pagerReloaders.vendorDirectory = () => renderVendorDirectoryPage(container);
    const state = pagerState('vendorDirectory');
    const page = await apiList('/vendors', {
        ...pagerParams('vendorDirectory'),
        search: state.search,
        category: state.category
    });
    const categoryOption = (value, label) =>
        `<option value="${value}" ${(state.category || 'all') === value ? 'selected' : ''}>${label}</option>`;

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">Registered Vendors</h3>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <input type="text" class="form-control" style="width: auto;" placeholder="Company, tax ID or email"
                           value="${escapeAttr(state.search || '')}" onchange="filterVendorsBySearch(this.value)">
                    <select class="form-control" style="width: auto; display: inline-block;" onchange="filterVendorsByCategory(this.value)">
                        ${categoryOption('all', 'All Categories')}
                        ${CATEGORIES.map(c => categoryOption(c, c.charAt(0).toUpperCase() + c.slice(1))).join('')}
                    </select>
                </div>
            </div>
            <div class="card-body" style="padding: 0;">
                <div class="table-container">
                    <table>
                        <thead><tr><th>Company</th><th>Category</th><th>Contact</th><th>Tax ID</th><th>Account</th><th>Registered</th></tr></thead>
                        <tbody>
                            ${page.items.map(vendor => `
                                <tr>
                                    <td><strong>${escapeHtml(vendor.company_name)}</strong><div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(vendor.address)}</div></td>
                                    <td><span class="badge badge-info">${vendor.vendor_category}</span></td>
                                    <td>${escapeHtml(vendor.contact_email)}<div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(vendor.contact_phone)}</div></td>
                                    <td><code style="font-size: 12px;">${escapeHtml(vendor.tax_id)}</code></td>
                                    <td>${escapeHtml(vendor.account_name)}<div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(vendor.account_username)}</div>
                                        <span class="badge ${vendor.account_status === 'active' ? 'badge-success' : 'badge-danger'}">${vendor.account_status}</span></td>
                                    <td>${formatDate(vendor.created_at)}</td>
                                </tr>
                            `).join('') || `<tr><td colspan="6" style="text-align:center; padding:30px;">No vendors match this filter</td></tr>`}
                        </tbody>
                    </table>
                </div>
                ${renderPager('vendorDirectory', page.total)}
            </div>
        </div>
        <p style="color: var(--text-muted); font-size: 13px; margin-top: 16px;">
            <i class="fas fa-circle-info"></i> Read-only. Vendors maintain their own company details, and their accounts are activated or deactivated from User Management.
        </p>
    `;
}

function filterVendorsBySearch(search) {
    pagerFilter('vendorDirectory', { search: search.trim() || null });
    renderVendorDirectoryPage(document.getElementById('contentArea'));
}

function filterVendorsByCategory(category) {
    pagerFilter('vendorDirectory', { category: category === 'all' ? null : category });
    renderVendorDirectoryPage(document.getElementById('contentArea'));
}

// ============================================
// BID SUBMISSION (public link and vendor portal)
// ============================================
// One form, two entry points: the shareable ?tender=<id> link, which anyone can
// use, and the signed-in vendor portal. A vendor's token is what attributes the
// bid to their company — the typed-in details never are.
function bidFormHtml(tender, profile) {
    const locked = !!profile;
    return `
        <form id="vendorSubmissionForm">
            ${locked ? `
                <div style="margin-bottom: 20px; padding: 12px 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--accent);">
                    <i class="fas fa-shield-halved" style="margin-right: 6px; color: var(--accent);"></i>
                    Bidding as <strong>${escapeHtml(profile.company_name)}</strong>. The bid is filed under your registered company.
                </div>
            ` : ''}
            <h3 style="margin-bottom: 16px; font-size: 16px;">Company Information</h3>
            <div class="form-row">
                <div class="form-group">
                    <label>Company Name *</label>
                    <input type="text" class="form-control" id="vendorCompany" required
                           value="${locked ? escapeAttr(profile.company_name) : ''}" ${locked ? 'readonly' : ''}>
                </div>
                <div class="form-group"><label>Contact Person *</label><input type="text" class="form-control" id="vendorContact" required value="${locked ? escapeAttr(AppState.currentUser?.name || '') : ''}"></div>
            </div>
            <div class="form-row">
                <div class="form-group"><label>Email Address *</label><input type="email" class="form-control" id="vendorEmail" required value="${locked ? escapeAttr(profile.contact_email) : ''}"></div>
                <div class="form-group"><label>Phone Number *</label><input type="tel" class="form-control" id="vendorPhone" required value="${locked ? escapeAttr(profile.contact_phone) : ''}"></div>
            </div>
            <h3 style="margin: 24px 0 16px; font-size: 16px;">Commercial Offer</h3>
            <div class="form-group"><label>Total Bid Amount (${tender.currency}) *</label><input type="number" class="form-control" id="vendorAmount" required min="0" step="0.01"></div>
            <div class="form-group"><label>Price Breakdown / Notes</label><textarea class="form-control" id="vendorNotes" placeholder="Provide breakdown of pricing..."></textarea></div>
            <h3 style="margin: 24px 0 16px; font-size: 16px;">Required Documents</h3>
            <div style="margin-bottom: 16px;">${(tender.required_docs || []).map(doc => `<span class="chip"><i class="fas fa-file-alt"></i> ${escapeHtml(doc)}</span>`).join('') || '<span style="color:var(--text-muted);">None specified</span>'}</div>
            <div class="file-upload-area" id="fileUploadArea">
                <i class="fas fa-cloud-upload-alt"></i>
                <p><strong>Drag &amp; drop files here or click to upload</strong></p>
                <p style="font-size: 12px; color: var(--text-muted);">PDF, DOC, XLS up to 10MB each</p>
                <input type="file" id="vendorFiles" multiple accept=".pdf,.doc,.docx,.xls,.xlsx" style="display: none;">
            </div>
            <div id="uploadedFilesList" class="uploaded-files"></div>
            <div style="margin-top: 32px;"><button type="submit" class="btn btn-primary" id="vendorSubmitBtn"><i class="fas fa-paper-plane"></i> Submit Offer</button></div>
        </form>
    `;
}

function wireBidForm(tenderId, tender, onSuccess) {
    AppState.uploadedFiles = [];
    const uploadArea = document.getElementById('fileUploadArea');
    const fileInput = document.getElementById('vendorFiles');
    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', (e) => { e.preventDefault(); uploadArea.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
    fileInput.addEventListener('change', () => handleFiles(fileInput.files));
    document.getElementById('vendorSubmissionForm').addEventListener('submit', (e) => {
        e.preventDefault();
        submitVendorOffer(tenderId, tender, onSuccess);
    });
}

// Portal entry point: same form, rendered inside the app shell.
async function openVendorBidPage(tenderId) {
    const container = document.getElementById('contentArea');
    showLoading(container);

    let tender, profile;
    try {
        [tender, profile] = await Promise.all([
            apiFetch(`/vendor/tenders/${tenderId}`),
            currentVendorProfile()
        ]);
    } catch (err) { showLoadError(container, err, `openVendorBidPage('${tenderId}')`); return; }

    if (!tender.accepting_submissions) {
        container.innerHTML = `
            <div style="margin-bottom: 24px;"><button class="btn btn-secondary btn-sm" onclick="navigateTo('vendor-tenders')"><i class="fas fa-arrow-left"></i> Back to Tenders</button></div>
            <div class="card"><div class="card-body"><div class="empty-state">
                <i class="fas fa-lock"></i>
                <h3>Not Accepting Bids</h3>
                <p>${escapeHtml(tender.reason || 'This tender is closed or past its deadline.')}</p>
            </div></div></div>
        `;
        return;
    }

    container.innerHTML = `
        <div style="margin-bottom: 24px;"><button class="btn btn-secondary btn-sm" onclick="navigateTo('vendor-tenders')"><i class="fas fa-arrow-left"></i> Back to Tenders</button></div>
        <div class="card" style="margin-bottom: 24px;">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">${escapeHtml(tender.name)}</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">${tender.serial}</span>
                </div>
                <span class="badge badge-warning"><i class="fas fa-clock"></i> Closes ${formatDate(tender.deadline_date)} at ${tender.deadline_time}</span>
            </div>
            <div class="card-body"><p style="color: var(--text-secondary); margin: 0;">${escapeHtml(tender.description)}</p></div>
        </div>
        <div class="card"><div class="card-body">${bidFormHtml(tender, profile)}</div></div>
    `;

    wireBidForm(tenderId, tender, () => {
        showToast('success', 'Submission Received', `Your bid for ${tender.serial} has been recorded`);
        navigateTo('vendor-tenders');
    });
}

// ============================================
// PUBLIC BID PAGE (?tender=<id>)
// ============================================
async function showVendorPage(tenderId) {
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('appContainer').classList.remove('active');
    const vendorPage = document.getElementById('vendorPage');
    vendorPage.classList.remove('hidden');
    vendorPage.innerHTML = `<div class="page-loading"><i class="fas fa-circle-notch fa-spin"></i><span>Loading tender...</span></div>`;

    let tender;
    try {
        tender = await apiFetch(`/vendor/tenders/${tenderId}`);
    } catch (err) {
        vendorPage.innerHTML = `<div class="vendor-card"><div class="vendor-header" style="background: var(--danger);"><i class="fas fa-triangle-exclamation" style="font-size: 48px; margin-bottom: 16px;"></i><h1>Tender Not Found</h1><p>This tender doesn't exist or has been removed.</p></div></div>`;
        return;
    }

    // A signed-in vendor gets their details prefilled and the bid attributed.
    // Anyone else bids anonymously, exactly as before.
    let profile = null;
    if (AppState.token) {
        try {
            const user = await apiFetch('/auth/me');
            AppState.currentUser = user;
            if (user.role === 'vendor') profile = await currentVendorProfile();
        } catch (err) { /* stale or staff token: bid anonymously */ }
    }

    if (!tender.accepting_submissions) {
        vendorPage.innerHTML = `
            <div class="vendor-card">
                <div class="vendor-header" style="background: var(--ink-light);"><i class="fas fa-lock" style="font-size: 48px; margin-bottom: 16px;"></i><h1>Not Accepting Bids</h1><p>${escapeHtml(tender.reason || 'This tender is no longer accepting submissions.')}</p></div>
                <div class="vendor-body">
                    <h3>${escapeHtml(tender.name)}</h3>
                    <p style="color: var(--text-secondary);">${escapeHtml(tender.description)}</p>
                    <p style="margin-top: 16px;"><strong>Deadline:</strong> ${formatDate(tender.deadline_date)} at ${tender.deadline_time}</p>
                    ${profile ? `<p style="margin-top: 16px;"><a href="${window.location.pathname}">Back to your tenders</a></p>` : ''}
                </div>
            </div>
        `;
        return;
    }

    vendorPage.innerHTML = `
        <div class="vendor-card">
            <div class="vendor-header">
                <i class="fas fa-file-contract" style="font-size: 40px; margin-bottom: 12px;"></i>
                <h1>${escapeHtml(tender.name)}</h1>
                <p>${tender.serial}</p>
            </div>
            <div class="vendor-body">
                <div class="deadline-banner">
                    <i class="fas fa-clock"></i>
                    <div><strong>Submission Deadline</strong><p style="margin: 0; font-size: 14px;">${formatDate(tender.deadline_date)} at ${tender.deadline_time}</p></div>
                </div>
                <p style="color: var(--text-secondary); margin-bottom: 24px;">${escapeHtml(tender.description)}</p>
                ${profile ? '' : `
                    <div style="margin-bottom: 24px; padding: 12px 16px; background: var(--bg-tertiary); border-radius: var(--radius);">
                        Registered vendors get their bids tracked against their account.
                        <a href="${window.location.pathname}" style="font-weight: 600;">Sign in or register</a>, then open this link again.
                    </div>
                `}
                ${bidFormHtml(tender, profile)}
            </div>
        </div>
    `;

    wireBidForm(tenderId, tender, (submission) => showPublicSubmissionReceipt(tender, submission));
}

function showPublicSubmissionReceipt(tender, submission) {
    document.getElementById('vendorPage').innerHTML = `
        <div class="vendor-card">
            <div class="vendor-header" style="background: var(--success);">
                <i class="fas fa-check-circle" style="font-size: 64px; margin-bottom: 16px;"></i>
                <h1>Submission Received!</h1>
                <p>Thank you for your offer</p>
            </div>
            <div class="vendor-body" style="text-align: center;">
                <h3 style="margin-bottom: 16px;">${escapeHtml(submission.company_name)}</h3>
                <p style="color: var(--text-secondary);">Your submission for <strong>${escapeHtml(tender.name)}</strong> has been received.</p>
                <div style="margin-top: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius);">
                    <p style="font-size: 14px; color: var(--text-muted);">Submission Reference</p>
                    <code style="font-family: 'IBM Plex Mono', monospace; font-size: 16px; color: var(--accent-light); word-break: break-all;">${submission.id}</code>
                </div>
                <p style="margin-top: 24px; color: var(--text-secondary); font-size: 14px;">You'll be emailed once the tender is decided.</p>
            </div>
        </div>
    `;
}

function handleFiles(files) {
    const maxSize = 10 * 1024 * 1024;
    const allowedTypes = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];
    Array.from(files).forEach(file => {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        if (!allowedTypes.includes(ext)) { showToast('error', 'Invalid File', `${file.name} is not an allowed file type`); return; }
        if (file.size > maxSize) { showToast('error', 'File Too Large', `${file.name} exceeds 10MB limit`); return; }
        if (!AppState.uploadedFiles.find(f => f.name === file.name)) AppState.uploadedFiles.push(file);
    });
    renderUploadedFiles();
}

function renderUploadedFiles() {
    const container = document.getElementById('uploadedFilesList');
    container.innerHTML = AppState.uploadedFiles.map((file, index) => `
        <div class="uploaded-file">
            <div><i class="fas fa-file" style="color: var(--accent); margin-right: 8px;"></i><span>${escapeHtml(file.name)}</span><span style="color: var(--text-muted); font-size: 12px; margin-left: 8px;">(${(file.size / 1024).toFixed(1)} KB)</span></div>
            <button type="button" class="action-btn danger" onclick="removeUploadedFile(${index})"><i class="fas fa-times"></i></button>
        </div>
    `).join('');
}

function removeUploadedFile(index) {
    AppState.uploadedFiles.splice(index, 1);
    renderUploadedFiles();
}

async function submitVendorOffer(tenderId, tender, onSuccess) {
    const company = document.getElementById('vendorCompany').value.trim();
    const contact = document.getElementById('vendorContact').value.trim();
    const email = document.getElementById('vendorEmail').value.trim();
    const phone = document.getElementById('vendorPhone').value.trim();
    const amount = document.getElementById('vendorAmount').value;
    const notes = document.getElementById('vendorNotes').value.trim();

    if (!company || !contact || !email || !phone || !amount) {
        showToast('error', 'Validation Error', 'Please fill in all required fields');
        return;
    }

    const submitBtn = document.getElementById('vendorSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Submitting...';

    const formData = new FormData();
    formData.append('company_name', company);
    formData.append('contact_name', contact);
    formData.append('email', email);
    formData.append('phone', phone);
    formData.append('total_amount', amount);
    if (notes) formData.append('notes', notes);
    AppState.uploadedFiles.forEach(f => formData.append('files', f));

    let submission;
    try {
        submission = await apiFetch(`/vendor/tenders/${tenderId}/submit`, { method: 'POST', body: formData });
    } catch (err) {
        showToast('error', 'Submission Failed', err.message);
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Offer';
        return;
    }

    AppState.uploadedFiles = [];
    onSuccess(submission);
}

// ============================================
// UTILITIES
// ============================================
function openModal(modalId) { document.getElementById(modalId).classList.add('active'); }
function closeModal(modalId) { document.getElementById(modalId).classList.remove('active'); }

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
}

function showToast(type, title, message) {
    const container = document.getElementById('toastContainer');
    const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fas ${icons[type]} toast-icon"></i><div class="toast-content"><div class="toast-title">${escapeHtml(title)}</div><div class="toast-message">${escapeHtml(message)}</div></div>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.animation = 'fadeIn 0.3s ease-out reverse'; setTimeout(() => toast.remove(), 300); }, 4000);
}

function showConfirmDialog(title, htmlBody, onConfirm) {
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalBody').innerHTML = htmlBody;
    const btn = document.getElementById('confirmModalSubmitBtn');
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => { closeModal('confirmModal'); onConfirm(); });
    openModal('confirmModal');
}

function openReasonModal({ title, description, label, submitLabel, onSubmit }) {
    document.getElementById('reasonModalTitle').textContent = title;
    document.getElementById('reasonModalDescription').textContent = description || '';
    document.getElementById('reasonModalLabel').textContent = label || 'Reason *';
    document.getElementById('reasonModalInput').value = '';
    const btn = document.getElementById('reasonModalSubmitBtn');
    btn.innerHTML = `<i class="fas fa-paper-plane"></i> ${submitLabel || 'Send'}`;
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
        const reason = document.getElementById('reasonModalInput').value.trim();
        if (!reason) { showToast('error', 'Required', 'Please provide a reason'); return; }
        closeModal('reasonModal');
        onSubmit(reason);
    });
    openModal('reasonModal');
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => showToast('success', 'Copied!', 'Link copied to clipboard')).catch(() => showToast('error', 'Error', 'Failed to copy'));
}

function formatDate(dateString) {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(dateString) {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ============================================
// NOTIFICATION DROPDOWN
// ============================================
function toggleNotificationDropdown() {
    const dropdown = document.getElementById('notificationDropdown');
    const isActive = dropdown.classList.contains('active');
    if (isActive) { dropdown.classList.remove('active'); }
    else { renderNotificationDropdown(); dropdown.classList.add('active'); }
}

async function renderNotificationDropdown() {
    const dropdown = document.getElementById('notificationDropdown');
    dropdown.innerHTML = `<div class="notification-dropdown-header"><h4><i class="fas fa-bell" style="margin-right: 8px;"></i>Notifications</h4></div><div class="page-loading" style="padding: 30px;"><i class="fas fa-circle-notch fa-spin"></i></div>`;

    let sorted = [];
    let unreadCount = 0;
    try {
        // The API already returns newest first; the count comes from its own
        // endpoint because ten rows can't tell you how many unread ones exist.
        const [page, unread] = await Promise.all([
            apiList('/notifications', { limit: 10 }),
            apiFetch('/notifications/unread-count')
        ]);
        sorted = page.items;
        unreadCount = unread.unread;
    } catch (err) { return; }
    AppState.unreadCount = unreadCount;

    dropdown.innerHTML = `
        <div class="notification-dropdown-header">
            <h4><i class="fas fa-bell" style="margin-right: 8px;"></i>Notifications</h4>
            ${unreadCount > 0 ? `<span class="badge badge-danger">${unreadCount} new</span>` : ''}
        </div>
        <div class="notification-dropdown-body">
            ${sorted.length === 0 ? `<div class="notification-dropdown-empty"><i class="fas fa-bell-slash"></i><p>No notifications</p></div>` : sorted.map(n => `
                <div class="notification-item ${n.read ? '' : 'unread'}" onclick="handleNotificationClick('${n.id}', '${n.type}')">
                    <div class="notification-item-header">
                        <span class="notification-item-type" style="color: ${getNotificationColor(n.type)};"><i class="fas ${getNotificationIcon(n.type)}" style="margin-right: 4px;"></i>${getNotificationLabel(n.type)}</span>
                        <span class="notification-item-time">${formatTimeAgo(n.created_at)}</span>
                    </div>
                    <div class="notification-item-message">${escapeHtml(n.message)}</div>
                </div>
            `).join('')}
        </div>
        ${sorted.length > 0 ? `<div style="padding: 12px 16px; border-top: 1px solid var(--border); text-align: center;"><button class="btn btn-secondary btn-sm" onclick="markAllNotificationsRead()" style="width: 100%;"><i class="fas fa-check-double"></i> Mark All as Read</button></div>` : ''}
    `;
    updateNotificationBadge();
}

function getNotificationColor(type) {
    const colors = { tender_pending_approval: 'var(--warning)', tender_awarded: 'var(--success)', manager_approved: 'var(--info)', changes_requested: 'var(--warning)', sc_rejected: 'var(--danger)', submission_received: 'var(--accent-light)', evaluation_submitted: 'var(--accent-light)' };
    return colors[type] || 'var(--text-secondary)';
}
function getNotificationIcon(type) {
    const icons = { tender_pending_approval: 'fa-clipboard-check', tender_awarded: 'fa-trophy', manager_approved: 'fa-check-circle', changes_requested: 'fa-circle-exclamation', sc_rejected: 'fa-circle-xmark', submission_received: 'fa-inbox', evaluation_submitted: 'fa-star' };
    return icons[type] || 'fa-bell';
}
function getNotificationLabel(type) {
    const labels = { tender_pending_approval: 'Needs Approval', tender_awarded: 'Awarded', manager_approved: 'Tender Opened', changes_requested: 'Sent Back', sc_rejected: 'Rejected', submission_received: 'New Submission', evaluation_submitted: 'Ready to Award' };
    return labels[type] || 'Notification';
}

function formatTimeAgo(dateString) {
    const now = new Date();
    const date = new Date(dateString);
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(dateString);
}

async function handleNotificationClick(notificationId, type) {
    try { await apiFetch(`/notifications/${notificationId}/read`, { method: 'POST' }); } catch (e) { /* ignore */ }
    document.getElementById('notificationDropdown').classList.remove('active');

    // manager_approved and changes_requested are the two types sent to two
    // different audiences: the role-addressed copy goes to procurement, and a
    // second copy goes personally to the employee who raised the tender. They
    // land on different pages, so this one type has to branch on who's reading.
    if (isEmployee(AppState.currentUser)) {
        navigateTo('my-requests');
        refreshNotificationBadgeOnly();
        return;
    }

    // For everyone else each type has exactly one role it's addressed to, so
    // the destination follows from the type alone.
    const destinations = {
        tender_pending_approval: 'review',      // manager: a tender needs a decision
        manager_approved: 'tenders',            // procurement: it's open, share the link
        changes_requested: 'tenders',           // procurement: revise and resubmit
        submission_received: 'submissions',     // procurement: a new bid landed
        evaluation_submitted: 'approvals',      // supply chain: ready to award
        sc_rejected: 'history',                 // manager: supply chain turned it down
        tender_awarded: 'notifications'         // finance: award details
    };
    const destination = destinations[type];
    if (destination) navigateTo(destination);

    refreshNotificationBadgeOnly();
}

async function markAllNotificationsRead() {
    try {
        await apiFetch('/notifications/mark-all-read', { method: 'POST' });
        renderNotificationDropdown();
        showToast('success', 'Done', 'All notifications marked as read');
    } catch (err) { showToast('error', 'Error', err.message); }
}

async function refreshNotificationBadgeOnly() {
    if (isVendor(AppState.currentUser) || !AppState.currentUser) return;
    try {
        // A dedicated count, so the poll that runs every minute doesn't drag a
        // page of rows across the wire just to decide whether to show a dot.
        const { unread } = await apiFetch('/notifications/unread-count');
        AppState.unreadCount = unread;
        updateNotificationBadge();
    } catch (err) { /* silent */ }
}

function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    if (badge) badge.classList.toggle('has-notifications', AppState.unreadCount > 0);
}

document.addEventListener('click', function (e) {
    const dropdown = document.getElementById('notificationDropdown');
    const btn = document.getElementById('notificationBtn');
    if (dropdown && btn && !dropdown.contains(e.target) && !btn.contains(e.target)) {
        dropdown.classList.remove('active');
    }
});