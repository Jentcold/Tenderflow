"""What a tender is for, and what a vendor supplies.

This was an enum of four labels — goods, services, works, consulting — shared by
`tenders.category` and `vendors.vendor_category`. Two things were wrong with it.

**Four is not the real list.** A procurement department distinguishes electronic
devices from portable devices from furniture, and "goods" answers none of the
questions anybody actually asks when picking who to invite. Adding a label to an
enum is a migration and a deploy, which means in practice the list never grows
and everything ends up filed under `goods`.

**And a vendor supplies more than one thing.** The single column forced a
company that sells laptops and desks to be filed under one of them, so the other
half of their catalogue was invisible to the invite list and the basket picker.

So: a table the admin maintains, and a join table beside it. A category is
retired rather than deleted once anything references it — a tender raised under
"Consulting" was raised under Consulting, and rewriting that later to make a
list tidier is rewriting history.

`slug` is the stable key. It is what the API sends and what the browser filters
on, and it does not change when somebody renames "Goods" to "General goods" —
which is exactly the edit a display name exists to allow.
"""
import uuid

from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, Table
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import UUIDPKMixin

# The four the enum used to hold, seeded on a fresh database so existing data
# and the demo keep meaning what they meant.
DEFAULT_CATEGORIES: list[tuple[str, str]] = [
    ("goods", "Goods"),
    ("services", "Services"),
    ("works", "Works"),
    ("consulting", "Consulting"),
]


# A plain association table rather than a model: it carries no data of its own
# beyond the pair, and giving it a class would invite somebody to hang a field
# on it that belongs on one side or the other.
vendor_categories = Table(
    "vendor_categories",
    Base.metadata,
    Column("vendor_id", ForeignKey("vendors.id", ondelete="CASCADE"), primary_key=True),
    Column("category_id", ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True),
)


class Category(Base, UUIDPKMixin):
    """One line of the admin's category list."""

    __tablename__ = "categories"

    # What people read. Renameable, because that is the whole point of having
    # it separate from the slug.
    name: Mapped[str] = mapped_column(String(120), unique=True)
    # What the API and the browser use. Set once, from the name, and never
    # rewritten: every tender, vendor and template filed under it would have to
    # be found and updated, and anything holding the old value in a URL or a
    # saved filter would quietly stop matching.
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True)

    # Retired, not deleted. A retired category disappears from the pickers but
    # keeps reading correctly on everything already filed under it.
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    # The admin's own ordering, so the list can put the categories a company
    # actually buys at the top rather than alphabetising them.
    position: Mapped[int] = mapped_column(Integer, default=0)

    vendors: Mapped[list["Vendor"]] = relationship(  # noqa: F821
        secondary=vendor_categories, back_populates="categories"
    )


def slugify(name: str) -> str:
    """A stable key from a display name.

    Deliberately narrow: lowercase, spaces and punctuation to hyphens, nothing
    else. A slug ends up in query strings and in browser-side comparisons, and
    the cost of being surprising there is a filter that silently matches
    nothing.
    """
    out = []
    for char in name.strip().lower():
        if char.isalnum():
            out.append(char)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-") or "category"
