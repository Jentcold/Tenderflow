from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


class Department(Base, UUIDPKMixin):
    __tablename__ = "departments"

    name: Mapped[str] = mapped_column(String(255), unique=True)
