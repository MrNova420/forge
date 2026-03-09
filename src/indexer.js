'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const INDEX_DB = path.join(__dirname, '../db/code-index.db');

function getIndexDB() {
  const db = new Database(INDEX_DB);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_type TEXT NOT NULL,   -- 'function', 'class', 'block', 'comment', 'imports'
      name TEXT,                   -- function/class name if applicable
      content TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      lang TEXT,
      indexed_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_project ON code_chunks(project_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_path);
    
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      id UNINDEXED,
      project_id UNINDEXED,
      name,
      content,
      file_path UNINDEXED,
      content=code_chunks,
      content_rowid=rowid
    );
    
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON code_chunks BEGIN
      INSERT INTO chunks_fts(rowid, id, project_id, name, content, file_path)
        VALUES (new.rowid, new.id, new.project_id, new.name, new.content, new.file_path);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON code_chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, id, project_id, name, content, file_path)
        VALUES ('delete', old.rowid, old.id, old.project_id, old.name, old.content, old.file_path);
    END;
  `);
  return db;
}

// Detect language from extension
function detectLang(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = { '.js': 'javascript', '.ts': 'typescript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.php': 'php', '.cs': 'csharp', '.cpp': 'cpp', '.c': 'c', '.sh': 'bash', '.md': 'markdown', '.json': 'json' };
  return map[ext] || 'text';
}

// Split code into meaningful chunks
function chunkCode(content, lang, filePath) {
  const lines = content.split('\n');
  const chunks = [];
  const fileBase = path.basename(filePath);
  
  // Always add imports/header chunk (first 20 lines if they have imports)
  const headerLines = lines.slice(0, Math.min(20, lines.length));
  const hasImports = headerLines.some(l => /^(import|require|from|#include|use )/.test(l.trim()));
  if (hasImports) {
    chunks.push({ type: 'imports', name: `${fileBase}:imports`, content: headerLines.join('\n'), lineStart: 1, lineEnd: headerLines.length });
  }
  
  if (lang === 'javascript' || lang === 'typescript') {
    // Extract functions
    const fnPattern = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?.*?\)?\s*=>/gm;
    let match;
    while ((match = fnPattern.exec(content)) !== null) {
      const name = match[1] || match[2];
      const startLine = content.slice(0, match.index).split('\n').length;
      // Find the function body end (simple heuristic: next blank line after 3+ lines)
      const fnLines = lines.slice(startLine - 1, startLine + 40);
      const fnContent = fnLines.join('\n');
      chunks.push({ type: 'function', name, content: fnContent.slice(0, 800), lineStart: startLine, lineEnd: startLine + fnLines.length });
    }
    
    // Extract classes
    const classPattern = /^(?:export\s+)?class\s+(\w+)/gm;
    while ((match = classPattern.exec(content)) !== null) {
      const name = match[1];
      const startLine = content.slice(0, match.index).split('\n').length;
      const classLines = lines.slice(startLine - 1, startLine + 60);
      chunks.push({ type: 'class', name, content: classLines.join('\n').slice(0, 1200), lineStart: startLine, lineEnd: startLine + classLines.length });
    }
  } else if (lang === 'python') {
    const fnPattern = /^(?:async\s+)?def\s+(\w+)/gm;
    const classPattern = /^class\s+(\w+)/gm;
    let match;
    while ((match = fnPattern.exec(content)) !== null) {
      const name = match[1];
      const startLine = content.slice(0, match.index).split('\n').length;
      const fnLines = lines.slice(startLine - 1, startLine + 30);
      chunks.push({ type: 'function', name, content: fnLines.join('\n').slice(0, 800), lineStart: startLine, lineEnd: startLine + fnLines.length });
    }
    while ((match = classPattern.exec(content)) !== null) {
      const name = match[1];
      const startLine = content.slice(0, match.index).split('\n').length;
      const classLines = lines.slice(startLine - 1, startLine + 50);
      chunks.push({ type: 'class', name, content: classLines.join('\n').slice(0, 1200), lineStart: startLine, lineEnd: startLine + classLines.length });
    }
  }
  
  // If no structural chunks found, chunk by blocks of 50 lines
  if (chunks.length <= (hasImports ? 1 : 0)) {
    for (let i = 0; i < lines.length; i += 50) {
      const blockLines = lines.slice(i, i + 50);
      chunks.push({ type: 'block', name: `${fileBase}:L${i+1}-${i+50}`, content: blockLines.join('\n'), lineStart: i + 1, lineEnd: i + blockLines.length });
    }
  }
  
  return chunks;
}

// Index a single project directory
function indexProject(projectId, projectPath) {
  if (!fs.existsSync(projectPath)) return { indexed: 0, files: 0, error: 'path not found' };
  
  const db = getIndexDB();
  try {
    // Clear existing index for this project
    db.prepare('DELETE FROM code_chunks WHERE project_id=?').run(projectId);
    
    const exts = ['.js', '.ts', '.py', '.go', '.rs', '.java', '.rb', '.sh', '.md'];
    const ignorePatterns = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'coverage'];
    
    let fileCount = 0;
    let chunkCount = 0;
    
    function walkDir(dir, depth = 0) {
      if (depth > 5) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!ignorePatterns.some(p => entry.name === p)) walkDir(fullPath, depth + 1);
        } else if (entry.isFile() && exts.includes(path.extname(entry.name).toLowerCase())) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8').slice(0, 50000); // max 50KB per file
            const lang = detectLang(fullPath);
            const relPath = path.relative(projectPath, fullPath);
            const chunks = chunkCode(content, lang, relPath);
            
            const insert = db.prepare('INSERT OR REPLACE INTO code_chunks (id, project_id, file_path, chunk_type, name, content, line_start, line_end, lang) VALUES (?,?,?,?,?,?,?,?,?)');
            const insertMany = db.transaction((chunks) => {
              for (const c of chunks) {
                const id = `${projectId}:${relPath}:${c.lineStart}:${c.name || c.type}`;
                insert.run(id, projectId, relPath, c.type, c.name || '', c.content, c.lineStart, c.lineEnd, lang);
              }
            });
            insertMany(chunks);
            chunkCount += chunks.length;
            fileCount++;
          } catch {}
        }
      }
    }
    
    walkDir(projectPath);
    return { indexed: chunkCount, files: fileCount };
  } finally {
    db.close();
  }
}

// Search indexed code using FTS5
function searchCode(projectId, query, limit = 5) {
  if (!query || !query.trim()) return [];
  const db = getIndexDB();
  try {
    // FTS5 search
    const results = db.prepare(`
      SELECT c.file_path, c.chunk_type, c.name, c.content, c.line_start, c.lang,
        rank
      FROM chunks_fts
      JOIN code_chunks c ON chunks_fts.id = c.id
      WHERE chunks_fts MATCH ? AND c.project_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(query.replace(/[^a-zA-Z0-9 _]/g, ' ').trim() + '*', projectId, limit);
    return results;
  } catch(e) {
    // Fallback to LIKE search if FTS fails
    try {
      return db.prepare(`
        SELECT file_path, chunk_type, name, content, line_start, lang
        FROM code_chunks
        WHERE project_id=? AND (content LIKE ? OR name LIKE ?)
        LIMIT ?
      `).all(projectId, `%${query}%`, `%${query}%`, limit);
    } catch { return []; }
  } finally {
    db.close();
  }
}

// Get relevant context for a task (used by pipeline)
function getRelevantContext(projectId, taskTitle, taskDescription, limit = 4) {
  const query = `${taskTitle} ${taskDescription}`.slice(0, 100);
  const results = searchCode(projectId, query, limit);
  if (!results.length) return '';
  
  const parts = results.map(r => `// ${r.file_path}:${r.line_start} (${r.chunk_type}: ${r.name || 'block'})\n${r.content.slice(0, 400)}`);
  return `RELEVANT PROJECT CODE:\n${parts.join('\n\n---\n')}\n`;
}

// Get project index stats
function getIndexStats(projectId) {
  const db = getIndexDB();
  try {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as totalChunks,
        COUNT(DISTINCT file_path) as files,
        COUNT(CASE WHEN chunk_type='function' THEN 1 END) as functions,
        COUNT(CASE WHEN chunk_type='class' THEN 1 END) as classes
      FROM code_chunks WHERE project_id=?
    `).get(projectId);
    return stats || { totalChunks: 0, files: 0, functions: 0, classes: 0 };
  } finally { db.close(); }
}

module.exports = { indexProject, searchCode, getRelevantContext, getIndexStats, getIndexDB };
