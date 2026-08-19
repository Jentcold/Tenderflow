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
