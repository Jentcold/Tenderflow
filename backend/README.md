# TenderFlow Backend

FastAPI + Postgres backend. All logic and state that used to live in `AppState`
inside `script.js` now lives here; the frontend will become a thin client that
calls this API and renders whatever it gets back.

## Structure

```
app/
  main.py         # creates the FastAPI app, mounts every router under /api
  config.py       # settings loaded from .env
  database.py     # async SQLAlchemy engine/session
  models/         # SQLAlchemy ORM tables (category.py holds the shared enum)
  schemas/        # Pydantic request/response shapes
  core/
    security.py   # password hashing + JWT
    deps.py       # get_current_user, require_roles(...) guards
    audit.py      # log_audit() helper used across routers
    ratelimit.py  # per-IP ceilings + per-account login lockout
    time.py       # server_now() / deadlines — the one definition of "now"
    pagination.py # the shared ?limit=&offset= dependency and Page envelope
  services/        # business logic that isn't just CRUD (serials, scoring, email rendering, file storage)
  routers/         # one file per resource, this is the "routers model" you wanted
    auth.py            /api/auth/*
    users.py           /api/users/*            (admin only)
    departments.py     /api/departments
    tenders.py         /api/tenders/*
    submissions.py     /api/submissions/*
    evaluations.py     /api/evaluations/*       (the approval workflow engine)
    notifications.py   /api/notifications/*
    audit.py           /api/audit               (admin only)
    emails.py          /api/emails/*            (templates + sent log)
    reports.py         /api/reports/*           (finance)
    vendors.py         /api/vendors/*           (staff-only vendor directory)
    vendor.py          /api/vendor/*            (PUBLIC — registration + the submission link page)
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
uvicorn app.main:app --reload --port 8000
```

API docs: http://localhost:8000/docs

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
`scoring_criteria`, `submission_count`, the approval trail and the award: a
bidder shouldn't learn how they'll be scored against rivals, or how many
rivals there are.

### Staff routers are staff-only

`/api/tenders`, `/api/submissions`, `/api/evaluations` and `/api/departments`
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
procurement scores each one                                   POST /evaluations/submissions/{id}/procurement
procurement hands off             evaluation_submitted = true POST /evaluations/tenders/{id}/submit-for-award
        |
supply chain awards top score     status = awarded            POST /evaluations/tenders/{id}/supply-chain-approve
                                                              (or .../supply-chain-reject)
```

**The manager approves the tender, not the scores.** Their involvement ends
once the tender opens. **Supply chain doesn't re-approve anything** — they take
the highest-scored submission and award it.

### Evaluations: one per submission

Procurement is the only role that scores. `evaluations.submission_id` is
unique, so re-scoring overwrites the same row and a tender's ranking is simply
procurement's ranking.

This replaced an earlier two-stage design where procurement and manager each
scored and the results were averaged. Removed with it: `EvaluatorRole`,
`combine_scores()`, `POST /evaluations/submissions/{id}/manager`,
`GET /evaluations/tenders/{id}/combined-rankings`, and the evaluation-stage
`manager-approve` / `manager-reject` / `submit-to-manager` endpoints.
`RankedSubmissionOut.procurement_evaluation` / `manager_evaluation` /
`combined_score` collapsed to `evaluation` and `score`.

`supply-chain-approve` now refuses a tender procurement hasn't handed off, so a
half-scored tender can't be awarded.

## Testing

No automated suite yet — verification is manual against a running dev
database. Rate limiting has to be off for a full pass, because the vendor
submit and register ceilings are 5/hour per IP and a second run inside the
hour trips them:

```bash
RATE_LIMIT_ENABLED=false uvicorn app.main:app --reload --port 8000
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
- The `{combined_score}` email-template placeholder kept its name — it's stored
  in `email_templates` rows, so renaming it would stop it substituting in any
  template already saved. It now resolves to the single evaluation score.
- **The old `JWT_SECRET` is still in git history on `origin/main`.** It's been
  rotated, so the published one is worthless, but the commits remain. The
  `SEED_ADMIN_PASSWORD` that shipped alongside it needs changing on the admin
  account itself — rotating the file doesn't touch the row already seeded.
- Rate limiting is in-memory: counters reset on restart and each worker keeps
  its own. Fine for one uvicorn process, needs Redis beyond that.
- Nothing closes a tender when its deadline passes; `is_expired` is computed
  per request instead. A scheduled sweep would make `status` self-consistent.
