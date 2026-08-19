"""The basket: what is actually being bought, line by line, and from whom.

The unit of an award moved once already — from a whole submission to a single
offer. This is the second move, and the last one: **the unit is the line**.

A tender asks for a mobile, a laptop, a tablet and a mouse. Nothing says one
vendor is the best answer to all four, and until now the model insisted they
were: approving an offer bought everything in it or nothing. Purchasing now
assembles a basket — this line from Acme's offer, that line from Techno's — and
the basket is what walks the approval chain.

Two things fall out of that for free:

* A vendor may bid on **some** of the items. Their offer covers what they can
  supply and stays silent on the rest, instead of being disqualified for a gap.
* A **by-hand** purchase is a basket whose lines have no offer behind them at
  all: purchasing walks to a shop, buys the thing, and fills the price and the
  seller in afterwards. Same table, `offer_item_id` null.

One live basket per tender. Rejecting it doesn't delete it — the row stays with
its reason, and a fresh one is started, so "what did we try to buy and who said
no" survives.
"""
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
    """Where the goods come from. Set once the tender is approved, before any
    RFQ goes out — after that the answer is baked into what happened."""

    vendors = "vendors"    # the normal path: invite vendors, collect offers
    by_hand = "by_hand"    # purchasing buys it themselves, cash or petty cash


class AwardStatus(str, enum.Enum):
    """Where the basket has got to. One column walked in order, same shape as
    the offer chain it replaces.

    draft -> submitted -> purchasing_manager_ok -> approved, with `rejected`
    reachable from any of them.
    """

    draft = "draft"                                    # purchasing still assembling it
    submitted = "submitted"                            # sent up; purchasing manager's turn
    purchasing_manager_ok = "purchasing_manager_ok"    # their manager signed it; supply chain next
    approved = "approved"                              # bought: finance pays, warehouse receives
    rejected = "rejected"                              # turned down, at whichever stage


class Award(Base, UUIDPKMixin):
    """One basket on one tender."""

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
    # False once superseded by a rejection. Kept rather than deleted: a basket
    # that was refused is part of how the tender came to be bought the way it
    # finally was.
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    currency: Mapped[str] = mapped_column(String(8), default="EGP")
    notes: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    # --- the approval trail, one pair per desk ---
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
    # True when urgency let the basket past the later desks. Recorded because
    # "why did nobody sign this off" has to have an answer on the row.
    urgent_skipped: Mapped[bool] = mapped_column(Boolean, default=False)

    lines: Mapped[list["AwardLine"]] = relationship(
        back_populates="award", cascade="all, delete-orphan", order_by="AwardLine.position"
    )


class AwardLine(Base, UUIDPKMixin):
    """One thing being bought, from one source.

    Every field the vendor quoted is **copied**, not referenced. The offer it
    came from can be superseded, and a by-hand line has no offer at all — either
    way, what was agreed has to keep saying what was agreed. The link back to
    `offer_item_id` is for provenance, not for reading the price off.
    """

    __tablename__ = "award_lines"

    award_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("awards.id", ondelete="CASCADE"), index=True
    )
    # Which requirement this answers. Null only for something bought that
    # nobody asked for on the tender — rare, but the by-hand path allows it.
    tender_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tender_items.id", ondelete="SET NULL"), index=True
    )
    # Which vendor line it was taken from. Null means it wasn't taken from an
    # offer: bought by hand, or typed in.
    offer_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("offer_items.id", ondelete="SET NULL"), index=True
    )

    # --- who it is being bought from ---
    # Both nullable and both kept. A registered vendor gets `vendor_id` so the
    # directory shows a consistent history; a corner shop gets a name and
    # nothing else. Filling in the name even when vendor_id is set means the
    # line still reads correctly if the vendor row is ever removed.
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
    # Zero is legitimate on a by-hand line that hasn't been filled in yet —
    # that is exactly the "empty template" purchasing completes after buying.
    unit_price: Mapped[float] = mapped_column(Numeric(14, 2), default=0)

    award: Mapped["Award"] = relationship(back_populates="lines")

    @property
    def line_total(self) -> float:
        """quantity x unit_price, computed rather than stored — a stored copy is
        one more thing that can disagree with the two numbers beside it."""
        return float(self.quantity) * float(self.unit_price)
