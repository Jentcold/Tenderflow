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

    op.add_column(
        "tenders", sa.Column("urgent", sa.Boolean(), nullable=False, server_default=sa.false())
    )


def downgrade() -> None:
    op.drop_column("tenders", "urgent")
    op.drop_index(op.f("ix_tender_templates_department_id"), table_name="tender_templates")
    op.drop_table("tender_templates")
