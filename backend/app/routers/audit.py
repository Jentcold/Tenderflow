from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_roles
from app.core.pagination import Page, Pagination, paginate
from app.database import get_db
from app.models.audit_log import AuditLog
from app.schemas.audit import AuditLogOut

router = APIRouter(prefix="/audit", tags=["audit"], dependencies=[Depends(require_roles("admin"))])


@router.get("", response_model=Page[AuditLogOut])
async def list_audit_log(
    action: str | None = Query(default=None, description="Exact action name, e.g. 'Tender Approved'"),
    user_name: str | None = Query(default=None, description="Substring match on who did it"),
    page: Pagination = Depends(),
    db: AsyncSession = Depends(get_db),
) -> Page[AuditLogOut]:
    # Previously capped at a hard 500 with no way past it, which quietly turned
    # the audit trail into "the most recent 500 things" — the opposite of what
    # an audit trail is for. Paging reaches every row.
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
