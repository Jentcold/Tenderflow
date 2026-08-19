"""The vendor-facing page, reached by an addressed link and nothing else.

Vendors have no accounts. There is no registration, no login, no password to
reset and nothing left enabled when the relationship ends. A vendor gets a link
carrying a token that identifies *this vendor on this tender*, and that token is
the whole of their authentication.

That is a deliberate trade. A token in a URL is a bearer secret — anyone holding
the link can bid as that company — so it is long and random, scoped to one
tender, revocable on its own, and never guessable from a vendor code or an id.
Against the alternative (a login per supplier, with the password resets and
dormant accounts that come with it) this is the smaller surface.
"""
import json
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import EmailStr, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.ratelimit import vendor_read_limit, vendor_submit_limit
from app.core.time import is_past_deadline
from app.database import get_db
from app.models.notification import Notification, NotificationType
from app.models.offer import Offer, OfferItem
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.tender_item import TenderItem
from app.models.user import UserRole
from app.models.vendor import TenderVendorInvite, Vendor
from app.schemas.offer import OfferIn
from app.schemas.submission import SubmissionOut
from app.schemas.tender import LineItemOut, VendorTenderOut
from app.services.storage_service import save_submission_file

router = APIRouter(prefix="/vendor", tags=["vendor"])

# Sanity ceilings for an endpoint anyone holding a link can post to. Both sit
# far above any real quotation; they exist so a malformed or hostile payload
# can't turn one POST into an unbounded number of rows.
MAX_OFFERS = 10
MAX_OFFER_LINES = 200


def _is_expired(tender: Tender) -> bool:
    return is_past_deadline(tender.deadline_date, tender.deadline_time)


async def _tender_items(db: AsyncSession, tender_id: uuid.UUID) -> list[TenderItem]:
    return list(
        (
            await db.execute(
                select(TenderItem)
                .where(TenderItem.tender_id == tender_id)
                .order_by(TenderItem.position)
            )
        ).scalars().all()
    )


async def _resolve(db: AsyncSession, token: str) -> tuple[TenderVendorInvite, Tender, Vendor]:
    """Turn a link token into the tender it opens and the vendor it belongs to.

    One 404 for every failure mode — unknown token, revoked invitation, missing
    tender. Telling the holder of a bad link *which* it was is telling them
    whether they've found a real token.
    """
    invite = await db.scalar(
        select(TenderVendorInvite).where(
            TenderVendorInvite.token == token, TenderVendorInvite.revoked.is_(False)
        )
    )
    if invite is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This link is not valid")
    tender = await db.get(Tender, invite.tender_id)
    vendor = await db.get(Vendor, invite.vendor_id)
    if tender is None or vendor is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This link is not valid")
    return invite, tender, vendor


@router.get("/invite/{token}", dependencies=[Depends(vendor_read_limit)])
async def open_invite(token: str, db: AsyncSession = Depends(get_db)) -> dict:
    """What the vendor sees when they follow their link.

    The tender's own item table comes back as the shape of the form: one row
    per requirement, with specs, quantity and notes filled in, waiting for a
    price. The vendor prices the company's list rather than describing their
    own in a free-text box, which is the whole reason the tender became a table.
    """
    invite, tender, vendor = await _resolve(db, token)

    already = await db.scalar(
        select(Submission).where(
            Submission.tender_id == tender.id, Submission.vendor_id == vendor.id
        )
    )
    items = await _tender_items(db, tender.id)

    return {
        "vendor": {
            "id": str(vendor.id),
            "code": vendor.code,
            "company_name": vendor.company_name,
            "contact_email": vendor.contact_email,
            "contact_phone": vendor.contact_phone,
        },
        "tender": VendorTenderOut(
            **VendorTenderOut.model_validate(tender).model_dump(
                exclude={"items", "already_submitted"}
            ),
            items=[LineItemOut.model_validate(i) for i in items],
            already_submitted=already is not None,
        ).model_dump(mode="json"),
        "can_submit": tender.status == TenderStatus.open
        and not _is_expired(tender)
        and already is None,
        # Said plainly rather than left for the page to work out, so the vendor
        # is told why the form is closed instead of finding it greyed out.
        "closed_reason": (
            "You have already submitted a quotation for this tender"
            if already is not None
            else "The deadline for this tender has passed"
            if _is_expired(tender)
            else None
            if tender.status == TenderStatus.open
            else "This tender is not currently open for quotations"
        ),
        # An offer submitted here can't be edited afterwards, and the page says
        # so before they start rather than after they try.
        "locked_after_submit": True,
    }


def _parse_offers(raw: str | None) -> list[OfferIn]:
    """The offers arrive as JSON inside a multipart field, because the same
    request carries file uploads. Malformed JSON is the vendor's problem to see,
    so the parse error comes back rather than a bare 422."""
    if not raw or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"`offers` is not valid JSON: {exc}")
    if not isinstance(data, list):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "`offers` must be a JSON array")
    try:
        return [OfferIn.model_validate(o) for o in data]
    except ValidationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"`offers` is not valid: {exc}")


def _match_documents(
    required: list[str], labels_json: str | None, uploads: list[UploadFile]
) -> dict[str, UploadFile]:
    """Pair each attached file with the requirement it answers.

    Matched by an explicit label rather than by position alone: positions
    silently shift the moment a vendor skips a slot, and a tax card filed
    against "ISO 9001" is worse than no file at all.

    Anything labelled with something the tender never asked for is dropped
    rather than rejected - the vendor cannot craft this list by hand, so a
    mismatch is a stale page, and a stale page should not lose them a bid whose
    real documents are all present.
    """
    if not required:
        return {}
    try:
        labels = json.loads(labels_json) if labels_json else []
    except json.JSONDecodeError:
        labels = []
    if not isinstance(labels, list):
        labels = []

    wanted = {d: None for d in required}
    matched: dict[str, UploadFile] = {}
    for label, upload in zip(labels, uploads):
        if not isinstance(label, str) or label not in wanted:
            continue
        if not upload.filename:
            continue
        # First one wins: a duplicate label is a double-attached slot, not two
        # answers to the same question.
        matched.setdefault(label, upload)
    return matched


@router.post(
    "/invite/{token}/submit",
    response_model=SubmissionOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(vendor_submit_limit)],
)
async def submit_quotation(
    token: str,
    # All three are optional and default to what the vendor directory already
    # holds. Asking a vendor to retype their own company's email and phone was
    # asking them to re-enter data purchasing had already recorded — and it
    # gave two versions of the same fact a chance to disagree, with the typed
    # one winning. Sent only when somebody has a reason to differ, e.g. a
    # different person handling this particular quotation.
    contact_name: str | None = Form(default=None),
    email: EmailStr | None = Form(default=None),
    phone: str | None = Form(default=None),
    notes: str | None = Form(default=None),
    # Advance payment the vendor is asking for before delivery, as a
    # percentage of the offer total. Part of the price of the deal, so it sits
    # on the bid rather than being negotiated separately after somebody has
    # already chosen on total alone.
    #
    # A percentage rather than a sum of money, because a quotation now carries
    # several offers at different totals: "5,000 up front" means one thing
    # against a 20,000 option and something else entirely against a 60,000 one,
    # and nothing on the row would say which it was meant for. A percentage
    # applies to whichever offer is accepted.
    deposit_percent: float = Form(default=0),
    # A JSON array of offers, each with its own priced lines. One quotation may
    # hold several: two brands of the same item, or a substitute for something
    # the vendor doesn't stock.
    offers: str | None = Form(default=None),
    files: list[UploadFile] = File(default=[]),
    # The tender's required documents, answered. `doc_labels` is a JSON array
    # of the labels the vendor actually attached something for, in the same
    # order as `doc_files`; a slot they left empty appears in neither, so the
    # two lists stay in step without the browser having to send placeholders.
    doc_labels: str | None = Form(default=None),
    doc_files: list[UploadFile] = File(default=[]),
    db: AsyncSession = Depends(get_db),
) -> Submission:
    """File a quotation against the tender this link opens.

    The company is taken from the invitation, never from the form. A vendor
    cannot file under another company's name because the name is not something
    they send.

    **One quotation per vendor per tender, and it cannot be changed.** A price
    that can be revised after everyone else's is in is not a sealed bid.
    """
    invite, tender, vendor = await _resolve(db, token)

    if tender.status != TenderStatus.open or _is_expired(tender):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "This tender is no longer accepting quotations"
        )

    existing = await db.scalar(
        select(Submission).where(
            Submission.tender_id == tender.id, Submission.vendor_id == vendor.id
        )
    )
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "You have already submitted a quotation for this tender, and a submitted "
            "quotation can't be changed",
        )

    if not 0 <= deposit_percent <= 100:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "The deposit is a percentage of the offer total, so it has to be between 0 and 100",
        )

    parsed_offers = _parse_offers(offers)
    if not parsed_offers:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Price at least one item before submitting"
        )
    # A ceiling on an unauthenticated endpoint that writes rows. Nobody puts
    # ten genuine alternatives on one tender, and without a limit a crafted
    # payload turns one request into as many offer rows as it likes.
    if len(parsed_offers) > MAX_OFFERS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"A quotation can hold at most {MAX_OFFERS} offers",
        )

    valid_item_ids = {i.id for i in await _tender_items(db, tender.id)}
    for offer_in in parsed_offers:
        if len(offer_in.items) > MAX_OFFER_LINES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"An offer can hold at most {MAX_OFFER_LINES} lines",
            )
        # An offer's total is computed from its lines, never taken on trust:
        # two numbers meant to agree eventually won't, and this is the one
        # purchasing compares.
        if offer_in.items:
            offer_in.total_amount = sum(i.quantity * i.unit_price for i in offer_in.items)
        elif offer_in.total_amount is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "An offer needs either priced lines or a total"
            )
        # A line may only point at an item of THIS tender. Unchecked, a crafted
        # payload could pin a price onto another tender's requirement.
        for line in offer_in.items:
            if line.tender_item_id is None:
                continue
            if line.tender_item_id not in valid_item_ids:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Line item {line.tender_item_id} is not part of this tender",
                )

        # Quantity is NOT capped at what was asked for. It used to be, on the
        # reasoning that nobody ordered the extras and they would inflate a
        # total decisions get made on. That reasoning was wrong about how
        # vendors actually quote: a supplier with a box of ten prices the box,
        # throws in a spare, or bundles a case with a laptop. Refusing those
        # rejected the good-faith offer along with the typo, and purchasing is
        # perfectly able to read "5" beside a requested 3 and decide.
        #
        # Under-supply was always allowed - "you want three, I have two" - and
        # over-supply is the same kind of information. Both are the vendor
        # telling us what they actually have.

    # A vendor may answer some of the requirements and stay silent on the rest.
    # Purchasing buys each line from whoever is best on it, so a partial
    # quotation is a normal quotation, not a disqualified one.
    total_amount = min(o.total_amount for o in parsed_offers)

    # Required means required. Purchasing wrote the list because a bid without
    # a valid tax card is one they cannot buy from, and finding that out after
    # the tender closes means going back to a vendor whose price is now public
    # to the desk. Refusing it here costs the vendor a minute.
    required = [d for d in (tender.required_docs or []) if d.strip()]
    documents = _match_documents(required, doc_labels, doc_files)
    absent = [d for d in required if d not in documents]
    if absent:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This tender asks for documents that aren't attached: " + ", ".join(absent),
        )
    stored_documents = {
        label: await save_submission_file(upload, tender.id)
        for label, upload in documents.items()
    }

    stored_paths = [await save_submission_file(f, tender.id) for f in files if f.filename]

    submission = Submission(
        tender_id=tender.id,
        currency=tender.currency,
        vendor_id=vendor.id,
        company_name=vendor.company_name,
        # The directory is the fallback, not the form. A vendor with no email
        # on file is one purchasing reached another way, so this can genuinely
        # be empty; the company name and the invite are what identify the bid.
        contact_name=(contact_name or "").strip() or vendor.company_name,
        email=(str(email) if email else (vendor.contact_email or "")).lower(),
        phone=(phone or "").strip() or (vendor.contact_phone or ""),
        total_amount=total_amount,
        notes=(
            f"{notes}\n\nDeposit / advance requested: {deposit_percent:g}% of the accepted offer total"
            if deposit_percent
            else notes
        ),
        files=stored_paths,
        documents=stored_documents,
    )
    db.add(submission)
    # The UUID default is applied at INSERT, not on construction, so
    # submission.id is None until this flush — the offers below key off it.
    await db.flush()

    for position, offer_in in enumerate(parsed_offers):
        db.add(
            Offer(
                submission_id=submission.id,
                tender_id=tender.id,
                position=position,
                title=offer_in.title,
                total_amount=offer_in.total_amount or 0,
                currency=tender.currency,
                notes=offer_in.notes,
                # Appended through the relationship rather than with an offer_id
                # of their own: the FK is populated during flush, so the lines
                # need no second round trip.
                items=[
                    OfferItem(
                        tender_item_id=line.tender_item_id,
                        is_replacement=line.is_replacement,
                        position=line_position,
                        name=line.name,
                        specs=line.specs,
                        notes=line.notes,
                        quantity=line.quantity,
                        unit=line.unit,
                        unit_price=line.unit_price,
                    )
                    for line_position, line in enumerate(offer_in.items)
                ],
            )
        )

    db.add(
        Notification(
            type=NotificationType.submission_received,
            tender_id=tender.id,
            message=f"{vendor.company_name} quoted on {tender.serial}",
            for_role=UserRole.procurement,
        )
    )
    await log_audit(
        db,
        "Quotation Received",
        f"{tender.serial}: {vendor.company_name} ({vendor.code}), "
        f"{len(parsed_offers)} offer(s), from {tender.currency} {total_amount:,.2f}",
        vendor.company_name,
    )
    await db.commit()
    await db.refresh(submission)
    return submission
