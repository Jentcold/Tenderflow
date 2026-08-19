import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import require_roles
from app.core.scope import require_purchasing
from app.core.labels import offer_label as _label
from app.core.time import server_now
from app.database import get_db
from app.models.department import PURCHASING_CODE, Department
from app.models.notification import Notification, NotificationType
from app.models.offer import APPROVAL_ORDER, Offer, OfferItem, OfferStatus
from app.models.submission import Submission, SubmissionStatus
from app.models.tender import Tender, TenderStatus
from app.models.user import User, UserRole
from app.schemas.offer import (
    MAX_SHORTLIST,
    OfferForward,
    OfferItemOut,
    OfferOut,
    OfferRejection,
    OfferSendBack,
    OfferShortlist,
)
from app.services.email_service import dispatch_emails, send_award_emails

router = APIRouter(prefix="/offers", tags=["offers"])

CAN_SEE_OFFERS = require_roles("admin", "procurement", "manager", "supply_chain")


async def _is_purchasing_manager(db: AsyncSession, user: User) -> bool:
    if user.role != UserRole.manager or user.department_id is None:
        return False
    department = await db.get(Department, user.department_id)
    return department is not None and department.code == PURCHASING_CODE


async def _is_department_manager(db: AsyncSession, user: User) -> bool:
    return user.role == UserRole.manager and not await _is_purchasing_manager(db, user)


async def _department_manager_ids(db: AsyncSession, department_id: uuid.UUID | None) -> list[uuid.UUID]:
    if department_id is None:
        return []
    ids = set(
        (
            await db.execute(
                select(User.id).where(
                    User.role == UserRole.manager, User.department_id == department_id
                )
            )
        ).scalars().all()
    )
    department = await db.get(Department, department_id)
    if department is not None and department.manager is not None:
        ids.add(department.manager)
    return list(ids)


async def _managed_department_ids(db: AsyncSession, user: User) -> set[uuid.UUID]:
    managed: set[uuid.UUID] = set()
    if user.role == UserRole.manager and user.department_id is not None:
        managed.add(user.department_id)
    managed.update(
        (await db.execute(select(Department.id).where(Department.manager == user.id))).scalars().all()
    )
    return managed


async def _check_department(db: AsyncSession, tender: Tender, user: User) -> None:
    if user.role in (UserRole.admin, UserRole.procurement, UserRole.supply_chain):
        return
    if await _is_purchasing_manager(db, user):
        return

    managed = await _managed_department_ids(db, user)
    if not managed:
        return
    if tender.department_id not in managed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "This tender was raised by another department"
        )


async def _load_offer_items(db: AsyncSession, offer_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[OfferItem]]:
    if not offer_ids:
        return {}
    rows = (
        await db.execute(
            select(OfferItem)
            .where(OfferItem.offer_id.in_(offer_ids))
            .order_by(OfferItem.position, OfferItem.name)
        )
    ).scalars().all()
    grouped: dict[uuid.UUID, list[OfferItem]] = {}
    for row in rows:
        grouped.setdefault(row.offer_id, []).append(row)
    return grouped


def _may_see_vendor(user: User) -> bool:
    return user.role in (UserRole.admin, UserRole.procurement)


async def _submission_info(
    db: AsyncSession, offers: list[Offer]
) -> dict[uuid.UUID, tuple[SubmissionStatus, str]]:
    ids = {o.submission_id for o in offers}
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(Submission.id, Submission.status, Submission.company_name)
            .where(Submission.id.in_(ids))
        )
    ).all()
    return {row[0]: (row[1], row[2]) for row in rows}


def _to_out(
    offer: Offer,
    label: str,
    items: list[OfferItem],
    info: tuple[SubmissionStatus, str] | None = None,
    show_vendor: bool = False,
) -> OfferOut:
    return OfferOut(
        id=offer.id,
        tender_id=offer.tender_id,
        label=label,
        title=offer.title,
        total_amount=float(offer.total_amount),
        currency=offer.currency,
        specs=offer.notes,
        status=offer.status,
        submitted_at=offer.created_at,
        submission_status=(info[0] if info else None) or SubmissionStatus.pending,
        vendor_company=(info[1] if info and show_vendor else None),
        forwarded_at=offer.forwarded_at,
        manager_rank=offer.manager_rank,
        manager_selected_at=offer.manager_selected_at,
        purchasing_reviewed_at=offer.purchasing_reviewed_at,
        purchasing_manager_reviewed_at=offer.purchasing_manager_reviewed_at,
        supply_chain_reviewed_at=offer.supply_chain_reviewed_at,
        rejected_at_stage=offer.rejected_at_stage,
        rejection_reason=offer.rejection_reason,
        urgent_skipped=offer.urgent_skipped,
        items=[
            OfferItemOut(
                id=i.id,
                tender_item_id=i.tender_item_id,
                is_replacement=i.is_replacement,
                position=i.position,
                name=i.name,
                specs=i.specs,
                notes=i.notes,
                quantity=float(i.quantity),
                unit=i.unit,
                unit_price=float(i.unit_price),
                line_total=i.line_total,
            )
            for i in items
        ],
        covers_items=len({i.tender_item_id for i in items if i.tender_item_id is not None}),
        replacement_items=sum(1 for i in items if i.is_replacement),
    )


@router.get("", response_model=list[OfferOut])
async def list_offers(
    tender_id: uuid.UUID = Query(..., description="Which tender's offers to show"),
    include_rejected: bool = Query(
        default=False, description="Show offers purchasing has already thrown out"
    ),
    user: User = Depends(CAN_SEE_OFFERS),
    db: AsyncSession = Depends(get_db),
) -> list[OfferOut]:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    await _check_department(db, tender, user)

    stmt = select(Offer).where(Offer.tender_id == tender_id)


    if not include_rejected:
        stmt = stmt.where(Offer.status != OfferStatus.rejected)

    stmt = stmt.order_by(Offer.total_amount.asc(), Offer.created_at.asc())

    offers = list((await db.execute(stmt)).scalars().all())
    items_by_offer = await _load_offer_items(db, [o.id for o in offers])
    reveal = _may_see_vendor(user)
    checked = await _submission_info(db, offers)
    return [
        _to_out(o, _label(i), items_by_offer.get(o.id, []), checked.get(o.submission_id), reveal)
        for i, o in enumerate(offers)
    ]


@router.post("/forward", response_model=list[OfferOut])
async def forward_offers(
    payload: OfferForward,
    user: User = Depends(require_purchasing("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> list[OfferOut]:
    tender = await db.get(Tender, payload.tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    all_offers = list(
        (await db.execute(select(Offer).where(Offer.tender_id == tender.id))).scalars().all()
    )
    by_id = {o.id: o for o in all_offers}

    for offer_id in payload.offer_ids:
        candidate = by_id.get(offer_id)
        if candidate is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, f"Offer {offer_id} is not on this tender"
            )
        if candidate.status == OfferStatus.rejected:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "One of those offers was rejected and can't be sent to the manager",
            )

    chosen = set(payload.offer_ids)
    now = server_now()
    added = withdrawn = locked = 0

    for offer in all_offers:
        if offer.status == OfferStatus.rejected:
            continue
        if offer.forwarded_at is not None and offer.status != OfferStatus.forwarded:
            locked += 1
            continue
        if offer.id in chosen:
            if offer.forwarded_at is None:
                offer.forwarded_at = now
                offer.forwarded_by = user.id
                offer.status = OfferStatus.forwarded
                added += 1
        elif offer.status == OfferStatus.forwarded:
            offer.forwarded_at = None
            offer.forwarded_by = None
            offer.status = OfferStatus.pending
            withdrawn += 1

    if added:
        for manager_id in await _department_manager_ids(db, tender.department_id):
            db.add(
                Notification(
                    type=NotificationType.offer_selected,
                    tender_id=tender.id,
                    message=(
                        f"{tender.serial}: purchasing sent you {added} offer(s) to rank"
                    ),
                    user_id=manager_id,
                )
            )

    await log_audit(
        db,
        "Offers Forwarded" if added or not withdrawn else "Offers Withdrawn",
        f"{tender.serial}: {added} newly sent, {withdrawn} taken back"
        + (f", {locked} already past the manager and left alone" if locked else ""),
        user.name,
    )
    await db.commit()

    forwarded = [
        o for o in all_offers
        if o.forwarded_at is not None and o.status != OfferStatus.rejected
    ]
    forwarded.sort(key=lambda o: (o.total_amount, o.created_at))
    items_by_offer = await _load_offer_items(db, [o.id for o in forwarded])
    reveal = _may_see_vendor(user)
    checked = await _submission_info(db, forwarded)
    return [
        _to_out(o, _label(i), items_by_offer.get(o.id, []), checked.get(o.submission_id), reveal)
        for i, o in enumerate(forwarded)
    ]


@router.post("/shortlist", response_model=list[OfferOut])
async def shortlist_offers(
    payload: OfferShortlist,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> list[OfferOut]:
    tender = await db.get(Tender, payload.tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    await _check_department(db, tender, user)

    all_offers = list(
        (await db.execute(select(Offer).where(Offer.tender_id == tender.id))).scalars().all()
    )
    by_id = {o.id: o for o in all_offers}

    for offer_id in payload.offer_ids:
        candidate = by_id.get(offer_id)
        if candidate is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, f"Offer {offer_id} is not on this tender"
            )
        if candidate.status == OfferStatus.rejected:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "One of those offers was rejected and can no longer be shortlisted",
            )
        if candidate.forwarded_at is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "That offer hasn't been sent to you by purchasing yet",
            )

    committed = next(
        (
            o
            for o in all_offers
            if o.status
            in (
                OfferStatus.purchasing_ok,
                OfferStatus.purchasing_manager_ok,
                OfferStatus.approved,
            )
        ),
        None,
    )
    if committed is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"An offer on this tender is already {committed.status.value} and has to be "
            f"rejected before the shortlist can be changed",
        )

    if any(o.status == OfferStatus.selected for o in all_offers):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "You've already sent your list on this tender. If it needs changing, ask "
            "purchasing to send it back to you.",
        )

    chosen = set(payload.offer_ids)
    for offer in all_offers:
        if offer.status == OfferStatus.selected and offer.id not in chosen:
            offer.status = OfferStatus.forwarded
            offer.manager_rank = None
            offer.manager_selected_at = None
            offer.manager_selected_by = None

    now = server_now()
    for rank, offer_id in enumerate(payload.offer_ids, start=1):
        offer = by_id[offer_id]
        offer.status = OfferStatus.selected
        offer.manager_rank = rank
        offer.manager_selected_at = now
        offer.manager_selected_by = user.id

    if payload.offer_ids:
        db.add(
            Notification(
                type=NotificationType.offer_selected,
                tender_id=tender.id,
                message=(
                    f"{tender.serial}: the manager shortlisted {len(payload.offer_ids)} offer(s) "
                    f"in order of preference, awaiting purchasing review"
                ),
                for_role=UserRole.procurement,
            )
        )
    await log_audit(
        db,
        "Offers Shortlisted" if payload.offer_ids else "Shortlist Withdrawn",
        f"{tender.serial}: "
        + (
            ", ".join(f"#{i} {oid}" for i, oid in enumerate(payload.offer_ids, start=1))
            or "shortlist cleared"
        ),
        user.name,
    )
    await db.commit()

    shortlisted = [by_id[oid] for oid in payload.offer_ids]
    items_by_offer = await _load_offer_items(db, [o.id for o in shortlisted])
    reveal = _may_see_vendor(user)
    checked = await _submission_info(db, shortlisted)
    return [
        _to_out(
            o,
            f"Choice #{o.manager_rank}",
            items_by_offer.get(o.id, []),
            checked.get(o.submission_id),
            reveal,
        )
        for o in shortlisted
    ]


@router.post("/send-back", response_model=list[OfferOut])
async def send_shortlist_back(
    payload: OfferSendBack,
    user: User = Depends(require_purchasing("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> list[OfferOut]:
    tender = await db.get(Tender, payload.tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    all_offers = list(
        (await db.execute(select(Offer).where(Offer.tender_id == tender.id))).scalars().all()
    )

    committed = next(
        (
            o
            for o in all_offers
            if o.status
            in (
                OfferStatus.purchasing_ok,
                OfferStatus.purchasing_manager_ok,
                OfferStatus.approved,
            )
        ),
        None,
    )
    if committed is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"An offer on this tender is already {committed.status.value}. Reject that one "
            f"first, with a reason, before asking the manager for a new list.",
        )

    shortlisted = [o for o in all_offers if o.status == OfferStatus.selected]
    if not shortlisted:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "The manager hasn't sent you a shortlist on this tender",
        )

    for offer in shortlisted:
        offer.status = OfferStatus.forwarded
        offer.manager_rank = None
        offer.manager_selected_at = None
        offer.manager_selected_by = None

    for manager_id in await _department_manager_ids(db, tender.department_id):
        db.add(
            Notification(
                type=NotificationType.changes_requested,
                tender_id=tender.id,
                message=(
                    f"{tender.serial}: purchasing sent your shortlist back - {payload.reason}"
                ),
                user_id=manager_id,
            )
        )

    await log_audit(
        db,
        "Shortlist Sent Back",
        f"{tender.serial}: {len(shortlisted)} shortlisted offer(s) released for re-ranking - "
        f"{payload.reason}",
        user.name,
    )
    await db.commit()

    forwarded = [
        o for o in all_offers
        if o.forwarded_at is not None and o.status != OfferStatus.rejected
    ]
    forwarded.sort(key=lambda o: (o.total_amount, o.created_at))
    items_by_offer = await _load_offer_items(db, [o.id for o in forwarded])
    reveal = _may_see_vendor(user)
    checked = await _submission_info(db, forwarded)
    return [
        _to_out(o, _label(i), items_by_offer.get(o.id, []), checked.get(o.submission_id), reveal)
        for i, o in enumerate(forwarded)
    ]


async def _purchasing_manager_ids(db: AsyncSession) -> list[uuid.UUID]:
    return list(
        (
            await db.execute(
                select(User.id)
                .join(Department, Department.id == User.department_id)
                .where(User.role == UserRole.manager, Department.code == PURCHASING_CODE)
            )
        ).scalars().all()
    )


async def _notify_users(
    db: AsyncSession, user_ids: list[uuid.UUID], tender: Tender, message: str
) -> None:
    for user_id in user_ids:
        db.add(
            Notification(
                type=NotificationType.offer_selected,
                tender_id=tender.id,
                message=message,
                user_id=user_id,
            )
        )


async def _tell_manager_if_off_list(
    db: AsyncSession, tender: Tender, off_shortlist: bool, never_asked: bool = False
) -> None:
    if not off_shortlist and not never_asked:
        return
    message = (
        f"{tender.serial}: purchasing bought an offer without sending you a shortlist"
        if never_asked
        else f"{tender.serial}: purchasing went with an offer you hadn't shortlisted"
    )
    db.add(
        Notification(
            type=NotificationType.offer_selected,
            tender_id=tender.id,
            message=message,
            for_role=UserRole.manager,
        )
    )


async def _load_for_decision(
    offer_id: uuid.UUID, expected: OfferStatus | tuple[OfferStatus, ...], db: AsyncSession
) -> tuple[Offer, Tender]:
    offer = await db.get(Offer, offer_id)
    if not offer:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Offer not found")
    tender = await db.get(Tender, offer.tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    allowed = expected if isinstance(expected, tuple) else (expected,)
    if offer.status not in allowed:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"This offer is {offer.status.value} and is not waiting at this step "
            f"(expected {' or '.join(a.value for a in allowed)})",
        )
    return offer, tender


async def _commit_to_one(db: AsyncSession, offer: Offer, tender: Tender, user: User) -> None:
    siblings = (
        await db.execute(
            select(Offer).where(
                Offer.tender_id == tender.id,
                Offer.id != offer.id,
                Offer.status == OfferStatus.selected,
            )
        )
    ).scalars().all()
    for sibling in siblings:
        sibling.status = OfferStatus.forwarded
        sibling.manager_rank = None
        sibling.manager_selected_at = None
        sibling.manager_selected_by = None
    if siblings:
        await log_audit(
            db,
            "Shortlist Closed",
            f"{tender.serial}: purchasing took choice #{offer.manager_rank or '?'}; "
            f"{len(siblings)} other shortlisted offer(s) released",
            user.name,
        )


async def _award_tender(db: AsyncSession, offer: Offer, tender: Tender, user: User) -> list:
    tender.supply_chain_approved = True
    tender.supply_chain_rejected = False
    tender.supply_chain_reviewed_at = server_now()
    tender.supply_chain_reviewed_by = user.id
    tender.status = TenderStatus.awarded

    tender.awarded_offer_id = offer.id
    tender.awarded_vendor_submission_id = offer.submission_id
    tender.awarded_amount = offer.total_amount
    submission = await db.get(Submission, offer.submission_id)
    if submission:
        tender.awarded_vendor_name = submission.company_name
        tender.awarded_email = submission.email

    submissions = list(
        (
            await db.execute(select(Submission).where(Submission.tender_id == tender.id))
        ).scalars().all()
    )
    return await send_award_emails(db, tender, submissions)


async def _respond(db: AsyncSession, offer: Offer, label: str, user: User) -> OfferOut:
    await db.commit()
    await db.refresh(offer)
    items = (await _load_offer_items(db, [offer.id])).get(offer.id, [])
    checked = await _submission_info(db, [offer])
    return _to_out(
        offer, label, items, checked.get(offer.submission_id), _may_see_vendor(user)
    )


@router.post("/{offer_id}/purchasing-approve", response_model=OfferOut)
async def purchasing_approve(
    offer_id: uuid.UUID,
    background: BackgroundTasks,
    user: User = Depends(require_purchasing("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> OfferOut:
    offer, tender = await _load_for_decision(
        offer_id, (OfferStatus.selected, OfferStatus.forwarded, OfferStatus.pending), db
    )
    never_asked = offer.status is OfferStatus.pending
    off_shortlist = offer.status is OfferStatus.forwarded

    if never_asked:
        offer.forwarded_at = server_now()
        offer.forwarded_by = user.id

    offer.purchasing_reviewed_at = server_now()
    offer.purchasing_reviewed_by = user.id
    await _commit_to_one(db, offer, tender, user)

    purchasing_managers = await _purchasing_manager_ids(db)
    if tender.urgent:
        offer.status = OfferStatus.approved
        offer.urgent_skipped = True
        queued = await _award_tender(db, offer, tender, user)
        await _notify_users(
            db,
            purchasing_managers,
            tender,
            f"{tender.serial} is urgent: purchasing approved an offer without waiting for you",
        )
        db.add(
            Notification(
                type=NotificationType.offer_selected,
                tender_id=tender.id,
                message=f"{tender.serial} is urgent: an offer was approved without waiting for supply chain",
                for_role=UserRole.supply_chain,
            )
        )
        await _tell_manager_if_off_list(db, tender, off_shortlist, never_asked)
        await log_audit(
            db,
            "Offer Approved (Urgent)",
            f"{tender.serial}: purchasing approved offer {offer.id}"
            + (" (the manager was never asked)" if never_asked else "")
            + (" (not on the manager's shortlist)" if off_shortlist else "")
            + ", purchasing-manager and supply-chain approval skipped as urgent",
            user.name,
        )
        response = await _respond(db, offer, "Approved offer", user)
        background.add_task(dispatch_emails, [e.id for e in queued])
        return response

    offer.status = OfferStatus.purchasing_ok
    await _notify_users(
        db,
        purchasing_managers,
        tender,
        f"{tender.serial}: purchasing approved an offer and it needs your decision",
    )
    await _tell_manager_if_off_list(db, tender, off_shortlist, never_asked)
    if not purchasing_managers:
        await log_audit(
            db,
            "Offer Awaiting Purchasing Manager",
            f"{tender.serial}: no user is a manager of the Purchasing department — "
            f"offer {offer.id} has nobody to approve it",
            user.name,
        )
    await log_audit(
        db,
        "Offer Approved by Purchasing",
        f"{tender.serial}: offer {offer.id}"
        + (" - taken directly, without going to the department manager" if never_asked else "")
        + (" - not on the manager's shortlist" if off_shortlist else ""),
        user.name,
    )
    return await _respond(db, offer, "Selected offer", user)


@router.post("/{offer_id}/purchasing-manager-approve", response_model=OfferOut)
async def purchasing_manager_approve(
    offer_id: uuid.UUID,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> OfferOut:
    if user.role != UserRole.admin and not await _is_purchasing_manager(db, user):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only a manager of the Purchasing department can approve at this step",
        )

    offer, tender = await _load_for_decision(offer_id, OfferStatus.purchasing_ok, db)
    offer.status = OfferStatus.purchasing_manager_ok
    offer.purchasing_manager_reviewed_at = server_now()
    offer.purchasing_manager_reviewed_by = user.id

    db.add(
        Notification(
            type=NotificationType.offer_selected,
            tender_id=tender.id,
            message=f"{tender.serial}: an approved offer is waiting on supply chain",
            for_role=UserRole.supply_chain,
        )
    )
    await log_audit(
        db, "Offer Approved by Purchasing Manager", f"{tender.serial}: offer {offer.id}", user.name
    )
    return await _respond(db, offer, "Selected offer", user)


@router.post("/{offer_id}/supply-chain-approve", response_model=OfferOut)
async def supply_chain_approve(
    offer_id: uuid.UUID,
    background: BackgroundTasks,
    user: User = Depends(require_roles("admin", "supply_chain")),
    db: AsyncSession = Depends(get_db),
) -> OfferOut:
    offer, tender = await _load_for_decision(offer_id, OfferStatus.purchasing_manager_ok, db)
    offer.status = OfferStatus.approved
    offer.supply_chain_reviewed_at = server_now()
    offer.supply_chain_reviewed_by = user.id
    queued = await _award_tender(db, offer, tender, user)

    db.add(
        Notification(
            type=NotificationType.tender_awarded,
            tender_id=tender.id,
            message=f"{tender.serial}: an offer cleared every approval and is ready to buy",
            for_role=UserRole.procurement,
        )
    )
    db.add(
        Notification(
            type=NotificationType.tender_awarded,
            tender_id=tender.id,
            message=f"{tender.serial}: an approved purchase is ready for payment",
            for_role=UserRole.finance,
        )
    )
    await log_audit(
        db, "Offer Approved by Supply Chain", f"{tender.serial}: offer {offer.id}", user.name
    )
    response = await _respond(db, offer, "Approved offer", user)
    background.add_task(dispatch_emails, [e.id for e in queued])
    return response


@router.post("/{offer_id}/reject", response_model=OfferOut)
async def reject_offer(
    offer_id: uuid.UUID,
    payload: OfferRejection,
    user: User = Depends(CAN_SEE_OFFERS),
    db: AsyncSession = Depends(get_db),
) -> OfferOut:
    offer = await db.get(Offer, offer_id)
    if not offer:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Offer not found")
    tender = await db.get(Tender, offer.tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    if offer.status == OfferStatus.pending:
        allowed = user.role in (UserRole.admin, UserRole.procurement)
        desk = "purchasing, who are still filtering"
    elif offer.status == OfferStatus.forwarded:
        managed = await _managed_department_ids(db, user)
        allowed = user.role == UserRole.admin or (
            await _is_department_manager(db, user)
            and (not managed or tender.department_id in managed)
        )
        desk = "the department manager"
    elif offer.status == OfferStatus.selected:
        allowed = user.role in (UserRole.admin, UserRole.procurement)
        desk = "purchasing"
    elif offer.status == OfferStatus.purchasing_ok:
        allowed = (
            user.role in (UserRole.admin, UserRole.procurement)
            or await _is_purchasing_manager(db, user)
        )
        desk = "the purchasing manager"
    elif offer.status == OfferStatus.purchasing_manager_ok:
        allowed = user.role in (UserRole.admin, UserRole.supply_chain, UserRole.procurement)
        desk = "supply chain"
    elif offer.status == OfferStatus.approved:
        allowed = user.role in (UserRole.admin, UserRole.procurement)
        desk = "purchasing, who withdraw and re-award"
    else:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"An offer that is {offer.status.value} isn't waiting on a decision",
        )

    if not allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"This offer is waiting on {desk}, not on you"
        )

    offer.rejected_at_stage = offer.status
    offer.status = OfferStatus.rejected
    offer.rejected_by = user.id
    offer.rejection_reason = payload.reason
    offer.manager_rank = None

    if tender.awarded_offer_id == offer.id:
        tender.awarded_offer_id = None
        tender.awarded_vendor_submission_id = None
        tender.awarded_vendor_name = None
        tender.awarded_email = None
        tender.awarded_amount = None
        if tender.status == TenderStatus.awarded:
            tender.status = TenderStatus.open
            tender.supply_chain_approved = False
            tender.supply_chain_reviewed_at = server_now()
            tender.supply_chain_reviewed_by = user.id

    db.add(
        Notification(
            type=NotificationType.changes_requested,
            tender_id=tender.id,
            message=f"{tender.serial}: the picked offer was rejected — {payload.reason}",
            for_role=UserRole.manager,
        )
    )
    db.add(
        Notification(
            type=NotificationType.changes_requested,
            tender_id=tender.id,
            message=f"{tender.serial}: the picked offer was rejected — {payload.reason}",
            for_role=UserRole.procurement,
        )
    )
    await log_audit(
        db,
        "Offer Rejected",
        f"{tender.serial}: offer {offer.id} rejected at {offer.rejected_at_stage.value} — {payload.reason}",
        user.name,
    )
    return await _respond(db, offer, "Rejected offer", user)
