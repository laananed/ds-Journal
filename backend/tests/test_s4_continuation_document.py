from uuid import uuid4
import pytest
from app.writing import documents


def test_capture_cursor_uses_only_user_text_before_unicode_cursor():
    first, second = str(uuid4()), str(uuid4())
    doc = {'type': 'doc', 'content': [
        {'type': 'paragraph', 'attrs': {'id': first}, 'content': [{'type': 'text', 'text': 'first'}]},
        {'type': 'paragraph', 'attrs': {'id': second}, 'content': [{'type': 'text', 'text': 'A🙂BC'}]},
    ]}
    context, root_id = documents.capture_continuation_cursor(doc, second, 2)
    assert context == 'first\nA🙂'
    assert root_id == second
    with pytest.raises(documents.DocumentError):
        documents.capture_continuation_cursor(doc, second, 9)


def test_insert_continuation_preserves_original_text_and_provenance():
    node, request = str(uuid4()), str(uuid4())
    doc = {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {'id': node},
        'content': [{'type': 'text', 'text': 'original'}]}]}
    changed = documents.insert_continuation_reply(doc, node, request, 'candidate')
    assert changed['content'][0] == doc['content'][0]
    assert changed['content'][1]['type'] == 'aiReply'
    assert documents.user_text_document(changed) == documents.user_text_document(doc)


def test_capture_cursor_inside_goal_preserves_preceding_text():
    node, goal = str(uuid4()), str(uuid4())
    doc = {'type': 'doc', 'content': [
        {'type': 'paragraph', 'attrs': {'id': str(uuid4())}, 'content': [{'type': 'text', 'text': 'prior'}]},
        {'type': 'goalItem', 'attrs': {'id': node, 'goal_id': goal, 'text': 'goal details', 'checked': False}},
    ]}
    context, root_id = documents.capture_continuation_cursor(doc, node, 4)
    assert context == 'prior\ngoal'
    assert root_id == node
