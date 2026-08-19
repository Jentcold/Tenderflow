"""The line items that make a tender a table rather than a paragraph.

A tender is no longer "we need some peripherals" in a free-text box. It is a
list of rows — mouse, mousepad, keyboard, laptop — each with its own specs and
its own notes ("red", "this exact model"). That structure is what gets sent to
the vendor, what the vendor prices line by line, and what the warehouse later
ticks off on paper.

`description` stays on the tender for the covering blurb, but it is no longer
where the requirement lives.
"""
import uuid

from sqlalchemy import ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


class _LineItemColumns:
    """The shape shared by a tender's items and a template's items.

    A mixin rather than one table with two nullable parents: a row that could
    belong to either would need a check constraint to stop it belonging to
    both, and every query would carry a filter that means nothing.
    """

    # Display order as typed. Without it the item list comes back in whatever
    # order Postgres feels like, and a printed checklist that reshuffles
    # between prints is worse than no checklist.
    position: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(255))
    # What it has to be: "wireless, 2.4GHz, 6 buttons".
    specs: Mapped[str | None] = mapped_column(Text)
    # What the requester wants on top of the specs: "red", "must match the
    # ones in room 3". Kept apart from specs because one is a requirement the
    # vendor bids against and the other is an instruction to whoever buys.
    notes: Mapped[str | None] = mapped_column(Text)
    quantity: Mapped[float] = mapped_column(Numeric(12, 2), default=1)
    unit: Mapped[str] = mapped_column(String(32), default="pcs")


class TenderItem(Base, UUIDPKMixin, _LineItemColumns):
    __tablename__ = "tender_items"

    tender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenders.id", ondelete="CASCADE"), index=True
    )


class TemplateItem(Base, UUIDPKMixin, _LineItemColumns):
    """A template's items, copied into a tender when the template is pressed.

    Copied rather than referenced: editing the template next quarter must not
    rewrite the requirement on a tender already out with vendors.
    """

    __tablename__ = "template_items"

    template_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tender_templates.id", ondelete="CASCADE"), index=True
    )
