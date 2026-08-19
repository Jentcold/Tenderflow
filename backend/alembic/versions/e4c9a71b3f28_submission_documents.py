from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e4c9a71b3f28'
down_revision: Union[str, None] = 'd2e5b81f4a07'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "submissions",
        sa.Column("documents", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("submissions", "documents")
