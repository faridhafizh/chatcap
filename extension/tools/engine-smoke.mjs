// End-to-end engine smoke test against real YouTube (network required).
// Runs the actual CaptureEngine with in-memory storage — no browser needed.
//
// Usage:
//   node tools/engine-smoke.mjs "https://www.youtube.com/watch?v=..." comment
//   node tools/engine-smoke.mjs "https://www.youtube.com/watch?v=..." live 8
import { CaptureEngine } from "../src/background/capture.js";

const url = process.argv[2];
const mode = process.argv[3] === "live" ? "live" : "comment";
const seconds = Number(process.argv[4] || 8);
if (!url) throw new Error("usage: node tools/engine-smoke.mjs <youtube-url> [comment|live] [seconds]");

const saved = [];
const storage = {
  createSession: async (meta) => ({ id: "smoke-session", ...meta }),
  updateSession: async () => {},
  appendMessages: async (_id, batch) => { saved.push(...batch); },
};

let statusText = "";
const port = {
  postMessage(message) {
    if (message?.type === "status") statusText = message.text;
    if (message?.type === "error") console.error("engine error:", message.message);
    if (message?.type === "ended") console.log("ended:", message.reason, "count:", message.count);
  },
};

const engine = new CaptureEngine({ url, mode }, port, { storage });
const run = engine.start();
if (mode === "live") setTimeout(() => engine.stop(), seconds * 1000);
await run;

console.log(`\n[mode=${mode}] saved messages:`, saved.length);
for (const message of saved.slice(0, 5)) {
  console.log(` - ${message.user_display_name || message.author} | ${message.timestamp || message.datetime || "?"} | ${String(message.comment).slice(0, 70)}`);
}
if (!saved.length) console.log("last status:", statusText);
