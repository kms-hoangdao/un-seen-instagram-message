// Chạy ở MAIN world (cùng context với code Instagram) để patch fetch / XHR / WebSocket.
(() => {
  const settings = { blockDmSeen: true, blockStorySeen: false, blockTyping: false, debug: false };
  window.addEventListener('igsb:settings', (e) => {
    try { Object.assign(settings, JSON.parse(e.detail)); } catch {}
  });

  const log = (...args) =>
    settings.debug && console.log('%c[IG Seen Blocker]', 'color:#e1306c;font-weight:bold', ...args);

  // ---------- Nhận diện request cần chặn ----------

  // Task trong LightSpeed (MQTT /ls_req). Label có thể đổi theo thời gian,
  // nên kiểm tra thêm theo nội dung payload cho chắc.
  const READ_LABELS = new Set(['21']);
  const TYPING_LABELS = new Set(['3']);

  function isBlockedTask(task) {
    const label = String(task?.label ?? '');
    const body = typeof task?.payload === 'string' ? task.payload : JSON.stringify(task?.payload ?? '');
    if (settings.blockDmSeen && (READ_LABELS.has(label) || body.includes('last_read_watermark'))) return 'dm-seen';
    if (settings.blockTyping && (TYPING_LABELS.has(label) || body.includes('is_typing'))) return 'typing';
    return null;
  }

  function friendlyName(body) {
    const m = /fb_api_req_friendly_name=([^&]+)/.exec(body);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // doc_id đổi theo mỗi bản build của Instagram, chỉ dùng làm phương án dự phòng.
  const DM_SEEN_DOC_IDS = new Set(['27399783383056109']);
  const DM_SEEN_NAME = /(MarkThread\w*Read|IGD\w*Seen|Direct\w*(Seen|MarkRead))/i;

  const TYPING_NAME = /(Typing|IndicateActivity|ActivityIndicator)/i;

  function docId(body) {
    const m = /(?:^|&)doc_id=(\d+)/.exec(body);
    return m ? m[1] : '';
  }

  function matchHttp(url, body) {
    if (url.includes('/graphql')) {
      const name = friendlyName(body);
      if (name) log('graphql:', name, docId(body));
      if (settings.blockStorySeen && /(Story|Stories|Reel)\w*Seen/i.test(name)) return 'story-seen';
      if (settings.blockDmSeen && (DM_SEEN_NAME.test(name) || DM_SEEN_DOC_IDS.has(docId(body)))) return 'dm-seen';
      if (settings.blockTyping && TYPING_NAME.test(name)) return 'typing';
    }
    if (settings.blockTyping && /\/direct_v2\/threads\/[^/]+\/(activity|indicate_activity)\/?/.test(url)) return 'typing';
    if (settings.blockDmSeen && /\/direct_v2\/threads\/[^/]+\/items\/[^/]+\/seen\/?/.test(url)) return 'dm-seen';
    if (settings.blockStorySeen && /\/stories\/reel\/seen/.test(url)) return 'story-seen';
    return null;
  }

  function bodyToString(body) {
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) return [...body.entries()].map(([k, v]) => `${k}=${v}`).join('&');
    return '';
  }

  const FAKE_OK = '{"status":"ok"}';

  // ---------- fetch ----------
  // Instagram có thể gán lại window.fetch sau khi trang tải, nên dùng getter/setter:
  // nếu nó gán hàm mới, ta lưu lại làm "hàm thật" và vẫn bọc bằng lớp chặn của mình.
  let realFetch = window.fetch;
  const wrappedFetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const rule = matchHttp(url, bodyToString(init?.body));
    if (rule) {
      log(`Chặn fetch (${rule})`, url);
      return Promise.resolve(new Response(FAKE_OK, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch.apply(this, arguments);
  };
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    get: () => wrappedFetch,
    set: (fn) => {
      if (typeof fn === 'function' && fn !== wrappedFetch) {
        log('Instagram gán lại fetch, đã bọc lại');
        realFetch = fn;
      }
    },
  });

  // ---------- XMLHttpRequest ----------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__igsbUrl = String(url);
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const rule = matchHttp(this.__igsbUrl || '', bodyToString(body));
    if (!rule) return origSend.apply(this, arguments);

    log(`Chặn XHR (${rule})`, this.__igsbUrl);
    Object.defineProperties(this, {
      readyState: { value: 4 },
      status: { value: 200 },
      statusText: { value: 'OK' },
      responseText: { value: FAKE_OK },
      response: { value: FAKE_OK },
    });
    setTimeout(() => {
      for (const type of ['readystatechange', 'load', 'loadend']) this.dispatchEvent(new Event(type));
    }, 0);
  };

  // ---------- WebSocket (MQTT) ----------
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function parsePublish(bytes) {
    if (bytes.length < 4 || bytes[0] >> 4 !== 3) return null; // 3 = PUBLISH
    const header = bytes[0];
    const qos = (header >> 1) & 3;
    let i = 1, mult = 1, b;
    do { b = bytes[i++]; mult *= 128; } while (b & 128 && i < 5);
    const topicLen = (bytes[i] << 8) | bytes[i + 1];
    i += 2;
    const topic = dec.decode(bytes.subarray(i, i + topicLen));
    i += topicLen;
    let packetId = null;
    if (qos > 0) { packetId = bytes.slice(i, i + 2); i += 2; }
    return { header, topic, packetId, payload: dec.decode(bytes.subarray(i)) };
  }

  function buildPublish({ header, topic, packetId, payload }) {
    const t = enc.encode(topic);
    const p = enc.encode(payload);
    const remaining = 2 + t.length + (packetId ? 2 : 0) + p.length;
    const lenBytes = [];
    let x = remaining;
    do {
      let byte = x % 128;
      x = Math.floor(x / 128);
      if (x > 0) byte |= 128;
      lenBytes.push(byte);
    } while (x > 0);

    const out = new Uint8Array(1 + lenBytes.length + remaining);
    let i = 0;
    out[i++] = header;
    out.set(lenBytes, i); i += lenBytes.length;
    out[i++] = t.length >> 8;
    out[i++] = t.length & 255;
    out.set(t, i); i += t.length;
    if (packetId) { out.set(packetId, i); i += 2; }
    out.set(p, i);
    return out.buffer;
  }

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null; // string / Blob: bỏ qua
  }

  // Trả về: data gốc (không đổi), frame mới (đã lọc bớt task), hoặc null (bỏ hẳn frame).
  function filterFrame(data) {
    const bytes = toBytes(data);
    if (!bytes) {
      log('ws frame không phải binary:', typeof data === 'string' ? data.slice(0, 300) : data);
      if (settings.blockTyping && typeof data === 'string' && /"(activity_status|is_typing)"/.test(data)) {
        log('Chặn typing (ws string)');
        return null;
      }
      return data;
    }
    // Socket gateway.instagram.com/ws/mqttbypass bọc MQTT trong frame DGW riêng,
    // nên không parse header mà kiểm tra thẳng nội dung JSON bên trong.
    if (settings.blockTyping) {
      const text = dec.decode(bytes);
      if (text.includes('"action":"indicate_activity"')) {
        log('Chặn typing (DGW)', /"activity_status":(\d)/.exec(text)?.[1] === '1' ? 'bắt đầu gõ' : 'ngừng gõ');
        return null;
      }
    }

    const pkt = parsePublish(bytes);
    if (!pkt) return data;
    if (pkt.topic !== '/ls_req') {
      log('mqtt topic:', pkt.topic, pkt.payload.slice(0, 300));
      // Kênh MQTT kiểu cũ của Instagram gửi typing thành frame riêng với activity_status / is_typing
      if (settings.blockTyping && /"(activity_status|is_typing)"/.test(pkt.payload)) {
        log(`Chặn typing qua topic ${pkt.topic}`);
        return null;
      }
      return data;
    }

    const outer = JSON.parse(pkt.payload);
    if (typeof outer.payload !== 'string') return data;
    const inner = JSON.parse(outer.payload);

    // Dạng 1: nhiều task gộp chung
    if (Array.isArray(inner.tasks)) {
      log('ls_req tasks:', inner.tasks.map((t) => ({ label: t.label, payload: t.payload })));
      const kept = inner.tasks.filter((t) => {
        const rule = isBlockedTask(t);
        if (rule) log(`Chặn task ${t.label} (${rule})`);
        return !rule;
      });
      if (kept.length === inner.tasks.length) return data;
      if (kept.length === 0) return null;
      inner.tasks = kept;
      outer.payload = JSON.stringify(inner);
      return buildPublish({ ...pkt, payload: JSON.stringify(outer) });
    }

    // Dạng 2: một task đơn (thường là typing indicator)
    if (inner.label != null) {
      log('ls_req single:', inner.label, inner.payload);
      const rule = isBlockedTask(inner);
      if (rule) { log(`Chặn task ${inner.label} (${rule})`); return null; }
    }
    return data;
  }

  const origWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    let out = data;
    try {
      out = filterFrame(data);
    } catch (err) {
      log('Không parse được frame, gửi nguyên bản', err);
      out = data;
    }
    if (out === null) return;
    return origWsSend.call(this, out);
  };

  log('Đã khởi động');
})();
