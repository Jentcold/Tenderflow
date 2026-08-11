"""point notifications.for_role at user_role and drop the duplicate enum

Revision ID: b8f31d0c5e42
Revises: a1c7e94b2f30
Create Date: 2026-08-11 13:05:00.000000

There were two Postgres enums for one Python enum. `users.role` used
`user_role`, created explicitly by the model. `notifications.for_role` declared
no name, so SQLAlchemy derived `userrole` — a second type that drifted, because
every migration that added a label (b349235fa678 for 'vendor', a1c7e94b2f30 for
'employee') only ever touched the first one.

`userrole` was therefore stuck at the original five labels, and any query
comparing `for_role` against a newer role failed with
`invalid input value for enum userrole`. The vendor case never surfaced only
because the UI hides the notification bell from vendors; adding employees hit
it immediately.

Patching the labels in would have left both types in place to drift again, so
the column is repointed at `user_role` and the duplicate dropped. Only
notifications.for_role ever referenced it.

"""
from typing import Sequence, Union

from alembic import op


revision: str = 'b8f31d0c5e42'
down_revision: Union[str, None] = 'a1c7e94b2f30'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ORIGINAL_LABELS = "'admin', 'procurement', 'manager', 'supply_chain', 'finance'"


def upgrade() -> None:
    op.execute(
        "ALTER TABLE notifications ALTER COLUMN for_role TYPE user_role "
        "USING for_role::text::user_role"
    )
    op.execute("DROP TYPE userrole")


def downgrade() -> None:
    # Rows addressed to a role the old type never knew about can't survive the
    # cast back. They're cleared rather than deleted: the notification still
    # belongs to whoever `user_id` names, it just loses its role addressing.
    op.execute(
        "UPDATE notifications SET for_role = NULL "
        f"WHERE for_role::text NOT IN ({ORIGINAL_LABELS})"
    )
    op.execute(f"CREATE TYPE userrole AS ENUM ({ORIGINAL_LABELS})")
    op.execute(
        "ALTER TABLE notifications ALTER COLUMN for_role TYPE userrole "
        "USING for_role::text::userrole"
    )
