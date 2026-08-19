from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '72c348c2830b'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('audit_log',
    sa.Column('action', sa.String(length=255), nullable=False),
    sa.Column('details', sa.Text(), nullable=False),
    sa.Column('user_name', sa.String(length=255), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('departments',
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )
    op.create_table('email_templates',
    sa.Column('type', sa.Enum('winner', 'loser', name='emailtype'), nullable=False),
    sa.Column('subject', sa.String(length=500), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.PrimaryKeyConstraint('type')
    )
    op.create_table('users',
    sa.Column('username', sa.String(length=64), nullable=False),
    sa.Column('email', sa.String(length=255), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('role', sa.Enum('admin', 'procurement', 'manager', 'supply_chain', 'finance', name='user_role'), nullable=False),
    sa.Column('status', sa.Enum('active', 'inactive', name='user_status'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_users_email'), 'users', ['email'], unique=True)
    op.create_index(op.f('ix_users_username'), 'users', ['username'], unique=True)
    op.create_table('tenders',
    sa.Column('serial', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('deadline_date', sa.Date(), nullable=False),
    sa.Column('deadline_time', sa.Time(), nullable=False),
    sa.Column('currency', sa.String(length=8), nullable=False),
    sa.Column('category', sa.Enum('goods', 'services', 'works', 'consulting', name='tendercategory'), nullable=False),
    sa.Column('status', sa.Enum('open', 'closed', 'awarded', 'rejected', name='tenderstatus'), nullable=False),
    sa.Column('department_id', sa.Uuid(), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('required_docs', sa.JSON(), nullable=False),
    sa.Column('scoring_criteria', sa.JSON(), nullable=False),
    sa.Column('evaluation_submitted', sa.Boolean(), nullable=False),
    sa.Column('evaluation_submitted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('evaluation_submitted_by', sa.Uuid(), nullable=True),
    sa.Column('manager_approved', sa.Boolean(), nullable=False),
    sa.Column('manager_rejected', sa.Boolean(), nullable=False),
    sa.Column('manager_reviewed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('manager_reviewed_by', sa.Uuid(), nullable=True),
    sa.Column('manager_feedback', sa.Text(), nullable=True),
    sa.Column('supply_chain_approved', sa.Boolean(), nullable=False),
    sa.Column('supply_chain_rejected', sa.Boolean(), nullable=False),
    sa.Column('supply_chain_reviewed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('supply_chain_reviewed_by', sa.Uuid(), nullable=True),
    sa.Column('supply_chain_rejection_reason', sa.Text(), nullable=True),
    sa.Column('awarded_vendor_submission_id', sa.Uuid(), nullable=True),
    sa.Column('awarded_vendor_name', sa.String(length=255), nullable=True),
    sa.Column('awarded_amount', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('awarded_email', sa.String(length=255), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['awarded_vendor_submission_id'], ['submissions.id'], name='fk_tenders_awarded_submission', use_alter=True),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ),
    sa.ForeignKeyConstraint(['department_id'], ['departments.id'], ),
    sa.ForeignKeyConstraint(['evaluation_submitted_by'], ['users.id'], ),
    sa.ForeignKeyConstraint(['manager_reviewed_by'], ['users.id'], ),
    sa.ForeignKeyConstraint(['supply_chain_reviewed_by'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_tenders_serial'), 'tenders', ['serial'], unique=True)
    op.create_table('notifications',
    sa.Column('type', sa.Enum('submission_received', 'evaluation_submitted', 'changes_requested', 'manager_approved', 'sc_rejected', 'tender_awarded', name='notificationtype'), nullable=False),
    sa.Column('tender_id', sa.Uuid(), nullable=True),
    sa.Column('message', sa.Text(), nullable=False),
    sa.Column('for_role', sa.Enum('admin', 'procurement', 'manager', 'supply_chain', 'finance', name='userrole'), nullable=False),
    sa.Column('read', sa.Boolean(), nullable=False),
    sa.Column('details', sa.JSON(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['tender_id'], ['tenders.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_notifications_for_role'), 'notifications', ['for_role'], unique=False)
    op.create_table('submissions',
    sa.Column('tender_id', sa.Uuid(), nullable=False),
    sa.Column('company_name', sa.String(length=255), nullable=False),
    sa.Column('contact_name', sa.String(length=255), nullable=False),
    sa.Column('email', sa.String(length=255), nullable=False),
    sa.Column('phone', sa.String(length=64), nullable=False),
    sa.Column('total_amount', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('files', sa.JSON(), nullable=False),
    sa.Column('status', sa.Enum('pending', 'validated', 'rejected', name='submissionstatus'), nullable=False),
    sa.Column('submitted_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['tender_id'], ['tenders.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_submissions_email'), 'submissions', ['email'], unique=False)
    op.create_index(op.f('ix_submissions_tender_id'), 'submissions', ['tender_id'], unique=False)
    op.create_table('evaluations',
    sa.Column('submission_id', sa.Uuid(), nullable=False),
    sa.Column('tender_id', sa.Uuid(), nullable=False),
    sa.Column('evaluator_role', sa.Enum('procurement', 'manager', name='evaluatorrole'), nullable=False),
    sa.Column('scores', sa.JSON(), nullable=False),
    sa.Column('total_score', sa.Numeric(precision=4, scale=2), nullable=False),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('evaluated_by', sa.Uuid(), nullable=True),
    sa.Column('evaluated_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['evaluated_by'], ['users.id'], ),
    sa.ForeignKeyConstraint(['submission_id'], ['submissions.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['tender_id'], ['tenders.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('submission_id', 'evaluator_role', name='uq_submission_evaluator')
    )
    op.create_index(op.f('ix_evaluations_submission_id'), 'evaluations', ['submission_id'], unique=False)
    op.create_index(op.f('ix_evaluations_tender_id'), 'evaluations', ['tender_id'], unique=False)
    op.create_table('sent_emails',
    sa.Column('tender_id', sa.Uuid(), nullable=False),
    sa.Column('tender_serial', sa.String(length=32), nullable=False),
    sa.Column('tender_name', sa.String(length=255), nullable=False),
    sa.Column('submission_id', sa.Uuid(), nullable=False),
    sa.Column('vendor_company', sa.String(length=255), nullable=False),
    sa.Column('recipient_email', sa.String(length=255), nullable=False),
    sa.Column('type', sa.Enum('winner', 'loser', name='emailtype'), nullable=False),
    sa.Column('subject', sa.String(length=500), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('sent_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['submission_id'], ['submissions.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['tender_id'], ['tenders.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_sent_emails_tender_id'), 'sent_emails', ['tender_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_sent_emails_tender_id'), table_name='sent_emails')
    op.drop_table('sent_emails')
    op.drop_index(op.f('ix_evaluations_tender_id'), table_name='evaluations')
    op.drop_index(op.f('ix_evaluations_submission_id'), table_name='evaluations')
    op.drop_table('evaluations')
    op.drop_index(op.f('ix_submissions_tender_id'), table_name='submissions')
    op.drop_index(op.f('ix_submissions_email'), table_name='submissions')
    op.drop_table('submissions')
    op.drop_index(op.f('ix_notifications_for_role'), table_name='notifications')
    op.drop_table('notifications')
    op.drop_index(op.f('ix_tenders_serial'), table_name='tenders')
    op.drop_table('tenders')
    op.drop_index(op.f('ix_users_username'), table_name='users')
    op.drop_index(op.f('ix_users_email'), table_name='users')
    op.drop_table('users')
    op.drop_table('email_templates')
    op.drop_table('departments')
    op.drop_table('audit_log')
