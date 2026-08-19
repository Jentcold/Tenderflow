from typing import Sequence, Union

from alembic import op


revision: str = 'dea0d209623d'
down_revision: Union[str, None] = 'b349235fa678'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

LABELS = "'goods', 'services', 'works', 'consulting'"


def upgrade() -> None:
    op.execute("ALTER TYPE tendercategory RENAME TO category")
    op.execute(
        "ALTER TABLE vendors ALTER COLUMN vendor_category TYPE category "
        "USING vendor_category::text::category"
    )
    op.execute("DROP TYPE vendor_category")

    op.create_index(op.f('ix_vendors_vendor_category'), 'vendors', ['vendor_category'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_vendors_vendor_category'), table_name='vendors')

    op.execute(f"CREATE TYPE vendor_category AS ENUM ({LABELS})")
    op.execute(
        "ALTER TABLE vendors ALTER COLUMN vendor_category TYPE vendor_category "
        "USING vendor_category::text::vendor_category"
    )
    op.execute("ALTER TYPE category RENAME TO tendercategory")
