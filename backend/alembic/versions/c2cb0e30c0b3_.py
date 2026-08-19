from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'c2cb0e30c0b3'
down_revision: Union[str, None] = '7e58402b7ec3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

email_status = sa.Enum('queued', 'sent', 'failed', 'simulated', name='emailstatus')


def upgrade() -> None:
    email_status.create(op.get_bind(), checkfirst=True)

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

    op.alter_column('sent_emails', 'status', server_default=None)


def downgrade() -> None:
    op.drop_index(op.f('ix_sent_emails_status'), table_name='sent_emails')
    op.drop_column('sent_emails', 'sent_at')
    op.drop_column('sent_emails', 'error')
    op.drop_column('sent_emails', 'attempts')
    op.drop_column('sent_emails', 'status')
    email_status.drop(op.get_bind(), checkfirst=True)
