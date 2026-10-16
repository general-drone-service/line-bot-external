import { botDbs } from "@/lib/botdb"
import { embedQuery } from "./embed"

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
  try {
    return (await botDbs().primary.matchKnowledge(embedding, topK, threshold)) as KnowledgeChunk[]
  } catch (err) {
    console.error("Knowledge search error:", (err as Error).message)
    return []
  }
}
