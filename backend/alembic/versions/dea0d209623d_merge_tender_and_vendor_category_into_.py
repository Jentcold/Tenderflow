"""merge tender and vendor category into one enum

Revision ID: dea0d209623d
Revises: b349235fa678
Create Date: 2026-08-10 17:12:44.301877

`tendercategory` and `vendor_category` held identical labels as separate
Postgres types. Vendors now only see tenders whose category matches theirs, and
that comparison is only sound if both sides come from one list — otherwise a
label added to tenders alone would leave no vendor able to match it, silently
and with no error anywhere.

Collapsed into a single `category` type. No data changes: every existing value
is a label the new type also has.

"""
from typing import Sequence, Union

from alembic import op


revision: str = 'dea0d209623d'
down_revision: Union[str, None] = 'b349235fa678'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

LABELS = "'goods', 'services', 'works', 'consulting'"


def upgrade() -> None:
    # Rename rather than create-and-swap: tenders.category already points at
    # this type, so renaming carries that column over untouched.
    op.execute("ALTER TYPE tendercategory RENAME TO category")
    op.execute(
        "ALTER TABLE vendors ALTER COLUMN vendor_category TYPE category "
        "USING vendor_category::text::category"
    )
    op.execute("DROP TYPE vendor_category")

    # Vendor listings filter on this column on every request.
    op.create_index(op.f('ix_vendors_vendor_category'), 'vendors', ['vendor_category'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_vendors_vendor_category'), table_name='vendors')

    op.execute(f"CREATE TYPE vendor_category AS ENUM ({LABELS})")
    op.execute(
        "ALTER TABLE vendors ALTER COLUMN vendor_category TYPE vendor_category "
        "USING vendor_category::text::vendor_category"
    )
    op.execute("ALTER TYPE category RENAME TO tendercategory")
