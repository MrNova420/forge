// Memory & RAG system — short-term buffer + long-term vector search
// Uses vectra (pure-JS vector store) as fallback when ChromaDB unavailable
const fs = require('fs');
const path = require('path');
const { LocalIndex } = require('vectra');
const { embed, generate } = require('./ollama');
const Database = require('better-sqlite3');

const MEMORY_DIR = path.join(__dirname, '../memory');
const DB_PATH = path.join(__dirname, '../db/agent_memory.db');

// ── Short-term Buffer ─────────────────────────────────────────────────────────

class ContextBuffer {
  constructor(maxTokens = 2000) {
    this.messages = [];
    this.maxTokens = maxTokens;
  }

  add(role, content) {
    this.messages.push({ role, content, ts: Date.now(), tokens: Math.ceil(content.length / 4) });
    this._trim();
  }

  _trim() {
    let total = this.messages.reduce((s, m) => s + m.tokens, 0);
    while (total > this.maxTokens && this.messages.length > 1) {
      total -= this.messages.shift().tokens;
    }
  }

  get(n = 10) {
    return this.messages.slice(-n).map(m => `[${m.role}]: ${m.content}`).join('\n');
  }

  clear() { this.messages = []; }
  size() { return this.messages.length; }
}

// ── Vector Store (vectra — pure JS, no Python needed) ────────────────────────

class VectorMemory {
  constructor(namespace = 'forge') {
    this.indexPath = path.join(MEMORY_DIR, 'vectra', namespace);
    this.index = new LocalIndex(this.indexPath);
    this.namespace = namespace;
  }

  async init() {
    if (!await this.index.isIndexCreated()) {
      await this.index.createIndex();
    }
  }

  async store(text, metadata = {}) {
    await this.init();
    try {
      const vector = await embed(text);
      await this.index.insertItem({
        vector,
        metadata: { text, ts: Date.now(), ...metadata }
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async search(query, topK = 5) {
    await this.init();
    try {
      const vector = await embed(query);
      const results = await this.index.queryItems(vector, topK);
      return results.map(r => ({
        text: r.item.metadata.text,
        score: r.score,
        metadata: r.item.metadata
      }));
    } catch (e) {
      return [];
    }
  }

  async storeCode(filePath, content, projectId) {
    // Split code into chunks and index each
    const chunks = chunkCode(content);
    for (const chunk of chunks) {
      await this.store(chunk, { type: 'code', filePath, projectId });
    }
    return { ok: true, chunks: chunks.length };
  }
}

function chunkCode(content, chunkSize = 400) {
  const lines = content.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    chunks.push(lines.slice(i, i + chunkSize).join('\n'));
  }
  return chunks.filter(c => c.trim().length > 20);
}

// ── Long-term Memory Manager ──────────────────────────────────────────────────

class MemoryManager {
  constructor() {
    this.buffers = new Map();      // agentRole → ContextBuffer
    this.vectors = new VectorMemory('forge');
    this.db = new Database(DB_PATH);
  }

  // Get or create short-term buffer for an agent
  getBuffer(agentRole) {
    if (!this.buffers.has(agentRole)) {
      this.buffers.set(agentRole, new ContextBuffer(2000));
    }
    return this.buffers.get(agentRole);
  }

  // Add to agent's short-term memory
  remember(agentRole, role, content) {
    this.getBuffer(agentRole).add(role, content);
  }

  // Get recent context for an agent
  getContext(agentRole, n = 6) {
    return this.getBuffer(agentRole).get(n);
  }

  // Store something in long-term vector memory
  async storeKnowledge(text, metadata = {}) {
    return this.vectors.store(text, metadata);
  }

  // Search long-term memory for relevant context
  async recall(query, topK = 4) {
    const results = await this.vectors.search(query, topK);
    if (!results.length) return '';
    return '=== RELEVANT CONTEXT FROM MEMORY ===\n' +
      results.map((r, i) => `[${i+1}] (relevance: ${r.score.toFixed(2)})\n${r.text}`).join('\n\n');
  }

  // Store code file in vector memory for RAG
  async indexCode(filePath, content, projectId) {
    return this.vectors.storeCode(filePath, content, projectId);
  }

  // Summarize agent history to compress context
  async summarize(agentRole) {
    const buffer = this.getBuffer(agentRole);
    if (buffer.size() < 4) return null;
    const context = buffer.get(20);
    const summary = await generate(
      `Summarize this conversation history in 3-5 bullet points, keeping key decisions and outputs:\n\n${context}`,
      { temperature: 0.1 }
    );
    // Replace buffer with summary
    buffer.clear();
    buffer.add('system', `[COMPRESSED HISTORY SUMMARY]\n${summary.text}`);
    return summary.text;
  }

  // Store error pattern for self-improvement
  recordError(agentRole, errorText, context = '') {
    try {
      const existing = this.db.prepare(
        `SELECT id, frequency FROM error_patterns WHERE agent=? AND pattern=?`
      ).get(agentRole, errorText.slice(0, 200));

      if (existing) {
        this.db.prepare(`UPDATE error_patterns SET frequency=frequency+1, last_seen=CURRENT_TIMESTAMP WHERE id=?`)
          .run(existing.id);
      } else {
        this.db.prepare(`INSERT INTO error_patterns (agent, pattern, fix_strategy) VALUES (?,?,?)`)
          .run(agentRole, errorText.slice(0, 200), context.slice(0, 500));
      }
    } catch (e) { /* non-critical */ }
  }

  // Get top error patterns for an agent (for self-improvement)
  getTopErrors(agentRole, limit = 5) {
    return this.db.prepare(
      `SELECT pattern, frequency, fix_strategy FROM error_patterns WHERE agent=? ORDER BY frequency DESC LIMIT ?`
    ).all(agentRole, limit);
  }

  close() { this.db.close(); }
}

// Singleton
const memoryManager = new MemoryManager();
module.exports = { MemoryManager, ContextBuffer, VectorMemory, memoryManager };
