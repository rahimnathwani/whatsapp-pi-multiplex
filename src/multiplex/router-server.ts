import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, chown, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { downloadContentFromMessage } from 'baileys';
import qrcode from 'qrcode-terminal';
import { extractIncomingText } from '../services/incoming-message.resolver.js';
import { RecentsService } from '../services/recents.service.js';
import { SessionManager } from '../services/session.manager.js';
import { WhatsAppService, type RouterIncomingMessage } from '../services/whatsapp.service.js';
import { DurableInbox } from './durable-inbox.js';
import { authenticateToken, normalizeRouteJid, type RouterConfig } from './router-config.js';
import { RouteScheduler } from './route-scheduler.js';
import { DurableMediaSpool } from './media-spool.js';
import { MAX_CLIENT_FRAME_BYTES, MAX_FRAMES_PER_READ, MAX_IMAGE_BYTES, MAX_MEDIA_FILE_BYTES, MAX_PREAUTH_FRAME_BYTES, MAX_TEXT_BYTES, NdjsonDecoder, PROTOCOL_VERSION, encodeFrame, validateClientFrame, type ClientFrame, type InlineImage, type MediaHandle, type ServerFrame } from './protocol.js';

const execFileAsync = promisify(execFile);
interface Connection {
    socket: Socket;
    decoder: NdjsonDecoder<ClientFrame>;
    clientId?: string;
    authenticated: boolean;
    authenticationTimeout: ReturnType<typeof setTimeout>;
    processing: Promise<void>;
    lastPingAt: number;
    mediaProgress: Map<string, { deliveryId: string; offset: number; completed: boolean }>;
}

const MAX_CONNECTIONS = 64;
const MAX_UNAUTHENTICATED_CONNECTIONS = 20;

export class RouterServer {
    private readonly sessionManager: SessionManager;
    private readonly whatsapp: WhatsAppService;
    private readonly recents: RecentsService;
    private readonly inbox: DurableInbox;
    private readonly mediaSpool: DurableMediaSpool;
    private readonly scheduler: RouteScheduler;
    private readonly connections = new Set<Connection>();
    private readonly readinessWaiters = new Set<{ generation: number; resolve: () => void }>();
    private whatsappReady = false;
    private readinessGeneration = 0;
    private server?: Server;
    private mediaGcTimer?: ReturnType<typeof setInterval>;

    constructor(private readonly config: RouterConfig) {
        this.sessionManager = new SessionManager(config.stateDir, config.stateDir);
        this.whatsapp = new WhatsAppService(this.sessionManager, config.stateDir);
        this.recents = new RecentsService(this.sessionManager, config.stateDir);
        this.whatsapp.setRecentsService(this.recents);
        this.inbox = new DurableInbox(join(config.stateDir, 'inbox.json'));
        this.mediaSpool = new DurableMediaSpool(join(config.stateDir, 'media-spool'));
        this.scheduler = new RouteScheduler(this.inbox, {
            isReady: () => this.whatsappReady,
            waitUntilReady: requireReconnect => this.waitUntilWhatsAppReady(requireReconnect),
            send: (jid, text) => this.sendOutbound(jid, text)
        }, {
            onFinished: async (_record, mediaHandle) => { if (mediaHandle) await this.mediaSpool.release(mediaHandle); }
        });
    }

    async start(): Promise<void> {
        await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
        await chmod(this.config.stateDir, 0o700);
        await this.sessionManager.ensureInitialized();
        await this.recents.ensureInitialized();
        await this.inbox.initialize();
        await this.mediaSpool.initialize();
        await this.reconcileMedia();
        await mkdir(dirname(this.config.socketPath), { recursive: true, mode: 0o750 });
        await rm(this.config.socketPath, { force: true });
        this.server = createServer(socket => this.accept(socket));
        const previousUmask = process.umask(0o077);
        try {
            await new Promise<void>((resolve, reject) => {
                this.server!.once('error', reject);
                this.server!.listen(this.config.socketPath, resolve);
            });
        } finally {
            process.umask(previousUmask);
        }
        await chmod(this.config.socketPath, this.config.socketMode);
        if (this.config.socketGroup) {
            const { stdout } = await execFileAsync('getent', ['group', this.config.socketGroup]);
            const gid = Number(stdout.trim().split(':')[2]);
            if (!Number.isInteger(gid)) throw new Error(`cannot resolve socket group ${this.config.socketGroup}`);
            await chown(this.config.socketPath, process.getuid?.() ?? 0, gid);
        }
        this.whatsapp.setQRCodeCallback(qr => qrcode.generate(qr, { small: true }));
        this.whatsapp.setStatusCallback(status => console.log(`[router] WhatsApp: ${status}`));
        this.whatsapp.setConnectionReadyCallback(ready => this.updateWhatsAppReadiness(ready));
        this.whatsapp.setIncomingMessageRecorder(message => this.recents.recordMessage({
            messageId: message.id,
            senderNumber: message.remoteJid.endsWith('@g.us') ? message.remoteJid : `+${message.remoteJid.split('@')[0]}`,
            senderName: message.pushName,
            text: message.text || '',
            direction: 'incoming',
            timestamp: message.timestamp
        }));
        this.whatsapp.setRouterMessageCallback(message => this.ingest(message));
        await this.whatsapp.start();
        this.mediaGcTimer = setInterval(() => { void this.reconcileMedia().catch(error => console.warn('[router] media spool GC failed', error)); }, 60 * 60 * 1_000);
        this.mediaGcTimer.unref();
    }

    async stop(): Promise<void> {
        if (this.mediaGcTimer) clearInterval(this.mediaGcTimer);
        this.mediaGcTimer = undefined;
        for (const connection of this.connections) connection.socket.destroy();
        await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
        await this.whatsapp.stop();
        await rm(this.config.socketPath, { force: true });
    }

    status() {
        const schedulerStatus = this.scheduler.status();
        const records = this.inbox.list();
        const routes = [...this.config.routes.entries()].map(([jid, clientId]) => ({
            jid,
            clientId,
            connected: schedulerStatus.connectedClients.includes(clientId),
            queued: records.filter(record => record.routeJid === jid && record.state === 'queued').length,
            inflight: records.some(record => record.routeJid === jid && (record.state === 'inflight' || record.state === 'sending'))
        }));
        return { whatsapp: this.whatsapp.getEffectiveStatus(), routes, ...schedulerStatus };
    }

    private accept(socket: Socket) {
        const unauthenticated = [...this.connections].filter(connection => !connection.authenticated).length;
        if (this.connections.size >= MAX_CONNECTIONS || unauthenticated >= MAX_UNAUTHENTICATED_CONNECTIONS) {
            socket.destroy();
            return;
        }
        const connection: Connection = {
            socket,
            decoder: new NdjsonDecoder(validateClientFrame, MAX_PREAUTH_FRAME_BYTES, MAX_FRAMES_PER_READ),
            authenticated: false,
            authenticationTimeout: setTimeout(() => socket.destroy(), 5000),
            processing: Promise.resolve(),
            lastPingAt: 0,
            mediaProgress: new Map()
        };
        this.connections.add(connection);
        socket.on('data', chunk => {
            socket.pause();
            connection.processing = connection.processing
                .then(async () => {
                    const frames = connection.decoder.push(chunk);
                    for (const frame of frames) await this.handle(connection, frame);
                })
                .catch(error => {
                    this.send(connection, { type: 'error', code: 'INVALID_FRAME', message: error instanceof Error ? error.message : String(error) });
                    socket.end();
                })
                .finally(() => { if (!socket.destroyed) socket.resume(); });
        });
        socket.once('error', () => undefined);
        socket.once('close', () => {
            clearTimeout(connection.authenticationTimeout);
            this.connections.delete(connection);
            connection.processing = connection.processing
                .catch(() => undefined)
                .then(async () => { if (connection.clientId) await this.scheduler.disconnect(connection.clientId); });
        });
    }

    private async handle(connection: Connection, frame: ClientFrame) {
        if (!connection.authenticated) {
            if (frame.type !== 'hello' || !authenticateToken(this.config, frame.clientId, frame.token)) {
                this.send(connection, { type: 'error', code: 'AUTH_FAILED', message: 'authentication failed' }); connection.socket.end(); return;
            }
            try {
                if (this.scheduler.hasClient(frame.clientId)) throw new Error('duplicate client');
                connection.clientId = frame.clientId;
                connection.authenticated = true;
                connection.decoder.setMaxBytes(MAX_CLIENT_FRAME_BYTES);
                clearTimeout(connection.authenticationTimeout);
                this.send(connection, { type: 'ready', protocol: PROTOCOL_VERSION, clientId: frame.clientId });
                await this.scheduler.connect(frame.clientId, delivery => this.send(connection, delivery));
            } catch {
                this.send(connection, { type: 'error', code: 'DUPLICATE_CLIENT', message: 'client already connected' }); connection.socket.end();
            }
            return;
        }
        if (frame.type === 'hello') { this.send(connection, { type: 'error', code: 'INVALID_STATE', message: 'already authenticated' }); return; }
        if (frame.type === 'ping') {
            const now = Date.now();
            if (now - connection.lastPingAt < 1_000) throw new Error('ping rate limit exceeded');
            connection.lastPingAt = now;
            this.send(connection, { type: 'pong', requestId: frame.requestId });
            return;
        }
        try {
            if (frame.type === 'mediaRead' || frame.type === 'mediaRelease') {
                const inboxRecord = this.scheduler.authorizeMedia(connection.clientId!, frame.deliveryId, frame.handle);
                const spoolRecord = this.mediaSpool.get(frame.handle);
                if (!spoolRecord || spoolRecord.clientId !== connection.clientId || spoolRecord.inboxKey !== inboxRecord.key ||
                    spoolRecord.accountId !== inboxRecord.accountId || spoolRecord.routeJid !== inboxRecord.routeJid || spoolRecord.messageId !== inboxRecord.messageId) {
                    throw new Error('media is not owned by this active delivery');
                }
                if (frame.type === 'mediaRead') {
                    const progress = connection.mediaProgress.get(frame.handle);
                    const expectedOffset = progress?.deliveryId === frame.deliveryId ? progress.offset : 0;
                    if (progress?.deliveryId === frame.deliveryId && progress.completed) throw new Error('media transfer is already complete');
                    if (frame.offset !== expectedOffset) throw new Error('media reads must be sequential');
                    const chunk = await this.mediaSpool.read(frame.handle, frame.offset, frame.length);
                    const sent = this.send(connection, { type: 'mediaChunk', requestId: frame.requestId, deliveryId: frame.deliveryId, handle: frame.handle, offset: frame.offset, data: chunk.data.toString('base64'), eof: chunk.eof });
                    if (!sent) {
                        connection.socket.destroy();
                        return;
                    }
                    connection.mediaProgress.set(frame.handle, { deliveryId: frame.deliveryId, offset: frame.offset + chunk.data.length, completed: chunk.eof });
                } else {
                    // This acknowledges that the client committed its copy. Router bytes remain
                    // durable until reply/complete so a disconnect can replay the delivery.
                    connection.mediaProgress.delete(frame.handle);
                    if (!this.send(connection, { type: 'mediaReleased', requestId: frame.requestId, deliveryId: frame.deliveryId, handle: frame.handle })) connection.socket.destroy();
                }
                return;
            }
            const result = frame.type === 'reply'
                ? await this.scheduler.reply(connection.clientId!, frame.requestId, frame.deliveryId, frame.text)
                : await this.scheduler.complete(connection.clientId!, frame.requestId, frame.deliveryId);
            this.send(connection, result);
        } catch (error) {
            if (frame.type === 'mediaRead' || frame.type === 'mediaRelease') {
                console.warn(`[router] ${frame.type} failed for authenticated client ${connection.clientId}`, error);
                this.send(connection, { type: 'error', code: 'MEDIA_REQUEST_FAILED', message: 'media request could not be completed', requestId: frame.requestId });
            } else {
                this.send(connection, { type: 'error', code: 'NOT_AUTHORIZED', message: error instanceof Error ? error.message : String(error), requestId: frame.requestId });
            }
        }
    }

    private send(connection: Connection, frame: ServerFrame): boolean {
        if (connection.socket.destroyed || !connection.socket.writable || connection.socket.writableLength > 12 * 1024 * 1024) return false;
        connection.socket.write(encodeFrame(frame));
        return true;
    }

    private async ingest(input: RouterIncomingMessage) {
        const message = input.message;
        const rawJid = message.key.remoteJid!;
        let routeJid: string;
        try { routeJid = normalizeRouteJid(rawJid); } catch { return; }
        const clientId = this.config.routes.get(routeJid);
        if (!clientId || !message.key.id || !message.message) return;
        const accountId = input.accountId;
        if (this.inbox.has(accountId, routeJid, message.key.id)) return;
        const resolved = extractIncomingText(message.message);
        if (resolved.kind === 'system') return;
        const mediaMessage = resolved.kind === 'document' ? resolved.documentMessage : resolved.kind === 'audio' ? resolved.audioMessage : undefined;
        const declaredMediaBytes = mediaMessage?.fileLength === undefined ? 0 : Number(mediaMessage.fileLength);
        const mediaPreflightRejected = mediaMessage !== undefined && (!Number.isSafeInteger(declaredMediaBytes) || declaredMediaBytes < 0 ||
            declaredMediaBytes > MAX_MEDIA_FILE_BYTES || !this.mediaSpool.canAccept(declaredMediaBytes));
        if (mediaPreflightRejected) console.warn(`[router] media preflight rejected ${message.key.id} for ${routeJid}`);
        const reservedBytes = Buffer.byteLength(resolved.text, 'utf8') + (resolved.kind === 'image' ? MAX_IMAGE_BYTES * 2 : mediaMessage ? 2048 : 0);
        if (!this.inbox.canAccept(routeJid, reservedBytes)) {
            console.warn(`[router] inbox quota exceeded; dropping ${message.key.id} for ${routeJid}`);
            return;
        }
        let text = resolved.text;
        if ('quotedMessage' in resolved && resolved.quotedMessage) text = `[Replying to: ${resolved.quotedMessage.quotedText}]\n\n${text}`;
        let image: InlineImage | undefined;
        let media: MediaHandle | undefined;
        if (resolved.kind === 'image') image = await this.inlineImage(resolved.imageMessage);
        if (resolved.kind === 'video') text = '[Video message is not supported by multiplex]';
        if (mediaMessage && mediaPreflightRejected) {
            const fallback = resolved.kind === 'audio'
                ? '[Audio attachment could not be transferred due to media limits]'
                : '[Document attachment could not be transferred due to media limits]';
            text = `${fallback}\n\n${text}`;
        } else if (mediaMessage) {
            try {
                const kind = resolved.kind as 'document' | 'audio';
                const stream = await downloadContentFromMessage(mediaMessage, kind);
                media = await this.mediaSpool.create({
                    inboxKey: this.inbox.keyFor(accountId, routeJid, message.key.id),
                    accountId, routeJid, clientId, messageId: message.key.id, kind,
                    mimeType: String(mediaMessage.mimetype || (kind === 'audio' ? 'audio/ogg' : 'application/octet-stream')),
                    fileName: kind === 'document' ? String(mediaMessage.fileName || 'document') : String(mediaMessage.fileName || 'audio.ogg'),
                    declaredSize: declaredMediaBytes,
                    stream
                });
            } catch (error) {
                console.warn(`[router] failed to spool media ${message.key.id}`, error);
                const fallback = resolved.kind === 'audio' ? '[Audio message could not be transferred]' : '[Document could not be transferred]';
                text = `${fallback}\n\n${text}`;
            }
        }
        text = this.boundedUtf8(text, MAX_TEXT_BYTES);
        const pushName = this.boundedUtf8(message.pushName || 'WhatsApp User', 512);
        const participant = routeJid.endsWith('@g.us')
            ? this.boundedUtf8(message.key.participant?.split('@')[0] || 'unknown', 256)
            : undefined;
        const payload = { messageId: message.key.id, routeJid, text, pushName, participant, image, media };
        try {
            const { inserted } = await this.inbox.enqueue({
                accountId,
                messageId: message.key.id,
                routeJid,
                clientId,
                payload
            });
            if (!inserted && media) await this.mediaSpool.release(media.handle);
            if (inserted) await this.scheduler.notifyQueued();
        } catch (error) {
            if (media) await this.mediaSpool.release(media.handle).catch(() => undefined);
            throw error;
        }
    }

    private async reconcileMedia(): Promise<void> {
        const missing = await this.mediaSpool.reconcile(this.inbox.activeMediaHandles());
        await this.inbox.replaceMissingMedia(missing);
    }

    private boundedUtf8(value: string, maxBytes: number): string {
        const buffer = Buffer.from(value, 'utf8');
        if (buffer.length <= maxBytes) return value;
        let truncated = buffer.subarray(0, maxBytes).toString('utf8');
        while (Buffer.byteLength(truncated) > maxBytes) truncated = truncated.slice(0, -1);
        return truncated;
    }

    private updateWhatsAppReadiness(ready: boolean): void {
        if (ready && !this.whatsappReady) {
            this.readinessGeneration++;
            this.whatsappReady = true;
            for (const waiter of [...this.readinessWaiters]) {
                if (waiter.generation <= this.readinessGeneration) {
                    this.readinessWaiters.delete(waiter);
                    waiter.resolve();
                }
            }
            void this.scheduler.notifyQueued();
        } else if (!ready) {
            this.whatsappReady = false;
        }
    }

    private waitUntilWhatsAppReady(requireReconnect = false): Promise<void> {
        if (this.whatsappReady && !requireReconnect) return Promise.resolve();
        const generation = this.readinessGeneration + 1;
        return new Promise(resolve => this.readinessWaiters.add({ generation, resolve }));
    }

    private async sendOutbound(jid: string, text: string) {
        const result = await this.whatsapp.sendMessageOnce(jid, text);
        if (result.success) {
            await this.recents.recordMessage({
                messageId: result.messageId || randomUUID(),
                senderNumber: jid.endsWith('@g.us') ? jid : `+${jid.split('@')[0]}`,
                text,
                direction: 'outgoing',
                timestamp: Date.now()
            });
        }
        return result;
    }

    private async inlineImage(imageMessage: any): Promise<InlineImage | undefined> {
        const mimeType = String(imageMessage.mimetype || 'image/jpeg').toLowerCase().split(';')[0];
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) return undefined;
        const chunks: Buffer[] = [];
        let bytes = 0;
        const stream = await downloadContentFromMessage(imageMessage, 'image');
        for await (const chunk of stream) {
            const buffer = Buffer.from(chunk); bytes += buffer.length;
            if (bytes > MAX_IMAGE_BYTES) return undefined;
            chunks.push(buffer);
        }
        return { data: Buffer.concat(chunks).toString('base64'), mimeType: mimeType as InlineImage['mimeType'] };
    }
}
