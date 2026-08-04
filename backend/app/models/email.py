import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


class EmailType(str, enum.Enum):
    winner = "winner"
    loser = "loser"


class EmailTemplate(Base):
    """One row per type: 'winner' and 'loser'. Seeded on first run, editable by procurement."""

    __tablename__ = "email_templates"

    type: Mapped[EmailType] = mapped_column(primary_key=True)
    subject: Mapped[str] = mapped_column(String(500))
    body: Mapped[str] = mapped_column(Text)


class SentEmail(Base, UUIDPKMixin):
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
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
