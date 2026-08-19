import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr

from app.models.submission import SubmissionStatus


class VendorSubmissionCreate(BaseModel):
    company_name: str
    contact_name: str
    email: EmailStr
    phone: str
    total_amount: float
    notes: str | None = None
    files: list[str] = []


class SubmissionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tender_id: uuid.UUID
    # Null for bids filed through the public link without logging in.
    vendor_id: uuid.UUID | None
    company_name: str
    contact_name: str
    # Plain str on the way out. The submit endpoint validates as EmailStr, so
    # nothing new gets in malformed; validating again on read only means one bad
    # legacy row 500s the entire list instead of just itself.
    email: str
    phone: str
    total_amount: float
    currency: str
    notes: str | None
    files: list[str]
    # The tender's required documents, keyed by the label purchasing asked for.
    # Defaulted rather than required so a bid filed before the column existed
    # reads as "sent nothing" instead of failing the whole list.
    documents: dict[str, str] = {}
    status: SubmissionStatus
    submitted_at: datetime


class SubmissionStatusUpdate(BaseModel):
    status: SubmissionStatus


# OfferOut moved to app/schemas/offer.py when a bid stopped being a single
# priced number: an offer is now its own row with its own line items, and the
# anonymised manager view is built from that, not from the submission envelope.


class SubmissionOfferLine(BaseModel):
    """One priced line of an offer, for the submissions screen."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tender_item_id: uuid.UUID | None
    is_replacement: bool
    name: str
    specs: str | None
    notes: str | None
    quantity: float
    unit: str
    unit_price: float
    line_total: float


class SubmissionOfferBrief(BaseModel):
    """One offer inside a bid, at a glance.

    Deliberately thin. This is read while deciding whether the *submission* is
    genuine, not while comparing prices - that comparison is the offers desk,
    and it only happens after this verdict. What matters here is how many ways
    the vendor answered and whether any of them quietly swaps in something the
    tender didn't ask for, which is the usual reason a bid needs a closer look.
    """

    id: uuid.UUID
    label: str                    # "Offer A", positional within this bid
    title: str | None
    total_amount: float
    currency: str
    # Distinct tender line items this offer prices.
    covers_items: int
    # Lines offering something other than what was asked for. Zero means the
    # vendor quoted the list as written.
    replacement_items: int
    # Names of just those substitutions, so the reviewer sees what was swapped
    # without opening the offer.
    replacements: list[str]

    # Requirements this offer never priced. Computed against the tender's own
    # item list, which the browser would otherwise have to fetch and diff for
    # every offer on the page.
    missing_items: int
    missing: list[str]

    # The full priced list. The submissions screen opens a bid to show every
    # offer inside it, so the lines have to come with it - a second request per
    # offer to render one modal would be a request per row on the page.
    items: list[SubmissionOfferLine]
