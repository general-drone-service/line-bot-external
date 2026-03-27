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
