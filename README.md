# Conclave

> **Multi-node fork of [thepopebot](https://github.com/stephengpope/thepopebot).** Conclave keeps popebot's UI, scheduler, and agent model intact and adds a fleet of remote worker **nodes**: a central control plane dispatches Claude or OpenClaw jobs to Mac, Windows, or Linux machines over a persistent WebSocket. One UI, many machines.
>
> Status: WIP. Original popebot README below.

## What's wired up

| Path | Status | How |
|---|---|---|
| Agent jobs (`createAgentJob` → coding-agent container) | ✅ Dispatchable to remote nodes | `CONCLAVE_DISPATCH_AGENT_JOB=auto` (default), shared spec via `buildAgentJobContainerSpec` |
| Lightweight `claude -p` jobs on a node | ✅ `runtime: claude-cli` | Uses the worker host's local Claude install/auth |
| OpenClaw forwarding | ✅ `runtime: openclaw` | Worker POSTs to a local OpenClaw gateway |
| Cluster roles | ❌ **Not dispatched — see below** | Architectural blocker |
| Interactive code workspaces | ❌ Not dispatched | ttyd/long-lived; needs different transport semantics |
| Headless `command/*` runtimes | ❌ Not dispatched | Same workspace coupling as interactive |

## Why cluster roles aren't dispatchable (yet)

Cluster roles use a **shared filesystem** to pass state between the central server and the worker container. The central writes `system-prompt.md`, `user-prompt.md`, `meta.json`, `trigger.json` to `data/clusters/cluster-{id}/role-{id}/...`, bind-mounts that directory into the container at `/home/coding-agent/workspace`, and the cluster-worker entrypoint reads the files from inside.

Agent jobs work for remote dispatch because they use **git** as their state-passing mechanism — the worker just clones the `agent-job/{id}` branch. Cluster roles can't use the same trick without either:

1. A shared filesystem mounted on every worker (NFS/syncthing/operator-provisioned) — fragile, easy to misconfigure.
2. A file-sync layer in conclave itself that ships the role's directory to the worker before each run and pulls results back — its own subsystem, real engineering.
3. Redesigning cluster roles to pass their state via the dispatch payload (env vars + inline content) instead of via files — invasive popebot core change.

For now: clusters keep running locally on the central server. Agent jobs are the "fleet does real work" path.

---

# ThePopeBot

Build autonomous AI agents that work for you 24/7, individually or in teams.

### What You Get

- **Runs 24/7** — set up tasks and your agent handles them around the clock, no babysitting
- **Does real work** — writes code, opens pull requests, completes multi-step tasks end to end
- **Agent clusters** — build teams of agents that coordinate and work together on bigger jobs
- **Full visibility** — every action is a commit you can review, approve, or undo

<a href="https://www.skool.com/ai-architects"><img src="docs/hero.png" width="100" alt="ThePopeBot" /></a>

[Get priority support HERE](https://www.skool.com/ai-architects)

---

## How It Works

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌─────────────────┐         ┌─────────────────┐                     │
│  │  Event Handler  │ ──1──►  │     GitHub      │                     │
│  │ (creates branch)│         │(agent-job/* br) │                     │
│  └────────▲────────┘         └─────────────────┘                     │
│           │                                                          │
│           │  2 (launches Docker container locally)                   │
│           │                                                          │
│           ▼                                                          │
│  ┌─────────────────┐                                                 │
│  │  Docker Agent   │                                                 │
│  │ (coding agent)  │                                                 │
│  └────────┬────────┘                                                 │
│           │                                                          │
│           │  3 (commits, pushes, creates PR)                         │
│           │                                                          │
│           ▼                                                          │
│  ┌─────────────────┐                                                 │
│  │     GitHub      │                                                 │
│  │   (PR opened)   │                                                 │
│  └────────┬────────┘                                                 │
│           │                                                          │
│           │  4a (auto-merge.yml)                                     │
│           │  4b (rebuild-event-handler.yml)                          │
│           │                                                          │
│           5 (notify-pr-complete.yml →                                │
│           │  webhook to event handler)                               │
│           └──────────────────────────►  Event Handler                │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

You interact with your bot via the web chat interface or Telegram (optional). The Event Handler creates an agent-job branch and launches a Docker container locally with the coding agent. The agent does the work, commits the results, pushes, and opens a PR. Auto-merge handles the rest. You get a notification when it's done.

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=stephengpope/thepopebot&type=date&legend=top-left)](https://www.star-history.com/#stephengpope/thepopebot&type=date&legend=top-left)

---

## Get Started

### Prerequisites

| Requirement | Install |
|-------------|---------|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) |
| **npm** | Included with Node.js |
| **Git** | [git-scm.com](https://git-scm.com) |
| **GitHub CLI** | [cli.github.com](https://cli.github.com) |
| **Docker + Docker Compose** | [docker.com](https://docs.docker.com/get-docker/) (installer requires admin password) |
| **ngrok*** | [ngrok.com](https://ngrok.com/download) (free account + authtoken required) |

*\*ngrok is only required for local installs without port forwarding. VPS/cloud deployments don't need it. [Sign up](https://dashboard.ngrok.com/signup) for a free ngrok account, then run `ngrok config add-authtoken <YOUR_TOKEN>` before starting setup.*

### Two steps

**Step 1** — Scaffold a new project:

```bash
mkdir my-agent && cd my-agent
npx thepopebot@latest init
```

This creates a Next.js project with configuration files, GitHub Actions workflows, and agent templates. You don't need to create a GitHub repo first — the setup wizard handles that.

**Step 2** — Run the setup wizard:

```bash
npm run setup
```

The wizard walks you through everything:
- Checks prerequisites (Node.js, Git, GitHub CLI, Docker)
- Creates a GitHub repository and pushes your initial commit
- Creates a GitHub Personal Access Token (scoped to your repo)
- Configures your public URL and webhook secret
- Syncs settings to `.env`, database, and GitHub secrets/variables
- Starts Docker for you

**That's it.** Visit your APP_URL when the wizard finishes.

- **Web Chat**: Visit your APP_URL to chat with your agent, create jobs, upload files
- **Telegram** (optional): Run `npm run setup-telegram` to connect a Telegram bot
- **Webhook**: Send a POST to `/api/create-agent-job` with your API key to create jobs programmatically
- **Cron**: Edit `agent-job/CRONS.json` to schedule recurring jobs

### Chat vs Agent LLM

Your bot has two sides — a **chat** side and an **agent** side.

**Chat** is the conversational part. When you talk to your bot in the web UI or Telegram, it uses the chat LLM. This runs on your server and responds in real time.

**Agent** is the worker. When your bot needs to write code, modify files, or do a bigger task, it spins up a separate job that runs in a Docker container on GitHub. That job uses the agent LLM.

By default, both use the same model. But during setup, you can choose different models for each — for example, a faster model for chat and a more capable one for agent jobs. The wizard asks "Would you like agent jobs to use different LLM settings?" and lets you pick.

### Using a Claude Subscription (OAuth Token)

If you have a Claude Pro ($20/mo) or Max ($100+/mo) subscription, you can use it to power your agent jobs instead of paying per API call. During setup, choose Anthropic as your agent provider and say yes when asked about a subscription.

You'll need to generate a token:

```bash
# Install Claude Code CLI (if you don't have it)
npm install -g @anthropic-ai/claude-code

# Generate your token (opens browser to log in)
claude setup-token
```

Paste the token (starts with `sk-ant-oat01-`) into the setup wizard. Your agent jobs will now run through your subscription. Note that usage counts toward your Claude.ai limits, and you still need an API key for the chat side.

See [Coding Agents](docs/CODING_AGENTS.md) for details on all five agent backends.

> **Local installs**: Your server needs to be reachable from the internet for GitHub webhooks and Telegram. On a VPS/cloud server, your APP_URL is just your domain. For local development, use [ngrok](https://ngrok.com) (`ngrok http 80`) or port forwarding to expose your machine.
>
> **If your ngrok URL changes** (it changes every time you restart ngrok on the free plan), you must update APP_URL everywhere:
>
> ```bash
> # Update .env and GitHub variable in one command:
> npx thepopebot set-var APP_URL https://your-new-url.ngrok.io
> # If Telegram is configured, re-register the webhook:
> npm run setup-telegram
> ```

---

## Updating

```bash
npx thepopebot upgrade          # latest stable
npx thepopebot upgrade @beta    # latest beta
npx thepopebot upgrade 1.2.72   # specific version
```

Saves your local changes, syncs with GitHub, installs the new version, rebuilds, pushes, and restarts Docker.

**What it does:**

1. Saves any local changes you've made
2. Pulls the latest from GitHub (stops if there are conflicts)
3. Installs the new version and updates project files
4. Rebuilds your project
5. Pushes everything to GitHub
6. Restarts Docker containers (if running)

Pushing to `main` triggers the `rebuild-event-handler.yml` workflow on your server. It detects the version change, runs `thepopebot init`, updates `THEPOPEBOT_VERSION` in the server's `.env`, pulls the new Docker image, restarts the container, rebuilds `.next`, and reloads PM2 — no manual `docker compose` needed.

> **Upgrade failed?** See [Recovering from a Failed Upgrade](docs/UPGRADE.md#recovering-from-a-failed-upgrade).

See [CLI Reference](docs/CLI.md) for full details on `init`, managed vs user files, template conventions, and all CLI commands.

---

## Security

thepopebot includes API key authentication, webhook secret validation (fail-closed), session encryption, secret filtering in the Docker agent, and auto-merge path restrictions. However, all software carries risk — thepopebot is provided as-is, and you are responsible for securing your own infrastructure. If you're running locally with a tunnel (ngrok, Cloudflare Tunnel, port forwarding), be aware that your dev server endpoints are publicly accessible with no rate limiting and no TLS on the local hop.

See [Security](docs/SECURITY.md) for full details on what's exposed, the risks, and recommendations.

---

## Different Models

thepopebot supports 9 built-in LLM providers (Anthropic, OpenAI, Google, DeepSeek, MiniMax, Mistral, xAI, Kimi, OpenRouter) plus custom OpenAI-compatible endpoints. The chat layer and coding agents are independent — use Claude for interactive chat and a different model for code tasks, or run everything on a single provider.

See [Different Models](docs/RUNNING_DIFFERENT_MODELS.md) for the full provider reference, admin UI configuration, per-job overrides, and custom provider setup.

---

## Known Issues

### Windows: `SQLITE_IOERR_SHMOPEN`

SQLite can't create or open its shared-memory (`.shm`) file. Common causes:

- **Antivirus** (Windows Defender, etc.) locking the database files — add your project folder to the exclusion list
- **Cloud-synced folders** (OneDrive, Dropbox, Google Drive) — move your project to a non-synced directory like `C:\Projects\`

---

## Docs

| Document | Description |
|----------|-------------|
| [Architecture](docs/ARCHITECTURE.md) | Two-layer design, file structure, API endpoints, GitHub Actions, Docker agent |
| [CLI Reference](docs/CLI.md) | `init`, managed vs user files, template conventions, all CLI commands |
| [Configuration](docs/CONFIGURATION.md) | Admin UI, DB-backed config, infrastructure variables, GitHub secrets, Docker Compose |
| [Customization](docs/CUSTOMIZATION.md) | Personality, skills, operating system files, using your bot, security details |
| [Chat Integrations](docs/CHAT_INTEGRATIONS.md) | Web chat, Telegram, adding new channels |
| [Different Models](docs/RUNNING_DIFFERENT_MODELS.md) | 9 built-in LLM providers, chat vs coding agent config, per-job overrides, custom providers |
| [Auto-Merge](docs/AUTO_MERGE.md) | Auto-merge controls, ALLOWED_PATHS configuration |
| [Deployment](docs/DEPLOYMENT.md) | VPS setup, Docker Compose, HTTPS with Let's Encrypt |
| [Coding Agents](docs/CODING_AGENTS.md) | 5 coding agent backends, OAuth tokens, LiteLLM proxy, per-agent config |
| [How to Build Skills](docs/HOW_TO_BUILD_SKILLS.md) | Guide to building and activating agent skills |
| [Pre-Release](docs/PRE_RELEASE.md) | Installing beta/alpha builds |
| [Code Workspaces](docs/CODE_WORKSPACES.md) | Interactive Docker containers with in-browser terminal |
| [Clusters](docs/CLUSTERS.md) | Agent clusters — groups of Docker containers spawned from role definitions |
| [Hacks](docs/HACKS.md) | Tips, tricks, and workarounds |
| [Mobile Testing](docs/MOBILE_TESTING.md) | Testing on mobile devices |
| [Security](docs/SECURITY.md) | Security disclaimer, local development risks |
| [Upgrading](docs/UPGRADE.md) | Automated upgrades, recovering from failed upgrades |

### Maintainer

| Document | Description |
|----------|-------------|
| [NPM](docs/NPM.md) | Updating skills, versioning, and publishing releases |
