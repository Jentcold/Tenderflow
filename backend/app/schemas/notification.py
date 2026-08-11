import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.notification import NotificationType
from app.models.user import UserRole


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    type: NotificationType
    tender_id: uuid.UUID | None
    message: str
    # Null on a notification addressed to one person rather than a job — the
    # column has always been nullable, but until employees arrived every row
    # carried a role, so this never had to admit it.
    for_role: UserRole | None
    read: bool
    details: dict | None
    created_at: datetime
