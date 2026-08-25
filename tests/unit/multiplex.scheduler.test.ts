import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableInbox } from '../../src/multiplex/durable-inbox.js';
import { RouteScheduler } from '../../src/multiplex/route-scheduler.js';
import type { ServerFrame } from '../../src/multiplex/protocol.js';

const directories: string[] = [];
async function createInbox() {
    const directory = await mkdtemp(join(tmpdir(), 'wa-multiplex-'));
    directories.push(directory);
    const path = join(directory, 'inbox.json');
    const inbox = new DurableInbox(path);
    await inbox.initialize();
    return { inbox, path };
}
async function enqueue(inbox: DurableInbox, routeJid: string, clientId: string, messageId: string) {
    return inbox.enqueue({
        accountId: 'account@s.whatsapp.net', messageId, routeJid, clientId,
        payload: { messageId, routeJid, text: `text-${messageId}`, pushName: clientId }
    });
}
const deliveries = (frames: ServerFrame[]) => frames.filter((frame): frame is Extract<ServerFrame, { type: 'delivery' }> => frame.type === 'delivery');
const readySender = (send: ReturnType<typeof vi.fn>, ready = true) => ({
    send,
    isReady: vi.fn(() => ready),
    waitUntilReady: vi.fn().mockResolvedValue(undefined)
});

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('durable inbox and route scheduler', () => {
    it('persists before offline replay, deduplicates upserts, and recovers inflight on restart', async () => {
        const { inbox, path } = await createInbox();
        expect((await enqueue(inbox, '12001@g.us', 'a', 'm1')).inserted).toBe(true);
        expect((await enqueue(inbox, '12001@g.us', 'a', 'm1')).inserted).toBe(false);
        const leased = await inbox.lease(inbox.list()[0].key);
        expect(leased.state).toBe('inflight');

        const restarted = new DurableInbox(path);
        await restarted.initialize();
        expect(restarted.list()[0]).toMatchObject({ state: 'queued', attempts: 1 });
        expect(restarted.list()[0].deliveryId).toBeUndefined();
    });

    it('isolates two clients, runs routes concurrently, and rejects impersonation/cross-route replies', async () => {
        const { inbox } = await createInbox();
        await enqueue(inbox, '12001@g.us', 'a', 'a1');
        await enqueue(inbox, '12002@g.us', 'b', 'b1');
        const sent = vi.fn().mockResolvedValue({ success: true, messageId: 'wa1' });
        const scheduler = new RouteScheduler(inbox, readySender(sent));
        const a: ServerFrame[] = [];
        const b: ServerFrame[] = [];
        await scheduler.connect('a', frame => { a.push(frame); return true; });
        await expect(scheduler.connect('a', () => true)).rejects.toThrow('already connected');
        await scheduler.connect('b', frame => { b.push(frame); return true; });
        expect(deliveries(a).map(frame => frame.messageId)).toEqual(['a1']);
        expect(deliveries(b).map(frame => frame.messageId)).toEqual(['b1']);

        await expect(scheduler.reply('a', 'attack', deliveries(b)[0].deliveryId, 'stolen')).rejects.toThrow('not active');
        expect(sent).not.toHaveBeenCalled();
        await scheduler.reply('a', 'request-a', deliveries(a)[0].deliveryId, 'reply-a');
        expect(sent).toHaveBeenCalledWith('12001@g.us', 'reply-a');
    });

    it('dispatches 20 configured routes concurrently to only their matching clients', async () => {
        const { inbox } = await createInbox();
        for (let index = 0; index < 20; index++) {
            await enqueue(inbox, `${12000 + index}@g.us`, `client-${index}`, `message-${index}`);
        }
        const scheduler = new RouteScheduler(inbox, readySender(vi.fn()));
        const received = new Map<string, ServerFrame[]>();
        for (let index = 0; index < 20; index++) {
            const clientId = `client-${index}`;
            const frames: ServerFrame[] = [];
            received.set(clientId, frames);
            await scheduler.connect(clientId, frame => { frames.push(frame); return true; });
        }
        for (let index = 0; index < 20; index++) {
            expect(deliveries(received.get(`client-${index}`)!).map(frame => frame.messageId)).toEqual([`message-${index}`]);
        }
        expect(scheduler.status()).toMatchObject({ connectedClients: expect.arrayContaining(Array.from({ length: 20 }, (_, i) => `client-${i}`)), inflight: 20 });
    });

    it('keeps FIFO/one-inflight ordering and returns duplicate request results without re-sending', async () => {
        const { inbox } = await createInbox();
        await enqueue(inbox, '12001@g.us', 'a', 'm1');
        await enqueue(inbox, '12001@g.us', 'a', 'm2');
        const sent = vi.fn().mockResolvedValue({ success: true, messageId: 'wa-message' });
        const scheduler = new RouteScheduler(inbox, readySender(sent));
        const frames: ServerFrame[] = [];
        await scheduler.connect('a', frame => { frames.push(frame); return true; });
        expect(deliveries(frames).map(frame => frame.messageId)).toEqual(['m1']);
        const first = deliveries(frames)[0];
        const result = await scheduler.reply('a', 'stable-request', first.deliveryId, 'hello');
        expect(result).toMatchObject({ type: 'replyResult', status: 'sent' });
        expect(deliveries(frames).map(frame => frame.messageId)).toEqual(['m1', 'm2']);
        const duplicate = await scheduler.reply('a', 'stable-request', first.deliveryId, 'changed');
        expect(duplicate).toEqual(result);
        expect(sent).toHaveBeenCalledTimes(1);
    });

    it('requeues a disconnected lease and records thrown send outcomes as ambiguous without retry', async () => {
        const { inbox } = await createInbox();
        await enqueue(inbox, '12001@g.us', 'a', 'm1');
        const sender = vi.fn().mockRejectedValue(new Error('connection closed after write'));
        const scheduler = new RouteScheduler(inbox, readySender(sender));
        const first: ServerFrame[] = [];
        await scheduler.connect('a', frame => { first.push(frame); return true; });
        const oldId = deliveries(first)[0].deliveryId;
        await scheduler.disconnect('a');
        const second: ServerFrame[] = [];
        await scheduler.connect('a', frame => { second.push(frame); return true; });
        const newId = deliveries(second)[0].deliveryId;
        expect(newId).not.toBe(oldId);
        await expect(scheduler.complete('a', 'stale', oldId)).rejects.toThrow();
        const result = await scheduler.reply('a', 'request', newId, 'reply');
        expect(result).toMatchObject({ status: 'ambiguous' });
        expect(sender).toHaveBeenCalledTimes(1);
    });

    it('authorizes media only for the owning active lease and runs terminal cleanup without disconnect cleanup', async () => {
        const { inbox } = await createInbox();
        const handle = 'A'.repeat(43);
        await inbox.enqueue({
            accountId: 'account', messageId: 'media', routeJid: '12001@g.us', clientId: 'a',
            payload: { messageId: 'media', routeJid: '12001@g.us', text: 'doc', pushName: 'Alice', media: { handle, kind: 'document', mimeType: 'application/pdf', size: 1, sha256: 'a'.repeat(64) } }
        });
        const cleaned: string[] = [];
        const scheduler = new RouteScheduler(inbox, readySender(vi.fn()), { onFinished: (_record, mediaHandle) => { if (mediaHandle) cleaned.push(mediaHandle); } });
        const frames: ServerFrame[] = [];
        await scheduler.connect('a', frame => { frames.push(frame); return true; });
        const lease = deliveries(frames)[0].deliveryId;
        expect(scheduler.authorizeMedia('a', lease, handle).messageId).toBe('media');
        expect(() => scheduler.authorizeMedia('b', lease, handle)).toThrow('not active');
        expect(() => scheduler.authorizeMedia('a', lease, 'B'.repeat(43))).toThrow('not bound');
        await scheduler.disconnect('a');
        expect(cleaned).toEqual([]);
        await scheduler.connect('a', frame => { frames.push(frame); return true; });
        const replay = deliveries(frames).at(-1)!.deliveryId;
        expect(() => scheduler.authorizeMedia('a', lease, handle)).toThrow('not active');
        await scheduler.complete('a', 'done', replay);
        expect(cleaned).toEqual([handle]);
    });

    it('gates replay until the outbound sender is ready', async () => {
        const { inbox } = await createInbox();
        await enqueue(inbox, '12001@g.us', 'a', 'm1');
        let ready = false;
        const scheduler = new RouteScheduler(inbox, {
            send: vi.fn(),
            isReady: () => ready,
            waitUntilReady: vi.fn().mockResolvedValue(undefined)
        });
        const frames: ServerFrame[] = [];
        await scheduler.connect('a', frame => { frames.push(frame); return true; });
        expect(deliveries(frames)).toEqual([]);
        ready = true;
        await scheduler.notifyQueued();
        expect(deliveries(frames).map(frame => frame.messageId)).toEqual(['m1']);
    });

    it('does not re-lease a record when the client disconnects during an outbound send', async () => {
        const { inbox } = await createInbox();
        await enqueue(inbox, '12001@g.us', 'a', 'm1');
        let resolveSend!: (value: { success: boolean; messageId: string }) => void;
        const send = vi.fn(() => new Promise<{ success: boolean; messageId: string }>(resolve => { resolveSend = resolve; }));
        const scheduler = new RouteScheduler(inbox, readySender(send));
        const first: ServerFrame[] = [];
        await scheduler.connect('a', frame => { first.push(frame); return true; });
        const reply = scheduler.reply('a', 'request', deliveries(first)[0].deliveryId, 'reply');
        await vi.waitFor(() => expect(inbox.list()[0].state).toBe('sending'));
        await scheduler.disconnect('a');
        const second: ServerFrame[] = [];
        await scheduler.connect('a', frame => { second.push(frame); return true; });
        expect(deliveries(second)).toEqual([]);
        resolveSend({ success: true, messageId: 'wa1' });
        await expect(reply).resolves.toMatchObject({ status: 'sent' });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('recovers a persisted sending boundary as a payload-free ambiguous tombstone', async () => {
        const { inbox, path } = await createInbox();
        await enqueue(inbox, '12001@g.us', 'a', 'm1');
        const leased = await inbox.lease(inbox.list()[0].key);
        await inbox.beginSending(leased.key, 'request');
        const restarted = new DurableInbox(path);
        await restarted.initialize();
        expect(restarted.list()[0]).toMatchObject({ state: 'completed', result: { requestId: 'request', status: 'ambiguous' } });
        expect(restarted.list()[0].payload).toBeUndefined();
    });
});
