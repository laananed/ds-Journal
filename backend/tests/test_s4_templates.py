"""Ritual template contracts on the rollback-isolated API fixture."""

from uuid import uuid4


def test_template_cas_and_validation(api):
    client, _ = api
    assert client.get('/api/ritual-templates').json()['set'] == {'questions': [], 'revision': 0}
    question = {'id': str(uuid4()), 'text': '  合成问题  '}
    result = client.patch('/api/ritual-templates/set', json={
        'expected_revision': 0, 'questions': [question],
    })
    assert result.status_code == 200
    assert result.json() == {'questions': [{'id': question['id'], 'text': '合成问题'}], 'revision': 1}
    assert client.patch('/api/ritual-templates/set', json={
        'expected_revision': 1, 'questions': [question],
    }).json()['revision'] == 1
    assert client.patch('/api/ritual-templates/set', json={
        'expected_revision': 0, 'questions': [],
    }).status_code == 409
    assert client.patch('/api/ritual-templates/set', json={
        'expected_revision': 1, 'questions': [question] * 5,
    }).status_code == 422


def test_empty_template_noop_and_missing_revision(api):
    client, _ = api
    assert client.patch('/api/ritual-templates/end', json={'questions': []}).status_code == 428
    response = client.patch('/api/ritual-templates/end', json={
        'expected_revision': 0, 'questions': [],
    })
    assert response.json() == {'questions': [], 'revision': 0}
