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
