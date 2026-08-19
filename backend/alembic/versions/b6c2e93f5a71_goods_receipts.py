from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b6c2e93f5a71'
down_revision: Union[str, None] = 'a3f7c05d81b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NOTIFICATION_ENUM = "notificationtype"
CONDITION_ENUM = "linecondition"

NOTIFICATION_LABELS = (
    "tender_pending_approval",
    "manager_approved",
    "changes_requested",
    "submission_received",
    "offer_selected",
    "sc_rejected",
    "tender_awarded",
)


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(
            f"ALTER TYPE {NOTIFICATION_ENUM} ADD VALUE IF NOT EXISTS 'goods_received'"
        )

    condition = sa.Enum(
        "ok", "short", "missing", "damaged", "wrong_item", "other",
        name=CONDITION_ENUM,
    )

    op.create_table(
        "goods_receipts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("offer_id", sa.Uuid(), nullable=False),
        sa.Column("tender_id", sa.Uuid(), nullable=False),
        sa.Column("received_by", sa.Uuid(), nullable=True),
        sa.Column(
            "received_at", sa.DateTime(timezone=True),
            server_default=sa.text("now()"), nullable=False,
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["offer_id"], ["offers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tender_id"], ["tenders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["received_by"], ["users.id"], ondelete="SET NULL"),
    )
    op.create_index(
        "ix_goods_receipts_offer_id", "goods_receipts", ["offer_id"], unique=True
    )
    op.create_index("ix_goods_receipts_tender_id", "goods_receipts", ["tender_id"])
    op.create_index("ix_goods_receipts_received_by", "goods_receipts", ["received_by"])

    op.create_table(
        "goods_receipt_lines",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("receipt_id", sa.Uuid(), nullable=False),
        sa.Column("offer_item_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("ordered_quantity", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("condition", condition, nullable=False, server_default="ok"),
        sa.Column("received_quantity", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["receipt_id"], ["goods_receipts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["offer_item_id"], ["offer_items.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_goods_receipt_lines_receipt_id", "goods_receipt_lines", ["receipt_id"])
    op.create_index(
        "ix_goods_receipt_lines_offer_item_id", "goods_receipt_lines", ["offer_item_id"]
    )


def downgrade() -> None:
    op.drop_table("goods_receipt_lines")
    op.drop_table("goods_receipts")
    sa.Enum(name=CONDITION_ENUM).drop(op.get_bind(), checkfirst=True)

    op.execute("DELETE FROM notifications WHERE type = 'goods_received'")
    labels = ", ".join(f"'{label}'" for label in NOTIFICATION_LABELS)
    op.execute(f"ALTER TYPE {NOTIFICATION_ENUM} RENAME TO {NOTIFICATION_ENUM}_old")
    op.execute(f"CREATE TYPE {NOTIFICATION_ENUM} AS ENUM ({labels})")
    op.execute(
        f"ALTER TABLE notifications ALTER COLUMN type TYPE {NOTIFICATION_ENUM} "
        f"USING type::text::{NOTIFICATION_ENUM}"
    )
    op.execute(f"DROP TYPE {NOTIFICATION_ENUM}_old")
