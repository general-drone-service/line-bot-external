# RAG AI Chatbot for LINE Bot

## Overview

Replace the keyword-based intent router with Claude Haiku + RAG, enabling the LINE bot to answer any customer question using company knowledge stored in Supabase pgvector.

## Architecture

```
LINE user message
  ↓
POST /api/webhook
  ├─ follow event → welcome handler (unchanged)
  └─ text message → Claude Haiku (Messages API + tool_use)
       ├─ tool: lookup_quote(quote_code)  → Supabase quotes table
       ├─ tool: search_knowledge(query)   → pgvector semantic search → top-3 chunks
       └─ no tool → answer from system prompt (company basics)
       ↓
     Haiku generates response
       ↓
     LINE reply API
       ├─ quote found → Flex Message (quote-bubble) + text
       └─ otherwise   → plain text
```

### Key decisions

- All text messages go through Haiku — no keyword router
- Haiku decides when to call tools via `tool_use`
- Quote lookup returns structured data rendered as Flex Message
- Knowledge search returns raw text chunks for Haiku to synthesize
- Follow event stays as static welcome message (no AI needed)

## Knowledge Base

### Source: Markdown files in repo

```
knowledge/
  ├─ company.md        # About, contact, hours, certifications
  ├─ services.md       # 4 services: cleaning, inspection, solar, industrial
  ├─ pricing.md        # Price comparisons, cost structures
  ├─ inspection.md     # Inspection service details, pricing, regulations
  ├─ training.md       # Training courses, career path
  ├─ franchise.md      # Joining/recruitment info
  ├─ projects.md       # Case studies
  ├─ faq.md            # Common customer questions
  └─ regulations.md    # Wall inspection laws, compliance
```

Content sourced from https://www.drone168.com/ (all pages).

### Chunking strategy

- Split by `##` heading boundaries
- Target ~300-500 characters per chunk
- Each chunk retains its source file name and heading as metadata

### Embedding

- **Model**: Voyage-3 (1024 dimensions, strong Chinese support)
- **API**: `https://api.voyageai.com/v1/embeddings`
- **Env var**: `VOYAGE_API_KEY`

### Supabase table

```sql
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
```

### Seed script

`scripts/seed-knowledge.ts`:
1. Read all `knowledge/*.md` files
2. Split into chunks by `##` headings
3. Call Voyage-3 to generate embeddings (batch)
4. Upsert into `knowledge_chunks` (clear + re-insert)

Run: `npx tsx scripts/seed-knowledge.ts`

## AI Integration

### Claude Haiku call flow

```
1. Receive user text message
2. Call Haiku Messages API:
   - system: GDS customer service prompt
   - messages: [{ role: "user", content: user_text }]
   - tools: [lookup_quote, search_knowledge]
3. If stop_reason === "tool_use":
   a. Execute tool (query Supabase)
   b. Send tool_result back to Haiku
   c. Get final response
4. If stop_reason === "end_turn":
   a. Use response directly
5. Format reply:
   - lookup_quote hit → Flex Message + text explanation
   - else → plain text message
```

### System prompt

```
你是 GDS 低空作業（一般無人機服務股份有限公司）的 LINE 官方帳號客服。

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
- 免費報價：https://quote.drone168.com
```

### Tool definitions

**lookup_quote**
```json
{
  "name": "lookup_quote",
  "description": "查詢客戶的報價單資料。當客戶提到報價編號（格式：Q-XXXXXXXX-XXX）時使用。",
  "input_schema": {
    "type": "object",
    "properties": {
      "quote_code": {
        "type": "string",
        "description": "報價編號，如 Q-20260327-619"
      }
    },
    "required": ["quote_code"]
  }
}
```

**search_knowledge**
```json
{
  "name": "search_knowledge",
  "description": "搜尋公司知識庫，找出與客戶問題相關的資訊。用於回答服務內容、價格、流程、法規等問題。",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "搜尋關鍵詞或問題摘要"
      }
    },
    "required": ["query"]
  }
}
```

### Knowledge search implementation

```typescript
async function searchKnowledge(query: string, topK = 3) {
  const embedding = await embedQuery(query)  // Voyage-3
  const { data } = await supabase.rpc("match_knowledge", {
    query_embedding: embedding,
    match_count: topK,
    match_threshold: 0.3,
  })
  return data  // [{ source, heading, content, similarity }]
}
```

Supabase RPC function:
```sql
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

## File Changes

### New files

| File | Purpose |
|------|---------|
| `knowledge/*.md` (9 files) | Knowledge base content |
| `scripts/seed-knowledge.ts` | Embed & seed knowledge into Supabase |
| `src/lib/ai/client.ts` | Anthropic client init |
| `src/lib/ai/chat.ts` | Messages API call + tool_use loop |
| `src/lib/ai/tools.ts` | Tool definitions & executor |
| `src/lib/ai/system-prompt.ts` | System prompt content |
| `src/lib/ai/index.ts` | Barrel export |
| `src/lib/knowledge/search.ts` | pgvector semantic search |
| `src/lib/knowledge/embed.ts` | Voyage-3 embedding call |
| `src/lib/knowledge/index.ts` | Barrel export |
| `supabase/migrations/001_knowledge_chunks.sql` | Table + index + RPC |

### Modified files

| File | Change |
|------|--------|
| `src/app/api/webhook/route.ts` | Text messages → `ai/chat.ts`, keep follow → welcome |
| `src/lib/handlers/quote.ts` | Called by tool executor instead of router |
| `.env.example` | Add `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` |
| `package.json` | Add `@anthropic-ai/sdk`, `voyage-ai` deps |

### Removed files

| File | Reason |
|------|--------|
| `src/lib/router/intent.ts` | Replaced by Haiku tool_use |
| `src/lib/router/index.ts` | Replaced by Haiku tool_use |
| `src/lib/handlers/booking.ts` | Replaced by AI |
| `src/lib/handlers/mission.ts` | Replaced by AI |
| `src/lib/handlers/support.ts` | Replaced by AI |
| `src/lib/handlers/unknown.ts` | Replaced by AI |

### Preserved files

| File | Reason |
|------|--------|
| `src/lib/handlers/welcome.ts` | Follow event, no AI needed |
| `src/lib/flex/quote-bubble.ts` | Structured Flex Message for quotes |
| `src/lib/services/quote-api.ts` | Supabase quote lookup |
| `src/lib/line/*` | LINE SDK unchanged |

## Environment Variables

```env
# Existing
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# New
ANTHROPIC_API_KEY=          # Claude Haiku
VOYAGE_API_KEY=             # Voyage-3 embeddings
```

## Cost Estimate

| Item | Per conversation | Monthly (1000 conversations) |
|------|-----------------|------------------------------|
| Haiku (no tool) | ~NT$0.02 | ~NT$20 |
| Haiku (with tool) | ~NT$0.05 | ~NT$50 |
| Voyage-3 embed | ~NT$0.01 | ~NT$10 |
| **Total** | | **~NT$50-80/月** |
