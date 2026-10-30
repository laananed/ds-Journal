"""Atomic goal commands. All writers lock day, journals by ID, then links."""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select, update, or_
from app.journal.models import Journal
from app.journal.schemas import _validate_content
from app.ritual.dates import business_date
from app.ritual.models import RitualGoalLink
from app.ritual.service import lock_day, RelatedFilesChanged
from app.writing.documents import DocumentError, project_document, validate_document
from app.writing.service import require_revision, WriteConflict, WritingError, PreconditionRequired


class SourceUnavailable(WriteConflict):
    code = 'source_unavailable'


def _locked_day(db, source_id, end_id=None):
    source = db.get(Journal, source_id)
    if source is None:
        raise SourceUnavailable('source unavailable')
    lock_day(db, source.journal_date)
    ids = [source_id] + ([end_id] if end_id is not None else [])
    rows = db.scalars(select(Journal).where(Journal.id.in_(ids)).order_by(Journal.id)
                      .with_for_update().execution_options(populate_existing=True)).all()
    found = {row.id: row for row in rows}
    source, end = found.get(source_id), found.get(end_id)
    if source is None or source.deleted_at is not None or source.journal_kind != 'set':
        raise SourceUnavailable('source unavailable')
    if end_id is not None and (end is None or end.deleted_at is not None or
                               end.journal_kind != 'end' or end.journal_date != source.journal_date):
        raise RelatedFilesChanged('end unavailable or changed')
    return source, end


def _goal(source, goal_id):
    if source.content_doc is None:
        raise SourceUnavailable('source unavailable')
    matches = [n for n in source.content_doc['content'] if n['type'] == 'goalItem'
               and n['attrs']['goal_id'] == str(goal_id)]
    if len(matches) != 1:
        raise SourceUnavailable('source unavailable')
    return matches[0]


def _write_doc(db, row, doc, *, user_edit=True):
    try:
        validate_document(doc)
        content = project_document(doc)
        _validate_content(content)
    except (DocumentError, ValueError) as error:
        raise WritingError(str(error)) from error
    from app.writing.service import invalidate_changed_go_deeper
    invalidate_changed_go_deeper(db, row.id, doc)
    from app.ai.comments import track_changed_minds
    track_changed_minds(db, row.id, doc)
    row.content_doc, row.content = doc, content
    row.revision += 1
    if user_edit:
        row.updated_at = datetime.now(timezone.utc)
    else:
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(row, 'updated_at')


def _same_document_intent(row, data):
    return (data.content_doc == row.content_doc and 'journal_date' not in data.model_fields_set and
            all(key not in data.model_fields_set or getattr(data, key) == getattr(row, key)
                for key in ('title', 'folder_id')))


def _mutation(db, bases):
    from app.journal.service import get_journal
    db.flush()
    files, effects = [], []
    for row, base, ops in bases:
        db.expire(row)
        files.append(get_journal(db, row.id))
        effects.append({'type': 'journal', 'id': row.id, 'base_revision': base,
                        'revision': row.revision, 'ops': ops})
    return {'files': files, 'effects': effects, 'request_id': None}


def detach_for_delete(db, journal_id, expected_revision, related, *, additional_ids=()):
    """Detach active links within the caller's deletion transaction."""
    initial = db.get(Journal, journal_id)
    if initial is None:
        return
    lock_day(db, initial.journal_date)
    predicate = (RitualGoalLink.set_journal_id.is_not(None) &
                 or_(RitualGoalLink.set_journal_id == journal_id,
                     RitualGoalLink.end_journal_id == journal_id))
    candidates = db.scalars(select(RitualGoalLink).where(predicate)).all()
    ids = {journal_id, *additional_ids}
    for link in candidates:
        ids.update((link.set_journal_id, link.end_journal_id))
    rows = db.scalars(select(Journal).where(Journal.id.in_(ids)).order_by(Journal.id)
                      .with_for_update().execution_options(populate_existing=True)).all()
    found = {row.id: row for row in rows}
    links = db.scalars(select(RitualGoalLink).where(predicate).order_by(RitualGoalLink.id)
                       .with_for_update().execution_options(populate_existing=True)).all()
    actual = {journal_id, *additional_ids}
    for link in links:
        actual.update((link.set_journal_id, link.end_journal_id))
    if actual != ids or set(found) != ids:
        raise RelatedFilesChanged('association set changed')
    if found[journal_id].revision != expected_revision:
        raise WriteConflict('file revision changed')
    required = ids - {journal_id, *additional_ids}
    supplied = {item.id: item.revision for item in related.related_revisions} if related is not None else {}
    if required - supplied.keys():
        raise PreconditionRequired('related revisions are required')
    if set(supplied) != required or any(found[i].revision != rev for i, rev in supplied.items()):
        raise RelatedFilesChanged('related files changed')
    bases = {item_id: found[item_id].revision for item_id in required}
    end_docs = {}
    for link in links:
        end = found[link.end_journal_id]
        if end.content_doc is None:
            raise RelatedFilesChanged('linked review unavailable')
        doc = end_docs.setdefault(end.id, deepcopy(end.content_doc))
        reviews = [node for node in doc['content'] if node['type'] == 'goalReview' and
                   node['attrs']['id'] == str(link.end_node_id) and
                   node['attrs']['link_id'] == str(link.id)]
        if len(reviews) != 1:
            raise RelatedFilesChanged('linked review changed')
        reviews[0]['attrs']['link_id'] = None
        link.set_journal_id = None
    db.flush()
    for related_id in ids:
        if related_id in additional_ids:
            continue
        if related_id == journal_id and related_id not in end_docs:
            continue
        values = {'updated_at': Journal.updated_at}
        if related_id in end_docs:
            doc = end_docs[related_id]
            values.update(content_doc=doc, content=project_document(doc))
        if related_id != journal_id:
            values['revision'] = Journal.revision + 1
        db.execute(update(Journal).where(Journal.id == related_id).values(**values)
                   .execution_options(synchronize_session=False))
    db.expire_all()
    return bases


def patch_set_document(db, set_id, data):
    """Apply a Set document edit and any linked review projections atomically."""
    from app.journal.service import _folder_exists, FolderNotFoundError, get_journal
    from app.writing.service import document_content
    require_revision(data.expected_revision)
    try:
        initial = db.get(Journal, set_id)
        lock_day(db, initial.journal_date)
        before_links = db.scalars(select(RitualGoalLink).where(
            RitualGoalLink.set_journal_id == set_id)).all()
        ids = {set_id} | {link.end_journal_id for link in before_links}
        rows = db.scalars(select(Journal).where(Journal.id.in_(ids)).order_by(Journal.id)
                          .with_for_update().execution_options(populate_existing=True)).all()
        found = {row.id: row for row in rows}
        links = db.scalars(select(RitualGoalLink).where(RitualGoalLink.set_journal_id == set_id)
                           .order_by(RitualGoalLink.id).with_for_update()
                           .execution_options(populate_existing=True)).all()
        if ids != ({set_id} | {link.end_journal_id for link in links}) or set(found) != ids:
            raise RelatedFilesChanged('association set changed')
        source = found[set_id]
        if source.deleted_at is not None or source.journal_kind != 'set':
            raise SourceUnavailable('source unavailable')
        if _same_document_intent(source, data):
            result = get_journal(db, set_id)
            db.commit()
            return result
        if source.revision != data.expected_revision:
            raise WriteConflict('set revision changed')
        if 'journal_date' in data.model_fields_set:
            raise WritingError('ritual date cannot be changed')
        candidate = data.content_doc
        try:
            validate_document(candidate)
        except (DocumentError, ValueError) as error:
            raise WritingError(str(error)) from error

        def goals(doc):
            result = {}
            for node in doc['content']:
                if node['type'] == 'goalItem':
                    attrs = node['attrs']
                    if attrs['goal_id'] in result or not attrs['text'].strip():
                        raise WritingError('invalid or duplicate goal')
                    result[attrs['goal_id']] = node
            return result
        old_goals, new_goals = goals(source.content_doc), goals(candidate)
        for link in links:
            end = found[link.end_journal_id]
            review = next((node for node in (end.content_doc or {}).get('content', [])
                           if node['type'] == 'goalReview' and node['attrs']['id'] == str(link.end_node_id)), None)
            if (str(link.goal_id) not in old_goals or end.deleted_at is not None or
                    end.journal_kind != 'end' or end.journal_date != source.journal_date or
                    review is None or review['attrs']['link_id'] != str(link.id)):
                raise RelatedFilesChanged('linked review unavailable')
        for goal_id in old_goals.keys() & new_goals.keys():
            if old_goals[goal_id]['attrs']['id'] != new_goals[goal_id]['attrs']['id']:
                raise WritingError('goal identity cannot change')
        shadow = deepcopy(source.content_doc)
        shadow['content'] = [node for node in shadow['content'] if node['type'] != 'goalItem']
        shadow['content'].extend(deepcopy(list(new_goals.values())))
        from app.ai.comments import reconcile_comment_marks
        candidate = reconcile_comment_marks(db, source.id, source.content_doc, candidate)
        from app.writing.service import invalidate_changed_go_deeper
        invalidate_changed_go_deeper(db, source.id, candidate)
        from app.ai.comments import track_changed_minds
        track_changed_minds(db, source.id, candidate)
        projected = document_content(candidate, shadow, verified_comments=True)
        changed = {goal_id for goal_id in old_goals.keys() | new_goals.keys()
                   if old_goals.get(goal_id) != new_goals.get(goal_id)}
        affected = [link for link in links if str(link.goal_id) in changed]
        mutation_bases = [(source, source.revision, [
            {'kind': 'goal_fields', 'node_id': (new_goals.get(goal_id) or old_goals[goal_id])['attrs']['id']}
            for goal_id in sorted(changed)])]
        for end_id in sorted({link.end_journal_id for link in affected}):
            mutation_bases.append((found[end_id], found[end_id].revision, [
                {'kind': 'goal_visibility' if str(link.goal_id) not in new_goals else 'goal_fields',
                 'node_id': str(link.end_node_id)} for link in affected if link.end_journal_id == end_id]))
        required = {link.end_journal_id for link in affected}
        provided = {item.id: item.revision for item in (data.related_revisions or [])}
        if required - provided.keys():
            raise PreconditionRequired('related revisions are required')
        if len(provided) != len(data.related_revisions or []) or set(provided) != required or any(
                found[item_id].revision != revision for item_id, revision in provided.items()):
            raise RelatedFilesChanged('related files changed')
        docs = {}
        for link in affected:
            end = found[link.end_journal_id]
            if end.deleted_at is not None or end.journal_kind != 'end' or end.journal_date != source.journal_date:
                raise RelatedFilesChanged('related end unavailable')
            doc = docs.setdefault(end.id, deepcopy(end.content_doc))
            reviews = [node for node in doc['content'] if node['type'] == 'goalReview' and
                       node['attrs']['id'] == str(link.end_node_id) and node['attrs']['link_id'] == str(link.id)]
            if len(reviews) != 1:
                raise RelatedFilesChanged('linked review changed')
            review = reviews[0]
            new_goal = new_goals.get(str(link.goal_id))
            if new_goal is None:
                review['attrs']['link_id'] = None
                link.set_journal_id = None
            else:
                attrs = new_goal['attrs']
                review['attrs'].update(goal_snapshot=attrs['text'], checked_snapshot=attrs['checked'],
                                       review_title=attrs['text'])
        if 'folder_id' in data.model_fields_set and data.folder_id is not None and not _folder_exists(db, data.folder_id):
            raise FolderNotFoundError('Folder does not exist')
        changed_source = source.content_doc != candidate
        for key in ('title', 'folder_id'):
            if key in data.model_fields_set and getattr(source, key) != getattr(data, key):
                setattr(source, key, getattr(data, key))
                changed_source = True
        for end_id, doc in docs.items():
            _write_doc(db, found[end_id], doc, user_edit=False)
        if changed_source:
            source.content_doc, source.content = deepcopy(candidate), projected
            source.revision += 1
            source.updated_at = datetime.now(timezone.utc)
        mutation = _mutation(db, mutation_bases) if affected else None
        db.flush()
        result = get_journal(db, set_id)
        if mutation is not None:
            result.file_mutation = mutation
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def patch_end_document(db, end_id, data):
    """Save answers or explicitly remove whole reviews, with source CAS."""
    from app.journal.service import _folder_exists, FolderNotFoundError, get_journal
    from app.writing.service import document_content
    require_revision(data.expected_revision)
    try:
        initial = db.get(Journal, end_id)
        lock_day(db, initial.journal_date)
        before = db.scalars(select(RitualGoalLink).where(RitualGoalLink.end_journal_id == end_id)).all()
        ids = {end_id} | {link.set_journal_id for link in before if link.set_journal_id is not None}
        rows = db.scalars(select(Journal).where(Journal.id.in_(ids)).order_by(Journal.id)
                          .with_for_update().execution_options(populate_existing=True)).all()
        found = {row.id: row for row in rows}
        links = db.scalars(select(RitualGoalLink).where(RitualGoalLink.end_journal_id == end_id)
                           .order_by(RitualGoalLink.id).with_for_update()
                           .execution_options(populate_existing=True)).all()
        if ids != ({end_id} | {link.set_journal_id for link in links if link.set_journal_id is not None}) or set(found) != ids:
            raise RelatedFilesChanged('association set changed')
        end = found[end_id]
        if end.deleted_at is not None or end.journal_kind != 'end':
            raise RelatedFilesChanged('end unavailable')
        if _same_document_intent(end, data):
            result = get_journal(db, end_id)
            db.commit()
            return result
        if end.revision != data.expected_revision:
            raise WriteConflict('end revision changed')
        if 'journal_date' in data.model_fields_set:
            raise WritingError('ritual date cannot be changed')
        candidate = data.content_doc
        try:
            validate_document(candidate)
        except (DocumentError, ValueError) as error:
            raise WritingError(str(error)) from error
        old = {node['attrs']['id']: node for node in end.content_doc['content'] if node['type'] == 'goalReview'}
        new = {node['attrs']['id']: node for node in candidate['content'] if node['type'] == 'goalReview'}
        for link in links:
            review = old.get(str(link.end_node_id))
            expected_link = str(link.id) if link.set_journal_id is not None else None
            if review is None or review['attrs']['link_id'] != expected_link:
                raise RelatedFilesChanged('linked review unavailable')
        if new.keys() - old.keys():
            raise WritingError('review creation requires linking')
        removed = old.keys() - new.keys()
        shadow = deepcopy(end.content_doc)
        shadow['content'] = [node for node in shadow['content']
                             if node['type'] != 'goalReview' or node['attrs']['id'] not in removed]
        from app.ai.comments import reconcile_comment_marks
        candidate = reconcile_comment_marks(db, end.id, end.content_doc, candidate)
        from app.writing.service import invalidate_changed_go_deeper
        invalidate_changed_go_deeper(db, end.id, candidate)
        from app.ai.comments import track_changed_minds
        track_changed_minds(db, end.id, candidate)
        projected = document_content(candidate, shadow, verified_comments=True)
        affected = [link for link in links if str(link.end_node_id) in removed]
        required = {link.set_journal_id for link in affected if link.set_journal_id is not None}
        mutation_bases = [(end, end.revision, [{'kind': 'goal_visibility', 'node_id': node_id}
                                               for node_id in sorted(removed)])]
        mutation_bases.extend((found[source_id], found[source_id].revision,
                               [{'kind': 'goal_visibility'}]) for source_id in sorted(required))
        provided = {item.id: item.revision for item in (data.related_revisions or [])}
        if required - provided.keys():
            raise PreconditionRequired('related revisions are required')
        if len(provided) != len(data.related_revisions or []) or set(provided) != required or any(
                found[item_id].revision != revision for item_id, revision in provided.items()):
            raise RelatedFilesChanged('related files changed')
        if 'folder_id' in data.model_fields_set and data.folder_id is not None and not _folder_exists(db, data.folder_id):
            raise FolderNotFoundError('Folder does not exist')
        for link in affected:
            db.delete(link)
        for related_id in required:
            source = found[related_id]
            if source.deleted_at is not None or source.journal_kind != 'set' or source.journal_date != end.journal_date:
                raise RelatedFilesChanged('source unavailable')
            source.revision += 1
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(source, 'updated_at')
        changed_end = end.content_doc != candidate
        for key in ('title', 'folder_id'):
            if key in data.model_fields_set and getattr(end, key) != getattr(data, key):
                setattr(end, key, getattr(data, key))
                changed_end = True
        if changed_end:
            end.content_doc, end.content = deepcopy(candidate), projected
            end.revision += 1
            end.updated_at = datetime.now(timezone.utc)
        mutation = _mutation(db, mutation_bases) if required else None
        db.flush()
        result = get_journal(db, end_id)
        if mutation is not None:
            result.file_mutation = mutation
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def create_links(db, data):
    require_revision(data.expected_set_revision)
    require_revision(data.expected_end_revision)
    try:
        source, end = _locked_day(db, data.source_set_id, data.end_id)
        goals = [_goal(source, goal_id) for goal_id in data.goal_ids]
        if end is None:
            # New-end creation has an additional replay/creation contract and
            # remains fail-closed until that path is implemented.
            raise WritingError('creating end through goal linking is unavailable')
        if end.content_doc is None:
            raise WritingError('end requires converted document')
        links = db.scalars(select(RitualGoalLink).where(
            RitualGoalLink.end_journal_id == end.id).order_by(RitualGoalLink.id).with_for_update()).all()
        existing = {str(link.goal_id): link for link in links}
        doc = deepcopy(end.content_doc)
        base = end.revision
        ops = []
        for goal in goals:
            attrs = goal['attrs']
            link = existing.get(attrs['goal_id'])
            if link is not None:
                if link.set_journal_id is None:
                    matches = [node for node in doc['content'] if node['type'] == 'goalReview' and
                               node['attrs']['id'] == str(link.end_node_id) and
                               node['attrs']['link_id'] is None]
                    if len(matches) != 1:
                        raise RelatedFilesChanged('detached review changed')
                    # Reuse only the stable goal identity and existing review;
                    # neither historical snapshot nor user answer is replaced.
                    matches[0]['attrs']['link_id'] = str(link.id)
                    link.set_journal_id = source.id
                    ops.append({'kind': 'goal_visibility', 'node_id': str(link.end_node_id)})
                elif link.set_journal_id != source.id:
                    raise RelatedFilesChanged('association belongs to another set')
                elif not any(node['type'] == 'goalReview' and node['attrs']['id'] == str(link.end_node_id) and
                             node['attrs']['link_id'] == str(link.id) for node in doc['content']):
                    raise RelatedFilesChanged('linked review unavailable')
                continue
            link_id, node_id = uuid4(), uuid4()
            db.add(RitualGoalLink(id=link_id, set_journal_id=source.id, end_journal_id=end.id,
                                  goal_id=attrs['goal_id'], end_node_id=node_id))
            doc['content'].append({'type': 'goalReview', 'attrs': {
                'id': str(node_id), 'link_id': str(link_id), 'goal_snapshot': attrs['text'],
                'checked_snapshot': attrs['checked'], 'review_title': attrs['text']}, 'content': []})
            ops.append({'kind': 'goal_fields', 'node_id': str(node_id)})
        if ops:
            if source.revision != data.expected_set_revision:
                raise WriteConflict('set revision changed')
            if end.revision != data.expected_end_revision:
                raise WriteConflict('end revision changed')
            _write_doc(db, end, doc)
            result = _mutation(db, [(end, base, ops)])
        else:
            from app.journal.service import get_journal
            result = {'files': [get_journal(db, end.id)], 'effects': [], 'request_id': None}
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def update_goal(db, set_id, goal_id, data):
    require_revision(data.expected_set_revision)
    try:
        initial = db.get(Journal, set_id)
        if initial is None:
            raise SourceUnavailable('source unavailable')
        lock_day(db, initial.journal_date)
        links = db.scalars(select(RitualGoalLink).where(
            RitualGoalLink.set_journal_id == set_id, RitualGoalLink.goal_id == goal_id)).all()
        if len(links) > 1:
            raise RelatedFilesChanged('association set changed')
        end_id = links[0].end_journal_id if links else None
        source, end = _locked_day(db, set_id, end_id)
        links = db.scalars(select(RitualGoalLink).where(
            RitualGoalLink.set_journal_id == set_id, RitualGoalLink.goal_id == goal_id)
            .order_by(RitualGoalLink.id).with_for_update()).all()
        if (links[0].end_journal_id if len(links) == 1 else None) != end_id or len(links) > 1:
            raise RelatedFilesChanged('association set changed')
        if end is not None:
            require_revision(data.expected_end_revision)
        goal = _goal(source, goal_id)
        source_doc = deepcopy(source.content_doc)
        updated = next(n for n in source_doc['content'] if n['type'] == 'goalItem'
                       and n['attrs']['goal_id'] == str(goal_id))
        for key in ('text', 'checked'):
            if key in data.model_fields_set:
                updated['attrs'][key] = getattr(data, key)
        if updated == goal:
            if end is not None:
                reviews = [n for n in (end.content_doc or {}).get('content', []) if n['type'] == 'goalReview' and
                           n['attrs']['id'] == str(links[0].end_node_id) and n['attrs']['link_id'] == str(links[0].id)]
                if (len(reviews) != 1 or reviews[0]['attrs']['goal_snapshot'] != goal['attrs']['text'] or
                        reviews[0]['attrs']['checked_snapshot'] != goal['attrs']['checked']):
                    raise RelatedFilesChanged('review differs from source')
            from app.journal.service import get_journal
            result = {'files': [get_journal(db, row.id) for row in [source, end] if row is not None],
                      'effects': [], 'request_id': None}
            db.commit()
            return result
        if source.revision != data.expected_set_revision:
            raise WriteConflict('set revision changed')
        if end is not None and end.revision != data.expected_end_revision:
            raise WriteConflict('end revision changed')
        bases = [(source, source.revision, [{'kind': 'goal_fields', 'node_id': goal['attrs']['id']}])]
        _write_doc(db, source, source_doc)
        if end is not None:
            doc = deepcopy(end.content_doc)
            matches = [n for n in doc['content'] if n['type'] == 'goalReview' and
                       n['attrs']['id'] == str(links[0].end_node_id) and
                       n['attrs']['link_id'] == str(links[0].id)]
            if len(matches) != 1:
                raise RelatedFilesChanged('review changed')
            review = matches[0]
            answer = deepcopy(review.get('content', []))
            review['attrs'].update(goal_snapshot=updated['attrs']['text'],
                                   checked_snapshot=updated['attrs']['checked'],
                                   review_title=updated['attrs']['text'])
            assert review.get('content', []) == answer
            bases.append((end, end.revision, [{'kind': 'goal_fields', 'node_id': review['attrs']['id']}]))
            _write_doc(db, end, doc)
        result = _mutation(db, bases)
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise
