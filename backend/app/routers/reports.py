import csv
import io

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_roles
from app.core.pagination import Pagination, paginate
from app.database import get_db
from app.models.notification import Notification
from app.models.tender import Tender, TenderStatus
from app.models.user import UserRole

router = APIRouter(prefix="/reports", tags=["reports"], dependencies=[Depends(require_roles("admin", "finance"))])


@router.get("/finance")
async def finance_report(page: Pagination = Depends(), db: AsyncSession = Depends(get_db)) -> dict:
    """Totals cover every awarded tender; `tenders` is the current page of them.

    The aggregates are computed in SQL rather than by summing the page, so
    paging through the list never changes the headline numbers.
    """
    awarded_only = select(Tender).where(Tender.status == TenderStatus.awarded)

    totals = (
        await db.execute(
            select(
                Tender.currency,
                func.count(),
                func.coalesce(func.sum(Tender.awarded_amount), 0),
            )
            .where(Tender.status == TenderStatus.awarded)
            .group_by(Tender.currency)
        )
    ).all()
    by_currency = {
        currency: {"count": count, "total": float(total)} for currency, count, total in totals
    }

    unique_vendors = await db.scalar(
        select(func.count(func.distinct(Tender.awarded_vendor_name))).where(
            Tender.status == TenderStatus.awarded, Tender.awarded_vendor_name.isnot(None)
        )
    )

    pending_actions = await db.scalar(
        select(Notification).where(Notification.for_role == UserRole.finance, Notification.read.is_(False)).limit(1)
    )

    rows, total = await paginate(
        db, awarded_only.order_by(Tender.supply_chain_reviewed_at.desc()), page
    )

    return {
        "awarded_count": total,
        "unique_vendors": unique_vendors or 0,
        "by_currency": by_currency,
        "has_pending_actions": pending_actions is not None,
        "limit": page.limit,
        "offset": page.offset,
        "tenders": [
            {
                "serial": t.serial,
                "name": t.name,
                "vendor": t.awarded_vendor_name,
                "email": t.awarded_email,
                "currency": t.currency,
                "amount": float(t.awarded_amount or 0),
                "awarded_at": t.supply_chain_reviewed_at,
            }
            for t in rows
        ],
    }


@router.get("/finance/export.csv")
async def export_finance_csv(db: AsyncSession = Depends(get_db)) -> StreamingResponse:
    awarded = (
        await db.execute(select(Tender).where(Tender.status == TenderStatus.awarded))
    ).scalars().all()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Serial", "Tender Name", "Vendor", "Contact Email", "Currency", "Amount", "Award Date"])
    for t in awarded:
        writer.writerow(
            [
                t.serial,
                t.name,
                t.awarded_vendor_name or "",
                t.awarded_email or "",
                t.currency,
                float(t.awarded_amount or 0),
                t.supply_chain_reviewed_at.date().isoformat() if t.supply_chain_reviewed_at else "",
            ]
        )
    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=finance_report.csv"},
    )
