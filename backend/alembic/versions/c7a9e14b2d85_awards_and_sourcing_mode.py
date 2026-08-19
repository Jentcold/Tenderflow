"""the basket: per-item awards across vendors, and the by-hand path

`awards` + `award_lines`, and `tenders.sourcing_mode`.

The unit of an award becomes the LINE. A tender asking for a mobile, a laptop,
a tablet and a mouse can now be bought from three different vendors and a shop
on the corner, which the old "approve one whole offer" model made impossible.

`sourcingmode` and `awardstatus` are new enum types, created here rather than
left to autogenerate — alembic does not diff enum values, and a type the model
references but the database lacks fails at runtime, not at migration time.

Revision ID: c7a9e14b2d85
Revises: b5f8c24a7e13
Create Date: 2026-08-17

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'c7a9e14b2d85'
down_revision: Union[str, None] = 'b5f8c24a7e13'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SOURCING_MODE = postgresql.ENUM("vendors", "by_hand", name="sourcingmode", create_type=False)
AWARD_STATUS = postgresql.ENUM(
    "draft", "submitted", "purchasing_manager_ok", "approved", "rejected",
    name="awardstatus", create_type=False,
)


def upgrade() -> None:
    sourcing_mode = postgresql.ENUM("vendors", "by_hand", name="sourcingmode")
    sourcing_mode.create(op.get_bind(), checkfirst=True)
    award_status = postgresql.ENUM(
        "draft", "submitted", "purchasing_manager_ok", "approved", "rejected", name="awardstatus"
    )
    award_status.create(op.get_bind(), checkfirst=True)

    op.add_column(
        "tenders",
        sa.Column("sourcing_mode", SOURCING_MODE, nullable=False, server_default="vendors"),
    )

    op.create_table(
        "awards",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tender_id", sa.Uuid(), nullable=False),
        sa.Column("mode", SOURCING_MODE, nullable=False, server_default="vendors"),
        sa.Column("status", AWARD_STATUS, nullable=False, server_default="draft"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("currency", sa.String(length=8), nullable=False, server_default="EGP"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("submitted_by", sa.Uuid(), nullable=True),
        sa.Column("purchasing_manager_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("purchasing_manager_reviewed_by", sa.Uuid(), nullable=True),
        sa.Column("supply_chain_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("supply_chain_reviewed_by", sa.Uuid(), nullable=True),
        sa.Column("rejected_at_stage", AWARD_STATUS, nullable=True),
        sa.Column("rejected_by", sa.Uuid(), nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("urgent_skipped", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["tender_id"], ["tenders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["submitted_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["purchasing_manager_reviewed_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["supply_chain_reviewed_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["rejected_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_awards_tender_id"), "awards", ["tender_id"], unique=False)
    op.create_index(op.f("ix_awards_status"), "awards", ["status"], unique=False)
    op.create_index(op.f("ix_awards_active"), "awards", ["active"], unique=False)

    op.create_table(
        "award_lines",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("award_id", sa.Uuid(), nullable=False),
        sa.Column("tender_item_id", sa.Uuid(), nullable=True),
        sa.Column("offer_item_id", sa.Uuid(), nullable=True),
        sa.Column("vendor_id", sa.Uuid(), nullable=True),
        sa.Column("vendor_name", sa.String(length=255), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("specs", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("quantity", sa.Numeric(12, 2), nullable=False, server_default="1"),
        sa.Column("unit", sa.String(length=32), nullable=False, server_default="pcs"),
        sa.Column("unit_price", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["award_id"], ["awards.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tender_item_id"], ["tender_items.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["offer_item_id"], ["offer_items.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["vendor_id"], ["vendors.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_award_lines_award_id"), "award_lines", ["award_id"], unique=False)
    op.create_index(op.f("ix_award_lines_tender_item_id"), "award_lines", ["tender_item_id"], unique=False)
    op.create_index(op.f("ix_award_lines_offer_item_id"), "award_lines", ["offer_item_id"], unique=False)
    op.create_index(op.f("ix_award_lines_vendor_id"), "award_lines", ["vendor_id"], unique=False)


def downgrade() -> None:
    op.drop_table("award_lines")
    op.drop_index(op.f("ix_awards_active"), table_name="awards")
    op.drop_index(op.f("ix_awards_status"), table_name="awards")
    op.drop_index(op.f("ix_awards_tender_id"), table_name="awards")
    op.drop_table("awards")
    op.drop_column("tenders", "sourcing_mode")
    postgresql.ENUM(name="awardstatus").drop(op.get_bind(), checkfirst=True)
    postgresql.ENUM(name="sourcingmode").drop(op.get_bind(), checkfirst=True)
