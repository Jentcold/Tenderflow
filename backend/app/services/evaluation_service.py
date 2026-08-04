def weighted_total(scores: dict[str, float], scoring_criteria: list[dict]) -> float:
    """scores: {"Price": 8.5, ...}; scoring_criteria: [{"name": "Price", "weight": 40}, ...]"""
    total = 0.0
    for criterion in scoring_criteria:
        score = float(scores.get(criterion["name"], 0))
        weight = float(criterion.get("weight", 0))
        total += (score * weight) / 100
    return round(total, 2)


def combine_scores(procurement_score: float | None, manager_score: float | None) -> float | None:
    """50/50 split once both stages have scored a submission; falls back to procurement-only."""
    if procurement_score is not None and manager_score is not None:
        return round((procurement_score * 0.5) + (manager_score * 0.5), 2)
    if procurement_score is not None:
        return procurement_score
    return None
