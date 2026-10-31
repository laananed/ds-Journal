from copy import deepcopy
from types import SimpleNamespace
import pytest

from app.ai.incremental import user_text
from app.journal.schemas import JournalUpdate
from app.writing.documents import DocumentError, project_document, user_text_document, validate_author_changes
from app.writing.service import LegacyConversionRequired, project_blocks, writing_changes

IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
BLOCKS = [{'id': IDS[0], 'kind': 'user', 'text': '甲'}, {'id': IDS[1], 'kind': 'user', 'text': '乙'}]


def doc(blocks=BLOCKS):
    return {'type': 'doc', 'content': [{'type': 'legacyBlocks', 'attrs': {'id': IDS[2], 'format_version': 1, 'blocks': deepcopy(blocks)}}]}


class EmptyDB:
    def scalar(self, query):
        return None


def test_two_blocks_preserve_exact_projections_and_convert_without_mutating_row():
    document = doc()
    assert project_document(document) == project_blocks(BLOCKS) == '甲乙'
    assert user_text_document(document) == user_text(BLOCKS, '') == '甲乙'
    row = SimpleNamespace(id=1, journal_kind='writing', content='甲乙', content_doc=None, content_blocks=deepcopy(BLOCKS))
    before = deepcopy(row.__dict__)
    assert writing_changes(row, JournalUpdate(content_doc=document, expected_revision=1), db=EmptyDB()) == {'content_doc': document}
    assert row.__dict__ == before


def test_author_guard_allows_only_user_text_edits():
    old = doc()
    edited = deepcopy(old)
    edited['content'][0]['attrs']['blocks'][0]['text'] = '新'
    validate_author_changes(old, edited)
    edited['content'][0]['attrs']['blocks'][0]['id'] = IDS[2]
    with pytest.raises(DocumentError):
        validate_author_changes(old, edited)


def test_wrong_content_or_forged_block_is_rejected():
    row = SimpleNamespace(id=1, journal_kind='writing', content='甲乙', content_doc=None, content_blocks=deepcopy(BLOCKS))
    altered = doc()
    altered['content'][0]['attrs']['blocks'][0]['text'] = '伪'
    with pytest.raises(LegacyConversionRequired):
        writing_changes(row, JournalUpdate(content_doc=altered, expected_revision=1), db=EmptyDB())


def test_ai_projection_and_source_protection_but_conversion_refused():
    ai = {'id': IDS[1], 'kind': 'ai_reply', 'text': '答', 'request_id': '44444444-4444-4444-8444-444444444444'}
    blocks = [BLOCKS[0], ai]
    original = doc(blocks)
    assert project_document(original) == project_blocks(blocks)
    assert user_text_document(original) == user_text(blocks, '')
    forged = deepcopy(original)
    forged['content'][0]['attrs']['blocks'][1]['text'] = '伪造'
    with pytest.raises(DocumentError):
        validate_author_changes(original, forged)
    row = SimpleNamespace(id=1, journal_kind='writing', content=project_blocks(blocks), content_doc=None, content_blocks=deepcopy(blocks))
    before = deepcopy(row.__dict__)
    with pytest.raises(LegacyConversionRequired):
        writing_changes(row, JournalUpdate(content_doc=original, expected_revision=1), db=EmptyDB())
    assert row.__dict__ == before


def test_duplicate_internal_id_is_rejected():
    duplicate = [BLOCKS[0], deepcopy(BLOCKS[0])]
    with pytest.raises(DocumentError):
        project_document(doc(duplicate))
