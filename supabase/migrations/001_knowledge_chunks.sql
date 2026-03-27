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
