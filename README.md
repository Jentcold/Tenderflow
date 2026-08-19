# TenderFlow

An internal procurement app: a department raises a request, their manager
approves it, purchasing takes it to vendors, offers come back, somebody is
awarded, and the warehouse receives what turns up.

FastAPI + Postgres behind a dependency-free single-page frontend. No build
step on either side: `pip install -r requirements.txt` and open a file.

## Screenshots

**Purchasing's dashboard** — the four counts that decide what to do next, the
open tenders, and the two work queues underneath: bids nobody has sorted yet,
and bids nobody has checked. Each table scrolls inside a fixed viewport, so the
page stays one screen however many tenders there are.

![Purchasing's dashboard](docs/screenshots/purchasing-dashboard.png)

**Raising a request** — the requester fills in a table of what they need, not a
paragraph. The pills across the top are purchasing's quick-fill templates, and
the number on each is how many rows it fills. Currency, deadline and required
documents are deliberately absent: they are not the requester's to decide.

![Raising a request](docs/screenshots/create-request.png)

**Purchasing's offers desk** — every bid on one tender, grouped by vendor, with
what each one actually quoted set against what was asked for: items answered,
substitutes, missing, added. Purchasing can send an offer up to the manager or
commit to it outright.

![Purchasing's offers desk](docs/screenshots/purchasing-offers.png)

## Structure

Paths below are relative to `backend/`; `frontend/` sits beside it.

```
main.py           # THE ENTRYPOINT — creates the FastAPI app, mounts every router
                  # under /api. It sits at the backend root, NOT in app/, so the
                  # uvicorn target is `main:app`. There is no app/main.py.
app/
  config.py       # settings loaded from .env
  database.py     # async SQLAlchemy engine/session
  models/         # SQLAlchemy ORM tables (category.py holds the category table
                  # and the vendor_categories join,
                  # tender_item.py the requirement table, offer.py the bids)
  schemas/        # Pydantic request/response shapes
  core/
    security.py   # password hashing + JWT
    deps.py       # get_current_user, require_roles(...) guards
    audit.py      # log_audit() helper used across routers
    ratelimit.py  # per-IP ceilings + per-account login lockout
    time.py       # server_now() / deadlines — the one definition of "now"
    pagination.py # the shared ?limit=&offset= dependency and Page envelope
  services/        # business logic that isn't just CRUD (serials, email rendering, file storage)
  routers/         # one file per resource, this is the "routers model" you wanted
    auth.py            /api/auth/*
    users.py           /api/users/*            (admin only)
    departments.py     /api/departments
    tenders.py         /api/tenders/*
    templates.py       /api/templates/*         (purchasing's reusable tender stencils)
    submissions.py     /api/submissions/*
    offers.py          /api/offers/*            (ANONYMISED bid list, shortlist, approval chain)
    notifications.py   /api/notifications/*
    audit.py           /api/audit               (admin only)
    emails.py          /api/emails/*            (templates + sent log)
    reports.py         /api/reports/*           (finance)
    vendors.py         /api/vendors/*           (staff-only vendor directory)
    vendor.py          /api/vendor/*            (PUBLIC — registration + the submission link page)
    categories.py      /api/categories/*        (the category list; admin writes it)
    receiving.py       /api/receiving/*         (the warehouse)
alembic/           # migrations
seed.py            # one-time: departments + a single bootstrap admin
```

## Setup

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env    # then edit JWT_SECRET and SEED_ADMIN_PASSWORD at minimum

docker compose up -d    # starts local Postgres on :5432

alembic revision --autogenerate -m "init"
alembic upgrade head

python seed.py          # creates departments + one admin login

# Run from backend/, and note the target is main:app — `app.main:app` fails with
# "Could not import module". `python -m uvicorn` rather than bare `uvicorn` so
# the current directory is on sys.path.
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Health check is `GET /health` at the root, not under `/api`.

API docs: http://localhost:8000/docs

## Two ways to reach the frontend

`frontend/` is static files with no build step, and there are two ways to serve
them. Both work at once; pick by which URL you open.

**1. The backend serves them.** `main.py` mounts `frontend/` at `/`, registered
after every route so `/api/*`, `/health`, `/docs` and `/openapi.json` are all
claimed first. So:

    http://localhost:8000/            the staff app
    http://localhost:8000/vendor.html the vendor form

**2. A separate static server on :5500**, which is the nicer thing to edit
against.

The JS works out which it is and points itself at the right API:

```js
const API_BASE = window.TENDERFLOW_API_BASE || (
    location.protocol === 'file:' || location.port === '5500'
        ? 'http://localhost:8000/api'
        : '/api'
);
```

### Why option 1 exists: showing it to someone else

`http://localhost:8000` is only localhost **on the machine running the stack**.
Anywhere else it is *that* machine, so tunnelling the static server alone gets
you pages that load and a UI where nothing works — every request goes to a
backend on the visitor's own laptop.

Served from the backend, `/api` is a relative path. It follows whatever host
the browser used — a LAN address, an ngrok URL — for free, and there is no CORS
on it at all, because there is no cross origin. **One tunnel is enough**, which
is what the free ngrok tier gives you:

```bash
ngrok http 8000
```

Nothing to change once the tunnel is up:

- **`FRONTEND_BASE_URL` is empty by default**, which means "build links from
  whatever host the request came in on". The RFQ email a vendor receives then
  points at the tunnel, because that is where the request that queued it came
  from. See *Links are built from the request, not from a constant* below.
- **`CORS_ORIGINS`** needs nothing. The tunnelled path is same-origin.

Free ngrok also shows an interstitial warning page to each new visitor. A
browser navigation clicks through it; a `fetch()` receives the warning HTML
where it expected JSON, which looks exactly like the app being broken. Both JS
files send `ngrok-skip-browser-warning` on API calls — but only when the API is
same-origin, since a custom header on a cross-origin request would make every
call preflighted for nothing.

**This is a demo path, not a deployment.** Anyone with the URL reaches the login
page, and the seeded staff password is in `dev_accounts.py`. Stop the tunnel
when you are done showing it.

### Links are built from the request, not from a constant

Every link that leaves the building — so far, the `vendor.html?invite=…` address
in an RFQ email — is built in exactly one place, `app/core/links.py`. No router
spells out a host of its own.

This is the one place where "works on my machine" is not a figure of speech.
`http://localhost:5500` is correct on the machine running the stack and
meaningless to everyone else: to the recipient, `localhost` is *their* laptop.
Nothing logs, nothing 500s — the mail arrives looking perfectly fine and the
vendor simply cannot bid.

`FRONTEND_BASE_URL` picks how the host is decided:

- **set** → that, verbatim. Explicit, stable, and the only answer a request
  cannot influence. Right for a real deployment.
- **empty (the default)** → read off the request being served, honouring
  `X-Forwarded-Proto` / `X-Forwarded-Host`. A tunnel then works without editing
  config, which matters because the URL changes on every ngrok restart and
  uvicorn's `--reload` does not watch `.env` anyway.

The forwarded headers have to be honoured for the derived path to be any use: a
tunnel terminates TLS at its edge and forwards plain http, so the `Host` alone
would build an `http://` link for an https-only domain. They are also
caller-supplied, so anyone who can reach the API directly can shape the link in
the *next* RFQ email. That is the trade being made by leaving the setting empty,
and it is why anything long-lived should set it.

## The frontend

A dependency-free single-page app with no build step and no package manager.
Open `frontend/index.html` in a browser and it runs.

### Running it

1. Start the backend (see **Setup** above). It listens on
   `http://localhost:8000`.
2. Open `index.html` directly — double-clicking works. No web server is needed.

Opening from `file://` means the browser sends `Origin: null`, so the backend's
`CORS_ORIGINS` includes `null` on purpose. Serving these files over HTTP instead
is fine too; just add that origin to `CORS_ORIGINS` in the backend `.env`.

### Pointing at a different backend

`API_BASE` defaults to `http://localhost:8000/api`. To override it without
editing `script.js`, set the global before the script loads:

```html
<script>window.TENDERFLOW_API_BASE = 'https://tenders.example.com/api';</script>
```

### Layout

| File | What's in it |
| --- | --- |
| `index.html` | Page shell and every modal. The SPA swaps content into `#contentArea`. |
| `script.js` | Everything else: auth, the API client, routing, and one render function per page. |
| `style.css` | Design tokens as CSS custom properties, then component styles. |
| `vendor.html` / `vendor.js` / `vendor.css` | The vendor's page, a separate site on purpose. See "The vendor's page is a separate site". |

There is no framework. Pages are rendered with template literals into
`innerHTML`, so anything interpolated from the API must go through `escapeHtml`
or `escapeAttr` first.

### Who sees what

The sidebar is built from a per-role config in `script.js`. Three predicates
decide access, and they are not interchangeable:

- `isVendor` — outside the company; sees only the vendor portal.
- `isEmployee` — on the payroll but with no back-office function. Raises tender
  requests and tracks their own, nothing more.
- `isStaff` — the roles that run the tender process. Mirrors `STAFF_ROLES` in
  `backend/app/core/deps.py`; treating an employee as staff here just buys them
  a screen of 403s.

## Auth model

- `POST /api/auth/login` with `{"username": "...", "password": "..."}` (username or email)
  returns `{"access_token": "...", "user": {...}}`.
- Send that token on every other request: `Authorization: Bearer <token>`.
- Token embeds `role`, but the backend always re-checks the role against the
  database on each request (`require_roles(...)`) rather than trusting the
  token blindly — a deactivated or role-changed user is locked out immediately
  instead of waiting for token expiry.
- `/api/vendor/*` is the one router with no auth at all — that's the public
  link vendors use to view a tender and submit a bid.

## What changed vs. the old script.js state

- Tenders no longer store `submissionCount` as a field — it's computed live
  from the `submissions` table so it can never drift out of sync.
- Vendors are real accounts (`role = vendor`) with a `vendors` profile row,
  not just a company name typed into a bid form. See "Vendors" below.
- The `awarded_vendor_submission_id` FK on `tenders` points at the winning
  `submissions` row directly, instead of copying company name/email as loose
  strings (still cached on the tender for cheap reads, but the FK is the
  source of truth).
- File uploads are now real: vendor files are validated (type/size) and saved
  under `uploads/<tender_id>/`, with a staff-only authenticated download route
  in `submissions.py`. The old version just showed the filename on screen.

## Vendors

A vendor is a `users` row with `role = vendor` plus exactly one `vendors` row
holding the company details (name, category, tax ID, address, contact
email/phone). `POST /api/vendor/register` is public and writes both in one
transaction, then returns a token so the frontend can go straight to the
dashboard.

`POST /api/users` **refuses** `role=vendor`, and `PATCH /api/users/{id}` won't
convert an account to or from that role. Both would produce a vendor login
with no profile behind it, which every `/api/vendor/*` route would then 404
on. Deactivate and re-register instead.

| Route | Who |
|---|---|
| `POST /api/vendor/register` | public (5/hour per IP) |
| `GET`/`PATCH /api/vendor/me` | the vendor themselves |
| `GET /api/vendor/tenders` | the vendor themselves — their category only |
| `GET /api/vendors`, `/api/vendors/{id}` | staff only, read-only |

Staff can browse and search the directory but can't edit a company's details
behind its back — vendors own their own profile.

### Categories

`tenders.category` and `vendors.vendor_category` share **one** enum
(`app/models/category.py`): goods, services, works, consulting. They used to
be two identical-but-separate Postgres types; visibility is decided by
comparing them, and that comparison is only sound if both sides draw from the
same list. Two enums would let someone add a label to tenders alone and
silently leave no vendor able to match it.

A vendor sees only their own category:

- `GET /api/vendor/tenders` returns open, unexpired tenders matching their
  category, soonest deadline first, with `already_submitted` per row. The
  deadline filter runs in SQL so `total` and the page agree.
- Submitting to a tender outside their category is a 403.
- `GET /api/vendor/tenders/{id}` stays public — it's a link a buyer shares, so
  anyone holding it can read the tender. `accepting_submissions` answers "can
  *you* bid", so for a logged-in vendor it accounts for category too and
  returns a `reason`.

The payload vendors get (`VendorTenderOut`) deliberately omits
`submission_count`, the approval trail and the award: a bidder shouldn't learn
how many rivals they have, or how their offer fared against them.

### Staff routers are staff-only

`/api/tenders`, `/api/submissions`, `/api/offers` and `/api/departments`
gate on `require_staff`, not `get_current_user`. Vendors are authenticated
users too — before this, a vendor token could read `/api/submissions` and see
every competitor's bid amount. It was unreachable only because no vendor
account could be created at all.

### Bids from registered vendors

`submissions.vendor_id` is set **only** when a vendor's bearer token is sent
with the submission, and the stored `company_name` then comes from their
profile rather than the form. Anonymous bids through the public link still
work exactly as before and leave `vendor_id` null.

Deliberately not matched by email: attributing a bid to whatever registered
vendor happens to share the typed-in address would let anyone file one under a
competitor's name. A null `vendor_id` means "nobody vouched for this", which
is honest; a wrong one wouldn't be.

## Time and deadlines

`core/time.py` is the only place that decides what time it is. Everything is
server time, and everything is timezone-aware — the columns are `timestamptz`,
so a naive value gets an offset guessed for it somewhere downstream.

Set `SERVER_TIMEZONE` to an IANA name (`Africa/Cairo`). Leaving it empty uses
the process's local zone, which is fine on one machine and wrong the day this
deploys somewhere set to UTC. A named zone also knows when DST starts, so a
deadline six months out lands on the right instant.

A tender **has no deadline until its manager approves it** — the columns are
nullable and `is_past_deadline()` treats null as "not expired", since a tender
that hasn't opened to vendors has nothing to be late for.

Nothing sweeps the table when a deadline passes, so `status` stays `open`
past it. `is_expired` is computed per request on every tender payload —
**use that, not `status`, to decide whether bidding is still open.** The
vendor routes already enforce it.

## Pagination

Every list route takes `?limit=&offset=` (default 50, max 200) and returns an
envelope instead of a bare array:

```json
{ "items": [...], "total": 1284, "limit": 50, "offset": 0 }
```

`/api/tenders`, `/api/submissions`, `/api/users`, `/api/vendors`,
`/api/notifications`, `/api/emails/log`, `/api/audit`. `total` always reflects
the full filtered set, not the page.

Two things that follow from this: `GET /api/notifications/unread-count` exists
because a header badge shouldn't fetch rows to draw a number, and
`/api/reports/finance` pages its `tenders` array while computing the totals in
SQL, so paging never changes the headline figures. The CSV export is
deliberately not paged — an export wants every row.

`/api/audit` used to be capped at a hard 500 with no way past it, which
quietly made it "the most recent 500 things" rather than an audit trail.

## Rate limiting

`core/ratelimit.py`, in-memory (single process — swap for Redis if this ever
runs multi-worker). Two layers:

- **Per-IP ceilings** on `/api/auth/login` and both public `/api/vendor/*`
  routes. Returns 429 with a `Retry-After` header.
- **Per-account lockout** after `LOGIN_MAX_FAILURES` bad passwords. Failures are
  recorded for unknown usernames too, so the lockout message can't be used to
  enumerate accounts.

Tunable via `.env` (see `.env.example`); `RATE_LIMIT_ENABLED=false` turns it off
wholesale for local work. `TRUST_PROXY_HEADERS` should stay `false` unless
you're behind a proxy you control — clients can forge `X-Forwarded-For`.

## Email delivery

Real SMTP via `aiosmtplib`, in `services/mailer.py`. `email_service.py` still
renders and queues `SentEmail` rows inside the request; actual delivery runs as
a FastAPI background task with its own DB session, so a slow or unreachable
mail server can't stall or fail an award.

Each row carries `status` (`queued`/`sent`/`failed`/`simulated`), `attempts`,
`error` and `sent_at`. Failures retry in-process with backoff up to
`MAIL_MAX_ATTEMPTS`, then land as `failed` for
`POST /api/emails/log/{id}/resend`. `GET /api/emails/log?status=failed` filters.

**Leaving `SMTP_HOST` empty keeps the old behaviour** — emails are rendered and
logged as `simulated`, never delivered. Nothing to configure until you want
real mail.

## The workflow

Two things are being described here, and the difference matters: the **target
flow** the business wants, and **what is actually wired up today**. Read the
first for direction and the second for what will happen if you press a button.

Naming: **"purchasing" and "procurement" are the same team.** The business calls
them purchasing; the code, the `user_role` enum and every route still say
`procurement`. Renaming the enum label means a hand-written migration plus a
sweep of every `require_roles("procurement")` call, so it hasn't been done —
treat the two words as synonyms when reading this file.

### Roles are generic; seniority comes from the department

There is no `purchasing_manager` role, and there will not be one. The roles stay
generic (`manager`, `procurement`, `supply_chain`, …) and **Purchasing, Supply
Chain and Warehouse are departments like any other**, seeded alongside IT and
HR. The purchasing manager is then simply *a user with `role = manager` whose
`department_id` points at Purchasing*.

That falls out well:

- Adding a second purchasing manager is adding a user row. No new role, no new
  `user_role` enum label, no migration — and enum labels are the one thing
  Postgres will not let you remove afterwards.
- "The manager of the tender" in step 6 of the flow means the manager of the
  department the tender was raised from, which is now a plain lookup.
- A department can have several managers, which `departments.manager` (a single
  pointer, one per department) could never express.

**Purchasing works company-wide.** Purchasing, the purchasing manager and
supply chain approve every offer whichever department raised the tender, so the
department scoping on `/api/offers` applies to *department managers only* —
scoping the others would break the chain on its second step.

The Purchasing department is found by `departments.code = 'purchasing'`, not by
its name, so nobody renaming it to "Purchasing & Procurement" one afternoon
takes the approval chain down with them. `supply_chain` and `warehouse` codes
exist alongside it. `python seed.py` is safe to re-run and fills the code in on
a database seeded before the column existed.

`users.department_id` is the general membership column; `departments.manager`
survives as the designated-head pointer and is still honoured, so anyone set up
before the column existed keeps their scope. `POST /api/users` and
`PATCH /api/users/{id}` both take `department_id`; on the PATCH, an explicit
`null` detaches the person (it checks whether the field was *sent*, not whether
it's truthy, so "no department" stays expressible).

Null for admins and vendors, who sit outside the org chart.

### Target flow (the purchasing redesign)

| # | Step | Status |
|---|---|---|
| 1 | Employee/user creates a tender as a **table of items** — from scratch or **from a template** | done (`POST /api/tenders`, `POST /api/templates/{id}/use`) |
| 2 | Department manager approves / rejects / edits / sends back, and may **tag it urgent** | approve, reject, edit and resubmit done; `PATCH /api/tenders/{id}/urgent` done |
| 3 | Purchasing receives it and picks **open to vendors** or **cash / by hand** | not built — no `sourcing_mode` on `tenders` yet; everything is the vendor path |
| 3a | Vendors path: purchasing gets the vendors **of that category** and selects who to invite (all ticked by default) | not built — vendors self-serve by category instead (`GET /api/vendor/tenders`); there is no invite list |
| 3b | Cash/by-hand path: an empty submission holding just the item, filled in with the price paid after the buy | not built |
| 4 | Invited vendors get email + in-app notification + **WhatsApp when no email is on file** | email and notifications exist; **no WhatsApp channel** and no per-invite send |
| 5 | Vendors bid — **one bid = one or more offers** (alternatives, replacements) | done — `offers` + `offer_items` under a submission |
| 5a | Purchasing **filters** the bids and sends up only what is worth comparing | done (`POST /api/offers/forward`) — see "Purchasing filters first" below |
| 6 | The **forwarded offers** go to the manager of the raising department, **cheapest first, with no vendor information at all** | done (`GET /api/offers?tender_id=`) — see "Offers" below |
| 7 | Manager picks **one offer** | done (`POST /api/offers/{id}/select`) — sets `tenders.awarded_offer_id` |
| 8 | The picked offer goes back to purchasing to approve/reject | done (`POST /api/offers/{id}/purchasing-approve`, `/reject`) |
| 9 | Then the **purchasing manager** approves/rejects — **skippable when urgent, but still notified** | done (`/purchasing-manager-approve`), urgent skip included |
| 10 | Then the **supply chain manager** — same urgent skip, same notification | done (`/supply-chain-approve`), urgent skip included |
| 11 | Finance views the invoice and sends payment | finance reporting exists (`/api/reports/finance`); no invoice or payment record |
| 12 | Warehouse sees bought offers in transit and receives them | not built — the data is there (the won offer's item list), the receiving endpoints aren't |
| 13 | Warehouse prints the item list from that offer and ticks it off on paper | the list exists (`GET /api/offers` returns each offer's items); no print view |
| 14 | Warehouse records what arrived, tags what's missing or short, adds a note | not built — needs a `receipts`/`receipt_items` pair |
| 15 | Back to purchasing, who set the offer to **wait for more** or **finalized** | not built — two more `OfferStatus` labels once step 14 exists |

The schema that was blocking most of this is in now: `tender_items`,
`offers` and `offer_items`. Steps 12–15 sit directly on top of it.

### What's wired today

Each role acts once, in order:

```
procurement creates tender        status = pending_approval   (vendors can't see it)
        |
manager approves it               status = open               POST /tenders/{id}/manager-approve
        |                         ...or rejects               POST /tenders/{id}/manager-reject
        |                            status = rejected, procurement edits and
        |                            POST /tenders/{id}/resubmit
        |
vendors in that category browse it                            GET  /vendor/tenders
        |
vendors submit bids                                           POST /vendor/tenders/{id}/submit
        |                         with a vendor token the bid is attributed to
        |                         their registered company and must match their
        |                         category; without one it's accepted anonymously
        |
purchasing validates the bid      submissions.status = validated
        |                         PATCH /submissions/{id}/status
        |                         nothing can be forwarded until this happens
        |
purchasing filters the bids       status = forwarded           POST /offers/forward
        |                         what they don't send up stays
        |                         `pending` and the manager never sees it
        |
department manager shortlists     1 to 3, best first           POST /offers/shortlist
        |                         of the FORWARDED ones only
        |                         (anonymised — no vendor names)
        |                         SEALED once sent; the tender leaves their screen
        |                         ...unless purchasing hands it back
        |                                                      POST /offers/send-back
purchasing commits to one         status = purchasing_ok       POST /offers/{id}/purchasing-approve
        |                         the rest of the shortlist drops back to pending
purchasing manager approves       purchasing_manager_ok        POST /offers/{id}/purchasing-manager-approve
        |
supply chain approves             tender status = awarded      POST /offers/{id}/supply-chain-approve
                                  vendors emailed
        |                         any desk can turn it down    POST /offers/{id}/reject
```

**The manager approves the tender first, then shortlists the offers on it.**
Those are two separate desks and two separate screens.

### Vendors don't have logins

A vendor is a **directory record**, not an account (`d8b3f60c1a94`). Purchasing
creates it; there is no registration, no password to reset, and nothing left
enabled when the relationship ends. `/api/vendor/register` and the vendor
portal are gone, and `/auth/login` refuses the `vendor` role outright for any
account predating the change.

They reach a tender through a link addressed to them:

```
tender approved -> purchasing picks who is asked -> RFQ sent, one link each
                -> vendor prices the tender's own table -> quotation sealed
```

- **`tender_vendor_invites`** — one row per (tender, vendor), each with its own
  token. Per invite rather than per vendor so a link can be revoked for one
  tender without cutting the vendor off from the rest, and so a leaked link
  exposes exactly one tender.
- The token is a bearer secret in a URL. It is long and random for that reason,
  and `vendors.code` is random too — anything countable would let one vendor
  walk the sequence to the next company's page. Every failure to resolve a
  token returns the same 404, so a bad link can't be used to probe for real ones.
- **Being in the category makes a vendor a candidate, not a recipient.**
  `PUT /api/tenders/{id}/vendors` sets the list; `POST .../vendors/send` is a
  separate step that actually mails it. Picking and sending are split so the
  list gets checked before three hundred vendors hear about a tender by accident.
- A vendor **with no email on file** is flagged (`needs_other_channel`), not
  skipped silently. Their link exists and somebody has to hand it over. That is
  the hook the WhatsApp channel goes on.
- The vendor's form **is the tender's item table** with a price column added.
  They price the rows they can supply and leave the rest blank — a partial
  quotation is a normal one now.
- **A submitted quotation is sealed.** One per vendor per tender, and a second
  attempt is a 409. A price that can be revised after everyone else's is in
  isn't a sealed bid.
- `deposit_amount` is required on the form (0 if none). It is part of the price
  of the deal, so it arrives with the bid rather than being discovered later.
- The directory keeps two histories apart: `/vendors/{id}/submissions` (what
  they have quoted — the list you read when an award has to move) and
  `/vendors/{id}/awards` (what we actually bought from them). A tender bought
  across three vendors appears on all three pages, each showing only their own
  lines.

### The basket: one tender, several suppliers

A tender asking for a mobile, a laptop, a tablet and a mouse has no reason to
be bought from one place. **The unit of an award is the line**, not the offer:
`awards` + `award_lines` (`c7a9e14b2d85`).

Purchasing assembles one basket per tender — this line from Acme's offer, that
one from Techno's, the mouse from the shop downstairs — and the *basket* is
what the purchasing manager and supply chain approve.

- `PUT /api/awards/tenders/{id}` replaces every line at once. A basket is a set
  of choices that have to agree with each other; patching a line at a time
  would let it sit in states that don't add up. Two lines answering the same
  requirement is a 422.
- A line either points at an `offer_item_id` (take this vendor's quote) **or**
  carries typed values (bought by hand). Mixing them across lines in one basket
  is the whole point.
- Everything on an award line is **copied, not referenced**. The offer it came
  from can be superseded and a by-hand line has no offer at all — either way,
  what was agreed has to keep saying what was agreed. `offer_item_id` is kept
  for provenance, not for reading the price off.
- Vendors may bid on **some** of the items. An offer covering 2 of 4 is a
  normal offer now, not a disqualified one; `covers_items` says how many.
- A line's supplier is `vendor_id` (registered, so the directory shows a
  consistent history) or just `vendor_name` (a shop with no account), or both.
  The name is filled in either way, so the line still reads if the vendor row
  ever goes.
- Rejecting a basket doesn't delete it — `active` goes false, the reason stays,
  and the next save opens a fresh one. What was refused is part of how the
  tender came to be bought the way it finally was.

### Sourcing mode is derived, not declared

**Superseded.** `tenders.sourcing_mode` and `POST /awards/tenders/{id}/sourcing-mode`
still exist, but nothing in the UI calls them: the two buttons that did are
gone. See "The basket is the exception path" below for what replaced them.

The short version: sourcing used to be chosen up front, before any bid arrived,
which is the one moment nobody can know the answer. `Award.mode` is now read off
the basket when it is saved — all lines typed in means `by_hand`, any line taken
from an offer means `vendors` — and a by-hand basket no longer skips approvals.

Submitting a basket while lines are unpriced or unsourced is still a 400, so a
half-filled basket can't be signed off.

### Scoring is gone

There is no rating, no weighted criteria, no ranking out of ten anywhere in the
product. It was removed in `a4e7b31c9d60`, which drops the `evaluations` table,
`tenders.scoring_criteria`, the three `evaluation_submitted*` columns and the
whole `/api/evaluations` router.

What replaced it: the department manager looks at the anonymised offers and
names **up to three they would accept, in order of preference**. That's the
whole judgement. It is an ordered list rather than a number because a number
implies a precision nobody had — and because what purchasing actually needs to
know is "if the first one falls over, what next".

- `offers.manager_rank` — 1, 2 or 3; null when not shortlisted.
- `POST /api/offers/shortlist` takes `{tender_id, offer_ids}` and **replaces**
  the whole shortlist. Order in the array is the ranking. An empty array
  withdraws the decision.
- Several offers sit at `selected` at once. From `purchasing_ok` on, only one
  does: purchasing picks one of the shortlist and the others go back to
  `pending`, not `rejected` — they weren't turned down, they just weren't
  bought, and marking them rejected would mean inventing a reason nobody gave.
- The tender's `awarded_*` fields are written **when the last approval lands**,
  not at shortlist time. A tender carrying `awarded_vendor_name` for an offer
  still walking the chain reads as bought when it isn't.
- Withdrawing an approved offer walks the tender back out of `awarded` to
  `open`, so finance and the warehouse aren't left working against a purchase
  that was cancelled.

`{combined_score}` is no longer offered as an email placeholder. The migration
strips the score line out of saved templates, and the renderer substitutes any
surviving token to nothing rather than printing it raw.

### A tender is a table, not a paragraph

`tender_items` — one row per thing being bought: **name, specs, notes,
quantity, unit**. A tender is "mouse / mousepad / keyboard / laptop", each with
its own requirement ("wireless, 2.4GHz, 6 buttons") and its own instruction
("red if available", "must match room 3"). `tenders.description` survives as
the covering note; it is no longer where the requirement lives.

- **specs vs. notes** are kept apart on purpose: specs are what the vendor bids
  against, notes are the instruction to whoever buys. Merging them makes a
  colour preference look like a hard requirement.
- `position` is assigned from the order the rows were sent, never accepted from
  the client. A printed checklist that reshuffles between prints is worse than
  no checklist.
- Editing a tender **replaces** the whole table. Matching old rows to new ones
  by name would merge two lines that happen to share a name, and would keep a
  row the requester meant to delete.
- Templates carry the same table (`template_items`), which is most of why a
  recurring purchase is worth templating. Pressing a template **copies** the
  rows, so editing the template next quarter can't rewrite a tender already out
  with vendors.
- `items` is loaded by the routers with a separate query, not through a lazy
  relationship — touching one during serialisation on an async session raises
  `MissingGreenlet`. List routes batch it: one query for the whole page.
- The vendor sees the table too, on both `GET /api/vendor/tenders` and the
  public `GET /api/vendor/tenders/{id}`. That's the point — they price it line
  by line instead of reading a paragraph and guessing.

`items` is now **required** on the request form — at least one row, each with a
name and a quantity above zero. It stopped being optional when it stopped being
a supplement to the description and became the request itself.

### The request form asks the requester only what they decide

The form used to ask for eight things. It asks for three: **a name, a category,
and the table of what's needed.** Everything else moved to whoever actually
owns the decision, because asking someone a question they have no way to answer
gets you an answer nobody should rely on.

| Field | Was | Is now |
| --- | --- | --- |
| Department | picked on the form | taken from `user.department_id` |
| Currency | picked on the form | purchasing, via `PATCH /purchasing-details` |
| Required documents | typed on the form | purchasing, same endpoint |
| Deadline | typed on the form | the manager, when they approve |
| Description | a required textarea | gone — the table is the requirement |

Why each one moved:

- **Department** decides which manager approves the request. Picking it on the
  form meant you could file against a department you don't work in, which also
  meant you could choose who signs your request off. It comes from the account
  now, and a user with no department gets a 400 telling them to ask an admin —
  better than a request sitting in nobody's queue.
- **Currency and required documents** are commercial terms. The person who
  needs a laptop has no basis for deciding whether vendors quote in EGP or USD,
  or which certificates they must attach.
- **The deadline** is the one that matters most. A requester saying "by Friday"
  is a wish; the date on the RFQ is a commitment to vendors. It is set in the
  same action as the approval — `POST /manager-approve` now takes
  `{deadline_date, deadline_time, urgent}` and all three are the manager's.

Two consequences worth knowing:

- **`deadline_date` and `deadline_time` are nullable**, because "raised but not
  yet approved" is a real state with no deadline in it. `is_past_deadline()`
  returns `False` for a null deadline — a tender that hasn't opened can't be
  late. `formatDeadline()` on the frontend prints "Not set yet".
- **`PUT /tenders/{id}` only writes name, category and items**, even for
  procurement. The terms and the deadline have their own endpoints, so an edit
  cannot quietly overwrite what someone else decided. Procurement changes terms
  through `PATCH /tenders/{id}/purchasing-details` (both fields optional, so
  setting the currency doesn't wipe the document list) and the deadline through
  `POST /tenders/{id}/extend-deadline`.

`description` stays on the table as a nullable column. Tenders raised before
this have one, and a template still carries a covering note; nothing collects
it on the request form.

### Sent back vs. rejected

`POST /manager-reject` takes `{reason, final}`. Both answers leave the tender
`rejected` and both require a reason in writing. `final` is the difference:

- `final: false` — **sent back for edit.** The requester fixes it and
  `POST /resubmit` puts it back in the manager's queue. The common case.
- `final: true` — **rejected.** `manager_declined` is set, `resubmit` returns
  400, and raising it again has to be a new request.

The second one exists because without it a manager saying "no" got the same
request back as often as the requester cared to press the button. It defaults
to `false` so a misclick is the recoverable answer.

The two send different notifications, and the wording is the point: a requester
who reads "needs changes" on a rejected request will keep editing and
resubmitting into a 400. Approving clears both flags, so a sent-back request
that gets fixed carries nothing forward.

### The vendor's page is a separate site

`frontend/vendor.html` + `vendor.css` + `vendor.js`. It shares **nothing** with
`index.html` / `style.css` / `script.js`.

Everything a browser is handed can be read by whoever holds the link, and a
vendor is outside the company. Serving them the staff bundle served them every
screen, every role check and every endpoint name in it — about 3,500 lines of
JavaScript, none of it theirs to see. The vendor page calls exactly two
endpoints, both public and both scoped to one token:

    GET  /api/vendor/invite/{token}
    POST /api/vendor/invite/{token}/submit

No CDN either. An icon font that fails to arrive shouldn't be able to make a
price field hard to find, so the page uses system fonts and inline SVG.

`script.js` redirects `?invite=` to `vendor.html` so links issued before the
split still land somewhere sensible. `_link()` in `routers/invites.py` builds
`{FRONTEND_BASE_URL}/vendor.html?invite={token}` — the `.html` is there because
nothing does server-side routing, so a pretty path 404s on a static server.

### The vendor's page builds offers, it isn't one big form

The page is in two halves.

**Top — what we're asking for.** The tender's own item table, read-only. A
vendor reads the whole request before deciding how to answer it; mixing the
reading and the answering into one table was what made the old form feel like
data entry.

**Bottom — the offers they build against it.** An offer is *one complete way of
answering the tender*: "all five items, original brands" is one offer, "three
of them plus a cheaper substitute for the fourth" is another. A vendor saves as
many as they want and purchasing picks between them — which is what `offers`
under a `submission` was always for, but the form only ever filed one.

Inside the editor:

- **Tick a row and the details come with it.** Name, specification and unit are
  the company's own, already filled in, so the only typing is a quantity and a
  price. Untick and it drops out of this offer. Nothing is retyped, so nothing
  can be retyped wrong — and the line stays pinned to its `tender_item_id`,
  which is what lets purchasing compare like with like.
- **Typing is only for what isn't on the list.** A second table, empty by
  default, for a substitute the vendor stocks instead, or an extra they think
  we'd want. Each row says which requirement it stands in for (by number, so
  two rows both called "screen" stay apart) or that it stands in for nothing.
  Picking a requirement sets `is_replacement` and pins `tender_item_id`;
  picking nothing leaves both empty, because calling it a replacement for
  something nobody asked for would be untrue.

**Offers are drafts until the whole quotation is sent.** They live in this
browser — and in `localStorage`, keyed by token, so a stray reload doesn't cost
an afternoon of pricing. Nothing reaches the company until *Send quotation*,
and after that nothing can be changed: a price that can be revised once the
others are in is not a sealed bid. The drafts are cleared only after the server
has taken the submission, never before.

Saving on the server instead would have put unsent prices in front of
purchasing before the vendor meant to show anyone.

### Vendors quote what they actually have, in both directions

The quantity box is the vendor's to set, either way:

- **Fewer than we asked for.** "You want three, I have two." Pre-filled with the
  requested amount, so a ticked row left alone is a full-quantity quote; typing
  a smaller number quotes for that many, and the line total follows the offered
  quantity rather than the requested one.
- **More than we asked for.** A box of ten, a spare thrown in.

Over-supply used to be refused (400, naming the line) on the reasoning that
nobody ordered the extras and they would inflate a total decisions get made on.
That was wrong about how suppliers actually quote, and it rejected the
good-faith bundle along with the typo. It is **flagged, not blocked**: the row
goes amber with "more than asked for" under the quantity, and saving the offer
says so in the toast — so a vendor who meant 3 and typed 30 sees it, and one
who meant 10 carries on. Purchasing is perfectly able to read "10" beside a
requested 3 and decide.

### Zero is a price

A vendor bundling a case with a laptop, throwing in a mouse pad, or sending a
sample enters **0**. It becomes a real line on the offer at no cost: it shows on
the quotation, it goes to the warehouse with the rest of the item list, and it
adds nothing to the total.

The trap this opens is a vendor who *forgets* to type a price, so:

**A blank price box is never read as free.** Saving names the row — "Needs a
quantity and a price (enter 0 if it's free)". The tick box is what says "I am
quoting this row", which is what freed the price field to mean a price; before
the offer builder, an empty price WAS how a vendor skipped a line, and the two
meanings would have collided.


### The deposit is a percentage, not an amount

`deposit_percent` on the submit endpoint, 0–100, recorded in the submission
notes as *"Deposit / advance requested: 20% of the accepted offer total"*.

It was a sum of money, and that stopped working the moment a quotation could
carry several offers at different totals: "5,000 up front" means one thing
against a 20,000 option and something else entirely against a 60,000 one, and
nothing on the row said which it was meant for. A percentage applies to
whichever offer is accepted. The form welds the `%` to the field so the unit is
impossible to miss and impossible to type over.

The contact fields are gone from the form. Purchasing already holds the
vendor's name, email and phone, so asking them to retype it gave two versions
of the same fact a chance to disagree — with the typed one winning. All three
are still accepted on the endpoint, and default to the directory record.

**The purchasing side of partial quantities is not built yet.** The basket can already buy a
line from one vendor and the next line from another, but it cannot yet split a
*single* line across two vendors — two of the three from whoever is cheapest,
the third from someone else. That needs the basket to allow more than one award
line per `tender_item_id` (today `AwardIn.one_line_per_requirement` rejects
exactly that), with the quantities across those lines summing to the requested
amount. Until then a short quotation is visible and priced correctly, but
answering the rest of that line means a separate purchase.

### Offers: the unit of a bid, and the unit of an award

A `Submission` is now an **envelope** — who bid, on what, with which
attachments — and the priced content lives in the `offers` rows underneath it.
One bid, one or more offers: a vendor with two brands of keyboard, or with
three of the four items plus a replacement for the fourth, files them together.

**One offer is accepted, never the whole submission.** That is what makes the
rest of the flow work: what purchasing buys, finance pays for and the warehouse
receives and ticks off is *one offer's item list*, not everything the vendor
ever proposed.

- `offer_items.tender_item_id` is **nullable**, and there's a separate
  `is_replacement` flag. Null means the line answers no particular requirement;
  the flag means "this is a substitute" and can still be pinned to the line it
  replaces — which is exactly the case the manager most needs marked.
- An offer's total is **computed from its lines**, never taken on trust. Two
  numbers meant to agree eventually won't, and this is the one the manager sorts
  on. An offer with no lines falls back to its stated `total_amount`.
- The bid's headline `submissions.total_amount` becomes the **cheapest offer in
  it** — a single flat figure is meaningless against three alternatives.
- A line may only reference an item of *its own tender*. Unchecked, a crafted
  payload could pin a price onto another tender's requirement.
- Offers arrive as a JSON array in the `offers` **form field**, because the same
  request uploads files and multipart is the only way to do both at once. A
  malformed payload is a 400 with the parse error attached — silently dropping
  it would accept a bid with no prices in it.
- A bid sent the old way (no `offers` field) still works and becomes a single
  offer worth `total_amount`. The migration backfilled one offer per existing
  submission for the same reason: the manager's view reads `offers` and nothing
  else, so a submission without one simply wouldn't be there to pick.
- `tenders.awarded_offer_id` holds the pick.
  `awarded_vendor_submission_id` stays beside it, because the award emails have
  to address a company.

### Purchasing filters first, then the manager ranks

A bid used to land in front of the department manager the moment a vendor sent
it. It now lands at purchasing.

```
vendor submits        status = pending      only purchasing can see it
        |
purchasing forwards   status = forwarded    POST /offers/forward
        |             forwarded_at stamped; now on the manager's screen
        |
manager shortlists    status = selected     POST /offers/shortlist
```

Everything purchasing doesn't tick stays `pending`. The manager never sees it,
and `/api/offers` filters it out for them at the query rather than in the page.

**Why a desk and not a passthrough.** Vendors quote things that miss the
specification, price a line nobody asked about, or send a correction that
supersedes their first try. A manager comparing bids should be comparing bids
that are actually comparable, and purchasing is the desk that knows which ones
those are. It also keeps the manager's screen down to something a person will
read: five vendors x three offers each is fifteen rows, and thirteen of them
may be noise.

Purchasing now has **two** jobs on the offers screen, and they are not the same
job:

| | Filtering | Committing |
|---|---|---|
| when | before the manager sees anything | after the manager has ranked |
| endpoint | `POST /offers/forward` | `POST /offers/{id}/purchasing-approve` |
| says | "this is worth looking at" | "this is the one we're buying" |

Keeping them apart is the point. If purchasing could rank as well as filter,
the manager's choice would be made for them.

**Withheld is not rejected.** An offer left off the list can be forwarded five
minutes later once purchasing has checked something, and it carries no reason
and no black mark. Turning one down for cause goes through
`POST /offers/{id}/reject`, which now accepts an offer at `pending` (purchasing's
desk) and at `forwarded` (the manager's) as well as the three approval steps it
already covered — because "the specification isn't met" is a thing somebody may
one day have to answer for, and silently never forwarding it leaves nobody able
to say what happened.

**The set is replaced on every call.** Un-forwarding is sending the list again
without that id. The replacement only reaches offers still in purchasing's
hands, though: anything already shortlisted or further up the chain stays put
whether or not its id is in the list. The manager acted on it, and pulling it
out from under them would leave a decision pointing at something no longer on
the table — reject it instead. Refusing the whole call over one such offer was
the first cut and it was wrong: a single shortlisted bid would have frozen the
forwarded set for every other offer on the tender.

**On upgrade** (`a3f7c05d81b4`) every offer already on the table was marked
forwarded. Under the old rules managers could see all of them, and a schema
change is not the place to take that back. `forwarded_by` stays null on those
rows — nobody actually made the call, and naming a user who didn't would put a
false signature on the record.

### Categories are a table the admin owns, and a vendor has several

Two problems with the `category` enum, fixed together because they shared a
column.

**Four labels is not the real list.** Goods, services, works, consulting - a
purchasing department distinguishes electronic devices from portable devices
from furniture, and "goods" answers none of the questions somebody picking a
supplier actually has. Growing an enum is a migration and a deploy, so in
practice it never grew and everything ended up filed under `goods`.

**And `vendors.vendor_category` was singular.** A company selling laptops and
desks had to be filed under one of them, and the other half of their catalogue
was then invisible to the invite list and the basket picker - both of which
match on category. A vendor is a candidate now if **any** of their categories is
the tender's.

`categories` is a table with `name`, `slug`, `active` and `position`;
`vendor_categories` is the join beside it. The four old labels are seeded with
exactly those slugs, so every tender, template and vendor keeps meaning what it
meant - only where it is stored changed.

**The slug is the stable key and the name is not.** Renaming "Goods" to "General
goods" relabels every screen and unfiles nothing, because nothing is filed under
the name. `CategoryUpdate` has no slug field for that reason: letting it be
edited would silently detach everything pointing at it.

**Retire, don't delete.** A retired category leaves the pickers and is refused
for anything new, while everything already filed under it keeps reading
correctly. `DELETE` exists but only succeeds when no tender, template or vendor
has ever used it - a tender raised under Consulting was raised under Consulting,
and shortening a dropdown is not a reason to rewrite that.

The API carries **slugs**, not ids: readable in a request log, and already what
the browser filters on, so nothing has to translate. `Tender.category` and
`Tender.category_name` survive as read-only properties over the relationship, so
every schema, screen and email template that used to read a string still reads a
string.

Reading the list is open to everyone internal - it is the vocabulary of the
request form, the vendor directory and the basket picker at once. Writing is
admin only.

### Quick-fill templates

A template is a stencil for a purchase that recurs: the laptop refresh, the
quarterly stationery order. Purchasing writes them; anyone raising a request
presses one and gets the requirement table already filled in, instead of
retyping fourteen rows from memory and getting two wrong.

The model and the endpoints already existed and nothing used them. What went in
is the two screens that make them real:

- **The templates desk** (purchasing): a category picker over a table, the same
  shape as the offers and bids desks because it answers the same shape of
  question - "what do we have for this kind of purchase?" A row opens the
  editor.
- **Pills on the request form.** A dropdown would have been less markup and
  worse: the value of a template is being reminded it exists at the moment you
  were about to type its contents out by hand, and a collapsed control reminds
  nobody of anything. Each pill shows how many rows it fills, which is the one
  number that decides whether pressing it beats typing.

**The pill fills the form; it does not submit it.** The requester sees exactly
what is about to be raised and can change any of it - which is what makes a
template safe to press without reading it first. Verified by raising one with an
edited quantity and a renamed title, both of which survived.

The template editor is the tender form with four more boxes, and the item-row
editor is **literally the same code** (`setItemRows` and friends now take the
tbody they work on). Two differently-shaped editors for one table is how the two
drift apart. The four extra boxes are the parts of a tender a request form
deliberately never asks for: currency, required documents, how far out the
deadline usually is, and which department it belongs to.

Those first two travel via `TenderCreate.template_id`. The name, category and
items come off the form as usual - the requester saw those and may have changed
them, and a template silently overriding what somebody typed would be worse than
no template at all - but the currency and the required documents have no boxes
on that form, and this is how they come across.

Nothing on the resulting tender points back at the template, so editing the
template next quarter cannot rewrite a tender already out with vendors.

**One bug fell out of building this.** `tender_templates.scoring_criteria` was
NOT NULL with no default, and `a4e7b31c9d60` dropped the same column from
`tenders` while missing this one. The model has had no such attribute since, so
every INSERT omitted it and every INSERT failed - creating a template had been
impossible for as long as scoring had been gone, silently, because nothing in
the app created one until this screen existed and somebody pressed Save.
`a9d3e07c5b41` drops it.

### The request belongs to the department that raised it

Who may rewrite a tender changed in both directions at once.

**The department manager can now edit it.** They are the one reading it, and a
wrong quantity or a missing line used to mean writing a rejection note, sending
it back, and waiting for the requester to make a change the manager could have
typed in less time than the note took. They already hold the decision;
withholding the pen was ceremony. The **Edit it yourself** button sits beside
Approve and Send back in the review dialog.

Their window closes when vendors can see it. Once the tender is `open`, editing
the requirement list moves the goalposts under offers already in flight - the
same reason the requester's window closes there.

**Purchasing can no longer edit it at all.** They used to be able to edit
anything at any stage, which was wrong in both directions: the request is the
requesting department's statement of what they need, and rewriting it on their
behalf - after a manager approved *that wording* - is not purchasing's call.
What is theirs is on `PATCH /purchasing-details`: the currency, and the
documents vendors must send. `_load_for_edit` returns a 403 saying so and
pointing at the right dialog.

Resubmitting is not editing, so purchasing keeps that: `_load_for_resubmit` is
a separate loader, because pressing resubmit says "look at this again" and
changes not a word of what the request says.

The department test lives in `app/core/scope.py` now rather than as a third
private copy - `offers.py` and `awards.py` still carry their own, and the
docstring says so, because a rule pasted into four files drifts in four
directions.

### Required documents arrive with the bid, labelled

`tenders.required_docs` always said what vendors must send. Nothing carried the
answer. The vendor form had one unlabelled attachment box and a sentence saying
"please have ready: tax card, commercial register", so what came back was a list
of filenames and matching those to the requirements meant reading whatever the
vendor happened to call the file.

The form now draws **one upload box per required document**, labelled with the
requirement. `submissions.documents` stores the answer keyed by that same label;
`submissions.files` is untouched and keeps meaning what it meant - anything else
the vendor wanted to include.

Labels and files are posted as two parallel lists (`doc_labels`, `doc_files`)
rather than one form field per document, because the field names would then be
vendor-supplied text and the server would be matching on a string it never
chose. A label the tender never asked for is dropped rather than rejected: the
vendor cannot craft that list by hand, so a mismatch means a stale page, and a
stale page should not lose them a bid whose real documents are all present.

**Required means required.** A submission missing one is refused, naming the
gaps. Purchasing wrote the list because a bid without a valid tax card is one
they cannot buy from, and discovering that after the tender closes means going
back to a vendor whose price is now known to the desk. The browser checks first
so the vendor is told before anything is sent.

### Validation is gone; the Submissions page is reference only

Purchasing used to mark each submission `validated` before its offers could be
compared, and `GET /offers` enforced it. That has been removed on both sides.

It was ceremony. Purchasing were the ones filtering the offers anyway, two
screens apart, and the only thing the gate reliably produced was offers that had
silently vanished from the desk because nobody had ticked a box on another page
- which is exactly how it presented as "supply chain can't approve anything" and
"the basket shows no vendors". Both were the same missing tick.

`submissions.status` is still recorded and still shown in the table. It just
doesn't decide what anyone can see, and nothing in the UI sets it any more.
`PATCH /submissions/{id}/status` still exists and is unused, and
`OfferOut.submission_status` is now informational.

**The gate had three parts, not two.** Removing the query filter and the
forward-time check left a third behind in the browser: the "send up" tick box on
the offers desk greyed itself out and read *Not validated* until the bid had
been ticked off — pointing at a button that no longer existed. That is gone too,
along with its `.forward-tick.blocked` styling.

Validation at the **offer** level is untouched and is where it belongs:
purchasing tick which offers the department manager sees, and reject the ones
that don't belong with a reason on them.

What the page is now: one tender at a time, a row per bid, and **clicking a row
opens every offer inside it** priced line by line - substitutes, added lines and
missing requirements all coloured the way they are on the offers desk.

Two columns changed with it:

- **Lowest bid** replaces the old bid total. That number was
  `submissions.total_amount`, the figure the vendor typed on the envelope, and
  since a bid can hold several offers it answered nothing. What purchasing want
  down that column is "what would this supplier cost us", and the honest answer
  is their cheapest offer.
- **Missing** sits next to Substitutes, counted against that same cheapest
  offer, so the row describes one coherent proposal rather than a mixture of
  all of them. `GET /submissions/{id}/offers` computes it server-side against
  the tender's item list.

### Bids: every tender on one screen, one dialog per tender

The Submissions page used to be one tender at a time, chosen from a dropdown at
the top. That shape came from the days when the screen *validated* bids: you
worked one tender, said yes or no to each envelope, and moved on. Validation is
gone, and what is left is a reference screen - which should not open on nothing
and demand you name a tender before it will tell you anything.

So: every tender that has bids, in one table. Press one and its bids open in a
dialog, sized off the viewport at roughly 92% wide and 74% tall - deliberately
short of filling the screen, because the sliver of the list behind it is what
says "this is one row of that", not somewhere you navigated to. The table inside
scrolls; the dialog doesn't grow.

**Pressing a bid lands on the offers desk with that tender selected.** Comparing
is the job this screen exists to start, and it happens over there against every
other vendor's lines. Reading one company's quotation in isolation is the rarer
thing, so it keeps a button (the eye) rather than the row.

The bid rows also carry a **Docs** column - "2 of 3", with the missing ones in
the tooltip - for tenders that demanded any.

### Purchasing can commit without the manager at all

The shortlist was already a guide rather than a gate: purchasing could take a
`forwarded` offer the manager never ranked. It goes one step further now - a
`pending` offer, one never sent to anybody, can be approved straight from the
offers desk.

Sometimes one bid is plainly better on every line, and routing it through a
shortlist-and-rank round trip to hear "yes, that one" costs days and settles
nothing. The button reads **Take this one** and asks for confirmation first: not
because the decision is wrong, but because the manager's review is the thing
being skipped and that should be a decision rather than a stray click.

Two things make the latitude safe. The manager is told - "purchasing bought an
offer without sending you a shortlist" - and `forwarded_at` is stamped on the
way past, so the offer still appears on their screen, which filters on that
column. Skipping their approval is the point; hiding the result from them
afterwards is not.

### The manager's shortlist is sealed when they send it

It used to be replaceable at will: every call to `/offers/shortlist` replaced
the whole list, including with an empty one. A preference that can be revised
at any moment, while purchasing is already working through it, isn't a decision.

Now the first send seals it. `/offers/shortlist` 409s afterwards with *"You've
already sent your list on this tender. If it needs changing, ask purchasing to
send it back to you."*, and the tender **leaves the manager's offers screen**
altogether — a table you can still re-rank on, that then refuses to save, is
worse than no table.

Sealed is derived, not stored: the list is locked while any offer on the tender
is `selected` or beyond. No column, and it unlocks by itself the moment nothing
is in that range — which is exactly what a rejection or a send-back produces.

**One to three, and one is fine.** `MAX_SHORTLIST` is a ceiling, never a floor.
A manager who would only accept one offer sends one. The only list refused is
an empty one: it would seal the tender with nothing on it and need purchasing
to unpick it.

### Purchasing can send a shortlist back

`POST /offers/send-back` — `{tender_id, reason}`, purchasing or admin. The only
thing that reopens a sealed list, and it exists because the seal would
otherwise deadlock: all three ranked offers turn out to be unbuyable — the
vendor withdrew, the price expired, the specification was missed on a closer
reading — and nobody could do anything except reject offers one at a time until
the tender had nothing left on it.

Every shortlisted offer drops back to `forwarded`. **None of them is rejected**:
they may well be ranked again, and marking them rejected would invent a verdict
on offers purchasing hasn't actually judged. What purchasing is saying is "not
this ordering", not "not these offers".

The reason is required and goes to the manager as a notification. Sending a
list back with no explanation invites them to hand back the same list.

Refused once purchasing has committed to one of the shortlist: an offer is
walking the approval chain by then, and taking the list apart underneath it
would strand whatever the next desk is holding. Reject that offer first —
which is a decision with a reason on it, as it should be.

### Offers: the manager's anonymised bid list

`GET /api/offers?tender_id=<uuid>` — admin and manager only. Returns every
**offer** on the tender (not every submission) **cheapest first, with the bidder
removed**: no company name, no contact name, no email, no phone, no `vendor_id`,
and no `files` (a letterhead identifies a vendor as fast as a name field does).
What's left is a letter label, the amount, the currency, the vendor's own notes,
the date, and the **priced line items**.

Because offers are listed rather than submissions, one vendor's three options
appear as three separate rows, sorted by price among everyone else's — so they
don't even cluster together in a way that would hint they came from one company.
Each row also carries `covers_items` (how many of the tender's own lines this
offer answers) and `replacement_items`, so a manager can see "covers 3 of 4, one
substitute" without reading every line.

`POST /api/offers/{offer_id}/select` is the manager's pick. Exactly one offer
per tender can hold it, so choosing again releases the previous one rather than
leaving two winners — done by query, not by reading `awarded_offer_id`, so a row
left `selected` by an older path is cleaned up too. Purchasing is notified, and
that notification names the tender, not the vendor. So does the audit line: the
same people read it.

One caveat on the letters: they are **positional per request**, so if an offer
is rejected and drops out of the default list, the ones below it shift up.
"Offer B" is stable while the field is, not across a rejection.

### The approval chain

After the pick, an offer walks three desks in order. Each endpoint checks the
offer is sitting at *its own* step, so calling the last one first doesn't skip
the first two, and each returns the same anonymised `OfferOut`.

```
manager picks              status = selected            POST /offers/{id}/select
        |
purchasing approves        status = purchasing_ok       POST /offers/{id}/purchasing-approve
        |
purchasing manager         status = purchasing_manager_ok
                                                        POST /offers/{id}/purchasing-manager-approve
        |
supply chain               status = approved            POST /offers/{id}/supply-chain-approve
        |
                           -> finance to pay, warehouse to receive
```

- **One status column**, walked in order. A separate "stage" field beside a
  "status" field is two things that can disagree.
- `POST /offers/{id}/reject` is one endpoint, not three: you may reject only at
  the step you are the approver for, and the step it died at is kept in
  `rejected_at_stage`. "Rejected" alone can't say whether supply chain killed it
  or purchasing never let it out of the room. A reason is required — the desk
  below needs to know whether to pick another offer or start again.
- Rejecting an offer clears the tender's award fields, so the manager can pick
  again without a stale award hanging off the row.
- **An offer past `selected` can't be quietly replaced.** Re-picking while
  another offer is `purchasing_ok` or beyond is a 409: someone signed that off,
  and further down it may already be bought. Change your mind by rejecting it,
  which records who and why.
- Supply chain can reject an offer that is already `approved` — that's
  **withdrawing** an approval (budget pulled, vendor fell over), and without it
  the tender deadlocks: nothing else can be picked while an approved offer
  stands, and nothing could clear it.
- The purchasing-manager step is guarded on the **department**, not a role. A
  department manager who wandered in would otherwise be approving the purchase
  they themselves requested.
- Notifications for the purchasing manager go to each of them **by user id**.
  Addressing them `for_role=manager` would ring every department manager in the
  company. If nobody is set up as a manager of Purchasing, the offer's arrival
  at that empty desk is written to the audit log rather than sitting silently.

### The basket is the exception path, not a parallel one

The basket used to sit outside the flow. A tender was sourced "from vendors" or
"by hand", chosen from two buttons **before any bid arrived** — which meant
deciding how something would be sourced at the one moment nobody could know.
Approving an offer and assembling a basket were two separate worlds that never
met.

They meet now:

- **One offer answers the whole tender?** Approve it on the Offers desk. No
  basket involved.
- **Items from more than one vendor, or something purchasing buys themselves?**
  That is what the basket is for, and it is reached from the same offers.

The two sourcing-mode buttons are gone. `Award.mode` is now **derived** when the
basket is saved — all lines typed in means `by_hand`, anything taken from an
offer means `vendors` — and it survives only as provenance and to decide
whether losing-bid mail makes sense.

**A by-hand basket no longer skips the approval chain.** It used to skip both
remaining desks, on the reasoning that it was petty cash already spent — which
followed from the button, where "by hand" meant "somebody is nipping to a shop".
Now that the mode is read off the lines, a basket can be entirely by-hand and
still be a large purchase nobody has signed off, and two approvals should not be
skipped because of how the lines happened to be filled in. `urgent` still skips,
because that is a flag a manager deliberately sets.

### A basket sent up has to be reachable by the desk it went to

`GET /awards?status=…` lists live baskets across every tender, and the
purchasing manager's and supply chain's dashboards render them into the **same
"waiting on you" table as the offers**, badged as a basket.

It was missing. A basket sent for approval fired the notification and then had
nowhere to go: the basket page is reached from the Tenders list, and neither
approver has a Tenders page on their nav. They could see that something needed
them and could not open it. An approval that exists only as a notification is
not an approval anybody performs.

A basket and an offer are two ways of buying the same tender, so they belong in
one list rather than on two screens — the approver's question is "what is
waiting on me", not "what kind of thing is waiting on me". The Open button goes
to the basket page, whose Back button now returns to wherever the reader can
actually go (`dashboard` for the approvers, `tenders` for purchasing).

Only `active` baskets are listed: a rejected one is superseded by the next
attempt and is history, not work.

### Choosing a source is a modal, not a dropdown

With three vendors bidding, a `<select>` per basket row was fine. With eight
offers across five submissions it was a list of near-identical strings in a box
two lines tall, and finding "Techno's second offer" meant reading every option.

It is a modal now, **grouped by the bid the offer arrived in**, because that is
how purchasing actually thinks about it: the question is "what did Techno quote
for this?", not "which of these nineteen lines is cheapest". The cheapest quote
is badged, substitutes are flagged, and each group is headed by the supplier's
name — purchasing may see it, and by the time a basket is being assembled the
blind comparison is long over.

**"We buy it ourselves" is an option in that same list**, which is where the
removed button went. It is one more answer to the same question, asked per line
rather than per tender.

The choice lives in `basketDraft`, not in the DOM, so it survives a re-render;
`repaintBasketRow` redraws the single row that changed rather than the page.

### One requirement, more than one supplier

`AwardIn` used to refuse two lines answering the same tender item - one
requirement, bought once. That is not how a split purchase works. Four monitors
where one vendor has one in stock and another has three is one requirement
bought from two places, and refusing it meant either buying all four from the
dearer vendor or leaving the requirement out of the basket and handling it off
the system entirely.

Each basket row now has a **Split** button. It adds another row against the same
requirement and moves quantity into it - whatever is unallocated, or half of the
last row when nothing is spare - and each part carries its own source, supplier
and price. The requirement is named once, on the first row; the continuation
rows are tinted and carry a turn-down arrow, because repeating the item name
would read as two requirements rather than one bought twice.

`basketDraft` is keyed by tender item id and holds a **list** of picks rather
than one. A running "3 of 4 allocated" sits under a split requirement and turns
amber when the parts don't add up - a short split totals correctly and simply
buys three of something four people need, which is invisible afterwards.

A quantity is now sent on **every** line, offer-sourced ones included. It used
to be omitted so the vendor's quoted quantity carried, which is right until a
requirement is split - at which point two lines both inheriting the full quote
would buy twice the order. The only thing still validated is that a split
requirement has a quantity on every part: a split into 4 and 0 is a typo, not a
plan.

### The source picker knows what the tender is for

Two changes to the same list.

**The directory is narrowed to the tender's own category.** A goods tender has
no business offering a list of construction contractors, and on a directory of
any size the one supplier purchasing meant was buried among companies that could
not have supplied it. There is a "show them anyway" toggle, because the category
on a vendor record is a filing decision somebody made once and being wrong about
it should not put a supplier out of reach.

**And there is a search box**, over both halves at once: vendor names and codes
in the directory, and supplier names and quoted item names in the bids above it.

### Adding to the basket from the offers desk

Each priced line of an offer carries a basket icon. The long way round was:
leave the desk, open the basket, find the row, open the picker, find the offer
again — and every step between the thought and the record is one where it gets
forgotten.

It merges rather than replaces: the PUT is a whole-basket write, so the current
lines are read first and the new one layered on top. A requirement already
answered is overwritten, which is the honest reading of "add this one instead" —
the toast says "Swapped" rather than "Added" when that happens.

The icon is purchasing-only and disappears once the tender is `awarded`, as does
the basket icon on the tenders list. An "add" button on a completed purchase
would be offering to change something already bought.

### Two award mails, because they say different things

`send_award_emails` and `send_basket_emails` are separate functions, not one
function with a flag:

- **`send_award_emails`** — a single offer cleared the chain. One vendor takes
  the tender (`winner`), everyone else is told they didn't (`loser`). Used by
  the offer path in `offers.py`.
- **`send_basket_emails`** — a basket was approved. Each winning vendor gets
  `basket_award` naming **their own** lines and **their own** total; every other
  bidder gets the ordinary `loser`. Used by `awards.py`.

The split is not cosmetic. `winner` says "the tender is yours", and on a split
basket that is simply untrue — a vendor who won two lines out of five would
read it and deliver the whole order. `basket_award` never says it, and spells
out that the tender went across more than one supplier so the listed items are
the full extent of the order.

Lines purchasing bought by hand have no vendor behind them and generate no mail:
there is nobody to write to. A basket with no bids at all (entirely by-hand)
sends nothing rather than erroring.

`tender.awarded_vendor_submission_id` is only filled when **one** vendor took
the lot; on a split basket it stays null rather than naming whichever supplier
happened to sort first, and `awarded_vendor_name` reads "N vendors".

### What finance is told, and why it is more than "approved"

Finance used to hear `"{serial}: an approved purchase is ready for payment"`,
sent from the supply chain endpoint. Two things were wrong with that.

**It was sent from the wrong place.** The urgent path never reaches that
endpoint, so an urgent purchase cleared every gate and hit the accounts with
nobody in finance having heard of it. The notification is built in `_finalise`
now — the one function both paths run through.

**One sentence hid the only two questions finance has.** On a basket, "a
purchase was approved" is not enough to act on:

- **Has it already been paid?** A line taken from an offer is a vendor who will
  invoice. A line purchasing walked out and bought is money already gone, and
  somebody is owed it back. The message splits the total between the two and
  says plainly which half needs reimbursing rather than invoicing.
- **Was it a registered vendor?** A supplier in the directory has a record and a
  tax id behind them. A name typed into a basket line has neither, and finance
  has to chase the paperwork before anything can be paid against it. Registered
  names and unregistered ones are listed separately, and the unregistered ones
  say so in as many words.

A basket approved on urgency also says so, so the missing signatures are not
something finance has to go and discover.

### Buying it ourselves, from someone we already know

"We buy it ourselves" originally meant one thing: a name typed into a box. But
purchasing walks into a supplier we already have a record for at least as often
as into a corner shop, and typing the name by hand lost the link to that
record — which is the entire reason the directory exists. The vendor's history
was silently incomplete, and finance had a plain string to pay against.

The source picker now lists the vendor directory under *We buy it ourselves*,
beside the free-text option. Choosing one sets `vendor_id` **and** copies
`vendor_name` onto the line — the id keeps it on their history, the name keeps
the line readable if the vendor row is ever retired. `AwardLine` already
carried both columns; nothing in the model changed, only what the desk could
reach.

The name field on that row goes read-only once a registered vendor is picked.
Editing it would put a second spelling of the same company on the line and
quietly break the directory link, which is the failure this was meant to fix.

Note that `Award.mode` still reads `by_hand` for these lines — the mode is
derived from `offer_item_id`, and "did this come off a bid" is a different
question from "is this company in our directory". It does not affect the
approval chain, which keys on `urgent` alone.

### The shortlist is a guide, not a gate

`POST /offers/{id}/purchasing-approve` accepts an offer at `selected` **or**
`forwarded`. The normal path is unchanged — the manager ranks, purchasing takes
one of the ranked — but purchasing may also take an offer the manager never
shortlisted.

The reasoning is that the manager is saying *what they want*, and purchasing
knows the market. A different vendor with the same item at the same price
shouldn't cost a full extra round trip through a review that would say yes
anyway. What makes the latitude safe is that it is visible, not that it is
forbidden: going off-list is written to the audit trail as such ("not on the
manager's shortlist") and the manager gets a notification. Silently departing
from the ranking would have made the ranking pointless.

### Withdrawing and re-awarding belongs to purchasing

It used to be supply chain's, on the reasoning that whoever signed a purchase
off can unsign it. That was half a job: withdrawing is only ever the first
half, and the second — buying something else instead — is purchasing's work.
They hold the vendor relationships and they place the replacement order.
Splitting the two across desks meant a cancellation could sit withdrawn with
nobody owning what came next.

So `POST /offers/{id}/reject` now reads:

| Offer sits at | Who may refuse or withdraw |
|---|---|
| `pending` | purchasing (still filtering) |
| `forwarded` | the department manager |
| `selected` | purchasing |
| `purchasing_ok` | the purchasing manager, **or purchasing** |
| `purchasing_manager_ok` | supply chain, **or purchasing** |
| `approved` | **purchasing** (was: supply chain) |

Supply chain still refuses at their own step, which is where a delivery
objection belongs — a lead time nobody can live with, a window that doesn't
work. Once they have approved, they raise it with purchasing, who withdraw and
re-award. Purchasing can also pull an offer back at the two steps before that:
it is their own commitment, nothing downstream has signed anything, and making
them wait for a refusal from the next desk to undo their own decision helps
nobody.

### Purchasing sees who bid; the manager still doesn't

`OfferOut.vendor_company` is populated for admin and purchasing, and `None` for
everyone else — `None`, not a redacted string, so there is nothing to render by
accident.

The anonymity on that payload exists so a price comparison can't be swayed by
whose name is on it, and that constraint binds the **department manager**, who
is the one comparing. It never bound purchasing: they read every bid with the
company attached while filtering it, they invited these vendors in the first
place, and they are the desk that has to notice one supplier quietly holding
three of the five offers. Withholding it from them protected nothing and made
their own screen unreadable.

On purchasing's offers desk the rows are therefore **grouped by supplier**,
with a separator row carrying the name and the count. A separator rather than a
column, because the vendor repeats down every row of a group. Groups are
ordered by their own cheapest offer and offers within a group by price, so the
cheapest thing on the tender is still the first row on the screen. The manager's
view is ungrouped and always will be — their payload carries no vendor to group
by.

### Three ways an offer can differ from what was asked for

Substitutes were already coloured. Two more join them, because they are
genuinely different questions:

- **substituted** — priced against a tender line, but offering something else
- **added** — priced, answering no tender line at all: a bundle, a cable thrown
  in, a gift. Not a fault, and often the reason one offer beats another
- **missing** — a tender line nobody priced

Missing is the one that needed inventing. A substitute and an addition are both
rows you can *see*; a line nobody quoted is invisible by nature, so the item
table grows a row for it whose only job is to say it isn't there. Without that,
somebody comparing two offers sees nothing at all where the gap is — and a
cheap offer is often cheap because it quietly left something out.

Derived in the browser (`offerGaps`) rather than on the server: the tender's
item list is already on the page, and computing it once beats a second set of
counters the API would have to keep in step with the first. Both counts also
appear as columns on the offer row, beside Substitutes.

### The forward bar disappears once the manager has answered

Anything at `selected` or beyond means the manager has ranked and purchasing is
working through the result — so there is nothing to send them, and the "Send to
manager" bar goes away rather than sitting there inviting a second round.

It returns on its own when the answer is undone: a send-back, or purchasing
rejecting the offer they committed to, drops everything to `forwarded` and the
bar reappears as **"Resend to manager"**. No separate flag tracks this; the
offer statuses already say it.

### The purchasing manager also runs a purchasing desk

`pmgr1` is `role=manager` in the Purchasing department, and both the nav and
every guard were keyed on the role alone — so they got the department manager's
sidebar and a 403 from every purchasing endpoint. On a team this size that is
wrong twice over: they cover the desk themselves when nobody else can, and they
are already trusted with the vendor names everywhere else.

**A purchasing manager is a manager *and* a purchasing officer**, so they need
both sets of rights rather than a splice of one item into the other. Two
matching pieces do that:

- `require_purchasing(*roles)` in `core/scope.py` — passes anyone in `roles`,
  **or** the purchasing manager. Every guard that used to read
  `require_roles("admin", "procurement")` on a purchasing action now reads
  `require_purchasing("admin", "procurement")`: tenders, templates, vendors,
  invites, awards, submissions, emails, and the three purchasing steps on
  offers. Admin-only (`users`, `audit`, `categories`) and finance-only
  (`reports`) are untouched, as is the manager's own shortlist step.
- `canPurchase(user)` in `script.js` — the same predicate on the browser side,
  replacing nine copies of `['admin', 'procurement'].includes(role)`. Nine
  places is nine chances to update eight of them.

The sidebar is a config of its own, `PURCHASING_MANAGER_NAV`, rather than a
role config with items spliced in: they carry the manager's Pending Reviews and
Decision History **and** purchasing's Manage Tenders, Submissions, Vendor
Directory, Templates and the email screens.

A department manager still gets none of that, and that is deliberate rather
than incidental: the bids on their own request are somebody else's work, and
the vendor names on those screens are exactly what the blind comparison keeps
away from them.

### Tender-scoped screens start empty from the sidebar

Offers and Submissions are both one-tender-at-a-time. Reached from the sidebar
they now open with **nothing selected** and a "Pick a tender" prompt; reached
from a dashboard row or a tender link they arrive with that tender already
loaded.

The offers desk used to open on whichever tender it judged most urgent. That is
a good guess and still the wrong thing to do: filtering bids on a tender you
didn't mean to open is the one mistake this screen makes expensive, and a
helpful default is indistinguishable from a deliberate choice once it is on the
screen. `navigateTo(page, { keepContext })` carries the distinction — the
sidebar's plain `navigateTo` clears the selection, `openOffersFor` /
`openSubmissionsFor` set it and pass `keepContext: true`.

### The warehouse receives against the purchase's item list

The last step in the chain, and the first record of what actually happened
rather than what was decided.

**Everything bought passes the door, whichever way it was bought.**
`GET /receiving/incoming` returns two things: offers at `approved`, and
**baskets at `approved`**. For a while it returned only the first, which meant
anything bought across two vendors — or bought by hand — was invisible to the
warehouse while the goods walked in anyway. A basket is a purchase somebody
committed to and nobody has checked in; that is the whole property this screen
cares about, so both shapes are on it, keyed by a `source` (`offer` |
`basket`) alongside the id. Nothing else about the warehouse's job varies with
the source, which is why the distinction goes no deeper than that pair:
`POST /receiving/{source}/{shipment_id}/receive`, one screen, one sheet.

Lines purchasing walked out and bought themselves are on the sheet like any
other. They are carried in, registered, and taken on from there — "we bought it
ourselves" is a statement about who paid, not about whether it arrives.

Nothing earlier appears, because everything earlier is somebody still deciding,
and there is nothing on this screen to decide. It is also the one desk that
sees the supplier's name: the anonymity that governs the offers desk exists to
keep a price comparison honest, and that comparison finished three approvals
ago. Somebody is standing at the door with a van.

**Received is a row, not a flag.** `goods_receipts` has one row per purchase,
pointing at *either* an `offer_id` *or* an `award_id` — both nullable, both
unique, exactly one filled in, enforced by a check constraint. (Postgres counts
nulls as distinct in a unique index, so "one receipt per purchase" survives
half the column being empty.) "Not yet received" is an approved purchase with
no row. A boolean on `offers` would have put the truth in two places, had
nowhere to live for a basket at all, and the part that actually matters —
*which* lines were wrong, and how — has nowhere to live on a flag either way.

**Every line has to be accounted for.** `POST /receiving/{source}/{shipment_id}/receive`
rejects a partial list rather than defaulting the rest to `ok`. A line nobody
mentioned is indistinguishable from a line nobody looked at, and telling those
two apart is the entire value of the record. Conditions are `ok`, `short`,
`missing`, `damaged`, `wrong_item`, `other`, and **anything that isn't `ok`
needs a note** — enforced in the schema, not just the UI. A line marked
`damaged` with no word about the damage is a shrug, and supply chain reads it
days later with the van long gone.

**A receipt can't be edited.** There is no PATCH. It is what somebody wrote
down at the door at a particular moment, and a delivery note that can be
revised afterwards is not evidence of anything. A second `receive` on the same
purchase is a 409. Corrections are a conversation with supply chain, who can read
the note that was filed.

**Every receipt notifies, not just the bad ones.** Supply chain and purchasing
both hear about every delivery. "It all arrived" is the thing they are waiting
for, and a channel that only ever carries bad news gets read as noise.
Purchasing is reached twice over — `for_role=procurement` for the buyers, and
the purchasing manager by *user id*, because their role is the generic
`manager` and broadcasting to it would ring every department manager in the
company about a delivery that isn't theirs.

**The print button is a convenience, not a step.** Somebody who wants paper at
the door prints the sheet, walks the pallet, marks it up and types the result in
afterwards; somebody with a tablet never touches it. Nothing waits on it having
been pressed. The `@media print` block in `style.css` is keyed on a
`printing-receipt` class set only for the duration of the dialog, so an
ordinary Ctrl+P of another page is unaffected — and it drops every form control,
because an empty `<select>` printed on paper is just a confusing box.

**The warehouse is a department, not a role.** There is no `warehouse`
`UserRole` and there should not be one: `dev_accounts.py` already settled this,
and it is the same rule that makes the purchasing manager a `manager` whose
department is Purchasing. The account is an ordinary `employee` attached to
Warehouse, and `require_warehouse` gates on `departments.code`. Adding a role
instead would have been a user-enum migration to express something the
department already says. The frontend consequence is that `setupRoleBasedNav()`
now runs *after* `/departments` has loaded — keyed off the role alone, a
warehouse account got the plain requester sidebar.

### Dashboards are per-desk, not one screen with things hidden

Every role used to open on the same four tender counters and a list of recent
tenders. For purchasing that is the job. For everybody else it was a summary of
somebody else's work, with the thing they actually came to do two clicks away
behind a nav item.

Each dashboard is now the same three-panel shape — one wide table of what is
waiting on **you**, then a secondary list and your own recent activity side by
side — so the app doesn't read as five different apps:

| Desk | Waiting on you | Bottom left | Bottom right |
|---|---|---|---|
| Purchasing manager | offers at `purchasing_ok` | open tenders | your recent decisions |
| Department manager | requests at `pending_approval` | tenders whose offers you haven't shortlisted | your recent decisions |
| Supply chain | offers at `purchasing_manager_ok` | your own department's tenders | your recent decisions |
| Warehouse | shipments on the way | deliveries you flagged a problem on | your recent decisions |
| Purchasing / admin | tenders | offers still to filter | bids still to check |
| Finance | *unchanged* — see below | | |

Purchasing's two lower panels are grouped by tender and each row jumps to that
tender **already selected** — which is the whole reason they are grouped. The
offers and submissions screens are one-tender-at-a-time, and the thing that
used to go wrong was arriving at either with somebody else's tender loaded.

Finance keeps the old screen deliberately. Their real integration is Dynamics
365 and they won't have an account in production; this stays only so the role
can be demonstrated in the flow.

**"Recent decisions" is `GET /audit/mine`, not the audit log.** The full log is
still admin-only. A dashboard panel showing a department manager every action
in the company would be a real widening of who can see what, dressed up as a
convenience — what belongs on a personal dashboard is what that person did. It
matches on `user_name`, which is all `log_audit` records, so two people sharing
a display name would see each other's entries. Worth knowing; not worth a
schema change for a panel that is a memory aid rather than a control.

The warehouse's bottom-left panel was a free choice — deliveries they flagged a
problem on. A plain "recently received" list is read once and forgotten, while a
delivery three boxes short is the warehouse's own open loop and the thing they
will be asked about.

### Urgent, and what it actually skips

`tenders.urgent` finally does something. On an urgent tender, **purchasing's
approval is the last gate**: the offer or basket goes straight to `approved`,
and the purchasing manager and supply chain are *notified but not waited for*.
The row keeps `urgent_skipped = true`, because "why did this never get supply
chain approval" has to have an answer sitting on it.

**Skipped is not hidden.** An urgent basket used to disappear the moment it was
sent up: it was `approved`, so it was not waiting at anybody's desk, and
neither skipped desk had any screen it appeared on. They got one notification
and then it was gone — which reads as a bug and is one, because urgency is a
reason to proceed without somebody's approval, not a reason to keep the
purchase from them. Both dashboards now carry an **"Approved without you"**
panel, fed by `GET /awards?status=approved` filtered on `urgent_skipped`, with
the same row shape as the waiting table and a status badge where the approve
button would be. There is nothing to press; the point is that it is visible.

**Urgent skips approvals, never the door.** The warehouse receives an urgent
basket exactly like any other. Nothing about "we needed it today" changes
whether the right things turned up.

The flag stays the manager's to set (`PATCH /api/tenders/{id}/urgent`, manager
and admin only). Purchasing cannot mark their own work urgent to skip the two
desks above them — which is the entire point of putting the flag there.

- `OfferOut` is deliberately **not** `from_attributes`. It's built field by field
  in the router, so a column added to `Submission` later cannot quietly start
  appearing in the anonymised view.
- Offers are labelled `Offer A`, `Offer B`, … in price order, so a manager has
  something to name in a meeting. The sort tie-breaks on `submitted_at`:
  without it two equal bids could swap places between requests and the letters
  would follow them, so "we're going with Offer B" would stop meaning anything.
- **A department manager only sees what purchasing forwarded.** Filtered on
  `offers.forwarded_at IS NOT NULL`, not on `status = 'forwarded'` — an offer
  that was forwarded, shortlisted and later released has moved past that status
  and must not vanish from the screen the manager is re-ranking on.
- Rejected bids are hidden unless `?include_rejected=true`. Showing what
  purchasing already threw out invites a manager to pick something that isn't on
  the table.
- **Not paginated**, on purpose. Picking a winner from page 1 of 3 is picking
  from a subset, which is the exact mistake this endpoint exists to prevent.
- Procurement is excluded: they already have `/api/submissions` with the names
  attached, so anonymising it for them would be theatre rather than privacy.
- Scoping: a manager only sees offers on tenders raised by a department they
  manage — `users.department_id` with `role = manager`, OR the older
  `departments.manager` pointer. **Known gap**: a manager attached to no
  department at all still sees everything, which keeps a half-configured install
  (and the demo data) usable. Attach them to a department and the scoping
  applies immediately; the hard denial is one line in
  `offers.py::_check_department`.

The remaining leak is `specs` itself — it's the vendor's free text, and a vendor
who signs their notes has named themselves. Shown as written; stripping it would
remove the one field the manager actually needs.

### Templates: purchasing's stencils for recurring buys

`/api/templates/*`. Purchasing maintains them, every internal role can read
them, and pressing one raises an ordinary tender.

- Tagged by **category** and **department**. `department_id = NULL` means "every
  department" — `GET /api/templates?department_id=<x>` returns that department's
  templates **plus** the shared ones, since an equality test alone would hide
  exactly the ones purchasing meant for everybody.
- `POST /api/templates/{id}/use` is the one press. It copies the fields into a
  new tender at `status = pending_approval` and notifies the manager, exactly
  like a hand-built one: **a template saves the typing, not the approval.**
- `default_deadline_days` rather than a stored date — an absolute date would be
  in the past by the second week anyone used the template. The deadline lands
  that many days out at 09:00 server time unless overridden.
- `required_docs` and the item rows are copied with `list()`/`dict()`, not
  shared: handing over the template's own objects would let a later edit to the
  tender mutate the template through the reference.
- Retire, don't delete — `active = false`. There is no DELETE route, and using a
  retired template is a 400. A template that produced tenders is part of how
  those tenders came to exist.

### Urgent tenders

`PATCH /api/tenders/{id}/urgent` with `{"urgent": true|false}` — **manager and
admin only**, at any stage. Purchasing deliberately can't set it: marking your
own work urgent to skip the approvals above you is the one thing this flag must
not allow. Both directions are audit-logged, because a skipped approval has to
be traceable to whoever made it skippable.

The skipping is live: on an urgent tender, purchasing's approval is the last
gate. The purchasing manager and supply chain are notified but not waited for,
and `offers.urgent_skipped` is left true on the row so "why was this never
approved by supply chain" has an answer sitting on the record.

## Dev accounts

```bash
python -m alembic upgrade head && python seed.py && python dev_accounts.py
```

`dev_accounts.py` creates one account per desk, all with the password
`pass1234`, and attaches each to the department that gives them their
authority. **Local development only** — it exists for a database you can throw
away, and it is gitignored for exactly that reason: a file that hands out one
shared password to eight accounts has no business in a clone. Write your own
against the table below, or create the accounts through `/api/users` as the
seeded admin.

| user | role | department |
|---|---|---|
| `mgr1` | manager | IT Department (department manager) |
| `pmgr1` | manager | Purchasing (**the purchasing manager**) |
| `proc1` | procurement | Purchasing |
| `sc1` | supply_chain | Supply Chain |
| `fin1` | finance | Finance Department |
| `emp1` | employee | IT Department |
| `wh1` | employee | Warehouse |
| `acme`, `buildco`, `techno` | vendor | — |

`admin` comes from `seed.py` and the `SEED_ADMIN_*` values in `.env`.

Emails are `@tenderflow.com`, deliberately not `.local`: pydantic's `EmailStr`
rejects reserved TLDs, so an account created with one logs in fine and then
500s serialising the user into the token response.

## Testing

No automated suite yet — verification is manual against a running dev
database. Rate limiting has to be off for a full pass, because the vendor
submit and register ceilings are 5/hour per IP and a second run inside the
hour trips them:

```bash
RATE_LIMIT_ENABLED=false python -m uvicorn main:app --reload --port 8000
```

Worth revisiting before this goes anywhere real: the two bugs that broke
production paths here (`submissions.currency` NOT NULL with nothing setting
it, and `user_role` missing its `vendor` label) both imported cleanly and only
showed up when something actually exercised the route.

## Not done yet (next steps)

- CORS is deliberately left at `*` so the frontend can run straight off
  `file://` with no web server. Note it's paired with
  `allow_credentials=True`, which makes Starlette echo back whatever origin
  asks — harmless while auth is Bearer-header only, but don't carry that pair
  into a deployment.
- `{combined_score}` is retired. `a4e7b31c9d60` strips the score line out of
  saved templates, and the renderer substitutes any surviving token to nothing —
  a template edited by hand before the migration ran sends slightly bare rather
  than printing the token raw.
- **Change the seeded admin password before this is reachable from anywhere.**
  `backend/.env` was once committed and pushed, so its `SEED_ADMIN_PASSWORD` is
  public. `JWT_SECRET` was rotated and the history rewritten, but rotating the
  file never touched the admin row already in the database — that password is
  still live. Deliberately left for now: the app only runs locally. It stops
  being fine the moment anything else can reach the API.
- Rate limiting is in-memory: counters reset on restart and each worker keeps
  its own. Fine for one uvicorn process, needs Redis beyond that.
- Nothing closes a tender when its deadline passes; `is_expired` is computed
  per request instead. A scheduled sweep would make `status` self-consistent.
- **The purchasing flow above is part-built.** What's left, in rough dependency
  order: `tenders.sourcing_mode` plus the cash/by-hand path, a vendor invite
  list per tender, warehouse receiving is **done** (`goods_receipts` /
  `goods_receipt_lines`, see "The warehouse receives" above), the two
  `OfferStatus` labels still outstanding (`wait_for_more`, `finalized`),
  finance's invoice/payment record, and a
  WhatsApp channel beside the mailer for vendors with no email on file.
- **Two approval chains still exist.** The per-offer one
  (`/api/offers/{id}/purchasing-approve` and the two after it) sits beside the
  basket chain, and both write `tenders.awarded_*`. The basket supersedes it —
  it is the only one that can buy four items from three vendors — so the offer
  chain should go. It hasn't yet because the Offers desk still drives it and
  the department manager's shortlist lives on the same screen.
- **The manager's blind review is structural, not textual — open question.**
  `/api/offers` sends a manager no vendor id, name, email, phone or submission
  reference; offers are `Offer A`, `Offer B`. What it can't strip is a vendor
  writing their own name into a product title or item name ("Acme ProBook 14"),
  because that text is also the thing being bought.

  **This is now mostly closed by the order of the chain.** Purchasing filters
  the bids before the department manager sees any of them (see "Purchasing
  filters first" above), so by the time an offer reaches the manager,
  purchasing has already read it with the vendor's name attached. A vendor who
  signs their own title costs nothing at that point, and purchasing can strike
  it while they are filtering — they are reading every row anyway.

  What is left is that nothing *makes* them. There is no prompt on the forward
  screen saying "check the titles", and no check that would catch it. Worth a
  line of UI when somebody has five minutes; not worth a name-stripping
  heuristic, which needs a list of company names to strip and would mangle
  legitimate product names ("Acme ProBook 14" is what is being bought).

- The Offers desk and the Basket page overlap: the manager shortlists on the
  first, purchasing builds on the second, and neither links to the other.
- `tenders.awarded_vendor_submission_id` and the win/lose emails only fire when
  a basket came from **one** vendor. A split basket writes
  `awarded_vendor_name = "3 vendors"` and emails nobody, because telling a
  vendor they lost a tender they partly won would be wrong. Per-vendor award
  notices are still to write.
- The vendor bid form still posts a flat `total_amount`, which the backend
  accepts and stores as a single offer, so multi-offer bids can only be filed
  via the API today.
- Still to come from the purchasing meeting: **per-category item columns** set
  by purchasing (stationery needs no model column, tablets do). Quick-fill is
  done — see "Quick-fill templates" above.
- Pressing a template no longer sets a deadline either, so
  `tender_templates.default_deadline_days` is currently unused by the backend.
  It is meant to prefill the manager's approve dialog; nothing reads it yet.
- The Offers desk fetches `/offers` once per tender that has bids. Fine at demo
  size; it wants a company-wide "offers waiting on me" endpoint before the
  tender list gets long.
- `warehouse` is a department, not a role. Whoever works there is a user
  attached to it; the receiving endpoints will gate on that once they exist.
