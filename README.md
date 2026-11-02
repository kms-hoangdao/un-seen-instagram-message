# IG Seen Blocker

A Chrome extension (Manifest V3) that lets you read Instagram messages on the web without sending the "Seen" receipt. It can also hide story views and the typing indicator.

It has no build step, no dependencies, and no background service worker. It is five plain files.

## Features

Every option can be turned on or off from the popup. Changes apply right away, with no page reload.

| Option | Default | What it does |
| --- | --- | --- |
| Hide DM seen (`blockDmSeen`) | On | The sender does not see "Seen" on messages you read |
| Hide story seen (`blockStorySeen`) | Off | You do not appear in a story's viewer list |
| Hide typing (`blockTyping`) | Off | The "…" indicator does not show while you type |
| Console logging (`debug`) | Off | Logs requests to DevTools so you can find new ones to block |

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome, Edge, Brave or another Chromium browser.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the repository folder.
5. Open or reload `https://www.instagram.com/`, then click the extension icon to change the options.

The `world: "MAIN"` content script field needs Chrome 111 or later.

## How it works

```
popup.html / popup.js        bridge.js (ISOLATED world)        inject.js (MAIN world)
  toggles  ──► chrome.storage ──► reads settings ──► CustomEvent 'igsb:settings' ──► patched fetch / XHR / WebSocket
```

Instagram's own code runs in the page's **main world**. A normal content script runs in an **isolated world**: it can use `chrome.storage`, but it cannot change the page's `fetch` or `WebSocket`. So the extension uses two scripts:

- **`bridge.js`** runs in the isolated world. It reads the settings from `chrome.storage.local` and sends them to the page as an `igsb:settings` `CustomEvent`. It sends them again whenever they change.
- **`inject.js`** runs in the main world at `document_start`, before Instagram's code loads. It wraps three network APIs:
  - **`fetch`**: Requests that match a block rule are not sent. The page gets a fake `{"status":"ok"}` reply instead. `window.fetch` is set up with a getter/setter, so if Instagram assigns its own `fetch` later, that function is kept and still wrapped.
  - **`XMLHttpRequest`**: Matching requests are not sent. The XHR is made to look finished (`readyState 4`, `status 200`), and the usual `load` events fire.
  - **`WebSocket`**: Instagram DMs go over MQTT. The script reads outgoing MQTT `PUBLISH` frames. On the `/ls_req` topic it removes the "read" and "typing" tasks from the task list and rebuilds the frame. If no tasks are left, the frame is not sent. Typing frames on the `gateway.instagram.com` DGW socket and the older MQTT topics are dropped too.

### What gets matched

| Rule | GraphQL / HTTP | MQTT `/ls_req` |
| --- | --- | --- |
| DM seen | `fb_api_req_friendly_name` like `MarkThreadRead`, `IGD…Seen`; known `doc_id`s; `/direct_v2/threads/*/items/*/seen` | task label `21` or payload containing `last_read_watermark` |
| Story seen | friendly name like `…StorySeen` / `…ReelSeen`; `/stories/reel/seen` | — |
| Typing | friendly name containing `Typing` / `IndicateActivity`; `/direct_v2/threads/*/activity` | task label `3`, `is_typing`, `indicate_activity` |

## When Instagram changes something

Instagram changes its `doc_id`s, task labels and endpoint names over time, so a rule can stop working. To find the new request:

1. Turn on **Console logging** in the popup.
2. Open DevTools on instagram.com and filter the console by `[IG Seen Blocker]`.
3. Do the action you want to block, such as opening a chat. Look for the `graphql:`, `ls_req tasks:` or `mqtt topic:` lines it causes.
4. Add the new name, `doc_id` or label to the matching constant at the top of `inject.js` (`READ_LABELS`, `TYPING_LABELS`, `DM_SEEN_DOC_IDS`, `DM_SEEN_NAME`, `TYPING_NAME`).
5. Click the reload button for the extension in `chrome://extensions`, then reload Instagram.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest. Registers both content scripts on `https://www.instagram.com/*` |
| `inject.js` | Main-world script that wraps fetch, XHR and WebSocket |
| `bridge.js` | Isolated-world script that sends settings from storage to `inject.js` |
| `popup.html` / `popup.js` | Toggle UI (light/dark aware) that saves to `chrome.storage.local` |

## Limitations

- It only works on the Instagram website (`www.instagram.com`), not the mobile apps.
- If you reply, react, or read the same chat in another app or browser, the "Seen" receipt can still be sent from there.
- The rules are based on watching Instagram's internal traffic. They can break without warning when Instagram ships a new build.
- Use it at your own risk. Changing client traffic may be against Instagram's Terms of Use.

## Privacy

The extension does not collect or send any data. Its only permission is `storage`, which it uses to save your four settings locally.
