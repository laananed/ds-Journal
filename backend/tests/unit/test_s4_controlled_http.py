"""受控命令的 HTTP 契约（无数据库）：状态码、错误体与 FileMutation 形状。

`get_db` 用内存替身覆盖，因此不连接 PostgreSQL、不写任何库；数据库事务、
并发与真实 CAS 仍须在隔离测试库中验证，本文件不替代那部分证据。

契约依据：`docs/stage4-api.md` §1（缺版本 428／非法 422／过期 409）、§4（受控
创建命令）、§10（FileMutation 的 effects/base_revision/ops）。
"""
import os
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import UUID

import dotenv
import unittest

with patch.dict(os.environ, {'DATABASE_URL': 'postgresql://dummy:dummy@127.0.0.1:1/isolated_dummy'}), \
     patch.object(dotenv, 'load_dotenv', return_value=False):
    from fastapi.testclient import TestClient
    from app.database import get_db
    from app.main import app
    from app.ritual import controlled

QUESTION_ID = '11111111-1111-4111-8111-111111111111'


def ritual_document(text='已有正文'):
    return {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {
        'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
        'content': [{'type': 'text', 'text': text}]}]}


class ControlledCommandHttpTests(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.row = SimpleNamespace(
            id=10, journal_date=date(2026, 10, 31), journal_kind='set', revision=5,
            deleted_at=None, content_doc=ritual_document())
        self.template = SimpleNamespace(revision=2, questions=[{'id': QUESTION_ID, 'text': '今天最重要的事？'}])
        self.db.get.return_value = self.row
        self.db.scalar.side_effect = lambda *_: self.row
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(app.dependency_overrides.clear)
        self.addCleanup(self.client.close)
        self.write = patch.object(controlled, '_write_doc').start()
        self.mutation = patch.object(controlled, '_mutation', return_value={
            'files': [{'id': 10, 'revision': 6}],
            'effects': [{'type': 'journal', 'id': 10, 'base_revision': 5, 'revision': 6,
                         'ops': [{'kind': 'copy_nodes', 'node_id': 'node-1'}]}],
            'request_id': None,
        }).start()
        self.addCleanup(patch.stopall)

    def post(self, path, payload):
        return self.client.post(path, json=payload)

    def question(self, **overrides):
        payload = {'expected_revision': 5, 'expected_template_revision': 2, 'question_id': QUESTION_ID}
        payload.update(overrides)
        return self.post('/api/rituals/10/questions', payload)

    def test_missing_versions_are_428(self):
        missing_file = self.post('/api/rituals/10/questions', {'question_id': QUESTION_ID})
        self.assertEqual(missing_file.status_code, 428, missing_file.text)
        missing_template = self.question(expected_template_revision=None)
        self.assertEqual(missing_template.status_code, 422, '显式 null 属于非法参数而不是缺版本')
        no_template = self.post('/api/rituals/10/questions',
                                {'expected_revision': 5, 'question_id': QUESTION_ID})
        self.assertEqual(no_template.status_code, 428, no_template.text)
        self.assertIn('required', no_template.json()['detail'])
        self.write.assert_not_called()

    def test_invalid_payload_is_422_without_echoing_values(self):
        cases = [
            self.question(expected_revision=None),
            self.question(question_id='not-a-uuid'),
            self.question(unexpected=1),
            self.post('/api/rituals/10/goals', {'expected_revision': 5}),
        ]
        for response in cases:
            self.assertEqual(response.status_code, 422, response.text)
            body = response.json()['detail']
            self.assertIsInstance(body, list)
            self.assertTrue(all('input' not in item for item in body), '错误体不得回显提交的值')
        self.write.assert_not_called()

    def test_stale_revisions_are_409(self):
        stale_file = self.question(expected_revision=1)
        self.assertEqual(stale_file.status_code, 409, stale_file.text)
        self.assertEqual(stale_file.json()['detail'], 'file revision has changed')
        stale_template = self.question(expected_template_revision=1)
        self.assertEqual(stale_template.status_code, 409, stale_template.text)
        self.write.assert_not_called()
        self.db.rollback.assert_called()

    def test_unknown_question_is_409(self):
        self.db.scalar.side_effect = [self.row, self.template]
        response = self.question(question_id='22222222-2222-4222-8222-222222222222')
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()['detail'], 'template question unavailable')
        self.write.assert_not_called()

    def test_missing_ritual_is_unavailable(self):
        self.db.get.return_value = None
        response = self.post('/api/rituals/99/goals',
                             {'expected_revision': 5, 'task_item_id': QUESTION_ID})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()['code'], 'source_unavailable')
        self.write.assert_not_called()

    def test_question_returns_file_mutation_with_node_identity(self):
        self.db.scalar.side_effect = [self.row, self.template]
        response = self.question()
        self.assertEqual(response.status_code, 200, response.text)
        self.write.assert_called_once()
        document = self.write.call_args.args[2]
        self.assertEqual(document['content'][-2]['type'], 'ritualQuestion')
        self.assertEqual(document['content'][-2]['attrs']['question_snapshot'], '今天最重要的事？')
        self.assertEqual(document['content'][-2]['attrs']['template_question_id'], QUESTION_ID)
        self.assertEqual(document['content'][-1]['type'], 'paragraph')
        self.assertEqual(document['content'][0]['attrs']['id'], 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                         '原有正文位置与身份不变')
        self.assertEqual(document['content'][0]['content'][0]['text'], '已有正文')
        effect = response.json()['effects'][0]
        self.assertEqual(effect['base_revision'], 5)
        self.assertEqual(effect['ops'][0]['kind'], 'copy_nodes')
        self.assertNotEqual(effect['ops'][0]['node_id'], QUESTION_ID, '正文节点 ID 不能复用模板 ID')
        self.db.commit.assert_called_once()

    def test_goal_on_end_and_unknown_item_are_422(self):
        self.row.journal_kind = 'end'
        end_goal = self.post('/api/rituals/10/goals',
                             {'expected_revision': 5, 'task_item_id': QUESTION_ID})
        self.assertEqual(end_goal.status_code, 422, end_goal.text)
        self.row.journal_kind = 'set'
        missing_item = self.post('/api/rituals/10/goals',
                                 {'expected_revision': 5, 'task_item_id': QUESTION_ID})
        self.assertEqual(missing_item.status_code, 422, missing_item.text)
        self.write.assert_not_called()
        self.db.rollback.assert_called()

    def test_goal_conversion_reports_new_goal_identity(self):
        item_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        self.row.content_doc = {'type': 'doc', 'content': [{'type': 'taskList', 'content': [{
            'type': 'taskItem', 'attrs': {'id': item_id, 'checked': True}, 'content': [
                {'type': 'paragraph', 'content': [{'type': 'text', 'text': '写周报'}]}]}]}]}
        response = self.post('/api/rituals/10/goals', {'expected_revision': 5, 'task_item_id': item_id})
        self.assertEqual(response.status_code, 200, response.text)
        goal = self.write.call_args.args[2]['content'][0]
        self.assertEqual(goal['type'], 'goalItem')
        self.assertEqual(goal['attrs']['text'], '写周报')
        self.assertTrue(goal['attrs']['checked'])
        UUID(goal['attrs']['goal_id'])
        UUID(goal['attrs']['id'])


if __name__ == '__main__':
    unittest.main()
