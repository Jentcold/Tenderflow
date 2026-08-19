"""the warehouse receives baskets too, not only single offers

A basket that cleared its approvals is a purchase like any other, and the goods
walk in through the same door. Until this revision the warehouse could not see
one: `goods_receipts.offer_id` was NOT NULL, so a purchase with no offer behind
it had no way to be checked in, and `/receiving/incoming` only ever looked at
approved offers.

So a receipt now points at *one* of the two things a purchase can be:

* `offer_id`  - one vendor's offer cleared the chain
* `award_id`  - a basket cleared the chain

Both nullable, both unique, exactly one filled in. The unique indexes still do
their job with nulls in the column - Postgres treats nulls as distinct - so
"one receipt per purchase" survives unchanged.

`goods_receipt_lines.award_line_id` is the same move one level down: a line was
checked in against an offer item or against a basket line. The copied `name`
and `ordered_quantity` stay where they are, and stay the reason this table is
readable years after either source is edited.

Revision ID: d2e5b81f4a07
Revises: c4d1a8e05b93
Create Date: 2026-08-19

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'd2e5b81f4a07'
down_revision: Union[str, None] = 'c4d1a8e05b93'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("goods_receipts", "offer_id", existing_type=sa.Uuid(), nullable=True)
    op.add_column("goods_receipts", sa.Column("award_id", sa.Uuid(), nullable=True))
    op.create_index("ix_goods_receipts_award_id", "goods_receipts", ["award_id"], unique=True)
    op.create_foreign_key(
        "fk_goods_receipts_award_id", "goods_receipts", "awards", ["award_id"], ["id"],
        ondelete="CASCADE",
    )
    # Exactly one source. Without it a receipt could point at both a basket and
    # an offer, and "what was this delivery against" would have two answers.
    op.create_check_constraint(
        "ck_goods_receipts_one_source",
        "goods_receipts",
        "(offer_id IS NULL) <> (award_id IS NULL)",
    )

    op.add_column("goods_receipt_lines", sa.Column("award_line_id", sa.Uuid(), nullable=True))
    op.create_index(
        "ix_goods_receipt_lines_award_line_id", "goods_receipt_lines", ["award_line_id"]
    )
    # SET NULL, like offer_item_id beside it: if the basket line is ever
    # removed, the fact that something arrived against it is still true.
    op.create_foreign_key(
        "fk_goods_receipt_lines_award_line_id", "goods_receipt_lines", "award_lines",
        ["award_line_id"], ["id"], ondelete="SET NULL",
    )


def downgrade() -> None:
    # Basket receipts have no offer to hang off, so they cannot survive the
    # column going back to NOT NULL. They are deleted rather than silently
    # re-pointed at an offer they were never against.
    op.execute("DELETE FROM goods_receipts WHERE award_id IS NOT NULL")

    op.drop_constraint("fk_goods_receipt_lines_award_line_id", "goods_receipt_lines", type_="foreignkey")
    op.drop_index("ix_goods_receipt_lines_award_line_id", table_name="goods_receipt_lines")
    op.drop_column("goods_receipt_lines", "award_line_id")

    op.drop_constraint("ck_goods_receipts_one_source", "goods_receipts", type_="check")
    op.drop_constraint("fk_goods_receipts_award_id", "goods_receipts", type_="foreignkey")
    op.drop_index("ix_goods_receipts_award_id", table_name="goods_receipts")
    op.drop_column("goods_receipts", "award_id")
    op.alter_column("goods_receipts", "offer_id", existing_type=sa.Uuid(), nullable=False)
