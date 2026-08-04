import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import require_roles
from app.database import get_db
from app.models.email import EmailTemplate, EmailType, SentEmail
from app.models.user import User
from app.schemas.email import (
    EmailPreviewRequest,
    EmailPreviewResponse,
    EmailTemplateOut,
    EmailTemplateUpdate,
    SentEmailOut,
)
from app.services.email_service import render_template

router = APIRouter(prefix="/emails", tags=["emails"], dependencies=[Depends(require_roles("admin", "procurement"))])

SAMPLE_PLACEHOLDERS = {
    "{vendor_company}": "Acme Corporation",
    "{vendor_contact}": "John Smith",
    "{vendor_email}": "john@acme.com",
    "{tender_name}": "Office Furniture Supply",
    "{tender_serial}": "TND-2025-0001",
    "{tender_category}": "Goods",
    "{currency}": "USD",
    "{awarded_amount}": "45,000",
    "{bid_amount}": "45,000",
    "{combined_score}": "8.5",
}


@router.get("/templates", response_model=list[EmailTemplateOut])
async def list_templates(db: AsyncSession = Depends(get_db)) -> list[EmailTemplate]:
    result = await db.execute(select(EmailTemplate))
    return list(result.scalars().all())


@router.put("/templates/{email_type}", response_model=EmailTemplateOut)
async def update_template(
    email_type: EmailType,
    payload: EmailTemplateUpdate,
    user: User = Depends(require_roles("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> EmailTemplate:
    template = await db.get(EmailTemplate, email_type)
    if not template:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    template.subject = payload.subject
    template.body = payload.body
    label = "Winner" if email_type == EmailType.winner else "Non-Winner"
    await log_audit(db, "Email Template Updated", f"{label} email template saved", user.name)
    await db.commit()
    await db.refresh(template)
    return template


@router.post("/templates/preview", response_model=EmailPreviewResponse)
async def preview_template(payload: EmailPreviewRequest) -> EmailPreviewResponse:
    subject, body = render_template(payload.subject, payload.body, SAMPLE_PLACEHOLDERS)
    return EmailPreviewResponse(subject=subject, body=body)


@router.get("/log", response_model=list[SentEmailOut])
async def email_log(db: AsyncSession = Depends(get_db)) -> list[SentEmail]:
    result = await db.execute(select(SentEmail).order_by(SentEmail.sent_at.desc()))
    return list(result.scalars().all())


@router.get("/log/{email_id}", response_model=SentEmailOut)
async def get_sent_email(email_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> SentEmail:
    email = await db.get(SentEmail, email_id)
    if not email:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Email not found")
    return email
