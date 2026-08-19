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
        "closed_reason": (
            "You have already submitted a quotation for this tender"
            if already is not None
            else "The deadline for this tender has passed"
            if _is_expired(tender)
            else None
            if tender.status == TenderStatus.open
            else "This tender is not currently open for quotations"
        ),
        "locked_after_submit": True,
    }


def _parse_offers(raw: str | None) -> list[OfferIn]:
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
    contact_name: str | None = Form(default=None),
    email: EmailStr | None = Form(default=None),
    phone: str | None = Form(default=None),
    notes: str | None = Form(default=None),
    deposit_percent: float = Form(default=0),
    offers: str | None = Form(default=None),
    files: list[UploadFile] = File(default=[]),
    doc_labels: str | None = Form(default=None),
    doc_files: list[UploadFile] = File(default=[]),
    db: AsyncSession = Depends(get_db),
) -> Submission:
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
        if offer_in.items:
            offer_in.total_amount = sum(i.quantity * i.unit_price for i in offer_in.items)
        elif offer_in.total_amount is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "An offer needs either priced lines or a total"
            )
        for line in offer_in.items:
            if line.tender_item_id is None:
                continue
            if line.tender_item_id not in valid_item_ids:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Line item {line.tender_item_id} is not part of this tender",
                )


    total_amount = min(o.total_amount for o in parsed_offers)

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
