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
    # Null on an RFQ. The invitation goes out before anybody has bid, so
    # there is no submission for it to point at - the model has allowed
    # that since RFQ mail was added, and this was the one place still
    # insisting on a value. Every log read blew up as soon as one RFQ
    # was in the table.
    submission_id: uuid.UUID | None
    vendor_company: str
    recipient_email: str
    type: EmailType
    subject: str
    body: str

    status: EmailStatus
    attempts: int
    error: str | None
    created_at: datetime           # when it was queued
    sent_at: datetime | None       # when a mail server accepted it, if ever
