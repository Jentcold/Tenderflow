"""Staff-facing vendor directory.

Read-only on purpose: vendors own their own details through
`PATCH /api/vendor/me`, and admins manage the underlying accounts (activate,
deactivate, reset) through /api/users. Nothing here lets staff rewrite a
company's particulars behind its back.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import Select, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_staff
from app.core.pagination import Page, Pagination, count_rows
from app.database import get_db
from app.models.user import User
from app.models.category import Category
from app.models.vendor import Vendor
from app.schemas.vendor import VendorWithAccountOut

router = APIRouter(prefix="/vendors", tags=["vendors"], dependencies=[Depends(require_staff)])


def _with_account(vendor: Vendor, user: User) -> VendorWithAccountOut:
    return VendorWithAccountOut(
        **{f: getattr(vendor, f) for f in VendorWithAccountOut.model_fields if not f.startswith("account_")},
        account_username=user.username,
        account_email=user.email,
        account_name=user.name,
        account_status=user.status,
    )


@router.get("", response_model=Page[VendorWithAccountOut])
async def list_vendors(
    search: str | None = Query(default=None, description="Matches company name, tax ID or contact email"),
    category: Category | None = Query(default=None),
    page: Pagination = Depends(),
    db: AsyncSession = Depends(get_db),
) -> Page[VendorWithAccountOut]:
    stmt: Select = select(Vendor, User).join(User, User.id == Vendor.user_id).order_by(Vendor.company_name)
    if category:
        stmt = stmt.where(Vendor.vendor_category == category)
    if search:
        pattern = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(
                Vendor.company_name.ilike(pattern),
                Vendor.tax_id.ilike(pattern),
                Vendor.contact_email.ilike(pattern),
            )
        )

    # paginate() unwraps scalars, which would drop the joined User, so the
    # window is applied here and only the count is borrowed.
    total = await count_rows(db, stmt)
    rows = (await db.execute(stmt.limit(page.limit).offset(page.offset))).all()

    return Page[VendorWithAccountOut](
        items=[_with_account(vendor, user) for vendor, user in rows],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/{vendor_id}", response_model=VendorWithAccountOut)
async def get_vendor(vendor_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> VendorWithAccountOut:
    row = (
        await db.execute(
            select(Vendor, User).join(User, User.id == Vendor.user_id).where(Vendor.id == vendor_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vendor not found")
    vendor, user = row
    return _with_account(vendor, user)
