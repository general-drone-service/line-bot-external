import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })
dotenv.config({ path: ".env" })
import fs from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings"

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

async function main() {
  const knowledgeDir = path.resolve(__dirname, "../knowledge")
  const files = fs.readdirSync(knowledgeDir).filter((f) => f.endsWith(".md"))

  if (files.length === 0) {
    console.error("No .md files found in knowledge/")
    process.exit(1)
  }

  const allChunks: Chunk[] = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(knowledgeDir, file), "utf-8")
    const chunks = chunkMarkdown(file, content)
    allChunks.push(...chunks)
    console.log(`  ${file}: ${chunks.length} chunks`)
  }

  console.log(`\nTotal: ${allChunks.length} chunks from ${files.length} files`)

  const BATCH_SIZE = 20
  const embeddings: number[][] = []
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE)
    const texts = batch.map((c) => `${c.heading}\n\n${c.content}`)
    console.log(`Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allChunks.length / BATCH_SIZE)}...`)
    const batchEmbeddings = await embedBatch(texts)
    embeddings.push(...batchEmbeddings)
  }

  console.log("\nClearing existing knowledge_chunks...")
  const { error: deleteError } = await supabase
    .from("knowledge_chunks")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000")
  if (deleteError) {
    console.error("Delete error:", deleteError.message)
    process.exit(1)
  }

  console.log("Inserting new chunks...")
  const rows = allChunks.map((chunk, i) => ({
    source: chunk.source,
    heading: chunk.heading,
    content: chunk.content,
    embedding: JSON.stringify(embeddings[i]),
  }))

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
