import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.audit import log_audit
from app.core.deps import require_staff
from app.core.scope import require_purchasing
from app.core.links import vendor_invite_link
from app.core.time import server_now
from app.database import get_db
from app.models.award import SourcingMode
from app.models.category import vendor_categories
from app.models.email import EmailStatus, EmailType, SentEmail
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.user import User
from app.models.vendor import TenderVendorInvite, Vendor
from app.schemas.vendor import InviteSelection, VendorInviteOut
from app.services.email_service import dispatch_emails

router = APIRouter(prefix="/tenders/{tender_id}/vendors", tags=["invites"])

CAN_INVITE = require_purchasing("admin", "procurement")


async def _tender_or_404(db: AsyncSession, tender_id: uuid.UUID) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    return tender


async def _rows(db: AsyncSession, tender: Tender, request: Request) -> list[VendorInviteOut]:
    invites = {
        i.vendor_id: i
        for i in (
            await db.execute(
                select(TenderVendorInvite).where(
                    TenderVendorInvite.tender_id == tender.id,
                    TenderVendorInvite.revoked.is_(False),
                )
            )
        ).scalars().all()
    }
    candidates = (
        await db.execute(
            select(Vendor)
            .where(
                Vendor.id.in_(
                    select(vendor_categories.c.vendor_id).where(
                        vendor_categories.c.category_id == tender.category_id
                    )
                ),
                Vendor.active.is_(True),
            )
            .order_by(Vendor.company_name)
        )
    ).scalars().all()

    by_id = {v.id: v for v in candidates}
    for vendor_id in invites:
        if vendor_id not in by_id:
            vendor = await db.get(Vendor, vendor_id)
            if vendor is not None:
                by_id[vendor_id] = vendor

    submitted = set(
        (
            await db.execute(
                select(Submission.vendor_id).where(
                    Submission.tender_id == tender.id, Submission.vendor_id.is_not(None)
                )
            )
        ).scalars().all()
    )

    out = []
    for vendor in sorted(by_id.values(), key=lambda v: v.company_name.lower()):
        invite = invites.get(vendor.id)
        out.append(
            VendorInviteOut(
                vendor_id=vendor.id,
                code=vendor.code,
                company_name=vendor.company_name,
                contact_email=vendor.contact_email,
                categories=vendor.categories,
                invited=invite is not None,
                sent_at=invite.sent_at if invite else None,
                needs_other_channel=not (vendor.contact_email or "").strip(),
                submission_link=vendor_invite_link(invite.token, request) if invite else None,
                submitted=vendor.id in submitted,
            )
        )
    return out


@router.get("", response_model=list[VendorInviteOut], dependencies=[Depends(require_staff)])
async def list_candidates(
    tender_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)
) -> list[VendorInviteOut]:
    tender = await _tender_or_404(db, tender_id)
    return await _rows(db, tender, request)


@router.put("", response_model=list[VendorInviteOut])
async def set_invites(
    tender_id: uuid.UUID,
    request: Request,
    payload: InviteSelection,
    user: User = Depends(CAN_INVITE),
    db: AsyncSession = Depends(get_db),
) -> list[VendorInviteOut]:
    tender = await _tender_or_404(db, tender_id)
    if tender.sourcing_mode == SourcingMode.by_hand:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This tender is being bought by hand, so no vendors are being asked",
        )
    if not tender.manager_approved:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "The department manager hasn't approved this tender yet"
        )

    wanted = set(payload.vendor_ids)
    found = (
        await db.execute(select(Vendor).where(Vendor.id.in_(wanted)))
    ).scalars().all() if wanted else []
    if len(found) != len(wanted):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "One of those vendors doesn't exist")

    existing = {
        i.vendor_id: i
        for i in (
            await db.execute(
                select(TenderVendorInvite).where(
                    TenderVendorInvite.tender_id == tender.id,
                    TenderVendorInvite.revoked.is_(False),
                )
            )
        ).scalars().all()
    }

    for vendor_id, invite in existing.items():
        if vendor_id not in wanted and invite.sent_at is None:
            await db.delete(invite)

    for vendor_id in wanted:
        if vendor_id not in existing:
            db.add(
                TenderVendorInvite(
                    tender_id=tender.id, vendor_id=vendor_id, invited_by=user.id
                )
            )

    await log_audit(
        db, "Vendor Invite List Set", f"{tender.serial}: {len(wanted)} vendor(s) selected", user.name
    )
    await db.commit()
    return await _rows(db, tender, request)


@router.delete("/{vendor_id}", response_model=list[VendorInviteOut])
async def revoke_invite(
    tender_id: uuid.UUID,
    request: Request,
    vendor_id: uuid.UUID,
    user: User = Depends(CAN_INVITE),
    db: AsyncSession = Depends(get_db),
) -> list[VendorInviteOut]:
    tender = await _tender_or_404(db, tender_id)
    invite = await db.scalar(
        select(TenderVendorInvite).where(
            TenderVendorInvite.tender_id == tender_id,
            TenderVendorInvite.vendor_id == vendor_id,
            TenderVendorInvite.revoked.is_(False),
        )
    )
    if invite is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That vendor isn't on this tender's list")

    already_bid = await db.scalar(
        select(Submission.id).where(
            Submission.tender_id == tender_id, Submission.vendor_id == vendor_id
        ).limit(1)
    )
    if already_bid is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "That vendor has already bid. Reject their offer instead of withdrawing the invitation.",
        )

    invite.revoked = True
    await log_audit(db, "Vendor Invite Revoked", f"{tender.serial}: {vendor_id}", user.name)
    await db.commit()
    return await _rows(db, tender, request)


@router.post("/confirm-handover", response_model=list[VendorInviteOut])
async def confirm_handover(
    tender_id: uuid.UUID,
    request: Request,
    user: User = Depends(CAN_INVITE),
    db: AsyncSession = Depends(get_db),
) -> list[VendorInviteOut]:
    tender = await _tender_or_404(db, tender_id)

    rows = (
        await db.execute(
            select(TenderVendorInvite, Vendor)
            .join(Vendor, Vendor.id == TenderVendorInvite.vendor_id)
            .where(
                TenderVendorInvite.tender_id == tender.id,
                TenderVendorInvite.revoked.is_(False),
                TenderVendorInvite.needs_other_channel.is_(True),
            )
        )
    ).all()
    if not rows:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Nobody on this tender is waiting to be reached another way.",
        )

    now = server_now()
    names = []
    for invite, vendor in rows:
        invite.needs_other_channel = False
        if invite.sent_at is None:
            invite.sent_at = now
        names.append(vendor.company_name)

    await log_audit(
        db,
        "Invite Handed Over",
        f"{tender.serial}: {', '.join(names)} confirmed sent outside email",
        user.name,
    )
    await db.commit()
    return await _rows(db, tender, request)


@router.post("/send", response_model=list[VendorInviteOut])
async def send_rfq(
    tender_id: uuid.UUID,
    request: Request,
    background: BackgroundTasks,
    resend: bool = Query(
        default=False,
        description="Also send to vendors who already had it. Use when the "
        "first mail didn't arrive or went out wrong.",
    ),
    user: User = Depends(CAN_INVITE),
    db: AsyncSession = Depends(get_db),
) -> list[VendorInviteOut]:
    tender = await _tender_or_404(db, tender_id)
    if tender.status != TenderStatus.open:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Only an open tender can go out to vendors (this one is {tender.status.value})",
        )
    if tender.deadline_date is None or tender.deadline_time is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This tender has no closing date yet. Set one before inviting vendors.",
        )

    conditions = [
        TenderVendorInvite.tender_id == tender.id,
        TenderVendorInvite.revoked.is_(False),
    ]
    if not resend:
        conditions.append(TenderVendorInvite.sent_at.is_(None))

    pending = (
        await db.execute(
            select(TenderVendorInvite, Vendor)
            .join(Vendor, Vendor.id == TenderVendorInvite.vendor_id)
            .where(*conditions)
        )
    ).all()

    already_bid = set(
        (
            await db.execute(
                select(Submission.vendor_id).where(Submission.tender_id == tender.id)
            )
        )
        .scalars()
        .all()
    )
    skipped_bid = sum(1 for _, v in pending if v.id in already_bid)
    pending = [(i, v) for i, v in pending if v.id not in already_bid]

    if not pending:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Everyone on the list has already bid on this tender"
            if skipped_bid
            else "Everyone on the list has already been sent this tender. "
            "Use resend if the mail needs to go out again.",
        )

    now = server_now()
    queued: list[SentEmail] = []
    no_email = 0
    for invite, vendor in pending:
        address = (vendor.contact_email or "").strip()
        if not address:
            invite.needs_other_channel = True
            no_email += 1
            continue

        body = (
            f"Dear {vendor.company_name},\n\n"
            f"You are invited to quote on {tender.name} ({tender.serial}).\n\n"
            f"Closing: {tender.deadline_date} {tender.deadline_time}\n"
            f"Currency: {tender.currency}\n\n"
            f"The item list and the form to price it are here:\n{vendor_invite_link(invite.token, request)}\n\n"
            f"This link is addressed to you — please don't forward it.\n\n"
            f"Regards,\nTenderFlow Purchasing Team"
        )
        record = SentEmail(
            tender_id=tender.id,
            tender_serial=tender.serial,
            tender_name=tender.name,
            vendor_company=vendor.company_name,
            recipient_email=address,
            type=EmailType.rfq,
            subject=(
                f"{'Reminder: invitation' if invite.sent_at else 'Invitation'} to quote"
                f" - {tender.serial} - {tender.name}"
            ),
            body=body,
            status=EmailStatus.queued if settings.mail_configured else EmailStatus.simulated,
        )
        db.add(record)
        queued.append(record)
        invite.sent_at = now

    await log_audit(
        db,
        "RFQ Resent" if resend else "RFQ Sent",
        f"{tender.serial}: {len(queued)} emailed"
        + (f", {no_email} have no email on file" if no_email else "")
        + (f", {skipped_bid} already bid" if skipped_bid else ""),
        user.name,
    )
    await db.commit()
    rows = await _rows(db, tender, request)
    background.add_task(dispatch_emails, [e.id for e in queued])
    return rows
