import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_CLIENT_FRAME_BYTES = 272 * 1024;
export const MAX_PREAUTH_FRAME_BYTES = 4 * 1024;
export const MAX_FRAMES_PER_READ = 16;
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface InlineImage { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }
export interface DeliveryPayload {
    deliveryId: string;
    messageId: string;
    routeJid: string;
    text: string;
    pushName: string;
    participant?: string;
    image?: InlineImage;
}

export type ClientFrame =
    | { type: 'hello'; protocol: 1; clientId: string; token: string }
    | { type: 'reply'; requestId: string; deliveryId: string; text: string }
    | { type: 'complete'; requestId: string; deliveryId: string }
    | { type: 'ping'; requestId: string };

export type ServerFrame =
    | { type: 'ready'; protocol: 1; clientId: string }
    | ({ type: 'delivery' } & DeliveryPayload)
    | { type: 'replyResult'; requestId: string; deliveryId: string; status: 'sent' | 'completed' | 'ambiguous' | 'failed'; messageId?: string; error?: string }
    | { type: 'error'; code: string; message: string; requestId?: string }
    | { type: 'pong'; requestId: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => {
    const keys = Object.keys(value);
    return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key));
};
const nonEmpty = (value: unknown, max = 256) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;
const validBase64 = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

export function validateClientFrame(value: unknown): ClientFrame {
    if (!isObject(value) || typeof value.type !== 'string') throw new Error('frame must be an object with a type');
    if (value.type === 'hello') {
        if (!exactKeys(value, ['type', 'protocol', 'clientId', 'token']) || value.protocol !== PROTOCOL_VERSION ||
            !nonEmpty(value.clientId, 128) || !nonEmpty(value.token, 1024)) throw new Error('invalid hello frame');
    } else if (value.type === 'reply') {
        if (!exactKeys(value, ['type', 'requestId', 'deliveryId', 'text']) || !nonEmpty(value.requestId) ||
            !nonEmpty(value.deliveryId) || typeof value.text !== 'string' || Buffer.byteLength(value.text) > MAX_TEXT_BYTES) throw new Error('invalid reply frame');
    } else if (value.type === 'complete') {
        if (!exactKeys(value, ['type', 'requestId', 'deliveryId']) || !nonEmpty(value.requestId) || !nonEmpty(value.deliveryId)) throw new Error('invalid complete frame');
    } else if (value.type === 'ping') {
        if (!exactKeys(value, ['type', 'requestId']) || !nonEmpty(value.requestId)) throw new Error('invalid ping frame');
    } else {
        throw new Error('unknown client frame type');
    }
    return value as ClientFrame;
}

export function validateServerFrame(value: unknown): ServerFrame {
    if (!isObject(value) || typeof value.type !== 'string') throw new Error('frame must be an object with a type');
    switch (value.type) {
        case 'ready':
            if (!exactKeys(value, ['type', 'protocol', 'clientId']) || value.protocol !== PROTOCOL_VERSION || !nonEmpty(value.clientId, 128)) throw new Error('invalid ready frame');
            break;
        case 'delivery': {
            if (!exactKeys(value, ['type', 'deliveryId', 'messageId', 'routeJid', 'text', 'pushName'], ['participant', 'image']) ||
                !nonEmpty(value.deliveryId) || !nonEmpty(value.messageId) || !nonEmpty(value.routeJid) ||
                typeof value.text !== 'string' || Buffer.byteLength(value.text) > MAX_TEXT_BYTES || !nonEmpty(value.pushName, 512) ||
                (value.participant !== undefined && !nonEmpty(value.participant, 256))) throw new Error('invalid delivery frame');
            if (value.image !== undefined) {
                if (!isObject(value.image) || !exactKeys(value.image, ['data', 'mimeType']) || !validBase64(value.image.data) ||
                    !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(String(value.image.mimeType)) ||
                    Buffer.byteLength(value.image.data, 'base64') > MAX_IMAGE_BYTES) throw new Error('invalid inline image');
            }
            break;
        }
        case 'replyResult':
            if (!exactKeys(value, ['type', 'requestId', 'deliveryId', 'status'], ['messageId', 'error']) || !nonEmpty(value.requestId) || !nonEmpty(value.deliveryId) ||
                !['sent', 'completed', 'ambiguous', 'failed'].includes(String(value.status)) ||
                (value.messageId !== undefined && !nonEmpty(value.messageId)) || (value.error !== undefined && typeof value.error !== 'string')) throw new Error('invalid reply result');
            break;
        case 'error':
            if (!exactKeys(value, ['type', 'code', 'message'], ['requestId']) || !nonEmpty(value.code) || !nonEmpty(value.message, 4096) ||
                (value.requestId !== undefined && !nonEmpty(value.requestId))) throw new Error('invalid error frame');
            break;
        case 'pong':
            if (!exactKeys(value, ['type', 'requestId']) || !nonEmpty(value.requestId)) throw new Error('invalid pong frame');
            break;
        default: throw new Error('unknown server frame type');
    }
    return value as ServerFrame;
}

export class NdjsonDecoder<T> {
    private buffer = Buffer.alloc(0);
    constructor(
        private readonly validate: (value: unknown) => T,
        private maxBytes = MAX_FRAME_BYTES,
        private readonly maxFramesPerPush = Number.POSITIVE_INFINITY
    ) {}
    setMaxBytes(maxBytes: number): void { this.maxBytes = maxBytes; }
    push(chunk: Buffer | string): T[] {
        this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (this.buffer.length > this.maxBytes && !this.buffer.includes(10)) throw new Error('frame too large');
        const frames: T[] = [];
        let newline: number;
        while ((newline = this.buffer.indexOf(10)) >= 0) {
            if (frames.length >= this.maxFramesPerPush) throw new Error('too many frames in one read');
            const line = this.buffer.subarray(0, newline);
            this.buffer = this.buffer.subarray(newline + 1);
            if (!line.length) continue;
            if (line.length > this.maxBytes) throw new Error('frame too large');
            let parsed: unknown;
            try { parsed = JSON.parse(line.toString('utf8')); } catch { throw new Error('malformed JSON'); }
            frames.push(this.validate(parsed));
        }
        return frames;
    }
}

export const encodeFrame = (frame: ClientFrame | ServerFrame): Buffer => {
    const output = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (output.length > MAX_FRAME_BYTES) throw new Error('frame too large');
    return output;
};
export const newRequestId = () => randomUUID();
