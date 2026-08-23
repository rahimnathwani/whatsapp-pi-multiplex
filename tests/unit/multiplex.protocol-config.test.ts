import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NdjsonDecoder, encodeFrame, validateClientFrame, validateServerFrame } from '../../src/multiplex/protocol.js';
import { authenticateToken, hashToken, loadRouterConfig, normalizeRouteJid, parseRouterConfig } from '../../src/multiplex/router-config.js';

const configValue = () => ({
    socketPath: '/tmp/router.sock', socketMode: 0o660, socketGroup: '', stateDir: '/tmp/router-state',
    clients: [
        { id: 'agent-a', tokenHash: hashToken('a'.repeat(32)) },
        { id: 'agent-b', tokenHash: hashToken('b'.repeat(32)) }
    ],
    routes: [
        { jid: '12001@g.us', clientId: 'agent-a' },
        { jid: '12002@g.us', clientId: 'agent-b' }
    ]
});

describe('multiplex protocol', () => {
    it('decodes split and coalesced strict frames', () => {
        const decoder = new NdjsonDecoder(validateClientFrame);
        const first = encodeFrame({ type: 'ping', requestId: 'one' });
        const second = encodeFrame({ type: 'complete', requestId: 'two', deliveryId: 'delivery' });
        expect(decoder.push(first.subarray(0, 4))).toEqual([]);
        expect(decoder.push(Buffer.concat([first.subarray(4), second]))).toEqual([
            { type: 'ping', requestId: 'one' },
            { type: 'complete', requestId: 'two', deliveryId: 'delivery' }
        ]);
    });

    it('rejects malformed, unknown, version-mismatched, and oversized frames', () => {
        expect(() => new NdjsonDecoder(validateClientFrame).push('{nope}\n')).toThrow('malformed JSON');
        expect(() => validateClientFrame({ type: 'ping', requestId: 'x', jid: 'attacker@g.us' })).toThrow();
        expect(() => validateClientFrame({ type: 'hello', protocol: 2, clientId: 'a', token: 'x' })).toThrow();
        expect(() => new NdjsonDecoder(validateClientFrame, 8).push('123456789')).toThrow('frame too large');
        expect(() => new NdjsonDecoder(validateClientFrame, 1024, 2).push(
            '{"type":"ping","requestId":"1"}\n{"type":"ping","requestId":"2"}\n{"type":"ping","requestId":"3"}\n'
        )).toThrow('too many frames');
        expect(() => validateServerFrame({
            type: 'delivery', deliveryId: 'd', messageId: 'm', routeJid: '12001@g.us', text: 'x', pushName: 'Alice',
            path: '/var/lib/whatsapp-pi-router/private.jpg'
        })).toThrow('invalid delivery');
        expect(() => validateServerFrame({
            type: 'delivery', deliveryId: 'd', messageId: 'm', routeJid: '12001@g.us', text: 'x', pushName: 'Alice',
            image: { mimeType: 'image/jpeg', data: 'not-base64' }
        })).toThrow('invalid inline image');
    });
});

describe('router config and authentication', () => {
    it('normalizes device-qualified JIDs and binds tokens to client IDs', () => {
        expect(normalizeRouteJid('12001:7@G.US')).toBe('12001@g.us');
        const config = parseRouterConfig(configValue());
        expect(authenticateToken(config, 'agent-a', 'a'.repeat(32))).toBe(true);
        expect(authenticateToken(config, 'agent-b', 'a'.repeat(32))).toBe(false);
        expect(authenticateToken(config, 'missing', 'a'.repeat(32))).toBe(false);
    });

    it('rejects duplicate routes, duplicate live claims in config, wildcards, and more than 20 clients', () => {
        const duplicateRoute = configValue();
        duplicateRoute.routes[1].jid = duplicateRoute.routes[0].jid;
        expect(() => parseRouterConfig(duplicateRoute)).toThrow('duplicate route');
        const duplicateClientRoute = configValue();
        duplicateClientRoute.routes[1].clientId = 'agent-a';
        expect(() => parseRouterConfig(duplicateClientRoute)).toThrow('multiple exclusive routes');
        expect(() => normalizeRouteJid('*@g.us')).toThrow();
        const duplicateHash = configValue();
        duplicateHash.clients[1].tokenHash = duplicateHash.clients[0].tokenHash;
        expect(() => parseRouterConfig(duplicateHash)).toThrow('duplicate client token hash');
        const tooMany = configValue();
        tooMany.clients = Array.from({ length: 21 }, (_, index) => ({ id: `a${index}`, tokenHash: hashToken(`${index}`) }));
        expect(() => parseRouterConfig(tooMany)).toThrow('1 to 20 clients');
    });

    it('rejects insecure socket modes and explicitly malformed privileged path fields', () => {
        expect(() => parseRouterConfig({ ...configValue(), socketMode: 0o666 })).toThrow('invalid socketMode');
        expect(() => parseRouterConfig({ ...configValue(), socketPath: 123 })).toThrow('socketPath');
        expect(() => parseRouterConfig({ ...configValue(), stateDir: '' })).toThrow('stateDir');
        expect(() => parseRouterConfig({ ...configValue(), socketGroup: 123 })).toThrow('socketGroup');
    });

    it('loads only a private regular config file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'wa-router-config-'));
        const path = join(directory, 'config.json');
        try {
            await writeFile(path, JSON.stringify(configValue()), { mode: 0o600 });
            await expect(loadRouterConfig(path)).resolves.toMatchObject({ socketPath: '/tmp/router.sock' });
            await chmod(path, 0o644);
            await expect(loadRouterConfig(path)).rejects.toThrow('must not be accessible');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
