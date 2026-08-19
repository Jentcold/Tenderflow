import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import UUIDPKMixin


class OfferStatus(str, enum.Enum):
    pending = "pending"
    forwarded = "forwarded"
    selected = "selected"
    purchasing_ok = "purchasing_ok"
    purchasing_manager_ok = "purchasing_manager_ok"
    approved = "approved"
    rejected = "rejected"


APPROVAL_ORDER = [
    OfferStatus.forwarded,
    OfferStatus.selected,
    OfferStatus.purchasing_ok,
    OfferStatus.purchasing_manager_ok,
    OfferStatus.approved,
]


class Offer(Base, UUIDPKMixin):
    __tablename__ = "offers"

    submission_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE"), index=True
    )
    tender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenders.id", ondelete="CASCADE"), index=True
    )

    position: Mapped[int] = mapped_column(Integer, default=0)
    title: Mapped[str | None] = mapped_column(String(255))
    total_amount: Mapped[float] = mapped_column(Numeric(14, 2))
    currency: Mapped[str] = mapped_column(String(8))
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[OfferStatus] = mapped_column(default=OfferStatus.pending)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    forwarded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    forwarded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    manager_selected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    manager_selected_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    manager_rank: Mapped[int | None] = mapped_column(Integer)
    purchasing_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    purchasing_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    purchasing_manager_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    purchasing_manager_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    supply_chain_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    supply_chain_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    rejected_at_stage: Mapped[OfferStatus | None] = mapped_column(
        Enum(OfferStatus, name="offerstatus")
    )
    rejected_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    urgent_skipped: Mapped[bool] = mapped_column(Boolean, default=False)

    items: Mapped[list["OfferItem"]] = relationship(
        back_populates="offer", cascade="all, delete-orphan", order_by="OfferItem.position"
    )


class OfferItem(Base, UUIDPKMixin):
    __tablename__ = "offer_items"

    offer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("offers.id", ondelete="CASCADE"), index=True)
    tender_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tender_items.id", ondelete="SET NULL"), index=True
    )
    is_replacement: Mapped[bool] = mapped_column(Boolean, default=False)

    position: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(255))
    specs: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    quantity: Mapped[float] = mapped_column(Numeric(12, 2), default=1)
    unit: Mapped[str] = mapped_column(String(32), default="pcs")
    unit_price: Mapped[float] = mapped_column(Numeric(14, 2), default=0)

    offer: Mapped["Offer"] = relationship(back_populates="items")

    @property
    def line_total(self) -> float:
        return float(self.quantity) * float(self.unit_price)
