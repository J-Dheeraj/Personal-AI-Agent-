import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.env.GROUP_DIR || '/workspace/group', 'mnemon.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    predicate TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    embedding BLOB
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
    USING fts5(entity, predicate, value, content=facts, content_rowid=id);
`);

// Add embedding column to existing databases that were created without it
try {
  db.exec(`ALTER TABLE facts ADD COLUMN embedding BLOB`);
} catch { /* column already exists — ignore */ }

type OllamaClient = {
  embeddings: (opts: { model: string; prompt: string }) => Promise<{ embedding: number[] }>;
};

let ollamaClient: OllamaClient | null = null;

async function getOllama(): Promise<OllamaClient | null> {
  if (ollamaClient) return ollamaClient;
  try {
    const { Ollama } = await import('ollama');
    ollamaClient = new Ollama({ host: process.env.OLLAMA_HOST || 'http://host.docker.internal:11434' });
    return ollamaClient;
  } catch {
    return null;
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class Mnemon {
  async addFact(entity: string, predicate: string, value: string, source: string): Promise<void> {
    const stmt = db.prepare(
      `INSERT INTO facts (entity, predicate, value, source, timestamp) VALUES (?, ?, ?, ?, ?)`
    );
    const info = stmt.run(entity, predicate, value, source, Date.now());
    const rowid = info.lastInsertRowid;

    db.prepare(
      `INSERT INTO facts_fts(rowid, entity, predicate, value) VALUES (?, ?, ?, ?)`
    ).run(rowid, entity, predicate, value);

    // Attempt to store an embedding; silently skip if Ollama is unavailable
    const ollama = await getOllama();
    if (ollama) {
      try {
        const { embedding } = await ollama.embeddings({
          model: 'nomic-embed-text',
          prompt: `${entity} ${predicate}: ${value}`,
        });
        const buf = Buffer.from(new Float32Array(embedding).buffer);
        db.prepare(`UPDATE facts SET embedding = ? WHERE id = ?`).run(buf, rowid);
      } catch { /* Ollama unavailable — fact stored without embedding */ }
    }
  }

  async semanticSearch(query: string, topK = 10): Promise<string[]> {
    const ollama = await getOllama();
    if (!ollama) return this.searchFacts(query);

    try {
      const { embedding: queryEmb } = await ollama.embeddings({ model: 'nomic-embed-text', prompt: query });
      const queryVec = new Float32Array(queryEmb);

      const rows = db.prepare(`SELECT entity, predicate, value, embedding FROM facts WHERE embedding IS NOT NULL`)
        .all() as { entity: string; predicate: string; value: string; embedding: Buffer }[];

      const scored = rows.map(r => {
        const vec = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
        return { text: `${r.entity} ${r.predicate}: ${r.value}`, score: cosineSimilarity(queryVec, vec) };
      });

      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(r => r.text);
    } catch {
      return this.searchFacts(query);
    }
  }

  searchFacts(query: string): string[] {
    try {
      const rows = db.prepare(`
        SELECT f.entity, f.predicate, f.value FROM facts_fts
        JOIN facts f ON f.id = facts_fts.rowid
        WHERE facts_fts MATCH ? LIMIT 10
      `).all(query) as { entity: string; predicate: string; value: string }[];
      return rows.map(r => `${r.entity} ${r.predicate}: ${r.value}`);
    } catch {
      return [];
    }
  }
}

export const mnemon = new Mnemon();
