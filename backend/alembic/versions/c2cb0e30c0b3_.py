"""email delivery tracking on sent_emails

Revision ID: c2cb0e30c0b3
Revises: 7e58402b7ec3
Create Date: 2026-08-10 15:07:24.595472

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'c2cb0e30c0b3'
down_revision: Union[str, None] = '7e58402b7ec3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Named separately so the type can be created before any column references it.
# op.add_column() does not emit CREATE TYPE the way create_table() does, so
# autogenerate's version of this migration failed on a fresh database.
email_status = sa.Enum('queued', 'sent', 'failed', 'simulated', name='emailstatus')


def upgrade() -> None:
    email_status.create(op.get_bind(), checkfirst=True)

    # Rows that predate delivery tracking were never handed to a mail server,
    # so they backfill as 'simulated' — marking them 'queued' would make the
    # email log offer to resend mail that was only ever rendered.
    op.add_column(
        'sent_emails',
        sa.Column(
            'status',
            postgresql.ENUM(name='emailstatus', create_type=False),
            nullable=False,
            server_default='simulated',
        ),
    )
    op.add_column('sent_emails', sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('sent_emails', sa.Column('error', sa.Text(), nullable=True))
    op.add_column('sent_emails', sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f('ix_sent_emails_status'), 'sent_emails', ['status'], unique=False)

    # Backfill done; new rows get their status from the model instead.
    op.alter_column('sent_emails', 'status', server_default=None)


def downgrade() -> None:
    op.drop_index(op.f('ix_sent_emails_status'), table_name='sent_emails')
    op.drop_column('sent_emails', 'sent_at')
    op.drop_column('sent_emails', 'error')
    op.drop_column('sent_emails', 'attempts')
    op.drop_column('sent_emails', 'status')
    email_status.drop(op.get_bind(), checkfirst=True)
