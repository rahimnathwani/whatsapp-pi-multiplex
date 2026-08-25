import type { ServerFrame } from './protocol.js';
import { DurableInbox, type InboxRecord, type PersistedResult } from './durable-inbox.js';

export interface OutboundSender {
    isReady(): boolean;
    waitUntilReady(requireReconnect?: boolean): Promise<void>;
    send(routeJid: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }>;
}
type Deliver = (frame: ServerFrame) => boolean;
export interface SchedulerLifecycle {
    onFinished(record: InboxRecord, mediaHandle?: string): Promise<void> | void;
}

export class RouteScheduler {
    private clients = new Map<string, Deliver>();
    private scheduling = false;
    private scheduleRequested = false;
    constructor(private readonly inbox: DurableInbox, private readonly sender: OutboundSender, private readonly lifecycle?: SchedulerLifecycle) {}

    hasClient(clientId: string): boolean { return this.clients.has(clientId); }

    async connect(clientId: string, deliver: Deliver): Promise<void> {
        if (this.clients.has(clientId)) throw new Error('client already connected');
        this.clients.set(clientId, deliver);
        await this.schedule();
    }

    async disconnect(clientId: string): Promise<void> {
        this.clients.delete(clientId);
        await this.inbox.requeueClient(clientId);
    }

    async notifyQueued(): Promise<void> { await this.schedule(); }

    private async schedule(): Promise<void> {
        if (!this.sender.isReady()) return;
        if (this.scheduling) {
            this.scheduleRequested = true;
            return;
        }
        this.scheduling = true;
        this.scheduleRequested = false;
        try {
            const activeRoutes = new Set(this.inbox.list().filter(r => r.state === 'inflight' || r.state === 'sending').map(r => r.routeJid));
            for (const record of this.inbox.list()) {
                if (!this.sender.isReady()) break;
                if (record.state !== 'queued' || activeRoutes.has(record.routeJid)) continue;
                const deliver = this.clients.get(record.clientId);
                if (!deliver) continue;
                const leased = await this.inbox.lease(record.key);
                if (!leased.payload) throw new Error('leased record has no payload');
                const accepted = deliver({ type: 'delivery', ...leased.payload, deliveryId: leased.deliveryId! });
                if (!accepted) {
                    await this.disconnect(record.clientId);
                    continue;
                }
                activeRoutes.add(record.routeJid);
            }
        } finally {
            this.scheduling = false;
            if (this.scheduleRequested) await this.schedule();
        }
    }

    async reply(clientId: string, requestId: string, deliveryId: string, text: string): Promise<ServerFrame> {
        const duplicate = this.inbox.getByRequestId(requestId);
        if (duplicate && duplicate.state === 'completed') return this.resultFrame(clientId, duplicate, requestId, deliveryId);
        const record = this.ownedInflight(clientId, deliveryId);
        await this.sender.waitUntilReady();
        await this.inbox.beginSending(record.key, requestId);
        let result: PersistedResult;
        try {
            const sent = await this.sender.send(record.routeJid, text);
            if (!sent.success) {
                await this.inbox.resetSending(record.key);
                await this.sender.waitUntilReady(true);
                return this.reply(clientId, requestId, deliveryId, text);
            }
            result = { requestId, status: 'sent', messageId: sent.messageId };
        } catch (error) {
            result = { requestId, status: 'ambiguous', error: error instanceof Error ? error.message : String(error) };
        }
        const mediaHandle = record.payload?.media?.handle;
        await this.inbox.finish(record.key, result);
        await this.finished(record, mediaHandle);
        await this.schedule();
        return this.toFrame(record, result);
    }

    async complete(clientId: string, requestId: string, deliveryId: string): Promise<ServerFrame> {
        const duplicate = this.inbox.getByRequestId(requestId);
        if (duplicate && duplicate.state === 'completed') return this.resultFrame(clientId, duplicate, requestId, deliveryId);
        const record = this.ownedInflight(clientId, deliveryId);
        const mediaHandle = record.payload?.media?.handle;
        const result: PersistedResult = { requestId, status: 'completed' };
        await this.inbox.finish(record.key, result);
        await this.finished(record, mediaHandle);
        await this.schedule();
        return this.toFrame(record, result);
    }

    status() {
        const records = this.inbox.list();
        return {
            connectedClients: [...this.clients.keys()].sort(),
            queued: records.filter(r => r.state === 'queued').length,
            inflight: records.filter(r => r.state === 'inflight' || r.state === 'sending').length,
            completed: records.filter(r => r.state === 'completed').length
        };
    }

    authorizeMedia(clientId: string, deliveryId: string, handle: string): InboxRecord {
        const record = this.ownedInflight(clientId, deliveryId);
        if (!record.payload?.media || record.payload.media.handle !== handle) throw new Error('media is not bound to this delivery');
        return record;
    }
    private ownedInflight(clientId: string, deliveryId: string): InboxRecord {
        const record = this.inbox.getByDeliveryId(deliveryId);
        if (!record || record.state !== 'inflight' || record.clientId !== clientId) throw new Error('delivery is not active for this client');
        return record;
    }
    private async finished(record: InboxRecord, mediaHandle?: string): Promise<void> {
        try { await this.lifecycle?.onFinished(record, mediaHandle); }
        catch (error) { console.warn('[router] failed to clean completed delivery media', error); }
    }
    private resultFrame(clientId: string, record: InboxRecord, requestId: string, deliveryId: string): ServerFrame {
        if (record.clientId !== clientId || !record.result || record.deliveryId !== deliveryId) throw new Error('request ID belongs to another delivery');
        return this.toFrame(record, record.result, requestId);
    }
    private toFrame(record: InboxRecord, result: PersistedResult, requestId = result.requestId): ServerFrame {
        return { type: 'replyResult', requestId, deliveryId: record.deliveryId!, status: result.status, messageId: result.messageId, error: result.error };
    }
}
