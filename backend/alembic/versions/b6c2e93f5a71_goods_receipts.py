"""the warehouse checks a delivery in

Everything before this revision records what *should* be bought. These two
tables are the first record of what actually turned up, and the gap between
them - a box short, a cracked screen, a line the vendor never sent - is the
reason the warehouse screen exists at all.

`goods_receipts` is one row per offer, enforced by the unique index on
`offer_id`. Being "received" is not a flag on the offer: the row exists or it
doesn't, and the warehouse's list of incoming shipments is `approved` offers
with no row here. A flag would have put the truth in two places and left the
interesting part - which lines were wrong, and how - with nowhere to live.

Also adds `goods_received` to the notification enum, by hand: alembic does NOT
diff enum values, so autogenerate produces an empty migration for that half and
the failure only appears at runtime as `invalid input value for enum`.

Revision ID: b6c2e93f5a71
Revises: a3f7c05d81b4
Create Date: 2026-08-19

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b6c2e93f5a71'
down_revision: Union[str, None] = 'a3f7c05d81b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NOTIFICATION_ENUM = "notificationtype"
CONDITION_ENUM = "linecondition"

# Kept in step with app/models/notification.py. Spelled out because the
# downgrade has to rebuild the type without the new label, and Postgres offers
# no way to drop one.
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
    # Adding a label has to be committed before anything can reference it, and
    # nothing here does in the same transaction - but the block also keeps this
    # consistent with the other enum migrations, and costs nothing.
    with op.get_context().autocommit_block():
        op.execute(
            f"ALTER TYPE {NOTIFICATION_ENUM} ADD VALUE IF NOT EXISTS 'goods_received'"
        )

    # Created by create_table below rather than by an explicit .create() here.
    # The autocommit_block above commits on its own, which leaves a separate
    # `Enum.create(checkfirst=True)` checking against a connection that then
    # tries the CREATE a second time from the column definition - it fails with
    # "type linecondition already exists" and takes the whole revision with it.
    # Letting the table own its type keeps that to one statement.
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
    # Unique, not merely indexed: one delivery per offer is the rule the whole
    # screen depends on, and "has this been received" has to have one answer.
    op.create_index(
        "ix_goods_receipts_offer_id", "goods_receipts", ["offer_id"], unique=True
    )
    op.create_index("ix_goods_receipts_tender_id", "goods_receipts", ["tender_id"])
    op.create_index("ix_goods_receipts_received_by", "goods_receipts", ["received_by"])

    op.create_table(
        "goods_receipt_lines",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("receipt_id", sa.Uuid(), nullable=False),
        # SET NULL, not CASCADE: if an offer line goes away, the fact that
        # something arrived against it is still true and still worth keeping.
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

    # A single label can't be dropped from a Postgres enum, so the type is
    # rebuilt without it. Any notification actually carrying `goods_received`
    # goes first - it describes an event whose tables no longer exist, so there
    # is nothing for it to point at once this revision is undone.
    #
    # `type` carries no DEFAULT, unlike offers.status in a3f7c05d81b4, so there
    # is no default to drop and re-add around the swap.
    op.execute("DELETE FROM notifications WHERE type = 'goods_received'")
    labels = ", ".join(f"'{label}'" for label in NOTIFICATION_LABELS)
    op.execute(f"ALTER TYPE {NOTIFICATION_ENUM} RENAME TO {NOTIFICATION_ENUM}_old")
    op.execute(f"CREATE TYPE {NOTIFICATION_ENUM} AS ENUM ({labels})")
    op.execute(
        f"ALTER TABLE notifications ALTER COLUMN type TYPE {NOTIFICATION_ENUM} "
        f"USING type::text::{NOTIFICATION_ENUM}"
    )
    op.execute(f"DROP TYPE {NOTIFICATION_ENUM}_old")
