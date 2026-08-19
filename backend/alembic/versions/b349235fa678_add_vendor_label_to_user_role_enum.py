from typing import Sequence, Union

from alembic import op


revision: str = 'b349235fa678'
down_revision: Union[str, None] = 'c68bd5372288'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

STAFF_ROLES = "'admin', 'procurement', 'manager', 'supply_chain', 'finance'"


def upgrade() -> None:
    op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'vendor'")


def downgrade() -> None:
    op.execute("DELETE FROM users WHERE role = 'vendor'")
    op.execute("ALTER TYPE user_role RENAME TO user_role_old")
    op.execute(f"CREATE TYPE user_role AS ENUM ({STAFF_ROLES})")
    op.execute("ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::text::user_role")
    op.execute("DROP TYPE user_role_old")
