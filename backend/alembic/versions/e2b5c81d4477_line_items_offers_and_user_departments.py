from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e2b5c81d4477'
down_revision: Union[str, None] = 'd7a1f0c93b52'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

offer_status = sa.Enum("pending", "selected", "rejected", name="offerstatus")


def _line_item_columns() -> list[sa.Column]:
    return [
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("specs", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("quantity", sa.Numeric(12, 2), nullable=False, server_default="1"),
        sa.Column("unit", sa.String(length=32), nullable=False, server_default="pcs"),
    ]


def upgrade() -> None:
    op.create_table(
        "tender_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tender_id", sa.Uuid(), nullable=False),
        *_line_item_columns(),
        sa.ForeignKeyConstraint(["tender_id"], ["tenders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_tender_items_tender_id"), "tender_items", ["tender_id"])

    op.create_table(
        "template_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("template_id", sa.Uuid(), nullable=False),
        *_line_item_columns(),
        sa.ForeignKeyConstraint(["template_id"], ["tender_templates.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_template_items_template_id"), "template_items", ["template_id"])

    op.create_table(
        "offers",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("submission_id", sa.Uuid(), nullable=False),
        sa.Column("tender_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("title", sa.String(length=255), nullable=True),
        sa.Column("total_amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("currency", sa.String(length=8), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("status", offer_status, nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["submission_id"], ["submissions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tender_id"], ["tenders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_offers_submission_id"), "offers", ["submission_id"])
    op.create_index(op.f("ix_offers_tender_id"), "offers", ["tender_id"])

    op.create_table(
        "offer_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("offer_id", sa.Uuid(), nullable=False),
        sa.Column("tender_item_id", sa.Uuid(), nullable=True),
        sa.Column("is_replacement", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("specs", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("quantity", sa.Numeric(12, 2), nullable=False, server_default="1"),
        sa.Column("unit", sa.String(length=32), nullable=False, server_default="pcs"),
        sa.Column("unit_price", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["offer_id"], ["offers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tender_item_id"], ["tender_items.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_offer_items_offer_id"), "offer_items", ["offer_id"])
    op.create_index(op.f("ix_offer_items_tender_item_id"), "offer_items", ["tender_item_id"])

    op.add_column("tenders", sa.Column("awarded_offer_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_tenders_awarded_offer", "tenders", "offers", ["awarded_offer_id"], ["id"], ondelete="SET NULL"
    )

    op.add_column("users", sa.Column("department_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_users_department_id"), "users", ["department_id"])
    op.create_foreign_key(
        "fk_users_department", "users", "departments", ["department_id"], ["id"], ondelete="SET NULL"
    )

    op.execute(
        """
        INSERT INTO offers (id, submission_id, tender_id, position, title,
                            total_amount, currency, notes, status, created_at)
        SELECT gen_random_uuid(), s.id, s.tender_id, 0, NULL,
               s.total_amount, s.currency, s.notes, 'pending', s.submitted_at
        FROM submissions s
        """
    )
    op.execute(
        """
        UPDATE offers o SET status = 'rejected'
        FROM submissions s
        WHERE s.id = o.submission_id AND s.status = 'rejected'
        """
    )
    op.execute(
        """
        UPDATE tenders t SET awarded_offer_id = o.id
        FROM offers o
        WHERE o.submission_id = t.awarded_vendor_submission_id
        """
    )
    op.execute(
        """
        UPDATE offers o SET status = 'selected'
        FROM tenders t
        WHERE t.awarded_offer_id = o.id
        """
    )


def downgrade() -> None:
    op.drop_constraint("fk_users_department", "users", type_="foreignkey")
    op.drop_index(op.f("ix_users_department_id"), table_name="users")
    op.drop_column("users", "department_id")

    op.drop_constraint("fk_tenders_awarded_offer", "tenders", type_="foreignkey")
    op.drop_column("tenders", "awarded_offer_id")

    op.drop_index(op.f("ix_offer_items_tender_item_id"), table_name="offer_items")
    op.drop_index(op.f("ix_offer_items_offer_id"), table_name="offer_items")
    op.drop_table("offer_items")

    op.drop_index(op.f("ix_offers_tender_id"), table_name="offers")
    op.drop_index(op.f("ix_offers_submission_id"), table_name="offers")
    op.drop_table("offers")
    offer_status.drop(op.get_bind(), checkfirst=True)

    op.drop_index(op.f("ix_template_items_template_id"), table_name="template_items")
    op.drop_table("template_items")

    op.drop_index(op.f("ix_tender_items_tender_id"), table_name="tender_items")
    op.drop_table("tender_items")
