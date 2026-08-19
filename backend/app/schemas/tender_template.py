import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.schemas.tender import LineItemIn, LineItemOut


class TenderTemplateCreate(BaseModel):
    name: str
    description: str = ""
    category: str = "goods"
    # Null means the template is offered to every department.
    department_id: uuid.UUID | None = None
    currency: str = "EGP"
    default_deadline_days: int = 14
    # The standing requirement table — the reason a recurring purchase is worth
    # templating at all. Copied into the tender when the template is pressed.
    items: list[LineItemIn] = []
    required_docs: list[str] = []

    @field_validator("default_deadline_days")
    @classmethod
    def deadline_is_in_the_future(cls, v: int) -> int:
        # A zero or negative offset would produce a tender whose deadline has
        # already passed the moment it is raised, which vendors cannot bid on.
        if v < 1:
            raise ValueError("default_deadline_days must be at least 1")
        return v


class TenderTemplateUpdate(TenderTemplateCreate):
    # Editing is the only way to retire a template — there is no DELETE.
    active: bool = True


class TenderTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str
    category: str = ""
    category_name: str = ""
    department_id: uuid.UUID | None
    currency: str
    default_deadline_days: int
    # Loaded by the router rather than through a relationship: touching a lazy
    # relationship during serialisation on an async session raises MissingGreenlet.
    items: list[LineItemOut] = []
    required_docs: list[str]
    active: bool
    created_at: datetime
    created_by: uuid.UUID | None
