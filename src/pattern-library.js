'use strict';
const fs = require('fs');
const path = require('path');

const PATTERN_FILE = path.join(__dirname, '../db/patterns.json');

// Built-in seed patterns — proven working code snippets
const SEED_PATTERNS = [
  {
    id: 'express-route',
    name: 'Express Route Handler',
    tags: ['node', 'api', 'express', 'route'],
    description: 'Express route with error handling and validation',
    useCount: 0, avgScore: 0,
    code: `FILE: src/routes/example.js
const express = require('express');
const router = express.Router();

/**
 * GET /example/:id - Get item by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'ID required' });
    // implementation here
    res.json({ id, data: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;`
  },
  {
    id: 'async-db',
    name: 'SQLite DB Query Helper',
    tags: ['node', 'database', 'sqlite', 'async'],
    description: 'Async database query with error handling',
    useCount: 0, avgScore: 0,
    code: `FILE: src/db/query.js
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../../data/app.db'));

/**
 * Query helper with automatic statement preparation
 */
function query(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    return sql.trim().toUpperCase().startsWith('SELECT') 
      ? stmt.all(params) 
      : stmt.run(params);
  } catch (err) {
    throw new Error(\`DB query failed: \${err.message}\`);
  }
}

module.exports = { query, db };`
  },
  {
    id: 'input-validator',
    name: 'Input Validation Middleware',
    tags: ['node', 'validation', 'middleware'],
    description: 'Input validation middleware',
    useCount: 0, avgScore: 0,
    code: `FILE: src/middleware/validate.js
/**
 * Creates validation middleware for request body fields
 * @param {string[]} required - Required field names
 */
function validateBody(required = []) {
  return (req, res, next) => {
    const missing = required.filter(field => !req.body[field]);
    if (missing.length > 0) {
      return res.status(400).json({ error: \`Missing required fields: \${missing.join(', ')}\` });
    }
    next();
  };
}

module.exports = { validateBody };`
  },
  {
    id: 'cli-command',
    name: 'CLI Command with Arg Parsing',
    tags: ['node', 'cli', 'command'],
    description: 'CLI command with argument parsing',
    useCount: 0, avgScore: 0,
    code: `FILE: src/cli/command.js
#!/usr/bin/env node
'use strict';

const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    flags[key] = args[i+1] && !args[i+1].startsWith('--') ? args[++i] : true;
  } else {
    positional.push(args[i]);
  }
}

async function main() {
  try {
    if (flags.help || positional[0] === 'help') {
      console.log('Usage: command [options]');
      process.exit(0);
    }
    // implementation
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();`
  },
  {
    id: 'test-suite',
    name: 'Node.js Test Suite',
    tags: ['node', 'test', 'testing'],
    description: 'Node.js test suite template',
    useCount: 0, avgScore: 0,
    code: `FILE: tests/example.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('Module tests', () => {
  test('should handle valid input', () => {
    // Arrange
    const input = 'test';
    // Act  
    const result = input.toUpperCase();
    // Assert
    assert.strictEqual(result, 'TEST');
  });

  test('should handle invalid input gracefully', () => {
    assert.throws(() => {
      if (!input) throw new Error('Input required');
    }, /Input required/);
  });

  test('should handle async operations', async () => {
    const result = await Promise.resolve(42);
    assert.strictEqual(result, 42);
  });
});`
  },
  {
    id: 'error-handler',
    name: 'Express Error Handler',
    tags: ['error', 'express', 'middleware'],
    description: 'Global error handling middleware for Express',
    useCount: 0, avgScore: 0,
    code: `FILE: src/middleware/errorHandler.js
/**
 * Global Express error handling middleware.
 * Must be registered AFTER all routes: app.use(errorHandler)
 */
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  console.error(\`[\${new Date().toISOString()}] \${req.method} \${req.path} — \${err.message}\`);
  res.status(status).json({
    error: err.message || 'Internal server error',
    status,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
}

module.exports = errorHandler;`
  },
  {
    id: 'config-loader',
    name: 'Config Loader',
    tags: ['config', 'env', 'validation'],
    description: 'Load and validate config from env with defaults',
    useCount: 0, avgScore: 0,
    code: `FILE: src/config.js
'use strict';

/**
 * Application configuration loaded from environment variables.
 * All secrets/settings must come from env — never hardcode values.
 */
const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  dbPath: process.env.DB_PATH || './db/app.db',
  debug: process.env.DEBUG === 'true',
  nodeEnv: process.env.NODE_ENV || 'development',
};

// Validate required fields
const required = [];
const missing = required.filter(k => !config[k]);
if (missing.length > 0) throw new Error(\`Missing required env vars: \${missing.join(', ')}\`);

module.exports = config;`
  },
  {
    id: 'retry-helper',
    name: 'Async Retry Helper',
    tags: ['async', 'retry', 'resilience'],
    description: 'Retry an async function N times with exponential backoff',
    useCount: 0, avgScore: 0,
    code: `FILE: src/utils/retry.js
/**
 * Retry an async function up to maxAttempts times with exponential backoff.
 * @param {Function} fn - Async function to retry
 * @param {number} maxAttempts - Max retry attempts (default 3)
 * @param {number} delayMs - Base delay in ms (doubles each retry, default 500)
 */
async function withRetry(fn, maxAttempts = 3, delayMs = 500) {
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxAttempts - 1) throw err;
      const wait = delayMs * Math.pow(2, i);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

module.exports = { withRetry };`
  }
];

function loadPatterns() {
  try {
    if (fs.existsSync(PATTERN_FILE)) {
      return JSON.parse(fs.readFileSync(PATTERN_FILE, 'utf8'));
    }
  } catch(e) {}
  return { patterns: [...SEED_PATTERNS], savedAt: new Date().toISOString() };
}

function savePatterns(data) {
  fs.mkdirSync(path.dirname(PATTERN_FILE), { recursive: true });
  fs.writeFileSync(PATTERN_FILE, JSON.stringify(data, null, 2));
}

/**
 * Find relevant patterns for a task by matching tags/keywords
 */
function findRelevantPatterns(taskTitle, projectStack, limit = 2) {
  const data = loadPatterns();
  const query = (taskTitle + ' ' + projectStack).toLowerCase();

  const scored = data.patterns.map(p => {
    let score = 0;
    for (const tag of p.tags) {
      if (query.includes(tag)) score += 2;
    }
    const descWords = p.description.toLowerCase().split(' ');
    for (const word of descWords) {
      if (word.length > 3 && query.includes(word)) score += 1;
    }
    return { ...p, relevance: score };
  }).filter(p => p.relevance > 0).sort((a, b) => b.relevance - a.relevance);

  return scored.slice(0, limit);
}

/**
 * Add a new pattern from a high-scoring task result
 */
function addPattern(pattern) {
  const data = loadPatterns();
  const existing = data.patterns.find(p => p.id === pattern.id);
  if (!existing) {
    data.patterns.push({ ...pattern, addedAt: new Date().toISOString() });
    savePatterns(data);
  }
}

/**
 * Format patterns as prompt context
 */
function getPatternsContext(taskTitle, stack) {
  const patterns = findRelevantPatterns(taskTitle, stack);
  if (patterns.length === 0) return '';
  return '\nRELEVANT CODE PATTERNS (use as reference):\n' +
    patterns.map(p => `--- ${p.description} ---\n${p.code.substring(0, 400)}`).join('\n\n') + '\n';
}

module.exports = { findRelevantPatterns, addPattern, getPatternsContext, loadPatterns };
