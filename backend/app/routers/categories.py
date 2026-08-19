import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import require_internal, require_roles
from app.database import get_db
from app.models.category import Category, slugify, vendor_categories
from app.models.tender import Tender
from app.models.tender_template import TenderTemplate
from app.models.user import User
from app.schemas.category import CategoryCreate, CategoryOut, CategoryUpdate

router = APIRouter(prefix="/categories", tags=["categories"])

CAN_EDIT = require_roles("admin")


async def _vendor_counts(db: AsyncSession) -> dict[uuid.UUID, int]:
    rows = await db.execute(
        select(vendor_categories.c.category_id, func.count())
        .group_by(vendor_categories.c.category_id)
    )
    return {row[0]: row[1] for row in rows}


def _to_out(category: Category, counts: dict[uuid.UUID, int]) -> CategoryOut:
    return CategoryOut(
        id=category.id,
        name=category.name,
        slug=category.slug,
        active=category.active,
        position=category.position,
        vendor_count=counts.get(category.id, 0),
    )


@router.get("", response_model=list[CategoryOut])
async def list_categories(
    include_retired: bool = Query(
        default=False, description="Include categories that have been retired"
    ),
    user: User = Depends(require_internal),
    db: AsyncSession = Depends(get_db),
) -> list[CategoryOut]:
    stmt = select(Category).order_by(Category.position.asc(), Category.name.asc())
    if not include_retired:
        stmt = stmt.where(Category.active.is_(True))
    categories = list((await db.execute(stmt)).scalars().all())
    counts = await _vendor_counts(db)
    return [_to_out(c, counts) for c in categories]


@router.post("", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
async def create_category(
    payload: CategoryCreate,
    user: User = Depends(CAN_EDIT),
    db: AsyncSession = Depends(get_db),
) -> CategoryOut:
    name = payload.name.strip()
    slug = slugify(name)

    clash = await db.scalar(
        select(Category).where((Category.slug == slug) | (func.lower(Category.name) == name.lower()))
    )
    if clash is not None:
        if not clash.active:
            clash.active = True
            clash.name = name
            clash.position = payload.position
            await log_audit(db, "Category Reinstated", f"{clash.name}", user.name)
            await db.commit()
            await db.refresh(clash)
            return _to_out(clash, await _vendor_counts(db))
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"There is already a category called {clash.name}"
        )

    category = Category(name=name, slug=slug, position=payload.position, active=True)
    db.add(category)
    await log_audit(db, "Category Created", f"{name} ({slug})", user.name)
    await db.commit()
    await db.refresh(category)
    return _to_out(category, await _vendor_counts(db))


@router.patch("/{category_id}", response_model=CategoryOut)
async def update_category(
    category_id: uuid.UUID,
    payload: CategoryUpdate,
    user: User = Depends(CAN_EDIT),
    db: AsyncSession = Depends(get_db),
) -> CategoryOut:
    category = await db.get(Category, category_id)
    if category is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found")

    changed = []
    if payload.name is not None and payload.name != category.name:
        clash = await db.scalar(
            select(Category).where(
                func.lower(Category.name) == payload.name.lower(), Category.id != category.id
            )
        )
        if clash is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, f"There is already a category called {clash.name}"
            )
        changed.append(f"{category.name} -> {payload.name}")
        category.name = payload.name
    if payload.position is not None and payload.position != category.position:
        changed.append(f"position {category.position} -> {payload.position}")
        category.position = payload.position
    if payload.active is not None and payload.active != category.active:
        changed.append("reinstated" if payload.active else "retired")
        category.active = payload.active

    if changed:
        await log_audit(db, "Category Updated", f"{category.slug}: {'; '.join(changed)}", user.name)
    await db.commit()
    await db.refresh(category)
    return _to_out(category, await _vendor_counts(db))


@router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(
    category_id: uuid.UUID,
    user: User = Depends(CAN_EDIT),
    db: AsyncSession = Depends(get_db),
) -> None:
    category = await db.get(Category, category_id)
    if category is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found")

    used_by = []
    if await db.scalar(select(Tender.id).where(Tender.category_id == category_id).limit(1)):
        used_by.append("tenders")
    if await db.scalar(
        select(TenderTemplate.id).where(TenderTemplate.category_id == category_id).limit(1)
    ):
        used_by.append("templates")
    if await db.scalar(
        select(vendor_categories.c.vendor_id)
        .where(vendor_categories.c.category_id == category_id)
        .limit(1)
    ):
        used_by.append("vendors")

    if used_by:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"This category is in use by {', '.join(used_by)}. Retire it instead - it will "
            f"leave the pickers, and everything already filed under it keeps reading correctly.",
        )

    await log_audit(db, "Category Deleted", f"{category.name} ({category.slug})", user.name)
    await db.delete(category)
    await db.commit()
