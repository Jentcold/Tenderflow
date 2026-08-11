import uuid
from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.category import Category
from app.models.tender import TenderStatus


class ScoringCriterion(BaseModel):
    name: str
    weight: int


class TenderCreate(BaseModel):
    name: str
    description: str
    deadline_date: date
    deadline_time: time
    currency: str
    category: Category = Category.goods
    department_id: uuid.UUID
    required_docs: list[str] = []
    scoring_criteria: list[ScoringCriterion]

    @field_validator("scoring_criteria")
    @classmethod
    def weights_sum_to_100(cls, v: list[ScoringCriterion]) -> list[ScoringCriterion]:
        total = sum(c.weight for c in v)
        if total != 100:
            raise ValueError(f"Scoring criteria weights must total 100, got {total}")
        return v


class TenderUpdate(TenderCreate):
    pass


class TenderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    serial: str
    name: str
    description: str
    deadline_date: date
    deadline_time: time
    currency: str
    category: Category
    status: TenderStatus
    department_id: uuid.UUID | None
    required_docs: list[str]
    scoring_criteria: list[dict]
    created_at: datetime
    created_by: uuid.UUID | None

    evaluation_submitted: bool
    manager_approved: bool
    manager_rejected: bool
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
    description: str
    deadline_date: date
    deadline_time: time
    currency: str
    category: Category
    status: TenderStatus
    department_id: uuid.UUID | None
    required_docs: list[str]
    scoring_criteria: list[dict]
    created_at: datetime
    manager_feedback: str | None
    is_expired: bool = False


class VendorTenderOut(BaseModel):
    """What a vendor is allowed to see about a tender.

    Deliberately narrower than TenderOut: no scoring_criteria, no submission
    count, nothing from the approval trail or the award. A bidder shouldn't
    learn how they'll be scored against rivals, or how many rivals there are.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    serial: str
    name: str
    description: str
    deadline_date: date
    deadline_time: time
    currency: str
    category: Category
    required_docs: list[str]
    already_submitted: bool = False


class ExtendDeadlineRequest(BaseModel):
    deadline_date: date
    deadline_time: time


class DepartmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
