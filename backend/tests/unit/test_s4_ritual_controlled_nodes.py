import unittest
from copy import deepcopy

from app.writing import documents
from app.ritual import schemas


class ControlledNodesTests(unittest.TestCase):
    def test_command_schemas_reject_null_and_unexpected_fields(self):
        question = getattr(schemas, 'QuestionInsert', None)
        goal = getattr(schemas, 'GoalCreate', None)
        self.assertTrue(callable(question) and callable(goal), 'command schemas are missing')
        for cls, values in ((question, {'expected_revision': None, 'expected_template_revision': 1,
                                         'question_id': '11111111-1111-4111-8111-111111111111'}),
                            (goal, {'expected_revision': 1,
                                    'task_item_id': '11111111-1111-4111-8111-111111111111', 'extra': 1})):
            with self.assertRaises(ValueError):
                cls(**values)

    def test_question_uses_snapshot_without_mutating_document(self):
        original = {'type': 'doc', 'content': []}
        insert = getattr(documents, 'insert_ritual_question', None)
        self.assertTrue(callable(insert), 'controlled question insertion is missing')
        result = insert(original, 'node', 'answer', 'template', '问题')
        self.assertEqual(original['content'], [])
        self.assertEqual(result['content'][0]['attrs']['question_snapshot'], '问题')
        self.assertEqual(result['content'][0]['attrs']['template_question_id'], 'template')
        self.assertEqual(result['content'][1]['type'], 'paragraph')

    def test_goal_conversion_preserves_neighbours_and_checkbox(self):
        item = lambda i, value: {'type': 'taskItem', 'attrs': {'id': i, 'checked': value},
                                  'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': i}]}]}
        original = {'type': 'doc', 'content': [{'type': 'taskList', 'content': [item('a', False), item('b', True), item('c', False)]}]}
        before = deepcopy(original)
        transform = getattr(documents, 'convert_ritual_task_item', None)
        self.assertTrue(callable(transform), 'controlled conversion is missing')
        result = transform(original, 'b', 'node', 'goal')
        self.assertEqual(original, before)
        self.assertEqual([n['type'] for n in result['content']], ['taskList', 'goalItem', 'taskList'])
        self.assertEqual(result['content'][1]['attrs'], {'id': 'node', 'goal_id': 'goal', 'text': 'b', 'checked': True})
        self.assertEqual(result['content'][0]['content'], [before['content'][0]['content'][0]])
        self.assertEqual(result['content'][2]['content'], [before['content'][0]['content'][2]])

    def test_conversion_rejects_formatted_content(self):
        transform = getattr(documents, 'convert_ritual_task_item', None)
        self.assertTrue(callable(transform), 'controlled conversion is missing')
        item = {'type': 'taskItem', 'attrs': {'id': 'x', 'checked': False}, 'content': [
            {'type': 'paragraph', 'content': [{'type': 'text', 'text': 'x', 'marks': [{'type': 'bold'}]}]}]}
        with self.assertRaises(documents.DocumentError):
            transform({'type': 'doc', 'content': [{'type': 'taskList', 'content': [item]}]}, 'x', 'node', 'goal')

    def test_created_nodes_pass_document_schema(self):
        first = '11111111-1111-4111-8111-111111111111'
        second = '22222222-2222-4222-8222-222222222222'
        third = '33333333-3333-4333-8333-333333333333'
        fourth = '44444444-4444-4444-8444-444444444444'
        base = {'type': 'doc', 'content': [{'type': 'taskList', 'attrs': {'id': first}, 'content': [
            {'type': 'taskItem', 'attrs': {'id': second, 'checked': False}, 'content': [
                {'type': 'paragraph', 'content': [{'type': 'text', 'text': '目标'}]}]}]}]}
        goal = documents.convert_ritual_task_item(base, second, third, fourth)
        documents.validate_document(goal)
        question = documents.insert_ritual_question(goal, first, second, third, '问题')
        documents.validate_document(question)

    def test_question_appends_after_existing_body_without_touching_it(self):
        base = {'type': 'doc', 'content': [
            {'type': 'paragraph', 'attrs': {'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
             'content': [{'type': 'text', 'text': '答案草稿',
                          'marks': [{'type': 'bold'}]}]},
        ]}
        result = documents.insert_ritual_question(
            base, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '今天最重要的事？')
        documents.validate_document(result)
        self.assertEqual(result['content'][0], base['content'][0])
        self.assertEqual([node['type'] for node in result['content']],
                         ['paragraph', 'ritualQuestion', 'paragraph'])
        self.assertEqual(result['content'][1]['attrs']['question_snapshot'], '今天最重要的事？')
        self.assertEqual(result['content'][2]['attrs']['id'], 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')

    def test_question_snapshot_must_not_be_blank(self):
        for value in ('', '   ', None):
            with self.assertRaises(documents.DocumentError):
                documents.insert_ritual_question({'type': 'doc', 'content': []},
                                                 'a', 'b', 'c', value)

    def test_template_cap_is_four_questions(self):
        """四问上限只作用于模板；插入命令按模板当前 revision 校验（API §4）。"""
        from uuid import uuid4
        from app.ritual.schemas import TemplateUpdate

        def questions(count):
            return [{'id': str(uuid4()), 'text': f'问题{index}'} for index in range(count)]

        TemplateUpdate(expected_revision=0, questions=[])            # 清空模板合法
        TemplateUpdate(expected_revision=3, questions=questions(4))
        for invalid in (questions(5), [{'id': str(uuid4()), 'text': '   '}],
                        [{'id': str(uuid4()), 'text': '问题'}] * 2):
            with self.assertRaises(ValueError):
                TemplateUpdate(expected_revision=0, questions=invalid)

    def test_split_keeps_first_half_identity_and_new_tail_identity(self):
        list_id = '11111111-1111-4111-8111-111111111111'
        ids = {'a': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
               'b': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
               'c': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}
        item = lambda i: {'type': 'taskItem', 'attrs': {'id': ids[i], 'checked': False},
                          'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': i}]}]}
        original = {'type': 'doc', 'content': [{'type': 'taskList', 'attrs': {'id': list_id},
                                                'content': [item('a'), item('b'), item('c')]}]}
        result = documents.convert_ritual_task_item(
            original, ids['b'], '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333')
        documents.validate_document(result)
        self.assertEqual([n['type'] for n in result['content']], ['taskList', 'goalItem', 'taskList'])
        self.assertEqual(result['content'][0]['attrs']['id'], list_id, '前半保留原清单身份')
        self.assertEqual([i['attrs']['id'] for i in result['content'][0]['content']], [ids['a']])
        self.assertEqual(result['content'][1]['attrs']['text'], 'b')
        self.assertNotEqual(result['content'][2]['attrs']['id'], list_id, '后半必须是新身份')
        self.assertEqual([i['attrs']['id'] for i in result['content'][2]['content']], [ids['c']])

    def test_goal_conversion_rejects_nested_comments_and_missing_checkbox(self):
        def doc(item):
            return {'type': 'doc', 'content': [{'type': 'taskList', 'content': [item]}]}
        nested = {'type': 'taskItem', 'attrs': {'id': 'x', 'checked': False}, 'content': [
            {'type': 'paragraph', 'content': [{'type': 'text', 'text': 'x'}]},
            {'type': 'taskList', 'content': []}]}
        commented = {'type': 'taskItem', 'attrs': {'id': 'x', 'checked': False}, 'content': [
            {'type': 'paragraph', 'content': [{'type': 'text', 'text': 'x',
                                               'marks': [{'type': 'mindComment',
                                                          'attrs': {'comment_ids': ['1']}}]}]}]}
        no_state = {'type': 'taskItem', 'attrs': {'id': 'x'}, 'content': [
            {'type': 'paragraph', 'content': [{'type': 'text', 'text': 'x'}]}]}
        for broken in (nested, commented, no_state):
            with self.assertRaises(documents.DocumentError):
                documents.convert_ritual_task_item(doc(broken), 'x', 'n', 'g')

    def test_ordinary_document_cannot_forge_controlled_nodes(self):
        from app.writing.service import WritingError, document_content
        base = {'type': 'doc', 'content': [
            {'type': 'paragraph', 'attrs': {'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
             'content': [{'type': 'text', 'text': '用户正文'}]}]}
        for forged in (
            {'type': 'goalItem', 'attrs': {'id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                                           'goal_id': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                                           'text': '伪造目标', 'checked': False}},
            {'type': 'ritualQuestion', 'attrs': {'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                                                 'template_question_id': None,
                                                 'question_snapshot': '伪造问题'}},
        ):
            candidate = deepcopy(base)
            candidate['content'].append(forged)
            with self.assertRaises(WritingError):
                document_content(candidate, base)
        # 受控命令之外，普通写入仍可正常编辑用户段落。
        edited = deepcopy(base)
        edited['content'][0]['content'][0]['text'] = '改过的正文'
        document_content(edited, base)


if __name__ == '__main__':
    unittest.main()
