import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import get_current_user, get_current_user_optional
from app.core.pagination import Page, Pagination, count_rows
from app.core.ratelimit import vendor_read_limit, vendor_register_limit, vendor_submit_limit
from app.core.security import create_access_token, hash_password
from app.core.time import is_past_deadline, server_now
from app.database import get_db
from app.models.notification import Notification, NotificationType
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.user import User, UserRole, UserStatus
from app.models.vendor import Vendor
from app.schemas.auth import TokenResponse
from app.schemas.submission import SubmissionOut
from app.schemas.tender import VendorTenderOut
from app.schemas.user import UserOut
from app.schemas.vendor import VendorOut, VendorRegisterRequest, VendorUpdate
from app.services.storage_service import save_submission_file

# Mostly public and unauthenticated: this is what the vendor-facing link
# (?tender=<id>) hits. The /me routes are the exception and say so.
router = APIRouter(prefix="/vendor", tags=["vendor"])


def _is_expired(tender: Tender) -> bool:
    return is_past_deadline(tender.deadline_date, tender.deadline_time)


async def _current_vendor(user: User, db: AsyncSession) -> Vendor:
    """The calling user's own company profile, or 403 if they aren't a vendor."""
    if user.role != UserRole.vendor:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This route is for vendor accounts")
    profile = await db.scalar(select(Vendor).where(Vendor.user_id == user.id))
    if profile is None:
        # Registration writes both rows in one transaction, so this means
        # someone made a vendor user by hand.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No company profile is linked to this account")
    return profile


async def _vendor_profile_of(caller: User | None, db: AsyncSession) -> Vendor | None:
    """Profile for an optionally-authenticated caller. None for anonymous
    callers and for staff, neither of whom has a category to match on."""
    if caller is None or caller.role != UserRole.vendor:
        return None
    return await db.scalar(select(Vendor).where(Vendor.user_id == caller.id))


# ----------------------------------------------------------------- accounts --

@router.post(
    "/register",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(vendor_register_limit)],
)
async def register_vendor(
    payload: VendorRegisterRequest, db: AsyncSession = Depends(get_db)
) -> TokenResponse:
    """Public sign-up: creates the login and the company profile together.

    Returns a token so the frontend can drop the vendor straight into their
    dashboard instead of bouncing them through the login form.
    """
    email = payload.email.lower()
    clash = await db.scalar(
        select(User).where(or_(User.username == payload.username, User.email == email))
    )
    if clash:
        raise HTTPException(status.HTTP_409_CONFLICT, "Username or email already exists")

    user = User(
        username=payload.username,
        email=email,
        name=payload.name.strip(),
        password_hash=hash_password(payload.password),
        role=UserRole.vendor,
        status=UserStatus.active,
    )
    db.add(user)
    # The profile's FK needs the user's id, and the id is generated
    # client-side by the UUID mixin, so no flush is needed for it — but the
    # insert order still has to satisfy the constraint.
    await db.flush()

    profile = Vendor(
        user_id=user.id,
        company_name=payload.company_name,
        vendor_category=payload.vendor_category,
        contact_email=(payload.contact_email or payload.email).lower(),
        contact_phone=payload.contact_phone,
        tax_id=payload.tax_id,
        address=payload.address,
    )
    db.add(profile)

    await log_audit(db, "Vendor Registered", f"{profile.company_name} ({user.username})", user.name)
    await db.commit()
    await db.refresh(user)

    token = create_access_token(subject=str(user.id), role=user.role.value)
    return TokenResponse(access_token=token, user=UserOut.model_validate(user))


@router.get("/me", response_model=VendorOut)
async def get_my_vendor_profile(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> Vendor:
    return await _current_vendor(user, db)


@router.patch("/me", response_model=VendorOut)
async def update_my_vendor_profile(
    payload: VendorUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Vendor:
    profile = await _current_vendor(user, db)

    fields = payload.model_dump(exclude_unset=True)
    if "contact_email" in fields and fields["contact_email"]:
        fields["contact_email"] = fields["contact_email"].lower()
    for field, value in fields.items():
        if value is not None:
            setattr(profile, field, value)

    await log_audit(db, "Vendor Profile Updated", profile.company_name, user.name)
    await db.commit()
    await db.refresh(profile)
    return profile


# ----------------------------------------------------------------- tenders --

@router.get(
    "/tenders",
    response_model=Page[VendorTenderOut],
    dependencies=[Depends(vendor_read_limit)],
)
async def list_tenders_for_vendor(
    page: Pagination = Depends(),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Page[VendorTenderOut]:
    """Open tenders in the calling vendor's own category, soonest deadline first.

    Category is the whole point of this route: a goods supplier has no business
    browsing consulting tenders. Expired ones are filtered in SQL rather than
    after the fact, so `total` and the page agree.
    """
    profile = await _current_vendor(user, db)

    # deadline_date + deadline_time is a timestamp in Postgres, compared
    # against server wall-clock time — the same basis the columns were
    # written on. See core/time.py.
    deadline = Tender.deadline_date + Tender.deadline_time
    stmt = (
        select(Tender)
        .where(
            Tender.status == TenderStatus.open,
            Tender.category == profile.vendor_category,
            deadline > server_now().replace(tzinfo=None),
        )
        .order_by(Tender.deadline_date, Tender.deadline_time)
    )

    total = await count_rows(db, stmt)
    tenders = (await db.execute(stmt.limit(page.limit).offset(page.offset))).scalars().all()

    # One query for the whole page: which of these has this vendor already bid on.
    already = set()
    if tenders:
        already = set(
            (
                await db.execute(
                    select(Submission.tender_id).where(
                        Submission.vendor_id == profile.id,
                        Submission.tender_id.in_([t.id for t in tenders]),
                    )
                )
            ).scalars().all()
        )

    return Page[VendorTenderOut](
        items=[
            VendorTenderOut(
                **VendorTenderOut.model_validate(t).model_dump(exclude={"already_submitted"}),
                already_submitted=t.id in already,
            )
            for t in tenders
        ],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/tenders/{tender_id}", dependencies=[Depends(vendor_read_limit)])
async def get_public_tender(
    tender_id: uuid.UUID,
    caller: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Stays public — this is a link a buyer shares, and anyone holding it can
    read the tender. `accepting_submissions` answers "can *you* bid", so for a
    logged-in vendor it also accounts for their category."""
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")

    public = {
        "id": tender.id,
        "serial": tender.serial,
        "name": tender.name,
        "description": tender.description,
        "deadline_date": tender.deadline_date,
        "deadline_time": tender.deadline_time,
        "category": tender.category,
    }

    if tender.status != TenderStatus.open or _is_expired(tender):
        return {**public, "accepting_submissions": False}

    profile = await _vendor_profile_of(caller, db)
    if profile is not None and profile.vendor_category != tender.category:
        return {
            **public,
            "accepting_submissions": False,
            "reason": (
                f"This tender is in the {tender.category.value} category and your "
                f"account is registered for {profile.vendor_category.value}"
            ),
        }

    return {
        **public,
        "currency": tender.currency,
        "required_docs": tender.required_docs,
        "accepting_submissions": True,
    }


@router.post(
    "/tenders/{tender_id}/submit",
    response_model=SubmissionOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(vendor_submit_limit)],
)
async def submit_offer(
    tender_id: uuid.UUID,
    company_name: str = Form(...),
    contact_name: str = Form(...),
    email: str = Form(...),
    phone: str = Form(...),
    total_amount: float = Form(...),
    notes: str | None = Form(default=None),
    files: list[UploadFile] = File(default=[]),
    caller: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
) -> Submission:
    """Open to anyone with the link. Send a vendor's bearer token to have the
    bid attributed to their registered company; without one it's accepted
    anonymously, exactly as before."""
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    if tender.status != TenderStatus.open or _is_expired(tender):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This tender is no longer accepting submissions")

    # A registered vendor gets their bid linked, and the company identity comes
    # from their profile rather than the form. Deliberately keyed off the token
    # and nothing else: matching the typed-in email against registered vendors
    # would let anyone file a bid under a competitor's name.
    profile = await _vendor_profile_of(caller, db)
    if profile is not None:
        if profile.vendor_category != tender.category:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"This tender is in the {tender.category.value} category and your "
                f"account is registered for {profile.vendor_category.value}",
            )
        company_name = profile.company_name

    existing = await db.scalar(
        select(Submission).where(Submission.tender_id == tender_id, Submission.email == email.lower())
    )
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "A submission from this email already exists")

    stored_paths = [await save_submission_file(f, tender_id) for f in files if f.filename]

    submission = Submission(
        tender_id=tender_id,
        # Bids are always in the tender's currency — the vendor form doesn't
        # offer a choice, and the column is NOT NULL.
        currency=tender.currency,
        vendor_id=profile.id if profile else None,
        company_name=company_name,
        contact_name=contact_name,
        email=email.lower(),
        phone=phone,
        total_amount=total_amount,
        notes=notes,
        files=stored_paths,
    )
    db.add(submission)

    db.add(
        Notification(
            type=NotificationType.submission_received,
            tender_id=tender.id,
            message=f"New submission from {company_name} for {tender.serial}",
            for_role=UserRole.procurement,
        )
    )
    await log_audit(
        db,
        "Submission Received",
        f"{company_name} for {tender.serial}" + ("" if profile else " (unregistered)"),
        caller.name if caller else "System",
    )
    await db.commit()
    await db.refresh(submission)
    return submission
