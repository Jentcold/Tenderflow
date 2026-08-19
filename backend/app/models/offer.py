"""Offers: what a vendor actually proposes, and what actually gets accepted.

The unit of a bid changed. A `Submission` is now the envelope — who bid, on
what tender, with which attachments — and the priced content lives in one or
more `Offer` rows underneath it. A vendor with two brands of keyboard, or with
three of the four items and a replacement for the fourth, files one submission
carrying several offers.

**One offer is accepted, never the whole submission.** That matters downstream:
what the warehouse receives and ticks off is one offer's item list, not
everything the vendor ever proposed.
"""
import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import UUIDPKMixin


class OfferStatus(str, enum.Enum):
    """Where an offer has got to. One column, walked in order - a separate
    "stage" field beside a "status" field is two things that can disagree.

    pending -> forwarded -> selected -> purchasing_ok -> purchasing_manager_ok
    -> approved, with `rejected` reachable from any of them.

    **A bid does not go straight to the department manager.** It lands at
    `pending`, where only purchasing can see it, and purchasing decides what is
    worth putting in front of the manager. What they forward becomes
    `forwarded`; what they don't stays `pending`, and the manager never sees it.

    That first pass is a real job, not a rubber stamp. Vendors quote things
    that miss the specification, price a line nobody asked about, or send a
    second try that supersedes their first. A manager comparing bids should be
    comparing bids that are actually comparable, and purchasing is the desk
    that knows which ones those are. It also keeps the manager's screen down to
    something a person will read.

    Several offers can then sit at `selected` at once: the department manager
    shortlists up to three of the forwarded ones in preference order (see
    `manager_rank`) rather than naming a single winner. From `purchasing_ok`
    on, only one survives - purchasing commits to one of the shortlist and the
    rest drop back to `forwarded`.
    """

    pending = "pending"                                # arrived; purchasing is filtering
    forwarded = "forwarded"                            # purchasing passed it to the department manager
    selected = "selected"                              # shortlisted by the department manager; purchasing's turn
    purchasing_ok = "purchasing_ok"                    # purchasing approved; their manager's turn
    purchasing_manager_ok = "purchasing_manager_ok"    # purchasing manager approved; supply chain's turn
    approved = "approved"                              # supply chain approved; on to finance/warehouse
    rejected = "rejected"                              # thrown out, at whichever stage


# The order the chain is walked in. Each approval endpoint checks the offer is
# sitting at its own step, so an offer can't skip a desk by calling the next
# endpoint directly.
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
    # Denormalised from the submission. Every read of this table is "all offers
    # on tender X, cheapest first" — going through submissions for it would put
    # a join on the one query that has to stay simple, and the tender of a
    # submission never changes, so there is nothing here to drift.
    tender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenders.id", ondelete="CASCADE"), index=True
    )

    position: Mapped[int] = mapped_column(Integer, default=0)
    # The vendor's own name for this option: "Logitech bundle", "budget
    # alternative". Shown to the manager, so it must not carry the company
    # name — the anonymised view can't strip what it can't recognise.
    title: Mapped[str | None] = mapped_column(String(255))
    total_amount: Mapped[float] = mapped_column(Numeric(14, 2))
    currency: Mapped[str] = mapped_column(String(8))
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[OfferStatus] = mapped_column(default=OfferStatus.pending)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # When purchasing passed this offer to the department manager, and who did.
    # Null means it has never been forwarded, which is what the manager's view
    # filters on. A status check wouldn't do: an offer that was forwarded,
    # shortlisted and then released has moved on from `forwarded` and still has
    # to stay visible to them.
    forwarded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    forwarded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    # --- the approval chain, one desk per pair ---
    # Same shape as the tender's own approval trail, so both read alike. Kept as
    # columns rather than derived from the audit log: "who signed this off" is a
    # question the offer itself has to answer, not one you reconstruct.
    manager_selected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    manager_selected_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # 1 = first choice, 2 = second, 3 = third. Null on anything not shortlisted.
    #
    # The manager doesn't pick a winner, they hand down an order of preference:
    # up to three offers they would accept, best first. Purchasing commits to
    # one of them. Kept as a small integer beside the status rather than as a
    # separate table — a shortlist is at most three rows and only ever read
    # alongside the offer itself.
    manager_rank: Mapped[int | None] = mapped_column(Integer)
    purchasing_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    purchasing_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    purchasing_manager_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    purchasing_manager_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    supply_chain_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    supply_chain_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    # Which step it was rejected at, kept after the status flips to `rejected` —
    # otherwise "rejected" alone can't tell you whether supply chain killed it
    # or purchasing never let it out of the room.
    rejected_at_stage: Mapped[OfferStatus | None] = mapped_column(
        Enum(OfferStatus, name="offerstatus")
    )
    rejected_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    # True when urgency let the offer past the purchasing-manager and supply
    # chain desks. Recorded because "why was this never approved by supply
    # chain" has to have an answer sitting on the row.
    urgent_skipped: Mapped[bool] = mapped_column(Boolean, default=False)

    items: Mapped[list["OfferItem"]] = relationship(
        back_populates="offer", cascade="all, delete-orphan", order_by="OfferItem.position"
    )


class OfferItem(Base, UUIDPKMixin):
    """One priced line of an offer.

    Mirrors a `TenderItem` when the vendor is quoting what was asked for, and
    stands alone when they aren't — `tender_item_id` is nullable precisely so a
    vendor can offer a replacement for something they don't stock, which is
    half the reason a bid has several offers in the first place.
    """

    __tablename__ = "offer_items"

    offer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("offers.id", ondelete="CASCADE"), index=True)
    # Null means "this line answers no particular tender item" — a replacement,
    # a substitute, or something the vendor threw in.
    tender_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tender_items.id", ondelete="SET NULL"), index=True
    )
    # Flagged by the vendor rather than inferred from a null tender_item_id: a
    # replacement can still be pinned to the line it replaces, and that is
    # exactly the case the manager most needs to see marked.
    is_replacement: Mapped[bool] = mapped_column(Boolean, default=False)

    position: Mapped[int] = mapped_column(Integer, default=0)
    # The vendor's own wording, not a copy of the tender's. What they are
    # actually supplying is the thing being judged.
    name: Mapped[str] = mapped_column(String(255))
    specs: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    quantity: Mapped[float] = mapped_column(Numeric(12, 2), default=1)
    unit: Mapped[str] = mapped_column(String(32), default="pcs")
    unit_price: Mapped[float] = mapped_column(Numeric(14, 2), default=0)

    offer: Mapped["Offer"] = relationship(back_populates="items")

    @property
    def line_total(self) -> float:
        """quantity x unit_price, computed rather than stored — a stored copy is
        one more thing that can disagree with the two numbers beside it."""
        return float(self.quantity) * float(self.unit_price)
