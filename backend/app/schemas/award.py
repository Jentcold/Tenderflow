import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.award import AwardStatus, SourcingMode


class SourcingModeUpdate(BaseModel):
    mode: SourcingMode


class AwardLineIn(BaseModel):
    """One line of the basket, as purchasing files it.

    Either `offer_item_id` (take this line from that vendor's offer) or the
    typed fields (bought by hand). Both are allowed together: taking a vendor
    line but overriding the quantity is a real thing that happens.
    """

    tender_item_id: uuid.UUID | None = None
    offer_item_id: uuid.UUID | None = None
    # A registered vendor, so the directory shows a consistent history...
    vendor_id: uuid.UUID | None = None
    # ...or just a name, for the shop on the corner that has no account.
    vendor_name: str | None = None

    # Ignored when offer_item_id is given — the offer's own wording wins, since
    # that is what was quoted.
    name: str | None = None
    specs: str | None = None
    notes: str | None = None
    quantity: float | None = None
    unit: str | None = None
    # Null on a by-hand line that hasn't been shopped yet: the empty template
    # purchasing fills in afterwards.
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
    """The whole basket, replaced on every save.

    A basket is a set of choices that have to agree with each other, so it is
    written whole. Patching a line at a time would let it sit in states that
    don't add up.

    **One requirement may be answered by several lines.** It used to be
    rejected — one line per tender item, enforced here — on the reasoning that
    a requirement is bought once. That is not how a split purchase works: four
    monitors where one vendor has one in stock and another has three is one
    requirement bought from two places, and it is a normal thing to do rather
    than an error to catch. The lines carry their own quantities and the desk
    adds them up.

    What is still checked is that a line being bought has a quantity on it: a
    split into 4 and 0 is a typo, not a plan.
    """

    lines: list[AwardLineIn] = []
    notes: str | None = None

    @field_validator("lines")
    @classmethod
    def split_lines_need_quantities(cls, v: list[AwardLineIn]) -> list[AwardLineIn]:
        # Only enforced where the requirement is actually split. A single line
        # may still leave quantity null and inherit the offer's or the
        # requirement's, which is what every unsplit basket does.
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
    # Totalled from the lines rather than stored: the sum of what is being
    # bought is the sum of what is being bought.
    total_amount: float = 0
    # How many of the tender's requirements this basket answers, out of how
    # many there are. "3 of 4" is the thing an approver needs to see first.
    items_answered: int = 0
    items_required: int = 0
    # Distinct suppliers across the lines. A basket spanning three vendors is
    # normal now, and worth showing plainly.
    vendor_count: int = 0

    # Denormalised for the approval screens, which list baskets across tenders
    # and would otherwise need a tender lookup per row just to print a serial.
    tender_serial: str = ""
    tender_name: str = ""
    urgent: bool = False
