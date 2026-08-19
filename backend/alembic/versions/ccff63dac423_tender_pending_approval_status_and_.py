from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'ccff63dac423'
down_revision: Union[str, None] = 'c2cb0e30c0b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE tenderstatus ADD VALUE IF NOT EXISTS 'pending_approval'")
    op.execute("ALTER TYPE notificationtype ADD VALUE IF NOT EXISTS 'tender_pending_approval'")


def downgrade() -> None:
    op.execute("UPDATE tenders SET status = 'open' WHERE status = 'pending_approval'")
    op.execute("ALTER TYPE tenderstatus RENAME TO tenderstatus_old")
    op.execute("CREATE TYPE tenderstatus AS ENUM ('open', 'closed', 'awarded', 'rejected')")
    op.execute(
        "ALTER TABLE tenders ALTER COLUMN status TYPE tenderstatus USING status::text::tenderstatus"
    )
    op.execute("DROP TYPE tenderstatus_old")

    op.execute(
        "DELETE FROM notifications WHERE type = 'tender_pending_approval'"
    )
    op.execute("ALTER TYPE notificationtype RENAME TO notificationtype_old")
    op.execute(
        "CREATE TYPE notificationtype AS ENUM ("
        "'submission_received', 'evaluation_submitted', 'changes_requested', "
        "'manager_approved', 'sc_rejected', 'tender_awarded')"
    )
    op.execute(
        "ALTER TABLE notifications ALTER COLUMN type TYPE notificationtype "
        "USING type::text::notificationtype"
    )
    op.execute("DROP TYPE notificationtype_old")
