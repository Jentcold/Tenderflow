"""How an offer is referred to when its bidder isn't.

Offers are read anonymously - the whole point of the manager's view is that
"Offer B" is cheaper than "Offer C", not that one supplier is cheaper than
another. That makes the label the only handle anyone has on an offer, in
emails and in conversation, so it lives in one place rather than being spelled
out wherever a list happens to be built.
"""


def offer_label(index: int) -> str:
    """0 -> 'Offer A', 25 -> 'Offer Z', 26 -> 'Offer AA'.

    Spreadsheet-column lettering rather than plain A-Z, so a tender with more
    than 26 offers doesn't end up with two called the same thing.

    The index is a position in whatever list is being rendered, so the same
    offer is 'Offer B' on a tender-wide price-sorted desk and 'Offer A' inside
    its own bid. That is intended: each list letters what it is showing.
    """
    letters = ""
    while True:
        letters = chr(ord("A") + index % 26) + letters
        index = index // 26 - 1
        if index < 0:
            return f"Offer {letters}"
