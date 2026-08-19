from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_internal, require_roles
from app.core.pagination import Page, Pagination, paginate
from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.user import User
from app.schemas.audit import AuditLogOut

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("/mine", response_model=list[AuditLogOut])
async def my_recent_actions(
    limit: int = Query(default=8, ge=1, le=50),
    user: User = Depends(require_internal),
    db: AsyncSession = Depends(get_db),
) -> list[AuditLogOut]:
    entries = (
        await db.execute(
            select(AuditLog)
            .where(AuditLog.user_name == user.name)
            .order_by(AuditLog.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [AuditLogOut.model_validate(e) for e in entries]


@router.get(
    "", response_model=Page[AuditLogOut], dependencies=[Depends(require_roles("admin"))]
)
async def list_audit_log(
    action: str | None = Query(default=None, description="Exact action name, e.g. 'Tender Approved'"),
    user_name: str | None = Query(default=None, description="Substring match on who did it"),
    page: Pagination = Depends(),
    db: AsyncSession = Depends(get_db),
) -> Page[AuditLogOut]:
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc())
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if user_name:
        stmt = stmt.where(AuditLog.user_name.ilike(f"%{user_name.strip()}%"))

    entries, total = await paginate(db, stmt, page)
    return Page[AuditLogOut](
        items=[AuditLogOut.model_validate(e) for e in entries],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )
