import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr

from app.models.submission import SubmissionStatus


class VendorSubmissionCreate(BaseModel):
    company_name: str
    contact_name: str
    email: EmailStr
    phone: str
    total_amount: float
    notes: str | None = None
    files: list[str] = []


class SubmissionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tender_id: uuid.UUID
    company_name: str
    contact_name: str
    email: EmailStr
    phone: str
    total_amount: float
    notes: str | None
    files: list[str]
    status: SubmissionStatus
    submitted_at: datetime


class SubmissionStatusUpdate(BaseModel):
    status: SubmissionStatus
