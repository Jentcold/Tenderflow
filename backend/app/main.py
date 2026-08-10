from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import (
    audit,
    auth,
    departments,
    emails,
    evaluations,
    notifications,
    reports,
    submissions,
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
app.include_router(tenders.router, prefix=API_PREFIX)
app.include_router(submissions.router, prefix=API_PREFIX)
app.include_router(evaluations.router, prefix=API_PREFIX)
app.include_router(notifications.router, prefix=API_PREFIX)
app.include_router(audit.router, prefix=API_PREFIX)
app.include_router(emails.router, prefix=API_PREFIX)
app.include_router(reports.router, prefix=API_PREFIX)
app.include_router(vendors.router, prefix=API_PREFIX)  # staff-only vendor directory
app.include_router(vendor.router, prefix=API_PREFIX)  # public vendor portal


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
