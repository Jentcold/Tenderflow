import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin, TimestampMixin


class EmailType(str, enum.Enum):
    winner = "winner"
    loser = "loser"
    # Sent to a vendor whose award was withdrawn and given to someone else.
    # Deliberately not the loser template: that one tells a vendor they were
    # never selected, which is not what happened to them.
    award_revoked = "award_revoked"


class EmailStatus(str, enum.Enum):
    queued = "queued"        # rendered and stored, not handed to SMTP yet
    sent = "sent"            # the mail server accepted it
    failed = "failed"        # every attempt was refused; see `error`
    simulated = "simulated"  # no SMTP_HOST configured, nothing was delivered


class EmailTemplate(Base):
    """One row per type: 'winner' and 'loser'. Seeded on first run, editable by procurement."""

    __tablename__ = "email_templates"

    type: Mapped[EmailType] = mapped_column(primary_key=True)
    subject: Mapped[str] = mapped_column(String(500))
    body: Mapped[str] = mapped_column(Text)


class SentEmail(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "sent_emails"

    tender_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    tender_serial: Mapped[str] = mapped_column(String(32))
    tender_name: Mapped[str] = mapped_column(String(255))
    submission_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("submissions.id", ondelete="CASCADE"))
    vendor_company: Mapped[str] = mapped_column(String(255))
    recipient_email: Mapped[str] = mapped_column(String(255))
    type: Mapped[EmailType]
    subject: Mapped[str] = mapped_column(String(500))
    body: Mapped[str] = mapped_column(Text)

    # Delivery outcome. `created_at` (from TimestampMixin) is when the mail was
    # queued; `sent_at` is when a mail server actually took it, and stays NULL
    # until then.
    status: Mapped[EmailStatus] = mapped_column(default=EmailStatus.queued, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
