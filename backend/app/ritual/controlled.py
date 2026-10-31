"""Controlled, single-file Ritual node creation (API §4, 2026-10-31).

Two commands share one transaction shape:

1. lock the business day, then the file row (same order as the other Ritual
   writers), verifying the client's file revision;
2. for questions, additionally lock the current template of that kind and
   verify its revision plus the question's ownership;
3. let the server build the node(s) — the client only names the template
   question or the checklist item, never the snapshot text or goal identity;
4. write the document and its projection in the same transaction.

Replay semantics: there is no persistent idempotency table (architecture §5).
A retry re-sends the same `expected_revision`, which the CAS in step 1 rejects
once the first attempt committed, so the same request can never insert twice.
Clients must re-read the file after a lost response instead of bumping the
revision to force the command through.
"""
from uuid import uuid4

from sqlalchemy import select

from app.journal.models import Journal
from app.ritual.goals import SourceUnavailable, _mutation, _write_doc
from app.ritual.models import RitualTemplate
from app.ritual.service import lock_day
from app.writing.documents import DocumentError, convert_ritual_task_item, insert_ritual_question
from app.writing.service import require_revision, WriteConflict, WritingError


def _locked_ritual(db, journal_id, revision):
    initial = db.get(Journal, journal_id)
    if initial is None:
        raise SourceUnavailable('source unavailable')
    lock_day(db, initial.journal_date)
    row = db.scalar(select(Journal).where(Journal.id == journal_id).with_for_update()
                    .execution_options(populate_existing=True))
    if row is None or row.deleted_at is not None or row.journal_kind not in ('set', 'end'):
        raise SourceUnavailable('source unavailable')
    if row.revision != revision:
        raise WriteConflict('file revision has changed')
    if row.content_doc is None:
        raise WritingError('Ritual requires converted document')
    return row


def create_controlled_node(db, journal_id, data, *, question):
    revision = require_revision(data.expected_revision)
    template_revision = require_revision(data.expected_template_revision) if question else None
    try:
        row = _locked_ritual(db, journal_id, revision)
        node_id = str(uuid4())
        if question:
            template = db.scalar(select(RitualTemplate).where(RitualTemplate.kind == row.journal_kind)
                                 .with_for_update().execution_options(populate_existing=True))
            if template is None or template.revision != template_revision:
                raise WriteConflict('template revision has changed')
            matches = [q for q in template.questions if q['id'] == str(data.question_id)]
            if len(matches) != 1:
                raise WriteConflict('template question unavailable')
            doc = insert_ritual_question(row.content_doc, node_id, str(uuid4()),
                                         str(data.question_id), matches[0]['text'])
        else:
            if row.journal_kind != 'set':
                raise WritingError('goals require a Set')
            try:
                doc = convert_ritual_task_item(row.content_doc, str(data.task_item_id), node_id, str(uuid4()))
            except DocumentError as error:
                raise WritingError(str(error)) from error
        _write_doc(db, row, doc)
        result = _mutation(db, [(row, revision, [{'kind': 'copy_nodes', 'node_id': node_id}])])
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise
