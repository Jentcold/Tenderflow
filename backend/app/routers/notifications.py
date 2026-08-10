import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.core.pagination import Page, Pagination, count_rows, paginate
from app.database import get_db
from app.models.notification import Notification
from app.models.user import User
from app.schemas.notification import NotificationOut

router = APIRouter(prefix="/notifications", tags=["notifications"], dependencies=[Depends(get_current_user)])


@router.get("", response_model=Page[NotificationOut])
async def list_my_notifications(
    unread_only: bool = Query(default=False),
    page: Pagination = Depends(),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Page[NotificationOut]:
    stmt = select(Notification).where(Notification.for_role == user.role).order_by(Notification.created_at.desc())
    if unread_only:
        stmt = stmt.where(Notification.read.is_(False))

    notifications, total = await paginate(db, stmt, page)
    return Page[NotificationOut](
        items=[NotificationOut.model_validate(n) for n in notifications],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/unread-count")
async def unread_count(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> dict:
    """For the header badge — paging means the list no longer carries the
    whole picture, and a badge shouldn't need to fetch rows to draw a number."""
    stmt = select(Notification).where(Notification.for_role == user.role, Notification.read.is_(False))
    return {"unread": await count_rows(db, stmt)}


@router.post("/{notification_id}/read", response_model=NotificationOut)
async def mark_read(
    notification_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> Notification:
    notification = await db.get(Notification, notification_id)
    if not notification or notification.for_role != user.role:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found")
    notification.read = True
    await db.commit()
    await db.refresh(notification)
    return notification


@router.post("/mark-all-read")
async def mark_all_read(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> dict:
    await db.execute(
        update(Notification).where(Notification.for_role == user.role, Notification.read.is_(False)).values(read=True)
    )
    await db.commit()
    return {"detail": "All notifications marked as read"}
