import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin, TimestampMixin


class EmailType(str, enum.Enum):
    # The invitation to quote, carrying the vendor's own tender link. The only
    # type sent before there is a bid to talk about, which is why
    # `SentEmail.submission_id` had to become nullable.
    rfq = "rfq"
    winner = "winner"
    loser = "loser"
    # Sent to a vendor whose award was withdrawn and given to someone else.
    # Deliberately not the loser template: that one tells a vendor they were
    # never selected, which is not what happened to them.
    award_revoked = "award_revoked"
    # A basket award: this vendor won SOME of the tender, not all of it.
    #
    # Its own type rather than the winner template, because the two say
    # genuinely different things. `winner` tells a vendor the tender is theirs;
    # a basket may have taken two lines from them and three from somebody else,
    # and sending them "congratulations, you have won" would have them
    # delivering the whole order. This one names the lines they actually got.
    basket_award = "basket_award"


class EmailStatus(str, enum.Enum):
    queued = "queued"        # rendered and stored, not handed to SMTP yet
    sent = "sent"            # the mail server accepted it
    failed = "failed"        # every attempt was refused; see `error`
    simulated = "simulated"  # no SMTP_HOST configured, nothing was delivered


class EmailTemplate(Base):
    """One row per type. Seeded on first run, editable by purchasing.

    The RFQ is deliberately not templated here yet — it carries a per-vendor
    link that has to be built per recipient, so it is rendered inline in the
    invite router rather than from a stored body someone could break by
    deleting the placeholder.
    """

    __tablename__ = "email_templates"

    type: Mapped[EmailType] = mapped_column(primary_key=True)
    subject: Mapped[str] = mapped_column(String(500))
    body: Mapped[str] = mapped_column(Text)


class SentEmail(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "sent_emails"

    tender_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenders.id", ondelete="CASCADE"), index=True)
    tender_serial: Mapped[str] = mapped_column(String(32))
    tender_name: Mapped[str] = mapped_column(String(255))
    # Null on an RFQ: it goes out before anyone has bid.
    submission_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("submissions.id", ondelete="CASCADE")
    )
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
