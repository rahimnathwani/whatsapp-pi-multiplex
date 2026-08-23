import { readFile, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { NdjsonDecoder, PROTOCOL_VERSION, encodeFrame, newRequestId, validateServerFrame, type DeliveryPayload, type ServerFrame } from './protocol.js';

export interface MultiplexClientOptions {
    clientId: string;
    socketPath: string;
    credentialFile: string;
    reconnectDelayMs?: number;
}

export class MultiplexClient {
    private socket?: Socket;
    private stopped = true;
    private token = '';
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private deliveryHandler?: (delivery: DeliveryPayload) => void | Promise<void>;
    private pending = new Map<string, { resolve: (frame: Extract<ServerFrame, { type: 'replyResult' }>) => void; reject: (error: Error) => void }>();
    private connected = false;
    private firstReady?: { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> };
    constructor(private readonly options: MultiplexClientOptions) {}

    onDelivery(handler: (delivery: DeliveryPayload) => void | Promise<void>) { this.deliveryHandler = handler; }
    isConnected() { return this.connected; }

    async start(): Promise<void> {
        const metadata = await stat(this.options.credentialFile);
        if ((metadata.mode & 0o077) !== 0) throw new Error('credential file must not be accessible by group or others (mode 0600)');
        if (process.getuid && metadata.uid !== process.getuid()) throw new Error('credential file must be owned by the client Unix user');
        this.token = (await readFile(this.options.credentialFile, 'utf8')).trim();
        if (this.token.length < 32) throw new Error('credential token must be at least 32 characters');
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

    async reply(deliveryId: string, text: string): Promise<Extract<ServerFrame, { type: 'replyResult' }>> {
        const requestId = newRequestId();
        return this.request({ type: 'reply', requestId, deliveryId, text });
    }
    async complete(deliveryId: string): Promise<Extract<ServerFrame, { type: 'replyResult' }>> {
        const requestId = newRequestId();
        return this.request({ type: 'complete', requestId, deliveryId });
    }

    private request(frame: { type: 'reply'; requestId: string; deliveryId: string; text: string } | { type: 'complete'; requestId: string; deliveryId: string }) {
        if (!this.socket || !this.connected) return Promise.reject(new Error('router is not connected'));
        return new Promise<Extract<ServerFrame, { type: 'replyResult' }>>((resolve, reject) => {
            this.pending.set(frame.requestId, { resolve, reject });
            try { this.socket!.write(encodeFrame(frame)); } catch (error) { this.pending.delete(frame.requestId); reject(error as Error); }
        });
    }

    private connect() {
        if (this.stopped) return;
        const decoder = new NdjsonDecoder(validateServerFrame);
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
        if (frame.type === 'delivery') { await this.deliveryHandler?.(frame); return; }
        if (frame.type === 'replyResult') {
            const pending = this.pending.get(frame.requestId);
            if (pending) { this.pending.delete(frame.requestId); pending.resolve(frame); }
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
                const pending = this.pending.get(frame.requestId);
                if (pending) { this.pending.delete(frame.requestId); pending.reject(error); }
            }
        }
    }
    private rejectFirstReady(error: Error) {
        if (!this.firstReady) return;
        clearTimeout(this.firstReady.timeout);
        this.firstReady.reject(error);
        this.firstReady = undefined;
    }
    private rejectPending(error: Error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
}
