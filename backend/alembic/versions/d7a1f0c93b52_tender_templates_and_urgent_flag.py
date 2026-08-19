"""tender templates, and an urgent flag on tenders

Two additions to the new purchasing flow:

* `tender_templates` — purchasing's reusable stencils, tagged by department and
  category so a department browsing its own category finds only what applies.
* `tenders.urgent` — the manager's flag that lets a tender skip the purchasing
  manager and supply chain approval gates (they still get notified).

Hand-written. The `category` enum type already exists in the database (shared
by tenders.category and vendors.vendor_category), so it is referenced with
create_type=False — letting alembic emit CREATE TYPE again fails with
"type category already exists" and takes the whole migration down with it.

Revision ID: d7a1f0c93b52
Revises: c4d2a81e6b09
Create Date: 2026-08-17

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'd7a1f0c93b52'
down_revision: Union[str, None] = 'c4d2a81e6b09'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

category_enum = postgresql.ENUM(
    "goods", "services", "works", "consulting", name="category", create_type=False
)


def upgrade() -> None:
    op.create_table(
        "tender_templates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("category", category_enum, nullable=False),
        # Nullable on purpose: NULL means "offered to every department".
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("currency", sa.String(length=8), nullable=False),
        sa.Column("default_deadline_days", sa.Integer(), nullable=False),
        sa.Column("required_docs", sa.JSON(), nullable=False),
        sa.Column("scoring_criteria", sa.JSON(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["department_id"], ["departments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_tender_templates_department_id"), "tender_templates", ["department_id"]
    )

    # server_default so the existing rows get a value; the model's Python-side
    # default covers new ones. Without it the NOT NULL add fails on a table that
    # already has tenders in it.
    op.add_column(
        "tenders", sa.Column("urgent", sa.Boolean(), nullable=False, server_default=sa.false())
    )


def downgrade() -> None:
    op.drop_column("tenders", "urgent")
    op.drop_index(op.f("ix_tender_templates_department_id"), table_name="tender_templates")
    op.drop_table("tender_templates")
    # The `category` type is left alone — it was not created here and both
    # tenders and vendors still use it.
