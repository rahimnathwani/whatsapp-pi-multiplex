<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="WhatsApp Logo" width="100">
</p>

# whatsapp-pi-multiplex
[![Upstream](https://img.shields.io/badge/upstream-whatsapp--pi-black.svg?style=flat-square&logo=github)](https://github.com/RaphaCastelloes/whatsapp-pi)

A multiplex-capable fork of **whatsapp-pi**, retaining Rapha Castelloes' upstream MIT attribution. Standalone mode remains the default and is backward-compatible.

A WhatsApp integration extension for the **[Pi Coding Agent](https://pi.dev)**. 

Pi is a powerful agentic AI coding assistant that operates in your terminal. This extension lets you chat and pair-program with your Pi agent through WhatsApp, with message filtering, allowed contacts/groups, recents/history browsing, message detail/reply, group-only binding, and reliable message delivery.


## Features

- **Manual WhatsApp Connection**: QR code-based authentication with session persistence
- **Allowed Contacts**: Control which phone numbers can interact with Pi
  - Add contacts with optional names for easy identification
  - View ignored numbers (not yet allowed) and add them when needed
  - Manage aliases and print allowed contacts from the menu
- **Allowed Groups**: Control which WhatsApp groups can interact with Pi
  - Add group JIDs with optional aliases
  - Only groups in Allowed Groups are processed by the agent
- **Recents & History**: Browse recent conversations, inspect full message history, and reply from message detail view
- **Reliable Messaging**: Queue-based message sending with retry logic
- **TUI Integration**: Menu-driven interface for managing connections, contacts, and recent chats
- **Group-Only Mode**: Bind the agent to a single WhatsApp group with `--whatsapp-group`
- **Media Support**: 
  - **Vision Analysis**: Automatically forwards WhatsApp images to Pi for analysis.
  - **Audio Transcription**: Transcribes voice notes locally with Whisper.cpp (`whisper-cpp-node`); `ffmpeg` is used to convert WhatsApp audio to 16 kHz mono WAV first.
  - **Document Handling**: Downloads and stores documents (PDF, text) for agent access; PDFs include a bounded text preview when readable.

## Prerequisites

### Pi Coding Agent

Install Pi from [pi.dev](https://pi.dev):

**Linux / macOS (recommended):**
```bash
curl -fsSL https://pi.dev/install.sh | sh
```

**Or via npm (requires Node.js 20+):**
```bash
npm install -g @earendil-works/pi-coding-agent
```

Then authenticate or set an API key before starting:
```bash
# Use /login inside Pi for subscription providers, or set an API key:
export ANTHROPIC_API_KEY=sk-ant-...
# OpenAI
export OPENAI_API_KEY=sk-...
# Google Gemini
export GEMINI_API_KEY=...
```

See the [Pi documentation](https://pi.dev/docs/latest) for full setup, providers, and model configuration details.

### Audio Transcription

Audio transcription uses a local `whisper.cpp` CLI and FFmpeg; no transcription API key is required.

Install dependencies and build the Whisper CLI:

**Linux/macOS:**
```bash
npm install
./scripts/build-whisper-cli.sh
```

**Windows (PowerShell):**
```powershell
npm install
./scripts/build-whisper-cli.ps1
```

The CLI is expected at `vendor/whisper.cpp/build/bin/whisper-cli` (or `.exe` on Windows). To use another location, set `WHISPER_CLI_PATH`.

PDF documents are parsed locally and do not require extra system utilities.
If a PDF cannot be parsed automatically, it is still saved and forwarded with a clear fallback notice. LiteParse is an optional dependency: installations using `npm install --omit=optional` retain document transfer and private local paths but omit automatic PDF text previews.

## Quick Start

1. Install the extension:
```bash
pi install npm:whatsapp-pi-multiplex
```

2. Start Pi:
```bash
pi
```

3. Open `/whatsapp` and choose **Connect / Reconnect WhatsApp**.
   - QR appears only on first pair or after logoff.

4. Add the chat you will use with Pi to **Allowed Contacts** or **Allowed Groups**.

5. Send a message from that allowed chat to Pi.
   - Pi replies in same thread.
   - Use **Recents** only to browse history or reply manually.

After first pairing, you can start Pi with auto-connect enabled:
```bash
pi --whatsapp-pi-online
```

### Iniciar automaticamente no Ubuntu

Com `tmux` instalado, o instalador abaixo instala `whatsapp-pi` no agente Pi do usuário e cria um serviço systemd que inicia `pi --whatsapp-pi-online` em um tmux no boot:

```bash
sudo apt install tmux
./scripts/install-whatsapp-pi-service.sh
```

Comandos úteis:
```bash
tmux attach -t whatsapp-pi
systemctl --user status whatsapp-pi.service
systemctl --user disable --now whatsapp-pi.service
```

## Multiplex Router (Linux)

Multiplex mode runs exactly one Baileys connection in a dedicated router account and routes up to 20 exact chat JIDs to separate Pi Unix users. It is opt-in; all commands above continue to use standalone mode.

### Build and provision (Debian/Ubuntu or Arch)

Install Node.js 20+, build, and expose the daemon command. Keep the checkout/package in a root-owned location such as `/opt/whatsapp-pi-multiplex`; agent users must not have write permission to the extension code, systemd units, or router configuration.

```bash
npm install
npm run build:router
sudo npm link
sudo ./scripts/setup-multiplex-users.sh agent01 agent02 # ... up to agent20
sudo cp config/router.example.json /etc/whatsapp-pi-router/config.json
```

The setup script prints each client's SHA-256 token hash. Put those hashes and exact `@g.us`/`@s.whatsapp.net` routes in the router config. Keep the config router-only:

```bash
sudo chown whatsapp-router:whatsapp-pi /etc/whatsapp-pi-router/config.json
sudo chmod 0600 /etc/whatsapp-pi-router/config.json
sudo cp systemd/whatsapp-pi-router.service.in /etc/systemd/system/whatsapp-pi-router.service
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-pi-router
```

The QR is printed in the router journal/terminal on first pairing. Treat journal access as privileged because pairing QR codes and route metadata are sensitive; prefer running the daemon in a protected terminal for first pairing and restrict persistent journal access. Send `SIGUSR1` to log status (WhatsApp connection, route count, connected clients, and queue depth):

```bash
sudo -u whatsapp-router WHATSAPP_PI_ROUTER_CONFIG=/etc/whatsapp-pi-router/config.json whatsapp-pi-multiplex
sudo systemctl kill -s SIGUSR1 whatsapp-pi-router
```

Start each Pi client as its own user. Tokens are read only from per-user mode-`0600` files, never command-line arguments:

```bash
sudo -iu agent01 sh -lc 'env \
  WHATSAPP_PI_ROUTER_SOCKET=/run/whatsapp-pi/router.sock \
  WHATSAPP_PI_CREDENTIAL_FILE="$HOME/.config/whatsapp-pi-multiplex/token" \
  pi -e /path/to/whatsapp-pi.ts --whatsapp-multiplex-client=agent01'
```

For systemd-managed clients (one isolated service/tmux per Unix user), instantiate the included template after replacing its two build-time paths:

```bash
project=$(pwd)
pi_bin=$(command -v pi)
sed -e "s|__PROJECT_DIR__|$project|g" -e "s|__PI_BIN__|$pi_bin|g" \
  systemd/whatsapp-pi-multiplex-client@.service.in | \
  sudo tee /etc/systemd/system/whatsapp-pi-multiplex-client@.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-pi-multiplex-client@agent01
# Repeat through agent20 as provisioned; inspect one TUI with:
sudo -iu agent01 tmux attach -t whatsapp-pi-agent01
```

`whatsapp-pi` socket-group membership permits connection but not route claims. The router authenticates the client token and derives the outbound JID exclusively from its persisted delivery lease. A second live connection for a client is rejected. Router state stays mode `0700`; agent homes/credential directories are mode `0700` and tokens mode `0600`.

### Multiplex product v1 semantics and IPC protocol v2 limits

- Exact static routes only; no wildcard or default route. One in-flight delivery per route, with concurrency across routes.
- Live Baileys `notify` upserts are iterated and durably deduplicated before dispatch. Offline clients receive queued messages after reconnect/restart.
- Delivery to Pi is **at least once**, not exactly once. The router persists a `sending` boundary before calling WhatsApp; a daemon crash at that boundary is recovered as terminally ambiguous and is not redelivered. WhatsApp itself still cannot provide a transactional exactly-once guarantee.
- IPC is protocol v2 strict NDJSON. Client frames are capped at 272 KiB (4 KiB before authentication), media chunks at 192 KiB, text at 256 KiB, and inline images at 5 MiB. Documents and audio are streamed through a router-private durable spool using opaque delivery-bound handles, then verified and atomically materialized as mode-0600 files beneath the client user's private storage. Router filesystem paths are never sent. Video remains unsupported in multiplex mode.
- Each client's materialized multiplex-media cache is limited to 100 files and 250 MiB. Files older than 7 days and least-recently-written files above those limits are removed before startup/materialization; cleanup occurs before the new active document is committed. Audio remains ephemeral and is removed immediately after transcription.
- Client mode disables `/whatsapp` connection/config ownership, reactions, and arbitrary-JID outbound sends. Replies are scoped to the immutable active delivery ID.
- The compact JSON inbox is intended for the bounded 20-route/low-volume deployment. It allows at most 100 active records per route, 1,000 active records globally, and 100 MiB of retained JSON payloads. The separate media spool allows 25 MiB per file and 250 MiB total, reconciles crash leftovers, and expires abandoned data. Completed payloads are reduced to tombstones; tombstones expire after 7 days and are capped at 10,000. Snapshots are atomically replaced and fsynced, but SQLite may be preferable for sustained high volume.
- An active lease has no daemon-side turn timeout in the current multiplex product. A wedged client must disconnect/restart so the router requeues that delivery.
- Unix socket permissions and systemd hardening are Linux-oriented. Cross-UID isolation must be validated on the target host.

### Multiplex test quickstart

```bash
npm test
npm run lint
npm run typecheck
npm run build:router
npm pack --dry-run
```

## Development / Testing

If you are developing or testing the extension locally, clone [whatsapp-pi-multiplex](https://github.com/rahimnathwani/whatsapp-pi-multiplex):

1. Clone and install dependencies:
```bash
git clone https://github.com/rahimnathwani/whatsapp-pi-multiplex.git
cd whatsapp-pi-multiplex
npm install
```

2. Run the extension:

**Linux/macOS:**
```bash
pi -e whatsapp-pi.ts
```

**Windows (PowerShell):**
```powershell
./scripts/launch-pi.ps1
```

For verbose mode (shows Baileys trace logs and audio timing logs for debugging):
```bash
pi -e whatsapp-pi.ts --verbose
```

To test startup auto-connect locally after you have already paired WhatsApp:
```bash
pi -e whatsapp-pi.ts --whatsapp-pi-online
```

## How It Works

- Pi processes **incoming** messages only from allowed contacts or allowed groups.
- **Recents** is history browser, not trigger.
- **Send Message** and `send_wa_message` are outbound only.
- If you message yourself, WhatsApp may show sent/read ticks, but that does not guarantee Pi will treat it as a trigger.

## LLM-Callable Tools

The extension registers the following tools that the Pi agent can call:

| Tool | Direction | Description |
| --- | --- | --- |
| `send_wa_message` | outbound | Send a WhatsApp message to a contact or group (or reply to the last conversation if `jid` is omitted). |
| `send_reaction` | outbound | React to a WhatsApp message with an emoji. |
| `list_wa_conversations` | read-only | List recent conversations from the local recents store. Supports `onlyIncoming`, `onlyAllowed`, and `limit`. |
| `get_wa_conversation_history` | read-only | Get the most recent messages with a given `senderNumber` (accepts `+E164`, raw digits, or a JID). Supports `limit`. |
| `check_wa_new_messages` | read-only | List conversations whose most recent message is incoming (i.e. waiting for a reply). Supports `sinceTimestamp` (ms epoch). |

The three read-only tools query the local recents store at `~/.pi/agent/extensions/whatsapp-pi/recents/recents.json`. They never touch the network and do not mark messages as read.

## WhatsApp Numbers and JIDs

- Contacts use phone format in UI: `+5511999999999`
- Internally, contacts map to JIDs like `5511999999999@s.whatsapp.net`
- Groups use JIDs like `120363012345@g.us`
- Recents may show normalized values from WhatsApp, so use **Print Contact** / **Print Group JID** and aliases to avoid confusion.

## Commands

- `/whatsapp` - Open the WhatsApp management menu

### Main Menu Options
- **Connect / Reconnect WhatsApp** - Start WhatsApp connection using saved credentials when available; QR code appears only if pairing is required
- **Disconnect WhatsApp** - Stop WhatsApp connection
- **Logoff (Delete Session)** - Remove all credentials and session data
- **Recents** - Open recent conversations, view history, and reply
- **Allowed Contacts** - Manage contacts that can interact with Pi
- **Allowed Groups** - Manage WhatsApp groups that can interact with Pi

### Allowed Contacts Management
- **Add Contact** - Add a new contact to the allowed contacts list (format: +5511999999999)
- **Select a contact** - Open a submenu with **History**, **Send Message**, **Print Contact**, **Add Alias**, **Remove Alias**, **Add Number**, **Remove Number**, **Remove Contact**, and **Back**
- **Back** - Return to main menu

### Allowed Groups Management
- **Add Group** - Add a WhatsApp group JID to the allowed groups list (format: 120363012345@g.us)
- **Select a group** - Open a submenu with **History**, **Send Message**, **Print Group JID**, **Add Alias**, **Remove Alias**, **Remove Group**, and **Back**

### Recents Management
- **History** - Open full message history for that conversation
- **Send Message** - Send a new message without Pi suffix
- **Reply** - Open message detail, then press `R` to reply
- **Allow Contact / Allow Group** - Move a recent sender into the appropriate allowed list
- **Remove Alias** - Clear saved alias for that sender
- **Back** - Return to main menu

### WhatsApp Chat Commands
Send these commands directly in WhatsApp to control the agent session:
- **`/compact`** - Compact the current Pi session context
- **`/abort`** - Abort the current Pi agent operation

## Project Structure

```
src/
├── services/        # Core services (WhatsApp, Session, Recents, Media)
└── ui/              # Menu handlers and TUI views

tests/
└── unit/            # Unit tests
```

## Development

Run tests:
```bash
npm test
```

## Notes

- `--whatsapp-pi-online` auto-connects when credentials already exist.
- `--whatsapp-group <jid>` binds Pi to one WhatsApp group.
- Media handling is local: images for vision, audio via Whisper.cpp + ffmpeg, and documents stored as private files under `~/.pi/agent/extensions/whatsapp-pi/whatsapp-medias/`.
- Recents/history live in `~/.pi/agent/extensions/whatsapp-pi/recents/recents.json`.
- Session state, allow lists, and startup reconnects are persisted locally.
