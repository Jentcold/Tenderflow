import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import require_roles
from app.core.scope import require_purchasing
from app.core.time import server_now
from app.database import get_db
from app.models.award import Award, AwardLine, AwardStatus, SourcingMode
from app.models.department import PURCHASING_CODE, Department
from app.models.notification import Notification, NotificationType
from app.models.offer import Offer, OfferItem
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.tender_item import TenderItem
from app.models.user import User, UserRole
from app.models.vendor import Vendor
from app.schemas.award import (
    AwardIn,
    AwardLineOut,
    AwardOut,
    AwardRejection,
    SourcingModeUpdate,
)
from app.services.email_service import dispatch_emails, send_basket_emails

router = APIRouter(prefix="/awards", tags=["awards"])

CAN_BUILD = require_purchasing("admin", "procurement")
CAN_VIEW = require_roles("admin", "procurement", "manager", "supply_chain", "finance")


async def _is_purchasing_manager(db: AsyncSession, user: User) -> bool:
    if user.role != UserRole.manager or user.department_id is None:
        return False
    department = await db.get(Department, user.department_id)
    return department is not None and department.code == PURCHASING_CODE


async def _tender_or_404(db: AsyncSession, tender_id: uuid.UUID) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    return tender


async def _active_award(db: AsyncSession, tender_id: uuid.UUID) -> Award | None:
    return await db.scalar(
        select(Award).where(Award.tender_id == tender_id, Award.active.is_(True))
    )


async def _lines_of(db: AsyncSession, award_id: uuid.UUID) -> list[AwardLine]:
    return list(
        (
            await db.execute(
                select(AwardLine).where(AwardLine.award_id == award_id).order_by(AwardLine.position)
            )
        ).scalars().all()
    )


async def _to_out(db: AsyncSession, award: Award) -> AwardOut:
    lines = await _lines_of(db, award.id)
    tender = await db.get(Tender, award.tender_id)
    required = len(
        (
            await db.execute(select(TenderItem.id).where(TenderItem.tender_id == award.tender_id))
        ).scalars().all()
    )
    suppliers = {
        (line.vendor_id, (line.vendor_name or "").strip().lower())
        for line in lines
        if line.vendor_id or (line.vendor_name or "").strip()
    }
    return AwardOut(
        id=award.id,
        tender_id=award.tender_id,
        mode=award.mode,
        status=award.status,
        active=award.active,
        currency=award.currency,
        notes=award.notes,
        created_at=award.created_at,
        submitted_at=award.submitted_at,
        purchasing_manager_reviewed_at=award.purchasing_manager_reviewed_at,
        supply_chain_reviewed_at=award.supply_chain_reviewed_at,
        rejected_at_stage=award.rejected_at_stage,
        rejection_reason=award.rejection_reason,
        urgent_skipped=award.urgent_skipped,
        lines=[
            AwardLineOut(
                id=line.id,
                tender_item_id=line.tender_item_id,
                offer_item_id=line.offer_item_id,
                vendor_id=line.vendor_id,
                vendor_name=line.vendor_name,
                position=line.position,
                name=line.name,
                specs=line.specs,
                notes=line.notes,
                quantity=float(line.quantity),
                unit=line.unit,
                unit_price=float(line.unit_price),
                line_total=line.line_total,
            )
            for line in lines
        ],
        total_amount=round(sum(line.line_total for line in lines), 2),
        items_answered=len({line.tender_item_id for line in lines if line.tender_item_id}),
        items_required=required,
        vendor_count=len(suppliers),
        tender_serial=tender.serial if tender else "",
        tender_name=tender.name if tender else "",
        urgent=bool(tender.urgent) if tender else False,
    )


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


@router.post("/tenders/{tender_id}/sourcing-mode", response_model=AwardOut)
async def set_sourcing_mode(
    tender_id: uuid.UUID,
    payload: SourcingModeUpdate,
    user: User = Depends(CAN_BUILD),
    db: AsyncSession = Depends(get_db),
) -> AwardOut:
    tender = await _tender_or_404(db, tender_id)
    if not tender.manager_approved:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "The department manager hasn't approved this tender yet",
        )

    existing_bids = await db.scalar(
        select(Submission.id).where(Submission.tender_id == tender.id).limit(1)
    )
    if existing_bids is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Vendors have already bid on this tender, so how it is sourced is settled",
        )

    tender.sourcing_mode = payload.mode

    award = await _active_award(db, tender.id)
    if award is None:
        award = Award(
            tender_id=tender.id,
            mode=payload.mode,
            currency=tender.currency,
            created_by=user.id,
        )
        db.add(award)
        await db.flush()
    else:
        if award.status != AwardStatus.draft:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"This tender's basket is already {award.status.value} and can't change how it is sourced",
            )
        award.mode = payload.mode
        await db.execute(AwardLine.__table__.delete().where(AwardLine.award_id == award.id))

    if payload.mode == SourcingMode.by_hand:
        requirements = (
            await db.execute(
                select(TenderItem).where(TenderItem.tender_id == tender.id).order_by(TenderItem.position)
            )
        ).scalars().all()
        for position, item in enumerate(requirements):
            db.add(
                AwardLine(
                    award_id=award.id,
                    tender_item_id=item.id,
                    position=position,
                    name=item.name,
                    specs=item.specs,
                    notes=item.notes,
                    quantity=item.quantity,
                    unit=item.unit,
                    unit_price=0,
                )
            )
        for user_id in await _purchasing_manager_ids(db):
            db.add(
                Notification(
                    type=NotificationType.offer_selected,
                    tender_id=tender.id,
                    message=f"{tender.serial} will be bought by hand — no RFQ is going out",
                    user_id=user_id,
                )
            )
        db.add(
            Notification(
                type=NotificationType.offer_selected,
                tender_id=tender.id,
                message=f"{tender.serial} will be bought by hand — no RFQ is going out",
                for_role=UserRole.supply_chain,
            )
        )

    await log_audit(
        db,
        "Sourcing Mode Set",
        f"{tender.serial}: {payload.mode.value}"
        + (" — empty basket opened for purchasing to fill in" if payload.mode == SourcingMode.by_hand else ""),
        user.name,
    )
    await db.commit()
    await db.refresh(award)
    return await _to_out(db, award)


@router.get("", response_model=list[AwardOut])
async def list_awards(
    status_filter: AwardStatus | None = Query(default=None, alias="status"),
    user: User = Depends(CAN_VIEW),
    db: AsyncSession = Depends(get_db),
) -> list[AwardOut]:
    stmt = select(Award).where(Award.active.is_(True)).order_by(Award.submitted_at.desc().nullslast())
    if status_filter is not None:
        stmt = stmt.where(Award.status == status_filter)
    awards = list((await db.execute(stmt)).scalars().all())
    return [await _to_out(db, a) for a in awards]


@router.get("/tenders/{tender_id}", response_model=AwardOut | None)
async def get_award(
    tender_id: uuid.UUID,
    user: User = Depends(CAN_VIEW),
    db: AsyncSession = Depends(get_db),
) -> AwardOut | None:
    await _tender_or_404(db, tender_id)
    award = await _active_award(db, tender_id)
    return await _to_out(db, award) if award else None


@router.put("/tenders/{tender_id}", response_model=AwardOut)
async def save_award(
    tender_id: uuid.UUID,
    payload: AwardIn,
    user: User = Depends(CAN_BUILD),
    db: AsyncSession = Depends(get_db),
) -> AwardOut:
    tender = await _tender_or_404(db, tender_id)
    award = await _active_award(db, tender_id)
    if award is None:
        award = Award(
            tender_id=tender.id,
            mode=tender.sourcing_mode,
            currency=tender.currency,
            created_by=user.id,
        )
        db.add(award)
        await db.flush()
    elif award.status not in (AwardStatus.draft, AwardStatus.rejected):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"This basket is {award.status.value} and is waiting on an approver, not on you. "
            f"It has to be rejected before it can be changed.",
        )
    elif award.status == AwardStatus.rejected:
        award.active = False
        await db.flush()
        award = Award(
            tender_id=tender.id,
            mode=tender.sourcing_mode,
            currency=tender.currency,
            created_by=user.id,
        )
        db.add(award)
        await db.flush()

    valid_items = set(
        (
            await db.execute(select(TenderItem.id).where(TenderItem.tender_id == tender.id))
        ).scalars().all()
    )
    offer_items: dict[uuid.UUID, OfferItem] = {}
    wanted = [line.offer_item_id for line in payload.lines if line.offer_item_id]
    if wanted:
        rows = (
            await db.execute(
                select(OfferItem)
                .join(Offer, Offer.id == OfferItem.offer_id)
                .where(OfferItem.id.in_(wanted), Offer.tender_id == tender.id)
            )
        ).scalars().all()
        offer_items = {row.id: row for row in rows}

    await db.execute(AwardLine.__table__.delete().where(AwardLine.award_id == award.id))

    for position, line in enumerate(payload.lines):
        if line.tender_item_id is not None and line.tender_item_id not in valid_items:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "One of those lines answers a requirement that isn't on this tender",
            )

        source = offer_items.get(line.offer_item_id) if line.offer_item_id else None
        if line.offer_item_id and source is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "One of those lines was taken from an offer on a different tender",
            )

        vendor_name = (line.vendor_name or "").strip() or None
        vendor_id = line.vendor_id
        if source is not None and vendor_id is None and vendor_name is None:
            submission = await db.scalar(
                select(Submission)
                .join(Offer, Offer.submission_id == Submission.id)
                .where(Offer.id == source.offer_id)
            )
            if submission is not None:
                vendor_id = submission.vendor_id
                vendor_name = submission.company_name
        if vendor_id is not None and vendor_name is None:
            vendor = await db.get(Vendor, vendor_id)
            if vendor is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "That vendor doesn't exist")
            vendor_name = vendor.company_name

        db.add(
            AwardLine(
                award_id=award.id,
                tender_item_id=line.tender_item_id
                or (source.tender_item_id if source is not None else None),
                offer_item_id=line.offer_item_id,
                vendor_id=vendor_id,
                vendor_name=vendor_name,
                position=position,
                name=(source.name if source is not None else None) or line.name or "Unnamed line",
                specs=(source.specs if source is not None else None) or line.specs,
                notes=line.notes or (source.notes if source is not None else None),
                quantity=line.quantity
                if line.quantity is not None
                else (float(source.quantity) if source is not None else 1),
                unit=line.unit or (source.unit if source is not None else "pcs"),
                unit_price=line.unit_price
                if line.unit_price is not None
                else (float(source.unit_price) if source is not None else 0),
            )
        )

    award.notes = payload.notes

    award.mode = (
        SourcingMode.vendors
        if any(line.offer_item_id for line in payload.lines)
        else SourcingMode.by_hand
    )

    await log_audit(
        db,
        "Basket Saved",
        f"{tender.serial}: {len(payload.lines)} line(s), mode {award.mode.value}",
        user.name,
    )
    await db.commit()
    await db.refresh(award)
    return await _to_out(db, award)


@router.post("/tenders/{tender_id}/submit", response_model=AwardOut)
async def submit_award(
    tender_id: uuid.UUID,
    background: BackgroundTasks,
    user: User = Depends(CAN_BUILD),
    db: AsyncSession = Depends(get_db),
) -> AwardOut:
    tender = await _tender_or_404(db, tender_id)
    award = await _active_award(db, tender_id)
    if award is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "There is no basket on this tender yet")
    if award.status != AwardStatus.draft:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"This basket is already {award.status.value}",
        )

    lines = await _lines_of(db, award.id)
    if not lines:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The basket is empty")
    unpriced = [line for line in lines if float(line.unit_price) <= 0]
    if unpriced:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{len(unpriced)} line(s) still have no price. Fill the basket in before sending it up.",
        )
    unsourced = [line for line in lines if not line.vendor_id and not (line.vendor_name or "").strip()]
    if unsourced:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{len(unsourced)} line(s) don't say who they are being bought from",
        )

    award.submitted_at = server_now()
    award.submitted_by = user.id

    skip = tender.urgent
    reason = "urgent"
    purchasing_managers = await _purchasing_manager_ids(db)

    if skip:
        award.status = AwardStatus.approved
        award.urgent_skipped = True
        queued = await _finalise(db, award, tender, user)
        for user_id in purchasing_managers:
            db.add(
                Notification(
                    type=NotificationType.offer_selected,
                    tender_id=tender.id,
                    message=f"{tender.serial} was completed without your approval ({reason})",
                    user_id=user_id,
                )
            )
        db.add(
            Notification(
                type=NotificationType.offer_selected,
                tender_id=tender.id,
                message=f"{tender.serial} was completed without supply chain approval ({reason})",
                for_role=UserRole.supply_chain,
            )
        )
        await log_audit(
            db,
            "Basket Approved (Skipped)",
            f"{tender.serial}: approved on submission, later desks skipped — {reason}",
            user.name,
        )
        await db.commit()
        await db.refresh(award)
        result = await _to_out(db, award)
        background.add_task(dispatch_emails, [e.id for e in queued])
        return result

    award.status = AwardStatus.submitted
    for user_id in purchasing_managers:
        db.add(
            Notification(
                type=NotificationType.offer_selected,
                tender_id=tender.id,
                message=f"{tender.serial}: purchasing sent a basket up and it needs your decision",
                user_id=user_id,
            )
        )
    if not purchasing_managers:
        await log_audit(
            db,
            "Basket Awaiting Purchasing Manager",
            f"{tender.serial}: no user is a manager of the Purchasing department — "
            f"this basket has nobody to approve it",
            user.name,
        )
    await log_audit(db, "Basket Submitted", f"{tender.serial}: sent for approval", user.name)
    await db.commit()
    await db.refresh(award)
    return await _to_out(db, award)


async def _tell_finance_and_purchasing(
    db: AsyncSession, award: Award, tender: Tender, lines: list[AwardLine], total: float
) -> None:
    currency = award.currency
    prepaid = round(sum(line.line_total for line in lines if not line.offer_item_id), 2)
    invoiced = round(total - prepaid, 2)

    registered = list(dict.fromkeys(
        line.vendor_name for line in lines if line.vendor_id and line.vendor_name
    ))
    unregistered = list(dict.fromkeys(
        line.vendor_name for line in lines
        if not line.vendor_id and (line.vendor_name or "").strip()
    ))

    parts = [f"{tender.serial}: purchase approved, {currency} {total:,.2f} in total."]
    if prepaid:
        parts.append(
            f"{currency} {prepaid:,.2f} was bought directly by purchasing and is already "
            f"paid - it needs reimbursing, not invoicing."
        )
    if invoiced:
        parts.append(f"{currency} {invoiced:,.2f} is still to be paid against vendor invoices.")
    if registered:
        parts.append(f"Registered vendor(s): {', '.join(registered)}.")
    if unregistered:
        parts.append(
            f"Not in the vendor directory: {', '.join(unregistered)} - no vendor record to pay against."
        )
    if award.urgent_skipped:
        parts.append("Approved as urgent, without the purchasing manager or supply chain.")
    message = " ".join(parts)

    db.add(
        Notification(
            type=NotificationType.tender_awarded,
            tender_id=tender.id,
            message=message,
            for_role=UserRole.finance,
        )
    )
    db.add(
        Notification(
            type=NotificationType.tender_awarded,
            tender_id=tender.id,
            message=f"{tender.serial}: cleared every approval and is ready to buy",
            for_role=UserRole.procurement,
        )
    )


async def _finalise(db: AsyncSession, award: Award, tender: Tender, user: User) -> list:
    lines = await _lines_of(db, award.id)
    total = round(sum(line.line_total for line in lines), 2)
    suppliers = [line.vendor_name for line in lines if line.vendor_name]
    distinct = list(dict.fromkeys(suppliers))

    tender.supply_chain_approved = True
    tender.supply_chain_rejected = False
    tender.supply_chain_reviewed_at = server_now()
    tender.supply_chain_reviewed_by = user.id
    tender.status = TenderStatus.awarded
    tender.awarded_amount = total
    tender.awarded_vendor_name = (
        distinct[0] if len(distinct) == 1 else f"{len(distinct)} vendors" if distinct else None
    )

    won_by_submission: dict[uuid.UUID, list] = {}
    for line in lines:
        if not line.offer_item_id:
            continue
        submission = await db.scalar(
            select(Submission)
            .join(Offer, Offer.submission_id == Submission.id)
            .join(OfferItem, OfferItem.offer_id == Offer.id)
            .where(OfferItem.id == line.offer_item_id)
        )
        if submission is not None:
            won_by_submission.setdefault(submission.id, []).append(line)

    if len(won_by_submission) == 1:
        only = await db.get(Submission, next(iter(won_by_submission)))
        if only is not None:
            tender.awarded_vendor_submission_id = only.id
            tender.awarded_email = only.email

    await _tell_finance_and_purchasing(db, award, tender, lines, total)

    submissions = list(
        (
            await db.execute(select(Submission).where(Submission.tender_id == tender.id))
        ).scalars().all()
    )
    if not submissions:
        return []
    return await send_basket_emails(db, tender, submissions, won_by_submission)


@router.post("/tenders/{tender_id}/purchasing-manager-approve", response_model=AwardOut)
async def purchasing_manager_approve(
    tender_id: uuid.UUID,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> AwardOut:
    if user.role != UserRole.admin and not await _is_purchasing_manager(db, user):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only a manager of the Purchasing department can approve at this step",
        )
    tender = await _tender_or_404(db, tender_id)
    award = await _active_award(db, tender_id)
    if award is None or award.status != AwardStatus.submitted:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"This basket is {award.status.value if award else 'missing'} and is not waiting at this step",
        )

    award.status = AwardStatus.purchasing_manager_ok
    award.purchasing_manager_reviewed_at = server_now()
    award.purchasing_manager_reviewed_by = user.id
    db.add(
        Notification(
            type=NotificationType.offer_selected,
            tender_id=tender.id,
            message=f"{tender.serial}: an approved basket is waiting on supply chain",
            for_role=UserRole.supply_chain,
        )
    )
    await log_audit(db, "Basket Approved by Purchasing Manager", f"{tender.serial}", user.name)
    await db.commit()
    await db.refresh(award)
    return await _to_out(db, award)


@router.post("/tenders/{tender_id}/supply-chain-approve", response_model=AwardOut)
async def supply_chain_approve(
    tender_id: uuid.UUID,
    background: BackgroundTasks,
    user: User = Depends(require_roles("admin", "supply_chain")),
    db: AsyncSession = Depends(get_db),
) -> AwardOut:
    tender = await _tender_or_404(db, tender_id)
    award = await _active_award(db, tender_id)
    if award is None or award.status != AwardStatus.purchasing_manager_ok:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"This basket is {award.status.value if award else 'missing'} and is not waiting at this step",
        )

    award.status = AwardStatus.approved
    award.supply_chain_reviewed_at = server_now()
    award.supply_chain_reviewed_by = user.id
    queued = await _finalise(db, award, tender, user)
    await log_audit(db, "Basket Approved by Supply Chain", f"{tender.serial}", user.name)
    await db.commit()
    await db.refresh(award)
    result = await _to_out(db, award)
    background.add_task(dispatch_emails, [e.id for e in queued])
    return result


@router.post("/tenders/{tender_id}/reject", response_model=AwardOut)
async def reject_award(
    tender_id: uuid.UUID,
    payload: AwardRejection,
    user: User = Depends(CAN_VIEW),
    db: AsyncSession = Depends(get_db),
) -> AwardOut:
    tender = await _tender_or_404(db, tender_id)
    award = await _active_award(db, tender_id)
    if award is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "There is no basket on this tender")

    if award.status == AwardStatus.submitted:
        allowed = user.role == UserRole.admin or await _is_purchasing_manager(db, user)
        desk = "the purchasing manager"
    elif award.status == AwardStatus.purchasing_manager_ok:
        allowed = user.role in (UserRole.admin, UserRole.supply_chain)
        desk = "supply chain"
    elif award.status == AwardStatus.approved:
        allowed = user.role in (UserRole.admin, UserRole.supply_chain)
        desk = "supply chain, who approved it"
    else:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"A basket that is {award.status.value} isn't waiting on a decision",
        )

    if not allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"This basket is waiting on {desk}, not on you"
        )

    was_approved = award.status == AwardStatus.approved
    award.rejected_at_stage = award.status
    award.status = AwardStatus.rejected
    award.rejected_by = user.id
    award.rejection_reason = payload.reason

    if was_approved:
        tender.status = TenderStatus.open
        tender.supply_chain_approved = False
        tender.awarded_vendor_name = None
        tender.awarded_amount = None
        tender.awarded_email = None
        tender.awarded_vendor_submission_id = None

    db.add(
        Notification(
            type=NotificationType.changes_requested,
            tender_id=tender.id,
            message=f"{tender.serial}: the basket was rejected — {payload.reason}",
            for_role=UserRole.procurement,
        )
    )
    await log_audit(
        db,
        "Basket Rejected",
        f"{tender.serial}: rejected at {award.rejected_at_stage.value} — {payload.reason}",
        user.name,
    )
    await db.commit()
    await db.refresh(award)
    return await _to_out(db, award)
