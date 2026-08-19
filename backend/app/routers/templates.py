import uuid
from datetime import time

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.categories import category_by_slug
from app.core.deps import require_internal, require_roles
from app.core.pagination import Page, Pagination, paginate
from app.database import get_db
from app.models.category import Category
from app.models.notification import Notification, NotificationType
from app.models.tender import Tender
from app.models.tender_item import TemplateItem, TenderItem
from app.models.tender_template import TenderTemplate
from app.models.user import User, UserRole
from app.schemas.tender import LineItemIn, LineItemOut, TenderListItem, TenderOut
from app.schemas.tender_template import (
    TenderTemplateCreate,
    TenderTemplateOut,
    TenderTemplateUpdate,
)
from app.services.tender_service import generate_serial

# Internal-only, and reading is deliberately open to every internal role: the
# whole point of a template is that a department can browse the ones for its
# category and press one. Writing is purchasing's job, enforced per endpoint.
router = APIRouter(prefix="/templates", tags=["templates"], dependencies=[Depends(require_internal)])

CAN_EDIT_TEMPLATES = require_roles("admin", "procurement")
# Same set as tenders.CAN_CREATE — raising a tender from a template must not be
# a way around who is allowed to raise a tender at all.
CAN_USE_TEMPLATES = require_roles("admin", "procurement", "employee")

# 09:00 local. A template stores how many days out the deadline is, not a time
# of day; anything raised from one lands on business hours rather than midnight.
# What the approve dialog offers as the closing time when a manager sets a
# deadline. Nothing writes it to a tender on its own.
DEFAULT_DEADLINE_TIME = time(9, 0)


async def _items_of(db: AsyncSession, template_id: uuid.UUID) -> list[TemplateItem]:
    return list(
        (
            await db.execute(
                select(TemplateItem)
                .where(TemplateItem.template_id == template_id)
                .order_by(TemplateItem.position)
            )
        ).scalars().all()
    )


async def _items_for(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[TemplateItem]]:
    """Items for a whole page in one query rather than one per template."""
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(TemplateItem)
            .where(TemplateItem.template_id.in_(ids))
            .order_by(TemplateItem.position)
        )
    ).scalars().all()
    grouped: dict[uuid.UUID, list[TemplateItem]] = {}
    for row in rows:
        grouped.setdefault(row.template_id, []).append(row)
    return grouped


def _write_items(db: AsyncSession, template: TenderTemplate, items: list[LineItemIn]) -> None:
    for position, item in enumerate(items):
        db.add(
            TemplateItem(
                template_id=template.id,
                position=position,
                name=item.name,
                specs=item.specs,
                notes=item.notes,
                quantity=item.quantity,
                unit=item.unit,
            )
        )


def _out(template: TenderTemplate, items: list[TemplateItem]) -> TenderTemplateOut:
    return TenderTemplateOut(
        **TenderTemplateOut.model_validate(template).model_dump(exclude={"items"}),
        items=[LineItemOut.model_validate(i) for i in items],
    )


class UseTemplateRequest(BaseModel):
    """Overrides for the one press that turns a template into a tender.

    Everything is optional. `department_id` is only needed for an all-departments
    template, which by definition doesn't know which department is using it.
    """

    name: str | None = None
    description: str | None = None
    department_id: uuid.UUID | None = None


@router.get("", response_model=Page[TenderTemplateOut])
async def list_templates(
    category: str | None = Query(default=None, description="Only templates for this category (slug)"),
    department_id: uuid.UUID | None = Query(
        default=None,
        description="Templates for this department, plus the all-department ones",
    ),
    include_inactive: bool = Query(default=False, description="Include retired templates"),
    page: Pagination = Depends(),
    db: AsyncSession = Depends(get_db),
) -> Page[TenderTemplateOut]:
    stmt = select(TenderTemplate).order_by(TenderTemplate.name)
    if category is not None:
        # Joined rather than compared: the category is a row now, and the slug
        # is what the caller sends because it is the readable stable key.
        stmt = stmt.join(Category, Category.id == TenderTemplate.category_id).where(
            Category.slug == category
        )
    if department_id is not None:
        # OR-ing in the nulls is the point of the filter: a template purchasing
        # made for everyone must appear for each department, not for none of
        # them. An equality test alone would hide exactly the shared ones.
        stmt = stmt.where(
            (TenderTemplate.department_id == department_id) | (TenderTemplate.department_id.is_(None))
        )
    if not include_inactive:
        stmt = stmt.where(TenderTemplate.active.is_(True))

    templates, total = await paginate(db, stmt, page)
    items = await _items_for(db, [t.id for t in templates])
    return Page[TenderTemplateOut](
        items=[_out(t, items.get(t.id, [])) for t in templates],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/{template_id}", response_model=TenderTemplateOut)
async def get_template(
    template_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> TenderTemplateOut:
    template = await db.get(TenderTemplate, template_id)
    if not template:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    return _out(template, await _items_of(db, template.id))


@router.post("", response_model=TenderTemplateOut, status_code=status.HTTP_201_CREATED)
async def create_template(
    payload: TenderTemplateCreate,
    user: User = Depends(CAN_EDIT_TEMPLATES),
    db: AsyncSession = Depends(get_db),
) -> TenderTemplateOut:
    template = TenderTemplate(
        name=payload.name,
        description=payload.description,
        category_ref=await category_by_slug(db, payload.category),
        department_id=payload.department_id,
        currency=payload.currency,
        default_deadline_days=payload.default_deadline_days,
        required_docs=payload.required_docs,
        created_by=user.id,
    )
    db.add(template)
    # The UUID default lands at INSERT, not on construction — flush so
    # template.id exists for the item rows' foreign key.
    await db.flush()
    _write_items(db, template, payload.items)
    await log_audit(db, "Template Created", f"{template.name} ({template.category})", user.name)
    await db.commit()
    await db.refresh(template)
    return _out(template, await _items_of(db, template.id))


@router.put("/{template_id}", response_model=TenderTemplateOut)
async def update_template(
    template_id: uuid.UUID,
    payload: TenderTemplateUpdate,
    user: User = Depends(CAN_EDIT_TEMPLATES),
    db: AsyncSession = Depends(get_db),
) -> TenderTemplateOut:
    template = await db.get(TenderTemplate, template_id)
    if not template:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")

    template.name = payload.name
    template.description = payload.description
    template.category_ref = await category_by_slug(db, payload.category)
    template.department_id = payload.department_id
    template.currency = payload.currency
    template.default_deadline_days = payload.default_deadline_days
    template.required_docs = payload.required_docs
    template.active = payload.active

    # Full replacement, same reasoning as a tender's items: matching rows by
    # name would merge two lines that share one and keep rows meant to go.
    await db.execute(TemplateItem.__table__.delete().where(TemplateItem.template_id == template.id))
    _write_items(db, template, payload.items)

    await log_audit(db, "Template Updated", f"{template.name} ({template.category})", user.name)
    await db.commit()
    await db.refresh(template)
    return _out(template, await _items_of(db, template.id))


@router.post("/{template_id}/use", response_model=TenderOut, status_code=status.HTTP_201_CREATED)
async def create_tender_from_template(
    template_id: uuid.UUID,
    payload: UseTemplateRequest,
    user: User = Depends(CAN_USE_TEMPLATES),
    db: AsyncSession = Depends(get_db),
) -> TenderListItem:
    """The one press. Creates an ordinary tender and hands it to the manager.

    Nothing is short-circuited: the tender starts at pending_approval and the
    manager gets the same notification as for a hand-built one. A template
    saves the typing, not the approval.
    """
    template = await db.get(TenderTemplate, template_id)
    if not template:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    if not template.active:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This template has been retired. Ask purchasing for the current one.",
        )

    department_id = payload.department_id or template.department_id
    if department_id is None:
        # An all-departments template can't guess who is raising it, and
        # department_id is what later decides which manager approves the tender.
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This template is not tied to a department, so department_id is required",
        )

    tender = Tender(
        serial=generate_serial(),
        name=payload.name or template.name,
        description=payload.description if payload.description is not None else template.description,
        # No deadline yet, template or not. Pressing a template still raises a
        # request that a manager approves, and the deadline is set there — the
        # template's `default_deadline_days` is what that dialog offers as a
        # starting point, not a date applied behind the manager's back.
        deadline_date=None,
        deadline_time=None,
        currency=template.currency,
        category=template.category,
        category_name=template.category_name,
        department_id=department_id,
        # Copied, not shared. dict()/list() here rather than the template's own
        # objects: handing over the same list would let a later edit to the
        # tender mutate the template's JSON through the shared reference.
        required_docs=list(template.required_docs),
        created_by=user.id,
    )
    db.add(tender)
    await db.flush()  # assigns tender.id for the item rows and the notification
    # The requirement table comes across as rows of its own, copied not shared,
    # so editing the template next quarter cannot rewrite a tender already out
    # with vendors.
    template_items = await _items_of(db, template.id)
    for item in template_items:
        db.add(
            TenderItem(
                tender_id=tender.id,
                position=item.position,
                name=item.name,
                specs=item.specs,
                notes=item.notes,
                quantity=item.quantity,
                unit=item.unit,
            )
        )
    db.add(
        Notification(
            type=NotificationType.tender_pending_approval,
            tender_id=tender.id,
            message=f"{tender.serial} - {tender.name} is awaiting your approval",
            for_role=UserRole.manager,
        )
    )
    await log_audit(
        db,
        "Tender Created",
        f"{tender.serial} - {tender.name} from template '{template.name}' (awaiting manager approval)",
        user.name,
    )
    await db.commit()
    await db.refresh(tender)

    tender_items = (
        await db.execute(
            select(TenderItem).where(TenderItem.tender_id == tender.id).order_by(TenderItem.position)
        )
    ).scalars().all()
    return TenderListItem(
        **TenderOut.model_validate(tender).model_dump(exclude={"items"}),
        items=[LineItemOut.model_validate(i) for i in tender_items],
        submission_count=0,
        is_expired=False,
    )
