'use strict';
const fetch = require('node-fetch');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

let _nomicAvailable = null;

async function checkNomic() {
  if (_nomicAvailable !== null) return _nomicAvailable;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const d = await r.json();
    _nomicAvailable = (d.models || []).some(m => m.name.includes('nomic'));
    return _nomicAvailable;
  } catch(e) { _nomicAvailable = false; return false; }
}

/**
 * Get embedding vector for text.
 * Uses nomic-embed-text if available, falls back to keyword TF-IDF style hash.
 */
async function embed(text) {
  const hasNomic = await checkNomic();
  if (hasNomic) {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: text.substring(0, 512) })
      });
      const d = await r.json();
      if (d.embedding) return { vector: d.embedding, method: 'nomic' };
    } catch(e) {}
  }
  // Fallback: keyword frequency vector (128 dims)
  return { vector: keywordVector(text), method: 'keyword' };
}

function keywordVector(text, dims = 128) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const vec = new Array(dims).fill(0);
  for (const word of words) {
    let hash = 5381;
    for (let i = 0; i < word.length; i++) hash = ((hash << 5) + hash) ^ word.charCodeAt(i);
    vec[Math.abs(hash) % dims] += 1;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / mag);
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; magA += a[i]*a[i]; magB += b[i]*b[i]; }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

module.exports = { embed, cosineSimilarity, checkNomic, keywordVector };
