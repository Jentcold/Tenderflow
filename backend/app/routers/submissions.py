import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import require_roles, require_staff
from app.core.labels import offer_label
from app.core.pagination import Page, Pagination, paginate
from app.database import get_db
from app.models.offer import Offer, OfferItem, OfferStatus
from app.models.submission import Submission, SubmissionStatus
from app.models.tender_item import TenderItem
from app.models.user import User
from app.schemas.submission import (
    SubmissionOfferBrief,
    SubmissionOfferLine,
    SubmissionOut,
    SubmissionStatusUpdate,
)
from app.services.storage_service import UPLOAD_DIR

# Staff-only. Vendors are authenticated users too, so gating on
# get_current_user alone would have let them read this router.
router = APIRouter(prefix="/submissions", tags=["submissions"], dependencies=[Depends(require_staff)])


@router.get("", response_model=Page[SubmissionOut])
async def list_submissions(
    tender_id: uuid.UUID | None = Query(default=None),
    vendor_id: uuid.UUID | None = Query(default=None, description="Only bids from this registered vendor"),
    status_filter: SubmissionStatus | None = Query(default=None, alias="status"),
    page: Pagination = Depends(),
    db: AsyncSession = Depends(get_db),
) -> Page[SubmissionOut]:
    stmt = select(Submission).order_by(Submission.submitted_at.desc())
    if tender_id:
        stmt = stmt.where(Submission.tender_id == tender_id)
    if vendor_id:
        stmt = stmt.where(Submission.vendor_id == vendor_id)
    if status_filter is not None:
        stmt = stmt.where(Submission.status == status_filter)

    submissions, total = await paginate(db, stmt, page)
    return Page[SubmissionOut](
        items=[SubmissionOut.model_validate(s) for s in submissions],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/files/{stored_path:path}")
async def download_submission_file(stored_path: str) -> FileResponse:
    """stored_path looks like '<tender_id>/<uuid>_<original_filename>', taken straight from
    a submission's `files` list. Requires staff auth (unlike the vendor upload endpoint)."""
    path = UPLOAD_DIR / stored_path
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    original_name = path.name.split("_", 1)[-1]
    return FileResponse(path, filename=original_name)


@router.get("/{submission_id}", response_model=SubmissionOut)
async def get_submission(submission_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> Submission:
    submission = await db.get(Submission, submission_id)
    if not submission:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Submission not found")
    return submission


@router.get("/{submission_id}/offers", response_model=list[SubmissionOfferBrief])
async def list_submission_offers(
    submission_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> list[SubmissionOfferBrief]:
    """What a vendor actually proposed, summarised, for the validation step.

    A bid is an envelope: one company may have put three different answers in
    it. Validating it without seeing them means waving through paperwork, so
    this is what the Submissions page opens - the offers by name, and which of
    them substitute something for what was asked for.

    Not gated on the submission's own status, unlike the offers desk. This is
    the endpoint that decides that status, so it has to be readable first.

    Ordered by arrival, not by price. The lettering has to stay put while
    somebody reads it, and it is a different sequence from the offers desk's
    (which sorts by price across the whole tender) on purpose: these letters
    are positions inside one bid, not the tender-wide ranking.
    """
    submission = await db.get(Submission, submission_id)
    if not submission:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Submission not found")

    offers = list(
        (
            await db.execute(
                select(Offer)
                .where(Offer.submission_id == submission_id)
                .order_by(Offer.created_at.asc())
            )
        ).scalars().all()
    )
    if not offers:
        return []

    # One query for every line, then grouped in memory - the alternative is a
    # query per offer, and a vendor filing ten of them shouldn't cost ten trips.
    rows = (
        await db.execute(
            select(OfferItem).where(OfferItem.offer_id.in_([o.id for o in offers]))
        )
    ).scalars().all()
    items: dict[uuid.UUID, list[OfferItem]] = {}
    for row in rows:
        items.setdefault(row.offer_id, []).append(row)

    # The tender's own list, to work out what each offer left unpriced. Read
    # once for the whole page rather than per offer.
    requirements = (
        await db.execute(
            select(TenderItem)
            .where(TenderItem.tender_id == submission.tender_id)
            .order_by(TenderItem.position)
        )
    ).scalars().all()

    out = []
    for index, offer in enumerate(offers):
        lines = items.get(offer.id, [])
        priced = {i.tender_item_id for i in lines if i.tender_item_id is not None}
        missing = [r.name for r in requirements if r.id not in priced]
        out.append(
            SubmissionOfferBrief(
                id=offer.id,
                label=offer_label(index),
                title=offer.title,
                total_amount=float(offer.total_amount),
                currency=offer.currency,
                covers_items=len({i.tender_item_id for i in lines if i.tender_item_id is not None}),
                replacement_items=sum(1 for i in lines if i.is_replacement),
                replacements=[i.name for i in lines if i.is_replacement],
                missing_items=len(missing),
                missing=missing,
                items=[
                    SubmissionOfferLine(
                        id=i.id,
                        tender_item_id=i.tender_item_id,
                        is_replacement=i.is_replacement,
                        name=i.name,
                        specs=i.specs,
                        notes=i.notes,
                        quantity=float(i.quantity),
                        unit=i.unit,
                        unit_price=float(i.unit_price),
                        line_total=i.line_total,
                    )
                    for i in sorted(lines, key=lambda x: x.position)
                ],
            )
        )
    return out


@router.patch("/{submission_id}/status", response_model=SubmissionOut)
async def update_submission_status(
    submission_id: uuid.UUID,
    payload: SubmissionStatusUpdate,
    user: User = Depends(require_roles("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> Submission:
    submission = await db.get(Submission, submission_id)
    if not submission:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Submission not found")

    was = submission.status
    submission.status = payload.status

    # Validating a bid is what lets its offers be sent to the department
    # manager (see the gate in POST /offers/forward), so taking the validation
    # away has to pull them back. Otherwise "rejected" would sit on the
    # submission while the manager carried on ranking what was inside it.
    #
    # Only offers still sitting with the manager are pulled: anything already
    # shortlisted or further up the chain has been acted on, and yanking it out
    # would strand that decision. Those are named in the audit line so the
    # person un-validating can see what they now have to reject by hand.
    pulled = stranded = 0
    if was == SubmissionStatus.validated and payload.status != SubmissionStatus.validated:
        offers = (
            await db.execute(select(Offer).where(Offer.submission_id == submission.id))
        ).scalars().all()
        for offer in offers:
            if offer.status == OfferStatus.rejected:
                continue
            if offer.status == OfferStatus.forwarded:
                offer.status = OfferStatus.pending
                offer.forwarded_at = None
                offer.forwarded_by = None
                pulled += 1
            elif offer.forwarded_at is not None:
                stranded += 1

    await log_audit(
        db,
        f"Submission {payload.status.value.capitalize()}",
        f"{submission.company_name} submission {payload.status.value}"
        + (f"; {pulled} offer(s) taken off the manager's list" if pulled else "")
        + (
            f"; {stranded} offer(s) already shortlisted or approved and left in place - "
            f"reject them if they should not stand"
            if stranded
            else ""
        ),
        user.name,
    )
    await db.commit()
    await db.refresh(submission)
    return submission
