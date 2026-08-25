import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isValidClientId } from './protocol.js';

export interface RouterConfig {
    socketPath: string;
    socketMode: number;
    socketGroup?: string;
    stateDir: string;
    routes: ReadonlyMap<string, string>;
    tokenHashes: ReadonlyMap<string, string>;
}

export function normalizeRouteJid(value: string): string {
    const trimmed = value.trim().toLowerCase();
    const match = /^(\d+)(?::\d+)?@(g\.us|s\.whatsapp\.net)$/.exec(trimmed);
    if (!match) throw new Error(`invalid exact route JID: ${value}`);
    return `${match[1]}@${match[2]}`;
}

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export function authenticateToken(config: RouterConfig, clientId: string, token: string): boolean {
    const expectedHex = config.tokenHashes.get(clientId);
    const actual = Buffer.from(hashToken(token), 'hex');
    const expected = expectedHex && /^[a-f0-9]{64}$/i.test(expectedHex) ? Buffer.from(expectedHex, 'hex') : Buffer.alloc(32);
    return timingSafeEqual(actual, expected) && expectedHex !== undefined;
}

export function parseRouterConfig(value: unknown): RouterConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('router config must be an object');
    const raw = value as Record<string, unknown>;
    const allowed = ['socketPath', 'socketMode', 'socketGroup', 'stateDir', 'routes', 'clients'];
    if (Object.keys(raw).some(key => !allowed.includes(key))) throw new Error('unknown router config field');
    if (!Array.isArray(raw.routes) || !Array.isArray(raw.clients)) throw new Error('routes and clients must be arrays');
    if (raw.clients.length < 1 || raw.clients.length > 20) throw new Error('router requires 1 to 20 clients');

    const tokenHashes = new Map<string, string>();
    const usedHashes = new Set<string>();
    for (const item of raw.clients) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid client');
        const client = item as Record<string, unknown>;
        if (Object.keys(client).some(k => !['id', 'tokenHash'].includes(k)) || !isValidClientId(client.id) ||
            typeof client.tokenHash !== 'string' || !/^[a-f0-9]{64}$/i.test(client.tokenHash)) throw new Error('invalid client');
        if (tokenHashes.has(client.id)) throw new Error(`duplicate client: ${client.id}`);
        const normalizedHash = client.tokenHash.toLowerCase();
        if (usedHashes.has(normalizedHash)) throw new Error('duplicate client token hash');
        usedHashes.add(normalizedHash);
        tokenHashes.set(client.id, normalizedHash);
    }

    const routes = new Map<string, string>();
    const routedClients = new Set<string>();
    for (const item of raw.routes) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid route');
        const route = item as Record<string, unknown>;
        if (Object.keys(route).some(k => !['jid', 'clientId'].includes(k)) || typeof route.jid !== 'string' || typeof route.clientId !== 'string') throw new Error('invalid route');
        const jid = normalizeRouteJid(route.jid);
        if (!tokenHashes.has(route.clientId)) throw new Error(`route references unknown client: ${route.clientId}`);
        if (routes.has(jid)) throw new Error(`duplicate route: ${jid}`);
        if (routedClients.has(route.clientId)) throw new Error(`client has multiple exclusive routes: ${route.clientId}`);
        routes.set(jid, route.clientId);
        routedClients.add(route.clientId);
    }
    if (routes.size < 1 || routes.size > 20) throw new Error('router requires 1 to 20 routes');

    if (raw.socketPath !== undefined && (typeof raw.socketPath !== 'string' || !raw.socketPath.startsWith('/'))) throw new Error('socketPath must be an absolute path');
    if (raw.stateDir !== undefined && (typeof raw.stateDir !== 'string' || !raw.stateDir.startsWith('/'))) throw new Error('stateDir must be an absolute path');
    if (raw.socketGroup !== undefined && typeof raw.socketGroup !== 'string') throw new Error('socketGroup must be a string');
    const socketMode = raw.socketMode === undefined ? 0o660 : raw.socketMode;
    if (!Number.isInteger(socketMode) || Number(socketMode) < 0 || Number(socketMode) > 0o777 || (Number(socketMode) & 0o007) !== 0) throw new Error('invalid socketMode');
    return {
        socketPath: raw.socketPath === undefined ? '/run/whatsapp-pi/router.sock' : raw.socketPath as string,
        socketMode: Number(socketMode),
        socketGroup: raw.socketGroup === undefined ? 'whatsapp-pi' : raw.socketGroup as string,
        stateDir: raw.stateDir === undefined ? '/var/lib/whatsapp-pi-router' : raw.stateDir as string,
        routes,
        tokenHashes
    };
}

export async function loadRouterConfig(path: string): Promise<RouterConfig> {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('router config must be a regular file');
    if ((metadata.mode & 0o077) !== 0) throw new Error('router config must not be accessible by group or others');
    if (process.getuid && metadata.uid !== process.getuid()) throw new Error('router config must be owned by the router Unix user');
    const text = await readFile(path, 'utf8');
    return parseRouterConfig(JSON.parse(text));
}
