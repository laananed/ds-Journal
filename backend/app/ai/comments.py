"""Server-owned Minds comments and validated document marks."""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import UUID, uuid4
from app.ritual.models import AIComment
from app.writing.documents import DocumentError, add_comment_mark, validate_anchor
from app.writing.service import WritingError
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.database import get_db
from app.journal.models import Journal
from app.writing.router import matched_revision
from app.writing.service import WriteConflict
import hashlib
import json

router = APIRouter(prefix='/api/journals', tags=['ai-comments'])


def prompt_nodes(source):
    from app.writing.documents import _plain
    nodes = []
    scope = source['scope']
    def visit(node, protected=False):
        protected = protected or node['type'] in ('aiReply','aiSummary','aiPlaceholder','ritualQuestion','legacyText','goalItem')
        node_id = node.get('attrs', {}).get('id')
        if not protected and node['type'] in ('paragraph','heading') and node_id:
            value = _plain(node, True)
            if scope == 'all':
                nodes.append({'node_id':node_id,'start':0,'text':value})
            else:
                ranges = scope.get('ranges', [scope])
                for selected in ranges:
                    if node_id == selected['node_id']:
                        nodes.append({'node_id':node_id,'start':selected['start'],
                                      'text':value[selected['start']:selected['end']]})
        for child in node.get('content', []):
            visit(child, protected)
    visit(source['document'])
    return nodes


def parse_comments(raw, source):
    try:
        result = json.loads(raw)
        if not isinstance(result, dict) or set(result) != {'comments'} or not isinstance(result['comments'], list) or len(result['comments']) > 30:
            raise ValueError
        for item in result['comments']:
            if not isinstance(item, dict) or set(item) != {'mind_preset_id','text','anchor'}:
                raise ValueError
            if item['mind_preset_id'] not in source['mind_preset_ids'] or not isinstance(item['text'], str) or not 1 <= len(item['text']) <= 4000:
                raise ValueError
            anchor = item['anchor']
            if not isinstance(anchor, dict) or set(anchor) not in ({'node_id','start','end','quote'}, {'node_id','start','end','quote','quote_sha256'}):
                raise ValueError
            if not isinstance(anchor['quote'], str) or not 1 <= len(anchor['quote']) <= 50000:
                raise ValueError
            anchor['quote_sha256'] = hashlib.sha256(anchor['quote'].encode()).hexdigest()
        return result['comments']
    except (ValueError, TypeError, KeyError, UnicodeError) as error:
        raise WritingError('invalid comment result') from error


@router.get('/{journal_id}/comments')
def list_comments(journal_id: int, page: int = Query(1, ge=1), db: Session = Depends(get_db)):
    if db.scalar(select(Journal.id).where(Journal.id == journal_id, Journal.deleted_at.is_(None))) is None:
        raise HTTPException(status_code=404, detail='File not found')
    total = db.scalar(select(func.count()).select_from(AIComment).where(AIComment.journal_id == journal_id))
    rows = db.scalars(select(AIComment).where(AIComment.journal_id == journal_id)
                      .order_by(AIComment.created_at, AIComment.id).offset((page-1)*20).limit(20)).all()
    return {'items':[{'id':str(c.id),'request_id':str(c.request_id) if c.request_id else None,
        'mind_preset_id':c.mind_preset_id,'text':c.text,'quote':c.quote,'anchor':c.anchor,
        'anchor_state':c.anchor_state,'created_at':c.created_at} for c in rows],
        'page':page,'page_size':20,'total':total,'has_next':page*20 < total}


@router.delete('/{journal_id}/comments/{comment_id}', status_code=204)
def delete_comment(journal_id: int, comment_id: UUID, revision: int = Depends(matched_revision),
                   db: Session = Depends(get_db)):
    from app.writing.documents import project_document, remove_comment_mark
    try:
        row = db.scalar(select(Journal).where(Journal.id == journal_id,
                Journal.deleted_at.is_(None)).with_for_update().execution_options(populate_existing=True))
        if row is None:
            raise HTTPException(status_code=404, detail='File not found')
        if row.revision != revision:
            raise WriteConflict('file revision has changed')
        comment = db.scalar(select(AIComment).where(AIComment.id == comment_id,
                            AIComment.journal_id == journal_id).with_for_update())
        if comment is None:
            raise HTTPException(status_code=404, detail='Comment not found')
        if row.content_doc is not None:
            row.content_doc = remove_comment_mark(row.content_doc, str(comment_id))
            row.content = project_document(row.content_doc)
        row.revision += 1
        row.updated_at = datetime.now(timezone.utc)
        db.delete(comment)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return Response(status_code=204)


def apply_comments(db, row, request, source):
    values = (request.result or {}).get('comments')
    if not isinstance(values, list) or len(values) > 30:
        raise WritingError('invalid comment result')
    document = deepcopy(row.content_doc)
    created = []
    for value in values:
        if not isinstance(value, dict) or set(value) != {'mind_preset_id','text','anchor'}:
            raise WritingError('invalid comment result')
        preset, body, anchor = value['mind_preset_id'], value['text'], value['anchor']
        if preset not in source['mind_preset_ids'] or not isinstance(body, str) or not 1 <= len(body) <= 4000:
            raise WritingError('invalid comment result')
        if not isinstance(anchor, dict) or not isinstance(anchor.get('quote'), str) or not anchor['quote']:
            raise WritingError('invalid comment result')
        comment_id = uuid4()
        available = True
        try:
            if anchor.get('node_id') in source.get('invalid_anchor_nodes', []):
                raise DocumentError('anchor was changed')
            validate_anchor(source['document'], anchor)
            scope = source['scope']
            if scope != 'all':
                ranges = scope.get('ranges', [scope])
                if not any(anchor['node_id'] == selected['node_id'] and
                           anchor['start'] >= selected['start'] and anchor['end'] <= selected['end']
                           for selected in ranges):
                    raise DocumentError('outside requested scope')
            document = add_comment_mark(document, anchor, str(comment_id))
        except DocumentError:
            available = False
        comment = AIComment(id=comment_id, journal_id=row.id, request_id=request.id,
                mind_preset_id=preset, text=body, quote=anchor['quote'], anchor=anchor,
                anchor_state='available' if available else 'unavailable', created_at=datetime.now(timezone.utc))
        db.add(comment)
        created.append(comment)
    return document, created


def track_changed_minds(db, journal_id, document):
    from app.ai.models import AIRequest
    requests = db.scalars(select(AIRequest).where(
        AIRequest.kind == 'minds_comments', AIRequest.status.in_(['prepared','pending','ready']),
        AIRequest.sources.contains([{'type':'journal','id':journal_id}])).with_for_update()).all()
    for request in requests:
        sources = deepcopy(request.sources)
        source = sources[0]
        original = {node['node_id']:node['text'] for node in prompt_nodes({**source,'scope':'all'})}
        current = {node['node_id']:node['text'] for node in prompt_nodes({**source,'scope':'all','document':document})}
        changed = {node_id for node_id, value in original.items() if current.get(node_id) != value}
        previous = set(source.get('invalid_anchor_nodes', []))
        if changed - previous:
            source['invalid_anchor_nodes'] = sorted(previous | changed)
            request.sources = sources


def reconcile_comment_marks(db, journal_id, old_document, candidate):
    """Verify ownership and preserve only anchors that still match at their old position."""
    from app.writing.documents import validate_document, remove_comment_mark
    validate_document(old_document)
    validate_document(candidate)
    def segments(document):
        output = {}
        def visit(node, protected=False):
            protected = protected or node['type'] in ('aiReply','aiSummary','aiPlaceholder','ritualQuestion','legacyText','goalItem')
            if node['type'] == 'text' and any(mark['type'] == 'mindComment' for mark in node.get('marks', [])):
                raise WritingError('comment mark outside user paragraph or heading')
            if node['type'] in ('paragraph','heading'):
                offset = 0
                for part in node.get('content', []):
                    size = len(part['text']) if part['type'] == 'text' else 1
                    for mark in part.get('marks', []):
                        if mark['type'] == 'mindComment':
                            if protected or not node.get('attrs',{}).get('id'):
                                raise WritingError('invalid comment mark')
                            for cid in mark['attrs']['comment_ids']:
                                output.setdefault(cid, []).append((node['attrs']['id'],offset,offset+size,part['text']))
                    offset += size
                return
            for child in node.get('content', []):
                visit(child, protected)
        visit(document)
        return output
    old, new = segments(old_document), segments(candidate)
    if not set(new).issubset(old):
        raise WritingError('comment mark cannot be introduced by a client')
    if not old:
        return candidate
    rows = db.scalars(select(AIComment).where(AIComment.journal_id == journal_id,
                     AIComment.id.in_([UUID(cid) for cid in old])).with_for_update()).all()
    owned = {str(row.id):row for row in rows}
    if set(owned) != set(old):
        raise WritingError('comment does not belong to this file')
    old_texts = {node['node_id']:node['text'] for node in prompt_nodes({'document':old_document,'scope':'all'})}
    new_texts = {node['node_id']:node['text'] for node in prompt_nodes({'document':candidate,'scope':'all'})}
    result = candidate
    for cid, comment in owned.items():
        anchor = comment.anchor
        parts = new.get(cid, [])
        old_text = old_texts.get(anchor.get('node_id'), '')
        new_text = new_texts.get(anchor.get('node_id'), '')
        try:
            validate_anchor(old_document, anchor)
            old_anchor_valid = True
        except DocumentError:
            old_anchor_valid = False
        valid = (comment.anchor_state == 'available' and old_anchor_valid and parts and
                 all(part[0] == anchor.get('node_id') for part in parts) and
                 all(a[2] == b[1] for a,b in zip(parts,parts[1:])) and
                 ''.join(part[3] for part in parts) == comment.quote)
        if valid:
            unique = old_text.count(comment.quote) == 1 and new_text.count(comment.quote) == 1
            unchanged_prefix = (parts[0][1] == anchor['start'] and
                                old_text[:anchor['start']] == new_text[:parts[0][1]])
            valid = unique or unchanged_prefix
        if not valid:
            result = remove_comment_mark(result, cid)
            comment.anchor_state = 'unavailable'
        elif parts[0][1] != anchor['start'] or parts[-1][2] != anchor['end']:
            comment.anchor = {**anchor, 'start':parts[0][1], 'end':parts[-1][2]}
    return result
