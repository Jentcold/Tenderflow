import uuid
from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.tender import TenderStatus


class RejectionReason(BaseModel):
    reason: str
    final: bool = False

    @field_validator("reason")
    @classmethod
    def reason_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Please give a reason")
        return v.strip()


class LineItemIn(BaseModel):
    name: str
    specs: str | None = None
    notes: str | None = None
    quantity: float = 1
    unit: str = "pcs"

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Every item needs a name")
        return v.strip()

    @field_validator("quantity")
    @classmethod
    def quantity_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Quantity must be greater than zero")
        return v


class LineItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    position: int
    name: str
    specs: str | None
    notes: str | None
    quantity: float
    unit: str


class TenderCreate(BaseModel):
    name: str
    category: str = "goods"
    items: list[LineItemIn]
    template_id: uuid.UUID | None = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Give the request a name")
        return v.strip()

    @field_validator("items")
    @classmethod
    def at_least_one_item(cls, v: list[LineItemIn]) -> list[LineItemIn]:
        if not v:
            raise ValueError("Add at least one item — this is what the request is for")
        return v


class TenderUpdate(TenderCreate):
    pass


class PurchasingDetails(BaseModel):
    currency: str | None = None
    required_docs: list[str] | None = None

    @field_validator("currency")
    @classmethod
    def currency_not_blank(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not v.strip():
            raise ValueError("Currency can't be blank")
        return v.strip().upper()


class ManagerApproval(BaseModel):
    deadline_date: date
    deadline_time: time
    urgent: bool = False


class TenderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    serial: str
    name: str
    description: str | None
    deadline_date: date | None
    deadline_time: time | None
    currency: str
    category: str = ""
    category_name: str = ""
    status: TenderStatus
    department_id: uuid.UUID | None
    required_docs: list[str]
    items: list[LineItemOut] = []
    created_at: datetime
    created_by: uuid.UUID | None

    urgent: bool
    manager_approved: bool
    manager_rejected: bool
    manager_declined: bool
    manager_feedback: str | None
    supply_chain_approved: bool
    supply_chain_rejected: bool
    supply_chain_rejection_reason: str | None
    supply_chain_reviewed_at: datetime | None

    awarded_vendor_name: str | None
    awarded_amount: float | None
    awarded_email: str | None
    awarded_offer_id: uuid.UUID | None
    awarded_vendor_submission_id: uuid.UUID | None


class TenderListItem(TenderOut):
    submission_count: int = 0
    is_expired: bool = False


class MyRequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    serial: str
    name: str
    description: str | None
    deadline_date: date | None
    deadline_time: time | None
    currency: str
    category: str = ""
    category_name: str = ""
    status: TenderStatus
    department_id: uuid.UUID | None
    required_docs: list[str]
    items: list[LineItemOut] = []
    created_at: datetime
    manager_feedback: str | None
    manager_declined: bool = False
    is_expired: bool = False


class VendorTenderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    serial: str
    name: str
    description: str | None
    deadline_date: date | None
    deadline_time: time | None
    currency: str
    category: str = ""
    category_name: str = ""
    required_docs: list[str]
    items: list[LineItemOut] = []
    already_submitted: bool = False


class UrgentUpdate(BaseModel):
    urgent: bool


class ExtendDeadlineRequest(BaseModel):
    deadline_date: date
    deadline_time: time


class DepartmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    code: str | None = None
