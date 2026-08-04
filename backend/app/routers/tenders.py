import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.audit import log_audit
from app.core.deps import get_current_user, require_roles
from app.database import get_db
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.user import User
from app.schemas.tender import ExtendDeadlineRequest, TenderCreate, TenderOut, TenderUpdate
from app.services.tender_service import generate_serial

router = APIRouter(prefix="/tenders", tags=["tenders"], dependencies=[Depends(get_current_user)])

CAN_MANAGE = require_roles("admin", "procurement")


async def _submission_count(db: AsyncSession, tender_id: uuid.UUID) -> int:
    return await db.scalar(select(func.count()).select_from(Submission).where(Submission.tender_id == tender_id)) or 0


def _to_out(tender: Tender) -> dict:
    data = TenderOut.model_validate(tender).model_dump()
    return data


@router.get("")
async def list_tenders(
    status_filter: TenderStatus | None = Query(default=None, alias="status"),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    stmt = select(Tender).order_by(Tender.created_at.desc())
    if status_filter:
        stmt = stmt.where(Tender.status == status_filter)
    tenders = (await db.execute(stmt)).scalars().all()

    out = []
    for t in tenders:
        item = _to_out(t)
        item["submission_count"] = await _submission_count(db, t.id)
        out.append(item)
    return out


@router.get("/{tender_id}")
async def get_tender(tender_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    item = _to_out(tender)
    item["submission_count"] = await _submission_count(db, tender.id)
    item["submission_link"] = f"{settings.FRONTEND_BASE_URL}/vendor?tender={tender.id}"
    return item


@router.post("", response_model=TenderOut, status_code=status.HTTP_201_CREATED)
async def create_tender(
    payload: TenderCreate, user: User = Depends(CAN_MANAGE), db: AsyncSession = Depends(get_db)
) -> Tender:
    tender = Tender(
        serial=generate_serial(),
        name=payload.name,
        description=payload.description,
        deadline_date=payload.deadline_date,
        deadline_time=payload.deadline_time,
        currency=payload.currency,
        category=payload.category,
        department_id=payload.department_id,
        required_docs=payload.required_docs,
        scoring_criteria=[c.model_dump() for c in payload.scoring_criteria],
        created_by=user.id,
    )
    db.add(tender)
    await log_audit(db, "Tender Created", f"{tender.serial} - {tender.name}", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


@router.put("/{tender_id}", response_model=TenderOut)
async def update_tender(
    tender_id: uuid.UUID,
    payload: TenderUpdate,
    user: User = Depends(CAN_MANAGE),
    db: AsyncSession = Depends(get_db),
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    tender.name = payload.name
    tender.description = payload.description
    tender.deadline_date = payload.deadline_date
    tender.deadline_time = payload.deadline_time
    tender.currency = payload.currency
    tender.category = payload.category
    tender.department_id = payload.department_id
    tender.required_docs = payload.required_docs
    tender.scoring_criteria = [c.model_dump() for c in payload.scoring_criteria]

    await log_audit(db, "Tender Updated", f"{tender.serial} - {tender.name}", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


@router.post("/{tender_id}/close", response_model=TenderOut)
async def close_tender(
    tender_id: uuid.UUID, user: User = Depends(CAN_MANAGE), db: AsyncSession = Depends(get_db)
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    tender.status = TenderStatus.closed
    await log_audit(db, "Tender Closed", f"{tender.serial} - {tender.name}", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


@router.post("/{tender_id}/reopen", response_model=TenderOut)
async def reopen_tender(
    tender_id: uuid.UUID, user: User = Depends(CAN_MANAGE), db: AsyncSession = Depends(get_db)
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    tender.status = TenderStatus.open
    await log_audit(db, "Tender Re-opened", f"{tender.serial} - {tender.name}", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender


@router.post("/{tender_id}/duplicate", response_model=TenderOut, status_code=status.HTTP_201_CREATED)
async def duplicate_tender(
    tender_id: uuid.UUID, user: User = Depends(CAN_MANAGE), db: AsyncSession = Depends(get_db)
) -> Tender:
    original = await db.get(Tender, tender_id)
    if not original:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    copy = Tender(
        serial=generate_serial(),
        name=f"{original.name} (Copy)",
        description=original.description,
        deadline_date=original.deadline_date,
        deadline_time=original.deadline_time,
        currency=original.currency,
        category=original.category,
        department_id=original.department_id,
        required_docs=list(original.required_docs),
        scoring_criteria=[dict(c) for c in original.scoring_criteria],
        created_by=user.id,
    )
    db.add(copy)
    await log_audit(db, "Tender Duplicated", f"{copy.serial} from {original.serial}", user.name)
    await db.commit()
    await db.refresh(copy)
    return copy


@router.post("/{tender_id}/extend-deadline", response_model=TenderOut)
async def extend_deadline(
    tender_id: uuid.UUID,
    payload: ExtendDeadlineRequest,
    user: User = Depends(CAN_MANAGE),
    db: AsyncSession = Depends(get_db),
) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    old = f"{tender.deadline_date} {tender.deadline_time}"
    tender.deadline_date = payload.deadline_date
    tender.deadline_time = payload.deadline_time
    tender.status = TenderStatus.open

    await log_audit(
        db,
        "Deadline Extended",
        f"{tender.serial}: {old} -> {payload.deadline_date} {payload.deadline_time}",
        user.name,
    )
    await db.commit()
    await db.refresh(tender)
    return tender


@router.post("/{tender_id}/reset-cycle", response_model=TenderOut)
async def reset_tender_cycle(
    tender_id: uuid.UUID, user: User = Depends(CAN_MANAGE), db: AsyncSession = Depends(get_db)
) -> Tender:
    """Deletes all submissions/evaluations for this tender and reopens it."""
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    await db.execute(Submission.__table__.delete().where(Submission.tender_id == tender_id))
    tender.status = TenderStatus.open
    tender.evaluation_submitted = False
    tender.manager_approved = False
    tender.manager_rejected = False
    tender.supply_chain_approved = False
    tender.supply_chain_rejected = False

    await log_audit(db, "Tender Cycle Reset", f"{tender.serial} - All submissions cleared", user.name)
    await db.commit()
    await db.refresh(tender)
    return tender
