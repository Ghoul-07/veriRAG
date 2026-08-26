// ============================================================================
// INTERACTIVE CLI CHAT INTERFACE FOR VERIRAG
// ============================================================================

import 'dotenv/config'
import * as readline from 'readline'
import { askQuestion } from './rag.js'

const rl = readline.createInterface({
  input:process.stdin,
  output: process.stdout
})

console.log('\n====================================================');
console.log('🛡️  VeriRAG: Interactive Grounded Query Assistant');
console.log('Type your question below. Type "exit" or "quit" to stop.');
console.log('====================================================\n');

function promptUser(){
  rl.question('\n❓ Query >', async (input)=>{
    const query = input.trim()

    if(!query){
      promptUser()
      return
    }

    if(query.toLowerCase() === 'exit' || query.toLowerCase() === 'quit'){
      console.log('\n👋 Exiting VeriRAG. Goodbye!');
      rl.close()
      process.exit(0)
    }

    try {
      console.log('🔎 Retrieving and verifying answer...');
      const response = await askQuestion(query, 3);

      console.log('\n----------------------------------------------------');
      console.log('💬 ANSWER:');
      console.log('----------------------------------------------------');
      console.log(response.answer);

      console.log('\n----------------------------------------------------');
      console.log('⚖️ VERIFICATION:');
      console.log('----------------------------------------------------');
      console.log(`Status:     ${response.verification.isFaithful ? '✅ PASS' : '❌ FAIL'}`);
      console.log(`Confidence: ${(response.verification.confidenceScore * 100).toFixed(0)}%`);
      console.log(`Reasoning:  ${response.verification.reasoning}`);

      console.log('\n----------------------------------------------------');
      console.log('📚 SOURCES:');
      console.log('----------------------------------------------------');
      console.table(response.sources);
    } catch (err) {
      console.error('❌ Error processing request:', err);
    }

    promptUser()
  })
}

promptUser()