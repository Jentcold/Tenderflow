from alembic import op
import sqlalchemy as sa

revision = "e9d4a2c60f37"
down_revision = "d8b3f60c1a94"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("tenders", "deadline_date", existing_type=sa.Date(), nullable=True)
    op.alter_column("tenders", "deadline_time", existing_type=sa.Time(), nullable=True)
    op.alter_column("tenders", "description", existing_type=sa.Text(), nullable=True)


def downgrade() -> None:
    op.execute("UPDATE tenders SET description = '' WHERE description IS NULL")
    op.execute("UPDATE tenders SET deadline_date = CURRENT_DATE + 30 WHERE deadline_date IS NULL")
    op.execute("UPDATE tenders SET deadline_time = TIME '09:00' WHERE deadline_time IS NULL")
    op.alter_column("tenders", "description", existing_type=sa.Text(), nullable=False)
    op.alter_column("tenders", "deadline_time", existing_type=sa.Time(), nullable=False)
    op.alter_column("tenders", "deadline_date", existing_type=sa.Date(), nullable=False)
