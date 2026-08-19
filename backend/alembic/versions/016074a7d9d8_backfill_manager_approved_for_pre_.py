from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '016074a7d9d8'
down_revision: Union[str, None] = 'ccff63dac423'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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
    pass
