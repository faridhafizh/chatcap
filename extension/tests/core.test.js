// Node tests for the browser-native core (no browser APIs required).
// Run with: npm test   (from the extension/ folder)
import test from "node:test";
import assert from "node:assert/strict";

import { makeFilter, userColor } from "../src/core/filter.js";
import {
  parseChatActions, parseChatRenderer, parseCommentRenderer,
  parseCommentItems, findReplyToken, tokenFromNode, parseCount, msToTimestamp,
} from "../src/core/parse.js";
import {
  validateUrl, extractVideoId, extractJsonAfter, parsePageConfig,
  findContinuations, findChatContinuation, findCommentContinuation,
  parseLiveChatResponse, parseCommentsResponse,
} from "../src/core/innertube.js";
import { analyzeMessages, tokenizeWords, chooseAutoBucket, parseBucket } from "../src/core/analytics.js";
import { toCsv, toJson, toMarkdown, toHtml } from "../src/core/exporters.js";

const USEC = "1700000000000000"; // 2023-11-14T22:13:20Z
const chatRenderer = {
  id: "m1",
  authorName: { simpleText: "@alice" },
  authorExternalChannelId: "UC1",
  timestampUsec: USEC,
  message: { runs: [{ text: "hello " }, { text: "world" }] },
  authorBadges: [{ liveChatAuthorBadgeRenderer: { tooltip: "Member (1 year)" } }],
};

const commentRenderer = {
  commentId: "c1",
  authorText: { runs: [{ text: "@bob" }] },
  authorExternalChannelId: "UC2",
  publishedTimeUsec: USEC,
  contentText: { runs: [{ text: "nice video" }] },
  voteCount: { simpleText: "1.2K" },
  authorThumbnail: { thumbnails: [{ url: "https://img/avatar.png" }] },
  replyButton: { buttonRenderer: { command: { continuationCommand: { token: "reply-token" } } } },
};

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------

test("makeFilter matches keywords and users (case-insensitive)", () => {
  const filter = makeFilter(["GG"], ["@alice"]);
  assert.equal(filter({ comment: "gg wp", user_display_name: "bob" }), true);
  assert.equal(filter({ comment: "hello", user_display_name: "ALICE" }), true);
  assert.equal(filter({ comment: "hello", user_display_name: "bob" }), false);
  assert.equal(makeFilter()({}), true);
});

test("userColor is deterministic", () => {
  assert.equal(userColor("alice"), userColor("alice"));
  assert.match(userColor("alice"), /^#/);
});

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

test("parseChatRenderer builds the CLI message schema", () => {
  const msg = parseChatRenderer(chatRenderer);
  assert.equal(msg.user_display_name, "@alice");
  assert.equal(msg.comment, "hello world");
  assert.equal(msg.message_type, "text");
  assert.deepEqual(msg.badges, ["Member (1 year)"]);
  assert.equal(msg.message_id, "m1");
  assert.equal(msg.video_offset_ms, "0");
});

test("super chat and membership are detected", () => {
  const paid = parseChatRenderer({ ...chatRenderer, purchaseAmountText: { runs: [{ text: "R$10" }] } });
  assert.equal(paid.message_type, "super_chat");
  assert.equal(paid.purchase_amount, "R$10");
  const member = parseChatRenderer({ ...chatRenderer, headerSubtext: { runs: [{ text: "1 year" }] } });
  assert.equal(member.message_type, "membership");
});

test("parseChatActions flattens replay actions and applies stream stamps", () => {
  const start = Number(USEC) / 1000 - 1000;
  const actions = [{ replayChatItemAction: { actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: chatRenderer } } }] } }];
  const msgs = parseChatActions(actions, start);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].video_offset_ms, "1000");
  assert.equal(msgs[0].timestamp, "0:00:01");
});

test("parseCommentRenderer and parseCommentItems", () => {
  const msg = parseCommentRenderer(commentRenderer);
  assert.equal(msg.user_display_name, "bob");
  assert.equal(msg.user_handle, "@bob");
  assert.equal(msg.like_count, 1200);
  assert.equal(msg.is_reply, false);
  assert.equal(findReplyToken(commentRenderer), "reply-token");

  const result = parseCommentItems([
    { commentRenderer },
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "next" } } } },
  ], "parent-1");
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].is_reply, true);
  assert.equal(result.comments[0].parent_id, "parent-1");
  assert.equal(result.nextToken, "next");
});

test("tokenFromNode reads Show more replies button continuations", () => {
  const item = {
    continuationItemRenderer: {
      button: {
        buttonRenderer: {
          text: { runs: [{ text: "Show more replies" }] },
          command: { continuationCommand: { token: "more-replies" } },
        },
      },
    },
  };
  assert.equal(tokenFromNode(item), "more-replies");
  assert.equal(tokenFromNode({ button: { buttonRenderer: { navigationEndpoint: { continuationCommand: { token: "nav-more" } } } } }), "nav-more");
});

test("count and timestamp helpers", () => {
  assert.equal(parseCount("1.2K"), 1200);
  assert.equal(parseCount("13"), 13);
  assert.equal(parseCount("n/a"), 0);
  assert.equal(msToTimestamp(12891410), "3:34:51");
});

// ---------------------------------------------------------------------------
// innertube
// ---------------------------------------------------------------------------

test("URL helpers", () => {
  assert.equal(validateUrl("https://www.youtube.com/watch?v=abc"), true);
  assert.equal(validateUrl("https://example.com/"), false);
  assert.equal(extractVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1"), "dQw4w9WgXcQ");
});

test("extractJsonAfter handles strings containing braces", () => {
  const html = 'prefix var ytInitialData = {"a":"x}y","b":[1,2]}; suffix';
  assert.deepEqual(extractJsonAfter(html), { a: "x}y", b: [1, 2] });
});

test("parsePageConfig reads api key, client version and liveness", () => {
  const html = `
    "INNERTUBE_API_KEY":"AIzaTest","INNERTUBE_CLIENT_VERSION":"2.2026.01.01",
    "isLive":true,"startTimestamp":"2026-11-19T10:00:00Z",
    var ytInitialData = {"contents":{"twoColumnWatchNextResults":{"conversationBar":{"liveChatRenderer":{"continuations":[{"reloadContinuationData":{"continuation":"abc"}}]}}}}};
  `;
  const cfg = parsePageConfig(html);
  assert.equal(cfg.apiKey, "AIzaTest");
  assert.equal(cfg.clientVersion, "2.2026.01.01");
  assert.equal(cfg.isLive, true);
  assert.equal(cfg.streamStartMs, Date.parse("2026-11-19T10:00:00Z"));
  assert.equal(findChatContinuation(cfg.initialData), "abc");
});

test("findContinuations collects every token", () => {
  const found = findContinuations({ a: { continuationCommand: { token: "t1" } }, b: [{ continuation: "t2" }] });
  assert.deepEqual(found.map((x) => x.token).sort(), ["t1", "t2"]);
});

test("parseLiveChatResponse extracts messages, token and timeout", () => {
  const data = {
    continuationContents: {
      liveChatContinuation: {
        actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: chatRenderer } } }],
        continuations: [{ continuationCommand: { token: "next-token" } }],
      },
    },
    timeoutMs: 2000,
  };
  const result = parseLiveChatResponse(data, null);
  assert.equal(result.messages.length, 1);
  assert.equal(result.nextToken, "next-token");
  assert.equal(result.timeoutMs, 2000);
});

test("parseCommentsResponse returns comments, renderers and next token", () => {
  const data = {
    onResponseReceivedActions: [{
      appendContinuationItemsAction: {
        continuationItems: [
          { commentRenderer },
          { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "next-comments" } } } },
        ],
      },
    }],
  };
  const result = parseCommentsResponse(data);
  assert.equal(result.comments.length, 1);
  assert.equal(result.renderers.length, 1);
  assert.equal(result.nextToken, "next-comments");
});

test("bucket parsing and auto granularity", () => {
  assert.equal(parseBucket("5m"), 300);
  assert.equal(parseBucket("90"), 90);
  assert.throws(() => parseBucket("5x"));
  assert.equal(chooseAutoBucket(3600), 60);
  assert.equal(chooseAutoBucket(4 * 3600), 300);
  assert.equal(chooseAutoBucket(10 * 3600), 3600);
});

// ---------------------------------------------------------------------------
// analytics + exporters
// ---------------------------------------------------------------------------

const msg = (user, text, offsetMin, likes) => ({
  user_id: user === "Alice" ? "UC1" : "UC2",
  user_display_name: user,
  user_handle: `@${user}`,
  datetime: new Date(Date.parse("2026-11-19T10:00:00Z") + offsetMin * 60000).toISOString(),
  timestamp: `10:${String(offsetMin).padStart(2, "0")}`,
  comment: text,
  message_type: "comment",
  video_offset_ms: String(offsetMin * 60000),
  ...(likes == null ? {} : { like_count: likes }),
  message_id: `${user}-${offsetMin}`,
});

test("tokenize drops stopwords and keeps emojis", () => {
  const [words, emojis] = tokenizeWords("Hello, WORLD!!! 😂 https://x.com @bob");
  assert.ok(words.includes("hello"));
  assert.ok(!words.includes("world"));
  assert.ok(!words.includes("bob"));
  assert.ok(emojis.length >= 1);
});

test("analyzeMessages computes all metrics", () => {
  const messages = [
    msg("Alice", "awesome clutch", 0, 5), msg("Alice", "awesome play", 0, 9),
    msg("Alice", "awesome finish", 0, 2), msg("Bob", "hello", 5, 1),
  ];
  const a = analyzeMessages(messages, { hasLikes: true, top: 2 });
  assert.equal(a.summary.total_messages, 4);
  assert.equal(a.summary.unique_users, 2);
  assert.equal(a.mostActiveUsers[0].user, "Alice");
  assert.equal(a.mostLiked[0].like_count, 9);
  assert.ok(a.mostRepeatedWords.some((w) => w.word === "awesome"));
  assert.ok(a.timeline.length >= 2);
  assert.equal(a.peakActivity.busiest_count, 3);
  assert.equal(a.participationRanking.length, 2);
});

test("analyzeMessages handles empty input", () => {
  const a = analyzeMessages([]);
  assert.equal(a.summary.total_messages, 0);
  assert.deepEqual(a.timeline, []);
  assert.equal(a.peakActivity.busiest_count, 0);
});

test("exporters produce CSV, Markdown, HTML and JSON", () => {
  const messages = [msg("Alice", "great clutch", 0, 5), msg("Bob", "hello", 1, 1)];
  const a = analyzeMessages(messages, { hasLikes: true });
  assert.ok(toCsv(messages).startsWith("\uFEFFdatetime"));
  assert.match(toMarkdown(a), /## Most Active Users/);
  assert.match(toHtml(messages, a), /<!doctype html>/);
  assert.equal(toJson(a).summary.total_messages, 2);
});

// ---------------------------------------------------------------------------
// modern (2025) YouTube payloads
// ---------------------------------------------------------------------------

test("findChatContinuation ignores the comments section", () => {
  const watch = {
    contents: {
      twoColumnWatchNextResults: {
        results: { results: { contents: [{ itemSectionRenderer: { contents: [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "comments-token" } } } }] } }] } },
        secondaryResults: { secondaryResults: { results: [{ itemSectionRenderer: { contents: [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "sidebar-token" } } } }] } }] } },
      },
      conversationBar: { liveChatRenderer: { continuations: [{ reloadContinuationData: { continuation: "chat-token" } }] } },
    },
  };
  assert.equal(findChatContinuation(watch), "chat-token");
  assert.equal(findCommentContinuation({ contents: { twoColumnWatchNextResults: watch.contents.twoColumnWatchNextResults } }), "comments-token");
  assert.equal(findChatContinuation({ itemSectionRenderer: { continuationCommand: { token: "comments-token" } } }), "");
});

test("parseLiveChatResponse reads invalidation continuation tokens", () => {
  const data = {
    continuationContents: {
      liveChatContinuation: {
        actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: chatRenderer } } }],
        continuations: [{
          invalidationContinuationData: { continuation: "live-next", timeoutMs: 3000 },
        }],
      },
    },
  };
  const result = parseLiveChatResponse(data, null);
  assert.equal(result.messages.length, 1);
  assert.equal(result.nextToken, "live-next");
  assert.equal(result.timeoutMs, 3000);
});

test("parseCommentsResponse supports commentViewModel entity payloads", () => {
  const data = {
    onResponseReceivedEndpoints: [{
      reloadContinuationItemsCommand: {
        continuationItems: [
          {
            commentsHeaderRenderer: {
              sortMenu: {
                sortFilterSubMenuRenderer: {
                  subMenuItems: [
                    { title: "Top", serviceEndpoint: { continuationCommand: { token: "top-token" } } },
                    { title: "Newest", serviceEndpoint: { continuationCommand: { token: "newest-token" } } },
                  ],
                },
              },
            },
          },
        ],
      },
    }, {
      reloadContinuationItemsCommand: {
        continuationItems: [
          {
            commentThreadRenderer: {
              commentViewModel: { commentViewModel: { commentKey: "k1", commentId: "c1" } },
              replies: {
                commentRepliesRenderer: {
                  contents: [{
                    continuationItemRenderer: {
                      continuationEndpoint: { continuationCommand: { token: "reply-token" } },
                    },
                  }],
                },
              },
            },
          },
          {
            continuationItemRenderer: {
              continuationEndpoint: { continuationCommand: { token: "next-page" } },
            },
          },
        ],
      },
    }],
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [{
          entityKey: "k1",
          payload: {
            commentEntityPayload: {
              properties: {
                commentId: "c1",
                content: { content: "modern comment" },
                publishedTime: "2 hours ago",
                replyLevel: 0,
              },
              author: {
                channelId: "UC1",
                displayName: "@alice",
                avatarThumbnailUrl: "https://img/avatar.png",
                isCreator: true,
                isVerified: true,
              },
              toolbar: { likeCountNotliked: "42" },
            },
          },
        }],
      },
    },
  };

  const result = parseCommentsResponse(data);
  assert.equal(result.comments.length, 1);
  const [comment] = result.comments;
  assert.equal(comment.message_id, "c1");
  assert.equal(comment.user_display_name, "alice");
  assert.equal(comment.user_handle, "@alice");
  assert.equal(comment.comment, "modern comment");
  assert.equal(comment.like_count, 42);
  assert.equal(comment.author_is_uploader, true);
  assert.deepEqual(comment.badges, ["Verified"]);
  assert.equal(comment.timestamp, "2 hours ago");
  assert.equal(result.nextToken, "next-page");
  assert.equal(result.sortToken, "newest-token");
  assert.deepEqual(result.replies, [{ parentId: "c1", token: "reply-token" }]);
});

