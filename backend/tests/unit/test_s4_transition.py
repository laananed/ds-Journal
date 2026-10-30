import os
import unittest
from types import SimpleNamespace

os.environ.setdefault('DATABASE_URL', 'postgresql+psycopg://test:test@127.0.0.1/seekjournal_test')
from app.journal.schemas import JournalUpdate, JournalCreate
from app.insight.schemas import InsightUpdate, InsightCreate
from app.writing.service import writing_changes, WriteConflict, WritingError, create_hash, document_content
import hashlib
import json
from datetime import date, datetime, timezone


def paragraph(text):
    return {'type': 'doc', 'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': text}]}]}


class TransitionTests(unittest.TestCase):
    def test_legacy_create_hash_is_unchanged(self):
        for model, body in ((JournalCreate, {'content':'hello', 'journal_date':'2026-10-30'}),
                            (InsightCreate, {'content':'hello'})):
            data = model(**body)
            dumped = data.model_dump(mode='json', exclude={'client_create_id', 'content_doc', 'document_schema_version', 'journal_kind', 'draft_started_at'})
            old_hash = hashlib.sha256(json.dumps(dumped, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            self.assertEqual(create_hash(data), old_hash)

    def test_new_client_cannot_forge_comments(self):
        d = paragraph('text')
        d['content'][0]['content'][0]['marks'] = [{'type':'mindComment', 'attrs':{'comment_ids':['11111111-1111-4111-8111-111111111111']}}]
        with self.assertRaises(WritingError):
            document_content(d)

    def test_legacy_equivalent_conversion_does_not_rewrite_content(self):
        raw = 'hello\n😀'
        row = SimpleNamespace(content=raw, content_doc=None, content_blocks=None, title=None)
        doc = {'type':'doc', 'content':[{'type':'legacyText','attrs':{'id':'11111111-1111-4111-8111-111111111111','author':'user','raw_text':raw}}]}
        self.assertEqual(writing_changes(row, JournalUpdate(content_doc=doc, expected_revision=1)), {'content_doc':doc})

    def test_detail_never_exposes_stale_blocks_for_converted_document(self):
        from app.journal.service import _to_response
        row = SimpleNamespace(id=7, revision=2, title=None, content='new', journal_date=date(2026,10,30),
                              journal_kind='writing', folder_id=None, created_at=datetime.now(timezone.utc),
                              updated_at=datetime.now(timezone.utc), deleted_at=None,
                              content_blocks=[{'id':'11111111-1111-4111-8111-111111111111','kind':'user','text':'stale'}],
                              content_doc=paragraph('new'))
        result = _to_response(row, 1, detail=True)
        self.assertIsNone(result.content_blocks)
        self.assertEqual(result.document_format, 'tiptap')
        self.assertEqual(result.content_doc, row.content_doc)
        row.content_doc = None
        legacy = _to_response(row, 1, detail=True)
        self.assertEqual(legacy.document_format, 'legacy')
        self.assertIsNotNone(legacy.content_blocks)
        row.content_blocks = [{'unknown_legacy_shape': 'preserved'}]
        self.assertEqual(_to_response(row, 1, detail=True).content_blocks, row.content_blocks)

    def test_ritual_draft_uses_business_day(self):
        from pydantic import ValidationError
        JournalCreate(content='x', journal_kind='set', journal_date='2026-10-30', draft_started_at='2026-10-29T20:00:00Z')
        with self.assertRaises(ValidationError):
            JournalCreate(content='x', journal_kind='set', journal_date='2026-10-30', draft_started_at='2026-10-29T19:59:00Z')
        with self.assertRaises(ValidationError):
            JournalCreate(content='x', journal_kind='end', journal_date='2026-10-30', draft_started_at='2026-10-30T04:00:00')

    def test_inbox_does_not_accept_document_payload(self):
        from app.inbox.schemas import InboxCreate, InboxUpdate
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            InboxCreate(inbox_date='2026-10-30', content_doc=paragraph('x'))
        with self.assertRaises(ValidationError):
            InboxUpdate(content_doc=paragraph('x'), expected_revision=1)
    def test_old_payload_cannot_overwrite_new_document(self):
        row = SimpleNamespace(content='original', content_doc=paragraph('original'), content_blocks=None, title=None)
        for payload in (JournalUpdate(content='replacement', expected_revision=1),
                        InsightUpdate(content='replacement', expected_revision=1)):
            with self.assertRaises(WriteConflict):
                writing_changes(row, payload)

    def test_insight_old_blocks_are_not_silently_ignored(self):
        row = SimpleNamespace(content='original', content_doc=paragraph('original'), title=None)
        with self.assertRaises(WriteConflict):
            writing_changes(row, InsightUpdate(content_blocks=[], expected_revision=1))

    def test_new_document_projects_content(self):
        old = paragraph('before')
        row = SimpleNamespace(content='before', content_doc=old, content_blocks=None, title=None)
        changes = writing_changes(row, JournalUpdate(content_doc=paragraph('after'), expected_revision=1))
        self.assertEqual(changes['content'], 'after')
        self.assertEqual(changes['content_doc'], paragraph('after'))

    def test_new_document_remains_authoritative_with_frozen_old_blocks(self):
        row = SimpleNamespace(content='before', content_doc=paragraph('before'),
                              content_blocks=[{'kind':'user','text':'stale'}], title=None)
        changes = writing_changes(row, JournalUpdate(content_doc=paragraph('after'), expected_revision=1))
        self.assertEqual(changes['content'], 'after')
        self.assertNotIn('content_blocks', changes)

    def test_legacy_change_does_not_bypass_conversion(self):
        row = SimpleNamespace(content='original', content_doc=None, content_blocks=None, title=None)
        with self.assertRaises(WriteConflict):
            writing_changes(row, JournalUpdate(content_doc=paragraph('replacement'), expected_revision=1))

    def test_blocks_never_converted_implicitly(self):
        row = SimpleNamespace(content='original', content_doc=None, content_blocks=[{'kind':'user','text':'original'}], title=None)
        with self.assertRaises(WriteConflict):
            writing_changes(row, JournalUpdate(content_doc=paragraph('original'), expected_revision=1))

    def test_forged_system_nodes_rejected(self):
        row = SimpleNamespace(content='before', content_doc=paragraph('before'), content_blocks=None, title=None)
        forged = {'type':'doc','content':[{'type':'aiPlaceholder','attrs':{'id':'11111111-1111-4111-8111-111111111111','request_id':'22222222-2222-4222-8222-222222222222'}}]}
        with self.assertRaises(WritingError):
            writing_changes(row, JournalUpdate(content_doc=forged, expected_revision=1))


if __name__ == '__main__':
    unittest.main()
