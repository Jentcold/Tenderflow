import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import require_staff
from app.core.scope import require_purchasing
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

    rows = (
        await db.execute(
            select(OfferItem).where(OfferItem.offer_id.in_([o.id for o in offers]))
        )
    ).scalars().all()
    items: dict[uuid.UUID, list[OfferItem]] = {}
    for row in rows:
        items.setdefault(row.offer_id, []).append(row)

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
    user: User = Depends(require_purchasing("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> Submission:
    submission = await db.get(Submission, submission_id)
    if not submission:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Submission not found")

    was = submission.status
    submission.status = payload.status

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
