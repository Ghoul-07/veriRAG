// ============================================================================
// END-TO-END RAG PIPELINE
// ============================================================================
// Connects vector retrieval with Groq LLM inference to generate
// grounded answers with source citations.

import 'dotenv/config'
import Groq from 'groq-sdk'
import { vectorSearch, SearchResult } from './retrieve.js'

const groq = new Groq({apiKey: process.env.GROQ_API_KEY})

interface RagResponse{
  query: string;
  answer: string;
  sources: { id: string; document: string; similarity: string }[];
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

export async function askQuestion(query: string, topK=3):Promise<RagResponse>{
  // 1. Retrieve the most relevant chunks from postgres
  const retrievedChunks = await vectorSearch(query, topK)

  if(retrievedChunks.length === 0){
    return {
      query,
      answer: 'No relevant context found in database.',
      sources:[]
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

  const answer = completion.choices[0]?.message?.content || 'No response generated'

  return {
    query,
    answer,
    sources: retrievedChunks.map((c)=>({
      id: c.id,
      document: c.documentName,
      similarity: `${(c.similarity * 100).toFixed(2)}%`,
    }))
  }
}

// Direct test execution
async function run() {
  const query = 'How does the circuit breaker handle cooldown and recover?';
  console.log(`🤖 Asking VeriRAG: "${query}"\n`);

  try {
    const response = await askQuestion(query, 3);

    console.log('====================================================');
    console.log('💬 ANSWER:');
    console.log('====================================================');
    console.log(response.answer);
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