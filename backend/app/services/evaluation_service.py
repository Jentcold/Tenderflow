def weighted_total(scores: dict[str, float], scoring_criteria: list[dict]) -> float:
    """scores: {"Price": 8.5, ...}; scoring_criteria: [{"name": "Price", "weight": 40}, ...]"""
    total = 0.0
    for criterion in scoring_criteria:
        score = float(scores.get(criterion["name"], 0))
        weight = float(criterion.get("weight", 0))
        total += (score * weight) / 100
    return round(total, 2)


