
from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, Table
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import UUIDPKMixin

DEFAULT_CATEGORIES: list[tuple[str, str]] = [
    ("goods", "Goods"),
    ("services", "Services"),
    ("works", "Works"),
    ("consulting", "Consulting"),
]


vendor_categories = Table(
    "vendor_categories",
    Base.metadata,
    Column("vendor_id", ForeignKey("vendors.id", ondelete="CASCADE"), primary_key=True),
    Column("category_id", ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True),
)


class Category(Base, UUIDPKMixin):
    __tablename__ = "categories"

    name: Mapped[str] = mapped_column(String(120), unique=True)
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True)

    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)

    vendors: Mapped[list["Vendor"]] = relationship(  # noqa: F821
        secondary=vendor_categories, back_populates="categories"
    )


def slugify(name: str) -> str:
    out = []
    for char in name.strip().lower():
        if char.isalnum():
            out.append(char)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-") or "category"
