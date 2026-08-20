import enum
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Numeric, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import UUIDPKMixin


class LineCondition(str, enum.Enum):
    ok = "ok"
    short = "short"
    missing = "missing"
    damaged = "damaged"
    wrong_item = "wrong_item"
    other = "other"


class GoodsReceipt(Base, UUIDPKMixin):
    __tablename__ = "goods_receipts"

    __table_args__ = (
        CheckConstraint(
            "(offer_id IS NULL) <> (award_id IS NULL)",
            name="ck_goods_receipts_one_source",
        ),
    )

    offer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("offers.id", ondelete="CASCADE"), unique=True, index=True
    )
    award_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("awards.id", ondelete="CASCADE"), unique=True, index=True
    )
    tender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenders.id", ondelete="CASCADE"), index=True
    )

    received_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    notes: Mapped[str | None] = mapped_column(Text)

    lines: Mapped[list["GoodsReceiptLine"]] = relationship(
        back_populates="receipt", cascade="all, delete-orphan"
    )


class GoodsReceiptLine(Base, UUIDPKMixin):
    __tablename__ = "goods_receipt_lines"

    receipt_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("goods_receipts.id", ondelete="CASCADE"), index=True
    )
    offer_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("offer_items.id", ondelete="SET NULL"), index=True
    )
    award_line_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("award_lines.id", ondelete="SET NULL"), index=True
    )

    name: Mapped[str] = mapped_column(Text)
    ordered_quantity: Mapped[float] = mapped_column(Numeric(12, 2), default=0)

    condition: Mapped[LineCondition] = mapped_column(default=LineCondition.ok)
    received_quantity: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    notes: Mapped[str | None] = mapped_column(Text)

    receipt: Mapped["GoodsReceipt"] = relationship(back_populates="lines")
