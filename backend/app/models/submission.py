import enum
import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


class SubmissionStatus(str, enum.Enum):
    pending = "pending"
    validated = "validated"
    rejected = "rejected"


class Submission(Base, UUIDPKMixin):
    __tablename__ = "submissions"

    tender_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    # Copied from the tender on submit, so the width has to match tenders.currency.
    currency: Mapped[str] = mapped_column(String(8), nullable=False)

    # Set only when a registered vendor was authenticated at submit time.
    # Bids through the public link leave it null — the company_name/email
    # below are then just what the form said, with nothing vouching for them.
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True, index=True
    )

    company_name: Mapped[str] = mapped_column(String(255))
    contact_name: Mapped[str] = mapped_column(String(255))
    email: Mapped[str] = mapped_column(String(255), index=True)
    phone: Mapped[str] = mapped_column(String(64))
    total_amount: Mapped[float] = mapped_column(Numeric(14, 2))
    notes: Mapped[str | None] = mapped_column(Text)
    files: Mapped[list[str]] = mapped_column(JSON, default=list)
    status: Mapped[SubmissionStatus] = mapped_column(default=SubmissionStatus.pending)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
