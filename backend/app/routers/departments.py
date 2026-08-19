from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_internal
from app.database import get_db
from app.models.department import Department
from app.schemas.tender import DepartmentOut

router = APIRouter(prefix="/departments", tags=["departments"], dependencies=[Depends(require_internal)])


@router.get("", response_model=list[DepartmentOut])
async def list_departments(db: AsyncSession = Depends(get_db)) -> list[Department]:
    result = await db.execute(select(Department).order_by(Department.name))
    return list(result.scalars().all())
