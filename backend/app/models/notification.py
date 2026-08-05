import enum
import uuid

from sqlalchemy import JSON, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin
from app.models.user import UserRole


class NotificationType(str, enum.Enum):
    submission_received = "submission_received"
    evaluation_submitted = "evaluation_submitted"
    changes_requested = "changes_requested"
    manager_approved = "manager_approved"
    sc_rejected = "sc_rejected"
    tender_awarded = "tender_awarded"


class Notification(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "notifications"

    type: Mapped[NotificationType]
    tender_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenders.id", ondelete="CASCADE")
    )
    submission_id: Mapped[uuid.UUID | None] = mapped_column(
            ForeignKey("submissions.id", ondelete="CASCADE")
        )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), 
        index=True
    )
    for_role: Mapped[UserRole | None] = mapped_column(index=True)

    message: Mapped[str] = mapped_column(Text)
    read: Mapped[bool] = mapped_column(default=False)
    details: Mapped[dict | None] = mapped_column(JSON)