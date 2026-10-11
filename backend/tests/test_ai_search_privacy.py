"""S3-T06 public-query privacy gate.

These cases pin the *verifiable interception* the product requires
(``docs/stage3.md`` §4, ``docs/stage3-architecture.md`` §6): a query may only
leave the process when it passed every rule, and a blocked query must not open a
socket at all.

The rules are deliberately conservative — an uncertain query is skipped rather
than sent — but they are pattern/overlap checks, **not** a semantic proof that a
query is private. Nothing here claims absolute privacy; the tests pin the
checkable contract only.
"""

from __future__ import annotations

import pytest

from app.ai import search

# Synthetic private text. Unique consecutive characters make an accidental
# 12-code-point overlap impossible, so a positive/negative case is unambiguous.
PRIVATE_JOURNAL = "今天的日记内容：" + "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉" + "，就写到这里。"
PRIVATE_PROMPT = "请用安静克制的语气陪我写字，不要提建议，也别催我。"
PRIVATE_QUESTION = "我为什么老想着那件没做完的事？"


class FakeSearchTransport:
    """Records every outbound search request; never opens a socket."""

    def __init__(self, response=None):
        self.calls = []
        self.response = response

    def get_json(self, url, params, headers, timeout, max_bytes):
        self.calls.append({"url": url, "params": params, "headers": headers,
                           "timeout": timeout, "max_bytes": max_bytes})
        if isinstance(self.response, Exception):
            raise self.response
        from app.ai.client import TransportResponse
        return self.response or TransportResponse(
            200, b'{"web": {"results": []}}', "application/json")


@pytest.fixture
def search_key(monkeypatch):
    monkeypatch.setenv(search.SEARCH_KEY_ENV, "synthetic-brave-key")
    return "synthetic-brave-key"


def verdict(query, texts=()):
    return search.check_public_query(query, texts)


# ---------------------------------------------------------------------------
# Length / shape: 1-120 Unicode code points
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("query", ["", "   ", "\t\n", None, 5, ["x"]])
def test_empty_blank_or_non_text_queries_are_blocked(query):
    result = verdict(query)
    assert result.allowed is False
    assert result.query is None
    assert result.reason in {"empty", "not_text"}


def test_one_hundred_twenty_code_points_pass_and_longer_is_blocked():
    assert verdict("a" * 120).allowed is True
    assert verdict("a" * 121).reason == "too_long"


def test_length_is_counted_in_code_points_not_bytes():
    """120 emoji are 480 UTF-8 bytes but exactly 120 code points."""
    assert verdict("😀" * 120).allowed is True
    assert verdict("😀" * 121).reason == "too_long"


def test_allowed_query_is_stripped_but_not_rewritten():
    result = verdict("  认知失调  的定义  ")
    assert result.allowed is True
    assert result.query == "认知失调  的定义"


# ---------------------------------------------------------------------------
# Direct identifiers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("query", [
    "someone@example.com 是谁",
    "user+tag@sub.example.co.jp",
    "我的邮箱是 a.b@example.com",
])
def test_email_like_queries_are_blocked(query):
    assert verdict(query).reason == "email"


@pytest.mark.parametrize("query", [
    "13812345678",
    "手机号 138 1234 5678",
    "010-12345678",
    "11010119900307123X",
    "6222 0212 3456 7890",
    "身份证 110101199003071234",
])
def test_phone_and_identifier_like_queries_are_blocked(query):
    assert verdict(query).reason == "phone_or_id"


@pytest.mark.parametrize("query", [
    "1990年代 流行音乐 特点",
    "2026年10月10日 是什么日子",
    "第3次 工业革命 时间",
])
def test_public_queries_with_short_numbers_stay_allowed(query):
    assert verdict(query).allowed is True


# ---------------------------------------------------------------------------
# Continuous overlap with private text (>= 12 code points)
# ---------------------------------------------------------------------------


def test_twelve_code_point_overlap_with_the_journal_is_blocked():
    fragment = PRIVATE_JOURNAL[9:21]
    assert len(fragment) == 12
    result = verdict("查一下 " + fragment, (PRIVATE_JOURNAL,))
    assert result.allowed is False
    assert result.reason == "source_overlap"


def test_eleven_code_point_overlap_is_not_treated_as_source_text():
    fragment = PRIVATE_JOURNAL[9:20]
    assert len(fragment) == 11
    assert verdict("查一下 " + fragment, (PRIVATE_JOURNAL,)).allowed is True


def test_overlap_is_detected_anywhere_in_the_query():
    fragment = PRIVATE_JOURNAL[4:16]
    result = verdict("我想了解" + fragment + "到底是什么意思", (PRIVATE_JOURNAL,))
    assert result.reason == "source_overlap"


@pytest.mark.parametrize("private_text", [PRIVATE_PROMPT, PRIVATE_QUESTION])
def test_question_and_custom_prompt_are_also_private_text(private_text):
    """The custom prompt and the in-flight question are user text, not search fodder."""
    fragment = private_text[:12]
    assert verdict("了解一下 " + fragment, (private_text,)).reason == "source_overlap"


def test_short_private_text_cannot_overlap_at_all():
    assert verdict("公开主题 关键词", ("很短",)).allowed is True


# ---------------------------------------------------------------------------
# Uncertain private matter is skipped, not guessed
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("query", [
    "我总是失眠怎么办",
    "老公最近压力很大",
    "我女儿的教育问题",
    "我的同事之间的关系",
    "妈妈 高血压 该注意什么",
])
def test_first_person_and_relationship_queries_are_skipped(query):
    assert verdict(query).reason == "private_matter"


@pytest.mark.parametrize("query", [
    "认知失调 定义",
    "睡眠卫生 建议",
    "如何提高专注力 方法",
    "达克效应 是什么",
])
def test_plain_public_topics_stay_allowed(query):
    assert verdict(query).allowed is True


def test_verdict_reason_is_a_short_code_and_never_echoes_the_query():
    query = "我的邮箱是 private.person@example.com"
    result = verdict(query)
    assert result.reason == "email"
    assert query not in result.reason
    assert "@" not in result.reason
    assert len(result.reason) <= 32


# ---------------------------------------------------------------------------
# A blocked (or unconfigured) query must not reach the network
# ---------------------------------------------------------------------------


def test_blocked_query_makes_no_outbound_request(search_key):
    transport = FakeSearchTransport()
    outcome = search.search_web("我总是失眠怎么办", transport=transport)
    assert outcome.status == search.WEB_BLOCKED
    assert outcome.requests == 0
    assert outcome.results == ()
    assert transport.calls == [], "被拦截的查询不允许出站"


def test_private_overlap_makes_no_outbound_request(search_key):
    transport = FakeSearchTransport()
    outcome = search.search_web("帮我查 " + PRIVATE_JOURNAL[9:21],
                                source_texts=(PRIVATE_JOURNAL,), transport=transport)
    assert outcome.status == search.WEB_BLOCKED and transport.calls == []


def test_missing_key_reports_not_configured_without_any_outbound(monkeypatch):
    monkeypatch.delenv(search.SEARCH_KEY_ENV, raising=False)
    transport = FakeSearchTransport()
    outcome = search.search_web("认知失调 定义", transport=transport)
    assert outcome.status == search.WEB_NOT_CONFIGURED
    assert outcome.requests == 0 and transport.calls == []


def test_search_web_rechecks_privacy_itself(search_key):
    """Defence in depth: the executor never trusts the caller's earlier check."""
    transport = FakeSearchTransport()
    outcome = search.search_web("a.b@example.com", transport=transport)
    assert outcome.status == search.WEB_BLOCKED and transport.calls == []
