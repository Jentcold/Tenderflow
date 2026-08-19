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
    op.create_check_constraint(
        "ck_goods_receipts_one_source",
        "goods_receipts",
        "(offer_id IS NULL) <> (award_id IS NULL)",
    )

    op.add_column("goods_receipt_lines", sa.Column("award_line_id", sa.Uuid(), nullable=True))
    op.create_index(
        "ix_goods_receipt_lines_award_line_id", "goods_receipt_lines", ["award_line_id"]
    )
    op.create_foreign_key(
        "fk_goods_receipt_lines_award_line_id", "goods_receipt_lines", "award_lines",
        ["award_line_id"], ["id"], ondelete="SET NULL",
    )


def downgrade() -> None:
    op.execute("DELETE FROM goods_receipts WHERE award_id IS NOT NULL")

    op.drop_constraint("fk_goods_receipt_lines_award_line_id", "goods_receipt_lines", type_="foreignkey")
    op.drop_index("ix_goods_receipt_lines_award_line_id", table_name="goods_receipt_lines")
    op.drop_column("goods_receipt_lines", "award_line_id")

    op.drop_constraint("ck_goods_receipts_one_source", "goods_receipts", type_="check")
    op.drop_constraint("fk_goods_receipts_award_id", "goods_receipts", type_="foreignkey")
    op.drop_index("ix_goods_receipts_award_id", table_name="goods_receipts")
    op.drop_column("goods_receipts", "award_id")
    op.alter_column("goods_receipts", "offer_id", existing_type=sa.Uuid(), nullable=False)
