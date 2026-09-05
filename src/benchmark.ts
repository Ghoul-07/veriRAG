// ============================================================================
// VERIRAG AUTOMATED EVALUATION & BENCHMARK RUNNER
// ============================================================================
// Purpose:
// 1. Programmatically iterates through all 20 test cases in data/eval-dataset.json.
// 2. Evaluates Dense Vector Search (Baseline) vs. Hybrid RRF Search (v2) for Top-3 Recall.
// 3. Tests Groq generation and Judge Gate verification on in-scope and out-of-scope queries.
// 4. Tests Action Drafting to ensure hallucinated/unsupported actions are blocked (0% False Actions).
// 5. Outputs a final quantitative evaluation report comparing Baseline vs. v2.

import 'dotenv/config'
import fs, { stat } from 'fs';
import path from 'path';
import pg from 'pg';
import { vectorSearch, hybridSearch, SearchResult } from './retrieve.js';
import { askQuestion } from './rag.js';
import { classifyAndDraftAction } from './action.js';
import { evaluateFaithfulness, evaluateActionFaithfulness } from './judge.js';

const { Pool } = pg
const isLocal = 
  !process.env.DATABASE_URL || 
  process.env.DATABASE_URL.includes('localhost') || 
  process.env.DATABASE_URL.includes('127.0.0.1') ||
  process.env.DATABASE_URL.includes('@postgres:'); // Docker service name

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

interface EvalTestCase{
  id: string;
  query: string;
  category: 'semantic' | 'keyword' | 'out_of_scope' | 'action';
  expectedChunkIds: string[];
  groundTruthAnswer: string;
  intentType: 'informational' | 'action_draft_issue';
  expectedAction: boolean;
}

/**
 * Tracks running counters throughout the benchmark loop to calculate final percentages.
 */
interface BenchmarkStats {
  totalQueries: number;
  inScopeQueries: number;  // Number of queries where answers actually exist in the docs (excludes out-of-scope)
  denseHits: number;     // How many times Dense Vector search found at least 1 expected chunk in its Top-3
  hybridHits: number;        // How many times Hybrid (RRF) search found at least 1 expected chunk in its Top-3
 
  // classification matrix for precision/ recall/ f1_score
  truePositives: number;   // In-scope question correctly answered & verified faithful
  falsePositives: number;  // Hallucinated claims or answered when out-of-scope
  falseNegatives: number;  // In-scope question that failed or falsely claimed missing context
  trueNegatives: number;   // Out-of-scope question cleanly caught and refused
  falseActions: number;
}

/**
 * Executes an async task with automatic retry and exponential backoff for HTTP 429 / RateLimit errors.
 */
async function withRetry<T>(fn: () => Promise<T>, retries= 4, delayMs= 3000): Promise<T>{
  try{
    return await fn()
  }catch(err: any){
    if(retries > 0 && (err?.status === 429 || err?.message?.includes('Rate Limit') || err?.error?.code === 'rate_limit_exceeded')){
      const waitTime = err?.headers?.get('retry-after') ? parseInt(err?.headers.get('retry-after')) * 1000 + 1000 : delayMs
      console.log(`   ⏳ Rate limit reached. Backing off for ${(waitTime / 1000).toFixed(1)}s before retry...`);
      await new Promise((r) => setTimeout(r, waitTime))
      return withRetry(fn, retries - 1, delayMs * 1.5)
    }
    throw err
  }
}

// hit checking: checks if chunk ID matches OR if ground truth answer keywords exist in the retrieved content
function calculateHits(retrieved: SearchResult[], tc: EvalTestCase): boolean{
  if(tc.expectedChunkIds.length === 0) return true       // Out-of-scope has no target chunks
  const idMatch = retrieved.some((r) => tc.expectedChunkIds.includes(r.id))
  if(idMatch) return true

  // check if ground truth concepts appear in retrieved text
  const keyTokens = tc.groundTruthAnswer
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(' ')
    .filter((w) => w.length > 4)

  return retrieved.some((r) =>{
    const content = r.content.toLowerCase()
    const matches = keyTokens.filter((token) => content.includes(token))
    return matches.length >= 2
  })
}


async function runBenchmark(){
  const datasetPath = path.resolve(process.cwd(), 'data', 'eval-dataset.json')
  if(!fs.existsSync(datasetPath)){
    console.error('❌ Could not find data/eval-dataset.json. Please ensure the file exists.');
    process.exit(1);
  }

  const testCases : EvalTestCase[] = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'))

  console.log('================================================================');
  console.log(`🚀 RUNNING VERIRAG BENCHMARK EVALUATION (${testCases.length} TEST CASES)`);
  console.log('================================================================\n');

  const stats: BenchmarkStats = {
    totalQueries: testCases.length,
    inScopeQueries: 0,
    denseHits: 0,
    hybridHits: 0,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    trueNegatives: 0,
    falseActions: 0,
  };

  for(let i = 0; i < testCases.length; i++){
    const tc = testCases[i]
    const isDocQuery = tc.category !== 'out_of_scope' && tc.intentType !== 'action_draft_issue';
    if(isDocQuery) stats.inScopeQueries++

   process.stdout.write(`[${i + 1}/${testCases.length}] Testing ${tc.id} (${tc.category.toUpperCase()}): "${tc.query.slice(0, 45)}..." `);

    // 1. Evaluate Retrieval: Dense Vs Hybrid
    const denseResult = await vectorSearch(tc.query, 3)
    const hybridResult = await hybridSearch(tc.query, 3)

    const denseHits = calculateHits(denseResult, tc)
    const hybridHits = calculateHits(hybridResult, tc)

    if(isDocQuery){
      if (denseHits) stats.denseHits++;
      if (hybridHits) stats.hybridHits++;
    }

    // 2. Evaluate Actions vs Answers
    if(tc.intentType === 'action_draft_issue'){
      let draft
      try{
        draft = await classifyAndDraftAction(tc.query, hybridResult)
      } catch(err: any){
        draft = {isActionIntent: false, title:'', body:''}
      }
            
      if(draft.isActionIntent){
        console.log('⚖️  Running Judge Gate on drafted action payload...');
        
        const verification = await evaluateActionFaithfulness(tc.query, draft.title, draft.body,hybridResult)
        const wouldTrigger = verification.isFaithful && verification.confidenceScore >= 0.7

        // If an action triggered when it was NOT expected -> False Action!
        if (wouldTrigger && !tc.expectedAction) {
          stats.falseActions++;
          stats.falsePositives++;
          console.log('❌ (False Action')
        } else if(wouldTrigger && tc.expectedAction){
          stats.truePositives++;
          console.log('✅ (Action Verified)')
        }
        else if(!wouldTrigger && !tc.expectedAction){
          stats.trueNegatives++;
          console.log('✅ (Unsafe Action Blocked)');
        }
        else{
          stats.falseNegatives++;
          console.log('⚠️ (Action Missed)');
        }
      }
      else{
        if (!tc.expectedAction) {
          stats.trueNegatives++;
          console.log('✅ (Unsafe Action Filtered by Policy/Classifier)');
        } else {
          stats.falseNegatives++;
          console.log('⚠️ (Expected Action Failed Intent Classification)');
        }
      }
    }
    else{
      const response = await withRetry(() => askQuestion(tc.query, 5))
      const { isFaithful, hasSufficientContext, confidenceScore} = response.verification
     
      if (tc.category === 'out_of_scope') {
        // Out-of-scope expectation: System should refuse / state lack of context
        if (!hasSufficientContext || !isFaithful) {
          stats.trueNegatives++;
          console.log('✅ (Refusal / True Negative)');
        } else {
          stats.falsePositives++;
          console.log('❌ (Hallucination / False Positive)');
        }
      } else {
        // In-scope expectation: System should resolve the query using retrieved context
       if (isFaithful && hasSufficientContext && confidenceScore >= 0.7) {
          stats.truePositives++;
          console.log('✅ (Faithful / True Positive)');
        } else if (!hasSufficientContext || response.answer.includes('cannot answer')) {
          // If the model refused an in-scope question, it's a FALSE NEGATIVE (missed answer), NOT a hallucination!
          stats.falseNegatives++;
          console.log('⚠️ (False Negative / Premature Refusal)');
        } else {
          // It answered with concrete assertions that weren't in the chunks
          stats.falsePositives++;
          console.log('❌ (Hallucination / False Positive)');
          console.log(`   👉 Answer: "${response.answer.slice(0, 150)}..."`);
          console.log(`   👉 Judge Reasoning: ${response.verification.reasoning}`);
        }
      }
    }

    // Small cooldown between LLM calls to respect API limits
    await new Promise((r) => setTimeout(r, 12000));
  } 

  // 3. Compute Metrices

  const precision = stats.truePositives + stats.falsePositives > 0 ?
    (stats.truePositives / (stats.truePositives + stats.falsePositives)) * 100 : 0
    
  const recall = stats.truePositives + stats.falseNegatives > 0 ?
    (stats.truePositives / (stats.truePositives + stats.falseNegatives)) * 100 : 0

  const f1_score = precision + recall > 0 ?
    (2 * (precision * recall)) / (precision + recall) : 0

  const accuracy = ((stats.trueNegatives + stats.truePositives) / stats.totalQueries) * 100


  const denseHitRate = stats.inScopeQueries > 0 ? ((stats.denseHits / stats.inScopeQueries) * 100).toFixed(1) : '0';
  const hybridHitRate = stats.inScopeQueries > 0 ? ((stats.hybridHits / stats.inScopeQueries) * 100).toFixed(1) : '0';
  const falseActionRate = ((stats.falseActions / stats.totalQueries) * 100).toFixed(1);

  console.log('\n================================================================');
  console.log('📊 FINAL QUANTITATIVE BENCHMARK REPORT');
  console.log('================================================================\n');


  console.table([
    { Metric: 'Total Test Cases', Value: stats.totalQueries },
    { Metric: 'Top-3 Recall (Dense Baseline)', Value: `${denseHitRate}% (${stats.denseHits}/${stats.inScopeQueries})` },
    { Metric: 'Top-3 Recall (Hybrid RRF)', Value: `${hybridHitRate}% (${stats.hybridHits}/${stats.inScopeQueries})` },
    { Metric: 'Overall Accuracy', Value: `${accuracy.toFixed(1)}%` },
    { Metric: 'Faithfulness Precision', Value: `${precision.toFixed(1)}%` },
    { Metric: 'Generation Recall', Value: `${recall.toFixed(1)}%` },
    { Metric: 'F1-Score', Value: `${f1_score.toFixed(1)}%` },
    { Metric: 'False-Action Rate', Value: `${falseActionRate}%` },
  ]);

  console.log('\n✅ Evaluation complete. All quantitative metrics computed.');
  await pool.end();

}

runBenchmark().catch((err) => {
  console.error('❌ Benchmark error:', err);
  pool.end();
})
