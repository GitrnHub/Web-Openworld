const MAX_BATCH = 32;
const PAGE_SIZE = 500;
const MAX_PERSISTED_OUTBOX = 512;

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function websocketUrl(apiBase, worldId, after, clientId) {
  const url = new URL(`/api/worlds/${encodeURIComponent(worldId)}/connect`, apiBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('after', String(after));
  url.searchParams.set('clientId', clientId);
  return url.href;
}

export class SharedWorldClient {
  constructor({ apiBase, worldId, flushIntervalMs = 2500, reconnectMaxMs = 15000, applyMutation, onStatus }) {
    this.apiBase = apiBase;
    this.worldId = worldId;
    this.flushIntervalMs = flushIntervalMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.applyMutation = applyMutation;
    this.onStatus = onStatus;
    this.clientId = localStorage.getItem('web-openworld.client-id') || makeId();
    localStorage.setItem('web-openworld.client-id', this.clientId);
    this.storageKey = `web-openworld.outbox.${worldId}`;
    this.outbox = this.restoreOutbox();
    this.optimistic = new Set();
    this.applied = new Set();
    this.lastSequence = 0;
    this.socket = null;
    this.flushTimer = 0;
    this.reconnectTimer = 0;
    this.reconnectDelay = 900;
    this.stopped = false;
    this.online = false;
    this.pagehide = () => this.flushWithKeepalive();
  }

  restoreOutbox() {
    try {
      const events = JSON.parse(localStorage.getItem(this.storageKey) || '[]');
      if (!Array.isArray(events)) return new Map();
      return new Map(events.slice(-MAX_PERSISTED_OUTBOX).filter((event) => event?.eventId && ['impact', 'blast'].includes(event.kind)).map((event) => [event.eventId, event]));
    } catch {
      return new Map();
    }
  }

  persistOutbox() {
    try {
      const events = [...this.outbox.values()].slice(-MAX_PERSISTED_OUTBOX);
      localStorage.setItem(this.storageKey, JSON.stringify(events));
    } catch (error) {
      console.warn('Could not persist the local mutation outbox:', error);
    }
  }

  status(state, detail = '') {
    this.onStatus?.({ state, detail, pending: this.outbox.size, sequence: this.lastSequence });
  }

  async start() {
    if (!this.apiBase) {
      this.status('offline', '等待 Cloudflare 地址');
      return;
    }
    this.stopped = false;
    window.addEventListener('pagehide', this.pagehide);
    this.flushTimer = window.setInterval(() => void this.flush(), this.flushIntervalMs);
    this.status('syncing', '正在读取持久世界');
    try {
      await this.loadHistory();
      // Reapply locally queued mutations that never reached the server before the previous page
      // closed. Their stable event ids make the later server retry idempotent.
      for (const event of this.outbox.values()) {
        if (this.applied.has(event.eventId)) continue;
        this.applyMutation?.({ ...event, id: event.eventId, clientId: this.clientId, seq: 0 });
        this.optimistic.add(event.eventId);
      }
      this.connect();
    } catch (error) {
      console.warn('Initial world sync failed:', error);
      this.status('retrying', 'Cloudflare 暂不可达，本地仍可游玩');
      this.scheduleReconnect();
    }
  }

  stop() {
    this.stopped = true;
    window.removeEventListener('pagehide', this.pagehide);
    window.clearInterval(this.flushTimer);
    window.clearTimeout(this.reconnectTimer);
    this.flushWithKeepalive();
    this.socket?.close(1000, 'page closed');
  }

  queueMutation(mutation) {
    if (!mutation || !['impact', 'blast'].includes(mutation.kind)) return;
    const event = { eventId: makeId(), kind: mutation.kind, payload: mutation.payload };
    this.outbox.set(event.eventId, event);
    this.optimistic.add(event.eventId);
    this.persistOutbox();
    this.status(this.online ? 'online' : 'queued', this.online ? '破坏已排队同步' : '离线排队');
  }

  async requestJson(path, init = {}) {
    const response = await fetch(new URL(path, this.apiBase), { signal: AbortSignal.timeout(7000), ...init });
    if (!response.ok) throw new Error(`World API ${response.status}`);
    return response.json();
  }

  async loadHistory() {
    let hasMore = true;
    while (hasMore && !this.stopped) {
      const path = `/api/worlds/${encodeURIComponent(this.worldId)}/state?after=${this.lastSequence}&limit=${PAGE_SIZE}`;
      const page = await this.requestJson(path, { headers: { Accept: 'application/json' } });
      for (const event of page.events || []) this.receiveEvent(event);
      hasMore = Boolean(page.hasMore);
      if (!page.events?.length) hasMore = false;
    }
  }

  receiveEvent(event) {
    if (!event || !Number.isSafeInteger(event.seq) || this.applied.has(event.id)) return;
    this.lastSequence = Math.max(this.lastSequence, event.seq);
    this.applied.add(event.id);
    if (this.applied.size > 24000) this.applied.clear();
    if (event.clientId === this.clientId && this.optimistic.has(event.id)) {
      this.optimistic.delete(event.id);
      return;
    }
    this.applyMutation?.(event);
  }

  connect() {
    if (this.stopped || !this.apiBase) return;
    window.clearTimeout(this.reconnectTimer);
    const socket = new WebSocket(websocketUrl(this.apiBase, this.worldId, this.lastSequence, this.clientId));
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.online = true;
      this.reconnectDelay = 900;
      this.status('online', '多人世界已连接');
      void this.flush();
    });
    socket.addEventListener('message', (message) => {
      try {
        const packet = JSON.parse(String(message.data));
        if (packet.type === 'welcome' || packet.type === 'batch') {
          for (const event of packet.events || []) this.receiveEvent(event);
          if (!packet.hasMore && Number.isSafeInteger(packet.latestSeq)) this.lastSequence = Math.max(this.lastSequence, packet.latestSeq);
          if (packet.type === 'welcome' && packet.hasMore) {
            this.status('syncing', '正在补齐较长的世界历史');
            void this.loadHistory().then(() => this.status('online', `${packet.players || 1} 人在线`)).catch((error) => {
              console.warn('Welcome history catch-up failed:', error);
              socket.close();
            });
          } else {
            this.status('online', `${packet.players || 1} 人在线`);
          }
        } else if (packet.type === 'ack') {
          for (const id of packet.ids || []) { this.outbox.delete(id); this.optimistic.delete(id); }
          this.persistOutbox();
          this.status('online', '共享状态已保存');
        } else if (packet.type === 'error') {
          console.warn('World API rejected a batch:', packet.message);
          this.status('error', packet.message || '同步数据被拒绝');
        }
      } catch (error) {
        console.warn('Invalid world socket message:', error);
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      this.online = false;
      if (!this.stopped) { this.status('retrying', '连接中断，正在重连'); this.scheduleReconnect(); }
    });
    socket.addEventListener('error', () => socket.close());
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = 0;
      try { await this.loadHistory(); } catch (error) { console.warn('History retry failed:', error); }
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectMaxMs, Math.round(this.reconnectDelay * 1.8));
  }

  pendingBatch() {
    return [...this.outbox.values()].slice(0, MAX_BATCH);
  }

  async flush() {
    const events = this.pendingBatch();
    if (!events.length || !this.apiBase) return;
    const packet = JSON.stringify({ type: 'mutations', clientId: this.clientId, events });
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(packet);
      return;
    }
    try {
      const result = await this.requestJson(`/api/worlds/${encodeURIComponent(this.worldId)}/mutations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: packet,
      });
      for (const id of result.ids || []) { this.outbox.delete(id); this.optimistic.delete(id); }
      this.persistOutbox();
      for (const event of result.events || []) this.receiveEvent(event);
    } catch (error) {
      console.warn('Mutation flush failed:', error);
      this.status('queued', '变更已保留，等待重连');
    }
  }

  flushWithKeepalive() {
    const events = this.pendingBatch();
    if (!events.length || !this.apiBase) return;
    const body = JSON.stringify({ type: 'mutations', clientId: this.clientId, events });
    void fetch(new URL(`/api/worlds/${encodeURIComponent(this.worldId)}/mutations`, this.apiBase), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
    }).catch(() => {});
  }
}
