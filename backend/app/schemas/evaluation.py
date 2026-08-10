import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class EvaluationSave(BaseModel):
    scores: dict[str, float]
    notes: str | None = None


class EvaluationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    submission_id: uuid.UUID
    tender_id: uuid.UUID
    scores: dict
    total_score: float
    notes: str | None
    evaluated_by: uuid.UUID | None
    evaluated_at: datetime | None


class RankedSubmissionOut(BaseModel):
    """Submission plus its evaluation, if procurement has scored it yet."""

    id: uuid.UUID
    company_name: str
    contact_name: str
    email: str
    phone: str
    total_amount: float
    notes: str | None
    files: list[str]
    submitted_at: datetime

    evaluation: EvaluationOut | None = None
    # Mirrors evaluation.total_score, or None when unscored. Ranking sorts on
    # this, so callers don't have to reach through a nullable relation.
    score: float | None = None


class RejectionReason(BaseModel):
    reason: str
