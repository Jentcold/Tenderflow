"""required documents arrive with the bid, labelled

`tenders.required_docs` has always said what vendors must send - a tax card, a
commercial register, an ISO certificate. Nothing carried the answer. The vendor
form had one unlabelled attachment box, so what came back was a list of
filenames, and matching those back to the list of requirements was guesswork
over whatever the vendor happened to call the file.

`submissions.documents` is that answer, keyed by the requirement's own label:
{"Tax card": "2026/uuid-tax-card.pdf"}. `submissions.files` is untouched and
keeps meaning what it meant - anything else the vendor wanted to include.

Revision ID: e4c9a71b3f28
Revises: d2e5b81f4a07
Create Date: 2026-08-19

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e4c9a71b3f28'
down_revision: Union[str, None] = 'd2e5b81f4a07'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # server_default so existing bids read as "sent nothing" rather than NULL,
    # which every reader would then have to special-case.
    op.add_column(
        "submissions",
        sa.Column("documents", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("submissions", "documents")
