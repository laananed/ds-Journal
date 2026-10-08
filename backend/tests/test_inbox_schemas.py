"""Schema tests use existing validated Unicode rules and submission semantics."""
import pytest
from pydantic import ValidationError


@pytest.mark.parametrize('title', [None, '', '  ', '🐟' * 80], ids=['null', 'empty', 'whitespace', 'emoji80'])
def test_title_and_content_are_preserved_and_patch_omission_is_distinct(title):
    from app.inbox.schemas import InboxCreate, InboxUpdate
    create = InboxCreate(content='  # source  \n', inbox_date='2034-01-01', title=title)
    assert create.title == title and create.content == '  # source  \n'
    assert InboxUpdate().model_dump(exclude_unset=True) == {}
    assert InboxUpdate(title=title).model_dump(exclude_unset=True) == {'title': title}
    assert InboxUpdate(inbox_date='2035-01-01', is_daily=True, id=999).model_dump(exclude_unset=True) == {}


@pytest.mark.parametrize('field,value', [('title', '🐟' * 81), ('content', None), ('content', ' \n\ufeff'), ('content', 'x' * 50001)], ids=['emoji81', 'content-null', 'blank', '50001'])
def test_actual_invalid_patch_fields_are_rejected(field, value):
    from app.inbox.schemas import InboxUpdate
    with pytest.raises(ValidationError):
        InboxUpdate(**{field: value})
