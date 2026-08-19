from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category import Category


async def category_by_slug(db: AsyncSession, slug: str | None) -> Category | None:
    if slug is None or not str(slug).strip():
        return None
    category = await db.scalar(select(Category).where(Category.slug == str(slug).strip()))
    if category is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"There is no category called '{slug}'"
        )
    if not category.active:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"The category '{category.name}' has been retired and can't be used for "
            f"anything new. Pick another, or ask an admin to reinstate it.",
        )
    return category


async def categories_by_slug(db: AsyncSession, slugs: list[str]) -> list[Category]:
    wanted = list(dict.fromkeys(s.strip() for s in slugs if s and s.strip()))
    if not wanted:
        return []
    found = list(
        (await db.execute(select(Category).where(Category.slug.in_(wanted)))).scalars().all()
    )
    missing = sorted(set(wanted) - {c.slug for c in found})
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"No such categor{'y' if len(missing) == 1 else 'ies'}: {', '.join(missing)}",
        )
    retired = [c.name for c in found if not c.active]
    if retired:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Retired and can't be assigned: {', '.join(retired)}",
        )
    return found
