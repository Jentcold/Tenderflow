from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a3f7c05d81b4'
down_revision: Union[str, None] = 'f1a8d3e70c26'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ENUM_NAME = "offerstatus"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(f"ALTER TYPE {ENUM_NAME} ADD VALUE IF NOT EXISTS 'forwarded'")

    op.add_column("offers", sa.Column("forwarded_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("offers", sa.Column("forwarded_by", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "offers_forwarded_by_fkey", "offers", "users", ["forwarded_by"], ["id"]
    )

    op.execute(
        f"""
        UPDATE offers
           SET forwarded_at = created_at,
               status = CASE WHEN status = 'pending'
                             THEN 'forwarded'::{ENUM_NAME}
                             ELSE status END
         WHERE status <> 'rejected'
        """
    )


def downgrade() -> None:
    op.execute(f"UPDATE offers SET status = 'pending'::{ENUM_NAME} WHERE status = 'forwarded'")

    op.drop_constraint("offers_forwarded_by_fkey", "offers", type_="foreignkey")
    op.drop_column("offers", "forwarded_by")
    op.drop_column("offers", "forwarded_at")

    op.execute("ALTER TABLE offers ALTER COLUMN status DROP DEFAULT")
    op.execute(f"ALTER TYPE {ENUM_NAME} RENAME TO {ENUM_NAME}_old")
    op.execute(
        f"CREATE TYPE {ENUM_NAME} AS ENUM ('pending', 'selected', 'purchasing_ok', "
        f"'purchasing_manager_ok', 'approved', 'rejected')"
    )
    for column in ("status", "rejected_at_stage"):
        op.execute(
            f"ALTER TABLE offers ALTER COLUMN {column} TYPE {ENUM_NAME} "
            f"USING {column}::text::{ENUM_NAME}"
        )
    op.execute(f"ALTER TABLE offers ALTER COLUMN status SET DEFAULT 'pending'::{ENUM_NAME}")
    op.execute(f"DROP TYPE {ENUM_NAME}_old")
