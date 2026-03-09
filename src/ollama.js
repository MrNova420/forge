// Ollama API wrapper — all inference goes through here
const fetch = require('node-fetch');
const { jsonrepair } = require('jsonrepair');

const BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.FORGE_MODEL || 'qwen2.5-coder:3b';

// ── VRAM Model Manager ───────────────────────────────────────────────────────
// Tracks which model is currently loaded in VRAM and handles clean swaps.
// GTX 1650 SUPER has only 4GB — only one model should be in VRAM at a time.
let _loadedModel = null;  // tracks currently hot model

// Evict a model from VRAM entirely.
// CRITICAL: Ollama only honours keep_alive:0 when it actually processes a request.
// Empty prompt/messages are silently ignored — must send real content.
// We await the chat request (stream:false) so eviction is confirmed before returning.
async function unloadModel(model) {
  if (!model) return;
  console.log(`[vram] 🔄 Unloading ${model} from VRAM...`);
  try {
    // Use /api/chat with a real message + keep_alive:0 + stream:false.
    // Ollama processes it, then immediately unloads the model because keep_alive:0.
    await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        keep_alive: 0,
        stream: false,
        options: { num_predict: 1 }
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (_loadedModel === model) _loadedModel = null;
    console.log(`[vram] ✅ ${model} unloaded`);
  } catch (err) {
    console.warn(`[vram] ⚠ Could not unload ${model}: ${err.message}`);
  }
}

// Swap VRAM: unload current model, load next model.
// Call this before switching between architect and coder.
async function swapModel(toModel) {
  if (_loadedModel && _loadedModel !== toModel) {
    await unloadModel(_loadedModel);
    await sleep(500); // brief pause so ollama fully frees VRAM
  }
  _loadedModel = toModel;
  console.log(`[vram] 🟢 Active model: ${toModel}`);
}

// Query which models ollama actually has loaded right now
async function getLoadedModels() {
  try {
    const res = await fetch(`${BASE_URL}/api/ps`, { timeout: 5000 });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => ({ name: m.name, vram: m.size_vram }));
  } catch { return []; }
}

// GPU temperature check — throttles inference if GPU is running hot
async function getGPUTemp() {
  const { execSync } = require('child_process');
  try {
    const out = execSync('nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
    return parseInt(out.trim()) || 0;
  } catch { return 0; }
}

async function gpuThrottle() {
  const temp = await getGPUTemp();
  if (temp >= 85) {
    console.log(`[gpu] 🌡 ${temp}°C — pausing 30s to cool down`);
    await sleep(30000);
  } else if (temp >= 78) {
    console.log(`[gpu] 🌡 ${temp}°C — slowing down (3s delay)`);
    await sleep(3000);
  }
  return temp;
}

// qwen2.5-coder:3b (1.9GB Q4_K_M) + KV cache on GTX 1650S (4GB VRAM):
//   4096 ctx  → ~0.4GB KV  → ~2.3GB total → pure GPU ✅ fast
//   8192 ctx  → ~0.8GB KV  → ~2.7GB total → pure GPU ✅ still fits
//  16384 ctx  → ~1.6GB KV  → ~3.5GB total → pure GPU ✅ fits (small model = small KV)
//  32768 ctx  → ~3.2GB KV  → ~5.1GB total → ~1.1GB spills to RAM ⚠ (some slowdown)
//
// deepseek-r1:1.5b (1.1GB Q4_K_M) — used as architect/planner only:
//  32768 ctx  → ~3.2GB KV  → ~4.3GB total → fits GPU ✅
//  65536 ctx  → ~6.4GB KV  → ~7.5GB total → ~3.5GB spills to RAM (slow but works)
// 131072 ctx  → ~12.8GB KV → mostly RAM   (very slow — use only for large project planning)
//
// Use 16384 as default — full context for deep dev tasks, stays on GPU.
// For large codebases / context relay, 32768 is fine (only slight RAM spill).
const DEFAULT_CTX  = 16384; // qwen2.5-coder fits fully on GPU at 16k ctx
const LARGE_CTX    = 32768; // full 32k — minor RAM spill (~1.1GB), acceptable for summaries
const MAX_PREDICT  = -1;    // unlimited — model stops at EOS naturally

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Rough token estimator: ~3.5 chars per token for code, 4 for prose
function estimateTokens(text) { return Math.ceil((text || '').length / 3.8); }

// Smart prompt builder: given a list of segments (most important first),
// fill up to targetTokens budget while keeping each segment whole.
function buildPrompt(segments, targetTokens = 5000) {
  const parts = [];
  let used = 0;
  for (const seg of segments) {
    if (!seg) continue;
    const t = estimateTokens(seg);
    if (used + t > targetTokens && parts.length > 0) {
      // Try to fit a trimmed version of lower-priority segments
      const remaining = targetTokens - used;
      const chars = Math.floor(remaining * 3.8);
      if (chars > 100) parts.push(seg.slice(0, chars) + '\n…[trimmed for context]');
      break;
    }
    parts.push(seg);
    used += t;
  }
  return parts.join('\n\n');
}

async function generate(prompt, opts = {}) {
  const { model = DEFAULT_MODEL, system, temperature = 0.2, maxRetries = 3,
          numCtx = DEFAULT_CTX, forceJson = false } = opts;

  // Clean VRAM swap — evict previous model if switching to a different one
  if (_loadedModel && _loadedModel !== model) {
    await swapModel(model);
  } else {
    _loadedModel = model;
  }

  const body = {
    model,
    prompt,
    stream: false,
    keep_alive: -1,
    options: {
      temperature,
      num_gpu: 99,
      num_ctx: numCtx,
      num_predict: MAX_PREDICT,
      repeat_penalty: 1.1
    }
  };
  if (system) body.system = system;
  if (forceJson) body.format = 'json';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const t0 = Date.now();
      const res = await fetch(`${BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 900000
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const durationMs = Date.now() - t0;
      const tokOut = data.eval_count || 0;
      const tokIn  = data.prompt_eval_count || 0;
      const tokPerSec = tokOut > 0 && data.eval_duration > 0
        ? Math.round((tokOut / data.eval_duration) * 1e9 * 10) / 10
        : 0;
      await sleep(800);
      return {
        text: data.response.trim(),
        model,
        tokens: tokOut,
        promptTokens: tokIn,
        durationMs,
        tokPerSec,
        // Emit benchmark event for listeners (server.js records to DB)
        _bench: { model, tokIn, tokOut, durationMs, tokPerSec }
      };
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(2000 * attempt);
    }
  }
}

async function chat(messages, opts = {}) {
  const { model = DEFAULT_MODEL, temperature = 0.2, maxRetries = 3,
          numCtx = DEFAULT_CTX } = opts;

  // Clean VRAM swap — evict previous model if switching to a different one
  if (_loadedModel && _loadedModel !== model) {
    await swapModel(model);
  } else {
    _loadedModel = model;
  }

  const body = {
    model,
    messages,
    stream: false,
    keep_alive: -1,
    options: { temperature, num_gpu: 99, num_ctx: numCtx, num_predict: MAX_PREDICT, repeat_penalty: 1.1 }
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const t0 = Date.now();
      const res = await fetch(`${BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 900000
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const durationMs = Date.now() - t0;
      const tokOut = data.eval_count || 0;
      const tokIn  = data.prompt_eval_count || 0;
      const tokPerSec = tokOut > 0 && data.eval_duration > 0
        ? Math.round((tokOut / data.eval_duration) * 1e9 * 10) / 10 : 0;
      await sleep(800);
      return {
        text: data.message.content.trim(), model,
        tokens: tokOut, promptTokens: tokIn, durationMs, tokPerSec,
        _bench: { model, tokIn, tokOut, durationMs, tokPerSec }
      };
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(2000 * attempt);
    }
  }
}

// ── Context Relay ────────────────────────────────────────────────────────────
// Summarise a long development session into a compact handoff for the next agent.
// Uses a fresh context so the summariser isn't affected by accumulated state.
async function summariseSession(sessionText, role, opts = {}) {
  const prompt = `You are summarising a ${role} agent's development session for handoff.\nExtract:\n1. What was built (filename, key functions/classes)\n2. What works correctly\n3. What still needs improvement\n4. Key design decisions made\n\nSESSION:\n${sessionText.slice(0, 12000)}\n\nWrite a concise handoff summary (max 400 words):`;
  return await generate(prompt, { ...opts, numCtx: 4096, temperature: 0.1 });
}

async function embed(text, opts = {}) {
  const { model = 'nomic-embed-text' } = opts;
  const res = await fetch(`${BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text })
  });
  if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
  const data = await res.json();
  return data.embedding;
}

async function generateJSON(prompt, schema, opts = {}) {
  const schemaStr = JSON.stringify(schema, null, 2);
  const wrappedPrompt = `${prompt}\n\nRespond ONLY with valid JSON matching this schema:\n${schemaStr}\n\nJSON response:`;
  for (let i = 0; i < 3; i++) {
    const result = await generate(wrappedPrompt, { ...opts, temperature: 0.1 });
    try {
      const match = result.text.match(/\{[\s\S]*\}/);
      if (match) {
        try { return { ...result, json: JSON.parse(match[0]) }; }
        catch { return { ...result, json: JSON.parse(jsonrepair(match[0])) }; }
      }
    } catch {}
  }
  throw new Error('Failed to get valid JSON after 3 attempts');
}

module.exports = { generate, chat, embed, generateJSON, sleep, summariseSession, buildPrompt, estimateTokens, getGPUTemp, gpuThrottle, unloadModel, swapModel, getLoadedModels, DEFAULT_MODEL, DEFAULT_CTX, LARGE_CTX };

