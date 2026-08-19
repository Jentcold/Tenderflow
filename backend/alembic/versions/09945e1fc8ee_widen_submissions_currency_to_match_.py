from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '09945e1fc8ee'
down_revision: Union[str, None] = '016074a7d9d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "submissions",
        "currency",
        existing_type=sa.String(length=3),
        type_=sa.String(length=8),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.execute("UPDATE submissions SET currency = left(currency, 3)")
    op.alter_column(
        "submissions",
        "currency",
        existing_type=sa.String(length=8),
        type_=sa.String(length=3),
        existing_nullable=False,
    )
