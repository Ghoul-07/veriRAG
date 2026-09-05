// ============================================================================
// VERIRAG VERIFIED PIPELINE (Hybrid Retrieval + Self-Correction Judge)
// ============================================================================

import 'dotenv/config'
import Groq from 'groq-sdk'
import { hybridSearch, SearchResult } from './retrieve.js'
import { EvaluationResult, evaluateFaithfulness } from './judge.js'

const groq = new Groq({apiKey: process.env.GROQ_API_KEY})

interface VerifiedRagResponse{
  query: string;
  answer: string;
  sources: { id: string; document: string; score: string }[];
  verification: EvaluationResult
}

/**
 * Builds the grounded prompt by appending retrieved chunks as context.
 */
function buildPrompt(query: string, chunks: SearchResult[]): string{
  const context = chunks
    .map((c, i) => `[Source ID: ${c.id}] (File: ${c.documentName})\n${c.content}`)
    .join('\n\n---\n\n');

  return `You are VeriRAG, an accurate and grounded technical assistant.
    Answer the user's question directly using the provided context chunks.
    Extract all facts, algorithms, numbers, and configurations that are present.
    If a specific detail is not mentioned in the context, answer the parts that ARE mentioned, and briefly state what detail was not found.
    Only state "I cannot answer this question based on the provided documentation." if the context contains ZERO relevant information.
    Do NOT refuse the entire question if at least one part is answered in the context.

    ### CONTEXT:
    ${context}

    ### USER QUESTION:
    ${query}

    ### GROUNDED ANSWER:`;
}

/**
 * Runs the complete RAG pipeline for a given query.
 */

export async function askQuestion(query: string, topK=5):Promise<VerifiedRagResponse>{
  // 1. Retrieve the most relevant chunks from postgres
  const retrievedChunks = await hybridSearch(query, topK)

  if(retrievedChunks.length === 0){
    return {
      query,
      answer: 'I cannot answer this question based on the provided documentation.',
      sources:[],
      verification:{
        isFaithful: false,
        confidenceScore: 1.0,
        hasSufficientContext: false,
        unsupportedClaims: [],
        reasoning: 'No relevant context found in database; accurately reported lack of context.'
      }
    }
  }

  // 2. Format the prompt with context
  const prompt =  buildPrompt(query,retrievedChunks)

  // 3. Generate response using Groq
  const completion = await groq.chat.completions.create({
    model:'openai/gpt-oss-120b',
    messages:[
      {
        role:'system',
        content: 'You are a precise technical assistant that answers questions using only provided context.',
      },
      {
        role:'user',
        content: prompt
      }
    ],
    temperature: 0.0, // Low temperature for high factual accuracy
  })

  const rawAnswer = completion.choices[0]?.message?.content || 'No response generated'

  // 4. Automated Faithfulness Verification (LLM Judge)
  console.log('⚖️  Running automated verification judge on generated response...');

  const verification = await evaluateFaithfulness(query, retrievedChunks, rawAnswer)

  return {
    query,
    answer: rawAnswer,
    sources: retrievedChunks.map((c)=>({
      id: c.id,
      document: c.documentName,
      score: c.score.toFixed(4),
    })),
    verification
  }
}

// Direct test execution
async function run() {
  const query = 'What algorithm does the gateway use for password hashing?';
  console.log(`🤖 Asking VeriRAG: "${query}"\n`);

  try {
    const response = await askQuestion(query, 3);

    // Format the answer and verification cleanly
    const output = [
      '',
      '====================================================',
      '💬 ANSWER:',
      '====================================================',
      response.answer,
      '',
      '====================================================',
      '⚖️ VERIFICATION REPORT:',
      '====================================================',
      `Status:              ${response.verification.isFaithful ? '✅ PASS' : '❌ FAIL'}`,
      `Sufficient Context:  ${response.verification.hasSufficientContext ? '✅ YES' : '❌ NO'}`,
      `Confidence:          ${(response.verification.confidenceScore * 100).toFixed(0)}%`,
      `Reasoning:           ${response.verification.reasoning}`,
      '',
      '====================================================',
      '📚 SOURCES USED:',
      '====================================================',
    ].join('\n');

    console.log(output);
    console.table(response.sources);
  } catch (err) {
    console.error('❌ RAG Pipeline Error:', err);
  }
}

if (process.argv[1] && process.argv[1].endsWith('rag.ts')) {
  run();
}