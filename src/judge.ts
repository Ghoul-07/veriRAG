// ============================================================================
// VERIRAG FAITHFULNESS & HALLUCINATION JUDGE
// ============================================================================
// Performs a secondary LLM verification pass over the retrieved context
// and generated answer to score factual faithfulness.

import 'dotenv/config'
import Groq from 'groq-sdk'
import { SearchResult } from './retrieve.js'

const groq = new Groq({apiKey: process.env.GROQ_API_KEY})

export interface EvaluationResult{
  isFaithful: boolean,
  confidenceScore: number,
  unsupportedClaims: string[],
  reasoning: string
}

/**
 * Validates whether every claim in the generated answer is strictly grounded in the context.
 */

export async function evaluateFaithfulness(query: string, contextChunks: SearchResult[], answer: string):   Promise<EvaluationResult>
{
  const context = contextChunks.map((c) => `[Source: ${c.id}]\n${c.content}`)
   .join('\n\n---\n\n')


  const judgePrompt = `You are a strict evaluation judge in an automated RAG verification pipeline.
  Your job is to determine whether the GENERATED ANSWER is strictly and factually faithful to the provided CONTEXT.

  Evaluation Criteria:
  1. Every factual statement in the answer MUST be directly supported by the context.
  2. If the answer introduces external knowledge, unmentioned facts, or fabricated statistics not in the context, it is NOT faithful.
  3. If the answer accurately states it cannot answer due to lack of context, it IS faithful.

  CONTEXT:
  ${context}

  USER QUESTION:
  ${query}

  GENERATED ANSWER:
  ${answer}

  Return a valid JSON object matching this schema EXACTLY without markdown wrappers:
  {
    "isFaithful": boolean,
    "confidenceScore": number, // between 0.0 and 1.0
    "unsupportedClaims": string[], // list any claims not found in context
    "reasoning": "concise explanation of your verdict"
  }`;

  const completion = await groq.chat.completions.create({
    model:'openai/gpt-oss-120b',
    messages:[
      {
        role:'system',
        content:'You are an automated evaluation judge. Respond ONLY in valid, parseable JSON.'
      },
      {
        role:'user',
        content: judgePrompt
      }
    ],
    temperature:0.0,
    response_format:{'type':'json_object'}
  })

  const rawJson = completion.choices[0]?.message?.content || '{}'

  try{
    const result : EvaluationResult = JSON.parse(rawJson)
    return result
  } catch{
    return {
      isFaithful: false,
      confidenceScore: 0,
      unsupportedClaims: ['Failed to parse JSON evaluation output'],
      reasoning: 'Evaluation parser failure.'
    }
  }
  }