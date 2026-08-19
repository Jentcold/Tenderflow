"""The basket: assembling it, and walking it up the chain.

Purchasing builds one basket per tender out of whatever answers each line best —
the mobiles from one vendor, the laptops from another, the mouse bought by hand
from a shop. The basket, not any single offer, is what the purchasing manager
and supply chain approve.
"""
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import require_roles
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

CAN_BUILD = require_roles("admin", "procurement")
CAN_VIEW = require_roles("admin", "procurement", "manager", "supply_chain", "finance")


# ---------------------------------------------------------------- helpers --

async def _is_purchasing_manager(db: AsyncSession, user: User) -> bool:
    """A manager whose own department is Purchasing. Matched on the department
    code, never its name, so renaming the department can't move the step."""
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


# ------------------------------------------------------ sourcing decision --

@router.post("/tenders/{tender_id}/sourcing-mode", response_model=AwardOut)
async def set_sourcing_mode(
    tender_id: uuid.UUID,
    payload: SourcingModeUpdate,
    user: User = Depends(CAN_BUILD),
    db: AsyncSession = Depends(get_db),
) -> AwardOut:
    """Vendors, or purchasing buys it themselves.

    Only before any bid has arrived. Once a vendor has quoted, switching to
    by-hand would leave offers on a tender nobody is going to read, and
    switching back would mean inviting vendors to price something already
    bought.

    Choosing `by_hand` opens the basket immediately, pre-filled with one empty
    line per requirement — the template purchasing completes with real prices
    and a seller once the shopping is done.
    """
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
        await db.flush()  # assigns award.id, which the lines below hang off
    else:
        if award.status != AwardStatus.draft:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"This tender's basket is already {award.status.value} and can't change how it is sourced",
            )
        award.mode = payload.mode
        await db.execute(AwardLine.__table__.delete().where(AwardLine.award_id == award.id))

    if payload.mode == SourcingMode.by_hand:
        # The empty template. One line per requirement, priced at zero, with no
        # seller yet — purchasing fills both in after buying.
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
        # Nobody is being asked to approve anything yet — this is a heads-up
        # that the tender left the vendor path, which is the one thing the
        # other desks would otherwise never find out.
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


# ----------------------------------------------------- building the basket --

@router.get("", response_model=list[AwardOut])
async def list_awards(
    status_filter: AwardStatus | None = Query(default=None, alias="status"),
    user: User = Depends(CAN_VIEW),
    db: AsyncSession = Depends(get_db),
) -> list[AwardOut]:
    """Live baskets across every tender, optionally filtered to one step.

    Added because a basket sent up the chain had nowhere to be seen. The
    purchasing manager got the notification and then had to find the tender,
    open it and click through to the basket — and their nav has no Tenders page
    on it, so in practice they could not get there at all. An approval that
    exists only as a notification is not an approval anybody performs.

    Active baskets only. A rejected one is superseded by the next attempt and
    is history, not work.
    """
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
    """The live basket for a tender, or null if purchasing hasn't started one."""
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
    """Write the basket. Replaces every line.

    A basket is a set of choices that have to agree — each requirement bought
    once, from one place. Saving it whole means it is never half-written;
    patching a line at a time would let it sit in states that don't add up.

    A line either points at an offer item (take this vendor's quote for this
    requirement) or carries its own typed values (bought by hand). Mixing them
    across lines in one basket is the entire point: the mobiles from Acme, the
    laptop from Techno, the mouse from the shop downstairs.
    """
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
        # A rejected basket is history. Editing it would rewrite what was
        # refused, so the changes go into a fresh one.
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

    # Everything referenced has to belong to THIS tender. Unchecked, a crafted
    # payload could pin another tender's quoted price onto this requirement.
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
            # Taken from an offer with no supplier named: fill it in from the
            # bid it came from, so the basket always says who is being paid.
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
                # The offer's own wording wins where there is one — that is
                # what was quoted, and what the vendor will be held to.
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

    # The mode is read off the basket rather than declared before it is built.
    #
    # It used to be a tender-level choice made from two buttons, before any bid
    # arrived — which meant deciding how something would be sourced at the one
    # moment nobody could know. The basket itself already answers the question:
    # a line taken from an offer is a vendor purchase, a line typed in is one
    # purchasing went and bought. All-typed means by-hand; anything else means
    # vendors are involved.
    #
    # It survives only as provenance now, and to decide whether losing-bid
    # emails make sense (see _finalise). It deliberately no longer decides
    # whether the basket skips approvals - see submit_award.
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


# ------------------------------------------------------- the approval chain --

@router.post("/tenders/{tender_id}/submit", response_model=AwardOut)
async def submit_award(
    tender_id: uuid.UUID,
    background: BackgroundTasks,
    user: User = Depends(CAN_BUILD),
    db: AsyncSession = Depends(get_db),
) -> AwardOut:
    """Purchasing sends the basket up: purchasing manager, then supply chain.

    On an **urgent** tender this is the last gate — both later desks are told
    but not waited for. Same on a **by-hand** purchase, where the money is
    already spent and an approval afterwards would be theatre; they are still
    notified, because somebody has to be able to ask why.
    """
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

    # Urgency, and nothing else.
    #
    # A by-hand basket used to skip both remaining desks on the reasoning that
    # it was petty cash already spent. That reasoning came from the button that
    # declared the mode up front, when "by hand" meant "somebody is nipping to
    # a shop". Now that the mode is derived from the lines, a basket can be
    # entirely by-hand and still be a large purchase nobody has signed off -
    # and skipping two approvals is not something that should happen because of
    # how the lines happened to be filled in. Urgent is a deliberate flag a
    # manager sets, so it stays.
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
    """Both desks that act after the approvals are done.

    Finance gets more than "a purchase was approved", because on a basket that
    sentence hides the only two questions they have. **Has it already been
    paid?** A line taken from an offer is a vendor who will invoice; a line
    purchasing walked out and bought is money already gone that somebody has to
    be reimbursed for, and the two need different handling. **Was it a
    registered vendor?** A supplier in the directory has a record and a tax id
    behind them; a name typed into a basket line has neither, and finance has
    to chase the paperwork before they can pay it.

    Sent from here rather than from the supply chain endpoint so the urgent
    path - which skips that endpoint entirely - tells them too. That omission
    is exactly how an urgent purchase used to reach the accounts with nobody
    in finance having heard of it.
    """
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
    """Mark the tender bought, and tell the vendors.

    Written here and nowhere earlier: until the last approval lands nobody has
    committed to anything, and a tender carrying an awarded vendor for a basket
    still walking the chain reads as bought when it isn't.
    """
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
    # One name when it came from one place, otherwise say so plainly rather
    # than picking a winner that doesn't exist.
    tender.awarded_vendor_name = (
        distinct[0] if len(distinct) == 1 else f"{len(distinct)} vendors" if distinct else None
    )

    # Which bid each basket line came from, so every vendor can be told exactly
    # what they won. By-hand lines have no offer behind them and trace to
    # nobody, which is correct — there is no vendor to write to.
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

    # `awarded_vendor_submission_id` names one vendor, so it is only meaningful
    # when one vendor took the lot. On a split basket it stays null rather than
    # naming whichever supplier happened to sort first.
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
        # An entirely by-hand basket: nobody bid, so there is nobody to write
        # to. Not an error, just the end of the mail path.
        return []
    return await send_basket_emails(db, tender, submissions, won_by_submission)


@router.post("/tenders/{tender_id}/purchasing-manager-approve", response_model=AwardOut)
async def purchasing_manager_approve(
    tender_id: uuid.UUID,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> AwardOut:
    """Guarded on the department, not the role: a department manager who
    wandered in here would be approving the purchase they requested."""
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
    """The last approval. After this it is bought: finance pays it and the
    warehouse receives against these lines."""
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
    # Finance and purchasing are told inside _finalise, so the urgent path -
    # which never reaches this endpoint - tells them too.
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
    """Turn the basket down at whichever desk it is sitting at.

    One endpoint rather than three: the check is the same each time, you may
    only reject at the step you are the approver for. `rejected_at_stage` keeps
    which desk it died at — "rejected" alone can't say whether supply chain
    killed it or the purchasing manager never let it out of the room.
    """
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
        # Withdrawing an approval, not refusing one. Without this the tender
        # deadlocks: purchasing can't edit an approved basket and nothing could
        # clear it.
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
