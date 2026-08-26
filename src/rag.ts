// ============================================================================
// VERIRAG VERIFIED PIPELINE (Hybrid Retrieval + Self-Correction Judge)
// ============================================================================

import 'dotenv/config'
import Groq from 'groq-sdk'
import { vectorSearch, SearchResult } from './retrieve.js'
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
Answer the user's question STRICTLY using the context provided below.
If the context does not contain enough information to answer the question, state clearly: "I cannot answer this question based on the provided documentation."
Always reference which Source ID you used to form each part of your answer.

### CONTEXT:
${context}

### USER QUESTION:
${query}

### GROUNDED ANSWER:`;
}

/**
 * Runs the complete RAG pipeline for a given query.
 */

export async function askQuestion(query: string, topK=3):Promise<VerifiedRagResponse>{
  // 1. Retrieve the most relevant chunks from postgres
  const retrievedChunks = await vectorSearch(query, topK)

  if(retrievedChunks.length === 0){
    return {
      query,
      answer: 'No relevant context found in database.',
      sources:[],
      verification:{
        isFaithful: false,
        confidenceScore: 0.0,
        unsupportedClaims: [],
        reasoning: 'No context was found; correctly flagged as empty'
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
    temperature: 0.1, // Low temperature for high factual accuracy
  })

  const rawAnswer = completion.choices[0]?.message?.content || 'No response generated'

  // 4. Automated Faithfulness Verification (LLM Judge)
  console.log('⚖️  Running automated verification judge on generated response...');

  const verification = await evaluateFaithfulness(query, retrievedChunks, rawAnswer)

  let finalAnswer = rawAnswer
  if(!verification.isFaithful){
    finalAnswer = `⚠️ [Verification Warning]: The generated answer failed faithfulness checks. \nReason: ${verification.reasoning}`;
  }

  return {
    query,
    answer: finalAnswer,
    sources: retrievedChunks.map((c)=>({
      id: c.id,
      document: c.documentName,
      score: `${(c.score * 100).toFixed(2)}%`,
    })),
    verification
  }
}

// Direct test execution
async function run() {
  const query = 'What algorithm does the gateway use for password hashing?';
  console.log(`🤖 Asking VeriRAG: "${query}"\n`);

  try {
    const response = await askQuestion(query, 2);

    console.log('\n====================================================');
    console.log('💬 ANSWER:');
    console.log('====================================================');
    console.log(response.answer);

    console.log('\n====================================================');
    console.log('⚖️ VERIFICATION REPORT:');
    console.log('====================================================');
    console.log(`Status:      ${response.verification.isFaithful ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Confidence:  ${(response.verification.confidenceScore * 100).toFixed(0)}%`);
    console.log(`Reasoning:   ${response.verification.reasoning}`);

    console.log('\n====================================================');
    console.log('📚 SOURCES USED:');
    console.log('====================================================');
    console.table(response.sources);
  } catch (err) {
    console.error('❌ RAG Pipeline Error:', err);
  }
}

if (process.argv[1] && process.argv[1].endsWith('rag.ts')) {
  run();
}