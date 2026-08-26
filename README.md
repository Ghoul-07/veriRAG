# VeriRAG: Grounded RAG Assistant with Hybrid Fusion & Gated Actions

VeriRAG is a retrieval-augmented generation (RAG) system engineered to eliminate hallucinations and safely execute downstream actions (e.g., GitHub issue drafting). It replaces unverified generation with a hybrid multi-signal retrieval pipeline, Reciprocal Rank Fusion (RRF), and an automated LLM-as-a-Judge faithfulness gate.

---

## 🏗️ Architecture

```
User Query
    │
    ▼
[Intent Classifier]
    │
    ├──────────────────────────────┬──────────────────────────────┐
    ▼ (Informational)               ▼ (Action Request)
Hybrid Retrieval Layer          Hybrid Retrieval Layer
Dense (pgvector) + Sparse       Dense (pgvector) + Sparse
    │                                ▼
    ▼                           RRF Candidate Fusion
RRF Candidate Fusion                 │
    │                                ▼
    ▼                           Grounded Issue Drafting
Grounded Generation                  │
    │                                ▼
    ▼                           LLM-as-a-Judge Gate
LLM-as-a-Judge Gate            (Faithfulness Threshold)
    │                                │
    ├──────────────┐          ┌──────┴──────┐
    ▼              ▼          ▼             ▼
Verified        Refusal     Pass (≥70%)   Fail (<70%)
Answer        (Ungrounded)     │              │
                                ▼              ▼
                          HITL Approval   Action Blocked
                                │
                          (Confirmed)
                                ▼
                        Octokit GitHub API
                        (Issue Dispatched)
```

---

## 🔬 Core Engineering Highlights

### 1. Hybrid Search & Reciprocal Rank Fusion (RRF)

Single-signal retrieval often fails on technical documents containing mixed natural language and exact tokens (ports, error codes, config keys). VeriRAG combines:

- **Dense Semantic Search:** 768-dimensional embeddings (`text-embedding-004`) indexed with pgvector HNSW.
- **Sparse Keyword Search:** PostgreSQL `tsvector` indexed with GIN inverted indexes for exact keyword matching.

The rankings are fused using Reciprocal Rank Fusion (k=60):

$$RRF\_Score(d \in D) = \sum_{m \in M} \frac{1}{k + r_m(d)}$$

Where *M* is the set of retrieval systems (Dense and Sparse), and *r<sub>m</sub>(d)* is the rank position of document *d* within system *m*.

### 2. LLM-as-a-Judge Verification Gate

Before any output or downstream action is permitted, a secondary judge model (`openai/gpt-oss-120b`) evaluates factual faithfulness between the retrieved chunks and the generated claims. Answers with confidence scores below 0.70, or containing unsupported claims, are blocked.

### 3. Safe Action Execution Layer

- **Intent Detection:** Dispatches action queries to structured issue drafting.
- **Human-in-the-Loop (HITL):** Requires manual terminal confirmation before dispatching API mutations.
- **Zero False-Action Safety:** Prevents hallucinated or out-of-scope queries from triggering external webhooks/APIs.

---

## 📊 Benchmark Evaluation Report

Evaluated programmatically over a hand-labeled 26-question benchmark suite (`data/eval-dataset.json`) across semantic, exact-keyword, out-of-scope, and action queries:

| Metric | Baseline (v1: Dense-Only) | VeriRAG (v2: Hybrid RRF + Judge) | Improvement |
|---|---|---|---|
| **Top-3 Retrieval Hit Rate** | 80.0% (16/20) | **85.0% (17/20)** | **+5.0% Recall Boost** |
| **Faithful Groundedness %** | Unverified / Raw | **86.4%** | **Hallucinations Intercepted** |
| **False-Action Rate** | ~25.0% (Ungated) | **0.0%** | **Zero Unsafe Dispatches** |

---

## 🚀 Getting Started

### Prerequisites

- Node.js v18+
- Docker & Docker Compose
- Groq API Key & Gemini API Key
- GitHub Personal Access Token (PAT)

### Setup

**1. Clone repository & install dependencies:**

```bash
git clone https://github.com/Ghoul-07/veriRAG.git
cd veriRAG
npm install
```

**2. Configure environment variables (`.env`):**

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/verirag_db
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key
GITHUB_TOKEN=ghp_your_github_token
GITHUB_OWNER=your_username
GITHUB_REPO=your_repo
```

**3. Start PostgreSQL with pgvector:**

```bash
docker run -d --name pgvector-verirag \
  -e POSTGRES_DB=verirag_db \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

**4. Initialize schema & ingest documents:**

```bash
npx tsx src/ingest.ts
```

---

## 🛠️ CLI Usage & Scripts

**Interactive query REPL:**

```bash
npx tsx src/cli.ts
```

**Run safe action layer (GitHub issue dispatch):**

```bash
npx tsx src/action.ts "File an issue: Downstream service returning 503 errors during open circuit state."
```

**Execute quantitative benchmark runner:**

```bash
npx tsx src/benchmark.ts
```
