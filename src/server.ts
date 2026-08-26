import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import type { Request, Response } from 'express'
import { ingestDocument } from './ingest.js'
import { askQuestion } from './rag.js'
import { hybridSearch } from './retrieve.js'
import { classifyAndDraftAction } from './action.js'
import { evaluateFaithfulness } from './judge.js'
import pg from 'pg'
import { error } from 'node:console'

const { Pool } = pg
const pool = new Pool({connectionString:process.env.DATABASE_URL})

const app = express()
const upload = multer({storage:multer.memoryStorage() }) // In-memory file buffer

app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000

// ----------------------------------------------------------------------------
// 1. HEALTH CHECK
// ----------------------------------------------------------------------------

app.get('/health', (req:Request, res:Response)=>{
  return res.status(200).json({
    status:'ok',
    timestamp: new Date().toISOString()
  })
})

// ----------------------------------------------------------------------------
// 2. DOCUMENT INGESTION ENDPOINT (Upload & Chunk on the fly)
// ----------------------------------------------------------------------------

app.post('/api/v1/upload', upload.single('file'), async(req:Request, res:Response) : Promise<void>=>{
  try{
    let content = ''
    let filename = 'pasted-text.md'


    // Case A: uploaded via form
    if(req.file){
      filename = req.file.originalname,
      content =req.file.buffer.toString('utf-8')
    }
    // Case B: Raw text passed in JSON body
    else if(req.body.text){
      content = req.body.text,
      filename = req.body.filename || 'manual-entry.md'
    }
    else{
      res.status(400).json({error: 'No file or text payload provided'})
      return
    }

    if (!content.trim()) {
      res.status(400).json({ error: 'Uploaded content is empty.' });
      return;
    }

    const chunksIndexed = await ingestDocument(filename, content)

    res.status(200).json({
      message: 'Document successfully ingested and indexed.',
      filename,
      chunksIndexed,
    })
  } catch(err: any){
      console.error('❌ Ingestion Error:', err);
      res.status(500).json({ error: 'Failed to process document', details: err.message });
  }
})

// ----------------------------------------------------------------------------
// 3. QUERY ENDPOINT
// ----------------------------------------------------------------------------

app.post('/api/v1/query', async(req:Request, res:Response)=>{
  try{
    const {query, topK=3} = req.body
    if(!query){
      res.status(400).json({ error: 'Missing "query" parameter.' });
      return;
    }

    const result = await askQuestion(query, topK)
    res.status(200).json(result)

  } catch(err: any){
    console.error('❌ Query Error:', err);
    res.status(500).json({ error: 'Failed to process query', details: err.message });
  }
})


app.listen(PORT, ()=>{
  console.log(`🚀 VeriRAG Backend Server listening on http://localhost:${PORT}`);
})