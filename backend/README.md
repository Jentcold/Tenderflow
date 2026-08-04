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
  models/         # SQLAlchemy ORM tables
  schemas/        # Pydantic request/response shapes
  core/
    security.py   # password hashing + JWT
    deps.py       # get_current_user, require_roles(...) guards
    audit.py       # log_audit() helper used across routers
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
    emails.py           /api/emails/*            (templates + sent log)
    reports.py          /api/reports/*           (finance)
    vendor.py            /api/vendor/*            (PUBLIC, no auth — the submission link page)
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
- Evaluations are one table with an `evaluator_role` column (`procurement` /
  `manager`) instead of being implicitly separated by which page wrote them.
- The `awarded_vendor_submission_id` FK on `tenders` points at the winning
  `submissions` row directly, instead of copying company name/email as loose
  strings (still cached on the tender for cheap reads, but the FK is the
  source of truth).
- File uploads are now real: vendor files are validated (type/size) and saved
  under `uploads/<tender_id>/`, with a staff-only authenticated download route
  in `submissions.py`. The old version just showed the filename on screen.

## Not done yet (next steps)

- Alembic's first migration needs to be generated against a running Postgres
  (`alembic revision --autogenerate`) — can't do that from here without a DB.
- Rate limiting / login throttling isn't in yet.
- Real email delivery: `services/email_service.py` renders templates and logs
  a `SentEmail` row, but doesn't call an SMTP/provider API. Swap that in when
  you're ready.
- CORS origins in `.env` need to point at wherever the new frontend actually
  gets served from.
