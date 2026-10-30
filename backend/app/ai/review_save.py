"""One explicit confirmation, target+request in one transaction."""
from sqlalchemy import select

from app.ai.models import AIRequest
from app.ai.review import lock_sources, matches
from app.ai.requests import RequestNotFound
from app.ai.usage import call_payload_hash
from app.folder.models import Folder, folder_fk_violation
from app.journal.models import Journal
from app.journal.service import get_journal
from app.writing.service import WritingError, WriteConflict, LegacyConversionRequired, summary_blocks


def save_review(db, request_id, payload):
    digest = call_payload_hash(payload.model_dump(mode='json',exclude_unset=True))
    try:
        snapshot = db.get(AIRequest,request_id)
        if snapshot is None: raise RequestNotFound('AI request not found')
        sources = snapshot.sources
        db.rollback()  # Read identity first; acquire source locks before request.
        locked = lock_sources(db,sources)
        request = db.scalar(select(AIRequest).where(AIRequest.id==request_id).with_for_update()
                            .execution_options(populate_existing=True))
        if request is None: raise RequestNotFound('AI request not found')
        if request.kind != 'review': raise WriteConflict('only a ready review can be saved')
        if request.status == 'applied':
            if request.save_payload_hash != digest: raise WriteConflict('review was saved with a different payload')
            target = get_journal(db,request.saved_target['id'])
            if target is None: raise RequestNotFound('Saved Journal is no longer available')
            response = {'request_id':str(request_id),'status':'applied','target':target.model_dump(mode='json')}
            db.rollback()
            return response,200
        if request.status != 'ready': raise WriteConflict('only a ready review can be saved')
        if not all(matches(row,s) for s,row in locked):
            request.status = 'conflict'
            request.error_category = 'source_changed'
            db.commit()
            raise WriteConflict('review source has changed; generate a new review')
        target = payload.target
        if target.mode == 'append_source':
            if len(locked)!=1 or locked[0][0]['type']!='journal':
                raise WritingError('append_source requires one Journal')
            row = locked[0][1]
            if getattr(row, 'content_doc', None) is not None:
                raise LegacyConversionRequired('legacy AI cannot modify a structured document')
            blocks,content = summary_blocks(payload.markdown,request_id,row.content_blocks,row.content)
            from datetime import datetime, timezone
            row.content_blocks = blocks
            row.content = content
            row.revision += 1
            row.updated_at = datetime.now(timezone.utc)
            code = 200
        else:
            if target.folder_id is not None:
                folder = db.scalar(select(Folder).where(Folder.id==target.folder_id).with_for_update())
                if folder is None: raise RequestNotFound('Folder not found')
            blocks,content = summary_blocks(payload.markdown,request_id)
            row = Journal(content=content,content_blocks=blocks,
                          title=target.title if target.title else 'AI 复盘 '+target.journal_date.isoformat(),
                          journal_date=target.journal_date,folder_id=target.folder_id,revision=1)
            db.add(row)
            code = 201
        db.flush()
        request.status = 'applied'
        request.saved_target = {'type':'journal','id':row.id}
        request.save_payload_hash = digest
        # Produce the response inside the transaction as well: projection errors
        # must not commit a target whose confirmation response cannot be built.
        detail = get_journal(db,row.id).model_dump(mode='json')
        response = {'request_id':str(request_id),'status':'applied','target':detail}
        db.commit()
        return response,code
    except Exception as error:
        db.rollback()
        if folder_fk_violation(error): raise RequestNotFound('Folder not found') from error
        raise
