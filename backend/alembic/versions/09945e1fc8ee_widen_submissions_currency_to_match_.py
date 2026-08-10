"""widen submissions currency to match tenders

Revision ID: 09945e1fc8ee
Revises: 016074a7d9d8
Create Date: 2026-08-10 16:06:16.853262

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '09945e1fc8ee'
down_revision: Union[str, None] = '016074a7d9d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # A submission copies tenders.currency (VARCHAR(8)) on submit, so the
    # narrower VARCHAR(3) here would reject any code longer than three
    # characters.
    op.alter_column(
        "submissions",
        "currency",
        existing_type=sa.String(length=3),
        type_=sa.String(length=8),
        existing_nullable=False,
    )


def downgrade() -> None:
    # Narrowing truncates, so anything already too long has to go first.
    op.execute("UPDATE submissions SET currency = left(currency, 3)")
    op.alter_column(
        "submissions",
        "currency",
        existing_type=sa.String(length=8),
        type_=sa.String(length=3),
        existing_nullable=False,
    )
