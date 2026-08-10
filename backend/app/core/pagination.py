"""Shared `?limit=&offset=` paging for list endpoints.

Every list route returns a `Page` envelope rather than a bare array, so the
caller always gets `total` back and can render "showing 50 of 1,284" without
a second request.
"""
from typing import Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

T = TypeVar("T")

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


class Pagination:
    """Depends() dependency carrying the window for one request."""

    def __init__(
        self,
        limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT, description="Rows per page"),
        offset: int = Query(0, ge=0, description="Rows to skip"),
    ) -> None:
        self.limit = limit
        self.offset = offset


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


async def count_rows(db: AsyncSession, stmt: Select) -> int:
    """Total rows `stmt` would return, ignoring any window.

    ORDER BY is stripped: sorting a subquery you only count is wasted work.
    """
    return await db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0


async def paginate(db: AsyncSession, stmt: Select, page: Pagination) -> tuple[list, int]:
    """Run `stmt` windowed, plus a COUNT over the same filters.

    Returns the ORM entities and the unwindowed total. For a query selecting
    more than one entity, use `count_rows` and window it yourself — this
    unwraps scalars and would drop the extra columns.
    """
    total = await count_rows(db, stmt)
    rows = (await db.execute(stmt.limit(page.limit).offset(page.offset))).scalars().all()
    return list(rows), total
