import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.offer import OfferStatus
from app.models.submission import SubmissionStatus


class OfferItemIn(BaseModel):
    """One priced line, as the vendor files it."""

    # Null means this line doesn't answer any particular tender item — a
    # replacement, a substitute, or something thrown in.
    tender_item_id: uuid.UUID | None = None
    is_replacement: bool = False
    name: str
    specs: str | None = None
    notes: str | None = None
    quantity: float = 1
    unit: str = "pcs"
    unit_price: float = 0

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Every line needs a name")
        return v.strip()

    @field_validator("quantity")
    @classmethod
    def quantity_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Quantity must be greater than zero")
        return v

    @field_validator("unit_price")
    @classmethod
    def price_not_negative(cls, v: float) -> float:
        if v < 0:
            raise ValueError("Unit price cannot be negative")
        return v


class OfferIn(BaseModel):
    """One option within a bid.

    A vendor files several of these at once when they have alternatives, or
    when they can't supply what was asked and are proposing replacements.
    """

    title: str | None = None
    notes: str | None = None
    # Optional: with items present the total is computed from them, because two
    # numbers that are meant to agree eventually won't. Only used when a bid
    # arrives with no line items at all.
    total_amount: float | None = None
    items: list[OfferItemIn] = []


class OfferForward(BaseModel):
    """Purchasing's first pass: which offers the department manager gets to see.

    The whole forwarded set is replaced on every call, exactly like the
    shortlist below. Purchasing changes its mind while it is still reading -
    a duplicate turns up, a vendor sends a correction - and one request that
    says "these, and only these" is easier to get right than a stream of add
    and remove calls that can arrive out of order.

    Offers left out are **withheld**, not rejected. They stay `pending` and can
    be forwarded later. Turning one down for cause is `POST /offers/{id}/reject`,
    which asks for a reason, because that is a decision somebody has to be able
    to answer for.
    """

    tender_id: uuid.UUID
    # Unranked, unlike the shortlist: purchasing says what is worth looking at,
    # the manager says what they prefer. Merging the two would have purchasing
    # making the choice they are meant to be handing over.
    offer_ids: list[uuid.UUID]

    @field_validator("offer_ids")
    @classmethod
    def distinct(cls, v: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(set(v)) != len(v):
            raise ValueError("The same offer appears twice")
        return v


MAX_SHORTLIST = 3


class OfferShortlist(BaseModel):
    """The department manager's answer: the offers they would accept, best first.

    An ordered list rather than one id per request. Preference is a property of
    the set — "this one, or failing that this one" — and sending it a row at a
    time would leave a window where the tender has a second choice and no first.
    """

    tender_id: uuid.UUID
    # Order IS the ranking: offer_ids[0] is first choice. An empty list clears
    # the shortlist, which is how a manager takes back a decision.
    offer_ids: list[uuid.UUID]

    @field_validator("offer_ids")
    @classmethod
    def at_most_three_and_distinct(cls, v: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(v) > MAX_SHORTLIST:
            raise ValueError(f"Shortlist at most {MAX_SHORTLIST} offers, in order of preference")
        if len(set(v)) != len(v):
            raise ValueError("The same offer appears twice in the shortlist")
        return v


class OfferSendBack(BaseModel):
    """Purchasing handing a shortlist back to the department manager.

    The manager's list is sealed once sent - they can't quietly re-rank it
    while purchasing is acting on it. This is the way it reopens: purchasing
    says the shortlist doesn't work and asks for another. Every shortlisted
    offer drops back to `forwarded` and the manager can pick again.

    The reason is required for the same reason a rejection's is. The manager
    ranked those three for a purpose; "try again" with no explanation invites
    them to hand back the same three.
    """

    tender_id: uuid.UUID
    reason: str

    @field_validator("reason")
    @classmethod
    def reason_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Say why the shortlist doesn't work")
        return v.strip()


class OfferRejection(BaseModel):
    """Turning an offer down needs a reason — the next desk down the chain has
    to know whether to pick another offer or start the tender again."""

    reason: str

    @field_validator("reason")
    @classmethod
    def reason_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Please give a reason")
        return v.strip()


class OfferItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tender_item_id: uuid.UUID | None
    is_replacement: bool
    position: int
    name: str
    specs: str | None
    notes: str | None
    quantity: float
    unit: str
    unit_price: float
    line_total: float


class OfferOut(BaseModel):
    """An offer with the bidder stripped out, for the manager who picks a winner.

    Deliberately NOT `from_attributes`: it is built field by field in the
    router, so a column added to `Offer` or `Submission` later cannot quietly
    start appearing here. Everything identifying the vendor is absent by
    construction — company_name, contact_name, email, phone, vendor_id, and the
    submission's `files`, whose names and letterheads give the game away as
    fast as a name field would.

    `label` replaces the identity: offers are lettered in price order, so the
    manager has something to name in a meeting without learning whose it is.
    """

    id: uuid.UUID
    tender_id: uuid.UUID
    label: str
    # The vendor's own name for the option ("budget alternative"). Free text,
    # and so the one place identity can still leak — a vendor who puts their
    # company name here has named themselves.
    title: str | None
    total_amount: float
    currency: str
    specs: str | None
    status: OfferStatus
    submitted_at: datetime
    # Where the bid this offer came from stands in purchasing's own checks.
    # An offer can't be sent to the manager until its submission is
    # `validated` - see the gate in POST /offers/forward.
    # Informational only. This used to gate the whole desk - an offer whose bid
    # wasn't `validated` was hidden, and its "send up" tick box was disabled -
    # and both halves of that are gone. Kept on the payload because it is a
    # true fact about the bid, but nothing reads it to decide anything.
    submission_status: SubmissionStatus = SubmissionStatus.pending
    # Who actually bid, and null for everyone who isn't allowed to know.
    #
    # The anonymity on this payload exists so a price comparison can't be
    # swayed by whose name is on it, and that constraint binds the department
    # manager, who is the one comparing. Purchasing is not: they read every bid
    # with the company attached while filtering, they invited these vendors in
    # the first place, and they are the desk that has to notice one supplier
    # quietly holding three of the five offers. Withholding it from them
    # protected nothing and made their own screen unreadable.
    #
    # Populated by the router from the caller's role - see `_may_see_vendor`.
    # A manager gets None here, not a redacted string, so there is nothing to
    # accidentally render.
    vendor_company: str | None = None
    # When purchasing passed it to the department manager. Null means it is
    # still in purchasing's first pass and no manager has seen it.
    forwarded_at: datetime | None = None
    # 1, 2 or 3 once the department manager has shortlisted it; null otherwise.
    manager_rank: int | None = None
    # Where it is in the approval chain, and who has signed it off so far.
    # Timestamps only — the names would be internal staff, which is fine for
    # purchasing but pointless noise for the department manager.
    manager_selected_at: datetime | None = None
    purchasing_reviewed_at: datetime | None = None
    purchasing_manager_reviewed_at: datetime | None = None
    supply_chain_reviewed_at: datetime | None = None
    rejected_at_stage: OfferStatus | None = None
    rejection_reason: str | None = None
    urgent_skipped: bool = False
    # The priced breakdown. This is the list that gets received and ticked off
    # by the warehouse if this offer is the one that wins.
    items: list[OfferItemOut] = []
    # How many of the tender's own lines this offer actually answers, and how
    # many of its lines are replacements. Lets the manager see "covers 3 of 4,
    # one substitute" without reading every row.
    covers_items: int = 0
    replacement_items: int = 0
