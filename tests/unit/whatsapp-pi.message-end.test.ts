import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetI18n } from '../../src/i18n.ts';

const mocks = vi.hoisted(() => {
    const createSessionManager = () => ({
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        isRegistered: vi.fn().mockResolvedValue(false),
        setStatus: vi.fn().mockResolvedValue(undefined),
        addNumber: vi.fn().mockResolvedValue(undefined),
        addAllowedGroup: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue('connected'),
        getAllowList: vi.fn().mockReturnValue([]),
        getAllowedGroups: vi.fn().mockReturnValue([]),
        setGroupJidForAuth: vi.fn()
    });

    const createWhatsAppService = () => ({
        setVerboseMode: vi.fn(),
        setStatusCallback: vi.fn(),
        setIncomingMessageRecorder: vi.fn(),
        setMessageCallback: vi.fn(),
        setGroupBinding: vi.fn(),
        setRecentsService: vi.fn(),
        getBoundGroupJid: vi.fn().mockReturnValue(null),
        getStatus: vi.fn().mockReturnValue('connected'),
        isVerbose: vi.fn().mockReturnValue(false),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'MSG123', attempts: 1 }),
        resolveOutboundRecipientJid: vi.fn((recipient: string) => recipient),
        getLastRemoteJid: vi.fn().mockReturnValue('5511999998888@s.whatsapp.net'),
        markRead: vi.fn(),
        sendPresence: vi.fn().mockResolvedValue(undefined)
    });

    const createRecentsService = () => ({
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        recordMessage: vi.fn().mockResolvedValue(undefined)
    });

    const createMenuHandler = () => ({
        handleCommand: vi.fn().mockResolvedValue(undefined)
    });

    const createIncomingMediaService = () => ({
        process: vi.fn().mockResolvedValue({ text: 'hello from whatsapp' }),
        processLocalDocument: vi.fn().mockResolvedValue({ text: '[Document Received: report.pdf]\nLocation: /client/private/report.pdf' })
    });
    const createAudioService = () => ({ transcribeFile: vi.fn().mockResolvedValue('voice text') });

    return {
        sessionManager: createSessionManager(),
        whatsappService: createWhatsAppService(),
        recentsService: createRecentsService(),
        menuHandler: createMenuHandler(),
        incomingMediaService: createIncomingMediaService(),
        audioService: createAudioService(),
        multiplexClient: {
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            onDelivery: vi.fn(),
            reply: vi.fn().mockResolvedValue({ type: 'replyResult', requestId: 'r', deliveryId: 'd', status: 'sent' }),
            complete: vi.fn().mockResolvedValue({ type: 'replyResult', requestId: 'r', deliveryId: 'd', status: 'completed' }),
            fetchMedia: vi.fn()
        },
        extractIncomingText: vi.fn().mockReturnValue({ kind: 'text', text: 'hello from whatsapp' }),
        reset() {
            this.sessionManager = createSessionManager();
            this.whatsappService = createWhatsAppService();
            this.recentsService = createRecentsService();
            this.menuHandler = createMenuHandler();
            this.incomingMediaService = createIncomingMediaService();
            this.audioService = createAudioService();
            this.multiplexClient = {
                start: vi.fn().mockResolvedValue(undefined),
                stop: vi.fn().mockResolvedValue(undefined),
                onDelivery: vi.fn(),
                reply: vi.fn().mockResolvedValue({ type: 'replyResult', requestId: 'r', deliveryId: 'd', status: 'sent' }),
                complete: vi.fn().mockResolvedValue({ type: 'replyResult', requestId: 'r', deliveryId: 'd', status: 'completed' }),
                fetchMedia: vi.fn()
            };
            this.extractIncomingText = vi.fn().mockReturnValue({ kind: 'text', text: 'hello from whatsapp' });
        }
    };
});

vi.mock('../../src/services/session.manager.ts', () => ({
    SessionManager: Object.assign(vi.fn(() => mocks.sessionManager), {
        isGroupJid: (jid: string) => jid.endsWith('@g.us')
    })
}));

vi.mock('../../src/services/whatsapp.service.ts', () => ({
    WhatsAppService: vi.fn(() => mocks.whatsappService)
}));

vi.mock('../../src/services/recents.service.ts', () => ({
    RecentsService: vi.fn(() => mocks.recentsService)
}));

vi.mock('../../src/services/audio.service.ts', () => ({
    AudioService: vi.fn(() => mocks.audioService)
}));

vi.mock('../../src/ui/menu.handler.ts', () => ({
    MenuHandler: vi.fn(() => mocks.menuHandler)
}));

vi.mock('../../src/services/incoming-message.resolver.ts', () => ({
    extractIncomingText: (...args: unknown[]) => mocks.extractIncomingText(...args)
}));

vi.mock('../../src/services/incoming-media.service.ts', () => ({
    IncomingMediaService: vi.fn(() => mocks.incomingMediaService)
}));

vi.mock('../../src/multiplex/client.ts', () => ({
    MultiplexClient: vi.fn(() => mocks.multiplexClient)
}));

type PiHandler = (event: any, ctx: any) => Promise<void>;

interface MockPi {
    flags: Map<string, unknown>;
    handlers: Map<string, PiHandler>;
    commands: Map<string, any>;
    tools: Map<string, any>;
    registerFlag: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
    registerTool: ReturnType<typeof vi.fn>;
    getFlag: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    sendUserMessage: ReturnType<typeof vi.fn>;
}

const createMockPi = (multiplex = false): MockPi => {
    const flags = new Map<string, unknown>();
    const handlers = new Map<string, PiHandler>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();

    return {
        flags,
        handlers,
        commands,
        tools,
        registerFlag: vi.fn((name: string, config: unknown) => flags.set(name, config)),
        on: vi.fn((name: string, handler: PiHandler) => handlers.set(name, handler)),
        registerCommand: vi.fn((name: string, command: unknown) => commands.set(name, command)),
        registerTool: vi.fn((tool: { name: string }) => tools.set(tool.name, tool)),
        getFlag: vi.fn((name: string) => name === 'whatsapp-multiplex-client' && multiplex ? 'agent-a' : false),
        appendEntry: vi.fn(),
        exec: vi.fn().mockResolvedValue({ code: 0 }),
        sendUserMessage: vi.fn()
    };
};

const createMockContext = () => ({
    ui: {
        setStatus: vi.fn(),
        notify: vi.fn()
    },
    sessionManager: {
        getEntries: vi.fn().mockReturnValue([])
    },
    compact: vi.fn(),
    abort: vi.fn()
});

const loadExtension = async () => {
    vi.resetModules();
    const module = await import('../../whatsapp-pi.ts');
    return module.default;
};

const makeAssistantEvent = (text: string) => ({
    message: {
        role: 'assistant',
        content: [{ type: 'text', text }]
    }
});

describe('whatsapp-pi message_end handler', () => {
    beforeEach(() => {
        resetI18n();
        vi.stubEnv('WHATSAPP_PI_LOCALE', '');
        mocks.reset();
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('sends reply and records in recents on successful assistant message', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();

        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        await pi.handlers.get('message_end')!(makeAssistantEvent('Hello back!'), ctx);

        expect(mocks.whatsappService.sendMessage).toHaveBeenCalledWith(
            '5511999998888@s.whatsapp.net',
            'Hello back!'
        );
        expect(mocks.recentsService.recordMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                messageId: 'MSG123',
                senderNumber: '+5511999998888',
                text: 'Hello back!',
                direction: 'outgoing'
            })
        );
        expect(ctx.ui.notify).toHaveBeenCalledWith('Sent reply to WhatsApp contact', 'info');
    });

    it('skips when session is not connected', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();
        mocks.sessionManager.getStatus.mockReturnValue('disconnected');

        registerExtension(pi as any);
        await pi.handlers.get('message_end')!(makeAssistantEvent('Hello'), ctx);

        expect(mocks.whatsappService.sendMessage).not.toHaveBeenCalled();
    });

    it('skips when message role is not assistant', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();

        registerExtension(pi as any);
        await pi.handlers.get('message_end')!({
            message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
        }, ctx);

        expect(mocks.whatsappService.sendMessage).not.toHaveBeenCalled();
    });

    it('notifies error when sendMessage returns failure', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();
        mocks.whatsappService.sendMessage.mockResolvedValue({ success: false, error: 'timeout', attempts: 3 });

        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        await pi.handlers.get('message_end')!(makeAssistantEvent('Hello'), ctx);

        expect(mocks.recentsService.recordMessage).not.toHaveBeenCalled();
        expect(ctx.ui.notify).toHaveBeenCalledWith('Failed to send WhatsApp reply', 'error');
    });

    it('notifies error when sendMessage throws', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();
        mocks.whatsappService.sendMessage.mockRejectedValue(new Error('network error'));

        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        await pi.handlers.get('message_end')!(makeAssistantEvent('Hello'), ctx);

        expect(ctx.ui.notify).toHaveBeenCalledWith('Failed to send WhatsApp reply', 'error');
    });

    it('skips reply when send_wa_message tool already sent to the same JID', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();

        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);

        await pi.tools.get('send_wa_message').execute(
            'tool-call-id',
            { jid: '5511999998888@s.whatsapp.net', message: 'Tool message' }
        );
        vi.clearAllMocks();

        await pi.handlers.get('message_end')!(makeAssistantEvent('Agent text'), ctx);

        expect(mocks.whatsappService.sendMessage).not.toHaveBeenCalled();
        expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it('sends again after the dedup flag is cleared by a prior message_end', async () => {
        const registerExtension = await loadExtension();
        const pi = createMockPi();
        const ctx = createMockContext();

        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);

        await pi.tools.get('send_wa_message').execute(
            'tool-call-id',
            { jid: '5511999998888@s.whatsapp.net', message: 'Tool message' }
        );
        await pi.handlers.get('message_end')!(makeAssistantEvent('Skipped'), ctx);
        vi.clearAllMocks();

        await pi.handlers.get('message_end')!(makeAssistantEvent('Follow up'), ctx);

        expect(mocks.whatsappService.sendMessage).toHaveBeenCalledWith(
            '5511999998888@s.whatsapp.net',
            'Follow up'
        );
    });

    it('waits for an unrelated active run and finalizes the routed run only after agent_settled', async () => {
        vi.stubEnv('WHATSAPP_PI_CREDENTIAL_FILE', '/private/token');
        const registerExtension = await loadExtension();
        const pi = createMockPi(true);
        const ctx = createMockContext();
        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        const onDelivery = mocks.multiplexClient.onDelivery.mock.calls[0][0];

        await pi.handlers.get('agent_start')!({}, ctx);
        onDelivery({ deliveryId: 'd1', messageId: 'm1', routeJid: '12001@g.us', text: 'first', pushName: 'Alice' });
        expect(pi.sendUserMessage).not.toHaveBeenCalled();
        await pi.handlers.get('agent_end')!({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'unrelated' }] }] }, ctx);
        expect(pi.sendUserMessage).not.toHaveBeenCalled();
        await pi.handlers.get('agent_settled')!({}, ctx);
        expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
        expect(mocks.multiplexClient.reply).not.toHaveBeenCalled();

        await pi.handlers.get('agent_start')!({}, ctx);
        await pi.handlers.get('message_end')!(makeAssistantEvent('routed reply'), ctx);
        expect(mocks.multiplexClient.reply).not.toHaveBeenCalled();
        await pi.handlers.get('agent_end')!({ messages: [makeAssistantEvent('routed reply').message] }, ctx);
        expect(mocks.multiplexClient.reply).not.toHaveBeenCalled();
        await pi.handlers.get('agent_settled')!({}, ctx);
        expect(mocks.multiplexClient.reply).toHaveBeenCalledWith('d1', 'routed reply');
    });

    it('materializes and processes a multiplex document before assigning the active prompt scope', async () => {
        vi.stubEnv('WHATSAPP_PI_CREDENTIAL_FILE', '/private/token');
        let resolveFetch!: (value: any) => void;
        mocks.multiplexClient.fetchMedia.mockReturnValue(new Promise(resolve => { resolveFetch = resolve; }));
        const registerExtension = await loadExtension();
        const pi = createMockPi(true);
        const ctx = createMockContext();
        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        const onDelivery = mocks.multiplexClient.onDelivery.mock.calls[0][0];
        const media = { handle: 'A'.repeat(43), kind: 'document', mimeType: 'application/pdf', fileName: '../../report.pdf', size: 3, sha256: 'a'.repeat(64) };
        onDelivery({ deliveryId: 'doc-delivery', messageId: 'm-doc', routeJid: '12001@g.us', text: 'caption', pushName: 'Alice', media });
        expect(pi.sendUserMessage).not.toHaveBeenCalled();
        const toolBeforeReady = await pi.tools.get('send_wa_message').execute('tool', { message: 'too early' });
        expect(toolBeforeReady.isError).toBe(true);
        resolveFetch({ ...media, fileName: 'report.pdf', path: '/client/private/report.pdf' });
        await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledTimes(1));
        expect(mocks.incomingMediaService.processLocalDocument).toHaveBeenCalledWith('/client/private/report.pdf', expect.objectContaining({ mimeType: 'application/pdf', caption: 'caption' }));
        expect(pi.sendUserMessage.mock.calls[0][0]).toContain('/client/private/report.pdf');
        expect(pi.sendUserMessage.mock.calls[0][0]).not.toContain('/var/lib');
    });

    it('falls back after a media fetch failure and continues to the queued delivery', async () => {
        vi.stubEnv('WHATSAPP_PI_CREDENTIAL_FILE', '/private/token');
        mocks.multiplexClient.fetchMedia.mockRejectedValueOnce(new Error('transfer failed'));
        const registerExtension = await loadExtension();
        const pi = createMockPi(true);
        const ctx = createMockContext();
        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        const onDelivery = mocks.multiplexClient.onDelivery.mock.calls[0][0];
        const media = { handle: 'C'.repeat(43), kind: 'document', mimeType: 'application/pdf', fileName: 'failed.pdf', size: 3, sha256: 'c'.repeat(64) };
        onDelivery({ deliveryId: 'failed-media', messageId: 'm-failed', routeJid: '12001@g.us', text: 'caption', pushName: 'Alice', media });
        onDelivery({ deliveryId: 'successor', messageId: 'm-next', routeJid: '12001@g.us', text: 'next message', pushName: 'Alice' });
        await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledTimes(1));
        expect(pi.sendUserMessage.mock.calls[0][0]).toContain('failed.pdf could not be prepared');

        await pi.handlers.get('agent_start')!({}, ctx);
        await pi.handlers.get('agent_end')!({ messages: [] }, ctx);
        await pi.handlers.get('agent_settled')!({}, ctx);

        await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledTimes(2));
        expect(pi.sendUserMessage.mock.calls[1][0]).toContain('next message');
    });

    it('transcribes multiplex audio before delivering the prompt', async () => {
        vi.stubEnv('WHATSAPP_PI_CREDENTIAL_FILE', '/private/token');
        const media = { handle: 'B'.repeat(43), kind: 'audio', mimeType: 'audio/ogg', fileName: 'voice.ogg', size: 3, sha256: 'b'.repeat(64) };
        mocks.multiplexClient.fetchMedia.mockResolvedValue({ ...media, path: '/client/private/voice.ogg' });
        const registerExtension = await loadExtension();
        const pi = createMockPi(true);
        const ctx = createMockContext();
        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        mocks.multiplexClient.onDelivery.mock.calls[0][0]({ deliveryId: 'audio-delivery', messageId: 'm-audio', routeJid: '12001@g.us', text: '[Audio]', pushName: 'Alice', media });
        await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledTimes(1));
        expect(mocks.audioService.transcribeFile).toHaveBeenCalledWith('/client/private/voice.ogg');
        expect(pi.sendUserMessage.mock.calls[0][0]).toContain('[Transcribed Audio]: voice text');
    });

    it('removes materialized audio even when transcription unexpectedly rejects', async () => {
        vi.stubEnv('WHATSAPP_PI_CREDENTIAL_FILE', '/private/token');
        const { mkdtemp, rm, stat, writeFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const directory = await mkdtemp(join(tmpdir(), 'wa-message-audio-'));
        const path = join(directory, 'voice.ogg');
        await writeFile(path, 'audio', { mode: 0o600 });
        const media = { handle: 'D'.repeat(43), kind: 'audio', mimeType: 'audio/ogg', fileName: 'voice.ogg', size: 5, sha256: 'd'.repeat(64) };
        mocks.multiplexClient.fetchMedia.mockResolvedValue({ ...media, path });
        mocks.audioService.transcribeFile.mockRejectedValueOnce(new Error('unexpected failure'));
        try {
            const registerExtension = await loadExtension();
            const pi = createMockPi(true);
            const ctx = createMockContext();
            registerExtension(pi as any);
            await pi.handlers.get('session_start')!({}, ctx);
            mocks.multiplexClient.onDelivery.mock.calls[0][0]({ deliveryId: 'failed-audio', messageId: 'm-audio-fail', routeJid: '12001@g.us', text: '[Audio]', pushName: 'Alice', media });
            await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalledTimes(1));
            expect(pi.sendUserMessage.mock.calls[0][0]).toContain('Audio message could not be prepared');
            await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('waits through tool execution, suppresses final text after a tool reply, and queues the successor delivery', async () => {
        vi.stubEnv('WHATSAPP_PI_CREDENTIAL_FILE', '/private/token');
        const registerExtension = await loadExtension();
        const pi = createMockPi(true);
        const ctx = createMockContext();
        registerExtension(pi as any);
        await pi.handlers.get('session_start')!({}, ctx);
        const onDelivery = mocks.multiplexClient.onDelivery.mock.calls[0][0];
        onDelivery({ deliveryId: 'd1', messageId: 'm1', routeJid: '12001@g.us', text: 'first', pushName: 'Alice' });
        await pi.handlers.get('agent_start')!({}, ctx);
        onDelivery({ deliveryId: 'd2', messageId: 'm2', routeJid: '12001@g.us', text: 'second', pushName: 'Alice' });

        await pi.tools.get('send_wa_message').execute('tool', { message: 'tool reply' });
        await pi.handlers.get('message_end')!({ message: { role: 'assistant', content: [{ type: 'toolCall', name: 'send_wa_message' }] } }, ctx);
        expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
        await pi.handlers.get('agent_end')!({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final confirmation' }] }] }, ctx);

        expect(mocks.multiplexClient.reply).toHaveBeenCalledTimes(1);
        expect(mocks.multiplexClient.reply).toHaveBeenCalledWith('d1', 'tool reply');
        expect(mocks.multiplexClient.complete).not.toHaveBeenCalled();
        expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
        await pi.handlers.get('agent_settled')!({}, ctx);
        expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
        expect(pi.sendUserMessage.mock.calls[1][0]).toContain('second');
    });
});
