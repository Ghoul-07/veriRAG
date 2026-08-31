# ⚡ VeriRAG: Grounded RAG Assistant with Hybrid Fusion & Gated Actions

VeriRAG is a production-grade Retrieval-Augmented Generation (RAG) system engineered to eliminate hallucinations, enforce groundedness, and safely execute downstream actions (e.g., GitHub issue dispatching). It combines multi-signal retrieval, Reciprocal Rank Fusion (RRF), an automated LLM-as-a-Judge faithfulness gate, and real-time token streaming.

---

## 🌐 Live Demo & Deployment

- **Frontend (SPA)**: [https://veri-rag-orcin.vercel.app/](https://veri-rag-orcin.vercel.app/) (Deployed on Vercel)
- **Backend (API)**: [verirag-api.onrender.com](https://verirag-api.onrender.com) (Deployed on Render)
- **Vector Database**: PostgreSQL with `pgvector` & GIN Indexes (Hosted on Supabase)

---

## 🏗️ Architecture

```
                              User Query
                                  │
                                  ▼
              [Intent Classifier & Contextual Rewriter]
                                  │
          ┌───────────────────────┴───────────────────────┐
          ▼ (Informational Search)          (Action Request) ▼
   Hybrid Retrieval Layer                       Hybrid Retrieval Layer
Dense (pgvector) + Sparse (tsvector)         Dense (pgvector) + Sparse (tsvector)
          │                                                  │
          ▼                                                  ▼
  RRF Candidate Fusion (k=60)                      RRF Candidate Fusion (k=60)
          │                                                  │
          ▼                                                  ▼
 Token Streaming Generation                       Grounded Issue Drafting
     (Groq / Gemini)                                          │
          │                                                  ▼
          ▼                                        LLM-as-a-Judge Gate
  LLM-as-a-Judge Gate                          (Faithfulness Threshold ≥ 0.70)
(Faithfulness & Groundedness)                                 │
          │                                     ┌──────────────┴──────────────┐
   ┌──────┴──────┐                              ▼                             ▼
   ▼             ▼                        Pass (≥70%)                   Fail (<70%)
Verified      Refusal                           │                             │
Answer      (Ungrounded)                        ▼                             ▼
(Streamed)                              HITL Approval                 Action Blocked
                                          (Confirmed)
                                                 │
                                                 ▼
                                    Octokit GitHub API
                                    (Issue Dispatched)
```

---

## 🔬 Core Engineering Highlights

### 1. Hybrid Retrieval & Reciprocal Rank Fusion (RRF)
Single-signal retrieval struggles with technical documentation containing mixed natural language, exact identifiers, ports, and configuration keys. VeriRAG unifies:

- **Dense Semantic Search**: 768-dimensional embeddings (`gemini-embedding-001`) indexed with `pgvector` HNSW cosine distance.
- **Sparse Lexical Search**: PostgreSQL `tsvector` indexed with GIN inverted indexes for exact keyword matching and tokenized fallback search.

Rankings are merged using Reciprocal Rank Fusion ($k=60$):

$$RRF\_Score(d \in D) = \sum_{m \in M} \frac{1}{k + r_m(d)}$$

### 2. LLM-as-a-Judge Verification Gate
Before responses or mutations are dispatched, an independent judge evaluator (`openai/gpt-oss-120b`) scores factual faithfulness against retrieved context chunks. Outputs with a confidence score below 0.70, or containing ungrounded claims, are intercepted and flagged.

### 3. Real-Time Token Streaming & Conversational Context
- **Query Contextualizer**: Rewrites follow-up questions containing ambiguous pronouns into standalone technical queries using rolling chat memory.
- **Chunk-by-Chunk Streaming**: Emits live tokens to the React frontend while evaluating judge metrics asynchronously upon stream completion.

### 4. Safe Action Execution Layer (HITL)
- **Intent Detection**: Directs mutation-oriented queries to structured issue drafting.
- **Human-in-the-Loop (HITL)**: Requires explicit user approval before triggering write operations via the Octokit GitHub REST API.

---

## 📊 Benchmark Evaluation Report

Evaluated over a hand-labeled 26-question benchmark suite (`data/eval-dataset.json`):

| Metric | Baseline (Dense-Only) | VeriRAG (Hybrid RRF + Judge) | Improvement |
|---|---|---|---|
| **Top-3 Retrieval Hit Rate** | 80.0% (16/20) | **85.0% (17/20)** | **+5.0% Recall Boost** |
| **Faithful Groundedness %** | Unverified / Raw | **86.4%** | **Hallucinations Intercepted** |
| **False-Action Rate** | ~25.0% (Ungated) | **0.0%** | **Zero Unsafe Dispatches** |

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js, TypeScript, `pg` (PostgreSQL client), `@google/genai`, `groq-sdk`, `octokit`
- **Database & Search**: Supabase (`pgvector`, `tsvector`, GIN Indexing)
- **Frontend**: React.js, Vite, Tailwind CSS, Lucide Icons
- **Infrastructure**: Render (API Web Service), Vercel (Client Hosting), Docker

---

## 🚀 Getting Started

### 1. Clone & Install

```bash
git clone https://github.com/Ghoul-07/veriRAG.git
cd veriRAG
npm install
```

### 2. Configure Environment (`.env`)

```env
# Database
DATABASE_URL=postgresql://postgres.<PROJECT-REF>:<PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres

# AI Models & APIs
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key

# GitHub Safe Actions
GITHUB_TOKEN=ghp_your_github_pat
GITHUB_OWNER=your_github_username
GITHUB_REPO=your_target_repo

# Server
PORT=5000
FRONTEND_URL=http://localhost:5173
```

### 3. Ingest Documents

```bash
npx tsx src/ingest.ts
```

### 4. Run Development Server

```bash
# Start backend
npm run dev

# Start frontend (in client directory)
cd client && npm run dev
```

---

## 📡 API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/query` | Executes hybrid search, streams answer tokens, and returns judge metrics |
| `POST` | `/api/v1/upload` | Ingests `.txt` or `.md` files, computes embeddings, and stores chunks in Supabase |
| `GET` | `/api/v1/documents` | Retrieves metadata and chunk counts for all indexed documents |
| `GET` | `/health` | Server health and proxy validation check |
