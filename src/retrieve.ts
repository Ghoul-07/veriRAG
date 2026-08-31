// ============================================================================
// HYBRID RETRIEVAL ENGINE (Dense Vector + BM25 Sparse Search + RRF + Streaming)
// ============================================================================
// Combines cosine vector similarity (Gemini) and PostgreSQL full-text search (tsvector)
// using Reciprocal Rank Fusion (RRF) for optimal keyword and semantic recall.

import pg from 'pg'
import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'
import { evaluateFaithfulness } from './judge.js'
import Groq from 'groq-sdk'

const { Pool } = pg
const pool = new Pool({connectionString: process.env.DATABASE_URL,
  ssl:{
    rejectUnauthorized: false
  }
})

const ai = new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY})
const groq = new Groq({apiKey:process.env.GROQ_API_KEY})

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

export interface ChatTurn{
  role: 'user' | 'assistant',
  content: string
}

/**
 * Rewrites a follow-up question using chat history into a standalone query.
 */

export async function contextualizeQuery(query: string, history: ChatTurn[]): Promise<string>{

  if(!history || history.length === 0) return query

  // take the last 4 turns 
  const recentHistory = history.slice(-4)
  const formattedHistory = recentHistory
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');

 try {
    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `You are an automated query contextualizer for technical documentation search.
          Given the previous conversation and the follow-up question, resolve all ambiguous pronouns (like "it", "its", "they", "this") using the exact entity or topic discussed in the latest turn.

          Rules:
          1. Output ONLY the standalone search query.
          2. Do NOT add conversational replies, markdown, or explanations.
          3. If the user question is already self-contained, return it verbatim.`,
        },
        {
          role: 'user',
          content: `--- CHAT HISTORY ---\n${formattedHistory}\n--------------------\n\nFollow-up Question: ${query}\n\nStandalone Search Query:`,
        },
      ],
    });

    const rewritten = completion.choices[0]?.message?.content?.trim();
    console.log(`\n🔄 [Query Rewriter] "${query}" ➔ "${rewritten}"`);
    return rewritten && rewritten.length > 0 ? rewritten : query;
  } catch (err) {
    console.warn('⚠️ Query rewriter failed, falling back to original query:', err);
    return query;
  }
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

/**
 * 2. SPARSE KEYWORD SEARCH (Tokenized ILIKE + Full-Text Search)
 */
export async function keywordSearch(query: string, topK = 8): Promise<SearchResult[]> {
  const client = await pool.connect();

  try {
    // Extract key tokens, ignoring punctuation and common stop words
    const cleanTokens = query
      .replace(/[^a-zA-Z0-9\s-]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !['what', 'how', 'why', 'when', 'the', 'are', 'its', 'for', 'with', 'about'].includes(w.toLowerCase()));

    if (cleanTokens.length === 0) return [];

    // Check if any token matches document names (e.g. "nexus", "gate", "verirag")
    const docNameMatches = cleanTokens.map((_, i) => `document_name ILIKE $${i + 1}`);
    const contentMatches = cleanTokens.map((_, i) => `content ILIKE $${i + 1}`);

    const params = cleanTokens.map((t) => `%${t}%`);

    const sql = `
      SELECT 
        id,
        document_name,
        content,
        (
          CASE 
            WHEN (${docNameMatches.join(' OR ')}) THEN 3.0 
            ELSE 0.0 
          END
          + ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', $${cleanTokens.length + 1}))
        ) AS rank_score
      FROM document_chunks
      WHERE (${contentMatches.join(' OR ')}) OR (${docNameMatches.join(' OR ')})
      ORDER BY rank_score DESC
      LIMIT $${cleanTokens.length + 2};
    `;

    const res = await client.query(sql, [...params, query, topK]);

    return res.rows.map((row) => ({
      id: row.id,
      documentName: row.document_name,
      content: row.content,
      score: parseFloat(row.rank_score) || 0.5,
      retrievalType: 'keyword',
    }));
  } catch (err) {
    console.warn('⚠️ Keyword search fallback error:', err);
    return [];
  } finally {
    client.release();
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
  history: ChatTurn[] = [] ,
  onToken: (chunkText: string) => void
): Promise<StreamResult>{

  // 1. Rewrite query if history exists
  const standaloneQuery = await contextualizeQuery(query, history);

  // 2. Fetch top relevant chunks via Hybrid RRF Search
  const sources = await hybridSearch(standaloneQuery, 6)

  

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

  // 3. Format context for prompt injection
  const formattedContext = sources
    .map((s, i) => `[Document: ${s.documentName} | Chunk ID: ${s.id}]\n${s.content}`)
    .join('\n\n---\n\n');

 const stream = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    temperature: 0.2,
    stream: true,
    messages: [
      {
        role: 'system',
        content: `You are VeriRAG, an accurate and helpful technical documentation assistant.
        Your task is to answer the user's question thoroughly using the retrieved reference context below.
        - Synthesize all relevant facts, configuration parameters, and architectural details present in the context.
        - Directly answer what is asked. Only state that information is missing if the context contains zero relevant details.

        --- RETRIEVED CONTEXT ---
        ${formattedContext}
        -------------------------`,
      },
      {
        role: 'user',
        content: standaloneQuery,
      },
    ],
  });

  let fullAnswer = ''

  // 5. Stream tokens chunk-by-chunk to callback
  for await(const chunk of stream){
    const text = chunk.choices[0]?.delta?.content || '';
    if(text){
      fullAnswer += text
      onToken(text)
    }
  }

  // 6. Run Faithfulness / Groundedness Judge Gate evaluation on assembled answer
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
