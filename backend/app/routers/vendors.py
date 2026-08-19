"""The vendor directory, and who gets asked to bid.

One directory. A vendor is a record purchasing creates — a company we buy from
— not an account. They never log in; they reach a tender through a link
addressed to them, and everything about them lives here.

Two histories are kept apart deliberately: **what they have quoted**
(`/submissions`) and **what we actually bought from them** (`/awards`). Reading
the second out of the first means walking every bid to find the winning lines,
which is exactly the thing you don't want to do when a vendor falls over and
the purchase has to move.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.audit import log_audit
from app.core.deps import require_roles, require_staff
from app.core.pagination import Page, Pagination, count_rows
from app.database import get_db
from app.models.award import Award, AwardLine, AwardStatus
from app.core.categories import categories_by_slug
from app.models.category import Category, vendor_categories
from app.models.offer import Offer, OfferItem
from app.models.submission import Submission
from app.models.tender import Tender
from app.models.user import User
from app.models.vendor import TenderVendorInvite, Vendor
from app.schemas.vendor import (
    VendorAwardOut,
    VendorCreate,
    VendorOut,
    VendorSubmissionOut,
    VendorUpdate,
)

router = APIRouter(prefix="/vendors", tags=["vendors"], dependencies=[Depends(require_staff)])

# Purchasing keeps the directory. Everyone else on staff can read it.
CAN_EDIT = require_roles("admin", "procurement")


def _out(vendor: Vendor) -> VendorOut:
    return VendorOut(
        **{f: getattr(vendor, f) for f in VendorOut.model_fields if f != "needs_other_channel"},
        needs_other_channel=not (vendor.contact_email or "").strip(),
    )


async def _get_or_404(db: AsyncSession, vendor_id: uuid.UUID) -> Vendor:
    vendor = await db.get(Vendor, vendor_id)
    if not vendor:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vendor not found")
    return vendor


@router.get("", response_model=Page[VendorOut])
async def list_vendors(
    search: str | None = Query(default=None, description="Matches company name, code, tax ID or email"),
    category: str | None = Query(default=None, description="Category slug"),
    active: bool | None = Query(default=None),
    page: Pagination = Depends(),
    db: AsyncSession = Depends(get_db),
) -> Page[VendorOut]:
    stmt: Select = select(Vendor).order_by(Vendor.company_name)
    if category:
        # ANY of the vendor's categories, not "their category" - a company
        # filed under both goods and services belongs in both lists.
        stmt = stmt.where(
            Vendor.id.in_(
                select(vendor_categories.c.vendor_id)
                .join(Category, Category.id == vendor_categories.c.category_id)
                .where(Category.slug == category)
            )
        )
    if active is not None:
        stmt = stmt.where(Vendor.active.is_(active))
    if search:
        pattern = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(
                Vendor.company_name.ilike(pattern),
                Vendor.code.ilike(pattern),
                Vendor.tax_id.ilike(pattern),
                Vendor.contact_email.ilike(pattern),
            )
        )

    total = await count_rows(db, stmt)
    rows = (await db.execute(stmt.limit(page.limit).offset(page.offset))).scalars().all()
    return Page[VendorOut](
        items=[_out(v) for v in rows], total=total, limit=page.limit, offset=page.offset
    )


@router.post("", response_model=VendorOut, status_code=status.HTTP_201_CREATED)
async def create_vendor(
    payload: VendorCreate, user: User = Depends(CAN_EDIT), db: AsyncSession = Depends(get_db)
) -> VendorOut:
    """Purchasing adds a company to the directory. No account is created."""
    existing = await db.scalar(
        select(Vendor).where(func.lower(Vendor.company_name) == payload.company_name.lower())
    )
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{existing.company_name} is already in the directory as {existing.code}",
        )

    vendor = Vendor(
        company_name=payload.company_name,
        categories=await categories_by_slug(db, payload.categories),
        contact_email=payload.contact_email,
        contact_phone=payload.contact_phone,
        tax_id=payload.tax_id,
        address=payload.address,
        notes=payload.notes,
        created_by=user.id,
    )
    db.add(vendor)
    await db.flush()
    await log_audit(
        db, "Vendor Added", f"{vendor.company_name} ({vendor.code})", user.name
    )
    await db.commit()
    await db.refresh(vendor)
    return _out(vendor)


@router.get("/{vendor_id}", response_model=VendorOut)
async def get_vendor(vendor_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> VendorOut:
    return _out(await _get_or_404(db, vendor_id))


@router.patch("/{vendor_id}", response_model=VendorOut)
async def update_vendor(
    vendor_id: uuid.UUID,
    payload: VendorUpdate,
    user: User = Depends(CAN_EDIT),
    db: AsyncSession = Depends(get_db),
) -> VendorOut:
    vendor = await _get_or_404(db, vendor_id)
    fields = payload.model_dump(exclude_unset=True)
    # Categories are a relationship, not a column, so they cannot ride the
    # generic setattr loop - that would put a list of slug strings where a list
    # of rows belongs. Omitted means "leave them alone"; sent means "this is
    # now the whole set", the same shape as the invite list and the basket.
    slugs = fields.pop("categories", None)
    if slugs is not None:
        vendor.categories = await categories_by_slug(db, slugs)
    for field, value in fields.items():
        setattr(vendor, field, value)
    await log_audit(db, "Vendor Updated", f"{vendor.company_name} ({vendor.code})", user.name)
    await db.commit()
    await db.refresh(vendor)
    return _out(vendor)


@router.get("/{vendor_id}/submissions", response_model=list[VendorSubmissionOut])
async def vendor_submissions(
    vendor_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> list[VendorSubmissionOut]:
    """Everything this vendor has ever quoted.

    The log you read when an award has to be withdrawn and moved: it shows who
    else was in the running and what they said, without hunting through
    tenders one at a time.
    """
    await _get_or_404(db, vendor_id)
    rows = (
        await db.execute(
            select(Submission, Tender)
            .join(Tender, Tender.id == Submission.tender_id)
            .where(Submission.vendor_id == vendor_id)
            .order_by(Submission.submitted_at.desc())
        )
    ).all()
    if not rows:
        return []

    submission_ids = [s.id for s, _ in rows]
    offer_counts = dict(
        (
            await db.execute(
                select(Offer.submission_id, func.count())
                .where(Offer.submission_id.in_(submission_ids))
                .group_by(Offer.submission_id)
            )
        ).all()
    )
    # How many lines from each bid were actually bought. Counted from the award
    # lines rather than from any status on the offer, because a basket can take
    # one line out of an offer and leave the other three.
    won = dict(
        (
            await db.execute(
                select(Offer.submission_id, func.count())
                .select_from(AwardLine)
                .join(OfferItem, OfferItem.id == AwardLine.offer_item_id)
                .join(Offer, Offer.id == OfferItem.offer_id)
                .join(Award, Award.id == AwardLine.award_id)
                .where(
                    Offer.submission_id.in_(submission_ids),
                    Award.active.is_(True),
                    Award.status != AwardStatus.rejected,
                )
                .group_by(Offer.submission_id)
            )
        ).all()
    )

    return [
        VendorSubmissionOut(
            submission_id=s.id,
            tender_id=t.id,
            tender_serial=t.serial,
            tender_name=t.name,
            total_amount=float(s.total_amount),
            currency=t.currency,
            submitted_at=s.submitted_at,
            offer_count=offer_counts.get(s.id, 0),
            won_lines=won.get(s.id, 0),
        )
        for s, t in rows
    ]


@router.get("/{vendor_id}/awards", response_model=list[VendorAwardOut])
async def vendor_awards(
    vendor_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> list[VendorAwardOut]:
    """What we have actually bought from this vendor, line by line.

    Separate from the bid log above: this is the finished business. A tender
    bought across three vendors appears on all three of their pages, showing
    only the lines each of them supplied.
    """
    await _get_or_404(db, vendor_id)
    rows = (
        await db.execute(
            select(AwardLine, Award, Tender)
            .join(Award, Award.id == AwardLine.award_id)
            .join(Tender, Tender.id == Award.tender_id)
            .where(
                AwardLine.vendor_id == vendor_id,
                Award.active.is_(True),
                Award.status != AwardStatus.rejected,
            )
            .order_by(Award.created_at.desc(), AwardLine.position)
        )
    ).all()
    return [
        VendorAwardOut(
            award_line_id=line.id,
            tender_id=tender.id,
            tender_serial=tender.serial,
            tender_name=tender.name,
            name=line.name,
            quantity=float(line.quantity),
            unit=line.unit,
            unit_price=float(line.unit_price),
            line_total=line.line_total,
            currency=award.currency,
            award_status=award.status.value,
            awarded_at=award.supply_chain_reviewed_at or award.submitted_at,
        )
        for line, award, tender in rows
    ]
