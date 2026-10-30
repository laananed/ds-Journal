"""Copy selected nodes from a deleted Ritual with transactional replay receipts."""
from copy import deepcopy
import hashlib
import json
from uuid import uuid5

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from app.journal.models import Journal
from app.journal.schemas import _validate_content
from app.journal.service import get_journal, _utcnow
from app.ritual.models import RitualCopy
from app.ritual.service import lock_day, require_no_links, RelatedFilesChanged
from app.writing.documents import DocumentError, SPECIAL, project_document, validate_document
from app.writing.service import require_revision, WriteConflict, WritingError, LegacyConversionRequired


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def has_comments(node):
    return (any(mark.get('type') == 'mindComment' for mark in node.get('marks', [])) or
            any(has_comments(child) for child in node.get('content', [])))


def indexed_nodes(document):
    found = {}
    def walk(node, parent=None, protected=False):
        ident = node.get('attrs', {}).get('id')
        if ident:
            found[ident] = (node, parent, protected)
        for child in node.get('content', []):
            walk(child, node, protected or node['type'] in SPECIAL)
    walk(document)
    return found


def selected_text(node, start, end):
    if node['type'] not in ('paragraph', 'heading'):
        raise WritingError('ranges require a paragraph or heading')
    result, offset = [], 0
    for child in node.get('content', []):
        length = len(child['text']) if child['type'] == 'text' else 1
        left, right = max(start, offset), min(end, offset + length)
        if left < right:
            part = deepcopy(child)
            if part['type'] == 'text':
                part['text'] = part['text'][left - offset:right - offset]
            result.append(part)
        offset += length
    if end > offset or not result:
        raise WritingError('selection range exceeds source text')
    result_node = deepcopy(node)
    result_node['content'] = result
    return result_node


def clone_node(node, copy_id, index):
    node = deepcopy(node)
    def visit(current, path):
        attrs = current.get('attrs', {})
        if 'id' in attrs:
            attrs['id'] = str(uuid5(copy_id, f'{index}:{path}:id:{attrs["id"]}'))
        if 'goal_id' in attrs:
            attrs['goal_id'] = str(uuid5(copy_id, f'{index}:{path}:goal:{attrs["goal_id"]}'))
        if current['type'] == 'goalReview':
            attrs['link_id'] = None
        for i, child in enumerate(current.get('content', [])):
            visit(child, f'{path}/{i}')
    visit(node, 'root')
    return node


def copy_content(db, source_id, data):
    require_revision(data.source_revision)
    require_revision(data.expected_target_revision)
    payload_hash = digest({'source_id': source_id, **data.model_dump(mode='json', by_alias=True)})
    try:
        source = db.get(Journal, source_id)
        if source is None:
            raise WritingError('source does not exist')
        lock_day(db, source.journal_date)
        rows = db.scalars(select(Journal).where(Journal.id.in_([source_id, data.target_id]))
                          .order_by(Journal.id).with_for_update()
                          .execution_options(populate_existing=True)).all()
        found = {row.id: row for row in rows}
        source, target = found.get(source_id), found.get(data.target_id)
        if (source is None or target is None or source.id == target.id or source.deleted_at is None
            or target.deleted_at is not None or source.journal_kind not in ('set', 'end')
            or source.journal_kind != target.journal_kind or source.journal_date != target.journal_date):
            raise WritingError('source and target must be matching deleted and active Rituals')
        require_no_links(db, source.id, target.id)
        if data.related_revisions:
            raise RelatedFilesChanged('related file set has changed')
        if source.content_doc is None or target.content_doc is None:
            raise LegacyConversionRequired('copy requires safely converted documents')
        receipt = db.get(RitualCopy, data.copy_id)
        if receipt:
            if receipt.payload_hash != payload_hash or receipt.source_id != source_id or receipt.target_id != target.id:
                raise WriteConflict('copy_id was used for another request')
            current = indexed_nodes(target.content_doc)
            entries = [current.get(item['id']) for item in receipt.copied_nodes]
            if any(entry is None or digest(entry[0]) != item['digest'] for entry, item in zip(entries, receipt.copied_nodes)):
                raise WriteConflict('copied result has changed')
            parents = [entry[1] for entry in entries]
            positions = [parent['content'].index(entry[0]) for parent, entry in zip(parents, entries)]
            if any(parent is not parents[0] for parent in parents) or positions != list(range(positions[0], positions[0] + len(positions))):
                raise WriteConflict('copied result has changed')
            current_file = get_journal(db, target.id)
            return {'files': [current_file], 'effects': [], 'request_id': None}
        if source.revision != data.source_revision or target.revision != data.expected_target_revision:
            raise WriteConflict('file revision has changed')
        source_nodes = indexed_nodes(source.content_doc)
        document = deepcopy(target.content_doc)
        position = indexed_nodes(document).get(str(data.insert_after_node_id))
        if position is None or position[1] is None or position[2]:
            raise WritingError('invalid insert position')
        selected = []
        if len({s.node_id for s in data.selection}) != len(data.selection):
            raise WritingError('duplicate selection')
        for i, item in enumerate(data.selection):
            entry = source_nodes.get(str(item.node_id))
            if entry is None or entry[2]:
                raise WritingError('source node not found')
            node = entry[0]
            if has_comments(node):
                raise WriteConflict('comment ownership copying is unavailable')
            if node['type'] == 'aiPlaceholder':
                raise WriteConflict('in-flight AI placeholders cannot be copied')
            if item.start is not None:
                node = selected_text(node, item.start, item.end)
            selected.append(clone_node(node, data.copy_id, i))
        siblings = position[1]['content']
        offset = siblings.index(position[0]) + 1
        siblings[offset:offset] = selected
        try:
            validate_document(document)
            projection = project_document(document)
            _validate_content(projection)
        except (DocumentError, ValueError) as error:
            raise WritingError('copy is invalid or exceeds the content limit') from error
        result = db.execute(update(Journal).where(Journal.id == target.id,
            Journal.revision == data.expected_target_revision, Journal.deleted_at.is_(None))
            .values(content_doc=document, content=projection, revision=Journal.revision + 1, updated_at=_utcnow()))
        if result.rowcount != 1:
            raise WriteConflict('target revision has changed')
        db.add(RitualCopy(id=data.copy_id, source_id=source.id, target_id=target.id,
                          payload_hash=payload_hash, copied_nodes=[
                              {'id': node['attrs']['id'], 'digest': digest(node)} for node in selected]))
        db.commit()
        db.expire_all()
        current_file = get_journal(db, data.target_id)
        return {'files': [current_file], 'effects': [{'type': 'journal', 'id': data.target_id,
            'base_revision': data.expected_target_revision, 'revision': data.expected_target_revision + 1,
            'ops': [{'kind': 'copy_nodes', 'nodes': selected}]}], 'request_id': None}
    except IntegrityError as error:
        db.rollback()
        if getattr(getattr(error.orig, 'diag', None), 'constraint_name', None) == 'ritual_copies_pkey':
            raise WriteConflict('copy_id was used concurrently') from error
        raise
    except Exception:
        db.rollback()
        raise
