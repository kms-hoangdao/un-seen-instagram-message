// Chạy ở ISOLATED world: có chrome.storage, chuyển settings sang MAIN world qua CustomEvent.
const DEFAULTS = { blockDmSeen: true, blockStorySeen: false, blockTyping: false, debug: false };

function push(settings) {
  window.dispatchEvent(new CustomEvent('igsb:settings', { detail: JSON.stringify(settings) }));
}

chrome.storage.local.get(DEFAULTS, push);
chrome.storage.onChanged.addListener(() => chrome.storage.local.get(DEFAULTS, push));
