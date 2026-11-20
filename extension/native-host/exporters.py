"""Export helpers used by the browser extension's native host.

Complements ``chatcap.analytics`` (which already covers JSON/Markdown) with
CSV (Excel-friendly) and a self-contained HTML report. No new dependency.
"""
from __future__ import annotations

import csv
import html
import json
from pathlib import Path

from chatcap.analytics import Analysis

CSV_COLUMNS = [
    "datetime", "timestamp", "user_display_name", "user_handle", "user_id",
    "message_type", "comment", "like_count", "is_reply", "parent_id",
    "is_pinned", "author_is_uploader", "purchase_amount", "badges",
    "message_id", "video_offset_ms",
]


def _cell(value):
    if isinstance(value, (list, tuple)):
        return ", ".join(str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return "" if value is None else value


def write_csv(messages: list[dict], path: str | Path) -> Path:
    """Write messages as UTF-8 BOM CSV so Excel opens non-ASCII text correctly."""
    path = Path(path)
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for msg in messages:
            writer.writerow({col: _cell(msg.get(col)) for col in CSV_COLUMNS})
    return path


def write_html(messages: list[dict], analysis: Analysis, path: str | Path, max_rows: int = 1000) -> Path:
    """Write a single self-contained HTML report (inline CSS, no JS/CDN)."""
    path = Path(path)
    esc = lambda value: html.escape(str(value))
    summary = analysis.summary
    L: list[str] = []
    L.append("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">")
    L.append("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">")
    L.append(f"<title>Chatcap report — {esc(analysis.file_path or 'chat')}</title>")
    L.append("""<style>
:root{color-scheme:dark}body{margin:0;background:#0e1117;color:#e6edf3;
font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}
header{padding:24px 32px;background:linear-gradient(120deg,#4c1d95,#1d4ed8)}
h1{margin:0;font-size:22px}h2{margin:28px 0 12px;font-size:17px;color:#a5b4fc}
main{padding:8px 32px 48px;max-width:1200px;margin:auto}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 18px}
.card b{display:block;font-size:22px;color:#7dd3fc}.card span{color:#8b949e;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #30363d;vertical-align:top}
th{color:#8b949e;position:sticky;top:0;background:#0e1117}
.bar{background:#21262d;border-radius:4px;height:12px;min-width:120px}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,#7c3aed,#38bdf8);border-radius:4px}
.scroll{max-height:520px;overflow:auto;border:1px solid #30363d;border-radius:8px}
.super_chat{color:#facc15}.membership{color:#4ade80}.reply{color:#a5b4fc}
small{color:#8b949e}
</style></head><body>""")
    L.append(f"<header><h1>Chatcap — {esc(analysis.file_path or 'chat')}</h1>")
    L.append(f"<small>{esc(summary.get('date_range') or 'no date range')}</small></header><main>")
    L.append("<div class=\"cards\">")
    for label, key in (
        ("Messages", "total_messages"), ("Unique users", "unique_users"),
        ("Duration (s)", "duration_seconds"), ("Avg / min", "avg_messages_per_minute"),
    ):
        L.append(f"<div class=\"card\"><b>{esc(summary.get(key))}</b><span>{label}</span></div>")
    L.append("</div>")

    L.append("<h2>Most active users</h2><table><tr><th>#</th><th>User</th><th>Messages</th><th>Share</th></tr>")
    for row in analysis.most_active_users:
        L.append(f"<tr><td>{row['rank']}</td><td>{esc(row['user'])} <small>{esc(row['handle'])}</small></td>"
                 f"<td>{row['messages']}</td><td>{row['share_pct']}%</td></tr>")
    L.append("</table>")

    if analysis.timeline:
        max_count = max(b["count"] for b in analysis.timeline) or 1
        L.append("<h2>Message frequency</h2><table><tr><th>Bucket</th><th>Start</th><th>Count</th><th></th></tr>")
        for b in analysis.timeline:
            pct = int(100 * b["count"] / max_count)
            L.append(f"<tr><td>{b['bucket']}</td><td>{esc(b['start'])}</td><td>{b['count']}</td>"
                     f"<td><div class=\"bar\"><i style=\"width:{pct}%\"></i></div></td></tr>")
        L.append("</table>")
        if analysis.peak_activity.get("busiest_count"):
            L.append(f"<p><small>Peak: bucket {analysis.peak_activity['busiest_bucket']} at "
                     f"{esc(analysis.peak_activity['busiest_start'])} — "
                     f"<b>{analysis.peak_activity['busiest_count']}</b> messages</small></p>")

    if analysis.most_repeated_words:
        L.append("<h2>Most repeated words</h2><p>" + " ".join(
            f"<span class=\"card\">{esc(r['word'])} · {r['count']}</span>"
            for r in analysis.most_repeated_words
        ) + "</p>")

    L.append(f"<h2>Messages <small>(first {min(len(messages), max_rows)} of {len(messages)})</small></h2>")
    L.append("<div class=\"scroll\"><table><tr><th>Time</th><th>User</th><th>Type</th><th>Message</th></tr>")
    for msg in messages[:max_rows]:
        mtype = str(msg.get("message_type") or "text").lower()
        cls = mtype if mtype in ("super_chat", "membership") else ""
        if msg.get("is_reply"):
            cls = (cls + " reply").strip()
        text = msg.get("comment") or msg.get("message") or ""
        user = msg.get("user_display_name") or msg.get("author") or "?"
        amount = msg.get("purchase_amount")
        extra = f" <small>{esc(amount)}</small>" if amount else ""
        L.append(f"<tr><td><small>{esc(msg.get('timestamp') or msg.get('datetime') or '')}</small></td>"
                 f"<td>{esc(user)}</td><td><small>{esc(mtype)}</small></td>"
                 f"<td class=\"{cls}\">{esc(text)}{extra}</td></tr>")
    L.append("</table></div></main></body></html>")
    path.write_text("\n".join(L), encoding="utf-8")
    return path
