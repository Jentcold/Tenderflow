"""What actually turned up at the door.

Everything upstream of this file is a decision about what *should* be bought.
This is the first record of what was really delivered, and the two disagree
often enough that the difference is the whole point: a box short, a cracked
screen, a line the vendor quietly never sent.

The receipt is deliberately a record, not a status. An offer doesn't become
"received" by having a flag flipped on it — a `GoodsReceipt` row exists, or it
doesn't, and everything on the warehouse screen is derived from that. A flag
would have needed the truth to live in two places at once, and the interesting
detail (which lines were wrong, and how) has nowhere to live on a flag anyway.

One receipt per purchase. Partial deliveries are recorded as lines in a problem
condition rather than as a second receipt: the warehouse ticks off the list
once, when the shipment arrives, and what didn't arrive is a fact about that
same visit. Splitting a delivery across several receipts would mean the
question "was this order received" no longer has one answer.

A purchase is one of two things, so a receipt points at one of two things: an
`offer_id` (one vendor's offer cleared the chain) or an `award_id` (a basket
did). Exactly one, enforced in the database. Everything the warehouse actually
does is identical either way - the goods still walk through the same door, and
somebody still has to say whether the right ones turned up - so the difference
stops at which column is filled in.
"""
import enum
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Numeric, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import UUIDPKMixin


class LineCondition(str, enum.Enum):
    """How one line of the order turned up.

    `ok` is the only one that needs no explanation, which is why the API
    insists on a note for every other value. A line marked `damaged` with no
    word about what the damage was is not a report, it is a shrug, and supply
    chain can do nothing with it.
    """

    ok = "ok"                          # arrived, right thing, right count
    short = "short"                    # arrived, but fewer than ordered
    missing = "missing"                # not in the shipment at all
    damaged = "damaged"                # arrived broken
    wrong_item = "wrong_item"          # something else turned up instead
    other = "other"                    # anything the list above doesn't cover


# The conditions that mean somebody upstream has to do something about it.
# Used to decide whether a receipt gets flagged, and to notify on it.
PROBLEM_CONDITIONS = [c for c in LineCondition if c is not LineCondition.ok]


class GoodsReceipt(Base, UUIDPKMixin):
    __tablename__ = "goods_receipts"

    # Exactly one of the two below is filled in. Both are unique, and both are
    # nullable - Postgres counts nulls as distinct in a unique index, so "one
    # receipt per purchase" still holds with half the column empty.
    __table_args__ = (
        CheckConstraint(
            "(offer_id IS NULL) <> (award_id IS NULL)",
            name="ck_goods_receipts_one_source",
        ),
    )

    # One vendor's offer cleared the chain. The offer is what the warehouse
    # ticks against: the priced list somebody committed to, whose line items
    # are exactly what the vendor said they would send.
    offer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("offers.id", ondelete="CASCADE"), unique=True, index=True
    )
    # ...or a basket did. Its lines are the priced list instead, and they can
    # span several suppliers - which changes nothing at the door.
    award_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("awards.id", ondelete="CASCADE"), unique=True, index=True
    )
    # Denormalised, like `Offer.tender_id` above it and for the same reason:
    # every read of this table is "what has arrived for this tender".
    tender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenders.id", ondelete="CASCADE"), index=True
    )

    received_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # Anything about the delivery as a whole rather than about one line - the
    # driver, the paperwork, the state of the pallet.
    notes: Mapped[str | None] = mapped_column(Text)

    lines: Mapped[list["GoodsReceiptLine"]] = relationship(
        back_populates="receipt", cascade="all, delete-orphan"
    )


class GoodsReceiptLine(Base, UUIDPKMixin):
    __tablename__ = "goods_receipt_lines"

    receipt_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("goods_receipts.id", ondelete="CASCADE"), index=True
    )
    # SET NULL rather than CASCADE: if an offer line is ever deleted, the fact
    # that something arrived against it is still true and still worth keeping.
    offer_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("offer_items.id", ondelete="SET NULL"), index=True
    )
    # The same thing for a basket receipt. Which of the two is set follows the
    # receipt above it; neither is set once the source row has been deleted,
    # which is why the copied fields below are not optional.
    award_line_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("award_lines.id", ondelete="SET NULL"), index=True
    )

    # Copied off the source line at receiving time rather than joined on read.
    # This is a record of what was checked in, and it has to keep reading the
    # same way years later even if the source line is edited or removed.
    name: Mapped[str] = mapped_column(Text)
    ordered_quantity: Mapped[float] = mapped_column(Numeric(12, 2), default=0)

    condition: Mapped[LineCondition] = mapped_column(default=LineCondition.ok)
    # What was actually taken in. Equals `ordered_quantity` on an `ok` line and
    # is the useful number on a `short` one.
    received_quantity: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    notes: Mapped[str | None] = mapped_column(Text)

    receipt: Mapped["GoodsReceipt"] = relationship(back_populates="lines")
