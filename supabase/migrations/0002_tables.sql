-- 0002: 全テーブル + トリガー + 索引 (spec.md §22)
-- vector は 768 次元固定 (§16.3)。vector 索引は MVP では作らない (§22 共通ルール)。

-- 共通: updated_at 自動更新トリガー関数 (§22)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- profiles (§22, §19)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url text,
  created_at timestamptz default now()
);

-- investigations (§22)
create table public.investigations (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null,
  title text not null,
  raw_query text not null,
  normalized_query text,
  status text not null default 'draft',
  share_token text unique not null default encode(gen_random_bytes(16), 'hex'),
  embedding vector(768),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create trigger trg_set_updated_at before update on public.investigations
for each row execute function public.set_updated_at();

-- investigation_members (§22)
create table public.investigation_members (
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'editor',  -- owner | editor | viewer
  joined_at timestamptz default now(),
  primary key (investigation_id, user_id)
);

-- requirements (§22, §11)
create table public.requirements (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  created_by uuid,
  text text not null,
  normalized_text text,
  kind text,        -- §11 RequirementKind
  priority text,    -- must | should | nice
  weight real,
  embedding vector(768),
  created_at timestamptz default now()
);

create index idx_requirements_investigation on public.requirements (investigation_id);

-- places (§22, §36 Rule 13)
create table public.places (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_place_id text not null,
  name text not null,
  address text,
  lat double precision,
  lng double precision,
  metadata jsonb,
  embedding vector(768),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider, provider_place_id)
);

create trigger trg_set_updated_at before update on public.places
for each row execute function public.set_updated_at();

-- evidence (§22, §13, §32, §44.4)
-- UPDATE せず INSERT 追記。investigation_id null = 共有資産 (scope='shared')
create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid references public.investigations(id) on delete set null,
  place_id uuid not null references public.places(id) on delete cascade,
  scope text not null default 'shared',   -- shared | investigation (§44)
  source_type text not null,              -- §14
  source_url text not null,
  source_title text,
  excerpt text,
  structured_claims jsonb not null default '[]'::jsonb,
  source_quality real,
  freshness_score real,
  observed_at timestamptz not null,
  embedding vector(768),
  created_at timestamptz default now()
);

create index idx_evidence_place_observed on public.evidence (place_id, observed_at desc);
create index idx_evidence_investigation on public.evidence (investigation_id);

-- candidates (§22)
create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  place_id uuid not null references public.places(id),
  score real,
  rank integer,
  summary text,
  pros jsonb,
  cons jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (investigation_id, place_id)
);

create trigger trg_set_updated_at before update on public.candidates
for each row execute function public.set_updated_at();

create index idx_candidates_investigation on public.candidates (investigation_id);
create index idx_candidates_place on public.candidates (place_id);

-- requirement_evaluations (§22)
-- investigation_id は RLS 単純化のための必須の非正規化列 (§23)
create table public.requirement_evaluations (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  requirement_id uuid not null references public.requirements(id) on delete cascade,
  state text not null,    -- match | partial | mismatch | unknown (§12)
  confidence real,
  explanation text,
  evidence_ids uuid[],
  created_at timestamptz default now(),
  unique (candidate_id, requirement_id)
);

create index idx_evaluations_investigation on public.requirement_evaluations (investigation_id);
create index idx_evaluations_candidate on public.requirement_evaluations (candidate_id);

-- votes (§22, §21)
-- investigation_id は RLS と Realtime filter を単純化するための必須の非正規化列 (§23)
create table public.votes (
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  user_id uuid not null,
  value smallint not null check (value in (-1, 0, 1)),
  comment text,
  updated_at timestamptz default now(),
  primary key (candidate_id, user_id)
);

create index idx_votes_investigation on public.votes (investigation_id);

-- investigation_events (§22, §10, §5.4 Search Log)
create table public.investigation_events (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  event_type text not null,
  message text,
  metadata jsonb,
  created_at timestamptz default now()
);

create index idx_events_investigation on public.investigation_events (investigation_id);
