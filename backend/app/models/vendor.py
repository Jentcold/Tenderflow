import secrets
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin
from app.models.category import Category, vendor_categories


def new_vendor_code() -> str:
    """A short, unguessable identifier for one vendor.

    Unguessable rather than sequential (`V-001`, `V-002`) because it travels in
    the tender link. Anything countable would let one vendor walk the sequence
    and open the next company's page.
    """
    return "V-" + secrets.token_urlsafe(9).upper().replace("_", "").replace("-", "")[:12]


class Vendor(Base, UUIDPKMixin, TimestampMixin):
    """A company we buy from. **Not** a login.

    Vendors don't have accounts. Purchasing creates the record here, and the
    vendor reaches a tender through a link addressed to them — no username, no
    password, nothing to reset, nothing to leave enabled after the relationship
    ends. One directory, and it is this table.

    `user_id` survives only for rows created before that decision. It is
    nullable and nothing new sets it; a vendor with an account attached still
    can't log in, because auth refuses the role outright.
    """

    __tablename__ = "vendors"

    # Legacy. Kept so old submissions still join to something, never populated
    # by new code. See `app/routers/auth.py` for the login refusal.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), unique=True, index=True
    )

    # What goes in the link, and what purchasing quotes on the phone.
    code: Mapped[str] = mapped_column(
        String(32), unique=True, index=True, default=new_vendor_code
    )

    company_name: Mapped[str] = mapped_column(String(255), index=True)

    # Where tender correspondence goes. Nullable: a vendor with no email is
    # exactly the case that has to be reachable another way, and refusing to
    # record them would just push them out of the system entirely.
    contact_email: Mapped[str | None] = mapped_column(String(255))
    # Matches submissions.phone. The old String(20) silently truncated anything
    # with a country code and an extension.
    contact_phone: Mapped[str | None] = mapped_column(String(64))

    # What they supply, and it is a list.
    #
    # This was one enum column, which forced a company selling laptops and
    # desks to be filed under one of them - and the other half of their
    # catalogue was then invisible to the invite list and the basket picker,
    # which both match on category. A vendor is a candidate for a tender if
    # ANY of their categories is the tender's.
    categories: Mapped[list[Category]] = relationship(
        secondary=vendor_categories, back_populates="vendors", lazy="selectin"
    )

    tax_id: Mapped[str | None] = mapped_column(String(255))
    address: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)

    # Retire, don't delete: a vendor who supplied something is part of how that
    # purchase happened. Inactive vendors drop out of the invite picker.
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))


def new_invite_token() -> str:
    """The secret in a tender link. Long, random, and per (tender, vendor).

    Per invite rather than per vendor so it can be revoked for one tender
    without cutting the vendor off from every other, and so a leaked link
    exposes exactly one tender.
    """
    return secrets.token_urlsafe(32)


class TenderVendorInvite(Base, UUIDPKMixin):
    """One vendor invited to bid on one tender.

    Purchasing chooses who gets asked. Being in the tender's category makes a
    vendor a *candidate*, not a recipient — the whole point of this table is
    that the shortlist of who actually gets the email is a decision somebody
    makes, not a query result.
    """

    __tablename__ = "tender_vendor_invites"

    tender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenders.id", ondelete="CASCADE"), index=True
    )
    vendor_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("vendors.id", ondelete="CASCADE"), index=True
    )
    token: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, default=new_invite_token
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    invited_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    # Null until the RFQ actually goes out. Selecting vendors and sending to
    # them are two steps: purchasing picks the list, checks it, then sends.
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set when there was no email address to send to, so the "who still needs
    # telling" list is answerable without guessing.
    needs_other_channel: Mapped[bool] = mapped_column(Boolean, default=False)

    revoked: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
