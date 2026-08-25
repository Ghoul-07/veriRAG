// ============================================================================
// VECTOR RETRIEVAL ENGINE
// ============================================================================
// Takes a query string, embeds it, and performs a cosine similarity search
// across the document chunks stored in pgvector.

import pg from 'pg'
import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'
import { ppid } from 'node:process'

const { Pool } = pg
const pool = new Pool({connectionString: process.env.DATABASE_URL})
const ai = new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY})

export interface SearchResult{
  id:string, 
  documentName:string,
  content:string,
  similarity: number
}

/**
 * Converts text into a 768-dimension embedding vector.
 */
async function embedQuery(text: string): Promise<number[]> {
  const response = await ai.models.embedContent({
    model:'gemini-embedding-001',
    contents:text,
    config:{
      outputDimensionality: 768
    }
  })

  const vector = response.embeddings?.[0]?.values
  if(!vector || vector.length === 0){
    throw new Error('Failed to generate query embedding.')
  }

  return vector;
}


/**
 * Searches pgvector for the top K closest chunks using Cosine Distance (<=>).
 * Cosine distance ranges from 0 (identical) to 2 (opposite).
 * Similarity is calculated as (1 - distance).
 */

export async function vectorSearch(query: string, topK= 3): Promise<SearchResult[]>{
  const queryVector = await embedQuery(query)
  const client = await pool.connect()

  try{
    const sql = `
      SELECT 
        id,
        document_name,
        content,
        (1 - (embedding <=> $1::vector)) AS similarity
      FROM document_chunks
      ORDER BY similarity DESC
      LIMIT $2;
    `

    const res = await client.query(sql, [JSON.stringify(queryVector), topK])

    return res.rows.map((row)=>({
      id: row.id,
      documentName: row.document_name,
      content: row.content,
      similarity: parseFloat(row.similarity)
    }))
  } finally{
    client.release()
  }
}

// Test runner for direct execution
async function run() {
  const query = 'How does the circuit breaker handle cooldown and recover?';
  console.log(` Running Vector Search for: "${query}"\n`);

  try {
    const results = await vectorSearch(query, 2);

    results.forEach((res, idx) => {
      console.log(`--- [Rank ${idx + 1}] Similarity: ${(res.similarity * 100).toFixed(2)}% ---`);
      console.log(`Source: ${res.documentName} (${res.id})`);
      console.log(`Content:\n${res.content}\n`);
    });
  } catch (err) {
    console.error('❌ Search error:', err);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('retrieve.ts')) {
  run();
}
