import copy
import json
import hashlib
from pathlib import Path
import unittest

from app.writing.documents import DocumentError, validate_document, project_document, user_text_document, validate_author_changes, convert_legacy_text, validate_anchor

UID = '11111111-1111-4111-8111-111111111111'
RID = '22222222-2222-4222-8222-222222222222'


def doc(*nodes):
    return {'type': 'doc', 'content': list(nodes)}


def para(text):
    return {'type': 'paragraph', 'content': [{'type': 'text', 'text': text}]}


class DocumentFoundationTests(unittest.TestCase):
    def test_shared_validity_fixtures(self):
        base = Path(__file__).resolve().parents[3] / 'tests' / 'fixtures' / 'stage4_documents'
        for name, valid in [('valid.json', True), ('invalid.json', False)]:
            for case in json.loads((base / name).read_text(encoding='utf-8')):
                with self.subTest(case=case['id']):
                    if valid:
                        validate_document(case['input'])
                    else:
                        with self.assertRaises(DocumentError):
                            validate_document(case['input'])

    def test_shared_legacy_fixtures(self):
        base = Path(__file__).resolve().parents[3] / 'tests' / 'fixtures' / 'stage4_documents'
        for case in json.loads((base / 'legacy.json').read_text(encoding='utf-8')):
            data = case['input']
            with self.subTest(case=case['id']):
                if case['conversion'] == 'legacy_conversion_required':
                    with self.assertRaises(DocumentError):
                        convert_legacy_text(data['content'], data['content_blocks'])
                else:
                    result = convert_legacy_text(data['content'], data['content_blocks'])
                    self.assertEqual(user_text_document(result), data['content'])
                    self.assertEqual(project_document(result), data['content'])
    def test_shared_projection_fixtures(self):
        path = Path(__file__).resolve().parents[3] / 'tests' / 'fixtures' / 'stage4_documents' / 'projections.json'
        for case in json.loads(path.read_text(encoding='utf-8')):
            with self.subTest(case=case['id']):
                self.assertEqual(project_document(case['input']), case['R'])
                self.assertEqual(user_text_document(case['input']), case['U'])
    def test_projection_separates_authors_and_unicode(self):
        d = doc(para('你好😀'), {'type': 'aiReply', 'attrs': {'id': UID, 'request_id': RID}, 'content': [para('AI')]}, para('结尾'))
        validate_document(d)
        self.assertEqual(user_text_document(d), '你好😀\n结尾')
        self.assertEqual(project_document(d), '你好😀\n\n> AI 回复\n> AI\n\n\n结尾')

    def test_legacy_source_is_preserved(self):
        d = doc({'type':'legacyText', 'attrs':{'id': UID, 'author':'user', 'raw_text':'a\n\nb'}})
        validate_document(d)
        self.assertEqual(user_text_document(d), 'a\n\nb')
        self.assertEqual(project_document(d), 'a\n\nb')

    def test_user_legacy_text_can_be_edited_without_changing_author(self):
        old = doc({'type':'legacyText','attrs':{'id':UID,'author':'user','raw_text':'old'}})
        edited = doc({'type':'legacyText','attrs':{'id':UID,'author':'user','raw_text':'new'}})
        validate_author_changes(old, edited)
        edited['content'][0]['attrs']['author'] = 'ai'
        with self.assertRaises(DocumentError):
            validate_author_changes(old, edited)

    def test_ai_legacy_is_excluded_from_user_projection(self):
        d = doc({'type':'legacyText', 'attrs':{'id':UID, 'author':'ai', 'raw_text':'AI 文本'}})
        self.assertEqual(user_text_document(d), '')
        self.assertIn('AI', project_document(d))

    def test_empty_user_block_is_a_real_boundary(self):
        d = doc(para('a'), {'type':'paragraph'}, para('b'))
        self.assertEqual(user_text_document(d), 'a\n\nb')

    def test_reading_projection_preserves_heading_lists_and_marks(self):
        d = doc({'type':'heading','attrs':{'level':2},'content':[{'type':'text','text':'标题'}]},
                {'type':'bulletList','content':[{'type':'listItem','content':[{'type':'paragraph','content':[{'type':'text','text':'重要','marks':[{'type':'bold'}]}]}]}]})
        self.assertEqual(project_document(d), '## 标题\n- **重要**')
        self.assertEqual(user_text_document(d), '标题\n重要')

    def test_anchor_uses_block_id_and_unicode_codepoints(self):
        d = doc({'type':'paragraph', 'attrs':{'id': UID}, 'content':[{'type':'text','text':'甲😀乙'}]})
        digest = hashlib.sha256('😀'.encode('utf-8')).hexdigest()
        validate_anchor(d, {'node_id':UID, 'start':1, 'end':2, 'quote':'😀', 'quote_sha256':digest})
        with self.assertRaises(DocumentError):
            validate_anchor(d, {'node_id':UID, 'start':1, 'end':3, 'quote':'😀', 'quote_sha256':digest})
        with self.assertRaises(DocumentError):
            validate_document(doc({'type':'paragraph','content':[{'type':'text','attrs':{'id':UID},'text':'x'}]}))

    def test_rejects_duplicate_id_unsafe_link_unknown_node(self):
        for d in (doc({'type':'legacyText','attrs':{'id':UID,'author':'user','raw_text':'a'}}, {'type':'legacyText','attrs':{'id':UID,'author':'ai','raw_text':'b'}}), doc({'type':'unknown'}), doc({'type':'paragraph','content':[{'type':'text','text':'x','marks':[{'type':'link','attrs':{'href':'javascript:alert(1)'}}]}]})):
            with self.subTest(d=d), self.assertRaises(DocumentError):
                validate_document(d)

    def test_malformed_root_and_mark_fail_closed(self):
        for d in ({'type':'doc'}, doc({'type':'paragraph','content':[{'type':'text','text':'x','marks':[{'type': []}]}]})):
            with self.assertRaises(DocumentError):
                validate_document(d)

    def test_ai_identity_and_content_cannot_be_forged(self):
        ai = {'type':'aiReply','attrs':{'id':UID,'request_id':RID},'content':[para('a')]}
        with self.assertRaises(DocumentError):
            validate_author_changes(doc(), doc(ai))
        changed = copy.deepcopy(ai)
        changed['content'] = [para('changed')]
        with self.assertRaises(DocumentError):
            validate_author_changes(doc(ai), doc(changed))
        with self.assertRaises(DocumentError):
            validate_author_changes(doc(ai), doc())

    def test_legacy_conversion_preserves_exact_text_and_rejects_blocks(self):
        raw = '一😀\n\n[[引用]]\n'
        converted = convert_legacy_text(raw, None)
        self.assertEqual(project_document(converted), raw)
        self.assertEqual(user_text_document(converted), raw)
        with self.assertRaises(DocumentError):
            convert_legacy_text(raw, [{'kind': 'ai_reply', 'text': 'a'}])


if __name__ == '__main__':
    unittest.main()
