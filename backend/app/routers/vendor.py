import uuid
from datetime import date, datetime, time

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.database import get_db
from app.models.notification import Notification, NotificationType
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.user import UserRole
from app.schemas.submission import SubmissionOut
from app.services.storage_service import save_submission_file

# Public, unauthenticated router: this is what the vendor-facing submission
# link (?tender=<id>) hits. No `Depends(get_current_user)` anywhere in here.
router = APIRouter(prefix="/vendor", tags=["vendor"])


def _is_expired(tender: Tender) -> bool:
    deadline = datetime.combine(tender.deadline_date, tender.deadline_time)
    return datetime.now() > deadline


@router.get("/tenders/{tender_id}")
async def get_public_tender(tender_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    expired = _is_expired(tender)
    if tender.status != TenderStatus.open or expired:
        return {
            "id": tender.id,
            "serial": tender.serial,
            "name": tender.name,
            "description": tender.description,
            "deadline_date": tender.deadline_date,
            "deadline_time": tender.deadline_time,
            "accepting_submissions": False,
        }

    return {
        "id": tender.id,
        "serial": tender.serial,
        "name": tender.name,
        "description": tender.description,
        "deadline_date": tender.deadline_date,
        "deadline_time": tender.deadline_time,
        "currency": tender.currency,
        "required_docs": tender.required_docs,
        "accepting_submissions": True,
    }


@router.post("/tenders/{tender_id}/submit", response_model=SubmissionOut, status_code=status.HTTP_201_CREATED)
async def submit_offer(
    tender_id: uuid.UUID,
    company_name: str = Form(...),
    contact_name: str = Form(...),
    email: str = Form(...),
    phone: str = Form(...),
    total_amount: float = Form(...),
    notes: str | None = Form(default=None),
    files: list[UploadFile] = File(default=[]),
    db: AsyncSession = Depends(get_db),
) -> Submission:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if tender.status != TenderStatus.open or _is_expired(tender):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This tender is no longer accepting submissions")

    existing = await db.scalar(
        select(Submission).where(Submission.tender_id == tender_id, Submission.email == email.lower())
    )
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "A submission from this email already exists")

    stored_paths = [await save_submission_file(f, tender_id) for f in files if f.filename]

    submission = Submission(
        tender_id=tender_id,
        company_name=company_name,
        contact_name=contact_name,
        email=email.lower(),
        phone=phone,
        total_amount=total_amount,
        notes=notes,
        files=stored_paths,
    )
    db.add(submission)

    db.add(
        Notification(
            type=NotificationType.submission_received,
            tender_id=tender.id,
            message=f"New submission from {company_name} for {tender.serial}",
            for_role=UserRole.procurement,
        )
    )
    await log_audit(db, "Submission Received", f"{company_name} for {tender.serial}", "System")
    await db.commit()
    await db.refresh(submission)
    return submission
