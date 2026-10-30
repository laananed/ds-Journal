"""Pure schema and projection primitives. They do not query or write a database.

Comment ownership and server-origin authorization require the calling service to
check database state; UUID syntax alone does not establish ownership.
"""
from copy import deepcopy
import hashlib
from html import escape
import re
from urllib.parse import urlsplit
from uuid import UUID, uuid4


class DocumentError(ValueError):
    pass


SPECIAL = {'aiReply', 'aiSummary', 'aiPlaceholder', 'ritualQuestion', 'goalItem', 'goalReview', 'legacyText'}
BLOCKS = {'paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'blockquote', 'horizontalRule'}
CHILDREN = {
    'doc': BLOCKS | SPECIAL, 'paragraph': {'text', 'hardBreak'}, 'heading': {'text', 'hardBreak'},
    'bulletList': {'listItem'}, 'orderedList': {'listItem'}, 'taskList': {'taskItem'},
    'listItem': BLOCKS, 'taskItem': BLOCKS, 'blockquote': BLOCKS, 'codeBlock': {'text'},
    'aiReply': {'paragraph'}, 'aiSummary': {'paragraph'}, 'goalReview': {'paragraph'},
}
ATOMIC = {'text', 'hardBreak', 'horizontalRule', 'aiPlaceholder', 'ritualQuestion', 'goalItem', 'legacyText'}
ATTRS = {'heading': {'level'}, 'orderedList': {'start'}, 'taskItem': {'checked'}, 'codeBlock': {'language'},
         'aiReply': {'id', 'request_id'}, 'aiSummary': {'id', 'request_id'}, 'aiPlaceholder': {'id', 'request_id'},
         'ritualQuestion': {'id', 'template_question_id', 'question_snapshot'},
         'goalItem': {'id', 'goal_id', 'text', 'checked'},
         'goalReview': {'id', 'link_id', 'goal_snapshot', 'checked_snapshot', 'review_title'},
         'legacyText': {'id', 'raw_text', 'author'}}


def _uuid(value):
    if not isinstance(value, str):
        raise DocumentError('invalid UUID')
    try:
        return str(UUID(value))
    except (ValueError, AttributeError) as exc:
        raise DocumentError('invalid UUID') from exc


def validate_document(document):
    """Validate shape and syntax; never infer comment ownership from a UUID."""
    seen = set()

    def visit(node, parent=None, depth=0):
        if depth > 64 or not isinstance(node, dict) or set(node) - {'type', 'attrs', 'content', 'text', 'marks'}:
            raise DocumentError('invalid node')
        kind = node.get('type')
        if not isinstance(kind, str) or (parent is None and kind != 'doc') or (parent is not None and kind not in CHILDREN.get(parent, set())):
            raise DocumentError('invalid node type or parent')
        if kind == 'doc' and 'content' not in node:
            raise DocumentError('document content is required')
        attrs = node.get('attrs', {})
        allowed = ATTRS.get(kind, set()) | ({'id'} if kind not in SPECIAL and kind not in {'doc', 'text', 'hardBreak'} else set())
        if not isinstance(attrs, dict) or set(attrs) - allowed:
            raise DocumentError('invalid attributes')
        if kind in SPECIAL and set(attrs) != ATTRS[kind]:
            raise DocumentError('missing special attributes')
        if 'id' in attrs:
            node_id = _uuid(attrs['id'])
            if node_id in seen:
                raise DocumentError('duplicate node id')
            seen.add(node_id)
        for key in ('request_id', 'goal_id', 'template_question_id', 'link_id'):
            if key in attrs and attrs[key] is not None:
                _uuid(attrs[key])
            elif key in attrs and key in {'request_id', 'goal_id'}:
                raise DocumentError('missing identity')
        if kind == 'heading' and (type(attrs.get('level')) is not int or attrs['level'] not in (1, 2, 3)):
            raise DocumentError('invalid heading')
        if kind == 'orderedList' and 'start' in attrs and (type(attrs['start']) is not int or attrs['start'] < 1):
            raise DocumentError('invalid list start')
        for key in ('checked', 'checked_snapshot'):
            if key in attrs and type(attrs[key]) is not bool:
                raise DocumentError('invalid boolean')
        if kind == 'taskItem' and type(attrs.get('checked')) is not bool:
            raise DocumentError('missing checked')
        if kind == 'codeBlock' and attrs.get('language') is not None and not isinstance(attrs['language'], str):
            raise DocumentError('invalid language')
        for key, limit in (('question_snapshot', 500), ('text', 2000), ('goal_snapshot', 2000), ('review_title', 2000), ('raw_text', None)):
            if key in attrs and (not isinstance(attrs[key], str) or (limit is not None and len(attrs[key]) > limit)):
                raise DocumentError('invalid text attribute')
        if kind == 'legacyText' and attrs['author'] not in ('user', 'ai'):
            raise DocumentError('invalid legacy author')
        if kind == 'text':
            if not isinstance(node.get('text'), str) or not node['text']:
                raise DocumentError('invalid text')
        elif 'text' in node:
            raise DocumentError('unexpected text')
        if 'marks' in node:
            if kind != 'text' or not isinstance(node['marks'], list):
                raise DocumentError('invalid marks')
            for mark in node['marks']:
                if not isinstance(mark, dict) or set(mark) - {'type', 'attrs'} or not isinstance(mark.get('type'), str) or mark.get('type') not in {'bold', 'italic', 'strike', 'code', 'link', 'mindComment'}:
                    raise DocumentError('invalid mark')
                mtype, ma = mark['type'], mark.get('attrs', {})
                if not isinstance(ma, dict):
                    raise DocumentError('invalid mark attrs')
                if mtype == 'link':
                    try:
                        safe_link = (set(ma) == {'href'} and isinstance(ma['href'], str)
                                     and not any(ord(c) <= 32 for c in ma['href'])
                                     and urlsplit(ma['href']).scheme.lower() in ('http', 'https', 'mailto'))
                    except ValueError:
                        safe_link = False
                    if not safe_link:
                        raise DocumentError('unsafe link')
                elif mtype == 'mindComment':
                    ids = ma.get('comment_ids')
                    if set(ma) != {'comment_ids'} or not isinstance(ids, list) or not ids:
                        raise DocumentError('invalid comment ids')
                    normalized = [_uuid(x) for x in ids]
                    if len(set(normalized)) != len(normalized):
                        raise DocumentError('duplicate comment id')
                elif ma:
                    raise DocumentError('invalid mark attrs')
        if kind in ATOMIC:
            if 'content' in node:
                raise DocumentError('atomic node has content')
        else:
            children = node.get('content', [])
            if not isinstance(children, list) or (kind in {'aiReply', 'aiSummary'} and not children):
                raise DocumentError('invalid content')
            for child in children:
                visit(child, kind, depth + 1)
    visit(document)
    return document


def _plain(node, user_only):
    kind = node['type']
    if kind == 'text': return node['text']
    if kind == 'hardBreak': return '\n'
    if kind == 'legacyText': return node['attrs']['raw_text'] if not user_only or node['attrs']['author'] == 'user' else None
    if user_only and kind in {'aiReply', 'aiSummary', 'aiPlaceholder', 'ritualQuestion', 'horizontalRule'}: return None
    if kind == 'goalItem': return node['attrs']['text']
    if kind == 'ritualQuestion': return node['attrs']['question_snapshot']
    parts = [_plain(child, user_only) for child in node.get('content', [])]
    parts = [part for part in parts if part is not None]
    if kind in {'paragraph', 'heading', 'codeBlock'}: return ''.join(parts)
    return '\n'.join(parts)


def user_text_document(document):
    validate_document(document)
    return _plain(document, True)


def validate_anchor(document, anchor):
    """Check a quote on a user paragraph/heading using half-open code-point offsets.

    This does not establish comment ownership; a service must verify it in DB.
    """
    validate_document(document)
    if not isinstance(anchor, dict) or set(anchor) != {'node_id', 'start', 'end', 'quote', 'quote_sha256'}:
        raise DocumentError('invalid anchor')
    wanted = _uuid(anchor['node_id'])
    start, end, quote = anchor['start'], anchor['end'], anchor['quote']
    if type(start) is not int or type(end) is not int or start < 0 or end <= start or not isinstance(quote, str):
        raise DocumentError('invalid anchor range')
    if anchor['quote_sha256'] != hashlib.sha256(quote.encode('utf-8')).hexdigest():
        raise DocumentError('anchor quote digest mismatch')
    matches = []
    def walk(node):
        kind = node['type']
        if kind in SPECIAL and kind != 'goalReview':
            return
        node_id = node.get('attrs', {}).get('id')
        if kind in {'paragraph', 'heading'} and node_id and _uuid(node_id) == wanted:
            matches.append(_plain(node, True))
        for child in node.get('content', []):
            walk(child)
    walk(document)
    if len(matches) != 1 or end > len(matches[0]) or matches[0][start:end] != quote:
        raise DocumentError('anchor changed or removed')


def _markdown(node):
    kind = node['type']
    if kind == 'text':
        value = escape(node['text'], quote=False)
        value = re.sub(r'([\\`*_~])', r'\\\1', value)
        for mark in node.get('marks', []):
            typ = mark['type']
            if typ == 'bold': value = '**' + value + '**'
            elif typ == 'italic': value = '*' + value + '*'
            elif typ == 'strike': value = '~~' + value + '~~'
            elif typ == 'code': value = '`' + value + '`'
            elif typ == 'link': value = '[' + value.replace(']', r'\]') + '](' + mark['attrs']['href'].replace(')', '%29') + ')'
        return value
    if kind == 'hardBreak': return '\n'
    if kind == 'legacyText': return node['attrs']['raw_text']
    if kind == 'horizontalRule': return '---'
    if kind == 'goalItem': return ('- [x] ' if node['attrs']['checked'] else '- [ ] ') + escape(node['attrs']['text'], quote=False)
    if kind == 'ritualQuestion': return escape(node['attrs']['question_snapshot'], quote=False)
    if kind == 'aiPlaceholder': return ''
    children = node.get('content', [])
    if kind in ('paragraph', 'heading'):
        value = ''.join(_markdown(child) for child in children)
        return ('#' * node['attrs']['level'] + ' ' if kind == 'heading' else '') + value
    if kind == 'codeBlock':
        raw = ''.join(child['text'] for child in children)
        runs = [len(run) for run in re.findall(r'`+', raw)]
        fence = '`' * max(3, max(runs, default=0) + 1)
        language = node.get('attrs', {}).get('language') or ''
        if not re.fullmatch(r'[A-Za-z0-9_+.-]*', language): language = ''
        return fence + language + '\n' + raw + '\n' + fence
    if kind in ('bulletList', 'orderedList', 'taskList'):
        lines = []
        start = node.get('attrs', {}).get('start', 1)
        for i, item in enumerate(children):
            prefix = ('- [x] ' if item.get('attrs', {}).get('checked') else '- [ ] ') if kind == 'taskList' else (f'{start + i}. ' if kind == 'orderedList' else '- ')
            text = _markdown(item)
            lines.append(prefix + text.replace('\n', '\n  '))
        return '\n'.join(lines)
    value = '\n'.join(_markdown(child) for child in children)
    if kind == 'blockquote': return '\n'.join('> ' + line for line in value.split('\n'))
    return value


def project_document(document):
    validate_document(document)
    parts = []
    for node in document.get('content', []):
        kind = node['type']
        value = _markdown(node)
        if kind == 'aiReply':
            value = '\n> AI 回复\n' + '\n'.join('> ' + line for line in value.split('\n')) + '\n\n'
        elif kind == 'aiSummary':
            value = '\n---\n\nAI 复盘\n\n' + value
        elif kind == 'legacyText' and node['attrs']['author'] == 'ai':
            value = '\n> AI 旧内容\n' + '\n'.join('> ' + line for line in value.split('\n'))
        parts.append(value)
    return '\n'.join(parts)


def convert_legacy_text(content, blocks):
    """Convert only unstructured legacy content; structured blocks need a proven adapter.

    This function changes no database values or checkpoints. The caller must
    commit conversion and its surrounding mutation with the existing CAS.
    """
    if not isinstance(content, str) or blocks is not None:
        raise DocumentError('legacy_conversion_required')
    result = {'type': 'doc', 'content': [{'type': 'legacyText', 'attrs': {
        'id': str(uuid4()), 'raw_text': content, 'author': 'user'}}]}
    validate_document(result)
    return result


def validate_author_changes(old, new):
    """Reject untrusted changes to protected nodes; service-created nodes bypass this explicitly."""
    validate_document(old)
    validate_document(new)
    def protected(doc):
        return {n['attrs']['id']: deepcopy(n) for n in doc.get('content', []) if n['type'] in SPECIAL}
    before, after = protected(old), protected(new)
    if before.keys() != after.keys():
        raise DocumentError('protected node creation or removal')
    for key, previous in before.items():
        current = after[key]
        if previous['type'] != current['type']:
            raise DocumentError('protected node type changed')
        kind = previous['type']
        if kind in {'aiSummary', 'goalReview'}:
            if previous['attrs'] != current['attrs']:
                raise DocumentError('protected source changed')
        elif kind == 'legacyText' and previous['attrs']['author'] == 'user':
            if current['attrs']['author'] != 'user' or previous['attrs']['id'] != current['attrs']['id']:
                raise DocumentError('protected source changed')
        elif previous != current:
            raise DocumentError('protected node changed')
