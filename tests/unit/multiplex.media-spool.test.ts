import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableMediaSpool, MEDIA_SPOOL_LIMITS } from '../../src/multiplex/media-spool.js';
import { DurableInbox } from '../../src/multiplex/durable-inbox.js';

const directories: string[] = [];
const stream = (...chunks: Buffer[]) => (async function* () { for (const chunk of chunks) yield chunk; })();
const binding = { inboxKey: 'account\0route\0message', accountId: 'account', routeJid: '12001@g.us', clientId: 'agent-a', messageId: 'message' };
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('DurableMediaSpool', () => {
    async function setup() {
        const root = await mkdtemp(join(tmpdir(), 'wa-spool-'));
        directories.push(root);
        const directory = join(root, 'media-spool');
        const spool = new DurableMediaSpool(directory);
        await spool.initialize();
        return { root, directory, spool };
    }

    it('durably streams, hashes, chunks, restarts, and idempotently releases private content', async () => {
        const { directory, spool } = await setup();
        const bytes = Buffer.concat([Buffer.alloc(200_000, 7), Buffer.from('tail')]);
        const descriptor = await spool.create({ ...binding, kind: 'document', mimeType: 'application/pdf', fileName: '../../unsafe.pdf', declaredSize: bytes.length, stream: stream(bytes.subarray(0, 100_000), bytes.subarray(100_000)) });
        expect(descriptor.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(descriptor.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        const names = await readdir(directory);
        const contentName = names.find(name => name.endsWith('.bin'))!;
        expect(contentName).not.toContain('unsafe');
        expect(contentName).not.toContain(descriptor.handle);
        expect((await stat(join(directory, contentName))).mode & 0o777).toBe(0o600);
        expect(await readFile(join(directory, 'metadata.json'), 'utf8')).not.toContain('../../unsafe.pdf.bin');

        const restarted = new DurableMediaSpool(directory);
        await restarted.initialize();
        const first = await restarted.read(descriptor.handle, 0, 192 * 1024);
        const second = await restarted.read(descriptor.handle, first.data.length, 192 * 1024);
        expect(Buffer.concat([first.data, second.data])).toEqual(bytes);
        expect(second.eof).toBe(true);
        await restarted.release(descriptor.handle);
        await restarted.release(descriptor.handle);
        await expect(restarted.read(descriptor.handle, 0, 1)).rejects.toThrow('unavailable');
        expect(await readFile(join(directory, 'metadata.json'), 'utf8')).not.toContain(descriptor.handle);
    });

    it('handles empty media as an immediate EOF without retaining terminal metadata', async () => {
        const { directory, spool } = await setup();
        const descriptor = await spool.create({ ...binding, kind: 'document', mimeType: 'application/octet-stream', stream: stream() });
        await expect(spool.read(descriptor.handle, 0, 1)).resolves.toEqual({ data: Buffer.alloc(0), eof: true });
        await spool.release(descriptor.handle);
        expect(JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')).records).toEqual([]);
    });

    it('rejects declared and streamed oversize data and removes incomplete files', async () => {
        const { directory, spool } = await setup();
        expect(spool.canAccept(MEDIA_SPOOL_LIMITS.maxFileBytes + 1)).toBe(false);
        await expect(spool.create({ ...binding, kind: 'audio', mimeType: 'audio/ogg', declaredSize: MEDIA_SPOOL_LIMITS.maxFileBytes + 1, stream: stream(Buffer.from('x')) })).rejects.toThrow('quota');
        await expect(spool.create({
            ...binding,
            kind: 'audio',
            mimeType: 'audio/ogg',
            declaredSize: 0,
            stream: stream(Buffer.alloc(MEDIA_SPOOL_LIMITS.maxFileBytes), Buffer.from('x'))
        })).rejects.toThrow('quota');
        expect((await readdir(directory)).filter(name => name.endsWith('.tmp') || name.endsWith('.bin'))).toEqual([]);
        await writeFile(join(directory, '.abandoned.tmp'), 'secret', { mode: 0o600 });
        const restarted = new DurableMediaSpool(directory);
        await restarted.initialize();
        expect(await readdir(directory)).not.toContain('.abandoned.tmp');
    });

    it('retains usable media across an offline inbox/spool restart', async () => {
        const { root, directory, spool } = await setup();
        const inboxPath = join(root, 'inbox.json');
        const inbox = new DurableInbox(inboxPath);
        await inbox.initialize();
        const bytes = Buffer.from('offline document');
        const inboxKey = inbox.keyFor(binding.accountId, binding.routeJid, binding.messageId);
        const descriptor = await spool.create({ ...binding, inboxKey, kind: 'document', mimeType: 'application/pdf', stream: stream(bytes) });
        await inbox.enqueue({ accountId: binding.accountId, routeJid: binding.routeJid, clientId: binding.clientId, messageId: binding.messageId, payload: { messageId: binding.messageId, routeJid: binding.routeJid, text: 'doc', pushName: 'Alice', media: descriptor } });

        const restartedInbox = new DurableInbox(inboxPath);
        const restartedSpool = new DurableMediaSpool(directory);
        await restartedInbox.initialize();
        await restartedSpool.initialize();
        expect(await restartedSpool.reconcile(restartedInbox.activeMediaHandles())).toEqual(new Set());
        expect((await restartedSpool.read(descriptor.handle, 0, 1024)).data).toEqual(bytes);
        expect(JSON.stringify(restartedInbox.list())).not.toContain(directory);
    });

    it('detects corrupt content during reconciliation without exposing a path', async () => {
        const { directory, spool } = await setup();
        const descriptor = await spool.create({ ...binding, kind: 'audio', mimeType: 'audio/ogg', stream: stream(Buffer.from('audio')) });
        const contentName = (await readdir(directory)).find(name => name.endsWith('.bin'))!;
        await chmod(join(directory, contentName), 0o600);
        await writeFile(join(directory, contentName), 'wrong');
        const missing = await spool.reconcile(new Set([descriptor.handle]));
        expect(missing).toEqual(new Set([descriptor.handle]));
        expect(spool.get(descriptor.handle)).not.toHaveProperty('internalName');
    });
});
