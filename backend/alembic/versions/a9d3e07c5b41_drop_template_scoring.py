from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a9d3e07c5b41'
down_revision: Union[str, None] = 'f3c7b21d9e40'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("tender_templates", "scoring_criteria")


def downgrade() -> None:
    op.add_column(
        "tender_templates",
        sa.Column("scoring_criteria", sa.JSON(), nullable=False, server_default="[]"),
    )
