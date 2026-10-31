"""Command-level checks with no database, no dotenv and no network."""
import os
import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import UUID

import dotenv

with patch.dict(os.environ, {'DATABASE_URL': 'postgresql://dummy:dummy@127.0.0.1:1/isolated_dummy'}), \
     patch.object(dotenv, 'load_dotenv', return_value=False):
    from app.ritual import controlled
    from app.ritual import goals
    from app.ritual.schemas import GoalCreate, QuestionInsert
    from app.writing.service import WriteConflict, WritingError


class ControlledCommandTests(unittest.TestCase):
    def test_ordinary_patch_cannot_create_goals(self):
        check = getattr(goals, 'require_existing_goals', None)
        self.assertTrue(callable(check), 'ordinary Set patch creation guard is missing')
        with self.assertRaises(WritingError):
            check({}, {'new-id': {'type': 'goalItem'}})
        check({'old-id': {}}, {})
        check({'old-id': {}}, {'old-id': {}})

    def setUp(self):
        self.row = SimpleNamespace(id=10, journal_date=date(2026, 1, 1), journal_kind='set',
                                   revision=3, deleted_at=None, content_doc={'type': 'doc', 'content': []})
        self.db = MagicMock()
        self.db.get.return_value = self.row
        self.db.scalar.side_effect = [self.row, SimpleNamespace(revision=2, questions=[
            {'id': '11111111-1111-4111-8111-111111111111', 'text': 'old'}])]
        self.lock = patch.object(controlled, 'lock_day').start()
        self.write = patch.object(controlled, '_write_doc').start()
        self.mutation = patch.object(controlled, '_mutation', return_value={'files': [], 'effects': []}).start()
        self.addCleanup(patch.stopall)

    def test_question_uses_locked_template_and_commits_once(self):
        request = QuestionInsert(expected_revision=3, expected_template_revision=2,
                                 question_id=UUID('11111111-1111-4111-8111-111111111111'))
        controlled.create_controlled_node(self.db, 10, request, question=True)
        doc = self.write.call_args.args[2]
        self.assertEqual(doc['content'][0]['attrs']['question_snapshot'], 'old')
        self.assertEqual(self.row.content_doc['content'], [])
        self.db.commit.assert_called_once()
        self.db.rollback.assert_not_called()

    def test_stale_revision_and_wrong_kind_do_not_write(self):
        stale = QuestionInsert(expected_revision=2, expected_template_revision=2,
                               question_id=UUID('11111111-1111-4111-8111-111111111111'))
        with self.assertRaises(WriteConflict):
            controlled.create_controlled_node(self.db, 10, stale, question=True)
        self.write.assert_not_called()
        self.db.commit.assert_not_called()
        self.db.rollback.assert_called_once()

    def test_goal_conversion_and_transaction_failure(self):
        item_id = '11111111-1111-4111-8111-111111111111'
        self.row.content_doc = {'type': 'doc', 'content': [{'type': 'taskList', 'content': [{
            'type': 'taskItem', 'attrs': {'id': item_id, 'checked': True}, 'content': [
                {'type': 'paragraph', 'content': [{'type': 'text', 'text': 'target'}]}]}]}]}
        self.db.scalar.side_effect = [self.row]
        request = GoalCreate(expected_revision=3, task_item_id=UUID(item_id))
        controlled.create_controlled_node(self.db, 10, request, question=False)
        self.assertEqual(self.write.call_args.args[2]['content'][0]['attrs']['text'], 'target')
        self.db.commit.assert_called_once()
        self.db.reset_mock()
        self.write.reset_mock(side_effect=True)
        self.write.side_effect = RuntimeError('simulated write failure')
        self.db.scalar.side_effect = [self.row]
        with self.assertRaises(RuntimeError):
            controlled.create_controlled_node(self.db, 10, request, question=False)
        self.db.commit.assert_not_called()
        self.db.rollback.assert_called_once()

    def test_stale_template_is_rejected(self):
        request = QuestionInsert(expected_revision=3, expected_template_revision=1,
                                 question_id=UUID('11111111-1111-4111-8111-111111111111'))
        with self.assertRaises(WriteConflict):
            controlled.create_controlled_node(self.db, 10, request, question=True)
        self.write.assert_not_called()
        self.db.commit.assert_not_called()
        self.db.rollback.assert_called_once()

        self.db.reset_mock()
        self.row.journal_kind = 'end'
        self.db.get.return_value = self.row
        self.db.scalar.side_effect = [self.row]
        request = GoalCreate(expected_revision=3, task_item_id=UUID('11111111-1111-4111-8111-111111111111'))
        with self.assertRaises(WritingError):
            controlled.create_controlled_node(self.db, 10, request, question=False)
        self.write.assert_not_called()
        self.db.commit.assert_not_called()
        self.db.rollback.assert_called_once()

    def test_missing_versions_raise_precondition_required(self):
        from app.writing.service import PreconditionRequired
        question = QuestionInsert(expected_template_revision=0,
                                  question_id=UUID('11111111-1111-4111-8111-111111111111'))
        self.assertIsNone(question.expected_revision)
        with self.assertRaises(PreconditionRequired):
            controlled.create_controlled_node(self.db, 10, question, question=True)
        missing_template = QuestionInsert(expected_revision=3,
                                          question_id=UUID('11111111-1111-4111-8111-111111111111'))
        with self.assertRaises(PreconditionRequired):
            controlled.create_controlled_node(self.db, 10, missing_template, question=True)
        self.write.assert_not_called()
        self.assertEqual(PreconditionRequired.status_code, 428)

    def test_missing_or_soft_deleted_ritual_is_unavailable(self):
        from app.ritual.goals import SourceUnavailable
        self.db.get.return_value = None
        request = GoalCreate(expected_revision=3, task_item_id=UUID('11111111-1111-4111-8111-111111111111'))
        with self.assertRaises(SourceUnavailable) as missing:
            controlled.create_controlled_node(self.db, 10, request, question=False)
        self.assertEqual(missing.exception.status_code, 409)
        self.assertEqual(missing.exception.code, 'source_unavailable')
        self.write.assert_not_called()

        self.row.deleted_at = '2026-01-01T00:00:00Z'
        self.db.get.return_value = self.row
        self.db.scalar.side_effect = [self.row]
        with self.assertRaises(SourceUnavailable):
            controlled.create_controlled_node(self.db, 10, request, question=False)
        self.write.assert_not_called()
        self.db.rollback.assert_called()

    def test_oversized_projection_is_rejected_before_any_mutation(self):
        """受控插入让阅读投影超限时，必须在写 row 之前失败（无半写）。"""
        from app.writing.documents import insert_ritual_question
        paragraph = {'type': 'paragraph', 'attrs': {'id': '11111111-1111-4111-8111-111111111111'},
                     'content': [{'type': 'text', 'text': '字' * 50000}]}
        doc = {'type': 'doc', 'content': [paragraph]}
        big = insert_ritual_question(doc, '22222222-2222-4222-8222-222222222222',
                                     '33333333-3333-4333-8333-333333333333', None, '问题')
        row = SimpleNamespace(id=10, revision=3, content_doc=doc, content='旧投影', updated_at='旧时间')
        with self.assertRaises(WritingError):
            goals._write_doc(MagicMock(), row, big)
        self.assertEqual(row.revision, 3, '校验失败不得增版')
        self.assertEqual(row.content_doc, doc, '正文保持原样')
        self.assertEqual(row.content, '旧投影')

    def test_same_request_replayed_cannot_insert_twice(self):
        """丢响应后按旧 revision 重发只会 409，不会产生第二个节点（无幂等表契约）。"""
        item_id = '11111111-1111-4111-8111-111111111111'
        self.row.content_doc = {'type': 'doc', 'content': [{'type': 'taskList', 'content': [{
            'type': 'taskItem', 'attrs': {'id': item_id, 'checked': False}, 'content': [
                {'type': 'paragraph', 'content': [{'type': 'text', 'text': 'target'}]}]}]}]}
        self.db.scalar.side_effect = None
        self.db.scalar.return_value = self.row
        self.write.side_effect = lambda db, row, doc, **kwargs: setattr(row, 'revision', row.revision + 1)
        request = GoalCreate(expected_revision=3, task_item_id=UUID(item_id))
        controlled.create_controlled_node(self.db, 10, request, question=False)
        self.assertEqual(self.write.call_count, 1)
        with self.assertRaises(WriteConflict):
            controlled.create_controlled_node(self.db, 10, request, question=False)
        self.assertEqual(self.write.call_count, 1, '重放不得再次构造或写入节点')
        self.db.commit.assert_called_once()


if __name__ == '__main__':
    unittest.main()
