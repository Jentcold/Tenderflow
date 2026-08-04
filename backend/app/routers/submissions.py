import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import get_current_user, require_roles
from app.database import get_db
from app.models.submission import Submission
from app.models.user import User
from app.schemas.submission import SubmissionOut, SubmissionStatusUpdate
from app.services.storage_service import UPLOAD_DIR

router = APIRouter(prefix="/submissions", tags=["submissions"], dependencies=[Depends(get_current_user)])


@router.get("", response_model=list[SubmissionOut])
async def list_submissions(
    tender_id: uuid.UUID | None = Query(default=None), db: AsyncSession = Depends(get_db)
) -> list[Submission]:
    stmt = select(Submission).order_by(Submission.submitted_at.desc())
    if tender_id:
        stmt = stmt.where(Submission.tender_id == tender_id)
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/files/{stored_path:path}")
async def download_submission_file(stored_path: str) -> FileResponse:
    """stored_path looks like '<tender_id>/<uuid>_<original_filename>', taken straight from
    a submission's `files` list. Requires staff auth (unlike the vendor upload endpoint)."""
    path = UPLOAD_DIR / stored_path
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    original_name = path.name.split("_", 1)[-1]
    return FileResponse(path, filename=original_name)


@router.get("/{submission_id}", response_model=SubmissionOut)
async def get_submission(submission_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> Submission:
    submission = await db.get(Submission, submission_id)
    if not submission:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Submission not found")
    return submission


@router.patch("/{submission_id}/status", response_model=SubmissionOut)
async def update_submission_status(
    submission_id: uuid.UUID,
    payload: SubmissionStatusUpdate,
    user: User = Depends(require_roles("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> Submission:
    submission = await db.get(Submission, submission_id)
    if not submission:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Submission not found")

    submission.status = payload.status
    await log_audit(
        db,
        f"Submission {payload.status.value.capitalize()}",
        f"{submission.company_name} submission {payload.status.value}",
        user.name,
    )
    await db.commit()
    await db.refresh(submission)
    return submission
