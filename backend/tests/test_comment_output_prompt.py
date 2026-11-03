from app.ai.prompts import minds_messages


def test_comment_prompt_requests_useful_output_for_valid_text():
    messages = minds_messages([{'node_id': 'synthetic', 'start': 0, 'text': 'synthetic text'}], ['gentle_reflection'])
    rules = messages[0]['content']
    assert '\u81f3\u5c11' in rules and '\u4e00\u6761' in rules
    assert '\u6ca1\u6709\u53ef\u8bc4\u8bba' in rules
    assert '\u9010\u5b57' in rules
