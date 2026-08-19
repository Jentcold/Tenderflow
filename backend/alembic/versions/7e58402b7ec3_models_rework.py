from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '7e58402b7ec3'
down_revision: Union[str, None] = '67d672641718'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('vendors',
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('company_name', sa.String(length=255), nullable=False),
    sa.Column('contact_email', sa.Text(), nullable=False),
    sa.Column('contact_phone', sa.String(length=20), nullable=False),
    sa.Column('vendor_category', sa.Enum('goods', 'services', 'works', 'consulting', name='vendor_category'), nullable=False),
    sa.Column('tax_id', sa.String(length=255), nullable=False),
    sa.Column('address', sa.String(length=255), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.add_column('departments', sa.Column('manager', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_departments_manager'), 'departments', ['manager'], unique=False)
    op.create_foreign_key(None, 'departments', 'users', ['manager'], ['id'], ondelete='SET NULL')
    op.drop_constraint(op.f('uq_submission_evaluator'), 'evaluations', type_='unique')
    op.drop_index(op.f('ix_evaluations_submission_id'), table_name='evaluations')
    op.create_index(op.f('ix_evaluations_submission_id'), 'evaluations', ['submission_id'], unique=True)
    op.drop_column('evaluations', 'evaluator_role')
    op.add_column('notifications', sa.Column('submission_id', sa.Uuid(), nullable=True))
    op.add_column('notifications', sa.Column('user_id', sa.Uuid(), nullable=True))
    op.alter_column('notifications', 'for_role',
               existing_type=postgresql.ENUM('admin', 'procurement', 'manager', 'supply_chain', 'finance', name='userrole'),
               nullable=True)
    op.create_index(op.f('ix_notifications_user_id'), 'notifications', ['user_id'], unique=False)
    op.create_foreign_key(None, 'notifications', 'submissions', ['submission_id'], ['id'], ondelete='CASCADE')
    op.create_foreign_key(None, 'notifications', 'users', ['user_id'], ['id'], ondelete='CASCADE')
    op.add_column('sent_emails', sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False))
    op.drop_column('sent_emails', 'sent_at')
    op.add_column('submissions', sa.Column('currency', sa.String(length=3), nullable=False))


def downgrade() -> None:
    op.drop_column('submissions', 'currency')
    op.add_column('sent_emails', sa.Column('sent_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), autoincrement=False, nullable=False))
    op.drop_column('sent_emails', 'created_at')
    op.drop_constraint(None, 'notifications', type_='foreignkey')
    op.drop_constraint(None, 'notifications', type_='foreignkey')
    op.drop_index(op.f('ix_notifications_user_id'), table_name='notifications')
    op.alter_column('notifications', 'for_role',
               existing_type=postgresql.ENUM('admin', 'procurement', 'manager', 'supply_chain', 'finance', name='userrole'),
               nullable=False)
    op.drop_column('notifications', 'user_id')
    op.drop_column('notifications', 'submission_id')
    op.add_column('evaluations', sa.Column('evaluator_role', postgresql.ENUM('procurement', 'manager', name='evaluatorrole'), autoincrement=False, nullable=False))
    op.drop_index(op.f('ix_evaluations_submission_id'), table_name='evaluations')
    op.create_index(op.f('ix_evaluations_submission_id'), 'evaluations', ['submission_id'], unique=False)
    op.create_unique_constraint(op.f('uq_submission_evaluator'), 'evaluations', ['submission_id', 'evaluator_role'], postgresql_nulls_not_distinct=False)
    op.drop_constraint(None, 'departments', type_='foreignkey')
    op.drop_index(op.f('ix_departments_manager'), table_name='departments')
    op.drop_column('departments', 'manager')
    op.drop_table('vendors')
