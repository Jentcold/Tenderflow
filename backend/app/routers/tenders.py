import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.audit import log_audit
from app.core.deps import (
    INTERNAL_ROLES,
    get_current_user,
    require_internal,
    require_roles,
    require_staff,
)
from app.core.categories import category_by_slug
from app.core.pagination import Page, Pagination, count_rows
from app.core.scope import manages_tender, require_purchasing
from app.core.time import is_past_deadline, server_now
from app.database import get_db
from app.models.notification import Notification, NotificationType
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.tender_item import TenderItem
from app.models.tender_template import TenderTemplate
from app.models.user import User, UserRole
from app.schemas.tender import (
    ExtendDeadlineRequest,
    ManagerApproval,
    LineItemIn,
    LineItemOut,
    MyRequestOut,
    PurchasingDetails,
    RejectionReason,
    TenderCreate,
    TenderListItem,
    TenderOut,
    TenderUpdate,
    UrgentUpdate,
)
from app.services.tender_service import generate_serial

router = APIRouter(prefix="/tenders", tags=["tenders"], dependencies=[Depends(require_internal)])

CAN_MANAGE = require_purchasing("admin", "procurement")
CAN_CREATE = require_roles(*INTERNAL_ROLES)


async def _items_of(db: AsyncSession, tender_id: uuid.UUID) -> list[TenderItem]:
    return list(
        (
            await db.execute(
                select(TenderItem)
                .where(TenderItem.tender_id == tender_id)
                .order_by(TenderItem.position)
            )
        ).scalars().all()
    )


async def _items_for(db: AsyncSession, tender_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[TenderItem]]:
    if not tender_ids:
        return {}
    rows = (
        await db.execute(
            select(TenderItem)
            .where(TenderItem.tender_id.in_(tender_ids))
            .order_by(TenderItem.position)
        )
    ).scalars().all()
    grouped: dict[uuid.UUID, list[TenderItem]] = {}
    for row in rows:
        grouped.setdefault(row.tender_id, []).append(row)
    return grouped


def _replace_items(db: AsyncSession, tender: Tender, items: list[LineItemIn]) -> None:
    for position, item in enumerate(items):
        db.add(
            TenderItem(
                tender_id=tender.id,
                position=position,
                name=item.name,
                specs=item.specs,
                notes=item.notes,
                quantity=item.quantity,
                unit=item.unit,
            )
        )


async def _submission_count(db: AsyncSession, tender_id: uuid.UUID) -> int:
    return await db.scalar(select(func.count()).select_from(Submission).where(Submission.tender_id == tender_id)) or 0


async def _submission_counts(db: AsyncSession, tender_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not tender_ids:
        return {}
    rows = await db.execute(
        select(Submission.tender_id, func.count())
        .where(Submission.tender_id.in_(tender_ids))
        .group_by(Submission.tender_id)
    )
    return dict(rows.all())


def _list_item(
    tender: Tender, submission_count: int, items: list[TenderItem] | None = None
) -> TenderListItem:
    base = TenderOut.model_validate(tender).model_dump(exclude={"items"})
    return TenderListItem(
        **base,
        items=[LineItemOut.model_validate(i) for i in (items or [])],
        submission_count=submission_count,
        is_expired=is_past_deadline(tender.deadline_date, tender.deadline_time),
    )


@router.get("", response_model=Page[TenderListItem], dependencies=[Depends(require_staff)])
async def list_tenders(
    status_filter: TenderStatus | None = Query(default=None, alias="status"),
    page: Pagination = Depends(),
    db: AsyncSession = Depends(get_db),
) -> Page[TenderListItem]:
    stmt = select(Tender).order_by(Tender.created_at.desc())
    if status_filter:
        stmt = stmt.where(Tender.status == status_filter)

    total = await count_rows(db, stmt)
    tenders = (await db.execute(stmt.limit(page.limit).offset(page.offset))).scalars().all()
    counts = await _submission_counts(db, [t.id for t in tenders])
    items = await _items_for(db, [t.id for t in tenders])

    return Page[TenderListItem](
        items=[_list_item(t, counts.get(t.id, 0), items.get(t.id, [])) for t in tenders],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/my-requests", response_model=Page[MyRequestOut])
async def list_my_requests(
    status_filter: TenderStatus | None = Query(default=None, alias="status"),
    page: Pagination = Depends(),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Page[MyRequestOut]:
    stmt = select(Tender).where(Tender.created_by == user.id).order_by(Tender.created_at.desc())
    if status_filter:
        stmt = stmt.where(Tender.status == status_filter)

    total = await count_rows(db, stmt)
    tenders = (await db.execute(stmt.limit(page.limit).offset(page.offset))).scalars().all()
    items = await _items_for(db, [t.id for t in tenders])

    return Page[MyRequestOut](
        items=[
            MyRequestOut(
                **MyRequestOut.model_validate(t).model_dump(exclude={"is_expired", "items"}),
                items=[LineItemOut.model_validate(i) for i in items.get(t.id, [])],
                is_expired=is_past_deadline(t.deadline_date, t.deadline_time),
            )
            for t in tenders
        ],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/{tender_id}", dependencies=[Depends(require_staff)])
async def get_tender(tender_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    item = _list_item(
        tender, await _submission_count(db, tender.id), await _items_of(db, tender.id)
    ).model_dump()
    return item


@router.post("", response_model=TenderOut, status_code=status.HTTP_201_CREATED)
async def create_tender(
    payload: TenderCreate, user: User = Depends(CAN_CREATE), db: AsyncSession = Depends(get_db)
) -> TenderListItem:
    if user.department_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Your account isn't attached to a department, so there's no manager "
            "to approve this. Ask an administrator to set your department.",
        )

    template: TenderTemplate | None = None
    if payload.template_id is not None:
        template = await db.get(TenderTemplate, payload.template_id)
        if template is None or not template.active:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "That template no longer exists. Raise the request without it.",
            )

    tender = Tender(
        serial=generate_serial(),
        name=payload.name,
        description=template.description if template else None,
        deadline_date=None,
        deadline_time=None,
        currency=(template.currency if template else settings.DEFAULT_CURRENCY),
        category_ref=await category_by_slug(db, payload.category),
        department_id=user.department_id,
        required_docs=list(template.required_docs) if template else [],
        created_by=user.id,
    )
    db.add(tender)
    await db.flush()
    _replace_items(db, tender, payload.items)
    db.add(
        Notification(
            type=NotificationType.tender_pending_approval,
            tender_id=tender.id,
            message=f"{tender.serial} - {tender.name} is awaiting your approval",
            for_role=UserRole.manager,
        )
    )
    await log_audit(db, "Tender Created", f"{tender.serial} - {tender.name} (awaiting manager approval)", user.name)
    await db.commit()
    await db.refresh(tender)
    return _list_item(tender, 0, await _items_of(db, tender.id))


async def _notify_requester(
    db: AsyncSession, tender: Tender, notification_type: NotificationType, message: str
) -> None:
    if not tender.created_by:
        return
    creator = await db.get(User, tender.created_by)
    if not creator or creator.role == UserRole.procurement:
        return
    db.add(
        Notification(
            type=notification_type,
            tender_id=tender.id,
            message=message,
            user_id=creator.id,
        )
    )


@router.post("/{tender_id}/manager-approve", response_model=TenderOut)
async def manager_approve_tender(
    tender_id: uuid.UUID,
    payload: ManagerApproval,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if tender.status != TenderStatus.pending_approval:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Only a tender awaiting approval can be approved (this one is {tender.status.value})",
        )
    if is_past_deadline(payload.deadline_date, payload.deadline_time):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "That deadline has already passed. Pick a date and time in the future.",
        )

    tender.deadline_date = payload.deadline_date
    tender.deadline_time = payload.deadline_time
    tender.urgent = payload.urgent
    tender.manager_approved = True
    tender.manager_rejected = False
    tender.manager_declined = False
    tender.manager_feedback = None
    tender.manager_reviewed_at = server_now()
    tender.manager_reviewed_by = user.id
    tender.status = TenderStatus.open

    db.add(
        Notification(
            type=NotificationType.manager_approved,
            tender_id=tender.id,
            message=f"{tender.serial} approved and now open for vendor submissions",
            for_role=UserRole.procurement,
        )
    )
    await _notify_requester(
        db,
        tender,
        NotificationType.manager_approved,
        f"Your request {tender.serial} was approved and is now open to vendors",
    )
    await log_audit(db, "Tender Approved", f"{tender.serial} opened for submissions", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


@router.patch("/{tender_id}/urgent", response_model=TenderOut)
async def set_tender_urgent(
    tender_id: uuid.UUID,
    payload: UrgentUpdate,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    tender.urgent = payload.urgent
    await log_audit(
        db,
        "Tender Marked Urgent" if payload.urgent else "Tender Urgency Cleared",
        f"{tender.serial} - {tender.name}",
        user.name,
    )
    await db.commit()
    await db.refresh(tender)
    return tender


@router.post("/{tender_id}/manager-reject", response_model=TenderOut)
async def manager_reject_tender(
    tender_id: uuid.UUID,
    payload: RejectionReason,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if not payload.reason.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please provide a reason")
    if tender.status != TenderStatus.pending_approval:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Only a tender awaiting approval can be rejected (this one is {tender.status.value})",
        )

    tender.manager_approved = False
    tender.manager_rejected = True
    tender.manager_declined = payload.final
    tender.manager_feedback = payload.reason
    tender.manager_reviewed_at = server_now()
    tender.manager_reviewed_by = user.id
    tender.status = TenderStatus.rejected

    if payload.final:
        staff_msg = f"{tender.serial} was declined: {payload.reason}"
        requester_msg = f"Your request {tender.serial} was declined: {payload.reason}"
        audit = "Tender Declined"
    else:
        staff_msg = f"{tender.serial} was sent back for changes: {payload.reason}"
        requester_msg = f"Your request {tender.serial} needs changes: {payload.reason}"
        audit = "Tender Sent Back"

    db.add(
        Notification(
            type=NotificationType.changes_requested,
            tender_id=tender.id,
            message=staff_msg,
            for_role=UserRole.procurement,
        )
    )
    await _notify_requester(
        db, tender, NotificationType.changes_requested, requester_msg
    )
    await log_audit(db, audit, f"{tender.serial} - {payload.reason}", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


EMPLOYEE_EDITABLE = (TenderStatus.pending_approval, TenderStatus.rejected)


async def _load_for_edit(tender_id: uuid.UUID, user: User, db: AsyncSession) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if user.role is UserRole.admin:
        return tender
    if user.role is UserRole.procurement:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "A request says what the requesting department needs, so it isn't purchasing's "
            "to reword. The currency and the required documents are yours - set those on "
            "the tender's terms instead.",
        )
    if user.role is UserRole.manager and await manages_tender(db, tender, user):
        if tender.status not in EMPLOYEE_EDITABLE:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"This tender is {tender.status.value} - vendors are working against what it "
                "says, so changing it now would move the goalposts under offers already in.",
            )
        return tender
    if tender.created_by != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if tender.status not in EMPLOYEE_EDITABLE:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"This request is {tender.status.value} and can no longer be changed. "
            "Contact procurement if it needs amending.",
        )
    return tender


async def _load_for_resubmit(tender_id: uuid.UUID, user: User, db: AsyncSession) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if user.role.value in ("admin", "procurement"):
        return tender
    if user.role is UserRole.manager and await manages_tender(db, tender, user):
        return tender
    if tender.created_by != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    return tender


@router.post("/{tender_id}/resubmit", response_model=TenderOut)
async def resubmit_tender(
    tender_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> Tender:
    tender = await _load_for_resubmit(tender_id, user, db)
    if tender.status != TenderStatus.rejected:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Only a rejected tender can be resubmitted (this one is {tender.status.value})",
        )
    if tender.manager_declined:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This request was declined, not sent back for changes. Raise a new "
            "request if the need still stands.",
        )

    tender.status = TenderStatus.pending_approval
    tender.manager_rejected = False

    db.add(
        Notification(
            type=NotificationType.tender_pending_approval,
            tender_id=tender.id,
            message=f"{tender.serial} was revised and is awaiting your approval again",
            for_role=UserRole.manager,
        )
    )
    await log_audit(db, "Tender Resubmitted", f"{tender.serial} sent back for manager approval", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


@router.put("/{tender_id}", response_model=TenderOut)
async def update_tender(
    tender_id: uuid.UUID,
    payload: TenderUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TenderListItem:
    tender = await _load_for_edit(tender_id, user, db)

    tender.name = payload.name
    tender.category_ref = await category_by_slug(db, payload.category)

    await db.execute(TenderItem.__table__.delete().where(TenderItem.tender_id == tender.id))
    _replace_items(db, tender, payload.items)

    await log_audit(db, "Tender Updated", f"{tender.serial} - {tender.name}", user.name)
    await db.commit()
    await db.refresh(tender)
    return _list_item(tender, await _submission_count(db, tender.id), await _items_of(db, tender.id))


@router.patch("/{tender_id}/purchasing-details", response_model=TenderOut)
async def set_purchasing_details(
    tender_id: uuid.UUID,
    payload: PurchasingDetails,
    user: User = Depends(CAN_MANAGE),
    db: AsyncSession = Depends(get_db),
) -> TenderListItem:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    changed = []
    if payload.currency is not None and payload.currency != tender.currency:
        changed.append(f"currency {tender.currency} -> {payload.currency}")
        tender.currency = payload.currency
    if payload.required_docs is not None:
        docs = [d.strip() for d in payload.required_docs if d.strip()]
        if docs != list(tender.required_docs):
            changed.append(f"documents: {', '.join(docs) if docs else 'none'}")
            tender.required_docs = docs

    if changed:
        await log_audit(
            db, "Tender Terms Set", f"{tender.serial} - {'; '.join(changed)}", user.name
        )
    await db.commit()
    await db.refresh(tender)
    return _list_item(
        tender, await _submission_count(db, tender.id), await _items_of(db, tender.id)
    )


@router.post("/{tender_id}/close", response_model=TenderOut)
async def close_tender(
    tender_id: uuid.UUID, user: User = Depends(CAN_MANAGE), db: AsyncSession = Depends(get_db)
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    tender.status = TenderStatus.closed
    await log_audit(db, "Tender Closed", f"{tender.serial} - {tender.name}", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


@router.post("/{tender_id}/reopen", response_model=TenderOut)
async def reopen_tender(
    tender_id: uuid.UUID, user: User = Depends(CAN_MANAGE), db: AsyncSession = Depends(get_db)
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if not tender.manager_approved:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "This tender has not been approved by a manager, so it can't be opened"
        )
    tender.status = TenderStatus.open
    await log_audit(db, "Tender Re-opened", f"{tender.serial} - {tender.name}", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


@router.post("/{tender_id}/duplicate", response_model=TenderOut, status_code=status.HTTP_201_CREATED)
async def duplicate_tender(
    tender_id: uuid.UUID, user: User = Depends(CAN_MANAGE), db: AsyncSession = Depends(get_db)
) -> Tender:
    original = await db.get(Tender, tender_id)
    if not original:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    copy = Tender(
        serial=generate_serial(),
        name=f"{original.name} (Copy)",
        description=original.description,
        deadline_date=None,
        deadline_time=None,
        currency=original.currency,
        category_ref=original.category_ref,
        department_id=original.department_id,
        required_docs=list(original.required_docs),
        created_by=user.id,
    )
    db.add(copy)
    await db.flush()
    for item in await _items_of(db, original.id):
        db.add(
            TenderItem(
                tender_id=copy.id,
                position=item.position,
                name=item.name,
                specs=item.specs,
                notes=item.notes,
                quantity=item.quantity,
                unit=item.unit,
            )
        )
    await log_audit(db, "Tender Duplicated", f"{copy.serial} from {original.serial}", user.name)
    await db.commit()
    await db.refresh(copy)
    return _list_item(copy, 0, await _items_of(db, copy.id))


@router.post("/{tender_id}/extend-deadline", response_model=TenderOut)
async def extend_deadline(
    tender_id: uuid.UUID,
    payload: ExtendDeadlineRequest,
    user: User = Depends(CAN_MANAGE),
    db: AsyncSession = Depends(get_db),
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    old = f"{tender.deadline_date} {tender.deadline_time}"
    tender.deadline_date = payload.deadline_date
    tender.deadline_time = payload.deadline_time
    if tender.manager_approved and tender.status == TenderStatus.closed:
        tender.status = TenderStatus.open

    await log_audit(
        db,
        "Deadline Extended",
        f"{tender.serial}: {old} -> {payload.deadline_date} {payload.deadline_time}",
        user.name,
    )
    await db.commit()
    await db.refresh(tender)
    return tender


@router.post("/{tender_id}/reset-cycle", response_model=TenderOut)
async def reset_tender_cycle(
    tender_id: uuid.UUID, user: User = Depends(CAN_MANAGE), db: AsyncSession = Depends(get_db)
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    tender.awarded_offer_id = None
    tender.awarded_vendor_submission_id = None
    tender.awarded_vendor_name = None
    tender.awarded_email = None
    tender.awarded_amount = None
    await db.flush()

    await db.execute(Submission.__table__.delete().where(Submission.tender_id == tender_id))
    tender.status = TenderStatus.pending_approval
    tender.manager_approved = False
    tender.manager_rejected = False
    tender.supply_chain_approved = False
    tender.supply_chain_rejected = False

    db.add(
        Notification(
            type=NotificationType.tender_pending_approval,
            tender_id=tender.id,
            message=f"{tender.serial} was reset and needs approval again",
            for_role=UserRole.manager,
        )
    )
    await log_audit(db, "Tender Cycle Reset", f"{tender.serial} - All submissions cleared", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender
