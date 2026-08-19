import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.award import AwardStatus, SourcingMode


class SourcingModeUpdate(BaseModel):
    mode: SourcingMode


class AwardLineIn(BaseModel):
    tender_item_id: uuid.UUID | None = None
    offer_item_id: uuid.UUID | None = None
    vendor_id: uuid.UUID | None = None
    vendor_name: str | None = None

    name: str | None = None
    specs: str | None = None
    notes: str | None = None
    quantity: float | None = None
    unit: str | None = None
    unit_price: float | None = None

    @field_validator("quantity")
    @classmethod
    def quantity_positive(cls, v: float | None) -> float | None:
        if v is not None and v <= 0:
            raise ValueError("Quantity must be greater than zero")
        return v

    @field_validator("unit_price")
    @classmethod
    def price_not_negative(cls, v: float | None) -> float | None:
        if v is not None and v < 0:
            raise ValueError("Unit price cannot be negative")
        return v


class AwardIn(BaseModel):
    lines: list[AwardLineIn] = []
    notes: str | None = None

    @field_validator("lines")
    @classmethod
    def split_lines_need_quantities(cls, v: list[AwardLineIn]) -> list[AwardLineIn]:
        seen: dict = {}
        for line in v:
            if line.tender_item_id is None:
                continue
            seen.setdefault(line.tender_item_id, []).append(line)
        for lines in seen.values():
            if len(lines) > 1 and any(
                line.quantity is None or line.quantity <= 0 for line in lines
            ):
                raise ValueError(
                    "A requirement split across suppliers needs a quantity on every part "
                    "of the split"
                )
        return v


class AwardRejection(BaseModel):
    reason: str

    @field_validator("reason")
    @classmethod
    def reason_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Please give a reason")
        return v.strip()


class AwardLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tender_item_id: uuid.UUID | None
    offer_item_id: uuid.UUID | None
    vendor_id: uuid.UUID | None
    vendor_name: str | None
    position: int
    name: str
    specs: str | None
    notes: str | None
    quantity: float
    unit: str
    unit_price: float
    line_total: float


class AwardOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tender_id: uuid.UUID
    mode: SourcingMode
    status: AwardStatus
    active: bool
    currency: str
    notes: str | None
    created_at: datetime
    submitted_at: datetime | None
    purchasing_manager_reviewed_at: datetime | None
    supply_chain_reviewed_at: datetime | None
    rejected_at_stage: AwardStatus | None
    rejection_reason: str | None
    urgent_skipped: bool

    lines: list[AwardLineOut] = []
    total_amount: float = 0
    items_answered: int = 0
    items_required: int = 0
    vendor_count: int = 0

    tender_serial: str = ""
    tender_name: str = ""
    urgent: bool = False
