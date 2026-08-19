import enum
import uuid

from sqlalchemy import JSON, Enum, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin
from app.models.user import UserRole


class NotificationType(str, enum.Enum):
    tender_pending_approval = "tender_pending_approval"  # -> manager, a new tender needs a decision
    manager_approved = "manager_approved"                # -> procurement, the tender is now open
    changes_requested = "changes_requested"              # -> procurement, manager sent it back
    submission_received = "submission_received"
    # Renamed from `evaluation_submitted` when scoring was removed. It now means
    # "an offer moved a step along the approval chain" and is addressed at
    # whichever desk is next, which is what it had come to mean anyway.
    offer_selected = "offer_selected"
    sc_rejected = "sc_rejected"
    tender_awarded = "tender_awarded"
    # -> supply chain and purchasing, the warehouse has checked a delivery in.
    # Raised whether or not anything was wrong; the message says which.
    goods_received = "goods_received"


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
    # Named explicitly so this shares `user_role` with users.role. Left to
    # infer, SQLAlchemy names it `userrole` and you get a second copy of the
    # same enum that no label migration ever reaches (see b8f31d0c5e42).
    for_role: Mapped[UserRole | None] = mapped_column(
        Enum(UserRole, name="user_role"), index=True
    )

    message: Mapped[str] = mapped_column(Text)
    read: Mapped[bool] = mapped_column(default=False)
    details: Mapped[dict | None] = mapped_column(JSON)