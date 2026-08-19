import uuid
from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.tender import TenderStatus


class RejectionReason(BaseModel):
    """Sending something back always needs a reason in writing.

    Lived in the evaluation schemas until scoring was removed; it was never
    about scoring, so it moved here rather than going with it.
    """

    reason: str
    # False (the default) sends it back to be fixed and resubmitted. True
    # declines it outright. Defaulted to the recoverable one: an accidental
    # click should be the reversible answer.
    final: bool = False

    @field_validator("reason")
    @classmethod
    def reason_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Please give a reason")
        return v.strip()


class LineItemIn(BaseModel):
    """One row of the requirement table, as typed on the tender form.

    `position` is not accepted from the client — it's assigned from the order
    of the list, so the rows come back the way they were entered without the
    caller having to keep a counter straight.
    """

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
    """Everything the person raising a request is asked for, and nothing else.

    Four fields used to sit here that no longer do, because none of them were
    the requester's to answer:

    - `department_id` comes from their own account. Picking it made it possible
      to file a request against a department you don't work in, and it decides
      which manager approves — so it was also a way to choose your approver.
    - `currency` and `required_docs` are purchasing's, set on the tender once
      they pick it up.
    - `deadline_date` / `deadline_time` belong to the manager who approves it.
      A requester asking for something by Friday is a wish; the deadline vendors
      bid against is a commitment, and it is made by whoever signs the request
      off.

    `description` went too. The requirement is the table now — `items` — not a
    paragraph someone has to read and interpret.
    """

    name: str
    # The category's slug, from the admin's list - see app/models/category.py.
    # A slug rather than an id because it is readable in a request log and is
    # already what the browser filters on.
    category: str = "goods"
    items: list[LineItemIn]

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
    """The same fields, for a request being revised before it is approved.

    Deliberately not wider than TenderCreate. Procurement changes the terms
    through `PATCH /purchasing-details` and the manager sets the deadline when
    they approve, so there is no path here that lets an edit quietly rewrite
    what someone else decided.
    """


class PurchasingDetails(BaseModel):
    """The commercial terms, which purchasing owns.

    Both optional so one can be set without disturbing the other; sending
    neither is a no-op rather than a way to blank them both.
    """

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
    """What the manager decides when they approve: by when, and how urgent.

    The deadline is required rather than optional. Approving without one would
    open the tender to vendors with no closing date, and the alternative —
    defaulting it quietly — would put a date in front of vendors that nobody
    chose.
    """

    deadline_date: date
    deadline_time: time
    urgent: bool = False


class TenderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    serial: str
    name: str
    description: str | None
    # Null while the tender is still waiting on its manager — the deadline is
    # set at approval, not at request time.
    deadline_date: date | None
    deadline_time: time | None
    currency: str
    category: str = ""
    # The display name, so a list of tenders needs no second lookup to
    # print what each one is for.
    category_name: str = ""
    status: TenderStatus
    department_id: uuid.UUID | None
    required_docs: list[str]
    # Populated by the routers, which load the rows separately — the model
    # relationship isn't eager-loaded, and touching it during serialisation on
    # an async session raises MissingGreenlet.
    items: list[LineItemOut] = []
    created_at: datetime
    created_by: uuid.UUID | None

    # Urgent tenders may skip the purchasing-manager and supply-chain approval
    # gates later in the flow. Exposed on the tender itself so every screen can
    # badge it, since "why did this one skip approval" has to be answerable.
    urgent: bool
    manager_approved: bool
    manager_rejected: bool
    manager_declined: bool
    manager_feedback: str | None
    supply_chain_approved: bool
    supply_chain_rejected: bool
    supply_chain_rejection_reason: str | None
    # When the award decision was taken. Null until supply chain rules on it —
    # the supply chain history table is the one place that dates the decision.
    supply_chain_reviewed_at: datetime | None

    awarded_vendor_name: str | None
    awarded_amount: float | None
    awarded_email: str | None
    # Which single offer the manager picked. One offer wins, not a whole bid.
    awarded_offer_id: uuid.UUID | None
    # Which bid actually holds the award. Names and emails aren't unique enough
    # to match a submission on, and reassigning needs to exclude the incumbent.
    awarded_vendor_submission_id: uuid.UUID | None


class TenderListItem(TenderOut):
    """A tender plus the two things every view needs that the row doesn't store.

    `is_expired` is computed per request rather than persisted: nothing sweeps
    the table at the deadline, so `status` stays "open" past it. A caller that
    trusts status alone will offer a tender vendors can no longer bid on.
    """

    submission_count: int = 0
    is_expired: bool = False


class MyRequestOut(BaseModel):
    """What the employee who raised a tender is allowed to see about it.

    Narrower than TenderListItem on purpose. No `submission_count`, so they
    can't read off how much vendor interest their request drew, and nothing
    from the award — who won and for how much is procurement's business, not
    the requester's. What's left is their own request back, its status, and
    `manager_feedback` so a rejection says why.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    serial: str
    name: str
    description: str | None
    # Null while the tender is still waiting on its manager — the deadline is
    # set at approval, not at request time.
    deadline_date: date | None
    deadline_time: time | None
    currency: str
    category: str = ""
    # The display name, so a list of tenders needs no second lookup to
    # print what each one is for.
    category_name: str = ""
    status: TenderStatus
    department_id: uuid.UUID | None
    required_docs: list[str]
    items: list[LineItemOut] = []
    created_at: datetime
    manager_feedback: str | None
    # True when the manager declined outright rather than asking for changes,
    # so the requester's screen can hide a Resubmit button that would 400.
    manager_declined: bool = False
    is_expired: bool = False


class VendorTenderOut(BaseModel):
    """What a vendor is allowed to see about a tender.

    Deliberately narrower than TenderOut: no submission count, nothing from the
    approval trail or the award. A bidder shouldn't learn how many rivals they
    have, or how their offer fared against them.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    serial: str
    name: str
    description: str | None
    # Null while the tender is still waiting on its manager — the deadline is
    # set at approval, not at request time.
    deadline_date: date | None
    deadline_time: time | None
    currency: str
    category: str = ""
    # The display name, so a list of tenders needs no second lookup to
    # print what each one is for.
    category_name: str = ""
    required_docs: list[str]
    # The requirement table. This is what the vendor prices, line by line,
    # instead of reading a paragraph and guessing what was meant.
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
    # The stable identifier for the departments the workflow names — purchasing,
    # supply_chain, warehouse. Exposed because the frontend has to recognise a
    # purchasing manager, and matching on the display name would break the
    # moment somebody renames the department.
    code: str | None = None
