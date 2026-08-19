import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.email import EmailStatus, EmailType


class EmailTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    type: EmailType
    subject: str
    body: str


class EmailTemplateUpdate(BaseModel):
    subject: str
    body: str


class EmailPreviewRequest(BaseModel):
    subject: str
    body: str


class EmailPreviewResponse(BaseModel):
    subject: str
    body: str


class SentEmailOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tender_id: uuid.UUID
    tender_serial: str
    tender_name: str
    submission_id: uuid.UUID | None
    vendor_company: str
    recipient_email: str
    type: EmailType
    subject: str
    body: str

    status: EmailStatus
    attempts: int
    error: str | None
    created_at: datetime
    sent_at: datetime | None
