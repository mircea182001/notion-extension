// background.js — Manifest V3 service worker
// Toggles the side panel open/closed when the extension icon is clicked.

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || (!tab.url.includes("notion.so"))) {
    // Not a Notion page — do nothing (or show a notification)
    return;
  }
  // Send a message to the content script to toggle the panel
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "nss-toggle-panel" });
  } catch (_err) {
    // Content script might not be injected yet; inject it programmatically
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["lib/html2canvas.min.js", "content.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["panel.css"],
    });
    // Retry toggling after injection
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "nss-toggle-panel" });
      } catch (_e) { /* noop */ }
    }, 300);
  }
});
