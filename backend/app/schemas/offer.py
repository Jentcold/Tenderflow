import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.offer import OfferStatus
from app.models.submission import SubmissionStatus


class OfferItemIn(BaseModel):
    tender_item_id: uuid.UUID | None = None
    is_replacement: bool = False
    name: str
    specs: str | None = None
    notes: str | None = None
    quantity: float = 1
    unit: str = "pcs"
    unit_price: float = 0

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Every line needs a name")
        return v.strip()

    @field_validator("quantity")
    @classmethod
    def quantity_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Quantity must be greater than zero")
        return v

    @field_validator("unit_price")
    @classmethod
    def price_not_negative(cls, v: float) -> float:
        if v < 0:
            raise ValueError("Unit price cannot be negative")
        return v


class OfferIn(BaseModel):
    title: str | None = None
    notes: str | None = None
    total_amount: float | None = None
    items: list[OfferItemIn] = []


class OfferForward(BaseModel):
    tender_id: uuid.UUID
    offer_ids: list[uuid.UUID]

    @field_validator("offer_ids")
    @classmethod
    def distinct(cls, v: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(set(v)) != len(v):
            raise ValueError("The same offer appears twice")
        return v


MAX_SHORTLIST = 3


class OfferShortlist(BaseModel):
    tender_id: uuid.UUID
    offer_ids: list[uuid.UUID]

    @field_validator("offer_ids")
    @classmethod
    def at_most_three_and_distinct(cls, v: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(v) > MAX_SHORTLIST:
            raise ValueError(f"Shortlist at most {MAX_SHORTLIST} offers, in order of preference")
        if len(set(v)) != len(v):
            raise ValueError("The same offer appears twice in the shortlist")
        return v


class OfferSendBack(BaseModel):
    tender_id: uuid.UUID
    reason: str

    @field_validator("reason")
    @classmethod
    def reason_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Say why the shortlist doesn't work")
        return v.strip()


class OfferRejection(BaseModel):
    reason: str

    @field_validator("reason")
    @classmethod
    def reason_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Please give a reason")
        return v.strip()


class OfferItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tender_item_id: uuid.UUID | None
    is_replacement: bool
    position: int
    name: str
    specs: str | None
    notes: str | None
    quantity: float
    unit: str
    unit_price: float
    line_total: float


class OfferOut(BaseModel):
    id: uuid.UUID
    tender_id: uuid.UUID
    label: str
    title: str | None
    total_amount: float
    currency: str
    specs: str | None
    status: OfferStatus
    submitted_at: datetime
    submission_status: SubmissionStatus = SubmissionStatus.pending
    vendor_company: str | None = None
    forwarded_at: datetime | None = None
    manager_rank: int | None = None
    manager_selected_at: datetime | None = None
    purchasing_reviewed_at: datetime | None = None
    purchasing_manager_reviewed_at: datetime | None = None
    supply_chain_reviewed_at: datetime | None = None
    rejected_at_stage: OfferStatus | None = None
    rejection_reason: str | None = None
    urgent_skipped: bool = False
    items: list[OfferItemOut] = []
    covers_items: int = 0
    replacement_items: int = 0
