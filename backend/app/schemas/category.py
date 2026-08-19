import uuid

from pydantic import BaseModel, ConfigDict, field_validator


class CategoryRef(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str


class CategoryOut(CategoryRef):
    active: bool
    position: int
    vendor_count: int = 0


class CategoryCreate(BaseModel):
    name: str
    position: int = 0

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("A category needs a name")
        return v.strip()


class CategoryUpdate(BaseModel):
    name: str | None = None
    position: int | None = None
    active: bool | None = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("A category needs a name")
        return v.strip() if v else v
