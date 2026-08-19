// ============================================
// CONFIG
// ============================================
// Point this at wherever the backend is actually running.
// Where the API lives, worked out from where this page was served.
//
// It used to be hardcoded to http://localhost:8000, which is fine on the
// machine running the stack and useless everywhere else: on somebody else's
// laptop "localhost" is THEIR laptop, so the pages arrive and every request
// dies. That is the whole failure mode behind putting a tunnel in front of the
// static server.
//
// So: if this page came off the standalone static server (or a file:// path),
// the API is the separate process on :8000. Otherwise the backend served this
// page itself and the API is on the same origin - a relative path, which
// follows whatever host the browser actually used, tunnel included, and needs
// no CORS because there is no cross origin.
//
// window.TENDERFLOW_API_BASE still overrides both, for anything neither guess
// covers.
const API_BASE = window.TENDERFLOW_API_BASE || (
    location.protocol === 'file:' || location.port === '5500'
        ? 'http://localhost:8000/api'
        : '/api'
);

// Mirrors core/pagination.py. MAX_PAGE_SIZE is the server's ceiling — asking for
// more is a 422, not a silent clamp.
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

const AppState = {
    token: localStorage.getItem('tf_token') || null,
    currentUser: null,
    currentPage: 'dashboard',
    departments: [],
    // The admin's category list. Loaded once at sign-in like the
    // departments beside it, because three screens need it to render at
    // all - the request form, the vendor directory and the basket picker -
    // and each fetching it separately is three requests for one list that
    // changes about twice a year.
    categories: [],
    tenders: [],
    submissions: [],
    unreadCount: 0,
    vendorProfile: null, // vendor accounts only
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

// ngrok's free tier puts an interstitial "you are about to visit" page in front
// of the first request from a new visitor. A browser navigation clicks through
// it; a fetch() just receives the warning HTML where it expected JSON, and the
// app looks broken for reasons nothing in it can explain. This header opts out.
//
// Sent only when the API is same-origin, which is exactly the tunnelled case.
// Adding a custom header to a cross-origin request would turn every simple call
// into a preflighted one for no reason, so the :5500 setup never sees it.
const SAME_ORIGIN_API = API_BASE.startsWith('/');

function tunnelHeaders(headers) {
    if (SAME_ORIGIN_API) headers['ngrok-skip-browser-warning'] = 'true';
    return headers;
}

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
    const headers = tunnelHeaders(Object.assign({}, options.headers || {}));
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
// can't filter on (manager_approved, supply_chain_approved, ...). Those pages
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
    const headers = tunnelHeaders({});
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
    // A vendor arriving with `?invite=` belongs on vendor.html, which is a page
    // of its own and shares nothing with this file. Anyone who lands here with
    // one followed a stale link from before the split.
    const inviteToken = new URLSearchParams(window.location.search).get('invite');
    if (inviteToken) {
        window.location.replace(`vendor.html?invite=${encodeURIComponent(inviteToken)}`);
        return;
    }

    setupEventListeners();

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
    document.getElementById('appContainer').classList.add('active');

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
        try {
            AppState.categories = await apiFetch('/categories');
        } catch (err) { AppState.categories = []; }
    } else {
        AppState.departments = [];
        AppState.categories = [];
    }

    // Only now, because the warehouse nav is chosen by department code and
    // that isn't known until the fetch above has returned. Running this any
    // earlier gave a warehouse account the plain requester sidebar.
    setupRoleBasedNav();

    // Nothing is ever addressed to `vendor`, so the bell would sit permanently
    // empty for them. Employees do get mail — addressed to them personally
    // rather than to their role — so they keep it.
    document.querySelector('.notification-wrapper').style.display = internal ? '' : 'none';

    navigateTo(staff || isWarehouse(user) ? 'dashboard' : 'my-requests');
    if (internal) refreshNotificationBadgeOnly();

    if (isFreshLogin) showToast('success', 'Welcome!', `Logged in as ${roleNames[user.role] || user.role}`);
}

function showLoginPage() {
    document.getElementById('appContainer').classList.remove('active');
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
// NAVIGATION
// ============================================
// Everyone on the payroll can raise a request now, not just the `employee`
// role, so this section is shared by every internal nav that doesn't already
// have the full Manage Tenders screen.
const REQUESTER_SECTION = { section: 'My Requests', items: [
    { id: 'new-request', icon: 'fa-plus-circle', label: 'New Request' },
    { id: 'my-requests', icon: 'fa-file-contract', label: 'My Requests' }
]};

const WAREHOUSE_NAV = [
    { section: 'Main', items: [
        { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
        { id: 'receiving', icon: 'fa-truck-ramp-box', label: 'On the way' },
        { id: 'receipts', icon: 'fa-clipboard-list', label: 'Received' }
    ]}
];

function setupRoleBasedNav() {
    const role = AppState.currentUser.role;
    const navContainer = document.getElementById('sidebarNav');

    const navConfigs = {
        admin: [
            { section: 'Main', items: [
                { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
                { id: 'tenders', icon: 'fa-file-contract', label: 'Manage Tenders' },
                { id: 'submissions', icon: 'fa-inbox', label: 'Submissions' },
                { id: 'offers', icon: 'fa-scale-balanced', label: 'Offers' }
            ]},
            { section: 'Administration', items: [
                { id: 'users', icon: 'fa-users-cog', label: 'User Management' },
                { id: 'categories', icon: 'fa-tags', label: 'Categories' },
                { id: 'vendors', icon: 'fa-building', label: 'Vendor Directory' },
                { id: 'audit', icon: 'fa-history', label: 'Audit Log' }
            ]}
        ],
        procurement: [
            { section: 'Main', items: [
                { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
                { id: 'tenders', icon: 'fa-file-contract', label: 'Manage Tenders' },
                { id: 'submissions', icon: 'fa-inbox', label: 'Submissions' },
                { id: 'offers', icon: 'fa-scale-balanced', label: 'Offers' },
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
                // The purchasing manager runs a purchasing desk as well as
                // approving on it — on a small team they cover the bids
                // themselves. A department manager gets no Submissions page:
                // the bids on their request are somebody else's work, and the
                // vendor names on that screen are exactly what the blind
                // comparison keeps away from them.
                ...(isPurchasingManager(AppState.currentUser)
                    ? [{ id: 'submissions', icon: 'fa-inbox', label: 'Submissions' }]
                    : []),
                // The manager's other desk: shortlist the offers that came back
                // on a tender they approved. A purchasing manager gets the same
                // page, but it shows them their own step of the chain.
                { id: 'offers', icon: 'fa-scale-balanced', label: 'Offers' },
                { id: 'history', icon: 'fa-history', label: 'Decision History' }
            ]},
            REQUESTER_SECTION
        ],
        supply_chain: [
            { section: 'Main', items: [
                { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
                { id: 'offers', icon: 'fa-stamp', label: 'Pending Approvals' },
                { id: 'approved', icon: 'fa-check-double', label: 'Approved Tenders' }
            ]},
            REQUESTER_SECTION
        ],
        finance: [
            { section: 'Main', items: [
                { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
                { id: 'notifications', icon: 'fa-bell', label: 'Notifications' },
                { id: 'reports', icon: 'fa-file-alt', label: 'Reports' }
            ]},
            REQUESTER_SECTION
        ],
        // No `vendor` entry: vendors don't sign in at all. Any account still
        // carrying the role is refused at /auth/login, so nothing here would
        // ever be rendered for one.
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

    // The warehouse is a department, not a role: that account is an ordinary
    // `employee` attached to Warehouse, so keying off the role alone would
    // have given them the requester's nav and nothing to receive with.
    const config = isWarehouse(AppState.currentUser)
        ? WAREHOUSE_NAV
        : (navConfigs[role] || navConfigs.admin);
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

// `keepContext` is what tells a tender-scoped page whether it was reached from
// the sidebar or from a link about one particular tender.
//
// From the sidebar the answer is "nothing selected": arriving at Offers and
// finding whichever tender the code picked for you is how somebody ends up
// filtering bids on the wrong one. From a dashboard row or a tender link, the
// caller knows exactly which tender is meant and says so.
function navigateTo(page, { keepContext = false } = {}) {
    if (!keepContext) {
        if (page === 'offers') offersTenderId = null;
        if (page === 'submissions') submissionsTenderId = null;
    }
    AppState.currentPage = page;
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });

    const titles = {
        dashboard: 'Dashboard', tenders: 'Manage Tenders', submissions: 'Submissions',
        users: 'User Management', offers: 'Offers', review: 'Pending Reviews',
        approved: 'Approved Tenders', notifications: 'Notifications',
        reports: 'Reports', audit: 'Audit Log', history: 'Decision History',
        'email-templates': 'Email Templates', 'email-log': 'Email Log',
        vendors: 'Vendor Directory',
        'my-requests': 'My Requests', 'new-request': 'New Request',
        receiving: 'Receiving', receipts: 'Received', categories: 'Categories'
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
            case 'offers': await renderOffersDeskPage(contentArea); break;
            case 'review': await renderManagerReviewPage(contentArea); break;
            case 'history': await renderManagerHistoryPage(contentArea); break;
            // Kept as an alias: 'approvals' is what supply chain's saved links
            // and older notifications point at, and it is the same desk now.
            case 'approvals': await renderOffersDeskPage(contentArea); break;
            case 'approved': await renderApprovedTendersPage(contentArea); break;
            case 'notifications': await renderFinanceNotificationsPage(contentArea); break;
            case 'reports': await renderFinanceReportsPage(contentArea); break;
            case 'email-templates': await renderEmailTemplatesPage(contentArea); break;
            case 'email-log': await renderEmailLogPage(contentArea); break;
            case 'vendors': await renderVendorDirectoryPage(contentArea); break;
            case 'my-requests': await renderMyRequestsPage(contentArea); break;
            case 'new-request': await renderNewRequestPage(contentArea); break;
            case 'categories': await renderCategoriesPage(contentArea); break;
            case 'receiving': await renderReceivingPage(contentArea); break;
            case 'receipts': await renderReceiptsPage(contentArea); break;
            default:
                // Warehouse first: that account is role=employee, and the
                // employee arm below would have sent it to My Requests.
                if (isWarehouse(AppState.currentUser)) await renderDashboard(contentArea);
                else if (isStaff(AppState.currentUser)) await renderDashboard(contentArea);
                else if (isEmployee(AppState.currentUser)) await renderMyRequestsPage(contentArea);
                else await renderMyRequestsPage(contentArea);
        }
    } catch (err) {
        showLoadError(contentArea, err, `navigateTo('${page}')`);
    }
}

// A category's display name from its slug. Everything in the API carries the
// slug - it is the stable key - and everything on screen should carry the name,
// which is the half the admin can rename.
function categoryName(slug) {
    if (!slug) return '';
    const hit = (AppState.categories || []).find(c => c.slug === slug);
    return hit ? hit.name : slug;
}

// <option> list for a category picker, with `selected` on the current value.
// Includes the current value even when it has been retired, so opening an old
// record doesn't silently re-file it under whatever sorts first.
function categoryOptions(selected) {
    const list = [...(AppState.categories || [])];
    if (selected && !list.some(c => c.slug === selected)) {
        list.push({ slug: selected, name: categoryName(selected) + ' (retired)' });
    }
    return list.map(c =>
        `<option value="${escapeAttr(c.slug)}" ${c.slug === selected ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
    ).join('');
}

// The chips a vendor's categories are shown as. A vendor supplies several
// things now, so one badge would be a lie about four fifths of them.
function categoryChips(categories) {
    if (!categories || !categories.length) {
        return '<span style="color: var(--text-muted);">none</span>';
    }
    return categories.map(c => `<span class="badge">${escapeHtml(c.name)}</span>`).join(' ');
}

function deptName(id) {
    const d = AppState.departments.find(d => d.id === id);
    return d ? d.name : 'Not Set';
}

// ============================================
// DASHBOARD
// ============================================
// ============================================
// DASHBOARDS
// ============================================
// One dashboard per desk, not one dashboard with things hidden.
//
// The old screen showed everybody the same four tender counters and a list of
// recent tenders. For purchasing that is the job; for everyone else it was a
// summary of somebody else's work, and the thing they actually came to do was
// two clicks away behind a nav item. A purchasing manager approves offers — so
// that is the big table, and the tender list they occasionally need is a small
// panel underneath it.
//
// The shape is the same everywhere so the app doesn't feel like five apps: one
// wide table of what is waiting on you, then two narrower panels — a secondary
// list on the left, your own recent activity on the right.

async function renderDashboard(container) {
    const user = AppState.currentUser;
    if (isWarehouse(user))          return renderWarehouseDashboard(container);
    if (isPurchasingManager(user))  return renderPurchasingManagerDashboard(container);
    if (user.role === 'manager')    return renderDepartmentManagerDashboard(container);
    if (user.role === 'supply_chain') return renderSupplyChainDashboard(container);
    return renderProcurementDashboard(container);
}

// Every offer on every tender, grouped. There is no company-wide offers
// endpoint — /offers is scoped and anonymised per tender, and a global variant
// would be a second thing to keep in step with it — so this walks the tenders
// the same way the offers desk does.
async function collectOffers() {
    const tenders = (await apiAll('/tenders')).filter(t => (t.submission_count || 0) > 0);
    const rows = await Promise.all(tenders.map(async tender => {
        try {
            return { tender, offers: await apiFetch(`/offers?tender_id=${tender.id}`) };
        } catch (err) {
            return null;   // a 403 here is the department scope doing its job
        }
    }));
    return rows.filter(r => r && r.offers.length > 0);
}

async function myRecentActivity(limit = 8) {
    try {
        return await apiFetch(`/audit/mine?limit=${limit}`);
    } catch (err) {
        return [];
    }
}

// ---------------------------------------------------------------- components

function dashPanel(title, subtitle, bodyHtml, opts = {}) {
    return `
        <div class="card dash-panel">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">${escapeHtml(title)}</h3>
                    ${subtitle ? `<span style="font-size: 13px; color: var(--text-muted);">${subtitle}</span>` : ''}
                </div>
                ${opts.action || ''}
            </div>
            <div class="card-body" style="padding: 0;">${bodyHtml}</div>
        </div>
    `;
}

function dashEmpty(icon, message) {
    return `<div style="padding: 28px;"><div class="empty-state">
        <i class="fas ${icon}"></i><p>${message}</p>
    </div></div>`;
}

function dashTable(headers, rowsHtml, emptyIcon, emptyMessage) {
    if (!rowsHtml) return dashEmpty(emptyIcon, emptyMessage);
    return `
        <div class="table-container">
            <table class="offers-table">
                <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>`;
}

function activityPanel(entries) {
    const body = entries.length === 0
        ? dashEmpty('fa-clock-rotate-left', 'Nothing yet. Your decisions are logged here as you make them.')
        : `<ul class="activity-list">${entries.map(e => `
                <li>
                    <div class="activity-action">${escapeHtml(e.action)}</div>
                    <div class="activity-detail">${escapeHtml(e.details)}</div>
                    <div class="activity-when">${formatTimeAgo(e.created_at)}</div>
                </li>`).join('')}</ul>`;
    return dashPanel('Your recent decisions', 'Logged as you make them', body);
}

function tenderMiniRows(tenders, limit = 6) {
    return tenders.slice(0, limit).map(t => `
        <tr class="offer-row" onclick="openTenderFor('${t.id}')">
            <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(t.serial)}</code>
                <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.name)}</div></td>
            <td>${t.urgent ? '<span class="badge badge-danger">Urgent</span>' : `<span class="badge badge-info">${escapeHtml(t.category_name || t.category || '')}</span>`}</td>
            <td style="white-space: nowrap;">${formatDeadline(t)}</td>
        </tr>`).join('');
}

// Rows of offers waiting at one desk, across every tender.
function offerWaitingRows(rows, verb, path) {
    return rows.map(({ tender, offer }) => `
        <tr class="offer-row ${tender.urgent ? 'is-urgent' : ''}">
            <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(tender.serial)}</code>
                <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(tender.name)}</div></td>
            <td><strong>${escapeHtml(offer.label)}</strong>
                ${offer.title ? `<div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(offer.title)}</div>` : ''}</td>
            <td>${offer.covers_items} item(s)</td>
            <td style="font-weight: 700; color: var(--accent-light); white-space: nowrap;">
                ${escapeHtml(tender.currency || '')} ${Number(offer.total_amount).toLocaleString()}</td>
            <td class="offer-actions">
                ${tender.urgent ? '<span class="badge badge-danger">Urgent</span>' : ''}
                <button class="btn btn-success btn-sm"
                        onclick="approveOffer('${tender.id}', '${offer.id}', '${path}')">${escapeHtml(verb)}</button>
                <button class="btn btn-secondary btn-sm" onclick="openOffersFor('${tender.id}')">Open</button>
            </td>
        </tr>`).join('');
}

// Baskets waiting at one desk, rendered into the same "waiting on you" table
// as the offers. A basket and an offer are two ways of buying the same tender,
// and splitting them across two screens is what left the purchasing manager
// holding a notification with nowhere to go.
function basketWaitingRows(awards, verb, path) {
    return awards.map(a => `
        <tr class="offer-row ${a.urgent ? 'is-urgent' : ''}">
            <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(a.tender_serial)}</code>
                <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(a.tender_name)}</div></td>
            <td><span class="badge badge-info"><i class="fas fa-basket-shopping"></i> Basket</span>
                <div style="font-size: 12px; color: var(--text-muted);">${a.vendor_count} supplier(s)</div></td>
            <td>${a.items_answered} of ${a.items_required}</td>
            <td style="font-weight: 700; color: var(--accent-light); white-space: nowrap;">
                ${escapeHtml(a.currency)} ${Number(a.total_amount).toLocaleString()}</td>
            <td class="offer-actions">
                ${a.urgent ? '<span class="badge badge-danger">Urgent</span>' : ''}
                <button class="btn btn-success btn-sm"
                        onclick="approveBasket('${a.tender_id}', '${path}')">${escapeHtml(verb)}</button>
                <button class="btn btn-secondary btn-sm" onclick="openBasketPage('${a.tender_id}')">Open</button>
            </td>
        </tr>`).join('');
}

// Baskets that were bought without this desk being asked.
//
// An urgent tender skips both approving desks, and for a while that meant the
// basket vanished: it was `approved`, so it wasn't waiting anywhere, and
// neither the purchasing manager nor supply chain had any screen it appeared
// on. They were notified once and then it was gone. Urgency is a reason to
// skip somebody's approval, not a reason to hide the purchase from them - so
// it shows here, as a record with nothing to press.
function basketSkippedRows(awards) {
    return awards.map(a => `
        <tr class="offer-row ${a.urgent ? 'is-urgent' : ''}">
            <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(a.tender_serial)}</code>
                <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(a.tender_name)}</div></td>
            <td><span class="badge badge-info"><i class="fas fa-basket-shopping"></i> Basket</span>
                <div style="font-size: 12px; color: var(--text-muted);">${a.vendor_count} supplier(s)</div></td>
            <td>${a.items_answered} of ${a.items_required}</td>
            <td style="font-weight: 700; color: var(--accent-light); white-space: nowrap;">
                ${escapeHtml(a.currency)} ${Number(a.total_amount).toLocaleString()}</td>
            <td class="offer-actions">
                <span class="badge badge-success">Approved</span>
                ${a.urgent ? '<span class="badge badge-danger"><i class="fas fa-bolt"></i> Urgent</span>' : ''}
                <button class="btn btn-secondary btn-sm" onclick="openBasketPage('${a.tender_id}')">Open</button>
            </td>
        </tr>`).join('');
}

// The panel the rows above go in. Rendered by both desks that can be skipped,
// and by neither of them when nothing was.
function skippedBasketPanel(awards) {
    if (!awards.length) return '';
    return dashPanel(
        'Approved without you',
        `${awards.length} urgent basket(s) bought before you were asked`,
        dashTable(['Tender', 'Bought as', 'Covers', 'Total', ''],
            basketSkippedRows(awards.slice(0, 8)), 'fa-bolt', '')
    );
}

// Jump to the offers desk with a particular tender already selected, so a
// dashboard row lands on the thing it was describing rather than on whatever
// the desk would have picked for itself.
function openOffersFor(tenderId) {
    offersTenderId = tenderId;
    navigateTo('offers', { keepContext: true });
}

// The same, for the bid-checking screen.
function openSubmissionsFor(tenderId) {
    submissionsTenderId = tenderId;
    navigateTo('submissions', { keepContext: true });
}

// ------------------------------------------------------- purchasing manager

async function renderPurchasingManagerDashboard(container) {
    const [withOffers, open, activity, baskets, done] = await Promise.all([
        collectOffers(),
        apiList('/tenders', { status: 'open', limit: 20 }),
        myRecentActivity(),
        apiFetch('/awards?status=submitted').catch(() => []),
        apiFetch('/awards?status=approved').catch(() => []),
    ]);
    const skipped = done.filter(a => a.urgent_skipped);

    // Their step of the chain: the department manager shortlisted, purchasing
    // committed to one, and it is now sitting on this desk.
    const waiting = [];
    withOffers.forEach(({ tender, offers }) => offers
        .filter(o => o.status === 'purchasing_ok')
        .forEach(offer => waiting.push({ tender, offer })));

    container.innerHTML = `
        ${dashPanel(
            'Waiting on you',
            `${waiting.length} offer(s) and ${baskets.length} basket(s) needing your approval`,
            dashTable(
                ['Tender', 'Offer', 'Covers', 'Total', ''],
                basketWaitingRows(baskets, 'Approve & send on', 'purchasing-manager-approve')
                    + offerWaitingRows(waiting, 'Approve & send on', 'purchasing-manager-approve'),
                'fa-stamp',
                'Nothing waiting on you. Work reaches this desk once purchasing has committed to it.'
            )
        )}
        ${skippedBasketPanel(skipped)}
        <div class="dash-split">
            ${dashPanel('Open tenders', `${open.total} out to vendors`,
                dashTable(['Tender', '', 'Closes'], tenderMiniRows(open.items),
                    'fa-file-contract', 'No tenders are open.'))}
            ${activityPanel(activity)}
        </div>
    `;
}

// ------------------------------------------------------ department manager

async function renderDepartmentManagerDashboard(container) {
    const [pending, withOffers, activity] = await Promise.all([
        apiAll('/tenders', { status: 'pending_approval' }),
        collectOffers(),
        myRecentActivity(),
    ]);

    // Tenders where offers are in front of them and no shortlist has gone back
    // yet. Once they send one the tender leaves this list, the same way it
    // leaves the offers desk — the decision is sealed.
    const undecided = withOffers.filter(({ offers }) =>
        offers.some(o => o.status === 'forwarded') &&
        !offers.some(o => ['selected', 'purchasing_ok', 'purchasing_manager_ok', 'approved'].includes(o.status)));

    container.innerHTML = `
        ${dashPanel(
            'Requests waiting on your approval',
            `${pending.length} request(s) raised by your department`,
            dashTable(
                ['Serial', 'Request', 'Raised', ''],
                pending.slice(0, 8).map(t => `
                    <tr class="offer-row ${t.urgent ? 'is-urgent' : ''}">
                        <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(t.serial)}</code></td>
                        <td><strong>${escapeHtml(t.name)}</strong>
                            <div style="font-size: 12px; color: var(--text-muted);">${(t.items || []).length} item(s)</div></td>
                        <td style="white-space: nowrap;">${formatDate(t.created_at)}</td>
                        <td class="offer-actions">
                            ${t.urgent ? '<span class="badge badge-danger">Urgent</span>' : ''}
                            <button class="btn btn-accent btn-sm" onclick="openTenderReview('${t.id}')">Review</button>
                        </td>
                    </tr>`).join(''),
                'fa-clipboard-check',
                'Nothing waiting on you. Requests from your department appear here.'
            )
        )}
        <div class="dash-split">
            ${dashPanel('Offers you haven\'t chosen from', `${undecided.length} tender(s) with a shortlist still to send`,
                dashTable(['Tender', 'Offers', ''],
                    undecided.slice(0, 6).map(({ tender, offers }) => `
                        <tr class="offer-row" onclick="openOffersFor('${tender.id}')">
                            <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(tender.serial)}</code>
                                <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(tender.name)}</div></td>
                            <td>${offers.length}</td>
                            <td class="offer-actions"><button class="btn btn-secondary btn-sm"
                                onclick="event.stopPropagation(); openOffersFor('${tender.id}')">Compare</button></td>
                        </tr>`).join(''),
                    'fa-scale-balanced', 'Nothing to compare. Purchasing sends you the offers worth reading.'))}
            ${activityPanel(activity)}
        </div>
    `;
}

// ------------------------------------------------------------- supply chain

async function renderSupplyChainDashboard(container) {
    const [withOffers, activity, baskets, done] = await Promise.all([
        collectOffers(),
        myRecentActivity(),
        apiFetch('/awards?status=purchasing_manager_ok').catch(() => []),
        apiFetch('/awards?status=approved').catch(() => []),
    ]);
    const skipped = done.filter(a => a.urgent_skipped);
    const myDept = currentDepartment();

    const waiting = [];
    withOffers.forEach(({ tender, offers }) => offers
        .filter(o => o.status === 'purchasing_manager_ok')
        .forEach(offer => waiting.push({ tender, offer })));

    // Tenders their own department raised, and where each one has got to.
    // Supply chain approve everybody's purchases; this is the panel about
    // their own, which is the part nobody else is watching for them.
    const mine = withOffers.filter(({ tender }) =>
        myDept && tender.department_id === myDept.id);

    container.innerHTML = `
        ${dashPanel(
            'Awaiting your approval',
            `${waiting.length} offer(s) and ${baskets.length} basket(s) at the last step before they are bought`,
            dashTable(
                ['Tender', 'Offer', 'Covers', 'Total', ''],
                basketWaitingRows(baskets, 'Approve', 'supply-chain-approve')
                    + offerWaitingRows(waiting, 'Approve', 'supply-chain-approve'),
                'fa-stamp',
                'Nothing waiting on you. A purchase reaches you once the purchasing manager has signed it.'
            )
        )}
        ${skippedBasketPanel(skipped)}
        <div class="dash-split">
            ${dashPanel('Your department\'s tenders', `${mine.length} raised by ${escapeHtml(myDept?.name || 'your department')}`,
                dashTable(['Tender', 'Offers', 'Status'],
                    mine.slice(0, 6).map(({ tender, offers }) => {
                        const done = offers.filter(o => o.status === 'approved').length;
                        return `
                        <tr class="offer-row" onclick="openOffersFor('${tender.id}')">
                            <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(tender.serial)}</code>
                                <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(tender.name)}</div></td>
                            <td>${offers.length}</td>
                            <td>${done
                                ? '<span class="badge badge-success">bought</span>'
                                : '<span class="badge badge-secondary">in progress</span>'}</td>
                        </tr>`; }).join(''),
                    'fa-folder-open', 'Your department hasn\'t raised anything with bids on it yet.'))}
            ${activityPanel(activity)}
        </div>
    `;
}

// ---------------------------------------------------------------- warehouse

async function renderWarehouseDashboard(container) {
    const [incoming, receipts, activity] = await Promise.all([
        apiFetch('/receiving/incoming').catch(() => []),
        apiFetch('/receiving/receipts?limit=50').catch(() => []),
        myRecentActivity(),
    ]);

    // The bottom-left panel: deliveries this warehouse checked in with
    // something wrong. Chosen over a plain "recently received" list because
    // that one is read once and forgotten, while a delivery three boxes short
    // is the warehouse's own open loop — the thing they will be asked about.
    const flagged = receipts.filter(r => r.problem_lines > 0);

    container.innerHTML = `
        ${dashPanel(
            'On the way',
            `${incoming.length} approved shipment(s) not yet received`,
            dashTable(
                ['Tender', 'Supplier', 'Lines', 'Value', ''],
                incoming.slice(0, 8).map(s => `
                    <tr class="offer-row ${s.urgent ? 'is-urgent' : ''}">
                        <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(s.tender_serial)}</code>
                            <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(s.tender_name)}</div></td>
                        <td><strong>${escapeHtml(s.vendor_company)}</strong></td>
                        <td>${s.items.length}</td>
                        <td style="font-weight: 700; color: var(--accent-light); white-space: nowrap;">
                            ${escapeHtml(s.currency)} ${Number(s.total_amount).toLocaleString()}</td>
                        <td class="offer-actions">
                            ${s.urgent ? '<span class="badge badge-danger">Urgent</span>' : ''}
                            <button class="btn btn-accent btn-sm" onclick="openReceiveModal('${s.offer_id}')">
                                <i class="fas fa-clipboard-check"></i> Receive</button>
                        </td>
                    </tr>`).join(''),
                'fa-truck-ramp-box',
                'Nothing on its way. A purchase appears here once supply chain has approved it.'
            )
        )}
        <div class="dash-split">
            ${dashPanel('Flagged on arrival', `${flagged.length} delivery(s) you reported a problem on`,
                dashTable(['Tender', 'Supplier', 'Flagged'],
                    flagged.slice(0, 6).map(r => `
                        <tr class="offer-row" onclick="navigateTo('receipts')">
                            <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(r.tender_serial)}</code></td>
                            <td>${escapeHtml(r.vendor_company)}</td>
                            <td><span class="substitute-count">${r.problem_lines}</span> of ${r.total_lines}</td>
                        </tr>`).join(''),
                    'fa-circle-check', 'Nothing flagged. Every delivery arrived as ordered.'))}
            ${activityPanel(activity)}
        </div>
    `;
}

// ------------------------------------------------ purchasing, admin, finance

// Purchasing's own desk, in the same three-panel shape as the others.
//
// The top table is the tender pipeline, because for purchasing that genuinely
// is the job — they raise them, invite the vendors and chase the deadlines.
// Underneath: the offers still needing a first pass on the left, and the bids
// still needing checking on the right.
//
// Both bottom panels are grouped by tender and each row jumps straight to that
// tender already selected. That is the whole point of them: the offers screen
// and the submissions screen are one-tender-at-a-time, and the thing that used
// to go wrong was arriving at either with somebody else's tender loaded.
async function renderProcurementDashboard(container) {
    const [recent, open, allSubs, pendingSubs, withOffers] = await Promise.all([
        apiList('/tenders', { limit: 6 }),
        apiList('/tenders', { status: 'open', limit: 1 }),
        apiList('/submissions', { limit: 1 }),
        apiAll('/submissions', { status: 'pending' }),
        collectOffers(),
    ]);

    const canManage = ['admin', 'procurement'].includes(AppState.currentUser?.role);

    // Tenders with offers nobody has filtered yet. `pending` is precisely
    // "arrived, and purchasing hasn't decided whether the manager sees it".
    const needFiltering = withOffers
        .map(({ tender, offers }) => ({ tender, n: offers.filter(o => o.status === 'pending').length }))
        .filter(row => row.n > 0)
        .sort((a, b) => b.n - a.n);

    // Unchecked bids, grouped the same way. Until one is validated nothing
    // inside it reaches the offers desk at all, so this panel is upstream of
    // the one beside it.
    const byTender = new Map();
    pendingSubs.forEach(sub => {
        if (!byTender.has(sub.tender_id)) byTender.set(sub.tender_id, []);
        byTender.get(sub.tender_id).push(sub);
    });
    const tenderById = Object.fromEntries(
        [...recent.items, ...withOffers.map(r => r.tender)].map(t => [t.id, t]));
    const needChecking = [...byTender.entries()]
        .map(([id, subs]) => ({ tender: tenderById[id], id, n: subs.length }))
        .sort((a, b) => b.n - a.n);

    container.innerHTML = `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon blue"><i class="fas fa-file-contract"></i></div>
                <div class="stat-content"><h3>${open.total}</h3><p>Open Tenders</p></div>
            </div>
            <div class="stat-card">
                <div class="stat-icon amber"><i class="fas fa-inbox"></i></div>
                <div class="stat-content"><h3>${allSubs.total}</h3><p>Total Bids</p></div>
            </div>
            <div class="stat-card">
                <div class="stat-icon purple"><i class="fas fa-clock"></i></div>
                <div class="stat-content"><h3>${pendingSubs.length}</h3><p>Bids To Check</p></div>
            </div>
            <div class="stat-card">
                <div class="stat-icon green"><i class="fas fa-scale-balanced"></i></div>
                <div class="stat-content"><h3>${needFiltering.reduce((n, r) => n + r.n, 0)}</h3><p>Offers To Filter</p></div>
            </div>
        </div>

        ${dashPanel('Tenders', `${open.total} open &middot; most recent first`,
            dashTable(['Serial', 'Name', 'Category', 'Deadline', 'Status', ''],
                recent.items.map(t => `
                    <tr class="offer-row ${t.urgent ? 'is-urgent' : ''}">
                        <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(t.serial)}</code></td>
                        <td><strong>${escapeHtml(t.name)}</strong></td>
                        <td><span class="badge badge-info">${escapeHtml(t.category_name || t.category || '')}</span></td>
                        <td style="white-space: nowrap;">${formatDeadline(t)}</td>
                        <td><span class="badge ${t.status === 'open' ? 'badge-success' : 'badge-secondary'}">${escapeHtml(t.status)}</span></td>
                        <td class="offer-actions">
                            ${t.urgent ? '<span class="badge badge-danger">Urgent</span>' : ''}
                            <button class="action-btn" onclick="openTenderFor('${t.id}')" title="View"><i class="fas fa-eye"></i></button>
                            <!-- Inviting vendors is the next thing that happens to a tender
                                 the moment it opens, so it belongs on the panel where you
                                 first see that it opened, not one screen away. -->
                            ${t.status === 'open' ? `<button class="action-btn" onclick="event.stopPropagation(); openTenderVendors('${t.id}')" title="Choose which vendors are asked"><i class="fas fa-paper-plane"></i></button>` : ''}
                            ${(t.submission_count || 0) > 0 ? `<button class="action-btn" onclick="event.stopPropagation(); openOffersFor('${t.id}')" title="Offers on this tender"><i class="fas fa-scale-balanced"></i></button>` : ''}
                        </td>
                    </tr>`).join(''),
                'fa-file-contract', 'No tenders yet.'),
            { action: canManage
                ? `<button class="btn btn-accent btn-sm" onclick="openCreateTenderModal()"><i class="fas fa-plus"></i> New Tender</button>`
                : '' })}

        <div class="dash-split">
            ${dashPanel('Offers waiting to be filtered',
                `${needFiltering.length} tender(s) with bids nobody has sorted yet`,
                dashTable(['Tender', 'Unfiltered', ''],
                    needFiltering.slice(0, 6).map(({ tender, n }) => `
                        <tr class="offer-row" onclick="openOffersFor('${tender.id}')">
                            <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(tender.serial)}</code>
                                <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(tender.name)}</div></td>
                            <td><span class="substitute-count">${n}</span></td>
                            <td class="offer-actions"><button class="btn btn-secondary btn-sm"
                                onclick="event.stopPropagation(); openOffersFor('${tender.id}')">Filter</button></td>
                        </tr>`).join(''),
                    'fa-scale-balanced',
                    'Nothing to filter. Offers land here once the bid they came in is validated.'))}

            ${dashPanel('Bids waiting to be checked',
                `${needChecking.length} tender(s) with unvalidated bids`,
                dashTable(['Tender', 'Unchecked', ''],
                    needChecking.slice(0, 6).map(({ tender, id, n }) => `
                        <tr class="offer-row" onclick="openSubmissionsFor('${id}')">
                            <td>${tender
                                ? `<code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(tender.serial)}</code>
                                   <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(tender.name)}</div>`
                                : '<span style="color: var(--text-muted);">Unknown tender</span>'}</td>
                            <td><span class="substitute-count">${n}</span></td>
                            <td class="offer-actions"><button class="btn btn-secondary btn-sm"
                                onclick="event.stopPropagation(); openSubmissionsFor('${id}')">Check</button></td>
                        </tr>`).join(''),
                    'fa-inbox', 'Every bid has been checked.'))}
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
                <td><strong>${escapeHtml(tender.name)}</strong>${tender.description ? `<div style="font-size: 12px; color: var(--text-muted); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(tender.description)}</div>` : ''}</td>
                <td><span class="badge badge-warning">${escapeHtml(deptName(tender.department_id))}</span></td>
                <td><span class="badge badge-info">${escapeHtml(tender.category_name || tender.category || '')}</span></td>
                <td>${tender.currency}</td>
                <td>${formatDeadline(tender)} ${isExpired && tender.status === 'open' ? '<span class="badge badge-danger" style="margin-left: 4px;">Expired</span>' : ''}</td>
                <td><span class="badge ${TENDER_STATUS_BADGE[tender.status] || 'badge-secondary'}">${tenderStatusLabel(tender.status)}</span>
                    ${tender.status === 'rejected' && tender.manager_rejected ? `<div style="font-size: 11px; color: var(--text-muted);">sent back by manager</div>` : ''}</td>
                <td>${tender.submission_count || 0}</td>
                <td>
                    <div class="actions">
                        <button class="action-btn" onclick="viewTender('${tender.id}')" title="View"><i class="fas fa-eye"></i></button>
                        ${tender.status === 'open' ? `<button class="action-btn" onclick="openTenderVendors('${tender.id}')" title="Choose which vendors are asked"><i class="fas fa-paper-plane"></i></button>` : ''}
                        ${(tender.submission_count || 0) > 0 ? `<button class="action-btn" onclick="openOffersFor('${tender.id}')" title="Offers on this tender"><i class="fas fa-scale-balanced"></i></button>` : ''}
                        ${canEditTender(tender) ? `<button class="action-btn" onclick="openEditTenderModal('${tender.id}')" title="Edit the request"><i class="fas fa-edit"></i></button>` : ''}
                        ${canManage && tender.manager_approved && tender.status !== 'awarded' ? `<button class="action-btn" onclick="openBasketPage('${tender.id}')" title="The basket — what we're buying"><i class="fas fa-basket-shopping"></i></button>` : ''}
                        ${canManage && tender.status === 'rejected' && tender.manager_rejected && !tender.manager_declined ? `<button class="action-btn success" onclick="resubmitTender('${tender.id}')" title="Resubmit for approval"><i class="fas fa-paper-plane"></i></button>` : ''}
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

// There is no single tender link any more. Each invited vendor gets their own,
// issued from the "who gets asked" screen — a shared one would make every bid
// anonymous at exactly the point attribution matters.

function isTenderExpired(tender) {
    // The API computes this against the server clock, which is the clock the
    // deadline was written on. Falling back to the browser's would disagree by
    // the viewer's UTC offset — telling someone in another timezone a tender is
    // still open hours after the server stopped taking bids.
    if (typeof tender.is_expired === 'boolean') return tender.is_expired;
    // No deadline means the manager hasn't approved it yet, so there is
    // nothing to have expired. Comparing against a null date would say
    // "expired" for every request still waiting on its manager.
    if (!tender.deadline_date) return false;
    return new Date() > new Date(`${tender.deadline_date}T${tender.deadline_time}`);
}

async function viewTender(tenderId) {
    let tender;
    try {
        tender = await apiFetch(`/tenders/${tenderId}`);
    } catch (err) {
        showToast('error', 'Error', err.message);
        return;
    }
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
        ${tender.description ? `<p style="color: var(--text-secondary); margin-bottom: 24px;">${escapeHtml(tender.description)}</p>` : ''}
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px;">
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Department</label><p style="font-weight: 600;"><span class="badge badge-warning">${escapeHtml(deptName(tender.department_id))}</span></p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Deadline</label><p style="font-weight: 600;">${formatDeadline(tender)}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Currency</label><p style="font-weight: 600;">${tender.currency}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Category</label><p style="font-weight: 600;">${escapeHtml(tender.category_name || tender.category || '')}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Submissions</label><p style="font-weight: 600;">${tender.submission_count || 0}</p></div>
        </div>
        <div style="margin-bottom: 24px;"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Required Documents</label><div style="margin-top: 8px;">${(tender.required_docs || []).map(doc => `<span class="chip"><i class="fas fa-file-alt"></i> ${escapeHtml(doc)}</span>`).join('') || '<span style="color:var(--text-muted);">None specified</span>'}</div></div>
        ${tender.status === 'pending_approval' ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--warning);"><strong>Waiting on the department manager.</strong><p style="color: var(--text-secondary); margin-top: 4px;">Vendors can't see this tender and no link works until a manager approves it.</p></div>` : ''}
        ${tender.manager_rejected && tender.manager_feedback ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--danger);"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Manager Sent This Back</label><p style="margin-top: 4px;">${escapeHtml(tender.manager_feedback)}</p></div>` : ''}
        ${tender.supply_chain_rejected && tender.supply_chain_rejection_reason ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--danger);"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Rejected by Supply Chain</label><p style="margin-top: 4px;">${escapeHtml(tender.supply_chain_rejection_reason)}</p></div>` : ''}
        ${tender.status === 'open' && !isExpired ? `<div style="margin-bottom: 24px;"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Vendors</label><p style="color: var(--text-secondary); margin-top: 6px;">Each invited vendor gets their own link. Open <strong>Who gets asked</strong> to pick them and copy a link.</p></div>` : ''}
        ${tender.awarded_vendor_name ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--accent);"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Awarded To</label><p style="font-weight: 700; font-size: 16px; margin-top: 4px;">${escapeHtml(tender.awarded_vendor_name)}</p><p style="color: var(--text-secondary);">${tender.currency} ${Number(tender.awarded_amount || 0).toLocaleString()} &middot; ${escapeHtml(tender.awarded_email || '')}</p></div>` : ''}
        ${canManage ? `
            <div style="border-top: 1px solid var(--border); padding-top: 20px; margin-top: 24px;">
                <label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 12px; display: block;">Actions</label>
                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                    ${canEditTender(tender) ? `<button class="btn btn-sm btn-secondary" onclick="openEditTenderModal('${tender.id}')"><i class="fas fa-edit"></i> Edit</button>` : ''}
                    <button class="btn btn-sm btn-secondary" onclick="openPurchasingTerms('${tender.id}')"><i class="fas fa-file-invoice-dollar"></i> Terms</button>
                    <button class="btn btn-sm btn-secondary" onclick="duplicateTender('${tender.id}')"><i class="fas fa-copy"></i> Duplicate</button>
                    <button class="btn btn-sm btn-secondary" onclick="extendDeadline('${tender.id}')"><i class="fas fa-calendar-plus"></i> Extend Deadline</button>
                    ${tender.status === 'rejected' && tender.manager_rejected && !tender.manager_declined ? `<button class="btn btn-sm btn-success" onclick="resubmitTender('${tender.id}')"><i class="fas fa-paper-plane"></i> Resubmit for Approval</button>` : ''}
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

// ------------------------------------------------------- purchasing's terms

// Currency and required documents used to sit on the request form, where the
// person asking for a laptop had to answer them. They are purchasing's call,
// so they live here instead - on the tender, after it has been picked up.
const CURRENCIES = ['EGP', 'USD', 'EUR', 'GBP', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR'];

async function openPurchasingTerms(tenderId) {
    let tender;
    try {
        tender = await apiFetch(`/tenders/${tenderId}`);
    } catch (err) {
        showToast('error', 'Error', err.message);
        return;
    }

    const options = CURRENCIES
        .map(c => `<option value="${c}" ${c === tender.currency ? 'selected' : ''}>${c}</option>`)
        .join('');

    showFormDialog(
        `Terms — ${escapeHtml(tender.serial)}`,
        `
        <div class="form-group">
            <label>Currency</label>
            <select class="form-control" id="termsCurrency">${options}</select>
            <small class="form-hint">What vendors quote in. Shown on the RFQ and on every price in the basket.</small>
        </div>
        <div class="form-group">
            <label>Required Documents</label>
            <input type="text" class="form-control" id="termsDocs" value="${escapeAttr((tender.required_docs || []).join(', '))}"
                   placeholder="Company Profile, Tax Card">
            <small class="form-hint">Separate with commas. Leave empty to ask for nothing.</small>
        </div>
        `,
        'Save Terms',
        async () => {
            const currency = document.getElementById('termsCurrency').value;
            const required_docs = document.getElementById('termsDocs').value
                .split(',').map(d => d.trim()).filter(Boolean);
            try {
                const updated = await apiFetch(`/tenders/${tenderId}/purchasing-details`, {
                    method: 'PATCH',
                    body: JSON.stringify({ currency, required_docs }),
                });
                showToast('success', 'Terms Saved', `${updated.serial} quotes in ${updated.currency}`);
                closeModal('viewTenderModal');
                renderPage(AppState.currentPage);
            } catch (err) {
                showToast('error', 'Error', err.message);
                return false;
            }
        }
    );
}

// ---------------------------------------------------- the requirement table

// The request form is a table, not a paragraph. Rows are held in the DOM
// rather than in a JS array: an input the user is halfway through typing is
// the truth, and mirroring it into state would mean deciding which copy wins
// every time a row is added or removed.

function itemRowHtml(item) {
    // escapeAttr, not escapeHtml: these go inside value="...", and escapeHtml
    // leaves double quotes alone. An item called `24" monitor` would close the
    // attribute early and lose everything after the inch mark.
    const it = item || {};
    return `
        <tr class="item-row">
            <td class="col-num"></td>
            <td><input type="text" class="form-control item-name" value="${escapeAttr(it.name || '')}" placeholder="Wireless mouse"></td>
            <td><input type="text" class="form-control item-specs" value="${escapeAttr(it.specs || '')}" placeholder="2.4GHz, 6 buttons"></td>
            <td class="col-qty"><input type="number" class="form-control item-qty" min="0.01" step="any" value="${it.quantity != null ? it.quantity : 1}"></td>
            <td class="col-unit"><input type="text" class="form-control item-unit" value="${escapeAttr(it.unit || 'pcs')}"></td>
            <td><input type="text" class="form-control item-notes" value="${escapeAttr(it.notes || '')}" placeholder="red"></td>
            <td class="col-act">
                <button type="button" class="btn-icon-danger" title="Remove this row" onclick="removeItemRow(this)">
                    <i class="fas fa-times"></i>
                </button>
            </td>
        </tr>`;
}

// The row numbers are painted on rather than stored, so deleting row 2 of four
// leaves 1-2-3 behind instead of 1-3-4.
function renumberItemRows() {
    const body = document.getElementById('tenderItemsBody');
    if (!body) return;
    Array.from(body.querySelectorAll('tr.item-row')).forEach((tr, i) => {
        tr.querySelector('.col-num').textContent = i + 1;
    });
}

function addItemRow(item) {
    const body = document.getElementById('tenderItemsBody');
    if (!body) return;
    body.insertAdjacentHTML('beforeend', itemRowHtml(item));
    renumberItemRows();
    if (!item) {
        const rows = body.querySelectorAll('tr.item-row');
        rows[rows.length - 1].querySelector('.item-name').focus();
    }
}

function removeItemRow(btn) {
    const body = document.getElementById('tenderItemsBody');
    btn.closest('tr').remove();
    // Never leave the table empty - an empty table reads as a broken form
    // rather than as a request with nothing in it.
    if (!body.querySelector('tr.item-row')) addItemRow();
    renumberItemRows();
}

function setItemRows(items) {
    const body = document.getElementById('tenderItemsBody');
    if (!body) return;
    body.innerHTML = '';
    const rows = (items && items.length) ? items : [null];
    rows.forEach(item => body.insertAdjacentHTML('beforeend', itemRowHtml(item)));
    renumberItemRows();
}

function collectItemRows() {
    const body = document.getElementById('tenderItemsBody');
    if (!body) return [];
    return Array.from(body.querySelectorAll('tr.item-row')).map(tr => {
        const val = sel => (tr.querySelector(sel).value || '').trim();
        return {
            name: val('.item-name'),
            specs: val('.item-specs') || null,
            notes: val('.item-notes') || null,
            quantity: parseFloat(tr.querySelector('.item-qty').value),
            unit: val('.item-unit') || 'pcs',
        };
    // A row nobody typed an item name into is a row they added and changed
    // their mind about, not an error to stop them on.
    }).filter(row => row.name);
}

// Shows which department the request will be filed under. Read-only: it comes
// from the account, and the backend takes it from there too, so this can only
// ever report what will happen rather than change it.
function showRequesterDepartment() {
    const el = document.getElementById('tenderDepartmentLabel');
    if (!el) return;
    const user = AppState.currentUser;
    const dept = (AppState.departments || []).find(d => d.id === (user && user.department_id));
    el.textContent = dept ? dept.name : 'Not set - ask an administrator';
    el.classList.toggle('form-static-warn', !dept);
}

function openCreateTenderModal() {
    resetCreateTenderModal();
    openModal('createTenderModal');
}

// Who may rewrite the request itself. Mirrors tenders.py::_load_for_edit, and
// the server is the one that enforces it - this only decides whether a button
// that would 403 is drawn at all.
//
// Purchasing is deliberately absent. The request is the requesting
// department's statement of what they need; the currency and the required
// documents are purchasing's, and those live on the Terms dialog.
function canEditTender(tender) {
    const user = AppState.currentUser;
    if (!user || !tender) return false;
    if (user.role === 'admin') return true;
    if (user.role !== 'manager' || isPurchasingManager(user)) return false;
    // Their window closes when vendors can see it: editing an open tender
    // moves the goalposts under offers already in flight.
    return ['pending_approval', 'rejected'].includes(tender.status);
}

async function openEditTenderModal(tenderId) {
    let tender;
    try {
        tender = await apiFetch(`/tenders/${tenderId}`);
    } catch (err) {
        showToast('error', 'Error', err.message);
        return;
    }
    resetCreateTenderModal();
    document.getElementById('editTenderId').value = tender.id;
    document.getElementById('tenderName').value = tender.name;
    fillTenderCategories(tender.category);
    setItemRows(tender.items);
    document.getElementById('tenderModalTitle').textContent = 'Edit Tender';
    const btn = document.getElementById('tenderModalSubmitBtn');
    btn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
    closeModal('viewTenderModal');
    openModal('createTenderModal');
}

// Three fields, because three fields are all the requester decides. The
// department comes from their account, the currency and required documents are
// purchasing's, and the deadline is set by the manager who approves it.
function collectTenderFormPayload() {
    const name = document.getElementById('tenderName').value.trim();
    const category = document.getElementById('tenderCategory').value;
    const items = collectItemRows();

    if (!name) {
        showToast('error', 'Validation Error', 'Give the request a name');
        return null;
    }
    if (!items.length) {
        showToast('error', 'Validation Error', 'Add at least one item - this is what the request is for');
        return null;
    }
    const badQty = items.find(i => !(i.quantity > 0));
    if (badQty) {
        showToast('error', 'Validation Error', `"${badQty.name}" needs a quantity greater than zero`);
        return null;
    }

    return { name, category, items };
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
    // The category list is the admin's now, so the options are written at open
    // time rather than sitting in the markup. `reset()` above would not clear
    // them, but rebuilding is what keeps a category added five minutes ago
    // from being missing until the page is reloaded.
    fillTenderCategories(null);
    showRequesterDepartment();
    setItemRows(null);
    const forEmployee = isEmployee(AppState.currentUser);
    document.getElementById('tenderModalTitle').textContent = forEmployee ? 'New Request' : 'Create New Tender';
    const btn = document.getElementById('tenderModalSubmitBtn');
    btn.innerHTML = forEmployee
        ? '<i class="fas fa-paper-plane"></i> Submit for Approval'
        : '<i class="fas fa-plus"></i> Create Tender';
}


// The category <select> on the create/edit tender form.
function fillTenderCategories(selected) {
    const box = document.getElementById('tenderCategory');
    if (!box) return;
    box.innerHTML = categoryOptions(selected)
        || '<option value="">No categories set up yet</option>';
    if (selected) box.value = selected;
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
    showConfirmDialog('Reset Tender Cycle', 'This will permanently delete ALL bids and offers on this tender and send it back for approval. This cannot be undone. Continue?', async () => {
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
        ? `Current: <strong>${formatDeadline(tender)}</strong>`
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
        showToast('success', 'Deadline Extended', `New deadline: ${formatDeadline(tender)}`);
        closeModal('extendDeadlineModal');
        closeModal('viewTenderModal');
        renderPage(AppState.currentPage);
    } catch (err) { showToast('error', 'Error', err.message); }
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
            <td><span class="badge badge-secondary">${escapeHtml(request.category_name || request.category || '')}</span></td>
            <td>${formatDeadline(request)}</td>
            <td><span class="badge ${TENDER_STATUS_BADGE[request.status] || 'badge-secondary'}">${tenderStatusLabel(request.status)}</span></td>
            <td>
                <div class="actions">
                    <button class="action-btn" title="View" onclick="viewMyRequest('${request.id}')"><i class="fas fa-eye"></i></button>
                    ${editable ? `<button class="action-btn" title="Edit" onclick="openEditRequestModal('${request.id}')"><i class="fas fa-pen"></i></button>` : ''}
                    ${request.status === 'rejected' && !request.manager_declined ? `<button class="action-btn success" title="Resubmit for approval" onclick="resubmitMyRequest('${request.id}')"><i class="fas fa-paper-plane"></i></button>` : ''}
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
        ${r.manager_declined ? `<div class="callout callout-danger" style="margin-bottom: 20px;"><strong>This request was declined.</strong><p style="color: var(--text-secondary); margin-top: 4px;">It can't be resubmitted. Raise a new request if the need still stands.</p></div>` : ''}
        ${r.description ? `<p style="color: var(--text-secondary); margin-bottom: 24px;">${escapeHtml(r.description)}</p>` : ''}
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px;">
            <div><label style="${label}">Department</label><p style="font-weight: 600;"><span class="badge badge-warning">${escapeHtml(deptName(r.department_id))}</span></p></div>
            <div><label style="${label}">Deadline</label><p style="font-weight: 600;">${formatDeadline(r)}</p></div>
            <div><label style="${label}">Currency</label><p style="font-weight: 600;">${escapeHtml(r.currency)}</p></div>
            <div><label style="${label}">Category</label><p style="font-weight: 600;">${escapeHtml(r.category_name || r.category || '')}</p></div>
        </div>
        <div style="margin-bottom: 24px;"><label style="${label}">Required Documents</label><div style="margin-top: 8px;">${(r.required_docs || []).map(d => `<span class="chip"><i class="fas fa-file-alt"></i> ${escapeHtml(d)}</span>`).join('') || '<span style="color:var(--text-muted);">None specified</span>'}</div></div>
        ${r.status === 'pending_approval' ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--warning);"><strong>Waiting on your manager.</strong><p style="color: var(--text-secondary); margin-top: 4px;">You'll get a notification once they've decided.</p></div>` : ''}
        ${r.status === 'rejected' && r.manager_feedback ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--danger);"><label style="${label}">Manager Asked For Changes</label><p style="margin-top: 4px;">${escapeHtml(r.manager_feedback)}</p></div>` : ''}
        ${r.status === 'open' ? `<div style="margin-bottom: 24px; padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius); border-left: 4px solid var(--accent);"><strong>Approved and open to vendors.</strong><p style="color: var(--text-secondary); margin-top: 4px;">Procurement handles it from here.</p></div>` : ''}
        ${editable ? `
            <div style="border-top: 1px solid var(--border); padding-top: 20px; margin-top: 24px;">
                <label style="${label} margin-bottom: 12px; display: block;">Actions</label>
                <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                    <button class="btn btn-sm btn-secondary" onclick="openEditRequestModal('${r.id}')"><i class="fas fa-edit"></i> Edit</button>
                    ${r.status === 'rejected' && !r.manager_declined ? `<button class="btn btn-sm btn-success" onclick="closeModal('viewTenderModal'); resubmitMyRequest('${r.id}')"><i class="fas fa-paper-plane"></i> Resubmit for Approval</button>` : ''}
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
    resetCreateTenderModal();
    document.getElementById('editTenderId').value = r.id;
    document.getElementById('tenderName').value = r.name;
    fillTenderCategories(r.category);
    setItemRows(r.items);
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

// Purchasing's first stop. A vendor's bid arrives as a *submission* - an
// envelope with a company, a contact, the documents the tender demanded, and
// one or more priced offers inside it.
//
// It used to be one tender at a time, chosen from a dropdown at the top. That
// shape came from the days when this screen validated bids: you worked one
// tender, said yes or no to each envelope, and moved on. Validation is gone,
// so what is left is a reference screen, and a reference screen answering
// "what has come in?" should not open on nothing and make you name a tender
// before it will tell you anything.
//
// So: every tender that has bids, in one table. Press one and its bids open in
// a dialog - big enough to read a whole quotation in, and scrolled rather than
// paged, because comparing four companies means looking up and down the list.
// Press a bid and you land on the offers desk with that tender already
// selected, which is where the actual decision gets made. This screen is the
// way in, not a stop.
let submissionsTenderId = null;
let submissionBriefs = {};

async function renderSubmissionsPage(container) {
    const tenders = (await apiAll('/tenders')).filter(t => (t.submission_count || 0) > 0);
    AppState.tenders = tenders;

    if (tenders.length === 0) {
        container.innerHTML = `
            <div class="card"><div class="card-body"><div class="empty-state">
                <i class="fas fa-inbox"></i><h3>Nothing has come in yet</h3>
                <p>Bids appear here as vendors file them. Every offer inside one reaches the
                   offers desk the moment it arrives.</p>
            </div></div></div>`;
        return;
    }

    const totalBids = tenders.reduce((n, t) => n + (t.submission_count || 0), 0);

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">Bids received</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">
                        ${totalBids} bid(s) across ${tenders.length} tender(s) &middot;
                        press a tender to read what came in
                    </span>
                </div>
            </div>
            <div class="card-body" style="padding: 0;">
                <div class="table-container">
                    <table class="offers-table">
                        <thead><tr>
                            <th>Tender</th>
                            <th>Department</th>
                            <th>Category</th>
                            <th>Bids</th>
                            <th>Closes</th>
                            <th>Status</th>
                            <th></th>
                        </tr></thead>
                        <tbody>${tenders.map(t => `
                            <tr class="offer-row ${t.urgent ? 'is-urgent' : ''}"
                                onclick="openTenderSubmissions('${t.id}')">
                                <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(t.serial)}</code>
                                    <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.name)}</div></td>
                                <td><span class="badge badge-warning">${escapeHtml(deptName(t.department_id))}</span></td>
                                <td><span class="badge badge-info">${escapeHtml(t.category_name || t.category || '')}</span></td>
                                <td><span class="substitute-count">${t.submission_count || 0}</span></td>
                                <td style="white-space: nowrap;">${formatDeadline(t)}</td>
                                <td><span class="badge ${TENDER_STATUS_BADGE[t.status] || 'badge-secondary'}">${tenderStatusLabel(t.status)}</span></td>
                                <td class="offer-actions">
                                    ${t.urgent ? '<span class="badge badge-danger">Urgent</span>' : ''}
                                    <button class="btn btn-secondary btn-sm"
                                            onclick="event.stopPropagation(); openTenderSubmissions('${t.id}')">Bids</button>
                                    <button class="btn btn-accent btn-sm"
                                            onclick="event.stopPropagation(); openOffersFor('${t.id}')">Offers</button>
                                </td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;

    // Arrived from a dashboard row about one tender, rather than from the
    // sidebar: open that tender's bids rather than making them find it again
    // in a list they were just pointed away from.
    if (submissionsTenderId && tenders.some(t => t.id === submissionsTenderId)) {
        const id = submissionsTenderId;
        submissionsTenderId = null;
        openTenderSubmissions(id);
    }
}

// One tender's bids, in a dialog. Deliberately not a page: this is a thing you
// look at and then act on somewhere else, and putting it behind a navigation
// step would mean losing the list you were reading down.
async function openTenderSubmissions(tenderId) {
    const tender = (AppState.tenders || []).find(t => t.id === tenderId)
        || await apiFetch(`/tenders/${tenderId}`).catch(() => null);
    if (!tender) { showToast('error', 'Error', 'That tender could not be opened'); return; }

    document.getElementById('tenderSubmissionsTitle').textContent =
        `${tender.serial} — ${tender.name}`;
    document.getElementById('tenderSubmissionsContent').innerHTML =
        `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Reading the bids&hellip;</p></div>`;
    openModal('tenderSubmissionsModal');

    let subs;
    try {
        subs = await apiAll('/submissions', { tender_id: tenderId });
    } catch (err) { showToast('error', 'Error', err.message); return; }
    AppState.submissions = subs;

    // The offers inside each bid, one request per bid. Fine for the handful a
    // tender attracts, and the reason this is per-tender rather than a single
    // company-wide fetch that would make one request per bid in the company.
    const briefs = await Promise.all(subs.map(sub =>
        apiFetch(`/submissions/${sub.id}/offers`).catch(() => [])
    ));
    submissionBriefs = {};
    subs.forEach((sub, i) => { submissionBriefs[sub.id] = briefs[i]; });

    const docs = (tender.required_docs || []).filter(d => d && d.trim());

    document.getElementById('tenderSubmissionsContent').innerHTML = `
        <p class="pick-hint" style="margin-bottom: 14px;">
            ${subs.length} bid(s) &middot; ${escapeHtml(tender.currency || '')} &middot;
            closes ${escapeHtml(formatDeadline(tender))}
            ${docs.length ? ` &middot; ${docs.length} document(s) required` : ''}
        </p>
        <div class="table-container">
            <table class="offers-table">
                <thead><tr>
                    <th>Company</th>
                    <th>Contact</th>
                    <th>Offers</th>
                    <th title="Lines offering something other than what was asked for">Substitutes</th>
                    <th title="Requirements their cheapest offer never priced">Missing</th>
                    ${docs.length ? '<th title="Documents the tender demanded">Docs</th>' : ''}
                    <th title="The cheapest of this vendor's offers">Lowest bid</th>
                    <th>Submitted</th>
                    <th></th>
                </tr></thead>
                <tbody>${renderSubmissionsRows(subs, tender, docs)}</tbody>
            </table>
        </div>
        <p class="pick-hint" style="margin-top: 14px;">
            Reference only &mdash; nothing here gates anything. Press a bid to compare its
            offers against everybody else's on the offers desk, or <i class="fas fa-eye"></i>
            to read the quotation exactly as it was filed.
        </p>
    `;
}

// A bid is pressed to get to the offers desk, not to open a detail sheet.
// Comparing is the job this screen exists to start, and it happens over there
// against every other vendor's lines - reading one company's quotation in
// isolation is the rarer thing, so it keeps a button rather than the row.
function openOffersForSubmission(tenderId) {
    closeModal('tenderSubmissionsModal');
    openOffersFor(tenderId);
}

function renderSubmissionsRows(submissions, tender, docs) {
    const span = 8 + (docs.length ? 1 : 0);
    if (submissions.length === 0) {
        return `<tr><td colspan="${span}" style="text-align: center; padding: 40px; color: var(--text-muted);">
            Nothing filed against this tender yet.</td></tr>`;
    }
    return submissions.map(sub => {
        const offers = submissionBriefs[sub.id] || [];
        const swapped = offers.reduce((n, o) => n + o.replacement_items, 0);

        // The cheapest of this vendor's offers, and the two counts read off
        // that same offer.
        //
        // The column used to show `submissions.total_amount`, the envelope
        // figure the vendor typed on the form. Since a bid can hold several
        // offers, that number answers no useful question - what purchasing
        // wants down this column is "what would this supplier cost us", and
        // the honest answer is their best one. Substitutes and missing follow
        // it so the row describes one coherent proposal rather than a mixture
        // of all of them.
        const best = offers.length
            ? offers.reduce((a, b) => (b.total_amount < a.total_amount ? b : a))
            : null;
        const lowest = best ? best.total_amount : sub.total_amount;
        const missing = best ? best.missing_items : null;

        // Which of the tender's demanded documents actually arrived. A bid
        // filed before the tender asked for any shows every slot empty, which
        // is the truth: nobody asked them for it.
        const filed = sub.documents || {};
        const absent = docs.filter(d => !filed[d]);

        return `
            <tr class="offer-row ${sub.status === 'rejected' ? 'is-rejected' : ''}"
                onclick="openOffersForSubmission('${sub.tender_id}')">
                <td><strong>${escapeHtml(sub.company_name)}</strong></td>
                <td>${escapeHtml(sub.contact_name)}
                    <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(sub.email)}</div></td>
                <td>${offers.length || '<span style="color: var(--text-muted);">&mdash;</span>'}</td>
                <td>${swapped ? `<span class="substitute-count">${swapped}</span>`
                              : '<span style="color: var(--text-muted);">&mdash;</span>'}</td>
                <td>${missing ? `<span class="missing-count">${missing}</span>`
                              : '<span style="color: var(--text-muted);">&mdash;</span>'}</td>
                ${docs.length ? `<td>${absent.length
                    ? `<span class="missing-count" title="Missing: ${escapeAttr(absent.join(', '))}">${docs.length - absent.length} of ${docs.length}</span>`
                    : '<span class="badge badge-success">all in</span>'}</td>` : ''}
                <td style="font-weight: 700; color: var(--accent-light); white-space: nowrap;">
                    ${tender.currency || ''} ${Number(lowest).toLocaleString()}
                    ${offers.length > 1
                        ? '<div class="pick-sub">cheapest of ' + offers.length + '</div>'
                        : ''}</td>
                <td style="white-space: nowrap;">${formatDateTime(sub.submitted_at)}</td>
                <td class="offer-actions">
                    <button class="action-btn" title="Read the quotation as it was filed"
                            onclick="event.stopPropagation(); viewSubmission('${sub.id}')"><i class="fas fa-eye"></i></button>
                </td>
            </tr>
        `;
    }).join('');
}

// Opens the bid: every offer inside it, priced line by line.
//
// It used to be a four-column summary, because this screen was where a bid got
// validated and the question was only "is this genuine". Validation is gone,
// so what is left is the reference screen - "what exactly did this company
// send us" - and that wants the whole thing, not a precis of it.
async function viewSubmission(subId) {
    let sub, offers;
    try {
        [sub, offers] = await Promise.all([
            apiFetch(`/submissions/${subId}`),
            apiFetch(`/submissions/${subId}/offers`).catch(() => [])
        ]);
    } catch (err) { showToast('error', 'Error', err.message); return; }

    const tender = AppState.tenders.find(t => t.id === sub.tender_id)
        || await apiFetch(`/tenders/${sub.tender_id}`).catch(() => null);
    const currency = tender?.currency || sub.currency || '';

    const cheapest = offers.length
        ? Math.min(...offers.map(o => o.total_amount)) : null;

    const offersHtml = offers.length === 0
        ? `<p style="color: var(--text-muted);">No offers were filed inside this bid.</p>`
        : offers.map(o => `
            <div class="sub-offer">
                <div class="sub-offer-head">
                    <div>
                        <strong>${escapeHtml(o.label)}</strong>
                        ${o.total_amount === cheapest && offers.length > 1
                            ? '<span class="badge badge-success">cheapest</span>' : ''}
                        ${o.title ? `<div class="pick-sub">${escapeHtml(o.title)}</div>` : ''}
                    </div>
                    <div style="text-align: right;">
                        <div style="font-weight: 700; color: var(--accent-light);">
                            ${escapeHtml(o.currency)} ${Number(o.total_amount).toLocaleString()}</div>
                        <div class="pick-sub">
                            ${o.covers_items} priced
                            ${o.replacement_items ? ` &middot; <span class="substitute-count">${o.replacement_items}</span> substituted` : ''}
                            ${o.missing_items ? ` &middot; <span class="missing-count">${o.missing_items}</span> missing` : ''}
                        </div>
                    </div>
                </div>
                <div class="table-container"><table class="offer-items">
                    <thead><tr><th>#</th><th>Item</th><th>Specs</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead>
                    <tbody>
                        ${o.items.map((line, idx) => `
                            <tr class="${line.is_replacement ? 'row-substitute'
                                        : (!line.tender_item_id ? 'row-added' : '')}">
                                <td>${idx + 1}</td>
                                <td><strong>${escapeHtml(line.name)}</strong></td>
                                <td style="font-size: 13px; color: var(--text-muted);">${escapeHtml(line.specs || '-')}</td>
                                <td style="white-space: nowrap;">${Number(line.quantity).toLocaleString()} ${escapeHtml(line.unit || '')}</td>
                                <td style="white-space: nowrap;">${escapeHtml(o.currency)} ${Number(line.unit_price).toLocaleString()}</td>
                                <td style="font-weight: 700; white-space: nowrap;">${escapeHtml(o.currency)} ${Number(line.line_total).toLocaleString()}</td>
                            </tr>`).join('')}
                        ${(o.missing || []).map(name => `
                            <tr class="row-missing" title="Not priced in this offer">
                                <td>&mdash;</td>
                                <td><strong>${escapeHtml(name)}</strong></td>
                                <td colspan="3" style="font-style: italic;">not quoted</td>
                                <td>&mdash;</td>
                            </tr>`).join('')}
                    </tbody>
                </table></div>
            </div>`).join('')
          + `<div class="sub-offer-key">
                ${offers.some(o => o.replacement_items) ? '<p class="substitute-key"><span class="swatch"></span> Substitute &mdash; not the item that was asked for</p>' : ''}
                ${offers.some(o => o.items.some(l => !l.tender_item_id)) ? '<p class="substitute-key"><span class="swatch added"></span> Added &mdash; not on the tender list</p>' : ''}
                ${offers.some(o => o.missing_items) ? '<p class="substitute-key"><span class="swatch missing"></span> Missing &mdash; asked for, not priced</p>' : ''}
             </div>`;

    document.getElementById('submissionDetailContent').innerHTML = `
        <h3 style="margin-bottom: 16px;">${escapeHtml(sub.company_name)}</h3>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px;">
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Contact Person</label><p>${escapeHtml(sub.contact_name)}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Email</label><p>${escapeHtml(sub.email)}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Phone</label><p>${escapeHtml(sub.phone)}</p></div>
            <div><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Lowest Offer</label><p style="font-weight: 700; color: var(--accent-light);">${currency} ${Number(cheapest != null ? cheapest : sub.total_amount).toLocaleString()}</p></div>
        </div>
        <div style="margin-bottom: 24px;">
            <label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Tender</label>
            <p>${escapeHtml(tender?.serial || '')} - ${escapeHtml(tender?.name || '')}</p>
        </div>

        <div style="margin-bottom: 24px;">
            <label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">
                ${offers.length} offer(s) in this bid</label>
            <div style="margin-top: 10px;">${offersHtml}</div>
        </div>

        ${(tender?.required_docs || []).length ? `
            <div style="margin-bottom: 24px;">
                <label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Required documents</label>
                <div style="margin-top: 8px;">${(tender.required_docs || []).map(doc => {
                    const path = (sub.documents || {})[doc];
                    return path
                        ? `<span class="chip" style="cursor: pointer;" onclick="downloadSubmissionFile('${escapeAttr(path)}')"><i class="fas fa-file-arrow-down"></i> ${escapeHtml(doc)}</span>`
                        : `<span class="chip chip-missing" title="Not attached"><i class="fas fa-circle-exclamation"></i> ${escapeHtml(doc)}</span>`;
                }).join('')}</div>
            </div>` : ''}
        ${sub.notes ? `<div style="margin-bottom: 24px;"><label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Notes</label><p>${escapeHtml(sub.notes)}</p></div>` : ''}
        ${sub.files && sub.files.length > 0 ? `
            <div>
                <label style="font-size: 12px; color: var(--text-muted); text-transform: uppercase;">Other attachments</label>
                <div style="margin-top: 8px;">${sub.files.map(f => `<span class="chip" style="cursor: pointer;" onclick="downloadSubmissionFile('${escapeAttr(f)}')"><i class="fas fa-file-arrow-down"></i> ${escapeHtml(fileDisplayName(f))}</span>`).join('')}</div>
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
// DEPARTMENT MANAGER - TENDER APPROVAL
// ============================================
// The manager decides on the tender itself here, not on the offers. A new
// tender sits at `pending_approval` and is invisible to vendors until they
// approve it; sending it back returns it to Procurement to revise and resubmit.
async function renderManagerReviewPage(container) {
    pagerReloaders.review = () => renderManagerReviewPage(container);
    const tenders = await apiAll('/tenders', { status: 'pending_approval' });
    AppState.tenders = tenders;
    const rows = pageLocally('review', tenders);

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">Awaiting Your Approval</h3>
                <span class="badge ${tenders.length > 0 ? 'badge-warning' : 'badge-secondary'}">${tenders.length} pending</span>
            </div>
            ${tenders.length === 0 ? `
                <div class="card-body"><div class="empty-state">
                    <i class="fas fa-clipboard-check"></i>
                    <h3>Nothing Waiting on You</h3>
                    <p>Requests raised by your department will appear here.</p>
                </div></div>
            ` : `
                <div class="card-body" style="padding: 0;">
                    <div class="table-container">
                        <table>
                            <thead><tr>
                                <th>Serial</th><th>Request</th><th>Department</th>
                                <th>Items</th><th>Raised</th><th></th>
                            </tr></thead>
                            <tbody>
                                ${rows.map(t => `
                                    <tr class="row-clickable" onclick="openTenderReview('${t.id}')">
                                        <td><code class="serial">${escapeHtml(t.serial)}</code></td>
                                        <td><strong>${escapeHtml(t.name)}</strong></td>
                                        <td>${escapeHtml(deptName(t.department_id))}</td>
                                        <td>${(t.items || []).length}</td>
                                        <td>${formatDate(t.created_at)}</td>
                                        <td class="col-act"><i class="fas fa-chevron-right" style="color: var(--text-muted);"></i></td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                ${renderPager('review', tenders.length)}
            `}
        </div>
    `;
}

// Which "view" a tender opens into depends on who is looking. A manager gets
// the review screen, so the eye on the dashboard lands them somewhere they can
// actually decide instead of on a read-only card with no way forward.
// Everyone else gets the procurement detail, which carries the vendor link and
// the management actions they need and a manager does not.
function openTenderFor(tenderId) {
    if (['manager', 'admin'].includes(AppState.currentUser?.role)) {
        return openTenderReview(tenderId);
    }
    return viewTender(tenderId);
}

// ------------------------------------------------------------ review a request

// The requirement, read-only. The same table the requester filled in and the
// same one the vendor will price - shown rather than summarised, because "4
// items" tells an approver nothing they can approve on.
function requirementTable(items) {
    if (!items || !items.length) {
        return '<p style="color: var(--text-muted);">No items on this request.</p>';
    }
    return `
        <div class="items-table-wrap">
            <table class="items-table items-table-read">
                <thead><tr>
                    <th class="col-num">#</th><th>Item</th><th>Specifications</th>
                    <th class="col-qty">QTY</th><th class="col-unit">Unit</th><th>Notes</th>
                </tr></thead>
                <tbody>
                    ${items.map((it, i) => `
                        <tr>
                            <td class="col-num">${i + 1}</td>
                            <td><strong>${escapeHtml(it.name)}</strong></td>
                            <td>${escapeHtml(it.specs) || '<span style="color: var(--text-muted);">—</span>'}</td>
                            <td class="col-qty">${it.quantity}</td>
                            <td class="col-unit">${escapeHtml(it.unit)}</td>
                            <td>${escapeHtml(it.notes) || '<span style="color: var(--text-muted);">—</span>'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// One screen for the whole decision: what was asked for, who asked, and the
// three answers. Reached from the pending list and from the eye on the
// dashboard, so the manager never has to approve something they've only seen
// the title of.
async function openTenderReview(tenderId) {
    let tender;
    try {
        tender = await apiFetch(`/tenders/${tenderId}`);
    } catch (err) {
        showToast('error', 'Error', err.message);
        return;
    }
    const pending = tender.status === 'pending_approval';
    const canDecide = pending && ['admin', 'manager'].includes(AppState.currentUser?.role);
    const label = 'font-size: 11px; text-transform: uppercase; color: var(--text-muted);';

    document.getElementById('viewTenderContent').innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: start; gap: 16px; margin-bottom: 20px;">
            <div>
                <code class="serial" style="color: var(--accent);">${escapeHtml(tender.serial)}</code>
                <h3 style="font-size: 20px; margin-top: 4px;">${escapeHtml(tender.name)}</h3>
            </div>
            <span class="badge ${pending ? 'badge-warning' : 'badge-secondary'}">
                ${pending ? 'Awaiting approval' : escapeHtml(tenderStatusLabel(tender.status))}
            </span>
        </div>

        <div class="review-facts">
            <div><label style="${label}">Department</label><p>${escapeHtml(deptName(tender.department_id))}</p></div>
            <div><label style="${label}">Category</label><p>${escapeHtml(tender.category_name || tender.category || '')}</p></div>
            <div><label style="${label}">Raised</label><p>${formatDate(tender.created_at)}</p></div>
            <div><label style="${label}">Deadline</label><p>${formatDeadline(tender)}</p></div>
        </div>

        ${tender.description ? `<p style="color: var(--text-secondary); margin: 16px 0;">${escapeHtml(tender.description)}</p>` : ''}

        <label style="${label} display: block; margin: 20px 0 8px;">What they need</label>
        ${requirementTable(tender.items)}

        ${tender.manager_feedback ? `
            <div class="callout callout-danger" style="margin-top: 20px;">
                <label style="${label}">${tender.manager_declined ? 'Declined' : 'Sent back'}</label>
                <p style="margin-top: 4px;">${escapeHtml(tender.manager_feedback)}</p>
            </div>` : ''}

        ${canDecide ? `
            <div class="review-actions">
                <!-- Editing here rather than only sending it back. A wrong
                     quantity or a missing line took a rejection note, a wait,
                     and a resubmission for a change the manager could have
                     typed in less time than the note took to write. They
                     already hold the decision. -->
                <button class="btn btn-secondary" onclick="closeModal('viewTenderModal'); openEditTenderModal('${tender.id}')">
                    <i class="fas fa-edit"></i> Edit it yourself
                </button>
                <button class="btn btn-danger" onclick="declineTenderAsManager('${tender.id}')">
                    <i class="fas fa-ban"></i> Reject
                </button>
                <button class="btn btn-warning" onclick="rejectTenderAsManager('${tender.id}')">
                    <i class="fas fa-rotate-left"></i> Send back for edit
                </button>
                <button class="btn btn-success" onclick="approveTenderAsManager('${tender.id}')">
                    <i class="fas fa-check"></i> Approve
                </button>
            </div>
            <p class="form-hint" style="text-align: right;">
                Approving asks you for the closing date. Rejecting is final — sending
                it back lets them fix it and resubmit.
            </p>
        ` : ''}
    `;
    openModal('viewTenderModal');
}

// Approving and dating the tender are one action. The requester says what they
// need; the manager says by when. Asking for the deadline here rather than on
// the request form is the whole point - it is the manager's commitment to
// vendors, not the requester's wish.
function approveTenderAsManager(tenderId) {
    const suggested = new Date();
    suggested.setDate(suggested.getDate() + 14);
    const iso = suggested.toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];

    showFormDialog(
        'Approve & Set Deadline',
        `
        <p style="color: var(--text-secondary); margin-bottom: 16px;">
            This opens the tender to vendors. Set the date their quotations have to be in by.
        </p>
        <div class="form-row">
            <div class="form-group">
                <label>Closing Date *</label>
                <input type="date" class="form-control" id="approveDeadlineDate" min="${today}" value="${iso}">
            </div>
            <div class="form-group">
                <label>Closing Time *</label>
                <input type="time" class="form-control" id="approveDeadlineTime" value="17:00">
            </div>
        </div>
        <label class="checkbox-line">
            <input type="checkbox" id="approveUrgent">
            <span>Mark urgent &mdash; skips the purchasing-manager and supply-chain gates, who are notified instead</span>
        </label>
        `,
        'Approve & Open',
        async () => {
            const deadline_date = document.getElementById('approveDeadlineDate').value;
            const deadline_time = document.getElementById('approveDeadlineTime').value;
            const urgent = document.getElementById('approveUrgent').checked;
            if (!deadline_date || !deadline_time) {
                showToast('error', 'Validation Error', 'Set a closing date and time');
                return false;
            }
            try {
                const tender = await apiFetch(`/tenders/${tenderId}/manager-approve`, {
                    method: 'POST',
                    body: JSON.stringify({ deadline_date, deadline_time, urgent }),
                });
                closeModal('viewTenderModal');
                showToast('success', 'Approved', `${tender.serial} closes ${formatDeadline(tender)}`);
                navigateTo('review');
            } catch (err) {
                showToast('error', 'Error', err.message);
                // Keep the dialog up so the dates they typed aren't lost.
                return false;
            }
        }
    );
}

// Both answers hit the same endpoint and both leave the tender `rejected`.
// `final` is the whole difference: sent back, the requester edits and
// resubmits; declined, resubmit is refused and a new request is the only way
// back. Two buttons because they are two different answers, not two wordings.
function sendTenderBack(tenderId, { final }) {
    openReasonModal({
        title: final ? 'Reject Request' : 'Send Back for Edit',
        description: final
            ? "This is final. The requester can't resubmit it — they would have to raise a new request."
            : 'The requester sees this and can fix the request and send it back to you.',
        label: 'Reason *',
        submitLabel: final ? 'Reject' : 'Send Back',
        onSubmit: async (reason) => {
            try {
                await apiFetch(`/tenders/${tenderId}/manager-reject`, {
                    method: 'POST',
                    body: JSON.stringify({ reason, final }),
                });
                closeModal('viewTenderModal');
                showToast('info', final ? 'Rejected' : 'Sent Back',
                    final ? 'The requester has been told' : 'They can edit it and send it back');
                navigateTo('review');
            } catch (err) { showToast('error', 'Error', err.message); }
        }
    });
}

function rejectTenderAsManager(tenderId) { sendTenderBack(tenderId, { final: false }); }
function declineTenderAsManager(tenderId) { sendTenderBack(tenderId, { final: true }); }

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
// OFFERS DESK - shortlist, then the approval chain
// ============================================
// One page serving four desks. Which buttons appear is decided by the offer's
// own status and the viewer's role, so nobody is shown an action the API would
// refuse.
//
// The department manager's view is anonymised by the API, not here: /offers
// never carries a company name, contact or file list, so there is nothing on
// this page to accidentally render.

const OFFER_STATUS_META = {
    pending:               { label: 'With purchasing',      badge: 'badge-secondary' },
    forwarded:             { label: 'With the manager',     badge: 'badge-info' },
    selected:              { label: 'Shortlisted',          badge: 'badge-warning' },
    purchasing_ok:         { label: 'Purchasing approved',  badge: 'badge-warning' },
    purchasing_manager_ok: { label: 'Purchasing mgr OK',    badge: 'badge-warning' },
    approved:              { label: 'Approved',             badge: 'badge-success' },
    rejected:              { label: 'Rejected',             badge: 'badge-danger' }
};

const MAX_SHORTLIST = 3;

// Unsaved rank choices, keyed by tender id then offer id. Held outside the DOM
// so a re-render (after rejecting one offer, say) doesn't silently drop a
// half-made shortlist.
const shortlistDraft = {};

function currentDepartment() {
    const user = AppState.currentUser;
    if (!user || !user.department_id) return null;
    return (AppState.departments || []).find(d => d.id === user.department_id) || null;
}

// The purchasing manager is a manager whose department is Purchasing - there
// is no role for it. Matched on the department's code, never its display name,
// so renaming the department doesn't quietly move the approval step.
function isPurchasingManager(user) {
    const dept = currentDepartment();
    return user && user.role === 'manager' && dept && dept.code === 'purchasing';
}

// Which single offer status this user is the approver for, or null if their
// job here is shortlisting rather than approving.
function deskFor(user) {
    if (!user) return null;
    if (user.role === 'procurement') return { status: 'selected', path: 'purchasing-approve', verb: 'Approve & send on' };
    if (isPurchasingManager(user)) return { status: 'purchasing_ok', path: 'purchasing-manager-approve', verb: 'Approve & send on' };
    if (user.role === 'supply_chain') return { status: 'purchasing_manager_ok', path: 'supply-chain-approve', verb: 'Final approval' };
    return null;
}

function canShortlist(user) {
    return user && (user.role === 'manager' && !isPurchasingManager(user));
}

// Purchasing's first pass. A bid now lands with them before it reaches the
// department manager: they weed out the ones that miss the specification, the
// duplicates and the corrections, and send on what is actually comparable.
// Deliberately a different question from `deskFor` - purchasing has two jobs on
// this screen, filtering first and committing to one of the shortlist later.
function canForward(user) {
    return !!user && (user.role === 'procurement' || user.role === 'admin');
}

// How an offer departs from the tender's own list. Three kinds, and they are
// genuinely different questions:
//
//   substituted - priced against a tender line, but offering something else
//   added       - priced, but answering no tender line at all: a bundle, a
//                 cable thrown in, a gift. Not a fault; often the reason one
//                 offer beats another
//   missing     - a tender line nobody priced. The dangerous one, because it
//                 is invisible: it isn't a row in the offer, so a reader
//                 comparing two tables sees nothing at all where the gap is
//
// Derived here rather than on the server: the tender's item list is already on
// the page, and computing it in one place beats a second set of counters the
// API would have to keep in step with the first.
function offerGaps(offer, tender) {
    const items = offer.items || [];
    const wanted = (tender && tender.items) || [];
    const priced = new Set(items.filter(i => i.tender_item_id).map(i => i.tender_item_id));
    return {
        added: items.filter(i => !i.tender_item_id && !i.is_replacement),
        missing: wanted.filter(w => !priced.has(w.id)),
    };
}

function offerItemsTable(offer, currency, tender) {
    if (!offer.items || offer.items.length === 0) {
        return `<p style="color: var(--text-muted); font-size: 13px; padding: 8px 0;">No line items - this bid was filed as a single total.</p>`;
    }
    const gaps = offerGaps(offer, tender);

    // The basket shortcut, on purchasing's screen only and only while there is
    // still something to decide. Once the tender is awarded the basket is
    // history, and an "add" button on it would offer to change a purchase that
    // has already been made.
    const canBasket = ['admin', 'procurement'].includes(AppState.currentUser?.role)
        && tender && tender.status !== 'awarded';

    // A substitute row is coloured, not labelled. The badge that used to sit
    // beside the name added a word to every row that had one and made the
    // table harder to scan than the thing it was flagging; colour says the
    // same thing without taking a column's worth of attention.
    return `
        <div class="table-container">
            <table class="offer-items">
                <thead><tr><th>#</th><th>Item</th><th>Specs</th><th>Notes</th><th>Qty</th><th>Unit price</th><th>Line total</th>${canBasket ? '<th title="Put this line in the basket">Basket</th>' : ''}</tr></thead>
                <tbody>
                    ${offer.items.map((item, idx) => `
                        <tr class="${item.is_replacement ? 'row-substitute'
                                    : (!item.tender_item_id ? 'row-added' : '')}"
                            ${item.is_replacement ? 'title="Substitute - not the item that was asked for"'
                              : (!item.tender_item_id ? 'title="Added - not on the tender list"' : '')}>
                            <td>${idx + 1}</td>
                            <td><strong>${escapeHtml(item.name)}</strong></td>
                            <td style="font-size: 13px; color: var(--text-muted);">${escapeHtml(item.specs || '-')}</td>
                            <td style="font-size: 13px; color: var(--text-muted);">${escapeHtml(item.notes || '-')}</td>
                            <td>${Number(item.quantity).toLocaleString()} ${escapeHtml(item.unit || '')}</td>
                            <td>${currency} ${Number(item.unit_price).toLocaleString()}</td>
                            <td style="font-weight: 700;">${currency} ${Number(item.line_total).toLocaleString()}</td>
                            ${canBasket ? `<td class="basket-add-cell">
                                ${item.tender_item_id ? `
                                    <button class="action-btn" title="Add this line to the basket"
                                            onclick="event.stopPropagation(); addLineToBasket('${tender.id}', '${item.tender_item_id}', '${item.id}')">
                                        <i class="fas fa-basket-shopping"></i></button>
                                ` : '<span style="color: var(--text-muted);" title="Not a tender line, so there is no requirement to put it against">&mdash;</span>'}
                            </td>` : ''}
                        </tr>
                    `).join('')}
                    ${gaps.missing.map(w => `
                        <tr class="row-missing" title="Not priced in this offer">
                            <td>&mdash;</td>
                            <td><strong>${escapeHtml(w.name)}</strong></td>
                            <td style="font-size: 13px; color: var(--text-muted);">${escapeHtml(w.specs || '-')}</td>
                            <td colspan="3" style="font-style: italic;">not quoted</td>
                            <td>&mdash;</td>
                            ${canBasket ? '<td>&mdash;</td>' : ''}
                        </tr>
                    `).join('')}
                </tbody>
                <tfoot>
                    <tr><td colspan="${canBasket ? 7 : 6}" style="text-align: right; font-weight: 700;">Offer total</td>
                        <td style="font-weight: 700; color: var(--accent-light);">${currency} ${Number(offer.total_amount).toLocaleString()}</td></tr>
                </tfoot>
            </table>
        </div>
        ${offer.items.some(i => i.is_replacement) ? `
            <p class="substitute-key"><span class="swatch"></span> Substitute — not the item that was asked for</p>
        ` : ''}
        ${gaps.added.length ? `
            <p class="substitute-key"><span class="swatch added"></span> Added — thrown in, not on the tender's list</p>
        ` : ''}
        ${gaps.missing.length ? `
            <p class="substitute-key"><span class="swatch missing"></span> Missing — asked for, not priced in this offer</p>
        ` : ''}
    `;
}

// One offer, one row. It used to be a card each - a heading, a price block, a
// badge and the whole item table stacked per offer - which meant comparing
// three bids was a scrolling exercise. The lines live behind a click now.
function offerRow(tender, offer, opts) {
    const meta = OFFER_STATUS_META[offer.status] || { label: offer.status, badge: '' };
    const draft = (shortlistDraft[tender.id] || {})[offer.id] || '';
    const rankOptions = ['', '1', '2', '3'].map(v =>
        `<option value="${v}" ${String(draft) === v ? 'selected' : ''}>${v === '' ? '-' : '#' + v}</option>`
    ).join('');
    const gaps = offerGaps(offer, tender);

    return `
        <tr class="offer-row ${offer.manager_rank ? 'is-shortlisted' : ''} ${offer.status === 'rejected' ? 'is-rejected' : ''}"
            onclick="toggleOfferLines(event, '${offer.id}')">
            <td class="col-act"><i class="fas fa-chevron-right offer-caret" id="caret-${offer.id}"></i></td>
            <td>
                <strong>${escapeHtml(offer.label)}</strong>
                ${offer.manager_rank ? `<span class="badge badge-warning" style="margin-left: 6px;">#${offer.manager_rank}</span>` : ''}
                ${offer.title ? `<div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(offer.title)}</div>` : ''}
            </td>
            <td>${offer.covers_items} of ${tender.items ? tender.items.length : '?'}</td>
            <td>${offer.replacement_items ? `<span class="substitute-count">${offer.replacement_items}</span>` : '<span style="color: var(--text-muted);">—</span>'}</td>
            <td>${gaps.missing.length ? `<span class="missing-count">${gaps.missing.length}</span>` : '<span style="color: var(--text-muted);">—</span>'}</td>
            <td>${gaps.added.length ? `<span class="added-count">${gaps.added.length}</span>` : '<span style="color: var(--text-muted);">—</span>'}</td>
            <td style="font-weight: 700; color: var(--accent-light); white-space: nowrap;">
                ${tender.currency} ${Number(offer.total_amount).toLocaleString()}
            </td>
            <td><span class="badge ${meta.badge}">${meta.label}</span></td>
            <td class="offer-actions" onclick="event.stopPropagation()">
                ${opts.forwarding && offer.status !== 'rejected' ? `
                    <label class="forward-tick"
                           title="${offer.forwarded_at
                                    ? 'The manager can see this one'
                                    : 'Tick to send this offer to the department manager'}">
                        <input type="checkbox" data-forward data-tender="${tender.id}"
                               data-offer="${offer.id}" ${offer.forwarded_at ? 'checked' : ''}
                               ${opts.forwardLocked ? 'disabled' : ''}>
                        <span>Send up</span>
                    </label>
                ` : ''}
                ${opts.shortlisting && offer.status !== 'rejected' ? `
                    <select class="form-control form-control-sm" data-tender="${tender.id}" data-offer="${offer.id}"
                            title="Preference" onchange="onRankChange(this)">${rankOptions}</select>
                ` : ''}
                ${opts.approvable ? `
                    <button class="btn btn-success btn-sm"
                            title="${opts.directPick
                                ? (offer.status === 'pending'
                                    ? 'Buy this one without sending the tender to the department manager'
                                    : 'Commit to this one even though the manager did not shortlist it')
                                : escapeAttr(opts.deskVerb)}"
                            onclick="${opts.directPick
                                ? `takeOfferDirectly('${tender.id}', '${offer.id}', '${offer.status}')`
                                : `approveOffer('${tender.id}', '${offer.id}', '${opts.deskPath}')`}">${escapeHtml(opts.deskVerb)}</button>
                ` : ''}
                ${opts.rejectable ? `
                    <button class="btn btn-danger btn-sm" onclick="rejectOffer('${tender.id}', '${offer.id}')">${offer.status === 'approved' ? 'Withdraw' : 'Reject'}</button>
                ` : ''}
            </td>
        </tr>
        <tr class="offer-lines hidden" id="lines-${offer.id}">
            <td colspan="9">
                ${offer.specs ? `<p style="margin-bottom: 10px; font-size: 13px;">${escapeHtml(offer.specs)}</p>` : ''}
                ${offerItemsTable(offer, tender.currency, tender)}
                ${offer.rejection_reason ? `<p style="margin-top: 10px; color: var(--danger); font-size: 13px;">Rejected at ${escapeHtml(offer.rejected_at_stage || '')}: ${escapeHtml(offer.rejection_reason)}</p>` : ''}
                ${offer.urgent_skipped ? `<p style="margin-top: 10px; color: var(--warning); font-size: 13px;">Urgent: approved without waiting for the purchasing manager or supply chain.</p>` : ''}
            </td>
        </tr>
    `;
}

function toggleOfferLines(event, offerId) {
    const lines = document.getElementById(`lines-${offerId}`);
    const caret = document.getElementById(`caret-${offerId}`);
    if (!lines) return;
    lines.classList.toggle('hidden');
    if (caret) caret.classList.toggle('open', !lines.classList.contains('hidden'));
}

function onRankChange(select) {
    const { tender, offer } = select.dataset;
    shortlistDraft[tender] = shortlistDraft[tender] || {};
    if (select.value) shortlistDraft[tender][offer] = select.value;
    else delete shortlistDraft[tender][offer];
}

async function saveShortlist(tenderId) {
    const draft = shortlistDraft[tenderId] || {};
    const entries = Object.entries(draft);
    const ranks = entries.map(([, rank]) => rank);
    if (new Set(ranks).size !== ranks.length) {
        showToast('error', 'Two offers share a rank', 'Each preference number can only be used once');
        return;
    }
    if (entries.length > MAX_SHORTLIST) {
        showToast('error', 'Too many', `Shortlist at most ${MAX_SHORTLIST} offers`);
        return;
    }
    // Order is the ranking: the API reads position in the array, not the number
    // typed here, so they are sorted before sending.
    const offer_ids = entries.sort((a, b) => Number(a[1]) - Number(b[1])).map(([id]) => id);
    // Sending an empty list used to withdraw the shortlist. It can't any more:
    // the list is sealed once sent, so an empty one would seal the tender with
    // nothing on it and need purchasing to unpick it.
    if (offer_ids.length === 0) {
        showToast('error', 'Nothing ranked', 'Give at least one offer a preference number');
        return;
    }
    try {
        await apiFetch('/offers/shortlist', { method: 'POST', body: JSON.stringify({ tender_id: tenderId, offer_ids }) });
        showToast('success', 'Shortlist sent',
            'Purchasing has been notified. This tender is off your list now and can only come '
            + 'back if they send it to you again.');
        delete shortlistDraft[tenderId];
        renderPage(AppState.currentPage);
    } catch (err) { showToast('error', 'Error', err.message); }
}

// Read straight off the checkboxes rather than out of a draft object. The
// whole set is replaced on every call, so what is ticked on screen when the
// button is pressed IS the answer - keeping a shadow copy would only give it
// something to disagree with.
async function sendForward(tenderId) {
    const boxes = [...document.querySelectorAll(`input[data-forward][data-tender="${tenderId}"]`)];
    const offer_ids = boxes.filter(b => b.checked).map(b => b.dataset.offer);
    const already = boxes.filter(b => b.defaultChecked).length;

    if (offer_ids.length === 0 && already === 0) {
        showToast('error', 'Nothing ticked', 'Tick the offers the manager should see');
        return;
    }

    const send = async () => {
        try {
            await apiFetch('/offers/forward', {
                method: 'POST',
                body: JSON.stringify({ tender_id: tenderId, offer_ids }),
            });
            showToast('success', offer_ids.length ? 'Sent to the manager' : 'Taken back',
                offer_ids.length
                    ? `${offer_ids.length} offer(s) are now on the manager's list`
                    : 'The manager has nothing to rank on this tender');
            renderPage(AppState.currentPage);
        } catch (err) { showToast('error', 'Error', err.message); }
    };

    // Un-ticking is the one direction worth a second look: the manager may
    // already be reading the list.
    if (offer_ids.length < already) {
        showConfirmDialog('Take offers back',
            `${already - offer_ids.length} offer(s) will disappear from the manager's list. `
            + "Offers they have already shortlisted can't be pulled back this way - reject "
            + 'those instead, with a reason.', send);
        return;
    }
    await send();
}

// The only way a sealed shortlist reopens. Purchasing isn't rejecting the
// offers here - they may well be ranked again - they are saying this ordering
// won't do. The reason goes to the manager, because "try again" with nothing
// attached invites the same three back.
function sendShortlistBack(tenderId) {
    openReasonModal({
        title: 'Send the shortlist back',
        description: "Every ranked offer goes back on the manager's table and they can rank "
            + 'again. None of them is rejected. Tell them what went wrong with this list, or '
            + 'they will hand you the same one.',
        label: "Why this list doesn't work *",
        submitLabel: 'Send it back',
        onSubmit: async (reason) => {
            try {
                await apiFetch('/offers/send-back', {
                    method: 'POST',
                    body: JSON.stringify({ tender_id: tenderId, reason }),
                });
                showToast('info', 'Sent back', 'The manager can rank these offers again');
                renderPage(AppState.currentPage);
            } catch (err) { showToast('error', 'Error', err.message); }
        }
    });
}

// Purchasing committing to an offer without the department manager's answer.
//
// Two shapes of the same latitude: taking one the manager saw but didn't rank,
// and taking one they were never sent. Both are allowed, and both are confirmed
// first - not because either is wrong, but because the manager's review is the
// thing being skipped and that should be a decision rather than a stray click.
// They are told afterwards either way, which is what makes the latitude safe.
function takeOfferDirectly(tenderId, offerId, status) {
    const neverAsked = status === 'pending';
    showConfirmDialog(
        neverAsked ? 'Buy this one without asking the manager?' : 'Take an offer they did not shortlist?',
        neverAsked
            ? `<p>This offer has not been sent to the department manager, and buying it now means
                  they never rank the tender at all.</p>
               <p style="margin-top: 10px; color: var(--text-muted);">Worth it when one bid is
                  plainly better on every line. They are told it happened and can see the offer
                  afterwards; it then goes up your own chain as normal.</p>`
            : `<p>The manager shortlisted other offers on this tender. Committing to this one
                  goes outside their ranking.</p>
               <p style="margin-top: 10px; color: var(--text-muted);">Allowed &mdash; their
                  shortlist is a guide, not a gate &mdash; and they are told, so the decision is
                  visible rather than silent.</p>`,
        () => approveOffer(tenderId, offerId, 'purchasing-approve')
    );
}

async function approveOffer(tenderId, offerId, path) {
    try {
        const result = await apiFetch(`/offers/${offerId}/${path}`, { method: 'POST' });
        showToast('success', 'Approved', `The offer is now ${(OFFER_STATUS_META[result.status] || {}).label || result.status}`);
        renderPage(AppState.currentPage);
    } catch (err) { showToast('error', 'Error', err.message); }
}

function rejectOffer(tenderId, offerId) {
    openReasonModal({
        title: 'Reject this offer',
        description: 'The department manager and purchasing are both told, so say enough for them to decide what happens next.',
        label: 'Reason *',
        submitLabel: 'Reject offer',
        onSubmit: async (reason) => {
            try {
                await apiFetch(`/offers/${offerId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
                showToast('info', 'Offer rejected', 'The other desks have been notified');
                renderPage(AppState.currentPage);
            } catch (err) { showToast('error', 'Error', err.message); }
        }
    });
}

// Which tender's offers are on screen. Held across re-renders so approving one
// offer doesn't bounce the reviewer back to the first tender in the list.
let offersTenderId = null;

async function renderOffersDeskPage(container) {
    const user = AppState.currentUser;
    const desk = deskFor(user);
    const shortlisting = canShortlist(user);
    const forwarding = canForward(user);
    const isAdmin = user.role === 'admin';

    const tenders = (await apiAll('/tenders')).filter(t => (t.submission_count || 0) > 0);
    AppState.tenders = tenders;

    // One request per tender with bids on it. Deliberately not batched into a
    // single endpoint: /offers is scoped and anonymised per tender, and a
    // company-wide variant would be a second thing to keep in step with it.
    const withOffers = await Promise.all(tenders.map(async tender => {
        try {
            return { tender, offers: await apiFetch(`/offers?tender_id=${tender.id}&include_rejected=true`) };
        } catch (err) {
            // A 403 here is the department scope doing its job, not an error.
            return null;
        }
    }));

    const rows = withOffers.filter(row => row && row.offers.length > 0);
    let live = rows.filter(row => row.offers.some(o => o.status !== 'rejected'));

    // Once a manager has sent their shortlist, that tender leaves their screen.
    // The list is sealed on the server too; taking it off the page as well is
    // the honest version - a table you can still re-rank on, that then refuses
    // to save, is worse than no table. It comes back if purchasing sends the
    // shortlist back to them.
    const shortlistSent = (row) => row.offers.some(o =>
        ['selected', 'purchasing_ok', 'purchasing_manager_ok', 'approved'].includes(o.status));
    const sealedAway = shortlisting && !isAdmin ? live.filter(shortlistSent).length : 0;
    if (shortlisting && !isAdmin) live = live.filter(row => !shortlistSent(row));

    const waitingOnMe = (row) => {
        if (isAdmin) return true;
        // Purchasing has two jobs here, and the filtering one comes first: an
        // untouched bid needs them before it needs anybody else.
        if (forwarding && row.offers.some(o => o.status === 'pending')) return true;
        if (desk) return row.offers.some(o => o.status === desk.status);
        if (shortlisting) return row.offers.some(o => o.status === 'forwarded' || o.status === 'selected');
        return false;
    };

    if (live.length === 0) {
        const emptyMessage = forwarding
            ? 'No bids to sort through yet. Offers land here first, and you choose which ones the department manager sees.'
            : desk
                ? 'Nothing is waiting at your desk. An offer reaches you once the step before yours has signed it off.'
                : shortlisting
                    ? (sealedAway
                        ? `Your shortlist is with purchasing on ${sealedAway} tender${sealedAway === 1 ? '' : 's'}. Once a list is sent it can't be changed — if none of your choices works out, purchasing will send it back and it reappears here.`
                        : 'Nothing has been sent to you yet. Purchasing sorts through the bids first and passes on the ones worth comparing.')
                    : 'Nothing to review here.';
        container.innerHTML = `
            <div class="card"><div class="card-body"><div class="empty-state">
                <i class="fas fa-scale-balanced"></i><h3>Nothing waiting on you</h3><p>${emptyMessage}</p>
            </div></div></div>`;
        return;
    }

    // Nothing is chosen for you when you arrive from the sidebar - see
    // navigateTo. The desk used to open on whichever tender it judged most
    // urgent, which is a good guess and still the wrong thing to do: filtering
    // bids on a tender you didn't mean to open is the one mistake this screen
    // makes expensive. Coming from a dashboard row, the tender is already set
    // and this leaves it alone.
    if (offersTenderId && !live.some(r => r.tender.id === offersTenderId)) {
        offersTenderId = null;
    }
    const current = live.find(r => r.tender.id === offersTenderId) || null;

    // The picker replaces a page of stacked cards, one per tender. Reviewing
    // is a one-tender-at-a-time job; showing all of them at once meant
    // scrolling past three tenders to reach the one you were asked about.
    const options = `<option value="" ${offersTenderId ? '' : 'selected'}>Choose a tender&hellip;</option>`
        + live.map(r => {
        const mine = waitingOnMe(r) ? ' • waiting on you' : '';
        const urgent = r.tender.urgent ? ' • URGENT' : '';
        const n = r.offers.filter(o => o.status !== 'rejected' || isAdmin).length;
        return `<option value="${r.tender.id}" ${r.tender.id === offersTenderId ? 'selected' : ''}>
            ${escapeHtml(r.tender.serial)} — ${escapeHtml(r.tender.name)} (${n} offer${n === 1 ? '' : 's'})${mine}${urgent}
        </option>`;
    }).join('');

    if (!current) {
        const waitingCount = live.filter(waitingOnMe).length;
        container.innerHTML = `
            <div class="card" style="margin-bottom: 20px;">
                <div class="card-body offers-picker">
                    <label for="offersTenderPicker">Tender</label>
                    <select class="form-control" id="offersTenderPicker" onchange="onOffersTenderChange(this.value)">
                        ${options}
                    </select>
                </div>
            </div>
            <div class="card"><div class="card-body"><div class="empty-state">
                <i class="fas fa-scale-balanced"></i><h3>Pick a tender</h3>
                <p>Offers are compared one tender at a time. Choose one above &mdash;
                   ${waitingCount
                        ? `<strong>${waitingCount}</strong> ${waitingCount === 1 ? 'is' : 'are'} waiting on you.`
                        : 'none of them is waiting on you right now.'}</p>
            </div></div></div>`;
        return;
    }

    const { tender, offers } = current;
    const visible = offers.filter(o => o.status !== 'rejected' || isAdmin);
    const approvableStatus = desk ? desk.status : null;
    const shortlistedCount = offers.filter(o => o.manager_rank).length;

    const notYetSent = offers.filter(o => o.status === 'pending').length;
    // Non-rejected only. A rejected offer keeps its forwarded_at - that is a
    // record of what happened to it - but it is not sitting with the manager,
    // and counting it told them they had four offers to rank when three of
    // them were dead.
    const sentUp = offers.filter(o => o.forwarded_at && o.status !== 'rejected').length;
    const hasShortlist = offers.some(o => o.status === 'selected');

    // Has the manager answered on this tender? Anything at `selected` or beyond
    // means they have: they ranked, and purchasing is working through the
    // result. While that is true there is nothing to send them - the forward
    // bar disappears rather than sitting there inviting a second round.
    //
    // It comes back on its own when the answer is undone: a send-back, or
    // purchasing rejecting the picked offer, drops everything to `forwarded`
    // and this goes false again. That is the "resend" case, and it needs no
    // separate flag because the state already says it.
    const managerReplied = offers.some(o =>
        ['selected', 'purchasing_ok', 'purchasing_manager_ok', 'approved'].includes(o.status));

    const rowOpts = (offer) => ({
        forwarding,
        // No `notValidated` any more. The tick box used to grey itself out and
        // read "Not validated" until somebody had ticked the bid off on the
        // Submissions page - the client half of a gate that no longer exists on
        // the server. Removing the server check on its own left this behind,
        // still refusing to send anything up and still pointing at a button
        // that had been taken away.
        // An offer the manager has already acted on can't be pulled back with a
        // tick box - that would strand their decision. The box goes grey and
        // the reject button is the way out.
        forwardLocked: !!offer.forwarded_at && offer.status !== 'forwarded',
        shortlisting: shortlisting || isAdmin,
        approvable: !!(approvableStatus && offer.status === approvableStatus)
            || (isAdmin && ['selected', 'purchasing_ok', 'purchasing_manager_ok'].includes(offer.status))
            // Purchasing may commit to an offer the manager never ranked, and
            // to one they were never even shown. Sometimes a bid is plainly
            // better on every line, and a shortlist-and-rank round trip to
            // hear "yes, that one" costs days and settles nothing. The manager
            // is told either way - see takeOfferDirectly.
            || (forwarding && ['pending', 'forwarded'].includes(offer.status)),
        directPick: forwarding && ['pending', 'forwarded'].includes(offer.status),
        deskPath: desk ? desk.path : ({
            pending: 'purchasing-approve',
            forwarded: 'purchasing-approve',
            selected: 'purchasing-approve',
            purchasing_ok: 'purchasing-manager-approve',
            purchasing_manager_ok: 'supply-chain-approve'
        })[offer.status],
        deskVerb: (forwarding && ['pending', 'forwarded'].includes(offer.status))
            ? 'Take this one'
            : (desk ? desk.verb : 'Approve & send on'),
        rejectable: offer.status !== 'rejected'
            && (isAdmin
                // Throwing a bid out during the first pass is part of filtering:
                // it misses the spec, it's a duplicate, the vendor withdrew. Done
                // with a reason, rather than by silently never forwarding it.
                || (forwarding && offer.status === 'pending')
                || (shortlisting && offer.status === 'forwarded')
                || (desk && offer.status === desk.status)
                // Purchasing own the withdraw-and-re-award cycle now, at every
                // step from their own commitment onwards. Supply chain still
                // refuses at their own desk, which the line above covers.
                || (forwarding && ['purchasing_ok', 'purchasing_manager_ok', 'approved'].includes(offer.status)))
    });

    // Purchasing read this screen grouped by supplier; everybody else reads it
    // by price. The manager's view has no vendor to group by at all - the API
    // sends them null - and grouping is exactly what their blind comparison is
    // meant to prevent. For purchasing the opposite is true: they invited these
    // vendors, and "who sent what" is the question the flat list made hardest,
    // especially when one supplier has filed three of the five offers.
    const groupByVendor = forwarding && visible.some(o => o.vendor_company);

    let body;
    if (!groupByVendor) {
        body = visible.map(offer => offerRow(tender, offer, rowOpts(offer))).join('');
    } else {
        const groups = new Map();
        visible.forEach(offer => {
            const key = offer.vendor_company || 'Unknown supplier';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(offer);
        });
        // Groups ordered by their own cheapest offer, and offers within a group
        // still by price, so the cheapest thing on the tender is still the
        // first row on the screen.
        body = [...groups.entries()]
            .sort((a, b) => Math.min(...a[1].map(o => o.total_amount))
                          - Math.min(...b[1].map(o => o.total_amount)))
            .map(([vendor, list]) => `
                <tr class="vendor-group"><td colspan="9">
                    <span class="vendor-name">${escapeHtml(vendor)}</span>
                    <span class="vendor-count">${list.length} offer${list.length === 1 ? '' : 's'}</span>
                </td></tr>
                ${list.map(offer => offerRow(tender, offer, rowOpts(offer))).join('')}
            `).join('');
    }

    container.innerHTML = `
        <div class="card" style="margin-bottom: 20px;">
            <div class="card-body offers-picker">
                <label for="offersTenderPicker">Tender</label>
                <select class="form-control" id="offersTenderPicker" onchange="onOffersTenderChange(this.value)">
                    ${options}
                </select>
                ${tender.urgent ? '<span class="badge badge-danger">Urgent</span>' : ''}
            </div>
        </div>

        <div class="card">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">${escapeHtml(tender.name)}</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">
                        ${escapeHtml(tender.serial)} · ${visible.length} offer(s)${
                            forwarding && notYetSent ? ` · ${notYetSent} not sent up yet` : ''}${
                            forwarding && sentUp ? ` · ${sentUp} with the manager` : ''}${
                            shortlistedCount ? ` · ${shortlistedCount} shortlisted` : ''}
                    </span>
                </div>
            </div>
            <div class="card-body" style="padding: 0;">
                <div class="table-container">
                    <table class="offers-table">
                        <thead><tr>
                            <th class="col-act"></th>
                            <th>Offer</th>
                            <th>Items answered</th>
                            <th>Substitutes</th>
                            <th title="Asked for, not priced in this offer">Missing</th>
                            <th title="Thrown in, not on the tender's list">Added</th>
                            <th>Total</th>
                            <th>Status</th>
                            <th></th>
                        </tr></thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>
            </div>
            ${forwarding && hasShortlist ? `
                <div class="card-body shortlist-bar">
                    <span>The manager has ranked ${shortlistedCount} offer(s). If none of them
                          will do &mdash; the vendor withdrew, the price expired, the spec was
                          missed &mdash; send the list back and they can rank again.</span>
                    <button class="btn btn-secondary btn-sm" onclick="sendShortlistBack('${tender.id}')">
                        Send back for another list</button>
                </div>
            ` : ''}
            ${forwarding && !managerReplied ? `
                <div class="card-body shortlist-bar">
                    <span>${sentUp
                        ? `The manager has these ${sentUp} offer(s) and hasn't ranked them yet.
                           Change the ticks and send again if the set is wrong.`
                        : `Tick the offers worth putting in front of the department manager.
                           Anything you leave unticked stays here and they never see it &mdash;
                           it isn't rejected, and you can send it up later.`}</span>
                    <button class="btn btn-accent btn-sm" onclick="sendForward('${tender.id}')">
                        ${sentUp ? 'Resend to manager' : 'Send to manager'}</button>
                </div>
            ` : ''}
            ${forwarding && managerReplied ? `
                <div class="card-body shortlist-bar">
                    <span>The manager has answered on this tender, so there is nothing to send
                          them. Rejecting the offer purchasing committed to &mdash; or sending
                          the shortlist back &mdash; reopens it and this returns.</span>
                </div>
            ` : ''}
            ${(shortlisting || isAdmin) ? `
                <div class="card-body shortlist-bar">
                    <span>Rank the offers you would accept, best first &mdash; up to ${MAX_SHORTLIST},
                          and <strong>one or two is fine</strong> if only that many are worth having.
                          Purchasing commits to one of them.
                          <strong>Once you send this you can't change it</strong>, so check the
                          order first.</span>
                    <button class="btn btn-accent btn-sm" onclick="saveShortlist('${tender.id}')">Send shortlist</button>
                </div>
            ` : ''}
        </div>
    `;
}

function onOffersTenderChange(tenderId) {
    offersTenderId = tenderId || null;
    renderPage('offers');
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
                                                <button class="action-btn" onclick="viewTender('${tender.id}')" title="View tender"><i class="fas fa-eye"></i></button>
                                                <!-- Moving an award is now withdrawing the approved offer on the
                                                     Offers desk, which records a reason and frees the tender for a
                                                     fresh shortlist. -->
                                                <button class="action-btn" onclick="navigateTo('offers')" title="Change this award on the Offers desk"><i class="fas fa-right-left"></i></button>
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
        { key: '{bid_amount}', desc: 'Vendor bid amount' }
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
// THE BASKET — what we're actually buying
// ============================================
// One row per requirement. Each row is answered from a vendor's quote or typed
// in by hand, so a four-item tender can be bought from four different places.
// The basket, not any single offer, is what gets approved.

const AWARD_STATUS_META = {
    draft:                 { label: 'Draft',                badge: '' },
    submitted:             { label: 'With purchasing mgr',  badge: 'badge-warning' },
    purchasing_manager_ok: { label: 'With supply chain',    badge: 'badge-warning' },
    approved:              { label: 'Approved',             badge: 'badge-success' },
    rejected:              { label: 'Rejected',             badge: 'badge-danger' },
};

// The basket being built, keyed by tender item id. Each entry is a *list* of
// picks, not one pick.
//
// It used to be one: a requirement was answered by a single source, and the
// API refused two lines against the same tender item. That is not how a split
// purchase works. Four monitors where one vendor has one in stock and another
// has three is one requirement bought from two places, and refusing it meant
// either buying four from the dearer vendor or leaving the requirement out of
// the basket entirely and handling it off the system.
//
// Held outside the DOM so a re-render doesn't throw away a half-built basket.
let basketDraft = {};

function basketPicks(itemId) {
    if (!Array.isArray(basketDraft[itemId])) basketDraft[itemId] = [];
    return basketDraft[itemId];
}

async function openBasketPage(tenderId) {
    const container = document.getElementById('contentArea');
    showLoading(container);

    let tender, offers, award, vendorPage;
    try {
        [tender, offers, award, vendorPage] = await Promise.all([
            apiFetch(`/tenders/${tenderId}`),
            apiFetch(`/offers?tender_id=${tenderId}`).catch(() => []),
            apiFetch(`/awards/tenders/${tenderId}`),
            // Buying something ourselves does not mean buying it from a
            // stranger. Purchasing walks into a supplier we already have a
            // record for as often as into a corner shop, and typing the name
            // in by hand loses the link to that record - which is the whole
            // reason the directory exists. Best effort: a desk that cannot
            // read the directory can still type a name.
            // 200 is the API's ceiling on a page, and asking for more is a 422
            // that this .catch would swallow into an empty directory - which
            // shows as "no supplier is filed under this category" and looks
            // like a filter bug rather than a request that never landed.
            apiList('/vendors', { limit: 200, active: true }).catch(() => ({ items: [] })),
        ]);
    } catch (err) { showLoadError(container, err, 'renderPage(AppState.currentPage)'); return; }
    const vendors = (vendorPage.items || []).filter(v => v.active !== false);

    const role = AppState.currentUser.role;
    const isPurchasing = ['admin', 'procurement'].includes(role);
    const status = award ? award.status : null;
    const editable = isPurchasing && (!award || status === 'draft' || status === 'rejected');

    // Every priced line any vendor offered, indexed by the requirement it
    // answers, so each row can show its own choices and nothing else.
    const choicesByItem = {};
    offers.forEach(offer => (offer.items || []).forEach(line => {
        if (!line.tender_item_id) return;
        (choicesByItem[line.tender_item_id] = choicesByItem[line.tender_item_id] || []).push({ offer, line });
    }));
    Object.values(choicesByItem).forEach(list => list.sort((a, b) => a.line.unit_price - b.line.unit_price));

    // Seed the draft from whatever is saved, so reopening the page shows the
    // basket as it stands rather than an empty one. Several saved lines against
    // one requirement come back as several picks, which is how a split survives
    // a reload.
    basketDraft = {};
    (award ? award.lines : []).forEach(line => {
        if (!line.tender_item_id) return;
        basketPicks(line.tender_item_id).push({
            offer_item_id: line.offer_item_id, vendor_id: line.vendor_id,
            vendor_name: line.vendor_name, unit_price: line.unit_price,
            quantity: line.quantity, name: line.name,
        });
    });

    basketContext = { tenderId, tender, choicesByItem, vendors };

    const rows = (tender.items || []).map(item => basketRowsFor(item, editable)).join('');

    const canApprovePM = (role === 'admin' || isPurchasingManager(AppState.currentUser)) && status === 'submitted';
    const canApproveSC = ['admin', 'supply_chain'].includes(role) && status === 'purchasing_manager_ok';
    const canReject = status && ['submitted', 'purchasing_manager_ok', 'approved'].includes(status)
        && (role === 'admin' || isPurchasingManager(AppState.currentUser) || role === 'supply_chain');

    container.innerHTML = `
        <button class="btn btn-secondary btn-sm" style="margin-bottom: 16px;" onclick="navigateTo('${isPurchasing ? 'tenders' : 'dashboard'}')"><i class="fas fa-arrow-left"></i> Back</button>
        <div class="card">
            <div class="card-header">
                <div><h3 class="card-title">Basket — ${escapeHtml(tender.name)}</h3>
                     <span style="font-size: 13px; color: var(--text-muted);">${escapeHtml(tender.serial)}
                        &middot; ${offers.length} offer(s) on the table
                        ${award ? `&middot; ${award.items_answered}/${award.items_required} answered &middot; ${award.vendor_count} supplier(s)` : ''}</span></div>
                <div style="text-align: right;">
                    ${status ? `<span class="badge ${(AWARD_STATUS_META[status] || {}).badge || ''}">${(AWARD_STATUS_META[status] || {}).label || status}</span>` : '<span class="badge">Not started</span>'}
                    ${tender.urgent ? `<span class="badge badge-danger" style="margin-left: 6px;"><i class="fas fa-bolt"></i> Urgent</span>` : ''}
                </div>
            </div>
            <div class="card-body">
                ${editable ? `
                    <p style="margin-bottom: 16px; font-size: 13px; color: var(--text-muted);">
                        The basket is for the awkward cases: items coming from more than one vendor,
                        or things purchasing buys themselves. If one offer answers the whole tender,
                        approve it on the Offers desk and skip this entirely.
                        Need part of a line from one supplier and the rest from another?
                        <strong>Split</strong> it.
                    </p>` : ''}

                ${award && award.rejection_reason ? `
                    <p style="margin-bottom: 16px; color: var(--danger); font-size: 13px;">
                        <i class="fas fa-circle-xmark"></i> Rejected at ${escapeHtml(award.rejected_at_stage || '')}: ${escapeHtml(award.rejection_reason)}
                        — saving again starts a fresh basket.</p>` : ''}
                ${award && award.urgent_skipped ? `
                    <p style="margin-bottom: 16px; color: var(--warning); font-size: 13px;">
                        <i class="fas fa-bolt"></i> Approved without the purchasing manager or supply chain.</p>` : ''}

                <div class="table-container">
                    <table>
                        <thead><tr><th>#</th><th>Requirement</th><th style="width: 150px;">Qty</th><th style="width: 280px;">Buy from</th>
                                   <th style="width: 180px;">Supplier (by hand)</th><th style="width: 130px;">Unit price</th><th>Line total</th></tr></thead>
                        <tbody>${rows || `<tr><td colspan="7" style="text-align:center; padding: 20px; color: var(--text-muted);">This tender has no item table</td></tr>`}</tbody>
                        <tfoot><tr><td colspan="6" style="text-align: right; font-weight: 700;">Basket total</td>
                                   <td id="basketTotal" style="font-weight: 700; color: var(--accent-light);">${tender.currency} 0</td></tr></tfoot>
                    </table>
                </div>

                <div style="margin-top: 20px; display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;">
                    ${editable ? `<button class="btn btn-secondary" onclick="saveBasket('${tenderId}')"><i class="fas fa-floppy-disk"></i> Save basket</button>` : ''}
                    ${editable && award && award.lines.length ? `<button class="btn btn-accent" onclick="submitBasket('${tenderId}')"><i class="fas fa-paper-plane"></i> Send for approval</button>` : ''}
                    ${canApprovePM ? `<button class="btn btn-success" onclick="approveBasket('${tenderId}', 'purchasing-manager-approve')"><i class="fas fa-check"></i> Approve &amp; send on</button>` : ''}
                    ${canApproveSC ? `<button class="btn btn-success" onclick="approveBasket('${tenderId}', 'supply-chain-approve')"><i class="fas fa-check"></i> Final approval</button>` : ''}
                    ${canReject ? `<button class="btn btn-danger" onclick="rejectBasket('${tenderId}')"><i class="fas fa-times"></i> ${status === 'approved' ? 'Withdraw approval' : 'Reject'}</button>` : ''}
                </div>
            </div>
        </div>
    `;
    // The source cell is drawn from the draft rather than inline in the row
    // template, so there is one definition of how a chosen source reads and
    // the picker can repaint a single row without rebuilding the page.
    (tender.items || []).forEach(item => repaintRequirementRows(item.id));
    recalcBasket();
}

let basketContext = null;

// Every row for one requirement: the picks it has been split into, or a single
// empty row when it has none yet.
//
// The requirement is named once, on the first row, and the rest carry a turn
// -down arrow. A split is one purchase of one thing from two places, and
// repeating the item name down the table would read as two requirements.
function basketRowsFor(item, editable) {
    const picks = basketPicks(item.id);
    const count = Math.max(picks.length, 1);
    let html = '';
    for (let idx = 0; idx < count; idx++) {
        const chosen = picks[idx] || {};
        const first = idx === 0;
        const qty = chosen.quantity != null ? chosen.quantity : item.quantity;
        html += `
            <tr data-row="${item.id}" data-pick="${idx}" data-editable="${editable ? '1' : '0'}"
                class="${first ? '' : 'basket-split-row'}">
                <td>${first ? item.position + 1 : '<i class="fas fa-turn-up fa-rotate-90" style="color: var(--text-muted);"></i>'}</td>
                <td>${first ? `<strong>${escapeHtml(item.name)}</strong>
                    <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(item.specs || '')}</div>`
                    : '<span style="color: var(--text-muted); font-size: 12px;">same item, another supplier</span>'}</td>
                <td>
                    <input class="form-control form-control-sm" type="number" min="0" step="any"
                           data-field="qty" value="${escapeAttr(qty)}"
                           oninput="recalcBasket()" ${editable ? '' : 'disabled'}>
                    ${first ? `<div class="split-tally" data-tally="${item.id}"></div>
                        ${editable ? `<button class="btn btn-secondary btn-sm basket-split-btn"
                            onclick="splitBasketRow('${item.id}')"
                            title="Buy part of this from another supplier"><i class="fas fa-code-branch"></i> Split</button>` : ''}`
                        : (editable ? `<button class="btn btn-danger btn-sm basket-split-btn"
                            onclick="removeBasketSplit('${item.id}', ${idx})"
                            title="Drop this part of the split"><i class="fas fa-times"></i> Remove</button>` : '')}
                    <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
                        ${Number(item.quantity).toLocaleString()} ${escapeHtml(item.unit || '')} needed</div>
                </td>
                <td>
                    <button class="btn btn-secondary btn-sm basket-source-btn"
                            onclick="openBasketPicker('${item.id}', ${idx})" ${editable ? '' : 'disabled'}>
                        <span class="basket-source-label"></span>
                        <i class="fas fa-chevron-down"></i>
                    </button>
                </td>
                <td><input class="form-control" data-field="vendor" placeholder="Shop or supplier"
                           value="" disabled></td>
                <td><input class="form-control" type="number" min="0" step="0.01" data-field="price"
                           value="" oninput="recalcBasket()" disabled></td>
                <td class="basket-line-total" style="font-weight: 700;">—</td>
            </tr>`;
    }
    return html;
}

// Adds another pick against the same requirement, and halves the quantity into
// it so the split starts from something sensible rather than from two rows
// both claiming the whole order.
function splitBasketRow(itemId) {
    const picks = basketPicks(itemId);
    const item = basketContext.tender.items.find(i => i.id === itemId);
    const rows = [...document.querySelectorAll(`tr[data-row="${itemId}"]`)];

    // Read the quantities currently on screen before the table is rebuilt, or
    // anything typed since the last repaint is lost.
    rows.forEach((row, idx) => {
        if (!picks[idx]) picks[idx] = {};
        picks[idx].quantity = Number(row.querySelector('[data-field="qty"]').value) || 0;
        if (picks[idx].offer_item_id == null && picks[idx].vendor_name != null) {
            picks[idx].vendor_name = row.querySelector('[data-field="vendor"]').value;
            picks[idx].unit_price = Number(row.querySelector('[data-field="price"]').value) || 0;
        }
    });

    if (!picks.length) picks.push({ quantity: Number(item.quantity) });
    const taken = picks.reduce((n, p) => n + Number(p.quantity || 0), 0);
    const spare = Math.max(Number(item.quantity) - taken, 0);
    // Nothing left over means the split has to come out of what is already
    // allocated, so the last row gives up half of itself.
    if (spare > 0) {
        picks.push({ quantity: spare });
    } else {
        const last = picks[picks.length - 1];
        const half = Math.floor(Number(last.quantity || 0) / 2) || Number(last.quantity || 0) / 2;
        last.quantity = Number(last.quantity || 0) - half;
        picks.push({ quantity: half });
    }
    redrawBasketRequirement(itemId);
}

function removeBasketSplit(itemId, index) {
    const picks = basketPicks(itemId);
    // Keep the typed values of the rows that survive.
    [...document.querySelectorAll(`tr[data-row="${itemId}"]`)].forEach((row, idx) => {
        if (!picks[idx]) return;
        picks[idx].quantity = Number(row.querySelector('[data-field="qty"]').value) || 0;
    });
    picks.splice(index, 1);
    redrawBasketRequirement(itemId);
}

// Redraws the rows of one requirement in place. Cheaper than rebuilding the
// page, and it keeps every other requirement's half-typed prices intact.
function redrawBasketRequirement(itemId) {
    const rows = [...document.querySelectorAll(`tr[data-row="${itemId}"]`)];
    if (!rows.length) return;
    const item = basketContext.tender.items.find(i => i.id === itemId);
    const editable = rows[0].dataset.editable === '1';

    const holder = document.createElement('tbody');
    holder.innerHTML = basketRowsFor(item, editable);
    const parent = rows[0].parentNode;
    [...holder.children].forEach(row => parent.insertBefore(row, rows[0]));
    rows.forEach(row => row.remove());

    repaintRequirementRows(itemId);
    recalcBasket();
}

// Every row of one requirement, including the single empty one a requirement
// with no picks still draws - that row has a source button too, and it needs
// to say "not buying" rather than nothing at all.
function repaintRequirementRows(itemId) {
    const count = Math.max(basketPicks(itemId).length, 1);
    for (let idx = 0; idx < count; idx++) repaintBasketRow(itemId, idx);
}

function recalcBasket() {
    if (!basketContext) return;
    const { tender } = basketContext;
    let total = 0;
    const allocated = {};
    document.querySelectorAll('tr[data-row]').forEach(row => {
        const itemId = row.dataset.row;
        const price = Number(row.querySelector('[data-field="price"]').value || 0);
        const qty = Number(row.querySelector('[data-field="qty"]').value || 0);
        const lineTotal = qty * price;
        total += lineTotal;
        allocated[itemId] = (allocated[itemId] || 0) + qty;
        row.querySelector('.basket-line-total').textContent =
            price ? `${tender.currency} ${lineTotal.toLocaleString()}` : '—';
    });

    // "3 of 4" under a split requirement. A split that doesn't add up is the
    // easy mistake to make here and an invisible one afterwards - the basket
    // totals correctly and simply buys three of something four people need.
    (tender.items || []).forEach(item => {
        const tally = document.querySelector(`[data-tally="${item.id}"]`);
        if (!tally) return;
        const picks = basketPicks(item.id);
        const got = allocated[item.id] || 0;
        if (picks.length < 2) { tally.textContent = ''; tally.className = 'split-tally'; return; }
        const want = Number(item.quantity);
        tally.textContent = `${got.toLocaleString()} of ${want.toLocaleString()} allocated`;
        tally.className = 'split-tally' + (Math.abs(got - want) > 1e-9 ? ' is-off' : ' is-ok');
    });

    const el = document.getElementById('basketTotal');
    if (el) el.textContent = `${tender.currency} ${total.toLocaleString()}`;
}

// Read off `basketDraft` for the choice, and off the row for the three typed
// fields. The draft is the source of truth for what was picked: it survives a
// re-render, and there is no longer a <select> holding it.
//
// A quantity is sent on every line, offer-sourced ones included. It used to be
// left off so the offer's own quoted quantity carried, which is right until a
// requirement is split - at which point two lines both inheriting the full
// quote would buy twice what was asked for.
function collectBasketLines() {
    const lines = [];
    document.querySelectorAll('tr[data-row]').forEach(row => {
        const itemId = row.dataset.row;
        const idx = Number(row.dataset.pick);
        const chosen = basketPicks(itemId)[idx];
        if (!chosen) return;   // a requirement we aren't buying on this basket

        const item = basketContext.tender.items.find(i => i.id === itemId);
        const quantity = Number(row.querySelector('[data-field="qty"]').value || 0);
        if (quantity <= 0) return;   // an empty part of a split is not a line

        if (chosen.offer_item_id) {
            lines.push({
                tender_item_id: itemId,
                offer_item_id: chosen.offer_item_id,
                quantity,
            });
            return;
        }
        // Bought by hand: the shop and the price are ours to type, so they come
        // from the inputs rather than the draft, which only knows a choice was
        // made.
        lines.push({
            tender_item_id: itemId,
            vendor_id: chosen.vendor_id || null,
            vendor_name: row.querySelector('[data-field="vendor"]').value.trim() || null,
            name: item.name,
            specs: item.specs,
            quantity,
            unit: item.unit,
            unit_price: Number(row.querySelector('[data-field="price"]').value || 0),
        });
    });
    return lines;
}

async function saveBasket(tenderId) {
    try {
        const award = await apiFetch(`/awards/tenders/${tenderId}`, {
            method: 'PUT', body: JSON.stringify({ lines: collectBasketLines(), notes: null }),
        });
        showToast('success', 'Basket saved',
            `${award.items_answered} of ${award.items_required} answered from ${award.vendor_count} supplier(s)`);
        openBasketPage(tenderId);
    } catch (err) { showToast('error', 'Error', err.message); }
}

async function submitBasket(tenderId) {
    try {
        const award = await apiFetch(`/awards/tenders/${tenderId}/submit`, { method: 'POST' });
        showToast('success', 'Sent',
            award.status === 'approved'
                ? 'Completed — the later approvals were skipped and both desks notified'
                : 'The purchasing manager has been notified');
        openBasketPage(tenderId);
    } catch (err) { showToast('error', 'Not sent', err.message); }
}

async function approveBasket(tenderId, path) {
    try {
        const award = await apiFetch(`/awards/tenders/${tenderId}/${path}`, { method: 'POST' });
        showToast('success', 'Approved', (AWARD_STATUS_META[award.status] || {}).label || award.status);
        openBasketPage(tenderId);
    } catch (err) { showToast('error', 'Error', err.message); }
}

function rejectBasket(tenderId) {
    openReasonModal({
        title: 'Reject this basket',
        description: 'Purchasing is told, and can rebuild it. Say enough for them to know what to change.',
        label: 'Reason *',
        submitLabel: 'Reject basket',
        onSubmit: async (reason) => {
            try {
                await apiFetch(`/awards/tenders/${tenderId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
                showToast('info', 'Rejected', 'Purchasing has been notified');
                openBasketPage(tenderId);
            } catch (err) { showToast('error', 'Error', err.message); }
        },
    });
}

// ============================================
// CATEGORIES (admin)
// ============================================
// The vocabulary the whole vendor-matching mechanism turns on. A tender has one
// category; a vendor has several; the invite list and the basket's source
// picker both match one against the other. Get this list wrong and the symptom
// is not an error - it is an empty invite list nobody can explain.
//
// It was an enum of four labels. Growing it meant a migration and a deploy, so
// it never grew, and everything ended up filed under "goods" - which answers
// none of the questions somebody picking a supplier actually has.
//
// Retire rather than delete. A tender raised under Consulting was raised under
// Consulting, and shortening a dropdown is not a reason to rewrite that.

let categoriesShowRetired = false;

async function renderCategoriesPage(container) {
    let categories;
    try {
        categories = await apiFetch(`/categories?include_retired=${categoriesShowRetired}`);
    } catch (err) { showLoadError(container, err, "renderPage('categories')"); return; }

    const retiredCount = categories.filter(c => !c.active).length;

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">Categories</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">
                        What tenders are for, and what vendors supply. A tender only ever offers
                        vendors filed under its own category.
                    </span>
                </div>
                <button class="btn btn-accent btn-sm" onclick="openAddCategoryModal()">
                    <i class="fas fa-plus"></i> Add category</button>
            </div>
            <div class="card-body" style="padding: 0;">
                <div style="padding: 12px 16px;">
                    <label class="category-tick" style="display: inline-flex;">
                        <input type="checkbox" ${categoriesShowRetired ? 'checked' : ''}
                               onchange="toggleRetiredCategories(this.checked)">
                        <span>Show retired${retiredCount && categoriesShowRetired ? ` (${retiredCount})` : ''}</span>
                    </label>
                </div>
                ${categories.length === 0 ? `
                    <div style="padding: 24px;"><div class="empty-state"><i class="fas fa-tags"></i>
                        <h3>No categories yet</h3>
                        <p>Add the kinds of thing this company buys &mdash; as broad or as specific as
                           you like. Nothing can be raised or quoted until at least one exists.</p>
                    </div></div>
                ` : `
                <div class="table-container">
                    <table>
                        <thead><tr>
                            <th style="width: 90px;">Order</th>
                            <th>Name</th>
                            <th>Key</th>
                            <th>Vendors</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr></thead>
                        <tbody>${categories.map(c => `
                            <tr class="${c.active ? '' : 'is-rejected'}">
                                <td>${c.position}</td>
                                <td><strong>${escapeHtml(c.name)}</strong></td>
                                <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(c.slug)}</code></td>
                                <td>${c.vendor_count
                                    ? `<span class="substitute-count">${c.vendor_count}</span>`
                                    : '<span style="color: var(--text-muted);">&mdash;</span>'}</td>
                                <td><span class="badge ${c.active ? 'badge-success' : 'badge-secondary'}">
                                    ${c.active ? 'Active' : 'Retired'}</span></td>
                                <td><div class="actions">
                                    <button class="action-btn" title="Rename or reorder"
                                            onclick="openEditCategoryModal('${c.id}', '${escapeAttr(c.name)}', ${c.position})">
                                        <i class="fas fa-edit"></i></button>
                                    <button class="action-btn" title="${c.active ? 'Retire' : 'Reinstate'}"
                                            onclick="setCategoryActive('${c.id}', ${!c.active})">
                                        <i class="fas fa-power-off"></i></button>
                                    ${c.vendor_count === 0 ? `
                                        <button class="action-btn danger" title="Delete — only if nothing uses it"
                                                onclick="deleteCategory('${c.id}', '${escapeAttr(c.name)}')">
                                            <i class="fas fa-trash"></i></button>` : ''}
                                </div></td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
                <div class="card-body" style="padding: 14px 16px; border-top: 1px solid var(--border);">
                    <span style="font-size: 13px; color: var(--text-muted);">
                        Renaming is safe &mdash; nothing is filed under the name, only under the key
                        beside it, which never changes. Retiring takes a category out of the pickers
                        while everything already filed under it keeps reading correctly.
                    </span>
                </div>
                `}
            </div>
        </div>
    `;
}

function toggleRetiredCategories(on) {
    categoriesShowRetired = on;
    renderPage('categories');
}

// Reloads AppState.categories after any change, so the create-tender form and
// the vendor picker see it without a sign-out. They read from the cache rather
// than fetching per open, which is right for a list that changes twice a year
// and wrong the one afternoon somebody is setting it up.
async function refreshCategoryCache() {
    try { AppState.categories = await apiFetch('/categories'); } catch (err) { /* keep the old list */ }
}

function openAddCategoryModal() {
    const body = `
        <div class="form-group">
            <label>Name *</label>
            <input class="form-control" id="ncName" placeholder="e.g. Portable devices">
            <small style="color: var(--text-muted); font-size: 12px;">
                As specific as is useful. "Electronic devices" and "Portable devices" are two
                categories if vendors differ between them, and one if they don't.</small>
        </div>
        <div class="form-group">
            <label>Order</label>
            <input class="form-control" type="number" id="ncPosition" value="0">
            <small style="color: var(--text-muted); font-size: 12px;">
                Lower comes first in every picker. Ties fall back to alphabetical.</small>
        </div>
    `;
    showFormDialog('Add category', body, 'Add category', async () => {
        const name = document.getElementById('ncName').value.trim();
        if (!name) { showToast('error', 'Name required', 'A category needs a name'); return false; }
        try {
            const c = await apiFetch('/categories', {
                method: 'POST',
                body: JSON.stringify({ name, position: Number(document.getElementById('ncPosition').value) || 0 }),
            });
            await refreshCategoryCache();
            showToast('success', 'Added', `${c.name} — key ${c.slug}`);
            renderPage('categories');
            return true;
        } catch (err) { showToast('error', 'Error', err.message); return false; }
    });
}

function openEditCategoryModal(id, name, position) {
    const body = `
        <div class="form-group"><label>Name *</label>
            <input class="form-control" id="ecName" value="${escapeAttr(name)}"></div>
        <div class="form-group"><label>Order</label>
            <input class="form-control" type="number" id="ecPosition" value="${position}"></div>
        <p style="font-size: 13px; color: var(--text-muted);">
            The key this category is filed under doesn't change when you rename it, so
            every tender and vendor already using it stays attached.</p>
    `;
    showFormDialog(`Edit ${name}`, body, 'Save', async () => {
        const newName = document.getElementById('ecName').value.trim();
        if (!newName) { showToast('error', 'Name required', 'A category needs a name'); return false; }
        try {
            await apiFetch(`/categories/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ name: newName, position: Number(document.getElementById('ecPosition').value) || 0 }),
            });
            await refreshCategoryCache();
            showToast('success', 'Saved', `${newName} updated`);
            renderPage('categories');
            return true;
        } catch (err) { showToast('error', 'Error', err.message); return false; }
    });
}

async function setCategoryActive(id, active) {
    try {
        const c = await apiFetch(`/categories/${id}`, {
            method: 'PATCH', body: JSON.stringify({ active }),
        });
        await refreshCategoryCache();
        showToast('info', active ? 'Reinstated' : 'Retired',
            active
                ? `${c.name} is back in the pickers`
                : `${c.name} has left the pickers — anything already filed under it is untouched`);
        renderPage('categories');
    } catch (err) { showToast('error', 'Error', err.message); }
}

function deleteCategory(id, name) {
    showConfirmDialog('Delete this category?',
        `<p><strong>${escapeHtml(name)}</strong> will be removed entirely.</p>
         <p style="margin-top: 10px; color: var(--text-muted);">Only possible while no tender,
            template or vendor uses it. If any does, retire it instead — that takes it out of the
            pickers and leaves the records readable.</p>`,
        async () => {
            try {
                await apiFetch(`/categories/${id}`, { method: 'DELETE' });
                await refreshCategoryCache();
                showToast('success', 'Deleted', `${name} is gone`);
                renderPage('categories');
            } catch (err) { showToast('error', 'Still in use', err.message); }
        });
}

// ============================================
// VENDOR DIRECTORY
// ============================================
// One directory, and this is it. A vendor is a company we buy from, not an
// account — purchasing creates the record, and the vendor reaches a tender
// through a link addressed to them. There is nothing here to activate,
// deactivate, or reset a password on.

async function renderVendorDirectoryPage(container) {
    pagerReloaders.vendors = () => renderVendorDirectoryPage(container);
    const page = await apiList('/vendors', pagerParams('vendors'));
    const canEdit = ['admin', 'procurement'].includes(AppState.currentUser.role);

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <div>
                    <h3 class="card-title">Vendor Directory</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">${page.total} compan${page.total === 1 ? 'y' : 'ies'} &middot; vendors don't have logins</span>
                </div>
                ${canEdit ? `<button class="btn btn-accent btn-sm" onclick="openAddVendorModal()"><i class="fas fa-plus"></i> Add Vendor</button>` : ''}
            </div>
            <div class="card-body" style="padding: 0;">
                <div style="padding: 16px; display: flex; gap: 12px; flex-wrap: wrap;">
                    <input type="text" class="form-control" style="max-width: 280px;" placeholder="Search name, code, tax ID"
                           value="${escapeAttr(pagerState('vendors').search || '')}"
                           onchange="pagerFilter('vendors', { search: this.value })">
                    <select class="form-control" style="max-width: 200px;" onchange="pagerFilter('vendors', { category: this.value })">
                        <option value="">All categories</option>
                        ${(AppState.categories || []).map(c =>
                            `<option value="${escapeAttr(c.slug)}" ${pagerState('vendors').category === c.slug ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
                    </select>
                </div>
                ${page.total === 0 ? `
                    <div style="padding: 24px;"><div class="empty-state"><i class="fas fa-building"></i><h3>No vendors yet</h3>
                    <p>Add the companies you buy from. Each one gets a code, and a per-tender link when you invite them.</p></div></div>
                ` : `
                <div class="table-container">
                    <table>
                        <thead><tr><th>Code</th><th>Company</th><th>Supplies</th><th>Contact</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody>
                            ${page.items.map(v => `
                                <tr>
                                    <td><code>${escapeHtml(v.code)}</code></td>
                                    <td><strong>${escapeHtml(v.company_name)}</strong>
                                        ${v.tax_id ? `<div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(v.tax_id)}</div>` : ''}</td>
                                    <td>${categoryChips(v.categories)}</td>
                                    <td>
                                        ${v.contact_email
                                            ? escapeHtml(v.contact_email)
                                            : `<span class="badge badge-warning" title="RFQs can't be emailed to this vendor"><i class="fas fa-phone"></i> no email</span>`}
                                        ${v.contact_phone ? `<div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(v.contact_phone)}</div>` : ''}
                                    </td>
                                    <td><span class="badge ${v.active ? 'badge-success' : 'badge-danger'}">${v.active ? 'Active' : 'Retired'}</span></td>
                                    <td><div class="actions">
                                        <button class="action-btn" onclick="openVendorHistory('${v.id}')" title="Quotes and purchases"><i class="fas fa-clock-rotate-left"></i></button>
                                        ${canEdit ? `<button class="action-btn" onclick="openEditVendorModal('${v.id}')" title="Edit — including what they supply"><i class="fas fa-edit"></i></button>` : ''}
                                        ${canEdit ? `<button class="action-btn" onclick="toggleVendorActive('${v.id}', ${!v.active})" title="${v.active ? 'Retire' : 'Reinstate'}"><i class="fas fa-power-off"></i></button>` : ''}
                                    </div></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
                ${renderPager('vendors', page.total)}
                `}
            </div>
        </div>
    `;
}

// Add and edit are one function because they are one form. The only real
// difference is which button was pressed and whether the fields start empty.
//
// Categories are tick boxes, not a dropdown. A vendor supplies several things -
// that is the whole reason the single column went - and a <select multiple> is
// a control almost nobody knows how to use with the keyboard, let alone that
// they are allowed to pick more than one.
function vendorFormBody(vendor) {
    const chosen = new Set((vendor && vendor.categories || []).map(c => c.slug));
    const list = [...(AppState.categories || [])];
    // A retired category the vendor is already filed under still shows, ticked,
    // so saving the form doesn't quietly drop it.
    (vendor && vendor.categories || []).forEach(c => {
        if (!list.some(x => x.slug === c.slug)) list.push({ ...c, name: c.name + ' (retired)' });
    });

    return `
        <div class="form-grid">
            <div class="form-group"><label>Company name *</label>
                <input class="form-control" id="nvName" value="${escapeAttr(vendor ? vendor.company_name : '')}"></div>
            <div class="form-group"><label>Contact email</label>
                <input class="form-control" id="nvEmail" placeholder="leave blank if they have none"
                       value="${escapeAttr(vendor ? (vendor.contact_email || '') : '')}">
                <small style="color: var(--text-muted); font-size: 12px;">Without one, RFQs have to be handed over another way</small></div>
            <div class="form-group"><label>Phone</label>
                <input class="form-control" id="nvPhone" value="${escapeAttr(vendor ? (vendor.contact_phone || '') : '')}"></div>
            <div class="form-group"><label>Tax ID</label>
                <input class="form-control" id="nvTax" value="${escapeAttr(vendor ? (vendor.tax_id || '') : '')}"></div>
            <div class="form-group full-width"><label>Address</label>
                <input class="form-control" id="nvAddress" value="${escapeAttr(vendor ? (vendor.address || '') : '')}"></div>
        </div>
        <div class="form-group" style="margin-top: 4px;">
            <label>What they supply *</label>
            <div class="category-picker" id="nvCategories">
                ${list.length ? list.map(c => `
                    <label class="category-tick">
                        <input type="checkbox" value="${escapeAttr(c.slug)}" ${chosen.has(c.slug) ? 'checked' : ''}>
                        <span>${escapeHtml(c.name)}</span>
                    </label>`).join('')
                : '<span style="color: var(--text-muted);">No categories exist yet. An admin sets them up under Categories.</span>'}
            </div>
            <small style="color: var(--text-muted); font-size: 12px;">
                Tick every category they can supply. A tender only offers vendors that match its own,
                so a missing tick is a vendor nobody can invite.</small>
        </div>
    `;
}

function readVendorForm() {
    const categories = [...document.querySelectorAll('#nvCategories input:checked')].map(b => b.value);
    return {
        company_name: document.getElementById('nvName').value.trim(),
        categories,
        contact_email: document.getElementById('nvEmail').value.trim() || null,
        contact_phone: document.getElementById('nvPhone').value.trim() || null,
        tax_id: document.getElementById('nvTax').value.trim() || null,
        address: document.getElementById('nvAddress').value.trim() || null,
    };
}

function openAddVendorModal() {
    showFormDialog('Add Vendor', vendorFormBody(null), 'Add vendor', async () => {
        const payload = readVendorForm();
        if (!payload.company_name) { showToast('error', 'Name required', 'A vendor needs a company name'); return false; }
        if (!payload.categories.length) {
            showToast('error', 'Pick a category', 'A vendor in no category is one no tender can reach');
            return false;
        }
        try {
            const v = await apiFetch('/vendors', { method: 'POST', body: JSON.stringify(payload) });
            showToast('success', 'Vendor added', `${v.company_name} is ${v.code}`);
            renderPage(AppState.currentPage);
            return true;
        } catch (err) { showToast('error', 'Error', err.message); return false; }
    });
}

async function openEditVendorModal(vendorId) {
    let vendor;
    try { vendor = await apiFetch(`/vendors/${vendorId}`); }
    catch (err) { showToast('error', 'Error', err.message); return; }

    showFormDialog(`Edit ${vendor.company_name}`, vendorFormBody(vendor), 'Save vendor', async () => {
        const payload = readVendorForm();
        if (!payload.company_name) { showToast('error', 'Name required', 'A vendor needs a company name'); return false; }
        if (!payload.categories.length) {
            showToast('error', 'Pick a category', 'A vendor in no category is one no tender can reach');
            return false;
        }
        try {
            await apiFetch(`/vendors/${vendorId}`, { method: 'PATCH', body: JSON.stringify(payload) });
            showToast('success', 'Saved', `${payload.company_name} updated`);
            renderPage(AppState.currentPage);
            return true;
        } catch (err) { showToast('error', 'Error', err.message); return false; }
    });
}

async function toggleVendorActive(vendorId, active) {
    try {
        await apiFetch(`/vendors/${vendorId}`, { method: 'PATCH', body: JSON.stringify({ active }) });
        showToast('info', active ? 'Reinstated' : 'Retired', 'Retired vendors drop out of the invite list');
        renderPage(AppState.currentPage);
    } catch (err) { showToast('error', 'Error', err.message); }
}

// Two histories, kept apart on purpose: everything they have quoted, and what
// we actually bought from them. The first is what you read when an award has
// to move; the second is the finished business.
async function openVendorHistory(vendorId) {
    const container = document.getElementById('contentArea');
    showLoading(container);
    let vendor, subs, awards;
    try {
        [vendor, subs, awards] = await Promise.all([
            apiFetch(`/vendors/${vendorId}`),
            apiFetch(`/vendors/${vendorId}/submissions`),
            apiFetch(`/vendors/${vendorId}/awards`),
        ]);
    } catch (err) { showLoadError(container, err, 'renderPage(AppState.currentPage)'); return; }

    const bought = awards.reduce((sum, a) => sum + Number(a.line_total), 0);
    container.innerHTML = `
        <button class="btn btn-secondary btn-sm" style="margin-bottom: 16px;" onclick="navigateTo('vendors')"><i class="fas fa-arrow-left"></i> Back to directory</button>
        <div class="card" style="margin-bottom: 16px;">
            <div class="card-header">
                <div><h3 class="card-title">${escapeHtml(vendor.company_name)}</h3>
                     <span style="font-size: 13px; color: var(--text-muted);"><code>${escapeHtml(vendor.code)}</code> &middot; ${(vendor.categories || []).map(c => escapeHtml(c.name)).join(', ') || 'no categories'}</span></div>
                <div style="text-align: right;">
                    <div style="font-size: 20px; font-weight: 700; color: var(--accent-light);">${awards.length ? awards[0].currency : ''} ${bought.toLocaleString()}</div>
                    <span style="font-size: 12px; color: var(--text-muted);">bought to date</span>
                </div>
            </div>
            <div class="card-body">
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px;">
                    <div><label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Email</label>
                         <p>${vendor.contact_email ? escapeHtml(vendor.contact_email) : '<span class="badge badge-warning">none on file</span>'}</p></div>
                    <div><label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Phone</label><p>${escapeHtml(vendor.contact_phone || '-')}</p></div>
                    <div><label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Tax ID</label><p>${escapeHtml(vendor.tax_id || '-')}</p></div>
                    <div><label style="font-size: 11px; text-transform: uppercase; color: var(--text-muted);">Address</label><p>${escapeHtml(vendor.address || '-')}</p></div>
                </div>
            </div>
        </div>

        <div class="card" style="margin-bottom: 16px;">
            <div class="card-header"><h3 class="card-title">Quotations filed (${subs.length})</h3>
                <span style="font-size: 12px; color: var(--text-muted);">everything they've ever priced</span></div>
            <div class="card-body" style="padding: 0;">
                ${subs.length === 0 ? `<div style="padding: 24px;"><div class="empty-state"><i class="fas fa-file-invoice"></i><h3>Nothing quoted yet</h3></div></div>` : `
                <div class="table-container"><table>
                    <thead><tr><th>Tender</th><th>Filed</th><th>From</th><th>Offers</th><th>Lines won</th></tr></thead>
                    <tbody>${subs.map(s => `
                        <tr>
                            <td><strong>${escapeHtml(s.tender_name)}</strong><div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(s.tender_serial)}</div></td>
                            <td>${formatDate(s.submitted_at)}</td>
                            <td>${escapeHtml(s.currency)} ${Number(s.total_amount).toLocaleString()}</td>
                            <td>${s.offer_count}</td>
                            <td>${s.won_lines ? `<span class="badge badge-success">${s.won_lines}</span>` : '<span style="color: var(--text-muted);">—</span>'}</td>
                        </tr>`).join('')}</tbody>
                </table></div>`}
            </div>
        </div>

        <div class="card">
            <div class="card-header"><h3 class="card-title">Bought from them (${awards.length} line${awards.length === 1 ? '' : 's'})</h3>
                <span style="font-size: 12px; color: var(--text-muted);">the finished business</span></div>
            <div class="card-body" style="padding: 0;">
                ${awards.length === 0 ? `<div style="padding: 24px;"><div class="empty-state"><i class="fas fa-box"></i><h3>Nothing bought yet</h3></div></div>` : `
                <div class="table-container"><table>
                    <thead><tr><th>Tender</th><th>Item</th><th>Qty</th><th>Unit</th><th>Total</th><th>Status</th></tr></thead>
                    <tbody>${awards.map(a => `
                        <tr>
                            <td><strong>${escapeHtml(a.tender_serial)}</strong><div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(a.tender_name)}</div></td>
                            <td>${escapeHtml(a.name)}</td>
                            <td>${Number(a.quantity).toLocaleString()} ${escapeHtml(a.unit)}</td>
                            <td>${escapeHtml(a.currency)} ${Number(a.unit_price).toLocaleString()}</td>
                            <td style="font-weight: 700;">${escapeHtml(a.currency)} ${Number(a.line_total).toLocaleString()}</td>
                            <td><span class="badge ${a.award_status === 'approved' ? 'badge-success' : 'badge-warning'}">${escapeHtml(a.award_status)}</span></td>
                        </tr>`).join('')}</tbody>
                </table></div>`}
            </div>
        </div>
    `;
}

// ============================================
// WHO GETS ASKED (per tender)
// ============================================
// Being in the tender's category makes a vendor a candidate. Purchasing
// decides which candidates are actually approached — that decision is this
// screen, and nothing goes out until Send is pressed.

async function openTenderVendors(tenderId) {
    const container = document.getElementById('contentArea');
    showLoading(container);
    let tender, rows;
    try {
        [tender, rows] = await Promise.all([
            apiFetch(`/tenders/${tenderId}`),
            apiFetch(`/tenders/${tenderId}/vendors`),
        ]);
    } catch (err) { showLoadError(container, err, 'renderPage(AppState.currentPage)'); return; }

    const canEdit = ['admin', 'procurement'].includes(AppState.currentUser.role);
    const unsent = rows.filter(r => r.invited && !r.sent_at).length;
    // Resend only makes sense once something has gone out.
    const sentAlready = rows.filter(r => r.sent_at).length;
    // Vendors with no email on file, still waiting for somebody to reach them.
    const needManual = rows.filter(r => r.invited && r.needs_other_channel).length;

    container.innerHTML = `
        <button class="btn btn-secondary btn-sm" style="margin-bottom: 16px;" onclick="navigateTo('tenders')"><i class="fas fa-arrow-left"></i> Back</button>
        <div class="card">
            <div class="card-header">
                <div><h3 class="card-title">Who gets asked — ${escapeHtml(tender.name)}</h3>
                     <span style="font-size: 13px; color: var(--text-muted);">${escapeHtml(tender.serial)} &middot; ${escapeHtml(tender.category)} vendors</span></div>
                ${canEdit ? `
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-secondary btn-sm" onclick="saveInviteList('${tenderId}')"><i class="fas fa-floppy-disk"></i> Save list</button>
                        <button class="btn btn-accent btn-sm" onclick="sendRfq('${tenderId}')" ${unsent ? '' : 'disabled title="Nobody new to send to"'}>
                            <i class="fas fa-paper-plane"></i> Send RFQ${unsent ? ` (${unsent})` : ''}</button>
                        ${sentAlready ? `
                            <button class="btn btn-secondary btn-sm" onclick="sendRfq('${tenderId}', true)"
                                    title="Send it again to everyone, at the same links as before">
                                <i class="fas fa-rotate-right"></i> Resend</button>` : ''}
                        ${needManual ? `
                            <button class="btn btn-warning btn-sm" onclick="confirmHandover('${tenderId}')"
                                    title="Record that you gave these vendors their link yourself">
                                <i class="fas fa-check-double"></i> Confirm handed over (${needManual})</button>` : ''}
                    </div>` : ''}
            </div>
            <div class="card-body" style="padding: 0;">
                <p style="padding: 16px; margin: 0; font-size: 13px; color: var(--text-muted);">
                    Everyone below supplies <strong>${escapeHtml(tender.category_name || tender.category || '')}</strong>. Ticking a vendor doesn't email them —
                    it puts them on the list. Nothing goes out until you press Send, and each vendor gets their own link.
                </p>
                <div class="table-container">
                    <table>
                        <thead><tr><th style="width: 40px;"></th><th>Vendor</th><th>Email</th><th>Sent</th><th>Bid</th><th>Link</th></tr></thead>
                        <tbody>
                            ${rows.map(r => `
                                <tr>
                                    <td><input type="checkbox" data-invite="${r.vendor_id}" ${r.invited ? 'checked' : ''}
                                               ${(!canEdit || r.sent_at || r.submitted) ? 'disabled' : ''}></td>
                                    <td><strong>${escapeHtml(r.company_name)}</strong><div style="font-size: 12px; color: var(--text-muted);"><code>${escapeHtml(r.code)}</code></div></td>
                                    <td>${r.contact_email ? escapeHtml(r.contact_email)
                                        : `<span class="badge badge-warning"><i class="fas fa-phone"></i> hand over another way</span>`}</td>
                                    <td>${r.sent_at ? formatDate(r.sent_at) : '<span style="color: var(--text-muted);">not yet</span>'}</td>
                                    <td>${r.submitted ? '<span class="badge badge-success">quoted</span>' : '<span style="color: var(--text-muted);">—</span>'}</td>
                                    <td>${r.submission_link
                                        ? `<button class="action-btn" title="Copy this vendor's link" onclick="copyToClipboard('${escapeAttr(r.submission_link)}')"><i class="fas fa-link"></i></button>`
                                        : '<span style="color: var(--text-muted);">—</span>'}</td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

async function saveInviteList(tenderId) {
    const ids = Array.from(document.querySelectorAll('[data-invite]'))
        .filter(cb => cb.checked).map(cb => cb.dataset.invite);
    try {
        await apiFetch(`/tenders/${tenderId}/vendors`, { method: 'PUT', body: JSON.stringify({ vendor_ids: ids }) });
        showToast('success', 'List saved', `${ids.length} vendor(s) on the list — nothing sent yet`);
        openTenderVendors(tenderId);
    } catch (err) { showToast('error', 'Error', err.message); }
}

// `resend` reuses each vendor's existing token, so a vendor holding the first
// mail and a vendor holding the second end up at the same page. Issuing new
// tokens instead would quietly break every link already handed out.
async function sendRfq(tenderId, resend) {
    showConfirmDialog(
        resend ? 'Send the RFQ again' : 'Send the RFQ',
        resend
            ? 'Everyone on the list gets it again, at the same link as before. Vendors who have already bid are skipped.'
            : 'Each vendor on the list gets their own link. Vendors with no email on file will be flagged for you to reach another way.',
        async () => {
            try {
                const rows = await apiFetch(
                    `/tenders/${tenderId}/vendors/send${resend ? '?resend=true' : ''}`,
                    { method: 'POST' });
                const sent = rows.filter(r => r.sent_at).length;
                const manual = rows.filter(r => r.invited && r.needs_other_channel).length;
                showToast('success', resend ? 'RFQ resent' : 'RFQ sent',
                    `${sent} emailed${manual ? `, ${manual} need handing over another way` : ''}`);
                openTenderVendors(tenderId);
            } catch (err) { showToast('error', 'Error', err.message); }
        });
}

// Marks the no-email vendors as reached. Nothing is sent and nothing is
// proven - this records that the person pressing it says they handed the link
// over, and the audit log keeps their name against that claim.
async function confirmHandover(tenderId) {
    showConfirmDialog('Confirm handed over',
        'This records that you gave these vendors their link yourself, by phone or message. No email is sent. Only do this once they actually have it.',
        async () => {
            try {
                await apiFetch(`/tenders/${tenderId}/vendors/confirm-handover`, { method: 'POST' });
                showToast('success', 'Recorded', 'Marked as reached outside email');
                openTenderVendors(tenderId);
            } catch (err) { showToast('error', 'Error', err.message); }
        });
}

// ============================================
// UTILITIES
// ============================================
// A modal with arbitrary form markup in it. `onSubmit` returns true to close
// and false to stay open, so a validation failure doesn't throw away what the
// user typed.
function showFormDialog(title, bodyHtml, submitLabel, onSubmit) {
    const existing = document.getElementById('genericFormModal');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.id = 'genericFormModal';
    // .modal-overlay is the fixed, centred backdrop; .modal is the box inside
    // it. This used to be `modal active` wrapping `.modal-content` - two class
    // names the stylesheet has never had - so the dialog laid out as a plain
    // block at the end of <body>, below the fold. It was there the whole time,
    // just past the bottom of the page.
    wrap.className = 'modal-overlay active';
    wrap.innerHTML = `
        <div class="modal">
            <div class="modal-header"><h3 class="modal-title">${escapeHtml(title)}</h3>
                <button class="modal-close" onclick="document.getElementById('genericFormModal').remove()">&times;</button></div>
            <div class="modal-body">${bodyHtml}</div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="document.getElementById('genericFormModal').remove()">Cancel</button>
                <button class="btn btn-accent" id="genericFormSubmit">${escapeHtml(submitLabel)}</button>
            </div>
        </div>`;
    document.body.appendChild(wrap);
    // Clicking the backdrop closes it; clicking inside the box must not.
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    document.getElementById('genericFormSubmit').addEventListener('click', async () => {
        const done = await onSubmit();
        if (done !== false) wrap.remove();
    });
}

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

// A tender has no deadline until the manager who approves it sets one, so
// every screen that shows a deadline has to have an answer for "none yet".
// Printing the raw null as "- null" was that answer before this existed.
function formatDeadline(t) {
    if (!t || !t.deadline_date) return 'Not set yet';
    return `${formatDate(t.deadline_date)} at ${t.deadline_time}`;
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
    const colors = { tender_pending_approval: 'var(--warning)', tender_awarded: 'var(--success)', manager_approved: 'var(--info)', changes_requested: 'var(--warning)', sc_rejected: 'var(--danger)', submission_received: 'var(--accent-light)', offer_selected: 'var(--accent-light)' };
    return colors[type] || 'var(--text-secondary)';
}
function getNotificationIcon(type) {
    const icons = { tender_pending_approval: 'fa-clipboard-check', tender_awarded: 'fa-trophy', manager_approved: 'fa-check-circle', changes_requested: 'fa-circle-exclamation', sc_rejected: 'fa-circle-xmark', submission_received: 'fa-inbox', offer_selected: 'fa-scale-balanced' };
    return icons[type] || 'fa-bell';
}
function getNotificationLabel(type) {
    const labels = { tender_pending_approval: 'Needs Approval', tender_awarded: 'Awarded', manager_approved: 'Tender Opened', changes_requested: 'Sent Back', sc_rejected: 'Rejected', submission_received: 'New Submission', offer_selected: 'Offer Moved On' };
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
        offer_selected: 'offers',               // an offer moved a step along the chain
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

// ============================================
// WAREHOUSE: RECEIVING
// ============================================
// The warehouse sees exactly one thing — purchases that cleared every approval
// and haven't been checked in yet. By the time a shipment reaches this screen
// every decision about it has been made, so there is nothing here to decide:
// the only question left is whether the right things turned up.
//
// Who counts as the warehouse is a department, not a role. Seniority and
// function come from `departments.code` everywhere else in this app, and the
// warehouse account is an ordinary `employee` attached to Warehouse.

function isWarehouse(user) {
    const dept = currentDepartment();
    return !!(user && dept && dept.code === 'warehouse');
}

// The shipment currently open in the receive modal, so the modal's own
// controls can read its lines back without another fetch.
let receivingDraft = null;

const CONDITIONS = [
    { value: 'ok',          label: 'Arrived, as ordered' },
    { value: 'short',       label: 'Short — fewer than ordered' },
    { value: 'missing',     label: 'Missing — not in the shipment' },
    { value: 'damaged',     label: 'Damaged' },
    { value: 'wrong_item',  label: 'Wrong item sent' },
    { value: 'other',       label: 'Other' },
];

const CONDITION_LABEL = Object.fromEntries(CONDITIONS.map(c => [c.value, c.label]));

async function renderReceivingPage(container) {
    const shipments = await apiFetch('/receiving/incoming');

    if (shipments.length === 0) {
        container.innerHTML = `
            <div class="card"><div class="card-body"><div class="empty-state">
                <i class="fas fa-truck-ramp-box"></i>
                <h3>Nothing on its way</h3>
                <p>A purchase appears here once it has cleared every approval &mdash; a vendor's
                   offer or a basket, it makes no difference at the door. Until then it is
                   still being decided, and there is nothing for you to receive.</p>
            </div></div></div>`;
        return;
    }

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">On the way</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">
                        ${shipments.length} shipment(s) approved and not yet received
                    </span>
                </div>
            </div>
            <div class="card-body" style="padding: 0;">
                <div class="table-container">
                    <table class="offers-table">
                        <thead><tr>
                            <th>Tender</th>
                            <th>Supplier</th>
                            <th>Lines</th>
                            <th>Value</th>
                            <th>Approved</th>
                            <th></th>
                        </tr></thead>
                        <tbody>
                            ${shipments.map(s => `
                                <tr class="${s.urgent ? 'is-urgent' : ''}">
                                    <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(s.tender_serial)}</code>
                                        <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(s.tender_name)}</div></td>
                                    <td><strong>${escapeHtml(s.vendor_company)}</strong>
                                        <div style="font-size: 12px; color: var(--text-muted);">
                                            ${s.source === 'basket'
                                                ? '<i class="fas fa-basket-shopping"></i> Basket'
                                                : escapeHtml(s.offer_title || 'Offer')}</div></td>
                                    <td>${s.items.length}</td>
                                    <td style="font-weight: 700; color: var(--accent-light); white-space: nowrap;">
                                        ${escapeHtml(s.currency)} ${Number(s.total_amount).toLocaleString()}</td>
                                    <td style="white-space: nowrap;">${s.approved_at ? formatDateTime(s.approved_at) : '—'}</td>
                                    <td class="offer-actions">
                                        ${s.urgent ? '<span class="badge badge-danger">Urgent</span>' : ''}
                                        ${s.urgent_skipped ? '<span class="badge badge-warning" title="Approved on urgency, without the purchasing manager or supply chain">Not signed off</span>' : ''}
                                        <button class="btn btn-accent btn-sm" onclick="openReceiveModal('${s.source}', '${s.shipment_id}')">
                                            <i class="fas fa-clipboard-check"></i> Receive</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

// The check-in sheet. Every line starts ticked, because "it all arrived" is
// what usually happens and making the warehouse confirm forty lines one by one
// to record a normal delivery is how you train people to click through it
// without looking. Untick a line and it asks what went wrong.
//
// The print button is a convenience, not a step. Somebody who wants paper in
// their hand at the door prints it, walks the pallet, marks it up and types the
// result in afterwards; somebody with a tablet never touches it. Nothing here
// waits on it having been pressed.
async function openReceiveModal(source, shipmentId) {
    let shipments;
    try {
        shipments = await apiFetch('/receiving/incoming');
    } catch (err) { showToast('error', 'Error', err.message); return; }

    const shipment = shipments.find(s => s.source === source && s.shipment_id === shipmentId);
    if (!shipment) {
        showToast('error', 'Gone', 'That shipment is no longer waiting to be received');
        renderPage('receiving');
        return;
    }
    receivingDraft = shipment;

    const options = CONDITIONS.filter(c => c.value !== 'ok')
        .map(c => `<option value="${c.value}">${c.label}</option>`).join('');

    document.getElementById('receiveModalTitle').textContent =
        `Receive — ${shipment.tender_serial}`;

    document.getElementById('receiveContent').innerHTML = `
        <div class="receive-head">
            <div>
                <label>Supplier</label>
                <p><strong>${escapeHtml(shipment.vendor_company)}</strong></p>
                ${shipment.source === 'basket'
                    ? '<p style="font-size: 12px; color: var(--text-muted);">A basket &mdash; lines can come from different places</p>'
                    : ''}
            </div>
            <div>
                <label>Tender</label>
                <p>${escapeHtml(shipment.tender_serial)} — ${escapeHtml(shipment.tender_name)}</p>
            </div>
            <div>
                <label>Order value</label>
                <p style="font-weight: 700; color: var(--accent-light);">
                    ${escapeHtml(shipment.currency)} ${Number(shipment.total_amount).toLocaleString()}</p>
            </div>
        </div>

        <p class="receive-hint no-print">
            Ticked means it arrived as ordered. Untick anything that didn't, say what happened,
            and supply chain and purchasing see it. Print the sheet if you would rather mark it
            up at the door — you can type the result in afterwards.
        </p>

        <div class="table-container">
            <table class="offer-items receive-table" id="receiveTable">
                <thead><tr>
                    <th class="tick no-print">OK</th>
                    <th>#</th>
                    <th>Item</th>
                    <th>Specs</th>
                    ${shipment.source === 'basket' ? '<th>From</th>' : ''}
                    <th>Ordered</th>
                    <th>Unit price</th>
                    <th>Line total</th>
                    <th class="print-only">Checked / notes</th>
                    <th class="no-print">If not</th>
                </tr></thead>
                <tbody>
                    ${shipment.items.map((item, idx) => `
                        <tr data-item="${item.line_id}" class="${item.is_replacement ? 'row-substitute' : ''}">
                            <td class="tick no-print">
                                <input type="checkbox" checked data-ok
                                       onchange="onReceiveTick(this)"
                                       aria-label="${escapeAttr(item.name)} arrived as ordered">
                            </td>
                            <td>${idx + 1}</td>
                            <td><strong>${escapeHtml(item.name)}</strong></td>
                            <td style="font-size: 13px; color: var(--text-muted);">${escapeHtml(item.specs || '-')}</td>
                            ${shipment.source === 'basket'
                                ? `<td style="font-size: 13px;">${escapeHtml(item.vendor_name || 'Bought by purchasing')}</td>`
                                : ''}
                            <td style="white-space: nowrap;">${Number(item.quantity).toLocaleString()} ${escapeHtml(item.unit || '')}</td>
                            <td style="white-space: nowrap;">${escapeHtml(shipment.currency)} ${Number(item.unit_price).toLocaleString()}</td>
                            <td style="font-weight: 700; white-space: nowrap;">${escapeHtml(shipment.currency)} ${Number(item.line_total).toLocaleString()}</td>
                            <td class="print-only print-box"></td>
                            <td class="no-print problem-cell">
                                <div class="problem-fields hidden">
                                    <select class="form-control form-control-sm" data-condition>
                                        ${options}
                                    </select>
                                    <input type="number" class="form-control form-control-sm" data-got
                                           min="0" step="any" value="0" placeholder="Qty received"
                                           aria-label="Quantity actually received">
                                    <input type="text" class="form-control form-control-sm" data-note
                                           placeholder="What happened? (required)"
                                           aria-label="What was wrong with this line">
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <div class="form-group no-print" style="margin-top: 16px;">
            <label class="form-label">Notes on the delivery as a whole (optional)</label>
            <textarea class="form-control" id="receiveNotes" rows="2"
                      placeholder="The driver, the paperwork, the state of the pallet"></textarea>
        </div>
    `;
    openModal('receiveModal');
}

// Unticking reveals the "what went wrong" fields for that line only. The
// received-quantity box is pre-filled with the ordered amount for the
// conditions where the goods did turn up (damaged, wrong item) and zero for the
// ones where they didn't, so the common case needs no typing.
function onReceiveTick(box) {
    const row = box.closest('tr');
    const fields = row.querySelector('.problem-fields');
    fields.classList.toggle('hidden', box.checked);
    row.classList.toggle('is-flagged', !box.checked);
    if (!box.checked) {
        syncReceivedDefault(row);
        row.querySelector('[data-condition]').onchange = () => syncReceivedDefault(row);
        row.querySelector('[data-note]').focus();
    }
}

function syncReceivedDefault(row) {
    const condition = row.querySelector('[data-condition]').value;
    const got = row.querySelector('[data-got]');
    if (got.dataset.touched) return;
    const item = (receivingDraft?.items || []).find(i => i.line_id === row.dataset.item);
    const ordered = item ? Number(item.quantity) : 0;
    // Damaged and wrong-item goods physically arrived; missing ones didn't.
    got.value = ['damaged', 'wrong_item'].includes(condition) ? ordered : 0;
    got.oninput = () => { got.dataset.touched = '1'; };
}

// Opens the browser's print dialog on the sheet alone. `.no-print` hides the
// controls and `.print-only` reveals a blank column to mark up by hand — see
// the @media print block in style.css.
function printReceivingSheet() {
    document.body.classList.add('printing-receipt');
    window.print();
    // Put the screen back once the dialog closes. The timeout is for the
    // browsers that return from window.print() before the dialog is dismissed.
    setTimeout(() => document.body.classList.remove('printing-receipt'), 500);
}

async function submitReceipt() {
    if (!receivingDraft) return;
    const rows = [...document.querySelectorAll('#receiveTable tbody tr')];

    const lines = [];
    const unexplained = [];
    for (const row of rows) {
        const ok = row.querySelector('[data-ok]').checked;
        const item = receivingDraft.items.find(i => i.line_id === row.dataset.item);
        if (ok) {
            lines.push({ line_id: row.dataset.item, condition: 'ok',
                         received_quantity: Number(item.quantity) });
            continue;
        }
        const note = row.querySelector('[data-note]').value.trim();
        if (!note) { unexplained.push(item.name); continue; }
        lines.push({
            line_id: row.dataset.item,
            condition: row.querySelector('[data-condition]').value,
            received_quantity: Number(row.querySelector('[data-got]').value) || 0,
            notes: note,
        });
    }

    // Named individually rather than counted. "3 lines need a note" means
    // hunting for them down a long table.
    if (unexplained.length) {
        showToast('error', 'Say what went wrong',
            `No note on: ${unexplained.slice(0, 3).join(', ')}` +
            (unexplained.length > 3 ? ` and ${unexplained.length - 3} more` : ''));
        return;
    }

    const flagged = lines.filter(l => l.condition !== 'ok').length;
    const confirmBody = flagged
        ? `<p>${flagged} of ${lines.length} line(s) will be flagged to supply chain and purchasing.</p>
           <p style="margin-top: 10px; color: var(--text-muted);">A receipt can't be edited afterwards —
           it is the record of what was at the door.</p>`
        : `<p>Signing for all ${lines.length} line(s) as arrived and correct.</p>
           <p style="margin-top: 10px; color: var(--text-muted);">A receipt can't be edited afterwards.</p>`;

    showConfirmDialog('Check this delivery in?', confirmBody, async () => {
        try {
            const receipt = await apiFetch(`/receiving/${receivingDraft.source}/${receivingDraft.shipment_id}/receive`, {
                method: 'POST',
                body: JSON.stringify({ lines, notes: document.getElementById('receiveNotes').value.trim() || null }),
            });
            closeModal('receiveModal');
            receivingDraft = null;
            showToast('success', 'Received',
                receipt.problem_lines
                    ? `${receipt.problem_lines} line(s) flagged — supply chain and purchasing have been told`
                    : 'Everything arrived as ordered');
            renderPage('receiving');
        } catch (err) { showToast('error', 'Error', err.message); }
    });
}

// What the warehouse has already checked in. Problems first is not a sort
// preference — an "everything arrived" receipt is read once and forgotten, and
// a delivery three boxes short is the one still needing somebody.
async function renderReceiptsPage(container) {
    const receipts = await apiFetch('/receiving/receipts?limit=100');

    if (receipts.length === 0) {
        container.innerHTML = `
            <div class="card"><div class="card-body"><div class="empty-state">
                <i class="fas fa-clipboard-list"></i><h3>Nothing received yet</h3>
                <p>Deliveries you check in are kept here.</p>
            </div></div></div>`;
        return;
    }

    const sorted = [...receipts].sort((a, b) =>
        (b.problem_lines > 0) - (a.problem_lines > 0) ||
        new Date(b.received_at) - new Date(a.received_at));

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">Received</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">
                        ${receipts.length} delivery(s) &middot;
                        ${receipts.filter(r => r.problem_lines).length} with something flagged
                    </span>
                </div>
            </div>
            <div class="card-body" style="padding: 0;">
                <div class="table-container">
                    <table class="offers-table">
                        <thead><tr>
                            <th class="col-act"></th>
                            <th>Tender</th><th>Supplier</th><th>Lines</th>
                            <th>Flagged</th><th>Received</th><th>By</th>
                        </tr></thead>
                        <tbody>${sorted.map(r => receiptRow(r)).join('')}</tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

function receiptRow(r) {
    return `
        <tr class="offer-row" onclick="toggleReceiptLines(event, '${r.id}')">
            <td class="col-act"><i class="fas fa-chevron-right offer-caret" id="rcaret-${r.id}"></i></td>
            <td><code style="font-family: 'IBM Plex Mono', monospace; font-size: 12px;">${escapeHtml(r.tender_serial)}</code>
                <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(r.tender_name)}</div></td>
            <td><strong>${escapeHtml(r.vendor_company)}</strong>
                ${r.source === 'basket' ? '<div style="font-size: 12px; color: var(--text-muted);"><i class="fas fa-basket-shopping"></i> Basket</div>' : ''}</td>
            <td>${r.total_lines}</td>
            <td>${r.problem_lines
                    ? `<span class="substitute-count">${r.problem_lines}</span>`
                    : '<span class="badge badge-success">all clear</span>'}</td>
            <td style="white-space: nowrap;">${formatDateTime(r.received_at)}</td>
            <td>${escapeHtml(r.received_by_name || '—')}</td>
        </tr>
        <tr class="offer-lines hidden" id="rlines-${r.id}">
            <td colspan="7">
                ${r.notes ? `<p style="margin-bottom: 10px; font-size: 13px;">${escapeHtml(r.notes)}</p>` : ''}
                <div class="table-container"><table class="offer-items">
                    <thead><tr><th>Item</th><th>Ordered</th><th>Received</th><th>Condition</th><th>Note</th></tr></thead>
                    <tbody>${r.lines.map(l => `
                        <tr class="${l.condition !== 'ok' ? 'row-substitute' : ''}">
                            <td><strong>${escapeHtml(l.name)}</strong></td>
                            <td>${Number(l.ordered_quantity).toLocaleString()}</td>
                            <td>${Number(l.received_quantity).toLocaleString()}</td>
                            <td>${l.condition === 'ok'
                                ? '<span class="badge badge-success">ok</span>'
                                : `<span class="badge badge-warning">${escapeHtml(CONDITION_LABEL[l.condition] || l.condition)}</span>`}</td>
                            <td style="font-size: 13px; color: var(--text-muted);">${escapeHtml(l.notes || '—')}</td>
                        </tr>`).join('')}
                    </tbody>
                </table></div>
            </td>
        </tr>
    `;
}

function toggleReceiptLines(event, receiptId) {
    const lines = document.getElementById(`rlines-${receiptId}`);
    const caret = document.getElementById(`rcaret-${receiptId}`);
    if (!lines) return;
    lines.classList.toggle('hidden');
    if (caret) caret.classList.toggle('open');
}

// ---------------------------------------------------------------- the picker
//
// Choosing where a basket line comes from used to be a <select> per row. With
// three vendors bidding it was fine; with eight offers across five submissions
// it was a list of near-identical strings in a box two lines tall, and finding
// "Techno's second offer" meant reading every option.
//
// It is a modal now, grouped by the bid it arrived in, because that is how
// purchasing actually thinks about it: the question is "what did Techno quote
// for this?", not "which of these nineteen lines is cheapest". The vendor name
// is on the group heading — purchasing may see it, and by the time a basket is
// being assembled the blind comparison is over anyway.
//
// "We buy it ourselves" is an option in the same list rather than a mode set
// elsewhere. It is one more answer to the same question.

let basketPickItemId = null;
let basketPickIndex = 0;
// What has been typed into the picker's search box, kept across a repaint of
// the modal body so typing doesn't reset itself.
let basketPickSearch = '';
// Whether the vendor list is showing every category or only the tender's.
let basketPickAllCategories = false;

function openBasketPicker(itemId, index = 0) {
    if (!basketContext) return;
    basketPickItemId = itemId;
    basketPickIndex = index;
    basketPickSearch = '';
    basketPickAllCategories = false;
    drawBasketPicker();
    openModal('basketPickModal');
}

function onBasketPickSearch(value) {
    basketPickSearch = value;
    drawBasketPicker({ keepFocus: true });
}

function toggleBasketPickCategories() {
    basketPickAllCategories = !basketPickAllCategories;
    drawBasketPicker({ keepFocus: true });
}

function drawBasketPicker(opts = {}) {
    const itemId = basketPickItemId;
    const { tender, choicesByItem, vendors } = basketContext;
    const item = (tender.items || []).find(i => i.id === itemId);
    const choices = choicesByItem[itemId] || [];
    const chosen = basketPicks(itemId)[basketPickIndex] || {};
    const query = basketPickSearch.trim().toLowerCase();

    // Grouped by the submission the offer came in on, so one vendor's several
    // offers sit together.
    const groups = new Map();
    choices.forEach(({ offer, line }) => {
        const key = offer.vendor_company || 'Supplier not shown';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ offer, line });
    });

    const cheapest = choices.length
        ? Math.min(...choices.map(c => Number(c.line.unit_price))) : null;

    const groupsHtml = [...groups.entries()]
        .filter(([vendor, list]) => !query
            || vendor.toLowerCase().includes(query)
            || list.some(c => (c.line.name || '').toLowerCase().includes(query)))
        .sort((a, b) => Math.min(...a[1].map(c => Number(c.line.unit_price)))
                      - Math.min(...b[1].map(c => Number(c.line.unit_price))))
        .map(([vendor, list]) => `
            <div class="pick-group">
                <div class="pick-group-head">
                    <span class="vendor-name">${escapeHtml(vendor)}</span>
                    <span class="vendor-count">${list.length} line${list.length === 1 ? '' : 's'}</span>
                </div>
                ${list.map(({ offer, line }) => {
                    const price = Number(line.unit_price);
                    const isChosen = chosen.offer_item_id === line.id;
                    return `
                    <div class="pick-option ${isChosen ? 'is-chosen' : ''}"
                         onclick="chooseBasketSource('${line.id}')">
                        <div class="pick-main">
                            <strong>${escapeHtml(line.name)}</strong>
                            ${line.is_replacement ? '<span class="badge badge-warning">substitute</span>' : ''}
                            ${cheapest !== null && price === cheapest ? '<span class="badge badge-success">cheapest</span>' : ''}
                            <div class="pick-sub">${escapeHtml(offer.label)}${
                                line.specs ? ' &middot; ' + escapeHtml(line.specs) : ''}</div>
                        </div>
                        <div class="pick-price">
                            ${escapeHtml(tender.currency)} ${price.toLocaleString()}
                            <div class="pick-sub">${Number(line.quantity).toLocaleString()} ${escapeHtml(line.unit || '')} quoted</div>
                        </div>
                    </div>`;
                }).join('')}
            </div>`).join('');

    // The directory, narrowed to the tender's own category.
    //
    // A goods tender has no business offering a list of construction
    // contractors, and on a directory of any size the one supplier purchasing
    // meant was buried in companies that could not have supplied it. The
    // toggle is there because the category on a vendor record is a filing
    // decision somebody made once, and being wrong about it should not put a
    // supplier out of reach.
    // ANY of the vendor's categories. A company selling laptops and desks is
    // a candidate for a tender about either, and testing one column was how
    // half their catalogue used to become unreachable.
    const inCategory = (v) => basketPickAllCategories || !tender.category
        || (v.categories || []).some(c => c.slug === tender.category);
    const matching = (vendors || []).filter(inCategory);
    const hiddenByCategory = (vendors || []).length - matching.length;
    const shownVendors = matching.filter(v => !query
        || (v.company_name || '').toLowerCase().includes(query)
        || (v.code || '').toLowerCase().includes(query));

    document.getElementById('basketPickTitle').textContent =
        item ? `Where does "${item.name}" come from?` : 'Choose a source';

    document.getElementById('basketPickContent').innerHTML = `
        <p class="pick-hint">
            ${item ? `${Number(item.quantity).toLocaleString()} ${escapeHtml(item.unit || '')} needed`
                   : ''}${choices.length
                ? ` &middot; ${choices.length} quote(s) across ${groups.size} supplier(s)`
                : ' &middot; nobody quoted this line'}
            ${basketPicks(itemId).length > 1
                ? ` &middot; part ${basketPickIndex + 1} of a split` : ''}
        </p>

        <input type="search" class="form-control pick-search" id="basketPickSearch"
               placeholder="Search suppliers and quoted items"
               value="${escapeAttr(basketPickSearch)}"
               oninput="onBasketPickSearch(this.value)">

        ${groupsHtml || (query
            ? ''
            : `<p style="color: var(--text-muted); margin-bottom: 12px;">
                 No vendor priced this requirement. Buy it yourselves &mdash; from the directory or
                 from anywhere else &mdash; or leave it out of the basket.</p>`)}

        <div class="pick-group">
            <div class="pick-group-head"><span class="vendor-name">We buy it ourselves</span>
                <span class="vendor-count">not from a bid</span></div>
            <div class="pick-option ${chosen.offer_item_id == null && chosen.vendor_name != null && !chosen.vendor_id ? 'is-chosen' : ''}"
                 onclick="chooseBasketSource('__manual__')">
                <div class="pick-main">
                    <strong>From a shop or supplier we have no record for</strong>
                    <div class="pick-sub">Type the name and the price in after buying it</div>
                </div>
                <div class="pick-price"><i class="fas fa-cart-shopping"></i></div>
            </div>
            ${shownVendors.map(v => `
                <div class="pick-option ${chosen.vendor_id === v.id ? 'is-chosen' : ''}"
                     onclick="chooseBasketSource('__vendor__${v.id}')">
                    <div class="pick-main">
                        <strong>${escapeHtml(v.company_name)}</strong>
                        <span class="badge badge-info">registered</span>
                        <div class="pick-sub">${escapeHtml(v.code)}${(v.categories || []).length
                            ? ' &middot; ' + (v.categories || []).map(c => escapeHtml(c.name)).join(', ') : ''}
                            &middot; bought in person, not off a bid</div>
                    </div>
                    <div class="pick-price"><i class="fas fa-store"></i></div>
                </div>`).join('')
            || `<div class="pick-option is-empty"><div class="pick-main">
                    <span style="color: var(--text-muted);">${query
                        ? 'No supplier in the directory matches that.'
                        : 'No supplier in the directory is filed under this category.'}</span>
                 </div></div>`}
            ${hiddenByCategory > 0 || basketPickAllCategories ? `
                <div class="pick-widen">
                    ${basketPickAllCategories
                        ? `Showing every category.
                           <a href="#" onclick="event.preventDefault(); toggleBasketPickCategories();">Back to ${escapeHtml(categoryName(tender.category) || 'this category')} only</a>`
                        : `${hiddenByCategory} supplier(s) hidden as they are not filed under
                           ${escapeHtml(categoryName(tender.category) || 'this category')}.
                           <a href="#" onclick="event.preventDefault(); toggleBasketPickCategories();">Show them anyway</a>`}
                </div>` : ''}
        </div>

        <div class="pick-group">
            <div class="pick-option ${!chosen.offer_item_id && chosen.vendor_name == null ? 'is-chosen' : ''}"
                 onclick="chooseBasketSource('')">
                <div class="pick-main">
                    <strong>Not buying this</strong>
                    <div class="pick-sub">Leave the requirement out of this basket</div>
                </div>
                <div class="pick-price"><i class="fas fa-ban"></i></div>
            </div>
        </div>
    `;

    if (opts.keepFocus) {
        const box = document.getElementById('basketPickSearch');
        if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }
}

// Writes the choice into the draft and repaints the one row it changed. The
// draft is the source of truth here, not the DOM, so a later re-render of the
// whole page keeps it.
function chooseBasketSource(value) {
    const itemId = basketPickItemId;
    if (!itemId) return;
    const picks = basketPicks(itemId);
    const idx = basketPickIndex;
    // A quantity already typed against this part of the split is the user's,
    // not the source's - changing where it comes from doesn't change how many.
    const row = document.querySelector(`tr[data-row="${itemId}"][data-pick="${idx}"]`);
    const typedQty = row ? Number(row.querySelector('[data-field="qty"]').value) : null;
    const keptQty = (picks[idx] && picks[idx].quantity) != null
        ? picks[idx].quantity : typedQty;

    if (value === '__manual__') {
        picks[idx] = { offer_item_id: null, vendor_id: null, vendor_name: '',
                       unit_price: null, quantity: keptQty };
    } else if (value.startsWith('__vendor__')) {
        // Bought by hand, but from a company we already have a record for. The
        // id is what keeps it on their history in the directory; the name is
        // copied alongside it so the line still reads correctly if the vendor
        // row is ever retired.
        const vendor = (basketContext.vendors || []).find(v => v.id === value.slice(10));
        picks[idx] = vendor
            ? { offer_item_id: null, vendor_id: vendor.id, vendor_name: vendor.company_name,
                unit_price: null, quantity: keptQty }
            : {};
    } else if (value) {
        const choice = (basketContext.choicesByItem[itemId] || []).find(c => c.line.id === value);
        picks[idx] = choice
            ? {
                offer_item_id: choice.line.id,
                vendor_id: null,
                vendor_name: choice.offer.vendor_company || null,
                unit_price: Number(choice.line.unit_price),
                quantity: keptQty,
                name: choice.line.name,
              }
            : {};
    } else if (picks.length > 1) {
        // One part of a split dropped rather than the whole requirement.
        picks.splice(idx, 1);
        closeModal('basketPickModal');
        basketPickItemId = null;
        redrawBasketRequirement(itemId);
        return;
    } else {
        delete basketDraft[itemId];
    }

    closeModal('basketPickModal');
    basketPickItemId = null;
    redrawBasketRequirement(itemId);
}

// One row, from the draft. Cheaper than re-rendering the page and it keeps the
// other rows' half-typed prices intact.
function repaintBasketRow(itemId, index = 0) {
    const row = document.querySelector(`tr[data-row="${itemId}"][data-pick="${index}"]`);
    if (!row) return;
    const chosen = basketPicks(itemId)[index] || {};
    const manual = chosen.offer_item_id == null && chosen.vendor_name != null;

    const label = row.querySelector('.basket-source-label');
    if (chosen.offer_item_id) {
        const choice = (basketContext.choicesByItem[itemId] || [])
            .find(c => c.line.id === chosen.offer_item_id);
        label.innerHTML = choice
            ? `<strong>${escapeHtml(choice.offer.vendor_company || choice.offer.label)}</strong>
               <div class="pick-sub">${escapeHtml(choice.offer.label)} &middot; ${escapeHtml(choice.line.name)}</div>`
            : '<span style="color: var(--text-muted);">— choose —</span>';
    } else if (manual) {
        label.innerHTML = chosen.vendor_id
            ? `<strong>${escapeHtml(chosen.vendor_name || '')}</strong>
               <div class="pick-sub">We buy it ourselves &middot; registered vendor</div>`
            : '<strong>We buy it ourselves</strong>';
    } else {
        label.innerHTML = '<span style="color: var(--text-muted);">— not buying —</span>';
    }

    const vendorInput = row.querySelector('[data-field="vendor"]');
    const priceInput = row.querySelector('[data-field="price"]');
    const editable = row.dataset.editable === '1';

    if (manual) {
        // A registered vendor's name comes from their record, so it is shown
        // and not typed - editing it here would put a second spelling of the
        // same company on the line and quietly break the directory link.
        vendorInput.disabled = !editable || !!chosen.vendor_id;
        priceInput.disabled = !editable;
        if (chosen.vendor_name != null) vendorInput.value = chosen.vendor_name;
        if (chosen.unit_price != null) priceInput.value = chosen.unit_price;
    } else {
        // A quoted price is the vendor's figure and not ours to edit: changing
        // it here would record something they never said.
        vendorInput.value = chosen.offer_item_id ? (chosen.vendor_name || '') : '';
        priceInput.value = chosen.offer_item_id && chosen.unit_price != null ? chosen.unit_price : '';
        vendorInput.disabled = true;
        priceInput.disabled = true;
    }
}


// Put one offer line straight into the tender's basket, from the offers desk.
//
// The long way round was: leave the desk, open the basket, find the row, open
// the picker, find the offer again. Purchasing reading a good line wants to
// keep it there and then, and every step between the thought and the record is
// a step where it gets forgotten.
//
// Merges into whatever the basket already holds rather than replacing it — the
// PUT is a whole-basket write, so the current lines are read first and this one
// is layered on top. A requirement already answered is overwritten, which is
// the honest reading of "add this one instead".
async function addLineToBasket(tenderId, tenderItemId, offerItemId) {
    try {
        const award = await apiFetch(`/awards/tenders/${tenderId}`);
        if (award && !['draft', 'rejected'].includes(award.status)) {
            showToast('error', 'Basket is locked',
                `This basket is ${award.status.replace(/_/g, ' ')} and can't be changed.`);
            return;
        }

        // Quantity is carried on every line, offer-sourced ones included: a
        // requirement split across two suppliers is two saved lines, and
        // dropping their quantities would collapse both back to the full
        // quoted amount and double the order.
        const lines = (award ? award.lines : [])
            .filter(l => l.tender_item_id !== tenderItemId)
            .map(l => (l.offer_item_id
                ? { tender_item_id: l.tender_item_id, offer_item_id: l.offer_item_id,
                    quantity: l.quantity }
                : {
                    tender_item_id: l.tender_item_id, vendor_id: l.vendor_id,
                    vendor_name: l.vendor_name,
                    name: l.name, specs: l.specs, quantity: l.quantity,
                    unit: l.unit, unit_price: l.unit_price,
                  }));
        const replaced = (award ? award.lines : []).some(l => l.tender_item_id === tenderItemId);
        lines.push({ tender_item_id: tenderItemId, offer_item_id: offerItemId });

        const saved = await apiFetch(`/awards/tenders/${tenderId}`, {
            method: 'PUT', body: JSON.stringify({ lines, notes: award ? award.notes : null }),
        });
        showToast('success', replaced ? 'Swapped in the basket' : 'Added to the basket',
            `${saved.items_answered}/${saved.items_required} requirement(s) answered`);
    } catch (err) { showToast('error', 'Error', err.message); }
}
