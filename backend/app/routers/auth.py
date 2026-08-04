from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import get_current_user
from app.core.security import create_access_token, verify_password
from app.database import get_db
from app.models.user import User, UserStatus
from app.schemas.auth import LoginRequest, TokenResponse
from app.schemas.user import UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    identifier = payload.username.strip().lower()
    user = await db.scalar(
        select(User).where(or_(User.username == identifier, User.email == identifier))
    )

    if user is None or user.status != UserStatus.active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username or password")

    token = create_access_token(subject=str(user.id), role=user.role.value)
    await log_audit(db, "User Login", f"{user.name} logged in as {user.role.value}", user.name)
    await db.commit()

    return TokenResponse(access_token=token, user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.post("/logout")
async def logout(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> dict:
    # JWTs are stateless here, so "logout" is a client-side token discard.
    # This endpoint just records the audit trail entry to match old behavior.
    await log_audit(db, "User Logout", f"{user.name} logged out", user.name)
    await db.commit()
    return {"detail": "Logged out"}
