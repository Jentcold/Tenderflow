import uuid
from collections.abc import Callable

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.database import get_db
from app.models.department import PURCHASING_CODE, Department
from app.models.tender import Tender
from app.models.user import User, UserRole


async def is_purchasing_manager(db: AsyncSession, user: User) -> bool:
    if user.role != UserRole.manager or user.department_id is None:
        return False
    department = await db.get(Department, user.department_id)
    return department is not None and department.code == PURCHASING_CODE


def require_purchasing(*roles: str) -> Callable:
    async def checker(
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if user.role.value in roles:
            return user
        if await is_purchasing_manager(db, user):
            return user
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Insufficient permissions for this action"
        )

    return checker


async def managed_department_ids(db: AsyncSession, user: User) -> set[uuid.UUID]:
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
    if await is_purchasing_manager(db, user):
        return False
    managed = await managed_department_ids(db, user)
    if user.role == UserRole.manager and not managed:
        return True
    return tender.department_id in managed
