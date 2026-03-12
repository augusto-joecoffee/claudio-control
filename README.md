<p align="center">
  <img src="public/icon.png" alt="Claude Control" width="128" height="128">
</p>

<h1 align="center">Claude Control</h1>

<p align="center">
  A native macOS desktop app for monitoring and managing multiple <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> sessions in real time.
</p>

When you're running several Claude Code instances across different repos and worktrees, it's hard to keep track of what each one is doing. Claude Control auto-discovers all running sessions and gives you a single dashboard with live status, git changes, conversation previews, and quick actions.

![Dashboard](docs/screenshot.png)

## Features

- **Auto-discovery** — Detects all running `claude` CLI processes via the process table and maps them to their JSONL conversation logs
- **Live status** — Classifies each session as Working, Idle, Waiting (needs input), Errored, or Finished based on CPU usage, file modification times, and conversation state
- **Git integration** — Shows branch name, changed files, additions/deletions, and detects open pull requests via `gh`
- **Task context** — Extracts Linear issue titles and descriptions from MCP tool results to show what each session is working on
- **Conversation preview** — Shows the last assistant message, active tool, and user prompt for each session
- **Notification sounds** — Plays a subtle chime when a session transitions from working to waiting/idle
- **Quick actions** — One-click buttons to focus the iTerm tab, open VS Code, Fork, or Finder for any session
- **New session creation** — Create new Claude Code sessions with git worktree support, repo browsing, and custom initial prompts
- **PR workflow** — Send `/create-pr` to idle sessions and see PR links once created
- **Worktree cleanup** — Remove worktrees, branches, and kill sessions with a two-step confirmation flow

## Requirements

- **macOS** (uses AppleScript for iTerm integration, native folder picker, etc.)
- **Node.js** >= 18
- [**Claude Code CLI**](https://docs.anthropic.com/en/docs/claude-code) installed and running
- [**iTerm2**](https://iterm2.com/) (for terminal focus and session creation features)
- [**GitHub CLI**](https://cli.github.com/) (`gh`) for PR detection (optional)

## Install from DMG

Download the latest `.dmg` from the [Releases](../../releases) page, open it, and drag the app to Applications.

> **Note:** The app is not notarized with Apple, so macOS will block it on first launch. To get past Gatekeeper, either right-click the app and select **Open**, or run:
> ```bash
> xattr -cr /Applications/Claude\ Control.app
> ```

## Build from source

```bash
# Clone the repo
git clone https://github.com/your-username/claude-control.git
cd claude-control

# Install dependencies
npm install

# Run in development mode (hot-reload)
npm run electron:dev

# Or build a distributable DMG
npm run electron:build
```

The development server runs on port 3200. The Electron shell loads it automatically.

### Scripts

| Command | Description |
|---|---|
| `npm run electron:dev` | Dev mode with hot-reload (Next.js + Electron) |
| `npm run electron:build` | Production build → DMG + ZIP in `dist/` |
| `npm run electron:pack` | Production build → unpacked app in `dist/` |
| `npm run dev` | Next.js dev server only (no Electron shell) |
| `npm run build` | Next.js production build only |
| `npm run lint` | Run ESLint |

## How it works

### Session discovery

1. Finds all processes named `claude` via `ps`
2. Filters out Claude Desktop (only CLI instances)
3. Gets each process's working directory via `lsof`
4. Maps the working directory to `~/.claude/projects/<escaped-path>/` to find conversation JSONL files
5. Reads the tail of each JSONL file to extract session state

### Status classification

| Status | Condition |
|---|---|
| **Working** | JSONL modified recently AND CPU > 5%, or CPU > 15% |
| **Waiting** | Last assistant message has a pending tool use (permission prompt) or is asking for user input |
| **Idle** | Process alive, low activity |
| **Errored** | Last message contains error indicators |
| **Finished** | Process no longer running |

### Architecture

```
Electron shell (macOS native window)
    ↓
Browser (SWR polls /api/sessions every 2s)
    ↓
Next.js API Routes (standalone server)
    ↓
┌──────────────────────────────────────────┐
│  discovery.ts  →  process-utils.ts       │  ps, lsof
│                →  paths.ts               │  ~/.claude/projects mapping
│                →  session-reader.ts       │  JSONL parsing
│                →  git-info.ts            │  git status, diff, PR detection
│                →  status-classifier.ts   │  Status state machine
└──────────────────────────────────────────┘
```

No database — all state is derived from the filesystem and process table on every request.

## First-time setup

On first launch, the app will ask you to select your code directory (the parent folder containing your git repos, e.g. `~/Code`). This is stored in `~/.claude-control/config.json` and used for the repo picker when creating new sessions.

You can add multiple code directories. The app scans up to two levels deep for git repositories.

## Project structure

```
├── electron/
│   └── main.js                  # Electron main process
├── src/
│   ├── app/
│   │   ├── page.tsx             # Dashboard
│   │   ├── session/[id]/        # Session detail view
│   │   └── api/                 # API routes (sessions, actions, repos)
│   ├── components/              # React components
│   ├── hooks/                   # SWR hooks, notification sound
│   └── lib/                     # Core logic (discovery, git, JSONL parsing)
├── scripts/
│   ├── prepare-build.js         # Assembles standalone Next.js app
│   └── after-pack.js            # Copies into Electron resources
└── public/
    └── icon.png
```

## Tech stack

- **Electron** — Native macOS window with hidden title bar
- **Next.js 14** (App Router, standalone output) — Serves both API and UI from a single process
- **TypeScript** (strict)
- **Tailwind CSS 3** — Dark theme
- **SWR** — Client-side polling with 2-second intervals

## Contributing

This is a side project built for personal use. PRs welcome if you find it useful and want to improve it.

Some areas that could use work:
- Linux/Windows support (currently macOS-only due to AppleScript usage)
- Better status detection for permission prompts
- Support for other terminals beyond iTerm2

## License

MIT
