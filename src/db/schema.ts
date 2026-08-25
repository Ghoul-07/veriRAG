// ============================================================================
// DATABASE SCHEMA & INITIALIZATION SCRIPT
// ============================================================================

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

export async function initDatabase() {
  console.log('🔄 Initializing database schema...');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // 1. Enable pgvector extension
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');

    // 2. Drop table if it was half-created in previous attempts
    await pool.query('DROP TABLE IF EXISTS document_chunks CASCADE;');

    // 3. Create document_chunks table with 768 dimensions
    const createTableQuery = `
      CREATE TABLE document_chunks (
        id VARCHAR(255) PRIMARY KEY,
        document_name VARCHAR(255) NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding vector(768),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await pool.query(createTableQuery);

    // 4. Create HNSW vector index (supports up to 2,000 dimensions)
    const createVectorIndexQuery = `
      CREATE INDEX idx_chunks_embedding_hnsw 
      ON document_chunks 
      USING hnsw (embedding vector_cosine_ops);
    `;
    await pool.query(createVectorIndexQuery);

    // 5. Create GIN index for full-text search
    const createFtsIndexQuery = `
      CREATE INDEX idx_chunks_fts 
      ON document_chunks 
      USING gin (to_tsvector('english', content));
    `;
    await pool.query(createFtsIndexQuery);

    console.log('✅ Database schema initialized successfully:');
    console.log('   - Table: document_chunks (vector size: 768)');
    console.log('   - Vector Index: idx_chunks_embedding_hnsw (HNSW)');
    console.log('   - Full-Text Index: idx_chunks_fts (GIN)');
  } catch (error) {
    console.error('❌ Schema initialization failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('schema.ts')) {
  initDatabase().catch(() => process.exit(1));
}