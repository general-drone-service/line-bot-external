# RAG AI Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace keyword intent router with Claude Haiku + Voyage-3 RAG so the LINE bot can answer any customer question using company knowledge.

**Architecture:** All text messages go to Claude Haiku via Messages API with two tools (lookup_quote, search_knowledge). Haiku decides when to call tools. Knowledge is stored as embedded markdown chunks in Supabase pgvector. Quote lookups return Flex Messages; everything else returns plain text.

**Tech Stack:** Next.js, @anthropic-ai/sdk (Haiku), Voyage-3 embeddings, Supabase pgvector, LINE Messaging API

**Spec:** `docs/superpowers/specs/2026-03-27-rag-chatbot-design.md`

---

## Task 1: Supabase Migration — knowledge_chunks Table

**Files:**
- Create: `supabase/migrations/001_knowledge_chunks.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- supabase/migrations/001_knowledge_chunks.sql
create extension if not exists vector;

create table knowledge_chunks (
  id         uuid primary key default gen_random_uuid(),
  source     text not null,
  heading    text,
  content    text not null,
  embedding  vector(1024) not null,
  created_at timestamptz default now()
);

create index on knowledge_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 10);

create or replace function match_knowledge(
  query_embedding vector(1024),
  match_count int default 3,
  match_threshold float default 0.3
) returns table (
  source text,
  heading text,
  content text,
  similarity float
) language sql stable as $$
  select source, heading, content,
         1 - (embedding <=> query_embedding) as similarity
  from knowledge_chunks
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

- [ ] **Step 2: Run migration on Supabase**

Run the SQL in Supabase Dashboard → SQL Editor, or via CLI:
```bash
supabase db push
```

Expected: Table `knowledge_chunks` created with vector index and `match_knowledge` function.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/001_knowledge_chunks.sql
git commit -m "feat: add knowledge_chunks table with pgvector and match_knowledge RPC"
```

---

## Task 2: Knowledge Base Markdown Files

**Files:**
- Create: `knowledge/company.md`
- Create: `knowledge/services.md`
- Create: `knowledge/pricing.md`
- Create: `knowledge/inspection.md`
- Create: `knowledge/training.md`
- Create: `knowledge/franchise.md`
- Create: `knowledge/projects.md`
- Create: `knowledge/faq.md`
- Create: `knowledge/regulations.md`

- [ ] **Step 1: Create all 9 knowledge markdown files**

Content comes from the website data already fetched during brainstorming (https://www.drone168.com/ and sub-pages). Each file should be structured with `##` headings that serve as natural chunk boundaries. Target 300-500 characters per section.

Example structure for `knowledge/company.md`:
```markdown
## 公司簡介

一般無人機服務股份有限公司（General Drone Service）成立於 2025 年，是台灣首家專注於無人機外牆清洗的技術領先企業。總部位於台北市松山區光復北路11巷46號2樓。

## 聯絡資訊

- 電話：02-7733-7678
- Email：contact@drone168.com
- 地址：台北市松山區光復北路11巷46號2樓
- LINE 官方帳號：@058xfgns
- 網站：https://drone168.com
- 免費報價：https://quote.drone168.com

## 營業時間

- 週一至週五：09:00-18:00
- 週六：09:00-12:00
- 週日及國定假日：休息

## 認證與資格

- 民航局遙控無人機能力審查核准證明（有效期至 2027 年 12 月 04 日）
- 職業安全衛生認證
- 環保標章認證
- 10 年以上無人機操作經驗
- 零事故紀錄
- 客戶評分：4.9/5（127 則評論）
```

Follow the same `##`-delimited structure for all files. Use the content fetched from:
- `/` (homepage) → company.md, faq.md
- `/solutions` → services.md
- `/solutions/cleaning` → services.md (cleaning details)
- `/solutions/inspection` → inspection.md
- `/pricing` → pricing.md
- `/about` → company.md
- `/projects` → projects.md
- `/training` → training.md
- `/franchise` → franchise.md
- `/blog` articles → regulations.md, faq.md (supplement)

- [ ] **Step 2: Commit**

```bash
git add knowledge/
git commit -m "feat: add knowledge base markdown files from drone168.com"
```

---

## Task 3: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install packages**

```bash
npm install @anthropic-ai/sdk
```

Note: Voyage-3 uses a plain fetch call (no SDK needed).

- [ ] **Step 2: Install tsx for seed script**

```bash
npm install -D tsx
```

- [ ] **Step 3: Add seed script to package.json**

Add to `scripts` in `package.json`:
```json
"seed": "tsx scripts/seed-knowledge.ts"
```

- [ ] **Step 4: Update .env.example**

Append to `.env.example`:
```env

# AI (Claude Haiku)
ANTHROPIC_API_KEY=

# Embeddings (Voyage-3)
VOYAGE_API_KEY=
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "feat: add @anthropic-ai/sdk, tsx deps and AI env vars"
```

---

## Task 4: Voyage-3 Embedding Module

**Files:**
- Create: `src/lib/knowledge/embed.ts`
- Create: `src/lib/knowledge/index.ts`

- [ ] **Step 1: Create embed.ts**

```typescript
// src/lib/knowledge/embed.ts
const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings"

function getVoyageApiKey(): string {
  const key = process.env.VOYAGE_API_KEY
  if (!key) throw new Error("Missing VOYAGE_API_KEY")
  return key
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getVoyageApiKey()}`,
    },
    body: JSON.stringify({
      input: texts,
      model: "voyage-3",
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Voyage API error ${res.status}: ${err}`)
  }

  const json = (await res.json()) as {
    data: { embedding: number[] }[]
  }
  return json.data.map((d) => d.embedding)
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text])
  return embedding
}
```

- [ ] **Step 2: Create index.ts**

```typescript
// src/lib/knowledge/index.ts
export { embedTexts, embedQuery } from "./embed"
export { searchKnowledge } from "./search"
```

Note: `search.ts` will be created in Task 5. This file will have a temporary import error until then.

- [ ] **Step 3: Commit**

```bash
git add src/lib/knowledge/embed.ts src/lib/knowledge/index.ts
git commit -m "feat: add Voyage-3 embedding module"
```

---

## Task 5: Knowledge Search Module

**Files:**
- Create: `src/lib/knowledge/search.ts`

- [ ] **Step 1: Create search.ts**

```typescript
// src/lib/knowledge/search.ts
import { createClient } from "@supabase/supabase-js"
import { embedQuery } from "./embed"

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL ?? process.env.QUOTE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.QUOTE_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  return createClient(url, key)
}

export interface KnowledgeChunk {
  source: string
  heading: string | null
  content: string
  similarity: number
}

export async function searchKnowledge(
  query: string,
  topK = 3,
  threshold = 0.3
): Promise<KnowledgeChunk[]> {
  const embedding = await embedQuery(query)
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase.rpc("match_knowledge", {
    query_embedding: embedding,
    match_count: topK,
    match_threshold: threshold,
  })

  if (error) {
    console.error("Knowledge search error:", error.message)
    return []
  }

  return (data ?? []) as KnowledgeChunk[]
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/knowledge/search.ts
git commit -m "feat: add pgvector knowledge search module"
```

---

## Task 6: Seed Script

**Files:**
- Create: `scripts/seed-knowledge.ts`

- [ ] **Step 1: Create seed-knowledge.ts**

```typescript
// scripts/seed-knowledge.ts
import fs from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings"

// ─── Config ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.QUOTE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.QUOTE_SUPABASE_SERVICE_ROLE_KEY
const VOYAGE_KEY = process.env.VOYAGE_API_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}
if (!VOYAGE_KEY) {
  console.error("Missing VOYAGE_API_KEY")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── Chunking ────────────────────────────────────────────────────────
interface Chunk {
  source: string
  heading: string | null
  content: string
}

function chunkMarkdown(filename: string, markdown: string): Chunk[] {
  const chunks: Chunk[] = []
  const sections = markdown.split(/^## /m)

  for (const section of sections) {
    const trimmed = section.trim()
    if (!trimmed) continue

    const newlineIdx = trimmed.indexOf("\n")
    if (newlineIdx === -1) continue

    const heading = trimmed.slice(0, newlineIdx).trim()
    const content = trimmed.slice(newlineIdx + 1).trim()
    if (!content) continue

    chunks.push({ source: filename, heading, content })
  }

  return chunks
}

// ─── Embedding ───────────────────────────────────────────────────────
async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_KEY}`,
    },
    body: JSON.stringify({ input: texts, model: "voyage-3" }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Voyage API error ${res.status}: ${err}`)
  }

  const json = (await res.json()) as { data: { embedding: number[] }[] }
  return json.data.map((d) => d.embedding)
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const knowledgeDir = path.resolve(__dirname, "../knowledge")
  const files = fs.readdirSync(knowledgeDir).filter((f) => f.endsWith(".md"))

  if (files.length === 0) {
    console.error("No .md files found in knowledge/")
    process.exit(1)
  }

  // Parse all chunks
  const allChunks: Chunk[] = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(knowledgeDir, file), "utf-8")
    const chunks = chunkMarkdown(file, content)
    allChunks.push(...chunks)
    console.log(`  ${file}: ${chunks.length} chunks`)
  }

  console.log(`\nTotal: ${allChunks.length} chunks from ${files.length} files`)

  // Embed in batches of 20
  const BATCH_SIZE = 20
  const embeddings: number[][] = []
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE)
    const texts = batch.map((c) => `${c.heading}\n\n${c.content}`)
    console.log(`Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allChunks.length / BATCH_SIZE)}...`)
    const batchEmbeddings = await embedBatch(texts)
    embeddings.push(...batchEmbeddings)
  }

  // Clear existing data
  console.log("\nClearing existing knowledge_chunks...")
  const { error: deleteError } = await supabase.from("knowledge_chunks").delete().neq("id", "00000000-0000-0000-0000-000000000000")
  if (deleteError) {
    console.error("Delete error:", deleteError.message)
    process.exit(1)
  }

  // Insert new data
  console.log("Inserting new chunks...")
  const rows = allChunks.map((chunk, i) => ({
    source: chunk.source,
    heading: chunk.heading,
    content: chunk.content,
    embedding: JSON.stringify(embeddings[i]),
  }))

  // Insert in batches of 20
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error: insertError } = await supabase.from("knowledge_chunks").insert(batch)
    if (insertError) {
      console.error(`Insert error at batch ${i}:`, insertError.message)
      process.exit(1)
    }
  }

  console.log(`\nDone! Seeded ${allChunks.length} chunks.`)
}

main().catch((err) => {
  console.error("Seed failed:", err)
  process.exit(1)
})
```

- [ ] **Step 2: Commit**

```bash
git add scripts/seed-knowledge.ts
git commit -m "feat: add knowledge base seed script (chunk + embed + upsert)"
```

---

## Task 7: AI Module — Client, System Prompt, Tools

**Files:**
- Create: `src/lib/ai/client.ts`
- Create: `src/lib/ai/system-prompt.ts`
- Create: `src/lib/ai/tools.ts`
- Create: `src/lib/ai/index.ts`

- [ ] **Step 1: Create client.ts**

```typescript
// src/lib/ai/client.ts
import Anthropic from "@anthropic-ai/sdk"

let _client: Anthropic | null = null

export function getAnthropicClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY")
    _client = new Anthropic({ apiKey })
  }
  return _client
}
```

- [ ] **Step 2: Create system-prompt.ts**

```typescript
// src/lib/ai/system-prompt.ts
export const SYSTEM_PROMPT = `你是 GDS 低空作業（一般無人機服務股份有限公司）的 LINE 官方帳號客服。

規則：
- 用繁體中文、親切專業的語氣回答
- 回答控制在 200 字以內，適合手機閱讀
- 有 search_knowledge 工具可查詢公司知識庫，不確定時請先搜尋
- 搜尋後仍不確定的資訊不要編造，請客戶聯繫人工客服
- 客戶提到報價編號（Q-XXXXXXXX-XXX）時，使用 lookup_quote 工具查詢

公司基本資訊：
- 電話：02-7733-7678
- Email：contact@drone168.com
- 地址：台北市松山區光復北路11巷46號2樓
- 營業時間：週一至週五 09:00-18:00，週六 09:00-12:00
- LINE 官方帳號：@058xfgns
- 免費報價：https://quote.drone168.com`
```

- [ ] **Step 3: Create tools.ts**

```typescript
// src/lib/ai/tools.ts
import type Anthropic from "@anthropic-ai/sdk"
import { lookupQuote } from "@/lib/services/quote-api"
import { searchKnowledge } from "@/lib/knowledge"

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "lookup_quote",
    description:
      "查詢客戶的報價單資料。當客戶提到報價編號（格式：Q-XXXXXXXX-XXX）時使用。",
    input_schema: {
      type: "object" as const,
      properties: {
        quote_code: {
          type: "string",
          description: "報價編號，如 Q-20260327-619",
        },
      },
      required: ["quote_code"],
    },
  },
  {
    name: "search_knowledge",
    description:
      "搜尋公司知識庫，找出與客戶問題相關的資訊。用於回答服務內容、價格、流程、法規等問題。",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "搜尋關鍵詞或問題摘要",
        },
      },
      required: ["query"],
    },
  },
]

export interface ToolResult {
  tool_use_id: string
  content: string
  /** If this tool returns structured quote data for Flex Message rendering */
  quoteData?: import("@/lib/services/quote-api").QuoteData | null
}

export async function executeTool(
  name: string,
  toolUseId: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  switch (name) {
    case "lookup_quote": {
      const code = input.quote_code as string
      const quote = await lookupQuote(code)
      if (!quote) {
        return {
          tool_use_id: toolUseId,
          content: `找不到報價編號 ${code} 的報價單。`,
          quoteData: null,
        }
      }
      return {
        tool_use_id: toolUseId,
        content: JSON.stringify({
          quote_code: quote.quote_code,
          total: quote.pricing.total,
          suggested_days: quote.time_result.suggested_days,
          valid_until: quote.expires_at ?? quote.pricing.valid_until,
          pdf_url: quote.pdf_url ?? null,
        }),
        quoteData: quote,
      }
    }

    case "search_knowledge": {
      const query = input.query as string
      const chunks = await searchKnowledge(query)
      if (chunks.length === 0) {
        return { tool_use_id: toolUseId, content: "知識庫中沒有找到相關資訊。" }
      }
      const text = chunks
        .map((c) => `[${c.source}${c.heading ? " > " + c.heading : ""}]\n${c.content}`)
        .join("\n\n---\n\n")
      return { tool_use_id: toolUseId, content: text }
    }

    default:
      return { tool_use_id: toolUseId, content: `Unknown tool: ${name}` }
  }
}
```

- [ ] **Step 4: Create index.ts**

```typescript
// src/lib/ai/index.ts
export { handleAiChat } from "./chat"
```

Note: `chat.ts` is created in Task 8.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/client.ts src/lib/ai/system-prompt.ts src/lib/ai/tools.ts src/lib/ai/index.ts
git commit -m "feat: add AI module — Anthropic client, system prompt, tool definitions and executor"
```

---

## Task 8: AI Chat Handler

**Files:**
- Create: `src/lib/ai/chat.ts`

- [ ] **Step 1: Create chat.ts**

```typescript
// src/lib/ai/chat.ts
import { getAnthropicClient } from "./client"
import { SYSTEM_PROMPT } from "./system-prompt"
import { TOOLS, executeTool } from "./tools"
import type { ToolResult } from "./tools"
import { reply } from "@/lib/line"
import type { LineMessage } from "@/lib/line"
import { buildQuoteBubble } from "@/lib/flex"
import type { QuoteData } from "@/lib/services/quote-api"

export async function handleAiChat(replyToken: string, userText: string) {
  const client = getAnthropicClient()

  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    { role: "user", content: userText },
  ]

  let quoteData: QuoteData | null = null

  // Tool use loop (max 3 iterations to prevent runaway)
  for (let i = 0; i < 3; i++) {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: messages as Parameters<typeof client.messages.create>[0]["messages"],
    })

    if (response.stop_reason === "end_turn") {
      // Extract text from response
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("")

      // Build LINE messages
      const lineMessages: LineMessage[] = []

      if (quoteData) {
        lineMessages.push(buildQuoteBubble(quoteData))
      }

      if (text) {
        lineMessages.push({ type: "text", text })
      }

      if (lineMessages.length > 0) {
        await reply(replyToken, lineMessages)
      }
      return
    }

    if (response.stop_reason === "tool_use") {
      // Find tool_use blocks
      const toolUseBlocks = response.content.filter(
        (block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
          block.type === "tool_use"
      )

      // Execute tools
      const toolResults: ToolResult[] = []
      for (const block of toolUseBlocks) {
        const result = await executeTool(block.name, block.id, block.input)
        toolResults.push(result)
        // Capture quote data if present
        if (result.quoteData) {
          quoteData = result.quoteData
        }
      }

      // Add assistant response + tool results to messages
      messages.push({ role: "assistant", content: response.content })
      messages.push({
        role: "user",
        content: toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
        })),
      })

      continue
    }

    // Unexpected stop reason
    break
  }

  // Fallback: if loop exhausted without end_turn
  await reply(replyToken, [
    { type: "text", text: "抱歉，目前無法處理您的問題。請稍後再試，或聯繫客服 02-7733-7678。" },
  ])
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/ai/chat.ts
git commit -m "feat: add AI chat handler with tool_use loop and Flex Message support"
```

---

## Task 9: Rewire Webhook Route

**Files:**
- Modify: `src/app/api/webhook/route.ts`
- Modify: `src/lib/handlers/index.ts`
- Remove: `src/lib/router/intent.ts`
- Remove: `src/lib/router/index.ts`
- Remove: `src/lib/handlers/booking.ts`
- Remove: `src/lib/handlers/mission.ts`
- Remove: `src/lib/handlers/support.ts`
- Remove: `src/lib/handlers/unknown.ts`
- Remove: `src/lib/handlers/quote.ts` (logic moved into `ai/tools.ts`)

- [ ] **Step 1: Rewrite webhook/route.ts**

Replace entire file:

```typescript
// src/app/api/webhook/route.ts
import { NextResponse } from "next/server"
import { verifySignature } from "@/lib/line"
import type { LineEvent, LineWebhookBody } from "@/lib/line"
import { handleFollow } from "@/lib/handlers"
import { handleAiChat } from "@/lib/ai"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const rawBody = await request.text()

    const signature = request.headers.get("x-line-signature")
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 })
    }

    try {
      if (!verifySignature(rawBody, signature)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
      }
    } catch {
      console.warn("LINE signature verification skipped (missing secret?)")
    }

    const body = JSON.parse(rawBody) as LineWebhookBody

    for (const event of body.events) {
      try {
        await handleEvent(event)
      } catch (err) {
        console.error("Error handling event:", event.type, err)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("LINE webhook error:", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}

async function handleEvent(event: LineEvent) {
  if (event.type === "follow" && event.source?.userId) {
    await handleFollow(event.source.userId)
    return
  }

  if (
    event.type === "message" &&
    event.message?.type === "text" &&
    event.message.text &&
    event.replyToken
  ) {
    await handleAiChat(event.replyToken, event.message.text)
  }
}
```

- [ ] **Step 2: Update handlers/index.ts**

Replace entire file — only export welcome handler:

```typescript
// src/lib/handlers/index.ts
export { handleFollow } from "./welcome"
```

- [ ] **Step 3: Delete removed files**

```bash
rm src/lib/router/intent.ts src/lib/router/index.ts
rmdir src/lib/router
rm src/lib/handlers/booking.ts src/lib/handlers/mission.ts src/lib/handlers/support.ts src/lib/handlers/unknown.ts src/lib/handlers/quote.ts
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: rewire webhook to use AI chat handler, remove keyword router and static handlers"
```

---

## Task 10: Update .env.example and Verify Build

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Update .env.example**

Replace entire file:

```env
# LINE Messaging API
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=

# Supabase (same project as quote-page)
# Accepts either SUPABASE_* or QUOTE_SUPABASE_* naming
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# AI (Claude Haiku)
ANTHROPIC_API_KEY=

# Embeddings (Voyage-3)
VOYAGE_API_KEY=
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors. If there are path alias issues, ensure `tsconfig.json` has `"paths": { "@/*": ["./src/*"] }`.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "feat: update .env.example with AI and embedding env vars"
```

---

## Task 11: Seed Knowledge and Test End-to-End

- [ ] **Step 1: Run the Supabase migration**

Execute `supabase/migrations/001_knowledge_chunks.sql` via Supabase Dashboard SQL Editor.

- [ ] **Step 2: Set env vars locally**

Copy `.env.example` to `.env.local` and fill in all values including `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`.

- [ ] **Step 3: Run seed script**

```bash
npm run seed
```

Expected output:
```
  company.md: 4 chunks
  services.md: 6 chunks
  ...
Total: ~40 chunks from 9 files
Embedding batch 1/2...
Embedding batch 2/2...
Clearing existing knowledge_chunks...
Inserting new chunks...
Done! Seeded 40 chunks.
```

- [ ] **Step 4: Start dev server and test**

```bash
npm run dev
```

Test with curl:
```bash
curl -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -H "x-line-signature: test" \
  -d '{"events":[{"type":"message","replyToken":"test","source":{"type":"user","userId":"test"},"message":{"type":"text","text":"你們有做太陽能板清洗嗎？"}}]}'
```

Check server logs for Haiku response (LINE reply will fail with invalid token, but the AI flow should complete).

- [ ] **Step 5: Deploy to Vercel**

Set new env vars in Vercel Dashboard:
- `ANTHROPIC_API_KEY`
- `VOYAGE_API_KEY`

```bash
npx vercel --prod
```

- [ ] **Step 6: Test via LINE**

Send messages to the LINE bot:
- "你們有做太陽能板清洗嗎？" → should search knowledge and answer
- "Q-20260327-619" → should return Flex Message with quote
- "你好" → should greet from system prompt
- "營業時間？" → should answer from system prompt or knowledge

- [ ] **Step 7: Final commit and push**

```bash
git add -A
git commit -m "feat: complete RAG chatbot integration — knowledge seeded, ready for production"
git push origin main
```
