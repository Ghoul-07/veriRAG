import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function inspectDb() {
  const client = await pool.connect();
  try {
    // Select chunk metadata, truncated content, and vector dimension length
    const res = await client.query(`
      SELECT 
        id, 
        document_name, 
        chunk_index, 
        LEFT(content, 80) AS preview, 
        vector_dims(embedding) AS embedding_dim
      FROM document_chunks
      ORDER BY chunk_index ASC;
    `);

    console.log(`\n📊 Found ${res.rowCount} chunks in 'document_chunks':\n`);
    console.table(res.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

inspectDb();