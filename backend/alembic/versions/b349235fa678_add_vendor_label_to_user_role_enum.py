"""add vendor label to user_role enum

Revision ID: b349235fa678
Revises: c68bd5372288
Create Date: 2026-08-10 16:44:02.118904

UserRole.vendor has been in the model since the rework, but no migration ever
added the label to the Postgres type — autogenerate does not diff enum values,
so nothing flagged it. Creating a vendor account failed with
`invalid input value for enum user_role: "vendor"` right up until this ran,
which is why the vendors table sat empty and unused.

"""
from typing import Sequence, Union

from alembic import op


revision: str = 'b349235fa678'
down_revision: Union[str, None] = 'c68bd5372288'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

STAFF_ROLES = "'admin', 'procurement', 'manager', 'supply_chain', 'finance'"


def upgrade() -> None:
    # Postgres 12+ allows this inside a transaction as long as the new value
    # isn't *used* in the same one. Nothing here does.
    op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'vendor'")


def downgrade() -> None:
    # A single label can't be dropped, so the type is rebuilt without it.
    # Vendor accounts have to go first — there'd be no role left to hold them.
    # Their profiles follow via ON DELETE CASCADE, and any submission linked to
    # one falls back to ON DELETE SET NULL rather than disappearing: the bid is
    # still a real bid, it just stops being attributed.
    op.execute("DELETE FROM users WHERE role = 'vendor'")
    op.execute("ALTER TYPE user_role RENAME TO user_role_old")
    op.execute(f"CREATE TYPE user_role AS ENUM ({STAFF_ROLES})")
    op.execute("ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::text::user_role")
    op.execute("DROP TYPE user_role_old")
