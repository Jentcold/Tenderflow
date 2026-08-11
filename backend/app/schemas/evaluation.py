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


class AwardDecision(BaseModel):
    """Which bid supply chain is awarding.

    The score ranks the bids, it doesn't pick the winner — supply chain can
    award any scored submission and give their reason. An omitted
    `submission_id` means the top-ranked one, which is the ordinary case.
    """

    submission_id: uuid.UUID | None = None
    reason: str | None = None


class AwardReassignment(BaseModel):
    """Moving a live award from one vendor to another.

    Both fields are required, unlike AwardDecision: there is no sensible default
    winner once one is already in place, and withdrawing a contract someone was
    told they had is not something to record without a reason.
    """

    submission_id: uuid.UUID
    reason: str
