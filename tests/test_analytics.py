"""Tests for chatcap.analytics — Chat Analytics & Statistics.

Covers all six metrics plus edge cases (empty, malformed, no-likes,
bucket override) using the Example/ fixtures where present, and
self-contained synthetic messages otherwise.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from chatcap.analytics import (
    analyze_file,
    analyze_messages,
    format_bar,
    load_messages,
    to_json_dict,
    to_markdown,
    tokenize_words,
)

ROOT = Path(__file__).resolve().parent.parent
LIVE_EXAMPLE = ROOT / "Example" / "Youtube-Live-Chats.json"
COMMENTS_EXAMPLE = ROOT / "Example" / "Youtube-VOD-Comments.json"


def _msg(
    user="Alice",
    text="hello world",
    dt="2026-11-02T14:00:00",
    uid="UC1",
    mtype="text",
    likes=None,
    offset=None,
    ts=None,
):
    m = {
        "user_id": uid,
        "user_display_name": user,
        "user_handle": f"@{user}",
        "datetime": dt,
        "timestamp": ts or dt[11:19],
        "comment": text,
        "message_type": mtype,
        "message_id": f"{uid}-{hash((user, text, dt))}",
    }
    if likes is not None:
        m["like_count"] = likes
    if offset is not None:
        m["video_offset_ms"] = str(offset)
    return m


# --------------------------------------------------------------------------
# tokenization
# --------------------------------------------------------------------------

class TestTokenize:
    def test_lowercase_and_strip_punct(self):
        words, emojis = tokenize_words("Hello, WORLD!!! kyoko")
        # "world" is a stopword in our list -> dropped; test the survivors
        assert "hello" in words
        assert "kyoko" in words
        assert "world" not in words

    def test_stopwords_and_short_dropped(self):
        words, _ = tokenize_words("is a an to of ok hi lol")
        for w in ("is", "a", "an", "to", "of", "ok", "hi"):
            assert w not in words
        # <3 chars dropped
        assert "ok" not in words
        assert "hi" not in words

    def test_urls_and_mentions_removed(self):
        words, _ = tokenize_words("check https://x.com/foo @someone great stuff")
        assert "https" not in words
        assert "someone" not in words
        assert "check" in words
        assert "stuff" in words

    def test_emoji_separate(self):
        words, emojis = tokenize_words("nice 😂😂 work 🎉")
        assert "nice" in words
        assert len(emojis) >= 1

    def test_empty(self):
        assert tokenize_words("") == ([], [])


# --------------------------------------------------------------------------
# core metrics on synthetic data
# --------------------------------------------------------------------------

def _synthetic(n_users=3, per_user=5):
    base = datetime(2026, 11, 2, 14, 0, 0)
    fruits = ["apple", "banana", "cherry", "mango", "peach"]
    msgs = []
    for u in range(n_users):
        for i in range(per_user):
            dt = (base + timedelta(minutes=i)).isoformat()
            msgs.append(_msg(
                user=f"User{u}",
                text=f"message {i} {fruits[u % len(fruits)]}",
                dt=dt,
                uid=f"UC{u}",
                offset=i * 60000,
            ))
    return msgs


class TestMetrics:
    def test_summary(self):
        a = analyze_messages(_synthetic())
        assert a.summary["total_messages"] == 15
        assert a.summary["unique_users"] == 3
        assert a.summary["skipped_malformed"] == 0

    def test_most_active_users_ranked(self):
        msgs = _synthetic(per_user=5)
        # User0 gets 3 extra messages so it should rank first
        msgs += [_msg(user="User0", text="extra", dt=f"2026-11-02T14:0{i}:00", uid="UC0")
                 for i in range(3)]
        a = analyze_messages(msgs)
        assert a.most_active_users[0]["user"] == "User0"
        assert a.most_active_users[0]["messages"] == 8
        assert a.most_active_users[0]["rank"] == 1

    def test_most_repeated_words(self):
        msgs = [_msg(text="apple apple banana apple"), _msg(text="banana apple")]
        a = analyze_messages(msgs)
        top_word = a.most_repeated_words[0]
        assert top_word["word"] == "apple"
        assert top_word["count"] == 4

    def test_most_repeated_emojis(self):
        msgs = [_msg(text="great 😂😂"), _msg(text="great 😂")]
        a = analyze_messages(msgs)
        assert a.most_repeated_emojis
        assert "😂" in a.most_repeated_emojis[0]["emoji"]

    def test_most_liked_ranks_by_like_count(self):
        msgs = [
            _msg(user="A", text="low", likes=2, mtype="comment"),
            _msg(user="B", text="high", likes=99, mtype="comment"),
            _msg(user="C", text="mid", likes=10, mtype="comment"),
        ]
        a = analyze_messages(msgs, has_likes=True)
        assert a.most_liked_available is True
        assert [m["text"] for m in a.most_liked] == ["high", "mid", "low"]

    def test_most_liked_no_like_data_note(self):
        a = analyze_messages([_msg(text="live chat msg")], has_likes=False)
        assert a.most_liked_available is False
        assert a.most_liked == []
        assert "like_count" in a.most_liked_note.lower()

    def test_timeline_and_peak(self):
        base = datetime(2026, 11, 2, 14, 0, 0)
        msgs = []
        # 3 messages in minute 0, 1 in minute 5
        for i in range(3):
            msgs.append(_msg(text="x", dt=(base + timedelta(seconds=i * 10)).isoformat()))
        msgs.append(_msg(text="y", dt=(base + timedelta(minutes=5)).isoformat()))
        a = analyze_messages(msgs)
        assert a.timeline
        assert a.peak_activity["busiest_count"] == 3
        assert sum(b["count"] for b in a.timeline) == 4

    def test_timeline_bucket_override(self):
        base = datetime(2026, 11, 2, 14, 0, 0)
        msgs = [
            _msg(text="a", dt=base.isoformat()),
            _msg(text="b", dt=(base + timedelta(minutes=10)).isoformat()),
        ]
        a = analyze_messages(msgs, bucket_spec="5m")
        assert a.summary["bucket_seconds"] == 300
        assert len(a.timeline) >= 2

    def test_timeline_empty_buckets_zero_filled(self):
        base = datetime(2026, 11, 2, 14, 0, 0)
        msgs = [
            _msg(text="a", dt=base.isoformat()),
            _msg(text="b", dt=(base + timedelta(minutes=3)).isoformat()),
        ]
        a = analyze_messages(msgs, bucket_spec="1m")
        counts = [b["count"] for b in a.timeline]
        assert 0 in counts  # gap bucket present as zero
        assert sum(counts) == 2

    def test_participation_ranking_composite(self):
        msgs = [
            _msg(user="Prolific", text="word1 word2 word3 word4", likes=50, mtype="comment"),
            _msg(user="Prolific", text="word1 word2 word3 word4", likes=50, mtype="comment"),
            _msg(user="Quiet", text="hi", likes=1, mtype="comment"),
        ]
        a = analyze_messages(msgs, has_likes=True)
        assert a.participation_ranking[0]["user"] == "Prolific"
        assert a.participation_ranking[0]["messages"] == 2
        assert a.participation_ranking[0]["participation_score"] > 0

    def test_top_n_respected(self):
        a = analyze_messages(_synthetic(n_users=5, per_user=2), top=2)
        assert len(a.most_active_users) == 2
        assert len(a.participation_ranking) == 2

    def test_all_message_types_counted(self):
        msgs = [
            _msg(text="hi"),
            _msg(text="paid", mtype="super_chat"),
            _msg(text="joined", mtype="membership"),
        ]
        a = analyze_messages(msgs)
        assert a.summary["message_types"]["super_chat"] == 1
        assert a.summary["message_types"]["membership"] == 1
        assert a.summary["total_messages"] == 3


# --------------------------------------------------------------------------
# loading / edge cases
# --------------------------------------------------------------------------

class TestEdges:
    def test_empty_list(self):
        a = analyze_messages([])
        assert a.summary["total_messages"] == 0
        assert a.most_active_users == []
        assert a.timeline == []
        assert a.peak_activity["busiest_count"] == 0

    def test_load_skips_malformed(self, tmp_path):
        p = tmp_path / "bad.json"
        p.write_text(json.dumps([{"comment": "ok"}, "notadict", 123, None, {"comment": "ok2"}]),
                     encoding="utf-8")
        res = load_messages(p)
        assert res.total_in_file == 5
        assert res.skipped == 3
        assert len(res.messages) == 2

    def test_load_rejects_non_list(self, tmp_path):
        p = tmp_path / "obj.json"
        p.write_text(json.dumps({"a": 1}), encoding="utf-8")
        with pytest.raises(ValueError):
            load_messages(p)

    def test_load_missing_file_raises(self, tmp_path):
        with pytest.raises((FileNotFoundError, OSError)):
            load_messages(tmp_path / "nope.json")

    def test_analyze_file_roundtrip(self, tmp_path):
        p = tmp_path / "in.json"
        msgs = [_msg(user="X", text="hello world")]
        p.write_text(json.dumps(msgs), encoding="utf-8")
        a = analyze_file(p)
        assert a.summary["total_messages"] == 1
        assert a.file_path == str(p)

    def test_missing_fields_tolerated(self):
        a = analyze_messages([{}, {"comment": None}, {"user_display_name": None}])
        assert a.summary["total_messages"] == 3
        assert a.summary["unique_users"] >= 1


# --------------------------------------------------------------------------
# example fixtures (if present)
# --------------------------------------------------------------------------

@pytest.mark.skipif(not LIVE_EXAMPLE.exists(), reason="live example missing")
class TestLiveExample:
    def test_live_example_analyzes(self):
        a = analyze_file(LIVE_EXAMPLE)
        assert a.summary["total_messages"] > 0
        assert a.summary["unique_users"] > 0
        assert a.most_active_users
        # Live chat has no like_count -> graceful note, not fake data
        assert a.most_liked_available is False
        assert "like" in a.most_liked_note.lower()
        # Timeline should exist (datetimes present)
        assert a.timeline
        assert a.peak_activity["busiest_count"] > 0

    def test_live_example_json_dict(self):
        a = analyze_file(LIVE_EXAMPLE)
        d = to_json_dict(a)
        for key in ("summary", "most_active_users", "most_repeated_words",
                    "most_liked", "timeline", "peak_activity",
                    "participation_ranking"):
            assert key in d

    def test_live_example_markdown(self):
        a = analyze_file(LIVE_EXAMPLE)
        md = to_markdown(a)
        assert "# Chat Analytics" in md
        assert "## Most Active Users" in md
        assert "## Peak Chat Activity" in md
        assert "█" in md  # ASCII bar present


@pytest.mark.skipif(not COMMENTS_EXAMPLE.exists(), reason="comments example missing")
class TestCommentsExample:
    def test_comments_example_has_likes(self):
        a = analyze_file(COMMENTS_EXAMPLE)
        assert a.summary["total_messages"] > 0
        assert a.most_liked_available is True
        assert a.most_liked
        # Sorted descending by likes
        counts = [m["like_count"] for m in a.most_liked]
        assert counts == sorted(counts, reverse=True)


# --------------------------------------------------------------------------
# formatting / bar helper
# --------------------------------------------------------------------------

class TestFormat:
    def test_bar_full_and_empty(self):
        assert format_bar(10, 10) == "█" * 30
        assert format_bar(0, 10) == "░" * 30
        assert format_bar(5, 10) == "█" * 15 + "░" * 15

    def test_bar_zero_max(self):
        assert format_bar(1, 0) == ""
