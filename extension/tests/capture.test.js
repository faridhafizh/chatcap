// End-to-end engine test with a fake YouTube API and fake storage.
// Verifies the polling loop, filtering, dedupe, stop and final flush.
import test from "node:test";
import assert from "node:assert/strict";

import { CaptureEngine } from "../src/background/capture.js";

const htmlResponse = (html) => ({ ok: true, status: 200, text: async () => html });
const jsonResponse = (data) => ({ ok: true, status: 200, json: async () => data });

function watchHtml({ chatToken = "t0", commentToken = "c0", live = true } = {}) {
  const initialData = chatToken
    ? { contents: { liveChatContinuation: { continuationItemRenderer: { continuationCommand: { token: chatToken } } } } }
    : { contents: { commentSectionRenderer: { continuationItemRenderer: { continuationCommand: { token: commentToken } } } } };
  return `
    "INNERTUBE_API_KEY":"AIzaFake","INNERTUBE_CLIENT_VERSION":"2.2026.01.01",
    "isLive":${live ? "true" : "false"},"startTimestamp":"2026-11-19T10:00:00Z",
    var ytInitialData = ${JSON.stringify(initialData)};
  `;
}

const renderer = (id, text) => ({
  id,
  authorName: { simpleText: "@tester" },
  authorExternalChannelId: "UC-TEST",
  timestampUsec: "1763546400000000",
  message: { runs: [{ text }] },
});

function memoryStorage() {
  const sessions = new Map();
  const messages = new Map();
  return {
    sessions, messages,
    createSession: async (meta) => {
      const session = { id: "session-1", ...meta };
      sessions.set(session.id, session);
      return session;
    },
    updateSession: async (id, patch) => {
      sessions.set(id, { ...sessions.get(id), ...patch });
    },
    appendMessages: async (id, batch, startSeq) => {
      messages.set(id, [...(messages.get(id) || []), ...batch.map((m, i) => ({ ...m, seq: startSeq + i }))]);
    },
  };
}

test("live capture polls, filters, dedupes, stops and flushes", async () => {
  let poll = 0;
  const fetchFn = async (url, options) => {
    if (url.includes("/watch?")) return htmlResponse(watchHtml());
    if (url.includes("/youtubei/v1/live_chat/get_live_chat")) {
      poll++;
      const id = `m${poll}`;
      return jsonResponse({
        continuationContents: {
          liveChatContinuation: {
            actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: renderer(id, poll === 1 ? "spam" : "hello world") } } }],
            continuations: [{ continuationCommand: { token: `t${poll}` } }],
          },
        },
        timeoutMs: 1000,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const storage = memoryStorage();
  const events = [];
  let engine;
  const port = {
    postMessage(message) {
      events.push(message);
      if (message.type === "message" && events.filter((m) => m.type === "message").length === 2) {
        engine.stop();
      }
    },
  };
  engine = new CaptureEngine({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "live",
    keywords: ["hello"],
  }, port, { fetchFn, storage });

  await engine.start();

  const delivered = events.filter((e) => e.type === "message").map((e) => e.msg.message_id);
  assert.deepEqual(delivered, ["m2", "m3"]); // poll 1 ("spam") filtered out
  assert.equal(events.at(-2).type, "ended");
  assert.equal(events.at(-2).count, 2);
  assert.equal(events.at(-1).type, "saved");
  assert.equal(events.at(-1).sessionId, "session-1");
  assert.equal(storage.messages.get("session-1").length, 2);
});

test("modern comment capture uses the Newest sort, entities and reply pages", async () => {
  const entity = (key, props, author, toolbar = {}) => ({
    entityKey: key,
    payload: { commentEntityPayload: { properties: props, author, toolbar } },
  });

  const headerPage = {
    onResponseReceivedEndpoints: [{
      reloadContinuationItemsCommand: {
        continuationItems: [{
          commentsHeaderRenderer: {
            sortMenu: {
              sortFilterSubMenuRenderer: {
                subMenuItems: [
                  { title: "Top", selected: true, serviceEndpoint: { continuationCommand: { token: "top-token" } } },
                  { title: "Newest", serviceEndpoint: { continuationCommand: { token: "newest-token" } } },
                ],
              },
            },
          },
        }],
      },
    }],
  };

  const newestPage = {
    onResponseReceivedEndpoints: [
      headerPage.onResponseReceivedEndpoints[0],
      {
        reloadContinuationItemsCommand: {
          continuationItems: [
            {
              commentThreadRenderer: {
                commentViewModel: { commentViewModel: { commentKey: "k1", commentId: "c1" } },
                replies: {
                  commentRepliesRenderer: {
                    contents: [{
                      continuationItemRenderer: {
                        continuationEndpoint: { continuationCommand: { token: "reply-1" } },
                      },
                    }],
                  },
                },
              },
            },
            {
              commentThreadRenderer: {
                commentViewModel: { commentViewModel: { commentKey: "k2", commentId: "c2" } },
              },
            },
            {
              continuationItemRenderer: {
                continuationEndpoint: { continuationCommand: { token: "page-2" } },
              },
            },
          ],
        },
      },
    ],
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [
          entity("k1", { commentId: "c1", content: { content: "top level" }, publishedTime: "2 hours ago" },
            { channelId: "UC1", displayName: "@alice", isCreator: true }, { likeCountNotliked: "42" }),
          entity("k2", { commentId: "c2", content: { content: "second" }, publishedTime: "1 hour ago" },
            { channelId: "UC2", displayName: "@bob" }, { likeCountA11y: "7 likes" }),
        ],
      },
    },
  };

  const replyPage = {
    onResponseReceivedEndpoints: [{
      appendContinuationItemsAction: {
        continuationItems: [{
          commentViewModel: { commentViewModel: { commentKey: "k3", commentId: "r1" } },
        }],
      },
    }],
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [
          entity("k3", { commentId: "r1", content: { content: "a reply" }, publishedTime: "30 minutes ago", replyLevel: 1 },
            { channelId: "UC3", displayName: "@carol" }),
        ],
      },
    },
  };

  const fetchFn = async (url, options) => {
    if (url.includes("/watch?")) return htmlResponse(watchHtml({ chatToken: "" }));
    if (url.includes("/youtubei/v1/next")) {
      const token = JSON.parse(options.body).continuation;
      if (token === "c0") return jsonResponse(headerPage);
      if (token === "newest-token") return jsonResponse(newestPage);
      if (token === "reply-1") return jsonResponse(replyPage);
      return jsonResponse({ onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: [] } }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const storage = memoryStorage();
  const events = [];
  const engine = new CaptureEngine({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "comment",
  }, { postMessage: (m) => events.push(m) }, { fetchFn, storage });

  await engine.start();

  const comments = events.filter((e) => e.type === "message").map((e) => e.msg);
  assert.deepEqual(comments.map((c) => c.message_id), ["c1", "c2", "r1"]);
  assert.equal(comments[0].user_handle, "@alice");
  assert.equal(comments[0].like_count, 42);
  assert.equal(comments[0].author_is_uploader, true);
  assert.equal(comments[1].like_count, 7);
  assert.equal(comments[2].is_reply, true);
  assert.equal(comments[2].parent_id, "c1");
  assert.equal(storage.messages.get("session-1").length, 3);
});

test("comment capture follows reply continuations and ends cleanly", async () => {
  const fetchFn = async (url, options) => {
    if (url.includes("/watch?")) return htmlResponse(watchHtml({ chatToken: "" }));
    if (url.includes("/youtubei/v1/next")) {
      const token = JSON.parse(options.body).continuation;
      if (token === "c0") {
        return jsonResponse({
          onResponseReceivedActions: [{
            appendContinuationItemsAction: {
              continuationItems: [{
                commentRenderer: {
                  commentId: "c1",
                  authorText: { runs: [{ text: "@top" }] },
                  contentText: { runs: [{ text: "top comment" }] },
                  publishedTimeUsec: "1763546400000000",
                  voteCount: { simpleText: "3" },
                  replyButton: { buttonRenderer: { command: { continuationCommand: { token: "r1" } } } },
                },
              }],
            },
          }],
        });
      }
      if (token === "r1") {
        return jsonResponse({
          onResponseReceivedActions: [{
            appendContinuationItemsAction: {
              continuationItems: [
                {
                  commentRenderer: {
                    commentId: "r1msg",
                    authorText: { runs: [{ text: "@replier" }] },
                    contentText: { runs: [{ text: "a reply" }] },
                    publishedTimeUsec: "1763546400000000",
                    voteCount: { simpleText: "1" },
                  },
                },
                {
                  continuationItemRenderer: {
                    button: {
                      buttonRenderer: {
                        text: { runs: [{ text: "Show more replies" }] },
                        command: { continuationCommand: { token: "r2" } },
                      },
                    },
                  },
                },
              ],
            },
          }],
        });
      }
      if (token === "r2") {
        return jsonResponse({
          onResponseReceivedActions: [{
            appendContinuationItemsAction: {
              continuationItems: [{
                commentRenderer: {
                  commentId: "r2msg",
                  authorText: { runs: [{ text: "@second-replier" }] },
                  contentText: { runs: [{ text: "another reply" }] },
                  publishedTimeUsec: "1763546400000000",
                  voteCount: { simpleText: "0" },
                },
              }],
            },
          }],
        });
      }
      return jsonResponse({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [] } }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const storage = memoryStorage();
  const events = [];
  const engine = new CaptureEngine({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    mode: "comment",
  }, { postMessage: (m) => events.push(m) }, { fetchFn, storage });

  await engine.start();

  const comments = events.filter((e) => e.type === "message").map((e) => e.msg);
  assert.equal(comments.length, 3);
  assert.equal(comments[0].message_id, "c1");
  assert.equal(comments[1].message_id, "r1msg");
  assert.equal(comments[1].is_reply, true);
  assert.equal(comments[1].parent_id, "c1");
  assert.equal(comments[2].message_id, "r2msg");
  assert.equal(comments[2].is_reply, true);
  assert.equal(comments[2].parent_id, "c1");
  assert.ok(events.some((e) => e.type === "ended"));
  assert.equal(storage.messages.get("session-1").length, 3);
});
