"""Who gets asked to bid, and the link that asks them.

Being in the tender's category makes a vendor a **candidate**. Purchasing
decides which candidates are actually approached — that decision is this
router, and it is why the invite list is a table rather than a query.

Nothing goes out until somebody presses send. Picking the list and sending the
RFQ are two steps on purpose: the list gets checked before three hundred
vendors hear about a tender by accident.
"""
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.audit import log_audit
from app.core.deps import require_roles, require_staff
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

CAN_INVITE = require_roles("admin", "procurement")



async def _tender_or_404(db: AsyncSession, tender_id: uuid.UUID) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    return tender


async def _rows(db: AsyncSession, tender: Tender, request: Request) -> list[VendorInviteOut]:
    """Every candidate for this tender, with their invite state.

    Candidates are the active vendors in the tender's category. Anyone already
    invited is included even if they've since been deactivated or recategorised
    — dropping them from the list would hide an invitation that exists.
    """
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
                # Any of their categories, not one: a vendor selling laptops
                # and desks is a candidate for a tender about either.
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
    """The vendors who could be asked, and which of them have been."""
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
    """Set the invite list. Replaces it wholesale.

    A vendor already sent to is **not** removed by dropping them here: the mail
    is out and the link works, so pretending otherwise would be a lie the
    database tells. Un-inviting them is `DELETE /{vendor_id}`, which revokes
    the link explicitly.
    """
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
    """Withdraw an invitation, and kill its link.

    Revoked rather than deleted: a link that was sent out is a thing that
    happened, and the token has to stay recorded so the same one can't be
    reissued by chance.
    """
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
    """Record that the flagged vendors were given their link by hand.

    A vendor with no email on file can't be mailed, so `send` flags them
    instead of pretending. Somebody then phones or messages them — and until
    now there was nowhere to say so, which left the list showing them as
    outstanding forever and no way to tell "nobody has called them yet" from
    "called them on Tuesday".

    This is a claim by the person pressing it, not proof of delivery: no mail
    was sent and none is recorded. The audit log names who confirmed it, which
    is the accountability that replaces a delivery receipt.
    """
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
        # Only stamp the time if this is the first time it went out at all;
        # a vendor emailed earlier and chased by phone keeps the date the
        # invitation actually reached them.
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
    """Send the RFQ to everyone on the list who hasn't had it yet.

    Each vendor gets their **own** link. One shared link would make every bid
    anonymous at exactly the moment attribution matters, and would let one
    invited vendor forward the tender to anyone.

    A vendor with no email on file is flagged rather than skipped silently —
    their link exists and someone has to hand it over another way. That is the
    hook the WhatsApp channel goes on.

    `?resend=true` includes vendors who were already sent it. Mail gets lost,
    and a link can go out wrong — without this the only remedy was revoking a
    vendor and re-adding them, which issues a new token and silently breaks the
    link they may already be holding. Resending reuses the same token, so both
    copies of the mail lead to the same place.

    A vendor who has already submitted is never sent it again, resend or not:
    their quotation is sealed and a second one is refused, so the mail could
    only invite them to try something that won't work.
    """
    tender = await _tender_or_404(db, tender_id)
    if tender.status != TenderStatus.open:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Only an open tender can go out to vendors (this one is {tender.status.value})",
        )
    if tender.deadline_date is None or tender.deadline_time is None:
        # Approving sets the deadline, so this only catches a tender opened
        # before that was true. Asking a vendor to quote with no closing date
        # invites a bid that arrives whenever.
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

    # Whoever has already bid drops out here rather than in the loop, so the
    # "nothing to send" message below is accurate.
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
                # Says so on the tin. A vendor who got the first one needs to
                # know this is the same request, not a second one to price.
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
