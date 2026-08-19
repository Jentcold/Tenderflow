import uuid

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin
from app.models.category import Category


class TenderTemplate(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "tender_templates"

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")

    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), index=True
    )
    category_ref: Mapped[Category | None] = relationship(lazy="selectin")
    @property
    def category(self) -> str:
        return self.category_ref.slug if self.category_ref else ""

    @property
    def category_name(self) -> str:
        return self.category_ref.name if self.category_ref else ""

    department_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="CASCADE"), index=True
    )

    currency: Mapped[str] = mapped_column(String(8), default="EGP")
    default_deadline_days: Mapped[int] = mapped_column(Integer, default=14)

    required_docs: Mapped[list[str]] = mapped_column(JSON, default=list)

    active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
