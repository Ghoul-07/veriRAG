import 'dotenv/config'
import pg from 'pg'
import Groq from 'groq-sdk'
// specifically for generating text embeddings
import { GoogleGenAI } from '@google/genai'

// connection pool manages a set of active database connections , so we don't have to open/close a TCP conn. on every query
const { Pool} = pg

async function runHealthCheck() {
  console.log('====================================================');
  console.log('🚀 RUNNING VERIRAG STACK HEALTH CHECK');
  console.log('====================================================\n');

  // --------------------------------------------------------------------------
  // CHECK 1: PostgreSQL & pgvector
  // Why: RAG requires storing text chunks along with high-dimensional vectors.
  // pgvector is the extension that allows PostgreSQL to store and run math
  // (like Cosine Similarity) directly on arrays of numbers.
  // --------------------------------------------------------------------------
  console.log('--- [1/3] Testing PostgreSQL + pgvector Extension ---');

  const pool = new Pool({connectionString: process.env.DATABASE_URL})

  try{
    // tell postgres to enable vector plugins 
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;')

    // query basic version to verify fundamental connectivity
    const versionRes = await pool.query('SELECT version();')
    console.log('✅ PostgreSQL connected successfully!');
    console.log(`   Database Engine: ${versionRes.rows[0].version.split(' on ')[0]}`);


    // confirm pgvector extension is actively loaded in the db
    const extCheck = await pool.query("SELECT extname FROM pg_extension WHERE extname='vector';")
    if (extCheck.rows.length > 0) {
      console.log('✅ pgvector extension is ACTIVE and ready for vector storage.');
    } else {
      console.error('❌ pgvector extension was not found.');
    }
  }catch (err) {
    console.error('❌ Database connection failed. Check if Docker container is running!');
    console.error(err);
  } finally {
    // Close the DB connection pool so the Node script can cleanly exit when done.
    await pool.end();
  }

  // --------------------------------------------------------------------------
  // CHECK 2: Gemini Embedding API
  // Why: Embeddings convert human text into mathematical vectors (lists of floats).
  // When you ask a question, we embed the question and find database chunks
  // pointing in the closest geometrical direction.
  // --------------------------------------------------------------------------
  console.log('\n--- [2/3] Testing Gemini Embeddings API ---');

  try{
    const ai = new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY})

    // send the test string to be transformed into a vector
    const response = await ai.models.embedContent({
      model:'gemini-embedding-001',
      contents:'Hello RAG world',
      config: {
        outputDimensionality: 768, //    forces Gemini to return exactly 768 dimensions
      },
    })
    
    // The response gives an array of floating point numbers in `values`
    const vector = response.embeddings?.[0]?.values ?? []
    
    if (vector.length === 0) {
      console.error('❌ Embedding returned empty array. Response structure:', JSON.stringify(response));
    } else {
      console.log('✅ Gemini Embedding API connected successfully!');
      console.log(`   Sample text converted to a vector of length: ${vector.length} dimensions`);
    }

  }catch(err){
    console.error('❌ Gemini Embeddings API test failed. Check your GEMINI_API_KEY in .env!');
    console.error(err);
  }

  // --------------------------------------------------------------------------
  // CHECK 3: Groq LLM API
  // Why: Groq provides near-instant inference for open-weight models (Llama 3.3).
  // We use this for generating grounded answers and for the LLM Judge Gate.
  // --------------------------------------------------------------------------
  console.log('\n--- [3/3] Testing Groq LLM API ---');

  try{
    const groq = new Groq({apiKey:process.env.GROQ_API_KEY})
     
    // make a simple connection call with zero temperature (deterministic output)
    const completion = await groq.chat.completions.create({
      model:'openai/gpt-oss-120b',
      messages:[
        {
          role:'user',
          content:'Reply strictly with the words.Groq connection successful!'
        }
      ],
      temperature:0
    })
    console.log('✅ Groq LLM connected successfully!');
    console.log(`   Model: openai/gpt-oss-120b`);
    console.log(`   Response: "${completion.choices[0]?.message?.content?.trim()}"`);

  } catch (err) {
    console.error('❌ Groq API test failed. Check your GROQ_API_KEY in .env!');
    console.error(err);
  }

  console.log('\n====================================================');
  console.log('🏁 HEALTH CHECK COMPLETE');
  console.log('====================================================');
  
}


runHealthCheck()