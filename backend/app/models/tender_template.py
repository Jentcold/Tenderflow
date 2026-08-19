import uuid

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin
from app.models.category import Category


class TenderTemplate(Base, UUIDPKMixin, TimestampMixin):
    """A pre-filled tender the purchasing team maintains for recurring buys.

    Tagged by department and category so a department browsing templates for
    its own category finds the three that apply to it, not the ninety that
    don't. It is a stencil, never a tender: pressing one creates a normal
    Tender that then walks the usual approval flow. Nothing here is a foreign
    key onto a tender, so editing a template later cannot rewrite history on
    the tenders already raised from it.
    """

    __tablename__ = "tender_templates"

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")

    # The two tags the whole feature exists for. `category` is the shared
    # tenders/vendors list, so a template's category is directly the one that
    # decides which vendors can later be invited.
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), index=True
    )
    category_ref: Mapped[Category | None] = relationship(lazy="selectin")
    # `category` and `category_name` stay plain strings to everything that
    # reads them - the schemas, the browser, the email templates - even though
    # what backs them is now a row rather than an enum value. The relationship
    # is `category_ref`; these two are what the API has always exposed, so
    # swapping the storage cost no caller a change.
    @property
    def category(self) -> str:
        return self.category_ref.slug if self.category_ref else ""

    @property
    def category_name(self) -> str:
        return self.category_ref.name if self.category_ref else ""

    # Null means "any department" — a template purchasing wants everyone to
    # have, e.g. office consumables. Departments filter on
    # `department_id IS NULL OR department_id = mine`, so a null row shows up
    # for all of them rather than for none.
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="CASCADE"), index=True
    )

    currency: Mapped[str] = mapped_column(String(8), default="EGP")
    # Days from "today" to the deadline when a tender is raised from this
    # template. A stored absolute date would be in the past the second week
    # anyone used it.
    default_deadline_days: Mapped[int] = mapped_column(Integer, default=14)

    required_docs: Mapped[list[str]] = mapped_column(JSON, default=list)

    # Retired rather than deleted. A template that produced tenders is part of
    # how those tenders came to exist, and the audit trail reads better with
    # the row still present.
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
