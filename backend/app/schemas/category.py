import uuid

from pydantic import BaseModel, ConfigDict, field_validator


class CategoryRef(BaseModel):
    """A category as it appears *on* something else - a vendor, a tender.

    Carries the slug as well as the name because the browser filters on the
    slug and shows the name, and making it fetch the full list to translate one
    into the other is a request per screen for something already in hand.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str


class CategoryOut(CategoryRef):
    active: bool
    position: int
    # How many vendors are filed under it, so the admin can see what retiring
    # one would take out of the invite list before they do it.
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
    """Rename, reorder, retire.

    There is no slug here on purpose. It is the stable key every tender, vendor
    and template is filed under, and letting it be edited would silently unfile
    all of them.
    """

    name: str | None = None
    position: int | None = None
    active: bool | None = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("A category needs a name")
        return v.strip() if v else v
