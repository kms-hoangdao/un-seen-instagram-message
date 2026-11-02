const DEFAULTS = { blockDmSeen: true, blockStorySeen: false, blockTyping: false, debug: false };

chrome.storage.local.get(DEFAULTS, (settings) => {
  for (const [key, value] of Object.entries(settings)) {
    const input = document.getElementById(key);
    if (!input) continue;
    input.checked = value;
    input.addEventListener('change', () => chrome.storage.local.set({ [key]: input.checked }));
  }
});
