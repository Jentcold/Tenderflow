import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.evaluation import EvaluatorRole


class EvaluationSave(BaseModel):
    scores: dict[str, float]
    notes: str | None = None


class EvaluationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    submission_id: uuid.UUID
    tender_id: uuid.UUID
    evaluator_role: EvaluatorRole
    scores: dict
    total_score: float
    notes: str | None
    evaluated_by: uuid.UUID | None
    evaluated_at: datetime | None


class RankedSubmissionOut(BaseModel):
    """Submission plus whatever evaluation(s) exist, sorted for display."""

    id: uuid.UUID
    company_name: str
    contact_name: str
    email: str
    phone: str
    total_amount: float
    notes: str | None
    files: list[str]
    submitted_at: datetime

    procurement_evaluation: EvaluationOut | None = None
    manager_evaluation: EvaluationOut | None = None
    combined_score: float | None = None


class RejectionReason(BaseModel):
    reason: str
