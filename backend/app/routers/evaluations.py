import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import require_roles, require_staff
from app.core.time import server_now
from app.database import get_db
from app.models.evaluation import Evaluation
from app.models.notification import Notification, NotificationType
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.user import User, UserRole
from app.schemas.evaluation import EvaluationSave, RankedSubmissionOut, RejectionReason
from app.services.email_service import dispatch_emails, send_award_emails
from app.services.evaluation_service import weighted_total

# Staff-only. Vendors are authenticated users too, so gating on
# get_current_user alone would have let them read this router.
router = APIRouter(prefix="/evaluations", tags=["evaluations"], dependencies=[Depends(require_staff)])


# ---------------------------------------------------------------- helpers --

async def _get_tender_or_404(db: AsyncSession, tender_id: uuid.UUID) -> Tender:
    tender = await db.get(Tender, tender_id)
    if not tender:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tender not found")
    return tender


async def _get_submission_or_404(db: AsyncSession, submission_id: uuid.UUID) -> Submission:
    submission = await db.get(Submission, submission_id)
    if not submission:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Submission not found")
    return submission


async def _evaluations_for_tender(db: AsyncSession, tender_id: uuid.UUID) -> list[Evaluation]:
    result = await db.execute(select(Evaluation).where(Evaluation.tender_id == tender_id))
    return list(result.scalars().all())


async def _build_ranked_list(db: AsyncSession, tender: Tender) -> list[RankedSubmissionOut]:
    """Submissions ranked by procurement's score, highest first. Unscored
    submissions sort last rather than being dropped, so the evaluation page can
    still show what's left to do."""
    submissions = (
        await db.execute(select(Submission).where(Submission.tender_id == tender.id))
    ).scalars().all()
    evals = await _evaluations_for_tender(db, tender.id)
    eval_by_sub = {e.submission_id: e for e in evals}

    rows: list[RankedSubmissionOut] = []
    for sub in submissions:
        evaluation = eval_by_sub.get(sub.id)
        rows.append(
            RankedSubmissionOut(
                id=sub.id,
                company_name=sub.company_name,
                contact_name=sub.contact_name,
                email=sub.email,
                phone=sub.phone,
                total_amount=float(sub.total_amount),
                notes=sub.notes,
                files=sub.files,
                submitted_at=sub.submitted_at,
                evaluation=evaluation,
                score=float(evaluation.total_score) if evaluation else None,
            )
        )

    rows.sort(key=lambda r: (r.score is None, -(r.score or 0)))
    return rows


# ------------------------------------------------------------- overview ----

@router.get("/overview")
async def evaluation_overview(db: AsyncSession = Depends(get_db)) -> list[dict]:
    """Tenders with at least one submission, plus evaluation progress. Backs the Evaluation landing page."""
    sub_counts = dict(
        (row[0], row[1])
        for row in (
            await db.execute(select(Submission.tender_id, func.count()).group_by(Submission.tender_id))
        ).all()
    )
    if not sub_counts:
        return []

    tenders = (
        await db.execute(select(Tender).where(Tender.id.in_(sub_counts.keys())).order_by(Tender.created_at.desc()))
    ).scalars().all()

    eval_counts = dict(
        (row[0], row[1])
        for row in (
            await db.execute(
                select(Evaluation.tender_id, func.count(func.distinct(Evaluation.submission_id)))
                .where(Evaluation.tender_id.in_(sub_counts.keys()))
                .group_by(Evaluation.tender_id)
            )
        ).all()
    )

    return [
        {
            "id": t.id,
            "serial": t.serial,
            "name": t.name,
            "status": t.status,
            "submission_count": sub_counts.get(t.id, 0),
            "evaluated_count": eval_counts.get(t.id, 0),
            "evaluation_submitted": t.evaluation_submitted,
        }
        for t in tenders
    ]


@router.get("/tenders/{tender_id}/rankings", response_model=list[RankedSubmissionOut])
async def get_rankings(tender_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> list[RankedSubmissionOut]:
    tender = await _get_tender_or_404(db, tender_id)
    return await _build_ranked_list(db, tender)


# -------------------------------------------------------- saving scores ----

async def _save_evaluation(
    db: AsyncSession,
    submission: Submission,
    tender: Tender,
    payload: EvaluationSave,
    user: User,
) -> Evaluation:
    """Create or update the submission's single evaluation. `submission_id` is
    unique on the table, so re-scoring overwrites in place."""
    total = weighted_total(payload.scores, tender.scoring_criteria)

    evaluation = await db.scalar(select(Evaluation).where(Evaluation.submission_id == submission.id))
    if not evaluation:
        evaluation = Evaluation(submission_id=submission.id, tender_id=tender.id)
        db.add(evaluation)

    evaluation.scores = payload.scores
    evaluation.total_score = total
    evaluation.notes = payload.notes
    evaluation.evaluated_by = user.id
    evaluation.evaluated_at = server_now()

    await log_audit(
        db, "Submission Evaluated", f"{submission.company_name} scored {total} for {tender.serial}", user.name
    )
    await db.commit()
    await db.refresh(evaluation)
    return evaluation


@router.post("/submissions/{submission_id}/procurement", response_model=RankedSubmissionOut)
async def save_procurement_evaluation(
    submission_id: uuid.UUID,
    payload: EvaluationSave,
    user: User = Depends(require_roles("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> RankedSubmissionOut:
    """Scoring is procurement's alone. Manager and supply chain review the
    result downstream but never write an evaluation of their own."""
    submission = await _get_submission_or_404(db, submission_id)
    tender = await _get_tender_or_404(db, submission.tender_id)
    await _save_evaluation(db, submission, tender, payload, user)
    rows = await _build_ranked_list(db, tender)
    return next(r for r in rows if r.id == submission_id)


# ------------------------------------------------------------- workflow ----

@router.post("/tenders/{tender_id}/submit-for-award")
async def submit_for_award(
    tender_id: uuid.UUID,
    user: User = Depends(require_roles("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Procurement signalling that scoring is finished. Goes straight to supply
    chain — the manager's involvement ended when they approved the tender."""
    tender = await _get_tender_or_404(db, tender_id)
    rows = await _build_ranked_list(db, tender)
    evaluated = [r for r in rows if r.evaluation]
    if not evaluated:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please evaluate at least one submission first")

    top = evaluated[0]
    tender.evaluation_submitted = True
    tender.evaluation_submitted_at = server_now()
    tender.evaluation_submitted_by = user.id

    db.add(
        Notification(
            type=NotificationType.evaluation_submitted,
            tender_id=tender.id,
            message=f"{tender.serial} scored and ready to award. Top: {top.company_name} ({top.score})",
            for_role=UserRole.supply_chain,
        )
    )
    await log_audit(
        db,
        "Evaluation Submitted",
        f"{tender.serial} sent to Supply Chain. Top scored: {top.company_name} ({top.score})",
        user.name,
    )
    await db.commit()
    return {"detail": "Sent to Supply Chain for award", "recommended_vendor": top.company_name}


@router.post("/tenders/{tender_id}/supply-chain-approve")
async def supply_chain_approve(
    tender_id: uuid.UUID,
    background: BackgroundTasks,
    user: User = Depends(require_roles("admin", "supply_chain")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tender = await _get_tender_or_404(db, tender_id)
    if not tender.evaluation_submitted:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Procurement has not finished scoring this tender yet"
        )

    rows = await _build_ranked_list(db, tender)
    evaluated = [r for r in rows if r.score is not None]
    if not evaluated:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No evaluated submissions to award")

    top = evaluated[0]
    submissions = (
        await db.execute(select(Submission).where(Submission.tender_id == tender.id))
    ).scalars().all()

    tender.supply_chain_approved = True
    tender.supply_chain_rejected = False
    tender.supply_chain_reviewed_at = server_now()
    tender.supply_chain_reviewed_by = user.id
    tender.awarded_vendor_submission_id = top.id
    tender.awarded_vendor_name = top.company_name
    tender.awarded_amount = top.total_amount
    tender.awarded_email = top.email
    tender.status = TenderStatus.awarded

    db.add(
        Notification(
            type=NotificationType.tender_awarded,
            tender_id=tender.id,
            message=f"Tender {tender.serial} awarded to {top.company_name} for {tender.currency} {top.total_amount:,.2f}",
            for_role=UserRole.finance,
            details={
                "vendor": top.company_name,
                "amount": top.total_amount,
                "currency": tender.currency,
                "email": top.email,
            },
        )
    )

    scores_by_submission = {r.id: r.score for r in rows}
    queued = await send_award_emails(db, tender, submissions, scores_by_submission)

    await log_audit(
        db,
        "Tender Awarded",
        f"{tender.serial} awarded to {top.company_name} for {tender.currency} {top.total_amount:,.2f}",
        user.name,
    )
    await db.commit()

    # Delivery happens after the response — the award is committed either way,
    # and any failures land on the email log for a retry.
    background.add_task(dispatch_emails, [e.id for e in queued])

    return {
        "detail": f"Tender awarded, {len(queued)} vendor email(s) queued",
        "awarded_vendor": top.company_name,
    }


@router.post("/tenders/{tender_id}/supply-chain-reject")
async def supply_chain_reject(
    tender_id: uuid.UUID,
    payload: RejectionReason,
    user: User = Depends(require_roles("admin", "supply_chain")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tender = await _get_tender_or_404(db, tender_id)
    if not payload.reason.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please provide a rejection reason")

    tender.supply_chain_approved = False
    tender.supply_chain_rejected = True
    tender.supply_chain_reviewed_at = server_now()
    tender.supply_chain_reviewed_by = user.id
    tender.supply_chain_rejection_reason = payload.reason
    tender.status = TenderStatus.rejected

    db.add(
        Notification(
            type=NotificationType.sc_rejected,
            tender_id=tender.id,
            message=f"Tender {tender.serial} rejected by Supply Chain: {payload.reason}",
            for_role=UserRole.manager,
        )
    )
    await log_audit(db, "Tender Rejected", f"{tender.serial} rejected by Supply Chain: {payload.reason}", user.name)
    await db.commit()
    return {"detail": "Relevant parties have been notified"}
