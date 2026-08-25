import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken, type RouterConfig } from '../../src/multiplex/router-config.js';
import { RouterServer } from '../../src/multiplex/router-server.js';
import { MAX_MEDIA_FILE_BYTES, type ClientFrame, type ServerFrame } from '../../src/multiplex/protocol.js';

const mocks = vi.hoisted(() => ({ downloadContentFromMessage: vi.fn() }));
vi.mock('baileys', async importOriginal => ({
    ...(await importOriginal<typeof import('baileys')>()),
    downloadContentFromMessage: mocks.downloadContentFromMessage
}));

const directories: string[] = [];
const mediaBytes = Buffer.from('router-private-document');
const stream = (...chunks: Buffer[]) => (async function* () { for (const chunk of chunks) yield chunk; })();

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });

afterEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

interface FakeConnection {
    clientId: string;
    authenticated: boolean;
    mediaProgress: Map<string, { deliveryId: string; offset: number; completed: boolean }>;
    socket: {
        destroyed: boolean;
        writable: boolean;
        writableLength: number;
        write: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
    };
}

function connection(clientId: string): FakeConnection {
    const socket = {
        destroyed: false,
        writable: true,
        writableLength: 0,
        write: vi.fn().mockReturnValue(true),
        destroy: vi.fn(function (this: FakeConnection['socket']) { this.destroyed = true; })
    };
    return { clientId, authenticated: true, mediaProgress: new Map(), socket };
}

function writtenFrames(value: FakeConnection): ServerFrame[] {
    return value.socket.write.mock.calls.map(call => JSON.parse(String(call[0]).trim()) as ServerFrame);
}

async function setup(fileLength = mediaBytes.length) {
    const root = await mkdtemp(join(tmpdir(), 'wa-router-media-'));
    directories.push(root);
    const tokenA = 'a'.repeat(64);
    const tokenB = 'b'.repeat(64);
    const config: RouterConfig = {
        socketPath: join(root, 'router.sock'),
        socketMode: 0o660,
        stateDir: join(root, 'state'),
        routes: new Map([['12001@g.us', 'agent-a']]),
        tokenHashes: new Map([['agent-a', hashToken(tokenA)], ['agent-b', hashToken(tokenB)]])
    };
    const router = new RouterServer(config);
    await (router as any).inbox.initialize();
    await (router as any).mediaSpool.initialize();
    (router as any).whatsappReady = true;
    mocks.downloadContentFromMessage.mockResolvedValue(stream(mediaBytes.subarray(0, 8), mediaBytes.subarray(8)));
    await (router as any).ingest({
        accountId: 'account-a',
        message: {
            key: { id: 'message-a', remoteJid: '12001@g.us', participant: '15550001@s.whatsapp.net' },
            pushName: 'Alice',
            message: { documentMessage: { fileName: '../../report.pdf', mimetype: 'application/pdf', fileLength, caption: 'Review this' } }
        }
    });
    return { root, router };
}

describe('RouterServer media wiring', () => {
    it('binds reads to the active client lease, preserves replay after release, and cleans on completion', async () => {
        const { router } = await setup();
        const deliveries: ServerFrame[] = [];
        await (router as any).scheduler.connect('agent-a', (frame: ServerFrame) => { deliveries.push(frame); return true; });
        const first = deliveries[0];
        expect(first.type).toBe('delivery');
        if (first.type !== 'delivery' || !first.media) throw new Error('expected media delivery');
        expect(JSON.stringify(first)).not.toContain((router as any).config.stateDir);
        expect(first.media).not.toHaveProperty('path');

        const attacker = connection('agent-b');
        await (router as any).handle(attacker, { type: 'mediaRead', requestId: 'attack', deliveryId: first.deliveryId, handle: first.media.handle, offset: 0, length: 8 } satisfies ClientFrame);
        expect(writtenFrames(attacker)).toContainEqual(expect.objectContaining({ type: 'error', code: 'MEDIA_REQUEST_FAILED', message: 'media request could not be completed', requestId: 'attack' }));

        const owner = connection('agent-a');
        await (router as any).handle(owner, { type: 'mediaRead', requestId: 'read-1', deliveryId: first.deliveryId, handle: first.media.handle, offset: 0, length: 8 } satisfies ClientFrame);
        expect(writtenFrames(owner)).toContainEqual(expect.objectContaining({ type: 'mediaChunk', requestId: 'read-1', offset: 0 }));
        await (router as any).handle(owner, { type: 'mediaRelease', requestId: 'release', deliveryId: first.deliveryId, handle: first.media.handle } satisfies ClientFrame);
        expect(writtenFrames(owner)).toContainEqual(expect.objectContaining({ type: 'mediaReleased', requestId: 'release' }));
        await expect((router as any).mediaSpool.read(first.media.handle, 0, 8)).resolves.toMatchObject({ data: mediaBytes.subarray(0, 8) });

        await (router as any).scheduler.disconnect('agent-a');
        const replayed: ServerFrame[] = [];
        await (router as any).scheduler.connect('agent-a', (frame: ServerFrame) => { replayed.push(frame); return true; });
        const replay = replayed[0];
        expect(replay.type).toBe('delivery');
        if (replay.type !== 'delivery' || !replay.media) throw new Error('expected replayed media delivery');
        expect(replay.deliveryId).not.toBe(first.deliveryId);
        const replayOwner = connection('agent-a');
        await (router as any).handle(replayOwner, { type: 'mediaRead', requestId: 'replay-read', deliveryId: replay.deliveryId, handle: replay.media.handle, offset: 0, length: mediaBytes.length } satisfies ClientFrame);
        expect(writtenFrames(replayOwner)).toContainEqual(expect.objectContaining({ type: 'mediaChunk', requestId: 'replay-read', data: mediaBytes.toString('base64'), eof: true }));

        await (router as any).handle(replayOwner, { type: 'complete', requestId: 'complete', deliveryId: replay.deliveryId } satisfies ClientFrame);
        await expect((router as any).mediaSpool.read(replay.media.handle, 0, 1)).rejects.toThrow('unavailable');
    });

    it('preserves the caption as a bounded fallback when media preflight rejects the attachment', async () => {
        const { router } = await setup(MAX_MEDIA_FILE_BYTES + 1);
        const deliveries: ServerFrame[] = [];
        await (router as any).scheduler.connect('agent-a', (frame: ServerFrame) => { deliveries.push(frame); return true; });
        const delivery = deliveries[0];
        expect(delivery.type).toBe('delivery');
        if (delivery.type !== 'delivery') throw new Error('expected fallback delivery');
        expect(delivery.media).toBeUndefined();
        expect(delivery.text).toContain('Review this');
        expect(delivery.text).toContain('could not be transferred due to media limits');
        expect(mocks.downloadContentFromMessage).not.toHaveBeenCalled();
    });

    it('returns sanitized media errors without leaking router-private paths', async () => {
        const { root, router } = await setup();
        const deliveries: ServerFrame[] = [];
        await (router as any).scheduler.connect('agent-a', (frame: ServerFrame) => { deliveries.push(frame); return true; });
        const delivery = deliveries[0];
        if (delivery.type !== 'delivery' || !delivery.media) throw new Error('expected media delivery');
        const spoolDirectory = join(root, 'state', 'media-spool');
        const contentName = (await readdir(spoolDirectory)).find(name => name.endsWith('.bin'))!;
        await rm(join(spoolDirectory, contentName));
        const warn = vi.mocked(console.warn);
        const owner = connection('agent-a');

        await (router as any).handle(owner, { type: 'mediaRead', requestId: 'missing', deliveryId: delivery.deliveryId, handle: delivery.media.handle, offset: 0, length: 8 } satisfies ClientFrame);

        const error = writtenFrames(owner).find(frame => frame.type === 'error');
        expect(error).toEqual(expect.objectContaining({ type: 'error', code: 'MEDIA_REQUEST_FAILED', message: 'media request could not be completed', requestId: 'missing' }));
        expect(JSON.stringify(error)).not.toContain(root);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('mediaRead failed'), expect.any(Error));
        expect(owner.mediaProgress.size).toBe(0);
    });

    it('converts missing spool content to a bounded inbox fallback', async () => {
        const { root, router } = await setup();
        const record = (router as any).inbox.list()[0];
        const handle = record.payload.media.handle as string;
        const spoolDirectory = join(root, 'state', 'media-spool');
        const contentName = (await readdir(spoolDirectory)).find(name => name.endsWith('.bin'))!;
        await rm(join(spoolDirectory, contentName));

        await (router as any).reconcileMedia();

        const recovered = (router as any).inbox.list()[0];
        expect(recovered.payload.media).toBeUndefined();
        expect(recovered.payload.text).toContain('Attached media is unavailable after router recovery');
        expect((router as any).mediaSpool.get(handle)).not.toHaveProperty('internalName');
    });

    it('does not advance transfer progress when the response cannot be queued', async () => {
        const { router } = await setup();
        const deliveries: ServerFrame[] = [];
        await (router as any).scheduler.connect('agent-a', (frame: ServerFrame) => { deliveries.push(frame); return true; });
        const delivery = deliveries[0];
        if (delivery.type !== 'delivery' || !delivery.media) throw new Error('expected media delivery');
        const owner = connection('agent-a');
        owner.socket.writableLength = 13 * 1024 * 1024;

        await (router as any).handle(owner, { type: 'mediaRead', requestId: 'blocked', deliveryId: delivery.deliveryId, handle: delivery.media.handle, offset: 0, length: 8 } satisfies ClientFrame);

        expect(owner.socket.destroy).toHaveBeenCalled();
        expect(owner.mediaProgress.size).toBe(0);
    });
});
