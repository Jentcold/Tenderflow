import pathlib

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.routers import (
    audit,
    auth,
    awards,
    categories,
    departments,
    emails,
    invites,
    notifications,
    offers,
    receiving,
    reports,
    submissions,
    templates,
    tenders,
    users,
    vendor,
    vendors,
)

app = FastAPI(title="TenderFlow API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_PREFIX = "/api"

app.include_router(auth.router, prefix=API_PREFIX)
app.include_router(users.router, prefix=API_PREFIX)
app.include_router(departments.router, prefix=API_PREFIX)
app.include_router(categories.router, prefix=API_PREFIX)  # the admin's category list, shared by tenders and vendors
app.include_router(tenders.router, prefix=API_PREFIX)
app.include_router(templates.router, prefix=API_PREFIX)  # purchasing's reusable tender stencils
app.include_router(submissions.router, prefix=API_PREFIX)
app.include_router(offers.router, prefix=API_PREFIX)  # manager's anonymised view of the bids
app.include_router(awards.router, prefix=API_PREFIX)  # the basket: per-item picks + by-hand buys
app.include_router(notifications.router, prefix=API_PREFIX)
app.include_router(audit.router, prefix=API_PREFIX)
app.include_router(emails.router, prefix=API_PREFIX)
app.include_router(reports.router, prefix=API_PREFIX)
app.include_router(vendors.router, prefix=API_PREFIX)  # staff-only vendor directory
app.include_router(invites.router, prefix=API_PREFIX)  # who gets asked to bid, and the RFQ
app.include_router(vendor.router, prefix=API_PREFIX)
app.include_router(receiving.router, prefix=API_PREFIX)  # the warehouse checks deliveries in  # the addressed vendor link (no login)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


# --------------------------------------------------------------- the frontend
#
# The API also serves the pages, so the whole application is reachable on ONE
# origin. That is not a deployment nicety, it is what makes the thing testable
# from anywhere but this machine: the frontend is static files with no build
# step, and every request it makes was aimed at http://localhost:8000, which on
# somebody else's laptop means *their* laptop. Put a tunnel in front of the
# static server alone and the pages arrive and nothing works.
#
# Served from here, `/api` is a relative path on whatever host the browser
# used - localhost, a LAN address, an ngrok URL - and follows it for free. It
# also means no CORS at all on that path, because there is no cross origin.
#
# Registered LAST, and last on purpose. Starlette matches routes in the order
# they were added, so every /api route and /health above is claimed before this
# catch-all ever sees the request.
#
# The separate static server (frontend/ on :5500) still works and is still the
# nicer thing to edit against; the JS picks its API base from the port it was
# served on. This is the second way in, not a replacement.
FRONTEND_DIR = pathlib.Path(__file__).resolve().parent.parent / "frontend"

if FRONTEND_DIR.is_dir():
    # html=True serves index.html for "/" and falls back to it for unknown
    # paths, which is what makes /vendor.html and a bare / both land somewhere.
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
