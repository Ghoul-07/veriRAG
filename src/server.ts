import 'dotenv/config'
import path from 'path'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import type { Request, Response, NextFunction } from 'express'
import { ingestDocument } from './ingest.js'
import { askQuestion } from './rag.js'
import { hybridSearch } from './retrieve.js'
import { classifyAndDraftAction, dispatchGitHubIssue } from './action.js'
import { evaluateActionFaithfulness} from './judge.js'
import { listIndexedDocuments, deleteDocumentChunks } from './ingest.js'
import { streamAnswer } from './retrieve.js'
import pg from 'pg'

const { Pool } = pg
const pool = new Pool({connectionString:process.env.DATABASE_URL})

const app = express()


// 1. Security Headers
app.use(helmet({ contentSecurityPolicy: false }));

// 2. CORS
const allowedOrigins = [
  process.env.FRONTEND_URL
].filter(Boolean)

app.use(cors({
  origin: (origin, callback) =>{
    if(!origin || allowedOrigins.includes(origin)){
      callback(null, true)
    }
    else{
      callback(new Error('Blocked by CORS policy: Origin unauthorized.'))
    }
  },
  credentials:true
}))
app.use(express.json({limit:'2mb'}))


// 3. rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please wait a moment before sending more queries.' }
})


// 4. File upload bounds & filter
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (_req, file, cb) => {
    const allowedExts = ['.txt', '.md', '.json', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type (${ext}). Allowed: .txt, .md, .json, .pdf`));
    }
  },
});

// 5. Global Error Handler for Multer & Edge Cases
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'File size exceeds 10MB limit.' });
      return;
    }
    res.status(400).json({ error: `Upload error: ${err.message}` });
    return;
  }
  if (err) {
    res.status(500).json({ error: err.message || 'Internal server error.' });
    return;
  }
});

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

app.post('/api/v1/query', apiLimiter,async(req:Request, res:Response)=>{
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

// 4. prepare and evaluate action intent with judge
app.post('/api/v1/action/draft', async (req: Request, res:Response) : Promise<void> =>{
  try{
    const {query} = req.body
    if(!query){
      res.status(400).json({ error: 'Field "query" is required.' });
      return;
    }
    const chunks = await hybridSearch(query,3)
    const draft = await classifyAndDraftAction(query, chunks)

    if (!draft.isActionIntent) {
      res.status(200).json({ isAction: false, message: 'No action intent detected.' });
      return;
    }


    const verification  = await evaluateActionFaithfulness(query, draft.title, draft.body, chunks)

    if (!verification.isFaithful || verification.confidenceScore < 0.7) {
      res.status(200).json({
        isAction: true,
        status: 'BLOCKED',
        draft,
        verification,
      });
      return;
    }

    res.status(200).json({
      isAction: true,
      status: 'VERIFIED_READY',
      draft,
      verification,
    });

  }catch(err: any){
    console.error('Action Draft Error:', err);
    res.status(500).json({ error: 'Failed to draft action', details: err.message });
  }
})

// 5. Dispatch human-approved action to GitHub
app.post('/api/v1/action/execute', apiLimiter,async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, body, labels } = req.body;
    if (!title || !body) {
      res.status(400).json({ error: 'Missing title or body for execution.' });
      return;
    }

    const issueUrl = await dispatchGitHubIssue({ title, body, labels });
    res.status(200).json({ success: true, issueUrl });
  } catch (err: any) {
    console.error('Action Execution Error:', err);
    res.status(500).json({ error: 'Failed to execute action', details: err.message });
  }
});

// ============================================================================
// DOCUMENT MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * GET /api/v1/documents
 * Fetches all unique documents stored in pgvector along with their chunk counts.
 */
app.get('/api/v1/documents', async(req: Request, res:Response)=>{
  try {
    const documents = await listIndexedDocuments();
    res.status(200).json({ success: true, count: documents.length, documents });
  } catch (err: any) {
    console.error('Error fetching document list:', err);
    res.status(500).json({ error: 'Failed to retrieve documents', details: err.message });
  }
})

/**
 * DELETE /api/v1/documents/:documentName
 * Deletes a document and all of its chunks/vectors from the database.
 */

app.delete('/api/v1/documents/:documentName', async (req: Request, res: Response): Promise<void> => {
  try {
    const documentName = req.params.documentName as string;

    if (!documentName || typeof documentName !== 'string') {
      res.status(400).json({ error: 'Document name parameter is required.' });
      return;
    }

    const deletedChunks = await deleteDocumentChunks(documentName);

    if (deletedChunks === 0) {
      res.status(404).json({ error: `Document "${documentName}" not found.` });
      return;
    }

    res.status(200).json({
      success: true,
      message: `Successfully deleted document "${documentName}" and its ${deletedChunks} chunks.`,
      deletedChunks,
    });
  } catch (err: any) {
    console.error('Error deleting document:', err);
    res.status(500).json({ error: 'Failed to delete document', details: err.message });
  }
});


// ============================================================================
// SSE STREAMING ROUTE
// ============================================================================

/**
 * GET /api/v1/query/stream?prompt=...
 * Streams LLM tokens in real time and sends final metadata (sources + judge verdict).
 */

app.get('/api/v1/query/stream', async (req: Request, res:Response): Promise<void> => {
  const prompt = req.query.prompt as string
  const historyRaw = req.query.history as string

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'A query parameter "prompt" is required.' });
    return;
  }

  let parsedHistory = []
  if(historyRaw){
    try{
      parsedHistory = JSON.parse(decodeURIComponent(historyRaw))
    }catch{
      parsedHistory = []
    }
  }
  // Set SSE Headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendSSE = (event: string, payload: any) =>{
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  try {
    const result = await streamAnswer(prompt, parsedHistory ,(tokenText: string) => {
      sendSSE('token', { token: tokenText });
    });

    // Send final completion payload
    sendSSE('done', {
      sources: result.sources,
      judgeVerdict: result.judgeVerdict,
      fullAnswer: result.fullAnswer,
    });

    res.end();
  } catch (err: any) {
    console.error('SSE Generation Error:', err);
    sendSSE('error', { message: err.message || 'Stream processing failed' });
    res.end();
  }
})

app.listen(PORT, ()=>{
  console.log(`🚀 VeriRAG Backend Server listening on http://localhost:${PORT}`);
})