// Port of chatcap/downloader.py + streaming.py + comments.py renderers.
// Produces the exact same message dict as the Python CLI.

export function textFromRuns(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((r) => r?.text || "").join("");
  if (Array.isArray(value.runs)) return value.runs.map((r) => r?.text || "").join("");
  return value.simpleText || "";
}

export function parseCount(text) {
  const s = String(text || "").replace(/,/g, "").trim();
  const m = /^([\d.]+)\s*([kmb])?$/i.exec(s);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
  return Math.round(n * mult);
}

export function msToTimestamp(ms) {
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function localClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

const CHAT_RENDERERS = [
  "liveChatTextMessageRenderer",
  "liveChatPaidMessageRenderer",
  "liveChatPaidStickerRenderer",
  "liveChatMembershipItemRenderer",
  "liveChatMembershipGiftPurchaseRenderer",
];

export function parseChatRenderer(renderer) {
  if (!renderer) return null;
  const usec = Number(renderer.timestampUsec || 0);
  const ms = usec > 0 ? usec / 1000 : 0;
  const datetime = ms ? new Date(ms).toISOString() : "";
  const amount = textFromRuns(renderer.purchaseAmountText?.runs) || renderer.purchaseAmountText?.simpleText || "";
  let messageType = "text";
  if (amount || renderer.purchaseAmountText) messageType = "super_chat";
  else if (renderer.headerSubtext || renderer.headerPrimaryText) messageType = "membership";

  const badges = (renderer.authorBadges || []).map((b) => {
    const r = b.liveChatAuthorBadgeRenderer || b;
    return r.tooltip || textFromRuns(r.label) || r.icon?.iconType || "";
  }).filter(Boolean);

  return {
    user_id: renderer.authorExternalChannelId || "",
    user_display_name: renderer.authorName?.simpleText || textFromRuns(renderer.authorName?.runs) || "Unknown",
    user_handle: "",
    datetime,
    timestamp: ms ? localClock(ms) : "",
    comment: textFromRuns(renderer.message?.runs) || renderer.message?.simpleText || "",
    message_type: messageType,
    badges,
    message_id: renderer.id || "",
    purchase_amount: amount,
    video_offset_ms: "0",
  };
}

function flattenActions(actions) {
  const out = [];
  for (const action of actions || []) {
    if (action?.replayChatItemAction?.actions?.length) {
      out.push(...action.replayChatItemAction.actions);
    } else {
      out.push(action);
    }
  }
  return out;
}

export function parseChatActions(actions, streamStartMs = null) {
  const messages = [];
  for (const action of flattenActions(actions)) {
    const item = action?.addChatItemAction?.item || action?.item;
    if (!item) continue;
    const key = CHAT_RENDERERS.find((k) => item[k]);
    if (!key) continue;
    const msg = parseChatRenderer(item[key]);
    if (!msg) continue;
    if (streamStartMs != null && msg.datetime) {
      const offset = Date.parse(msg.datetime) - streamStartMs;
      msg.timestamp = (offset < 0 ? "-" : "") + msToTimestamp(offset);
      msg.video_offset_ms = String(offset);
    }
    messages.push(msg);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Comments (port of CommentScraper._convert)
// ---------------------------------------------------------------------------

export function parseCommentRenderer(renderer, { isReply = false, parentId = "" } = {}) {
  if (!renderer) return null;
  const author = textFromRuns(renderer.authorText) || "";
  const name = author.replace(/^@/, "") || "Unknown User";
  const handle = author.startsWith("@") ? author : `@${name.replace(/\s/g, "")}`;
  const usec = Number(renderer.publishedTimeUsec || 0);
  const ms = usec > 0 ? usec / 1000 : 0;
  const iso = ms ? new Date(ms).toISOString() : "";
  const date = ms ? iso.slice(0, 10) : "";
  const commentId = renderer.commentId || "";

  return {
    user_id: renderer.authorExternalChannelId || "",
    user_display_name: name,
    user_handle: handle,
    datetime: iso,
    timestamp: date,
    comment: textFromRuns(renderer.contentText),
    message_type: "comment",
    like_count: parseCount(renderer.voteCount?.simpleText || textFromRuns(renderer.voteCount?.runs)),
    is_reply: isReply,
    parent_id: isReply ? parentId : "",
    is_pinned: Boolean(renderer.isPinned),
    is_favorited: false,
    author_is_uploader: Boolean(renderer.authorIsChannelOwner),
    author_thumbnail: renderer.authorThumbnail?.thumbnails?.[0]?.url || "",
    message_id: commentId,
    badges: [],
    purchase_amount: "",
    video_offset_ms: "0",
  };
}

export function tokenFromNode(node) {
  return node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
    // "Show more replies" / "Show more comments" wrap the continuation in a
    // button instead of a continuationEndpoint. Without this, reply
    // pagination stops after the first batch even when the UI says
    // "44 replies".
    || node?.continuationItemRenderer?.button?.buttonRenderer?.command?.continuationCommand?.token
    || node?.continuationItemRenderer?.button?.buttonRenderer?.navigationEndpoint?.continuationCommand?.token
    || node?.continuationEndpoint?.continuationCommand?.token
    || node?.button?.buttonRenderer?.command?.continuationCommand?.token
    || node?.button?.buttonRenderer?.navigationEndpoint?.continuationCommand?.token
    || node?.continuationCommand?.token
    || node?.continuations?.[0]?.continuationCommand?.token
    || node?.continuations?.[0]?.reloadContinuationData?.continuation
    || node?.nextContinuationData?.continuation
    || (typeof node?.continuation === "string" ? node.continuation : "")
    || "";
}

// Simple counts such as "8 likes", "1.2K", or " " (empty).
function parseLikeText(value) {
  const cleaned = String(value || "").replace(/[^\d.,kmb\s]/gi, " ").trim();
  return parseCount(cleaned.split(/\s+/)[0] || "");
}

// ---------------------------------------------------------------------------
// Modern comments (commentViewModel + frameworkUpdates entity payloads).
// YouTube moved away from commentRenderer in 2024/2025; this is what the
// watch page and youtubei/v1/next now return.
// ---------------------------------------------------------------------------

export function collectCommentEntities(data) {
  const entities = new Map();
  const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
  for (const mutation of mutations) {
    const payload = mutation?.payload?.commentEntityPayload;
    const key = mutation?.entityKey || payload?.key;
    if (payload && key) entities.set(key, payload);
  }
  return entities;
}

export function parseCommentEntity(payload, { isReply = false, parentId = "" } = {}) {
  if (!payload) return null;
  const props = payload.properties || {};
  const author = payload.author || {};
  const toolbar = payload.toolbar || {};
  const rawName = author.displayName || props.authorButtonA11y || "";
  const name = rawName.replace(/^@/, "").trim() || "Unknown User";
  const handle = rawName
    ? (rawName.startsWith("@") ? rawName : `@${name.replace(/\s/g, "")}`)
    : `@${name.replace(/\s/g, "")}`;
  const replyLevel = Number(props.replyLevel || 0);
  const reply = isReply || replyLevel > 0;

  return {
    user_id: author.channelId || "",
    user_display_name: name,
    user_handle: handle,
    // The modern payload only exposes a relative label ("4 minutes ago"),
    // not an absolute timestamp, so datetime stays empty.
    datetime: "",
    timestamp: props.publishedTime || "",
    comment: props.content?.content || "",
    message_type: "comment",
    like_count: parseLikeText(toolbar.likeCountNotliked)
      || parseLikeText(toolbar.likeCountA11y)
      || parseLikeText(toolbar.likeCountLiked),
    is_reply: reply,
    parent_id: reply ? parentId : "",
    is_pinned: Boolean(props.isPinned),
    is_favorited: false,
    author_is_uploader: Boolean(author.isCreator),
    author_thumbnail: author.avatarThumbnailUrl || "",
    message_id: props.commentId || "",
    badges: author.isVerified ? ["Verified"] : [],
    purchase_amount: "",
    video_offset_ms: "0",
  };
}

function viewModelKey(thread) {
  return thread?.commentViewModel?.commentViewModel?.commentKey
    || thread?.commentViewModel?.commentKey
    || "";
}

export function findReplyToken(thread) {
  if (thread?.replyButton?.buttonRenderer?.command?.continuationCommand?.token) {
    return thread.replyButton.buttonRenderer.command.continuationCommand.token;
  }
  return tokenFromNode(thread?.replies?.commentRepliesRenderer?.contents?.[0])
    || tokenFromNode(thread?.replies?.commentRepliesRenderer);
}

export function findNewestSortToken(items) {
  const header = (items || []).find((item) => item?.commentsHeaderRenderer)?.commentsHeaderRenderer;
  const menu = header?.sortMenu?.sortFilterSubMenuRenderer?.subMenuItems || [];
  const newest = menu.find((entry) => /newest/i.test(entry?.title || ""));
  return newest ? tokenFromNode(newest.serviceEndpoint) : "";
}

export function parseCommentItems(items, parentId = "") {
  const comments = [];
  const replies = [];
  let nextToken = "";

  for (const item of items || []) {
    if (item?.commentThreadRenderer) {
      const thread = item.commentThreadRenderer;
      const msg = parseCommentRenderer(thread.comment, { isReply: false, parentId: "" });
      if (msg) comments.push(msg);
      const replyToken = findReplyToken(thread);
      if (replyToken) replies.push({ parentId: msg?.message_id || "", token: replyToken });
    } else if (item?.commentRenderer) {
      const msg = parseCommentRenderer(item.commentRenderer, { isReply: Boolean(parentId), parentId });
      if (msg) comments.push(msg);
      const replyToken = findReplyToken(item.commentRenderer);
      if (replyToken) replies.push({ parentId: msg?.message_id || "", token: replyToken });
    } else if (item?.continuationItemRenderer) {
      nextToken = tokenFromNode(item.continuationItemRenderer) || nextToken;
    }
  }

  return { comments, nextToken, replies, sortToken: findNewestSortToken(items) };
}

// Entity-aware variant used by the live API client.
export function parseCommentItemsWithEntities(items, entities, parentId = "") {
  const comments = [];
  const replies = [];
  let nextToken = "";

  for (const item of items || []) {
    if (item?.commentThreadRenderer) {
      const thread = item.commentThreadRenderer;
      const key = viewModelKey(thread);
      const msg = key ? parseCommentEntity(entities.get(key)) : null;
      if (msg) comments.push(msg);
      const replyToken = findReplyToken(thread);
      if (replyToken) replies.push({ parentId: msg?.message_id || "", token: replyToken });
    } else if (item?.commentViewModel) {
      const vm = item.commentViewModel?.commentViewModel || item.commentViewModel;
      const key = vm?.commentKey || "";
      const msg = key ? parseCommentEntity(entities.get(key), {
        isReply: Boolean(parentId),
        parentId,
      }) : null;
      if (msg) comments.push(msg);
    } else if (item?.commentRenderer) {
      const msg = parseCommentRenderer(item.commentRenderer, { isReply: Boolean(parentId), parentId });
      if (msg) comments.push(msg);
      const replyToken = findReplyToken(item.commentRenderer);
      if (replyToken) replies.push({ parentId: msg?.message_id || "", token: replyToken });
    } else if (item?.continuationItemRenderer) {
      nextToken = tokenFromNode(item.continuationItemRenderer) || nextToken;
    }
  }

  return { comments, nextToken, replies, sortToken: findNewestSortToken(items) };
}
