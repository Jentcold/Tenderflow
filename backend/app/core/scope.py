"""Who manages what.

Seniority in this app is a *department*, not a role: the purchasing manager is
`role=manager` attached to Purchasing, and a department manager is the same role
attached to their own. Every screen that has to tell those two apart, or has to
ask "is this tender theirs", ends up needing the same two lookups.

`offers.py` and `awards.py` still carry their own private copies of the first
two; this module exists because the tender router needed the same rule when a
department manager gained the right to edit their own department's request, and
a fourth copy pasted into `tenders.py` is how a rule starts drifting. The
semantics here match `offers.py::_managed_department_ids` exactly - if you
change one, change both.
"""
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.department import PURCHASING_CODE, Department
from app.models.tender import Tender
from app.models.user import User, UserRole


async def is_purchasing_manager(db: AsyncSession, user: User) -> bool:
    """A manager whose own department is Purchasing.

    This is the "purchasing manager" of the approval chain. There is no role for
    it - the roles stay generic and seniority comes from the department - so
    adding a second purchasing manager is adding a user row, with no enum label
    and no migration.
    """
    if user.role != UserRole.manager or user.department_id is None:
        return False
    department = await db.get(Department, user.department_id)
    return department is not None and department.code == PURCHASING_CODE


async def managed_department_ids(db: AsyncSession, user: User) -> set[uuid.UUID]:
    """Departments this user manages.

    Two sources, deliberately OR-ed: `users.department_id` where the person's
    role is manager (the general rule - a department can have several managers,
    and adding one is adding a row), and the older `departments.manager` single
    -head pointer, which some installs are still configured with.
    """
    ids: set[uuid.UUID] = set()
    if user.role == UserRole.manager and user.department_id is not None:
        ids.add(user.department_id)
    ids.update(
        (
            await db.execute(select(Department.id).where(Department.manager == user.id))
        ).scalars().all()
    )
    return ids


async def manages_tender(db: AsyncSession, tender: Tender, user: User) -> bool:
    """Is this tender one the caller is the department manager of?

    False for the purchasing manager even though they are a manager: they sit on
    the approval chain, not at the raising end of it, and the request they would
    be "managing" here is somebody else's.

    A manager attached to no department at all counts as managing everything -
    the same known gap the offers scoping carries, kept so a half-configured
    install and the demo data stay usable.
    """
    if await is_purchasing_manager(db, user):
        return False
    managed = await managed_department_ids(db, user)
    if user.role == UserRole.manager and not managed:
        return True
    return tender.department_id in managed
