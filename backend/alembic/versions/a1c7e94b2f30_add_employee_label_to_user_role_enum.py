"""add employee label to user_role enum

Revision ID: a1c7e94b2f30
Revises: dea0d209623d
Create Date: 2026-08-11 12:40:00.000000

Employees raise tender requests and wait for the manager's decision. Same
caveat as b349235fa678: autogenerate does not diff enum values, so the label
has to be added by hand or every INSERT with role='employee' fails.

"""
from typing import Sequence, Union

from alembic import op


revision: str = 'a1c7e94b2f30'
down_revision: Union[str, None] = 'dea0d209623d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

KEPT_ROLES = "'admin', 'procurement', 'manager', 'supply_chain', 'finance', 'vendor'"


def upgrade() -> None:
    # Postgres 12+ allows this inside a transaction as long as the new value
    # isn't *used* in the same one. Nothing here does.
    op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'employee'")


def downgrade() -> None:
    # A single label can't be dropped, so the type is rebuilt without it.
    # tenders.created_by is a plain FK with no ON DELETE, so the accounts can't
    # just be deleted — the reference is cleared first. The tender itself stays:
    # it is a real request that was really raised, it just stops naming who by.
    op.execute(
        "UPDATE tenders SET created_by = NULL WHERE created_by IN "
        "(SELECT id FROM users WHERE role = 'employee')"
    )
    op.execute("DELETE FROM users WHERE role = 'employee'")
    op.execute("ALTER TYPE user_role RENAME TO user_role_old")
    op.execute(f"CREATE TYPE user_role AS ENUM ({KEPT_ROLES})")
    op.execute("ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::text::user_role")
    op.execute("DROP TYPE user_role_old")
