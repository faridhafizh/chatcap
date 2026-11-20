// Chatcap Side Panel — Phase 2. Talks to the service worker and reads
// IndexedDB directly; there is no native host and no Python involved.

import { analyzeMessages } from "../src/core/analytics.js";
import { toCsv, toJson, toMarkdown, toHtml } from "../src/core/exporters.js";
import { getMessages, listSessions } from "../src/storage/db.js";
import { CaptureEngine } from "../src/background/capture.js";

const MAX_LINES = 5000;
const COLORS = ["#22d3ee", "#f472b6", "#4ade80", "#facc15", "#60a5fa", "#fb7185",
                "#67e8f9", "#e879f9", "#86efac", "#fde047", "#93c5fd", "#fca5a5"];

let running = false;
let count = 0;
let outputTouched = false;
let currentSessionId = "";
let toastTimer = null;
let panelPort = null;
let localEngine = null;

const el = (id) => document.getElementById(id);
const splitList = (value) => String(value).split(",").map((s) => s.trim()).filter(Boolean);

function toast(text) {
  const node = el("toast");
  node.textContent = text;
  node.title = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 6000);
}

function status(text, kind = "idle") {
  const node = el("status");
  node.textContent = text;
  node.className = `pill ${kind}`;
}

function colorFor(name) {
  let h = 2166136261;
  for (let i = 0; i < String(name).length; i++) {
    h ^= String(name).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return COLORS[(h >>> 0) % COLORS.length];
}

function appendLine(parts, className = "") {
  const log = el("log");
  if (log.querySelector(".empty")) log.replaceChildren();
  const line = document.createElement("div");
  line.className = `line ${className}`.trim();
  for (const [text, cls] of parts) {
    if (!text) continue;
    const span = document.createElement("span");
    span.textContent = String(text);
    if (cls) span.className = cls;
    if (cls === "text") {
      span.style.color = colorFor(parts.find((p) => p[1] === "user")?.[0] || "");
    }
    line.appendChild(span);
  }
  log.appendChild(line);
  while (log.childElementCount > MAX_LINES) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

function render(msg) {
  const parts = [];
  if (msg.timestamp) parts.push([`[${msg.timestamp}] `, "ts"]);
  const type = String(msg.message_type || "text").toLowerCase();
  const user = msg.user_display_name || msg.author || "?";
  parts.push([msg.is_reply ? `↳ ${user}` : user, "user"]);
  parts.push([": ", "ts"]);
  parts.push([msg.comment || msg.message || "", "text"]);
  if (type === "super_chat" && msg.purchase_amount) parts.push([` ${msg.purchase_amount}`, "amount"]);
  if (type === "comment" && msg.like_count) parts.push([`  👍 ${msg.like_count}`, "ts"]);
  if (!["text", "comment", "chat", "textmessage"].includes(type)) parts.push([`  [${type}]`, "tag"]);
  appendLine(parts, type === "comment" ? "comment" : type);
}

function toggleButtons() {
  el("start").disabled = running;
  el("stop").disabled = !running;
}

async function refreshSessions() {
  const sessions = await listSessions();
  const select = el("session");
  const keep = select.value;
  select.replaceChildren(new Option("Current", ""));
  for (const s of sessions) {
    select.appendChild(new Option(
      `${s.mode === "comment" ? "Comments" : "Chat"} · ${s.count ?? 0} · ${String(s.startedAt).slice(11, 19)}`,
      s.id,
    ));
  }
  const has = (id) => Boolean(id) && [...select.options].some((option) => option.value === id);
  select.value = has(currentSessionId) ? currentSessionId : (has(keep) ? keep : "");
}

function onEngineMessage(message) {
  switch (message?.type) {
    case "status":
      status(message.text || "Working…", "busy");
      break;
    case "message":
      count = message.count ?? count + 1;
      render(message.msg || {});
      el("count").textContent = `${count} messages`;
      if (!running) { running = true; toggleButtons(); status("● Capturing", "live"); }
      break;
    case "saved":
      currentSessionId = message.sessionId || currentSessionId;
      el("path").textContent = `Saved locally · ${message.count ?? count} messages · session ${currentSessionId.slice(0, 8)}`;
      refreshSessions();
      break;
    case "ended":
      running = false;
      toggleButtons();
      status(`✓ ${message.reason || "Done"} · ${message.count ?? count} messages`, "ok");
      break;
    case "error":
      console.error("Chatcap engine error:", message.message);
      status(`Error: ${message.message}`, "error");
      toast(message.message);
      break;
    default:
      console.debug("Chatcap engine message", message);
  }
}

function connect() {
  if (panelPort) return;
  panelPort = chrome.runtime.connect({ name: "chatcap-panel" });
  panelPort.onMessage.addListener(onEngineMessage);
  panelPort.onDisconnect.addListener(() => { panelPort = null; });
}

async function fillFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { host = new URL(tab?.url || "").hostname; } catch { /* not a URL */ }
  if (!host || !(host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com"))) {
    toast("The active tab is not a YouTube page.");
    return;
  }
  let info = null;
  try { info = await chrome.tabs.sendMessage(tab.id, { type: "chatcap:page-info" }); }
  catch { /* content script may not be injected yet */ }
  el("url").value = info?.url || tab.url;
  el("video-title").textContent = info?.title || "";
  const cfg = await chrome.storage.local.get(["chatcap_output_prefix", "chatcap_auto_name"]);
  const prefix = cfg.chatcap_output_prefix || "chatcap";
  if (!outputTouched && info?.videoId && cfg.chatcap_auto_name !== false) {
    el("output").value = `${prefix}-${info.videoId}`;
  }
  persistConfig();
}

function persistConfig() {
  chrome.storage.local.set({
    chatcap_url: el("url").value,
    chatcap_mode: el("mode").value,
    chatcap_output: el("output").value,
    chatcap_keywords: el("keywords").value,
    chatcap_users: el("users").value,
  });
}

function startLocalEngine(config) {
  localEngine = new CaptureEngine(config, { postMessage: onEngineMessage });
  localEngine.start()
    .catch((error) => {
      console.error("Chatcap: panel engine failed", error);
      status(`Capture failed: ${error.message}`, "error");
      toast(error.message);
    })
    .finally(() => { localEngine = null; });
  status("Capturing in this panel — keep it open.", "live");
}

async function start() {
  const url = el("url").value.trim();
  if (!/^https?:\/\/([^/]*\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
    toast("Enter a valid YouTube URL (or click ↻ on a YouTube tab).");
    return;
  }
  const config = {
    url,
    mode: el("mode").value,
    output: el("output").value.trim(),
    keywords: splitList(el("keywords").value),
    users: splitList(el("users").value),
  };
  connect();
  try {
    const response = await chrome.runtime.sendMessage({ type: "chatcap:start", config });
    if (!response) throw new Error("The background service worker did not respond. Reload the extension and try again.");
    if (!response.ok) throw new Error(response.error || "The background service worker rejected the request.");
    running = true;
    count = 0;
    el("count").textContent = "0 messages";
    el("session").value = "";
    toggleButtons();
    status("Connecting…", "busy");
    persistConfig();
    if (response.mode === "panel") {
      console.warn("Chatcap: offscreen unavailable, using the panel fallback:", response.warning);
      startLocalEngine(config);
    }
  } catch (error) {
    console.error("Chatcap: start failed", error);
    status(`Cannot start: ${error.message}`, "error");
    toast(error.message);
  }
}

async function stop() {
  if (localEngine) {
    localEngine.stop();
    status("Stopping…", "busy");
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "chatcap:stop" });
    if (response && response.ok === false && running) {
      status(`Cannot stop: ${response.error}`, "error");
      return;
    }
    status("Stopping…", "busy");
  } catch (error) {
    console.error("Chatcap: stop failed", error);
    status(`Cannot stop: ${error.message}`, "error");
  }
}

async function loadSession(sessionId) {
  if (!sessionId) return;
  const [sessions, messages] = await Promise.all([listSessions(), getMessages(sessionId)]);
  const session = sessions.find((s) => s.id === sessionId);
  el("log").replaceChildren();
  count = messages.length;
  el("count").textContent = `${count} messages`;
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "This session has no saved messages.";
    el("log").appendChild(empty);
  } else {
    for (const message of messages.slice(-MAX_LINES)) render(message);
  }
  if (session) {
    el("url").value = session.url || el("url").value;
    el("mode").value = session.mode || el("mode").value;
    el("path").textContent = `Saved session · ${messages.length} messages · ${session.mode === "comment" ? "comments" : "chat"}`;
  }
}

async function onSessionChange() {
  const chosen = el("session").value;
  if (!chosen) {
    if (running) return;
    if (currentSessionId) await loadSession(currentSessionId);
    else clearView();
    return;
  }
  await loadSession(chosen);
}

function clearView() {
  el("log").replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = "Log cleared — messages are still being saved.";
  el("log").appendChild(empty);
}

async function exportFile(format) {
  const sessionId = el("session").value || currentSessionId;
  if (!sessionId) { toast("Start a capture first, or pick a saved session."); return; }
  const messages = await getMessages(sessionId);
  if (!messages.length) { toast("This session has no messages."); return; }
  const sessions = await listSessions();
  const session = sessions.find((s) => s.id === sessionId);
  const base = String(session?.output || "chatcap").replace(/\.json$/i, "");
  const hasLikes = session?.mode === "comment" || messages.some((m) => "like_count" in m);
  const analysis = analyzeMessages(messages, { hasLikes });
  analysis.file = session?.url || base;

  let content;
  let extension = format;
  if (format === "csv") content = toCsv(messages);
  else if (format === "md") content = toMarkdown(analysis);
  else if (format === "html") content = toHtml(messages, analysis);
  else { content = JSON.stringify(toJson(analysis), null, 2); extension = "json"; }

  const mime = { json: "application/json", csv: "text/csv", md: "text/markdown", html: "text/html" }[extension];
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const filename = `chatcap/${base}.${extension}`;
  await chrome.downloads.download({ url, filename, saveAs: false });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(`Downloaded ${base}.${extension}`);
}

async function restoreConfig() {
  const keys = ["chatcap_url", "chatcap_mode", "chatcap_output", "chatcap_keywords", "chatcap_users"];
  const cfg = await chrome.storage.local.get(keys);
  if (cfg.chatcap_url) el("url").value = cfg.chatcap_url;
  if (cfg.chatcap_mode) el("mode").value = cfg.chatcap_mode;
  if (cfg.chatcap_output) { el("output").value = cfg.chatcap_output; outputTouched = true; }
  if (cfg.chatcap_keywords) el("keywords").value = cfg.chatcap_keywords;
  if (cfg.chatcap_users) el("users").value = cfg.chatcap_users;
  clearView();
  refreshSessions();
}

document.addEventListener("DOMContentLoaded", () => {
  restoreConfig();
  connect();
  el("refresh-tab").addEventListener("click", fillFromTab);
  el("start").addEventListener("click", start);
  el("stop").addEventListener("click", stop);
  el("clear").addEventListener("click", clearView);
  el("output").addEventListener("input", () => { outputTouched = true; });
  el("session").addEventListener("change", onSessionChange);
  for (const id of ["url", "mode", "keywords", "users"]) el(id).addEventListener("change", persistConfig);
  document.querySelectorAll("[data-format]").forEach((button) => {
    button.addEventListener("click", async () => {
      status(`Exporting ${button.dataset.format.toUpperCase()}…`, "busy");
      try { await exportFile(button.dataset.format); }
      catch (error) { toast(`Export failed: ${error.message}`); }
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !running) start();
    if (event.key === "Escape" && running) stop();
  });
});
