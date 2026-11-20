// Port of chatcap.analytics writers + native-host/exporters.py.
// All outputs are plain strings; the caller decides how to download them.

import { bar } from "./analytics.js";

export const CSV_COLUMNS = [
  "datetime", "timestamp", "user_display_name", "user_handle", "user_id",
  "message_type", "comment", "like_count", "is_reply", "parent_id",
  "is_pinned", "author_is_uploader", "purchase_amount", "badges",
  "message_id", "video_offset_ms",
];

const escHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[ch]));

function cell(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value == null ? "" : value;
}

function csvField(value) {
  const s = String(cell(value));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(messages) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const msg of messages) {
    lines.push(CSV_COLUMNS.map((col) => csvField(msg[col])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function toJson(a) {
  return {
    file: a.file,
    summary: a.summary,
    most_active_users: a.mostActiveUsers,
    most_repeated_words: a.mostRepeatedWords,
    most_repeated_emojis: a.mostRepeatedEmojis,
    most_liked: { available: a.mostLikedAvailable, note: a.mostLikedNote, items: a.mostLiked },
    timeline: a.timeline,
    peak_activity: a.peakActivity,
    participation_ranking: a.participationRanking,
  };
}

export function toMarkdown(a) {
  const s = a.summary;
  const L = [
    `# Chat Analytics — \`${a.file}\``, "",
    `- **Total messages:** ${s.total_messages} (skipped malformed: ${s.skipped_malformed})`,
    `- **Unique users:** ${s.unique_users}`,
    `- **Message types:** ${JSON.stringify(s.message_types)}`,
    `- **Range:** ${s.date_range}`,
    `- **Duration:** ${s.duration_seconds}s`,
    `- **Avg/min:** ${s.avg_messages_per_minute}`,
    "", "## Most Active Users", "",
    "| # | User | Msgs | Share |", "|---|------|------|-------|",
    ...a.mostActiveUsers.map((r) => `| ${r.rank} | ${r.user} (${r.handle}) | ${r.messages} | ${r.share_pct}% |`),
    "", "## Most Repeated Words", "",
    "| # | Word | Count |", "|---|------|-------|",
    ...a.mostRepeatedWords.map((r) => `| ${r.rank} | ${r.word} | ${r.count} |`),
  ];
  const maxW = Math.max(0, ...a.mostRepeatedWords.map((r) => r.count));
  if (a.mostRepeatedWords.length) {
    L.push("", "```", ...a.mostRepeatedWords.map((r) => `${r.word.padEnd(20)} ${String(r.count).padStart(5)}  ${bar(r.count, maxW)}`), "```");
  }
  if (a.mostRepeatedEmojis.length) {
    L.push("", "## Most Repeated Emojis", "", "| # | Emoji | Count |", "|---|-------|-------|",
      ...a.mostRepeatedEmojis.map((r) => `| ${r.rank} | ${r.emoji} | ${r.count} |`));
  }
  L.push("", "## Most Liked Comments", "");
  if (a.mostLikedAvailable && a.mostLiked.length) {
    L.push("| # | User | Likes | Text |", "|---|------|-------|------|",
      ...a.mostLiked.map((r, i) => `| ${i + 1} | ${r.user} | ${r.like_count} | ${r.text.replace(/\|/g, "\\|")} |`));
  } else {
    L.push(a.mostLikedNote || "No liked messages.");
  }
  L.push("", `## Message Frequency Timeline (${s.bucket_seconds}s buckets)`, "",
    "| Bucket | Start | Count |", "|--------|-------|-------|",
    ...a.timeline.map((b) => `| ${b.bucket} | ${b.start} | ${b.count} |`));
  if (a.timeline.length) {
    const maxT = Math.max(...a.timeline.map((b) => b.count));
    L.push("", "```", ...a.timeline.map((b) => `${String(b.bucket).padStart(3)} ${String(b.start).slice(0, 25).padEnd(25)} ${String(b.count).padStart(5)}  ${bar(b.count, maxT)}`), "```");
  }
  L.push("", "## Peak Chat Activity", "");
  if (a.peakActivity.busiest_count) {
    L.push(`Busiest bucket **#${a.peakActivity.busiest_bucket}** at \`${a.peakActivity.busiest_start}\` with **${a.peakActivity.busiest_count}** messages.`,
      "", "| # | Bucket | Start | Count |", "|---|--------|-------|-------|",
      ...a.peakActivity.top_peaks.map((p, i) => `| ${i + 1} | ${p.bucket} | ${p.start} | ${p.count} |`));
  } else {
    L.push(a.peakActivity.note || "No peak data.");
  }
  L.push("", "## User Participation Ranking", "",
    "| # | User | Msgs | Share% | Likes | AvgLen | Score |", "|---|------|------|--------|-------|--------|-------|",
    ...a.participationRanking.map((r) => `| ${r.rank} | ${r.user} | ${r.messages} | ${r.share_pct} | ${r.likes_received} | ${r.avg_msg_length} | ${r.participation_score} |`),
    "");
  return L.join("\n");
}

export function toHtml(messages, a, maxRows = 1000) {
  const s = a.summary;
  const L = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>Chatcap report — ${escHtml(a.file)}</title>`,
    `<style>
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
small{color:#8b949e}</style></head><body>`,
    `<header><h1>Chatcap — ${escHtml(a.file)}</h1><small>${escHtml(s.date_range || "no date range")}</small></header><main>`,
    '<div class="cards">',
    ...[["Messages", s.total_messages], ["Unique users", s.unique_users], ["Duration (s)", s.duration_seconds], ["Avg / min", s.avg_messages_per_minute]]
      .map(([label, value]) => `<div class="card"><b>${escHtml(value)}</b><span>${label}</span></div>`),
    "</div>",
    "<h2>Most active users</h2><table><tr><th>#</th><th>User</th><th>Messages</th><th>Share</th></tr>",
    ...a.mostActiveUsers.map((r) => `<tr><td>${r.rank}</td><td>${escHtml(r.user)} <small>${escHtml(r.handle)}</small></td><td>${r.messages}</td><td>${r.share_pct}%</td></tr>`),
    "</table>",
  ];
  if (a.timeline.length) {
    const max = Math.max(...a.timeline.map((b) => b.count)) || 1;
    L.push("<h2>Message frequency</h2><table><tr><th>Bucket</th><th>Start</th><th>Count</th><th></th></tr>",
      ...a.timeline.map((b) => `<tr><td>${b.bucket}</td><td>${escHtml(b.start)}</td><td>${b.count}</td><td><div class="bar"><i style="width:${Math.round(100 * b.count / max)}%"></i></div></td></tr>`),
      "</table>");
    if (a.peakActivity.busiest_count) {
      L.push(`<p><small>Peak: bucket ${a.peakActivity.busiest_bucket} at ${escHtml(a.peakActivity.busiest_start)} — <b>${a.peakActivity.busiest_count}</b> messages</small></p>`);
    }
  }
  if (a.mostRepeatedWords.length) {
    L.push("<h2>Most repeated words</h2><p>",
      ...a.mostRepeatedWords.map((r) => `<span class="card">${escHtml(r.word)} · ${r.count}</span>`), "</p>");
  }
  L.push(`<h2>Messages <small>(first ${Math.min(messages.length, maxRows)} of ${messages.length})</small></h2>`,
    '<div class="scroll"><table><tr><th>Time</th><th>User</th><th>Type</th><th>Message</th></tr>');
  for (const msg of messages.slice(0, maxRows)) {
    const type = String(msg.message_type || "text").toLowerCase();
    const cls = ["super_chat", "membership"].includes(type) ? type : msg.is_reply ? "reply" : "";
    L.push(`<tr><td><small>${escHtml(msg.timestamp || msg.datetime || "")}</small></td>` +
      `<td>${escHtml(msg.user_display_name || msg.author || "?")}</td><td><small>${escHtml(type)}</small></td>` +
      `<td class="${cls}">${escHtml(msg.comment || msg.message || "")}${msg.purchase_amount ? ` <small>${escHtml(msg.purchase_amount)}</small>` : ""}</td></tr>`);
  }
  L.push("</table></div></main></body></html>");
  return L.join("\n");
}
