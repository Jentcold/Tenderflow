import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile, status

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_FILE_SIZE = 10 * 1024 * 1024
ALLOWED_EXTENSIONS = {".pdf", ".doc", ".docx", ".xls", ".xlsx"}


async def save_submission_file(file: UploadFile, tender_id: uuid.UUID) -> str:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{file.filename}: file type not allowed")

    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{file.filename}: exceeds 10MB limit")

    tender_dir = UPLOAD_DIR / str(tender_id)
    tender_dir.mkdir(parents=True, exist_ok=True)

    stored_name = f"{uuid.uuid4().hex}_{file.filename}"
    (tender_dir / stored_name).write_bytes(contents)

    return f"{tender_id}/{stored_name}"
