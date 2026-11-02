from copy import deepcopy

import pytest

from app.writing.documents import DocumentError, validate_author_changes


def test_editor_can_add_missing_paragraph_id_without_changing_ai_reply():
    old = {'type': 'doc', 'content': [{
        'type': 'aiReply',
        'attrs': {'id': '11111111-1111-4111-8111-111111111111',
                  'request_id': '22222222-2222-4222-8222-222222222222'},
        'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': 'synthetic reply'}]}],
    }]}
    new = deepcopy(old)
    paragraph = new['content'][0]['content'][0]
    paragraph['attrs'] = {'id': '33333333-3333-4333-8333-333333333333'}
    validate_author_changes(old, new)

    altered = deepcopy(new)
    altered['content'][0]['content'][0]['content'][0]['text'] = 'altered reply'
    with pytest.raises(DocumentError, match='protected node changed'):
        validate_author_changes(old, altered)

    changed_id = deepcopy(new)
    changed_id['content'][0]['content'][0]['attrs']['id'] = '44444444-4444-4444-8444-444444444444'
    with pytest.raises(DocumentError, match='protected node changed'):
        validate_author_changes(new, changed_id)
