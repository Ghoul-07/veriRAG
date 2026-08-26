// ============================================================================
// VERIRAG ACTION LAYER (Intent Detection, Drafting & GitHub Issue Creator)
// ============================================================================
// Detects action intent, drafts a structured issue grounded in retrieved context,
// validates through the Judge Gate, and posts via Octokit with HITL(Human In The Loop) confirmation.

import 'dotenv/config'
import Groq from 'groq-sdk'
import { Octokit } from '@octokit/rest'
import * as readline from 'readline'
import { hybridSearch, SearchResult } from './retrieve.js'
import { evaluateFaithfulness } from './judge.js'
import { askQuestion } from './rag.js'


const groq = new Groq({apiKey: process.env.GROQ_API_KEY})
const octokit = new Octokit({auth: process.env.GITHUB_TOKEN})

export interface IssueDraft{
  isActionIntent: boolean;
  title: string;
  body: string;
  labels: string[];
}

/**
 * 1. INTENT CLASSIFIER & ISSUE DRAFTER
 * Analyzes whether the user wants to take an action (e.g., file a bug, draft an issue)
 * and formats a grounded issue title and markdown body.
 */
export async function classifyAndDraftAction(query:string, contextChunks: SearchResult[]): Promise<IssueDraft>{
  const context = contextChunks.map((c)=> `[Source: ${c.id}]\n${c.content}`)

  const draftPrompt = `You are the action planner for VeriRAG.
    Analyze the user's prompt to determine if they intend to file a bug report, ticket, or GitHub issue.

    CONTEXT:
    ${context}

    USER PROMPT:
    ${query}

    Instructions:
    1. If the user is NOT requesting an action (just asking a question), set "isActionIntent": false.
    2. If the user IS requesting an action, set "isActionIntent": true and generate a concise issue title and a well-structured markdown body.
    3. The issue body MUST reference the technical specifics found in CONTEXT (e.g., status codes, metrics, ports).

    Return valid JSON matching this schema:
    {
      "isActionIntent": boolean,
      "title": "Clear issue title",
      "body": "Markdown issue body summarizing technical context and reproduction steps",
      "labels": ["bug" | "documentation" | "enhancement"]
    }`;

  const completion = await groq.chat.completions.create({
    model:'openai/gpt-oss-120b',
    messages:[
      {
        role:'system',
        content:"Respond ONLY with valid JSON."
      },
      {
        role:'user',
        content: draftPrompt
      }
    ],
    temperature:0.1,
    response_format:{type:'json_object'}
  })

  try{
    return JSON.parse(completion.choices[0]?.message?.content || '{}') as IssueDraft
  }catch{
    return{
      isActionIntent: false,
      title:'',
      body:'',
      labels:[]

    }
  }
}

/**
 * 2. HUMAN-IN-THE-LOOP (HITL) TERMINAL PROMPT
 */
async function promptConfirmation(promptText: string): Promise<boolean>{
  const rl = readline.createInterface({
    input:process.stdin,
    output: process.stdout
  })

  return new Promise((resolve)=>{
    rl.question(`\n⚠️  ${promptText} (y/N):`, (answer)=>{
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

/**
 * EXECUTOR: DISPATCHES TO GITHUB API
 */

export async function executeGatedAction(query:string): Promise<void>{
  console.log(`🔎 Retrieving context for query: "${query}"...`);
  const chunks = await hybridSearch(query, 3)

  // 1. classify intent and generate draft
  const draft = await classifyAndDraftAction(query, chunks)

  // Fallback branch: route to standard verified Q&A pipeline
  if(!draft.isActionIntent){
    console.log('ℹ️ No action intent detected. Handing over to standard Q&A.');
    const response = await askQuestion(query, 3)

    console.log('====================================================');
    console.log('💬 ANSWER:');
    console.log('====================================================');
    console.log(response.answer);
    console.log('\n====================================================');
    console.log('⚖️ VERIFICATION:');
    console.log('====================================================');
    console.log(`Status:     ${response.verification.isFaithful ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Confidence: ${(response.verification.confidenceScore * 100).toFixed(0)}%`);
    return;
  }

  // Action Branch
  console.log('\n📝 Drafted GitHub Issue:');
  console.log(`📌 Title:  ${draft.title}`);
  console.log(`🏷️ Labels: ${draft.labels.join(', ')}`);
  console.log(`📄 Body:\n${draft.body}\n`);

  // 2. Gate with judge model (Verify Groundedness)

  console.log('⚖️  Running Judge Gate to verify groundedness before action execution...');
  const combinedText = `${draft.title}\n${draft.body}`
  const verification = await evaluateFaithfulness(query, chunks, combinedText)

  if (!verification.isFaithful || verification.confidenceScore < 0.7) {
    console.log('\n🛑 ACTION BLOCKED BY JUDGE GATE');
    console.log(`Reason: ${verification.reasoning}`);
    console.log('False Action prevented: Issue draft contained ungrounded or hallucinated claims.');
    return;
  }
  console.log(`✅ Judge Gate Passed! (Confidence: ${(verification.confidenceScore * 100).toFixed(0)}%)`);

  // 3. Human in the loop confirmation
  const confirmed = await promptConfirmation('Do you confirm dispatching the issue to Github')
  if(!confirmed){
    console.log('❌ Action aborted by user.');
    return;
  }

  //4. Github API Execution
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO

  if (!process.env.GITHUB_TOKEN || !owner || !repo) {
    console.log('\n⚠️ [DRY-RUN MODE]: GITHUB_TOKEN or GITHUB_OWNER/REPO not set in .env.');
    console.log('Simulated successful GitHub API issue creation.');
    return;
  }
  try{
    const res = await octokit.issues.create({
      owner,
      repo,
      title: draft.title,
      body: `${draft.body}\n\n---\n*Auto-generated by VeriRAG Knowledge Assistant (Grounded & Verified)*`,
      labels: draft.labels,
    })
    console.log(`\n🎉 Success! Issue created at: ${res.data.html_url}`);
  } catch (err) {
    console.error('❌ Failed to post issue to GitHub API:', err);
  }
}

// Test runner for direct execution
async function run() {
  const query = 'File an issue: Downstream service returning 503 errors during open circuit state.';
  console.log(`🚀 Testing Action Pipeline for: "${query}"\n`);
  await executeGatedAction(query);
}

if (process.argv[1] && process.argv[1].endsWith('action.ts')) {
  run();
}
