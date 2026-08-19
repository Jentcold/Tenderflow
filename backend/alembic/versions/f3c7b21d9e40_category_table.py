"""categories become a table the admin owns, and a vendor can have several

Two problems with the `category` enum, fixed together because they share a
column.

Four labels - goods, services, works, consulting - is not the list a purchasing
department actually uses; they distinguish electronic devices from portable
devices from furniture. Growing an enum is a migration and a deploy, so in
practice it never grew and everything ended up filed under `goods`.

And `vendors.vendor_category` was singular, so a company selling laptops and
desks had to be filed under one of them. The other half of their catalogue was
then invisible to the invite list and the basket picker, which both match on
category.

The four existing labels are seeded as rows with those exact slugs, so every
tender, template and vendor keeps meaning precisely what it meant. Nothing is
reinterpreted; only where it is stored changes.

Revision ID: f3c7b21d9e40
Revises: e4c9a71b3f28
Create Date: 2026-08-19

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'f3c7b21d9e40'
down_revision: Union[str, None] = 'e4c9a71b3f28'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Slug, display name, position - the enum's four members, in the order they
# were declared in.
SEED = [
    ("goods", "Goods", 0),
    ("services", "Services", 1),
    ("works", "Works", 2),
    ("consulting", "Consulting", 3),
]

ENUM_NAME = "category"
ENUM_LABELS = ("goods", "services", "works", "consulting")


def upgrade() -> None:
    op.create_table(
        "categories",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("slug", sa.String(length=120), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
        sa.UniqueConstraint("slug"),
    )
    op.create_index("ix_categories_slug", "categories", ["slug"])
    op.create_index("ix_categories_active", "categories", ["active"])

    # gen_random_uuid() is in core Postgres from 13 on, which is below the 16
    # this runs against, so no extension is needed.
    for slug, name, position in SEED:
        op.execute(
            sa.text(
                "INSERT INTO categories (id, name, slug, active, position) "
                "VALUES (gen_random_uuid(), :name, :slug, true, :position)"
            ).bindparams(name=name, slug=slug, position=position)
        )

    op.create_table(
        "vendor_categories",
        sa.Column("vendor_id", sa.Uuid(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["vendor_id"], ["vendors.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["category_id"], ["categories.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("vendor_id", "category_id"),
    )
    # Every existing vendor keeps exactly the one category they had. Widening
    # is a decision for whoever maintains the directory, not something a
    # migration should guess at.
    op.execute(
        "INSERT INTO vendor_categories (vendor_id, category_id) "
        "SELECT v.id, c.id FROM vendors v "
        "JOIN categories c ON c.slug = v.vendor_category::text"
    )

    for table in ("tenders", "tender_templates"):
        op.add_column(table, sa.Column("category_id", sa.Uuid(), nullable=True))
        op.create_index(f"ix_{table}_category_id", table, ["category_id"])
        op.create_foreign_key(
            f"fk_{table}_category_id", table, "categories", ["category_id"], ["id"],
            ondelete="SET NULL",
        )
        op.execute(
            f"UPDATE {table} SET category_id = c.id "
            f"FROM categories c WHERE c.slug = {table}.category::text"
        )
        op.drop_column(table, "category")

    op.drop_column("vendors", "vendor_category")
    # Last: the type cannot go while any column still has it.
    op.execute(f"DROP TYPE IF EXISTS {ENUM_NAME}")


def downgrade() -> None:
    enum = sa.Enum(*ENUM_LABELS, name=ENUM_NAME)
    enum.create(op.get_bind(), checkfirst=True)

    # Anything filed under a category the enum never had cannot come back, so
    # it lands on `goods` - the enum's own default. Said plainly rather than
    # failing the downgrade: the alternative is a database that cannot be
    # rolled back once somebody adds their first real category.
    op.add_column(
        "vendors",
        sa.Column("vendor_category", enum, nullable=False, server_default="goods"),
    )
    op.execute(
        "UPDATE vendors v SET vendor_category = c.slug::category "
        "FROM vendor_categories vc JOIN categories c ON c.id = vc.category_id "
        "WHERE vc.vendor_id = v.id AND c.slug IN ('goods','services','works','consulting')"
    )
    op.alter_column("vendors", "vendor_category", server_default=None)

    for table in ("tenders", "tender_templates"):
        op.add_column(
            table, sa.Column("category", enum, nullable=False, server_default="goods")
        )
        op.execute(
            f"UPDATE {table} t SET category = c.slug::category FROM categories c "
            f"WHERE c.id = t.category_id "
            f"AND c.slug IN ('goods','services','works','consulting')"
        )
        op.alter_column(table, "category", server_default="goods")
        op.drop_constraint(f"fk_{table}_category_id", table, type_="foreignkey")
        op.drop_index(f"ix_{table}_category_id", table_name=table)
        op.drop_column(table, "category_id")

    op.drop_table("vendor_categories")
    op.drop_index("ix_categories_active", table_name="categories")
    op.drop_index("ix_categories_slug", table_name="categories")
    op.drop_table("categories")
