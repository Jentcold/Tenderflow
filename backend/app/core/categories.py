"""Turning the slug an API caller sends into the category row it means.

Every write that carries a category - a tender, a template, a vendor - takes a
**slug** rather than an id. Ids are meaningless to read in a request log and
meaningless to type; a slug says what it is, and it is already what the browser
filters on, so nothing has to translate.

Retired categories are refused on the way *in* and accepted on the way *out*.
Something already filed under a retired category keeps reading correctly; filing
something new under one is a mistake, and almost always a stale page.
"""
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category import Category


async def category_by_slug(db: AsyncSession, slug: str | None) -> Category | None:
    """One category, or None when the caller sent nothing."""
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
    """Several, for a vendor. Order and duplicates in the request are ignored.

    An unknown slug is an error rather than something to skip: a vendor filed
    under three of the four categories they were meant to have looks correct on
    every screen and is quietly missing from one invite list.
    """
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
