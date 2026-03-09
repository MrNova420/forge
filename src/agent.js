// Base Agent class — all agents extend this
const { generate, chat } = require('./ollama');
const { multipass } = require('./multipass');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../db/agent_memory.db');

// Model resolver — injected by server.js to keep agent.js dependency-free
let _modelResolver = null;
function setModelResolver(fn) { _modelResolver = fn; }

function resolveModel(role, fallback = 'qwen2.5-coder:3b') {
  if (_modelResolver) return _modelResolver(role) || fallback;
  return fallback;
}

class Agent {
  constructor(role, systemPrompt, opts = {}) {
    this.role = role;
    this.systemPrompt = systemPrompt;
    // Use role-based model resolver if no explicit model provided
    this.model = opts.model || resolveModel(role);
    this.memory = []; // short-term conversation buffer
    this.maxMemory = opts.maxMemory || 10;
    this.db = new Database(DB_PATH);
  }

  // Core: think + act with multi-pass quality loop
  async run(task, opts = {}) {
    const { useMultipass = true, minScore = 7, rounds = 3, taskId = null, model } = opts;
    // Allow per-call model override (constructor default used otherwise)
    if (model) this.model = model;
    console.log(`[${this.role}] Starting task: ${task.slice(0, 80)}...`);

    let result;
    if (useMultipass) {
      result = await multipass(task, this.systemPrompt, {
        rounds, minScore, model: this.model, verbose: true
      });
      this._log(task, result.output, taskId);
      await this._reflect(task, result.output, result.score, taskId);
      return result;
    } else {
      const raw = await generate(task, { system: this.systemPrompt, model: this.model });
      this._log(task, raw.text, taskId);
      return { output: raw.text, score: null, rounds: 1 };
    }
  }

  // Add to short-term memory buffer
  remember(role, content) {
    this.memory.push({ role, content, ts: Date.now() });
    if (this.memory.length > this.maxMemory) this.memory.shift();
  }

  // Build context string from memory
  getContext() {
    return this.memory.map(m => `[${m.role}]: ${m.content}`).join('\n');
  }

  // Inject a context refresh message to keep agents oriented during long sessions
  refreshContext(projectSummary, recentTasks = []) {
    const refreshMsg = [
      '=== CONTEXT REFRESH ===',
      projectSummary ? `Project: ${projectSummary}` : '',
      recentTasks.length ? `Recent work:\n${recentTasks.slice(-5).map(t => `- ${t}`).join('\n')}` : '',
      '=== END REFRESH ==='
    ].filter(Boolean).join('\n');

    // Insert at start of memory so it's always visible
    this.memory.unshift({ role: 'system', content: refreshMsg });
    if (this.memory.length > this.maxMemory) this.memory = this.memory.slice(0, this.maxMemory);
  }

  // Returns true when memory is ≥80% full (time to refresh)
  shouldRefresh() {
    return this.memory.length >= Math.floor(this.maxMemory * 0.8);
  }

  // Self-reflection — agent scores its own output
  async _reflect(task, output, existingScore, taskId) {
    const score = existingScore !== null ? existingScore : await this._selfScore(task, output);
    this.db.prepare(
      `INSERT INTO reflection_scores (agent, task_id, score, reasoning) VALUES (?, ?, ?, ?)`
    ).run(this.role, taskId || 'unknown', score, `Auto-scored after task completion`);
    return score;
  }

  async _selfScore(task, output) {
    try {
      const prompt = `Rate this output 1-10 for quality, correctness, and completeness.\nTASK: ${task.slice(0,200)}\nOUTPUT: ${output.slice(0,500)}\nRespond with JSON: {"score": N}`;
      const raw = await generate(prompt, { model: this.model, temperature: 0.1 });
      const match = raw.text.match(/\{"score":\s*(\d+)/);
      return match ? parseInt(match[1]) : 5;
    } catch { return 5; }
  }

  // Log to agent_memory.db
  _log(task, output, taskId) {
    this.db.prepare(
      `INSERT INTO agent_history (agent, role, content, task_id) VALUES (?, ?, ?, ?)`
    ).run(this.role, 'user', task, taskId || 'unknown');
    this.db.prepare(
      `INSERT INTO agent_history (agent, role, content, task_id) VALUES (?, ?, ?, ?)`
    ).run(this.role, 'assistant', output, taskId || 'unknown');
  }

  // Get average quality score for this agent
  getAverageScore() {
    const row = this.db.prepare(
      `SELECT AVG(score) as avg FROM reflection_scores WHERE agent = ?`
    ).get(this.role);
    return row?.avg?.toFixed(2) || 'N/A';
  }

  close() { this.db.close(); }
}

module.exports = { Agent, setModelResolver };
