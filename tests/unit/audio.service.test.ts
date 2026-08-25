import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n } from '../../src/i18n.ts';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({
    downloadContentFromMessage: vi.fn(),
    execFile: vi.fn()
}));
vi.mock('baileys', () => ({ downloadContentFromMessage: mocks.downloadContentFromMessage }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

const createStream = (...chunks: Buffer[]) => (async function* () { for (const chunk of chunks) yield chunk; })();
const logger = { log: vi.fn(), error: vi.fn() };
const whisperTranscriber = { transcribe: vi.fn() };
let AudioService: typeof import('../../src/services/audio.service.ts').AudioService;
let directories: string[] = [];

describe('AudioService', () => {
    beforeEach(async () => {
        resetI18n();
        vi.clearAllMocks();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.downloadContentFromMessage.mockResolvedValue(createStream(Buffer.from('media')));
        mocks.execFile.mockImplementation((...args: unknown[]) => {
            const callback = args.at(-1) as (error?: Error | null) => void;
            callback(null);
            return undefined;
        });
        whisperTranscriber.transcribe.mockResolvedValue('transcribed text');
        ({ AudioService } = await import('../../src/services/audio.service.ts'));
    });
    afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

    async function setupService() {
        const mediaDir = await mkdtemp(join(tmpdir(), 'wa-audio-'));
        directories.push(mediaDir);
        return { mediaDir, service: new AudioService(logger as any, whisperTranscriber as any, mediaDir) };
    }

    it('streams a download, transcribes it, and removes private intermediates', async () => {
        mocks.downloadContentFromMessage.mockResolvedValue(createStream(Buffer.from('part-1'), Buffer.from('part-2')));
        whisperTranscriber.transcribe.mockResolvedValue('  áudio transcrito  \n');
        const { service, mediaDir } = await setupService();
        const audioMessage = { id: 'audio-1' };
        await expect(service.transcribe(audioMessage)).resolves.toBe('áudio transcrito');
        expect(mocks.downloadContentFromMessage).toHaveBeenCalledWith(audioMessage, 'audio');
        expect(mocks.execFile).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i']), { windowsHide: true }, expect.any(Function));
        expect(whisperTranscriber.transcribe).toHaveBeenCalledWith(expect.stringMatching(/\.audio-[a-f0-9-]+\.wav$/));
        expect(await readdir(mediaDir)).toEqual([]);
    });

    it('transcribes an existing local file without deleting the original and cleans wav on success', async () => {
        const { service, mediaDir } = await setupService();
        const input = join(mediaDir, 'original.ogg');
        await writeFile(input, 'audio', { mode: 0o600 });
        await expect(service.transcribeFile(input)).resolves.toBe('transcribed text');
        expect(await readdir(mediaDir)).toEqual(['original.ogg']);
    });

    it('returns fallback for empty output and cleans intermediates', async () => {
        whisperTranscriber.transcribe.mockResolvedValue('');
        const { service, mediaDir } = await setupService();
        await expect(service.transcribe({ id: 'audio-2' })).resolves.toBe('[Empty transcription]');
        expect(await readdir(mediaDir)).toEqual([]);
    });

    it('returns a formatted error and cleans temporary audio when download fails', async () => {
        mocks.downloadContentFromMessage.mockRejectedValue(new Error('download failed'));
        const { service, mediaDir } = await setupService();
        await expect(service.transcribe({ id: 'audio-4' })).resolves.toBe('[Transcription error: download failed]');
        expect(console.error).toHaveBeenCalledWith('[AudioService] Transcription error:', expect.any(Error));
        expect(await readdir(mediaDir)).toEqual([]);
    });

    it('cleans wav when Whisper fails', async () => {
        const { service, mediaDir } = await setupService();
        const input = join(mediaDir, 'original.ogg');
        await writeFile(input, 'audio');
        whisperTranscriber.transcribe.mockRejectedValueOnce(new Error('whisper failed'));
        await expect(service.transcribeFile(input)).resolves.toContain('whisper failed');
        expect(await readdir(mediaDir)).toEqual(['original.ogg']);
    });

    it('cleans wav when ffmpeg fails', async () => {
        mocks.execFile.mockImplementationOnce((...args: unknown[]) => {
            const callback = args.at(-1) as (error?: Error | null) => void;
            callback(Object.assign(new Error('invalid audio'), { code: 1 }));
        });
        const { service, mediaDir } = await setupService();
        const input = join(mediaDir, 'original.ogg');
        await writeFile(input, 'audio');
        await expect(service.transcribeFile(input)).resolves.toContain('invalid audio');
        expect(whisperTranscriber.transcribe).not.toHaveBeenCalled();
        expect(await readdir(mediaDir)).toEqual(['original.ogg']);
    });
});
