// Port of chatcap/analytics.py — pure functions, no browser APIs.
// Same six metrics and identical field names as the CLI.

export const STOPWORDS = new Set(`
the is and to of a in it you that he was for on are as with his they i at be this have from or one had by
word but not what all were we when your can said there use an each which she do how their will up other about
out many then them these so some her would make like him into time has look two more write go see number no way
could people my than first water been call who oil its now find long down day did get come made may part over new
sound take only little work know place year live me back give most very after thing our just name good sentence
man think say great where help through much before line right too mean old any same tell boy follow came want show
also around form three small set put end does another well large must big even such because turn here why ask went
men read need land different home us move try kind hand picture again change off play spell air away animal house
point page letter mother answer found study still learn should world high every near add food between own below
country plant last school father keep tree never start city earth eye light thought head under story saw left few
while along might close something seem next hard open example begin life always those both paper together got group
often run
yang dengan untuk ini itu dan di ke dari ada atau juga saya kamu dia mereka kita akan sudah tidak bukan sangat bisa
para dalam pada saat karena jadi kalau ketika setelah sebelum masih saja saja hanya karena sehingga maka serta
 ` .trim().split(/\s+/));

const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const MENTION_RE = /@[\p{L}\p{N}_]+/gu;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F]+/gu;
const PUNCT_RE = /[^\p{L}\p{N}\s]+/gu;

const BUCKET_MAP = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
};

export function tokenizeWords(text) {
  if (!text) return [[], []];
  const emojis = text.match(EMOJI_RE) || [];
  const cleaned = String(text)
    .replace(URL_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(EMOJI_RE, " ")
    .replace(PUNCT_RE, " ");
  const words = [];
  for (const token of cleaned.toLowerCase().split(/\s+/)) {
    const t = token.trim();
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    words.push(t);
  }
  return [words, emojis];
}

export function parseBucket(spec) {
  const s = String(spec || "").trim().toLowerCase();
  if (!s) throw new Error("empty bucket spec");
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)?$/.exec(s);
  if (!m) throw new Error(`bad bucket spec: ${spec}`);
  if (!m[2]) return Number.parseInt(m[1], 10);
  if (!(m[2] in BUCKET_MAP)) throw new Error(`bad bucket unit: ${m[2]}`);
  return Math.trunc(Number.parseFloat(m[1]) * BUCKET_MAP[m[2]]);
}

export function chooseAutoBucket(seconds) {
  if (seconds < 2 * 3600) return 60;
  if (seconds < 8 * 3600) return 300;
  return 3600;
}

export function bar(n, max, width = 30) {
  if (max <= 0) return "";
  const filled = Math.round(width * n / max);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

const textOf = (msg) => String(msg.comment || msg.message || "").trim();

function userKey(msg) {
  const name = String(msg.user_display_name || msg.author || "Unknown").trim() || "Unknown";
  let handle = String(msg.user_handle || "").trim();
  const uid = String(msg.user_id || "").trim();
  if (!handle) handle = name.startsWith("@") ? name : `@${name.replace(/\s/g, "")}`;
  return { name, handle, uid };
}

function parseDt(msg) {
  const raw = String(msg.datetime || "").trim();
  if (!raw) return null;
  const ms = Date.parse(raw.replace("Z", "+00:00"));
  return Number.isNaN(ms) ? null : new Date(ms);
}

function offsetMs(msg) {
  const raw = msg.video_offset_ms;
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function timestampLabel(msg) {
  return String(msg.timestamp || "").trim()
    || (parseDt(msg)?.toISOString().slice(0, 19) || "unknown");
}

export function analyzeMessages(messages, { top = 10, bucketSpec = null, hasLikes = false } = {}) {
  const a = {
    summary: {}, mostActiveUsers: [], mostRepeatedWords: [], mostRepeatedEmojis: [],
    mostLiked: [], mostLikedAvailable: !!hasLikes, mostLikedNote: "",
    timeline: [], peakActivity: {}, participationRanking: [],
    skipped: 0, totalInFile: messages.length, file: "",
  };
  const n = messages.length;
  const types = new Map();
  const words = new Map();
  const emojis = new Map();
  const users = new Map();
  const dts = [];
  const offsets = [];
  let datedFlags = 0;

  const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

  for (const msg of messages) {
    const mtype = String(msg.message_type || "text").toLowerCase();
    bump(types, mtype);
    const { name, handle, uid } = userKey(msg);
    const key = `${uid || handle || name}\u0000${name}`;
    let stats = users.get(key);
    if (!stats) {
      stats = { name, handle, uid, messages: 0, likes: 0, chars: 0, first: null, last: null,
        firstLabel: "", lastLabel: "", types: new Map() };
      users.set(key, stats);
    }
    stats.messages++;
    bump(stats.types, mtype);
    stats.likes += Number.parseInt(msg.like_count || 0, 10) || 0;
    const text = textOf(msg);
    stats.chars += text.length;
    const [tokens, emo] = tokenizeWords(text);
    for (const word of tokens) bump(words, word);
    for (const e of emo) bump(emojis, e);

    const dt = parseDt(msg);
    const off = offsetMs(msg);
    if (dt) {
      dts.push(dt);
      datedFlags++;
      if (!stats.first || dt < stats.first) { stats.first = dt; stats.firstLabel = timestampLabel(msg); }
      if (!stats.last || dt > stats.last) { stats.last = dt; stats.lastLabel = timestampLabel(msg); }
    }
    if (off != null) offsets.push(off);
  }

  // ---- summary ---------------------------------------------------------
  let duration = null;
  let range = "";
  if (dts.length) {
    const min = new Date(Math.min(...dts));
    const max = new Date(Math.max(...dts));
    duration = (max - min) / 1000;
    range = `${min.toISOString().slice(0, 19)} → ${max.toISOString().slice(0, 19)}`;
  } else if (offsets.length) {
    duration = Math.max(...offsets) / 1000;
    range = "n/a (offset only)";
  }
  a.summary = {
    total_messages: n,
    total_in_file: a.totalInFile,
    skipped_malformed: a.skipped,
    unique_users: users.size,
    message_types: Object.fromEntries(types),
    date_range: range,
    duration_seconds: duration == null ? null : Math.round(duration * 10) / 10,
    avg_messages_per_minute: duration > 0 ? Math.round(n / (duration / 60) * 100) / 100 : null,
    has_likes: a.mostLikedAvailable,
  };

  // ---- 1. most active users --------------------------------------------
  const byMessages = [...users.values()].sort((x, y) => y.messages - x.messages || x.name.localeCompare(y.name));
  a.mostActiveUsers = byMessages.slice(0, top).map((u, i) => ({
    rank: i + 1, user: u.name, handle: u.handle, user_id: u.uid, messages: u.messages,
    share_pct: n ? Math.round(100 * u.messages / n * 100) / 100 : 0,
    message_types: Object.fromEntries(u.types),
  }));

  // ---- 2. words / emojis ------------------------------------------------
  const sorted = (map, key) => [...map.entries()].sort((x, y) => y[1] - x[1]).slice(0, top)
    .map(([value, count], i) => ({ rank: i + 1, [key]: value, count }));
  a.mostRepeatedWords = sorted(words, "word");
  a.mostRepeatedEmojis = sorted(emojis, "emoji");

  // ---- 3. most liked ----------------------------------------------------
  if (a.mostLikedAvailable) {
    const liked = messages.map((msg) => ({
      like_count: Number.parseInt(msg.like_count || 0, 10) || 0,
      ...userKey(msg), timestamp: timestampLabel(msg), text: textOf(msg).slice(0, 120),
      message_type: String(msg.message_type || "text").toLowerCase(),
    })).filter((x) => x.like_count > 0)
      .sort((x, y) => y.like_count - x.like_count || x.user.localeCompare(y.user));
    a.mostLiked = liked.slice(0, top).map(({ user, handle, ...rest }) => ({ user, handle, ...rest }));
    a.mostLikedNote = !liked.length ? "Has like_count field but no positive likes found."
      : liked.length <= top ? "" : `Top ${top} of ${liked.length} liked messages.`;
  } else {
    a.mostLikedNote = "No like_count data in this file (use a --comment capture for this metric).";
  }

  // ---- 4/5. timeline + peak --------------------------------------------
  let bucketSeconds = null;
  let note = "";
  if (bucketSpec) {
    try { bucketSeconds = parseBucket(bucketSpec); }
    catch (e) { note = `Invalid --bucket spec (${e.message}); auto granularity used instead.`; }
  }
  if (dts.length) {
    const min = Math.min(...dts);
    const max = Math.max(...dts);
    if (bucketSeconds == null) bucketSeconds = chooseAutoBucket((max - min) / 1000);
    const span = (max - min) / 1000;
    const count = new Map();
    for (const dt of dts) {
      const idx = Math.floor((dt - min) / 1000 / bucketSeconds);
      bump(count, idx);
    }
    const buckets = Math.floor(span / bucketSeconds) + 1;
    for (let i = 0; i < buckets; i++) {
      a.timeline.push({ bucket: i, start: new Date(min + i * bucketSeconds * 1000).toISOString().slice(0, 19), count: count.get(i) || 0 });
    }
    note ||= datedFlags === messages.length
      ? `Bucketed by datetime into ${bucketSeconds}s intervals.`
      : `Partial datetimes (${datedFlags}/${messages.length} parsed); buckets cover dated messages only.`;
  } else if (offsets.length) {
    const min = Math.min(...offsets);
    const max = Math.max(...offsets);
    if (bucketSeconds == null) bucketSeconds = chooseAutoBucket((max - min) / 1000);
    const bucketMs = bucketSeconds * 1000;
    const count = new Map();
    for (const off of offsets) bump(count, Math.floor((off - min) / bucketMs));
    const buckets = Math.floor((max - min) / bucketMs) + 1;
    for (let i = 0; i < buckets; i++) {
      a.timeline.push({ bucket: i, start: `offset ${min + i * bucketMs}ms`, count: count.get(i) || 0 });
    }
    note ||= `No parseable datetimes; bucketed by video_offset_ms into ${bucketSeconds}s intervals.`;
  } else {
    note ||= "No timeline data (no parseable datetime or offset).";
  }
  a.summary.timeline_kind = dts.length ? "datetime" : offsets.length ? "offset" : "none";
  a.summary.bucket_seconds = bucketSeconds;
  if (note) a.summary.timeline_note = note;

  if (a.timeline.length) {
    const busy = [...a.timeline].sort((x, y) => y.count - x.count || x.bucket - y.bucket);
    a.peakActivity = {
      busiest_bucket: busy[0].bucket, busiest_start: busy[0].start, busiest_count: busy[0].count,
      top_peaks: busy.slice(0, 3).map((b) => ({ bucket: b.bucket, start: b.start, count: b.count })),
      bucket_seconds: bucketSeconds, timeline_kind: a.summary.timeline_kind,
    };
  } else {
    a.peakActivity = { busiest_count: 0, top_peaks: [], note };
  }

  // ---- 6. participation ranking ----------------------------------------
  const maxMsgs = Math.max(1, ...[...users.values()].map((u) => u.messages));
  const maxLikes = Math.max(1, ...[...users.values()].map((u) => u.likes));
  const maxLen = Math.max(1, ...[...users.values()].map((u) => u.messages ? u.chars / u.messages : 0));
  const score = (u) => {
    const avg = u.messages ? u.chars / u.messages : 0;
    return 50 * (u.messages / maxMsgs) + 10 * (u.messages / maxMsgs)
      + (u.likes ? 25 * (u.likes / maxLikes) : 0) + (avg ? 15 * (avg / maxLen) : 0);
  };
  const ranked = [...users.values()].sort((x, y) => score(y) - score(x) || y.messages - x.messages || x.name.localeCompare(y.name));
  a.participationRanking = ranked.slice(0, top).map((u, i) => ({
    rank: i + 1, user: u.name, handle: u.handle, messages: u.messages,
    share_pct: n ? Math.round(100 * u.messages / n * 100) / 100 : 0,
    likes_received: u.likes, avg_msg_length: u.messages ? Math.round(u.chars / u.messages * 10) / 10 : 0,
    first_active: u.firstLabel, last_active: u.lastLabel, participation_score: Math.round(score(u) * 100) / 100,
  }));

  return a;
}
