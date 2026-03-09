'use strict';
const fs = require('fs');
const path = require('path');
const { embed, cosineSimilarity } = require('./embeddings');

const KB_FILE = path.join(__dirname, '../db/knowledge-base.json');

function loadKB() {
  try {
    if (fs.existsSync(KB_FILE)) return JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
  } catch(e) {}
  return { entries: [], version: 1 };
}

function saveKB(kb) {
  fs.mkdirSync(path.dirname(KB_FILE), { recursive: true });
  fs.writeFileSync(KB_FILE, JSON.stringify(kb, null, 2));
}

/**
 * Add an entry to the knowledge base
 */
async function addKnowledge(type, title, content, tags = []) {
  const kb = loadKB();
  const { vector } = await embed(title + ' ' + content.substring(0, 200));
  const entry = {
    id: `kb_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    type, // 'decision', 'pattern', 'error', 'learning', 'architecture'
    title,
    content: content.substring(0, 1000),
    tags,
    vector,
    createdAt: new Date().toISOString()
  };
  kb.entries.push(entry);
  // Keep max 500 entries, remove oldest
  if (kb.entries.length > 500) kb.entries = kb.entries.slice(-500);
  saveKB(kb);
  return entry.id;
}

/**
 * Search knowledge base by semantic similarity
 */
async function searchKnowledge(query, topK = 5, typeFilter = null) {
  const kb = loadKB();
  if (kb.entries.length === 0) return [];

  const { vector: queryVec } = await embed(query);

  let entries = kb.entries;
  if (typeFilter) entries = entries.filter(e => e.type === typeFilter);

  const scored = entries.map(e => ({
    ...e,
    similarity: e.vector ? cosineSimilarity(queryVec, e.vector) : 0
  })).sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, topK).map(e => ({
    id: e.id, type: e.type, title: e.title,
    content: e.content.substring(0, 300), tags: e.tags, similarity: e.similarity
  }));
}

/**
 * Get knowledge context for a task (formatted for prompt injection)
 */
async function getKnowledgeContext(taskTitle, stack) {
  const results = await searchKnowledge(`${taskTitle} ${stack}`, 3);
  if (results.length === 0) return '';
  const relevant = results.filter(r => r.similarity > 0.1);
  if (relevant.length === 0) return '';
  return '\nTEAM KNOWLEDGE:\n' + relevant.map(r =>
    `[${r.type.toUpperCase()}] ${r.title}: ${r.content.substring(0, 200)}`
  ).join('\n') + '\n';
}

function getAllKnowledge() { return loadKB(); }
function getStats() {
  const kb = loadKB();
  const byType = {};
  for (const e of kb.entries) byType[e.type] = (byType[e.type]||0) + 1;
  return { total: kb.entries.length, byType };
}

module.exports = { addKnowledge, searchKnowledge, getKnowledgeContext, getAllKnowledge, getStats };
