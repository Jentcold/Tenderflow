from typing import Sequence, Union

from alembic import op


revision: str = 'b8f31d0c5e42'
down_revision: Union[str, None] = 'a1c7e94b2f30'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ORIGINAL_LABELS = "'admin', 'procurement', 'manager', 'supply_chain', 'finance'"


def upgrade() -> None:
    op.execute(
        "ALTER TABLE notifications ALTER COLUMN for_role TYPE user_role "
        "USING for_role::text::user_role"
    )
    op.execute("DROP TYPE userrole")


def downgrade() -> None:
    op.execute(
        "UPDATE notifications SET for_role = NULL "
        f"WHERE for_role::text NOT IN ({ORIGINAL_LABELS})"
    )
    op.execute(f"CREATE TYPE userrole AS ENUM ({ORIGINAL_LABELS})")
    op.execute(
        "ALTER TABLE notifications ALTER COLUMN for_role TYPE userrole "
        "USING for_role::text::userrole"
    )
