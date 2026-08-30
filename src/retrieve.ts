// ============================================================================
// HYBRID RETRIEVAL ENGINE (Dense Vector + BM25 Sparse Search + RRF + Streaming)
// ============================================================================
// Combines cosine vector similarity (Gemini) and PostgreSQL full-text search (tsvector)
// using Reciprocal Rank Fusion (RRF) for optimal keyword and semantic recall.

import pg from 'pg'
import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'
import { evaluateFaithfulness } from './judge.js'
import { chunkText } from './ingest.js'

const { Pool } = pg
const pool = new Pool({connectionString: process.env.DATABASE_URL})
const ai = new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY})

export interface SearchResult{
  id:string, 
  documentName:string,
  content: string,
  score: number,
  retrievalType?: 'vector' | 'keyword' | 'hybrid'
}

export interface StreamResult {
  fullAnswer: string,
  sources: SearchResult[],
  judgeVerdict:any
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
 * 1. DENSE VECTOR SEARCH (Cosine Similarity via pgvector)
 */

export async function vectorSearch(query: string, topK= 5): Promise<SearchResult[]>{
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
      score: parseFloat(row.similarity),
      retrievalType:'vector'
    }))
  } finally{
    client.release()
  }
}


/**
 * 2. SPARSE KEYWORD SEARCH (PostgreSQL tsvector / GIN Full-Text Search)
 */

export async function keywordSearch(query:string, topK=8): Promise<SearchResult[]>{
  const client = await pool.connect()

  try{

    const sql = `
      SELECT 
        id,
        document_name,
        content,
        ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', $1)) AS rank_score
      FROM document_chunks
      WHERE to_tsvector('english', content) @@ websearch_to_tsquery('english', $1)
      ORDER BY rank_score DESC
      LIMIT $2;
    `

    const res = await client.query(sql, [query, topK])

    return res.rows.map((row) =>({
      id:row.id,
      documentName: row.document_name,
      content:row.content,
      score: parseFloat(row.rank_score),
      retrievalType:'keyword'
    }))
  } finally{
    client.release()
  }
}


/**
 * 3. HYBRID SEARCH VIA RECIPROCAL RANK FUSION (RRF)
 * Standard constant k = 60 prevents high rankings from overly dominating.
 */
  export async function hybridSearch(query:string, topK = 3, kConstant = 60): Promise<SearchResult[]>{
    const [vectorResults, keywordResults] = await Promise.all([
      vectorSearch(query, topK * 2),
      keywordSearch(query, topK * 2)
    ])

    const rrfScores =  new Map<string, { chunk: SearchResult; score: number }> ()

    // Tally RRF scores from vector search ranks
    vectorResults.forEach((chunk, rank)=>{
      const current = rrfScores.get(chunk.id) || {chunk, score:0}
      current.score += 1 / (kConstant + (rank + 1))
      rrfScores.set(chunk.id, current)
    })

    // Tally RRF scores from keyword search ranks
    keywordResults.forEach((chunk,rank)=>{
      const current = rrfScores.get(chunk.id) || {chunk, score:0}
      current.score += 1 / (kConstant + (rank + 1))
      rrfScores.set(chunk.id, current)
    })

    // Sort by combined RRF score descending and return top K
    return Array.from(rrfScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((item) => ({
        ...item.chunk,
        score: item.score,
        retrievalType: 'hybrid',
      }));
  }

  /**
 * 4. TOKEN STREAMING GENERATION WITH JUDGE GATE
 * Executes hybrid search, streams answer tokens via callback,
 * and performs a faithfulness check upon generation completion.
 */

export async function streamAnswer(
  query:string,
  onToken: (chunkText: string) => void
): Promise<StreamResult>{

  // 1. Fetch top relevant chunks via Hybrid RRF Search
  const sources = await hybridSearch(query, 6)

  console.log(`\n🔎 Query: "${query}"`);
console.log(`📦 Retrieved ${sources.length} chunks:`, sources.map(s => `[${s.documentName} | ${s.id}]`).join(', '));

  if (sources.length === 0) {
    const emptyNotice = "I could not find any relevant context in the indexed documents.";
    onToken(emptyNotice);
    return {
      fullAnswer: emptyNotice,
      sources: [],
      judgeVerdict: {
        isGrounded: false,
        confidenceScore: 0,
        reasoning: 'No relevant chunks found in the database.',
      },
    };
  }

  // 2. Format context for prompt injection
  const formattedContext = sources
    .map((s, i) => `[Document: ${s.documentName} | Chunk ID: ${s.id}]\n${s.content}`)
    .join('\n\n---\n\n');

  const promptText = `You are VeriRAG, an accurate and helpful technical documentation assistant.

  Your task is to answer the user's question thoroughly using the retrieved reference context below.
  - Synthesize all relevant facts, configuration parameters, and architectural details present in the context.
  - Directly answer what is asked. Only state that information is missing if the context contains zero relevant details.

  --- RETRIEVED CONTEXT ---
  ${formattedContext}
  -------------------------

  User Question: ${query}`;

  // 3. Request token stream from Gemini
  const responseStream = await ai.models.generateContentStream({
    model:'gemini-3.6-flash',
    contents:[
      {
        role: 'user',
        parts: [{ text: promptText}],
      }
    ]
  })

  let fullAnswer = ''

  // 4. Stream tokens chunk-by-chunk to callback
  for await(const chunk of responseStream){
    const text = chunk.text || ''
    if(text){
      fullAnswer += text
      onToken(text)
    }
  }

  // 5. Run Faithfulness / Groundedness Judge Gate evaluation on assembled answer
  const judgeVerdict = await evaluateFaithfulness(query, sources, fullAnswer);

  return {
    fullAnswer,
    sources,
    judgeVerdict,
  };
}


// Direct test runner
async function run() {
  const query = 'How are Authentication and Authorization handled?';
  console.log(`🔎 Testing Hybrid Search for: "${query}"\n`);

  try {
    console.log('--- [1] Keyword Search Only ---');
    const kw = await keywordSearch(query, 2);
    console.table(kw.map(k => ({ id: k.id, score: k.score, preview: k.content.slice(0, 60) })));

    console.log('\n--- [2] Vector Search Only ---');
    const vec = await vectorSearch(query, 2);
    console.table(vec.map(v => ({ id: v.id, score: v.score, preview: v.content.slice(0, 60) })));

    console.log('\n--- [3] Hybrid Fusion (RRF) ---');
    const hybrid = await hybridSearch(query, 2);
    console.table(hybrid.map(h => ({ id: h.id, rrfScore: h.score.toFixed(4), preview: h.content.slice(0, 60) })));
  } catch (err) {
    console.error('❌ Search error:', err);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('retrieve.ts')) {
  run();
}
