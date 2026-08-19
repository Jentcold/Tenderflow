import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import UUIDPKMixin


class SourcingMode(str, enum.Enum):
    vendors = "vendors"
    by_hand = "by_hand"


class AwardStatus(str, enum.Enum):
    draft = "draft"
    submitted = "submitted"
    purchasing_manager_ok = "purchasing_manager_ok"
    approved = "approved"
    rejected = "rejected"


class Award(Base, UUIDPKMixin):
    __tablename__ = "awards"

    tender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenders.id", ondelete="CASCADE"), index=True
    )
    mode: Mapped[SourcingMode] = mapped_column(
        Enum(SourcingMode, name="sourcingmode"), default=SourcingMode.vendors
    )
    status: Mapped[AwardStatus] = mapped_column(
        Enum(AwardStatus, name="awardstatus"), default=AwardStatus.draft, index=True
    )
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    currency: Mapped[str] = mapped_column(String(8), default="EGP")
    notes: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    purchasing_manager_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    purchasing_manager_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    supply_chain_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    supply_chain_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    rejected_at_stage: Mapped[AwardStatus | None] = mapped_column(
        Enum(AwardStatus, name="awardstatus")
    )
    rejected_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    urgent_skipped: Mapped[bool] = mapped_column(Boolean, default=False)

    lines: Mapped[list["AwardLine"]] = relationship(
        back_populates="award", cascade="all, delete-orphan", order_by="AwardLine.position"
    )


class AwardLine(Base, UUIDPKMixin):
    __tablename__ = "award_lines"

    award_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("awards.id", ondelete="CASCADE"), index=True
    )
    tender_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tender_items.id", ondelete="SET NULL"), index=True
    )
    offer_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("offer_items.id", ondelete="SET NULL"), index=True
    )

    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("vendors.id", ondelete="SET NULL"), index=True
    )
    vendor_name: Mapped[str | None] = mapped_column(String(255))

    position: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(255))
    specs: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    quantity: Mapped[float] = mapped_column(Numeric(12, 2), default=1)
    unit: Mapped[str] = mapped_column(String(32), default="pcs")
    unit_price: Mapped[float] = mapped_column(Numeric(14, 2), default=0)

    award: Mapped["Award"] = relationship(back_populates="lines")

    @property
    def line_total(self) -> float:
        return float(self.quantity) * float(self.unit_price)
