from uuid import uuid4
import pytest
from app.writing import documents
from app.writing.documents import DocumentError, user_text_document


def para(text):
    return {'type':'paragraph', 'attrs':{'id':str(uuid4())}, 'content':[{'type':'text','text':text}]}


def test_reply_at_original_boundary_preserves_later_input():
    request = str(uuid4())
    source = {'type':'doc', 'content':[para('原始😀')]}
    prepared = documents.prepare_ai_placeholder(source, request)
    snapshot = user_text_document(source)
    prepared['content'][-1]['content'] = [{'type':'text','text':'继续输入'}]
    applied = documents.apply_ai_placeholder(prepared, request, snapshot, '回复')
    assert applied['content'][-1]['content'][0]['text'] == '继续输入'
    assert applied['content'][-2]['type'] == 'aiReply'
    assert user_text_document(applied).startswith(snapshot)


def test_old_text_change_or_missing_placeholder_fails_closed():
    request = str(uuid4())
    source = {'type':'doc', 'content':[para('旧文')]}
    prepared = documents.prepare_ai_placeholder(source, request)
    prepared['content'][0]['content'][0]['text'] = '修改'
    with pytest.raises(DocumentError):
        documents.apply_ai_placeholder(prepared, request, user_text_document(source), '回复')
    prepared['content'] = [n for n in prepared['content'] if n['type'] != 'aiPlaceholder']
    with pytest.raises(DocumentError):
        documents.apply_ai_placeholder(prepared, request, user_text_document(source), '回复')
