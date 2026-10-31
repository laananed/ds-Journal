"""Synthetic counterexamples for preserving old block identities and projections."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from app.ai.incremental import compute_increment, user_text
from app.journal.schemas import JournalUpdate
from app.writing.documents import project_document, user_text_document
from app.writing.service import LegacyConversionRequired, project_blocks, writing_changes

FIRST = '11111111-1111-4111-8111-111111111111'
SECOND = '22222222-2222-4222-8222-222222222222'
THIRD = '33333333-3333-4333-8333-333333333333'
REQUEST = '44444444-4444-4444-8444-444444444444'


def legacy(node_id, text):
    return {'type': 'legacyText', 'attrs': {'id': node_id, 'author': 'user', 'raw_text': text}}


def test_two_user_blocks_preserve_ids_but_change_projection_and_checkpoint_delta():
    blocks = [{'id': FIRST, 'kind': 'user', 'text': '甲'},
              {'id': SECOND, 'kind': 'user', 'text': '乙'}]
    document = {'type': 'doc', 'content': [legacy(FIRST, '甲'), legacy(SECOND, '乙')]}
    assert project_blocks(blocks) == user_text(blocks, '') == '甲乙'
    assert project_document(document) == user_text_document(document) == '甲\n乙'
    assert compute_increment('甲乙', '甲').text == '乙'
    assert compute_increment('甲\n乙', '甲').text == '\n乙'
    row = SimpleNamespace(id=1, journal_kind='writing', content='甲乙', content_doc=None, content_blocks=blocks)
    before = deepcopy(row.__dict__)
    with pytest.raises(LegacyConversionRequired):
        writing_changes(row, JournalUpdate(content_doc=document, expected_revision=1))
    assert row.__dict__ == before


def test_interleaved_ai_preserves_request_id_but_not_original_projections():
    blocks = [{'id': FIRST, 'kind': 'user', 'text': '甲'},
              {'id': SECOND, 'kind': 'ai_reply', 'text': '答', 'request_id': REQUEST},
              {'id': THIRD, 'kind': 'user', 'text': '乙'}]
    document = {'type': 'doc', 'content': [legacy(FIRST, '甲'),
        {'type': 'aiReply', 'attrs': {'id': SECOND, 'request_id': REQUEST},
         'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': '答'}]}]},
        legacy(THIRD, '乙')]}
    assert user_text(blocks, '') == '甲乙'
    assert user_text_document(document) == '甲\n乙'
    assert project_blocks(blocks) != project_document(document)
    row = SimpleNamespace(id=1, journal_kind='writing', content=project_blocks(blocks), content_doc=None, content_blocks=blocks)
    before = deepcopy(row.__dict__)
    with pytest.raises(LegacyConversionRequired):
        writing_changes(row, JournalUpdate(content_doc=document, expected_revision=1))
    assert row.__dict__ == before
