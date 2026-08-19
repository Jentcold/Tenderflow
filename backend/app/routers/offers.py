import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import require_roles
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

# Everyone with a desk in the chain: the department manager who picks, the
# purchasing team and their manager who approve after them, and supply chain
# last. They don't all see the same set of tenders — see _check_department.
#
# Note this view stays anonymised even for purchasing, who are perfectly
# entitled to know who bid. It isn't hiding anything from them: /submissions
# has the names on it. It just means one payload shape, and no chance of the
# wrong one reaching the department manager.
CAN_SEE_OFFERS = require_roles("admin", "procurement", "manager", "supply_chain")


async def _is_purchasing_manager(db: AsyncSession, user: User) -> bool:
    """A manager whose own department is Purchasing.

    This is the "purchasing manager" of the flow. There is no role for it: the
    roles stay generic and seniority comes from the department, so adding a
    second purchasing manager is adding a user row.
    """
    if user.role != UserRole.manager or user.department_id is None:
        return False
    department = await db.get(Department, user.department_id)
    return department is not None and department.code == PURCHASING_CODE


async def _is_department_manager(db: AsyncSession, user: User) -> bool:
    """A manager of a raising department - the person who shortlists.

    Explicitly NOT the purchasing manager, who is a manager too but sits on the
    approval chain rather than at the receiving end of it. The two are told
    apart by department, which is where all seniority lives here.
    """
    return user.role == UserRole.manager and not await _is_purchasing_manager(db, user)


async def _department_manager_ids(db: AsyncSession, department_id: uuid.UUID | None) -> list[uuid.UUID]:
    """Everyone who manages one department, by user id.

    The inverse of `_managed_department_ids`. Notifications go to each by id
    rather than `for_role=manager`, which would ring every department manager
    in the company about a tender that is none of their business.

    Both sources are OR-ed for the same reason as the forward lookup: the
    general rule (`users.department_id` with role manager) and the older
    single-head pointer (`departments.manager`).
    """
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
    """Departments this user manages.

    Two sources, deliberately OR-ed: `users.department_id` where the person's
    role is manager (the general rule — a department can have several managers,
    and adding one is adding a row), and the older `departments.manager`
    pointer for the single designated head. Dropping the second would silently
    de-scope anyone set up before the column existed.
    """
    managed: set[uuid.UUID] = set()
    if user.role == UserRole.manager and user.department_id is not None:
        managed.add(user.department_id)
    managed.update(
        (await db.execute(select(Department.id).where(Department.manager == user.id))).scalars().all()
    )
    return managed


async def _check_department(db: AsyncSession, tender: Tender, user: User) -> None:
    """Department scoping applies to department managers, and to nobody else.

    Purchasing, their manager and supply chain all sit across the whole company
    — they approve every offer whichever department raised the tender, so
    scoping them by department would break the chain on its second step. Admin
    likewise.

    A department manager sees their own department's tenders. One attached to no
    department at all still sees everything: a known gap that keeps a
    half-configured install (and the demo data) usable. Attach them to a
    department and the scoping applies immediately.
    """
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
    """Every line for a page of offers in one query, rather than one per offer."""
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
    """Whether this caller may be told whose offer it is.

    Purchasing and admin: yes. They read every bid with the company attached
    while filtering, and they are the desk that has to spot one supplier
    holding three of the five offers.

    The department manager: no, and that is the whole point of the blind
    view - they are the one comparing on price.
    """
    return user.role in (UserRole.admin, UserRole.procurement)


async def _submission_info(
    db: AsyncSession, offers: list[Offer]
) -> dict[uuid.UUID, tuple[SubmissionStatus, str]]:
    """The check status of the bids a page of offers came from, in one query.

    Purchasing validate a *submission* - the envelope, its attachments, the
    company behind it - and that verdict now gates the offers inside it. Read
    per offer it would be one query a row; read here it is one for the page.
    """
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
    # (status, company_name) from _submission_info. None only if the submission
    # row went missing under us; the status is coerced rather than passed
    # through, so a null can't reach a non-optional field.
    info: tuple[SubmissionStatus, str] | None = None,
    # False for the department manager, whose whole view is blind. See
    # `_may_see_vendor`.
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
    """Every offer on a tender, cheapest first, with the bidder removed.

    Offers, not submissions: one vendor may have proposed three options and
    each stands on its own here, because one of them is what gets bought.

    Not paginated. A manager comparing offers needs the whole field in front of
    them — handing back page 1 of 3 would mean picking a winner from a subset,
    which is exactly the decision this endpoint exists to get right.
    """
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    await _check_department(db, tender, user)

    stmt = select(Offer).where(Offer.tender_id == tender_id)

    # No validation gate here any more.
    #
    # Purchasing used to mark each submission `validated` before its offers
    # could be compared, and this query enforced it. The step turned out to be
    # pure ceremony: purchasing were the ones filtering the offers anyway, two
    # screens apart, and the only thing the gate reliably produced was offers
    # that had silently vanished from the desk because nobody had ticked a box
    # on another page. `Submission.status` is still recorded and still shown -
    # it just doesn't decide what anyone can see.

    if not include_rejected:
        # A rejected offer is one purchasing already threw out. Showing it here
        # invites the manager to pick something that isn't on the table.
        stmt = stmt.where(Offer.status != OfferStatus.rejected)

    # Price ascending, then arrival. The tie-break isn't cosmetic: without it
    # two equal offers could swap places between requests and the letters would
    # follow them, so "we're going with Offer B" would stop meaning anything.
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
    user: User = Depends(require_roles("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> list[OfferOut]:
    """Purchasing's first pass: hand the department manager the offers worth reading.

    Bids no longer go straight to the manager. They arrive at `pending`, where
    only purchasing can see them, and this is where purchasing says which ones
    go up. Everything forwarded gets `forwarded_at` stamped and shows on the
    manager's screen; everything left out stays `pending` and doesn't.

    Withheld is not rejected. An offer left off this list can be forwarded five
    minutes later once purchasing has checked something. Turning one down for
    cause goes through `/offers/{id}/reject`, which asks for a reason - because
    that is a decision a vendor may one day ask about.

    The set is replaced on every call, so un-forwarding is sending the list
    again without that id. The replacement only reaches offers still in
    purchasing's hands, though: anything the manager has already shortlisted,
    or that has moved further up the chain, is left exactly where it is
    whether or not its id is in the list. They acted on it, and yanking it out
    from under them would leave a decision pointing at something that is no
    longer on the table. Reject it instead, with a reason.

    That tolerance is deliberate rather than lax. Refusing the whole call
    because one offer had moved on would mean a single shortlisted bid froze
    the forwarded set for every other offer on the tender.

    Purchasing works across the whole company, so there is no department check
    here - whichever department raised the tender, this is their desk.
    """
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
        # Past the manager's desk: not ours to move any more, in either
        # direction. Counted so the audit line says the set wasn't fully
        # purchasing's to set.
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
                    # No vendor name: the manager's whole view is anonymised,
                    # and a notification is as good a place to leak one as any.
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

    # What the manager can now see. Rejected offers are left out for the same
    # reason the list endpoint leaves them out: showing what was already thrown
    # away invites somebody to pick it.
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
    """The department manager's decision: up to three offers, best first.

    Not "pick the winner". The manager says which offers they would accept and
    in what order; purchasing commits to one of them at the next desk. Three
    because a first choice that falls over shouldn't send the whole tender back
    round the loop, and a longer list stops being a preference.

    The whole shortlist is replaced on every call, so re-ranking is one request
    and an empty list withdraws the decision. The manager still never learns
    whose offers these are — the notification to purchasing names the tender,
    not the vendor, and the response is the same anonymised shape as the list.
    """
    tender = await db.get(Tender, payload.tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    await _check_department(db, tender, user)

    # Every offer on the tender, so the ones dropping off the shortlist are
    # cleared in the same pass as the ones joining it.
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
        # The manager can't rank what purchasing hasn't sent up. The list
        # endpoint already hides these, so reaching one means an id that came
        # from somewhere else.
        if candidate.forwarded_at is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "That offer hasn't been sent to you by purchasing yet",
            )

    # An offer that has already cleared purchasing is not something to quietly
    # demote — someone signed it off, and further down the chain it may already
    # be bought. Changing your mind at that point means rejecting it first, so
    # the rejection is recorded with a reason and the desks that approved it
    # find out.
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

    # **The shortlist is sealed once it is sent.** It used to be replaceable at
    # will, which meant a manager could re-rank while purchasing was already
    # working through their list - and a preference that can be revised at any
    # moment isn't a decision, it's a mood.
    #
    # It reopens one way: purchasing sends it back (POST /offers/send-back)
    # because none of the ranked offers will do. That leaves a reason on the
    # record, which "changed my mind" never did.
    if any(o.status == OfferStatus.selected for o in all_offers):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "You've already sent your list on this tender. If it needs changing, ask "
            "purchasing to send it back to you.",
        )

    chosen = set(payload.offer_ids)
    for offer in all_offers:
        # Only shortlisted rows are touched. A rejected offer keeps its status
        # and its reason — clearing it here would resurrect something a later
        # desk deliberately threw out.
        if offer.status == OfferStatus.selected and offer.id not in chosen:
            # Back to `forwarded`, not `pending`: purchasing put it in front of
            # this manager and taking it off the shortlist doesn't undo that.
            # Dropping it to `pending` would make it disappear from the screen
            # they are re-ranking on.
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

    # The tender's award fields stay empty here. A shortlist is a preference,
    # not an award — they are written when an offer clears the last approval,
    # so `awarded_vendor_name` never names someone nobody has committed to.
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
        # No vendor name in the audit line either — the same people read it.
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
    user: User = Depends(require_roles("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> list[OfferOut]:
    """Hand a shortlist back to the department manager and ask for another.

    The manager's list is sealed the moment they send it, so this is the only
    way it reopens. It exists because the sealed list would otherwise be a
    deadlock: all three ranked offers turn out to be unbuyable - the vendor
    withdrew, the price expired, the specification was missed on closer reading
    - and nobody could do anything about it except reject offers one at a time
    until the tender had nothing left on it.

    Every shortlisted offer drops back to `forwarded`. **None of them is
    rejected**: they may well be ranked again, and marking them rejected would
    mean inventing a verdict on offers purchasing hasn't actually judged. What
    purchasing is saying here is "not this ordering", not "not these offers".

    The reason is required and goes to the manager. Sending a list back with no
    explanation invites them to hand back the same list.

    Refuses once purchasing has committed to one of the shortlist: at that
    point an offer is walking the approval chain, and taking the list apart
    underneath it would strand whatever the next desk is holding. Reject that
    offer first - which is a decision with a reason on it, as it should be.
    """
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

    # What the manager can now see. Rejected offers are left out for the same
    # reason the list endpoint leaves them out: showing what was already thrown
    # away invites somebody to pick it.
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


# --------------------------------------------------------- the approval chain --
#
# After the department manager picks, an offer walks three desks in order:
# purchasing -> the purchasing manager -> supply chain. Each endpoint checks the
# offer is sitting at its own step, so calling the last one first doesn't skip
# the first two.

async def _purchasing_manager_ids(db: AsyncSession) -> list[uuid.UUID]:
    """Everyone who is a manager of the Purchasing department.

    A list, not one id: there can be several, which is the whole reason
    seniority lives on the department rather than in a role. Notifications go to
    each by user id — addressing them `for_role=manager` would ring every
    department manager in the company.
    """
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
    """Tell the department manager when purchasing went outside their ranking.

    The shortlist is a guide and purchasing may depart from it, but departing
    from it silently would make the ranking pointless: the manager would have
    no way of knowing their preference wasn't followed, and no chance to say
    something before the purchase completes. Visibility is what makes the
    latitude safe.

    `never_asked` is the stronger version of the same thing: purchasing took an
    offer without sending the manager a shortlist at all. That is allowed - see
    `purchasing_approve` - and it is exactly the case where the manager most
    needs telling, because there is no shortlist of theirs to notice was
    ignored.

    Nothing is sent when purchasing took a ranked offer - that is the expected
    outcome and a notification for it would be noise.
    """
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
    """Drop the rest of the manager's shortlist once purchasing has chosen.

    The manager hands down up to three offers in preference order; purchasing
    takes one. The others go back to `forwarded` rather than `rejected` — they
    weren't turned down on their merits, they simply weren't the one bought, and
    marking them rejected would mean inventing a reason nobody gave.
    """
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
    """Write the award onto the tender, once an offer has cleared every desk.

    Deliberately here and not at shortlist time: until this point nobody has
    committed to anything, and a tender carrying `awarded_vendor_name` for an
    offer still working its way up the chain would be read as bought.

    Returns the queued vendor emails for the caller to dispatch in the
    background — nothing touches the network inside the request.
    """
    tender.supply_chain_approved = True
    tender.supply_chain_rejected = False
    tender.supply_chain_reviewed_at = server_now()
    tender.supply_chain_reviewed_by = user.id
    tender.status = TenderStatus.awarded

    tender.awarded_offer_id = offer.id
    # The submission the offer came from, kept for the award emails that have to
    # address a company. The department manager's own view never reads it.
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
    user: User = Depends(require_roles("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> OfferOut:
    """Purchasing commits to ONE offer on the tender.

    Usually one the department manager shortlisted, and that is the normal
    path: the manager hands down up to three in preference order and this is
    where the choice is actually made. Whichever is approved here, the rest of
    the shortlist is released back to `forwarded`.

    But **the shortlist is a guide, not a gate**. Purchasing may take any
    forwarded offer, including one the manager never ranked. The manager is
    saying what they want; purchasing knows the market, and a different vendor
    with the same item at the same price shouldn't cost a whole extra round
    trip through a review that would say yes anyway. Going off-list is recorded
    as such on the audit trail and the manager is told, so the decision is
    visible rather than silent - that is the safeguard, not a refusal.

    **And the manager can be skipped entirely.** A `pending` offer - one never
    forwarded to anybody - can be approved straight from here. Sometimes one
    bid is plainly better than the rest on every line, and routing it through a
    shortlist-and-rank round trip to hear "yes, that one" is ceremony that only
    costs days. The manager is told it happened, and `forwarded_at` is stamped
    on the way past so the offer still appears on their screen: they should be
    able to see what was bought on their department's request, even though they
    were not asked first.

    Purchasing works across the whole company, so there is no department check
    here — whichever department raised the tender, this is their desk.

    On an **urgent** tender this is the last gate: the purchasing manager and
    supply chain are notified but not waited for. That is the only thing the
    urgent flag does, and it is the manager's flag to set, never purchasing's.
    """
    offer, tender = await _load_for_decision(
        offer_id, (OfferStatus.selected, OfferStatus.forwarded, OfferStatus.pending), db
    )
    # Ranked by the manager, taken over their heads, or bought without asking
    # them at all. Read before _commit_to_one, which clears the ranks off the
    # siblings.
    never_asked = offer.status is OfferStatus.pending
    off_shortlist = offer.status is OfferStatus.forwarded

    if never_asked:
        # Stamped so the manager's offers screen - which filters on
        # `forwarded_at IS NOT NULL` - still shows them the offer that was
        # bought on their request. Skipping their approval is the point; hiding
        # the result from them afterwards is not.
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
        # After the commit: the award stands whether or not the mail server is
        # reachable, and a failure lands on the email log for a resend.
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
        # Nobody is set up to take the next step, so say so on the audit trail
        # rather than letting the offer sit at a desk that doesn't exist.
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
    """The purchasing manager's decision — the manager of the Purchasing
    department, across every tender regardless of who raised it.

    Guarded on the department rather than on a role: a department manager who
    wandered in here would otherwise be approving the purchase they themselves
    requested.
    """
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
    """The last approval. After this the offer is bought: finance pays it and
    the warehouse receives against its item list.

    This is also where the tender itself becomes `awarded` and the vendors are
    emailed — the win to whoever's offer it was, the polite no to everyone else.
    """
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
    """Turn an offer down at whichever desk it is currently sitting at.

    One endpoint rather than three, because the check is the same each time:
    you may reject an offer only at the step you are the approver for. The step
    it died at is kept in `rejected_at_stage` — "rejected" on its own can't say
    whether supply chain killed it or purchasing never let it out of the room.
    """
    offer = await db.get(Offer, offer_id)
    if not offer:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Offer not found")
    tender = await db.get(Tender, offer.tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    # Who owns the desk this offer is standing at.
    if offer.status == OfferStatus.pending:
        # Purchasing's first pass. Throwing a bid out here is part of the job -
        # it misses the specification, it's a duplicate, the vendor withdrew -
        # and doing it with a reason is better than silently never forwarding
        # it, which leaves nobody able to say what happened to it.
        allowed = user.role in (UserRole.admin, UserRole.procurement)
        desk = "purchasing, who are still filtering"
    elif offer.status == OfferStatus.forwarded:
        # With the department manager, who can turn one down outright instead
        # of ranking it.
        managed = await _managed_department_ids(db, user)
        allowed = user.role == UserRole.admin or (
            await _is_department_manager(db, user)
            # An empty set means a manager attached to no department, who sees
            # everything. Same leniency as _check_department, deliberately: a
            # half-configured install stays usable, and attaching them to a
            # department turns the scoping on straight away.
            and (not managed or tender.department_id in managed)
        )
        desk = "the department manager"
    elif offer.status == OfferStatus.selected:
        allowed = user.role in (UserRole.admin, UserRole.procurement)
        desk = "purchasing"
    elif offer.status == OfferStatus.purchasing_ok:
        # The purchasing manager's desk to refuse. Purchasing may also pull the
        # offer back out: it is their own commitment, nothing downstream has
        # signed anything yet, and making them wait for a refusal from the next
        # desk to undo their own decision helps nobody.
        allowed = (
            user.role in (UserRole.admin, UserRole.procurement)
            or await _is_purchasing_manager(db, user)
        )
        desk = "the purchasing manager"
    elif offer.status == OfferStatus.purchasing_manager_ok:
        # Supply chain's desk to refuse - a delivery window that doesn't work,
        # a lead time nobody can live with. Purchasing can still withdraw here
        # for the same reason as above: supply chain has not approved yet, so
        # there is no signed-off purchase to strand.
        allowed = user.role in (UserRole.admin, UserRole.supply_chain, UserRole.procurement)
        desk = "supply chain"
    elif offer.status == OfferStatus.approved:
        # Withdrawing a completed purchase, not refusing one - and this is
        # **purchasing's** call, not supply chain's.
        #
        # It used to be supply chain's, on the reasoning that whoever signed it
        # can unsign it. But withdrawing is only ever half a job: something else
        # has to be bought instead, and re-awarding is purchasing's work - they
        # hold the vendor relationships and they are the ones who will place the
        # replacement order. Splitting the two across desks meant a cancellation
        # could sit withdrawn with nobody owning what came next.
        #
        # Supply chain still refuses at their own step above, which is where a
        # delivery objection belongs. Once they have approved, they raise it
        # with purchasing, who withdraw and re-award.
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
    # It is off the shortlist by definition now, and leaving a rank on it would
    # have the manager's "second choice" pointing at something nobody can buy.
    offer.manager_rank = None

    # The tender stops pointing at an offer that was turned down, so the
    # department manager can shortlist again without a stale award hanging off
    # the row. Withdrawing an approved offer also walks the tender back out of
    # `awarded` — it isn't, any more, and leaving the status would have finance
    # and the warehouse still working against a purchase that was cancelled.
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

