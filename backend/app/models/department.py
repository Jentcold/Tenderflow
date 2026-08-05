import uuid
from sqlalchemy import String, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


class Department(Base, UUIDPKMixin):
    __tablename__ = "departments"

    name: Mapped[str] = mapped_column(String(255), unique=True)
    manager: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
