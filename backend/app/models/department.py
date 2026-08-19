import uuid
from sqlalchemy import String, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


PURCHASING_CODE = "purchasing"
SUPPLY_CHAIN_CODE = "supply_chain"
WAREHOUSE_CODE = "warehouse"


class Department(Base, UUIDPKMixin):
    __tablename__ = "departments"

    name: Mapped[str] = mapped_column(String(255), unique=True)
    code: Mapped[str | None] = mapped_column(String(32), unique=True, index=True)
    manager: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
