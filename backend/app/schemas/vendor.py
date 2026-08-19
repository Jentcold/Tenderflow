import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, field_validator

from app.schemas.category import CategoryRef


class VendorCreate(BaseModel):
    """A vendor as purchasing files them. No account, no password.

    Only the name and at least one category are required. Everything else is
    contact detail we may not have yet, and refusing to record a supplier
    because nobody knows their tax id just keeps them out of the system.
    """

    company_name: str
    # Slugs, and a list: a company that sells laptops and desks is filed under
    # both, and the invite list matches on ANY of them. At least one, because a
    # vendor in no category is a vendor no tender can ever reach.
    categories: list[str]
    contact_email: EmailStr | None = None
    contact_phone: str | None = None
    tax_id: str | None = None
    address: str | None = None
    notes: str | None = None

    @field_validator("company_name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("A vendor needs a company name")
        return v.strip()


class VendorUpdate(BaseModel):
    company_name: str | None = None
    # Replaces the whole set when given; omit it to leave the categories alone.
    categories: list[str] | None = None
    contact_email: EmailStr | None = None
    contact_phone: str | None = None
    tax_id: str | None = None
    address: str | None = None
    notes: str | None = None
    active: bool | None = None


class VendorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    company_name: str
    categories: list[CategoryRef] = []
    contact_email: EmailStr | None
    contact_phone: str | None
    tax_id: str | None
    address: str | None
    notes: str | None
    active: bool
    created_at: datetime
    # True when there is no email on file, so the RFQ has to reach them some
    # other way. Surfaced rather than left for the caller to infer from a null.
    needs_other_channel: bool = False


class VendorInviteOut(BaseModel):
    """One vendor's place on one tender's invite list."""

    vendor_id: uuid.UUID
    code: str
    company_name: str
    contact_email: EmailStr | None
    categories: list[CategoryRef] = []
    invited: bool = False
    sent_at: datetime | None = None
    needs_other_channel: bool = False
    # The addressed link. Only present once invited — there is no link to give
    # out before somebody decides this vendor is being asked.
    submission_link: str | None = None
    # Whether they've actually bid yet.
    submitted: bool = False


class InviteSelection(BaseModel):
    """Who gets asked. Replaces the whole list, like the shortlist does.

    Being in the tender's category makes a vendor a candidate; this is the
    decision about which candidates are actually approached.
    """

    vendor_ids: list[uuid.UUID]


class VendorSubmissionOut(BaseModel):
    """A bid this vendor filed, for their directory page."""

    submission_id: uuid.UUID
    tender_id: uuid.UUID
    tender_serial: str
    tender_name: str
    total_amount: float
    currency: str
    submitted_at: datetime
    offer_count: int
    # Whether anything from this bid ended up being bought. The two lists are
    # kept apart on purpose — "everything they ever quoted" and "what we
    # actually bought from them" answer different questions.
    won_lines: int = 0


class VendorAwardOut(BaseModel):
    """A line actually bought from this vendor."""

    award_line_id: uuid.UUID
    tender_id: uuid.UUID
    tender_serial: str
    tender_name: str
    name: str
    quantity: float
    unit: str
    unit_price: float
    line_total: float
    currency: str
    award_status: str
    awarded_at: datetime | None = None
