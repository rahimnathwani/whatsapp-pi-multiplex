import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_MEDIA_CHUNK_BYTES, MAX_MEDIA_FILE_BYTES, type MediaHandle, type MediaKind } from './protocol.js';

export const MEDIA_SPOOL_LIMITS = {
    maxFileBytes: MAX_MEDIA_FILE_BYTES,
    maxTotalBytes: 250 * 1024 * 1024,
    maxActiveFiles: 1_000,
    orphanGraceMs: 60 * 60 * 1_000,
    maxRetentionMs: 30 * 24 * 60 * 60 * 1_000
} as const;

export interface SpoolBinding {
    inboxKey: string;
    accountId: string;
    routeJid: string;
    clientId: string;
    messageId: string;
}
export interface CreateMediaInput extends SpoolBinding {
    kind: MediaKind;
    mimeType: string;
    fileName?: string;
    declaredSize?: number;
    stream: AsyncIterable<Uint8Array>;
}
export interface SpoolRecord extends SpoolBinding, MediaHandle {
    createdAt: number;
}
// releasedAt is accepted only to compact snapshots written by the earlier spool format.
interface StoredRecord extends SpoolRecord { internalName: string; releasedAt?: number }
interface Snapshot { version: 1; records: StoredRecord[] }

export class DurableMediaSpool {
    private readonly metadataPath: string;
    private records = new Map<string, StoredRecord>();
    private mutation = Promise.resolve();

    constructor(private readonly directory: string) {
        this.metadataPath = join(directory, 'metadata.json');
    }

    async initialize(): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        let compacted = false;
        try {
            const parsed = JSON.parse(await readFile(this.metadataPath, 'utf8')) as Snapshot;
            if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('unsupported media spool snapshot');
            const seenHandles = new Set<string>();
            for (const record of parsed.records) {
                if (!this.validStoredRecord(record) || seenHandles.has(record.handle)) throw new Error('corrupt media spool record');
                seenHandles.add(record.handle);
                if (record.releasedAt !== undefined) compacted = true;
                else this.records.set(record.handle, record);
            }
            if (compacted) await this.persist();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await this.persist();
        }
        await this.removeIncompleteAndUnknownFiles();
    }

    canAccept(declaredSize = 0): boolean {
        if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MEDIA_SPOOL_LIMITS.maxFileBytes) return false;
        return this.records.size < MEDIA_SPOOL_LIMITS.maxActiveFiles && this.activeBytes() + declaredSize <= MEDIA_SPOOL_LIMITS.maxTotalBytes;
    }

    async create(input: CreateMediaInput): Promise<MediaHandle> {
        return this.mutate(async () => {
            const declaredSize = input.declaredSize ?? 0;
            if (!this.canAccept(declaredSize)) throw new Error('media spool quota exceeded');
            const handle = randomBytes(32).toString('base64url');
            const internalName = `${randomUUID()}.bin`;
            const tempName = `.${randomUUID()}.tmp`;
            const tempPath = join(this.directory, tempName);
            const finalPath = join(this.directory, internalName);
            const file = await open(tempPath, 'wx', 0o600);
            const hash = createHash('sha256');
            let size = 0;
            try {
                for await (const value of input.stream) {
                    const chunk = Buffer.from(value);
                    size += chunk.length;
                    if (size > MEDIA_SPOOL_LIMITS.maxFileBytes || this.activeBytes() + size > MEDIA_SPOOL_LIMITS.maxTotalBytes) {
                        throw new Error('media exceeds spool quota');
                    }
                    hash.update(chunk);
                    await this.writeAll(file, chunk);
                }
                await file.sync();
            } catch (error) {
                await file.close().catch(() => undefined);
                await rm(tempPath, { force: true });
                throw error;
            }
            await file.close();
            try {
                await rename(tempPath, finalPath);
                await this.syncDirectory();
            } catch (error) {
                await rm(tempPath, { force: true });
                await rm(finalPath, { force: true });
                throw error;
            }
            const record: StoredRecord = {
                handle, internalName,
                inboxKey: input.inboxKey,
                accountId: input.accountId,
                routeJid: input.routeJid,
                clientId: input.clientId,
                messageId: input.messageId,
                kind: input.kind,
                mimeType: this.normalizeMime(input.mimeType),
                fileName: this.safeDisplayName(input.fileName),
                size,
                sha256: hash.digest('hex'),
                createdAt: Date.now()
            };
            this.records.set(handle, record);
            try { await this.persist(); } catch (error) {
                this.records.delete(handle);
                await rm(finalPath, { force: true });
                throw error;
            }
            return this.descriptor(record);
        });
    }

    get(handle: string): SpoolRecord | undefined {
        const record = this.records.get(handle);
        return record ? this.publicRecord(record) : undefined;
    }

    async read(handle: string, offset: number, length: number): Promise<{ data: Buffer; eof: boolean }> {
        const record = this.records.get(handle);
        if (!record) throw new Error('media handle is unavailable');
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_MEDIA_CHUNK_BYTES || offset > record.size) {
            throw new Error('invalid media range');
        }
        const path = join(this.directory, record.internalName);
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== record.size) throw new Error('media content is missing or corrupt');
        const file = await open(path, 'r');
        try {
            const data = Buffer.alloc(Math.min(length, record.size - offset));
            const { bytesRead } = await file.read(data, 0, data.length, offset);
            return { data: data.subarray(0, bytesRead), eof: offset + bytesRead === record.size };
        } finally { await file.close(); }
    }

    async release(handle: string): Promise<void> {
        await this.mutate(async () => {
            const record = this.records.get(handle);
            if (!record) return;
            await rm(join(this.directory, record.internalName), { force: true });
            this.records.delete(handle);
            await this.persist();
        });
    }

    async reconcile(activeHandles: ReadonlySet<string>): Promise<Set<string>> {
        return this.mutate(async () => {
            const now = Date.now();
            const missing = new Set<string>();
            for (const handle of activeHandles) {
                const record = this.records.get(handle);
                if (!record || !(await this.verify(record))) missing.add(handle);
            }
            let changed = false;
            for (const record of [...this.records.values()]) {
                const orphaned = !activeHandles.has(record.handle) && now - record.createdAt > MEDIA_SPOOL_LIMITS.orphanGraceMs;
                const expired = now - record.createdAt > MEDIA_SPOOL_LIMITS.maxRetentionMs;
                if (orphaned || expired) {
                    await rm(join(this.directory, record.internalName), { force: true });
                    this.records.delete(record.handle);
                    changed = true;
                    if (activeHandles.has(record.handle)) missing.add(record.handle);
                }
            }
            if (changed) await this.persist();
            await this.removeIncompleteAndUnknownFiles();
            return missing;
        });
    }

    private async verify(record: StoredRecord): Promise<boolean> {
        try {
            const path = join(this.directory, record.internalName);
            const metadata = await lstat(path);
            if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== record.size) return false;
            const file = await open(path, 'r');
            const hash = createHash('sha256');
            try {
                for await (const chunk of file.createReadStream()) hash.update(chunk);
            } finally { await file.close().catch(() => undefined); }
            return hash.digest('hex') === record.sha256;
        } catch { return false; }
    }

    private async removeIncompleteAndUnknownFiles(): Promise<void> {
        const known = new Set([...this.records.values()].map(record => record.internalName));
        for (const entry of await readdir(this.directory, { withFileTypes: true })) {
            if (entry.name === 'metadata.json') continue;
            if (entry.isSymbolicLink() || entry.name.endsWith('.tmp') || (entry.name.endsWith('.bin') && !known.has(entry.name))) {
                await rm(join(this.directory, entry.name), { recursive: entry.isDirectory(), force: true });
            }
        }
    }

    private activeBytes(): number {
        return [...this.records.values()].reduce((total, record) => total + record.size, 0);
    }
    private descriptor(record: StoredRecord): MediaHandle {
        return { handle: record.handle, kind: record.kind, mimeType: record.mimeType, fileName: record.fileName, size: record.size, sha256: record.sha256 };
    }
    private publicRecord(record: StoredRecord): SpoolRecord {
        return { ...this.descriptor(record), inboxKey: record.inboxKey, accountId: record.accountId, routeJid: record.routeJid, clientId: record.clientId, messageId: record.messageId, createdAt: record.createdAt };
    }
    private normalizeMime(value: string): string {
        const mime = String(value || 'application/octet-stream').toLowerCase().trim().slice(0, 255);
        return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/.test(mime) ? mime : 'application/octet-stream';
    }
    private safeDisplayName(value?: string): string | undefined {
        if (!value) return undefined;
        const normalized = [...value].filter(character => {
            const code = character.charCodeAt(0);
            return code > 31 && code !== 127;
        }).join('').slice(0, 512);
        return normalized || undefined;
    }
    private validStoredRecord(value: unknown): value is StoredRecord {
        if (!value || typeof value !== 'object') return false;
        const record = value as Partial<StoredRecord>;
        return typeof record.handle === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.handle) &&
            typeof record.internalName === 'string' && /^[a-f0-9-]{36}\.bin$/.test(record.internalName) &&
            typeof record.inboxKey === 'string' && typeof record.accountId === 'string' && typeof record.routeJid === 'string' &&
            typeof record.clientId === 'string' && typeof record.messageId === 'string' && ['document', 'audio'].includes(String(record.kind)) &&
            typeof record.mimeType === 'string' && Number.isSafeInteger(record.size) && Number(record.size) >= 0 && Number(record.size) <= MEDIA_SPOOL_LIMITS.maxFileBytes &&
            typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256) && Number.isSafeInteger(record.createdAt) &&
            (record.releasedAt === undefined || Number.isSafeInteger(record.releasedAt));
    }
    private mutate<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.mutation.then(operation, operation);
        this.mutation = next.then(() => undefined, () => undefined);
        return next;
    }
    private async writeAll(file: FileHandle, data: Buffer): Promise<void> {
        let written = 0;
        while (written < data.length) {
            const result = await file.write(data, written, data.length - written, null);
            if (result.bytesWritten < 1) throw new Error('media spool write made no progress');
            written += result.bytesWritten;
        }
    }
    private async syncDirectory(): Promise<void> {
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
    }
    private async persist(): Promise<void> {
        const temp = `${this.metadataPath}.${process.pid}.${randomUUID()}.tmp`;
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, records: [...this.records.values()] } satisfies Snapshot)); await file.sync(); } finally { await file.close(); }
        try { await rename(temp, this.metadataPath); await this.syncDirectory(); }
        catch (error) { await rm(temp, { force: true }); throw error; }
    }
}
