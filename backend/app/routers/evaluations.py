import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import log_audit
from app.core.deps import get_current_user, require_roles
from app.database import get_db
from app.models.evaluation import Evaluation, EvaluatorRole
from app.models.notification import Notification, NotificationType
from app.models.submission import Submission
from app.models.tender import Tender, TenderStatus
from app.models.user import User, UserRole
from app.schemas.evaluation import EvaluationSave, RankedSubmissionOut, RejectionReason
from app.services.email_service import send_award_emails
from app.services.evaluation_service import combine_scores, weighted_total

router = APIRouter(prefix="/evaluations", tags=["evaluations"], dependencies=[Depends(get_current_user)])


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


async def _build_ranked_list(db: AsyncSession, tender: Tender, combined: bool) -> list[RankedSubmissionOut]:
    submissions = (
        await db.execute(select(Submission).where(Submission.tender_id == tender.id))
    ).scalars().all()
    evals = await _evaluations_for_tender(db, tender.id)

    proc_by_sub = {e.submission_id: e for e in evals if e.evaluator_role == EvaluatorRole.procurement}
    mgr_by_sub = {e.submission_id: e for e in evals if e.evaluator_role == EvaluatorRole.manager}

    rows: list[RankedSubmissionOut] = []
    for sub in submissions:
        proc_eval = proc_by_sub.get(sub.id)
        mgr_eval = mgr_by_sub.get(sub.id)
        combined_score = combine_scores(
            float(proc_eval.total_score) if proc_eval else None,
            float(mgr_eval.total_score) if mgr_eval else None,
        )
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
                procurement_evaluation=proc_eval,
                manager_evaluation=mgr_eval,
                combined_score=combined_score,
            )
        )

    if combined:
        rows.sort(key=lambda r: (r.combined_score is None, -(r.combined_score or 0)))
    else:
        rows.sort(
            key=lambda r: (
                r.procurement_evaluation is None,
                -(float(r.procurement_evaluation.total_score) if r.procurement_evaluation else 0),
            )
        )
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
                .where(Evaluation.tender_id.in_(sub_counts.keys()), Evaluation.evaluator_role == EvaluatorRole.procurement)
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
    return await _build_ranked_list(db, tender, combined=False)


@router.get("/tenders/{tender_id}/combined-rankings", response_model=list[RankedSubmissionOut])
async def get_combined_rankings(tender_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> list[RankedSubmissionOut]:
    tender = await _get_tender_or_404(db, tender_id)
    return await _build_ranked_list(db, tender, combined=True)


# -------------------------------------------------------- saving scores ----

async def _save_evaluation(
    db: AsyncSession,
    submission: Submission,
    tender: Tender,
    role: EvaluatorRole,
    payload: EvaluationSave,
    user: User,
) -> Evaluation:
    total = weighted_total(payload.scores, tender.scoring_criteria)

    evaluation = await db.scalar(
        select(Evaluation).where(Evaluation.submission_id == submission.id, Evaluation.evaluator_role == role)
    )
    if not evaluation:
        evaluation = Evaluation(submission_id=submission.id, tender_id=tender.id, evaluator_role=role)
        db.add(evaluation)

    evaluation.scores = payload.scores
    evaluation.total_score = total
    evaluation.notes = payload.notes
    evaluation.evaluated_by = user.id
    evaluation.evaluated_at = datetime.now(timezone.utc)

    label = "Manager Evaluation" if role == EvaluatorRole.manager else "Submission Evaluated"
    await log_audit(db, label, f"{submission.company_name} scored {total} for {tender.serial}", user.name)
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
    submission = await _get_submission_or_404(db, submission_id)
    tender = await _get_tender_or_404(db, submission.tender_id)
    await _save_evaluation(db, submission, tender, EvaluatorRole.procurement, payload, user)
    rows = await _build_ranked_list(db, tender, combined=False)
    return next(r for r in rows if r.id == submission_id)


@router.post("/submissions/{submission_id}/manager", response_model=RankedSubmissionOut)
async def save_manager_evaluation(
    submission_id: uuid.UUID,
    payload: EvaluationSave,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> RankedSubmissionOut:
    submission = await _get_submission_or_404(db, submission_id)
    tender = await _get_tender_or_404(db, submission.tender_id)
    await _save_evaluation(db, submission, tender, EvaluatorRole.manager, payload, user)
    rows = await _build_ranked_list(db, tender, combined=True)
    return next(r for r in rows if r.id == submission_id)


# ------------------------------------------------------------- workflow ----

@router.post("/tenders/{tender_id}/submit-to-manager")
async def submit_to_manager(
    tender_id: uuid.UUID,
    user: User = Depends(require_roles("admin", "procurement")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tender = await _get_tender_or_404(db, tender_id)
    rows = await _build_ranked_list(db, tender, combined=False)
    evaluated = [r for r in rows if r.procurement_evaluation]
    if not evaluated:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please evaluate at least one submission first")

    top = evaluated[0]
    tender.evaluation_submitted = True
    tender.evaluation_submitted_at = datetime.now(timezone.utc)
    tender.evaluation_submitted_by = user.id

    db.add(
        Notification(
            type=NotificationType.evaluation_submitted,
            tender_id=tender.id,
            message=f"Evaluation submitted for {tender.serial} - {tender.name}",
            for_role=UserRole.manager,
        )
    )
    await log_audit(
        db,
        "Evaluation Submitted",
        f"{tender.serial} submitted to Department Manager. Recommended: {top.company_name}",
        user.name,
    )
    await db.commit()
    return {"detail": "Submitted to Department Manager", "recommended_vendor": top.company_name}


@router.post("/tenders/{tender_id}/manager-approve")
async def manager_approve(
    tender_id: uuid.UUID,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tender = await _get_tender_or_404(db, tender_id)
    rows = await _build_ranked_list(db, tender, combined=True)
    if not any(r.manager_evaluation for r in rows):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please add your evaluation to at least one submission first")

    top = rows[0]
    tender.manager_approved = True
    tender.manager_rejected = False
    tender.manager_reviewed_at = datetime.now(timezone.utc)
    tender.manager_reviewed_by = user.id

    db.add(
        Notification(
            type=NotificationType.manager_approved,
            tender_id=tender.id,
            message=f"{tender.serial} approved by Manager. Combined Score: {top.combined_score}. Recommended: {top.company_name}",
            for_role=UserRole.supply_chain,
        )
    )
    await log_audit(
        db,
        "Evaluation Approved",
        f"{tender.serial} approved by Manager. Recommended: {top.company_name} (Combined: {top.combined_score})",
        user.name,
    )
    await db.commit()
    return {"detail": "Forwarded to Supply Chain Head", "recommended_vendor": top.company_name}


@router.post("/tenders/{tender_id}/manager-reject")
async def manager_reject(
    tender_id: uuid.UUID,
    payload: RejectionReason,
    user: User = Depends(require_roles("admin", "manager")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tender = await _get_tender_or_404(db, tender_id)
    if not payload.reason.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please provide a reason for the requested changes")

    tender.manager_approved = False
    tender.manager_rejected = True
    tender.manager_reviewed_at = datetime.now(timezone.utc)
    tender.manager_reviewed_by = user.id
    tender.manager_feedback = payload.reason
    tender.evaluation_submitted = False

    db.add(
        Notification(
            type=NotificationType.changes_requested,
            tender_id=tender.id,
            message=f"Changes requested for {tender.serial}: {payload.reason}",
            for_role=UserRole.procurement,
        )
    )
    await log_audit(db, "Changes Requested", f"{tender.serial} - Manager requested changes: {payload.reason}", user.name)
    await db.commit()
    return {"detail": "Feedback sent to Procurement team"}


@router.post("/tenders/{tender_id}/supply-chain-approve")
async def supply_chain_approve(
    tender_id: uuid.UUID,
    user: User = Depends(require_roles("admin", "supply_chain")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tender = await _get_tender_or_404(db, tender_id)
    rows = await _build_ranked_list(db, tender, combined=True)
    evaluated = [r for r in rows if r.combined_score is not None]
    if not evaluated:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No evaluated submissions to award")

    top = evaluated[0]
    submissions = (
        await db.execute(select(Submission).where(Submission.tender_id == tender.id))
    ).scalars().all()

    tender.supply_chain_approved = True
    tender.supply_chain_rejected = False
    tender.supply_chain_reviewed_at = datetime.now(timezone.utc)
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

    combined_scores_by_submission = {r.id: r.combined_score for r in rows}
    await send_award_emails(db, tender, submissions, combined_scores_by_submission)

    await log_audit(
        db,
        "Tender Awarded",
        f"{tender.serial} awarded to {top.company_name} for {tender.currency} {top.total_amount:,.2f}",
        user.name,
    )
    await db.commit()
    return {"detail": "Tender awarded, emails sent to all vendors", "awarded_vendor": top.company_name}


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
    tender.supply_chain_reviewed_at = datetime.now(timezone.utc)
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
