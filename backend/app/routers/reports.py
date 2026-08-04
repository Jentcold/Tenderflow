import csv
import io

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_roles
from app.database import get_db
from app.models.notification import Notification
from app.models.tender import Tender, TenderStatus
from app.models.user import UserRole

router = APIRouter(prefix="/reports", tags=["reports"], dependencies=[Depends(require_roles("admin", "finance"))])


@router.get("/finance")
async def finance_report(db: AsyncSession = Depends(get_db)) -> dict:
    awarded = (
        await db.execute(select(Tender).where(Tender.status == TenderStatus.awarded))
    ).scalars().all()

    by_currency: dict[str, dict] = {}
    for t in awarded:
        bucket = by_currency.setdefault(t.currency, {"count": 0, "total": 0.0})
        bucket["count"] += 1
        bucket["total"] += float(t.awarded_amount or 0)

    pending_actions = await db.scalar(
        select(Notification).where(Notification.for_role == UserRole.finance, Notification.read.is_(False)).limit(1)
    )

    return {
        "awarded_count": len(awarded),
        "unique_vendors": len({t.awarded_vendor_name for t in awarded if t.awarded_vendor_name}),
        "by_currency": by_currency,
        "has_pending_actions": pending_actions is not None,
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
            for t in awarded
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
