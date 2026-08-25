import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import pg from 'pg'
import { GoogleGenAI } from '@google/genai'
import { text } from 'stream/consumers'

const {Pool} = pg
const pool = new Pool({connectionString:process.env.DATABASE_URL})
const ai = new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY})

// configuration for sliding window chunking
const CHUNK_SIZE = 400   // approximate character count per chunk
const CHUNK_OVERLAP = 80 // overlap to preserve context across boundaries

interface DocumentChunk{
  id: string,
  documentName: string,
  chunkIndex: number,
  content: string,
  embedding: number[]
}

/**
 * Splits text cleanly by paragraphs and markdown sections, ensuring no mid-word slicing.
 */
function chunkText(text: string, maxChunkLength = 500, overlapSentences = 1): string[] {
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

async function generateEmbedding(text: string): Promise<number[]> {
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

async function ingestFile(filePath: string){
  const fileName = path.basename(filePath)
  console.log(`\n📄 Ingesting document: ${fileName}`);

  const rawContent = fs.readFileSync(filePath, 'utf-8')
  const textChunks = chunkText(rawContent, CHUNK_SIZE, CHUNK_OVERLAP)
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
      console.log(`✅ Successfully ingested all ${textChunks.length} chunks into pgvector!`);
    }
  }finally{
    client.release()
  }
}

async function run() {
  try {
    const sampleFilePath = path.join(process.cwd(), 'data', 'sample-docs.md');
    await ingestFile(sampleFilePath);
  } catch (error) {
    console.error('❌ Ingestion failed:', error);
  } finally {
    await pool.end();
  }
}

run();