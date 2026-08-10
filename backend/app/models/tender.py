import enum
import uuid
from datetime import date, datetime, time

from sqlalchemy import JSON, Date, DateTime, Enum, ForeignKey, Numeric, String, Text, Time
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin
from app.models.category import Category


class TenderStatus(str, enum.Enum):
    pending_approval = "pending_approval"  # created, waiting on the department manager
    open = "open"                          # manager approved it; vendors can submit
    closed = "closed"
    awarded = "awarded"
    rejected = "rejected"                  # manager turned the tender down


class Tender(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "tenders"

    serial: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text)
    deadline_date: Mapped[date] = mapped_column(Date)
    deadline_time: Mapped[time] = mapped_column(Time)
    currency: Mapped[str] = mapped_column(String(8))
    category: Mapped[Category] = mapped_column(Enum(Category, name="category"), default=Category.goods)
    # New tenders are not visible to vendors until a manager approves them.
    status: Mapped[TenderStatus] = mapped_column(default=TenderStatus.pending_approval)

    department_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("departments.id"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    required_docs: Mapped[list[str]] = mapped_column(JSON, default=list)
    # scoring_criteria: [{"name": "Price", "weight": 40}, ...] - weights must sum to 100
    scoring_criteria: Mapped[list[dict]] = mapped_column(JSON, default=list)

    # --- Stage 1: department manager approves the tender itself ---
    # Gates whether the tender ever opens to vendors. Nothing to do with scoring.
    manager_approved: Mapped[bool] = mapped_column(default=False)
    manager_rejected: Mapped[bool] = mapped_column(default=False)
    manager_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    manager_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    manager_feedback: Mapped[str | None] = mapped_column(Text)

    # --- Stage 2: procurement finishes scoring and hands off for award ---
    evaluation_submitted: Mapped[bool] = mapped_column(default=False)
    evaluation_submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    evaluation_submitted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    # --- Stage 3: supply chain awards the top-scored submission ---
    supply_chain_approved: Mapped[bool] = mapped_column(default=False)
    supply_chain_rejected: Mapped[bool] = mapped_column(default=False)
    supply_chain_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    supply_chain_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    supply_chain_rejection_reason: Mapped[str | None] = mapped_column(Text)

    # --- Award ---
    awarded_vendor_submission_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("submissions.id", use_alter=True, name="fk_tenders_awarded_submission")
    )
    awarded_vendor_name: Mapped[str | None] = mapped_column(String(255))
    awarded_amount: Mapped[float | None] = mapped_column(Numeric(14, 2))
    awarded_email: Mapped[str | None] = mapped_column(String(255))
