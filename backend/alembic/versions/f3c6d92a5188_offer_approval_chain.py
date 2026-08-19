from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'f3c6d92a5188'
down_revision: Union[str, None] = 'e2b5c81d4477'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NEW_LABELS = ("purchasing_ok", "purchasing_manager_ok", "approved")

offer_status = postgresql.ENUM(
    "pending", "selected", "rejected", *NEW_LABELS, name="offerstatus", create_type=False
)


def upgrade() -> None:
    for label in NEW_LABELS:
        op.execute(f"ALTER TYPE offerstatus ADD VALUE IF NOT EXISTS '{label}'")

    for column in (
        sa.Column("manager_selected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("manager_selected_by", sa.Uuid(), nullable=True),
        sa.Column("purchasing_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("purchasing_reviewed_by", sa.Uuid(), nullable=True),
        sa.Column("purchasing_manager_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("purchasing_manager_reviewed_by", sa.Uuid(), nullable=True),
        sa.Column("supply_chain_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("supply_chain_reviewed_by", sa.Uuid(), nullable=True),
        sa.Column("rejected_at_stage", offer_status, nullable=True),
        sa.Column("rejected_by", sa.Uuid(), nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("urgent_skipped", sa.Boolean(), nullable=False, server_default=sa.false()),
    ):
        op.add_column("offers", column)

    for name, local in (
        ("fk_offers_manager_selected_by", "manager_selected_by"),
        ("fk_offers_purchasing_reviewed_by", "purchasing_reviewed_by"),
        ("fk_offers_purchasing_manager_reviewed_by", "purchasing_manager_reviewed_by"),
        ("fk_offers_supply_chain_reviewed_by", "supply_chain_reviewed_by"),
        ("fk_offers_rejected_by", "rejected_by"),
    ):
        op.create_foreign_key(name, "offers", "users", [local], ["id"])

    op.add_column("departments", sa.Column("code", sa.String(length=32), nullable=True))
    op.create_index(op.f("ix_departments_code"), "departments", ["code"], unique=True)
    op.execute("UPDATE departments SET code = 'purchasing' WHERE name = 'Purchasing'")
    op.execute("UPDATE departments SET code = 'supply_chain' WHERE name = 'Supply Chain'")
    op.execute("UPDATE departments SET code = 'warehouse' WHERE name = 'Warehouse'")


def downgrade() -> None:
    op.drop_index(op.f("ix_departments_code"), table_name="departments")
    op.drop_column("departments", "code")

    for name in (
        "fk_offers_manager_selected_by",
        "fk_offers_purchasing_reviewed_by",
        "fk_offers_purchasing_manager_reviewed_by",
        "fk_offers_supply_chain_reviewed_by",
        "fk_offers_rejected_by",
    ):
        op.drop_constraint(name, "offers", type_="foreignkey")

    for column in (
        "urgent_skipped",
        "rejection_reason",
        "rejected_by",
        "rejected_at_stage",
        "supply_chain_reviewed_by",
        "supply_chain_reviewed_at",
        "purchasing_manager_reviewed_by",
        "purchasing_manager_reviewed_at",
        "purchasing_reviewed_by",
        "purchasing_reviewed_at",
        "manager_selected_by",
        "manager_selected_at",
    ):
        op.drop_column("offers", column)

    op.execute(
        "UPDATE offers SET status = 'selected' "
        "WHERE status IN ('purchasing_ok', 'purchasing_manager_ok', 'approved')"
    )
    op.execute("ALTER TYPE offerstatus RENAME TO offerstatus_old")
    op.execute("CREATE TYPE offerstatus AS ENUM ('pending', 'selected', 'rejected')")
    op.execute(
        "ALTER TABLE offers ALTER COLUMN status DROP DEFAULT, "
        "ALTER COLUMN status TYPE offerstatus USING status::text::offerstatus, "
        "ALTER COLUMN status SET DEFAULT 'pending'"
    )
    op.execute("DROP TYPE offerstatus_old")
