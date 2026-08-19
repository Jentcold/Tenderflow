"""Deadline and description become optional on a tender.

The request form now asks the person raising it for two things only: a name and
the table of what they need. Everything else moved to whoever actually decides
it — the department comes from their account, the currency and required
documents are purchasing's, and the deadline is set by the manager who approves
the tender.

That makes three columns nullable. `deadline_date` and `deadline_time` are null
between "raised" and "approved", which is a real state a tender now sits in.
`description` is null for anything raised through the new form; it stays on the
table for the tenders that already have one and for the covering note a
template carries.

Revision ID: e9d4a2c60f37
Revises: d8b3f60c1a94
"""
from alembic import op
import sqlalchemy as sa

revision = "e9d4a2c60f37"
down_revision = "d8b3f60c1a94"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("tenders", "deadline_date", existing_type=sa.Date(), nullable=True)
    op.alter_column("tenders", "deadline_time", existing_type=sa.Time(), nullable=True)
    op.alter_column("tenders", "description", existing_type=sa.Text(), nullable=True)


def downgrade() -> None:
    # Going back needs every row to have the values again. A tender still
    # waiting on its manager genuinely has no deadline, so one is invented far
    # enough out to be obviously a placeholder rather than a date anyone
    # planned around.
    op.execute("UPDATE tenders SET description = '' WHERE description IS NULL")
    op.execute("UPDATE tenders SET deadline_date = CURRENT_DATE + 30 WHERE deadline_date IS NULL")
    op.execute("UPDATE tenders SET deadline_time = TIME '09:00' WHERE deadline_time IS NULL")
    op.alter_column("tenders", "description", existing_type=sa.Text(), nullable=False)
    op.alter_column("tenders", "deadline_time", existing_type=sa.Time(), nullable=False)
    op.alter_column("tenders", "deadline_date", existing_type=sa.Date(), nullable=False)
