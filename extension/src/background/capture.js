// Capture engine for Phase 2. Runs inside the offscreen document so polling
// continues even when the side panel is closed. No Python involved.

import {
  validateUrl, extractVideoId, fetchWatchPage, getLiveChat, getCommentsPage,
  parseLiveChatResponse, parseCommentsResponse, findChatContinuation,
  findCommentContinuation,
} from "../core/innertube.js";
import { makeFilter } from "../core/filter.js";
import * as defaultStorage from "../storage/db.js";

export class CaptureEngine {
  constructor(config, port, deps = {}) {
    this.config = config;
    this.port = port;
    this.storage = deps.storage || defaultStorage;
    this.fetchFn = deps.fetchFn || fetch;
    this.stopped = false;
    this.reason = "";
    this.seen = new Set();
    this.buffer = [];
    this.seq = 0;
    this.count = 0;
    this.lastFlush = 0;
    this.waiters = new Set();
    this.session = null;
    this.videoId = "";
    this.filter = makeFilter(config.keywords || [], config.users || []);
  }

  emit(message) {
    try { this.port?.postMessage(message); }
    catch { /* panel or service worker is not listening right now */ }
  }

  wait(ms) {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const entry = {
        done: () => {
          clearTimeout(entry.id);
          this.waiters.delete(entry);
          resolve(!this.stopped);
        },
      };
      entry.id = setTimeout(entry.done, ms);
      this.waiters.add(entry);
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const waiter of [...this.waiters]) waiter.done();
    this.emit({ type: "status", text: "Stopping…" });
  }

  async flush(force = false) {
    if (!this.session || !this.buffer.length) return;
    const now = Date.now();
    if (!force && now - this.lastFlush < 1000) return;
    const batch = this.buffer.splice(0);
    await this.storage.appendMessages(this.session.id, batch, this.seq);
    this.seq += batch.length;
    this.lastFlush = now;
    await this.storage.updateSession(this.session.id, { count: this.count });
  }

  accept(msg) {
    if (this.stopped || !this.filter(msg)) return false;
    const mid = msg.message_id;
    if (mid && this.seen.has(mid)) return false;
    if (mid) this.seen.add(mid);
    this.buffer.push(msg);
    this.count++;
    this.emit({ type: "message", msg, count: this.count });
    return true;
  }

  async start() {
    try {
      if (!validateUrl(this.config.url)) throw new Error("Only YouTube URLs are supported");
      this.videoId = extractVideoId(this.config.url);
      if (!this.videoId) throw new Error("Could not find a video id in the URL");

      this.session = await this.storage.createSession({
        url: this.config.url,
        mode: this.config.mode,
        output: this.config.output || `chatcap-${this.videoId}`,
      });
      this.emit({
        type: "status",
        text: this.config.mode === "comment" ? "Scraping comments…" : "Connecting to live chat…",
      });

      const page = await fetchWatchPage(this.videoId, this.fetchFn);
      if (!page.apiKey) throw new Error("Could not extract the YouTube API key");
      if (this.config.mode === "comment") await this.captureComments(page);
      else await this.captureChat(page);
    } catch (error) {
      if (!this.stopped) {
        this.emit({ type: "error", message: error?.message || String(error) });
        this.reason = `Error: ${error?.message || error}`;
      }
    } finally {
      try { await this.flush(true); }
      catch (error) { this.emit({ type: "error", message: `Save failed: ${error.message}` }); }
      if (this.session) {
        await this.storage.updateSession(this.session.id, {
          count: this.count,
          status: this.reason.startsWith("Error") ? "error" : "done",
          finishedAt: new Date().toISOString(),
        }).catch(() => {});
      }
      this.emit({ type: "ended", reason: this.reason || (this.stopped ? "Stopped by user." : "Done."), count: this.count });
      this.emit({ type: "saved", sessionId: this.session?.id || "", count: this.count });
    }
  }

  async captureChat(page) {
    let token = findChatContinuation(page.initialData);
    if (!token) throw new Error("No live-chat continuation found — try Comments mode");
    let isLive = page.isLive;
    const args = { apiKey: page.apiKey, clientVersion: page.clientVersion };

    let data;
    try {
      data = await getLiveChat({ ...args, token, replay: !isLive, fetchFn: this.fetchFn });
    } catch (error) {
      if (error.status !== 400) throw error;
      isLive = !isLive; // mirror the CLI's live/replay fallback
      data = await getLiveChat({ ...args, token, replay: !isLive, fetchFn: this.fetchFn });
    }

    let idlePolls = 0;
    const seenTokens = new Set();
    while (!this.stopped) {
      const { messages, nextToken, timeoutMs } = parseLiveChatResponse(
        data, isLive ? page.streamStartMs : null,
      );
      for (const message of messages) this.accept(message);

      if (!nextToken) {
        if (!isLive) { this.reason = "End of replay."; break; }
        idlePolls++;
        if (idlePolls >= 5) {
          try {
            const fresh = await fetchWatchPage(this.videoId, this.fetchFn);
            const refresh = findChatContinuation(fresh.initialData);
            if (refresh) token = refresh;
            idlePolls = 0;
          } catch { /* keep polling the old token */ }
        }
        if (!(await this.wait(5000))) break;
        try {
          const fresh = await fetchWatchPage(this.videoId, this.fetchFn);
          token = findChatContinuation(fresh.initialData) || token;
          data = await getLiveChat({ ...args, token, replay: !isLive, fetchFn: this.fetchFn });
        } catch (error) {
          this.emit({ type: "status", text: `Retrying: ${error.message}` });
          if (!(await this.wait(10000))) break;
          data = {};
        }
        continue;
      }

      token = nextToken;
      idlePolls = 0;
      if (!isLive && seenTokens.has(token)) { this.reason = "End of replay."; break; }
      seenTokens.add(token);

      const delay = isLive ? Math.min(5000, Math.max(1000, timeoutMs || 1000)) : 80;
      if (!(await this.wait(delay))) break;
      try {
        data = await getLiveChat({ ...args, token, replay: !isLive, fetchFn: this.fetchFn });
      } catch (error) {
        if (!isLive) throw error;
        this.emit({ type: "status", text: `Retrying after error: ${error.message}` });
        if (!(await this.wait(10000))) break;
        data = {};
      }
    }
  }

  async captureComments(page) {
    const initial = findCommentContinuation(page.initialData);
    if (!initial) throw new Error("No comments found — they may be disabled");
    const args = { apiKey: page.apiKey, clientVersion: page.clientVersion };
    const seenTokens = new Set();
    let token = initial;
    let firstPage = true;

    while (!this.stopped && token) {
      if (seenTokens.has(token)) break;
      seenTokens.add(token);
      let data = await getCommentsPage({ ...args, token, fetchFn: this.fetchFn });

      // The watch page starts on the "Top" sort, which only returns featured
      // comments and no pagination. Switch to "Newest" once so we get the
      // full, chronological thread like the Python CLI did.
      if (firstPage) {
        firstPage = false;
        const { sortToken } = parseCommentsResponse(data);
        if (sortToken && sortToken !== token && !seenTokens.has(sortToken)) {
          token = sortToken;
          seenTokens.add(sortToken);
          data = await getCommentsPage({ ...args, token, fetchFn: this.fetchFn });
        }
      }

      const { comments, nextToken, replies } = parseCommentsResponse(data);
      for (const comment of comments) {
        if (this.stopped) break;
        this.accept(comment);
      }

      for (const reply of replies) {
        let replyToken = reply.token;
        let replyPages = 0;
        while (!this.stopped && replyToken && !seenTokens.has(replyToken) && replyPages < 100) {
          seenTokens.add(replyToken);
          replyPages++;
          try {
            const replyPage = await getCommentsPage({
              ...args, token: replyToken, fetchFn: this.fetchFn,
            });
            const replyResult = parseCommentsResponse(replyPage, reply.parentId);
            for (const message of replyResult.comments) this.accept(message);
            replyToken = replyResult.nextToken;
          } catch (error) {
            this.emit({ type: "status", text: `Could not load replies: ${error.message}` });
            break;
          }
        }
      }

      token = nextToken;
      if (!this.stopped) await this.wait(50);
    }
    this.reason ||= "Comments finished.";
  }
}
