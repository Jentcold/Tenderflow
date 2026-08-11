import uuid
from collections.abc import Callable

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_access_token
from app.database import get_db
from app.models.user import User, UserStatus

bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = decode_access_token(credentials.credentials)
        user_id = uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")

    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None or user.status != UserStatus.active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found or inactive")
    return user


async def get_current_user_optional(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """For public routes that behave better when they know who's calling.

    No credentials means an anonymous caller, which is fine. Credentials that
    are *present but bad* still 401 — quietly downgrading a expired token to
    anonymous would leave a vendor wondering why their bid came out
    unattributed.
    """
    if credentials is None:
        return None
    return await get_current_user(credentials, db)


def require_roles(*roles: str) -> Callable:
    """Usage: Depends(require_roles('admin', 'procurement'))"""

    async def checker(user: User = Depends(get_current_user)) -> User:
        if user.role.value not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions for this action")
        return user

    return checker


# Back-office roles: the people who run the tender process and may therefore
# see bids, vendors and scores. Deliberately excludes both vendors and
# employees.
STAFF_ROLES = ("admin", "procurement", "manager", "supply_chain", "finance")
require_staff = require_roles(*STAFF_ROLES)

# Anyone on the company payroll, staff plus the employees who only raise
# requests. Wider than require_staff, so it gates only the routers an employee
# genuinely needs: /tenders (where each endpoint re-checks) and /departments
# (which their request form has to populate). Adding "employee" to STAFF_ROLES
# instead would have handed them /submissions, /vendors and /evaluations.
INTERNAL_ROLES = STAFF_ROLES + ("employee",)
require_internal = require_roles(*INTERNAL_ROLES)
