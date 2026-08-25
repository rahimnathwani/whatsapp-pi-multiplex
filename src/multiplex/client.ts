import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import { MAX_MEDIA_CHUNK_BYTES, MAX_MEDIA_FILE_BYTES, MAX_SERVER_FRAME_BYTES, NdjsonDecoder, PROTOCOL_VERSION, encodeFrame, isValidClientId, newRequestId, validateServerFrame, type ClientFrame, type DeliveryPayload, type LocalMedia, type ServerFrame } from './protocol.js';

export const LOCAL_MEDIA_CACHE_LIMITS = {
    maxBytes: 250 * 1024 * 1024,
    maxFiles: 100,
    maxAgeMs: 7 * 24 * 60 * 60 * 1_000
} as const;

export interface MultiplexClientOptions {
    clientId: string;
    socketPath: string;
    credentialFile: string;
    mediaDirectory: string;
    reconnectDelayMs?: number;
}

type ReplyResult = Extract<ServerFrame, { type: 'replyResult' }>;
type MediaResult = Extract<ServerFrame, { type: 'mediaChunk' | 'mediaReleased' }>;
interface Pending<T> { resolve: (frame: T) => void; reject: (error: Error) => void }

export class MultiplexClient {
    private socket?: Socket;
    private stopped = true;
    private token = '';
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private deliveryHandler?: (delivery: DeliveryPayload) => void | Promise<void>;
    private replyPending = new Map<string, Pending<ReplyResult>>();
    private mediaPending = new Map<string, Pending<MediaResult>>();
    private connected = false;
    private firstReady?: { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> };
    private deliveryProcessing = Promise.resolve();
    private mediaCacheMutation = Promise.resolve();
    private readonly options: MultiplexClientOptions;

    constructor(options: MultiplexClientOptions) {
        if (!isValidClientId(options.clientId)) throw new Error('invalid multiplex client ID');
        this.options = options;
    }

    onDelivery(handler: (delivery: DeliveryPayload) => void | Promise<void>) { this.deliveryHandler = handler; }
    isConnected() { return this.connected; }

    async start(): Promise<void> {
        const metadata = await stat(this.options.credentialFile);
        if ((metadata.mode & 0o077) !== 0) throw new Error('credential file must not be accessible by group or others (mode 0600)');
        if (process.getuid && metadata.uid !== process.getuid()) throw new Error('credential file must be owned by the client Unix user');
        this.token = (await readFile(this.options.credentialFile, 'utf8')).trim();
        if (this.token.length < 32) throw new Error('credential token must be at least 32 characters');
        await this.mutateMediaCache(async () => {
            await this.ensureMediaDirectory();
            await this.cleanupMediaCache();
        });
        this.stopped = false;
        const ready = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.stopped = true;
                this.socket?.destroy();
                this.firstReady = undefined;
                reject(new Error('timed out authenticating with multiplex router'));
            }, 10_000);
            this.firstReady = { resolve, reject, timeout };
        });
        this.connect();
        await ready;
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.connected = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.socket?.destroy();
        this.rejectFirstReady(new Error('multiplex client stopped'));
        this.rejectPending(new Error('multiplex client stopped'));
    }

    async reply(deliveryId: string, text: string): Promise<ReplyResult> {
        const requestId = newRequestId();
        return this.requestReply({ type: 'reply', requestId, deliveryId, text });
    }
    async complete(deliveryId: string): Promise<ReplyResult> {
        const requestId = newRequestId();
        return this.requestReply({ type: 'complete', requestId, deliveryId });
    }

    async fetchMedia(delivery: DeliveryPayload): Promise<LocalMedia | undefined> {
        const media = delivery.media;
        if (!media) return undefined;
        return this.mutateMediaCache(async () => {
            if (media.size > MAX_MEDIA_FILE_BYTES) throw new Error('declared media size exceeds local limit');
            await this.ensureMediaDirectory();
            await this.cleanupMediaCache(media.size, 1);
            return this.fetchMediaLocked(delivery, media);
        });
    }

    private async fetchMediaLocked(delivery: DeliveryPayload, media: NonNullable<DeliveryPayload['media']>): Promise<LocalMedia> {
        const tempPath = join(this.options.mediaDirectory, `.${randomUUID()}.tmp`);
        const safeName = this.safeFileName(media.fileName || (media.kind === 'audio' ? 'audio.ogg' : 'document'));
        const finalPath = join(this.options.mediaDirectory, `${randomUUID()}-${safeName}`);
        const file = await open(tempPath, 'wx', 0o600);
        const hash = createHash('sha256');
        let offset = 0;
        let renamed = false;
        let committed = false;
        try {
            while (offset < media.size) {
                const length = Math.min(MAX_MEDIA_CHUNK_BYTES, media.size - offset);
                const requestId = newRequestId();
                const result = await this.requestMedia({ type: 'mediaRead', requestId, deliveryId: delivery.deliveryId, handle: media.handle, offset, length });
                if (result.type !== 'mediaChunk' || result.deliveryId !== delivery.deliveryId || result.handle !== media.handle || result.offset !== offset) throw new Error('media chunk correlation mismatch');
                const data = Buffer.from(result.data, 'base64');
                if (data.length < 1 || data.length > length || offset + data.length > media.size) throw new Error('invalid media chunk length');
                if (result.eof !== (offset + data.length === media.size)) throw new Error('unexpected media end marker');
                await this.writeAll(file, data);
                hash.update(data);
                offset += data.length;
            }
            if (offset !== media.size || hash.digest('hex') !== media.sha256) throw new Error('media size or checksum mismatch');
            await file.sync();
            await file.close();
            await rename(tempPath, finalPath);
            renamed = true;
            const directory = await open(this.options.mediaDirectory, 'r');
            try { await directory.sync(); } finally { await directory.close(); }
            committed = true;
            const requestId = newRequestId();
            try {
                const released = await this.requestMedia({ type: 'mediaRelease', requestId, deliveryId: delivery.deliveryId, handle: media.handle });
                if (released.type !== 'mediaReleased' || released.deliveryId !== delivery.deliveryId || released.handle !== media.handle) throw new Error('media release correlation mismatch');
            } catch {
                // The verified local commit is usable; terminal delivery cleanup also releases the router copy.
            }
            return { ...media, path: finalPath };
        } catch (error) {
            await file.close().catch(() => undefined);
            if (!committed) {
                await rm(tempPath, { force: true });
                if (renamed) await rm(finalPath, { force: true });
            }
            throw error;
        }
    }

    private requestReply(frame: Extract<ClientFrame, { type: 'reply' | 'complete' }>): Promise<ReplyResult> {
        if (!this.socket || !this.connected) return Promise.reject(new Error('router is not connected'));
        return new Promise((resolve, reject) => {
            this.replyPending.set(frame.requestId, { resolve, reject });
            try { this.socket!.write(encodeFrame(frame)); } catch (error) { this.replyPending.delete(frame.requestId); reject(error as Error); }
        });
    }
    private requestMedia(frame: Extract<ClientFrame, { type: 'mediaRead' | 'mediaRelease' }>): Promise<MediaResult> {
        if (!this.socket || !this.connected) return Promise.reject(new Error('router is not connected'));
        return new Promise((resolve, reject) => {
            this.mediaPending.set(frame.requestId, { resolve, reject });
            try { this.socket!.write(encodeFrame(frame)); } catch (error) { this.mediaPending.delete(frame.requestId); reject(error as Error); }
        });
    }

    private connect() {
        if (this.stopped) return;
        const decoder = new NdjsonDecoder(validateServerFrame, MAX_SERVER_FRAME_BYTES);
        const socket = createConnection(this.options.socketPath);
        this.socket = socket;
        socket.once('connect', () => socket.write(encodeFrame({ type: 'hello', protocol: PROTOCOL_VERSION, clientId: this.options.clientId, token: this.token })));
        socket.on('data', chunk => {
            try { for (const frame of decoder.push(chunk)) void this.handle(frame); }
            catch { socket.destroy(); }
        });
        socket.once('error', () => undefined);
        socket.once('close', () => {
            if (this.socket === socket) this.socket = undefined;
            this.connected = false;
            this.rejectPending(new Error('router connection closed; request outcome may be ambiguous'));
            if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectDelayMs ?? 2000);
        });
    }

    private async handle(frame: ServerFrame) {
        if (frame.type === 'ready') {
            this.connected = true;
            if (this.firstReady) {
                clearTimeout(this.firstReady.timeout);
                this.firstReady.resolve();
                this.firstReady = undefined;
            }
            return;
        }
        if (frame.type === 'delivery') {
            this.deliveryProcessing = this.deliveryProcessing.then(() => this.deliveryHandler?.(frame)).then(() => undefined, () => undefined);
            await this.deliveryProcessing;
            return;
        }
        if (frame.type === 'replyResult') {
            const pending = this.replyPending.get(frame.requestId);
            if (pending) { this.replyPending.delete(frame.requestId); pending.resolve(frame); }
            return;
        }
        if (frame.type === 'mediaChunk' || frame.type === 'mediaReleased') {
            const pending = this.mediaPending.get(frame.requestId);
            if (pending) { this.mediaPending.delete(frame.requestId); pending.resolve(frame); }
            return;
        }
        if (frame.type === 'error') {
            const error = new Error(`${frame.code}: ${frame.message}`);
            if (!frame.requestId && !this.connected) {
                this.stopped = true;
                this.socket?.destroy();
                this.rejectFirstReady(error);
                return;
            }
            if (frame.requestId) {
                const reply = this.replyPending.get(frame.requestId);
                if (reply) { this.replyPending.delete(frame.requestId); reply.reject(error); }
                const media = this.mediaPending.get(frame.requestId);
                if (media) { this.mediaPending.delete(frame.requestId); media.reject(error); }
            }
        }
    }
    private async cleanupMediaCache(reserveBytes = 0, reserveFiles = 0): Promise<void> {
        if (reserveBytes > LOCAL_MEDIA_CACHE_LIMITS.maxBytes || reserveFiles > LOCAL_MEDIA_CACHE_LIMITS.maxFiles) throw new Error('media cache quota exceeded');
        const now = Date.now();
        const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
        let changed = false;
        for (const entry of await readdir(this.options.mediaDirectory, { withFileTypes: true })) {
            const path = join(this.options.mediaDirectory, entry.name);
            if (entry.isSymbolicLink() || (entry.name.startsWith('.') && entry.name.endsWith('.tmp'))) {
                await rm(path, { recursive: entry.isDirectory(), force: true });
                changed = true;
                continue;
            }
            if (!entry.isFile()) continue;
            const metadata = await lstat(path);
            if (!metadata.isFile() || metadata.isSymbolicLink()) {
                await rm(path, { force: true });
                changed = true;
                continue;
            }
            if (now - metadata.mtimeMs > LOCAL_MEDIA_CACHE_LIMITS.maxAgeMs) {
                await rm(path, { force: true });
                changed = true;
                continue;
            }
            files.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
        }
        files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
        let bytes = files.reduce((total, file) => total + file.size, 0);
        while (files.length + reserveFiles > LOCAL_MEDIA_CACHE_LIMITS.maxFiles || bytes + reserveBytes > LOCAL_MEDIA_CACHE_LIMITS.maxBytes) {
            const oldest = files.shift();
            if (!oldest) throw new Error('media cache quota exceeded');
            await rm(oldest.path, { force: true });
            bytes -= oldest.size;
            changed = true;
        }
        if (changed) {
            const directory = await open(this.options.mediaDirectory, 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        }
    }
    private async ensureMediaDirectory(): Promise<void> {
        await mkdir(this.options.mediaDirectory, { recursive: true, mode: 0o700 });
        const metadata = await lstat(this.options.mediaDirectory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('media directory must be a private real directory');
        await chmod(this.options.mediaDirectory, 0o700);
    }
    private mutateMediaCache<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.mediaCacheMutation.then(operation, operation);
        this.mediaCacheMutation = next.then(() => undefined, () => undefined);
        return next;
    }
    private async writeAll(file: FileHandle, data: Buffer): Promise<void> {
        let written = 0;
        while (written < data.length) {
            const result = await file.write(data, written, data.length - written, null);
            if (result.bytesWritten < 1) throw new Error('media file write made no progress');
            written += result.bytesWritten;
        }
    }
    private safeFileName(value: string): string {
        const leaf = basename(value.replace(/\\/g, '/'));
        const safe = leaf.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 128);
        return safe || 'media';
    }
    private rejectFirstReady(error: Error) {
        if (!this.firstReady) return;
        clearTimeout(this.firstReady.timeout);
        this.firstReady.reject(error);
        this.firstReady = undefined;
    }
    private rejectPending(error: Error) {
        for (const pending of this.replyPending.values()) pending.reject(error);
        for (const pending of this.mediaPending.values()) pending.reject(error);
        this.replyPending.clear();
        this.mediaPending.clear();
    }
}
