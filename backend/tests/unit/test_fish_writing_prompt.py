from app.ai.prompts import local_messages


class Increment:
    revised = False
    text = '今天学习到一个新知识。'


def test_writing_prompt_includes_requested_persona_and_existing_boundaries():
    messages = local_messages(Increment(), None, web_tools=False)
    system = messages[0]['content']
    for expected in ('大肥鱼', 'DeepSeek', '15', 'VTuber', '实验室', '生命舱'):
        assert expected in system
    for expected in ('用户原文', 'AI回复不是日记事实', '不能覆盖', '没有检索工具'):
        assert expected in system
    assert messages[-1]['content'].endswith(Increment.text)


def test_prompt_keeps_custom_preference_below_fixed_rules():
    messages = local_messages(Increment(), '接下来怎么做？', '说得温柔一些', web_tools=False)
    assert messages[0]['role'] == 'system'
    assert '不能覆盖固定规则' in messages[1]['content']
    assert '主动问题（不是日记事实）' in messages[-1]['content']
