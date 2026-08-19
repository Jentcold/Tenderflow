from typing import Sequence, Union

from alembic import op


revision: str = 'a1c7e94b2f30'
down_revision: Union[str, None] = 'dea0d209623d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

KEPT_ROLES = "'admin', 'procurement', 'manager', 'supply_chain', 'finance', 'vendor'"


def upgrade() -> None:
    op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'employee'")


def downgrade() -> None:
    op.execute(
        "UPDATE tenders SET created_by = NULL WHERE created_by IN "
        "(SELECT id FROM users WHERE role = 'employee')"
    )
    op.execute("DELETE FROM users WHERE role = 'employee'")
    op.execute("ALTER TYPE user_role RENAME TO user_role_old")
    op.execute(f"CREATE TYPE user_role AS ENUM ({KEPT_ROLES})")
    op.execute("ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::text::user_role")
    op.execute("DROP TYPE user_role_old")
