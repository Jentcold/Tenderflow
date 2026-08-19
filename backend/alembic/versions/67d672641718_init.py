from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '67d672641718'
down_revision: Union[str, None] = '72c348c2830b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_foreign_key('fk_tenders_awarded_submission', 'tenders', 'submissions', ['awarded_vendor_submission_id'], ['id'], use_alter=True)


def downgrade() -> None:
    op.drop_constraint('fk_tenders_awarded_submission', 'tenders', type_='foreignkey')
