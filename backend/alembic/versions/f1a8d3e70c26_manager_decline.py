from alembic import op
import sqlalchemy as sa

revision = "f1a8d3e70c26"
down_revision = "e9d4a2c60f37"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenders",
        sa.Column("manager_declined", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column("tenders", "manager_declined", server_default=None)


def downgrade() -> None:
    op.drop_column("tenders", "manager_declined")
