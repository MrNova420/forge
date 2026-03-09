# ⚡ Forge AI — VS Code Extension

Local AI development assistant powered by **phi3.5-forge** via Ollama. Works like GitHub Copilot — inline completions, a chat panel, and code actions — all running 100% locally.

---

## Requirements

- **Forge server** running at `http://localhost:3737`
- **Ollama** installed with the `phi3.5-forge` model pulled
- **VS Code** 1.85+
- **Node.js** 18+ (for building)

---

## Installation

```bash
# 1. Navigate to the extension folder
cd /home/mrnova420/forge/forge-vscode

# 2. Install dependencies and compile
npm install && npm run compile

# 3. (Optional) Package as .vsix
npm install -g @vscode/vsce
vsce package --no-dependencies
# → produces forge-ai-1.0.0.vsix

# 4. Install in VS Code
# Ctrl+Shift+P → "Extensions: Install from VSIX" → pick forge-ai-1.0.0.vsix
```

Or run the included script:

```bash
chmod +x install.sh && ./install.sh
```

---

## Features

### 🔮 Inline Completions
Forge suggests code as you type — just like GitHub Copilot. Press `Tab` to accept.

- Sends your cursor's surrounding code (prefix + suffix) to `/complete/fim`
- Debounced by 600ms (configurable) to avoid flooding the model
- Works in every file type

### 💬 Chat Panel (`Ctrl+Shift+F` / `Cmd+Shift+F`)
Opens a side panel where you can have a conversation with Forge.

- Streams responses token-by-token in real time
- Falls back to non-streaming if SSE isn't available
- Ask about your code, architecture, bugs, anything

### 🛠 Code Actions (Right-click menu)
Select any code, right-click, and choose a Forge action:

| Action | What it does |
|--------|-------------|
| **Forge: Explain Code** | Opens an output channel with a plain-English explanation |
| **Forge: Fix Code** | Opens a new tab with the corrected version |
| **Forge: Generate Tests** | Opens a new tab with unit tests |
| **Forge: Refactor Code** | Opens a new tab with a cleaner version |

Keyboard shortcut: `Ctrl+Shift+.` to fix selected code instantly.

### 📊 Status Bar
The `⚡ Forge` indicator in the bottom-right shows connectivity:

- `⚡ Forge` — server is online
- `⚡ Forge ⚠` — server unreachable (checked every 30s)

Click it to open the chat panel.

### ⚙ Additional Commands (`Ctrl+Shift+P`)
- **Forge: Run Next Task** — triggers `/task/run-next` on the Forge server
- **Forge: Index Workspace** — (stub) will index open workspace files

---

## Settings

Open VS Code settings (`Ctrl+,`) and search **"Forge"**:

| Setting | Default | Description |
|---------|---------|-------------|
| `forge.apiUrl` | `http://localhost:3737` | Forge server URL |
| `forge.enableInlineCompletions` | `true` | Toggle inline completions on/off |
| `forge.completionDelay` | `600` | Debounce delay in milliseconds |
| `forge.model` | `phi3.5-forge` | Ollama model name |

---

## Keybindings

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+F` | Open Forge Chat |
| `Ctrl+Shift+.` | Fix selected code |

---

## API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `POST /complete/fim` | Inline fill-in-the-middle completions |
| `POST /chat` | Chat (streaming via SSE) |
| `POST /code/explain` | Explain selected code |
| `POST /code/fix` | Fix selected code |
| `POST /code/refactor` | Refactor selected code |
| `POST /code/generate-tests` | Generate unit tests |
| `POST /task/run-next` | Run next queued task |
| `GET  /health` | Health check for status bar |

---

## Troubleshooting

**`⚡ Forge ⚠` in status bar** — The extension can't reach `localhost:3737`. Start the Forge server first.

**No completions appearing** — Check that `forge.enableInlineCompletions` is `true` and the server is running. You can also increase `forge.completionDelay` if completions interrupt typing.

**Chat shows `❌ Error`** — Open the VS Code Developer Console (`Help → Toggle Developer Tools`) for the full error message.
