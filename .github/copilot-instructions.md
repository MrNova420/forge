# Forge — Copilot Instructions

## What This Project Is

Forge is a fully local autonomous AI development team. It runs a 9-stage multi-agent pipeline (research → architect → coder → refactor → tester → reviewer → arch-review → security → docs) against user-defined projects, scoring and improving code until it meets quality thresholds. All inference runs via **Ollama** on the local machine (GTX 1650 SUPER, 4 GB VRAM).

---

## Running the System

```bash
# Start the API server (port 3737)
bash start.sh          # recommended — checks if already running, logs to logs/forge.log
node src/server.js     # direct, logs to stdout

# Run the full pipeline against a project
bash run-all.sh <project_id>

# Build the React dashboard (after any App.jsx change)
cd dashboard && npm run build
# Then restart the server so Express serves the new bundle

# Dashboard dev server (hot reload, port 5173)
cd dashboard && npm run dev

# Lint the dashboard
cd dashboard && npm run lint

# Watch server logs
tail -f logs/forge.log
```

There is no `npm test` — the tester agent generates and runs tests at runtime as part of the pipeline.

---

## Architecture

### Backend — `src/server.js`
Express 5 API, **~5100 lines, single file**. Contains all routes, all agent PROMPTS, the full pipeline runner, and all business logic. There are no routing modules — everything lives here.

### Supporting modules in `src/`
| File | Purpose |
|---|---|
| `agent.js` | Base `Agent` class — role, model, memory, `run()`, `reflect()` |
| `multipass.js` | Best-of-N quality amplifier + `scoreCode()` |
| `ollama.js` | Thin wrapper around the Ollama HTTP API |
| `tools.js` | File I/O, git, shell execution, web search |
| `session-memory.js` | Cross-session JSON persistence (`db/session-memory.json`) |
| `memory.js` | In-session working memory |
| `improve.js` | Iterative improvement loop |
| `knowledge-base.js` | Semantic knowledge retrieval |
| `embeddings.js` | Text embedding helpers |
| `indexer.js` | Code/file indexing |
| `pattern-library.js` | Code pattern storage and lookup |

### Frontend — `dashboard/`
React 19 + Vite + Tailwind CSS. **`dashboard/src/App.jsx` is a single large file** (~47 k lines) containing all shared components, state, and the five panel components imported from `dashboard/src/panels/`.

| Panel file | Dashboard tab |
|---|---|
| `panels/OverviewPanel.jsx` | Overview — projects, epics, stats |
| `panels/PipelinePanel.jsx` | Pipeline — kanban, stage indicator, task queue |
| `panels/ChatPanel.jsx` | Chat — model picker dropdown, streaming |
| `panels/ModelsPanel.jsx` | Models — VRAM bars, hot/cold badges, model cards |
| `panels/SettingsPanel.jsx` | Settings — VRAM unload, config |

Reusable animated components live in `dashboard/src/components/`.

Express serves the built bundle from `dashboard/dist/` — **rebuild with `cd dashboard && npm run build` then restart server** after any frontend change.

### Database
- **`better-sqlite3`** — synchronous C bindings; NOT the async `sqlite3` package. All queries are blocking.
- Three DB files under `db/`: `project.db`, `agent_memory.db`, `prompts.db`
- **No connection pool** — each endpoint instantiates its own DB object
- Schema created inline via `.prepare()` calls; no migration files

### Port / Environment
| Variable | Default | Purpose |
|---|---|---|
| `FORGE_PORT` | `3737` | API listen port |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama inference endpoint |
| `FORGE_MODEL` | `phi3.5-forge` | Default Ollama model |

No `.env` file — these are hardcoded defaults in `src/server.js`.

### Hardware Constraints (CRITICAL)
- GPU: GTX 1650 SUPER — **4 GB VRAM**
- Default model: `phi3.5-forge` (Q4_0, ~2.2 GB) + KV cache at 4096 ctx = ~3.8 GB total
- **Never set `DEFAULT_CTX` above 4096** — model spills to RAM and runs 5–10× slower
- `keep_alive: "10m"` in chat requests keeps model hot between calls
- `num_gpu: 99` forces all layers onto the GPU
- Models >4 GB (e.g. qwen3:8b at 5.2 GB) cannot load and show a ⚠ warning in the UI

---

## Key Conventions

### Agent Instantiation
```js
// Constructor: (role, systemPrompt, opts)
const agent = new Agent('coder', PROMPTS.coder, { model: 'phi3.5-forge' });

// run() opts
const { output, score } = await agent.run(taskDescription, {
  useMultipass: true,
  minScore: 7,
  rounds: 3,
  taskId: task.id,
  model: 'phi3.5-forge'   // can override per-call
});
```

`run()` must destructure `model` from opts and apply `if (model) this.model = model` — historical bug; do not regress.

### multipass() vs scoreCode()
- `multipass(task, systemPrompt, opts)` — best-of-N loop; use inside agents
- `scoreCode(text, knownFiles[])` — returns `{ score, issues, suggestions }`; inline scoring
- multipass samples N times at varied temperatures and picks the best; it does **not** revise/critique

### Model Switching (Ollama VRAM eviction)
Evicting a model requires sending `keep_alive: 0` to **both** `/api/generate` AND `/api/chat` — Ollama tracks loaded state per-endpoint. Send both as fire-and-forget, then **poll `/api/ps`** until the model is gone before loading the next one. The endpoint `/model/switch` in `server.js` implements this correctly — do not regress.

```js
// Pattern used in /model/switch
fetch(`${OLLAMA_URL}/api/generate`, { method:'POST', body: JSON.stringify({ model, keep_alive:0, prompt:'' }) });
fetch(`${OLLAMA_URL}/api/chat`,     { method:'POST', body: JSON.stringify({ model, keep_alive:0, messages:[] }) });
// then poll /api/ps for up to 90s
```

### pipeline_log — Always JSON.parse
`pipeline_log` is stored in SQLite as a **JSON string**, not an object. Always parse it before use:
```js
// BAD — typeof plog === 'object' is ALWAYS false
const plog = task.pipeline_log;

// GOOD
let plog = null;
try { plog = JSON.parse(task.pipeline_log); } catch {}
```

### Database Queries — Avoid Ambiguous Columns
Any query joining `tasks` with `epics` or `projects` **must** prefix column names:
```js
// BAD — "ambiguous column name: title"
db.prepare('SELECT title FROM tasks JOIN epics ON ...').all();

// GOOD
db.prepare('SELECT t.title, t.quality_score FROM tasks t JOIN epics e ON ...').all();
```

### Code Output Format Expected by Scorer
Agent-generated code **must** start with a `FILE:` prefix line for `scoreCode()` to award the file-prefix point:
```
FILE: src/routes/users.js
const express = require('express');
```
Hardcoded secrets (`password =`, `api_key =`, etc.) incur a **−2 penalty**. Empty catch blocks cost **−1**.

### Mutex Pattern
Only one pipeline task runs at a time. In-memory flag with a 20-minute auto-timeout.
```js
if (!acquireMutex()) return res.json({ status: 'busy' });
try { ... } finally { releaseMutex(); }
```
Emergency reset: `POST /mutex/reset`

### Session Memory Injection
Every task's `sharedContext` must include:
```js
const sharedContext = `
...project info...
BEST PRACTICES:\n${sessionMem.getBestPracticesContext()}
AVOID THESE ERRORS:\n${sessionMem.getErrorAvoidanceContext()}
`;
```
After completion: `sessionMem.recordBestPractice()` / `sessionMem.recordErrorPattern()`.

### n8n Notifications
`notifyN8n(event, payload)` fires on `task_done` and `epic_complete`. **Must never throw** — n8n being offline cannot break the pipeline. Always wrap in try/catch.

### SSE Events
```js
broadcast({ type: 'task_done', taskId, score, projectId });
```
Consumed by `GET /events` (EventSource in the dashboard).

### Adding a New Pipeline Stage
1. Add a prompt to the `PROMPTS` object in `server.js`
2. Add the stage in `/task/run-next` after existing stages
3. Use `finalCode = ...` (not `const`) — security/docs stages may overwrite it
4. Log the result into `pipelineLog`

### MODEL_META (dashboard source of truth)
`App.jsx` contains a `MODEL_META` constant (~line 1240) mapping model names to `{ tier, color, speed, ctx, vram, roles }`. Both the Chat model picker and Models panel seed from this. When adding a new Ollama model, add it here too.

### Project Templates
JSON files in `templates/` (`node-api.json`, `node-cli.json`, `web-app.json`):
```json
{ "name": "...", "description": "...", "stack": "...", "epics": [...] }
```
Served by `GET /templates`; consumed by `POST /project/create-from-template`.

---

## Important File Locations

| Path | Purpose |
|---|---|
| `src/server.js` | Everything — routes, pipeline, PROMPTS, business logic (~5100 lines) |
| `src/agent.js` | Base Agent class |
| `src/multipass.js` | Best-of-N sampler + `scoreCode()` |
| `src/ollama.js` | Ollama HTTP wrapper (`unloadModel` sends to both endpoints) |
| `src/session-memory.js` | Cross-session learning persistence |
| `dashboard/src/App.jsx` | Entire React app — shared components + panel imports |
| `dashboard/src/panels/` | Five panel components (Overview, Pipeline, Chat, Models, Settings) |
| `dashboard/dist/` | Built bundle served by Express (rebuild after any JSX change) |
| `db/project.db` | Projects, epics, tasks (main pipeline DB) |
| `db/agent_memory.db` | Reflection scores, agent history |
| `db/session-memory.json` | Cross-session best practices + error patterns |
| `projects/` | Generated project workspaces |
| `logs/forge.log` | Server log when started via `start.sh` |
| `run-all.sh` | 6-phase pipeline runner script |
| `n8n/forge-workflow.json` | n8n automation workflow (import manually) |
| `templates/` | Project creation templates |
