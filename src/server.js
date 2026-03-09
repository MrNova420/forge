// Forge API Server v2 — full capability: agents + tools + memory + self-improvement
const express = require('express');
const { Agent, setModelResolver } = require('./agent');
const { memoryManager } = require('./memory');
const { getDashboard, runImprovementCycle, getQualityTrend } = require('./improve');
const tools = require('./tools');
const Database = require('better-sqlite3');
const path = require('path');
const { jsonrepair } = require('jsonrepair');
const { generate, sleep, getGPUTemp, gpuThrottle, unloadModel, swapModel, getLoadedModels, DEFAULT_CTX, LARGE_CTX } = require('./ollama');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const sessionMem = require('./session-memory');
const patternLib = require('./pattern-library');
const knowledgeBase = require('./knowledge-base');

// ── LRU Response Cache ─────────────────────────────────────────────────────
const _cache = new Map();
const CACHE_MAX = 100;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.val;
}

function cacheSet(key, val) {
  if (_cache.size >= CACHE_MAX) {
    _cache.delete(_cache.keys().next().value); // evict oldest
  }
  _cache.set(key, { val, ts: Date.now() });
}

function cacheKey(...parts) {
  return parts.map(p => typeof p === 'string' ? p.slice(0, 200) : JSON.stringify(p)).join('|');
}

// ── callOllama — thin wrapper around Ollama /api/generate ──────────────────
async function callOllama(model, prompt, opts = {}) {
  const { num_predict = -1, temperature = 0.2, top_p, stop, num_ctx = DEFAULT_CTX } = opts;
  const body = {
    model,
    prompt,
    stream: false,
    keep_alive: -1,
    options: { temperature, num_predict, num_ctx, num_gpu: 99, repeat_penalty: 1.1 }
  };
  if (top_p != null) body.options.top_p = top_p;
  if (stop) body.options.stop = stop;
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return { response: (data.response || '').trim(), eval_count: data.eval_count };
}

// ── Research cache ─────────────────────────────────────────────────────────
const _researchCache = new Map(); // key: query string, value: { result, ts }
const RESEARCH_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function cachedResearch(query, fetchFn) {
  const hit = _researchCache.get(query);
  if (hit && (Date.now() - hit.ts) < RESEARCH_CACHE_TTL) return Promise.resolve(hit.result);
  return fetchFn().then(result => {
    _researchCache.set(query, { result, ts: Date.now() });
    if (_researchCache.size > 200) {
      const oldest = [..._researchCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0][0];
      _researchCache.delete(oldest);
    }
    return result;
  });
}

// ── Ollama base URL ────────────────────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.FORGE_MODEL || 'qwen2.5-coder:3b';

// ── Multi-Provider System ──────────────────────────────────────────────────
// Supports Ollama (local), OpenAI, Anthropic, Groq, Google AI, and any
// OpenAI-compatible custom endpoint. Keys stored in db/providers.json.
const PROVIDERS_FILE = path.join(__dirname, '../db/providers.json');

function loadProviders() {
  try { return JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveProviders(data) {
  fs.mkdirSync(path.dirname(PROVIDERS_FILE), { recursive: true });
  // Atomic write: write to .tmp then rename to prevent corruption on crash
  const tmp = PROVIDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, PROVIDERS_FILE);
}

// Returns { provider, model } from a model name like "openai/gpt-4o" or "gpt-4o"
function resolveProvider(modelName) {
  if (!modelName) return { provider: 'ollama', model: DEFAULT_MODEL };
  if (modelName.includes('/')) {
    const [provider, ...rest] = modelName.split('/');
    return { provider, model: rest.join('/') };
  }
  // Check if it's a known cloud model
  const providers = loadProviders();
  for (const [pname, pcfg] of Object.entries(providers)) {
    if (pcfg.enabled && pcfg.models && pcfg.models.includes(modelName)) {
      return { provider: pname, model: modelName };
    }
  }
  return { provider: 'ollama', model: modelName };
}

// Universal streaming chat — routes to correct provider
async function* streamChat(modelFull, messages, opts = {}) {
  const { provider, model } = resolveProvider(modelFull);
  const providers = loadProviders();
  const pcfg = providers[provider] || {};
  const temperature = opts.temperature ?? 0.7;

  if (provider === 'ollama' || !pcfg.apiKey) {
    // Ollama local
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, keep_alive: '10m', options: { temperature, num_predict: -1, num_gpu: 99 } }),
      signal: opts.signal || AbortSignal.timeout(300000)
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines.filter(Boolean)) {
        try {
          const d = JSON.parse(line);
          if (d.message?.content) yield { token: d.message.content, done: false, raw: null };
          // Always yield the final done chunk (empty content but carries eval_count/duration for stats)
          if (d.done) yield { token: '', done: true, raw: d };
        } catch {}
      }
    }
    return;
  }

  if (provider === 'anthropic') {
    // Anthropic API
    const sysMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': pcfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, messages: chatMsgs, system: sysMsg?.content, max_tokens: opts.max_tokens || 8192, stream: true, temperature }),
      signal: opts.signal || AbortSignal.timeout(300000)
    });
    if (!res.ok) { const e = await res.text(); throw new Error(`Anthropic ${res.status}: ${e}`); }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const d = JSON.parse(line.slice(5).trim());
          if (d.type === 'content_block_delta' && d.delta?.text) yield { token: d.delta.text };
          if (d.type === 'message_stop') yield { done: true };
        } catch {}
      }
    }
    return;
  }

  // OpenAI-compatible (OpenAI, Groq, Google AI, OpenRouter, Custom)
  const baseUrl = pcfg.baseUrl || (provider === 'openai' ? 'https://api.openai.com/v1'
    : provider === 'groq' ? 'https://api.groq.com/openai/v1'
    : provider === 'google' ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
    : pcfg.baseUrl || 'https://api.openai.com/v1');
  const extraHeaders = provider === 'openrouter' ? { 'HTTP-Referer': 'http://localhost:3737', 'X-Title': 'Forge' } : {};
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pcfg.apiKey}`, ...extraHeaders },
    body: JSON.stringify({ model, messages, stream: true, temperature, max_tokens: opts.max_tokens || 8192 }),
    signal: opts.signal || AbortSignal.timeout(300000)
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`${provider} ${res.status}: ${e}`); }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const chunk = line.slice(5).trim();
      if (chunk === '[DONE]') { yield { done: true }; continue; }
      try {
        const d = JSON.parse(chunk);
        const tok = d.choices?.[0]?.delta?.content; if (tok) yield { token: tok };
        // Capture usage stats (OpenAI/OpenRouter send these in the last chunk)
        if (d.usage?.prompt_tokens) yield { usage: { promptTokens: d.usage.prompt_tokens, completionTokens: d.usage.completion_tokens||0 } };
      } catch {}
    }
  }
}

// ── Provider API routes ────────────────────────────────────────────────────
// (registered later — placed here for declaration order)


// Each agent role has a designated model, context size, and temperature.
// Models are swapped cleanly in VRAM when switching roles (only 1 model hot at a time).
//
//  Tier 1 — PLANNER    deepseek-r1:1.5b  (1.1GB, 131k ctx, chain-of-thought reasoning)
//  Tier 2 — AUDITOR    deepseek-coder:6.7b (3.8GB, 16k ctx, high-quality code judgment)
//  Tier 3 — WORKHORSE  qwen2.5-coder:3b  (1.9GB, 32k ctx, 50 tok/s pure coding)
//  Tier 4 — FAST       deepseek-coder:1.3b (0.8GB, 16k ctx, ultra-fast simple tasks)
//
//  Fallback: if a model isn't downloaded yet, falls back to qwen2.5-coder:3b
const AGENT_MODELS = {
  // Tier 1 — Planners (deepseek-r1 reasons deeply before answering)
  orchestrator:   { model: 'deepseek-r1:1.5b',      ctx: 32768, temp: 0.1, tier: 'planner'  },
  architect:      { model: 'deepseek-r1:1.5b',      ctx: 32768, temp: 0.1, tier: 'planner'  },
  arch_reviewer:  { model: 'deepseek-r1:1.5b',      ctx: 32768, temp: 0.1, tier: 'planner'  },
  standup:        { model: 'deepseek-r1:1.5b',      ctx: 16384, temp: 0.3, tier: 'planner'  },

  // Tier 2 — Auditors (deepseek-coder:6.7b for quality-critical judgment)
  reviewer:       { model: 'deepseek-coder:6.7b',   ctx: 8192,  temp: 0.1, tier: 'auditor'  },
  debugger:       { model: 'deepseek-coder:6.7b',   ctx: 8192,  temp: 0.1, tier: 'auditor'  },
  security:       { model: 'deepseek-coder:6.7b',   ctx: 8192,  temp: 0.1, tier: 'auditor'  },

  // Tier 3 — Workhorse (qwen2.5-coder:3b fast bulk coding at 50 tok/s)
  researcher:     { model: 'deepseek-r1:1.5b',      ctx: 32768, temp: 0.1, tier: 'planner'  },
  coder:          { model: 'qwen2.5-coder:3b',      ctx: 16384, temp: 0.2, tier: 'workhorse' },
  refactor:       { model: 'qwen2.5-coder:3b',      ctx: 16384, temp: 0.1, tier: 'workhorse' },
  tester:         { model: 'qwen2.5-coder:3b',      ctx: 16384, temp: 0.2, tier: 'workhorse' },
  deploy:         { model: 'qwen2.5-coder:3b',      ctx: 16384, temp: 0.1, tier: 'workhorse' },
  ux:             { model: 'qwen2.5-coder:3b',      ctx: 16384, temp: 0.2, tier: 'workhorse' },
  integration:    { model: 'qwen2.5-coder:3b',      ctx: 16384, temp: 0.2, tier: 'workhorse' },

  // Tier 4 — Fast (deepseek-coder:1.3b for simple/quick tasks)
  docs:           { model: 'deepseek-coder:1.3b',   ctx: 8192,  temp: 0.2, tier: 'fast'     },
};

// Models available locally — refreshed on startup + on /vram/status
let _availableModels = new Set();
let _modelsBySize = []; // [{name, size}] sorted smallest first
async function refreshAvailableModels() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { timeout: 5000 });
    if (!res.ok) return;
    const data = await res.json();
    const models = (data.models || []).map(m => ({ name: m.name, size: m.size || 0 }));
    models.sort((a, b) => a.size - b.size);
    _modelsBySize = models;
    _availableModels = new Set(models.map(m => m.name));
    console.log(`[models] Available: ${[..._availableModels].join(', ')}`);
  } catch {}
}
refreshAvailableModels(); // run on startup

// Get the model for a role — falls back to qwen2.5-coder:3b if not downloaded
function getAgentModel(role) {
  const cfg = AGENT_MODELS[role];
  if (!cfg) return DEFAULT_MODEL;
  // Check if the preferred model is downloaded
  const modelBase = cfg.model.split(':')[0] + ':' + cfg.model.split(':')[1];
  if (_availableModels.has(modelBase) || _availableModels.has(cfg.model)) return cfg.model;
  console.log(`[models] ⚠ ${cfg.model} not downloaded — falling back to ${DEFAULT_MODEL} for role '${role}'`);
  return DEFAULT_MODEL;
}

function getAgentCtx(role)  { return AGENT_MODELS[role]?.ctx  || 16384; }
function getAgentTemp(role) { return AGENT_MODELS[role]?.temp || 0.2;   }
function getAgentTier(role) { return AGENT_MODELS[role]?.tier || 'workhorse'; }

// Unified role caller — picks the right model+ctx, swaps VRAM cleanly, strips <think> for planners
async function callRole(role, prompt, opts = {}) {
  const model = getAgentModel(role);
  const numCtx = opts.numCtx || getAgentCtx(role);
  const temperature = opts.temperature ?? getAgentTemp(role);
  const result = await generate(prompt, { ...opts, model, numCtx, temperature });
  // Strip deepseek-r1 chain-of-thought blocks for planner roles
  if (getAgentTier(role) === 'planner') {
    const clean = result.text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return { ...result, text: clean };
  }
  return result;
}

// Backward-compat alias
const ARCHITECT_MODEL = 'deepseek-r1:1.5b';

// Wire the role→model resolver into the Agent class so all new Agent(role,...) auto-pick the right model
setModelResolver(getAgentModel);

// ── A/B prompt testing storage ─────────────────────────────────────────────
const _promptVariants = {}; // role -> [{ variant, wins, trials }]
const _abResults = {};      // role -> { variantKey: { wins, trials, avgScore } }

function getPromptVariant(role) {
  if (!_promptVariants[role] || _promptVariants[role].length === 0) return PROMPTS[role];
  // Epsilon-greedy: 20% explore, 80% exploit
  const variants = _promptVariants[role];
  if (Math.random() < 0.2) {
    return variants[Math.floor(Math.random() * variants.length)].variant;
  }
  // Pick highest win rate
  const best = variants.reduce((a, b) => (a.wins / Math.max(a.trials, 1)) >= (b.wins / Math.max(b.trials, 1)) ? a : b);
  return best.wins > 0 ? best.variant : PROMPTS[role];
}

function recordAbResult(role, variant, score) {
  if (!_abResults[role]) _abResults[role] = {};
  const key = variant.substring(0, 40);
  if (!_abResults[role][key]) _abResults[role][key] = { wins: 0, trials: 0, avgScore: 0 };
  const r = _abResults[role][key];
  r.trials++;
  r.avgScore = (r.avgScore * (r.trials - 1) + score) / r.trials;
  if (score >= 7) r.wins++;
}

// ── Agent handoff context builder ─────────────────────────────────────────
function buildHandoffContext(role, previousStages, task) {
  const parts = [];

  // Every agent gets the research brief — it's the foundation everyone builds on
  if (previousStages.research?.output) {
    // Research brief trimmed to 600 chars for downstream agents (they already have sharedContext)
    const brief = previousStages.research.output.slice(0, 600);
    parts.push(`=== RESEARCHER BRIEF ===\n${brief}${previousStages.research.output.length > 600 ? '\n[...trimmed]' : ''}`);
  }

  // Architect gets research only (above)
  // Coder gets research + full arch spec
  if (role === 'coder' && previousStages.architect?.output) {
    parts.push(`=== ARCHITECT SPEC (implement this exactly — use the FILE: path from this spec) ===\n${previousStages.architect.output}`);
  }

  // Refactor gets research + arch spec + what coder wrote (trim code to 2000 chars to fit small models)
  if (role === 'refactor') {
    if (previousStages.architect?.output)
      parts.push(`=== ARCHITECT SPEC (code must match this) ===\n${previousStages.architect.output.slice(0,600)}`);
    if (previousStages.coder?.output) {
      const code = previousStages.coder.output;
      parts.push(`=== CODE TO REFACTOR ===\n${code.length > 2000 ? code.slice(0,900) + '\n...[middle trimmed]...\n' + code.slice(-900) : code}`);
    }
  }

  // Tester gets arch spec (to know what exports exist) + actual code (trimmed)
  if (role === 'tester') {
    if (previousStages.architect?.output)
      parts.push(`=== ARCHITECT SPEC (shows exports to test) ===\n${previousStages.architect.output.slice(0,500)}`);
    if (previousStages.coder?.output) {
      const code = previousStages.coder.output;
      parts.push(`=== CODE TO TEST ===\n${code.length > 2500 ? code.slice(0,1100) + '\n...[middle trimmed]...\n' + code.slice(-900) : code}`);
    }
  }

  // Reviewer gets everything — research intent, arch spec, final code
  if (role === 'reviewer') {
    if (previousStages.architect?.output)
      parts.push(`=== ARCHITECT SPEC (review against this) ===\n${previousStages.architect.output.slice(0,500)}`);
    if (previousStages.coder?.output) {
      const code = previousStages.coder.output;
      parts.push(`=== FINAL CODE TO REVIEW ===\n${code.length > 3000 ? code.slice(0,1300) + '\n...[middle trimmed]...\n' + code.slice(-1000) : code}`);
    }
  }

  // Debugger gets test error + failing code
  if (role === 'debugger') {
    if (previousStages.testError)
      parts.push(`=== TEST FAILURE ===\n${previousStages.testError.slice(0,600)}`);
    if (previousStages.coder?.output) {
      const code = previousStages.coder.output;
      parts.push(`=== FAILING CODE ===\n${code.length > 2500 ? code.slice(0,1100) + '\n...[middle trimmed]...\n' + code.slice(-900) : code}`);
    }
  }

  // Coder fix pass: gets reviewer's specific issues to fix
  if (role === 'coder_fix' && previousStages.reviewer?.output) {
    parts.push(`=== REVIEWER ISSUES TO FIX ===\n${previousStages.reviewer.output.slice(0,800)}`);
    if (previousStages.coder?.output) {
      const code = previousStages.coder.output;
      parts.push(`=== CURRENT CODE (fix it) ===\n${code.length > 2500 ? code.slice(0,1100) + '\n...[middle trimmed]...\n' + code.slice(-900) : code}`);
    }
  }

  // Arch-review gets full arch spec + final code summary
  if (role === 'arch-review') {
    if (previousStages.architect?.output)
      parts.push(`=== ORIGINAL ARCH SPEC ===\n${previousStages.architect.output.slice(0,600)}`);
    if (previousStages.coder?.output)
      parts.push(`=== IMPLEMENTED CODE ===\n${previousStages.coder.output.slice(0,1200)}`);
    if (previousStages.reviewer?.output)
      parts.push(`=== REVIEWER NOTES ===\n${previousStages.reviewer.output.slice(0,400)}`);
  }

  // Security gets final code
  if (role === 'security' && previousStages.coder?.output) {
    const code = previousStages.coder.output;
    parts.push(`=== CODE TO AUDIT ===\n${code.length > 2500 ? code.slice(0,1200) + '\n...[middle trimmed]...\n' + code.slice(-800) : code}`);
  }

  // Docs gets final code
  if (role === 'docs' && previousStages.coder?.output) {
    const code = previousStages.coder.output;
    parts.push(`=== CODE TO DOCUMENT ===\n${code.length > 2000 ? code.slice(0,900) + '\n...[middle trimmed]...\n' + code.slice(-700) : code}`);
  }

  return parts.length > 0 ? '\n' + parts.join('\n\n') + '\n' : '';
}

// Extract the FILE: path from architect output so coder uses the REAL filename
function extractArchitectFilePath(archOutput) {
  if (!archOutput) return null;
  const m = archOutput.match(/^FILE:\s*(\S+)/m);
  return m ? m[1].trim() : null;
}

// ── Workspace symlink helper ───────────────────────────────────────────────
function updateWorkspaceSymlink(projectId) {
  try {
    const projectDir = path.join(__dirname, '../projects', projectId);
    const symlinkPath = path.join(__dirname, '../workspace');
    if (!fs.existsSync(projectDir)) return;
    try { fs.unlinkSync(symlinkPath); } catch(e) {}
    fs.symlinkSync(projectDir, symlinkPath);
  } catch(e) { /* non-critical */ }
}

// ── Auto git commit after task completion ─────────────────────────────────
async function autoGitCommit(projectDir, taskTitle, score) {
  try {
    const isGit = fs.existsSync(path.join(projectDir, '.git'));
    // Sanitize title: strip backticks/quotes/special chars that could break shell
    const safeTitle = (taskTitle || '').replace(/[`'"\\$!;&|<>(){}]/g, '').substring(0, 60).trim();
    if (!isGit) {
      execSync('git init && git add -A && git commit -m "Initial commit by Forge"', { cwd: projectDir, timeout: 10000 });
    } else {
      execSync(`git add -A && git commit -m "feat: ${safeTitle} [score:${score}]" --allow-empty`,
        { cwd: projectDir, timeout: 10000 });
    }
  } catch(e) { /* non-critical */ }
}

// ── VRAM monitoring ────────────────────────────────────────────────────────
async function getVramUsage() {
  try {
    const out = execSync('nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits', { timeout: 3000 }).toString().trim();
    const [used, total, util] = out.split(',').map(s => s.trim());
    return { usedMB: parseInt(used), totalMB: parseInt(total), utilizationPct: parseInt(util), available: true };
  } catch(e) {
    return { available: false, error: e.message };
  }
}

// ── Benchmark / Token Stats Recording ────────────────────────────────────────
// Called after each pipeline stage completes to record per-model token usage.
function recordBench({ model, role, taskId, tokIn = 0, tokOut = 0, durationMs = 0, tokPerSec = 0, qualityScore = null, stage = null }) {
  try {
    const db = DB();
    db.prepare(`INSERT INTO model_stats (model, role, task_id, tokens_in, tokens_out, duration_ms, tok_per_sec, quality_score, pipeline_stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(model || 'unknown', role || null, taskId || null, tokIn, tokOut, durationMs, tokPerSec, qualityScore, stage);
    db.close();
  } catch (e) { /* non-critical — never crash pipeline */ }
}


function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  const candidate = text.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch {}
  try { return JSON.parse(jsonrepair(candidate)); } catch {}
  return null;
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Rate limiting disabled — no limits
function rateLimit(_maxPerMinute) {
  return (_req, _res, next) => next();
}

async function callArchitect(prompt, opts = {}) {
  return callRole('architect', prompt, opts);
}

const DB  = () => {
  const db = new Database(path.join(__dirname, '../db/project.db'));
  db.pragma('journal_mode = WAL');   // allow concurrent readers during writes
  db.pragma('busy_timeout = 5000');  // wait up to 5s instead of SQLITE_BUSY error
  return db;
};
const MEM = () => {
  const db = new Database(path.join(__dirname, '../db/agent_memory.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
};

// ── Robust JSON parser — handles model's markdown/trailing-comma/restart output ─
function cleanJson(raw) {
  if (!raw) throw new Error('Empty response');

  function tryParse(s) {
    // Normalize: remove trailing commas, JS comments, control chars
    s = s.replace(/,(\s*[}\]])/g, '$1');
    s = s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    return JSON.parse(s);
  }

  // Strategy 1: extract all ```json ... ``` fenced blocks, try each LAST→FIRST
  const fenced = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fm;
  while ((fm = fenceRe.exec(raw)) !== null) fenced.push(fm[1].trim());
  for (let i = fenced.length - 1; i >= 0; i--) {
    try { return tryParse(fenced[i]); } catch {}
  }

  // Strategy 2: find all { ... } blocks (greedy from each opening brace), try each LAST→FIRST
  const candidates = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] === '}') {
      // find matching opening brace
      let depth = 0, start = -1;
      for (let j = i; j >= 0; j--) {
        if (raw[j] === '}') depth++;
        else if (raw[j] === '{') { depth--; if (depth === 0) { start = j; break; } }
      }
      if (start !== -1) candidates.push(raw.slice(start, i + 1));
    }
  }
  // Deduplicate and try largest candidates first
  const seen = new Set();
  for (const c of candidates.sort((a, b) => b.length - a.length)) {
    if (seen.has(c)) continue; seen.add(c);
    try { return tryParse(c); } catch {}
  }

  // Strategy 3: strip everything before first { and after last }
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return tryParse(raw.slice(first, last + 1)); } catch {}
  }

  throw new Error('No valid JSON found in model response');
}

const PROMPTS = {
  research: `You are a senior software engineer doing pre-implementation research for a dev team.
Your job: deeply understand what needs to be built and produce a brief that every other agent will use.

Output this EXACT format (no other text):
DOMAIN: [type of system/module, e.g. "REST API auth middleware", "data parser", "CLI tool"]
PURPOSE: [one sentence — what this piece does and why it exists in the project]
REQUIREMENTS:
- [key requirement 1]
- [key requirement 2]
- [key requirement 3]
PATTERNS: [best implementation pattern to use, e.g. "middleware chain", "repository pattern", "event emitter"]
LIBRARIES: [specific npm packages or built-in modules to use, with reason]
PITFALLS:
- [common mistake 1 and how to avoid it]
- [common mistake 2 and how to avoid it]
INTERFACES: [what this file exports and how other files will import/use it]
QUALITY_BAR: [what makes an excellent implementation of this — be specific]`,

  architect: `You are a senior software architect. You receive research from the researcher agent and design the exact implementation.
You must build directly ON TOP of the researcher's findings — not ignore them.

CRITICAL: Your FIRST line must be FILE: with the exact file path. Example: FILE: src/routes/games.js
Then follow with the spec sections below.

Output this EXACT format (replace the examples with real values for this task):
FILE: src/routes/games.js
EXPORTS:
- functionName(param: type) -> returnType: [one line purpose]
- functionName2(param: type) -> returnType: [one line purpose]
DATA_STRUCTURES:
- name: { field: type, field2: type } — [purpose]
LOGIC:
1. [exact step of what the code must do]
2. [exact step]
3. [exact step]
ERROR_CASES:
- [specific error to handle]: [how to handle it]
DEPENDENCIES: [require/import statements needed]
INTEGRATES_WITH: [other files in the project this touches]
MUST_NOT: [specific anti-patterns to avoid based on researcher findings]`,

  coder: `You are an elite software engineer. You receive a researcher brief AND architect spec. Implement them exactly.

MANDATORY PROCESS:
1. Read the researcher brief — understand the domain and pitfalls
2. Read the architect spec — it tells you the EXACT file path (FILE: line), exports, and data structures
3. Use the EXACT file path from the architect spec FILE: line — do NOT invent a generic name
4. Implement every function completely — no stubs, no TODOs
5. Apply the pitfalls from research — avoid every one explicitly

OUTPUT FORMAT — first line must be the FILE: path from the architect spec:
FILE: src/routes/games.js    ← example: use the REAL path from architect spec, not this example
[complete working code — no markdown fences]

Rules:
- Every exported function gets a JSDoc comment
- try/catch on all async operations and I/O
- Validate all inputs before using them
- Functions under 30 lines
- Match the exact exports the architect specified
- If imports are needed, add require() at top`,

  refactor: `You are a senior engineer doing a quality pass. You have the architect spec and the written code.
Your job: make the code match the spec perfectly and improve quality.

Check against the architect spec:
1. Are all specified exports present and correctly typed?
2. Are all specified error cases handled?
3. Does the logic match the architect's steps?

Then improve:
- Better variable names (no abbreviations)
- Extract any repeated logic into helpers
- Improve error messages to be specific and actionable
- Add any missing input validation

Output: FILE: [same path]\n[improved complete file — no markdown fences]
If code already matches spec well, output it unchanged with FILE: prefix.`,

  tester: `You are a QA engineer. You have the architect spec showing exact exports and the implemented code.
Write tests that TEST THE ACTUAL EXPORTS — not hypothetical functions.

REQUIRED test cases:
1. Happy path — correct inputs produce correct outputs
2. Edge cases — null, undefined, empty string, 0, negative numbers
3. Error cases — invalid inputs should throw or return errors (not crash)
4. Integration — if this module uses other modules, test that it calls them correctly

FILE: tests/[module-name].test.js
Use ONLY Node.js built-in: const { test } = require('node:test'); const assert = require('assert');
Import the actual module being tested.
Make tests runnable standalone with: node tests/[file].test.js`,

  debugger: `You are a debugging expert. Read the error message carefully and fix the ROOT CAUSE.

Process:
1. Read the error: what line failed? what was the actual vs expected value?
2. Find the bug in the code — trace backwards from the error
3. Write the minimal fix — change as little as possible
4. Make sure the fix doesn't break other behavior

FILE: [same path as failing file]
[complete corrected file — no markdown fences]
Fix ONLY the bug. Do not refactor or rename things.`,

  reviewer: `You are a principal engineer doing final code review. You have seen the research brief, architect spec, and the code.
Review against ALL THREE — does the code fulfil the research requirements AND follow the architect spec?

Score strictly:
10 = production-ready, matches spec perfectly, handles all edge cases
8-9 = minor issues only
6-7 = works but missing things from spec or poor error handling  
4-5 = significant gaps in spec compliance or correctness
1-3 = broken or fundamentally wrong

Output EXACTLY:
SCORE: N/10
VERDICT: APPROVE or REJECT
ISSUES:
- [HIGH/MED/LOW] specific issue with file:line if possible
- [HIGH/MED/LOW] specific issue
FIXES_NEEDED:
[if REJECT: write the specific code changes needed, not just descriptions]`,

  security: `You are an elite security engineer. Review for vulnerabilities.
Check specifically: SQL injection, path traversal, unvalidated user input, hardcoded secrets,
missing auth checks, information disclosure in errors, insecure dependencies, prototype pollution.

Output:
SECURITY SCORE: N/10
ISSUES FOUND:
- [CRITICAL/HIGH/MED] description and exact fix
FIXED CODE:
FILE: [path]
[full secure version if score < 8, or just the vulnerable lines with fixes if >= 8]`,

  docs: `You are a technical writer. Add clear, useful documentation to the code.
Add: module-level JSDoc describing what this module does and how to use it,
function-level JSDoc with @param types, @returns type, @throws, and one usage @example per exported function.
Output: FILE: [same path]\n[fully documented code — preserve all logic exactly, only add/improve comments]`,

  orchestrator: `You are a technical project manager.
Break down the project into specific, implementable tasks.
For each task specify: what file to create, what functions to implement, what it connects to.
Output a numbered list of concrete implementation tasks.`,

  memory: `You are summarizing code for future reference.
Output a brief JSON: {"summary": "what this module does", "exports": ["fn1", "fn2"], "dependencies": ["module1"]}`,

  planner: `You are a senior software architect doing project planning.
Given a project and task, create a detailed implementation plan.
Output: PLAN:\n1. Data structures needed\n2. Functions to implement\n3. Error cases to handle\n4. Integration points\n5. Test scenarios\nKeep plan under 200 words.`,

  deploy: `You are a DevOps engineer. Given a Node.js project, generate deployment files.
Output EXACTLY these files in sequence:
FILE: Dockerfile
[dockerfile content]
FILE: docker-compose.yml  
[compose content]
FILE: .env.example
[env vars]
FILE: DEPLOY.md
[deployment instructions]
Each file must be complete and production-ready. Use multi-stage builds in Dockerfile.`,

  ux: `You are a senior API/UX design expert. Review code from a developer experience perspective.
Check: endpoint naming consistency, HTTP status codes correctness, error message clarity, 
response format consistency, input validation feedback, API documentation completeness.
Output: UX SCORE: N/10, then bullet list of specific improvements with code examples.
Focus on what a developer consuming this API would experience.`,

  integration: `You are an integration testing expert. Write end-to-end tests that test the FULL system working together.
Not unit tests - integration tests that spin up the actual server, make real HTTP calls, verify real responses.
Use Node.js built-in test runner. Start server in subprocess, run tests, kill server.
Output FILE: tests/integration.test.js with complete runnable tests.
Include: happy path flows, error handling, edge cases, concurrent request handling.`,

  standup: `You are a senior engineering team lead. Generate a concise daily standup summary.
Format:
## Daily Standup - [date]
### Completed Yesterday
- [list tasks done]
### In Progress  
- [list active tasks]
### Blockers
- [any issues, low scores, failed tasks]
### Quality Metrics
- Average score: X/10
- Tasks completed: N
### Next Priorities
- [top 3 tasks to tackle next]`
};

// ── Model routing: assign best model per task complexity ──────────────────
const MODEL_ROUTING = {
  simple:       { keywords: ['readme', 'gitignore', 'docs', 'comment', 'rename'], model: 'qwen2.5-coder:3b' },
  architecture: { keywords: ['architect', 'design', 'structure', 'schema', 'database', 'api design'], model: ARCHITECT_MODEL },
  complex:      { keywords: ['algorithm', 'optimize', 'security', 'auth', 'encryption', 'concurrency'], model: 'qwen2.5-coder:3b' },
  test:         { keywords: ['test', 'spec', 'integration', 'coverage', 'mock'], model: 'qwen2.5-coder:3b' }
};

function getTaskModel(taskTitle, taskDesc, projectModel) {
  // projectModel always takes priority if explicitly set
  if (projectModel && projectModel !== 'qwen2.5-coder:3b') return projectModel;

  const text = (taskTitle + ' ' + (taskDesc || '')).toLowerCase();

  // In future: route to different models based on task complexity
  // For now with single GPU, always use qwen2.5-coder:3b but log the routing decision
  for (const [type, config] of Object.entries(MODEL_ROUTING)) {
    if (config.keywords.some(kw => text.includes(kw))) {
      return config.model; // Returns same model now, extensible for multi-model later
    }
  }
  return projectModel || DEFAULT_MODEL;
}

// ── Agent Constitutions ────────────────────────────────────────────────────
const CONSTITUTIONS = {
  coder: [
    'Output MUST start with FILE: <filename> on its own line',
    'MUST include module.exports or export default',
    'MUST wrap main logic in try/catch with meaningful error messages',
    'MUST validate all function inputs (check for null/undefined)',
    'MUST NOT include placeholder comments like "// TODO" or "// implement this"',
    'MUST NOT wrap code in markdown fences (no ```)',
    'All functions MUST have at least one JSDoc comment'
  ],
  reviewer: [
    'Output MUST include SCORE: N/10 on its own line',
    'Output MUST list specific issues as bullet points',
    'Output MUST include VERDICT: APPROVE or REJECT'
  ],
  tester: [
    'Output MUST start with FILE: tests/<name>.test.js',
    'MUST include at least 3 test cases',
    'MUST test the happy path AND at least one error case',
    'MUST use Node.js built-in test runner (require("node:test"))'
  ]
};

function getConstitutionContext(role) {
  const rules = CONSTITUTIONS[role];
  if (!rules) return '';
  return `\nMANDATORY RULES (violations = rejection):\n${rules.map((r,i)=>`${i+1}. ${r}`).join('\n')}\n`;
}

function checkConstitution(output, role) {
  const violations = [];
  if (role === 'coder') {
    if (!output.includes('FILE:')) violations.push('Missing FILE: prefix');
    if (!output.match(/module\.exports|export default|exports\./)) violations.push('Missing exports');
    if (!output.match(/try\s*{|\.catch\s*\(/)) violations.push('Missing error handling');
    if (output.includes('// TODO') || output.includes('// implement')) violations.push('Has placeholder TODOs');
    if (output.includes('```')) violations.push('Wrapped in markdown fences');
  }
  if (role === 'reviewer') {
    if (!output.match(/SCORE:\s*\d/i)) violations.push('Missing SCORE: N/10');
  }
  return violations;
}

// ── Chain-of-Thought: strip PLAN section before storing ───────────────────
function extractFinalCode(output) {
  // If output has PLAN: section, extract just the FILE: code part
  const fileIdx = output.indexOf('FILE:');
  if (fileIdx > 0 && output.substring(0, fileIdx).includes('PLAN:')) {
    return output.substring(fileIdx);
  }
  return output;
}

// ── Quality Ratchet ────────────────────────────────────────────────────────
const _qualityRatchet = new Map(); // projectId -> bestSessionScore

function ratchetScore(projectId, score) {
  const best = _qualityRatchet.get(projectId) || 0;
  if (score > best) _qualityRatchet.set(projectId, score);
  return _qualityRatchet.get(projectId);
}

function shouldRetryForRatchet(projectId, score) {
  const best = _qualityRatchet.get(projectId) || 0;
  // If we've seen score >= 8 before and this task got < 6, retry
  return best >= 8 && score < 6;
}

// ── Prompt Compression for Small Models (vision-prompt-compression) ────────
/**
 * Compress a system prompt to fit within token budget.
 * Small models perform better with focused, bullet-point prompts under 300 tokens.
 */
function compressPrompt(prompt, maxChars = 1200) {
  if (prompt.length <= maxChars) return prompt;

  const lines = prompt.split('\n').map(l => l.trim()).filter(Boolean);
  const scored = lines.map(line => {
    let score = 1;
    if (line.startsWith('-') || line.startsWith('•') || line.match(/^\d+\./)) score = 3;
    if (line.toUpperCase() === line && line.length > 3) score = 4; // ALL CAPS = rule
    if (line.includes('MUST') || line.includes('NEVER') || line.includes('ALWAYS')) score = 5;
    if (line.includes('FILE:') || line.includes('module.exports')) score = 4;
    if (line.length < 10) score = 0.5;
    return { line, score };
  });

  scored.sort((a, b) => b.score - a.score);
  let result = '';
  for (const { line } of scored) {
    if ((result + '\n' + line).length > maxChars) break;
    result += (result ? '\n' : '') + line;
  }
  return result;
}

// ── Language/Stack Specializations (vision-specialization) ────────────────
const STACK_SPECIALIZATIONS = {
  'node': {
    rules: `Node.js rules: Use require() not import. Use module.exports. Use async/await with try/catch. Check process.env for config. Use path.join() for file paths.`,
    example: `// Good Node.js pattern:\nconst handler = async (req, res) => {\n  try {\n    const result = await doWork(req.body);\n    res.json({ ok: true, data: result });\n  } catch (err) {\n    res.status(500).json({ error: err.message });\n  }\n};`
  },
  'react': {
    rules: `React rules: Use functional components with hooks. Use useState/useEffect. Export component as default. Use JSX. Handle loading and error states.`,
    example: `// Good React pattern:\nexport default function Component({ data }) {\n  const [loading, setLoading] = useState(false);\n  if (loading) return <div>Loading...</div>;\n  return <div>{data?.name}</div>;\n}`
  },
  'cli': {
    rules: `CLI rules: Parse process.argv. Show usage on --help. Exit with code 1 on error. Use console.error for errors. Make it executable with #!/usr/bin/env node.`,
    example: `#!/usr/bin/env node\nconst [,, cmd, ...args] = process.argv;\nif (!cmd || cmd === '--help') { console.log('Usage: tool <command>'); process.exit(0); }`
  },
  'python': {
    rules: `Python rules: Use type hints. Add docstrings. Use if __name__ == '__main__'. Handle exceptions with specific except clauses. Use pathlib not os.path.`,
    example: `def process(data: dict) -> dict:\n    """Process input data and return result."""\n    if not data:\n        raise ValueError("data cannot be empty")\n    return {"result": data}`
  }
};

function getStackContext(stack) {
  const spec = STACK_SPECIALIZATIONS[stack?.toLowerCase()] || STACK_SPECIALIZATIONS['node'];
  return `\nSTACK RULES (${stack||'node'}):\n${spec.rules}\n\nEXAMPLE PATTERN:\n${spec.example}\n`;
}

// ── Smart Error Recovery (vision-error-recovery) ──────────────────────────
async function smartErrorRecovery(task, failedOutput, failedScore, projectModel, sharedContext) {
  const { scoreCode } = require('./multipass');
  const scoreResult = scoreCode(failedOutput);

  const issues = scoreResult.issues || [];
  const errorContext = issues.length > 0
    ? `SPECIFIC ISSUES TO FIX:\n${issues.map((i,n) => `${n+1}. ${i}`).join('\n')}`
    : 'ISSUES: Output did not meet quality requirements. Missing FILE: prefix, exports, or error handling.';

  const hasSyntaxError = failedOutput.includes('SyntaxError') || failedOutput.includes('Unexpected token');
  const hasNoFile = !failedOutput.includes('FILE:');
  const hasNoExports = !failedOutput.match(/module\.exports|export default/);

  let recoveryPrompt = `RECOVERY ATTEMPT - Previous score: ${failedScore}/10\n\n`;
  if (hasNoFile) recoveryPrompt += 'CRITICAL: You MUST start with FILE: <filename> on the first line.\n';
  if (hasNoExports) recoveryPrompt += 'CRITICAL: You MUST include module.exports = { ... } at the end.\n';
  if (hasSyntaxError) recoveryPrompt += 'CRITICAL: Previous output had syntax errors. Double-check all brackets and parentheses.\n';
  recoveryPrompt += `\n${errorContext}\n\nTask: ${task.title}\n${task.description || ''}\n\n${sharedContext.substring(0, 800)}`;

  const recoveryAgent = new Agent('coder', PROMPTS.coder);
  const result = await recoveryAgent.run(recoveryPrompt, { useMultipass: true, minScore: 6, rounds: 2 });
  recoveryAgent.close();
  return result;
}

app.get('/health', (req, res) => res.json({
  status: 'ok', model: DEFAULT_MODEL, version: '3.0',
  capabilities: ['agents','tools','memory','self-improvement','git','tests','multi-model-routing']
}));

// ── Backup endpoints ───────────────────────────────────────────────────────
app.post('/backup/now', (req, res) => {
  try {
    runCheckpointAndBackup();
    const backupDir = path.join(__dirname, '../backups');
    const files = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(f=>f.endsWith('.bak')) : [];
    res.json({ ok: true, message: 'Backup complete', files: files.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/backup/list', (req, res) => {
  const backupDir = path.join(__dirname, '../backups');
  if (!fs.existsSync(backupDir)) return res.json({ files: [] });
  const files = fs.readdirSync(backupDir)
    .filter(f => f.endsWith('.bak'))
    .map(f => {
      const stat = fs.statSync(path.join(backupDir, f));
      return { name: f, size: stat.size, mtime: stat.mtime };
    })
    .sort((a,b) => new Date(b.mtime) - new Date(a.mtime));
  res.json({ files, total: files.length, dir: backupDir });
});



// ── VRAM Status + Control ──────────────────────────────────────────────────
app.get('/vram/status', async (req, res) => {
  try {
    const loaded = await getLoadedModels();
    const roles = Object.entries(AGENT_MODELS).map(([role, cfg]) => ({
      role,
      model: getAgentModel(role),
      preferredModel: cfg.model,
      ctx: cfg.ctx,
      tier: cfg.tier,
      available: _availableModels.has(cfg.model) || _availableModels.has(cfg.model.split(':')[0]+':'+cfg.model.split(':')[1])
    }));
    res.json({ loaded, roles, availableModels: [..._availableModels] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/vram/unload', async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'model required' });
  await unloadModel(model);
  // Confirm it's gone from /api/ps
  const ps = await fetch(`${OLLAMA_URL}/api/ps`).then(r => r.json()).catch(() => ({ models: [] }));
  const stillLoaded = (ps.models || []).map(m => m.name);
  res.json({ ok: true, unloaded: model, stillLoaded });
});

// Force-evict ALL models from VRAM — polls until /api/ps is empty
app.post('/vram/unload-all', async (req, res) => {
  try {
    const ps = await fetch(`${OLLAMA_URL}/api/ps`).then(r => r.json()).catch(() => ({ models: [] }));
    const loaded = (ps.models || []).map(m => m.name);
    console.log(`[vram/unload-all] Evicting ${loaded.length} model(s): ${loaded.join(', ')}`);
    // Send eviction sequentially — each must COMPLETE (not fire-and-forget) for keep_alive:0 to work.
    // Empty messages/prompt are ignored by Ollama; real content is required.
    for (const m of loaded) {
      await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], keep_alive: 0, stream: false, options: { num_predict: 1 } }),
        signal: AbortSignal.timeout(60000)
      }).catch(() => {});
    }
    const final = [];
    res.json({ ok: true, evicted: loaded, remaining: final });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Reload (unload then warm-up) a model — clears KV cache, fixes sluggish responses
app.post('/model/reload', async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'model required' });
  try {
    await unloadModel(model);
    await sleep(1500);
    await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, keep_alive: -1, options: { temperature: 0.1 } })
    });
    res.json({ ok: true, reloaded: model });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Synchronous model switch — evicts ALL currently loaded models then warms up the target
// This is blocking so the client knows when it's safe to chat
app.post('/model/switch', async (req, res) => {
  const { to, from } = req.body;
  if (!to) return res.status(400).json({ error: 'to required' });

  const toIsCloud  = to.includes('/');
  const fromIsCloud = from && from.includes('/');

  try {
    // --- Switching TO a cloud model ---
    if (toIsCloud) {
      // Just evict whatever local models are in VRAM — cloud needs no warmup via Ollama
      const ps = await fetch(`${OLLAMA_URL}/api/ps`).then(r => r.json()).catch(() => ({ models: [] }));
      const loaded = (ps.models || []).map(m => m.name);
      if (loaded.length > 0) {
        console.log(`[switch] Evicting local VRAM before cloud model: ${loaded.join(', ')}`);
        for (const m of loaded) {
          await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], keep_alive: 0, stream: false, options: { num_predict: 1 } }),
            signal: AbortSignal.timeout(60000)
          }).catch(e => console.warn(`[switch] Evict ${m} error: ${e.message}`));
        }
      }
      _loadedModel = to;
      console.log(`[switch] ✅ Cloud model selected: ${to} — VRAM cleared`);
      return res.json({ ok: true, loaded: to, cloud: true, vramCleared: loaded.length });
    }

    // --- Switching TO a local model ---
    // Step 1: Get currently loaded models from Ollama
    const ps = await fetch(`${OLLAMA_URL}/api/ps`).then(r => r.json()).catch(() => ({ models: [] }));
    const loaded = (ps.models || []).map(m => m.name);
    console.log(`[switch] Evicting ${loaded.length} model(s): ${loaded.join(', ') || 'none'} → loading ${to}`);

    // Step 2: Evict all loaded models
    for (const m of loaded) {
      console.log(`[switch] Evicting ${m}...`);
      await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], keep_alive: 0, stream: false, options: { num_predict: 1 } }),
        signal: AbortSignal.timeout(60000)
      }).catch(e => console.warn(`[switch] Evict ${m} error: ${e.message}`));
      console.log(`[switch] ✅ ${m} evicted`);
    }

    // Step 3: Warm up the new local model
    console.log('[switch] VRAM clear — loading', to);
    const warmup = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: to,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        keep_alive: '10m',
        options: { temperature: 0.1, num_predict: 3, num_gpu: 99 }
      }),
      signal: AbortSignal.timeout(180000)
    });
    if (!warmup.ok) {
      const errText = await warmup.text().catch(() => '');
      throw new Error(`Warmup failed (${warmup.status}): ${errText.slice(0, 200)}`);
    }
    _loadedModel = to;
    console.log(`[switch] ✅ ${to} ready`);
    res.json({ ok: true, loaded: to, cloud: false, vramCleared: loaded.length });
  } catch(e) {
    console.error('[switch] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/vram/refresh-models', async (req, res) => {
  await refreshAvailableModels();
  res.json({ ok: true, available: [..._availableModels] });
});

// ── Stats ──────────────────────────────────────────────────────────────────
app.get('/stats', (req, res) => {
  const proj = DB(), mem = MEM();
  try {
    const stats = { projects: 0, tasks: { total:0, done:0, pending:0, in_progress:0 }, avgQualityScore:'N/A', totalReflections:0 };
    stats.projects = proj.prepare('SELECT COUNT(*) as n FROM projects').get().n;
    proj.prepare('SELECT status, COUNT(*) as n FROM tasks GROUP BY status').all()
      .forEach(r => { stats.tasks[r.status] = r.n; stats.tasks.total += r.n; });
    const sc = proj.prepare('SELECT AVG(quality_score) as avg FROM tasks WHERE quality_score IS NOT NULL').get();
    stats.avgQualityScore = sc?.avg?.toFixed(2) || 'N/A';
    stats.totalReflections = mem.prepare('SELECT COUNT(*) as n FROM reflection_scores').get().n;
    proj.close(); mem.close();
    res.json(stats);
  } catch(e) { try { proj.close(); } catch {} try { mem.close(); } catch {} res.status(500).json({ error: e.message }); }
});

app.get('/dashboard', (req, res) => { try { res.json(getDashboard()); } catch(e) { res.status(500).json({ error: e.message }); } });

// ── Model Stats & Benchmark Analytics ─────────────────────────────────────
app.get('/stats/models', (req, res) => {
  const db = DB();
  try {
    // Per-model aggregated stats
    const models = db.prepare(`
      SELECT
        model,
        COUNT(*) as total_calls,
        ROUND(AVG(quality_score),2) as avg_score,
        ROUND(AVG(tok_per_sec),1) as avg_tok_per_sec,
        SUM(tokens_in) as total_tokens_in,
        SUM(tokens_out) as total_tokens_out,
        ROUND(AVG(duration_ms)/1000.0,1) as avg_duration_sec,
        MAX(created_at) as last_used
      FROM model_stats
      GROUP BY model
      ORDER BY total_calls DESC
    `).all();

    // Per-role breakdown
    const roles = db.prepare(`
      SELECT model, role, COUNT(*) as calls, ROUND(AVG(quality_score),2) as avg_score
      FROM model_stats WHERE role IS NOT NULL
      GROUP BY model, role ORDER BY calls DESC
    `).all();

    // Score trend — last 50 tasks per model
    const trends = db.prepare(`
      SELECT model, quality_score, created_at, pipeline_stage
      FROM model_stats WHERE quality_score IS NOT NULL
      ORDER BY created_at DESC LIMIT 100
    `).all();

    // Overall totals
    const totals = db.prepare(`
      SELECT SUM(tokens_in+tokens_out) as total_tokens,
             ROUND(AVG(tok_per_sec),1) as overall_tok_per_sec,
             COUNT(*) as total_calls
      FROM model_stats
    `).get();

    db.close();
    res.json({ models, roles, trends, totals });
  } catch(e) { try{db.close()}catch{}; res.status(500).json({ error: e.message }); }
});

app.get('/benchmark/history', (req, res) => {
  const db = DB();
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const model = req.query.model;
    const rows = db.prepare(`
      SELECT ms.*, t.title as task_title
      FROM model_stats ms LEFT JOIN tasks t ON ms.task_id = t.id
      ${model ? 'WHERE ms.model = ?' : ''}
      ORDER BY ms.created_at DESC LIMIT ?
    `).all(...(model ? [model, limit] : [limit]));
    db.close();
    res.json(rows);
  } catch(e) { try{db.close()}catch{}; res.status(500).json({ error: e.message }); }
});


app.post('/project/create', rateLimit(10), async (req, res) => {
  try {
    const { name, stack = 'node', model = 'qwen2.5-coder:3b' } = req.body;
    let { description } = req.body;
    if (!name || !description) return res.status(400).json({ error: 'name and description required' });

    // Optional brainstorm phase (msg-brainstorm-phase)
    if (req.body.brainstorm) {
      const brainstormAgent = new Agent('orchestrator', PROMPTS.orchestrator, { model: DEFAULT_MODEL });
      const brainstorm = await brainstormAgent.run(
        `Brainstorm the architecture for: "${name}" - ${description}\nStack: ${stack || 'node'}\nOutput: 3 key design decisions and 5 core components to build. Be specific.`,
        { useMultipass: false, rounds: 1 }
      );
      brainstormAgent.close();
      description = description + '\n\nARCHITECTURE NOTES:\n' + brainstorm.output.substring(0, 500);
    }

    const id = `proj_${Date.now()}`;
    const db = DB();
    try {
      // Ensure model column exists
      try { db.prepare(`ALTER TABLE projects ADD COLUMN model TEXT DEFAULT 'qwen2.5-coder:3b'`).run(); } catch {}
      db.prepare('INSERT INTO projects (id,name,description,stack,model) VALUES (?,?,?,?,?)').run(id, name, description, stack, model);
      const scaffold = await tools.scaffoldProject(id, stack);

      const stackLang = stack === 'python' ? 'Python' : stack === 'rust' ? 'Rust' : stack === 'go' ? 'Go' : 'Node.js/JavaScript';
      const fileExtHint = stack === 'python' ? '.py' : stack === 'rust' ? '.rs' : stack === 'go' ? '.go' : '.js';

      const epicRes = await callArchitect(
        `Project: "${name}" — ${description}\nStack: ${stackLang}\n\nList exactly 4 epic titles for this ${stackLang} project. Each epic groups related ${stackLang} files. Output ONLY a numbered list, one per line, no extra text:\n1.`,
        { system: PROMPTS.architect }
      );
      const epicTitles = epicRes.text.split('\n')
        .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
        .filter(l => l.length > 3)
        .slice(0, 5);

      const plan = { epics: [] };
      for (let ei = 0; ei < epicTitles.length; ei++) {
        const epicTitle = epicTitles[ei];
        const taskRes = await callArchitect(
          `Project: "${name}" (${stackLang})\nEpic: "${epicTitle}"\n\nList exactly 3 ${stackLang} files to create for this epic. Output ONLY short file names (no explanations), one per line:\n1.`,
          { system: PROMPTS.architect }
        );
        const taskTitles = taskRes.text.split('\n')
          .map(l => l.replace(/^\d+[\.\)]\s*/, '').replace(/^[-*]\s*/, '').trim())
          .filter(l => l.length > 2 && l.length < 80)
          .slice(0, 3);

        const eid = `${id}_e${ei+1}`;
        db.prepare('INSERT INTO epics (id,project_id,title) VALUES (?,?,?)').run(eid, id, epicTitle);
        const tasks = taskTitles.map((title, ti) => {
          const tid = `${eid}_t${ti+1}`;
          db.prepare('INSERT INTO tasks (id,epic_id,title,description) VALUES (?,?,?,?)').run(tid, eid, title, `Implement in ${stackLang}: ${title} for ${epicTitle}`);
          return { id: tid, title };
        });
        plan.epics.push({ id: eid, title: epicTitle, tasks });
      }

      console.log(`[architect] Plan: ${plan.epics.length} epics, ${plan.epics.flatMap(e=>e.tasks).length} tasks, model:${model}`);
      await memoryManager.storeKnowledge(`Project: ${name}\n${description}`, { type:'project', projectId:id });
      db.close();
      updateWorkspaceSymlink(id);
      res.json({ success:true, projectId:id, projectPath:scaffold.projectPath, plan, score: 8, model });
    } catch(e) { db.close(); throw e; }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Mutex with auto-timeout (prevents permanent deadlock) ─────────────────
let taskRunning = false;
let mutexAcquiredAt = null;
const MUTEX_TIMEOUT_MS = 20 * 60 * 1000; // 20 min max per task

function acquireMutex() {
  // Auto-release if stuck > 20 min (crash recovery)
  if (taskRunning && mutexAcquiredAt && (Date.now() - mutexAcquiredAt) > MUTEX_TIMEOUT_MS) {
    console.log('[mutex] ⚠ Auto-releasing stale mutex (>20min)');
    taskRunning = false;
    mutexAcquiredAt = null;
  }
  if (taskRunning) return false;
  taskRunning = true;
  mutexAcquiredAt = Date.now();
  return true;
}
function releaseMutex() { taskRunning = false; mutexAcquiredAt = null; }

// Reset in_progress tasks on startup (crash recovery)
try {
  const _db = DB();
  const _r = _db.prepare("UPDATE tasks SET status='pending' WHERE status='in_progress'").run();
  if (_r.changes > 0) console.log(`[startup] Reset ${_r.changes} stale in_progress task(s) to pending`);
  // Ensure model column exists on projects table
  try { _db.prepare(`ALTER TABLE projects ADD COLUMN model TEXT DEFAULT 'qwen2.5-coder:3b'`).run(); console.log('[startup] Added model column to projects'); } catch {}
  try { _db.prepare(`CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    token_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).run(); } catch(e) { console.error('[startup] chat_sessions table error:', e.message); }
  _db.close();
} catch(e) { console.error('[startup] DB reset error:', e.message); }

// ── SSE event bus (live log streaming to dashboard) ───────────────────────
const sseClients = new Set();
function sseEmit(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}
// broadcast is an alias for sseEmit (used by evolvePrompts)
const broadcast = sseEmit;

// ── Task dependency helpers ────────────────────────────────────────────────
function extractDependencies(task, allTasks) {
  const blockedBy = [];
  const desc = (task.description || '') + ' ' + (task.title || '');
  // Look for explicit "depends on:" markers
  const depMatch = desc.match(/depends?[:\s]+([^\n.]+)/i);
  if (depMatch) {
    const depHint = depMatch[1].toLowerCase();
    for (const other of allTasks) {
      if (other.id === task.id) continue;
      if (depHint.includes(other.title.toLowerCase().substring(0, 20))) {
        blockedBy.push(other.id);
      }
    }
  }
  // Heuristic: if task mentions "import from" or "uses" another task's likely filename
  const importMatch = desc.match(/(?:import|require|from)\s+['"]?(\w+)/gi) || [];
  for (const imp of importMatch) {
    const modName = imp.replace(/(?:import|require|from)\s+['"]?/i, '').toLowerCase();
    for (const other of allTasks) {
      if (other.id === task.id) continue;
      if (other.title.toLowerCase().includes(modName) && other.status === 'pending') {
        blockedBy.push(other.id);
      }
    }
  }
  return { blockedBy: [...new Set(blockedBy)] };
}

// ── Prompt Evolution ───────────────────────────────────────────────────────
async function evolvePrompts() {
  try {
    const db = DB();
    // Get the top recurring issues from last 50 tasks
    const recentTasks = db.prepare(`SELECT pipeline_log, quality_score FROM tasks 
      WHERE status='done' AND quality_score IS NOT NULL 
      ORDER BY completed_at DESC LIMIT 50`).all();
    db.close();

    // Collect issues
    const issueFreq = {};
    for (const t of recentTasks) {
      if (t.quality_score < 7 && t.pipeline_log) {
        try {
          const log = JSON.parse(t.pipeline_log);
          if (log.issues) log.issues.forEach(i => { issueFreq[i] = (issueFreq[i] || 0) + 1; });
        } catch(e) {}
      }
    }

    const topIssues = Object.entries(issueFreq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([issue]) => issue);
    if (topIssues.length === 0) return;

    // Ask orchestrator to suggest prompt improvements
    const agent = new Agent('orchestrator', PROMPTS.orchestrator, { model: DEFAULT_MODEL });
    const suggestion = await agent.run(
      `The coder agent keeps producing code with these issues: ${topIssues.join(', ')}. 
    Suggest ONE specific addition to the coder system prompt (max 50 words) to prevent these issues.
    Output ONLY the addition text, no explanation.`,
      { useMultipass: false, rounds: 1 }
    );
    agent.close();

    if (suggestion.output && suggestion.output.length > 10) {
      // Store evolved prompt addition in prompts.db
      const pdb = new Database(path.join(__dirname, '../db/prompts.db'));
      pdb.prepare(`CREATE TABLE IF NOT EXISTS prompt_evolutions 
        (id TEXT PRIMARY KEY, role TEXT, addition TEXT, issues TEXT, created_at TEXT)`).run();
      pdb.prepare(`INSERT OR REPLACE INTO prompt_evolutions VALUES (?,?,?,?,?)`).run(
        `evo_${Date.now()}`, 'coder', suggestion.output, topIssues.join(','), new Date().toISOString()
      );
      pdb.close();
      // Apply to live PROMPTS
      PROMPTS.coder = PROMPTS.coder + '\n\nEVOLVED RULE: ' + suggestion.output;
      broadcast('prompt_evolved', { role: 'coder', addition: suggestion.output });
      console.log(`[evolvePrompts] Applied coder evolution: ${suggestion.output.slice(0, 80)}`);
    }
  } catch(e) {
    console.error('[evolvePrompts] Error:', e.message);
  }
}
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  // Send current status immediately
  res.write(`event: connected\ndata: {"msg":"Forge SSE live stream connected"}\n\n`);
  req.on('close', () => sseClients.delete(res));
});
// ── Project-wide code intelligence (Copilot-style) ───────────────────────────

/**
 * Read ALL files in a project and build a map of exports, imports, and patterns.
 * This gives agents the same codebase awareness Copilot has.
 */
function buildProjectMap(projectPath, stack) {
  const allFiles = tools.listFiles(projectPath, ['.js','.ts','.py','.json','.md','.sh']).files || [];
  if (!allFiles.length) return { summary: '', files: [], exports: {}, patterns: {} };

  const fileMap = {};
  const allExports = {};
  const requiresFound = new Set();
  let totalLines = 0;

  for (const f of allFiles) {
    try {
      const r = tools.readFile(path.join(projectPath, f));
      if (!r.ok) continue;
      const content = r.content;
      const lines = content.split('\n');
      totalLines += lines.length;

      // Extract exports
      const exports = [];
      if (stack === 'node' || !stack) {
        content.match(/(?:module\.exports\.|exports\.)(\w+)\s*=/g)?.forEach(m => {
          const name = m.match(/\.(\w+)\s*=/)?.[1];
          if (name) exports.push(name);
        });
        content.match(/(?:^|\n)(?:async\s+)?function\s+(\w+)/g)?.forEach(m => {
          const name = m.match(/function\s+(\w+)/)?.[1];
          if (name && name !== 'anonymous') exports.push(name);
        });
        content.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g)?.forEach(m => {
          const name = m.match(/(?:const|let|var)\s+(\w+)/)?.[1];
          if (name) exports.push(name);
        });
        // Track requires to understand dependencies
        content.match(/require\(['"]([^'"./][^'"]*)['"]\)/g)?.forEach(m => {
          const pkg = m.match(/require\(['"]([^'"]+)['"]\)/)?.[1];
          if (pkg) requiresFound.add(pkg);
        });
      }
      // Only include short preview of large files
      const preview = lines.length > 30
        ? lines.slice(0, 15).join('\n') + `\n… (${lines.length} lines total)`
        : content;

      fileMap[f] = { lines: lines.length, exports: [...new Set(exports)], preview };
      if (exports.length) allExports[f] = [...new Set(exports)];
    } catch {}
  }

  // Detect naming/style patterns from most-lines file
  const biggestFile = Object.entries(fileMap).sort((a,b) => b[1].lines - a[1].lines)[0];
  const patterns = {};
  if (biggestFile) {
    const content = tools.readFile(path.join(projectPath, biggestFile[0])).content || '';
    patterns.usesAsync = content.includes('async ') && content.includes('await ');
    patterns.usesCallbacks = content.includes('callback') || content.match(/function.*err.*,.*data/);
    patterns.usesClasses = content.includes('class ');
    patterns.errorStyle = content.includes('throw new Error') ? 'throw' : content.includes('return { error') ? 'return-error' : 'try-catch';
    patterns.namingStyle = content.match(/[a-z][A-Z]/) ? 'camelCase' : 'snake_case';
  }

  const exportsText = Object.entries(allExports)
    .map(([f, exps]) => `${f}: exports [${exps.join(', ')}]`)
    .join('\n');

  const summary = [
    `PROJECT CODEBASE (${allFiles.length} files, ~${totalLines} lines):`,
    allFiles.map(f => `  ${f} (${fileMap[f]?.lines||0} lines)`).join('\n'),
    exportsText ? `\nAVAILABLE EXPORTS (import these instead of rewriting):\n${exportsText}` : '',
    Object.keys(patterns).length ? `\nCODE STYLE DETECTED:\n${Object.entries(patterns).map(([k,v])=>`  ${k}: ${v}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  return { summary, files: allFiles, exports: allExports, patterns, requires: [...requiresFound] };
}

/**
 * Extract ALL FILE: blocks from agent output — enables multi-file output per task.
 */
function extractAllFileBlocks(output) {
  const blocks = [];
  const regex = /FILE:\s*(\S+\.(?:js|ts|py|rs|go|json|md|sh|yaml|yml|env\.example|Dockerfile|\.gitignore))\s*\n([\s\S]*?)(?=\nFILE:|$)/gi;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const relPath = match[1].trim();
    const code = match[2].trim();
    if (code.length > 10) blocks.push({ relPath, code: stripFencesStatic(code) });
  }
  return blocks;
}

function stripFencesStatic(text) {
  return text
    .replace(/^```(?:javascript|js|typescript|python|py|rust|bash|json|sh)?\s*\n/gm, '')
    .replace(/^```\s*$/gm, '')
    .trim();
}

/**
 * Detect new require() packages in written code and add them to package.json.
 * Then run npm install if anything new was added.
 */
async function syncPackageDeps(projectPath, code) {
  if (!code || !projectPath) return;
  const pkgPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const existing = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      // Node built-ins — don't try to install these
      'fs','path','http','https','crypto','os','net','url','util','stream','events',
      'child_process','assert','buffer','cluster','dns','domain','readline','repl',
      'string_decoder','timers','tls','tty','v8','vm','worker_threads','zlib',
      'node:test','node:assert','node:fs','node:path','node:crypto','node:os'
    ]);
    const found = [];
    const requires = code.match(/require\(['"]([^'"./][^'"]*)['"]\)/g) || [];
    for (const r of requires) {
      const pkg2 = r.match(/require\(['"]([^'"]+)['"]\)/)?.[1];
      // strip sub-paths like 'express/router' → 'express'
      const base = pkg2?.split('/')[0];
      if (base && !existing.has(base) && !base.startsWith('@types')) {
        found.push(base);
        existing.add(base);
      }
    }

    if (found.length > 0) {
      console.log(`[deps] Installing new packages: ${found.join(', ')}`);
      pkg.dependencies = pkg.dependencies || {};
      for (const p of found) pkg.dependencies[p] = 'latest';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      try {
        execSync('npm install --save 2>&1', { cwd: projectPath, timeout: 30000, stdio: 'pipe' });
        console.log(`[deps] npm install completed`);
      } catch(e) {
        console.warn(`[deps] npm install warning: ${e.message?.slice(0,100)}`);
      }
    }
  } catch(e) {
    console.warn(`[deps] syncPackageDeps error: ${e.message}`);
  }
}

/**
 * Verify a written JS file can actually be loaded — catches broken imports/syntax.
 */
function verifyModuleLoads(filePath) {
  if (!filePath.endsWith('.js') && !filePath.endsWith('.ts')) return { ok: true };
  try {
    const tmp = `/tmp/forge_verify_${Date.now()}.js`;
    fs.writeFileSync(tmp, `try { require(${JSON.stringify(filePath)}) } catch(e) { if(!e.code||e.code==='ERR_REQUIRE_ESM') process.exit(0); process.stderr.write(e.message); process.exit(1); }`);
    execSync(`node ${tmp}`, { timeout: 8000, stdio: 'pipe' });
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: true };
  } catch(e) {
    return { ok: false, error: (e.stderr?.toString()||e.message||'').slice(0,200) };
  }
}

// ── Run Next Task (full pipeline) ──────────────────────────────────────────
app.post('/task/run-next', rateLimit(30), async (req, res) => {
  if (!acquireMutex()) return res.status(429).json({ message: 'Task already running — try again shortly' });
  const db = DB();
  try {
    // Get all pending tasks with dependency-ordered selection
    const projectId = req.body?.projectId;
    const pendingTasks = db.prepare(`
      SELECT t.id, t.title, t.description, t.epic_id, t.attempts,
        COALESCE(p.model,'qwen2.5-coder:3b') as project_model,
        p.id as project_id, p.name as proj_name, p.description as proj_desc,
        COALESCE(p.stack,'node') as stack,
        e.title as epic_title
      FROM tasks t
      JOIN epics e ON t.epic_id = e.id
      JOIN projects p ON e.project_id = p.id
      WHERE t.status = 'pending' AND t.attempts < 5
      ${projectId ? 'AND p.id = ?' : ''}
      ORDER BY t.created_at ASC
    `).all(...(projectId ? [projectId] : []));

    // Find first task with no unmet dependencies
    let task = null;
    for (const candidate of pendingTasks) {
      const deps = extractDependencies(candidate, pendingTasks);
      if (deps.blockedBy.length === 0) { task = candidate; break; }
    }
    if (!task) task = pendingTasks[0]; // fallback: take first if all blocked
    if (!task) { db.close(); releaseMutex(); return res.json({ message: 'No pending tasks' }); }
    const taskStartTime = Date.now();

    // GPU temp check before starting (throttle if hot)
    const gpuTemp = await gpuThrottle();
    sseEmit('task_start', { taskId: task.id, title: task.title, gpuTemp });

    db.prepare('UPDATE tasks SET status=?,assigned_agent=?,attempts=attempts+1,started_at=datetime(\'now\'),updated_at=CURRENT_TIMESTAMP WHERE id=?').run('in_progress','coder',task.id);

    const projectPath = path.join(__dirname, '../projects', task.project_id);
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id) || { stack: task.stack || 'node' };
    const existingFiles = tools.listFiles(projectPath,['.js','.ts','.py','.json','.md','.sh']).files || [];

    // Build full project map — all files, exports, patterns (Copilot-style codebase awareness)
    const projectMap = buildProjectMap(projectPath, task.stack || 'node');

    // Dynamic context: more files included as project matures
    const db2 = DB();
    const doneCount = db2.prepare(`SELECT COUNT(*) as n FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=? AND t.status='done'`).get(task.project_id).n;
    db2.close();

    // Read all project files — full content, no truncation
    const fileContext = existingFiles.map(f => {
      const r = tools.readFile(path.join(projectPath, f));
      if (!r.ok) return '';
      return `=== ${f} ===\n${r.content}`;
    }).filter(Boolean).join('\n\n');

    const recalled_unused = null; // moved below
    const stack = task.stack || 'node';
    const stackHint = stack === 'node' ? 'JavaScript/Node.js (.js files, no Python)' :
                      stack === 'python' ? 'Python (.py files)' :
                      stack === 'rust' ? 'Rust (.rs files)' : stack;
    const fileExt = stack === 'node' ? '.js' : stack === 'python' ? '.py' : stack === 'rust' ? '.rs' : '.js';

    // ── Stage outputs accumulator — every agent reads from this ───────────
    const stageOutputs = {};

    // ── Base shared context (project/task info passed to every agent) ──────
    const projectModel = getAgentModel('coder');
    const tasksDone = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status='done'").get().n;
    if (tasksDone > 0 && tasksDone % 10 === 0) {
      const projSummary = sessionMem.getProjectSummary(task.project_id);
      if (projSummary) req._contextRefresh = { summary: projSummary, tasksDone };
    }
    const memBestPractices = sessionMem.getBestPracticesContext('coder');
    const memErrorAvoid = sessionMem.getErrorAvoidanceContext();
    const memProjectCtx = sessionMem.getProjectSummary(task.project_id) || '';
    const patternContext = patternLib.getPatternsContext(task.title, project.stack || 'node');
    const knowledgeContext = await knowledgeBase.getKnowledgeContext(task.title, project.stack || 'node');
    const stackContext = getStackContext(stack);
    const relevantCode = indexer.getRelevantContext(task.project_id, task.title, task.description || '');
    const recalled = await memoryManager.recall(task.title + ' ' + (task.description || ''));

    // All other tasks in this epic — so agents understand the bigger picture
    const epicTasksDb = DB();
    const epicTasks = epicTasksDb.prepare(
      `SELECT title, status FROM tasks WHERE epic_id=? AND id!=? ORDER BY created_at ASC`
    ).all(task.epic_id, task.id);
    epicTasksDb.close();
    const epicTasksContext = epicTasks.length
      ? `OTHER TASKS IN THIS EPIC:\n${epicTasks.map(t=>`- [${t.status}] ${t.title}`).join('\n')}`
      : '';

    const sharedContext = [
      `PROJECT: ${task.proj_name}`,
      `PROJECT DESCRIPTION: ${task.proj_desc || ''}`,
      `STACK: ${stackHint}`,
      `EPIC: ${task.epic_title || ''}`,
      epicTasksContext,
      `CURRENT TASK: ${task.title}`,
      `TASK REQUIREMENTS:\n${task.description || ''}`,
      projectMap.summary || '',   // full codebase map — all files, exports, patterns
      relevantCode,
      recalled ? `MEMORY (similar past tasks):\n${recalled}` : '',
      memBestPractices,
      memErrorAvoid,
      memProjectCtx ? `PROJECT CONTEXT:\n${memProjectCtx}` : '',
      patternContext,
      knowledgeContext,
      stackContext,
    ].filter(Boolean).join('\n\n');

    // ── Stage 1: Researcher — deep domain analysis ─────────────────────────
    console.log(`[researcher] Analyzing: ${task.title.slice(0,60)}`);
    sseEmit('agent', { agent: 'research', task: task.title, status: 'running' });
    try {
      const researchAgent = new Agent('researcher', PROMPTS.research);
      if (req._contextRefresh) researchAgent.refreshContext(req._contextRefresh.summary, [task.title]);
      const researchRun = await researchAgent.run(
        `${sharedContext}\n\nProduce a research brief for this task. Use the project context above to understand what the full project is about and what this piece needs to do within it. Be specific to this project and stack — no generic advice.`,
        { useMultipass: false, rounds: 1, taskId: task.id }
      );
      researchAgent.close();
      stageOutputs.research = researchRun;
    } catch(e) {
      stageOutputs.research = { output: '' };
      console.warn('[researcher] failed:', e.message);
    }
    sseEmit('pipeline_stage', { role: 'research', status: 'done', score: null, taskId: task.id });
    broadcast({ type: 'pipeline_stage', role: 'research', status: 'done', taskId: task.id });

    // ── Stage 2: Architect — spec design using researcher brief ───────────
    console.log(`[architect] Planning: ${task.title.slice(0,60)}`);
    sseEmit('agent', { agent: 'architect', task: task.title, status: 'running' });
    const architect = new Agent('architect', PROMPTS.architect, { model: ARCHITECT_MODEL });
    if (req._contextRefresh) architect.refreshContext(req._contextRefresh.summary, [task.title]);
    const archHandoff = buildHandoffContext('architect', stageOutputs, task);
    const plan = await architect.run(
      `${sharedContext}${archHandoff}\n\nDesign the implementation spec for this task. Build ON TOP of the researcher brief above. Be specific: exact file path, exact function signatures, exact data structures.`,
      { useMultipass: false, taskId: task.id, model: ARCHITECT_MODEL }
    );
    architect.close();
    plan.output = plan.output.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    stageOutputs.architect = plan;
    const planSummary = plan.output.slice(0, 800);
    sseEmit('pipeline_stage', { role: 'architect', status: 'done', score: null, taskId: task.id });

    // ── Stage 3: Coder — implements researcher+architect spec ─────────────
    console.log(`[coder] Implementing: ${task.title.slice(0,60)}`);
    sseEmit('agent', { agent: 'coder', task: task.title, status: 'running' });
    const coderPrompt = getPromptVariant('coder');
    const compressedCoderPrompt = compressPrompt(coderPrompt + getConstitutionContext('coder'));
    const coder = new Agent('coder', compressedCoderPrompt);
    if (req._contextRefresh) coder.refreshContext(req._contextRefresh.summary, [task.title]);
    const coderHandoff = buildHandoffContext('coder', stageOutputs, task);
    // Extract the exact file path the architect specified so the coder uses the right filename
    const archFilePath = extractArchitectFilePath(stageOutputs.architect?.output) ||
      `src/${task.title.replace(/[^a-z0-9]+/gi,'_').slice(0,30).toLowerCase()}${fileExt}`;
    const coded = await coder.run(
      `${sharedContext}${coderHandoff}\n\nImplement the architect spec exactly. The architect specified this file: ${archFilePath}\nYour first output line MUST be: FILE: ${archFilePath}\nYou can add additional FILE: blocks for helper modules if needed.\nNo TODOs. No stubs. Full production code.\nReuse existing exports from the project map — do NOT rewrite what already exists.`,
      { useMultipass: true, minScore: 7, rounds: 3, taskId: task.id }
    );
    coder.close();
    stageOutputs.coder = coded;
    sseEmit('agent', { agent: 'coder', task: task.title, status: 'done', score: coded.score });
    sseEmit('pipeline_stage', { role: 'coder', status: 'done', score: coded.score, taskId: task.id });

    // ── Constitution check + auto-repair ──────────────────────────────────
    let coderOutput = coded.output;
    const coderViolations = checkConstitution(coderOutput, 'coder');
    if (coderViolations.length > 2) {
      console.log(`[coder] Constitution violations (${coderViolations.length}): ${coderViolations.join(', ')} — repairing`);
      sseEmit('agent', { agent: 'coder', task: task.title, status: 'repair' });
      const repairAgent = new Agent('coder', PROMPTS.coder + getConstitutionContext('coder'));
      const repaired = await repairAgent.run(
        `REPAIR REQUIRED. Your previous output violated: ${coderViolations.join(', ')}.\n\nOriginal task: ${task.title}\n\nFix ALL violations. Output ONLY the corrected code starting with FILE: ${archFilePath}`,
        { useMultipass: false, rounds: 1 }
      );
      repairAgent.close();
      if (repaired.output.includes('FILE:')) coderOutput = repaired.output;
    }
    stageOutputs.coder = { ...coded, output: coderOutput };

    // Strip markdown code fences from model output
    function stripFences(text) {
      return text
        .replace(/^```(?:javascript|js|typescript|python|py|rust|bash|json|sh)?\s*\n/gm, '')
        .replace(/^```\s*$/gm, '')
        .trim();
    }

    // Validate JS syntax before writing (prevents broken files)
    function validateSyntax(code, ext) {
      if (ext !== '.js' && ext !== '.ts') return { ok: true };
      // Write to tmp file and check — avoids sh vs bash herestring issues
      const tmp = `/tmp/forge_syntax_${Date.now()}.js`;
      try {
        fs.writeFileSync(tmp, code);
        execSync(`node --check ${tmp}`, { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
        return { ok: true };
      } catch(e) {
        return { ok: false, error: (e.stdout || e.stderr || e.message || '').slice(0, 200) };
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }

    // ── Write ALL FILE: blocks from coder output (multi-file support) ────────
    const fileBlocks = extractAllFileBlocks(coderOutput);
    let writtenFile = null;
    const writtenFiles = [];

    if (fileBlocks.length > 0) {
      for (const { relPath, code } of fileBlocks) {
        const absPath = path.join(projectPath, relPath);
        const syntaxCheck = validateSyntax(code, path.extname(relPath));
        if (!syntaxCheck.ok) console.log(`[coder] ⚠ Syntax warning ${relPath}: ${syntaxCheck.error?.slice(0,80)}`);
        tools.writeFile(absPath, code);
        writtenFiles.push(relPath);
        await memoryManager.indexCode(relPath, code, task.project_id);
        console.log(`[coder] Wrote ${relPath} (${code.split('\n').length} lines)`);
        // Auto-add new npm packages to package.json + npm install
        await syncPackageDeps(projectPath, code);
        // Verify module loads (catches broken imports)
        if (relPath.endsWith('.js') || relPath.endsWith('.ts')) {
          const verify = verifyModuleLoads(absPath);
          if (!verify.ok) {
            console.warn(`[coder] ⚠ Module load failed: ${relPath}: ${verify.error}`);
            sseEmit('agent', { agent: 'coder', task: task.title, status: 'load-error', file: relPath, error: verify.error });
          }
        }
      }
      writtenFile = fileBlocks[0].relPath;
    } else {
      // fallback — no FILE: prefix detected
      const ext = stack === 'python' ? '.py' : stack === 'rust' ? '.rs' : '.js';
      const backtickName = task.title.match(/`([^`]+)`/)?.[1];
      const autoName = backtickName || task.title.replace(/[^a-z0-9]+/gi,'_').slice(0,30).toLowerCase() + ext;
      const relPath = autoName.includes('/') ? autoName : `src/${autoName}`;
      const cleanCode = stripFences(coderOutput);
      tools.writeFile(path.join(projectPath, relPath), cleanCode);
      writtenFile = relPath;
      writtenFiles.push(relPath);
      await syncPackageDeps(projectPath, cleanCode);
      console.log(`[coder] Auto-named (no FILE: prefix): ${relPath}`);
    }

    stageOutputs.coder = { ...coded, output: coderOutput };
    sseEmit('file_written', { files: writtenFiles, file: writtenFile, score: coded.score, task: task.title });

    // ── Refactor + Tester in parallel (both get full stageOutputs handoff) ──
    console.log(`[refactor+tester] Running in parallel for: ${writtenFile}`);
    sseEmit('agent', { agent: 'refactor', task: task.title, status: 'running' });
    sseEmit('agent', { agent: 'tester', task: task.title, status: 'running' });
    const [refactorResult, testerResult] = await Promise.all([
      (async () => {
        const refactorAgent = new Agent('refactor', compressPrompt(PROMPTS.refactor + getConstitutionContext('refactor')));
        if (req._contextRefresh) refactorAgent.refreshContext(req._contextRefresh.summary, [task.title]);
        const handoff = buildHandoffContext('refactor', stageOutputs, task);
        return refactorAgent.run(
          `${sharedContext}${handoff}\n\nRefactor the code above to perfectly match the architect spec and researcher requirements.`,
          { useMultipass: false, rounds: 1, taskId: task.id }
        );
      })(),
      (async () => {
        const testerAgent = new Agent('tester', compressPrompt(PROMPTS.tester + getConstitutionContext('tester')));
        const handoff = buildHandoffContext('tester', stageOutputs, task);
        return testerAgent.run(
          `${sharedContext}${handoff}\n\nWrite tests for the actual exports shown in the architect spec and code above.`,
          { useMultipass: false, rounds: 1, taskId: task.id }
        );
      })()
    ]);

    // Apply refactor output — handle multiple FILE: blocks
    const rfBlocks = extractAllFileBlocks(refactorResult.output);
    let finalCode = coderOutput;
    if (rfBlocks.length > 0) {
      for (const { relPath, code } of rfBlocks) {
        tools.writeFile(path.join(projectPath, relPath), code);
        console.log(`[refactor] Improved: ${relPath}`);
      }
      // Use first refactor block as finalCode for downstream agents
      if (refactorResult.score >= (coded.score || 0) - 1) {
        finalCode = rfBlocks[0].code;
        stageOutputs.coder = { ...stageOutputs.coder, output: refactorResult.output };
      }
    }

    // Apply tester output and run tests
    let testResult = null;
    if (writtenFile) {
      const tfm = testerResult.output.match(/FILE:\s*(\S+\.(?:js|ts|py|rs|go|json|md|sh))\s*\n([\s\S]+)/);
      if (tfm) tools.writeFile(path.join(projectPath, tfm[1].trim()), stripFences(tfm[2].trim()));
      testResult = await tools.runTests(projectPath);
      console.log(`[tester] Tests ${testResult.passed ? '✅ passed' : '❌ failed'}`);
      sseEmit('tests', { passed: testResult.passed, task: task.title });
    }

    broadcast({ type: 'pipeline_stage', role: 'refactor', status: 'done', score: refactorResult.score, taskId: task.id });
    broadcast({ type: 'pipeline_stage', role: 'tester', status: testResult?.passed ? 'done' : 'error', score: testerResult.score, taskId: task.id });

    // ── Debugger if tests fail ─────────────────────────────────────────────
    if (testResult && !testResult.passed) {
      console.log(`[debugger] Tests failed, auto-fixing...`);
      sseEmit('agent', { agent: 'debugger', task: task.title, status: 'running' });
      for (let fixRound = 1; fixRound <= 2; fixRound++) {
        const dbg = new Agent('debugger', PROMPTS.debugger);
        const handoff = buildHandoffContext('debugger', {
          ...stageOutputs,
          testError: (testResult.stderr||testResult.stdout||'unknown error').slice(0,500)
        }, task);
        const fixed = await dbg.run(
          `${sharedContext}${handoff}\n\nFix the root cause. Output FILE: ${writtenFile} then the complete corrected file.`,
          { useMultipass:true, minScore:7, rounds:2, taskId:task.id }
        );
        dbg.close();
        const ffm = fixed.output.match(/FILE:\s*(\S+\.(?:js|ts|py|rs|go|json|md|sh))\s*\n([\s\S]+)/);
        if (ffm) {
          tools.writeFile(path.join(projectPath, ffm[1].trim()), stripFences(ffm[2].trim()));
          stageOutputs.coder = { ...stageOutputs.coder, output: fixed.output };
          testResult = await tools.runTests(projectPath);
          if (testResult.passed) break;
          memoryManager.recordError('debugger', testResult.stderr?.slice(0,300)||'test failure');
        } else break;
      }
      sseEmit('pipeline_stage', { role: 'debugger', status: testResult?.passed ? 'done' : 'error', score: null, taskId: task.id });
    }

    // ── Reviewer — reviews against research brief + arch spec + code ──────
    console.log(`[reviewer] Final review of: ${writtenFile}`);
    sseEmit('agent', { agent: 'reviewer', task: task.title, status: 'running' });
    const reviewer = new Agent('reviewer', compressPrompt(PROMPTS.reviewer + getConstitutionContext('reviewer')));
    const reviewHandoff = buildHandoffContext('reviewer', stageOutputs, task);
    const reviewed = await reviewer.run(
      `${sharedContext}${reviewHandoff}\n\nReview the code against the researcher brief and architect spec above. Is it correct, complete, and production-ready?`,
      { useMultipass:false, taskId:task.id }
    );
    reviewer.close();
    stageOutputs.reviewer = reviewed;

    const reviewScoreMatch = reviewed.output.match(/SCORE:\s*(\d+)/);
    const reviewScore = reviewScoreMatch ? parseInt(reviewScoreMatch[1]) : null;
    const reviewVerdict = reviewed.output.match(/VERDICT:\s*(APPROVE|REJECT)/i)?.[1]?.toUpperCase();
    sseEmit('pipeline_stage', { role: 'reviewer', status: 'done', score: reviewScore, taskId: task.id });
    recordBench({ model: getAgentModel('reviewer'), role: 'reviewer', taskId: task.id, tokOut: reviewed?.tokens||0, tokPerSec: reviewed?.tokPerSec||0, qualityScore: reviewScore, stage: 'reviewer' });

    // ── Reviewer feedback loop — if REJECT, coder gets one fix pass ───────
    if (reviewVerdict === 'REJECT' && reviewScore !== null && reviewScore < 7) {
      console.log(`[reviewer-fix] Score ${reviewScore} REJECTED — sending issues back to coder`);
      sseEmit('agent', { agent: 'coder', task: task.title, status: 'fixing', reviewScore });
      const fixCoder = new Agent('coder', compressedCoderPrompt);
      const fixHandoff = buildHandoffContext('coder_fix', stageOutputs, task);
      const fixed = await fixCoder.run(
        `${sharedContext}${fixHandoff}\n\nFix all reviewer issues above. Output FILE: ${writtenFile||`src/index${fileExt}`} then the complete corrected file.`,
        { useMultipass: true, minScore: 7, rounds: 2, taskId: task.id }
      );
      fixCoder.close();
      if (fixed.output.includes('FILE:') && fixed.score >= (reviewScore || 0)) {
        const fixFm = fixed.output.match(/FILE:\s*(\S+\.(?:js|ts|py|rs|go|json|md|sh))\s*\n([\s\S]+)/);
        if (fixFm) {
          const fixClean = stripFences(fixFm[2].trim());
          tools.writeFile(path.join(projectPath, fixFm[1].trim()), fixClean);
          stageOutputs.coder = { ...stageOutputs.coder, output: fixed.output };
          finalCode = fixClean;
          console.log(`[reviewer-fix] Applied fix, new score: ${fixed.score}`);
        }
      }
      sseEmit('pipeline_stage', { role: 'reviewer-fix', status: 'done', score: fixed?.score, taskId: task.id });
    }

    // ── Collaborative arch review (second independent perspective) ─────────
    const prelimScore = Math.max(coded.score || 0, reviewScore || 0);
    let pipelineLog_archReview = null;
    if (prelimScore >= 6) {
      const archReviewer = new Agent('architect', PROMPTS.architect);
      const archReview = await archReviewer.run(
        `Review this code from an ARCHITECTURE perspective only. Does it follow the original architect spec? Is it modular? Does it integrate well with the rest of the project?
Rate 1-10 and list max 2 specific improvements.

ARCHITECT SPEC:\n${planSummary}
CODE:\n${finalCode}`,
        { useMultipass: false, rounds: 1, taskId: task.id }
      );
      archReviewer.close();
      pipelineLog_archReview = { output: archReview.output.substring(0, 400) };

      // If arch reviewer catches something important, run one more refactor pass
      const archScore = parseInt((archReview.output.match(/\b([0-9]|10)\s*\/\s*10/) || ['', '5'])[1]) || 5;
      if (archScore < 6 && finalCode.includes('FILE:')) {
        const archRefactor = new Agent('refactor', PROMPTS.refactor);
        const archFixed = await archRefactor.run(
          `Apply these architectural improvements: ${archReview.output.substring(0, 300)}\n\nCODE:\n${finalCode}`,
          { useMultipass: false, rounds: 1, taskId: task.id }
        );
        archRefactor.close();
        if (archFixed.output.includes('FILE:')) {
          finalCode = archFixed.output;
        }
      }
      sseEmit('agent', { agent: 'arch-review', task: task.title, status: 'done', archScore });
    }

    // ── Security audit pass ────────────────────────────────────────────────
    sseEmit('agent', { agent: 'security', task: task.title, status: 'running' });
    const secAgent = new Agent('security', PROMPTS.security);
    const secHandoff = buildHandoffContext('security', stageOutputs, task);
    const secResult = await secAgent.run(
      `${sharedContext}${secHandoff}\n\nAudit the code above for security vulnerabilities. FILE is: ${writtenFile||'src/index.js'}`,
      { useMultipass: false, rounds: 1, taskId: task.id }
    );
    secAgent.close();
    const secScoreMatch = secResult.output.match(/SECURITY SCORE:\s*(\d+)/i);
    const secScore = secScoreMatch ? parseInt(secScoreMatch[1]) : null;
    const secFixed = secResult.output.includes('FILE:') ? stripFences(secResult.output) : null;
    if (secFixed && secScore !== null && secScore < 8) {
      const secFileMatch = secFixed.match(/^FILE:\s*(.+)$/m);
      if (secFileMatch) {
        const secCode = secFixed.replace(/^FILE:\s*.+\n?/, '');
        if (secCode.trim().length > 50) {
          tools.writeFile(path.join(projectPath, secFileMatch[1].trim()), secCode);
          finalCode = secCode;
        }
      }
    }
    sseEmit('agent', { agent: 'security', task: task.title, status: 'done', secScore });
    recordBench({ model: getAgentModel('security'), role: 'security', taskId: task.id, tokOut: secResult?.tokens||0, tokPerSec: secResult?.tokPerSec||0, qualityScore: secScore, stage: 'security' });

    // ── Documentation pass ────────────────────────────────────────────────
    sseEmit('agent', { agent: 'docs', task: task.title, status: 'running' });
    const docsAgent = new Agent('docs', PROMPTS.docs);
    const docsHandoff = buildHandoffContext('docs', stageOutputs, task);
    const docsResult = await docsAgent.run(
      `${sharedContext}${docsHandoff}\n\nAdd comprehensive JSDoc documentation. Preserve all logic. Output FILE: ${writtenFile||'src/index.js'} then the fully documented code.`,
      { useMultipass: false, rounds: 1, taskId: task.id }
    );
    docsAgent.close();
    const docsFixed = docsResult.output.includes('FILE:') ? stripFences(docsResult.output) : null;
    if (docsFixed) {
      const docsFileMatch = docsFixed.match(/^FILE:\s*(.+)$/m);
      if (docsFileMatch) {
        const docsCode = docsFixed.replace(/^FILE:\s*.+\n?/, '');
        if (docsCode.trim().length > 50) {
          tools.writeFile(path.join(projectPath, docsFileMatch[1].trim()), docsCode);
          finalCode = docsCode;
        }
      }
    }
    sseEmit('agent', { agent: 'docs', task: task.title, status: 'done' });
    recordBench({ model: getAgentModel('docs'), role: 'docs', taskId: task.id, tokOut: docsResult?.tokens||0, tokPerSec: docsResult?.tokPerSec||0, stage: 'docs' });

    // Use best of coder score and reviewer score
    let finalScore = Math.max(coded.score || 0, reviewScore || 0);
    recordAbResult('coder', coderPrompt.substring(0, 40), finalScore);
    const durationMs = Date.now() - taskStartTime;

    // ── Smart Error Recovery (vision-error-recovery) ──────────────────────
    const pipelineLog_recovery = { triggered: false };
    if (finalScore < 5) {
      pipelineLog_recovery.triggered = true;
      pipelineLog_recovery.originalScore = finalScore;
      console.log(`[recovery] Score ${finalScore} < 5 — triggering smart error recovery`);
      sseEmit('agent', { agent: 'recovery', task: task.title, status: 'running' });
      try {
        const recovered = await smartErrorRecovery(task, finalCode, finalScore, projectModel, sharedContext);
        if (recovered.score > finalScore) {
          finalCode = recovered.output;
          finalScore = recovered.score;
          pipelineLog_recovery.recoveredScore = finalScore;
          broadcast({ type: 'error_recovered', taskId: task.id, from: pipelineLog_recovery.originalScore, to: finalScore });
          console.log(`[recovery] Improved score: ${pipelineLog_recovery.originalScore} → ${finalScore}`);
        }
      } catch(e) { console.error('[recovery] Error:', e.message); }
    }

    // ── Quality Ratchet — never regress below project's best ──────────────
    const sessionBest = ratchetScore(task.project_id, finalScore);
    let pipelineLog_ratchetRetry = false;
    if (shouldRetryForRatchet(task.project_id, finalScore)) {
      console.log(`[ratchet] Score ${finalScore} below project best ${sessionBest} — retrying`);
      sseEmit('agent', { agent: 'ratchet', task: task.title, status: 'running', sessionBest });
      const ratchetAgent = new Agent('coder', PROMPTS.coder + getConstitutionContext('coder'));
      const ratchetResult = await ratchetAgent.run(
        `Previous attempt scored ${finalScore}/10 but this project has achieved ${sessionBest}/10 before. Higher quality is expected.\n\nTask: ${task.title}\n${task.description || ''}`,
        { useMultipass: true, minScore: 7, rounds: 2 }
      );
      ratchetAgent.close();
      if (ratchetResult.score > finalScore) {
        finalCode = ratchetResult.output;
        finalScore = ratchetResult.score;
        pipelineLog_ratchetRetry = true;
        ratchetScore(task.project_id, finalScore);
        console.log(`[ratchet] Improved to ${finalScore}/10`);
      }
    }

    // Cross-review: architect checks if implementation matches the plan
    let pipelineLog_crossReview = null;
    if (finalScore >= 6 && planSummary) {
      const crossReviewer = new Agent('architect', PROMPTS.architect);
      const crossReview = await crossReviewer.run(
        `You previously planned: ${planSummary.substring(0,300)}
    
The coder implemented: ${finalCode.substring(0,600)}

Does the implementation match the plan? Score alignment 1-10. List any gaps.
Output: ALIGNMENT: N/10 then bullet list of gaps (or "No gaps found").`,
        { useMultipass: false, rounds: 1, taskId: task.id }
      );
      crossReviewer.close();
      pipelineLog_crossReview = { output: crossReview.output.substring(0,400) };

      // If major misalignment, log it but don't block (too slow to redo)
      const alignment = parseInt((crossReview.output.match(/ALIGNMENT:\s*(\d+)/i)||['','5'])[1]);
      if (alignment < 5) {
        broadcast({ type: 'alignment_warning', taskId: task.id, alignment, projectId: task.project_id });
      }
    }

    // Build structured pipeline log for dashboard
    // Auto-save high-quality outputs as reusable patterns
    if (finalScore >= 9 && finalCode.includes('FILE:')) {
      const fileMatch = finalCode.match(/FILE:\s*(\S+)/);
      if (fileMatch) {
        patternLib.addPattern({
          id: `generated_${task.id}`,
          tags: [project.stack||'node', ...(task.title.toLowerCase().split(' ').slice(0,3))],
          description: task.title,
          code: finalCode.substring(0, 800)
        });
      }
    }
    const pipelineLog = JSON.stringify({
      research: researchContext ? searchResult.results.length + ' results' : 'skipped',
      architect: planSummary,
      coderScore: coded.score,
      coderRounds: coded.rounds,
      coderSessionSummary: coded.sessionSummary,
      refactored: !!rfm,
      testsPassed: testResult?.passed ?? null,
      reviewScore,
      secScore,
      archReview: pipelineLog_archReview,
      crossReview: pipelineLog_crossReview,
      recovery: pipelineLog_recovery,
      durationMs,
      writtenFile,
      ratchetRetry: pipelineLog_ratchetRetry,
      sessionBestScore: sessionBest
    });

    await tools.gitCommit(projectPath, `feat: ${task.title} (score:${finalScore}/10, ${Math.round(durationMs/1000)}s)`);
    try {
      const coderModel = getAgentModel('coder');
      db.prepare(`UPDATE tasks SET status=?,result=?,quality_score=?,completed_at=datetime('now'),duration_ms=?,pipeline_log=?,model_used=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run('done', extractFinalCode(finalCode).slice(0,2000), finalScore, durationMs, pipelineLog, coderModel, task.id);
      console.log(`[db] ✅ task ${task.id} marked done (score:${finalScore})`);
      // Record benchmark stats for this completed task
      recordBench({ model: coderModel, role: 'coder', taskId: task.id, tokIn: coded?.promptTokens||0, tokOut: coded?.tokens||0, durationMs, tokPerSec: coded?.tokPerSec||0, qualityScore: finalScore, stage: 'full_pipeline' });
    } catch(dbErr) {
      console.error(`[db] ❌ FAILED to mark task done: ${dbErr.message}`);
    }

    autoGitCommit(projectPath, task.title, finalScore).catch(() => {});

    // Record learnings in cross-session memory
    if (finalScore >= 8) {
      sessionMem.recordBestPractice(`${task.title}: score ${finalScore}/10 in ${Math.round(durationMs/60000)}min`, 'coder');
      sessionMem.recordAgentLearning('coder', task.title, finalScore);
      knowledgeBase.addKnowledge('pattern', task.title,
        `Stack: ${project.stack}. Score: ${finalScore}/10. ${task.description||''}`,
        [project.stack||'node', task.assigned_agent||'coder']).catch(()=>{});
    }
    if (finalScore < 6) {
      sessionMem.recordErrorPattern(`Low score on "${task.title.slice(0,60)}" — score:${finalScore}`);
    }
    if (finalScore < 5) {
      knowledgeBase.addKnowledge('error', `AVOID: ${task.title}`,
        `Low score ${finalScore}/10. Pipeline issues detected.`,
        ['error', project.stack||'node']).catch(()=>{});
    }
    // Trigger prompt evolution every 10 completed tasks (non-blocking)
    if ((tasksDone + 1) % 10 === 0) {
      console.log(`[pipeline] ${tasksDone + 1} tasks done — triggering prompt evolution`);
      evolvePrompts();
    }
    // Update rolling project summary every 3 tasks
    const summaryDoneCount = db.prepare("SELECT COUNT(*) as c FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=? AND t.status='done'").get(task.project_id);
    if (summaryDoneCount.c % 3 === 0) {
      const recentTasks = db.prepare("SELECT t.title,t.quality_score FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=? AND t.status='done' ORDER BY t.completed_at DESC LIMIT 9").all(task.project_id);
      const ctxSummary = `Completed: ${recentTasks.map(t=>`${t.title}(${t.quality_score||'?'})`).join(', ')}`;
      sessionMem.setProjectSummary(task.project_id, ctxSummary);
    }

    // Check if epic is complete → trigger epic self-review
    const epicPending = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE epic_id=? AND status!='done'").get(task.epic_id);
    if (epicPending.c === 0) {
      console.log(`[pipeline] Epic ${task.epic_id} complete — triggering self-review`);
      const epicTasks = db.prepare("SELECT * FROM tasks WHERE epic_id=? AND status='done'").all(task.epic_id);
      const fileContents = epicTasks.slice(0,4).map(t => `=== ${t.title} ===\n${(t.result||'').slice(0,400)}`).join('\n\n');
      const epicData = db.prepare('SELECT * FROM epics WHERE id=?').get(task.epic_id);
      // Fire-and-forget epic review in background
      generate(
        `Epic: ${epicData?.title||task.epic_id}\n\nFiles completed:\n${fileContents}\n\nIdentify integration issues and list FIX: tasks needed:`,
        { system: PROMPTS.reviewer, numCtx: DEFAULT_CTX }
      ).then(r => {
        const fixLines = r.text.split('\n').filter(l=>/^FIX:/i.test(l.trim())).map(l=>l.replace(/^FIX:\s*/i,'').trim()).filter(l=>l.length>5&&l.length<100);
        if (fixLines.length > 0) {
          const _db2 = DB();
          fixLines.slice(0,3).forEach((ft, idx) => {
            const tid = `${task.epic_id}_fix_${Date.now()}_${idx}`;
            _db2.prepare('INSERT INTO tasks (id,epic_id,title,description) VALUES (?,?,?,?)').run(tid, task.epic_id, ft, `Self-review fix: ${ft}`);
          });
          _db2.close();
          sseEmit('epic_review_tasks', { epicId: task.epic_id, added: fixLines.length });
          notifyN8n('epic_complete', { epicId: task.epic_id, fixTasks: fixLines.length });
        }
      }).catch(() => {});
    }

    db.close();
    releaseMutex();
    _lastTaskTime = Date.now();
    updateWorkspaceSymlink(task.project_id);
    // Re-index project after task completes (non-blocking)
    setImmediate(() => {
      try {
        const projPath = path.join(__dirname, '../projects', task.project_id);
        indexer.indexProject(task.project_id, projPath);
      } catch {}
    });
    const result = { taskId:task.id, title:task.title, status:'done', qualityScore:finalScore, coderScore:coded.score, reviewScore, writtenFile, testsPassed:testResult?.passed??null, durationMs, review:reviewed.output.slice(0,600) };
    sseEmit('task_done', result);
    // Notify n8n
    notifyN8n('task_done', { taskId:task.id, title:task.title, score:finalScore, projectId:task.project_id });
    res.json(result);
  } catch(e) { db.close(); releaseMutex(); sseEmit('error', { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// ── Fix Error ──────────────────────────────────────────────────────────────
app.post('/fix/error', async (req, res) => {
  try {
    const { errorLog, filePath, code, projectId } = req.body;
    if (!errorLog) return res.status(400).json({ error: 'errorLog required' });
    let fc = code;
    if (!fc && filePath) { const r = tools.readFile(filePath); if (r.ok) fc = r.content; }
    const recalled = await memoryManager.recall(errorLog);
    const agent = new Agent('debugger', PROMPTS.debugger);
    const result = await agent.run(
      `${recalled?recalled+'\n\n':''}Error:\n${errorLog}${filePath?'\nFile: '+filePath:''}${fc?'\nCode:\n'+fc:''}\n\nDiagnose and fix. Start with FILE: path if writing a file.`,
      { useMultipass:true, minScore:7, rounds:2 }
    );
    agent.close();
    let fixApplied = false;
    if (projectId) {
      const pp = path.join(__dirname, '../projects', projectId);
      const ffm = result.output.match(/FILE:\s*(.+)\n([\s\S]+)/);
      if (ffm) { tools.writeFile(path.join(pp, ffm[1].trim()), ffm[2].trim()); fixApplied = true; }
    }
    memoryManager.recordError('debugger', errorLog.slice(0,200));
    res.json({ fix:result.output, score:result.score, fixApplied });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Run Agent Directly ─────────────────────────────────────────────────────
app.post('/agent/:role', async (req, res) => {
  try {
    const { role } = req.params;
    const { task, useMultipass=false, minScore=8, context, projectId } = req.body;
    if (!task) return res.status(400).json({ error: 'task required' });
    if (!PROMPTS[role]) return res.status(404).json({ error: `Unknown agent: ${role}. Valid: ${Object.keys(PROMPTS).join(', ')}` });
    const recalled = await memoryManager.recall(task);
    // If projectId given, add file context
    let fileCtx = '';
    if (projectId) {
      const pp = path.join(__dirname, '../projects', projectId);
      const files = tools.listFiles(pp,['.js','.ts','.py','.json','.md']).files?.slice(0,10) || [];
      fileCtx = files.length ? `Project files:\n${files.join('\n')}` : '';
    }
    const fullTask = [recalled, context, fileCtx, task].filter(Boolean).join('\n\n');
    const agent = new Agent(role, PROMPTS[role]);
    const result = await agent.run(fullTask, { useMultipass, minScore });
    agent.close();
    memoryManager.remember(role, 'assistant', result.output.slice(0,500));
    res.json({ output:result.output, score:result.score, rounds:result.rounds });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Web Search ─────────────────────────────────────────────────────────────
app.get('/tools/search', async (req, res) => {
  try {
    const { q, n = 5, source = 'all' } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const results = {};
    const tasks = [];
    if (source === 'all' || source === 'web')   tasks.push(tools.webSearch(q, parseInt(n)).then(r => { results.web = r; }));
    if (source === 'all' || source === 'npm')   tasks.push(tools.searchNpm(q, 5).then(r => { results.npm = r; }));
    if (source === 'all' || source === 'so')    tasks.push(tools.searchStackOverflow(q, 4).then(r => { results.stackoverflow = r; }));
    await Promise.all(tasks);
    // Flatten for backward compatibility (results.results for web)
    const flat = results.web || { results: [] };
    res.json({ ...flat, ...results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/tools/fetch', async (req, res) => {
  try {
    const { url, max = 4000 } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    const result = await tools.fetchPage(url, parseInt(max));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Tools ──────────────────────────────────────────────────────────────────
app.post('/tools/shell', async (req, res) => {
  try { const { command, cwd } = req.body; res.json(await tools.runShell(command, { cwd, allowFail:true })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/tools/shell-unsafe', (req, res) => {
  const { cmd, adminKey } = req.body;
  if (adminKey !== (process.env.FORGE_ADMIN_KEY || 'forge-local-admin')) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  tools.runShell(cmd, { allowFail: true, bypassSandbox: true })
    .then(result => res.json(result))
    .catch(e => res.status(500).json({ error: e.message }));
});
app.post('/tools/file', (req, res) => {
  const { action, path:fp, content, projectId } = req.body;
  if (action==='read') return res.json(tools.readFile(fp));
  if (action==='write') {
    try {
      return res.json(tools.writeFile(fp, content, projectId));
    } catch(e) {
      return res.status(400).json({ error: e.message });
    }
  }
  if (action==='list') return res.json(tools.listFiles(fp));
  res.status(400).json({ error: 'action: read|write|list' });
});
app.post('/tools/test', async (req, res) => {
  try { res.json(await tools.runTests(req.body.projectPath)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/tools/git', async (req, res) => {
  try {
    const { action, projectPath, message } = req.body;
    if (action==='status') return res.json(await tools.gitStatus(projectPath));
    if (action==='commit') return res.json(await tools.gitCommit(projectPath, message));
    if (action==='diff') return res.json(await tools.gitDiff(projectPath));
    res.status(400).json({ error: 'action: status|commit|diff' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Memory ─────────────────────────────────────────────────────────────────
app.post('/memory/store', async (req, res) => { try { res.json(await memoryManager.storeKnowledge(req.body.text, req.body.metadata)); } catch(e) { res.status(500).json({ error:e.message }); } });
app.post('/memory/recall', async (req, res) => { try { res.json({ results: await memoryManager.recall(req.body.query, req.body.topK||5) }); } catch(e) { res.status(500).json({ error:e.message }); } });
app.post('/memory/compress', async (req, res) => {
  try {
    const roles = req.body.role ? [req.body.role] : Object.keys(PROMPTS);
    const results = {};
    for (const r of roles) results[r] = await memoryManager.summarize(r);
    res.json(results);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Task Management: restart / redo / direct-run ──────────────────────────
// Restart: reset a stale/failed task back to pending
app.post('/task/:id/restart', (req, res) => {
  try {
    const db = DB();
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
    if (!task) { db.close(); return res.status(404).json({ error: 'Task not found' }); }
    db.prepare("UPDATE tasks SET status='pending',assigned_agent=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
    db.close();
    res.json({ ok: true, message: `Task "${task.title}" reset to pending` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Redo: force re-run a task even if it's marked done (resets attempts too)
app.post('/task/:id/redo', (req, res) => {
  try {
    const db = DB();
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
    if (!task) { db.close(); return res.status(404).json({ error: 'Task not found' }); }
    db.prepare("UPDATE tasks SET status='pending',attempts=0,quality_score=NULL,result=NULL,assigned_agent=NULL,pipeline_log=NULL,started_at=NULL,completed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
    db.close();
    res.json({ ok: true, message: `Task "${task.title}" queued for redo` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Redo multiple tasks at once (by project)
app.post('/project/:id/redo-low-quality', (req, res) => {
  try {
    const { minScore = 7 } = req.body;
    const db = DB();
    const r = db.prepare(`
      UPDATE tasks SET status='pending',attempts=0,quality_score=NULL,result=NULL,assigned_agent=NULL,pipeline_log=NULL,started_at=NULL,completed_at=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT t.id FROM tasks t JOIN epics e ON t.epic_id=e.id
        WHERE e.project_id=? AND t.status='done' AND (t.quality_score IS NULL OR t.quality_score < ?)
      )
    `).run(req.params.id, minScore);
    db.close();
    res.json({ ok: true, requeued: r.changes, message: `${r.changes} low-quality tasks queued for redo` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reset ALL in_progress tasks (useful after crash/restart)
app.post('/tasks/reset-stale', (req, res) => {
  try {
    const db = DB();
    const r = db.prepare("UPDATE tasks SET status='pending' WHERE status='in_progress'").run();
    db.close();
    res.json({ ok: true, reset: r.changes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.post('/improve', rateLimit(5), async (req, res) => { try { res.json(await runImprovementCycle(PROMPTS)); } catch(e) { res.status(500).json({ error:e.message }); } });
app.get('/improve/dashboard', (req, res) => { try { res.json(getDashboard()); } catch(e) { res.status(500).json({ error:e.message }); } });
app.get('/improve/trend/:role', (req, res) => { try { res.json(getQualityTrend(req.params.role)); } catch(e) { res.status(500).json({ error:e.message }); } });

// ── Quality Ratchet ────────────────────────────────────────────────────────
app.get('/quality/ratchet', (req, res) => {
  const ratchetData = {};
  for (const [pid, score] of _qualityRatchet) ratchetData[pid] = score;
  res.json({ ratchet: ratchetData });
});

// ── Projects API ───────────────────────────────────────────────────────────
app.get('/projects', (req, res) => {
  try {
    const db = DB();
    const projects = db.prepare(`
      SELECT p.*,
        COUNT(t.id) as task_total,
        SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) as task_done,
        SUM(CASE WHEN t.status='in_progress' THEN 1 ELSE 0 END) as task_running,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) as task_pending,
        AVG(t.quality_score) as avg_score,
        SUM(t.duration_ms) as total_duration_ms,
        MIN(t.started_at) as first_started,
        MAX(t.completed_at) as last_completed
      FROM projects p
      LEFT JOIN epics e ON e.project_id = p.id
      LEFT JOIN tasks t ON t.epic_id = e.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `).all();
    db.close();
    res.json(projects);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/projects/overview', (req, res) => {
  const db = DB();
  try {
    const projects = db.prepare(`
      SELECT p.id, p.name, p.stack, p.created_at,
        COUNT(DISTINCT e.id) as epicCount,
        COUNT(DISTINCT t.id) as taskCount,
        COUNT(DISTINCT CASE WHEN t.status='done' THEN t.id END) as doneTasks,
        ROUND(AVG(CASE WHEN t.quality_score > 0 THEN t.quality_score END), 1) as avgScore,
        MAX(t.quality_score) as bestScore
      FROM projects p
      LEFT JOIN epics e ON e.project_id = p.id
      LEFT JOIN tasks t ON t.epic_id = e.id
      GROUP BY p.id ORDER BY p.created_at DESC
    `).all();

    const overview = projects.map(p => ({
      ...p,
      progress: p.taskCount > 0 ? Math.round((p.doneTasks / p.taskCount) * 100) : 0,
      grade: p.avgScore >= 9 ? 'S' : p.avgScore >= 8 ? 'A' : p.avgScore >= 7 ? 'B' : p.avgScore >= 6 ? 'C' : 'D',
      status: p.doneTasks === p.taskCount && p.taskCount > 0 ? 'complete' : 'in-progress'
    }));

    res.json({
      projects: overview,
      total: overview.length,
      avgGrade: overview.length ? (overview.reduce((s, p) => s + (p.avgScore || 0), 0) / overview.length).toFixed(1) : 0
    });
  } finally { db.close(); }
});

app.get('/projects/compare', (req, res) => {
  const db = DB();
  try {
    const rows = db.prepare(`
      SELECT p.name, p.stack,
        COUNT(CASE WHEN t.status='done' THEN 1 END) as done,
        ROUND(AVG(CASE WHEN t.quality_score > 0 THEN t.quality_score END),1) as avg,
        MAX(t.quality_score) as best,
        MIN(CASE WHEN t.quality_score > 0 THEN t.quality_score END) as worst
      FROM projects p
      LEFT JOIN epics e ON e.project_id = p.id
      LEFT JOIN tasks t ON t.epic_id = e.id
      GROUP BY p.id
    `).all();
    res.json({ comparison: rows });
  } finally { db.close(); }
});

app.get('/projects/:id', (req, res) => {
  try {
    const db = DB();
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const epics = db.prepare('SELECT * FROM epics WHERE project_id=?').all(req.params.id);
    for (const epic of epics) {
      epic.tasks = db.prepare('SELECT * FROM tasks WHERE epic_id=? ORDER BY created_at').all(epic.id);
    }
    db.close();
    res.json({ ...project, epics });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/tasks/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const db = DB();
    const tasks = db.prepare(`
      SELECT t.*, e.title as epic_title, p.name as project_name, p.id as project_id
      FROM tasks t
      JOIN epics e ON t.epic_id = e.id
      JOIN projects p ON e.project_id = p.id
      ORDER BY t.updated_at DESC LIMIT ?
    `).all(limit);
    db.close();
    res.json(tasks);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/task/:id', (req, res) => {
  try {
    const db = DB();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    db.close();
    if (!task) return res.status(404).json({ error: 'not found' });
    try { task.pipeline_log = task.pipeline_log ? JSON.parse(task.pipeline_log) : null; } catch(e) {}
    res.json(task);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Project file browser (direct project ID) ──────────────────────────────
app.get('/projects/:id/files', (req, res) => {
  try {
    const projectPath = path.join(__dirname, '../projects', req.params.id);
    const allExts = ['.js','.ts','.py','.rs','.go','.json','.md','.sh','.txt','.html','.css'];
    const result = tools.listFiles(projectPath, allExts);
    const files = (result.files || []).map(f => ({
      path: f,
      fullPath: path.join(projectPath, f),
      size: (() => { try { return require('fs').statSync(path.join(projectPath,f)).size; } catch { return 0; } })()
    }));
    res.json({ projectPath, files });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Generate runnable scripts for a project ───────────────────────────────
app.post('/project/:id/generate-scripts', async (req, res) => {
  try {
    const db = DB();
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) { db.close(); return res.status(404).json({ error: 'Project not found' }); }
    const tasks = db.prepare(`
      SELECT t.title, t.result FROM tasks t
      JOIN epics e ON t.epic_id=e.id
      WHERE e.project_id=? AND t.status='done' AND t.result IS NOT NULL
      ORDER BY t.created_at
    `).all(req.params.id);
    db.close();

    const projDir = path.join(__dirname, '../projects', project.id);
    const fs = require('fs');
    if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });

    // Collect all generated files from task results
    const fileList = [];
    for (const t of tasks) {
      const fileMatch = (t.result || '').match(/FILE:\s*(\S+)/);
      if (fileMatch) fileList.push(fileMatch[1]);
    }

    // Ask the architect to generate README + package.json / requirements.txt + run script
    const prompt = `PROJECT: ${project.name}
DESCRIPTION: ${project.description}
STACK: ${project.stack || 'node'}
GENERATED FILES: ${fileList.join(', ')}

Generate THREE files:

FILE: README.md
# ${project.name}
[A complete README with: description, installation, usage, commands, examples, and development notes]

FILE: ${project.stack === 'python' ? 'requirements.txt' : 'package.json'}
[Complete dependencies file with all required packages for the project above]

FILE: run.sh
#!/bin/bash
[A script that installs dependencies and runs the project. Include both install and start commands.]`;

    const { generate } = require('./ollama');
    const result = await generate(prompt, {
      system: 'You are a senior DevOps engineer. Generate complete, working project setup files. Every FILE: section must contain a complete, production-ready file.',
      numCtx: 8192
    });

    // Write each file found in the result
    const blocks = result.text.split(/(?=FILE:\s*\S)/);
    const written = [];
    for (const block of blocks) {
      const m = block.match(/^FILE:\s*(\S+)\s*\n([\s\S]+)/);
      if (!m) continue;
      const [, filePath, content] = m;
      const fullPath = path.join(projDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content.trim());
      written.push(filePath);
    }

    res.json({ ok: true, written, message: `Generated ${written.length} project scripts` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/file', (req, res) => {
  try {
    const fp = req.query.path;
    if (!fp || !fp.startsWith('/home/mrnova420/forge/projects/')) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    const result = tools.readFile(fp);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Chat Session Persistence ──────────────────────────────────────────────
app.post('/chat/sessions', async (req, res) => {
  try {
    const { id, title, model, messages, tokenCount } = req.body;
    if (!messages) return res.status(400).json({ error: 'messages required' });

    let autoTitle = title;
    if (!autoTitle || autoTitle === 'New Chat') {
      const msgs = JSON.parse(messages || '[]');
      const firstUser = msgs.find(m => m.role === 'user');
      autoTitle = firstUser ? firstUser.content.slice(0, 60).trim() + (firstUser.content.length > 60 ? '...' : '') : 'Chat';
    }

    const db = DB();
    try {
      const sid = id || Date.now().toString(36) + Math.random().toString(36).slice(2,6);
      const existing = id ? db.prepare('SELECT id FROM chat_sessions WHERE id=?').get(id) : null;
      if (existing) {
        db.prepare('UPDATE chat_sessions SET title=?, model=?, messages=?, token_count=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(autoTitle, model||null, messages, tokenCount||0, sid);
      } else {
        db.prepare('INSERT INTO chat_sessions (id, title, model, messages, token_count) VALUES (?,?,?,?,?)')
          .run(sid, autoTitle, model||null, messages, tokenCount||0);
      }
      const row = db.prepare('SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id=?').get(sid);
      res.json(row);
    } finally { db.close(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/chat/sessions', async (req, res) => {
  try {
    const db = DB();
    try {
      const rows = db.prepare('SELECT id, title, model, token_count, created_at, updated_at, messages FROM chat_sessions ORDER BY updated_at DESC').all();
      res.json(rows.map(r => {
        let mc = 0;
        try { mc = JSON.parse(r.messages||'[]').filter(m=>m.role==='user').length } catch {}
        return { id: r.id, title: r.title, model: r.model, token_count: r.token_count, created_at: r.created_at, updated_at: r.updated_at, message_count: mc };
      }));
    } finally { db.close(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/chat/sessions/:id', async (req, res) => {
  try {
    const db = DB();
    try {
      const row = db.prepare('SELECT id, title, model, messages, token_count, created_at FROM chat_sessions WHERE id=?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Session not found' });
      row.messages = JSON.parse(row.messages || '[]');
      res.json(row);
    } finally { db.close(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/chat/sessions/:id', async (req, res) => {
  try {
    const db = DB();
    try {
      db.prepare('DELETE FROM chat_sessions WHERE id=?').run(req.params.id);
      res.json({ ok: true });
    } finally { db.close(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CHAT — primary entry point: just describe what you want ──────────────
// Works like a real dev team: understand the request, create project if needed,
// add tasks if already developing, always keep the runner going.
app.post('/chat', rateLimit(20), async (req, res) => {
  try {
    const { message, projectId: explicitProjectId } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Intent detection — detect build requests and route to /build
    const buildTriggers = ['build', 'create', 'make', 'write', 'develop', 'generate', 'code', 'implement'];
    const msgLower = (message || '').toLowerCase();
    const isBuildRequest = buildTriggers.some(t => msgLower.startsWith(t) || msgLower.includes(' ' + t + ' '))
      && msgLower.length > 15
      && !msgLower.includes('?'); // not a question

    if (isBuildRequest && !explicitProjectId) {
      try {
        const buildRes = await fetch(`http://localhost:${PORT}/build`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: message, autoRun: true })
        });
        const buildData = await buildRes.json();
        if (buildData.projectId) {
          return res.json({
            response: `🚀 Got it! I'm building **${buildData.name}** — ${buildData.description}\n\n📋 Created ${buildData.totalTasks} tasks across ${buildData.epics?.length} epics:\n${(buildData.epics||[]).map(e => `• ${e.title} (${e.tasks?.length} tasks)`).join('\n')}\n\n⚡ Auto-build started! Watch the progress in your dashboard.`,
            projectId: buildData.projectId,
            type: 'build_started',
            project: buildData
          });
        }
      } catch(e) {
        // Fall through to normal chat if build fails
      }
    }

    const { generate } = require('./ollama');
    const db = DB();

    // --- Step 1: Find active project (most recent with any tasks) ---
    const activeProject = explicitProjectId
      ? db.prepare('SELECT * FROM projects WHERE id=?').get(explicitProjectId)
      : db.prepare(`
          SELECT p.*, COUNT(t.id) as task_total,
            SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) as pending
          FROM projects p
          LEFT JOIN epics e ON e.project_id=p.id
          LEFT JOIN tasks t ON t.epic_id=e.id
          GROUP BY p.id ORDER BY p.created_at DESC LIMIT 1
        `).get();

    // --- Step 2: Classify intent ---
    const intentRes = await generate(
      `User message: "${message.slice(0, 300)}"\nActive project: ${activeProject ? activeProject.name : 'none'}\n\nClassify intent as one word: NEW_PROJECT | ADD_TASKS | CHAT_QUESTION | FIX_BUG | EXPAND\nRespond with only the word:`,
      { system: 'You classify developer intents. Reply with only one word from the given options.' }
    );
    const intent = intentRes.text.trim().split(/\s+/)[0].toUpperCase().replace(/[^A-Z_]/g,'');
    console.log(`[chat] intent="${intent}" project=${activeProject?.name || 'none'}`);

    let responseMsg = '';
    let projectIdForRunner = activeProject?.id;

    if (intent === 'NEW_PROJECT' || !activeProject) {
      // Extract project metadata from message
      const metaRes = await generate(
        `From this request: "${message.slice(0, 400)}"\nExtract JSON: {"name":"short-kebab-name","description":"one sentence what it does","stack":"node or python"}\nJSON only:`,
        { system: 'Extract project metadata as JSON. Use node for JavaScript/web/API projects, python for data/ML/scripts.' }
      );
      let meta = { name: 'my-project', description: message.slice(0, 100), stack: 'node' };
      try {
        const m = metaRes.text.match(/\{[\s\S]*?\}/);
        if (m) meta = { ...meta, ...JSON.parse(m[0]) };
      } catch {}
      meta.name = meta.name.replace(/[^a-z0-9-]/gi, '-').slice(0, 30).toLowerCase();
      db.close();

      // Create project using existing /project/create logic
      const createRes = await fetch(`http://localhost:${process.env.FORGE_PORT || 3737}/project/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta)
      });
      const created = await createRes.json();
      projectIdForRunner = created.projectId;
      const taskCount = created.plan?.epics?.flatMap(e => e.tasks).length || 0;
      responseMsg = `🚀 Creating **${meta.name}** (${meta.stack}) — planned ${taskCount} tasks across ${created.plan?.epics?.length || 0} epics. Running dev team now...`;
    } else if (intent === 'ADD_TASKS' || intent === 'EXPAND') {
      // Add new tasks to the active project
      const stackLang = activeProject.stack === 'python' ? 'Python' : 'Node.js';
      const fileExt = activeProject.stack === 'python' ? '.py' : '.js';
      const taskRes = await generate(
        `Project: "${activeProject.name}" — ${activeProject.description || ''}\nUser wants: "${message.slice(0, 300)}"\n\nList 3-5 new ${stackLang} files to implement for this request. Output ONLY filenames (${fileExt}), one per line:\n1.`,
        { system: PROMPTS.architect }
      );
      const newTasks = taskRes.text.split('\n')
        .map(l => l.replace(/^\d+[\.\)]\s*/, '').replace(/^[-*]\s*/, '').trim())
        .filter(l => l.length > 2 && l.length < 80);

      // Add to first epic of the project (or create a new one)
      let epicId = db.prepare('SELECT id FROM epics WHERE project_id=? ORDER BY created_at LIMIT 1').get(activeProject.id)?.id;
      if (!epicId) {
        epicId = `${activeProject.id}_e_chat`;
        db.prepare('INSERT INTO epics (id,project_id,title) VALUES (?,?,?)').run(epicId, activeProject.id, `Chat: ${message.slice(0, 50)}`);
      }
      const added = [];
      for (let i = 0; i < newTasks.length; i++) {
        const tid = `${epicId}_tc${Date.now()}_${i}`;
        db.prepare('INSERT INTO tasks (id,epic_id,title,description) VALUES (?,?,?,?)').run(
          tid, epicId, newTasks[i], `Implement in ${stackLang}: ${newTasks[i]} — requested: ${message.slice(0, 200)}`
        );
        added.push(newTasks[i]);
      }
      db.close();
      responseMsg = `➕ Added ${added.length} tasks to **${activeProject.name}**: ${added.join(', ')}. Running now...`;
    } else if (intent === 'FIX_BUG') {
      db.close();
      // Route to fix/error endpoint
      const fixRes = await fetch(`http://localhost:${process.env.FORGE_PORT || 3737}/fix/error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ errorLog: message, projectId: activeProject?.id })
      });
      const fix = await fixRes.json();
      return res.json({ intent, response: fix.fix?.slice(0, 600) || 'No fix found', projectId: activeProject?.id });
    } else {
      // CHAT_QUESTION — build rich project context then answer with model
      const projectId = activeProject?.id;

      // Build rich project context
      let projectContext = '';
      if (projectId) {
        // db is already open — reuse it before closing
        try {
          const proj = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
          if (proj) {
            const taskStats = db.prepare(`
              SELECT
                COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
                COUNT(CASE WHEN status='done' THEN 1 END) as done,
                COUNT(CASE WHEN status='in_progress' THEN 1 END) as running,
                ROUND(AVG(CASE WHEN status='done' THEN quality_score END),1) as avgScore
              FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?
            `).get(projectId);
            const recentTasks = db.prepare(`
              SELECT t.title, t.status, t.quality_score FROM tasks t
              JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?
              ORDER BY t.created_at DESC LIMIT 5
            `).all(projectId);
            projectContext = `\nProject: ${proj.name} (${proj.stack})
Description: ${proj.description || 'N/A'}
Tasks: ${taskStats.done} done, ${taskStats.pending} pending, ${taskStats.running} running
Avg quality: ${taskStats.avgScore || 'N/A'}/10
Recent tasks: ${recentTasks.map(t => `${t.title} [${t.status}${t.quality_score ? ' '+t.quality_score+'/10' : ''}]`).join(', ')}`;
          }
        } catch {}
      }
      db.close();

      // Handle special shortcut commands without hitting the model
      const msgLowerChat = (message || '').toLowerCase().trim();
      let directResponse;

      if (msgLowerChat === 'status' || msgLowerChat === 'status?' || msgLowerChat.includes('project status')) {
        if (projectContext) {
          directResponse = `📊 **Project Status**\n${projectContext}`;
        }
      } else if (msgLowerChat.includes('run') && (msgLowerChat.includes('task') || msgLowerChat.includes('next') || msgLowerChat.includes('all'))) {
        directResponse = `I'll run the next task for you! Use the **⚡ Auto-Build** button or call \`POST /project/${projectId}/auto-run\` to run all tasks automatically.`;
      }

      if (directResponse) {
        return res.json({ intent, response: directResponse, projectId });
      }

      // Try semantic search for relevant code snippets
      let recentCode = '';
      try {
        const indexer = require('./indexer');
        recentCode = indexer.getRelevantContext(projectId, message, '');
      } catch {}

      const systemPrompt = `You are Forge, an expert AI software development assistant.${projectContext}

You help developers build, debug, improve, and understand code. You can:
- Answer questions about the current project
- Explain code and technical concepts
- Suggest implementations and architecture
- Review and improve code quality
- Help debug issues

Be concise and direct. When asked to build something, explain that you'll create a project with /build.`;

      const fullPrompt = `${systemPrompt}${recentCode ? '\n\nRelevant code:\n' + recentCode.slice(0, 600) : ''}

User: ${message}

Forge:`;

      const result = await callOllama('qwen2.5-coder:3b', fullPrompt, {
        temperature: 0.5,
        num_ctx: DEFAULT_CTX
      });
      responseMsg = result.response || 'I could not generate a response.';
      return res.json({ intent, response: responseMsg, projectId });
    }

    // Start runner in background
    const { exec } = require('child_process');
    const logPath = path.join(__dirname, '../logs/autorun.log');
    const runnerPath = path.join(__dirname, '../run-all.sh');
    exec(`pgrep -f 'run-all.sh' | head -1`, (err, pid) => {
      if (!pid?.trim()) {
        exec(`nohup bash ${runnerPath} >> ${logPath} 2>&1 &`, { detached: true });
      }
    });

    res.json({ intent, response: responseMsg, projectId: projectIdForRunner, running: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Expand project: orchestrator reviews done work, adds more tasks ────────
// Called by run-all.sh when no pending tasks remain
app.post('/project/:id/expand', async (req, res) => {
  try {
    const db = DB();
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) { db.close(); return res.status(404).json({ added: 0, reason: 'project not found' }); }

    // Check how many tasks already exist (prevent runaway expansion)
    const totalTasks = db.prepare(`
      SELECT COUNT(*) as n FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?
    `).get(req.params.id).n;
    if (totalTasks >= 40) { db.close(); return res.json({ added: 0, reason: 'max tasks reached (40)' }); }

    // Get recent completed task summaries + file list
    const done = db.prepare(`
      SELECT t.title, t.quality_score FROM tasks t JOIN epics e ON t.epic_id=e.id
      WHERE e.project_id=? AND t.status='done' ORDER BY t.completed_at DESC LIMIT 10
    `).all(req.params.id);
    const pp = path.join(__dirname, '../projects', req.params.id);
    const existingFiles = tools.listFiles(pp, ['.js','.py','.ts','.json','.md']).files?.join(', ') || '';
    const avgScore = done.length ? (done.reduce((s,t) => s + (t.quality_score||0), 0) / done.length).toFixed(1) : 0;

    const stackLang = project.stack === 'python' ? 'Python' : 'Node.js';
    const fileExt = project.stack === 'python' ? '.py' : '.js';
    const { generate } = require('./ollama');

    const expandRes = await generate(
      `Project: "${project.name}" — ${project.description || ''}\nStack: ${stackLang}\nFiles built: ${existingFiles}\nCompleted tasks: ${done.map(t=>t.title).join(', ')}\nAvg quality: ${avgScore}/10\n\nWhat 2-3 ${stackLang} files are still MISSING to make this project fully functional and production-ready? If nothing is missing, say COMPLETE.\nOutput filenames only (${fileExt}), one per line:`,
      { system: PROMPTS.architect }
    );

    if (/complete|nothing|all done|no (more|additional)/i.test(expandRes.text)) {
      db.close();
      return res.json({ added: 0, reason: 'orchestrator says project complete', complete: true });
    }

    const newFiles = expandRes.text.split('\n')
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').replace(/^[-*]\s*/, '').trim())
      .filter(l => l.length > 2 && l.length < 80 && (fileExt === '.py' ? l.endsWith('.py') : l.endsWith('.js') || l.endsWith('.json')));

    if (!newFiles.length) { db.close(); return res.json({ added: 0, reason: 'no new files identified' }); }

    let epicId = db.prepare('SELECT id FROM epics WHERE project_id=? ORDER BY created_at DESC LIMIT 1').get(req.params.id)?.id;
    if (!epicId) {
      epicId = `${req.params.id}_e_expand`;
      db.prepare('INSERT INTO epics (id,project_id,title) VALUES (?,?,?)').run(epicId, req.params.id, 'Expansion Pass');
    }
    const added = [];
    for (let i = 0; i < newFiles.length; i++) {
      const tid = `${epicId}_te${Date.now()}_${i}`;
      db.prepare('INSERT INTO tasks (id,epic_id,title,description) VALUES (?,?,?,?)').run(
        tid, epicId, newFiles[i], `Implement in ${stackLang}: ${newFiles[i]} — expansion pass to complete project`
      );
      added.push(newFiles[i]);
    }
    db.close();
    console.log(`[expand] Added ${added.length} tasks to ${project.name}: ${added.join(', ')}`);
    res.json({ added: added.length, tasks: added });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Runner status (enhanced) ───────────────────────────────────────────────
app.get('/runner/status', (req, res) => {
  try {
    let pid = null;
    try {
      const raw = execSync("pgrep -f 'run-all.sh' | head -1", { encoding:'utf8' }).trim();
      if (raw) { try { execSync(`kill -0 ${raw}`, {stdio:'ignore'}); pid = raw; } catch {} }
    } catch {}
    const logTail = require('fs').existsSync(path.join(__dirname,'../logs/autorun.log'))
      ? require('fs').readFileSync(path.join(__dirname,'../logs/autorun.log'), 'utf8').split('\n').slice(-20).join('\n')
      : '';
    res.json({ running: !!pid, pid, recentLog: logTail });
  } catch { res.json({ running: false, pid: null, recentLog: '' }); }
});

app.post('/runner/start', (req, res) => {
  // Verify pid is actually alive before reporting as running
  const getLivePid = () => {
    try {
      const pid = execSync("pgrep -f 'run-all.sh' | head -1", { encoding:'utf8' }).trim();
      if (!pid) return null;
      try { execSync(`kill -0 ${pid}`, { stdio:'ignore' }); return pid; } catch { return null; }
    } catch { return null; }
  };
  const existing = getLivePid();
  if (existing) return res.json({ started: false, message: 'Already running', pid: existing });
  const { exec } = require('child_process');
  const runnerPath = path.join(__dirname, '../run-all.sh');
  const logPath = path.join(__dirname, '../logs/autorun.log');
  exec(`nohup bash ${runnerPath} >> ${logPath} 2>&1 &`, { detached: true });
  setTimeout(() => {
    const pid = getLivePid();
    res.json({ started: !!pid, pid: pid || null });
  }, 1800);
});

app.post('/runner/stop', (req, res) => {
  try {
    const pid = execSync("pgrep -f 'run-all.sh' | head -1", { encoding:'utf8' }).trim();
    if (pid) { execSync(`kill ${pid}`); res.json({ stopped: true, pid }); }
    else res.json({ stopped: false, message: 'Not running' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GPU / System stats ─────────────────────────────────────────────────────
app.get('/system/gpu', async (req, res) => {
  try {
    const raw = execSync('nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits 2>/dev/null', { encoding:'utf8', timeout:3000 }).trim();
    const [temp, util, memUsed, memTotal, power] = raw.split(',').map(s => s.trim());
    res.json({ temp: parseInt(temp), utilization: parseInt(util), memUsed: parseInt(memUsed), memTotal: parseInt(memTotal), power: parseFloat(power), safe: parseInt(temp) < 78 });
  } catch { res.json({ temp: 0, utilization: 0, memUsed: 0, memTotal: 0, power: 0, safe: true, error: 'nvidia-smi unavailable' }); }
});

// ── Available Ollama models ────────────────────────────────────────────────
app.get('/models', async (req, res) => {
  try {
    const data = await fetch('http://localhost:11434/api/tags');
    const json = await data.json();
    const models = (json.models || []).map(m => ({
      name: m.name,
      size: m.size,
      sizeMB: Math.round(m.size / 1024 / 1024),
      modified: m.modified_at
    }));
    res.json({ models, current: process.env.FORGE_MODEL || 'qwen2.5-coder:3b' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Set active model for a project ────────────────────────────────────────
app.post('/project/:id/set-model', (req, res) => {
  try {
    const { model } = req.body;
    if (!model) return res.status(400).json({ error: 'model required' });
    const db = DB();
    // Store model preference in project (add column if needed)
    try { db.prepare('ALTER TABLE projects ADD COLUMN model TEXT').run(); } catch {}
    db.prepare('UPDATE projects SET model=? WHERE id=?').run(model, req.params.id);
    // Also update all pending tasks for this project
    db.prepare(`UPDATE tasks SET description=COALESCE(description,'')||? WHERE status='pending' AND epic_id IN (SELECT id FROM epics WHERE project_id=?)`).run('', req.params.id);
    db.close();
    res.json({ ok: true, model, projectId: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── System doctor ──────────────────────────────────────────────────────────
app.get('/system/doctor', async (req, res) => {
  const checks = [];
  // Ollama running
  try { await fetch('http://localhost:11434/api/tags'); checks.push({ name:'Ollama', ok:true, msg:'Running on :11434' }); }
  catch { checks.push({ name:'Ollama', ok:false, msg:'Not running — start with: ollama serve' }); }
  // qwen2.5-coder:3b model
  try {
    const d = await fetch('http://localhost:11434/api/tags');
    const j = await d.json();
    const has = (j.models||[]).some(m => m.name.includes('qwen2.5-coder'));
    checks.push({ name:'qwen2.5-coder:3b', ok:has, msg: has ? 'Model loaded' : 'Missing — run: ollama pull qwen2.5-coder:3b' });
  } catch { checks.push({ name:'qwen2.5-coder:3b', ok:false, msg:'Cannot check' }); }
  // GPU
  try {
    const gpu = execSync('nvidia-smi --query-gpu=temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits', { encoding:'utf8', timeout:3000 }).trim();
    const [temp, used, total] = gpu.split(',').map(s=>parseInt(s.trim()));
    const ok = temp < 85 && used < total * 0.98;
    checks.push({ name:'GPU', ok, msg:`${temp}°C, ${used}/${total}MB VRAM ${ok?'✅':'⚠ high'}` });
  } catch { checks.push({ name:'GPU', ok:false, msg:'nvidia-smi not found' }); }
  // n8n
  try { const r = await fetch('http://localhost:5678/healthz', { timeout: 2000 }); checks.push({ name:'n8n', ok:r.ok, msg:r.ok?'Running on :5678':'Not responding' }); }
  catch { checks.push({ name:'n8n', ok:false, msg:'Not running — start n8n separately' }); }
  // DB
  try { const db=DB(); db.prepare('SELECT 1').get(); db.close(); checks.push({ name:'Database', ok:true, msg:'project.db accessible' }); }
  catch(e) { checks.push({ name:'Database', ok:false, msg:e.message }); }
  // Disk space
  try {
    const disk = execSync("df -h ~/forge | awk 'NR==2{print $4\" free of \"$2}'", { encoding:'utf8' }).trim();
    checks.push({ name:'Disk', ok:true, msg:disk });
  } catch { checks.push({ name:'Disk', ok:false, msg:'Cannot check disk space' }); }
  // Mutex state
  checks.push({ name:'Mutex', ok:!taskRunning || (mutexAcquiredAt && Date.now()-mutexAcquiredAt < MUTEX_TIMEOUT_MS), msg: taskRunning ? `Locked (${Math.round((Date.now()-mutexAcquiredAt)/1000)}s)` : 'Free' });

  const allOk = checks.every(c => c.ok);
  res.json({ ok: allOk, checks });
});

// ── Project analysis — full quality review ────────────────────────────────
app.post('/project/:id/analyze', async (req, res) => {
  const projectId = req.params.id;
  const db = DB();
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  const tasks = db.prepare(`SELECT t.title, t.quality_score, t.assigned_agent, t.status, t.result
    FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?`).all(projectId);
  db.close();
  if (!project) return res.status(404).json({ error: 'not found' });

  const done = tasks.filter(t => t.status === 'done');
  const scores = done.map(t => t.quality_score || 0).filter(s => s > 0);
  const avgScore = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 0;
  const distribution = { excellent:0, good:0, acceptable:0, poor:0 };
  for (const s of scores) {
    if (s >= 9) distribution.excellent++;
    else if (s >= 7) distribution.good++;
    else if (s >= 5) distribution.acceptable++;
    else distribution.poor++;
  }

  const report = {
    projectId, projectName: project.name, stack: project.stack,
    generatedAt: new Date().toISOString(),
    summary: {
      totalTasks: tasks.length, doneTasks: done.length,
      pendingTasks: tasks.filter(t=>t.status==='pending').length,
      avgScore: Math.round(avgScore*10)/10,
      grade: avgScore>=9?'S':avgScore>=8?'A':avgScore>=7?'B':avgScore>=6?'C':'D',
      scoreDistribution: distribution
    },
    topTasks: done.slice().sort((a,b)=>(b.quality_score||0)-(a.quality_score||0)).slice(0,3)
      .map(t=>({ title:t.title, score:t.quality_score })),
    lowTasks: done.slice().sort((a,b)=>(a.quality_score||0)-(b.quality_score||0)).slice(0,3)
      .map(t=>({ title:t.title, score:t.quality_score })),
    recommendations: []
  };

  if (avgScore < 7) report.recommendations.push('Run retry-low-quality to improve weak tasks');
  if (distribution.poor > 2) report.recommendations.push('Several tasks scored below 5 — run full-review-cycle');
  if (done.length < tasks.length * 0.8) report.recommendations.push('Many tasks still pending — run the pipeline');
  if (!fs.existsSync(path.join(__dirname,'../projects',projectId,'src'))) {
    report.recommendations.push('Run scaffold-workspace to create proper directory structure');
  }

  // Save report
  const reportPath = path.join(__dirname, '../projects', projectId, 'ANALYSIS.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  res.json(report);
});

// ── Security audit ─────────────────────────────────────────────────────────
app.post('/project/:id/security-audit', async (req, res) => {
  const db = DB();
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) { db.close(); return res.status(404).json({ error:'Not found' }); }
    const pp = path.join(__dirname, '../projects', req.params.id);
    const files = tools.listFiles(pp, ['.js','.ts','.py']).files || [];
    const m = project.model || 'qwen2.5-coder:3b';
    const srcFiles = files.filter(f=>f.startsWith('src/'));
    const codeSnippets = srcFiles.map(f => {
      const r = tools.readFile(path.join(pp, f));
      return r.ok ? `=== ${f} ===\n${r.content}` : '';
    }).filter(Boolean).join('\n\n');
    const audit = await generate(
      `Security audit for project: ${project.name}\n\nFiles:\n${codeSnippets}\n\nProvide:\n1. SECURITY SCORE: N/10\n2. Critical vulnerabilities found\n3. High risk issues\n4. Recommendations`,
      { system: PROMPTS.security, numCtx: DEFAULT_CTX, model: m }
    );
    db.close();
    const scoreMatch = audit.text.match(/SECURITY SCORE:\s*(\d+)/i);
    res.json({ projectId: req.params.id, securityScore: scoreMatch ? parseInt(scoreMatch[1]) : null, audit: audit.text, filesAudited: srcFiles });
  } catch(e) { db.close(); res.status(500).json({ error: e.message }); }
});

// ── Project health monitor ─────────────────────────────────────────────────
app.get('/project/:id/health', (req, res) => {
  const db = DB();
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) { db.close(); return res.status(404).json({ error:'Not found' }); }
    const epics = db.prepare('SELECT id,title FROM epics WHERE project_id=?').all(req.params.id);
    const tasks = db.prepare("SELECT status,quality_score,attempts FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?").all(req.params.id);
    const done = tasks.filter(t=>t.status==='done');
    const pending = tasks.filter(t=>t.status==='pending');
    const failed = tasks.filter(t=>t.attempts>=5);
    const avgScore = done.length ? (done.reduce((s,t)=>s+(t.quality_score||0),0)/done.length).toFixed(1) : 0;
    const pp = path.join(__dirname, '../projects', req.params.id);
    const files = (tools.listFiles(pp,['.js','.ts','.py','.json','.md']).files||[]).length;
    db.close();
    res.json({
      projectId: req.params.id, name: project.name, model: project.model||'qwen2.5-coder:3b',
      epics: epics.length, totalTasks: tasks.length, done: done.length,
      pending: pending.length, failed: failed.length,
      avgScore: parseFloat(avgScore), files,
      healthy: failed.length === 0 && parseFloat(avgScore) >= 7,
      grade: parseFloat(avgScore) >= 9 ? 'A' : parseFloat(avgScore) >= 7 ? 'B' : parseFloat(avgScore) >= 5 ? 'C' : 'D'
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Project backup ─────────────────────────────────────────────────────────
app.post('/project/:id/backup', (req, res) => {
  try {
    const pp = path.join(__dirname, '../projects', req.params.id);
    const backupDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const backupPath = path.join(backupDir, `${req.params.id}_${ts}.tar.gz`);
    execSync(`tar czf ${backupPath} -C ${path.join(__dirname,'../projects')} ${req.params.id}`, { timeout: 30000 });
    const size = fs.statSync(backupPath).size;
    res.json({ backup: backupPath, size, created: ts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/project/:id/restore', async (req, res) => {
  const projectId = req.params.id;
  const backupDir = path.join(__dirname, '../backups');

  let backupFile = req.body.backupFile;
  if (!backupFile) {
    try {
      const files = fs.readdirSync(backupDir)
        .filter(f => f.includes(projectId) && f.endsWith('.tar.gz'))
        .sort().reverse();
      if (files.length === 0) return res.status(404).json({ error: 'No backup found for project' });
      backupFile = path.join(backupDir, files[0]);
    } catch(e) {
      return res.status(404).json({ error: 'Backups directory not found' });
    }
  }

  const projectDir = path.join(__dirname, '../projects', projectId);
  try {
    fs.mkdirSync(projectDir, { recursive: true });
    execSync(`tar -xzf "${backupFile}" -C "${path.join(__dirname, '../projects')}"`, { timeout: 30000 });
    res.json({ ok: true, projectId, restoredFrom: backupFile });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Workspace cleanup ──────────────────────────────────────────────────────
app.post('/projects/cleanup', (req, res) => {
  const db = DB();
  try {
    const projectsDir = path.join(__dirname, '../projects');
    if (!fs.existsSync(projectsDir)) { db.close(); return res.json({ cleaned: 0 }); }
    const dirs = fs.readdirSync(projectsDir);
    let cleaned = 0;
    for (const dir of dirs) {
      const dp = path.join(projectsDir, dir);
      const stat = fs.statSync(dp);
      if (!stat.isDirectory()) continue;
      const proj = db.prepare('SELECT id FROM projects WHERE id=?').get(dir);
      if (!proj) {
        execSync(`rm -rf ${dp}`, { timeout: 10000 });
        cleaned++;
      } else {
        const files = tools.listFiles(dp, ['.js','.ts','.py']).files || [];
        if (files.length === 0) {
          const tasks = db.prepare("SELECT COUNT(*) as c FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?").get(dir);
          if (tasks.c === 0) {
            db.prepare('DELETE FROM projects WHERE id=?').run(dir);
            execSync(`rm -rf ${dp}`, { timeout: 10000 });
            cleaned++;
          }
        }
      }
    }
    db.close();
    res.json({ cleaned, message: `Cleaned ${cleaned} empty/orphaned projects` });
  } catch(e) { db.close(); res.status(500).json({ error: e.message }); }
});

// ── Project delete ─────────────────────────────────────────────────────────
app.delete('/project/:id', (req, res) => {
  try {
    const db = DB();
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) { db.close(); return res.status(404).json({ error:'Not found' }); }
    // Delete DB entries
    const epics = db.prepare('SELECT id FROM epics WHERE project_id=?').all(req.params.id);
    for (const e of epics) db.prepare('DELETE FROM tasks WHERE epic_id=?').run(e.id);
    db.prepare('DELETE FROM epics WHERE project_id=?').run(req.params.id);
    db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
    db.close();
    // Delete project files
    const pp = path.join(__dirname, '../projects', req.params.id);
    try { execSync(`rm -rf ${pp}`); } catch {}
    res.json({ ok: true, deleted: project.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Mutex reset (emergency) ────────────────────────────────────────────────
app.post('/admin/restart', (req, res) => {
  res.json({ ok: true, msg: 'Restarting server...' });
  setTimeout(() => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true, stdio: 'ignore',
      cwd: process.cwd(),
      env: process.env
    });
    child.unref();
    process.exit(0);
  }, 300);
});

app.post('/mutex/reset', (req, res) => {
  releaseMutex();
  try {
    const db = DB();
    const r = db.prepare("UPDATE tasks SET status='pending' WHERE status='in_progress'").run();
    db.close();
    res.json({ ok: true, reset: r.changes, msg: 'Mutex released, stale tasks reset to pending' });
  } catch(e) { res.json({ ok: true, reset: 0, msg: 'Mutex released' }); }
});

// ── 5-pass full dev cycle for a project ──────────────────────────────────
app.post('/project/:id/full-cycle', async (req, res) => {
  res.json({ ok: true, msg: 'Full 5-pass dev cycle queued — runner will handle all phases', projectId: req.params.id });
  // Phase 1: run all pending tasks (normal pipeline)
  // Phase 2: redo any tasks with score < 7
  // Phase 3: expand (add missing files)
  // Phase 4: generate scripts (README, package.json, run.sh)
  // Phase 5: analyze and report
  try {
    const logPath = path.join(__dirname, '../logs/autorun.log');
    const runnerPath = path.join(__dirname, '../run-all.sh');
    exec(`nohup bash ${runnerPath} >> ${logPath} 2>&1 &`, { detached: true });
  } catch(e) { console.error('[full-cycle] Runner start error:', e.message); }
});

// ── Epic self-review: after each epic completes, review all its files ──────
app.post('/project/:id/epic-review', async (req, res) => {
  const db = DB();
  try {
    const { epicId } = req.body;
    if (!epicId) return res.status(400).json({ error: 'epicId required' });
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    const epic = db.prepare('SELECT * FROM epics WHERE id=? AND project_id=?').get(epicId, req.params.id);
    if (!project || !epic) { db.close(); return res.status(404).json({ error:'Not found' }); }
    const tasks = db.prepare("SELECT * FROM tasks WHERE epic_id=? AND status='done'").all(epicId);
    const pp = path.join(__dirname, '../projects', req.params.id);
    const fileContents = tasks.slice(0,4).map(t => {
      const result = (t.result||'').slice(0, 600);
      return `=== ${t.title} ===\n${result}`;
    }).join('\n\n');
    const m = project.model || 'qwen2.5-coder:3b';
    const review = await generate(
      `Project: ${project.name}\nEpic: ${epic.title}\n\nAll files in this epic:\n${fileContents}\n\nAs a senior engineer, identify:\n1. Integration issues between these files\n2. Inconsistent patterns or naming\n3. Missing error handling\n4. Any broken imports/dependencies\n5. List specific fix tasks needed (format: FIX: <description>)`,
      { system: PROMPTS.reviewer, numCtx: DEFAULT_CTX, model: m }
    );
    // Auto-generate fix tasks if any FIX: lines found
    const fixTasks = review.text.split('\n').filter(l => /^FIX:/i.test(l.trim())).map(l => l.replace(/^FIX:\s*/i,'').trim()).filter(l=>l.length>5&&l.length<100);
    let added = 0;
    for (const ft of fixTasks.slice(0,3)) {
      const tid = `${epicId}_fix_${Date.now()}_${added}`;
      db.prepare('INSERT INTO tasks (id,epic_id,title,description) VALUES (?,?,?,?)').run(tid, epicId, ft, `Self-review fix for epic "${epic.title}": ${ft}`);
      added++;
    }
    db.close();
    sseEmit('epic_review', { epicId, fixes: fixTasks.length, addedTasks: added });
    res.json({ epicId, review: review.text, fixTasks, addedTasks: added });
  } catch(e) { db.close(); res.status(500).json({ error: e.message }); }
});

// ── Auto-retry low quality tasks ───────────────────────────────────────────
app.post('/project/:id/retry-low-quality', (req, res) => {
  const { minScore = 7 } = req.body || {};
  const db = DB();
  try {
    const rows = db.prepare(
      `SELECT t.id FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=? AND t.status='done' AND (t.quality_score IS NULL OR t.quality_score<?)`
    ).all(req.params.id, minScore);
    let reset = 0;
    for (const r of rows) {
      db.prepare("UPDATE tasks SET status='pending',attempts=0,result=NULL,quality_score=NULL WHERE id=?").run(r.id);
      reset++;
    }
    db.close();
    sseEmit('retry_queued', { projectId: req.params.id, count: reset, minScore });
    res.json({ queued: reset, message: `Reset ${reset} low-quality tasks (score < ${minScore}) to pending` });
  } catch(e) { db.close(); res.status(500).json({ error: e.message }); }
});

// ── Context rolling summary (summarize all done tasks for next context) ────
const _projectContextCache = {};
app.get('/project/:id/context', async (req, res) => {
  const db = DB();
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) { db.close(); return res.status(404).json({ error:'Not found' }); }
    const doneTasks = db.prepare("SELECT t.title,t.quality_score,t.result FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=? AND t.status='done' ORDER BY t.completed_at LIMIT 12").all(req.params.id);
    db.close();
    if (!doneTasks.length) return res.json({ summary: '', tasks: 0 });
    // Build rolling summary
    const taskList = doneTasks.map(t => `- ${t.title} (score:${t.quality_score||'?'})`).join('\n');
    const lastCode = doneTasks[doneTasks.length-1].result || '';
    const summary = `Project: ${project.name}\nCompleted ${doneTasks.length} tasks:\n${taskList}\n\nMost recent code snippet:\n${lastCode}`;
    _projectContextCache[req.params.id] = { summary, updatedAt: Date.now() };
    res.json({ summary, tasks: doneTasks.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── n8n webhook integration ────────────────────────────────────────────────
const N8N_WEBHOOK = process.env.N8N_WEBHOOK || 'http://localhost:5678/webhook/forge';
async function notifyN8n(event, data) {
  try {
    const body = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
    // Use node http — no external deps
    const url = new URL(N8N_WEBHOOK);
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.request({ hostname: url.hostname, port: url.port||5678, path: url.pathname, method: 'POST', headers: {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, () => resolve());
      req.on('error', () => resolve()); // silently ignore if n8n down
      req.write(body);
      req.end();
    });
  } catch {}
}

// ── Project workspace export (README, package.json, run.sh, .gitignore) ───
app.post('/project/:id/scaffold-workspace', async (req, res) => {
  const db = DB();
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) { db.close(); return res.status(404).json({ error:'Not found' }); }
    const tasks = db.prepare("SELECT t.title FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=? AND t.status='done'").all(req.params.id);
    const pp = path.join(__dirname, '../projects', req.params.id);
    const files = [];
    // README.md
    const readmePath = path.join(pp, 'README.md');
    if (!fs.existsSync(readmePath)) {
      const md = `# ${project.name}\n\n${project.description}\n\n## Stack\n${project.stack}\n\n## Features\n${tasks.map(t=>`- ${t.title}`).join('\n')}\n\n## Getting Started\n\`\`\`bash\nnpm install\nnode src/index.js\n\`\`\`\n\n## Project Structure\n\`\`\`\nsrc/        # Source files\ntests/      # Test files\n\`\`\`\n`;
      fs.writeFileSync(readmePath, md);
      files.push('README.md');
    }
    // package.json
    const pkgPath = path.join(pp, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      const pkg = { name: project.name.toLowerCase().replace(/\s+/g,'-'), version: '1.0.0', description: project.description, main: 'src/index.js', scripts: { start: 'node src/index.js', test: 'node --test tests/' }, dependencies: {}, devDependencies: {} };
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      files.push('package.json');
    }
    // .gitignore
    const gitignorePath = path.join(pp, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n*.log\ndist/\n.DS_Store\n');
      files.push('.gitignore');
    }
    // run.sh
    const runPath = path.join(pp, 'run.sh');
    if (!fs.existsSync(runPath)) {
      fs.writeFileSync(runPath, '#!/bin/bash\nnpm install 2>/dev/null\nnode src/index.js "$@"\n');
      fs.chmodSync(runPath, '755');
      files.push('run.sh');
    }
    // Create standard subdirectories with .gitkeep
    const dirs = ['src', 'tests', 'docs', 'scripts'];
    for (const dir of dirs) {
      fs.mkdirSync(path.join(pp, dir), { recursive: true });
      const keepFile = path.join(pp, dir, '.gitkeep');
      if (!fs.existsSync(keepFile)) {
        fs.writeFileSync(keepFile, '');
        files.push(`${dir}/.gitkeep`);
      }
    }
    db.close();
    res.json({ created: files, projectPath: pp });
  } catch(e) { db.close(); res.status(500).json({ error: e.message }); }
});

// ── Workspace health check ─────────────────────────────────────────────────
app.get('/project/:id/workspace-health', (req, res) => {
  const projectDir = path.join(__dirname, '../projects', req.params.id);
  const checks = {
    exists: fs.existsSync(projectDir),
    hasSrc: fs.existsSync(path.join(projectDir, 'src')),
    hasTests: fs.existsSync(path.join(projectDir, 'tests')),
    hasPackageJson: fs.existsSync(path.join(projectDir, 'package.json')),
    hasReadme: fs.existsSync(path.join(projectDir, 'README.md')),
    hasGitignore: fs.existsSync(path.join(projectDir, '.gitignore')),
    hasGit: fs.existsSync(path.join(projectDir, '.git')),
  };
  const score = Object.values(checks).filter(Boolean).length;
  const maxScore = Object.keys(checks).length;
  res.json({ projectId: req.params.id, checks, score, maxScore, healthy: score >= 5 });
});

// ── Deployment preparation: generate Dockerfile, docker-compose, .env.example, DEPLOY.md ──
app.post('/project/:id/deploy-prep', async (req, res) => {
  const db = DB();
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  db.close();
  if (!project) return res.status(404).json({ error: 'not found' });

  const projectDir = path.join(__dirname, '../projects', req.params.id);

  // Read existing files for context
  let existingFiles = '';
  try {
    const srcFiles = fs.readdirSync(path.join(projectDir, 'src')).slice(0, 5);
    existingFiles = srcFiles.join(', ');
  } catch(e) {}

  try {
    const agent = new Agent('deploy', PROMPTS.deploy, { model: req.body.model || DEFAULT_MODEL });
    const result = await agent.run(
      `Project: ${project.name}\nStack: ${project.stack}\nDescription: ${project.description}\nExisting files: ${existingFiles}\n\nGenerate all deployment files.`,
      { useMultipass: false, rounds: 1 }
    );
    agent.close();

    // Parse and write files
    const written = [];
    const fileMatches = result.output.matchAll(/FILE:\s*(\S+)\n([\s\S]*?)(?=FILE:|$)/g);
    for (const [, filename, content] of fileMatches) {
      const filePath = path.join(projectDir, filename.trim());
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content.trim());
      written.push(filename.trim());
    }

    res.json({ ok: true, filesWritten: written, projectId: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Semantic code search (basic grep-based) ────────────────────────────────
app.get('/project/:id/search', async (req, res) => {
  const { q, semantic } = req.query;
  if (!q) return res.status(400).json({ error: 'q param required' });

  const projectDir = path.join(__dirname, '../projects', req.params.id);
  const results = [];

  // Always do text search
  try {
    const grepOut = execSync(`grep -r "${q.replace(/"/g,'')}" "${projectDir}" --include="*.js" -l 2>/dev/null || true`,
      { timeout: 5000 }).toString();
    const textFiles = grepOut.split('\n').filter(Boolean);
    for (const f of textFiles.slice(0, 10)) {
      results.push({ file: f.replace(projectDir + '/', ''), match: 'text', score: 1.0 });
    }
  } catch(e) {}

  // Semantic search via knowledge base
  if (semantic !== 'false') {
    try {
      const semResults = await knowledgeBase.searchKnowledge(q, 5);
      for (const r of semResults) {
        if (r.similarity > 0.15) {
          results.push({ knowledge: r.title, content: r.content.substring(0,200), match: 'semantic', score: r.similarity });
        }
      }
    } catch(e) {}
  }

  res.json({ query: q, projectId: req.params.id, results });
});

// ── Knowledge Base endpoints ───────────────────────────────────────────────
app.get('/knowledge', async (req, res) => {
  const stats = knowledgeBase.getStats();
  res.json(stats);
});
app.get('/knowledge/search', async (req, res) => {
  const { q, type } = req.query;
  if (!q) return res.status(400).json({ error: 'q param required' });
  const results = await knowledgeBase.searchKnowledge(q, 10, type || null);
  res.json({ query: q, results });
});
app.post('/knowledge/add', async (req, res) => {
  const { type, title, content, tags } = req.body;
  if (!type || !title || !content) return res.status(400).json({ error: 'type, title, content required' });
  const id = await knowledgeBase.addKnowledge(type, title, content, tags || []);
  res.json({ ok: true, id });
});

// ── File content view ──────────────────────────────────────────────────────
app.get('/project/:id/file', (req, res) => {
  const { f } = req.query;
  if (!f) return res.status(400).json({ error: 'f param required' });
  const pp = path.join(__dirname, '../projects', req.params.id);
  const fp = path.join(pp, f);
  // Security: ensure path stays within project dir
  if (!fp.startsWith(pp)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  try {
    const content = fs.readFileSync(fp, 'utf8');
    const ext = path.extname(f).slice(1) || 'text';
    res.json({ file: f, content, ext, lines: content.split('\n').length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── A/B prompt testing: record prompt variant performance ─────────────────
const promptABHistory = [];
app.post('/prompt-ab/record', (req, res) => {
  const { role, variant, score } = req.body;
  if (!role || !variant) return res.status(400).json({ error: 'role and variant required' });
  promptABHistory.push({ role, variant, score: score||0, ts: Date.now() });
  res.json({ recorded: true, total: promptABHistory.length });
});
app.get('/prompt-ab/results', (req, res) => {
  const grouped = {};
  for (const r of promptABHistory) {
    const k = `${r.role}:${r.variant}`;
    if (!grouped[k]) grouped[k] = { role: r.role, variant: r.variant, scores: [], count: 0 };
    grouped[k].scores.push(r.score);
    grouped[k].count++;
  }
  const results = Object.values(grouped).map(g => ({ ...g, avg: (g.scores.reduce((a,b)=>a+b,0)/g.scores.length).toFixed(2) }));
  res.json({ results, abResults: _abResults });
});

app.post('/prompt-ab/variant', (req, res) => {
  const { role, variant } = req.body;
  if (!role || !variant) return res.status(400).json({ error: 'role and variant required' });
  if (!_promptVariants[role]) _promptVariants[role] = [];
  _promptVariants[role].push({ variant, wins: 0, trials: 0 });
  res.json({ ok: true, role, variantsCount: _promptVariants[role].length });
});

// ── Prompt evolution history & manual trigger ──────────────────────────────
app.get('/prompts/history', (req, res) => {
  try {
    const pdb = new Database(path.join(__dirname, '../db/prompts.db'));
    const evos = pdb.prepare('SELECT * FROM prompt_evolutions ORDER BY created_at DESC LIMIT 20').all();
    pdb.close();
    res.json({ evolutions: evos });
  } catch(e) { res.json({ evolutions: [] }); }
});

app.post('/prompts/evolve', async (req, res) => {
  res.json({ ok: true, message: 'Evolution triggered' });
  evolvePrompts(); // non-blocking
});

// ── Prompt compression preview (vision-prompt-compression) ────────────────
app.post('/prompts/compress-preview', (req, res) => {
  const { role } = req.body;
  if (!role || !PROMPTS[role]) return res.status(400).json({ error: 'unknown role' });
  const original = PROMPTS[role];
  const compressed = compressPrompt(original);
  res.json({ role, originalChars: original.length, compressedChars: compressed.length,
    reduction: Math.round((1 - compressed.length/original.length)*100) + '%', compressed });
});

// ── Stack specializations list (vision-specialization) ────────────────────
app.get('/stacks', (req, res) => {
  res.json({
    available: Object.keys(STACK_SPECIALIZATIONS),
    descriptions: { node: 'Node.js/Express APIs', react: 'React frontend', cli: 'Command-line tools', python: 'Python scripts' }
  });
});

app.post('/agents/refresh-context', (req, res) => {
  const { projectId } = req.body || {};
  const summary = projectId ? sessionMem.getProjectSummary(projectId) : 'General context refresh';
  sseEmit('context_refresh', { projectId, summary, ts: Date.now() });
  res.json({ ok: true, projectId, summary });
});

// ── Dashboard metrics ──────────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  const db = DB();
  try {
    const tasksPerHour = db.prepare(`SELECT strftime('%Y-%m-%d %H',completed_at) as hour, COUNT(*) as count FROM tasks WHERE status='done' AND completed_at IS NOT NULL GROUP BY hour ORDER BY hour DESC LIMIT 24`).all();
    const scoreHist = db.prepare(`SELECT CAST(quality_score AS INT) as score, COUNT(*) as count FROM tasks WHERE status='done' AND quality_score IS NOT NULL GROUP BY score ORDER BY score`).all();
    const avgDuration = db.prepare(`SELECT AVG(duration_ms) as avg_ms FROM tasks WHERE status='done' AND duration_ms > 0`).get();
    const agentStats = db.prepare(`SELECT assigned_agent, COUNT(*) as count, AVG(quality_score) as avg_score FROM tasks WHERE status='done' GROUP BY assigned_agent`).all();
    const vram = await getVramUsage();
    db.close();
    res.json({ tasksPerHour, scoreHistogram: scoreHist, avgDurationMs: Math.round(avgDuration?.avg_ms||0), agentStats, vram, rateLimits: { tracked: _rateLimits.size } });
  } catch(e) { db.close(); res.status(500).json({ error: e.message }); }
});

// ── Cache stats ────────────────────────────────────────────────────────────
app.get('/cache/stats', (req, res) => {
  res.json({ researchCache: { size: _researchCache.size, maxTTLMinutes: 30 } });
});

// ── VRAM endpoint ──────────────────────────────────────────────────────────
app.get('/system/vram', async (req, res) => {
  const vram = await getVramUsage();
  res.json(vram);
});

// ── N8n incoming webhook ───────────────────────────────────────────────────
app.post('/webhook/n8n', express.json(), async (req, res) => {
  const { action, projectId, projectName, projectDesc, stack, message, agent } = req.body || {};
  try {
    if (action === 'create_project') {
      const r = await fetch(`http://localhost:${PORT}/project/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName, description: projectDesc, stack: stack || 'node' })
      });
      const data = await r.json();
      return res.json({ ok: true, action, result: data });
    }
    if (action === 'run_next') {
      const r = await fetch(`http://localhost:${PORT}/task/run-next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: req.body?.projectId })
      });
      const data = await r.json();
      return res.json({ ok: true, action, result: data });
    }
    if (action === 'get_status') {
      const r = await fetch(`http://localhost:${PORT}/stats`);
      const data = await r.json();
      return res.json({ ok: true, action, result: data });
    }
    if (action === 'chat') {
      const r = await fetch(`http://localhost:${PORT}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, agent: agent || 'orchestrator' })
      });
      const data = await r.json();
      return res.json({ ok: true, action, result: data });
    }
    if (action === 'improve') {
      const r = await fetch(`http://localhost:${PORT}/improve`, { method: 'POST' });
      const data = await r.json();
      return res.json({ ok: true, action, result: data });
    }
    res.json({ ok: false, error: `Unknown action: ${action}. Valid: create_project, run_next, get_status, chat, improve` });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Workspace symlink endpoints ────────────────────────────────────────────
app.post('/workspace/set/:projectId', (req, res) => {
  updateWorkspaceSymlink(req.params.projectId);
  const symlinkPath = path.join(__dirname, '../workspace');
  res.json({ ok: true, workspace: symlinkPath, projectId: req.params.projectId });
});

app.get('/workspace', (req, res) => {
  const symlinkPath = path.join(__dirname, '../workspace');
  try {
    const target = fs.readlinkSync(symlinkPath);
    const files = fs.readdirSync(target).slice(0, 20);
    res.json({ workspace: symlinkPath, target, files });
  } catch(e) {
    res.json({ workspace: symlinkPath, target: null, error: 'No active workspace set' });
  }
});

// ── Session memory API ─────────────────────────────────────────────────────
app.post('/memory/session/best-practice', (req, res) => {
  const { text, role } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  sessionMem.recordBestPractice(text, role || 'general');
  res.json({ ok: true });
});
app.delete('/memory/session', (req, res) => {
  sessionMem.resetMemory();
  res.json({ ok: true, message: 'Session memory reset' });
});

// ── Project templates ──────────────────────────────────────────────────────
app.get('/templates', (req, res) => {
  const templatesDir = path.join(__dirname, '../templates');
  try {
    if (!fs.existsSync(templatesDir)) return res.json({ templates: [] });
    const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.json'));
    const templates = files.map(f => {
      try { return { file: f, ...JSON.parse(fs.readFileSync(path.join(templatesDir, f), 'utf8')) }; } catch { return null; }
    }).filter(Boolean);
    res.json({ templates });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/project/create-from-template', async (req, res) => {
  const { templateFile, name, model } = req.body;
  if (!templateFile) return res.status(400).json({ error: 'templateFile required' });
  const templatePath = path.join(__dirname, '../templates', templateFile);
  if (!fs.existsSync(templatePath)) return res.status(404).json({ error: 'Template not found' });
  try {
    const tmpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    const projectName = name || tmpl.name;
    const r = await fetch(`http://localhost:${process.env.FORGE_PORT||3737}/project/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: projectName, description: tmpl.description, stack: tmpl.stack, model: model || 'qwen2.5-coder:3b' })
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Test runner + coverage tracking ───────────────────────────────────────
app.post('/project/:id/run-tests', (req, res) => {
  const projectId  = req.params.id;
  const projectDir = path.join(__dirname, '../projects', projectId);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

  const pkgJson = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgJson)) return res.status(400).json({ error: 'No package.json in project workspace' });

  let output = '';
  try {
    output = execSync(`cd ${JSON.stringify(projectDir)} && npm test --if-present 2>&1`, {
      encoding: 'utf8', timeout: 30000, shell: true
    });
  } catch (e) {
    output = e.stdout || e.message || '';
  }

  // Parse test result counts
  const lines = output.split('\n');
  let passed = 0, failed = 0;
  for (const line of lines) {
    const passingMatch = line.match(/(\d+)\s+passing/i);
    const failingMatch = line.match(/(\d+)\s+failing/i);
    const okMatch      = line.match(/^ok\s+\d+/i);
    const notOkMatch   = line.match(/^not ok\s+\d+/i);
    if (passingMatch) passed += parseInt(passingMatch[1], 10);
    if (failingMatch) failed += parseInt(failingMatch[1], 10);
    if (okMatch)      passed += 1;
    if (notOkMatch)   failed += 1;
  }

  const ranAt = new Date().toISOString();
  const runId = `${projectId}-${Date.now()}`;
  const last50 = lines.slice(-50).join('\n');

  // Persist to project.db
  try {
    const db = DB();
    db.exec(`CREATE TABLE IF NOT EXISTS test_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      ran_at TEXT,
      output TEXT,
      passed INTEGER,
      failed INTEGER
    )`);
    db.prepare('INSERT INTO test_runs (id, project_id, ran_at, output, passed, failed) VALUES (?,?,?,?,?,?)')
      .run(runId, projectId, ranAt, last50, passed, failed);
    db.close();
  } catch (e) {
    // Non-fatal: still return results even if DB write fails
  }

  res.json({ projectId, passed, failed, output: last50, ranAt });
});

// ── Enhanced test runner v2 ────────────────────────────────────────────────
app.post('/project/:id/run-tests-v2', async (req, res) => {
  const projectId = req.params.id;
  const projectDir = path.join(__dirname, '../projects', projectId);

  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'Project directory not found' });
  }

  const results = { projectId, ranAt: new Date().toISOString(), files: [], summary: {} };

  // Find test files
  let testFiles = [];
  try {
    const found = execSync(`find "${projectDir}" -name "*.test.js" -not -path "*/node_modules/*" 2>/dev/null`,
      { timeout: 5000 }).toString().split('\n').filter(Boolean);
    testFiles = found;
  } catch(e) {}

  results.testFiles = testFiles.map(f => f.replace(projectDir + '/', ''));

  if (testFiles.length === 0) {
    const db = DB();
    const tasks = db.prepare(`SELECT t.result FROM tasks t JOIN epics e ON t.epic_id=e.id
      WHERE e.project_id=? AND t.status='done' AND t.result LIKE 'FILE:%' LIMIT 1`).all(projectId);
    db.close();

    if (tasks.length > 0) {
      return res.json({ ...results, message: 'No test files found. Use POST /project/:id/tdd-task to generate tests first.' });
    }
    return res.json({ ...results, message: 'No test files and no code to test yet.' });
  }

  // Run each test file
  let totalPassed = 0, totalFailed = 0;
  for (const testFile of testFiles.slice(0, 5)) {
    try {
      const output = execSync(`node --test "${testFile}" 2>&1`, { timeout: 30000, cwd: projectDir }).toString();
      const passed = (output.match(/# pass\s+(\d+)/i)||['','0'])[1];
      const failed = (output.match(/# fail\s+(\d+)/i)||['','0'])[1];
      totalPassed += parseInt(passed); totalFailed += parseInt(failed);
      results.files.push({ file: testFile.replace(projectDir+'/',''), passed: parseInt(passed), failed: parseInt(failed), output: output.slice(-500) });
    } catch(e) {
      // execSync throws on non-zero exit — parse output from error
      const output = e.stdout ? e.stdout.toString() : e.message;
      const passed = (output.match(/# pass\s+(\d+)/i)||['','0'])[1];
      const failed = (output.match(/# fail\s+(\d+)/i)||['','0'])[1];
      totalPassed += parseInt(passed||0); totalFailed += parseInt(failed||1);
      results.files.push({ file: testFile.replace(projectDir+'/',''), passed: parseInt(passed||0), failed: parseInt(failed||1), output: output.slice(-500), error: true });

      // Auto-trigger debugger broadcast if tests fail
      if (parseInt(failed||1) > 0) {
        broadcast({ type: 'test_failure', projectId, file: testFile, output: output.slice(-300) });
      }
    }
  }

  results.summary = { totalPassed, totalFailed, testFiles: testFiles.length };

  // Store in DB
  try {
    const db = DB();
    db.prepare(`CREATE TABLE IF NOT EXISTS test_runs (id TEXT PRIMARY KEY, project_id TEXT, ran_at TEXT, output TEXT, passed INTEGER, failed INTEGER)`).run();
    db.prepare(`INSERT INTO test_runs VALUES (?,?,?,?,?,?)`).run(
      `run_${Date.now()}`, projectId, results.ranAt, JSON.stringify(results.files), totalPassed, totalFailed
    );
    db.close();
  } catch(e) {}

  res.json(results);
});

// ── Routing preview ────────────────────────────────────────────────────────
app.post('/routing/preview', (req, res) => {
  const { title, description, projectModel } = req.body;
  const model = getTaskModel(title||'', description||'', projectModel||DEFAULT_MODEL);
  const text = ((title||'') + ' ' + (description||'')).toLowerCase();
  const matched = Object.entries(MODEL_ROUTING).find(([,c]) => c.keywords.some(kw => text.includes(kw)));
  res.json({ model, taskType: matched ? matched[0] : 'default', title });
});

// ── Context level for a project ───────────────────────────────────────────
app.get('/project/:id/context-level', (req, res) => {
  const db = DB();
  try {
    const done = db.prepare(`SELECT COUNT(*) as n FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=? AND t.status='done'`).get(req.params.id);
    db.close();
    const n = done ? done.n : 0;
    res.json({
      projectId: req.params.id,
      tasksDone: n,
      contextLevel: n < 5 ? 'early' : n < 15 ? 'growing' : 'mature',
      filesInContext: n < 5 ? 1 : n < 15 ? 3 : 5,
      charsPerFile: n < 5 ? 400 : n < 15 ? 600 : 800
    });
  } catch(e) { db.close(); res.status(500).json({ error: e.message }); }
});
let _benchmarkResults = [];
app.post('/models/benchmark', async (req, res) => {
  const { testTask = 'Write a Node.js function that validates an email address with regex and exports it.' } = req.body || {};

  let models = [];
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await r.json();
    models = (data.models || []).map(m => m.name);
  } catch(e) {
    return res.status(500).json({ error: 'Cannot reach Ollama: ' + e.message });
  }

  res.json({
    ok: true,
    message: `Benchmark started for ${models.length} models. This runs in background — check /models/benchmark/results`,
    models,
    testTask
  });

  // Run benchmark async (don't block response)
  const results = [];
  for (const model of models.slice(0, 5)) {
    const start = Date.now();
    try {
      const r = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: testTask, stream: false, options: { num_predict: 300, num_ctx: 2048 } })
      });
      const data = await r.json();
      const elapsed = Date.now() - start;
      const { scoreCode } = require('./multipass');
      const scored = scoreCode(data.response || '');
      results.push({ model, elapsed, score: scored.score, tokens: data.eval_count || 0, tokensPerSec: Math.round((data.eval_count||0) / (elapsed/1000)) });
    } catch(e) {
      results.push({ model, elapsed: Date.now()-start, error: e.message });
    }
  }
  _benchmarkResults = results;
  sseEmit('benchmark_complete', { results });
});

app.get('/models/benchmark/results', (req, res) => res.json({ results: _benchmarkResults }));

// ── Pattern Library endpoints ──────────────────────────────────────────────
app.get('/patterns', (req, res) => {
  const data = patternLib.loadPatterns();
  res.json({ count: data.patterns.length, patterns: data.patterns.map(p => ({ id: p.id, description: p.description, tags: p.tags })) });
});

app.post('/patterns/search', (req, res) => {
  const { query, stack } = req.body;
  const results = patternLib.findRelevantPatterns(query || '', stack || 'node', 5);
  res.json({ results });
});

// ── TDD pipeline ───────────────────────────────────────────────────────────
app.post('/project/:id/tdd-task', async (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const db = DB();
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  const epics = db.prepare('SELECT id FROM epics WHERE project_id=? LIMIT 1').all(req.params.id);
  db.close();
  if (!project || epics.length === 0) return res.status(404).json({ error: 'project/epic not found' });

  const epicId = epics[0].id;
  const model = project.model || DEFAULT_MODEL;

  // Step 1: Generate tests first
  const tester = new Agent('tester', PROMPTS.tester, { model });
  const testsResult = await tester.run(
    `Write tests FIRST for this feature (TDD). Do not implement yet, just tests.
Feature: ${title}
Description: ${description || ''}
Project: ${project.name} (${project.stack})

Output FILE: tests/${title.toLowerCase().replace(/\s+/g,'-')}.test.js with failing tests.`,
    { useMultipass: true, minScore: 6, rounds: 2 }
  );
  tester.close();

  // Step 2: Generate implementation to pass tests
  const coder = new Agent('coder', PROMPTS.coder, { model });
  const implResult = await coder.run(
    `Implement code to pass these tests:
${testsResult.output.substring(0, 800)}

Feature: ${title}
Project: ${project.name} (${project.stack})
Output the implementation file with FILE: prefix.`,
    { useMultipass: true, minScore: 7, rounds: 3 }
  );
  coder.close();

  // Save both tasks to DB
  const db2 = DB();
  const testTaskId = `task_${Date.now()}_test`;
  const implTaskId = `task_${Date.now()+1}_impl`;

  db2.prepare(`INSERT INTO tasks (id, epic_id, title, description, status, result, quality_score, created_at, updated_at) VALUES (?,?,?,?,'done',?,?,?,?)`).run(
    testTaskId, epicId, `TESTS: ${title}`, 'TDD tests', testsResult.output, testsResult.score, new Date().toISOString(), new Date().toISOString()
  );
  db2.prepare(`INSERT INTO tasks (id, epic_id, title, description, status, result, quality_score, created_at, updated_at) VALUES (?,?,?,?,'done',?,?,?,?)`).run(
    implTaskId, epicId, `IMPL: ${title}`, description || title, implResult.output, implResult.score, new Date().toISOString(), new Date().toISOString()
  );
  db2.close();

  res.json({ ok: true, testScore: testsResult.score, implScore: implResult.score, testTaskId, implTaskId });
});

// ── UX Review Agent ────────────────────────────────────────────────────────
app.post('/project/:id/ux-review', async (req, res) => {
  try {
    const db = DB();
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    const tasks = db.prepare(`SELECT t.result FROM tasks t JOIN epics e ON t.epic_id=e.id 
      WHERE e.project_id=? AND t.status='done' AND t.result IS NOT NULL LIMIT 5`).all(req.params.id);
    db.close();
    if (!project) return res.status(404).json({ error: 'not found' });

    const codeContext = tasks.map(t => (t.result||'').substring(0,400)).join('\n---\n');
    const agent = new Agent('ux', PROMPTS.ux, { model: req.body.model || DEFAULT_MODEL });
    const result = await agent.run(
      `Project: ${project.name} (${project.stack})\nDescription: ${project.description}\n\nCode samples:\n${codeContext}`,
      { useMultipass: false, rounds: 1 }
    );
    res.json({ ok: true, review: result.output, projectId: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Integration Test Agent ──────────────────────────────────────────────────
app.post('/project/:id/integration-tests', async (req, res) => {
  try {
    const db = DB();
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    const tasks = db.prepare(`SELECT t.title, t.result FROM tasks t JOIN epics e ON t.epic_id=e.id 
      WHERE e.project_id=? AND t.status='done' LIMIT 8`).all(req.params.id);
    db.close();
    if (!project) return res.status(404).json({ error: 'not found' });

    const taskSummary = tasks.map(t => t.title).join(', ');
    const agent = new Agent('integration', PROMPTS.integration, { model: req.body.model || DEFAULT_MODEL });
    const result = await agent.run(
      `Project: ${project.name}\nStack: ${project.stack}\nComponents built: ${taskSummary}\nDescription: ${project.description}\n\nWrite comprehensive integration tests.`,
      { useMultipass: true, minScore: 7, rounds: 3 }
    );

    // Write the integration test file
    if (result.output.includes('FILE:')) {
      const projectDir = path.join(__dirname, '../projects', req.params.id);
      const fileMatch = result.output.match(/FILE:\s*(\S+)\n([\s\S]*)/);
      if (fileMatch) {
        const testPath = path.join(projectDir, fileMatch[1].trim());
        fs.mkdirSync(path.dirname(testPath), { recursive: true });
        fs.writeFileSync(testPath, fileMatch[2].trim());
      }
    }

    res.json({ ok: true, output: result.output, score: result.score });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Daily Team Standup ─────────────────────────────────────────────────────
app.get('/standup', async (req, res) => {
  try {
    const db = DB();
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const completed = db.prepare(`SELECT t.title, t.quality_score, t.assigned_agent 
      FROM tasks t JOIN epics e ON t.epic_id=e.id 
      WHERE t.status='done' AND t.completed_at > ? ORDER BY t.completed_at DESC LIMIT 20`).all(yesterday);
    const inProgress = db.prepare(`SELECT t.title FROM tasks t WHERE t.status='in_progress' LIMIT 5`).all();
    const lowScore = db.prepare(`SELECT t.title, t.quality_score FROM tasks t 
      WHERE t.quality_score < 6 AND t.status='done' ORDER BY t.completed_at DESC LIMIT 5`).all();
    const pending = db.prepare(`SELECT t.title FROM tasks t WHERE t.status='pending' LIMIT 5`).all();
    const avgScore = db.prepare(`SELECT AVG(quality_score) as avg FROM tasks WHERE status='done' AND quality_score IS NOT NULL`).get();
    db.close();

    const agent = new Agent('standup', PROMPTS.standup, { model: DEFAULT_MODEL });
    const summary = await agent.run(
      `Date: ${new Date().toDateString()}
Completed: ${completed.map(t=>`${t.title} (${t.quality_score}/10)`).join(', ')||'none'}
In progress: ${inProgress.map(t=>t.title).join(', ')||'none'}
Low quality: ${lowScore.map(t=>`${t.title} (${t.quality_score}/10)`).join(', ')||'none'}
Pending next: ${pending.map(t=>t.title).join(', ')||'none'}
Avg score: ${(avgScore.avg||0).toFixed(1)}/10`,
      { useMultipass: false, rounds: 1 }
    );

    // Save to logs
    const logFile = path.join(__dirname, '../logs', `standup-${new Date().toISOString().slice(0,10)}.md`);
    fs.writeFileSync(logFile, summary.output);

    res.json({ standup: summary.output, savedTo: logFile, stats: { completed: completed.length, avgScore: avgScore.avg } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Full Project Review Cycle ──────────────────────────────────────────────
app.post('/project/:id/full-review-cycle', async (req, res) => {
  try {
    const projectId = req.params.id;
    const db = DB();
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    const allTasks = db.prepare(`SELECT t.title, t.result, t.quality_score FROM tasks t 
      JOIN epics e ON t.epic_id=e.id WHERE e.project_id=? AND t.status='done'`).all(projectId);
    db.close();
    if (!project) return res.status(404).json({ error: 'not found' });

    res.json({ ok: true, message: 'Full review cycle started', taskCount: allTasks.length });

    // Run async: read all files, find issues, create fix tasks
    (async () => {
      const maxCycles = req.body.cycles || 2;
      for (let cycle = 0; cycle < maxCycles; cycle++) {
        const projectDir = path.join(__dirname, '../projects', projectId);
        let allCode = '';
        try {
          const srcDir = path.join(projectDir, 'src');
          if (fs.existsSync(srcDir)) {
            const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
            for (const f of files.slice(0, 5)) {
              allCode += `\n--- ${f} ---\n` + fs.readFileSync(path.join(srcDir, f), 'utf8').substring(0, 500);
            }
          }
        } catch(e) {}

        if (!allCode) allCode = allTasks.map(t => (t.result||'').substring(0,300)).join('\n---\n');

        const orchestrator = new Agent('orchestrator', PROMPTS.orchestrator, { model: DEFAULT_MODEL });
        const review = await orchestrator.run(
          `Review this entire project for issues. Find the top 3 specific bugs or quality problems.
Project: ${project.name} (${project.stack})
Code: ${allCode.substring(0, 2000)}

For each issue output: FIX: <short task title> | <what to fix in one sentence>`,
          { useMultipass: false, rounds: 1 }
        );

        // Parse FIX: tasks and create them
        const fixMatches = [...review.output.matchAll(/FIX:\s*([^|]+)\|([^\n]+)/g)];
        let created = 0;
        if (fixMatches.length > 0) {
          const db2 = DB();
          const epics = db2.prepare(`SELECT id FROM epics WHERE project_id=? LIMIT 1`).all(projectId);
          if (epics.length > 0) {
            const epicId = epics[0].id;
            for (const [, title, desc] of fixMatches.slice(0, 3)) {
              const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
              db2.prepare(`INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at) 
                VALUES (?,?,?,?,'pending',?,?)`).run(taskId, epicId, `FIX: ${title.trim()}`, desc.trim(), new Date().toISOString(), new Date().toISOString());
              created++;
            }
          }
          db2.close();
        }
        broadcast({ type: 'review_cycle_done', projectId, cycle: cycle+1, issuesFound: fixMatches.length, tasksCreated: created });
        if (fixMatches.length === 0) break; // No more issues found
      }
    })();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Continuous Fix-and-Improve Loop ───────────────────────────────────────
app.post('/project/:id/improve-loop', async (req, res) => {
  const projectId = req.params.id;
  const maxRounds = Math.min(req.body.maxRounds || 3, 5);

  res.json({ ok: true, message: `Continuous improvement loop started (${maxRounds} rounds)`, projectId });

  (async () => {
    for (let round = 1; round <= maxRounds; round++) {
      broadcast({ type: 'improve_loop', projectId, round, maxRounds, status: 'starting' });

      // Phase 1: retry low quality
      try {
        const r = await fetch(`http://localhost:${PORT}/project/${projectId}/retry-low-quality`, { method: 'POST' });
        const d = await r.json();
        if (d.queued > 0) {
          // Run the retried tasks
          for (let i = 0; i < d.queued && i < 5; i++) {
            await fetch(`http://localhost:${PORT}/task/run-next`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectId })
            });
            await new Promise(r => setTimeout(r, 500));
          }
        }
      } catch(e) {}

      // Phase 2: full review cycle to find issues
      try {
        await fetch(`http://localhost:${PORT}/project/${projectId}/full-review-cycle`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ cycles: 1 }) });
        await new Promise(r => setTimeout(r, 3000)); // Wait for review
      } catch(e) {}

      // Phase 3: check if there are new tasks to run
      const db = DB();
      const pending = db.prepare(`SELECT COUNT(*) as n FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=? AND t.status='pending'`).get(projectId);
      db.close();

      broadcast({ type: 'improve_loop', projectId, round, pendingTasks: pending?.n || 0, status: 'done' });

      if (!pending?.n) break; // No more tasks, done
      await new Promise(r => setTimeout(r, 1000));
    }
    broadcast({ type: 'improve_loop_complete', projectId, maxRounds });
  })().catch(() => {});
});

// ── API Docs ───────────────────────────────────────────────────────────────
app.get('/docs', (req, res) => {
  const endpoints = [
    // Projects
    { method:'POST', path:'/project/create', desc:'Create new project with AI-generated epic/task breakdown', body:'{ name, description, stack, model }' },
    { method:'GET', path:'/projects', desc:'List all projects with stats', returns:'[{ id, name, status, taskCount, doneCount, avgScore }]' },
    { method:'GET', path:'/project/:id', desc:'Get single project details' },
    { method:'DELETE', path:'/project/:id', desc:'Delete project and all tasks' },
    // Tasks
    { method:'POST', path:'/task/run-next', desc:'Run next pending task through 9-agent pipeline (mutex-protected)', returns:'{ taskId, score, duration }' },
    { method:'GET', path:'/task/:id', desc:'Get task details including pipeline log' },
    // Pipeline
    { method:'POST', path:'/project/:id/expand', desc:'Ask orchestrator to generate more tasks for the project' },
    { method:'POST', path:'/project/:id/analyze', desc:'Analyze project quality, generate comprehensive report with grade and recommendations' },
    { method:'POST', path:'/project/:id/retry-low-quality', desc:'Reset tasks below score threshold for re-run', body:'{ minScore (default:6) }' },
    { method:'POST', path:'/project/:id/scaffold-workspace', desc:'Create src/, tests/, docs/, scripts/, README.md, package.json, .gitignore, run.sh' },
    { method:'GET', path:'/project/:id/workspace-health', desc:'Check workspace directory structure health score' },
    { method:'POST', path:'/project/:id/improve-loop', desc:'Continuous fix-and-improve loop (retry low quality + review cycle)', body:'{ maxRounds (default:3, max:5) }' },
    { method:'POST', path:'/project/:id/backup', desc:'Create tar.gz backup of project workspace' },
    { method:'POST', path:'/project/:id/restore', desc:'Restore project from latest backup' },
    { method:'POST', path:'/project/:id/deploy-prep', desc:'Generate Dockerfile, docker-compose.yml, .env.example, DEPLOY.md' },
    { method:'POST', path:'/project/:id/security-audit', desc:'Run security agent over project code' },
    { method:'POST', path:'/project/:id/ux-review', desc:'UX/API design review by specialist agent' },
    { method:'POST', path:'/project/:id/integration-tests', desc:'Generate integration tests for the project' },
    { method:'POST', path:'/project/:id/full-review-cycle', desc:'Full orchestrator review: find issues, create fix tasks (up to N cycles)', body:'{ cycles (default:2) }' },
    { method:'POST', path:'/project/:id/run-tests', desc:'Run npm test in project workspace, parse results' },
    { method:'POST', path:'/project/:id/tdd-task', desc:'TDD mode: write tests first, then implementation', body:'{ title, description }' },
    { method:'GET', path:'/project/:id/context', desc:'Get rolling context summary for project' },
    { method:'GET', path:'/project/:id/health', desc:'Project health score and grade' },
    { method:'GET', path:'/project/:id/git-log', desc:'Git commit history for project' },
    { method:'GET', path:'/project/:id/search', desc:'Search project files by text query', query:'?q=searchterm' },
    { method:'GET', path:'/project/:id/file', desc:'View file contents', query:'?f=relative/path' },
    // Quality
    { method:'GET', path:'/quality/ratchet', desc:'Session best scores per project' },
    { method:'GET', path:'/prompts/history', desc:'Prompt evolution history' },
    { method:'POST', path:'/prompts/evolve', desc:'Trigger manual prompt evolution based on recent task issues' },
    { method:'GET', path:'/prompt-ab/results', desc:'A/B prompt testing results' },
    { method:'POST', path:'/prompt-ab/variant', desc:'Register new prompt variant for A/B testing', body:'{ role, variant }' },
    // Memory
    { method:'GET', path:'/memory/session', desc:'Get all cross-session memory' },
    { method:'POST', path:'/memory/session', desc:'Store memory item', body:'{ type, content }' },
    { method:'DELETE', path:'/memory/session', desc:'Reset all session memory' },
    { method:'POST', path:'/memory/compress', desc:'Compress agent histories to save space' },
    // Agents
    { method:'POST', path:'/chat', desc:'Chat directly with an agent', body:'{ message, agent (default:orchestrator) }' },
    { method:'GET', path:'/standup', desc:'Generate daily standup summary across all projects' },
    { method:'POST', path:'/agents/refresh-context', desc:'Trigger context refresh broadcast', body:'{ projectId }' },
    // System
    { method:'GET', path:'/health', desc:'Server health check' },
    { method:'GET', path:'/stats', desc:'Global statistics: projects, tasks, scores' },
    { method:'GET', path:'/metrics', desc:'Detailed metrics: quality distribution, tasks/hour, VRAM, rate limits' },
    { method:'GET', path:'/system/vram', desc:'GPU VRAM usage (requires nvidia-smi)' },
    { method:'GET', path:'/system/doctor', desc:'System health check: Ollama, models, DB, memory' },
    { method:'GET', path:'/cache/stats', desc:'Research cache statistics' },
    { method:'POST', path:'/mutex/reset', desc:'Emergency: reset stuck pipeline mutex' },
    // N8n
    { method:'POST', path:'/webhook/n8n', desc:'N8n incoming webhook', body:'{ action: create_project|run_next|get_status|chat|improve, ...params }' },
    // Patterns
    { method:'GET', path:'/patterns', desc:'List code pattern library' },
    { method:'POST', path:'/patterns/search', desc:'Search patterns by query', body:'{ query, stack }' },
    // Models
    { method:'GET', path:'/models', desc:'List available Ollama models' },
    { method:'POST', path:'/models/benchmark', desc:'Benchmark all models on test task (async, check /models/benchmark/results)' },
    { method:'GET', path:'/models/benchmark/results', desc:'Latest benchmark results' },
    // Templates
    { method:'GET', path:'/templates', desc:'List project templates' },
    { method:'POST', path:'/project/create-from-template', desc:'Create project from template', body:'{ templateId, name, description }' },
    // Workspace
    { method:'GET', path:'/workspace', desc:'Get active workspace symlink target and files' },
    { method:'POST', path:'/workspace/set/:projectId', desc:'Set active workspace to project' },
    // Events
    { method:'GET', path:'/events', desc:'SSE stream for live pipeline events' },
    // Docs & Wiki
    { method:'GET', path:'/docs', desc:'This page — auto-generated API documentation', query:'?format=json' },
    { method:'GET', path:'/project/:id/wiki', desc:'Generate or retrieve project WIKI.md', query:'?refresh=1' },
    // Schedule (called by n8n)
    { method:'POST', path:'/schedule/improve', desc:'Trigger self-improvement (called by n8n daily at 3am)' },
    { method:'POST', path:'/schedule/compress-memory', desc:'Trigger memory compression (called by n8n every 6h)' },
    { method:'POST', path:'/intake', desc:'N8n project intake form handler', body:'{ projectName, projectDescription, stack, priority }' },
  ];

  if (req.query.format === 'json') {
    return res.json({ version: '3.0', endpoints });
  }

  // HTML docs
  const html = `<!DOCTYPE html><html><head><title>Forge API Docs</title>
  <style>
    body { font-family: monospace; background: #0a0a14; color: #e8e8f0; padding: 20px; }
    h1 { color: #7c6af5; } h2 { color: #9090a8; border-bottom: 1px solid #1e1e35; padding-bottom: 8px; }
    .ep { display:flex; gap:12px; padding:8px; border-bottom:1px solid #111; align-items:flex-start; }
    .ep:hover { background:#0d0d1a; }
    .method { font-weight:bold; min-width:50px; }
    .GET { color:#4caf50; } .POST { color:#7c6af5; } .DELETE { color:#f44336; }
    .path { color:#61afef; min-width:280px; }
    .desc { color:#9090a8; font-size:12px; }
    .body { color:#ff9800; font-size:11px; margin-top:2px; }
    input { background:#0d0d1a; border:1px solid #2a2a45; color:#e8e8f0; padding:8px; width:300px; border-radius:4px; margin-bottom:16px; }
  </style>
  </head><body>
  <h1>⚡ Forge API v3.0</h1>
  <p style="color:#9090a8">Local AI dev team. Running on <span style="color:#4caf50">http://localhost:3737</span></p>
  <input type="text" placeholder="Filter endpoints..." onkeyup="filter(this.value)" id="filter">
  ${Object.entries(endpoints.reduce((g,e) => { const cat = e.path.split('/')[1]; g[cat]=(g[cat]||[]); g[cat].push(e); return g; }, {}))
    .map(([cat, eps]) => `<h2>/${cat}</h2>${eps.map(e =>
      `<div class="ep" data-search="${e.method} ${e.path} ${e.desc}">
        <span class="method ${e.method}">${e.method}</span>
        <div><div class="path">${e.path}${e.query||''}</div>
        <div class="desc">${e.desc}</div>
        ${e.body ? `<div class="body">Body: ${e.body}</div>` : ''}
        </div></div>`).join('')}`).join('')}
  <script>
  function filter(q) {
    document.querySelectorAll('.ep').forEach(el => {
      el.style.display = el.dataset.search.toLowerCase().includes(q.toLowerCase()) ? 'flex' : 'none';
    });
  }
  </script></body></html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ── Project Wiki ───────────────────────────────────────────────────────────
app.get('/project/:id/wiki', async (req, res) => {
  const projectId = req.params.id;
  const wikiPath = path.join(__dirname, '../projects', projectId, 'WIKI.md');

  if (fs.existsSync(wikiPath) && !req.query.refresh) {
    return res.json({ wiki: fs.readFileSync(wikiPath, 'utf8'), projectId, cached: true });
  }

  const db = DB();
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  const tasks = db.prepare(`SELECT t.title, t.quality_score, t.assigned_agent, t.pipeline_log
    FROM tasks t JOIN epics e ON t.epic_id=e.id
    WHERE e.project_id=? AND t.status='done' ORDER BY t.completed_at LIMIT 20`).all(projectId);
  const epics = db.prepare('SELECT title FROM epics WHERE project_id=?').all(projectId);
  db.close();
  if (!project) return res.status(404).json({ error: 'not found' });

  try {
    const agent = new Agent('docs', PROMPTS.docs, { model: DEFAULT_MODEL });
    const wiki = await agent.run(
      `Generate a WIKI.md for this project. Include:
# ${project.name}
## Overview
## Architecture Decisions
## Key Components
## API Endpoints (if applicable)
## Known Issues
## Quality Notes

Project: ${project.name}
Stack: ${project.stack}
Description: ${project.description}
Epics: ${epics.map(e=>e.title).join(', ')}
Tasks completed: ${tasks.length}
Avg quality: ${tasks.length ? (tasks.reduce((s,t)=>s+(t.quality_score||0),0)/tasks.length).toFixed(1) : 'N/A'}/10
Recent tasks: ${tasks.slice(-5).map(t=>t.title).join(', ')}`,
      { useMultipass: false, rounds: 1 }
    );

    const projectDir = path.join(__dirname, '../projects', projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(wikiPath, wiki.output);

    res.json({ wiki: wiki.output, projectId, cached: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Schedule Endpoints (called by n8n) ────────────────────────────────────
app.post('/schedule/improve', async (req, res) => {
  const secret = req.headers['x-forge-secret'] || req.body?.secret;
  if (secret && secret !== (process.env.FORGE_SECRET || 'forge-local')) {
    return res.status(403).json({ error: 'Invalid secret' });
  }
  res.json({ ok: true, message: 'Self-improvement triggered' });
  setTimeout(async () => {
    try {
      await fetch(`http://localhost:${PORT}/improve`, { method: 'POST' });
      broadcast({ type: 'scheduled_improve', ts: Date.now() });
    } catch(e) {}
  }, 100);
});

app.post('/schedule/compress-memory', async (req, res) => {
  res.json({ ok: true, message: 'Memory compression triggered' });
  setTimeout(async () => {
    try {
      await fetch(`http://localhost:${PORT}/memory/compress`, { method: 'POST' });
      broadcast({ type: 'memory_compressed', ts: Date.now() });
    } catch(e) {}
  }, 100);
});

app.post('/intake', async (req, res) => {
  const { projectName, projectDescription, stack, priority } = req.body;
  if (!projectName || !projectDescription) {
    return res.status(400).json({ error: 'projectName and projectDescription required' });
  }
  try {
    const r = await fetch(`http://localhost:${PORT}/project/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: projectName, description: projectDescription, stack: stack || 'node' })
    });
    const data = await r.json();
    res.json({ ok: true, message: `Project "${projectName}" created!`, projectId: data.projectId, dashboardUrl: `http://localhost:3737` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Git log for project ────────────────────────────────────────────────────
app.get('/project/:id/git-log', (req, res) => {
  const projectDir = path.join(__dirname, '../projects', req.params.id);
  try {
    const log = execSync('git log --oneline -20', { cwd: projectDir, timeout: 5000 }).toString();
    res.json({ ok: true, log: log.split('\n').filter(Boolean) });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Forge Models Status ────────────────────────────────────────────────────
app.get('/models/forge-models', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const d = await r.json();
    const allModels = (d.models || []).map(m => m.name);
    const forgeModels = ['forge-coder', 'forge-reviewer', 'forge-architect', 'forge-tester', 'forge-debugger'];
    const installed = forgeModels.filter(m => allModels.some(am => am.includes(m)));
    const missing = forgeModels.filter(m => !allModels.some(am => am.includes(m)));
    res.json({ installed, missing, installScript: '~/forge/models/install-modelfiles.sh', allModels });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Capabilities Tracker ───────────────────────────────────────────────────
app.get('/capabilities', async (req, res) => {
  const db = DB();
  try {
    const stats = db.prepare(`SELECT 
      COUNT(DISTINCT e.project_id) as projects,
      COUNT(t.id) as totalTasks,
      COUNT(CASE WHEN t.status='done' THEN 1 END) as doneTasks,
      AVG(CASE WHEN t.status='done' THEN t.quality_score END) as avgScore,
      MAX(t.quality_score) as bestScore,
      COUNT(CASE WHEN t.quality_score >= 8 THEN 1 END) as highQualityTasks
    FROM tasks t JOIN epics e ON t.epic_id = e.id`).get();

    const topTasks = db.prepare(`SELECT t.title, t.quality_score, t.assigned_agent
      FROM tasks t WHERE t.status='done' AND t.quality_score IS NOT NULL
      ORDER BY t.quality_score DESC LIMIT 5`).all();

    const stackDist = db.prepare(`SELECT p.stack, COUNT(t.id) as tasks, AVG(t.quality_score) as avgScore
      FROM tasks t JOIN epics e ON t.epic_id=e.id JOIN projects p ON e.project_id=p.id
      WHERE t.status='done' GROUP BY p.stack`).all();

    const agentPerf = db.prepare(`SELECT assigned_agent, COUNT(*) as tasks, AVG(quality_score) as avgScore
      FROM tasks WHERE status='done' AND assigned_agent IS NOT NULL
      GROUP BY assigned_agent ORDER BY avgScore DESC`).all();

    db.close();

    const avg = stats.avgScore || 0;
    const grade = avg >= 9 ? 'S' : avg >= 8 ? 'A' : avg >= 7 ? 'B' : avg >= 6 ? 'C' : 'D';

    const capabilities = {
      grade,
      avgQuality: Math.round((avg||0)*10)/10,
      bestScore: stats.bestScore || 0,
      totalProjects: stats.projects || 0,
      totalTasksDone: stats.doneTasks || 0,
      highQualityRate: stats.doneTasks > 0 ? Math.round(stats.highQualityTasks/stats.doneTasks*100) : 0,
      topAchievements: topTasks.map(t => ({ title: t.title, score: t.quality_score })),
      byStack: stackDist,
      agentPerformance: agentPerf,
      systemStats: {
        agents: 15,
        pipelineStages: 9,
        endpoints: 59,
        patternLibrary: 8,
        constitutionRules: 7,
        features: ['chain-of-thought', 'quality-ratchet', 'A/B-testing', 'prompt-evolution',
                   'session-memory', 'knowledge-base', 'semantic-search', 'auto-git', 'ESLint',
                   'parallel-agents', 'cross-review', 'TDD-mode', 'pattern-library']
      },
      generatedAt: new Date().toISOString()
    };

    res.json(capabilities);
  } catch(e) { db.close(); res.status(500).json({ error: e.message }); }
});

app.post('/capabilities/snapshot', async (req, res) => {
  const r = await fetch(`http://localhost:${PORT}/capabilities`);
  const caps = await r.json();
  const logDir = path.join(__dirname, '../logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `capabilities-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(logFile, JSON.stringify(caps, null, 2));
  res.json({ ok: true, savedTo: logFile, grade: caps.grade, avgQuality: caps.avgQuality });
});

// ── Multi-Project Orchestration ────────────────────────────────────────────
app.post('/orchestrate', async (req, res) => {
  if (taskRunning) return res.status(409).json({ error: 'Task already running' });

  const db = DB();
  const projects = db.prepare('SELECT id FROM projects ORDER BY created_at ASC').all();
  db.close();

  for (const { id } of projects) {
    const db2 = DB();
    const pending = db2.prepare(`
      SELECT COUNT(*) as n FROM tasks t JOIN epics e ON t.epic_id=e.id
      WHERE e.project_id=? AND t.status='pending'
    `).get(id);
    db2.close();
    if (pending?.n > 0) {
      const r = await fetch(`http://localhost:${PORT}/task/run-next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: id })
      });
      const result = await r.json();
      return res.json({ ...result, orchestratedFor: id });
    }
  }
  res.json({ message: 'All projects complete — no pending tasks' });
});

// ── Atomic Task Decomposition ──────────────────────────────────────────────
app.post('/project/:id/decompose-epic/:epicId', async (req, res) => {
  const { id: projectId, epicId } = req.params;
  const db = DB();
  const epic = db.prepare('SELECT * FROM epics WHERE id=? AND project_id=?').get(epicId, projectId);
  const existingTasks = db.prepare('SELECT title FROM tasks WHERE epic_id=?').all(epicId);
  db.close();

  if (!epic) return res.status(404).json({ error: 'Epic not found' });

  res.json({ ok: true, message: 'Decomposing epic into atomic tasks...' });

  (async () => {
    const agent = new Agent('architect', PROMPTS.architect);
    const prompt = `Break down this epic into 3-5 atomic, independently-implementable tasks.
Epic: "${epic.title}"
Description: "${epic.description || ''}"
Existing tasks: ${existingTasks.map(t => t.title).join(', ') || 'none'}

Return ONLY a JSON array of task objects:
[{"title": "...", "description": "...", "estimated_complexity": "low|medium|high"}]
Each task must be completable in <100 lines of code. No vague tasks.`;

    const result = await agent.run(prompt, { useMultipass: false, rounds: 1 });

    try {
      const match = result.match(/\[[\s\S]*\]/);
      if (!match) return;
      const tasks = JSON.parse(match[0]);

      const db2 = DB();
      const insert = db2.prepare(`INSERT INTO tasks (id, epic_id, title, description, status, assigned_agent)
        VALUES (?, ?, ?, ?, 'pending', 'coder')`);
      for (const task of tasks.slice(0, 5)) {
        insert.run(`task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`, epicId,
          task.title, task.description || '');
      }
      db2.close();
      broadcast({ type: 'tasks_added', epicId, count: tasks.length });
    } catch (e) {
      console.error('Decompose error:', e.message);
    }
  })().catch(console.error);
});

// ── Project Preview / Run ─────────────────────────────────────────────────
app.post('/project/:id/launch-preview', async (req, res) => {
  const projectId = req.params.id;
  const projectDir = path.join(__dirname, '../projects', projectId);

  if (!fs.existsSync(projectDir)) {
    return res.status(404).json({ error: 'Project directory not found. Run scaffold-workspace first.' });
  }

  const candidates = ['src/index.js', 'index.js', 'src/app.js', 'app.js', 'src/main.js', 'main.js'];
  const entryPoint = candidates.find(c => fs.existsSync(path.join(projectDir, c)));

  if (!entryPoint) {
    return res.json({
      ok: false,
      message: 'No entry point found',
      checked: candidates,
      files: fs.readdirSync(projectDir).slice(0, 20)
    });
  }

  const child = exec(`timeout 5 node ${entryPoint}`, { cwd: projectDir, timeout: 6000 });

  let stdout = '', stderr = '';
  child.stdout?.on('data', d => stdout += d);
  child.stderr?.on('data', d => stderr += d);

  child.on('close', (code) => {
    res.json({
      ok: code === 0 || code === null,
      exitCode: code,
      entryPoint,
      stdout: stdout.substring(0, 2000),
      stderr: stderr.substring(0, 500),
      message: code === 0 ? 'Project ran successfully!' : code === null ? 'Timed out (may be a server — that is OK)' : 'Project exited with errors'
    });
  });
});

// ── Webhook Status ────────────────────────────────────────────────────────
app.get('/webhook/status', async (req, res) => {
  const n8nUrl = process.env.N8N_URL || 'http://localhost:5678';
  try {
    const r = await fetch(`${n8nUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
    const healthy = r.ok;
    res.json({
      n8nRunning: healthy,
      n8nUrl,
      webhookEndpoint: `http://localhost:${PORT}/webhook/n8n`,
      instructions: healthy ?
        'n8n is running. Import ~/forge/n8n/master-workflow.json in n8n UI at ' + n8nUrl :
        'n8n not running. Start with: docker run -p 5678:5678 n8nio/n8n'
    });
  } catch (e) {
    res.json({
      n8nRunning: false,
      n8nUrl,
      error: e.message,
      instructions: 'n8n not running. Start with: docker run -p 5678:5678 n8nio/n8n or npx n8n'
    });
  }
});

// ── N8n Status ─────────────────────────────────────────────────────────────
app.get('/n8n/status', async (req, res) => {
  try {
    const r = await fetch('http://localhost:5678/healthz');
    const text = await r.text();
    res.json({ n8nRunning: true, status: text.trim(), webhookUrl: 'http://localhost:5678/webhook/forge' });
  } catch(e) {
    res.json({ n8nRunning: false, error: e.message, webhookUrl: 'http://localhost:5678/webhook/forge' });
  }
});

// ── Code Indexer ───────────────────────────────────────────────────────────
const indexer = require('./indexer');

app.post('/project/:id/index', rateLimit(10), (req, res) => {
  const { id } = req.params;
  const projectPath = path.join(__dirname, '../projects', id);
  try {
    const result = indexer.indexProject(id, projectPath);
    res.json({ ...result, projectId: id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/project/:id/index/stats', (req, res) => {
  try {
    const stats = indexer.getIndexStats(req.params.id);
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/project/:id/search-code', rateLimit(30), (req, res) => {
  const { query, limit = 5 } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const results = indexer.searchCode(req.params.id, query, limit);
    res.json({ results, query });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FIM Completions (Copilot-style inline) ─────────────────────────────────
app.post('/complete/fim', rateLimit(60), async (req, res) => {
  const { prefix = '', suffix = '', lang = 'javascript', maxTokens = 150, model } = req.body;
  if (!prefix && !suffix) return res.status(400).json({ error: 'prefix or suffix required' });

  const useModel = model || 'qwen2.5-coder:3b';

  const ck = cacheKey(prefix.slice(-200), suffix.slice(0, 100), lang);
  const cached = cacheGet(ck);
  if (cached) return res.json({ ...cached, cached: true });

  const prompt = `Complete the following ${lang} code. Output ONLY the code that goes between the prefix and suffix. No explanations, no markdown, no extra text. Just the raw code completion.

PREFIX:
${prefix.slice(-800)}

SUFFIX:
${suffix.slice(0, 300)}

COMPLETION (only the middle part):`;

  try {
    const result = await callOllama(useModel, prompt, {
      num_predict: maxTokens,
      temperature: 0.1,
      top_p: 0.9,
      stop: ['\n\n\n', '```', 'PREFIX:', 'SUFFIX:'],
      num_ctx: 2048
    });

    let completion = (result.response || '').trim();
    completion = completion.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    if (completion.split('\n').length > 20) {
      completion = completion.split('\n').slice(0, 20).join('\n');
    }

    const payload = { completion, model: useModel, tokens: result.eval_count || 0 };
    cacheSet(ck, { completion, model: useModel });
    res.json(payload);
  } catch(e) {
    res.status(500).json({ error: e.message, completion: '' });
  }
});

// Single-line quick completion
app.post('/complete/inline', rateLimit(120), async (req, res) => {
  const { line = '', lang = 'javascript', model } = req.body;
  if (!line.trim()) return res.json({ completion: '' });

  const useModel = model || 'qwen2.5-coder:3b';
  const prompt = `Complete this single line of ${lang} code. Output ONLY what comes after the cursor. No newlines, no explanation:\n${line}`;

  try {
    const result = await callOllama(useModel, prompt, {
      num_predict: 60,
      temperature: 0.05,
      stop: ['\n', ';', '{', '```'],
      num_ctx: 1024
    });
    const completion = (result.response || '').split('\n')[0].trim();
    res.json({ completion, model: useModel });
  } catch(e) {
    res.json({ completion: '' });
  }
});

// ── Code Actions (explain, fix, refactor, generate-tests) ─────────────────
app.post('/code/explain', rateLimit(30), async (req, res) => {
  const { code, lang = 'javascript', filename = '' } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const prompt = `You are an expert ${lang} developer. Explain this code clearly and concisely:

\`\`\`${lang}
${code.slice(0, 2000)}
\`\`\`

Provide:
1. What this code does (1-2 sentences)
2. How it works (step by step)
3. Any important patterns or gotchas
4. Suggestions for improvement (if any)`;

  try {
    const result = await callOllama('qwen2.5-coder:3b', prompt, { temperature: 0.3 });
    res.json({ explanation: result.response || '', filename, lang });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/code/fix', rateLimit(30), async (req, res) => {
  const { code, error: errMsg = '', lang = 'javascript', filename = '' } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const prompt = `Fix the following ${lang} code${errMsg ? ` that has this error: ${errMsg}` : ''}.
Output ONLY the fixed code, no explanations, no markdown wrapping:

${code.slice(0, 2000)}`;

  try {
    const result = await callOllama('qwen2.5-coder:3b', prompt, { temperature: 0.1 });
    let fixed = (result.response || '').trim();
    fixed = fixed.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    res.json({ fixed, original: code, lang });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/code/refactor', rateLimit(30), async (req, res) => {
  const { code, instructions = '', lang = 'javascript' } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const prompt = `Refactor the following ${lang} code to be cleaner, more readable, and follow best practices.
${instructions ? `Instructions: ${instructions}\n` : ''}Output ONLY the refactored code, no markdown, no explanation:

${code.slice(0, 2000)}`;

  try {
    const result = await callOllama('qwen2.5-coder:3b', prompt, { temperature: 0.2 });
    let refactored = (result.response || '').trim();
    refactored = refactored.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    res.json({ refactored, original: code, lang });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/code/generate-tests', rateLimit(30), async (req, res) => {
  const { code, lang = 'javascript', framework = 'jest', filename = '' } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const prompt = `Write comprehensive ${framework} tests for this ${lang} code. Cover happy paths, edge cases, and error cases.
Output ONLY the test code, no markdown:

${code.slice(0, 2000)}`;

  try {
    const result = await callOllama('qwen2.5-coder:3b', prompt, { temperature: 0.2 });
    let tests = (result.response || '').trim();
    tests = tests.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    res.json({ tests, lang, framework });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/code/suggest', rateLimit(60), async (req, res) => {
  const { code, lang = 'javascript', context = '' } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const prompt = `Review this ${lang} code and suggest 3-5 specific improvements. Be concise:
${context ? `Context: ${context}\n` : ''}
\`\`\`${lang}
${code.slice(0, 1500)}
\`\`\``;

  try {
    const result = await callOllama('qwen2.5-coder:3b', prompt, { temperature: 0.3 });
    res.json({ suggestions: result.response || '', lang });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Server-side build intent detection (no model needed) ──────────────────
function detectBuildIntent(message) {
  const m = message.toLowerCase();
  return [
    /\b(build|create|start|make|develop|code)\s+(it|this|the\s+project|project|that|app|site|now)\b/,
    /\bstart\s+(building|developing|coding|working\s+on|the\s+project)\b/,
    /\b(queue|run|launch|kick\s+off)\s+(the\s+)?(pipeline|project|dev\s+team|agents|build)\b/,
    /\bget\s+to\s+work\b/,
    /\bfire\s+it\s+up\b/,
    /\bstart\s+the\s+(dev|development|coding)\b/,
    /\bjust\s+(build|do|start|make)\s+it\b/,
    /\b(go\s+ahead|proceed)\s+(and\s+)?(build|create|develop|start)\b/,
  ].some(p => p.test(m));
}

// ── Plan project from chat conversation ────────────────────────────────────
// Uses a capable model to extract structured project plan from conversation.
// Does NOT affect the user's chat model session — runs as independent call.
app.post('/project/plan-from-chat', async (req, res) => {
  const { conversation = [], stack } = req.body;
  if (!conversation.length) return res.status(400).json({ error: 'conversation required' });

  const convoText = conversation
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-12)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')
    .slice(0, 2000);

  // Pick planner model: prefer qwen2.5-coder:3b (fast instruction-following) or largest that fits VRAM
  const VRAM_LIMIT = 4 * 1024 * 1024 * 1024;
  const PREFERRED_PLANNER = ['qwen2.5-coder:3b', 'phi3.5-forge:latest', 'phi3.5:latest', 'deepseek-r1:1.5b'];
  let plannerModel = PREFERRED_PLANNER.find(m => _availableModels.has(m));
  if (!plannerModel) {
    const fitsVram = _modelsBySize.filter(m => m.size <= VRAM_LIMIT);
    plannerModel = (fitsVram.length > 0 ? fitsVram[fitsVram.length - 1] : _modelsBySize[0])?.name || DEFAULT_MODEL;
  }

  const prompt = `You are a JSON API. A user had this conversation about a project they want to build:

${convoText}

Extract the project details and return ONLY a JSON object. No markdown, no explanation.

{"name":"short project name","description":"one sentence what it does","stack":"${stack||'node'}","features":["feature1","feature2","feature3","feature4","feature5"],"epics":[{"title":"epic title","tasks":["task1","task2","task3"]},{"title":"epic title","tasks":["task1","task2","task3"]},{"title":"epic title","tasks":["task1","task2"]}]}

Rules: stack must be node/react/python/go. 3 epics. 3-4 tasks each. Output ONLY the JSON object starting with {`;

  try {
    let result = null;
    for (const temperature of [0.1, 0.2]) {
      try {
        const r = await callOllama(plannerModel, prompt, { num_predict: -1, temperature, num_ctx: DEFAULT_CTX });
        result = cleanJson(r.response);
        if (result?.name && result?.epics?.length) break;
      } catch { result = null; }
    }

    if (!result || !result.name || !result.epics?.length) {
      // Fallback: build from conversation text
      const words = conversation.filter(m=>m.role==='user').map(m=>m.content).join(' ').slice(0,200);
      result = {
        name: words.slice(0,50),
        description: words.slice(0,120),
        stack: stack || 'node',
        features: ['Core functionality','User interface','Data persistence','API layer','Testing & docs'],
        epics: [
          { title: 'Core Implementation', tasks: ['Set up project structure','Implement core logic','Add error handling'] },
          { title: 'Interface & API', tasks: ['Build user interface','Create API endpoints','Add data layer'] },
          { title: 'Polish & Deploy', tasks: ['Write tests','Add documentation','Deployment setup'] }
        ]
      };
    }

    result.epics = result.epics.map(e => ({
      title: e.title || 'Implementation',
      tasks: Array.isArray(e.tasks) ? e.tasks.filter(Boolean) : []
    })).filter(e => e.tasks.length > 0);

    res.json({ ok: true, plan: result, plannerModel });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Streaming chat ─────────────────────────────────────────────────────────
// Image generation endpoint — routes to correct provider's image API
app.post('/chat/generate-image', async (req, res) => {
  const { prompt, model, size = '1024x1024', n = 1 } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const { provider, model: modelId } = resolveProvider(model || 'openai/dall-e-3');
  const providers = loadProviders();
  const pcfg = providers[provider] || {};
  if (!pcfg?.apiKey) return res.status(400).json({ error: `${provider} API key not configured` });

  try {
    const baseUrl = pcfg.baseUrl || (provider === 'openai' ? 'https://api.openai.com/v1'
      : provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
      : 'https://api.openai.com/v1');
    const extraHeaders = provider === 'openrouter' ? { 'HTTP-Referer': 'http://localhost:3737', 'X-Title': 'Forge' } : {};

    const r = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pcfg.apiKey}`, ...extraHeaders },
      body: JSON.stringify({ model: modelId, prompt, n, size, response_format: 'b64_json' }),
      signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) { const e = await r.text(); throw new Error(`${provider} ${r.status}: ${e}`); }
    const data = await r.json();
    res.json({ images: (data.data || []).map(d => ({ b64: d.b64_json, url: d.url, revisedPrompt: d.revised_prompt })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/chat/stream', rateLimit(20), async (req, res) => {
  const { message, projectId, model, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Pick model — supports "provider/model" format for cloud routing
  const useModel = model || (_modelsBySize[0]?.name) || 'qwen2.5-coder:3b';

  let systemCtx = `You are Forge, a software project planner and AI dev assistant.

RULES:
- When a user describes ANY project idea, immediately produce a full structured plan. Do NOT ask "what do you want to build?" — they already told you. Make smart decisions yourself.
- Structure every project plan exactly like this:

## [Project Name]
**What it does:** [1-2 sentences]
**Core Features:**
- [feature]
- [feature]
**Recommended Stack:** [your pick]
**Development Phases:**
1. [Phase] — [what gets built]
2. [Phase] — [what gets built]
3. [Phase] — [what gets built]

After the plan say: "Ready to queue this for the dev team?"

- If user says yes/start/build/go ahead/queue it → end your response with: [FORGE_BUILD: one sentence description]
- For non-project questions: just answer directly, no disclaimers, no apologies.`;

  if (projectId) {
    const db = DB();
    try {
      const proj = db.prepare('SELECT name, description, stack FROM projects WHERE id=?').get(projectId);
      if (proj) systemCtx += `\n\nActive project: ${proj.name} (${proj.stack}). ${proj.description || ''}`;
    } finally { db.close(); }
  }

  // Build messages array from conversation history + current message
  const messages = [{ role: 'system', content: systemCtx }];
  for (const h of (history || []).slice(-14)) {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: 'user', content: message });

  const t0 = Date.now();

  try {
    let fullResponse = '';
    let evalCount = 0, promptEvalCount = 0, tokPerSec = 0;

    for await (const chunk of streamChat(useModel, messages, { temperature: 0.7 })) {
      if (chunk.token) {
        fullResponse += chunk.token;
        res.write(`data: ${JSON.stringify({ token: chunk.token })}\n\n`);
      }
      if (chunk.raw?.done) {
        evalCount = chunk.raw.eval_count || 0;
        promptEvalCount = chunk.raw.prompt_eval_count || 0;
        const evalDuration = chunk.raw.eval_duration || 0;
        tokPerSec = evalCount > 0 && evalDuration > 0 ? Math.round((evalCount / evalDuration) * 1e9 * 10) / 10 : 0;
      }
      // Cloud provider usage stats
      if (chunk.usage) {
        promptEvalCount = chunk.usage.promptTokens || promptEvalCount;
        evalCount = chunk.usage.completionTokens || evalCount;
      }
    }

    const durationMs = Date.now() - t0;
    const buildIntent = detectBuildIntent(message);
    const forgeBuildMatch = fullResponse.match(/\[FORGE_BUILD:\s*([^\]]+)\]/i);
    if (evalCount > 0) {
      recordBench({ model: useModel, role: 'chat', tokIn: promptEvalCount, tokOut: evalCount, durationMs, tokPerSec, stage: 'chat' });
    }
    res.write(`data: ${JSON.stringify({
      done: true, full: fullResponse, tokens: evalCount,
      promptTokens: promptEvalCount, tokPerSec, durationMs,
      buildIntent, forgeBuild: forgeBuildMatch ? forgeBuildMatch[1].trim() : null
    })}\n\n`);
    res.end();
  } catch(e) {
    res.write(`data: ${JSON.stringify({ error: e.message, done: true })}\n\n`);
    res.end();
  }
});

// ── Quick Ask — fast single-agent response (no full pipeline) ──────────────
app.post('/quick-ask', rateLimit(30), async (req, res) => {
  const { question, code, lang = 'javascript', projectId } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });

  let context = '';
  if (projectId) {
    const db = DB();
    try {
      const proj = db.prepare('SELECT name, description, stack FROM projects WHERE id=?').get(projectId);
      if (proj) context = `Project: ${proj.name} (${proj.stack}). ${proj.description || ''}\n\n`;
    } finally { db.close(); }
  }

  const prompt = `${context}${code ? `Code:\n\`\`\`${lang}\n${code.slice(0, 1500)}\n\`\`\`\n\n` : ''}Question: ${question}`;

  try {
    const startTime = Date.now();
    const result = await callOllama('qwen2.5-coder:3b', prompt, {
      temperature: 0.4,
      num_ctx: 8192
    });
    res.json({
      answer: result.response || '',
      duration: Date.now() - startTime,
      tokens: result.eval_count || 0
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Autonomous Auto-Run Loop ────────────────────────────────────────────────
const _autoRunState = new Map(); // projectId -> { running, done, failed, total }

app.post('/project/:id/auto-run', rateLimit(5), async (req, res) => {
  const { id } = req.params;
  const { maxFails = 3, stopOnScore } = req.body || {};

  if (_autoRunState.get(id)?.running) {
    return res.json({ message: 'Auto-run already active for this project', state: _autoRunState.get(id) });
  }

  const db = DB();
  let pending;
  try {
    pending = db.prepare(`
      SELECT COUNT(*) as n FROM tasks t
      JOIN epics e ON t.epic_id = e.id
      WHERE e.project_id=? AND t.status='pending'
    `).get(id).n;
  } finally { db.close(); }

  if (pending === 0) return res.json({ message: 'No pending tasks for this project', done: true });

  const state = { running: true, done: 0, failed: 0, total: pending, consecutiveFails: 0, startedAt: Date.now() };
  _autoRunState.set(id, state);

  res.json({ message: `Auto-run started for project ${id}`, total: pending, pending, running: true });

  // Run in background (non-blocking)
  setImmediate(async () => {
    sseEmit('auto_run_start', { projectId: id, total: pending });

    while (state.consecutiveFails < maxFails) {
      // Check pending tasks for this project
      const db2 = DB();
      let nextTask;
      try {
        nextTask = db2.prepare(`
          SELECT t.id, t.title FROM tasks t
          JOIN epics e ON t.epic_id = e.id
          WHERE e.project_id=? AND t.status='pending' AND t.attempts < 5
          ORDER BY t.created_at ASC LIMIT 1
        `).get(id);
      } finally { db2.close(); }

      if (!nextTask) {
        // No pending tasks — check if any are still in_progress (wait for them)
        const db3 = DB();
        let inProg = 0;
        try {
          inProg = db3.prepare(`
            SELECT COUNT(*) as n FROM tasks t JOIN epics e ON t.epic_id=e.id
            WHERE e.project_id=? AND t.status='in_progress'
          `).get(id).n;
        } finally { db3.close(); }
        if (inProg > 0) {
          await new Promise(r => setTimeout(r, 20000)); // wait 20s for in_progress tasks
          continue;
        }
        break; // truly no more tasks
      }

      sseEmit('auto_run_task', { projectId: id, taskId: nextTask.id, title: nextTask.title, done: state.done, total: state.total });

      try {
        // Call the run-next endpoint internally — it manages the mutex itself
        // Retry up to 6 times if mutex is busy (another task still running)
        let runRes, result, retries = 0;
        while (retries < 6) {
          runRes = await fetch(`http://localhost:${PORT}/task/run-next`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: id })
          });
          result = await runRes.json();
          if (runRes.status !== 429) break; // mutex acquired successfully
          retries++;
          await new Promise(r => setTimeout(r, 15000)); // wait 15s before retry
        }

        if (result.taskId) {
          state.done++;
          state.consecutiveFails = 0;
          const score = result.qualityScore || 0;
          sseEmit('auto_run_done', { projectId: id, taskId: result.taskId, score, done: state.done, total: state.total });

          // Auto git commit if score >= 6
          if (score >= 6) {
            try {
              const projectPath = path.join(__dirname, '../projects', id);
              const { execSync } = require('child_process');
              try { execSync('git init', { cwd: projectPath, stdio: 'pipe' }); } catch {}
              try { execSync('git add -A', { cwd: projectPath, stdio: 'pipe' }); } catch {}
              try {
                execSync(`git commit -m "feat: ${result.title || nextTask.title} (score:${score}/10)" --allow-empty`,
                  { cwd: projectPath, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Forge AI', GIT_AUTHOR_EMAIL: 'forge@local', GIT_COMMITTER_NAME: 'Forge AI', GIT_COMMITTER_EMAIL: 'forge@local' } }
                );
                sseEmit('auto_run_commit', { projectId: id, title: result.title, score });
              } catch {}
            } catch {}
          }

          if (stopOnScore && score >= stopOnScore) break;
        } else {
          state.failed++;
          state.consecutiveFails++;
          sseEmit('auto_run_fail', { projectId: id, error: result.message || result.error, consecutiveFails: state.consecutiveFails });
        }
      } catch(e) {
        state.failed++;
        state.consecutiveFails++;
        // Don't release mutex here — run-next owns it, not us
        sseEmit('auto_run_fail', { projectId: id, error: e.message, consecutiveFails: state.consecutiveFails });
      }

      // Brief pause between tasks to avoid thermal issues
      await new Promise(r => setTimeout(r, 2000));
    }

    state.running = false;
    const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
    sseEmit('auto_run_complete', {
      projectId: id, done: state.done, failed: state.failed, total: state.total, elapsed,
      message: state.consecutiveFails >= maxFails ? `Stopped after ${maxFails} consecutive failures` : 'All tasks complete!'
    });
    _autoRunState.delete(id);

    // After all tasks done, run output verification
    try {
      await fetch(`http://localhost:${PORT}/project/${id}/verify-output`, { method: 'POST' });
    } catch {}
  });
});

app.get('/project/:id/auto-run/status', (req, res) => {
  const id = req.params.id;
  const state = _autoRunState.get(id);
  const db = DB();
  try {
    const counts = db.prepare(`
      SELECT
        COUNT(CASE WHEN t.status='pending' THEN 1 END) as pending,
        COUNT(CASE WHEN t.status='done' THEN 1 END) as done,
        COUNT(CASE WHEN t.status='in_progress' THEN 1 END) as inProgress
      FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?
    `).get(id);
    const isRunning = !!(state?.running);
    return res.json({
      running: isRunning,
      pending: counts.pending,
      done: counts.done,
      inProgress: counts.inProgress,
      projectId: id
    });
  } finally { db.close(); }
});

app.post('/project/:id/auto-run/stop', (req, res) => {
  const state = _autoRunState.get(req.params.id);
  if (state) { state.consecutiveFails = 999; state.running = false; }
  res.json({ stopped: true });
});

// ── Scaffold Real Starter Code ─────────────────────────────────────────────
app.post('/project/:id/scaffold-code', rateLimit(5), async (req, res) => {
  const { id } = req.params;
  const db = DB();
  let project;
  try {
    project = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
  } finally { db.close(); }

  const projectPath = path.join(__dirname, '../projects', id);
  if (!require('fs').existsSync(projectPath)) require('fs').mkdirSync(projectPath, { recursive: true });

  const prompt = `You are an expert ${project.stack} developer. Create the initial project structure for:

Project: ${project.name}
Description: ${project.description || 'A software project'}
Stack: ${project.stack}

Generate a COMPLETE working starter project. Output as JSON array of files:
[
  { "path": "relative/path/file.ext", "content": "full file content here" },
  ...
]

Rules:
- Include ALL necessary files for a working project (package.json OR requirements.txt, main entry point, src/ files, basic README.md)
- Make the code actually runnable right now
- For Node.js: include package.json with scripts, an index.js or src/index.js
- For Python: include requirements.txt, main.py
- Write real, working code — not placeholder comments
- Keep each file focused and under 100 lines
- Maximum 8 files total
- Output ONLY the JSON array, nothing else`;

  try {
    const result = await callOllama('qwen2.5-coder:3b', prompt, { num_predict: -1, temperature: 0.3, num_ctx: DEFAULT_CTX });

    let files = [];
    try { files = cleanJson(result.response || ''); } catch {}
    if (!Array.isArray(files)) files = [];

    const written = [];
    const fs = require('fs');
    for (const file of files) {
      if (!file.path || !file.content) continue;
      // Security: only allow relative paths within project
      const safePath = file.path.replace(/\.\./g, '').replace(/^\//, '');
      const fullPath = path.join(projectPath, safePath);
      if (!fullPath.startsWith(projectPath)) continue; // path traversal guard

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content, 'utf8');
      written.push(safePath);
    }

    // Auto-index after scaffolding
    try {
      const indexer = require('./indexer');
      indexer.indexProject(id, projectPath);
    } catch {}

    sseEmit('scaffold_complete', { projectId: id, files: written });
    res.json({ written, projectPath, message: `Scaffolded ${written.length} files` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Run & Verify Project Output ────────────────────────────────────────────
app.post('/project/:id/verify-output', rateLimit(10), async (req, res) => {
  const { id } = req.params;
  const projectPath = path.join(__dirname, '../projects', id);
  const fs = require('fs');
  const { execSync } = require('child_process');

  if (!fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project path not found' });

  // Detect entry point
  let command = null;
  let entryFile = null;
  const checks = [
    { file: 'package.json', fn: () => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
        if (pkg.scripts?.start) return { cmd: 'node ' + (pkg.main || 'index.js'), lang: 'node' };
        if (pkg.main) return { cmd: `node ${pkg.main}`, lang: 'node' };
      } catch {}
      return { cmd: 'node index.js', lang: 'node' };
    }},
    { file: 'main.py', fn: () => ({ cmd: 'python3 main.py', lang: 'python' }) },
    { file: 'index.js', fn: () => ({ cmd: 'node index.js', lang: 'node' }) },
    { file: 'app.js', fn: () => ({ cmd: 'node app.js', lang: 'node' }) },
    { file: 'src/index.js', fn: () => ({ cmd: 'node src/index.js', lang: 'node' }) },
    { file: 'index.py', fn: () => ({ cmd: 'python3 index.py', lang: 'python' }) },
    { file: 'main.sh', fn: () => ({ cmd: 'bash main.sh', lang: 'bash' }) },
  ];

  for (const check of checks) {
    if (fs.existsSync(path.join(projectPath, check.file))) {
      const detected = check.fn();
      command = detected.cmd;
      entryFile = check.file;
      break;
    }
  }

  if (!command) return res.json({ ran: false, message: 'No recognizable entry point found', files: fs.readdirSync(projectPath) });

  let output = '';
  let exitCode = -1;
  let error = null;

  try {
    output = execSync(command, {
      cwd: projectPath,
      timeout: 10000, // 10s timeout
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    exitCode = 0;
  } catch(e) {
    output = (e.stdout || '') + (e.stderr || '');
    exitCode = e.status || 1;
    error = e.message;
  }

  const success = exitCode === 0;
  sseEmit('verify_result', { projectId: id, success, exitCode, command, output: output.slice(0, 500) });

  // If it failed, trigger auto-fix — but only if project is substantially complete (>= 80% done)
  if (!success && error) {
    try {
      const db = DB();
      try {
        const taskStats = db.prepare(`
          SELECT COUNT(*) as total,
            SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) as done
          FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?
        `).get(id);
        const completePct = taskStats.total > 0 ? taskStats.done / taskStats.total : 0;
        if (completePct >= 0.8) {
          // Find the most recent done task
          const lastTask = db.prepare(`
            SELECT t.id, t.title FROM tasks t JOIN epics e ON t.epic_id=e.id
            WHERE e.project_id=? AND t.status='done'
            ORDER BY t.updated_at DESC LIMIT 1
          `).get(id);
          if (lastTask) {
            // Queue a debug task
            db.prepare(`UPDATE tasks SET status='pending', attempts=0 WHERE id=?`).run(lastTask.id);
            sseEmit('auto_fix_queued', { projectId: id, taskId: lastTask.id, error: output.slice(0, 300) });
          }
        } else {
          console.log(`[verify] project ${id} only ${Math.round(completePct*100)}% done — skipping auto-fix reset`);
        }
      } finally { db.close(); }
    } catch {}
  }

  res.json({ ran: true, success, exitCode, command, entryFile, output: output.slice(0, 1000), autoFixed: !success });
});

// ── Idle Self-Improvement Scheduler ───────────────────────────────────────
let _lastTaskTime = Date.now();

setInterval(async () => {
  // Only run if idle for 30+ minutes and no tasks running
  if (Date.now() - _lastTaskTime < 30 * 60 * 1000) return;
  if (!acquireMutex()) return; // something else running
  releaseMutex(); // release immediately — just checking

  // Find projects with low quality scores
  const db = DB();
  try {
    const lowQuality = db.prepare(`
      SELECT e.project_id, AVG(t.quality_score) as avgScore, COUNT(t.id) as taskCount
      FROM tasks t JOIN epics e ON t.epic_id=e.id
      WHERE t.status='done' AND t.quality_score IS NOT NULL
      GROUP BY e.project_id
      HAVING avgScore < 7 AND taskCount >= 3
      ORDER BY avgScore ASC LIMIT 1
    `).get();

    if (lowQuality) {
      sseEmit('idle_improve_start', { projectId: lowQuality.project_id, avgScore: lowQuality.avgScore });
      try {
        await fetch(`http://localhost:${PORT}/project/${lowQuality.project_id}/improve-loop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxRounds: 2 })
        });
        _lastTaskTime = Date.now(); // reset so it doesn't immediately re-trigger
      } catch {}
    }
  } finally { db.close(); }
}, 5 * 60 * 1000); // check every 5 minutes

// ── Chat-to-Build: describe it, Forge builds it ────────────────────────────
app.post('/build', rateLimit(5), async (req, res) => {
  const { description, autoRun = true, plan: incomingPlan } = req.body;
  if (!description || description.trim().length < 5) {
    return res.status(400).json({ error: 'Describe what you want to build' });
  }

  // If a structured plan was passed from the chat planner, use it directly — skip re-parsing
  let parsed = null;
  if (incomingPlan?.name && Array.isArray(incomingPlan?.epics) && incomingPlan.epics.length > 0) {
    parsed = {
      name: incomingPlan.name,
      description: incomingPlan.description || description,
      stack: incomingPlan.stack || req.body.stack || 'node',
      epics: incomingPlan.epics.map(e => ({
        title: e.title || 'Core Features',
        tasks: Array.isArray(e.tasks) ? e.tasks.filter(Boolean) : []
      })).filter(e => e.tasks.length > 0)
    };
  }

  // Otherwise parse from description using the largest VRAM-fitting model
  if (!parsed) {
    const makeParsePrompt = (desc, simple = false) => simple
      ? `Return JSON only. No markdown. No explanation. No apologies.
{"name":"${desc.slice(0,40)}","description":"short desc","stack":"node","epics":[{"title":"Core","tasks":["task1","task2","task3"]}]}`
      : `You are a JSON API. Return ONLY a JSON object. No markdown fences. No explanation. No apology text.

Project request: "${desc.slice(0, 200)}"

Return this JSON (fill in the values):
{"name":"Short project name","description":"One sentence what it does","stack":"node","epics":[{"title":"Epic 1 title","tasks":["Specific task 1","Specific task 2","Specific task 3"]},{"title":"Epic 2 title","tasks":["Specific task 4","Specific task 5","Specific task 6"]}]}

Rules: stack=node/python/react/go. 2-3 epics. 3-4 tasks each. Task strings under 80 chars. NO trailing commas. NO comments. Output ONLY the JSON object starting with {`;

    const VRAM_LIMIT = 4 * 1024 * 1024 * 1024;
    const PREFERRED_PARSE = ['qwen2.5-coder:3b', 'phi3.5-forge:latest', 'phi3.5:latest', 'deepseek-r1:1.5b'];
    let parseModel = PREFERRED_PARSE.find(m => _availableModels.has(m));
    if (!parseModel) {
      const fitsVram = _modelsBySize.filter(m => m.size <= VRAM_LIMIT);
      parseModel = (fitsVram.length > 0 ? fitsVram[fitsVram.length - 1] : _modelsBySize[0])?.name || DEFAULT_MODEL;
    }

    for (const [simple, tokens] of [[false, 900], [true, 400]]) {
      try {
        const result = await callOllama(parseModel, makeParsePrompt(description, simple), {
          num_predict: tokens,
          temperature: 0.1,
          num_ctx: DEFAULT_CTX
        });
        parsed = cleanJson(result.response);
        if (!parsed.name || !parsed.epics) throw new Error('Missing name or epics');
        parsed.epics = (parsed.epics || []).map(e => ({
          title: e.title || 'Core Features',
          tasks: Array.isArray(e.tasks) ? e.tasks.filter(Boolean) : []
        })).filter(e => e.tasks.length > 0);
        if (!parsed.epics.length) throw new Error('No valid epics generated');
        break;
      } catch(e) { parsed = null; }
    }

    // Final fallback
    if (!parsed) {
      const words = description.trim().split(/\s+/).slice(0, 6).join(' ');
      parsed = {
        name: words.length > 4 ? words : description.slice(0, 50),
        description: description.slice(0, 120),
        stack: req.body.stack || 'node',
        epics: [
          { title: 'Core Implementation', tasks: ['Set up project structure and dependencies', 'Implement core business logic', 'Add error handling and validation'] },
          { title: 'API & Interface', tasks: ['Build main API endpoints or UI', 'Add data persistence layer', 'Write basic tests'] }
        ]
      };
    }
  }

  // Step 2: Create the project in DB
  const db = DB();
  let projectId, epicIds = [];
  try {
    projectId = 'proj_' + Date.now();
    db.prepare(`INSERT INTO projects (id, name, description, stack, status, created_at)
      VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)`)
      .run(projectId, parsed.name, parsed.description || '', parsed.stack || 'node');

    // Create epics and tasks
    for (const epic of (parsed.epics || [])) {
      const epicId = 'epic_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      db.prepare(`INSERT INTO epics (id, project_id, title, status) VALUES (?, ?, ?, 'pending')`)
        .run(epicId, projectId, epic.title);
      epicIds.push(epicId);

      for (const taskTitle of (epic.tasks || [])) {
        const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        db.prepare(`INSERT INTO tasks (id, epic_id, title, description, status, attempts, created_at)
          VALUES (?, ?, ?, ?, 'pending', 0, CURRENT_TIMESTAMP)`)
          .run(taskId, epicId, taskTitle, `Implement: ${taskTitle}`);
      }
    }
  } finally { db.close(); }

  // Step 3: Scaffold starter code
  sseEmit('build_start', { projectId, name: parsed.name, stack: parsed.stack, description: parsed.description });

  // Count total tasks
  const db2 = DB();
  let totalTasks;
  try {
    totalTasks = db2.prepare(`SELECT COUNT(*) as n FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?`).get(projectId).n;
  } finally { db2.close(); }

  // Respond immediately with project details
  res.json({
    projectId,
    name: parsed.name,
    description: parsed.description,
    stack: parsed.stack,
    totalTasks,
    epics: parsed.epics.map((e, i) => ({ id: epicIds[i], title: e.title, tasks: e.tasks })),
    message: `Created "${parsed.name}" with ${totalTasks} tasks${autoRun ? '. Starting auto-build...' : '. Ready to run.'}`,
    autoRunning: autoRun
  });

  // Step 4: Scaffold + auto-run in background
  if (autoRun) {
    setImmediate(async () => {
      // Scaffold first
      try {
        await fetch(`http://localhost:${PORT}/project/${projectId}/scaffold-code`, { method: 'POST' });
      } catch {}

      // Then auto-run all tasks
      try {
        await fetch(`http://localhost:${PORT}/project/${projectId}/auto-run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxFails: 3 })
        });
      } catch(e) {
        sseEmit('build_error', { projectId, error: e.message });
      }
    });
  }
});

// ── File read/write for in-dashboard editor ────────────────────────────────
app.get('/project/:id/file', (req, res) => {
  const filePath2 = req.query.path;
  if (!filePath2) return res.status(400).json({ error: 'path query param required' });
  const projectPath = path.join(__dirname, '../projects', req.params.id);
  const fullPath = path.join(projectPath, filePath2.replace(/\.\./g, ''));
  if (!fullPath.startsWith(projectPath)) return res.status(403).json({ error: 'Path traversal blocked' });
  try {
    const content = require('fs').readFileSync(fullPath, 'utf8');
    res.json({ content, path: filePath2 });
  } catch(e) { res.status(404).json({ error: 'File not found: ' + e.message }); }
});

app.put('/project/:id/file', (req, res) => {
  const { content = '', path: filePath2 } = req.body;
  if (!filePath2) return res.status(400).json({ error: 'path in body required' });
  const projectPath = path.join(__dirname, '../projects', req.params.id);
  const fullPath = path.join(projectPath, filePath2.replace(/\.\./g, ''));
  if (!fullPath.startsWith(projectPath)) return res.status(403).json({ error: 'Path traversal blocked' });
  try {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    try { const indexer = require('./indexer'); indexer.indexProject(req.params.id, projectPath); } catch {}
    res.json({ saved: true, path: filePath2, bytes: Buffer.byteLength(content) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── List all files in a project directory ─────────────────────────────────
app.get('/project/:id/files-list', (req, res) => {
  const projectPath = path.join(__dirname, '../projects', req.params.id);
  const fs = require('fs');
  if (!fs.existsSync(projectPath)) return res.json({ files: [] });
  const results = [];
  const exts = ['.js','.ts','.py','.json','.md','.sh','.html','.css','.go','.rs','.txt','.env'];
  const skip = ['node_modules','.git','dist','build','__pycache__','.next'];
  function walk(dir, rel='') {
    try { fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      if (e.isDirectory() && !skip.includes(e.name)) walk(path.join(dir,e.name), rel ? rel+'/'+e.name : e.name);
      else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase())) results.push(rel ? rel+'/'+e.name : e.name);
    }); } catch {}
  }
  walk(projectPath);
  res.json({ files: results, projectPath });
});

// ── Run a command inside a project directory (Copilot-style inline dev) ──────
app.post('/project/:id/exec', async (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: 'command required' });
  const projectPath = path.join(__dirname, '../projects', req.params.id);
  const { exec } = require('child_process');
  exec(command.trim(), { cwd: projectPath, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
    res.json({ stdout: stdout || '', stderr: stderr || '', exitCode: err ? (err.code ?? 1) : 0, command: command.trim() });
  });
});

// ── Agentic chat — model autonomously reads/writes files and runs commands ────
// Works like Claude Code / Copilot agent: user says "fix the auth bug" and the
// model reads relevant files, patches them, runs tests, and reports back.
app.post('/project/:id/agent-chat', async (req, res) => {
  const { message, model: reqModel, history = [] } = req.body;
  const { id } = req.params;
  if (!message) return res.status(400).json({ error: 'message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const emit = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

  // __workspace__ = sandbox mode — no project required, uses /forge/workspace dir
  const isWorkspace = (id === '__workspace__');
  let proj = null;
  if (!isWorkspace) {
    const db = DB();
    try { proj = db.prepare('SELECT * FROM projects WHERE id=?').get(id); }
    finally { db.close(); }
    if (!proj) { emit({ error: 'Project not found', done: true }); return res.end(); }
  }

  const projectPath = isWorkspace
    ? path.join(__dirname, '../workspace')
    : path.join(__dirname, '../projects', id);

  // Ensure workspace dir exists
  if (isWorkspace) fs.mkdirSync(projectPath, { recursive: true });

  const SKIP = new Set(['node_modules','.git','dist','build','__pycache__','.next','coverage']);
  const CODE_EXTS = new Set(['.js','.ts','.jsx','.tsx','.py','.json','.md','.sh','.html','.css','.go','.rs','.env','.yaml','.yml','.sql']);

  function listFiles(dir, rel='', depth=0) {
    const results = [];
    if (depth > 4) return results;
    try {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        if (e.isDirectory() && !SKIP.has(e.name)) results.push(...listFiles(path.join(dir,e.name), rel?rel+'/'+e.name:e.name, depth+1));
        else if (e.isFile() && CODE_EXTS.has(require('path').extname(e.name).toLowerCase())) results.push(rel?rel+'/'+e.name:e.name);
      });
    } catch {}
    return results;
  }

  const files = listFiles(projectPath).slice(0, 50);

  const projLabel = isWorkspace
    ? 'Forge Workspace (sandbox — write files here, run commands, prototype freely)'
    : `"${proj.name}" project (stack: ${proj.stack||'node'})${proj.description?'\nProject: '+proj.description:''}`;

  const systemPrompt = `You are Forge, an autonomous AI coding agent working inside ${projLabel}.

Files in workspace:
${files.length ? files.join('\n') : '(empty — create files with WRITE:)'}

## YOUR TOOLS — use these exact patterns on their own line:

READ: src/path/to/file.js
  → You will receive the file contents. Always read a file before editing it.

WRITE: src/path/to/file.js
\`\`\`
...complete file content here...
\`\`\`
  → Writes the file. Always write the COMPLETE file, not just changes.

RUN: npm test
  → Runs a command in the project directory. You get stdout/stderr back.

## RULES
- Read files before editing them. Never guess at file contents.
- Write the full file every time (never partial patches).
- After writing code, run tests to verify it works.
- Be decisive. Take action immediately, do not ask "should I?".
- When done, summarize what you changed and why.`;

  const useModel = reqModel || (_modelsBySize.find(m => m.name.includes('qwen2.5-coder')) || _modelsBySize[0])?.name || 'qwen2.5-coder:3b';

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-12).filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message }
  ];

  const MAX_ITERATIONS = 10;
  let noToolTurns = 0;
  let lastWrittenFile = null;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    emit({ type: 'thinking', iteration });

    let fullResponse = '';
    try {
      for await (const chunk of streamChat(useModel, messages, { temperature: 0.15 })) {
        if (chunk.token) { fullResponse += chunk.token; emit({ type: 'token', token: chunk.token }); }
      }
    } catch(e) {
      emit({ type: 'error', message: e.message });
      break;
    }

    messages.push({ role: 'assistant', content: fullResponse });

    // Parse actions from the response — strict + fallback patterns
    const lines = fullResponse.split('\n');
    const actions = [];
    let i = 0;
    while (i < lines.length) {
      const trimmed = lines[i].trim();

      // READ patterns: READ: path | [READ: path] | **READ:** path | `READ path` | read(path)
      const readMatch = trimmed.match(/^READ:\s+(\S.*)/)
        || trimmed.match(/^\[READ:\s+([^\]]+)\]/)
        || trimmed.match(/^\*\*READ:\*\*\s+(\S.*)/)
        || trimmed.match(/^`READ\s+([^`]+)`/)
        || trimmed.match(/^read\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (readMatch) {
        actions.push({ type: 'read', path: readMatch[1].trim() });
        i++; continue;
      }

      // WRITE patterns: WRITE: path | [WRITE: path] | **WRITE:** path | `WRITE path` | write(path)
      const writeMatch = trimmed.match(/^WRITE:\s+(\S.*)/)
        || trimmed.match(/^\[WRITE:\s+([^\]]+)\]/)
        || trimmed.match(/^\*\*WRITE:\*\*\s+(\S.*)/)
        || trimmed.match(/^`WRITE\s+([^`]+)`/)
        || trimmed.match(/^write\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (writeMatch) {
        const filePath = writeMatch[1].trim();
        let code = '';
        let j = i + 1;
        while (j < lines.length && !lines[j].trim().startsWith('```')) j++;
        if (j < lines.length) {
          j++; // skip opening ```lang
          while (j < lines.length && !lines[j].trim().startsWith('```')) {
            code += lines[j] + '\n';
            j++;
          }
        }
        if (code.trim()) actions.push({ type: 'write', path: filePath, content: code.trimEnd() });
        i = j; i++; continue;
      }

      // RUN patterns: RUN: cmd | [RUN: cmd] | **RUN:** cmd | `RUN cmd` | run(cmd)
      const runMatch = trimmed.match(/^RUN:\s+(\S.*)/)
        || trimmed.match(/^\[RUN:\s+([^\]]+)\]/)
        || trimmed.match(/^\*\*RUN:\*\*\s+(\S.*)/)
        || trimmed.match(/^`RUN\s+([^`]+)`/)
        || trimmed.match(/^run\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (runMatch) {
        actions.push({ type: 'run', command: runMatch[1].trim() });
        i++; continue;
      }

      i++;
    }

    if (actions.length === 0) {
      // Auto-extract code block to last written file if there's an active file context
      const cbMatch = fullResponse.match(/```(?:[a-z]*)?\n([\s\S]+?)\n```/);
      if (cbMatch && lastWrittenFile) {
        actions.push({ type: 'write', path: lastWrittenFile, content: cbMatch[1].trimEnd() });
        emit({ type: 'info', message: `Auto-extracted code → ${lastWrittenFile}` });
      }
    }

    if (actions.length === 0) {
      noToolTurns++;
      if (noToolTurns >= 3) {
        noToolTurns = 0;
        messages.push({ role: 'user', content: 'Remember to use READ: path, WRITE: path\n```code```, or RUN: command format.' });
        emit({ type: 'tool_turn', count: 0, reminder: true });
        continue;
      }
      // No more actions — agent is done
      emit({ type: 'done', iteration: iteration + 1 });
      return res.end();
    }
    noToolTurns = 0;

    // Execute actions, collect results
    let toolResults = '';
    for (const action of actions) {
      if (action.type === 'read') {
        emit({ type: 'action', action: 'read', path: action.path });
        const safePath = action.path.replace(/\.\./g, '');
        const fullPath = path.join(projectPath, safePath);
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          toolResults += `\n[Result of READ: ${action.path}]\n\`\`\`\n${content}\n\`\`\`\n`;
          emit({ type: 'result', action: 'read', path: action.path, lines: content.split('\n').length });
        } catch(e) {
          toolResults += `\n[READ: ${action.path}] → File not found: ${e.message}\n`;
          emit({ type: 'result', action: 'read', path: action.path, error: e.message });
        }
      }

      if (action.type === 'write') {
        emit({ type: 'action', action: 'write', path: action.path });
        const safePath = action.path.replace(/\.\./g, '');
        const fullPath = path.join(projectPath, safePath);
        try {
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, action.content, 'utf8');
          const lineCount = action.content.split('\n').length;
          lastWrittenFile = action.path;
          toolResults += `\n[Result of WRITE: ${action.path}] → Written (${lineCount} lines)\n`;
          emit({ type: 'result', action: 'write', path: action.path, lines: lineCount });
          try { require('./indexer').indexProject(id, projectPath); } catch {}
        } catch(e) {
          toolResults += `\n[WRITE: ${action.path}] → Failed: ${e.message}\n`;
          emit({ type: 'result', action: 'write', path: action.path, error: e.message });
        }
      }

      if (action.type === 'run') {
        emit({ type: 'action', action: 'run', command: action.command });
        const { execSync } = require('child_process');
        try {
          const output = execSync(action.command, { cwd: projectPath, timeout: 30000, maxBuffer: 2*1024*1024 }).toString();
          const trimmedOut = output.slice(0, 2000);
          toolResults += `\n[Result of RUN: ${action.command}]\n${trimmedOut}\n`;
          emit({ type: 'result', action: 'run', command: action.command, output: trimmedOut, exitCode: 0 });
        } catch(e) {
          const output = ((e.stdout?.toString()||'') + (e.stderr?.toString()||'')).slice(0, 2000) || e.message;
          toolResults += `\n[RUN: ${action.command}] exited ${e.status||1}:\n${output}\n`;
          emit({ type: 'result', action: 'run', command: action.command, output, exitCode: e.status||1 });
        }
      }
    }

    // Feed results back into the conversation
    messages.push({ role: 'user', content: toolResults });
    emit({ type: 'tool_turn', count: actions.length });
  }

  emit({ type: 'done', iteration: MAX_ITERATIONS });
  res.end();
});

// ── Get all AGENT_MODELS role assignments (for Models panel) ────────────────
app.get('/agent-roles', (req, res) => {
  const roleMap = {};
  for (const [role, cfg] of Object.entries(AGENT_MODELS)) {
    if (!roleMap[cfg.model]) roleMap[cfg.model] = [];
    roleMap[cfg.model].push(role);
  }
  res.json({ roles: roleMap });
});

// ── Quick project stats for dashboard ─────────────────────────────────────
app.get('/project/:id/summary', (req, res) => {
  const db = DB();
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const stats = db.prepare(`
      SELECT 
        COUNT(t.id) as total,
        COUNT(CASE WHEN t.status='done' THEN 1 END) as done,
        COUNT(CASE WHEN t.status='pending' THEN 1 END) as pending,
        COUNT(CASE WHEN t.status='in_progress' THEN 1 END) as inProgress,
        ROUND(AVG(CASE WHEN t.status='done' THEN t.quality_score END),1) as avgScore,
        MAX(t.quality_score) as bestScore,
        COUNT(DISTINCT e.id) as epicCount
      FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?
    `).get(req.params.id);
    const indexStats = (() => { try { return require('./indexer').getIndexStats(req.params.id); } catch { return {}; } })();
    res.json({ ...project, ...stats, indexStats });
  } finally { db.close(); }
});

// Serve static assets (hashed filenames = safe to cache long-term)
// But index.html must never be cached — it references the current bundle hashes
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Project-aware Ask (smarter than /quick-ask) ───────────────────────────
app.post('/project/:id/ask', rateLimit(30), async (req, res) => {
  const { question, code, context: extraCtx = '' } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });

  const db = DB();
  let proj, taskStats, recentCode = '';
  try {
    proj = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    taskStats = db.prepare(`
      SELECT COUNT(CASE WHEN t.status='done' THEN 1 END) as done,
             COUNT(CASE WHEN t.status='pending' THEN 1 END) as pending,
             ROUND(AVG(CASE WHEN t.status='done' THEN t.quality_score END),1) as avgScore
      FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?
    `).get(req.params.id);
  } finally { db.close(); }

  // Try semantic search for relevant code
  try {
    const indexer = require('./indexer');
    recentCode = indexer.getRelevantContext(req.params.id, question, '');
  } catch {}

  const prompt = `Project: ${proj?.name || 'Unknown'} (${proj?.stack || 'node'})
${proj?.description ? 'Description: ' + proj.description : ''}
Tasks: ${taskStats?.done || 0} done, ${taskStats?.pending || 0} pending, avg score ${taskStats?.avgScore || 'N/A'}/10
${recentCode ? recentCode.slice(0, 600) : ''}
${code ? `\nCode:\n\`\`\`\n${code.slice(0, 1000)}\n\`\`\`` : ''}
${extraCtx ? `\nContext: ${extraCtx}` : ''}

Question: ${question}
Answer concisely and specifically:`;

  try {
    const start = Date.now();
    const result = await callOllama('qwen2.5-coder:3b', prompt, {
      num_predict: -1, temperature: 0.4, num_ctx: DEFAULT_CTX
    });
    res.json({ answer: result.response || '', duration: Date.now() - start, projectId: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Batch create from spec file ────────────────────────────────────────────
app.post('/build/from-spec', rateLimit(3), async (req, res) => {
  const { spec, autoRun = false } = req.body;
  // spec = { name, description, stack, epics: [{title, tasks:[]}] }
  if (!spec?.name || !spec?.epics?.length) {
    return res.status(400).json({ error: 'spec.name and spec.epics required' });
  }

  const db = DB();
  let projectId, epicIds = [];
  try {
    projectId = 'proj_' + Date.now();
    db.prepare(`INSERT INTO projects (id, name, description, stack, status, created_at)
      VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)`)
      .run(projectId, spec.name, spec.description || '', spec.stack || 'node');

    for (const epic of spec.epics) {
      const epicId = 'epic_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      db.prepare(`INSERT INTO epics (id, project_id, title, status) VALUES (?, ?, ?, 'pending')`)
        .run(epicId, projectId, epic.title);
      epicIds.push(epicId);
      for (const task of (epic.tasks || [])) {
        const title = typeof task === 'string' ? task : task.title;
        const desc = typeof task === 'object' ? task.description : `Implement: ${title}`;
        const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        db.prepare(`INSERT INTO tasks (id, epic_id, title, description, status, attempts, created_at)
          VALUES (?, ?, ?, ?, 'pending', 0, CURRENT_TIMESTAMP)`)
          .run(taskId, epicId, title, desc);
      }
    }
  } finally { db.close(); }

  const db2 = DB();
  let total;
  try {
    total = db2.prepare(`SELECT COUNT(*) as n FROM tasks t JOIN epics e ON t.epic_id=e.id WHERE e.project_id=?`).get(projectId).n;
  } finally { db2.close(); }

  res.json({ projectId, name: spec.name, totalTasks: total, message: `Created from spec with ${total} tasks` });

  if (autoRun) setImmediate(async () => {
    try {
      await fetch(`http://localhost:${PORT}/project/${projectId}/auto-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxFails: 3 })
      });
    } catch {}
  });
});

const PORT = process.env.FORGE_PORT || 3737;

// ── Provider Management Routes ─────────────────────────────────────────────
app.get('/providers', (req, res) => {
  const providers = loadProviders();
  // Return configs without exposing full API keys (mask them)
  const safe = {};
  for (const [name, cfg] of Object.entries(providers)) {
    safe[name] = { ...cfg, apiKey: cfg.apiKey ? cfg.apiKey.slice(0,6) + '••••' + cfg.apiKey.slice(-4) : '' };
  }
  // Always include ollama as a provider
  safe.ollama = { enabled: true, baseUrl: OLLAMA_URL, apiKey: '', models: _modelsBySize.map(m=>m.name) };
  res.json({ providers: safe });
});

app.post('/providers', (req, res) => {
  const { name, apiKey, baseUrl, enabled = true } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const providers = loadProviders();
  // Deduplicate key — if user accidentally pastes key multiple times (e.g. sk-or-v1-xxx repeated)
  let cleanKey = apiKey || providers[name]?.apiKey || '';
  if (cleanKey.length > 100) {
    // Try to detect repeating pattern: if the string is N copies of the same substring
    const half = Math.floor(cleanKey.length / 2);
    for (let len = 20; len <= half; len++) {
      const candidate = cleanKey.slice(0, len);
      if (cleanKey.split(candidate).join('') === '') { cleanKey = candidate; break; }
    }
  }
  providers[name] = { ...providers[name], enabled, apiKey: cleanKey, baseUrl: baseUrl || providers[name]?.baseUrl || '' };
  saveProviders(providers);
  res.json({ ok: true, name });
});

// Validate a provider API key by making a minimal chat request
app.get('/providers/:name/validate', async (req, res) => {
  const { name } = req.params;
  const providers = loadProviders();
  const pcfg = providers[name];
  if (!pcfg?.apiKey) return res.json({ valid: false, error: 'No API key saved' });

  try {
    if (name === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': pcfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
        signal: AbortSignal.timeout(10000)
      });
      if (r.ok) return res.json({ valid: true });
      const e = await r.json().catch(() => ({}));
      return res.json({ valid: false, error: e?.error?.message || `HTTP ${r.status}` });
    }

    // OpenAI-compatible providers
    const baseUrl = pcfg.baseUrl || (name === 'openai' ? 'https://api.openai.com/v1'
      : name === 'groq' ? 'https://api.groq.com/openai/v1'
      : name === 'google' ? 'https://generativelanguage.googleapis.com/v1beta/openai'
      : name === 'openrouter' ? 'https://openrouter.ai/api/v1'
      : pcfg.baseUrl || 'https://api.openai.com/v1');

    // Use a known cheap/free model per provider for validation
    const testModel = name === 'openrouter' ? 'meta-llama/llama-3.1-8b-instruct:free'
      : name === 'groq' ? 'llama-3.1-8b-instant'
      : name === 'google' ? 'gemini-1.5-flash'
      : 'gpt-4o-mini';

    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pcfg.apiKey}`, 'HTTP-Referer': 'http://localhost:3737', 'X-Title': 'Forge' },
      body: JSON.stringify({ model: testModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(15000)
    });
    if (r.ok) return res.json({ valid: true });
    const e = await r.json().catch(() => ({}));
    return res.json({ valid: false, error: e?.error?.message || `HTTP ${r.status}` });
  } catch(err) {
    return res.json({ valid: false, error: err.message });
  }
});

app.delete('/providers/:name', (req, res) => {
  const providers = loadProviders();
  delete providers[req.params.name];
  saveProviders(providers);
  res.json({ ok: true });
});

// Fetch available models from a specific provider
app.get('/providers/:name/models', async (req, res) => {
  const { name } = req.params;
  if (name === 'ollama') {
    return res.json({ models: _modelsBySize.map(m => ({ id: m.name, name: m.name, provider: 'ollama', size: m.size })) });
  }
  const providers = loadProviders();
  const pcfg = providers[name];
  if (!pcfg?.apiKey) return res.status(400).json({ error: 'Provider not configured or missing API key' });

  try {
    if (name === 'anthropic') {
      // Anthropic hardcoded (no list API without beta header complexity)
      return res.json({ models: [
        { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', provider: 'anthropic' },
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic' },
        { id: 'claude-haiku-3-5', name: 'Claude Haiku 3.5', provider: 'anthropic' },
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', provider: 'anthropic' },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
        { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', provider: 'anthropic' },
      ]});
    }
    // OpenAI-compatible list endpoint
    const baseUrl = pcfg.baseUrl || (name === 'openai' ? 'https://api.openai.com/v1'
      : name === 'groq' ? 'https://api.groq.com/openai/v1'
      : name === 'google' ? 'https://generativelanguage.googleapis.com/v1beta/openai'
      : name === 'openrouter' ? 'https://openrouter.ai/api/v1'
      : pcfg.baseUrl);
    const r = await fetch(`${baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${pcfg.apiKey}` },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    let models = (data.data || data.models || []).map(m => {
      const isFree = name === 'openrouter'
        ? (String(m.pricing?.prompt) === '0' && String(m.pricing?.completion) === '0') || (m.id||'').endsWith(':free')
        : false;
      return {
        id: m.id || m.name,
        name: m.name || m.id,
        provider: name,
        free: isFree,
        context: m.context_length || null,
        created: m.created,
        owned_by: m.owned_by
      };
    });

    // For OpenRouter: free models first, then sort alphabetically within each group
    if (name === 'openrouter') {
      models.sort((a, b) => {
        if (a.free && !b.free) return -1;
        if (!a.free && b.free) return 1;
        return (a.id||'').localeCompare(b.id||'');
      });
    }

    // Cache on provider config — store objects with free flag for frontend
    providers[name].models = models.map(m => m.id);
    providers[name].modelsMeta = models.map(m => ({ id: m.id, name: m.name, free: m.free, context: m.context }));
    saveProviders(providers);
    res.json({ models });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All models across all providers — used by chat model picker
app.get('/all-models', async (req, res) => {
  const providers = loadProviders();
  const all = [];
  // Local Ollama models
  for (const m of _modelsBySize) {
    all.push({ id: m.name, name: m.name, provider: 'ollama', size: m.size, local: true });
  }
  // Cloud providers
  for (const [pname, pcfg] of Object.entries(providers)) {
    if (!pcfg.enabled || !pcfg.apiKey) continue;
    if (pcfg.models) {
      const metaMap = {};
      (pcfg.modelsMeta || []).forEach(m => { metaMap[m.id] = m; });
      for (const mid of pcfg.models) {
        const meta = metaMap[mid] || {};
        all.push({ id: `${pname}/${mid}`, name: meta.name || mid, provider: pname, local: false, free: meta.free || false, context: meta.context || null });
      }
    }
  }
  res.json({ models: all });
});

app.listen(PORT, () => {
  console.log(`🔨 Forge API v3 on http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/`);
  console.log(`   New: security-audit, health, backup, cleanup, context, metrics, session-memory, templates`);
  console.log(`   Agents: ${Object.keys(PROMPTS).join(', ')}`);
});

// ── Periodic WAL checkpoint + auto-backup every 30 minutes ──────────────────
function runCheckpointAndBackup() {
  const dbFiles = ['project.db', 'agent_memory.db', 'prompts.db'];
  const backupDir = path.join(__dirname, '../backups');
  fs.mkdirSync(backupDir, { recursive: true });

  for (const dbFile of dbFiles) {
    try {
      const dbPath = path.join(__dirname, '../db', dbFile);
      if (!fs.existsSync(dbPath)) continue;
      const db2 = new Database(dbPath);
      db2.pragma('wal_checkpoint(TRUNCATE)');
      db2.close();

      // Copy to backups/ with date stamp — keep last 5 per file
      const stamp = new Date().toISOString().slice(0,10);
      const dest = path.join(backupDir, `${dbFile}.${stamp}.bak`);
      fs.copyFileSync(dbPath, dest);
    } catch(e) { console.error('Backup error for', dbFile, e.message); }
  }

  // Backup JSON files
  for (const jsonFile of ['providers.json', 'session-memory.json']) {
    try {
      const src = path.join(__dirname, '../db', jsonFile);
      if (!fs.existsSync(src)) continue;
      const stamp = new Date().toISOString().slice(0,10);
      const dest = path.join(backupDir, `${jsonFile}.${stamp}.bak`);
      fs.copyFileSync(src, dest);
    } catch(e) {}
  }

  // Prune old backups — keep only last 5 per base filename
  try {
    const allBaks = fs.readdirSync(backupDir).filter(f => f.endsWith('.bak'));
    const byBase = {};
    for (const f of allBaks) {
      const base = f.replace(/\.\d{4}-\d{2}-\d{2}\.bak$/, '');
      if (!byBase[base]) byBase[base] = [];
      byBase[base].push(f);
    }
    for (const [, files] of Object.entries(byBase)) {
      files.sort();
      while (files.length > 5) {
        const old = files.shift();
        try { fs.unlinkSync(path.join(backupDir, old)); } catch {}
      }
    }
  } catch {}

  console.log(`[backup] Checkpoint + backup complete at ${new Date().toISOString()}`);
}

// Run once at startup (after 60s delay so the server is fully up), then every 30 min
setTimeout(runCheckpointAndBackup, 60_000);
setInterval(runCheckpointAndBackup, 30 * 60_000);
