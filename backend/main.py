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
app.include_router(categories.router, prefix=API_PREFIX)
app.include_router(tenders.router, prefix=API_PREFIX)
app.include_router(templates.router, prefix=API_PREFIX)
app.include_router(submissions.router, prefix=API_PREFIX)
app.include_router(offers.router, prefix=API_PREFIX)
app.include_router(awards.router, prefix=API_PREFIX)
app.include_router(notifications.router, prefix=API_PREFIX)
app.include_router(audit.router, prefix=API_PREFIX)
app.include_router(emails.router, prefix=API_PREFIX)
app.include_router(reports.router, prefix=API_PREFIX)
app.include_router(vendors.router, prefix=API_PREFIX)
app.include_router(invites.router, prefix=API_PREFIX)
app.include_router(vendor.router, prefix=API_PREFIX)
app.include_router(receiving.router, prefix=API_PREFIX)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


FRONTEND_DIR = pathlib.Path(__file__).resolve().parent.parent / "frontend"

if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
