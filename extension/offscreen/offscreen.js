// Offscreen document: long-lived polling worker. Created on demand by the
// service worker, so capture keeps running while the side panel is closed.
//
// Offscreen documents may only use the chrome.runtime API — chrome.storage and
// chrome.offscreen are NOT available here. The config arrives over the port
// that is opened below; the service worker closes this document when done.

import { CaptureEngine } from "../src/background/capture.js";

let engine = null;
let running = false;
let port = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

// A stable handle for the engine: it always writes to the current port, so a
// service worker restart does not break progress reporting.
const channel = {
  postMessage(message) {
    try { port?.postMessage(message); }
    catch { /* the service worker is restarting */ }
  },
};

function begin(config) {
  if (running || !config) return;
  running = true;
  engine = new CaptureEngine(config, channel);
  engine.start().catch((error) => {
    console.error("Chatcap: capture crashed", error);
  }).finally(() => {
    running = false;
    engine = null;
  });
}

function stop() {
  engine?.stop();
}

function handleMessage(message) {
  if (message?.type === "run") begin(message.config);
  else if (message?.type === "stop") stop();
}

function connect() {
  try {
    port = chrome.runtime.connect({ name: "chatcap-capture" });
  } catch (error) {
    console.warn("Chatcap: could not connect to the service worker", error);
    return;
  }
  reconnectAttempts = 0;
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // The service worker was stopped after being idle. Reconnect so capture
    // progress and the Stop button keep working.
    if (reconnectAttempts >= 10) return;
    reconnectAttempts++;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 500);
  });
}

connect();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "chatcap:run") {
    begin(message.config);
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "chatcap:stop-offscreen") {
    stop();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
