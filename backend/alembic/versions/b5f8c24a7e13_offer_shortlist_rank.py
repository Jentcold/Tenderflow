from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b5f8c24a7e13'
down_revision: Union[str, None] = 'a4e7b31c9d60'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("offers", sa.Column("manager_rank", sa.Integer(), nullable=True))
    op.execute("UPDATE offers SET manager_rank = 1 WHERE status = 'selected'")


def downgrade() -> None:
    op.drop_column("offers", "manager_rank")
