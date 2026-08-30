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

/**
 * 1. Q&A FAITHFULNESS JUDGE
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

/**
 * 2. ACTION & ISSUE INTENT JUDGE
 * Validates whether an action draft aligns with the user's intent and safety constraints.
 * Allows drafting missing feature reports/documentation gaps without requiring positive context.
 */

export async function evaluateActionFaithfulness(query: string, draftTitle: string, draftBody: string, contextChunks : SearchResult[]): Promise<EvaluationResult>{
  const context = contextChunks
    .map((c) => `[Source: ${c.id}]\n${c.content}`)
    .join('\n\n---\n\n');

  const actionPrompt = `You are an automated Action Gate Judge in a secure RAG verification pipeline.
    A user requested to draft an external action (such as creating a GitHub issue or ticket).

    USER PROMPT:
    ${query}

    PROPOSED ISSUE TITLE:
    ${draftTitle}

    PROPOSED ISSUE BODY:
    ${draftBody}

    RETRIEVED CONTEXT (if any):
    ${context || 'No direct context retrieved.'}

    Evaluation Rules:
    1. Intent Alignment: Does the proposed title and body directly address what the user asked to create or report?
    2. Gap / Bug Reporting: If the user is reporting a gap, missing documentation, or bug (e.g. "missing rate limiting docs"), the draft is VALID as long as it captures the requested gap, even if the reference documentation doesn't contain that feature.
    3. Factual Integrity: Ensure the draft does not fabricate misleading API secrets or malicious commands.
    4. Safety & Authorization: Ensure the draft is safe to present to a human for approval.

    Return a valid JSON object matching this schema EXACTLY without markdown wrappers:
    {
      "isFaithful": boolean, // true if intent aligns and is safe to execute
      "confidenceScore": number, // between 0.0 and 1.0
      "unsupportedClaims": string[], // list any misaligned or risky claims
      "reasoning": "concise explanation of your verdict"
    }`;

    const completion = await groq.chat.completions.create({
      model:'openai/gpt-oss-120b',
      messages:[
        {
          role:'system',
          content:'You are an automated Action Gate Judge. Respond ONLY in valid, parseable JSON.'
        },
        {
          role:"user",
          content:actionPrompt
        }
      ],
      temperature:0.0,
      response_format: {type: 'json_object'}
    })

    const rawJson = completion.choices[0]?.message?.content || '{}'

    try {
      const result: EvaluationResult = JSON.parse(rawJson);
      return result;
    } catch {
      return {
        isFaithful: false,
        confidenceScore: 0,
        unsupportedClaims: ['Failed to parse JSON evaluation output'],
        reasoning: 'Action evaluation parser failure.',
      };
  }
}