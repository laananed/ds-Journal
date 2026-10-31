"""Conservative source classification for a future Inbox retirement.

This module does not connect to a database or authorize any deletion.  Its
result is only one input to a separately verified, exclusive migration window.
"""


class RetirementBlocked(ValueError):
    """A persisted source cannot be classified without guessing."""


def classify_sources(sources: object) -> bool:
    """Return whether the *entire* request must be removed; reject ambiguity."""
    if not isinstance(sources, list) or not sources:
        raise RetirementBlocked('request sources are missing or malformed')
    has_inbox = False
    for source in sources:
        if not isinstance(source, dict):
            raise RetirementBlocked('request source is malformed')
        source_type = source.get('type')
        source_id = source.get('id')
        if source_type not in ('journal', 'inbox'):
            raise RetirementBlocked('request source type is unknown')
        if type(source_id) is not int or source_id < 1:
            raise RetirementBlocked('request source identity is invalid')
        has_inbox |= source_type == 'inbox'
    return has_inbox


def plan_requests(rows: list[dict]) -> list:
    """Build an in-memory candidate list; never mutate the rows or database.

    All rows are inspected before returning. Even a Journal-only in-flight
    request blocks this conservative plan: this check cannot prove that a
    process with older code has stopped or that its snapshot is isolated.
    """
    candidates = []
    ids = set()
    for row in rows:
        request_id = row.get('id')
        if request_id is None or request_id in ids:
            raise RetirementBlocked('request identity is missing or duplicated')
        ids.add(request_id)
        if row.get('status') not in ('ready', 'applied', 'failed', 'conflict'):
            raise RetirementBlocked('request status requires investigation')
        if classify_sources(row.get('sources')):
            candidates.append(request_id)
    return candidates
