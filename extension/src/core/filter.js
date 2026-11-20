// Port of chatcap/utils.py — filters and deterministic per-user colors.

export const PLAIN_TYPES = new Set(["text", "comment", "chat", "textmessage"]);

const PALETTE = [
  "#22d3ee", "#f472b6", "#4ade80", "#facc15", "#60a5fa", "#fb7185",
  "#67e8f9", "#e879f9", "#86efac", "#fde047", "#93c5fd", "#fca5a5",
];

export function makeFilter(keywords = [], users = []) {
  const kws = keywords.map((k) => String(k).toLowerCase()).filter(Boolean);
  const usrs = users.map((u) => String(u).toLowerCase().replace(/^@/, "")).filter(Boolean);
  return (msg) => {
    if (!kws.length && !usrs.length) return true;
    const comment = String(msg.comment || msg.message || "").toLowerCase();
    const plain = (v) => String(v || "").toLowerCase().replace(/^@/, "");
    const name = plain(msg.user_display_name || msg.author);
    const handle = plain(msg.user_handle);
    const uid = String(msg.user_id || "").toLowerCase();
    if (kws.length && kws.some((k) => comment.includes(k))) return true;
    if (usrs.length && usrs.some((u) => name.includes(u) || handle.includes(u) || uid.includes(u))) return true;
    return false;
  };
}

export function userColor(name) {
  let h = 2166136261;
  for (let i = 0; i < String(name).length; i++) {
    h ^= String(name).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[(h >>> 0) % PALETTE.length];
}

export function splitList(value = "") {
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}
