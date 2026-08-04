import enum
import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Numeric, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


class EvaluatorRole(str, enum.Enum):
    procurement = "procurement"
    manager = "manager"


class Evaluation(Base, UUIDPKMixin):
    __tablename__ = "evaluations"
    __table_args__ = (UniqueConstraint("submission_id", "evaluator_role", name="uq_submission_evaluator"),)

    submission_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("submissions.id", ondelete="CASCADE"), index=True)
    tender_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    evaluator_role: Mapped[EvaluatorRole] = mapped_column(default=EvaluatorRole.procurement)

    # {"Price": 8.5, "Technical": 7.0, ...}
    scores: Mapped[dict] = mapped_column(JSON, default=dict)
    total_score: Mapped[float] = mapped_column(Numeric(4, 2), default=0)
    notes: Mapped[str | None] = mapped_column(Text)

    evaluated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    evaluated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
