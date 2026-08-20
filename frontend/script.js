const API_BASE = window.TENDERFLOW_API_BASE || (
    location.protocol === 'file:' || location.port === '5500'
        ? 'http://localhost:8000/api'
        : '/api'
);

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

const AppState = {
    token: localStorage.getItem('tf_token') || null,
    currentUser: null,
    currentPage: 'dashboard',
    departments: [],

    categories: [],
    tenders: [],
    submissions: [],
    unreadCount: 0,
    vendorProfile: null,
    uploadedFiles: []
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

const SAME_ORIGIN_API = API_BASE.startsWith('/');

function tunnelHeaders(headers) {
    if (SAME_ORIGIN_API) headers['ngrok-skip-browser-warning'] = 'true';
    return headers;
}

function isVendor(user) {
    return !!user && user.role === 'vendor';
}

function isEmployee(user) {
    return !!user && user.role === 'employee';
}

function isStaff(user) {
    return !!user && !isVendor(user) && !isEmployee(user);
}

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
        } catch (e) {  }
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

async function apiList(path, params = {}) {
    const page = await apiFetch(`${path}${qs({ limit: PAGE_SIZE, offset: 0, ...params })}`);
    if (!page || !Array.isArray(page.items)) {
        throw new Error(`${path} did not return a paged response`);
    }
    return page;
}

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

const pagers = {};
const pagerReloaders = {};

function pagerState(key, overrides) {
    pagers[key] = Object.assign({ limit: PAGE_SIZE, offset: 0 }, pagers[key], overrides);
    return pagers[key];
}

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

document.addEventListener('DOMContentLoaded', () => {

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

    setupRoleBasedNav();

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
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch (e) {  }
    clearSession();

    if (window.location.search) {
        window.location.replace(window.location.pathname);
        return;
    }
    showLoginPage();
}

const REQUESTER_SECTION = { section: 'My Requests', items: [
    { id: 'new-request', icon: 'fa-plus-circle', label: 'New Request' },
    { id: 'my-requests', icon: 'fa-file-contract', label: 'My Requests' }
]};

const PURCHASING_MANAGER_NAV = [
    { section: 'Main', items: [
        { id: 'dashboard', icon: 'fa-chart-pie', label: 'Dashboard' },
        { id: 'review', icon: 'fa-check-circle', label: 'Pending Reviews' },
        { id: 'tenders', icon: 'fa-file-contract', label: 'Manage Tenders' },
        { id: 'submissions', icon: 'fa-inbox', label: 'Submissions' },
        { id: 'offers', icon: 'fa-scale-balanced', label: 'Offers' },
        { id: 'history', icon: 'fa-history', label: 'Decision History' }
    ]},
    { section: 'Purchasing', items: [
        { id: 'vendors', icon: 'fa-building', label: 'Vendor Directory' },
        { id: 'templates', icon: 'fa-wand-magic-sparkles', label: 'Templates' }
    ]},
    { section: 'Settings', items: [
        { id: 'email-templates', icon: 'fa-envelope', label: 'Email Templates' },
        { id: 'email-log', icon: 'fa-history', label: 'Email Log' }
    ]},
    REQUESTER_SECTION
];

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
                { id: 'templates', icon: 'fa-wand-magic-sparkles', label: 'Templates' },
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
                { id: 'vendors', icon: 'fa-building', label: 'Vendor Directory' },
                { id: 'templates', icon: 'fa-wand-magic-sparkles', label: 'Templates' }
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

        employee: [
            { section: 'Main', items: [
                { id: 'my-requests', icon: 'fa-file-contract', label: 'My Requests' },
                { id: 'new-request', icon: 'fa-plus-circle', label: 'New Request' }
            ]}
        ]
    };

    const config = isWarehouse(AppState.currentUser)
        ? WAREHOUSE_NAV
        : isPurchasingManager(AppState.currentUser)
            ? PURCHASING_MANAGER_NAV
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
        receiving: 'Receiving', receipts: 'Received', categories: 'Categories',
        templates: 'Quick-fill Templates'
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
            case 'templates': await renderTemplatesPage(contentArea); break;
            case 'receiving': await renderReceivingPage(contentArea); break;
            case 'receipts': await renderReceiptsPage(contentArea); break;
            default:

                if (isWarehouse(AppState.currentUser)) await renderDashboard(contentArea);
                else if (isStaff(AppState.currentUser)) await renderDashboard(contentArea);
                else if (isEmployee(AppState.currentUser)) await renderMyRequestsPage(contentArea);
                else await renderMyRequestsPage(contentArea);
        }
    } catch (err) {
        showLoadError(contentArea, err, `navigateTo('${page}')`);
    }
}

function categoryName(slug) {
    if (!slug) return '';
    const hit = (AppState.categories || []).find(c => c.slug === slug);
    return hit ? hit.name : slug;
}

function categoryOptions(selected) {
    const list = [...(AppState.categories || [])];
    if (selected && !list.some(c => c.slug === selected)) {
        list.push({ slug: selected, name: categoryName(selected) + ' (retired)' });
    }
    return list.map(c =>
        `<option value="${escapeAttr(c.slug)}" ${c.slug === selected ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
    ).join('');
}

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

async function renderDashboard(container) {
    const user = AppState.currentUser;
    if (isWarehouse(user))          return renderWarehouseDashboard(container);
    if (isPurchasingManager(user))  return renderPurchasingManagerDashboard(container);
    if (user.role === 'manager')    return renderDepartmentManagerDashboard(container);
    if (user.role === 'supply_chain') return renderSupplyChainDashboard(container);
    return renderProcurementDashboard(container);
}

async function collectOffers() {
    const tenders = (await apiAll('/tenders')).filter(t => (t.submission_count || 0) > 0);
    const rows = await Promise.all(tenders.map(async tender => {
        try {
            return { tender, offers: await apiFetch(`/offers?tender_id=${tender.id}`) };
        } catch (err) {
            return null;
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

function skippedBasketPanel(awards) {
    if (!awards.length) return '';
    return dashPanel(
        'Approved without you',
        `${awards.length} urgent basket(s) bought before you were asked`,
        dashTable(['Tender', 'Bought as', 'Covers', 'Total', ''],
            basketSkippedRows(awards.slice(0, 8)), 'fa-bolt', '')
    );
}

function openOffersFor(tenderId) {
    offersTenderId = tenderId;
    navigateTo('offers', { keepContext: true });
}

function openSubmissionsFor(tenderId) {
    submissionsTenderId = tenderId;
    navigateTo('submissions', { keepContext: true });
}

async function renderPurchasingManagerDashboard(container) {
    const [withOffers, open, activity, baskets, done] = await Promise.all([
        collectOffers(),
        apiList('/tenders', { status: 'open', limit: 20 }),
        myRecentActivity(),
        apiFetch('/awards?status=submitted').catch(() => []),
        apiFetch('/awards?status=approved').catch(() => []),
    ]);
    const skipped = done.filter(a => a.urgent_skipped);

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

async function renderDepartmentManagerDashboard(container) {
    const [pending, withOffers, activity] = await Promise.all([
        apiAll('/tenders', { status: 'pending_approval' }),
        collectOffers(),
        myRecentActivity(),
    ]);

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

async function renderWarehouseDashboard(container) {
    const [incoming, receipts, activity] = await Promise.all([
        apiFetch('/receiving/incoming').catch(() => []),
        apiFetch('/receiving/receipts?limit=50').catch(() => []),
        myRecentActivity(),
    ]);

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

async function renderProcurementDashboard(container) {
    const [recent, open, allSubs, pendingSubs, withOffers] = await Promise.all([
        apiList('/tenders', { limit: 6 }),
        apiList('/tenders', { status: 'open', limit: 1 }),
        apiList('/submissions', { limit: 1 }),
        apiAll('/submissions', { status: 'pending' }),
        collectOffers(),
    ]);

    const canManage = canPurchase();

    const needFiltering = withOffers
        .map(({ tender, offers }) => ({ tender, n: offers.filter(o => o.status === 'pending').length }))
        .filter(row => row.n > 0)
        .sort((a, b) => b.n - a.n);

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

async function renderTendersPage(container) {
    pagerReloaders.tenders = () => renderTendersPage(container);
    const state = pagerState('tenders');

    const page = await apiList('/tenders', { ...pagerParams('tenders'), status: state.status });
    AppState.tenders = page.items;
    const canManage = canPurchase();
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
    const canManage = canPurchase();
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

function isTenderExpired(tender) {

    if (typeof tender.is_expired === 'boolean') return tender.is_expired;

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
    const canManage = canPurchase();

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

function itemRowHtml(item) {

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

function renumberItemRows(bodyId = 'tenderItemsBody') {
    const body = typeof bodyId === 'string' ? document.getElementById(bodyId) : bodyId;
    if (!body) return;
    Array.from(body.querySelectorAll('tr.item-row')).forEach((tr, i) => {
        tr.querySelector('.col-num').textContent = i + 1;
    });
}

function addItemRow(item, bodyId = 'tenderItemsBody') {
    const body = typeof bodyId === 'string' ? document.getElementById(bodyId) : bodyId;
    if (!body) return;
    body.insertAdjacentHTML('beforeend', itemRowHtml(item));
    renumberItemRows(body);
    if (!item) {
        const rows = body.querySelectorAll('tr.item-row');
        rows[rows.length - 1].querySelector('.item-name').focus();
    }
}

function removeItemRow(btn) {

    const body = btn.closest('tbody');
    btn.closest('tr').remove();

    if (!body.querySelector('tr.item-row')) addItemRow(null, body);
    renumberItemRows(body);
}

function setItemRows(items, bodyId = 'tenderItemsBody') {
    const body = typeof bodyId === 'string' ? document.getElementById(bodyId) : bodyId;
    if (!body) return;
    body.innerHTML = '';
    const rows = (items && items.length) ? items : [null];
    rows.forEach(item => body.insertAdjacentHTML('beforeend', itemRowHtml(item)));
    renumberItemRows(body);
}

function collectItemRows(bodyId = 'tenderItemsBody') {
    const body = typeof bodyId === 'string' ? document.getElementById(bodyId) : bodyId;
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

    }).filter(row => row.name);
}

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

function canEditTender(tender) {
    const user = AppState.currentUser;
    if (!user || !tender) return false;
    if (user.role === 'admin') return true;
    if (user.role !== 'manager' || isPurchasingManager(user)) return false;

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

    const pills = document.getElementById('templatePills');
    if (pills) pills.innerHTML = '';
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

    const templateId = (document.getElementById('tenderTemplateId') || {}).value || null;
    return { name, category, items, ...(templateId ? { template_id: templateId } : {}) };
}

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

    fillTenderCategories(null);
    document.getElementById('tenderTemplateId').value = '';

    loadTemplatePills();
    showRequesterDepartment();
    setItemRows(null);
    const forEmployee = isEmployee(AppState.currentUser);
    document.getElementById('tenderModalTitle').textContent = forEmployee ? 'New Request' : 'Create New Tender';
    const btn = document.getElementById('tenderModalSubmitBtn');
    btn.innerHTML = forEmployee
        ? '<i class="fas fa-paper-plane"></i> Submit for Approval'
        : '<i class="fas fa-plus"></i> Create Tender';
}

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

let myRequestRows = [];

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

    openCreateTenderModal();
}

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

    if (submissionsTenderId && tenders.some(t => t.id === submissionsTenderId)) {
        const id = submissionsTenderId;
        submissionsTenderId = null;
        openTenderSubmissions(id);
    }
}

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

        const best = offers.length
            ? offers.reduce((a, b) => (b.total_amount < a.total_amount ? b : a))
            : null;
        const lowest = best ? best.total_amount : sub.total_amount;
        const missing = best ? best.missing_items : null;

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

function filterAuditByAction(action) {
    pagerFilter('audit', { action: action.trim() || null });
    renderAuditLog(document.getElementById('contentArea'));
}

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

function openTenderFor(tenderId) {
    if (['manager', 'admin'].includes(AppState.currentUser?.role)) {
        return openTenderReview(tenderId);
    }
    return viewTender(tenderId);
}

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

                return false;
            }
        }
    );
}

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

async function renderManagerHistoryPage(container) {
    pagerReloaders.history = () => renderManagerHistoryPage(container);

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

const shortlistDraft = {};

function currentDepartment() {
    const user = AppState.currentUser;
    if (!user || !user.department_id) return null;
    return (AppState.departments || []).find(d => d.id === user.department_id) || null;
}

function canPurchase(user = AppState.currentUser) {
    return !!user && (['admin', 'procurement'].includes(user.role) || isPurchasingManager(user));
}

function isPurchasingManager(user) {
    const dept = currentDepartment();
    return user && user.role === 'manager' && dept && dept.code === 'purchasing';
}

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

function canForward(user) {
    return canPurchase(user);
}

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

    const canBasket = canPurchase()
        && tender && tender.status !== 'awarded';

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

    const offer_ids = entries.sort((a, b) => Number(a[1]) - Number(b[1])).map(([id]) => id);

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

    if (offer_ids.length < already) {
        showConfirmDialog('Take offers back',
            `${already - offer_ids.length} offer(s) will disappear from the manager's list. `
            + "Offers they have already shortlisted can't be pulled back this way - reject "
            + 'those instead, with a reason.', send);
        return;
    }
    await send();
}

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

let offersTenderId = null;

async function renderOffersDeskPage(container) {
    const user = AppState.currentUser;
    const desk = deskFor(user);
    const shortlisting = canShortlist(user);
    const forwarding = canForward(user);
    const isAdmin = user.role === 'admin';

    const tenders = (await apiAll('/tenders')).filter(t => (t.submission_count || 0) > 0);
    AppState.tenders = tenders;

    const withOffers = await Promise.all(tenders.map(async tender => {
        try {
            return { tender, offers: await apiFetch(`/offers?tender_id=${tender.id}&include_rejected=true`) };
        } catch (err) {

            return null;
        }
    }));

    const rows = withOffers.filter(row => row && row.offers.length > 0);
    let live = rows.filter(row => row.offers.some(o => o.status !== 'rejected'));

    const shortlistSent = (row) => row.offers.some(o =>
        ['selected', 'purchasing_ok', 'purchasing_manager_ok', 'approved'].includes(o.status));
    const sealedAway = shortlisting && !isAdmin ? live.filter(shortlistSent).length : 0;
    if (shortlisting && !isAdmin) live = live.filter(row => !shortlistSent(row));

    const waitingOnMe = (row) => {
        if (isAdmin) return true;

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

    if (offersTenderId && !live.some(r => r.tender.id === offersTenderId)) {
        offersTenderId = null;
    }
    const current = live.find(r => r.tender.id === offersTenderId) || null;

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

    const sentUp = offers.filter(o => o.forwarded_at && o.status !== 'rejected').length;
    const hasShortlist = offers.some(o => o.status === 'selected');

    const managerReplied = offers.some(o =>
        ['selected', 'purchasing_ok', 'purchasing_manager_ok', 'approved'].includes(o.status));

    const rowOpts = (offer) => ({
        forwarding,

        forwardLocked: !!offer.forwarded_at && offer.status !== 'forwarded',
        shortlisting: shortlisting || isAdmin,
        approvable: !!(approvableStatus && offer.status === approvableStatus)
            || (isAdmin && ['selected', 'purchasing_ok', 'purchasing_manager_ok'].includes(offer.status))

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

                || (forwarding && offer.status === 'pending')
                || (shortlisting && offer.status === 'forwarded')
                || (desk && offer.status === desk.status)

                || (forwarding && ['purchasing_ok', 'purchasing_manager_ok', 'approved'].includes(offer.status)))
    });

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

async function renderFinanceNotificationsPage(container) {
    pagerReloaders.notifications = () => renderFinanceNotificationsPage(container);

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

const AWARD_STATUS_META = {
    draft:                 { label: 'Draft',                badge: '' },
    submitted:             { label: 'With purchasing mgr',  badge: 'badge-warning' },
    purchasing_manager_ok: { label: 'With supply chain',    badge: 'badge-warning' },
    approved:              { label: 'Approved',             badge: 'badge-success' },
    rejected:              { label: 'Rejected',             badge: 'badge-danger' },
};

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

            apiList('/vendors', { limit: 200, active: true }).catch(() => ({ items: [] })),
        ]);
    } catch (err) { showLoadError(container, err, 'renderPage(AppState.currentPage)'); return; }
    const vendors = (vendorPage.items || []).filter(v => v.active !== false);

    const role = AppState.currentUser.role;
    const isPurchasing = canPurchase();
    const status = award ? award.status : null;
    const editable = isPurchasing && (!award || status === 'draft' || status === 'rejected');

    const choicesByItem = {};
    offers.forEach(offer => (offer.items || []).forEach(line => {
        if (!line.tender_item_id) return;
        (choicesByItem[line.tender_item_id] = choicesByItem[line.tender_item_id] || []).push({ offer, line });
    }));
    Object.values(choicesByItem).forEach(list => list.sort((a, b) => a.line.unit_price - b.line.unit_price));

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

    (tender.items || []).forEach(item => repaintRequirementRows(item.id));
    recalcBasket();
}

let basketContext = null;

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

function splitBasketRow(itemId) {
    const picks = basketPicks(itemId);
    const item = basketContext.tender.items.find(i => i.id === itemId);
    const rows = [...document.querySelectorAll(`tr[data-row="${itemId}"]`)];

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

    [...document.querySelectorAll(`tr[data-row="${itemId}"]`)].forEach((row, idx) => {
        if (!picks[idx]) return;
        picks[idx].quantity = Number(row.querySelector('[data-field="qty"]').value) || 0;
    });
    picks.splice(index, 1);
    redrawBasketRequirement(itemId);
}

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

function collectBasketLines() {
    const lines = [];
    document.querySelectorAll('tr[data-row]').forEach(row => {
        const itemId = row.dataset.row;
        const idx = Number(row.dataset.pick);
        const chosen = basketPicks(itemId)[idx];
        if (!chosen) return;

        const item = basketContext.tender.items.find(i => i.id === itemId);
        const quantity = Number(row.querySelector('[data-field="qty"]').value || 0);
        if (quantity <= 0) return;

        if (chosen.offer_item_id) {
            lines.push({
                tender_item_id: itemId,
                offer_item_id: chosen.offer_item_id,
                quantity,
            });
            return;
        }

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

let templatesCategory = '';

async function renderTemplatesPage(container) {
    const canEdit = canPurchase();

    let page;
    try {
        page = await apiList('/templates', {
            limit: 200,
            include_inactive: canEdit,
            ...(templatesCategory ? { category: templatesCategory } : {}),
        });
    } catch (err) { showLoadError(container, err, "renderPage('templates')"); return; }

    const templates = page.items || [];

    container.innerHTML = `
        <div class="card" style="margin-bottom: 20px;">
            <div class="card-body offers-picker">
                <label for="templatesCategoryPicker">Category</label>
                <select class="form-control" id="templatesCategoryPicker"
                        onchange="onTemplatesCategoryChange(this.value)">
                    <option value="" ${templatesCategory ? '' : 'selected'}>All categories</option>
                    ${(AppState.categories || []).map(c => `
                        <option value="${escapeAttr(c.slug)}" ${c.slug === templatesCategory ? 'selected' : ''}>
                            ${escapeHtml(c.name)}</option>`).join('')}
                </select>
                ${canEdit ? `<button class="btn btn-accent btn-sm" onclick="openTemplateModal(null)">
                    <i class="fas fa-plus"></i> New template</button>` : ''}
            </div>
        </div>

        <div class="card">
            <div class="card-header">
                <div>
                    <h3 class="card-title" style="margin-bottom: 4px;">Quick-fill templates</h3>
                    <span style="font-size: 13px; color: var(--text-muted);">
                        ${templates.length} template(s)${templatesCategory
                            ? ` for ${escapeHtml(categoryName(templatesCategory))}` : ''}
                        &middot; ${canEdit
                            ? 'press one to edit what it fills in'
                            : 'these appear as pills on the request form'}
                    </span>
                </div>
            </div>
            <div class="card-body" style="padding: 0;">
                ${templates.length === 0 ? `
                    <div style="padding: 24px;"><div class="empty-state">
                        <i class="fas fa-wand-magic-sparkles"></i>
                        <h3>Nothing here yet</h3>
                        <p>${canEdit
                            ? 'A template is a purchase that comes round again — write the requirement table once and everybody raising it presses a pill instead of retyping it.'
                            : 'Purchasing has not set up any templates for this category yet.'}</p>
                    </div></div>
                ` : `
                <div class="table-container">
                    <table class="offers-table">
                        <thead><tr>
                            <th>Template</th>
                            <th>Category</th>
                            <th>Department</th>
                            <th>Items</th>
                            <th>Documents</th>
                            <th>Deadline</th>
                            ${canEdit ? '<th>Status</th><th></th>' : ''}
                        </tr></thead>
                        <tbody>${templates.map(t => `
                            <tr class="offer-row ${t.active ? '' : 'is-rejected'}"
                                onclick="${canEdit ? `openTemplateModal('${t.id}')` : `useTemplateFromList('${t.id}')`}">
                                <td><strong>${escapeHtml(t.name)}</strong>
                                    ${t.description ? `<div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.description)}</div>` : ''}</td>
                                <td><span class="badge badge-info">${escapeHtml(t.category_name || t.category || '')}</span></td>
                                <td>${t.department_id
                                    ? `<span class="badge badge-warning">${escapeHtml(deptName(t.department_id))}</span>`
                                    : '<span class="badge">All departments</span>'}</td>
                                <td>${(t.items || []).length}</td>
                                <td>${(t.required_docs || []).length || '<span style="color: var(--text-muted);">&mdash;</span>'}</td>
                                <td style="white-space: nowrap;">${t.default_deadline_days} day(s)</td>
                                ${canEdit ? `
                                    <td><span class="badge ${t.active ? 'badge-success' : 'badge-secondary'}">
                                        ${t.active ? 'Active' : 'Retired'}</span></td>
                                    <td class="offer-actions">
                                        <button class="btn btn-secondary btn-sm"
                                                onclick="event.stopPropagation(); openTemplateModal('${t.id}')">Edit</button>
                                    </td>` : ''}
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>`}
            </div>
        </div>
    `;
}

function onTemplatesCategoryChange(slug) {
    templatesCategory = slug || '';
    renderPage('templates');
}

function useTemplateFromList(templateId) {
    openCreateTenderModal();
    setTimeout(() => applyTemplate(templateId), 60);
}

async function openTemplateModal(templateId) {
    let template = null;
    if (templateId) {
        try { template = await apiFetch(`/templates/${templateId}`); }
        catch (err) { showToast('error', 'Error', err.message); return; }
    }

    const currencies = (typeof CURRENCIES !== 'undefined' ? CURRENCIES : ['EGP'])
        .map(c => `<option value="${c}" ${template && c === template.currency ? 'selected' : ''}>${c}</option>`)
        .join('');

    document.getElementById('templateModalTitle').textContent =
        template ? `Template — ${template.name}` : 'New template';
    document.getElementById('templateId').value = template ? template.id : '';

    document.getElementById('templateFields').innerHTML = `
        <div class="form-row">
            <div class="form-group">
                <label>Template name *</label>
                <input type="text" class="form-control" id="tplName"
                       value="${escapeAttr(template ? template.name : '')}"
                       placeholder="Annual laptop refresh">
            </div>
            <div class="form-group">
                <label>Category *</label>
                <select class="form-control" id="tplCategory">
                    ${categoryOptions(template ? template.category : (AppState.categories || [])[0]?.slug)}
                </select>
                <small class="form-hint">Decides which vendors can be invited to anything raised from it.</small>
            </div>
            <div class="form-group">
                <label>Department</label>
                <select class="form-control" id="tplDepartment">
                    <option value="">All departments</option>
                    ${(AppState.departments || []).map(d => `
                        <option value="${d.id}" ${template && template.department_id === d.id ? 'selected' : ''}>
                            ${escapeHtml(d.name)}</option>`).join('')}
                </select>
                <small class="form-hint">Leave on "all" for something anyone might raise.</small>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label>Currency</label>
                <select class="form-control" id="tplCurrency">${currencies}</select>
            </div>
            <div class="form-group">
                <label>Usual deadline</label>
                <input type="number" class="form-control" id="tplDays" min="1"
                       value="${template ? template.default_deadline_days : 14}">
                <small class="form-hint">Days out. Offered to the manager approving it, never applied behind them.</small>
            </div>
            <div class="form-group">
                <label>Required documents</label>
                <input type="text" class="form-control" id="tplDocs"
                       value="${escapeAttr((template && template.required_docs || []).join(', '))}"
                       placeholder="Tax card, Commercial register">
                <small class="form-hint">Separate with commas. Vendors get an upload box for each.</small>
            </div>
        </div>
        <div class="form-group full-width">
            <label>Description</label>
            <input type="text" class="form-control" id="tplDescription"
                   value="${escapeAttr(template ? template.description : '')}"
                   placeholder="What this template is for">
        </div>
    `;

    setItemRows(template ? template.items : null, 'templateItemsBody');

    document.getElementById('templateRetireBtn').style.display =
        template ? 'inline-flex' : 'none';
    if (template) {
        const btn = document.getElementById('templateRetireBtn');
        btn.innerHTML = template.active
            ? '<i class="fas fa-power-off"></i> Retire'
            : '<i class="fas fa-power-off"></i> Reinstate';
        btn.onclick = () => saveTemplate(!template.active);
    }
    openModal('templateModal');
}

async function saveTemplate(active = true) {
    const id = document.getElementById('templateId').value;
    const name = document.getElementById('tplName').value.trim();
    if (!name) { showToast('error', 'Name required', 'A template needs a name'); return; }

    const items = collectItemRows('templateItemsBody');
    if (!items.length) {
        showToast('error', 'Nothing in it',
            'A template with no requirement table saves nobody any typing');
        return;
    }

    const payload = {
        name,
        description: document.getElementById('tplDescription').value.trim(),
        category: document.getElementById('tplCategory').value,
        department_id: document.getElementById('tplDepartment').value || null,
        currency: document.getElementById('tplCurrency').value,
        default_deadline_days: Number(document.getElementById('tplDays').value) || 14,
        required_docs: document.getElementById('tplDocs').value
            .split(',').map(d => d.trim()).filter(Boolean),
        items,
        active,
    };

    try {
        if (id) {
            await apiFetch(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
            showToast('success', 'Saved', `${name} updated`);
        } else {
            await apiFetch('/templates', { method: 'POST', body: JSON.stringify(payload) });
            showToast('success', 'Template created', `${name} is ready to use`);
        }
        closeModal('templateModal');
        renderPage('templates');
    } catch (err) { showToast('error', 'Error', err.message); }
}

let templatePills = [];

async function loadTemplatePills() {
    const strip = document.getElementById('templatePills');
    if (!strip) return;
    const user = AppState.currentUser;
    try {
        const page = await apiList('/templates', {
            limit: 50,
            ...(user && user.department_id ? { department_id: user.department_id } : {}),
        });
        templatePills = page.items || [];
    } catch (err) { templatePills = []; }

    if (!templatePills.length) { strip.innerHTML = ''; return; }
    strip.innerHTML = `
        <span class="pill-label">Start from</span>
        ${templatePills.map(t => `
            <button type="button" class="template-pill" onclick="applyTemplate('${t.id}')"
                    title="${escapeAttr(t.description || t.name)}">
                <i class="fas fa-wand-magic-sparkles"></i> ${escapeHtml(t.name)}
                <span class="pill-count">${(t.items || []).length}</span>
            </button>`).join('')}
        <button type="button" class="template-pill is-clear" onclick="clearTemplate()"
                title="Start from an empty form">Blank</button>
    `;
}

function applyTemplate(templateId) {
    const template = templatePills.find(t => t.id === templateId);
    if (!template) {

        apiFetch(`/templates/${templateId}`).then(t => {
            templatePills = [...templatePills, t];
            applyTemplate(templateId);
        }).catch(err => showToast('error', 'Error', err.message));
        return;
    }
    document.getElementById('tenderName').value = template.name;
    fillTenderCategories(template.category);
    setItemRows(template.items);

    document.getElementById('tenderTemplateId').value = template.id;
    document.querySelectorAll('#templatePills .template-pill').forEach(b =>
        b.classList.toggle('is-active', b.getAttribute('onclick').includes(templateId)));
    showToast('info', 'Filled in from a template',
        `${(template.items || []).length} row(s) — change anything you like before sending`);
}

function clearTemplate() {
    document.getElementById('tenderName').value = '';
    setItemRows(null);
    document.getElementById('tenderTemplateId').value = '';
    document.querySelectorAll('#templatePills .template-pill').forEach(b =>
        b.classList.remove('is-active'));
}

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

async function refreshCategoryCache() {
    try { AppState.categories = await apiFetch('/categories'); } catch (err) {  }
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

async function renderVendorDirectoryPage(container) {
    pagerReloaders.vendors = () => renderVendorDirectoryPage(container);
    const page = await apiList('/vendors', pagerParams('vendors'));
    const canEdit = canPurchase();

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

function vendorFormBody(vendor) {
    const chosen = new Set((vendor && vendor.categories || []).map(c => c.slug));
    const list = [...(AppState.categories || [])];

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

    const canEdit = canPurchase();
    const unsent = rows.filter(r => r.invited && !r.sent_at).length;

    const sentAlready = rows.filter(r => r.sent_at).length;

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

function showFormDialog(title, bodyHtml, submitLabel, onSubmit) {
    const existing = document.getElementById('genericFormModal');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.id = 'genericFormModal';

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

function formatDeadline(t) {
    if (!t || !t.deadline_date) return 'Not set yet';
    return `${formatDate(t.deadline_date)} at ${t.deadline_time}`;
}

function formatDateTime(dateString) {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

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
    try { await apiFetch(`/notifications/${notificationId}/read`, { method: 'POST' }); } catch (e) {  }
    document.getElementById('notificationDropdown').classList.remove('active');

    if (isEmployee(AppState.currentUser)) {
        navigateTo('my-requests');
        refreshNotificationBadgeOnly();
        return;
    }

    const destinations = {
        tender_pending_approval: 'review',
        manager_approved: 'tenders',
        changes_requested: 'tenders',
        submission_received: 'submissions',
        offer_selected: 'offers',
        sc_rejected: 'history',
        tender_awarded: 'notifications'
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

        const { unread } = await apiFetch('/notifications/unread-count');
        AppState.unreadCount = unread;
        updateNotificationBadge();
    } catch (err) {  }
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

function isWarehouse(user) {
    const dept = currentDepartment();
    return !!(user && dept && dept.code === 'warehouse');
}

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

    got.value = ['damaged', 'wrong_item'].includes(condition) ? ordered : 0;
    got.oninput = () => { got.dataset.touched = '1'; };
}

function printReceivingSheet() {
    document.body.classList.add('printing-receipt');
    window.print();

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

let basketPickItemId = null;
let basketPickIndex = 0;

let basketPickSearch = '';

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

function chooseBasketSource(value) {
    const itemId = basketPickItemId;
    if (!itemId) return;
    const picks = basketPicks(itemId);
    const idx = basketPickIndex;

    const row = document.querySelector(`tr[data-row="${itemId}"][data-pick="${idx}"]`);
    const typedQty = row ? Number(row.querySelector('[data-field="qty"]').value) : null;
    const keptQty = (picks[idx] && picks[idx].quantity) != null
        ? picks[idx].quantity : typedQty;

    if (value === '__manual__') {
        picks[idx] = { offer_item_id: null, vendor_id: null, vendor_name: '',
                       unit_price: null, quantity: keptQty };
    } else if (value.startsWith('__vendor__')) {

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

        vendorInput.disabled = !editable || !!chosen.vendor_id;
        priceInput.disabled = !editable;
        if (chosen.vendor_name != null) vendorInput.value = chosen.vendor_name;
        if (chosen.unit_price != null) priceInput.value = chosen.unit_price;
    } else {

        vendorInput.value = chosen.offer_item_id ? (chosen.vendor_name || '') : '';
        priceInput.value = chosen.offer_item_id && chosen.unit_price != null ? chosen.unit_price : '';
        vendorInput.disabled = true;
        priceInput.disabled = true;
    }
}

async function addLineToBasket(tenderId, tenderItemId, offerItemId) {
    try {
        const award = await apiFetch(`/awards/tenders/${tenderId}`);
        if (award && !['draft', 'rejected'].includes(award.status)) {
            showToast('error', 'Basket is locked',
                `This basket is ${award.status.replace(/_/g, ' ')} and can't be changed.`);
            return;
        }

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
