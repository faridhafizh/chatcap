"""Chat Analytics & Statistics — offline analysis of saved chat JSON files.

Reads a chatcap output file (a JSON array of message dicts, as produced by
``chatcap`` in live-chat or ``--comment`` mode) and produces:

- Most Active Users — raw message count per user
- Most Repeated Words — tokenized word/emoji frequency
- Most Liked Comments — by like_count when present (comments only)
- Message Frequency Timeline — bucketed message counts over time
- Peak Chat Activity — busiest bucket(s)
- User Participation Ranking — composite score table

Outputs: Rich terminal tables, JSON (-o/--json), Markdown (--markdown),
all with zero new dependencies.

Usage:
    chatcap analyze my_live_chat.json [--top 10] [--bucket 5m]
                                     [--json out.json] [--markdown report.md]
    python -m chatcap.analytics <file.json> [same flags]

The file format is defined by chatcap's message dicts. Key fields used:

    | field               | live chat examples              | comment examples          |
    |---------------------|---------------------------------|---------------------------|
    | user_display_name   | "@swag_lord_2000"               | "VictorTalking"           |
    | user_id             | "UCtuK2Kk2Ndfg-gZEdUTxjoA"      | "UC3Ru3gHkS4C4MOdLUP7aWnA"|
    | datetime            | "2026-11-02T14:34:36.410265"    | "2025-11-02T08:00:00"     |
    | timestamp           | "3:34:51" (stream elapsed)      | "2025-11-02" (date)       |
    | video_offset_ms     | "12891410"                      | "0"                       |
    | message_type        | text/super_chat/membership      | comment                   |
    | like_count          | (absent)                        | integer                   |
    | comment             | message text                    | comment text              |
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

# A compact English stopword list (~60 words). Words in this set plus words
# shorter than 3 chars are excluded from the word-frequency ranking.
STOPWORDS = frozenset({
    "the", "is", "and", "to", "of", "a", "in", "it", "you", "that", "he",
    "was", "for", "on", "are", "as", "with", "his", "they", "i", "at",
    "be", "this", "have", "from", "or", "one", "had", "by", "word", "but",
    "not", "what", "all", "were", "we", "when", "your", "can", "said",
    "there", "use", "an", "each", "which", "she", "do", "how", "their",
    "will", "up", "other", "about", "out", "many", "then", "them", "these",
    "so", "some", "her", "would", "make", "like", "him", "into", "time",
    "has", "look", "two", "more", "write", "go", "see", "number", "no",
    "way", "could", "people", "my", "than", "first", "water", "been",
    "call", "who", "oil", "its", "now", "find", "long", "down", "day",
    "did", "get", "come", "made", "may", "part", "over", "new", "sound",
    "take", "only", "little", "work", "know", "place", "year", "live",
    "me", "back", "give", "most", "very", "after", "thing", "our", "just",
    "name", "good", "sentence", "man", "think", "say", "great", "where",
    "help", "through", "much", "before", "line", "right", "too", "mean",
    "right", "old", "any", "same", "tell", "boy", "follow", "came", "want",
    "show", "also", "around", "form", "three", "small", "set", "put",
    "end", "does", "another", "well", "large", "must", "big", "even",
    "such", "because", "turn", "here", "why", "ask", "went", "men", "read",
    "need", "land", "different", "home", "us", "move", "try", "kind",
    "hand", "picture", "again", "change", "off", "play", "spell", "air",
    "away", "animal", "house", "point", "page", "letter", "mother", "answer",
    "found", "study", "still", "learn", "should", "world", "high", "every",
    "near", "add", "food", "between", "own", "below", "country", "plant",
    "last", "school", "father", "keep", "tree", "never", "start", "city",
    "earth", "eye", "light", "thought", "head", "under", "story", "saw",
    "left", "few", "while", "along", "might", "close", "something", "seem",
    "next", "hard", "open", "example", "begin", "life", "always", "those",
    "both", "paper", "together", "got", "group", "often", "run",
})

_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_EMOJI_RE = re.compile(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]+", re.UNICODE)
_PUNCT_RE = re.compile(r"[^\w\s]+", re.UNICODE)
_MENTION_RE = re.compile(r"@\w+", re.UNICODE)

# Human-readable parsing of bucket sizes like "5m", "60s", "1h", "1d"
_BUCKET_MAP = {
    "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
    "d": 86400, "day": 86400, "days": 86400,
}

# Buckets shown in the markdown/terminal charts scaled to this width.
_BAR_WIDTH = 30


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

@dataclass
class LoadResult:
    messages: list[dict] = field(default_factory=list)
    skipped: int = 0
    total_in_file: int = 0
    has_likes: bool = False
    is_comment_mode: bool = False


def load_messages(path: str | Path) -> LoadResult:
    """Load a chatcap JSON file defensively.

    Skips malformed entries (non-dicts) and counts them. Never raises on bad
    rows; raises only if the file itself is unreadable / not JSON / not a list.
    """
    text = Path(path).read_text(encoding="utf-8")
    data = json.loads(text)
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected a JSON array of messages, got {type(data).__name__}")

    result = LoadResult(total_in_file=len(data))
    for entry in data:
        if not isinstance(entry, dict):
            result.skipped += 1
            continue
        result.messages.append(entry)
        if "like_count" in entry:
            result.has_likes = True
        if (entry.get("message_type") or "").lower() == "comment":
            result.is_comment_mode = True

    # If every row lacks like_count the flag stays False; a single row with
    # like_count=0 still counts as "has likes" (comments always carry it).
    if result.is_comment_mode:
        result.has_likes = True
    return result


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _user_key(msg: dict) -> tuple[str, str, str]:
    """Return (display_name, handle, user_id) with sensible fallbacks."""
    name = (msg.get("user_display_name") or msg.get("author") or "Unknown").strip() or "Unknown"
    handle = (msg.get("user_handle") or "").strip()
    uid = (msg.get("user_id") or "").strip()
    if not handle and name:
        handle = name if name.startswith("@") else f"@{name.replace(' ', '')}"
    return name, handle, uid


def _message_text(msg: dict) -> str:
    return (msg.get("comment") or msg.get("message") or "").strip()


def _parse_dt(msg: dict) -> datetime | None:
    """Parse datetime (ISO). Returns None on failure."""
    raw = (msg.get("datetime") or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _offset_ms(msg: dict) -> int | None:
    """Parse video_offset_ms. Returns None on failure or negative."""
    raw = msg.get("video_offset_ms")
    if raw is None or str(raw).strip() == "":
        return None
    try:
        ms = int(float(str(raw)))
        return ms if ms >= 0 else None
    except (TypeError, ValueError):
        return None


def _timestamp_label(msg: dict) -> str:
    """Best human label for a message moment (stream time or date)."""
    ts = (msg.get("timestamp") or "").strip()
    if ts:
        return ts
    dt = _parse_dt(msg)
    if dt:
        return dt.isoformat(timespec="seconds")
    return "unknown"


def tokenize_words(text: str) -> tuple[list[str], list[str]]:
    """Split text into (words, emojis) using the planned clean+stopwords rules.

    - Lowercase, strip URLs and @mentions.
    - Split on whitespace; strip punctuation from each token (internal
      hyphens/apostrophes collapsed away).
    - Drop stopwords and tokens shorter than 3 chars.
    - Emojis (incl. ZWJ sequences) are returned separately.
    """
    if not text:
        return [], []
    emojis = _EMOJI_RE.findall(text)
    # Keep multi-char emoji sequences together; simple findall is fine here.
    cleaned = _URL_RE.sub(" ", text)
    cleaned = _MENTION_RE.sub(" ", cleaned)
    # Remove emoji so they don't pollute word tokens.
    cleaned = _EMOJI_RE.sub(" ", cleaned)
    cleaned = _PUNCT_RE.sub(" ", cleaned)
    words = []
    for tok in cleaned.lower().split():
        tok = tok.strip()
        if len(tok) < 3 or tok in STOPWORDS:
            continue
        words.append(tok)
    return words, emojis


def _bar(n: int, max_n: int, width: int = _BAR_WIDTH) -> str:
    if max_n <= 0:
        return ""
    filled = int(round(width * n / max_n))
    return "█" * filled + "░" * (width - filled)


def _parse_bucket(spec: str) -> int:
    """Parse '5m' / '60s' / '1h' / '90' (seconds) into seconds."""
    spec = spec.strip().lower()
    if not spec:
        raise ValueError("empty bucket spec")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([a-z]+)?", spec)
    if not m:
        raise ValueError(f"bad bucket spec: {spec!r} (examples: 60s, 5m, 1h, 1d)")
    num, unit = m.groups()
    if unit is None:
        return int(num)
    if unit not in _BUCKET_MAP:
        raise ValueError(f"bad bucket unit: {unit!r} (use s/m/h/d)")
    return int(float(num) * _BUCKET_MAP[unit])


def _choose_auto_bucket(duration_seconds: float) -> int:
    """Auto granularity: <2h per-minute, 2-8h 5-min, >8h per-hour."""
    if duration_seconds < 2 * 3600:
        return 60
    if duration_seconds < 8 * 3600:
        return 300
    return 3600


# --------------------------------------------------------------------------
# Core analysis — single pass where practical
# --------------------------------------------------------------------------

@dataclass
class UserStats:
    name: str = ""
    handle: str = ""
    user_id: str = ""
    messages: int = 0
    likes_received: int = 0
    chars: int = 0
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    first_label: str = ""
    last_label: str = ""
    types: Counter = field(default_factory=Counter)


@dataclass
class Analysis:
    summary: dict = field(default_factory=dict)
    most_active_users: list[dict] = field(default_factory=list)
    most_repeated_words: list[dict] = field(default_factory=list)
    most_repeated_emojis: list[dict] = field(default_factory=list)
    most_liked: list[dict] = field(default_factory=list)
    most_liked_available: bool = False
    most_liked_note: str = ""
    timeline: list[dict] = field(default_factory=list)
    peak_activity: dict = field(default_factory=dict)
    participation_ranking: list[dict] = field(default_factory=list)
    skipped: int = 0
    total_in_file: int = 0
    file_path: str = ""


def analyze_messages(
    messages: list[dict],
    *,
    top: int = 10,
    bucket_spec: str | None = None,
    skipped: int = 0,
    total_in_file: int | None = None,
    file_path: str = "",
    has_likes: bool = False,
) -> Analysis:
    """Run all six metrics over loaded messages. Pure function (no I/O)."""
    if total_in_file is None:
        total_in_file = len(messages) + skipped
    a = Analysis(skipped=skipped, total_in_file=total_in_file, file_path=file_path)

    n = len(messages)
    type_counter: Counter = Counter()
    word_counter: Counter = Counter()
    emoji_counter: Counter = Counter()
    user_map: dict[tuple[str, str], UserStats] = {}

    # Per-message anchors for timeline fallback
    offsets: list[int] = []
    dts: list[datetime] = []
    dated_flags: list[bool] = []

    for msg in messages:
        mtype = (msg.get("message_type") or "text").lower()
        type_counter[mtype] += 1

        name, handle, uid = _user_key(msg)
        key = (uid or handle or name, name)  # uid is most stable
        stats = user_map.get(key)
        if stats is None:
            stats = UserStats(name=name, handle=handle, user_id=uid)
            user_map[key] = stats
        stats.messages += 1
        stats.types[mtype] += 1
        try:
            stats.likes_received += int(msg.get("like_count") or 0)
        except (TypeError, ValueError):
            pass

        text = _message_text(msg)
        stats.chars += len(text)

        words, emojis = tokenize_words(text)
        word_counter.update(words)
        emoji_counter.update(emojis)

        dt = _parse_dt(msg)
        off = _offset_ms(msg)
        dated = dt is not None
        dated_flags.append(dated)
        if dt is not None:
            dts.append(dt)
            if stats.first_seen is None or dt < stats.first_seen:
                stats.first_seen = dt
                stats.first_label = _timestamp_label(msg)
            if stats.last_seen is None or dt > stats.last_seen:
                stats.last_seen = dt
                stats.last_label = _timestamp_label(msg)
        if off is not None:
            offsets.append(off)

    # ---- summary -------------------------------------------------------
    date_range = ""
    duration_seconds = None
    if dts:
        dmin, dmax = min(dts), max(dts)
        duration_seconds = (dmax - dmin).total_seconds()
        date_range = f"{dmin.isoformat(timespec='seconds')} → {dmax.isoformat(timespec='seconds')}"
    elif offsets:
        duration_seconds = max(offsets) / 1000.0 if offsets else 0
        date_range = "n/a (offset only)"
    avg_per_min = None
    if duration_seconds and duration_seconds > 0:
        avg_per_min = round(n / (duration_seconds / 60), 2)

    a.summary = {
        "total_messages": n,
        "total_in_file": total_in_file,
        "skipped_malformed": skipped,
        "unique_users": len(user_map),
        "message_types": dict(type_counter),
        "date_range": date_range,
        "duration_seconds": round(duration_seconds, 1) if duration_seconds is not None else None,
        "avg_messages_per_minute": avg_per_min,
        "has_likes": has_likes,
    }

    # ---- 1. Most Active Users ------------------------------------------
    users_sorted = sorted(user_map.values(), key=lambda u: (-u.messages, u.name.lower()))
    a.most_active_users = [
        {
            "rank": i + 1,
            "user": u.name,
            "handle": u.handle,
            "user_id": u.user_id,
            "messages": u.messages,
            "share_pct": round(100 * u.messages / n, 2) if n else 0.0,
            "message_types": dict(u.types),
        }
        for i, u in enumerate(users_sorted[:top])
    ]

    # ---- 2. Most Repeated Words (+ emojis separately) -------------------
    a.most_repeated_words = [
        {"rank": i + 1, "word": w, "count": c}
        for i, (w, c) in enumerate(word_counter.most_common(top))
    ]
    a.most_repeated_emojis = [
        {"rank": i + 1, "emoji": e, "count": c}
        for i, (e, c) in enumerate(emoji_counter.most_common(top))
    ]

    # ---- 3. Most Liked Comments -----------------------------------------
    a.most_liked_available = has_likes
    if has_likes:
        liked = []
        for msg in messages:
            try:
                lc = int(msg.get("like_count") or 0)
            except (TypeError, ValueError):
                lc = 0
            if lc > 0:
                name, handle, _uid = _user_key(msg)
                liked.append({
                    "like_count": lc,
                    "user": name,
                    "handle": handle,
                    "timestamp": _timestamp_label(msg),
                    "text": _message_text(msg)[:120],
                    "message_type": (msg.get("message_type") or "text").lower(),
                })
        liked.sort(key=lambda x: (-x["like_count"], x["user"].lower()))
        a.most_liked = liked[:top]
        if not liked:
            a.most_liked_note = "Has like_count field but no positive likes found."
        elif len(liked) <= top:
            a.most_liked_note = ""
        else:
            a.most_liked_note = f"Top {top} of {len(liked)} liked messages."
    else:
        a.most_liked = []
        a.most_liked_note = (
            "No like_count data in this file (live chat messages don't carry likes; "
            "use a --comment file for this metric)."
        )

    # ---- 4. Message Frequency Timeline + 5. Peak Activity ----------------
    bucket_seconds = None
    timeline: list[dict] = []
    timeline_kind = "none"
    timeline_note = ""

    if bucket_spec is not None:
        try:
            bucket_seconds = _parse_bucket(bucket_spec)
        except ValueError as e:
            timeline_note = f"Invalid --bucket spec ({e}); auto granularity used instead."
            bucket_seconds = None

    if dts:
        anchor = min(dts)
        if bucket_seconds is None:
            dur = (max(dts) - min(dts)).total_seconds()
            bucket_seconds = _choose_auto_bucket(dur)
        # Bucket relative to anchor; include empty buckets as zeros.
        span = (max(dts) - min(dts)).total_seconds()
        n_buckets = int(span // bucket_seconds) + 1 if span > 0 else 1
        counts = Counter()
        for dt in dts:
            idx = int((dt - anchor).total_seconds() // bucket_seconds)
            counts[idx] += 1
        # Label: first message in bucket — use datetime iso for that bucket.
        timeline_kind = "datetime"
        for i in range(n_buckets):
            start_dt = anchor + timedelta(seconds=i * bucket_seconds)
            timeline.append({
                "bucket": i,
                "start": start_dt.isoformat(timespec="seconds"),
                "count": counts.get(i, 0),
            })
        if not dated_flags or all(dated_flags):
            timeline_note = timeline_note or (
                f"Bucketed by datetime into {bucket_seconds}s intervals "
                f"(auto: per-minute <2h, 5-min 2–8h, hourly >8h; override with --bucket)."
            )
        else:
            timeline_note = timeline_note or (
                f"Partial datetimes ({sum(dated_flags)}/{len(dated_flags)} parsed); "
                "buckets cover dated messages only."
            )
    elif offsets:
        # No datetimes but stream offsets (replay/live without datetime).
        anchor_ms = min(offsets)
        if bucket_seconds is None:
            dur_s = (max(offsets) - anchor_ms) / 1000.0
            bucket_seconds = _choose_auto_bucket(dur_s)
        bucket_ms = int(bucket_seconds * 1000)
        counts = Counter()
        for off in offsets:
            idx = (off - anchor_ms) // bucket_ms
            counts[idx] += 1
        n_buckets = (max(offsets) - anchor_ms) // bucket_ms + 1 if offsets else 1
        timeline_kind = "offset"
        for i in range(int(n_buckets)):
            timeline.append({
                "bucket": i,
                "start": f"offset {anchor_ms + i * bucket_ms}ms",
                "count": counts.get(i, 0),
            })
        timeline_note = timeline_note or (
            f"No parseable datetimes; bucketed by video_offset_ms into {bucket_seconds}s intervals."
        )
    else:
        timeline_note = timeline_note or "No timeline data (no parseable datetime or offset)."
    if bucket_spec is not None and bucket_seconds is not None and not timeline_note:
        timeline_note = f"Bucketed by {timeline_kind} into {bucket_seconds}s intervals (--bucket {bucket_spec})."

    a.timeline = timeline
    a.summary["timeline_kind"] = timeline_kind
    a.summary["bucket_seconds"] = bucket_seconds
    if timeline_note:
        a.summary["timeline_note"] = timeline_note

    if timeline:
        busy = sorted(timeline, key=lambda b: (-b["count"], b["bucket"]))
        peak = busy[0]
        a.peak_activity = {
            "busiest_bucket": peak["bucket"],
            "busiest_start": peak["start"],
            "busiest_count": peak["count"],
            "top_peaks": [
                {"bucket": b["bucket"], "start": b["start"], "count": b["count"]}
                for b in busy[:3]
            ],
            "bucket_seconds": bucket_seconds,
            "timeline_kind": timeline_kind,
        }
    else:
        a.peak_activity = {"busiest_count": 0, "top_peaks": [], "note": timeline_note}

    # ---- 6. User Participation Ranking (composite) ------------------------
    # Composite = messages (50%) + share% scaled + likes bonus + avg-length bonus.
    # Kept transparent: each component is reported so the ranking is auditable.
    total_likes = sum(u.likes_received for u in user_map.values()) or 0
    max_msgs = max((u.messages for u in user_map.values()), default=0) or 1
    max_likes = max((u.likes_received for u in user_map.values()), default=0) or 1
    max_avg_len = max(
        ((u.chars / u.messages) if u.messages else 0 for u in user_map.values()),
        default=0,
    ) or 1

    def _score(u: UserStats) -> float:
        msg_score = 50.0 * (u.messages / max_msgs)
        share_score = 0.0  # share is already proportional to messages; keep 10 for scale
        share_score = 10.0 * (u.messages / max_msgs)
        like_score = 25.0 * (u.likes_received / max_likes) if u.likes_received else 0.0
        avg_len = (u.chars / u.messages) if u.messages else 0
        len_score = 15.0 * (avg_len / max_avg_len) if avg_len else 0.0
        return msg_score + share_score + like_score + len_score

    ranked = sorted(user_map.values(), key=lambda u: (-_score(u), -u.messages, u.name.lower()))
    a.participation_ranking = [
        {
            "rank": i + 1,
            "user": u.name,
            "handle": u.handle,
            "messages": u.messages,
            "share_pct": round(100 * u.messages / n, 2) if n else 0.0,
            "likes_received": u.likes_received,
            "avg_msg_length": round(u.chars / u.messages, 1) if u.messages else 0,
            "first_active": u.first_label,
            "last_active": u.last_label,
            "participation_score": round(_score(u), 2),
        }
        for i, u in enumerate(ranked[:top])
    ]

    return a


def analyze_file(
    path: str | Path,
    *,
    top: int = 10,
    bucket_spec: str | None = None,
) -> Analysis:
    res = load_messages(path)
    return analyze_messages(
        res.messages,
        top=top,
        bucket_spec=bucket_spec,
        skipped=res.skipped,
        total_in_file=res.total_in_file,
        file_path=str(path),
        has_likes=res.has_likes,
    )


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

def _ascii_table(headers: list[str], rows: list[list[str]], widths: list[int] | None = None) -> str:
    """Fallback plain-text table (used if Rich is unavailable)."""
    if not rows:
        return "  (none)"
    cols = len(headers)
    widths = widths or [max(len(headers[i]), max(len(str(r[i])) for r in rows)) for i in range(cols)]
    def fmt(row):
        return "  " + " | ".join(str(c).ljust(widths[i]) for i, c in enumerate(row))
    lines = [fmt(headers), "  " + "-+-".join("-" * w for w in widths)]
    for r in rows:
        lines.append(fmt([str(c) for c in r]))
    return "\n".join(lines)


def print_tables(a: Analysis, top: int = 10) -> None:
    """Print Rich tables (falls back to plain text if Rich missing)."""
    try:
        from rich.console import Console
        from rich.table import Table
        console = Console()
        use_rich = True
    except Exception:
        use_rich = False

    def table(title: str, headers: list[str]) -> Table:
        t = Table(title=title, show_header=True)
        for h in headers:
            t.add_column(h)
        return t

    s = a.summary
    print("=" * 60)
    print(f"CHAT ANALYTICS — {a.file_path or 'messages'}")
    print("=" * 60)
    print(f"Messages: {s.get('total_messages')} (skipped {s.get('skipped_malformed')})"
          f" · Users: {s.get('unique_users')}"
          f" · Types: {s.get('message_types')}")
    print(f"Range: {s.get('date_range')}"
          f" · Duration: {s.get('duration_seconds')}s"
          f" · Avg/min: {s.get('avg_messages_per_minute')}")
    if s.get("timeline_note"):
        print(f"Timeline: {s['timeline_note']}")
    print()

    max_active = max((r["messages"] for r in a.most_active_users), default=0)
    if use_rich:
        t = table("Most Active Users", ["#", "User", "Msgs", "Share", "Bar"])
        for r in a.most_active_users:
            t.add_row(str(r["rank"]), f"{r['user']} ({r['handle']})",
                      str(r["messages"]), f"{r['share_pct']}%",
                      _bar(r["messages"], max_active))
        console.print(t)
        print()

        max_w = max((r["count"] for r in a.most_repeated_words), default=0)
        t = table("Most Repeated Words", ["#", "Word", "Count", "Bar"])
        for r in a.most_repeated_words:
            t.add_row(str(r["rank"]), r["word"], str(r["count"]), _bar(r["count"], max_w))
        if a.most_repeated_emojis:
            t2 = table("Most Repeated Emojis", ["#", "Emoji", "Count"])
            for r in a.most_repeated_emojis:
                t2.add_row(str(r["rank"]), r["emoji"], str(r["count"]))
            console.print(t2)
            print()
        console.print(t)
        print()

        t = table("Most Liked Comments", ["#", "User", "Likes", "Text"])
        if a.most_liked_available and a.most_liked:
            for i, r in enumerate(a.most_liked, 1):
                t.add_row(str(i), r["user"], str(r["like_count"]), r["text"][:60])
        elif a.most_liked_available:
            t.add_row("-", "-", "-", "(no positive likes)")
        else:
            t.add_row("-", "-", "-", a.most_liked_note)
        console.print(t)
        print()

        t = table(f"Message Frequency Timeline ({s.get('bucket_seconds')}s buckets)", ["Bucket", "Start", "Count", "Bar"])
        max_t = max((b["count"] for b in a.timeline), default=0)
        for b in a.timeline:
            t.add_row(str(b["bucket"]), str(b["start"]), str(b["count"]), _bar(b["count"], max_t))
        console.print(t)
        print()

        if a.peak_activity.get("busiest_count"):
            print(f"Peak activity: bucket {a.peak_activity['busiest_bucket']} "
                  f"at {a.peak_activity['busiest_start']} — "
                  f"{a.peak_activity['busiest_count']} messages")
            print()

        max_sc = max((r["participation_score"] for r in a.participation_ranking), default=0)
        t = table("User Participation Ranking", ["#", "User", "Msgs", "Share%", "Likes", "AvgLen", "Score", "Bar"])
        for r in a.participation_ranking:
            t.add_row(str(r["rank"]), r["user"], str(r["messages"]), str(r["share_pct"]),
                      str(r["likes_received"]), str(r["avg_msg_length"]),
                      str(r["participation_score"]), _bar(int(r["participation_score"] * 100), int(max_sc * 100)))
        console.print(t)
    else:
        print(_ascii_table(
            ["#", "User", "Msgs", "Share%"],
            [[r["rank"], f"{r['user']} ({r['handle']})", r["messages"], r["share_pct"]]
             for r in a.most_active_users],
        ))
        print()
        print(_ascii_table(
            ["#", "Word", "Count"],
            [[r["rank"], r["word"], r["count"]] for r in a.most_repeated_words],
        ))


def to_json_dict(a: Analysis) -> dict:
    return {
        "file": a.file_path,
        "summary": a.summary,
        "most_active_users": a.most_active_users,
        "most_repeated_words": a.most_repeated_words,
        "most_repeated_emojis": a.most_repeated_emojis,
        "most_liked": {
            "available": a.most_liked_available,
            "note": a.most_liked_note,
            "items": a.most_liked,
        },
        "timeline": a.timeline,
        "peak_activity": a.peak_activity,
        "participation_ranking": a.participation_ranking,
    }


def to_markdown(a: Analysis) -> str:
    L: list[str] = []
    s = a.summary
    L.append(f"# Chat Analytics — `{a.file_path}`")
    L.append("")
    L.append(f"- **Total messages:** {s.get('total_messages')} "
             f"(skipped malformed: {s.get('skipped_malformed')})")
    L.append(f"- **Unique users:** {s.get('unique_users')}")
    L.append(f"- **Message types:** {s.get('message_types')}")
    L.append(f"- **Range:** {s.get('date_range')}")
    L.append(f"- **Duration:** {s.get('duration_seconds')}s")
    L.append(f"- **Avg/min:** {s.get('avg_messages_per_minute')}")
    if s.get("timeline_note"):
        L.append(f"- **Timeline:** {s['timeline_note']}")
    L.append("")

    L.append("## Most Active Users")
    L.append("")
    L.append("| # | User | Msgs | Share |")
    L.append("|---|------|------|-------|")
    for r in a.most_active_users:
        L.append(f"| {r['rank']} | {r['user']} ({r['handle']}) | {r['messages']} | {r['share_pct']}% |")
    L.append("")

    L.append("## Most Repeated Words")
    L.append("")
    max_w = max((r["count"] for r in a.most_repeated_words), default=0)
    L.append("| # | Word | Count |")
    L.append("|---|------|-------|")
    for r in a.most_repeated_words:
        L.append(f"| {r['rank']} | {r['word']} | {r['count']} |")
    L.append("")
    if a.most_repeated_words:
        L.append("```")
        for r in a.most_repeated_words:
            L.append(f"{r['word']:<20} {r['count']:>5}  {_bar(r['count'], max_w)}")
        L.append("```")
        L.append("")

    if a.most_repeated_emojis:
        L.append("## Most Repeated Emojis")
        L.append("")
        L.append("| # | Emoji | Count |")
        L.append("|---|-------|-------|")
        for r in a.most_repeated_emojis:
            L.append(f"| {r['rank']} | {r['emoji']} | {r['count']} |")
        L.append("")

    L.append("## Most Liked Comments")
    L.append("")
    if a.most_liked_available and a.most_liked:
        if a.most_liked_note:
            L.append(f"_{a.most_liked_note}_")
            L.append("")
        L.append("| # | User | Likes | Text |")
        L.append("|---|------|-------|------|")
        for i, r in enumerate(a.most_liked, 1):
            safe = r["text"].replace("|", "\\|")
            L.append(f"| {i} | {r['user']} | {r['like_count']} | {safe} |")
    else:
        L.append(a.most_liked_note or "No liked messages.")
    L.append("")

    L.append(f"## Message Frequency Timeline ({s.get('bucket_seconds')}s buckets)")
    L.append("")
    L.append("| Bucket | Start | Count |")
    L.append("|--------|-------|-------|")
    for b in a.timeline:
        L.append(f"| {b['bucket']} | {b['start']} | {b['count']} |")
    L.append("")
    if a.timeline:
        max_t = max((b["count"] for b in a.timeline), default=0)
        L.append("```")
        for b in a.timeline:
            L.append(f"{b['bucket']:>3} {str(b['start'])[:25]:<25} {b['count']:>5}  {_bar(b['count'], max_t)}")
        L.append("```")
        L.append("")

    L.append("## Peak Chat Activity")
    L.append("")
    if a.peak_activity.get("busiest_count"):
        L.append(f"Busiest bucket **#{a.peak_activity['busiest_bucket']}** "
                 f"at `{a.peak_activity['busiest_start']}` with "
                 f"**{a.peak_activity['busiest_count']}** messages.")
        L.append("")
        L.append("| # | Bucket | Start | Count |")
        L.append("|---|--------|-------|-------|")
        for i, p in enumerate(a.peak_activity["top_peaks"], 1):
            L.append(f"| {i} | {p['bucket']} | {p['start']} | {p['count']} |")
    else:
        L.append(a.peak_activity.get("note", "No peak data."))
    L.append("")

    L.append("## User Participation Ranking")
    L.append("")
    L.append("| # | User | Msgs | Share% | Likes | AvgLen | Score |")
    L.append("|---|------|------|--------|-------|--------|-------|")
    for r in a.participation_ranking:
        L.append(f"| {r['rank']} | {r['user']} | {r['messages']} | {r['share_pct']} "
                 f"| {r['likes_received']} | {r['avg_msg_length']} | {r['participation_score']} |")
    L.append("")
    return "\n".join(L)


def write_json(a: Analysis, out: str | Path) -> None:
    Path(out).write_text(json.dumps(to_json_dict(a), indent=2, ensure_ascii=False), encoding="utf-8")


def write_markdown(a: Analysis, out: str | Path) -> None:
    Path(out).write_text(to_markdown(a), encoding="utf-8")


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def format_bar(n: int, max_n: int, width: int = _BAR_WIDTH) -> str:
    """Public wrapper for chart helpers."""
    return _bar(n, max_n, width)


def analyze_main(argv: list[str] | None = None) -> int:
    """Entry point for ``chatcap analyze`` / ``python -m chatcap.analytics``."""
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(
        prog="chatcap analyze",
        description="Analyze a saved chatcap JSON file (most active users, "
                    "word frequency, most liked, timeline, peak activity, "
                    "participation ranking).",
    )
    parser.add_argument("file", help="Path to saved chat JSON (e.g. my_live_chat.json)")
    parser.add_argument("--top", type=int, default=10,
                        help="Top-N for ranked lists (default: 10)")
    parser.add_argument("--bucket", default=None,
                        help="Timeline bucket size: 60s, 5m, 1h, 1d "
                             "(default: auto — per-minute <2h, 5-min 2–8h, hourly >8h)")
    parser.add_argument("-o", "--json", dest="json_out", default=None,
                        help="Also write machine-readable JSON to this path")
    parser.add_argument("--markdown", dest="md_out", default=None,
                        help="Also write a Markdown report with ASCII charts to this path")
    parser.add_argument("--no-tables", action="store_true",
                        help="Suppress terminal tables (useful when writing files)")
    args = parser.parse_args(argv)

    try:
        a = analyze_file(args.file, top=args.top, bucket_spec=args.bucket)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"error: cannot analyze {args.file}: {e}", file=sys.stderr)
        return 2

    if args.json_out:
        try:
            write_json(a, args.json_out)
        except OSError as e:
            print(f"error: cannot write JSON {args.json_out}: {e}", file=sys.stderr)
            return 2
    if args.md_out:
        try:
            write_markdown(a, args.md_out)
        except OSError as e:
            print(f"error: cannot write Markdown {args.md_out}: {e}", file=sys.stderr)
            return 2

    if not args.no_tables:
        print_tables(a, top=args.top)
    return 0


if __name__ == "__main__":
    raise SystemExit(analyze_main())
