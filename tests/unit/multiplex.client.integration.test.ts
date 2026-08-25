import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_MEDIA_CACHE_LIMITS, MultiplexClient } from '../../src/multiplex/client.js';
import { NdjsonDecoder, encodeFrame, validateClientFrame, type ClientFrame } from '../../src/multiplex/protocol.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

describe('MultiplexClient Unix socket integration', () => {
    it('authenticates from a private credential, receives a delivery, and sends only delivery-scoped reply fields', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'wa-client-'));
        const socketPath = join(directory, 'router.sock');
        const credentialFile = join(directory, 'token');
        const token = 'a'.repeat(64);
        await writeFile(credentialFile, token, { mode: 0o600 });
        await chmod(credentialFile, 0o600);
        const received: ClientFrame[] = [];
        let server: Server;
        server = createServer(socket => {
            const decoder = new NdjsonDecoder(validateClientFrame);
            socket.on('data', chunk => {
                for (const frame of decoder.push(chunk)) {
                    received.push(frame);
                    if (frame.type === 'hello') {
                        expect(frame).toEqual({ type: 'hello', protocol: 2, clientId: 'agent-a', token });
                        socket.write(encodeFrame({ type: 'ready', protocol: 2, clientId: 'agent-a' }));
                        socket.write(encodeFrame({
                            type: 'delivery', deliveryId: 'lease-a', messageId: 'message-a', routeJid: '12001@g.us',
                            text: 'hello', pushName: 'Alice'
                        }));
                    } else if (frame.type === 'reply') {
                        socket.write(encodeFrame({ type: 'replyResult', requestId: frame.requestId, deliveryId: frame.deliveryId, status: 'sent', messageId: 'wa-a' }));
                    }
                }
            });
        });
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
        const client = new MultiplexClient({ clientId: 'agent-a', socketPath, credentialFile, mediaDirectory: join(directory, 'media'), reconnectDelayMs: 10 });
        const deliveryPromise = new Promise<string>(resolve => client.onDelivery(delivery => resolve(delivery.deliveryId)));
        cleanups.push(async () => { await client.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

        await client.start();
        expect(await deliveryPromise).toBe('lease-a');
        const result = await client.reply('lease-a', 'reply text');
        expect(result).toMatchObject({ status: 'sent', deliveryId: 'lease-a' });
        const reply = received.find((frame): frame is Extract<ClientFrame, { type: 'reply' }> => frame.type === 'reply');
        expect(reply).toMatchObject({ deliveryId: 'lease-a', text: 'reply text' });
        expect(reply).not.toHaveProperty('jid');
    });

    it('materializes bounded chunks privately, verifies the digest, sanitizes names, and releases', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'wa-client-media-'));
        const socketPath = join(directory, 'router.sock');
        const credentialFile = join(directory, 'token');
        const mediaDirectory = join(directory, 'media');
        const token = 'b'.repeat(64);
        const bytes = Buffer.concat([Buffer.alloc(192 * 1024, 1), Buffer.from('tail')]);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const handle = 'B'.repeat(43);
        await writeFile(credentialFile, token, { mode: 0o600 });
        let released = false;
        const server = createServer(socket => {
            const decoder = new NdjsonDecoder(validateClientFrame);
            socket.on('data', chunk => {
                for (const frame of decoder.push(chunk)) {
                    if (frame.type === 'hello') {
                        socket.write(encodeFrame({ type: 'ready', protocol: 2, clientId: 'agent-a' }));
                    } else if (frame.type === 'mediaRead') {
                        const data = bytes.subarray(frame.offset, frame.offset + frame.length);
                        socket.write(encodeFrame({ type: 'mediaChunk', requestId: frame.requestId, deliveryId: frame.deliveryId, handle: frame.handle, offset: frame.offset, data: data.toString('base64'), eof: frame.offset + data.length === bytes.length }));
                    } else if (frame.type === 'mediaRelease') {
                        released = true;
                        socket.write(encodeFrame({ type: 'mediaReleased', requestId: frame.requestId, deliveryId: frame.deliveryId, handle: frame.handle }));
                    }
                }
            });
        });
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
        const client = new MultiplexClient({ clientId: 'agent-a', socketPath, credentialFile, mediaDirectory });
        cleanups.push(async () => { await client.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
        await client.start();
        const local = await client.fetchMedia({ deliveryId: 'lease', messageId: 'message', routeJid: '12001@g.us', text: 'doc', pushName: 'Alice', media: { handle, kind: 'document', mimeType: 'application/pdf', fileName: '../../unsafe.pdf', size: bytes.length, sha256 } });
        expect(local?.path.startsWith(`${mediaDirectory}/`)).toBe(true);
        expect(local?.path).not.toContain('..');
        expect(await readFile(local!.path)).toEqual(bytes);
        expect((await stat(local!.path)).mode & 0o777).toBe(0o600);
        expect(released).toBe(true);
    });

    it('bounds and ages the private local media cache at startup', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'wa-client-cache-'));
        const socketPath = join(directory, 'router.sock');
        const credentialFile = join(directory, 'token');
        const mediaDirectory = join(directory, 'media');
        await writeFile(credentialFile, 'd'.repeat(64), { mode: 0o600 });
        await mkdir(mediaDirectory, { mode: 0o700 });
        const expired = join(mediaDirectory, 'expired.pdf');
        await writeFile(expired, 'expired', { mode: 0o600 });
        const oldTime = new Date(Date.now() - LOCAL_MEDIA_CACHE_LIMITS.maxAgeMs - 1_000);
        await utimes(expired, oldTime, oldTime);
        const oversized = join(mediaDirectory, 'oversized.pdf');
        await writeFile(oversized, '', { mode: 0o600 });
        await truncate(oversized, LOCAL_MEDIA_CACHE_LIMITS.maxBytes + 1);
        for (let index = 0; index < LOCAL_MEDIA_CACHE_LIMITS.maxFiles + 1; index++) {
            await writeFile(join(mediaDirectory, `cached-${String(index).padStart(3, '0')}.pdf`), 'x', { mode: 0o600 });
        }
        const server = createServer(socket => {
            const decoder = new NdjsonDecoder(validateClientFrame);
            socket.on('data', chunk => {
                for (const frame of decoder.push(chunk)) if (frame.type === 'hello') socket.write(encodeFrame({ type: 'ready', protocol: 2, clientId: 'agent-a' }));
            });
        });
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
        const client = new MultiplexClient({ clientId: 'agent-a', socketPath, credentialFile, mediaDirectory });
        cleanups.push(async () => { await client.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

        await client.start();

        const retained = await readdir(mediaDirectory);
        expect(retained).not.toContain('expired.pdf');
        expect(retained).not.toContain('oversized.pdf');
        expect(retained.length).toBeLessThanOrEqual(LOCAL_MEDIA_CACHE_LIMITS.maxFiles);
        const retainedBytes = (await Promise.all(retained.map(name => stat(join(mediaDirectory, name))))).reduce((total, metadata) => total + metadata.size, 0);
        expect(retainedBytes).toBeLessThanOrEqual(LOCAL_MEDIA_CACHE_LIMITS.maxBytes);
    });

    it('materializes empty media without requesting an invalid zero-length chunk', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'wa-client-empty-'));
        const socketPath = join(directory, 'router.sock');
        const credentialFile = join(directory, 'token');
        const mediaDirectory = join(directory, 'media');
        await writeFile(credentialFile, 'e'.repeat(64), { mode: 0o600 });
        const handle = 'E'.repeat(43);
        let reads = 0;
        const server = createServer(socket => {
            const decoder = new NdjsonDecoder(validateClientFrame);
            socket.on('data', chunk => {
                for (const frame of decoder.push(chunk)) {
                    if (frame.type === 'hello') socket.write(encodeFrame({ type: 'ready', protocol: 2, clientId: 'agent-a' }));
                    if (frame.type === 'mediaRead') reads++;
                    if (frame.type === 'mediaRelease') socket.write(encodeFrame({ type: 'mediaReleased', requestId: frame.requestId, deliveryId: frame.deliveryId, handle: frame.handle }));
                }
            });
        });
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
        const client = new MultiplexClient({ clientId: 'agent-a', socketPath, credentialFile, mediaDirectory });
        cleanups.push(async () => { await client.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
        await client.start();

        const local = await client.fetchMedia({ deliveryId: 'lease', messageId: 'empty', routeJid: '12001@g.us', text: 'empty', pushName: 'Alice', media: { handle, kind: 'document', mimeType: 'application/octet-stream', size: 0, sha256: createHash('sha256').digest('hex') } });

        expect(reads).toBe(0);
        expect((await stat(local!.path)).size).toBe(0);
    });

    it('rejects corrupt transfers and removes the temporary file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'wa-client-corrupt-'));
        const socketPath = join(directory, 'router.sock');
        const credentialFile = join(directory, 'token');
        const mediaDirectory = join(directory, 'media');
        await writeFile(credentialFile, 'c'.repeat(64), { mode: 0o600 });
        const handle = 'C'.repeat(43);
        const server = createServer(socket => {
            const decoder = new NdjsonDecoder(validateClientFrame);
            socket.on('data', chunk => {
                for (const frame of decoder.push(chunk)) {
                    if (frame.type === 'hello') socket.write(encodeFrame({ type: 'ready', protocol: 2, clientId: 'agent-a' }));
                    if (frame.type === 'mediaRead') socket.write(encodeFrame({ type: 'mediaChunk', requestId: frame.requestId, deliveryId: frame.deliveryId, handle, offset: frame.offset, data: Buffer.from('bad').toString('base64'), eof: true }));
                }
            });
        });
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
        const client = new MultiplexClient({ clientId: 'agent-a', socketPath, credentialFile, mediaDirectory });
        cleanups.push(async () => { await client.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
        await client.start();
        await expect(client.fetchMedia({ deliveryId: 'lease', messageId: 'm', routeJid: '12001@g.us', text: 'doc', pushName: 'Alice', media: { handle, kind: 'document', mimeType: 'application/pdf', size: 3, sha256: '0'.repeat(64) } })).rejects.toThrow('checksum');
        await expect((await import('node:fs/promises')).readdir(mediaDirectory)).resolves.toEqual([]);
    });

    it('rejects client IDs that could escape the private cache directory', () => {
        for (const clientId of ['.', '..', 'agent/a', 'agent\\a']) {
            expect(() => new MultiplexClient({ clientId, socketPath: '/tmp/router.sock', credentialFile: '/tmp/token', mediaDirectory: '/tmp/media' }))
                .toThrow('invalid multiplex client ID');
        }
    });

    it('rejects a credential file readable by other Unix users', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'wa-client-mode-'));
        const credentialFile = join(directory, 'token');
        await writeFile(credentialFile, 'a'.repeat(64), { mode: 0o644 });
        const client = new MultiplexClient({ clientId: 'agent-a', socketPath: join(directory, 'none.sock'), credentialFile, mediaDirectory: join(directory, 'media') });
        cleanups.push(async () => rm(directory, { recursive: true, force: true }));
        await expect(client.start()).rejects.toThrow('mode 0600');
    });
});
