from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin


class AuditLog(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "audit_log"

    action: Mapped[str] = mapped_column(String(255))
    details: Mapped[str] = mapped_column(Text)
    user_name: Mapped[str] = mapped_column(String(255))
