from typing import Sequence, Union

from alembic import op

revision: str = 'c4d2a81e6b09'
down_revision: Union[str, None] = 'b8f31d0c5e42'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ENUM_NAME = "emailtype"

SUBJECT = "Award Withdrawn - {tender_serial}"
BODY = (
    "Dear {vendor_contact},\n\n"
    "We are writing regarding {tender_name} ({tender_serial}), which was "
    "previously awarded to {vendor_company}.\n\n"
    "That award has been withdrawn and the tender reassigned to another "
    "vendor. Our procurement team will be in touch about the reasons and "
    "any next steps.\n\n"
    "Your Bid: {currency} {bid_amount}\n\n"
    "We value your participation and encourage you to bid on future tenders.\n\n"
    "Best regards,\nTenderFlow Procurement Team"
)


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(f"ALTER TYPE {ENUM_NAME} ADD VALUE IF NOT EXISTS 'award_revoked'")

    op.execute(
        f"""
        INSERT INTO email_templates (type, subject, body)
        VALUES ('award_revoked', {_q(SUBJECT)}, {_q(BODY)})
        ON CONFLICT (type) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM email_templates WHERE type = 'award_revoked'")
    op.execute("DELETE FROM sent_emails WHERE type = 'award_revoked'")

    op.execute(f"ALTER TYPE {ENUM_NAME} RENAME TO {ENUM_NAME}_old")
    op.execute(f"CREATE TYPE {ENUM_NAME} AS ENUM ('winner', 'loser')")
    for table in ("email_templates", "sent_emails"):
        op.execute(
            f"ALTER TABLE {table} ALTER COLUMN type TYPE {ENUM_NAME} "
            f"USING type::text::{ENUM_NAME}"
        )
    op.execute(f"DROP TYPE {ENUM_NAME}_old")


def _q(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"
