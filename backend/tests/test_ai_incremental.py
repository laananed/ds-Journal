"""User-only code-point incremental input and bounded question context."""
from uuid import uuid4

import pytest

from app.ai.incremental import compute_increment, user_text, bounded_context


@pytest.mark.parametrize('current,checkpoint,text,revised,position,valid', [
    ('甲😀乙', None, '甲😀乙', False, 0, True),
    ('甲😀乙 新', '甲😀乙', ' 新', False, 3, True),
    ('甲😀改', '甲😀乙', '改', True, 2, True),
    ('甲', '甲乙', '', True, 1, False),
    ('', '甲乙', '', True, 0, False),
    ('甲\ufeff\u3000', '甲', '\ufeff\u3000', False, 1, False),
    ('甲', '甲', '', False, 1, False),
])
def test_increment(current, checkpoint, text, revised, position, valid):
    result = compute_increment(current, checkpoint)
    assert (result.text, result.revised, result.position, result.valid) == (text, revised, position, valid)


def test_authors_and_null_legacy_are_distinct():
    blocks = [{'id': str(uuid4()), 'kind': kind, 'text': text}
              for kind, text in [('user', '甲'), ('ai_reply', '禁止事实'),
                                 ('ai_summary', '禁止总结'), ('user', '😀乙')]]
    assert user_text(blocks, 'wrong projection') == '甲😀乙'
    assert user_text(None, '> AI 回复\n旧文字') == '> AI 回复\n旧文字'
    assert user_text([], 'wrong') == ''


def test_context_limits_complete_messages_and_excludes_journal_snapshots():
    turns = [{'question': f'问题{i}', 'reply': f'回答{i}', 'user_text': '旧全文'} for i in range(5)]
    messages = bounded_context(turns)
    assert len(messages) == 6
    assert messages[0] == {'role': 'user', 'content': '问题2'}
    assert '旧全文' not in str(messages)
    assert bounded_context([{'question': 'q' * 4001, 'reply': 'a' * 4001}]) == []
    assert sum(len(m['content']) for m in bounded_context([{'question': 'q' * 2000, 'reply': 'a' * 2000}])) == 4000


def test_reply_uses_captured_user_boundary_before_following_ai():
    from types import SimpleNamespace
    from app.writing.service import insert_ai_reply, project_blocks
    blocks = [{'id': str(uuid4()), 'kind': 'user', 'text': '用户原文'},
              {'id': str(uuid4()), 'kind': 'ai_summary', 'text': '既有总结', 'request_id': str(uuid4())}]
    row = SimpleNamespace(content_blocks=blocks, content=project_blocks(blocks), revision=1)
    insert_ai_reply(row, '新回复', uuid4(), blocks)
    assert [b['kind'] for b in row.content_blocks] == ['user', 'ai_reply', 'user', 'ai_summary']
    assert row.content_blocks[0] == blocks[0] and row.content_blocks[-1] == blocks[1]
    assert row.content_blocks[2]['text'] == ''
