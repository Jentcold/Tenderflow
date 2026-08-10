import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import require_roles
from app.core.pagination import Page, Pagination, paginate
from app.core.security import hash_password
from app.database import get_db
from app.models.user import User, UserRole
from app.schemas.user import UserCreate, UserOut, UserUpdate

router = APIRouter(prefix="/users", tags=["users"], dependencies=[Depends(require_roles("admin"))])

# A vendor user is meaningless without the company profile beside it, and only
# POST /api/vendor/register writes both. Letting an admin hand-make one here
# would leave an account that every /api/vendor route 404s on.
VENDOR_ROLE_MESSAGE = (
    "Vendor accounts are created through POST /api/vendor/register, which also "
    "captures the company profile"
)


@router.get("", response_model=Page[UserOut])
async def list_users(
    role: UserRole | None = Query(default=None),
    page: Pagination = Depends(),
    db: AsyncSession = Depends(get_db),
) -> Page[UserOut]:
    stmt = select(User).order_by(User.created_at)
    if role:
        stmt = stmt.where(User.role == role)
    users, total = await paginate(db, stmt, page)
    return Page[UserOut](
        items=[UserOut.model_validate(u) for u in users],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: UserCreate, admin: User = Depends(require_roles("admin")), db: AsyncSession = Depends(get_db)
) -> User:
    if payload.role == UserRole.vendor:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, VENDOR_ROLE_MESSAGE)

    existing = await db.scalar(
        select(User).where(or_(User.username == payload.username, User.email == payload.email.lower()))
    )
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "Username or email already exists")

    user = User(
        username=payload.username,
        email=payload.email.lower(),
        name=payload.name,
        password_hash=hash_password(payload.password),
        role=payload.role,
        status=payload.status,
    )
    db.add(user)
    await log_audit(db, "User Created", f"{user.name} ({user.username}) as {user.role.value}", admin.name)
    await db.commit()
    await db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: uuid.UUID,
    payload: UserUpdate,
    admin: User = Depends(require_roles("admin")),
    db: AsyncSession = Depends(get_db),
) -> User:
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    # Both directions are blocked: promoting a vendor to staff would strand
    # their company profile, and demoting staff to vendor would create the
    # profile-less account the create guard exists to prevent. Deactivate the
    # account instead.
    if payload.role and payload.role != user.role and UserRole.vendor in (payload.role, user.role):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "A vendor account can't be converted to or from a staff role — "
            "deactivate it and create the new account separately",
        )

    if payload.username or payload.email:
        dupe_check = await db.scalar(
            select(User).where(
                or_(
                    User.username == (payload.username or user.username),
                    User.email == (payload.email or user.email).lower(),
                ),
                User.id != user_id,
            )
        )
        if dupe_check:
            raise HTTPException(status.HTTP_409_CONFLICT, "Username or email already exists")

    if payload.username:
        user.username = payload.username.lower()
    if payload.email:
        user.email = payload.email.lower()
    if payload.name:
        user.name = payload.name
    if payload.password:
        user.password_hash = hash_password(payload.password)
    if payload.role:
        user.role = payload.role
    if payload.status:
        user.status = payload.status

    await log_audit(db, "User Updated", f"{user.name} ({user.username})", admin.name)
    await db.commit()
    await db.refresh(user)
    return user


@router.post("/{user_id}/toggle-status", response_model=UserOut)
async def toggle_user_status(
    user_id: uuid.UUID,
    admin: User = Depends(require_roles("admin")),
    db: AsyncSession = Depends(get_db),
) -> User:
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    if user.id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot deactivate your own account")

    from app.models.user import UserStatus

    user.status = UserStatus.inactive if user.status == UserStatus.active else UserStatus.active
    await log_audit(
        db,
        "User Activated" if user.status == UserStatus.active else "User Deactivated",
        f"{user.name} ({user.username})",
        admin.name,
    )
    await db.commit()
    await db.refresh(user)
    return user
