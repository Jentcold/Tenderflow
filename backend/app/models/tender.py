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
    pending_approval = "pending_approval"  # created, waiting on the department manager
    open = "open"                          # manager approved it; vendors can submit
    closed = "closed"
    awarded = "awarded"
    rejected = "rejected"                  # manager turned the tender down


class Tender(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "tenders"

    serial: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    # Kept for tenders raised before the requirement became a table, and for
    # the covering note a template carries. Nothing collects it on the request
    # form any more — what is needed is the item rows, not a paragraph.
    description: Mapped[str | None] = mapped_column(Text)
    # Null until the approving manager sets it. The requester says what they
    # need; when it has to be here is the manager's call, so a tender waiting
    # for approval has no deadline yet.
    deadline_date: Mapped[date | None] = mapped_column(Date)
    deadline_time: Mapped[time | None] = mapped_column(Time)
    currency: Mapped[str] = mapped_column(String(8))
    # The admin's category list, not an enum - see app/models/category.py.
    # Nullable only so a category can be retired without taking the tenders
    # filed under it with it; every tender the app creates has one.
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), index=True
    )
    category_ref: Mapped[Category | None] = relationship(lazy="selectin")
    # `category` and `category_name` stay plain strings to everything that
    # reads them - the schemas, the browser, the email templates - even though
    # what backs them is now a row rather than an enum value. The relationship
    # is `category_ref`; these two are what the API has always exposed, so
    # swapping the storage cost no caller a change.
    @property
    def category(self) -> str:
        return self.category_ref.slug if self.category_ref else ""

    @property
    def category_name(self) -> str:
        return self.category_ref.name if self.category_ref else ""

    # New tenders are not visible to vendors until a manager approves them.
    status: Mapped[TenderStatus] = mapped_column(default=TenderStatus.pending_approval)

    department_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("departments.id"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    required_docs: Mapped[list[str]] = mapped_column(JSON, default=list)

    # --- Stage 1: department manager approves the tender itself ---
    # Gates whether the tender ever opens to vendors.
    manager_approved: Mapped[bool] = mapped_column(default=False)
    manager_rejected: Mapped[bool] = mapped_column(default=False)
    manager_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    manager_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    manager_feedback: Mapped[str | None] = mapped_column(Text)
    # Whether the rejection was final. Both answers leave the tender
    # `rejected`; the difference is what the requester may do next. False means
    # "fix this and send it back" and `resubmit` is open to them. True means
    # "we are not buying this" — resubmit is refused, and raising it again has
    # to be a new request, so a declined one can't quietly reappear in the
    # manager's queue until they give in.
    manager_declined: Mapped[bool] = mapped_column(default=False)
    # Set by the manager when they approve (or at any time afterwards). Urgent
    # tenders may skip the purchasing-manager and supply-chain approvals later
    # in the flow — those approvers still get notified, they just aren't a gate.
    # It is the manager's call and nobody else's, which is why it lives here
    # beside their other decisions rather than on the create form.
    urgent: Mapped[bool] = mapped_column(default=False)

    # --- Stage 1b: purchasing decides where the goods come from ---
    # Set after the manager approves and before any RFQ goes out, because after
    # that the answer is baked into what actually happened. `by_hand` means
    # purchasing buys it themselves: no vendors are invited, the later approval
    # desks are notified rather than waited on, and the basket is filled in with
    # real prices once the shopping is done.
    sourcing_mode: Mapped["SourcingMode"] = mapped_column(
        Enum(SourcingMode, name="sourcingmode"), default=SourcingMode.vendors
    )

    # --- Stage 2: supply chain signs off the offer that won ---
    # Written when an offer clears the last approval, so the tender row still
    # answers "was this bought, and when" without walking the offers table.
    supply_chain_approved: Mapped[bool] = mapped_column(default=False)
    supply_chain_rejected: Mapped[bool] = mapped_column(default=False)
    supply_chain_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    supply_chain_reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    supply_chain_rejection_reason: Mapped[str | None] = mapped_column(Text)

    # --- Award ---
    awarded_vendor_submission_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("submissions.id", use_alter=True, name="fk_tenders_awarded_submission")
    )
    # The manager's pick. One OFFER wins, not a whole submission — a vendor may
    # have proposed three, and only the chosen one is bought, delivered and
    # received. `awarded_vendor_submission_id` above still records which bid it
    # came from, for the award emails that address a company.
    awarded_offer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("offers.id", use_alter=True, name="fk_tenders_awarded_offer", ondelete="SET NULL")
    )
    awarded_vendor_name: Mapped[str | None] = mapped_column(String(255))
    awarded_amount: Mapped[float | None] = mapped_column(Numeric(14, 2))
    awarded_email: Mapped[str | None] = mapped_column(String(255))
