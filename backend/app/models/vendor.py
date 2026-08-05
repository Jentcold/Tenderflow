import enum, uuid

from sqlalchemy import String, ForeignKey, Text, Enum
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin


class VendorCategory(str, enum.Enum):
    goods = "goods"
    services = "services"
    works = "works"
    consulting = "consulting"




class Vendor(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "vendors"

    user_id : Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    company_name : Mapped[str] = mapped_column(String(255))

    contact_email : Mapped[str] = mapped_column(Text)
    contact_phone : Mapped[str] = mapped_column(String(20))

    vendor_category : Mapped[VendorCategory] = mapped_column(Enum(VendorCategory, name="vendor_category"))

    tax_id : Mapped[str] = mapped_column(String(255))
    address : Mapped[str] = mapped_column(String(255))
