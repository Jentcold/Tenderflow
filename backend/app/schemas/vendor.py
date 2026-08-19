import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, field_validator

from app.schemas.category import CategoryRef


class VendorCreate(BaseModel):
    company_name: str
    categories: list[str]
    contact_email: EmailStr | None = None
    contact_phone: str | None = None
    tax_id: str | None = None
    address: str | None = None
    notes: str | None = None

    @field_validator("company_name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("A vendor needs a company name")
        return v.strip()


class VendorUpdate(BaseModel):
    company_name: str | None = None
    categories: list[str] | None = None
    contact_email: EmailStr | None = None
    contact_phone: str | None = None
    tax_id: str | None = None
    address: str | None = None
    notes: str | None = None
    active: bool | None = None


class VendorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    company_name: str
    categories: list[CategoryRef] = []
    contact_email: EmailStr | None
    contact_phone: str | None
    tax_id: str | None
    address: str | None
    notes: str | None
    active: bool
    created_at: datetime
    needs_other_channel: bool = False


class VendorInviteOut(BaseModel):
    vendor_id: uuid.UUID
    code: str
    company_name: str
    contact_email: EmailStr | None
    categories: list[CategoryRef] = []
    invited: bool = False
    sent_at: datetime | None = None
    needs_other_channel: bool = False
    submission_link: str | None = None
    submitted: bool = False


class InviteSelection(BaseModel):
    vendor_ids: list[uuid.UUID]


class VendorSubmissionOut(BaseModel):
    submission_id: uuid.UUID
    tender_id: uuid.UUID
    tender_serial: str
    tender_name: str
    total_amount: float
    currency: str
    submitted_at: datetime
    offer_count: int
    won_lines: int = 0


class VendorAwardOut(BaseModel):
    award_line_id: uuid.UUID
    tender_id: uuid.UUID
    tender_serial: str
    tender_name: str
    name: str
    quantity: float
    unit: str
    unit_price: float
    line_total: float
    currency: str
    award_status: str
    awarded_at: datetime | None = None
