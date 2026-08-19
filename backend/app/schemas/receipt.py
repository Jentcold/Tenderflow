import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator

from app.models.receipt import LineCondition

# What a purchase turned out to be. The warehouse does the same job either way,
# so this only ever decides which id the ticked lines are written against.
ShipmentSource = Literal["offer", "basket"]


class IncomingLine(BaseModel):
    """One line of what the warehouse is expecting, or has just checked in."""

    model_config = ConfigDict(from_attributes=True)

    # The offer item or the basket line, depending on the shipment's `source`.
    # One field rather than two nullable ones: the warehouse ticks a line, and
    # which table it came from is the shipment's business, not the row's.
    line_id: uuid.UUID
    name: str
    specs: str | None = None
    quantity: float
    unit: str
    unit_price: float
    line_total: float
    # The vendor offered something other than what was asked for. Worth seeing
    # while checking a delivery in: a substitute is the line most likely to be
    # queried at the door.
    is_replacement: bool = False
    # Only ever set on a basket, where one shipment can span several suppliers
    # and "who do I chase about this line" has a different answer per line.
    vendor_name: str | None = None


class IncomingShipment(BaseModel):
    """An approved purchase on its way to the warehouse.

    Two things can be one of these: an offer that cleared supply chain, and a
    basket that did. Both are goods somebody has committed to buy and nobody
    has checked in yet, which is the only property this screen cares about.
    Everything earlier in the chain is somebody else's decision and none of the
    warehouse's business.
    """

    source: ShipmentSource
    # The offer id or the award id. Paired with `source` it addresses the
    # receive endpoint, and the pair is what the browser holds onto.
    shipment_id: uuid.UUID
    tender_id: uuid.UUID
    tender_serial: str
    tender_name: str
    # The warehouse is the one desk that *has* to know who is delivering -
    # somebody is standing at the door with a van. The anonymity that governs
    # the offers desk exists to keep a price comparison honest, and that
    # comparison finished several approvals ago.
    #
    # On a split basket there is no single answer, so this reads "3 suppliers"
    # and the per-line `vendor_name` carries the detail.
    vendor_company: str
    offer_title: str | None
    currency: str
    total_amount: float
    approved_at: datetime | None
    urgent: bool = False
    # True when urgency carried the purchase past the later desks. The
    # warehouse still receives it exactly the same way - the flag is there
    # because "nobody signed this off" is worth knowing at the door.
    urgent_skipped: bool = False
    items: list[IncomingLine]


class ReceiptLineIn(BaseModel):
    line_id: uuid.UUID
    condition: LineCondition = LineCondition.ok
    received_quantity: float = 0
    notes: str | None = None

    @model_validator(mode="after")
    def problems_need_a_word(self) -> "ReceiptLineIn":
        """Anything not `ok` has to say what happened.

        A line marked `damaged` with no note is not a report, it is a shrug:
        supply chain read it days later, with the van long gone, and can do
        nothing with it. Cheap to insist on here, impossible to reconstruct
        afterwards.
        """
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

    # Rolled up here rather than counted in the browser, so the warehouse list,
    # the supply chain list and any future report all agree on what "a problem"
    # means.
    total_lines: int
    problem_lines: int
