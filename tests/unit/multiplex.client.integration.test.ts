import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { MultiplexClient } from '../../src/multiplex/client.js';
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
                        expect(frame).toEqual({ type: 'hello', protocol: 1, clientId: 'agent-a', token });
                        socket.write(encodeFrame({ type: 'ready', protocol: 1, clientId: 'agent-a' }));
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
        const client = new MultiplexClient({ clientId: 'agent-a', socketPath, credentialFile, reconnectDelayMs: 10 });
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

    it('rejects a credential file readable by other Unix users', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'wa-client-mode-'));
        const credentialFile = join(directory, 'token');
        await writeFile(credentialFile, 'a'.repeat(64), { mode: 0o644 });
        const client = new MultiplexClient({ clientId: 'agent-a', socketPath: join(directory, 'none.sock'), credentialFile });
        cleanups.push(async () => rm(directory, { recursive: true, force: true }));
        await expect(client.start()).rejects.toThrow('mode 0600');
    });
});
