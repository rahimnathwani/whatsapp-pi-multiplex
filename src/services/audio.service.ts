import { downloadContentFromMessage } from 'baileys';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { chmod, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { createStoragePaths } from './storage-path.js';
import { WhatsAppPiLogger } from './whatsapp-pi.logger.js';
import { tryCreateWhisperCppAudioTranscriber, type AudioTranscriber } from './whisper-cpp-audio.transcriber.js';
import { t } from '../i18n.js';
import { MAX_MEDIA_FILE_BYTES } from '../multiplex/protocol.js';

const staticFfmpegPath = ffmpegStatic as unknown as string | null;
const execFileAsync = promisify(execFile);

type AudioLogger = Pick<WhatsAppPiLogger, 'log' | 'error'>;
type AudioPhase = 'download' | 'write' | 'convert' | 'whisper' | 'total';

export class AudioService {
    private readonly logger: AudioLogger;
    private readonly whisperCppTranscriber: AudioTranscriber | null;
    private readonly ffmpegCommands = [
        process.env.FFMPEG_PATH ?? (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
        ...(staticFfmpegPath ? [staticFfmpegPath] : [])
    ];

    constructor(
        logger: AudioLogger = new WhatsAppPiLogger(false),
        whisperCppTranscriber?: AudioTranscriber | null,
        private readonly mediaDir = createStoragePaths().mediaDir
    ) {
        this.logger = logger;
        this.whisperCppTranscriber = whisperCppTranscriber === undefined
            ? tryCreateWhisperCppAudioTranscriber(logger)
            : whisperCppTranscriber;
        void this.ensureMediaDirectory().catch(() => undefined);
    }

    async transcribe(audioMessage: any): Promise<string> {
        const totalStart = Date.now();
        let inputPath: string | undefined;
        try {
            await this.ensureMediaDirectory();
            inputPath = join(this.mediaDir, `.audio-${randomUUID()}.ogg`);
            const file = await open(inputPath, 'wx', 0o600);
            try {
                await this.measurePhase('download', async () => {
                    const stream = await downloadContentFromMessage(audioMessage, 'audio');
                    let size = 0;
                    for await (const value of stream) {
                        const chunk = Buffer.from(value);
                        size += chunk.length;
                        if (size > MAX_MEDIA_FILE_BYTES) throw new Error('audio exceeds local media limit');
                        await this.writeAll(file, chunk);
                    }
                    await file.sync();
                });
            } finally { await file.close(); }
            return await this.transcribePreparedFile(inputPath);
        } catch (error) {
            console.error(t('audio.transcriptionError'), error);
            return t('audio.transcriptionErrorResult', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            if (inputPath) await rm(inputPath, { force: true }).catch(() => undefined);
            this.logger.log(t('audio.phaseTiming', { phase: t('audio.phase.total'), duration: Date.now() - totalStart }));
        }
    }

    async transcribeFile(inputPath: string): Promise<string> {
        const totalStart = Date.now();
        try {
            await this.ensureMediaDirectory();
            return await this.transcribePreparedFile(inputPath);
        } catch (error) {
            console.error(t('audio.transcriptionError'), error);
            return t('audio.transcriptionErrorResult', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            this.logger.log(t('audio.phaseTiming', { phase: t('audio.phase.total'), duration: Date.now() - totalStart }));
        }
    }

    private async transcribePreparedFile(inputPath: string): Promise<string> {
        const wavPath = join(this.mediaDir, `.audio-${randomUUID()}.wav`);
        // Reserve the unpredictable name without following an existing link. ffmpeg replaces this private file.
        const reservation = await open(wavPath, 'wx', 0o600);
        await reservation.close();
        try {
            await this.measurePhase('convert', () => this.convertToWav(inputPath, wavPath));
            const whisperCppTranscriber = this.whisperCppTranscriber;
            if (!whisperCppTranscriber) throw new Error('whisper-cpp-node unavailable');
            return await this.measurePhase('whisper', async () => {
                const transcription = await whisperCppTranscriber.transcribe(wavPath);
                const text = String(transcription ?? '').trim();
                return text || t('audio.emptyTranscription');
            });
        } finally { await rm(wavPath, { force: true }).catch(() => undefined); }
    }

    private async ensureMediaDirectory(): Promise<void> {
        await mkdir(this.mediaDir, { recursive: true, mode: 0o700 });
        await chmod(this.mediaDir, 0o700);
    }

    private async writeAll(file: FileHandle, data: Buffer): Promise<void> {
        let written = 0;
        while (written < data.length) {
            const result = await file.write(data, written, data.length - written, null);
            if (result.bytesWritten < 1) throw new Error('audio file write made no progress');
            written += result.bytesWritten;
        }
    }

    private async measurePhase<T>(phase: Exclude<AudioPhase, 'total'>, action: () => Promise<T>): Promise<T> {
        const start = Date.now();
        try { return await action(); }
        finally { this.logger.log(t('audio.phaseTiming', { phase: this.getPhaseLabel(phase), duration: Date.now() - start })); }
    }

    private getPhaseLabel(phase: Exclude<AudioPhase, 'total'>): string {
        switch (phase) {
            case 'download': return t('audio.phase.download');
            case 'write': return t('audio.phase.write');
            case 'convert': return t('audio.phase.convert');
            case 'whisper': return t('audio.phase.whisper');
        }
    }

    private async convertToWav(inputPath: string, outputPath: string): Promise<void> {
        const args = ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath];
        let lastError: unknown;
        for (const command of this.ffmpegCommands) {
            try {
                await execFileAsync(command, args, { windowsHide: true });
                return;
            } catch (error) {
                lastError = error;
                if (!this.isMissingFfmpegCommand(error)) throw error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error('ffmpeg unavailable');
    }

    private isMissingFfmpegCommand(error: unknown): boolean {
        if (!(error instanceof Error)) return false;
        const anyError = error as Error & { code?: number | string; stderr?: string };
        const message = `${anyError.message}\n${anyError.stderr ?? ''}`;
        return anyError.code === 'ENOENT' || anyError.code === 127 || anyError.code === 9009 || /not found|not recognized/i.test(message);
    }
}
