"""Tell "send it back" apart from "we're not buying this".

Both leave the tender `rejected`; the difference is what happens next. A tender
sent back can be edited and resubmitted, which is the common case. A declined
one cannot — raising it again has to be a new request, so a manager who says no
doesn't get the same request back in their queue every time the requester
presses a button.

Existing rejections become sends-back (False). That is the recoverable reading,
and nothing on record says which of the two any of them meant.

Revision ID: f1a8d3e70c26
Revises: e9d4a2c60f37
"""
from alembic import op
import sqlalchemy as sa

revision = "f1a8d3e70c26"
down_revision = "e9d4a2c60f37"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenders",
        sa.Column("manager_declined", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # The default was only needed to fill the existing rows; the model supplies
    # one for new ones, and leaving it on the column hides a missing value.
    op.alter_column("tenders", "manager_declined", server_default=None)


def downgrade() -> None:
    op.drop_column("tenders", "manager_declined")
