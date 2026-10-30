"""Validation/cleanup do not commit; the AI-block deletion endpoint owns its transaction."""
import hashlib
import json

from sqlalchemy import delete, select


class WritingError(ValueError):
    status_code = 422


class PreconditionRequired(WritingError):
    status_code = 428


class WriteConflict(WritingError):
    status_code = 409


class LegacyConversionRequired(WriteConflict):
    code = 'legacy_conversion_required'


def document_content(document, old_document=None, *, verified_comments=False):
    """Validate untrusted client documents and return the server's projection.

    Comment references are rejected until a file-scoped database ownership
    check exists. Pure UUID validation must never be treated as ownership.
    """
    from app.writing.documents import DocumentError, project_document, validate_author_changes
    from app.journal.schemas import _validate_content

    def has_comments(node):
        return (any(m.get('type') == 'mindComment' for m in node.get('marks', []))
                or any(has_comments(c) for c in node.get('content', [])))
    try:
        from app.writing.documents import validate_document
        validate_document(document)
        if has_comments(document) and not verified_comments:
            raise DocumentError('comment ownership validation is unavailable')
        validate_author_changes(old_document or {'type': 'doc', 'content': []}, document)
        result = project_document(document)
        _validate_content(result)
        return result
    except (DocumentError, ValueError) as error:
        raise WritingError(str(error)) from error


def require_revision(revision):
    if revision is None:
        raise PreconditionRequired("expected_revision or If-Match is required")
    return revision


def create_hash(data):
    # Defaults and omission have equal meaning except Inbox's omitted title.
    # Preserve Stage 3 hashes when newly introduced fields were omitted.
    extras = {'content_doc', 'document_schema_version', 'journal_kind', 'draft_started_at'}
    omitted = extras - data.model_fields_set
    body = data.model_dump(mode="json", exclude={"client_create_id"} | omitted)
    if "inbox_date" in body and "title" not in data.model_fields_set:
        body["title"] = body["inbox_date"]
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def verify_create_replay(row, payload_hash):
    if row.create_payload_hash != payload_hash:
        raise WriteConflict("client_create_id was used for a different creation payload")


def project_blocks(blocks):
    parts = []
    for block in blocks:
        if block["kind"] == "user":
            parts.append(block["text"])
        elif block["kind"] == "ai_reply":
            lines = block["text"].split("\n")
            parts.append("\n\n> AI 回复\n" + "\n".join("> " + line for line in lines) + "\n\n")
        else:
            parts.append("\n\n---\n\nAI 复盘\n\n" + block["text"])
    return "".join(parts)


def summary_blocks(markdown, request_id, old_blocks=None, old_content=None):
    """Server-only summary construction; validates projection and never commits."""
    from copy import deepcopy
    from uuid import uuid4
    from app.journal.schemas import _validate_content
    blocks = deepcopy(old_blocks) if old_blocks is not None else []
    if old_blocks is None and old_content is not None:
        blocks.append({'id':str(uuid4()),'kind':'user','text':old_content})
    blocks.extend([{'id':str(uuid4()),'kind':'ai_summary','text':markdown,'request_id':str(request_id)},
                   {'id':str(uuid4()),'kind':'user','text':''}])
    content = project_blocks(blocks)
    try: _validate_content(content)
    except ValueError as error: raise WritingError(str(error)) from error
    return blocks,content


def insert_ai_reply(row, reply, request_id, captured_blocks):
    """Server-only append at the captured user boundary. Does not commit.

    The caller has already locked/checked the source. Preserve existing user
    IDs and the preallocated empty continuation. Convert NULL only on success.
    """
    if getattr(row, 'content_doc', None) is not None:
        raise LegacyConversionRequired('legacy AI operations cannot modify a structured document')
    from copy import deepcopy
    from datetime import datetime, timezone
    from uuid import uuid4
    from app.journal.schemas import CONTENT_MAX_CODE_POINTS

    blocks = deepcopy(captured_blocks)
    if blocks is None:
        blocks = [{"id": str(uuid4()), "kind": "user", "text": row.content}]
    users = [index for index, block in enumerate(blocks) if block["kind"] == "user"]
    boundary = len(blocks)
    if users:
        last_user = users[-1]
        boundary = last_user if blocks[last_user]["text"] == "" else last_user + 1
    blocks.insert(boundary, {"id": str(uuid4()), "kind": "ai_reply",
                             "text": reply, "request_id": str(request_id)})
    if boundary + 1 == len(blocks) or blocks[boundary + 1]["kind"] != "user" or blocks[boundary + 1]["text"] != "":
        blocks.insert(boundary + 1, {"id": str(uuid4()), "kind": "user", "text": ""})
    content = project_blocks(blocks)
    if len(content) > CONTENT_MAX_CODE_POINTS:
        raise WritingError("AI reply exceeds the content length limit")
    row.content_blocks = blocks
    row.content = content
    row.revision += 1
    row.updated_at = datetime.now(timezone.utc)


def validate_blocks(blocks, *, old_blocks=None, old_content=None):
    from app.journal.schemas import _is_blank, _validate_content

    ids = [block["id"] for block in blocks]
    if len(set(ids)) != len(ids):
        raise WritingError("block IDs must be unique")
    old = {b["id"]: b for b in old_blocks or []}
    old_order = [b["id"] for b in old_blocks or [] if b["id"] in ids]
    if [bid for bid in ids if bid in old] != old_order:
        raise WritingError("existing blocks cannot be reordered")
    for block in blocks:
        previous = old.get(block["id"])
        if previous is None:
            if block["kind"] != "user":
                raise WritingError("clients cannot create AI blocks")
            if block["text"] == "":
                position = ids.index(block["id"])
                if position != len(blocks) - 1 or position == 0 or blocks[position - 1]["kind"] != "user":
                    # Equivalent conversion of a legacy empty body is allowed below.
                    if not (old_blocks is None and len(blocks) == 1 and old_content == ""):
                        raise WritingError("new empty continuation must follow the last user block")
        elif previous["kind"] != block["kind"]:
            raise WritingError("block kind cannot change")
        elif previous["kind"] != "user":
            if previous["request_id"] != block["request_id"]:
                raise WritingError("AI source identity cannot change")
            if previous["kind"] == "ai_reply" and previous["text"] != block["text"]:
                raise WritingError("AI replies cannot be edited")
    if any(b["kind"] != "user" and b["id"] not in ids for b in old.values()):
        raise WritingError("delete AI blocks through the dedicated endpoint")
    content = project_blocks(blocks)
    if old_content is not None and content == old_content:
        return content  # Explicit equivalent conversion preserves legacy text/limits.
    try:
        _validate_content(content)
    except ValueError as error:
        raise WritingError(str(error)) from error
    has_user = any(b["kind"] == "user" and not _is_blank(b["text"]) for b in blocks)
    has_saved_summary = any(b["kind"] == "ai_summary" and b["id"] in old
                            and not _is_blank(b["text"]) for b in blocks)
    if not has_user and not has_saved_summary:
        raise WritingError("ordinary saves require valid user content")
    return content


def writing_changes(row, data, *, db=None):
    changes = data.model_dump(mode="python", exclude_unset=True, exclude={"expected_revision", "document_schema_version"})
    current_doc = getattr(row, 'content_doc', None)
    if current_doc is not None and ({'content', 'content_blocks'} & changes.keys()):
        raise LegacyConversionRequired('legacy body cannot replace a structured document')
    if 'content_blocks' in changes and not hasattr(row, 'content_blocks'):
        raise LegacyConversionRequired('blocks are not supported for this file')
    if 'content_doc' in changes:
        candidate = changes['content_doc']
        if current_doc is None:
            blocks = getattr(row, 'content_blocks', None)
            from app.writing.documents import DocumentError, validate_document
            try:
                validate_document(candidate)
            except DocumentError as error:
                raise WritingError(str(error)) from error
            nodes = candidate.get('content', []) if isinstance(candidate, dict) else []
            if (blocks is not None or len(nodes) != 1 or not isinstance(nodes[0], dict)
                    or nodes[0].get('type') != 'legacyText'
                    or nodes[0].get('attrs', {}).get('raw_text') != row.content
                    or nodes[0].get('attrs', {}).get('author') != 'user'):
                raise LegacyConversionRequired('legacy body requires safe conversion')
            # Exact legacy conversion is a server-controlled identity transition.
            changes['content'] = row.content
        else:
            if db is not None and hasattr(row, 'journal_kind'):
                from app.ai.comments import reconcile_comment_marks
                candidate = reconcile_comment_marks(db, row.id, current_doc, candidate)
                invalidate_changed_go_deeper(db, row.id, candidate)
                from app.ai.comments import track_changed_minds
                track_changed_minds(db, row.id, candidate)
                changes['content_doc'] = candidate
                changes['content'] = document_content(candidate, current_doc, verified_comments=True)
            else:
                changes['content'] = document_content(candidate, current_doc)
    if "content" in changes and 'content_doc' not in changes and getattr(row, "content_blocks", None) is not None:
        raise WriteConflict("structured files must be edited using content_blocks")
    if "content_blocks" in changes:
        blocks = data.model_dump(mode="json", exclude_unset=True)["content_blocks"]
        changes["content_blocks"] = blocks
        changes["content"] = validate_blocks(blocks, old_blocks=row.content_blocks,
                                               old_content=row.content)
    return {key: value for key, value in changes.items() if getattr(row, key, None) != value}


def cleanup_private_ai(db, file_type, file_id):
    """Called in the source deletion transaction; keeps usage and saved files."""
    from app.ai.models import AICheckpoint, AIRequest

    db.execute(delete(AICheckpoint).where(AICheckpoint.file_type == file_type,
                                          AICheckpoint.file_id == file_id))
    # JSONB containment compares typed identity; a multi-source request is removed
    # as a whole because snapshots/question/result can contain the deleted source.
    db.execute(delete(AIRequest).where(AIRequest.sources.contains(
        [{"type": file_type, "id": file_id}])).execution_options(synchronize_session=False))


def invalidate_writing_ai(db, journal_id):
    """Invalidate in-flight writing requests in the source lifecycle transaction."""
    from sqlalchemy import update
    from app.ai.models import AIRequest
    db.execute(update(AIRequest).where(
        AIRequest.kind.in_(['go_deeper', 'minds_comments']),
        AIRequest.status.in_(['prepared', 'pending', 'ready']),
        AIRequest.sources.contains([{'type': 'journal', 'id': journal_id}]),
    ).values(status='conflict', error_category='source_changed')
       .execution_options(synchronize_session=False))


def invalidate_changed_go_deeper(db, journal_id, document):
    """Revoke a boundary as soon as its frozen prefix changes, even if later restored."""
    from app.ai.models import AIRequest
    from app.writing.documents import DocumentError, apply_ai_placeholder
    requests = db.scalars(select(AIRequest).where(
        AIRequest.kind == 'go_deeper', AIRequest.status.in_(['prepared','pending','ready']),
        AIRequest.sources.contains([{'type':'journal','id':journal_id}])).with_for_update()).all()
    for request in requests:
        try:
            apply_ai_placeholder(document, str(request.id), request.sources[0]['user_text'], 'check')
        except DocumentError:
            request.status = 'conflict'
            request.error_category = 'source_changed'


def delete_ai_block(db, file_type, file_id, block_id, expected_revision):
    from datetime import datetime, timezone
    from sqlalchemy import update
    from app.inbox.models import Inbox
    from app.journal.models import Journal

    model = Journal if file_type == "journal" else Inbox
    active = [model.deleted_at.is_(None)] if file_type == "journal" else []
    try:
        row = db.scalar(select(model).where(model.id == file_id, *active).with_for_update()
                        .execution_options(populate_existing=True))
        if row is None:
            return False
        if row.revision != expected_revision:
            raise WriteConflict("file revision has changed")
        if getattr(row, 'content_doc', None) is not None:
            if file_type != 'journal':
                raise WritingError('AI block deletion only supports Journal')
            from copy import deepcopy
            from app.ai.models import AIRequest
            from app.writing.documents import project_document
            from app.journal.schemas import _validate_content
            doc = deepcopy(row.content_doc)
            node = next((n for n in doc['content'] if n.get('attrs', {}).get('id') == block_id), None)
            if node is None:
                return False
            if node['type'] not in ('aiReply', 'aiSummary', 'aiPlaceholder'):
                raise WritingError('user blocks are edited through PATCH')
            doc['content'].remove(node)
            content = project_document(doc)
            _validate_content(content)
            row.content_doc = doc
            row.content = content
            row.revision += 1
            row.updated_at = datetime.now(timezone.utc)
            if node['type'] == 'aiPlaceholder':
                db.execute(update(AIRequest).where(AIRequest.id == node['attrs']['request_id'],
                    AIRequest.kind == 'go_deeper', AIRequest.status.in_(['prepared','pending','ready']),
                    AIRequest.sources.contains([{'type':'journal','id':file_id}]))
                    .values(status='conflict', error_category='source_changed'))
            db.commit()
            return True
        block = next((b for b in row.content_blocks or [] if b["id"] == block_id), None)
        if block is None:
            return False
        if block["kind"] == "user":
            raise WritingError("user blocks are edited through PATCH")
        blocks = [b for b in row.content_blocks if b["id"] != block_id]
        content = project_blocks(blocks)
        result = db.execute(update(model).where(model.id == file_id,
                            model.revision == expected_revision, *active)
                            .values(content_blocks=blocks, content=content,
                                    revision=model.revision + 1,
                                    updated_at=datetime.now(timezone.utc))
                            .execution_options(synchronize_session=False))
        if result.rowcount == 0:
            db.expire_all()
            if db.scalar(select(model.id).where(model.id == file_id, *active)) is None:
                return False
            raise WriteConflict("file revision has changed")
        db.commit()
    except Exception:
        db.rollback()
        raise
    return True
