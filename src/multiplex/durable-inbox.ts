import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MAX_TEXT_BYTES, type DeliveryPayload } from './protocol.js';

export type InboxState = 'queued' | 'inflight' | 'sending' | 'completed';
export interface PersistedResult {
    requestId: string;
    status: 'sent' | 'completed' | 'ambiguous' | 'failed';
    messageId?: string;
    error?: string;
}
export interface InboxRecord {
    key: string;
    accountId: string;
    messageId: string;
    routeJid: string;
    clientId: string;
    payload?: Omit<DeliveryPayload, 'deliveryId'>;
    state: InboxState;
    deliveryId?: string;
    attempts: number;
    createdAt: number;
    completedAt?: number;
    result?: PersistedResult;
}
interface Snapshot { version: 1; records: InboxRecord[] }

export const INBOX_LIMITS = {
    maxActiveRecords: 1_000,
    maxActiveRecordsPerRoute: 100,
    maxPayloadBytes: 100 * 1024 * 1024,
    maxTombstones: 10_000,
    tombstoneTtlMs: 7 * 24 * 60 * 60 * 1_000
} as const;

export class DurableInbox {
    private records = new Map<string, InboxRecord>();
    private mutation = Promise.resolve();
    constructor(private readonly path: string) {}

    async initialize(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        try {
            const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Snapshot;
            if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('unsupported inbox snapshot');
            for (const record of parsed.records) {
                if (!record.key || !record.messageId || !record.routeJid || !record.clientId || !['queued', 'inflight', 'sending', 'completed'].includes(record.state)) {
                    throw new Error('corrupt inbox record');
                }
                if (record.state === 'sending') {
                    record.state = 'completed';
                    record.completedAt = Date.now();
                    record.result = {
                        requestId: record.result?.requestId ?? `recovered-${record.deliveryId ?? record.key}`,
                        status: 'ambiguous',
                        error: 'router restarted while outbound send was in progress'
                    };
                    delete record.payload;
                } else if (record.state === 'inflight') {
                    record.state = 'queued';
                    delete record.deliveryId;
                }
                this.records.set(record.key, record);
            }
            this.compact();
            await this.persist();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await this.persist();
        }
    }

    keyFor(accountId: string, routeJid: string, messageId: string) { return `${accountId}\u0000${routeJid}\u0000${messageId}`; }

    has(accountId: string, routeJid: string, messageId: string): boolean {
        return this.records.has(this.keyFor(accountId, routeJid, messageId));
    }

    activeMediaHandles(): Set<string> {
        return new Set(this.list().flatMap(record => record.state !== 'completed' && record.payload?.media ? [record.payload.media.handle] : []));
    }

    async replaceMissingMedia(handles: ReadonlySet<string>): Promise<void> {
        if (!handles.size) return;
        await this.mutate(async () => {
            let changed = false;
            for (const record of this.records.values()) {
                if (!record.payload?.media || !handles.has(record.payload.media.handle)) continue;
                const fallback = '\n\n[Attached media is unavailable after router recovery]';
                const bytes = Buffer.from(`${record.payload.text}${fallback}`, 'utf8');
                record.payload.text = bytes.length <= MAX_TEXT_BYTES
                    ? bytes.toString('utf8')
                    : bytes.subarray(0, MAX_TEXT_BYTES).toString('utf8').replace(/\uFFFD$/u, '');
                delete record.payload.media;
                changed = true;
            }
            if (changed) await this.persist();
        });
    }

    canAccept(routeJid: string, payloadBytes = 0): boolean {
        const active = this.list().filter(record => record.state !== 'completed');
        if (active.length >= INBOX_LIMITS.maxActiveRecords) return false;
        if (active.filter(record => record.routeJid === routeJid).length >= INBOX_LIMITS.maxActiveRecordsPerRoute) return false;
        return this.activePayloadBytes() + payloadBytes <= INBOX_LIMITS.maxPayloadBytes;
    }

    async enqueue(input: Omit<InboxRecord, 'key' | 'state' | 'attempts' | 'createdAt' | 'deliveryId' | 'completedAt'> & { payload: Omit<DeliveryPayload, 'deliveryId'> }): Promise<{ record: InboxRecord; inserted: boolean }> {
        return this.mutate(async () => {
            this.compact();
            const key = this.keyFor(input.accountId, input.routeJid, input.messageId);
            const existing = this.records.get(key);
            if (existing) return { record: existing, inserted: false };
            const payloadBytes = Buffer.byteLength(JSON.stringify(input.payload));
            if (!this.canAccept(input.routeJid, payloadBytes)) throw new Error(`inbox quota exceeded for route ${input.routeJid}`);
            const record: InboxRecord = { ...input, key, state: 'queued', attempts: 0, createdAt: Date.now() };
            this.records.set(key, record);
            try { await this.persist(); } catch (error) { this.records.delete(key); throw error; }
            return { record, inserted: true };
        });
    }

    list(): InboxRecord[] { return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt); }
    getByDeliveryId(id: string): InboxRecord | undefined { return this.list().find(record => record.deliveryId === id); }
    getByRequestId(id: string): InboxRecord | undefined { return this.list().find(record => record.result?.requestId === id); }

    async lease(key: string): Promise<InboxRecord> {
        return this.mutate(async () => {
            const record = this.required(key);
            if (record.state !== 'queued' || !record.payload) throw new Error('record is not queued');
            record.state = 'inflight';
            record.deliveryId = randomUUID();
            record.attempts++;
            try {
                await this.persist();
            } catch (error) {
                record.state = 'queued'; delete record.deliveryId; record.attempts--; throw error;
            }
            return record;
        });
    }

    async beginSending(key: string, requestId: string): Promise<void> {
        await this.mutate(async () => {
            const record = this.required(key);
            if (record.state !== 'inflight') throw new Error('record is not inflight');
            record.state = 'sending';
            record.result = { requestId, status: 'ambiguous', error: 'outbound send outcome is unknown' };
            try { await this.persist(); } catch (error) { record.state = 'inflight'; delete record.result; throw error; }
        });
    }

    async resetSending(key: string): Promise<void> {
        await this.mutate(async () => {
            const record = this.required(key);
            if (record.state !== 'sending') throw new Error('record is not sending');
            const previousResult = record.result;
            record.state = 'inflight';
            delete record.result;
            try { await this.persist(); } catch (error) {
                record.state = 'sending';
                record.result = previousResult;
                throw error;
            }
        });
    }

    async requeueClient(clientId: string): Promise<void> {
        await this.mutate(async () => {
            const changed: Array<{ record: InboxRecord; deliveryId?: string }> = [];
            for (const record of this.records.values()) {
                if (record.clientId === clientId && record.state === 'inflight') {
                    changed.push({ record, deliveryId: record.deliveryId });
                    record.state = 'queued'; delete record.deliveryId;
                }
            }
            if (changed.length) {
                try { await this.persist(); } catch (error) {
                    for (const previous of changed) {
                        previous.record.state = 'inflight'; previous.record.deliveryId = previous.deliveryId;
                    }
                    throw error;
                }
            }
        });
    }

    async finish(key: string, result: PersistedResult): Promise<InboxRecord> {
        return this.mutate(async () => {
            const record = this.required(key);
            const previous = { state: record.state, result: record.result, payload: record.payload, completedAt: record.completedAt };
            record.state = 'completed';
            record.result = result;
            record.completedAt = Date.now();
            delete record.payload;
            this.compact();
            try { await this.persist(); } catch (error) {
                record.state = previous.state; record.result = previous.result; record.payload = previous.payload; record.completedAt = previous.completedAt; throw error;
            }
            return record;
        });
    }

    private activePayloadBytes(): number {
        let bytes = 0;
        for (const record of this.records.values()) if (record.state !== 'completed' && record.payload) bytes += Buffer.byteLength(JSON.stringify(record.payload));
        return bytes;
    }
    private compact(): void {
        const cutoff = Date.now() - INBOX_LIMITS.tombstoneTtlMs;
        const completed = this.list().filter(record => record.state === 'completed');
        for (const record of completed) {
            if ((record.completedAt ?? record.createdAt) < cutoff) this.records.delete(record.key);
        }
        const retained = this.list().filter(record => record.state === 'completed');
        for (const record of retained.slice(0, Math.max(0, retained.length - INBOX_LIMITS.maxTombstones))) this.records.delete(record.key);
    }
    private required(key: string) { const value = this.records.get(key); if (!value) throw new Error('record not found'); return value; }
    private mutate<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.mutation.then(operation, operation);
        this.mutation = next.then(() => undefined, () => undefined);
        return next;
    }

    private async persist(): Promise<void> {
        const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        const data = JSON.stringify({ version: 1, records: this.list() } satisfies Snapshot);
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
        try {
            await rename(temp, this.path);
            const directory = await open(dirname(this.path), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        } catch (error) {
            await rm(temp, { force: true });
            throw error;
        }
    }
}
