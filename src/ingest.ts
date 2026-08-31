// ============================================================================
// VERIRAG INGESTION LAYER (Chunking, Embedding & Document Management)
// ============================================================================

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import pg from 'pg'
import { GoogleGenAI } from '@google/genai'

const {Pool} = pg
const pool = new Pool({connectionString:process.env.DATABASE_URL,
  ssl:{
    rejectUnauthorized:false
  }
})
const ai = new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY})

// configuration for sliding window chunking
const CHUNK_SIZE = 400   // approximate character count per chunk

export interface DocumentSummary{
  documentName: string,
  chunkCount: number
}

/**
 * Splits text cleanly by paragraphs and markdown sections, ensuring no mid-word slicing.
 */
export function chunkText(text: string, maxChunkLength = 500): string[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    if ((currentChunk + '\n\n' + para).trim().length <= maxChunkLength) {
      currentChunk = currentChunk ? `${currentChunk}\n\n${para}` : para;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = para;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Generates a 768-dimension vector using Gemini embeddings.
 */

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await ai.models.embedContent({
    model:'gemini-embedding-001',
    contents: text,
    config:{
      outputDimensionality: 768
    }
  })

  const vector = response.embeddings?.[0]?.values

  if(!vector || vector.length === 0){
    throw new Error(`Failed to generate embeddings for chunk: ${text.slice(0, 30)}...`)
  }
  return vector

}

/**
 * Main ingestion routine: processes files and inserts vectors into pgvector.
 */

export async function ingestDocument(fileName: string, rawContent: string): Promise<number>{
  console.log(`\n📄 Ingesting document: ${fileName}`);
  
  const textChunks = chunkText(rawContent, CHUNK_SIZE)
  console.log(`✂️  Split into ${textChunks.length} chunks.`);

  const client = await pool.connect()

  try{
    for(let i = 0; i < textChunks.length; i++){
      const chunk = textChunks[i]
      const chunkId = `${fileName}_chunk_${i}`

      console.log(`🔄 Generating embedding for chunk [${i + 1}/${textChunks.length}]...`);
      const embedding = await generateEmbedding(chunk)

      // upsert chunk and vector in database
      const query = `
        INSERT INTO document_chunks (id, document_name, chunk_index, content, embedding) 
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content,
         embedding = EXCLUDED.embedding;
      `
      // pgvector requires array formated as string '[0.1, 0.2 ..]'
      await client.query(query, [
        chunkId,
        fileName,
        i,
        chunk,
        JSON.stringify(embedding)
      ])

      // Small pacing delay
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log(`✅ Successfully ingested all ${textChunks.length} chunks into pgvector!`);
    return textChunks.length
    
  }finally{
    client.release()
  }
}

/**
 * Lists all indexed documents grouped by document_name with total chunk counts.
 */

export async function listIndexedDocuments() : Promise<DocumentSummary[]>{
  const query = `
    SELECT 
      document_name as documentname,
      COUNT(*):: int as chunkcount
    FROM document_chunks
    WHERE document_name IS NOT NULL
    GROUP BY document_name
    ORDER BY document_name
  `
  const result = await pool.query(query)
  return result.rows
}

/**
 * Deletes all chunks and vector embeddings belonging to a specific document.
 */
export async function deleteDocumentChunks(documentName: string): Promise<number>{
  const query = `
    DELETE FROM document_chunks
    WHERE document_name = $1
  `
  const result = await pool.query(query, [documentName])
  return result.rowCount || 0
}

/**
 * Ingest directly from a local file path.
 */
export async function ingestFile(filePath: string): Promise<number> {
  const fileName = path.basename(filePath);
  const rawContent = fs.readFileSync(filePath, 'utf-8');
  return ingestDocument(fileName, rawContent);
}

// CLI runner support: Accepts optional file path as CLI argument
async function run() {
  const targetPath = process.argv[2] || path.join(process.cwd(), 'data', 'sample-docs.md');

  if (!fs.existsSync(targetPath)) {
    console.error(`❌ File not found at: ${targetPath}`);
    process.exit(1);
  }

  try {
    await ingestFile(targetPath);
  } catch (error) {
    console.error('❌ Ingestion failed:', error);
  } finally {
    await pool.end();
  }
}

// Execute only if run directly from terminal
if (process.argv[1] && process.argv[1].endsWith('ingest.ts')) {
  run();
}