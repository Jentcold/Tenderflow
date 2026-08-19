import secrets
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin
from app.models.category import Category, vendor_categories


def new_vendor_code() -> str:
    return "V-" + secrets.token_urlsafe(9).upper().replace("_", "").replace("-", "")[:12]


class Vendor(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "vendors"

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), unique=True, index=True
    )

    code: Mapped[str] = mapped_column(
        String(32), unique=True, index=True, default=new_vendor_code
    )

    company_name: Mapped[str] = mapped_column(String(255), index=True)

    contact_email: Mapped[str | None] = mapped_column(String(255))
    contact_phone: Mapped[str | None] = mapped_column(String(64))

    categories: Mapped[list[Category]] = relationship(
        secondary=vendor_categories, back_populates="vendors", lazy="selectin"
    )

    tax_id: Mapped[str | None] = mapped_column(String(255))
    address: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)

    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))


def new_invite_token() -> str:
    return secrets.token_urlsafe(32)


class TenderVendorInvite(Base, UUIDPKMixin):
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
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    needs_other_channel: Mapped[bool] = mapped_column(Boolean, default=False)

    revoked: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
