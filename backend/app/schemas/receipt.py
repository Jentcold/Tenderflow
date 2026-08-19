import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator

from app.models.receipt import LineCondition

ShipmentSource = Literal["offer", "basket"]


class IncomingLine(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    line_id: uuid.UUID
    name: str
    specs: str | None = None
    quantity: float
    unit: str
    unit_price: float
    line_total: float
    is_replacement: bool = False
    vendor_name: str | None = None


class IncomingShipment(BaseModel):
    source: ShipmentSource
    shipment_id: uuid.UUID
    tender_id: uuid.UUID
    tender_serial: str
    tender_name: str
    vendor_company: str
    offer_title: str | None
    currency: str
    total_amount: float
    approved_at: datetime | None
    urgent: bool = False
    urgent_skipped: bool = False
    items: list[IncomingLine]


class ReceiptLineIn(BaseModel):
    line_id: uuid.UUID
    condition: LineCondition = LineCondition.ok
    received_quantity: float = 0
    notes: str | None = None

    @model_validator(mode="after")
    def problems_need_a_word(self) -> "ReceiptLineIn":
        if self.condition is not LineCondition.ok and not (self.notes or "").strip():
            raise ValueError(
                f"Say what was wrong - a line marked '{self.condition.value}' "
                f"needs a note, or supply chain can't act on it"
            )
        if self.received_quantity < 0:
            raise ValueError("A received quantity can't be negative")
        return self


class ReceiptIn(BaseModel):
    lines: list[ReceiptLineIn]
    notes: str | None = None


class ReceiptLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    line_id: uuid.UUID | None = None
    name: str
    ordered_quantity: float
    received_quantity: float
    condition: LineCondition
    notes: str | None


class ReceiptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source: ShipmentSource
    shipment_id: uuid.UUID
    tender_id: uuid.UUID
    tender_serial: str
    tender_name: str
    vendor_company: str
    received_by_name: str | None
    received_at: datetime
    notes: str | None
    lines: list[ReceiptLineOut]

    total_lines: int
    problem_lines: int
