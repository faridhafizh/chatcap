// Browser-native YouTube Innertube client. Runs in an extension page with
// host permissions, so cross-origin fetch works without any Proxy/Python.
//
// YouTube rejects POSTs to youtubei/v1/* when the request carries an extension
// Origin (`chrome-extension://…`) with HTTP 403 "Sorry...". Chrome/Edge stamp
// that Origin automatically for extension fetches, so rules/youtube-origin.json
// rewrites it to the YouTube web origin before the request leaves the browser.

import {
  parseChatActions, parseCommentItemsWithEntities, collectCommentEntities, tokenFromNode,
} from "./parse.js";

const JSON_MARKERS = [
  "var ytInitialData =", 'window["ytInitialData"] =', "ytInitialData =",
  "var ytInitialPlayerResponse =", 'window["ytInitialPlayerResponse"] =',
  "ytInitialPlayerResponse =", "ytcfg.set(",
];

export function validateUrl(url) {
  let host = "";
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  return host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com");
}

export function extractVideoId(url) {
  const s = String(url || "");
  return (/^https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)([\w-]{11})/.exec(s)
    || /^https?:\/\/youtu\.be\/([\w-]{11})/.exec(s))?.[1] || "";
}

function matchBalanced(text, start, open, close) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function extractJsonAfter(text, markers = JSON_MARKERS) {
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx < 0) continue;
    let pos = idx + marker.length;
    while (/\s/.test(text[pos] || "")) pos++;
    if (text[pos] === "=") {
      pos++;
      while (/\s/.test(text[pos] || "")) pos++;
    }
    const open = text[pos];
    if (open !== "{" && open !== "[") continue;
    const raw = matchBalanced(text, pos, open, open === "{" ? "}" : "]");
    if (!raw) continue;
    try { return JSON.parse(raw); } catch { /* try the next marker */ }
  }
  return null;
}

export function parsePageConfig(html) {
  const apiKey = /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(html)?.[1] || "";
  const clientVersion = /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/.exec(html)?.[1]
    || "2.20250312.04.00";
  const initialData = extractJsonAfter(html, JSON_MARKERS);
  const playerResponse = extractJsonAfter(html, JSON_MARKERS.slice(3, 6));
  const startString = /"startTimestamp"\s*:\s*"([^"]+)"/.exec(html)?.[1]
    || playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.startTimestamp
    || "";
  const publish = playerResponse?.microformat?.playerMicroformatRenderer?.publishDate || "";
  const liveDetails = playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails || {};
  const streamStartMs = Date.parse(startString) || Date.parse(publish) || null;
  // `isLiveContent` is also true for finished streams, so only treat a video
  // as live when the player says it is broadcasting right now.
  const isLive = liveDetails.isLiveNow === true
    || playerResponse?.videoDetails?.isLive === true
    || /"isLiveNow"\s*:\s*true/.test(html)
    || /"isLive"\s*:\s*true/.test(html);

  return { apiKey, clientVersion, initialData, playerResponse, isLive, streamStartMs };
}

export async function fetchWatchPage(videoId, fetchFn = fetch) {
  const response = await fetchFn(`https://www.youtube.com/watch?v=${videoId}`, {
    credentials: "omit",
    headers: { "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!response.ok) throw new Error(`YouTube page returned HTTP ${response.status}`);
  return parsePageConfig(await response.text());
}

export function findContinuations(obj) {
  const found = [];
  const seenObjects = new WeakSet();
  const seenTokens = new Set();
  const walk = (node, path) => {
    if (!node || typeof node !== "object" || seenObjects.has(node)) return;
    seenObjects.add(node);
    const command = node.continuationCommand
      || node.continuationEndpoint?.continuationCommand
      || null;
    const token = command?.token
      || node.nextContinuationData?.continuation
      || node.continuation;
    if (typeof token === "string" && token && !seenTokens.has(token)) {
      seenTokens.add(token);
      found.push({
        token,
        path,
        request: command?.request || "",
        targetId: command?.command?.showReloadUiCommand?.targetId || "",
      });
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}/${key}`);
  };
  walk(obj, "");
  return found;
}

function continuationScore(entry, kind) {
  const path = entry.path.toLowerCase();
  const target = String(entry.targetId || "").toLowerCase();
  if (kind === "chat") {
    if (path.includes("livechat") || path.includes("conversationbar")
      || target.includes("live-chat") || target.includes("chat")) return 10;
    return 0;
  }
  if (path.includes("commentsection") || target.includes("comments-section")) return 10;
  if (path.includes("comment")) return 8;
  if (path.includes("itemsectionrenderer")) return 2;
  return 0;
}

function bestContinuation(obj, kind) {
  const ranked = findContinuations(obj)
    .map((entry) => ({ ...entry, score: continuationScore(entry, kind) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.token || "";
}

export const findChatContinuation = (obj) => bestContinuation(obj, "chat");
export const findCommentContinuation = (obj) => bestContinuation(obj, "comments");

function findTimeoutMs(obj) {
  let found = null;
  const seen = new WeakSet();
  const walk = (node) => {
    if (found != null || !node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Number.isFinite(node.timeoutMs)) { found = node.timeoutMs; return; }
    for (const value of Object.values(node)) walk(value);
  };
  walk(obj);
  return found;
}

function post(endpoint, apiKey, clientVersion, body, fetchFn) {
  return fetchFn(`https://www.youtube.com/youtubei/v1/${endpoint}?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Youtube-Client-Name": "1",
      "X-Youtube-Client-Version": clientVersion,
    },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion, hl: "en", gl: "US" } },
      ...body,
    }),
  });
}

export async function getLiveChat({ apiKey, clientVersion, token, replay = false, playerOffsetMs = 0, fetchFn = fetch }) {
  // The live-chat endpoints live under v1/live_chat/, not v1/ directly.
  const endpoint = replay ? "live_chat/get_live_chat_replay" : "live_chat/get_live_chat";
  const body = { continuation: token };
  if (replay) body.playerOffsetMs = String(playerOffsetMs);
  const response = await post(endpoint, apiKey, clientVersion, body, fetchFn);
  if (!response.ok) {
    const error = new Error(`YouTube returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function getCommentsPage({ apiKey, clientVersion, token, fetchFn = fetch }) {
  const response = await post("next", apiKey, clientVersion, { continuation: token }, fetchFn);
  if (!response.ok) throw new Error(`YouTube returned HTTP ${response.status}`);
  return response.json();
}

export function parseLiveChatResponse(data, streamStartMs = null) {
  const cont = data?.continuationContents?.liveChatContinuation || {};
  return {
    messages: parseChatActions(cont.actions, streamStartMs),
    nextToken: liveChatNextToken(cont) || liveChatNextToken(data?.continuationContents),
    timeoutMs: findTimeoutMs(data),
  };
}

// Live chat next pages live in `continuations[0].<kind>ContinuationData`
// (invalidation, timed, reload, or replay), not in a generic command object.
function liveChatNextToken(cont) {
  for (const entry of cont?.continuations || []) {
    if (!entry || typeof entry !== "object") continue;
    const direct = tokenFromNode(entry);
    if (direct) return direct;
    if (typeof entry.continuation === "string" && entry.continuation) return entry.continuation;
    for (const value of Object.values(entry)) {
      if (value && typeof value === "object"
        && typeof value.continuation === "string" && value.continuation) {
        return value.continuation;
      }
    }
  }
  return "";
}

function endpointItems(endpoint) {
  return endpoint?.reloadContinuationItemsCommand?.continuationItems
    || endpoint?.appendContinuationItemsAction?.continuationItems
    || null;
}

function commentItems(data) {
  const arrays = [];
  const add = (value) => { if (Array.isArray(value) && value.length) arrays.push(value); };
  for (const endpoint of data?.onResponseReceivedEndpoints || []) add(endpointItems(endpoint));
  for (const endpoint of data?.onResponseReceivedActions || []) add(endpointItems(endpoint));
  for (const value of Object.values(data?.continuationContents || {})) {
    add(value?.content?.items);
    add(value?.items);
  }
  if (!arrays.length) {
    const seen = new WeakSet();
    const walk = (node) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)
        && node.some((x) => x?.commentRenderer || x?.commentThreadRenderer || x?.commentsHeaderRenderer)) {
        arrays.push(node);
        return;
      }
      for (const value of Object.values(node)) walk(value);
    };
    walk(data);
  }
  return arrays.flat();
}

export function parseCommentsResponse(data, parentId = "") {
  const items = commentItems(data);
  const entities = collectCommentEntities(data);
  const parsed = parseCommentItemsWithEntities(items, entities, parentId);
  return {
    ...parsed,
    renderers: items.filter((item) => item?.commentRenderer).map((item) => item.commentRenderer),
  };
}
