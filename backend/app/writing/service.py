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


def require_revision(revision):
    if revision is None:
        raise PreconditionRequired("expected_revision or If-Match is required")
    return revision


def create_hash(data):
    # Defaults and omission have equal meaning except Inbox's omitted title.
    body = data.model_dump(mode="json", exclude={"client_create_id"})
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


def insert_ai_reply(row, reply, request_id, captured_blocks):
    """Server-only append at the captured user boundary. Does not commit.

    The caller has already locked/checked the source. Preserve existing user
    IDs and the preallocated empty continuation. Convert NULL only on success.
    """
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


def writing_changes(row, data):
    changes = data.model_dump(mode="python", exclude_unset=True, exclude={"expected_revision"})
    if "content" in changes and getattr(row, "content_blocks", None) is not None:
        raise WriteConflict("structured files must be edited using content_blocks")
    if "content_blocks" in changes:
        blocks = data.model_dump(mode="json", exclude_unset=True)["content_blocks"]
        changes["content_blocks"] = blocks
        changes["content"] = validate_blocks(blocks, old_blocks=row.content_blocks,
                                               old_content=row.content)
    return {key: value for key, value in changes.items() if getattr(row, key) != value}


def cleanup_private_ai(db, file_type, file_id):
    """Called in the source deletion transaction; keeps usage and saved files."""
    from app.ai.models import AICheckpoint, AIRequest

    db.execute(delete(AICheckpoint).where(AICheckpoint.file_type == file_type,
                                          AICheckpoint.file_id == file_id))
    # JSONB containment compares typed identity; a multi-source request is removed
    # as a whole because snapshots/question/result can contain the deleted source.
    db.execute(delete(AIRequest).where(AIRequest.sources.contains(
        [{"type": file_type, "id": file_id}])).execution_options(synchronize_session=False))


def delete_ai_block(db, file_type, file_id, block_id, expected_revision):
    from datetime import datetime, timezone
    from sqlalchemy import update
    from app.inbox.models import Inbox
    from app.journal.models import Journal

    model = Journal if file_type == "journal" else Inbox
    active = [model.deleted_at.is_(None)] if file_type == "journal" else []
    try:
        row = db.scalar(select(model).where(model.id == file_id, *active)
                        .execution_options(populate_existing=True))
        if row is None:
            return False
        if row.revision != expected_revision:
            raise WriteConflict("file revision has changed")
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
