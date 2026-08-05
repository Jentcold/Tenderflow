import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Numeric, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


class Evaluation(Base, UUIDPKMixin):
    __tablename__ = "evaluations"

    submission_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE"), 
        unique=True,  # One evaluation per submission!
        index=True
    )
    tender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenders.id", ondelete="CASCADE"), 
        index=True
    )

    scores: Mapped[dict] = mapped_column(JSON, default=dict)
    total_score: Mapped[float] = mapped_column(Numeric(4, 2), default=0)
    notes: Mapped[str | None] = mapped_column(Text)

    evaluated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    evaluated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))