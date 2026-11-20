// Chatcap — content script. Runs in an isolated world, so it only reads the
// DOM (never page JS variables). Used to auto-fill the side panel form.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "chatcap:page-info") return;

  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  let videoId = "";
  try {
    videoId = new URL(canonical).searchParams.get("v") || "";
  } catch (_) {
    // location.href was enough; leave videoId empty
  }

  const title = (document.title || "")
    .replace(/\s*-\s*YouTube\s*$/i, "")
    .trim();

  sendResponse({ videoId, title, url: location.href });
  return true;
});
