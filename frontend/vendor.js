const API_BASE = window.TENDERFLOW_API_BASE || (
    location.protocol === 'file:' || location.port === '5500'
        ? 'http://localhost:8000/api'
        : '/api'
);

const TUNNEL_HEADERS = API_BASE.startsWith('/')
    ? { 'ngrok-skip-browser-warning': 'true' }
    : {};

const state = {
    token: null,
    tender: null,
    vendor: null,

    offers: [],

    editing: null,
    submitting: false,
};

const $ = (id) => document.getElementById(id);
const page = () => $('page');
let seq = 0;

function esc(value) {
    if (value === null || value === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(value);
    return d.innerHTML;
}

function escAttr(value) {
    return esc(value).replace(/"/g, '&quot;');
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function filled(value) {
    return String(value === null || value === undefined ? '' : value).trim() !== '';
}

function money(amount) {
    const currency = state.tender ? state.tender.currency : '';
    return `${currency} ${num(amount).toLocaleString(undefined, {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
    })}`;
}

function formatDeadline(t) {
    if (!t || !t.deadline_date) return 'no closing date set';
    const d = new Date(`${t.deadline_date}T${t.deadline_time || '00:00'}`);
    if (isNaN(d)) return `${t.deadline_date} ${t.deadline_time || ''}`.trim();
    return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function toast(message, bad) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
}

const ICON = {
    warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    broken: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#8592a8" stroke-width="1.5" stroke-linecap="round"><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 4.5 7.2M8 12h3M2 2l20 20"/></svg>',
    locked: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#8592a8" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    done: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#158a5a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>',
    empty: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#8592a8" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15h6M12 12v6"/></svg>',
    plus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
};

function showState(icon, heading, body) {
    page().innerHTML = `
        <div class="card"><div class="state">
            ${icon}
            <h2>${esc(heading)}</h2>
            <p>${esc(body)}</p>
        </div></div>`;
}

function draftKey() {
    return `tenderflow.draft.${state.token}`;
}

function saveDrafts() {
    try {
        localStorage.setItem(draftKey(), JSON.stringify(state.offers));
    } catch (err) {

    }
}

function loadDrafts() {
    try {
        const raw = localStorage.getItem(draftKey());
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) state.offers = parsed;
    } catch (err) {
        state.offers = [];
    }
}

function clearDrafts() {
    try { localStorage.removeItem(draftKey()); } catch (err) {  }
}

function itemsById() {
    return new Map((state.tender.items || []).map((i) => [i.id, i]));
}

function offerLines(offer) {
    const byId = itemsById();
    const lines = [];

    (state.tender.items || []).forEach((item) => {
        const pick = offer.picked[item.id];
        if (!pick) return;
        const qty = num(pick.qty);
        const price = num(pick.price);

        if (qty <= 0 || !filled(pick.price) || price < 0) return;
        lines.push({
            tender_item_id: item.id,
            is_replacement: false,
            name: item.name,
            specs: item.specs || null,
            notes: null,
            quantity: qty,
            unit: item.unit,
            unit_price: price,
        });
    });

    (offer.extras || []).forEach((extra) => {
        const qty = num(extra.qty);
        const price = num(extra.price);
        if (!extra.name || !extra.name.trim() || qty <= 0) return;
        if (!filled(extra.price) || price < 0) return;
        const replaced = extra.replaces ? byId.get(extra.replaces) : null;
        lines.push({
            tender_item_id: replaced ? replaced.id : null,

            is_replacement: !!replaced,
            name: extra.name.trim(),
            specs: (extra.specs || '').trim() || null,
            notes: null,
            quantity: qty,
            unit: (extra.unit || '').trim() || 'pcs',
            unit_price: price,
        });
    });

    return lines;
}

function offerTotal(offer) {
    return offerLines(offer).reduce((sum, l) => sum + l.quantity * l.unit_price, 0);
}

function offerCoverage(offer) {
    const lines = offerLines(offer);
    const answered = new Set(lines.filter((l) => l.tender_item_id).map((l) => l.tender_item_id));
    return {
        covered: answered.size,
        of: (state.tender.items || []).length,
        extras: lines.filter((l) => !l.tender_item_id).length,
        replacements: lines.filter((l) => l.is_replacement).length,
    };
}

function overSupplied(offer) {
    const byId = itemsById();
    const totals = new Map();
    offerLines(offer).forEach((l) => {
        if (!l.tender_item_id) return;
        totals.set(l.tender_item_id, (totals.get(l.tender_item_id) || 0) + l.quantity);
    });
    const over = [];
    totals.forEach((offered, id) => {
        const item = byId.get(id);
        if (item && offered > num(item.quantity)) over.push(item.name);
    });
    return over;
}

function blankOffer() {
    seq += 1;
    return { id: `d${Date.now()}${seq}`, title: '', notes: '', picked: {}, extras: [] };
}

function offerLabel(offer) {
    const i = state.offers.findIndex((o) => o.id === offer.id);
    const n = i === -1 ? state.offers.length + 1 : i + 1;
    return `Offer ${n}`;
}

function render() {
    const { vendor, tender } = state;

    page().innerHTML = `
        <div class="card">
            <div class="card-head">
                <div>
                    <h1>${esc(tender.name)}</h1>
                    <span class="sub">${esc(tender.serial)} &middot; closes ${esc(formatDeadline(tender))}</span>
                </div>
                <div class="who">
                    <strong>${esc(vendor.company_name)}</strong>
                    <span class="code">${esc(vendor.code)}</span>
                </div>
            </div>
            <div class="card-body">
                ${tender.description ? `<p class="lede" style="margin-bottom:10px;">${esc(tender.description)}</p>` : ''}
                <p class="lede">This invitation is addressed to ${esc(vendor.company_name)}.
                   Please don't forward it &mdash; the link files a quotation in your name.</p>
                ${(tender.required_docs || []).length ? `
                    <p class="lede" style="margin-top:10px;"><strong>Documents required:</strong>
                       ${esc((tender.required_docs || []).join(', '))}. There is an upload box for
                       each of them further down &mdash; a quotation can't be sent without them.</p>` : ''}
            </div>
        </div>
        ${requirementsCard()}
        <div class="card" id="offersCard">${state.editing ? editorCard() : listCard()}</div>
        ${state.editing ? '' : sendCard()}`;

    if (state.editing) wireEditor(); else wireList();
}

function requirementsCard() {
    const items = state.tender.items || [];
    if (!items.length) {
        return `<div class="card"><div class="card-body">
            <p class="lede">No itemised list was attached to this tender. Describe what you
               are offering in the offer below.</p></div></div>`;
    }
    const rows = items.map((item, i) => `
        <tr>
            <td class="num">${i + 1}</td>
            <td><strong>${esc(item.name)}</strong></td>
            <td class="want">${esc(item.specs) || '&mdash;'}</td>
            <td class="want">${esc(item.notes) || '&mdash;'}</td>
            <td class="qty">${num(item.quantity).toLocaleString()} ${esc(item.unit)}</td>
        </tr>`).join('');

    return `
        <div class="card">
            <div class="card-head">
                <div>
                    <h2>What we're asking for</h2>
                    <span class="sub">${items.length} item${items.length === 1 ? '' : 's'}</span>
                </div>
            </div>
            <div class="card-body">
                <div class="table-scroll">
                    <table class="req-table">
                        <thead><tr>
                            <th class="num">#</th>
                            <th>Item</th>
                            <th>Specification</th>
                            <th>Notes</th>
                            <th>Quantity</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        </div>`;
}

function listCard() {
    const body = state.offers.length
        ? `<div class="offer-list">${state.offers.map(offerSummary).join('')}</div>`
        : `<div class="state">
               ${ICON.empty}
               <h2>No offers yet</h2>
               <p>An offer is one complete way of answering this tender. Tick the items you
                  can supply, add anything you're proposing instead, and save it. Add a second
                  offer if you have an alternative worth pricing.</p>
           </div>`;

    return `
        <div class="card-head">
            <div>
                <h2>Your offers</h2>
                <span class="sub">${state.offers.length
                    ? `${state.offers.length} saved &middot; nothing has been sent yet`
                    : 'Nothing saved yet'}</span>
            </div>
            <button type="button" id="addOffer">${ICON.plus} Add an offer</button>
        </div>
        <div class="card-body">${body}</div>`;
}

function offerSummary(offer) {
    const cover = offerCoverage(offer);
    const bits = [];
    if (cover.of) bits.push(`${cover.covered} of ${cover.of} requested item${cover.of === 1 ? '' : 's'}`);
    if (cover.replacements) bits.push(`${cover.replacements} substitute${cover.replacements === 1 ? '' : 's'}`);
    if (cover.extras) bits.push(`${cover.extras} extra${cover.extras === 1 ? '' : 's'}`);

    const summary = bits.map(esc).join(' &middot; ') || 'nothing priced';

    return `
        <div class="offer-row">
            <div class="offer-id">
                <strong>${esc(offerLabel(offer))}${offer.title ? ` &mdash; ${esc(offer.title)}` : ''}</strong>
                <span class="sub">${summary}</span>
            </div>
            <div class="offer-total">${esc(money(offerTotal(offer)))}</div>
            <div class="offer-actions">
                <button type="button" class="ghost" data-edit="${escAttr(offer.id)}">Edit</button>
                <button type="button" class="ghost danger" data-remove="${escAttr(offer.id)}"
                        aria-label="Remove ${escAttr(offerLabel(offer))}">${ICON.trash}</button>
            </div>
        </div>`;
}

function documentsBlock() {
    const docs = (state.tender.required_docs || []).filter(d => d && d.trim());
    if (!docs.length) return '';
    return `
        <div class="doc-slots">
            <h3>Documents we need from you</h3>
            <p class="hint">All of them, or the quotation can't be sent. PDF, image or
               office file &mdash; whatever you have.</p>
            ${docs.map((doc, i) => `
                <div class="doc-slot">
                    <label for="doc-${i}">${esc(doc)}</label>
                    <input id="doc-${i}" type="file" data-doc="${escAttr(doc)}"
                           aria-label="Upload ${escAttr(doc)}">
                </div>`).join('')}
        </div>`;
}

function collectDocuments() {
    const docs = (state.tender.required_docs || []).filter(d => d && d.trim());
    const picked = [];
    const missing = [];
    docs.forEach((doc, i) => {
        const input = $(`doc-${i}`);
        const file = input && input.files && input.files[0];
        if (file) picked.push({ label: doc, file });
        else missing.push(doc);
    });
    if (missing.length) {
        toast(`Still to attach: ${missing.join(', ')}.`, true);
        return null;
    }
    return picked;
}

function sendCard() {
    const total = state.offers.length ? Math.min(...state.offers.map(offerTotal)) : 0;
    return `
        <div class="card">
            <div class="card-head"><h2>Send your quotation</h2></div>
            <div class="card-body">
                <div class="notice">
                    ${ICON.warn}
                    <span>Nothing above has reached us yet. Once you send, your quotation is
                          sealed and can't be changed &mdash; please check your prices first.</span>
                </div>

                ${documentsBlock()}

                <div class="fields">
                    <div>
                        <label for="deposit">Deposit / advance required</label>
                        <div class="suffixed">
                            <input id="deposit" type="number" min="0" max="100" step="0.1"
                                   inputmode="decimal" value="0">
                            <span class="suffix">% of the offer total</span>
                        </div>
                        <p class="hint">A percentage, not an amount &mdash; it applies to
                           whichever offer is accepted. Enter 0 if none is required.</p>
                    </div>
                    <div class="wide">
                        <label for="notes">Anything else we should know</label>
                        <textarea id="notes" placeholder="Delivery time, warranty, payment terms"></textarea>
                    </div>
                </div>

                <div class="actions">
                    <span class="sub" id="counted">${state.offers.length
                        ? `${state.offers.length} offer${state.offers.length === 1 ? '' : 's'}, from ${esc(money(total))}`
                        : 'Add an offer before sending'}</span>
                    <button id="send" type="button" ${state.offers.length ? '' : 'disabled'}>
                        Send quotation</button>
                </div>
            </div>
        </div>`;
}

function editorCard() {
    const offer = state.editing;
    const items = state.tender.items || [];
    const known = state.offers.some((o) => o.id === offer.id);

    const pickRows = items.map((item, i) => {
        const pick = offer.picked[item.id];
        const on = !!pick;
        return `
        <tr data-pick="${escAttr(item.id)}" class="${on ? 'priced' : 'off'}">
            <td class="tick">
                <input type="checkbox" data-field="have" ${on ? 'checked' : ''}
                       aria-label="I can supply ${escAttr(item.name)}">
            </td>
            <td class="num">${i + 1}</td>
            <td><strong>${esc(item.name)}</strong>
                <span class="want block">${esc(item.specs) || 'no specification given'}</span></td>
            <td class="qty">${num(item.quantity).toLocaleString()} ${esc(item.unit)}</td>
            <td class="col-can">
                <input data-field="qty" type="number" min="0" step="any" inputmode="decimal"
                       value="${on ? escAttr(pick.qty) : escAttr(item.quantity)}"
                       ${on ? '' : 'disabled'}
                       aria-label="How many ${escAttr(item.name)} you can supply">
            </td>
            <td class="col-price">
                <input data-field="price" type="number" min="0" step="0.01" inputmode="decimal"
                       value="${on ? escAttr(pick.price) : ''}" ${on ? '' : 'disabled'}
                       aria-label="Unit price for ${escAttr(item.name)}">
            </td>
            <td class="line-total ${on ? '' : 'empty'}" data-total>&mdash;</td>
        </tr>`;
    }).join('');

    const extraRows = (offer.extras || []).map((extra, i) => `
        <tr data-extra="${i}">
            <td class="num">${i + 1}</td>
            <td><input data-field="name" value="${escAttr(extra.name)}"
                       placeholder="What you're offering" aria-label="Item name"></td>
            <td><input data-field="specs" value="${escAttr(extra.specs)}"
                       placeholder="Make, model, spec" aria-label="Specification"></td>
            <td class="col-replaces">
                <select data-field="replaces" aria-label="What this replaces">
                    <option value="">Extra &mdash; nothing on the list</option>
                    ${items.map((it, n) => `
                        <option value="${escAttr(it.id)}" ${extra.replaces === it.id ? 'selected' : ''}
                            >instead of #${n + 1} ${escAttr(it.name)}</option>`).join('')}
                </select>
            </td>
            <td class="col-can"><input data-field="qty" type="number" min="0" step="any"
                       inputmode="decimal" value="${escAttr(extra.qty)}" aria-label="Quantity"></td>
            <td class="col-unit"><input data-field="unit" value="${escAttr(extra.unit)}"
                       placeholder="pcs" aria-label="Unit"></td>
            <td class="col-price"><input data-field="price" type="number" min="0" step="0.01"
                       inputmode="decimal" value="${escAttr(extra.price)}" aria-label="Unit price"></td>
            <td class="line-total empty" data-total>&mdash;</td>
            <td class="tick"><button type="button" class="ghost danger" data-drop="${i}"
                       aria-label="Remove this row">${ICON.trash}</button></td>
        </tr>`).join('');

    return `
        <div class="card-head">
            <div>
                <h2>${esc(known ? `Editing ${offerLabel(offer)}` : `New offer (${state.offers.length + 1})`)}</h2>
                <span class="sub">Saved on this device only until you send the quotation</span>
            </div>
        </div>
        <div class="card-body">
            <div class="fields tight">
                <div class="wide">
                    <label for="offerTitle">A name for this option <span class="opt">(optional)</span></label>
                    <input id="offerTitle" value="${escAttr(offer.title)}"
                           placeholder="e.g. Original brand, or Budget alternative">
                    <p class="hint">Shown to the people comparing offers. Please don't put your
                       company name here &mdash; offers are compared without knowing whose they are.</p>
                </div>
            </div>

            <h3 class="section">Items we asked for</h3>
            <p class="lede">Tick anything you can supply and the details are filled in for you
               &mdash; you only enter a quantity and your unit price. Leave the rest unticked.
               The quantity is yours to set in either direction: <strong>fewer</strong> than we
               asked for is a perfectly good answer (two of a requested three, and we source
               the rest elsewhere), and <strong>more</strong> is fine too if that's how it
               comes &mdash; a box of ten, or a spare thrown in.</p>
            <p class="lede">Enter <strong>0</strong> as the price for anything you're giving
               away: a case with the laptop, a bundled accessory, a sample. Please don't leave
               a price box empty, though &mdash; a blank isn't read as free.</p>
            ${items.length ? `
            <div class="table-scroll">
                <table class="pick-table">
                    <thead><tr>
                        <th class="tick"><span class="sr">Can supply</span></th>
                        <th class="num">#</th>
                        <th>Item</th>
                        <th>Asked for</th>
                        <th class="col-can">Qty you can supply</th>
                        <th class="col-price">Unit price</th>
                        <th class="col-total">Line total</th>
                    </tr></thead>
                    <tbody>${pickRows}</tbody>
                </table>
            </div>` : '<p class="lede">Nothing was itemised on this tender.</p>'}

            <h3 class="section">Anything you're offering instead</h3>
            <p class="lede">Only for what isn't on the list above &mdash; a substitute for
               something you don't stock, a bundled extra, or a gift you're including. Type
               these in yourself and say which line they stand in for &mdash; the numbers match
               the list at the top of this page, so two rows with the same name stay apart.
               Price a giveaway at 0 and it shows on the quotation without adding to the
               total.</p>
            ${(offer.extras || []).length ? `
            <div class="table-scroll">
                <table class="extra-table">
                    <thead><tr>
                        <th class="num">#</th>
                        <th>Item</th>
                        <th>Specification</th>
                        <th class="col-replaces">Stands in for</th>
                        <th class="col-can">Qty</th>
                        <th class="col-unit">Unit</th>
                        <th class="col-price">Unit price</th>
                        <th class="col-total">Line total</th>
                        <th class="tick"><span class="sr">Remove</span></th>
                    </tr></thead>
                    <tbody>${extraRows}</tbody>
                </table>
            </div>` : ''}
            <button type="button" class="ghost add" id="addExtra">${ICON.plus} Add an item of your own</button>

            <div class="fields tight">
                <div class="wide">
                    <label for="offerNotes">Notes on this offer <span class="opt">(optional)</span></label>
                    <textarea id="offerNotes" placeholder="Lead time, warranty, why you're proposing a substitute">${esc(offer.notes)}</textarea>
                </div>
            </div>

            <div class="actions">
                <span class="offer-running">Offer total <strong id="offerTotal">${esc(money(0))}</strong></span>
                <button type="button" class="ghost" id="cancelOffer">Cancel</button>
                <button type="button" id="saveOffer">${known ? 'Save changes' : 'Save offer'}</button>
            </div>
        </div>`;
}

function harvest() {
    const offer = state.editing;
    if (!offer) return;

    offer.title = ($('offerTitle') || {}).value ? $('offerTitle').value.trim() : '';
    offer.notes = ($('offerNotes') || {}).value ? $('offerNotes').value.trim() : '';

    const picked = {};
    page().querySelectorAll('tr[data-pick]').forEach((row) => {
        if (!row.querySelector('[data-field="have"]').checked) return;
        picked[row.dataset.pick] = {
            qty: row.querySelector('[data-field="qty"]').value,
            price: row.querySelector('[data-field="price"]').value,
        };
    });
    offer.picked = picked;

    page().querySelectorAll('tr[data-extra]').forEach((row) => {
        const extra = offer.extras[Number(row.dataset.extra)];
        if (!extra) return;
        extra.name = row.querySelector('[data-field="name"]').value;
        extra.specs = row.querySelector('[data-field="specs"]').value;
        extra.replaces = row.querySelector('[data-field="replaces"]').value;
        extra.qty = row.querySelector('[data-field="qty"]').value;
        extra.unit = row.querySelector('[data-field="unit"]').value;
        extra.price = row.querySelector('[data-field="price"]').value;
    });
}

function recalc() {
    const offer = state.editing;
    if (!offer) return;
    const byId = itemsById();
    let total = 0;

    page().querySelectorAll('tr[data-pick]').forEach((row) => {
        const item = byId.get(row.dataset.pick);
        const on = row.querySelector('[data-field="have"]').checked;
        const cell = row.querySelector('[data-total]');
        const qty = num(row.querySelector('[data-field="qty"]').value);
        const price = num(row.querySelector('[data-field="price"]').value);

        const priceTyped = filled(row.querySelector('[data-field="price"]').value);
        const counts = on && qty > 0 && priceTyped && price >= 0;

        row.classList.toggle('off', !on);
        row.classList.toggle('priced', counts);

        row.classList.toggle('over', on && item && qty > num(item.quantity));

        if (counts) {
            total += qty * price;
            cell.textContent = money(qty * price);
            cell.classList.remove('empty');
        } else {
            cell.textContent = '—';
            cell.classList.add('empty');
        }
    });

    page().querySelectorAll('tr[data-extra]').forEach((row) => {
        const cell = row.querySelector('[data-total]');
        const qty = num(row.querySelector('[data-field="qty"]').value);
        const raw = row.querySelector('[data-field="price"]').value;
        const price = num(raw);
        if (qty > 0 && filled(raw) && price >= 0) {
            total += qty * price;
            cell.textContent = money(qty * price);
            cell.classList.remove('empty');
        } else {
            cell.textContent = '—';
            cell.classList.add('empty');
        }
    });

    $('offerTotal').textContent = money(total);
}

function wireEditor() {
    const root = page();

    root.querySelectorAll('[data-field="have"]').forEach((box) => {
        box.addEventListener('change', () => {
            const row = box.closest('tr');

            row.querySelectorAll('[data-field="qty"], [data-field="price"]').forEach((input) => {
                input.disabled = !box.checked;
            });
            if (box.checked) row.querySelector('[data-field="price"]').focus();
            recalc();
        });
    });

    root.querySelectorAll('table input, table select').forEach((input) => {
        input.addEventListener('input', recalc);
    });

    root.querySelectorAll('[data-drop]').forEach((button) => {
        button.addEventListener('click', () => {
            harvest();
            state.editing.extras.splice(Number(button.dataset.drop), 1);
            render();
            recalc();
        });
    });

    $('addExtra').addEventListener('click', () => {
        harvest();
        state.editing.extras.push({ name: '', specs: '', replaces: '', qty: '', unit: 'pcs', price: '' });
        render();
        recalc();

        const rows = page().querySelectorAll('tr[data-extra] [data-field="name"]');
        if (rows.length) rows[rows.length - 1].focus();
    });

    $('cancelOffer').addEventListener('click', () => {
        state.editing = null;
        render();
    });

    $('saveOffer').addEventListener('click', saveOffer);
    recalc();
}

function saveOffer() {
    harvest();
    const offer = state.editing;

    const incomplete = [];
    const byId = itemsById();
    Object.keys(offer.picked).forEach((id) => {
        const pick = offer.picked[id];
        const item = byId.get(id);
        if (!item) return;
        if (num(pick.qty) <= 0 || !filled(pick.price) || num(pick.price) < 0) {
            incomplete.push(item.name);
        }
    });
    (offer.extras || []).forEach((extra, i) => {
        const started = (extra.name || '').trim() || num(extra.qty) > 0 || filled(extra.price);
        if (!started) return;
        if (!(extra.name || '').trim() || num(extra.qty) <= 0
            || !filled(extra.price) || num(extra.price) < 0) {
            incomplete.push(`your own item ${i + 1}`);
        }
    });
    if (incomplete.length) {
        toast(`Needs a quantity and a price (enter 0 if it's free): ${incomplete.join(', ')}.`, true);
        return;
    }

    if (!offerLines(offer).length) {
        toast('Tick at least one item, or add one of your own, before saving.', true);
        return;
    }

    if (!state.offers.some((o) => o.id === offer.id)) state.offers.push(offer);
    state.editing = null;
    saveDrafts();
    render();

    const over = overSupplied(offer);
    toast(over.length
        ? `Offer saved. Note you've quoted more than we asked for on: ${over.join(', ')}.`
        : 'Offer saved. Nothing is sent until you send the quotation.');
}

function wireList() {
    $('addOffer').addEventListener('click', () => {
        state.editing = blankOffer();
        render();
    });

    page().querySelectorAll('[data-edit]').forEach((button) => {
        button.addEventListener('click', () => {
            const offer = state.offers.find((o) => o.id === button.dataset.edit);
            if (!offer) return;
            state.editing = offer;
            render();
        });
    });

    page().querySelectorAll('[data-remove]').forEach((button) => {
        button.addEventListener('click', () => {
            const offer = state.offers.find((o) => o.id === button.dataset.remove);
            if (!offer) return;
            if (!window.confirm(`Remove ${offerLabel(offer)}? This can't be undone.`)) return;
            state.offers = state.offers.filter((o) => o.id !== offer.id);
            saveDrafts();
            render();
        });
    });

    const send = $('send');
    if (send) send.addEventListener('click', submit);
}

async function submit() {
    if (state.submitting) return;
    const { tender } = state;

    if (!state.offers.length) {
        toast('Add at least one offer before sending.', true);
        return;
    }

    const deposit = num($('deposit').value);
    if (deposit < 0 || deposit > 100) {
        toast('The deposit is a percentage, so it has to be between 0 and 100.', true);
        return;
    }

    const payload = [];
    for (const offer of state.offers) {
        const items = offerLines(offer);
        if (!items.length) {
            toast(`${offerLabel(offer)} has nothing priced in it. Edit or remove it.`, true);
            return;
        }
        payload.push({

            title: offer.title || (state.offers.length > 1 ? offerLabel(offer) : null),
            notes: offer.notes || null,
            items,
        });
    }

    const documents = collectDocuments();
    if (documents === null) return;

    const form = new FormData();
    form.append('deposit_percent', String(deposit));
    form.append('notes', $('notes').value.trim());
    form.append('offers', JSON.stringify(payload));

    form.append('doc_labels', JSON.stringify(documents.map(d => d.label)));
    documents.forEach(d => form.append('doc_files', d.file, d.file.name));

    state.submitting = true;
    const button = $('send');
    button.disabled = true;
    button.textContent = 'Sending…';

    try {
        const res = await fetch(
            `${API_BASE}/vendor/invite/${encodeURIComponent(state.token)}/submit`,
            { method: 'POST', body: form, headers: TUNNEL_HEADERS },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || 'Your quotation could not be submitted.');

        clearDrafts();
        showState(ICON.done, 'Quotation received',
            `Thank you. Your ${payload.length} offer${payload.length === 1 ? '' : 's'} for `
            + `${tender.serial} ${payload.length === 1 ? 'has' : 'have'} been recorded and can no `
            + 'longer be changed. The purchasing team will be in touch.');
    } catch (err) {
        state.submitting = false;
        button.disabled = false;
        button.textContent = 'Send quotation';
        toast(err.message, true);
    }
}

async function open() {
    const token = new URLSearchParams(window.location.search).get('invite');
    if (!token) {
        showState(ICON.broken, 'Nothing to open here',
            'This page needs the invitation link that was sent to you. Please open the link '
            + 'from your email rather than typing the address by hand.');
        return;
    }
    state.token = token;

    let data;
    try {
        const res = await fetch(`${API_BASE}/vendor/invite/${encodeURIComponent(token)}`,
                                { headers: TUNNEL_HEADERS });
        if (!res.ok) throw new Error('not valid');
        data = await res.json();
    } catch (err) {

        showState(ICON.broken, "This link isn't valid",
            'It may have been withdrawn, or the address may have been copied incompletely. '
            + 'Please get in touch with the purchasing team who sent it.');
        return;
    }

    state.tender = data.tender;
    state.vendor = data.vendor;
    document.title = `Quote — ${data.tender.serial}`;

    if (!data.can_submit) {

        clearDrafts();
        page().innerHTML = requirementsCard() + `
            <div class="card"><div class="state">
                ${ICON.locked}
                <h2>This form is closed</h2>
                <p>${esc(data.closed_reason || 'This tender is not accepting quotations.')}</p>
            </div></div>`;
        return;
    }

    loadDrafts();
    render();
    if (state.offers.length) {
        toast(`Picked up ${state.offers.length} unsent offer${state.offers.length === 1 ? '' : 's'} from your last visit.`);
    }
}

document.addEventListener('DOMContentLoaded', open);
