"""The warehouse end of the chain: what is coming, and what actually arrived.

The warehouse sees one thing - purchases that cleared every approval and have
not been checked in yet. Not tenders, not bids, not offers under review. By the
time a shipment appears here every decision about it has been made, so there is
nothing on this screen to decide and nothing to leak: the only question left is
whether the right things turned up.

**Two shapes of purchase reach this door, not one.** An approved offer is one,
and an approved basket is the other, and for a while only the first showed up
here - which meant anything bought across two vendors, or bought by hand, was
invisible to the warehouse even though the goods still walked in. The screen
now lists both, keyed by a `source` alongside the id. Nothing else about the
warehouse's job changes with the source, which is why the difference goes no
deeper than that pair.

Who counts as the warehouse is a *department*, not a role. That is the rule the
rest of the app already follows - seniority and function come from
`departments.code`, and `UserRole` stays generic - and it is why there is no
`warehouse` role to add. Whoever is attached to the Warehouse department can
receive, whatever their role says.

Checking a delivery in notifies supply chain and purchasing. Always, not only
when something is wrong: "it all arrived" is the thing they are waiting to
hear, and a channel that only ever carries bad news gets read as noise.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import get_current_user
from app.core.time import server_now
from app.database import get_db
from app.models.award import Award, AwardLine, AwardStatus
from app.models.department import PURCHASING_CODE, WAREHOUSE_CODE, Department
from app.models.notification import Notification, NotificationType
from app.models.offer import Offer, OfferItem, OfferStatus
from app.models.receipt import GoodsReceipt, GoodsReceiptLine, LineCondition
from app.models.submission import Submission
from app.models.tender import Tender
from app.models.user import User, UserRole
from app.schemas.receipt import (
    IncomingLine,
    IncomingShipment,
    ReceiptIn,
    ReceiptLineOut,
    ReceiptOut,
)

router = APIRouter(prefix="/receiving", tags=["receiving"])


# --------------------------------------------------------------------- access


async def _department_code(db: AsyncSession, user: User) -> str | None:
    if user.department_id is None:
        return None
    return await db.scalar(
        select(Department.code).where(Department.id == user.department_id)
    )


async def require_warehouse(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> User:
    """Whoever works in the Warehouse department, plus admin.

    Not `require_roles(...)`: the warehouse staff account is `role=employee`,
    and widening that role would hand every requester in the company the
    submissions and offers routers along with it.
    """
    if user.role is UserRole.admin:
        return user
    if await _department_code(db, user) == WAREHOUSE_CODE:
        return user
    raise HTTPException(
        status.HTTP_403_FORBIDDEN, "Only the warehouse can receive deliveries"
    )


async def require_receipt_reader(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> User:
    """Who may read what the warehouse recorded.

    The warehouse itself, supply chain, and purchasing - the people a problem
    on a delivery lands on. Kept deliberately wider than `require_warehouse`:
    the whole point of a receipt is that somebody else acts on it.
    """
    if user.role in (UserRole.admin, UserRole.supply_chain, UserRole.procurement):
        return user
    code = await _department_code(db, user)
    if code in (WAREHOUSE_CODE, PURCHASING_CODE):
        return user
    raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions for this action")


# ---------------------------------------------------------------------- reads


def _suppliers_label(names: list[str | None]) -> str:
    """Who is delivering, in one phrase.

    A basket can span three vendors and a corner shop, and there is no honest
    single name for that - so it says how many rather than picking whichever
    sorted first. The per-line vendor carries the detail.
    """
    distinct = list(dict.fromkeys(n for n in names if n))
    if not distinct:
        return "Bought by purchasing"
    if len(distinct) == 1:
        return distinct[0]
    return f"{len(distinct)} suppliers"


async def _offer_items(db: AsyncSession, offer_ids: list[uuid.UUID]) -> dict:
    if not offer_ids:
        return {}
    rows = (
        await db.execute(
            select(OfferItem)
            .where(OfferItem.offer_id.in_(offer_ids))
            .order_by(OfferItem.position.asc())
        )
    ).scalars().all()
    grouped: dict[uuid.UUID, list[OfferItem]] = {}
    for row in rows:
        grouped.setdefault(row.offer_id, []).append(row)
    return grouped


async def _incoming_offers(db: AsyncSession) -> list[IncomingShipment]:
    """Approved offers with no receipt against them yet.

    `approved` is the whole filter, and it is deliberately the only one: that
    status means supply chain signed it off, which is the moment the goods
    become the warehouse's problem and not before. Anything earlier belongs to
    somebody still deciding.
    """
    received = select(GoodsReceipt.offer_id).where(GoodsReceipt.offer_id.is_not(None))
    offers = list(
        (
            await db.execute(
                select(Offer)
                .where(Offer.status == OfferStatus.approved, Offer.id.not_in(received))
                .order_by(Offer.supply_chain_reviewed_at.asc())
            )
        ).scalars().all()
    )
    if not offers:
        return []

    tenders = {
        t.id: t
        for t in (
            await db.execute(
                select(Tender).where(Tender.id.in_({o.tender_id for o in offers}))
            )
        ).scalars().all()
    }
    vendors = {
        s.id: s.company_name
        for s in (
            await db.execute(
                select(Submission).where(Submission.id.in_({o.submission_id for o in offers}))
            )
        ).scalars().all()
    }
    items_by_offer = await _offer_items(db, [o.id for o in offers])

    out = []
    for offer in offers:
        tender = tenders.get(offer.tender_id)
        if tender is None:
            continue
        out.append(
            IncomingShipment(
                source="offer",
                shipment_id=offer.id,
                tender_id=offer.tender_id,
                tender_serial=tender.serial,
                tender_name=tender.name,
                vendor_company=vendors.get(offer.submission_id, "Unknown supplier"),
                offer_title=offer.title,
                currency=offer.currency,
                total_amount=float(offer.total_amount),
                approved_at=offer.supply_chain_reviewed_at,
                urgent=bool(getattr(tender, "urgent", False)),
                items=[
                    IncomingLine(
                        line_id=i.id,
                        name=i.name,
                        specs=i.specs,
                        quantity=float(i.quantity),
                        unit=i.unit,
                        unit_price=float(i.unit_price),
                        line_total=i.line_total,
                        is_replacement=i.is_replacement,
                    )
                    for i in items_by_offer.get(offer.id, [])
                ],
            )
        )
    return out


async def _incoming_baskets(db: AsyncSession) -> list[IncomingShipment]:
    """Approved baskets with no receipt against them yet.

    The warehouse never sees the basket walk the chain - draft, submitted, with
    the purchasing manager - for the same reason it never sees an offer do it.
    It appears at `approved` and not one step earlier.

    Urgent baskets land here too, and that is the point: urgency skips the two
    approving desks, never the door. Somebody still has to say what turned up,
    including on the lines purchasing walked out and bought themselves - those
    are carried in, registered, and taken on from here like everything else.
    """
    received = select(GoodsReceipt.award_id).where(GoodsReceipt.award_id.is_not(None))
    awards = list(
        (
            await db.execute(
                select(Award)
                .where(
                    Award.status == AwardStatus.approved,
                    Award.active.is_(True),
                    Award.id.not_in(received),
                )
                .order_by(Award.submitted_at.asc().nullslast())
            )
        ).scalars().all()
    )
    if not awards:
        return []

    tenders = {
        t.id: t
        for t in (
            await db.execute(
                select(Tender).where(Tender.id.in_({a.tender_id for a in awards}))
            )
        ).scalars().all()
    }
    lines_by_award: dict[uuid.UUID, list[AwardLine]] = {}
    for line in (
        await db.execute(
            select(AwardLine)
            .where(AwardLine.award_id.in_([a.id for a in awards]))
            .order_by(AwardLine.position.asc())
        )
    ).scalars().all():
        lines_by_award.setdefault(line.award_id, []).append(line)

    out = []
    for award in awards:
        tender = tenders.get(award.tender_id)
        if tender is None:
            continue
        lines = lines_by_award.get(award.id, [])
        if not lines:
            # An empty basket cannot be approved, so this is a broken row
            # rather than a delivery. Nothing to tick off, so nothing to show.
            continue
        out.append(
            IncomingShipment(
                source="basket",
                shipment_id=award.id,
                tender_id=award.tender_id,
                tender_serial=tender.serial,
                tender_name=tender.name,
                vendor_company=_suppliers_label([line.vendor_name for line in lines]),
                offer_title="Basket",
                currency=award.currency,
                total_amount=round(sum(line.line_total for line in lines), 2),
                # An urgent basket is approved on submission and never reaches
                # supply chain, so the moment it became real is when it was
                # sent up.
                approved_at=award.supply_chain_reviewed_at or award.submitted_at,
                urgent=bool(getattr(tender, "urgent", False)),
                urgent_skipped=bool(award.urgent_skipped),
                items=[
                    IncomingLine(
                        line_id=line.id,
                        name=line.name,
                        specs=line.specs,
                        quantity=float(line.quantity),
                        unit=line.unit,
                        unit_price=float(line.unit_price),
                        line_total=line.line_total,
                        vendor_name=line.vendor_name,
                    )
                    for line in lines
                ],
            )
        )
    return out


@router.get("/incoming", response_model=list[IncomingShipment])
async def list_incoming(
    user: User = Depends(require_receipt_reader), db: AsyncSession = Depends(get_db)
) -> list[IncomingShipment]:
    """Everything approved and not yet checked in, whichever shape it took.

    Received shipments drop off this list by having a `goods_receipts` row,
    not by changing status - see app/models/receipt.py for why that is a row
    and not a flag.
    """
    shipments = list(await _incoming_offers(db)) + list(await _incoming_baskets(db))
    # Oldest first: the thing approved a fortnight ago and still not arrived is
    # the one worth looking at.
    shipments.sort(key=lambda s: (s.approved_at is None, s.approved_at))
    return shipments


async def _receipt_out(db: AsyncSession, receipt: GoodsReceipt) -> ReceiptOut:
    tender = await db.get(Tender, receipt.tender_id)
    vendor = "Unknown supplier"
    source = "basket" if receipt.award_id else "offer"

    if receipt.offer_id is not None:
        offer = await db.get(Offer, receipt.offer_id)
        if offer is not None:
            submission = await db.get(Submission, offer.submission_id)
            if submission is not None:
                vendor = submission.company_name
    elif receipt.award_id is not None:
        names = list(
            (
                await db.execute(
                    select(AwardLine.vendor_name).where(AwardLine.award_id == receipt.award_id)
                )
            ).scalars().all()
        )
        vendor = _suppliers_label(names)

    received_by_name = None
    if receipt.received_by is not None:
        who = await db.get(User, receipt.received_by)
        received_by_name = who.name if who else None

    lines = list(
        (
            await db.execute(
                select(GoodsReceiptLine).where(GoodsReceiptLine.receipt_id == receipt.id)
            )
        ).scalars().all()
    )
    return ReceiptOut(
        id=receipt.id,
        source=source,
        shipment_id=receipt.award_id or receipt.offer_id,
        tender_id=receipt.tender_id,
        tender_serial=tender.serial if tender else "",
        tender_name=tender.name if tender else "",
        vendor_company=vendor,
        received_by_name=received_by_name,
        received_at=receipt.received_at,
        notes=receipt.notes,
        lines=[
            ReceiptLineOut(
                id=line.id,
                line_id=line.award_line_id or line.offer_item_id,
                name=line.name,
                ordered_quantity=float(line.ordered_quantity),
                received_quantity=float(line.received_quantity),
                condition=line.condition,
                notes=line.notes,
            )
            for line in lines
        ],
        total_lines=len(lines),
        problem_lines=sum(1 for line in lines if line.condition is not LineCondition.ok),
    )


@router.get("/receipts", response_model=list[ReceiptOut])
async def list_receipts(
    problems_only: bool = False,
    limit: int = 50,
    user: User = Depends(require_receipt_reader),
    db: AsyncSession = Depends(get_db),
) -> list[ReceiptOut]:
    """Deliveries already checked in, newest first.

    `problems_only` is what supply chain and purchasing actually open this on:
    a delivery where everything arrived needs reading once, and a delivery
    missing three lines needs chasing.
    """
    limit = max(1, min(limit, 200))
    receipts = list(
        (
            await db.execute(
                select(GoodsReceipt).order_by(GoodsReceipt.received_at.desc()).limit(limit)
            )
        ).scalars().all()
    )
    out = [await _receipt_out(db, r) for r in receipts]
    if problems_only:
        out = [r for r in out if r.problem_lines]
    return out


def _receipt_lookup(source: str, shipment_id: uuid.UUID):
    """The one clause that says "the receipt against this purchase"."""
    if source == "basket":
        return GoodsReceipt.award_id == shipment_id
    return GoodsReceipt.offer_id == shipment_id


@router.get("/receipts/{source}/{shipment_id}", response_model=ReceiptOut)
async def get_receipt(
    source: str,
    shipment_id: uuid.UUID,
    user: User = Depends(require_receipt_reader),
    db: AsyncSession = Depends(get_db),
) -> ReceiptOut:
    if source not in ("offer", "basket"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    receipt = await db.scalar(select(GoodsReceipt).where(_receipt_lookup(source, shipment_id)))
    if receipt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This delivery hasn't been received yet")
    return await _receipt_out(db, receipt)


# --------------------------------------------------------------------- writes


async def _notify_purchasing_and_supply_chain(
    db: AsyncSession, tender: Tender, message: str
) -> None:
    """Supply chain and purchasing both hear about every delivery.

    Purchasing is reached twice over: `for_role=procurement` covers the buyers,
    and the purchasing manager is addressed by user id because their role is
    the generic `manager` - broadcasting to that role would ring every
    department manager in the company about a delivery that isn't theirs.
    """
    db.add(
        Notification(
            type=NotificationType.goods_received,
            tender_id=tender.id,
            message=message,
            for_role=UserRole.supply_chain,
        )
    )
    db.add(
        Notification(
            type=NotificationType.goods_received,
            tender_id=tender.id,
            message=message,
            for_role=UserRole.procurement,
        )
    )

    purchasing = await db.scalar(
        select(Department.id).where(Department.code == PURCHASING_CODE)
    )
    if purchasing is not None:
        manager_ids = set(
            (
                await db.execute(
                    select(User.id).where(
                        User.role == UserRole.manager, User.department_id == purchasing
                    )
                )
            ).scalars().all()
        )
        designated = await db.scalar(
            select(Department.manager).where(Department.id == purchasing)
        )
        if designated is not None:
            manager_ids.add(designated)
        for manager_id in manager_ids:
            db.add(
                Notification(
                    type=NotificationType.goods_received,
                    tender_id=tender.id,
                    message=message,
                    user_id=manager_id,
                )
            )


async def _shipment_lines(
    db: AsyncSession, source: str, shipment_id: uuid.UUID
) -> tuple[Tender, dict]:
    """The purchase's tender and its lines, keyed by the id the browser ticks.

    Raises the same refusals for both shapes, so an offer and a basket that
    aren't ready to be received fail identically.
    """
    if source == "offer":
        offer = await db.get(Offer, shipment_id)
        if offer is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Offer not found")
        if offer.status is not OfferStatus.approved:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "This purchase hasn't cleared every approval yet, so it isn't on its way to you",
            )
        tender = await db.get(Tender, offer.tender_id)
        lines = (
            await db.execute(select(OfferItem).where(OfferItem.offer_id == shipment_id))
        ).scalars().all()
    else:
        award = await db.get(Award, shipment_id)
        if award is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Basket not found")
        if award.status is not AwardStatus.approved or not award.active:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "This purchase hasn't cleared every approval yet, so it isn't on its way to you",
            )
        tender = await db.get(Tender, award.tender_id)
        lines = (
            await db.execute(select(AwardLine).where(AwardLine.award_id == shipment_id))
        ).scalars().all()

    if tender is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    return tender, {line.id: line for line in lines}


@router.post(
    "/{source}/{shipment_id}/receive",
    response_model=ReceiptOut,
    status_code=status.HTTP_201_CREATED,
)
async def receive_shipment(
    source: str,
    shipment_id: uuid.UUID,
    payload: ReceiptIn,
    user: User = Depends(require_warehouse),
    db: AsyncSession = Depends(get_db),
) -> ReceiptOut:
    """Check a delivery in, line by line.

    Every line of the purchase has to be accounted for. Not a convenience - a
    line nobody mentioned is indistinguishable from a line nobody looked at,
    and the difference between those two is the entire value of this record.
    The endpoint rejects a partial list rather than defaulting the rest to
    `ok`, which would quietly sign for goods that were never checked.

    Once written it stands. There is no edit: a receipt is what somebody
    recorded at the door at a particular moment, and a delivery note that can
    be revised afterwards is not evidence of anything. A correction is a
    conversation with supply chain, who can see the note that was filed.
    """
    if source not in ("offer", "basket"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    existing = await db.scalar(select(GoodsReceipt).where(_receipt_lookup(source, shipment_id)))
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This delivery was already received. Ask supply chain if something needs correcting.",
        )

    tender, items = await _shipment_lines(db, source, shipment_id)

    seen = [line.line_id for line in payload.lines]
    unknown = [str(i) for i in seen if i not in items]
    if unknown:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{len(unknown)} line(s) aren't part of this delivery",
        )
    if len(set(seen)) != len(seen):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The same line was checked in twice")
    missing = [items[i].name for i in items if i not in set(seen)]
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Every line has to be accounted for. Still unmarked: {', '.join(missing[:5])}"
            + (f" and {len(missing) - 5} more" if len(missing) > 5 else ""),
        )

    receipt = GoodsReceipt(
        offer_id=shipment_id if source == "offer" else None,
        award_id=shipment_id if source == "basket" else None,
        tender_id=tender.id,
        received_by=user.id,
        received_at=server_now(),
        notes=(payload.notes or "").strip() or None,
    )
    db.add(receipt)
    # id is assigned on INSERT, and the lines need it as a foreign key.
    await db.flush()

    problems = 0
    for line in payload.lines:
        item = items[line.line_id]
        ok = line.condition is LineCondition.ok
        if not ok:
            problems += 1
        db.add(
            GoodsReceiptLine(
                receipt_id=receipt.id,
                offer_item_id=item.id if source == "offer" else None,
                award_line_id=item.id if source == "basket" else None,
                name=item.name,
                ordered_quantity=float(item.quantity),
                condition=line.condition,
                # An `ok` line means "all of it arrived", so the ordered
                # quantity is the received one and the warehouse is not asked
                # to retype a number already on the screen.
                received_quantity=float(item.quantity) if ok else float(line.received_quantity),
                notes=(line.notes or "").strip() or None,
            )
        )

    what = "basket" if source == "basket" else "delivery"
    summary = (
        f"{tender.serial}: {what} checked in by {user.name}"
        + (
            f" - {problems} line(s) need attention"
            if problems
            else " - everything arrived as ordered"
        )
    )
    await _notify_purchasing_and_supply_chain(db, tender, summary)
    await log_audit(db, "Delivery Received", summary, user.name)

    await db.commit()
    await db.refresh(receipt)
    return await _receipt_out(db, receipt)
