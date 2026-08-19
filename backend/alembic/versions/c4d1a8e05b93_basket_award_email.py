"""a separate mail for a basket award

A basket can take two lines from one vendor and three from another. The
`winner` template says "the tender is yours", which for a partial award is
simply untrue - the vendor would deliver the whole order. `basket_award` is the
one that names the lines they actually won.

Hand-written: alembic does not diff enum values, so autogenerate produces an
empty migration and the failure appears at runtime as `invalid input value for
enum`.

Revision ID: c4d1a8e05b93
Revises: b6c2e93f5a71
Create Date: 2026-08-19

"""
from typing import Sequence, Union

from alembic import op

revision: str = 'c4d1a8e05b93'
down_revision: Union[str, None] = 'b6c2e93f5a71'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ENUM_NAME = "emailtype"
LABELS = ("rfq", "winner", "loser", "award_revoked")


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(f"ALTER TYPE {ENUM_NAME} ADD VALUE IF NOT EXISTS 'basket_award'")


def downgrade() -> None:
    # A label can't be dropped from a Postgres enum, so the type is rebuilt.
    # Both tables that use it move across. Rows carrying the label go first:
    # they describe mail that the old schema has no way to talk about, and
    # there is nothing sensible to recast them to.
    op.execute("DELETE FROM sent_emails WHERE type = 'basket_award'")
    op.execute("DELETE FROM email_templates WHERE type = 'basket_award'")

    labels = ", ".join(f"'{label}'" for label in LABELS)
    op.execute(f"ALTER TYPE {ENUM_NAME} RENAME TO {ENUM_NAME}_old")
    op.execute(f"CREATE TYPE {ENUM_NAME} AS ENUM ({labels})")
    for table in ("sent_emails", "email_templates"):
        op.execute(
            f"ALTER TABLE {table} ALTER COLUMN type TYPE {ENUM_NAME} "
            f"USING type::text::{ENUM_NAME}"
        )
    op.execute(f"DROP TYPE {ENUM_NAME}_old")
