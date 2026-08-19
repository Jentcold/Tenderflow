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
    for_role: UserRole | None
    read: bool
    details: dict | None
    created_at: datetime
