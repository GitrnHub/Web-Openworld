import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://gitrnhub.github.io';
const WORLD_URL = `https://worker.test/api/worlds/safehouse-test-${crypto.randomUUID()}`;

function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Origin', ORIGIN);
  return exports.default.fetch(`${WORLD_URL}/${path}`, { ...init, headers });
}

function collectPackets(socket: WebSocket, count: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const packets: Array<Record<string, unknown>> = [];
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket packets')), 3000);
    const onMessage = (event: MessageEvent) => {
      try {
        packets.push(JSON.parse(String(event.data)) as Record<string, unknown>);
        if (packets.length < count) return;
        clearTimeout(timeout);
        socket.removeEventListener('message', onMessage);
        resolve(packets);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    };
    socket.addEventListener('message', onMessage);
  });
}

async function connect(clientId: string): Promise<WebSocket> {
  const response = await request(`connect?after=0&clientId=${clientId}`, { headers: { Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error('Expected WebSocket response');
  socket.accept();
  expect((await collectPackets(socket, 1))[0]).toEqual(expect.objectContaining({ type: 'welcome' }));
  return socket;
}

describe('shared world state', () => {
  it('persists a batch, deduplicates event ids, and paginates by sequence', async () => {
    const event = {
      eventId: 'test-event-0001',
      kind: 'blast',
      payload: { point: [12, 0, -8], blastRadius: 6.2, craterRadius: 6.6, craterDepth: 2.8 },
    };
    const packet = { type: 'mutations', clientId: 'test-client-0001', events: [event] };

    const created = await request('mutations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(packet),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ ids: string[]; events: Array<{ id: string; seq: number }> }>();
    expect(createdBody.ids).toEqual([event.eventId]);
    expect(createdBody.events).toHaveLength(1);
    const sequence = createdBody.events[0]?.seq;
    expect(sequence).toBeTypeOf('number');

    const duplicate = await request('mutations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(packet),
    });
    const duplicateBody = await duplicate.json<{ events: unknown[] }>();
    expect(duplicate.status).toBe(200);
    expect(duplicateBody.events).toEqual([]);

    const state = await request('state?after=0&limit=10');
    const stateBody = await state.json<{ events: Array<{ id: string; kind: string }>; latestSeq: number; hasMore: boolean }>();
    expect(state.status).toBe(200);
    expect(stateBody.events).toEqual([expect.objectContaining({ id: event.eventId, kind: 'blast' })]);
    expect(stateBody.latestSeq).toBe(sequence);
    expect(stateBody.hasMore).toBe(false);

    const noNewEvents = await request(`state?after=${sequence}&limit=10`);
    expect((await noNewEvents.json<{ events: unknown[] }>()).events).toEqual([]);
  });

  it('rejects invalid origins and malformed mutations', async () => {
    const forbidden = await exports.default.fetch(`${WORLD_URL}/state?after=0`, { headers: { Origin: 'https://evil.example' } });
    expect(forbidden.status).toBe(403);

    const malformed = await request('mutations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'mutations', clientId: 'test-client-0002', events: [{ eventId: 'too-short', kind: 'blast', payload: { point: [0, 0, 0] } }] }),
    });
    expect(malformed.status).toBe(400);
  });

  it('broadcasts persisted mutations and acknowledges the sender over WebSocket', async () => {
    const sender = await connect('test-client-ws01');
    const receiver = await connect('test-client-ws02');
    const senderPackets = collectPackets(sender, 2);
    const receiverPackets = collectPackets(receiver, 1);

    sender.send(JSON.stringify({
      type: 'mutations',
      clientId: 'test-client-ws01',
      events: [{
        eventId: 'test-event-ws01',
        kind: 'impact',
        payload: { bodyId: 'lobby-desk', point: [0, 1, 0], direction: [0, 0, -1], speed: 42 },
      }],
    }));

    const sent = await senderPackets;
    const received = await receiverPackets;
    expect(sent.map((packet) => packet.type)).toEqual(expect.arrayContaining(['batch', 'ack']));
    expect(received[0]).toEqual(expect.objectContaining({ type: 'batch' }));
    sender.close(1000, 'test complete');
    receiver.close(1000, 'test complete');
  });
});
