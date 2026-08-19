from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c68bd5372288'
down_revision: Union[str, None] = '09945e1fc8ee'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

FK_SUBMISSION_VENDOR = "fk_submissions_vendor_id"
FK_VENDOR_USER = "fk_vendors_user_id"


def upgrade() -> None:
    op.add_column('submissions', sa.Column('vendor_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_submissions_vendor_id'), 'submissions', ['vendor_id'], unique=False)
    op.create_foreign_key(
        FK_SUBMISSION_VENDOR, 'submissions', 'vendors', ['vendor_id'], ['id'], ondelete='SET NULL'
    )

    op.alter_column('vendors', 'contact_email',
                    existing_type=sa.TEXT(),
                    type_=sa.String(length=255),
                    existing_nullable=False)
    op.alter_column('vendors', 'contact_phone',
                    existing_type=sa.VARCHAR(length=20),
                    type_=sa.String(length=64),
                    existing_nullable=False)

    op.create_index(op.f('ix_vendors_company_name'), 'vendors', ['company_name'], unique=False)
    op.create_index(op.f('ix_vendors_user_id'), 'vendors', ['user_id'], unique=True)

    op.drop_constraint(op.f('vendors_user_id_fkey'), 'vendors', type_='foreignkey')
    op.create_foreign_key(FK_VENDOR_USER, 'vendors', 'users', ['user_id'], ['id'], ondelete='CASCADE')


def downgrade() -> None:
    op.drop_constraint(FK_VENDOR_USER, 'vendors', type_='foreignkey')
    op.create_foreign_key(op.f('vendors_user_id_fkey'), 'vendors', 'users', ['user_id'], ['id'])
    op.drop_index(op.f('ix_vendors_user_id'), table_name='vendors')
    op.drop_index(op.f('ix_vendors_company_name'), table_name='vendors')

    op.execute("UPDATE vendors SET contact_phone = left(contact_phone, 20)")
    op.alter_column('vendors', 'contact_phone',
                    existing_type=sa.String(length=64),
                    type_=sa.VARCHAR(length=20),
                    existing_nullable=False)
    op.alter_column('vendors', 'contact_email',
                    existing_type=sa.String(length=255),
                    type_=sa.TEXT(),
                    existing_nullable=False)

    op.drop_constraint(FK_SUBMISSION_VENDOR, 'submissions', type_='foreignkey')
    op.drop_index(op.f('ix_submissions_vendor_id'), table_name='submissions')
    op.drop_column('submissions', 'vendor_id')
