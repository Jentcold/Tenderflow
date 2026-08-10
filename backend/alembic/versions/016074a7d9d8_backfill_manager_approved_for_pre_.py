"""backfill manager_approved for pre-existing tenders

Revision ID: 016074a7d9d8
Revises: ccff63dac423
Create Date: 2026-08-10 15:34:29.772138

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '016074a7d9d8'
down_revision: Union[str, None] = 'ccff63dac423'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Manager approval used to happen after scoring, so tenders that were
    # already open/closed/awarded were approved under the old rules even though
    # manager_approved is still false. Without this they'd sit in a state the
    # new workflow treats as unapproved — /reopen would refuse them.
    op.execute(
        """
        UPDATE tenders
        SET manager_approved = true,
            manager_rejected = false
        WHERE status IN ('open', 'closed', 'awarded')
          AND manager_approved = false
        """
    )


def downgrade() -> None:
    # No-op: the pre-migration value of manager_approved isn't recoverable, and
    # guessing would be worse than leaving the backfilled flag in place.
    pass
