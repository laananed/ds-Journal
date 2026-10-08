"""Insight Schema tests: shared Unicode rules, PATCH submission semantics, no date fields.

These tests are intentionally DB-free: they only exercise Pydantic validation and
pure helpers, so they run without PostgreSQL and guard the request contract that the
Service and Router rely on.
"""
import pytest
from pydantic import ValidationError


@pytest.mark.parametrize('title', [None, '', '  ', '🐟' * 80], ids=['null', 'empty', 'whitespace', 'emoji80'])
def test_create_and_patch_preserve_original_values(title):
    from app.insight.schemas import InsightCreate, InsightUpdate
    create = InsightCreate(content='  # source  \n', title=title)
    assert create.title == title and create.content == '  # source  \n'
    # Omitted fields stay unset; explicit null is a real instruction, not an omission.
    assert InsightUpdate().model_dump(exclude_unset=True) == {}
    assert InsightUpdate(title=title).model_dump(exclude_unset=True) == {'title': title}
    assert InsightUpdate(folder_id=None).model_dump(exclude_unset=True) == {'folder_id': None}


def test_insight_create_declares_no_date_source_or_ai_fields():
    from app.insight.schemas import InsightCreate, InsightResponse
    create = InsightCreate(
        content='x',
        journal_date='2030-01-01',
        inbox_date='2030-01-01',
        is_daily=True,
        source_journal_id=1,
        ai_state='done',
    )
    assert set(create.model_dump(exclude_unset=True)) == {'content'}
    for absent in ('journal_date', 'inbox_date', 'is_daily', 'source_journal_id', 'ai_state'):
        assert absent not in InsightResponse.model_fields


def test_content_is_required_on_create():
    from app.insight.schemas import InsightCreate
    with pytest.raises(ValidationError):
        InsightCreate()


@pytest.mark.parametrize('field,value', [('title', '🐟' * 81), ('title', '中' * 81), ('content', None), ('content', ''), ('content', ' \n\ufeff'), ('content', 'x' * 50001)], ids=['emoji81', 'cjk81', 'content-null', 'content-empty', 'content-blank', 'content-50001'])
def test_invalid_create_fields_are_rejected(field, value):
    from app.insight.schemas import InsightCreate
    payload = {'content': 'ok'}
    payload[field] = value
    with pytest.raises(ValidationError):
        InsightCreate(**payload)


@pytest.mark.parametrize('field,value', [('title', '🐟' * 81), ('content', None), ('content', ' \n\ufeff'), ('content', 'x' * 50001)], ids=['emoji81', 'content-null', 'content-blank', 'content-50001'])
def test_invalid_patch_fields_are_rejected(field, value):
    from app.insight.schemas import InsightUpdate
    with pytest.raises(ValidationError):
        InsightUpdate(**{field: value})


def test_patch_ignores_system_and_unknown_fields():
    from app.insight.schemas import InsightUpdate
    payload = {
        'id': 999,
        'type': 'journal',
        'display_title': 'evil',
        'created_at': '2000-01-01',
        'updated_at': '2000-01-01',
        'deleted_at': '2000-01-01',
        'journal_date': '2030-01-01',
        'inbox_date': '2030-01-01',
        'is_daily': True,
        'unknown': 'x',
    }
    assert InsightUpdate(**payload).model_dump(exclude_unset=True) == {}


@pytest.mark.parametrize('title,expected', [(None, '未命名 Insight'), ('', '未命名 Insight'), ('  ', '  '), ('原则', '原则')], ids=['null', 'empty', 'whitespace', 'manual'])
def test_display_title_fallback_is_projection_only(title, expected):
    from app.insight.service import build_insight_display_title
    assert build_insight_display_title(title) == expected
