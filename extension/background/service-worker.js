// Chatcap — Manifest V3 service worker (Phase 2, no Python required).
// Starts/stops the offscreen poller and relays its messages to open panels.
// If an offscreen document cannot be created (older Chrome/Edge builds or a
// restrictive policy), the side panel runs the engine itself as a fallback.

let capturePort = null;
let captureEnded = false;
let closeTimer = null;
let pendingConfig = null;
const panelPorts = new Set();

function configurePanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.warn("Chatcap: panel behavior", err));
  }
}

configurePanel();
chrome.runtime.onInstalled.addListener(configurePanel);

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (chrome.sidePanel?.open && tab?.id) {
      await chrome.sidePanel.open({ tabId: tab.id });
      return;
    }
  } catch (err) {
    console.warn("Chatcap: open panel", err);
  }
  // Browsers without the Side Panel API still get a usable window.
  chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel/panel.html") });
});

function broadcast(message) {
  for (const port of [...panelPorts]) {
    try { port.postMessage(message); }
    catch { panelPorts.delete(port); }
  }
}

const OFFSCREEN_PATH = "offscreen/offscreen.html";
let creatingOffscreen = null;

async function offscreenExists() {
  // runtime.getContexts() (Chrome/Edge 116+) is the reliable check;
  // offscreen.hasDocument() only exists in Chrome 150+.
  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
      });
      return contexts.length > 0;
    } catch {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      return contexts.length > 0;
    }
  }
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  // Last resort: match only the offscreen document URL, never a panel/page.
  const clients = await self.clients.matchAll();
  return clients.some((client) => client.url === chrome.runtime.getURL(OFFSCREEN_PATH));
}

// Returns true when a new document was created, false when one already existed.
async function ensureOffscreen() {
  if (await offscreenExists()) return false;
  if (creatingOffscreen) { await creatingOffscreen; return false; }
  if (!chrome.offscreen?.createDocument) {
    throw new Error("This browser does not support offscreen documents.");
  }

  // "INDEXEDDB" is NOT a valid offscreen Reason (that caused the previous
  // "Error in invocation of offscreen.createDocument"). Try a few valid
  // reasons so Chrome and Edge builds with different enums both work.
  const reasonSets = [["DOM_PARSER"], ["BLOBS"], ["DOM_SCRAPING"], ["WORKERS"]];
  let lastError;
  for (const reasons of reasonSets) {
    try {
      creatingOffscreen = chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons,
        justification: "Poll YouTube chat and store captured messages locally",
      });
      await creatingOffscreen;
      creatingOffscreen = null;
      return true;
    } catch (error) {
      lastError = error;
      creatingOffscreen = null;
      const message = String(error?.message || error);
      if (/single offscreen|already exists|already open/i.test(message)) return false;
      console.warn("Chatcap: offscreen reason rejected", reasons, message);
    }
  }
  throw lastError;
}

async function closeOffscreenSoon(delay = 2000) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    chrome.offscreen?.closeDocument?.().catch(() => {});
  }, delay);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "chatcap-capture") {
    capturePort = port;
    captureEnded = false;
    // The offscreen document can only use chrome.runtime, so the config is
    // handed over through this port (never through chrome.storage).
    if (pendingConfig) {
      try { port.postMessage({ type: "run", config: pendingConfig }); }
      catch (error) { console.warn("Chatcap: config handoff failed", error); }
      pendingConfig = null;
    }
    port.onMessage.addListener((message) => {
      if (message?.type === "ended" || message?.type === "error") captureEnded = true;
      broadcast(message);
      // Free the offscreen document once the capture has fully finished.
      if (message?.type === "saved") closeOffscreenSoon();
    });
    port.onDisconnect.addListener(() => {
      if (capturePort === port) capturePort = null;
      if (!captureEnded) broadcast({ type: "status", text: "Capture worker disconnected." });
    });
  } else if (port.name === "chatcap-panel") {
    panelPorts.add(port);
    port.onDisconnect.addListener(() => panelPorts.delete(port));
  }
});

async function startCapture(config) {
  captureEnded = false;
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  pendingConfig = config;

  let created;
  try {
    created = await ensureOffscreen();
  } catch (error) {
    pendingConfig = null;
    // Never block the user: the panel can poll on its own while it stays open.
    console.warn("Chatcap: offscreen unavailable, using the side panel instead", error);
    return { ok: true, mode: "panel", warning: String(error?.message || error) };
  }

  if (!created && capturePort) {
    try { capturePort.postMessage({ type: "run", config }); pendingConfig = null; }
    catch { capturePort = null; }
  }

  if (!created && !capturePort) {
    // The document survived a service worker restart, so its port is gone.
    try {
      await chrome.runtime.sendMessage({ type: "chatcap:run", config });
      pendingConfig = null;
    } catch (error) {
      console.warn("Chatcap: could not wake the offscreen worker", error);
    }
  }

  return { ok: true, mode: "offscreen" };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  if (type === "chatcap:start") {
    startCapture(message.config).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: String(error?.message || error) });
    });
    return true;
  }

  if (type === "chatcap:stop") {
    if (capturePort) {
      try {
        capturePort.postMessage({ type: "stop" });
        sendResponse({ ok: true });
        return true;
      } catch { /* fall through to a runtime message */ }
    }
    chrome.runtime.sendMessage({ type: "chatcap:stop-offscreen" })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: "No active capture." }));
    return true;
  }

  if (type === "chatcap:close-offscreen") {
    chrome.offscreen?.closeDocument?.().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (type === "chatcap:open-panel") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab && chrome.sidePanel?.open) {
        chrome.sidePanel.open({ tabId: tab.id }).then(() => sendResponse({ ok: true }));
      } else {
        sendResponse({ ok: false });
      }
    });
    return true;
  }

  return false;
});
