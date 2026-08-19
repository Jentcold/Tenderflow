"""offers.manager_rank — the department manager's order of preference

Replaces "the manager picks one offer" with "the manager shortlists up to
three, best first". Null means not shortlisted; 1, 2 or 3 mean the position.

Existing rows sitting at `selected` were picked under the old one-winner rule,
so they are backfilled to rank 1 — they were somebody's only choice.

Revision ID: b5f8c24a7e13
Revises: a4e7b31c9d60
Create Date: 2026-08-17

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b5f8c24a7e13'
down_revision: Union[str, None] = 'a4e7b31c9d60'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("offers", sa.Column("manager_rank", sa.Integer(), nullable=True))
    op.execute("UPDATE offers SET manager_rank = 1 WHERE status = 'selected'")


def downgrade() -> None:
    op.drop_column("offers", "manager_rank")
