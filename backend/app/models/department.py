import uuid
from sqlalchemy import String, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


# Departments the workflow itself has to be able to find. Purchasing is the one
# that matters most: its manager approves every offer regardless of which
# department raised the tender, so the code has to be able to point at that
# department without depending on somebody not renaming "Purchasing" to
# "Purchasing & Procurement" one afternoon.
PURCHASING_CODE = "purchasing"
SUPPLY_CHAIN_CODE = "supply_chain"
WAREHOUSE_CODE = "warehouse"


class Department(Base, UUIDPKMixin):
    __tablename__ = "departments"

    name: Mapped[str] = mapped_column(String(255), unique=True)
    # Null for ordinary departments — only the ones the workflow names carry a
    # code, and it stays stable while the display name is free to change.
    code: Mapped[str | None] = mapped_column(String(32), unique=True, index=True)
    manager: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
