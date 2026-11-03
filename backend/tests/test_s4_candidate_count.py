import json

import pytest

from app.ai.comments import CandidateCountError, parse_comments


def result(count):
    item = {"mind_preset_id": "gentle_reflection", "text": "synthetic",
            "anchor": {"node_id": "node", "start": 0, "end": 1, "quote": "s"}}
    return json.dumps({"comments": [item] * count})


@pytest.mark.parametrize("count", [0, 1, 4])
def test_candidate_mode_rejects_invalid_counts(count):
    with pytest.raises(CandidateCountError):
        parse_comments(result(count), {"mind_preset_ids": ["gentle_reflection"], "candidate_mode": True})


@pytest.mark.parametrize("count", [2, 3])
def test_candidate_mode_accepts_two_or_three(count):
    assert len(parse_comments(result(count), {"mind_preset_ids": ["gentle_reflection"], "candidate_mode": True})) == count


@pytest.mark.parametrize("count", [0, 1, 4])
def test_legacy_comments_preserve_existing_counts(count):
    assert len(parse_comments(result(count), {"mind_preset_ids": ["gentle_reflection"]})) == count
