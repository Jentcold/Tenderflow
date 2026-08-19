import uuid

from sqlalchemy import ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


class _LineItemColumns:
    position: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(255))
    specs: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    quantity: Mapped[float] = mapped_column(Numeric(12, 2), default=1)
    unit: Mapped[str] = mapped_column(String(32), default="pcs")


class TenderItem(Base, UUIDPKMixin, _LineItemColumns):
    __tablename__ = "tender_items"

    tender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenders.id", ondelete="CASCADE"), index=True
    )


class TemplateItem(Base, UUIDPKMixin, _LineItemColumns):
    __tablename__ = "template_items"

    template_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tender_templates.id", ondelete="CASCADE"), index=True
    )
