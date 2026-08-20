import { DurableObject } from 'cloudflare:workers';

const MAX_BATCH = 32;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HISTORY_PAGE = 1000;
const WORLD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EVENT_ID_PATTERN = /^[a-zA-Z0-9-]{8,80}$/;
const BODY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

type MutationKind = 'impact' | 'blast';
type Vector3Tuple = [number, number, number];

interface ImpactPayload {
  bodyId: string;
  point: Vector3Tuple;
  direction: Vector3Tuple;
  speed: number;
}

interface BlastPayload {
  point: Vector3Tuple;
  blastRadius: number;
  craterRadius: number;
  craterDepth: number;
}

type MutationPayload = ImpactPayload | BlastPayload;

interface MutationInput {
  eventId: string;
  kind: MutationKind;
  payload: MutationPayload;
}

interface StoredMutation {
  id: string;
  seq: number;
  clientId: string;
  kind: MutationKind;
  payload: MutationPayload;
  createdAt: number;
}

interface MutationPacket {
  type: 'mutations';
  clientId: string;
  events: MutationInput[];
}

interface HistoryPage {
  events: StoredMutation[];
  latestSeq: number;
  hasMore: boolean;
}

interface AppendResult {
  ids: string[];
  events: StoredMutation[];
  latestSeq: number;
}

interface SocketAttachment {
  clientId: string;
  connectedAt: number;
}

interface EventRow extends Record<string, SqlStorageValue> {
  seq: number;
  event_id: string;
  client_id: string;
  kind: string;
  payload: string;
  created_at: number;
}

interface LatestRow extends Record<string, SqlStorageValue> {
  latest: number;
}

interface Env {
  WORLD_STATE: DurableObjectNamespace<WorldState>;
  ALLOWED_ORIGINS: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  return isRecord(value) && typeof value.clientId === 'string' && EVENT_ID_PATTERN.test(value.clientId) && typeof value.connectedAt === 'number';
}

function isFiniteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isVector3(value: unknown, maxMagnitude = 100_000): value is Vector3Tuple {
  return Array.isArray(value) && value.length === 3 && value.every((item) => isFiniteNumber(item, -maxMagnitude, maxMagnitude));
}

function parseMutation(value: unknown): MutationInput | null {
  if (!isRecord(value) || typeof value.eventId !== 'string' || !EVENT_ID_PATTERN.test(value.eventId)) return null;
  if (value.kind === 'impact' && isRecord(value.payload)) {
    const payload = value.payload;
    if (typeof payload.bodyId !== 'string' || !BODY_ID_PATTERN.test(payload.bodyId)) return null;
    if (!isVector3(payload.point) || !isVector3(payload.direction, 2) || !isFiniteNumber(payload.speed, 0, 260)) return null;
    return { eventId: value.eventId, kind: 'impact', payload: { bodyId: payload.bodyId, point: payload.point, direction: payload.direction, speed: payload.speed } };
  }
  if (value.kind === 'blast' && isRecord(value.payload)) {
    const payload = value.payload;
    if (!isVector3(payload.point)) return null;
    if (!isFiniteNumber(payload.blastRadius, 1, 18) || !isFiniteNumber(payload.craterRadius, 0.5, 18) || !isFiniteNumber(payload.craterDepth, 0.1, 9)) return null;
    return { eventId: value.eventId, kind: 'blast', payload: { point: payload.point, blastRadius: payload.blastRadius, craterRadius: payload.craterRadius, craterDepth: payload.craterDepth } };
  }
  return null;
}

function parsePacket(value: unknown): MutationPacket | null {
  if (!isRecord(value) || value.type !== 'mutations' || typeof value.clientId !== 'string' || !EVENT_ID_PATTERN.test(value.clientId)) return null;
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > MAX_BATCH) return null;
  const events: MutationInput[] = [];
  for (const candidate of value.events) {
    const event = parseMutation(candidate);
    if (!event) return null;
    events.push(event);
  }
  return { type: 'mutations', clientId: value.clientId, events };
}

function parseStoredPayload(kind: string, value: string): MutationPayload | null {
  try {
    const parsed: unknown = JSON.parse(value);
    const candidate = parseMutation({ eventId: 'stored-event', kind, payload: parsed });
    return candidate?.payload ?? null;
  } catch {
    return null;
  }
}

function rowToMutation(row: EventRow): StoredMutation | null {
  if (row.kind !== 'impact' && row.kind !== 'blast') return null;
  const payload = parseStoredPayload(row.kind, row.payload);
  if (!payload) return null;
  return { id: row.event_id, seq: row.seq, clientId: row.client_id, kind: row.kind, payload, createdAt: row.created_at };
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}

function allowedOrigins(env: Env): Set<string> {
  return new Set(env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean));
}

function corsHeaders(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function readJsonBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) throw new Error('Payload too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('Payload too large');
  return JSON.parse(text) as unknown;
}

export class WorldState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS world_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          client_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('impact', 'blast')),
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS world_events_created_at ON world_events(created_at);
      `);
    });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private latestSequence(): number {
    return this.ctx.storage.sql.exec<LatestRow>('SELECT COALESCE(MAX(seq), 0) AS latest FROM world_events').one().latest;
  }

  async getEvents(after = 0, limit = 500): Promise<HistoryPage> {
    const safeAfter = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const safeLimit = clampInteger(limit, 1, MAX_HISTORY_PAGE, 500);
    const rows = this.ctx.storage.sql.exec<EventRow>(
      'SELECT seq, event_id, client_id, kind, payload, created_at FROM world_events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
      safeAfter, safeLimit + 1,
    ).toArray();
    const hasMore = rows.length > safeLimit;
    const events = rows.slice(0, safeLimit).map(rowToMutation).filter((event): event is StoredMutation => event !== null);
    return { events, latestSeq: this.latestSequence(), hasMore };
  }

  async appendMutations(clientId: string, candidates: unknown[]): Promise<AppendResult> {
    const packet = parsePacket({ type: 'mutations', clientId, events: candidates });
    if (!packet) throw new Error('Invalid mutation batch');
    const createdAt = Date.now();
    const inserted: StoredMutation[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const event of packet.events) {
        const rows = this.ctx.storage.sql.exec<EventRow>(
          `INSERT INTO world_events(event_id, client_id, kind, payload, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO NOTHING
           RETURNING seq, event_id, client_id, kind, payload, created_at`,
          event.eventId, packet.clientId, event.kind, JSON.stringify(event.payload), createdAt,
        ).toArray();
        const row = rows[0];
        if (!row) continue;
        const stored = rowToMutation(row);
        if (stored) inserted.push(stored);
      }
    });
    // Explicitly flush the SQLite output gate before any live client sees the mutation.
    await this.ctx.storage.sync();
    const latestSeq = this.latestSequence();
    if (inserted.length) this.broadcast({ type: 'batch', events: inserted, latestSeq, players: this.ctx.getWebSockets().length });
    console.log(JSON.stringify({ event: 'mutations_persisted', clientId: packet.clientId, inserted: inserted.length, latestSeq }));
    return { ids: packet.events.map((event) => event.eventId), events: inserted, latestSeq };
  }

  private broadcast(packet: unknown): void {
    const message = JSON.stringify(packet);
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch { socket.close(1011, 'broadcast failed'); }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const url = new URL(request.url);
    const after = clampInteger(Number(url.searchParams.get('after')), 0, Number.MAX_SAFE_INTEGER, 0);
    const clientId = url.searchParams.get('clientId') || '';
    if (!EVENT_ID_PATTERN.test(clientId)) return new Response('Invalid client id', { status: 400 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.serializeAttachment({ clientId, connectedAt: Date.now() } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server, [`client:${clientId}`]);
    const page = await this.getEvents(after, MAX_HISTORY_PAGE);
    server.send(JSON.stringify({ type: 'welcome', ...page, players: this.ctx.getWebSockets().length }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_BODY_BYTES) {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
      return;
    }
    try {
      const value: unknown = JSON.parse(message);
      const packet = parsePacket(value);
      if (!packet) throw new Error('Invalid mutation batch');
      const attachment: unknown = socket.deserializeAttachment();
      if (!isSocketAttachment(attachment) || packet.clientId !== attachment.clientId) throw new Error('Client id mismatch');
      const result = await this.appendMutations(packet.clientId, packet.events);
      socket.send(JSON.stringify({ type: 'ack', ids: result.ids, latestSeq: result.latestSeq }));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Invalid request';
      socket.send(JSON.stringify({ type: 'error', message: messageText }));
    }
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
    this.broadcast({ type: 'presence', players: this.ctx.getWebSockets().length });
  }

  override webSocketError(socket: WebSocket): void {
    socket.close(1011, 'socket error');
  }
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'web-openworld-state' });

    const match = url.pathname.match(/^\/api\/worlds\/([^/]+)\/(state|mutations|connect)$/);
    if (!match) return json({ error: 'Not found' }, 404);
    let worldId = '';
    try { worldId = decodeURIComponent(match[1] || ''); } catch { return json({ error: 'Invalid world id' }, 400); }
    const action = match[2];
    if (!WORLD_ID_PATTERN.test(worldId)) return json({ error: 'Invalid world id' }, 400);

    const origin = request.headers.get('Origin') || '';
    if (!origin || !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const stub = env.WORLD_STATE.getByName(`world:${worldId}`);
    if (action === 'connect') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, corsHeaders(origin));
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Expected WebSocket' }, 426, corsHeaders(origin));
      return stub.fetch(request);
    }

    try {
      if (action === 'state' && request.method === 'GET') {
        const after = clampInteger(Number(url.searchParams.get('after')), 0, Number.MAX_SAFE_INTEGER, 0);
        const limit = clampInteger(Number(url.searchParams.get('limit')), 1, MAX_HISTORY_PAGE, 500);
        return json(await stub.getEvents(after, limit), 200, corsHeaders(origin));
      }
      if (action === 'mutations' && request.method === 'POST') {
        const value = await readJsonBody(request);
        const packet = parsePacket(value);
        if (!packet) return json({ error: 'Invalid mutation batch' }, 400, corsHeaders(origin));
        return json(await stub.appendMutations(packet.clientId, packet.events), 200, corsHeaders(origin));
      }
      return json({ error: 'Method not allowed' }, 405, corsHeaders(origin));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal error';
      console.error(JSON.stringify({ event: 'request_failed', worldId, action, message }));
      return json({ error: message }, message === 'Payload too large' ? 413 : 500, corsHeaders(origin));
    }
  },
} satisfies ExportedHandler<Env>;
