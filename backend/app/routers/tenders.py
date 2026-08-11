import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.audit import log_audit
from app.core.deps import get_current_user, require_internal, require_roles, require_staff
from app.core.pagination import Page, Pagination, count_rows
from app.core.time import is_past_deadline, server_now
from app.database import get_db
from app.models.notification import Notification, NotificationType
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.user import User, UserRole
from app.schemas.evaluation import RejectionReason
from app.schemas.tender import (
    ExtendDeadlineRequest,
    MyRequestOut,
    TenderCreate,
    TenderListItem,
    TenderOut,
    TenderUpdate,
)
from app.services.tender_service import generate_serial

# Internal-only. Vendors are authenticated users too, so gating on
# get_current_user alone would have let them read this router. The gate is
# `require_internal` rather than `require_staff` because employees raise
# requests here — but it only gets them through the door, and every endpoint
# below re-checks. The two that used to lean on the router gate alone
# (`list_tenders`, `get_tender`) now carry `require_staff` themselves.
router = APIRouter(prefix="/tenders", tags=["tenders"], dependencies=[Depends(require_internal)])

CAN_MANAGE = require_roles("admin", "procurement")
CAN_CREATE = require_roles("admin", "procurement", "employee")


async def _submission_count(db: AsyncSession, tender_id: uuid.UUID) -> int:
    return await db.scalar(select(func.count()).select_from(Submission).where(Submission.tender_id == tender_id)) or 0


async def _submission_counts(db: AsyncSession, tender_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Bid counts for a whole page in one round trip, rather than per row."""
    if not tender_ids:
        return {}
    rows = await db.execute(
        select(Submission.tender_id, func.count())
        .where(Submission.tender_id.in_(tender_ids))
        .group_by(Submission.tender_id)
    )
    return dict(rows.all())


def _list_item(tender: Tender, submission_count: int) -> TenderListItem:
    return TenderListItem(
        **TenderOut.model_validate(tender).model_dump(),
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

    return Page[TenderListItem](
        items=[_list_item(t, counts.get(t.id, 0)) for t in tenders],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


# Declared above /{tender_id} — registered the other way round, "my-requests"
# would be parsed as a tender id and 422 on the UUID.
@router.get("/my-requests", response_model=Page[MyRequestOut])
async def list_my_requests(
    status_filter: TenderStatus | None = Query(default=None, alias="status"),
    page: Pagination = Depends(),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Page[MyRequestOut]:
    """Tenders this caller raised, in the narrow requester's view.

    Open to every internal role, since "things I filed" means the same for all
    of them, but it is the employee's only window onto tenders — they have no
    access to the company-wide list above. It carries the full request body,
    not a summary, so the edit form can be populated without a detail fetch
    they aren't allowed to make.
    """
    stmt = select(Tender).where(Tender.created_by == user.id).order_by(Tender.created_at.desc())
    if status_filter:
        stmt = stmt.where(Tender.status == status_filter)

    total = await count_rows(db, stmt)
    tenders = (await db.execute(stmt.limit(page.limit).offset(page.offset))).scalars().all()

    return Page[MyRequestOut](
        items=[
            MyRequestOut(
                **MyRequestOut.model_validate(t).model_dump(exclude={"is_expired"}),
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
    item = _list_item(tender, await _submission_count(db, tender.id)).model_dump()
    item["submission_link"] = f"{settings.FRONTEND_BASE_URL}/vendor?tender={tender.id}"
    return item


@router.post("", response_model=TenderOut, status_code=status.HTTP_201_CREATED)
async def create_tender(
    payload: TenderCreate, user: User = Depends(CAN_CREATE), db: AsyncSession = Depends(get_db)
) -> Tender:
    tender = Tender(
        serial=generate_serial(),
        name=payload.name,
        description=payload.description,
        deadline_date=payload.deadline_date,
        deadline_time=payload.deadline_time,
        currency=payload.currency,
        category=payload.category,
        department_id=payload.department_id,
        required_docs=payload.required_docs,
        scoring_criteria=[c.model_dump() for c in payload.scoring_criteria],
        created_by=user.id,
    )
    db.add(tender)
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
    return tender


async def _notify_requester(
    db: AsyncSession, tender: Tender, notification_type: NotificationType, message: str
) -> None:
    """Tell the employee who raised this tender how the manager decided.

    Addressed to the person, not the role — an employee holds no role mail of
    their own, and the decision on their request is nobody else's business.
    Only employees get one: procurement already hears about every tender
    through the role-addressed copy alongside this, so a procurement-raised
    tender would otherwise notify them twice.
    """
    if not tender.created_by:
        return
    creator = await db.get(User, tender.created_by)
    if not creator or creator.role != UserRole.employee:
        return
    db.add(
        Notification(
            type=notification_type,
            tender_id=tender.id,
            message=message,
            user_id=creator.id,
        )
    )


# ------------------------------------------- manager approval of the tender --

@router.post("/{tender_id}/manager-approve", response_model=TenderOut)
async def manager_approve_tender(
    tender_id: uuid.UUID,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> Tender:
    """Opens the tender to vendors. This is the manager's only say in the
    process — they approve the tender itself, not the scores it later gets."""
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if tender.status != TenderStatus.pending_approval:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Only a tender awaiting approval can be approved (this one is {tender.status.value})",
        )

    tender.manager_approved = True
    tender.manager_rejected = False
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


@router.post("/{tender_id}/manager-reject", response_model=TenderOut)
async def manager_reject_tender(
    tender_id: uuid.UUID,
    payload: RejectionReason,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> Tender:
    """Sends a tender back instead of opening it. Procurement can edit and
    resubmit it with `/resubmit`."""
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
    tender.manager_feedback = payload.reason
    tender.manager_reviewed_at = server_now()
    tender.manager_reviewed_by = user.id
    tender.status = TenderStatus.rejected

    db.add(
        Notification(
            type=NotificationType.changes_requested,
            tender_id=tender.id,
            message=f"{tender.serial} was not approved: {payload.reason}",
            for_role=UserRole.procurement,
        )
    )
    await _notify_requester(
        db,
        tender,
        NotificationType.changes_requested,
        f"Your request {tender.serial} needs changes: {payload.reason}",
    )
    await log_audit(db, "Tender Rejected", f"{tender.serial} - {payload.reason}", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


# Statuses in which a request still belongs to the person who raised it. Once a
# manager opens it, vendors start bidding against what it says — editing then
# would move the goalposts under offers already in flight.
EMPLOYEE_EDITABLE = (TenderStatus.pending_approval, TenderStatus.rejected)


async def _load_for_edit(tender_id: uuid.UUID, user: User, db: AsyncSession) -> Tender:
    """Fetch a tender the caller is allowed to change, or raise.

    Admin and procurement may edit any tender at any stage. An employee gets a
    404 rather than a 403 for someone else's request: they have no company-wide
    list, so confirming a tender exists would tell them something they can't
    otherwise learn.
    """
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if user.role.value in ("admin", "procurement"):
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


@router.post("/{tender_id}/resubmit", response_model=TenderOut)
async def resubmit_tender(
    tender_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> Tender:
    """Puts a rejected tender back in front of the manager after edits.

    The employee who raised it can do this for their own request; procurement
    can do it for anyone's.
    """
    tender = await _load_for_edit(tender_id, user, db)
    if tender.status != TenderStatus.rejected:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Only a rejected tender can be resubmitted (this one is {tender.status.value})",
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
) -> Tender:
    tender = await _load_for_edit(tender_id, user, db)

    tender.name = payload.name
    tender.description = payload.description
    tender.deadline_date = payload.deadline_date
    tender.deadline_time = payload.deadline_time
    tender.currency = payload.currency
    tender.category = payload.category
    tender.department_id = payload.department_id
    tender.required_docs = payload.required_docs
    tender.scoring_criteria = [c.model_dump() for c in payload.scoring_criteria]

    await log_audit(db, "Tender Updated", f"{tender.serial} - {tender.name}", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


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
        deadline_date=original.deadline_date,
        deadline_time=original.deadline_time,
        currency=original.currency,
        category=original.category,
        department_id=original.department_id,
        required_docs=list(original.required_docs),
        scoring_criteria=[dict(c) for c in original.scoring_criteria],
        created_by=user.id,
    )
    db.add(copy)
    await log_audit(db, "Tender Duplicated", f"{copy.serial} from {original.serial}", user.name)
    await db.commit()
    await db.refresh(copy)
    return copy


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
    # Extending a deadline reopens an approved tender, but must not smuggle an
    # unapproved or rejected one past the manager.
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
    """Deletes all submissions/evaluations for this tender and reopens it."""
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    await db.execute(Submission.__table__.delete().where(Submission.tender_id == tender_id))
    # Clearing manager_approved sends it back to the start of the workflow, so
    # the status has to follow it rather than jumping straight to open.
    tender.status = TenderStatus.pending_approval
    tender.evaluation_submitted = False
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
