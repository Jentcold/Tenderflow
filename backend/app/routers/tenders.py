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
from app.core.scope import manages_tender
from app.core.time import is_past_deadline, server_now
from app.database import get_db
from app.models.notification import Notification, NotificationType
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.tender_item import TenderItem
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

# Internal-only. Vendors are authenticated users too, so gating on
# get_current_user alone would have let them read this router. The gate is
# `require_internal` rather than `require_staff` because employees raise
# requests here — but it only gets them through the door, and every endpoint
# below re-checks. The two that used to lean on the router gate alone
# (`list_tenders`, `get_tender`) now carry `require_staff` themselves.
router = APIRouter(prefix="/tenders", tags=["tenders"], dependencies=[Depends(require_internal)])

CAN_MANAGE = require_roles("admin", "procurement")
# Anyone on the payroll can raise a request — a manager needs a laptop as much
# as anyone else, and routing every request through an employee proxy account
# was making people file under someone else's name. Everyone follows the same
# cycle for now: raised -> department manager -> purchasing. Letting a role skip
# a step is a later decision, and it belongs in the approval code rather than
# here, where it would silently become "who can create" too.
CAN_CREATE = require_roles(*INTERNAL_ROLES)


async def _items_of(db: AsyncSession, tender_id: uuid.UUID) -> list[TenderItem]:
    """A tender's requirement rows, in the order they were entered."""
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
    """Items for a whole page in one round trip, rather than one query per row."""
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
    """Write the requirement table, numbering the rows from the list order.

    Caller is responsible for having deleted the old rows first — an edit is a
    full replacement, since matching rows up by name would silently merge two
    lines that happen to be called the same thing.
    """
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
    """Bid counts for a whole page in one round trip, rather than per row."""
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
    # No `submission_link` here any more. It used to be one anonymous URL per
    # tender that any vendor could bid through; invites replaced it, and every
    # link is now addressed to one company and carries its own token. Handing
    # back a shared link would have been handing back one that no longer works.
    return item


@router.post("", response_model=TenderOut, status_code=status.HTTP_201_CREATED)
async def create_tender(
    payload: TenderCreate, user: User = Depends(CAN_CREATE), db: AsyncSession = Depends(get_db)
) -> TenderListItem:
    if user.department_id is None:
        # Without a department there is no manager to send this to. Better to
        # say so now than to create a request that silently sits in nobody's
        # queue.
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Your account isn't attached to a department, so there's no manager "
            "to approve this. Ask an administrator to set your department.",
        )

    tender = Tender(
        serial=generate_serial(),
        name=payload.name,
        # The requester fills in the table, not a blurb. `description` stays
        # empty unless purchasing or a template puts something in it.
        description=None,
        # Set by the manager when they approve; see ManagerApproval.
        deadline_date=None,
        deadline_time=None,
        # Purchasing's to set, once they pick the request up.
        currency=settings.DEFAULT_CURRENCY,
        category_ref=await category_by_slug(db, payload.category),
        # Taken from the account, never from the form — see TenderCreate.
        department_id=user.department_id,
        required_docs=[],
        created_by=user.id,
    )
    db.add(tender)
    # The UUID default is applied by SQLAlchemy at INSERT, not on construction,
    # so tender.id is still None here — flushing assigns it before anything
    # takes a foreign key on it.
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
    """Tell whoever raised this tender how the manager decided.

    Addressed to the person, not the role: anyone on the payroll can raise a
    request now, and the decision on it is theirs to hear about wherever they
    sit in the org chart.

    Procurement is the one exception. They already hear about every tender
    through the role-addressed copy sent alongside this, so a purchasing-raised
    tender would otherwise notify them twice.
    """
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


# ------------------------------------------- manager approval of the tender --

@router.post("/{tender_id}/manager-approve", response_model=TenderOut)
async def manager_approve_tender(
    tender_id: uuid.UUID,
    payload: ManagerApproval,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> Tender:
    """Opens the tender to vendors, on a deadline the manager sets here.

    Approving and dating the tender are one action rather than two. The
    requester says what they need; the manager says by when and whether it is
    urgent, and those two answers are what turn a request into something
    vendors can bid on.
    """
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if tender.status != TenderStatus.pending_approval:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Only a tender awaiting approval can be approved (this one is {tender.status.value})",
        )
    if is_past_deadline(payload.deadline_date, payload.deadline_time):
        # Opening a tender that has already closed leaves vendors an invitation
        # they cannot answer.
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
    """Flags a tender as urgent, or clears the flag.

    The manager's call alone — procurement can't mark their own work urgent to
    skip the approvals above them. Allowed at any stage, because a purchase can
    turn urgent after it was raised, and clearing it is the same right in
    reverse. Logged either way: a skipped approval has to be traceable to
    whoever made it skippable.
    """
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
    tender.manager_declined = payload.final
    tender.manager_feedback = payload.reason
    tender.manager_reviewed_at = server_now()
    tender.manager_reviewed_by = user.id
    tender.status = TenderStatus.rejected

    # The wording matters more than usual here: one of these is an instruction
    # to fix something, the other is an answer. A requester who reads "needs
    # changes" on a declined request will keep editing and resubmitting into a
    # 400.
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


# Statuses in which a request still belongs to the person who raised it. Once a
# manager opens it, vendors start bidding against what it says — editing then
# would move the goalposts under offers already in flight.
EMPLOYEE_EDITABLE = (TenderStatus.pending_approval, TenderStatus.rejected)


async def _load_for_edit(tender_id: uuid.UUID, user: User, db: AsyncSession) -> Tender:
    """Fetch a tender the caller is allowed to change, or raise.

    Three answers, and the middle one changed:

    * **Admin** may edit anything at any stage. The escape hatch.
    * **The department manager** may edit their own department's request while
      it is still theirs to decide - `pending_approval` or sent back. They read
      it, and a wrong quantity or a missing line used to mean bouncing it to the
      requester and waiting for it to come back, for a change the manager could
      have typed in the time it took to write the rejection note. They already
      hold the decision; withholding the pen was ceremony.
    * **Purchasing may not edit it at all.** They used to be able to edit
      anything at any stage, which was wrong in both directions: the request is
      the requesting department's statement of what they need, and rewriting it
      on their behalf - after their manager approved *that wording* - is not
      purchasing's call. What is theirs is on `/purchasing-details`: the
      currency and the documents vendors must send.

    The manager's window closes when vendors can see it. Once a tender is open,
    editing the requirement list moves the goalposts under offers already in
    flight - the same reason the requester's window closes there.

    An employee gets a 404 rather than a 403 for someone else's request: they
    have no company-wide list, so confirming a tender exists would tell them
    something they can't otherwise learn.
    """
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
    """Who may put a sent-back request back in front of the manager.

    Separate from `_load_for_edit` because pressing resubmit is not rewriting
    the request - it is saying "look at this again". Purchasing chasing a
    stalled request on somebody's behalf is a normal thing to do and does not
    change a word of what it says, so they keep it even though they lost the
    edit.
    """
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
    """Puts a rejected tender back in front of the manager after edits.

    The employee who raised it can do this for their own request; procurement
    can do it for anyone's.
    """
    tender = await _load_for_resubmit(tender_id, user, db)
    if tender.status != TenderStatus.rejected:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Only a rejected tender can be resubmitted (this one is {tender.status.value})",
        )
    if tender.manager_declined:
        # Declined is an answer, not a note to revise. Letting this through
        # would put the same request back in the manager's queue as often as
        # the requester cared to press the button.
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

    # Only what the requester owns. The deadline, the currency and the required
    # documents are set elsewhere by the people whose call they are, so an edit
    # here can't reach them — including an edit made by procurement.
    tender.name = payload.name
    tender.category_ref = await category_by_slug(db, payload.category)

    # Full replacement of the requirement table. Matching old rows to new ones
    # by name would merge two lines that happen to share a name and would keep
    # a row the requester meant to delete.
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
    """Sets the commercial terms: what it's priced in, and what vendors must send.

    Separate from the requester's edit path on purpose. These are purchasing's
    to decide, and asking the person who needs a laptop which currency to quote
    in or which certificates to demand was asking them a question they had no
    way to answer.

    Allowed after the tender opens, because required documents are a common
    thing to have forgotten. Both fields are optional and only what is sent is
    written, so setting the currency doesn't wipe the document list.
    """
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
        # Not copied. The duplicate goes back to the manager for approval, and
        # they set the deadline then — carrying the original's over would put a
        # date on it that was chosen for a different tender, possibly one that
        # has already passed.
        deadline_date=None,
        deadline_time=None,
        currency=original.currency,
        category_ref=original.category_ref,
        department_id=original.department_id,
        required_docs=list(original.required_docs),
        created_by=user.id,
    )
    db.add(copy)
    await db.flush()  # assigns copy.id, which the items below hang off
    # The items come along, or the copy is a tender with no requirement in it.
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
    """Deletes every bid on this tender and sends it back for approval.

    The offers go with the submissions — they are cascaded from them — so the
    award pointers have to be cleared too, or the tender would keep naming an
    offer that no longer exists.
    """
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    # Cleared and flushed BEFORE the delete, not after. `awarded_offer_id` and
    # `awarded_vendor_submission_id` are foreign keys into the rows about to go,
    # so leaving them set until commit makes Postgres refuse the delete.
    tender.awarded_offer_id = None
    tender.awarded_vendor_submission_id = None
    tender.awarded_vendor_name = None
    tender.awarded_email = None
    tender.awarded_amount = None
    await db.flush()

    await db.execute(Submission.__table__.delete().where(Submission.tender_id == tender_id))
    # Clearing manager_approved sends it back to the start of the workflow, so
    # the status has to follow it rather than jumping straight to open.
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
