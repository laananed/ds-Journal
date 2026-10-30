import pytest
from pydantic import ValidationError
from app.ai.schemas import AISettingsUpdate
from app.ai.settings import describe


def test_auto_settings_default_off_and_have_one_preset():
    value = describe(None)
    assert value['auto_go_deeper'] is False
    assert value['auto_minds_comments'] is False
    assert value['mind_preset_ids'] == ['gentle_reflection']


@pytest.mark.parametrize('presets', [[], ['gentle_reflection', 'gentle_reflection'], ['forged']])
def test_settings_reject_invalid_preset_sets(presets):
    with pytest.raises(ValidationError):
        AISettingsUpdate(expected_revision=0, mind_preset_ids=presets)


def test_settings_accept_independent_flags_and_presets():
    payload = AISettingsUpdate(expected_revision=0, auto_go_deeper=True,
                               auto_minds_comments=False,
                               mind_preset_ids=['thinking_traps'])
    assert payload.auto_go_deeper is True
    assert payload.mind_preset_ids == ['thinking_traps']


def test_auto_settings_round_trip_with_cas(api):
    client, _ = api
    defaults = client.get('/api/ai/settings').json()
    assert defaults['auto_go_deeper'] is False
    assert defaults['auto_minds_comments'] is False
    created = client.patch('/api/ai/settings', json={
        'expected_revision': 0, 'auto_goeper': True,
    })
    assert created.status_code == 422
    created = client.patch('/api/ai/settings', json={
        'expected_revision': 0, 'auto_go_deeper': True,
        'mind_preset_ids': ['alternative_perspectives'],
    })
    assert created.status_code == 200
    assert created.json()['auto_go_deeper'] is True
    assert created.json()['auto_minds_comments'] is False
    assert created.json()['mind_preset_ids'] == ['alternative_perspectives']
    assert client.patch('/api/ai/settings', json={
        'expected_revision': 1, 'auto_minds_comments': True,
    }).json()['revision'] == 2
    assert client.patch('/api/ai/settings', json={
        'expected_revision': 1, 'auto_go_deeper': False,
    }).status_code == 409
