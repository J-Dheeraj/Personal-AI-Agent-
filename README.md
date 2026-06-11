# NanoClaw — Personal AI Agent

A self-hosted personal AI agent that accumulates a private knowledge graph, transcribes voice notes locally, runs semantic search offline, and connects to WhatsApp, Telegram, a web UI, and the terminal — all without ever exposing your API keys to a container.

Based on Dr. Vivian Balakrishnan's "Second Brain" setup, presented at AI Engineer Singapore (May 2026).

---

## Features

- **Four channels** — WhatsApp, Telegram, Web UI (port 3080), Terminal
- **Private knowledge graph** — mnemon stores facts extracted from articles, voice notes, and documents in local SQLite
- **On-device voice transcription** — whisper.cpp runs locally; audio never leaves your machine
- **Local semantic search** — Ollama + nomic-embed-text; no document content sent to cloud embedding APIs
- **Scheduled briefings** — cron-based morning summaries, weekly digests, one-time reminders
- **Container isolation** — one Docker container per messaging group; no shared memory or filesystem between groups
- **API key isolation** — OneCLI Agent Vault proxies all Anthropic API calls; containers never hold a raw key

---

## Architecture

```
Messaging apps (WhatsApp / Telegram / Web UI / CLI)
        │
        ▼
NanoClaw host process  (Node.js · src/index.ts)
  ├─ Router          → validates group name + sender → writes inbound.db
  ├─ Container runner → spawns one Docker container per agent group
  ├─ Delivery        → polls outbound.db → sends replies to channels
  ├─ Scheduler       → cron / interval / one-time tasks
  └─ OneCLI proxy    → intercepts container HTTPS → injects credentials
        │
        ▼  (one container per active group)
Docker container  (Bun runtime · nanoclaw-agent image)
  ├─ Claude Agent SDK   → reasoning + tool use
  ├─ mnemon             → SQLite + FTS5 knowledge graph
  ├─ whisper.cpp        → on-device speech-to-text
  ├─ Ollama client      → local vector embeddings
  └─ /workspace/group   → bind-mounted group directory
        │
        ▼  (two SQLite files per session)
  inbound.db   ← host writes, container reads
  outbound.db  ← container writes, host reads
```

**Three-stage knowledge pipeline:**

```
Raw sources         →   mnemon graph            →   wiki pages
(voice notes,           (structured facts,          (Obsidian vault,
 articles,               graph nodes,                entities / concepts /
 web clips,              FTS5 semantic search)        timelines)
 documents)
```

---

## Tech Stack

| Component | Tool |
|---|---|
| LLM | Claude (via Anthropic Agent SDK) |
| Credential proxy | OneCLI Agent Vault |
| WhatsApp | Baileys (WhatsApp Web protocol) |
| Telegram | node-telegram-bot-api |
| Web UI | Express · port 3080 |
| Knowledge graph | mnemon (SQLite + FTS5) |
| Local embeddings | Ollama + nomic-embed-text |
| Voice transcription | whisper.cpp (on-device) |
| Storage | SQLite (inbound / outbound per session) |
| Containers | Docker (WSL2 backend) |
| Notes browser | Obsidian (optional) |

---

## Prerequisites

Run all of these in your **WSL2 Ubuntu** terminal before installing.

```bash
# 1. Confirm WSL2 (not WSL1) — VERSION column must show 2
wsl.exe --list --verbose

# 2. Install build tools
sudo apt-get update
sudo apt-get install -y build-essential python3 git curl

# 3. Confirm Docker is reachable from WSL
docker ps
# If this fails: Docker Desktop → Settings → Resources →
# WSL Integration → enable Ubuntu → Apply & Restart → wsl --shutdown

# 4. Clone into the Linux filesystem (NOT /mnt/c/ — 10-100x slower for builds)
cd ~
git clone https://github.com/J-Dheeraj/Personal-AI-Agent- nanoclaw
cd nanoclaw

# 5. Have your Anthropic API key ready (sk-ant-...)
# Get one at: https://console.anthropic.com/settings/api-keys
# Add $10–20 credit before starting.
```

---

## Installation

```bash
cd ~/nanoclaw
bash nanoclaw.sh
```

The installer will:

1. Check / install Node 22 (via nvm) and pnpm 10
2. Install and configure **OneCLI Agent Vault** — paste your `sk-ant-...` key when prompted. OneCLI stores it; NanoClaw never touches it again.
3. Build the agent Docker container image
4. Create security config files (`mount-allowlist.json`, `sender-allowlist.json`)
5. Register a systemd user service (or a start script if systemd is absent)

---

## Security Configuration

Do this **before** pairing any messaging channel.

### Mount allowlist

Controls which host directories containers may access. Lives outside the project root at `~/.config/nanoclaw/mount-allowlist.json` so containers cannot read it.

```json
{
  "allowedPaths": [
    "~/nanoclaw/groups",
    "~/nanoclaw/data",
    "~/Documents/nanoclaw-ingest"
  ],
  "blockedPatterns": [
    ".ssh", ".aws", ".gnupg", ".config/gh", ".config/nanoclaw",
    "*.pem", "*.key", "*.p12", "*.pfx",
    "id_rsa", "id_ed25519", "credentials", ".netrc"
  ]
}
```

Never add `~` or `/home` as an allowed path.

### Sender allowlist

Controls which senders can trigger the agent. `drop` mode silently ignores and does not store messages from unlisted senders.

```json
{
  "defaultMode": "drop",
  "groups": {
    "main": {
      "mode": "drop",
      "allowedSenders": ["YOUR_PHONE_NUMBER@s.whatsapp.net"]
    }
  }
}
```

Replace `YOUR_PHONE_NUMBER` with your number in international format (e.g. `6591234567`).

### OneCLI rate limits (recommended)

```bash
# Limit email sends to 5/hour
onecli rules create \
  --name "Email send rate limit" \
  --host-pattern "gmail.googleapis.com" \
  --path-pattern "/gmail/v1/users/*/messages/send" \
  --action rate_limit --rate-limit 5 --rate-window 1h

# Limit delete operations to 3/hour
onecli rules create \
  --name "Delete rate limit" \
  --host-pattern "*.googleapis.com" \
  --path-pattern "*/delete*" \
  --action rate_limit --rate-limit 3 --rate-window 1h
```

---

## Adding Channels

### WhatsApp

```
/add-whatsapp
```

Scan the QR code with WhatsApp → Settings → Linked Devices → Link a Device.

> **Note:** Baileys uses the WhatsApp Web protocol, which is technically against WhatsApp's ToS for automated use. This is intended for personal use only.

### Telegram

```
/add-telegram
```

1. Message `@BotFather` on Telegram → `/newbot`
2. Copy the token (`123456789:ABC-...`)
3. Paste it into NanoClaw when prompted
4. Add your Telegram user ID to `sender-allowlist.json` (find it by messaging `@userinfobot`)

### Web UI

Available immediately at **http://localhost:3080** — no extra setup required.

### Terminal

Start the service and type directly into the prompt:

```bash
bash start-nanoclaw.sh
```

---

## Local AI Setup

### Embeddings (Ollama)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the embedding model (274 MB — runs on any modern CPU)
ollama pull nomic-embed-text

# Verify
ollama list
```

Then in the NanoClaw web UI:

```
/add-ollama
```

### Voice transcription

whisper.cpp is included in the agent container. Send a voice note to your WhatsApp or Telegram bot — it will be transcribed locally within 10–30 seconds and ingested into the knowledge graph automatically.

---

## Using the Knowledge Graph

| Command | What happens |
|---|---|
| `ingest this: https://example.com/article` | Article extracted → facts added to knowledge graph |
| `what do I know about [topic]?` | Semantic search of knowledge graph |
| Send a voice note | Transcribed locally → ingested into graph |
| Attach a PDF or document | Parsed and ingested |
| `summarise everything you know about [person]` | Graph synthesis |

Browse the wiki in Obsidian (optional):

1. Download Obsidian from [obsidian.md](https://obsidian.md)
2. Open folder as vault → `~/nanoclaw/groups/main/wiki/`
3. Pages are organized under `entities/`, `concepts/`, `timelines/`

---

## Scheduled Tasks

```
every morning at 7:30am, send me a summary of what I've saved this week
in 2 hours remind me to review the proposal
every Sunday at 9am, compile a digest of everything I ingested this week
```

Check active tasks:

```
/tasks
```

---

## Agent Commands

| Command | Action |
|---|---|
| `/add-whatsapp` | Pair WhatsApp channel |
| `/add-telegram` | Pair Telegram channel |
| `/add-ollama` | Connect local embedding model |
| `/tasks` | List active scheduled tasks |
| `/status` | Show agent and container health |
| `/help` | List all available commands |

---

## Security Verification Checklist

Run after full setup. Do not skip any item.

```bash
# 1. No API keys in any container
docker inspect $(docker ps -q) | grep -i "sk-ant\|anthropic_api\|api_key"
# Expected: no output

# 2. OneCLI is the only path to api.anthropic.com
docker exec $(docker ps -q | head -1) sh -c \
  "ss -tnp | grep -v localhost | grep -v 127.0.0.1"
# All external connections should route through OneCLI's local port

# 3. Mount allowlist is enforced
docker run --rm -v ~/.ssh:/test alpine ls /test
# Expected: permission error

# 4. Sender allowlist is active — send from a number NOT in your allowlist
# Expected: no response, no stored message

# 5. Group folder names are valid
ls ~/nanoclaw/groups/
# Every name must match: ^[a-zA-Z0-9_-]+$

# 6. Ollama serving embeddings locally
curl http://localhost:11434/api/tags | grep nomic-embed-text

# 7. whisper.cpp on-device
docker exec $(docker ps -q | head -1) which whisper-cpp

# 8. Web UI is localhost only (not network-exposed)
# From another machine: curl http://YOUR_PC_IP:3080
# Expected: connection refused
# If accessible externally, add WEB_HOST=127.0.0.1 to .env and restart
```

---

## Operations

### Update NanoClaw

```bash
cd ~/nanoclaw
git pull
pnpm install
./container/build.sh
systemctl --user restart nanoclaw-v2
```

### View logs

```bash
# Main service
tail -f ~/nanoclaw/logs/nanoclaw.log

# Specific container
docker logs $(docker ps -q --filter name=whatsapp) -f
```

### Back up your knowledge graph

```bash
cp -r ~/nanoclaw/groups/main ~/nanoclaw-backup-$(date +%Y%m%d)
cp ~/nanoclaw/data/v2.db ~/nanoclaw-data-backup-$(date +%Y%m%d).db
```

---

## Project Structure

```
nanoclaw/
├── src/
│   ├── index.ts                  # Main orchestrator
│   ├── logger.ts
│   ├── router/index.ts           # Message routing + group validation
│   ├── security/
│   │   ├── groupNames.ts         # Strict alphanumeric name validation
│   │   ├── senderAllowlist.ts    # drop / trigger mode enforcement
│   │   └── mountAllowlist.ts     # Allowlist + blocked pattern enforcement
│   ├── channels/
│   │   ├── whatsapp.ts           # Baileys connector
│   │   ├── telegram.ts           # Telegram bot connector
│   │   ├── webui.ts              # Express on 127.0.0.1:3080
│   │   └── cli.ts                # readline terminal interface
│   ├── container/runner.ts       # Docker spawner (no API keys passed)
│   ├── delivery/index.ts         # outbound.db poller
│   └── scheduler/index.ts        # node-cron task runner
├── container/
│   ├── Dockerfile                # Bun/Alpine agent image
│   ├── build.sh
│   └── agent/
│       ├── index.ts              # Claude agentic loop
│       ├── mnemon/index.ts       # SQLite + FTS5 knowledge graph
│       └── tools/
│           ├── ingest.ts         # URL fetch + fact extraction
│           └── search.ts         # Knowledge graph search
├── public/index.html             # Web chat UI
├── config/examples/              # Example security config files
├── nanoclaw.sh                   # Installer
├── start-nanoclaw.sh             # Manual start (no systemd)
└── .env.example
```

---

## Important Caveats

1. **Prompt injection is not solved.** The sender allowlist and rate limits reduce the blast radius, but are not a complete defence. Do not connect the agent to systems whose compromise would be severe (banking, production databases).

2. **WhatsApp ToS.** Baileys uses the WhatsApp Web protocol. This is technically against WhatsApp's terms of service for automated use. Use for personal purposes only and understand the risk.

3. **API costs.** Claude API is pay-as-you-go. Frequent scheduled tasks with large context windows can add up. Monitor usage at [console.anthropic.com/usage](https://console.anthropic.com/usage) and set a spending limit.

4. **whisper.cpp model size vs speed.** The `base` model is fast but less accurate. The `medium` model is more accurate but slower on a laptop. Start with `base` and upgrade if transcription quality is poor.

---

## References

- [NanoClaw GitHub](https://github.com/nanocoai/nanoclaw)
- [Official docs](https://docs.nanoclaw.dev)
- [Security deep dive](https://docs.nanoclaw.dev/advanced/security-model)
- [OneCLI Agent Vault](https://github.com/onecli/onecli)
- [Dr. Balakrishnan's original gist](https://gist.github.com/VivianBalakrishnan/a7d4eec3833baee4971a0ee54b08f322)
- [Anthropic Console](https://console.anthropic.com)
- [NanoClaw Discord](https://discord.gg/VDdww8qS42)

---

## License

MIT

---

## Production Fixes

The following 17 hardening and correctness changes have been applied to this codebase:

**Critical:** (1) `senderAllowlist.ts` now fails-closed — missing config throws an error and rejects all messages rather than permitting them; schema validation enforces `defaultMode` and `groups` shape. (2) `container/runner.ts` replaces all `execSync` shell-string calls with `execFileSync` and discrete argument arrays, eliminating shell injection. (3) Containers use a dedicated `nanoclaw-net` bridge network instead of `--network host`; `host.docker.internal` replaces `127.0.0.1` for OneCLI and Ollama. (4) `delivery/index.ts` dispatches messages for real via `sendWhatsApp`, `sendTelegram`, `sendWebUI`, and stdout — the previous stub only logged. (5) `container/agent/index.ts` wraps the full `processMessage` body in try/catch; each tool call has its own try/catch returning `is_error: true`; 5 consecutive tool errors abort the loop and write an error reply to `outbound.db`.

**Important:** (6) Allowlist config is cached in memory and hot-reloaded via `fs.watch` — disk reads no longer happen per message; `reloadConfig()` and `closeAllowlistWatcher()` are exported for callers. (7) Scheduled tasks survive restarts — `scheduler/index.ts` persists tasks in `scheduler.db` and replays them with `loadPersistedTasks()` on startup; the cron callback injects prompts into `inbound.db`. (8) `mnemon/index.ts` stores embeddings via Ollama + `nomic-embed-text` in a `BLOB` column and implements `semanticSearch()` with cosine similarity, falling back to FTS5 if Ollama is unreachable. (9) Context injected into the system prompt is capped at 4,000 characters with a truncation note. (10) Every tool call is logged to `audit.db` with name, input, result (≤2,000 chars), duration, and timestamp. (11) `GET /health` returns container status, `last_inbound_at`, `last_outbound_at` per group, OneCLI reachability, and scheduler task count.

**Nice-to-have:** (12) HTML extraction uses `@mozilla/readability` + `jsdom` instead of a regex strip, with a regex fallback on parse failure. (13) Ingested content is stored up to 50,000 characters with separate `title` and `summary` facts. (14) System prompt is fully structured with identity, knowledge-graph instructions, tool constraints, response format, and decline rules. (15) Token usage is recorded per message in `agent_costs` and accumulated in session-level counters exposed via `getSessionCost()`. (16) `mnemon: any` replaced with the exported `Mnemon` type in all tool files. (17) Graceful shutdown handles SIGTERM/SIGINT, propagates the `shuttingDown` flag to the router (which drops in-flight messages), drains the delivery poller, closes DB handles, and forces exit on a second signal.
