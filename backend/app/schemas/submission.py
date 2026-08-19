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
    vendor_id: uuid.UUID | None
    company_name: str
    contact_name: str
    email: str
    phone: str
    total_amount: float
    currency: str
    notes: str | None
    files: list[str]
    documents: dict[str, str] = {}
    status: SubmissionStatus
    submitted_at: datetime


class SubmissionStatusUpdate(BaseModel):
    status: SubmissionStatus


class SubmissionOfferLine(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tender_item_id: uuid.UUID | None
    is_replacement: bool
    name: str
    specs: str | None
    notes: str | None
    quantity: float
    unit: str
    unit_price: float
    line_total: float


class SubmissionOfferBrief(BaseModel):
    id: uuid.UUID
    label: str
    title: str | None
    total_amount: float
    currency: str
    covers_items: int
    replacement_items: int
    replacements: list[str]

    missing_items: int
    missing: list[str]

    items: list[SubmissionOfferLine]
