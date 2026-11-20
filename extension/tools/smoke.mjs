// Developer smoke test against real YouTube (network required).
// Usage: node tools/smoke.mjs "https://www.youtube.com/watch?v=VIDEO_ID" [live|comment]
import {
  extractVideoId, fetchWatchPage, findChatContinuation, findCommentContinuation,
  getLiveChat, getCommentsPage, parseLiveChatResponse, parseCommentsResponse,
} from "../src/core/innertube.js";

const url = process.argv[2] || "https://www.youtube.com/watch?v=B2yEbLpW_Wg";
const mode = process.argv[3] || "auto";
const videoId = extractVideoId(url);
if (!videoId) throw new Error(`not a YouTube video url: ${url}`);

const page = await fetchWatchPage(videoId);
console.log("videoId      :", videoId);
console.log("apiKey       :", page.apiKey ? "found" : "MISSING");
console.log("clientVersion:", page.clientVersion);
console.log("isLive       :", page.isLive);
console.log("startMs      :", page.streamStartMs);

const chatToken = findChatContinuation(page.initialData);
const commentToken = findCommentContinuation(page.initialData);
console.log("chat token   :", chatToken ? `${chatToken.slice(0, 24)}…` : "none");
console.log("comment token:", commentToken ? `${commentToken.slice(0, 24)}…` : "none");

const wantChat = mode === "live" || (mode === "auto" && chatToken);
const wantComment = mode === "comment" || (mode === "auto" && !chatToken);

if (wantChat && chatToken) {
  const data = await getLiveChat({
    apiKey: page.apiKey, clientVersion: page.clientVersion,
    token: chatToken, replay: !page.isLive,
  });
  const { messages, nextToken, timeoutMs } = parseLiveChatResponse(
    data, page.isLive ? page.streamStartMs : null,
  );
  console.log("\n[live chat] messages:", messages.length,
    "next:", Boolean(nextToken), "timeoutMs:", timeoutMs);
  for (const m of messages.slice(0, 3)) {
    console.log(` - ${m.user_display_name} [${m.timestamp || m.datetime || "?"}]: ${m.comment.slice(0, 70)}`);
  }
}

if (wantComment && commentToken) {
  let data = await getCommentsPage({
    apiKey: page.apiKey, clientVersion: page.clientVersion, token: commentToken,
  });
  let result = parseCommentsResponse(data);
  if (result.sortToken) {
    data = await getCommentsPage({
      apiKey: page.apiKey, clientVersion: page.clientVersion, token: result.sortToken,
    });
    result = parseCommentsResponse(data);
  }
  console.log("\n[comments] count:", result.comments.length,
    "next:", Boolean(result.nextToken), "replies:", result.replies.length);
  for (const c of result.comments.slice(0, 3)) {
    console.log(` - ${c.user_handle} (${c.like_count} likes, ${c.timestamp}): ${c.comment.slice(0, 70)}`);
  }
}

if (!wantChat && !wantComment) {
  console.log("\nNo usable continuation found (comments/chat may be disabled).");
}
