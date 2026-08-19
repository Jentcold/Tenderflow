from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a4e7b31c9d60'
down_revision: Union[str, None] = 'f3c6d92a5188'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_LABELS = (
    "tender_pending_approval", "manager_approved", "changes_requested",
    "submission_received", "evaluation_submitted", "sc_rejected", "tender_awarded",
)
NEW_LABELS = (
    "tender_pending_approval", "manager_approved", "changes_requested",
    "submission_received", "offer_selected", "sc_rejected", "tender_awarded",
)


def _rebuild_notification_type(labels: Sequence[str], remap: tuple[str, str]) -> None:
    old, new = remap
    op.execute(f"ALTER TYPE notificationtype RENAME TO notificationtype_old")
    op.execute("CREATE TYPE notificationtype AS ENUM (" + ", ".join(f"'{l}'" for l in labels) + ")")
    op.execute(
        f"ALTER TABLE notifications ALTER COLUMN type TYPE text USING type::text"
    )
    op.execute(f"UPDATE notifications SET type = '{new}' WHERE type = '{old}'")
    op.execute(
        "ALTER TABLE notifications ALTER COLUMN type TYPE notificationtype "
        "USING type::notificationtype"
    )
    op.execute("DROP TYPE notificationtype_old")


def upgrade() -> None:
    op.drop_column("tenders", "scoring_criteria")
    op.drop_column("tenders", "evaluation_submitted")
    op.drop_column("tenders", "evaluation_submitted_at")
    op.drop_column("tenders", "evaluation_submitted_by")

    op.drop_table("evaluations")

    _rebuild_notification_type(NEW_LABELS, ("evaluation_submitted", "offer_selected"))

    op.execute(
        "UPDATE email_templates SET body = replace(body, 'Your Score: {combined_score}/10' || chr(10) || chr(10), '') "
        "WHERE body LIKE '%{combined_score}%'"
    )
    op.execute(
        "UPDATE email_templates SET body = replace(body, 'Your Score: {combined_score}/10', '') "
        "WHERE body LIKE '%{combined_score}%'"
    )


def downgrade() -> None:
    _rebuild_notification_type(OLD_LABELS, ("offer_selected", "evaluation_submitted"))

    op.create_table(
        "evaluations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("submission_id", sa.Uuid(), nullable=False),
        sa.Column("tender_id", sa.Uuid(), nullable=False),
        sa.Column("scores", sa.JSON(), nullable=True),
        sa.Column("total_score", sa.Numeric(4, 2), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("evaluated_by", sa.Uuid(), nullable=True),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["submission_id"], ["submissions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tender_id"], ["tenders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["evaluated_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_evaluations_submission_id", "evaluations", ["submission_id"], unique=True)
    op.create_index("ix_evaluations_tender_id", "evaluations", ["tender_id"], unique=False)

    op.add_column("tenders", sa.Column("evaluation_submitted_by", sa.Uuid(), nullable=True))
    op.add_column(
        "tenders", sa.Column("evaluation_submitted_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "tenders",
        sa.Column("evaluation_submitted", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "tenders",
        sa.Column("scoring_criteria", sa.JSON(), nullable=False, server_default="[]"),
    )
