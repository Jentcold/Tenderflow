from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_internal, require_roles
from app.core.pagination import Page, Pagination, paginate
from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.user import User
from app.schemas.audit import AuditLogOut

# No router-level role gate any more. The full log is still admin-only - that
# check moved onto the endpoint below - but `/audit/mine` has to be reachable
# by everyone whose dashboard shows their own recent decisions, and a blanket
# dependency here made that impossible without a second router.
router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("/mine", response_model=list[AuditLogOut])
async def my_recent_actions(
    limit: int = Query(default=8, ge=1, le=50),
    user: User = Depends(require_internal),
    db: AsyncSession = Depends(get_db),
) -> list[AuditLogOut]:
    """The caller's own recent entries, for the "recent activity" panel.

    Deliberately not a window onto the whole log. A department manager's
    dashboard showing every action in the company would be a real widening of
    who can see what, dressed up as a convenience; what belongs on a personal
    dashboard is what that person did.

    Matched on `user_name`, because that is all `log_audit` records - there is
    no user_id on the row. Two people sharing a display name would see each
    other's entries here. Worth knowing, not worth a schema change for a panel
    that is a memory aid rather than a control.
    """
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
