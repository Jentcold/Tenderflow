import enum
import uuid
from datetime import date, datetime, time

from sqlalchemy import JSON, Date, DateTime, Enum, ForeignKey, Numeric, String, Text, Time
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.award import SourcingMode
from app.models.base import TimestampMixin, UUIDPKMixin
from app.models.category import Category


class TenderStatus(str, enum.Enum):
    pending_approval = "pending_approval"
    open = "open"
    closed = "closed"
    awarded = "awarded"
    rejected = "rejected"


class Tender(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "tenders"

    serial: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    deadline_date: Mapped[date | None] = mapped_column(Date)
    deadline_time: Mapped[time | None] = mapped_column(Time)
    currency: Mapped[str] = mapped_column(String(8))
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), index=True
    )
    category_ref: Mapped[Category | None] = relationship(lazy="selectin")
    @property
    def category(self) -> str:
        return self.category_ref.slug if self.category_ref else ""

    @property
    def category_name(self) -> str:
        return self.category_ref.name if self.category_ref else ""

    status: Mapped[TenderStatus] = mapped_column(default=TenderStatus.pending_approval)

    department_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("departments.id"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    required_docs: Mapped[list[str]] = mapped_column(JSON, default=list)

    manager_approved: Mapped[bool] = mapped_column(default=False)
    manager_rejected: Mapped[bool] = mapped_column(default=False)
    manager_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    manager_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    manager_feedback: Mapped[str | None] = mapped_column(Text)
    manager_declined: Mapped[bool] = mapped_column(default=False)
    urgent: Mapped[bool] = mapped_column(default=False)

    sourcing_mode: Mapped["SourcingMode"] = mapped_column(
        Enum(SourcingMode, name="sourcingmode"), default=SourcingMode.vendors
    )

    supply_chain_approved: Mapped[bool] = mapped_column(default=False)
    supply_chain_rejected: Mapped[bool] = mapped_column(default=False)
    supply_chain_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    supply_chain_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    supply_chain_rejection_reason: Mapped[str | None] = mapped_column(Text)

    awarded_vendor_submission_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("submissions.id", use_alter=True, name="fk_tenders_awarded_submission")
    )
    awarded_offer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("offers.id", use_alter=True, name="fk_tenders_awarded_offer", ondelete="SET NULL")
    )
    awarded_vendor_name: Mapped[str | None] = mapped_column(String(255))
    awarded_amount: Mapped[float | None] = mapped_column(Numeric(14, 2))
    awarded_email: Mapped[str | None] = mapped_column(String(255))
