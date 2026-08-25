import { downloadContentFromMessage } from 'baileys';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createStoragePaths } from './storage-path.js';
import { AudioService } from './audio.service.js';
import type { IncomingResolution } from './incoming-message.resolver.js';
import { WhatsAppPiLogger } from './whatsapp-pi.logger.js';
import { t } from '../i18n.js';
import { MAX_MEDIA_FILE_BYTES } from '../multiplex/protocol.js';

export interface ProcessedIncomingContent {
    text: string;
    imageBuffer?: Buffer;
    imageMimeType?: string;
}
export interface LocalDocumentMetadata {
    fileName?: string;
    mimeType?: string;
    size?: number;
    caption?: string;
}

const PDF_PREVIEW_LIMIT = 1200;

export class IncomingMediaService {
    constructor(
        private readonly audioService: AudioService,
        private readonly logger = new WhatsAppPiLogger(false),
        private readonly mediaDir = createStoragePaths().mediaDir
    ) {}

    async process(resolved: IncomingResolution, pushName: string): Promise<ProcessedIncomingContent> {
        if (resolved.kind === 'audio') return this.processAudio(resolved.audioMessage, pushName);
        if (resolved.kind === 'image') return this.processImage(resolved.imageMessage, resolved.text, pushName);
        if (resolved.kind === 'video') return this.processVideo(resolved.videoMessage, resolved.text, pushName);
        if (resolved.kind === 'document') return this.processDocument(resolved.documentMessage, pushName);
        return { text: resolved.text };
    }

    async processLocalDocument(path: string, metadata: LocalDocumentMetadata): Promise<ProcessedIncomingContent> {
        const fileName = this.safeDisplayName(metadata.fileName || basename(path) || 'document');
        const mimeType = String(metadata.mimeType || 'application/octet-stream').slice(0, 255);
        const fileSize = Number.isFinite(metadata.size) ? Number(metadata.size) : 0;
        let text = t('incoming.media.documentReceived', { fileName }) + '\n'
            + t('incoming.media.documentMimeType', { mimeType }) + '\n'
            + t('incoming.media.documentSize', { size: this.formatFileSize(fileSize) }) + '\n'
            + t('incoming.media.documentLocation', { relativePath: path });
        if (this.isPdfDocument(fileName, mimeType)) {
            const preview = await this.extractPdfPreview(await readFile(path));
            text += preview
                ? `\n\n${t('incoming.media.documentPdfPreviewHeading')}\n${preview}`
                : `\n\n${t('incoming.media.documentPdfFallbackNotice')}`;
        }
        if (metadata.caption) text += `\n\n${t('incoming.media.documentDescription', { caption: metadata.caption })}`;
        return { text };
    }

    private async processAudio(audioMessage: any, pushName: string): Promise<ProcessedIncomingContent> {
        this.logger.log(t('incoming.media.audioTranscribing', { pushName }));
        const transcription = await this.audioService.transcribe(audioMessage);
        return { text: t('incoming.media.audioTranscribed', { transcription }) };
    }

    private async processImage(imageMessage: any, fallbackText: string, pushName: string): Promise<ProcessedIncomingContent> {
        this.logger.log(t('incoming.media.imageDownloading', { pushName }));
        try {
            const imageBuffer = await this.downloadMessage(imageMessage, 'image');
            const rawMime = imageMessage.mimetype || 'image/jpeg';
            let imageMimeType = rawMime.toLowerCase().split(';')[0].trim();
            if (imageMimeType === 'image/jpg') imageMimeType = 'image/jpeg';
            this.logger.log(t('incoming.media.imageDownloaded', { imageMimeType, rawMime, size: imageBuffer.length }));
            await this.saveMediaFile('image', imageMimeType, imageBuffer);
            return { text: fallbackText || t('incoming.media.image'), imageBuffer, imageMimeType };
        } catch (error) {
            this.logger.error(t('incoming.media.imageDownloadFailed'), error);
            return { text: t('incoming.media.imageDownloadFailedText') };
        }
    }

    private async processVideo(videoMessage: any, fallbackText: string, pushName: string): Promise<ProcessedIncomingContent> {
        this.logger.log(`[WhatsApp-Pi] Downloading video from ${pushName}...`);
        try {
            const buffer = await this.downloadMessage(videoMessage, 'video');
            const mimeType = (videoMessage.mimetype || 'video/mp4').toLowerCase().split(';')[0].trim();
            const extension = mimeType.split('/')[1] || 'mp4';
            const absolutePath = join(this.mediaDir, `video_${Date.now()}.${extension}`);
            await mkdir(this.mediaDir, { recursive: true });
            await writeFile(absolutePath, buffer, { mode: 0o600 });
            this.logger.log(`[WhatsApp-Pi] Video saved to ${absolutePath} (${buffer.length} bytes)`);
            return { text: `${fallbackText || t('incoming.media.video')}\n[Video saved: ${absolutePath}]` };
        } catch (error) {
            this.logger.error('[WhatsApp-Pi] Failed to download video:', error);
            return { text: '[Video (download failed)]' };
        }
    }

    private async saveMediaFile(kind: 'image' | 'video', mimeType: string, buffer: Buffer): Promise<string> {
        const extension = mimeType.split('/')[1] || (kind === 'image' ? 'jpg' : 'mp4');
        const absolutePath = join(this.mediaDir, `${kind}_${Date.now()}.${extension}`);
        await mkdir(this.mediaDir, { recursive: true });
        await writeFile(absolutePath, buffer, { mode: 0o600 });
        return absolutePath;
    }

    private async processDocument(documentMessage: any, pushName: string): Promise<ProcessedIncomingContent> {
        const fileName = this.safeDisplayName(documentMessage.fileName || 'unnamed_document');
        const mimeType = documentMessage.mimetype || 'application/octet-stream';
        const fileSize = documentMessage.fileLength ? Number(documentMessage.fileLength) : 0;
        this.logger.log(t('incoming.media.documentDownloading', { pushName, fileName }));
        try {
            const buffer = await this.downloadMessage(documentMessage, 'document');
            const path = await this.saveDocument(fileName, buffer);
            this.logger.log(t('incoming.media.documentSaved', { relativePath: path, size: buffer.length }));
            return await this.formatLocalDocument(path, { fileName, mimeType, size: fileSize, caption: documentMessage.caption }, buffer);
        } catch (error) {
            this.logger.error(t('incoming.media.documentDownloadFailed'), error);
            return { text: t('incoming.media.documentDownloadFailedText', { fileName }) };
        }
    }

    private async formatLocalDocument(path: string, metadata: LocalDocumentMetadata, buffer: Buffer): Promise<ProcessedIncomingContent> {
        const fileName = this.safeDisplayName(metadata.fileName || basename(path));
        const mimeType = String(metadata.mimeType || 'application/octet-stream');
        let text = t('incoming.media.documentReceived', { fileName }) + '\n'
            + t('incoming.media.documentMimeType', { mimeType }) + '\n'
            + t('incoming.media.documentSize', { size: this.formatFileSize(metadata.size || 0) }) + '\n'
            + t('incoming.media.documentLocation', { relativePath: path });
        if (this.isPdfDocument(fileName, mimeType)) {
            const preview = await this.extractPdfPreview(buffer);
            text += preview ? `\n\n${t('incoming.media.documentPdfPreviewHeading')}\n${preview}` : `\n\n${t('incoming.media.documentPdfFallbackNotice')}`;
        }
        if (metadata.caption) text += `\n\n${t('incoming.media.documentDescription', { caption: metadata.caption })}`;
        return { text };
    }

    private async extractPdfPreview(buffer: Buffer): Promise<string | null> {
        try {
            const { LiteParse } = await import('@llamaindex/liteparse');
            const result = await new LiteParse({ ocrEnabled: true }).parse(buffer);
            return this.formatPdfPreview(result.text);
        } catch (error) {
            this.logger.warn('[WhatsApp-Pi] PDF parsing failed, falling back to storage-only behavior.', error);
            return null;
        }
    }
    private formatPdfPreview(text: string | undefined | null): string | null {
        const normalized = (text || '').replace(/\r\n/g, '\n').trim();
        if (!normalized) return null;
        return normalized.length <= PDF_PREVIEW_LIMIT ? normalized : `${normalized.slice(0, PDF_PREVIEW_LIMIT)}…`;
    }
    private isPdfDocument(fileName: string, mimeType: string): boolean {
        return mimeType.toLowerCase().split(';')[0].trim() === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
    }
    private async downloadMessage(message: any, type: 'image' | 'video' | 'document'): Promise<Buffer> {
        const stream = await downloadContentFromMessage(message, type);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const value of stream) {
            const chunk = Buffer.from(value);
            size += chunk.length;
            if (size > MAX_MEDIA_FILE_BYTES) throw new Error('media exceeds local limit');
            chunks.push(chunk);
        }
        return Buffer.concat(chunks, size);
    }
    private async saveDocument(fileName: string, buffer: Buffer): Promise<string> {
        const documentDir = join(this.mediaDir, 'documents');
        const absolutePath = join(documentDir, `${randomUUID()}-${this.safeDisplayName(fileName)}`);
        await mkdir(documentDir, { recursive: true, mode: 0o700 });
        await writeFile(absolutePath, buffer, { mode: 0o600 });
        return absolutePath;
    }
    private safeDisplayName(value: string): string {
        const leaf = basename(value.replace(/\\/g, '/'));
        return leaf.replace(/[^a-z0-9._-]/gi, '_').replace(/^\.+/, '').slice(0, 128) || 'document';
    }
    private formatFileSize(fileSize: number): string {
        return fileSize > 1024 * 1024 ? `${(fileSize / (1024 * 1024)).toFixed(1)} MB` : `${(fileSize / 1024).toFixed(1)} KB`;
    }
}
