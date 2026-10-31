from copy import deepcopy
from types import SimpleNamespace

import pytest

from app.journal.schemas import JournalUpdate
from app.writing.service import LegacyConversionRequired, writing_changes


BLOCK_ID = '11111111-1111-4111-8111-111111111111'


def candidate(text='hello'):
    return {'type': 'doc', 'content': [{'type': 'legacyText', 'attrs': {
        'id': BLOCK_ID, 'author': 'user', 'raw_text': text}}]}


class NoReferences:
    def scalar(self, query):
        return None


def row(blocks=None, text='hello'):
    return SimpleNamespace(id=1, journal_kind='writing', content=text,
                           content_doc=None, content_blocks=blocks)


def test_single_user_block_is_equivalent_and_preserves_old_data():
    original = row([{'id': BLOCK_ID, 'kind': 'user', 'text': 'hello'}])
    before = deepcopy(original.__dict__)
    doc = candidate()
    assert writing_changes(original, JournalUpdate(content_doc=doc, expected_revision=1), db=NoReferences()) == {'content_doc': doc}
    assert original.__dict__ == before


@pytest.mark.parametrize('blocks', [[], [{'id': BLOCK_ID, 'kind': 'user', 'text': 'different'}],
    [{'id': BLOCK_ID, 'kind': 'user', 'text': 'hello', 'extra': True}],
    [{'id': BLOCK_ID, 'kind': 'ai_reply', 'text': 'hello'}],
    [{'id': BLOCK_ID, 'kind': 'user', 'text': 'hello'}] * 2])
def test_unsafe_shapes_are_rejected_without_mutation(blocks):
    original = row(blocks)
    before = deepcopy(original.__dict__)
    with pytest.raises(LegacyConversionRequired):
        writing_changes(original, JournalUpdate(content_doc=candidate(), expected_revision=1), db=NoReferences())
    assert original.__dict__ == before


def test_missing_database_or_existing_reference_refuses_conversion():
    original = row([{'id': BLOCK_ID, 'kind': 'user', 'text': 'hello'}])
    data = JournalUpdate(content_doc=candidate(), expected_revision=1)
    with pytest.raises(LegacyConversionRequired):
        writing_changes(original, data)
    class HasReference:
        def scalar(self, query):
            return 1
    with pytest.raises(LegacyConversionRequired):
        writing_changes(original, data, db=HasReference())


def test_combined_metadata_and_link_text_are_refused():
    original = row([{'id': BLOCK_ID, 'kind': 'user', 'text': 'hello'}])
    with pytest.raises(LegacyConversionRequired):
        writing_changes(original, JournalUpdate(content_doc=candidate(), title='changed', expected_revision=1), db=NoReferences())
    original = row([{'id': BLOCK_ID, 'kind': 'user', 'text': '[[missing]]'}], text='[[missing]]')
    with pytest.raises(LegacyConversionRequired):
        writing_changes(original, JournalUpdate(content_doc=candidate('[[missing]]'), expected_revision=1), db=NoReferences())
