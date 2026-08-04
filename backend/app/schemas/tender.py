import uuid
from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.tender import TenderCategory, TenderStatus


class ScoringCriterion(BaseModel):
    name: str
    weight: int


class TenderCreate(BaseModel):
    name: str
    description: str
    deadline_date: date
    deadline_time: time
    currency: str
    category: TenderCategory = TenderCategory.goods
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
    category: TenderCategory
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

    awarded_vendor_name: str | None
    awarded_amount: float | None
    awarded_email: str | None


class TenderListItem(BaseModel):
    """Lighter payload for table/list views, includes computed submission_count."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    serial: str
    name: str
    description: str
    deadline_date: date
    deadline_time: time
    currency: str
    category: TenderCategory
    status: TenderStatus
    department_id: uuid.UUID | None
    submission_count: int = 0


class ExtendDeadlineRequest(BaseModel):
    deadline_date: date
    deadline_time: time


class DepartmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
