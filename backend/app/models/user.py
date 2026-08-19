import enum
import uuid

from sqlalchemy import Enum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin


class UserRole(str, enum.Enum):
    admin = "admin"
    procurement = "procurement"
    manager = "manager"
    supply_chain = "supply_chain"
    finance = "finance"
    vendor = "vendor"
    # A company employee who raises a tender request and waits on the manager's
    # decision. No back-office function: they never see bids or vendors.
    employee = "employee"


class UserStatus(str, enum.Enum):
    active = "active"
    inactive = "inactive"


class User(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "users"

    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(Enum(UserRole, name="user_role"))
    status: Mapped[UserStatus] = mapped_column(
        Enum(UserStatus, name="user_status"), default=UserStatus.active
    )
    # Which department this person belongs to. With `role = manager` it means
    # "manager OF this department", which is how the whole approval chain is
    # addressed now: the purchasing manager is simply the manager of the
    # Purchasing department, and adding a second one is adding a second row —
    # no new role, no new enum label, no migration.
    #
    # Null for admins and vendors, who sit outside the org chart. SET NULL on
    # delete rather than cascade: deleting a department must not delete the
    # people who worked in it.
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), index=True
    )
