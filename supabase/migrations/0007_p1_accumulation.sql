-- 0007: P1 集積の開始 (spec.md §44.5 / issue #102)
-- investigations.visibility + place_facts + place_feedback + 公開閲覧 RLS + RPC 4 本。
-- DDL の列名・RPC シグネチャは他実装と共有する確定契約。変更禁止。

-- ============================================================
-- 1. DDL (§44.5 確定 DDL)
-- ============================================================

-- 公開設定 (§33: デフォルト private。公開は owner の明示操作のみ)
alter table public.investigations add column visibility text not null default 'private'
  check (visibility in ('private','public'));

-- place 単位の集約ビュー (§44.5)。複数 Evidence / feedback を突き合わせた
-- 「現時点で最も確からしい値」。書き込みは service role と RPC 内の決定論 SQL のみ。
create table public.place_facts (
  place_id uuid not null references public.places(id) on delete cascade,
  key text not null,              -- ClaimKey (§13)。飲食店専用の名前にしない (§44.6)
  value jsonb not null,
  confidence real not null,
  evidence_count int not null,
  conflicting boolean not null default false,
  last_verified_at timestamptz not null,
  primary key (place_id, key)
);

-- 来店後フィードバック (§44.5)。L3 個人データ (§44.3):
-- 生の行は本人のみ。共有してよいのは集計値のみ (§33「来店後の評価は集計値のみ」)。
create table public.place_feedback (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  user_id uuid not null,
  visited_at date,
  rating smallint check (rating in (-1,0,1)),
  aspect text check (aspect in ('noise','space','value','service')),
  aspect_value text,
  created_at timestamptz default now()
);

-- 外部キー索引 (§22 共通ルール)
create index idx_place_feedback_place on public.place_feedback (place_id);
create index idx_place_feedback_user on public.place_feedback (user_id);

-- ============================================================
-- 2. テーブルレベル GRANT (0003 と同じ規律。anon には開けない §19)
-- ============================================================

-- place_facts: 店舗そのものの事実は共有資産 (§33 表)。クライアントは読み取りのみ。
grant select on public.place_facts to authenticated;
-- place_feedback: 本人行のみ読み書き (行の制御は RLS)
grant select, insert, update on public.place_feedback to authenticated;
-- service role (Edge Function / 集積ジョブ) はフルアクセス
grant all on public.place_facts to service_role;
grant all on public.place_feedback to service_role;

-- ============================================================
-- 3. RLS
-- ============================================================

alter table public.place_facts enable row level security;

-- select のみ。insert/update/delete ポリシーは作らない (service role のみ書ける)。
create policy pfacts_select on public.place_facts for select
  to authenticated using (true);

alter table public.place_feedback enable row level security;

-- 他人の生データを見せない (§44.3 L3 / §33)
create policy pfb_select on public.place_feedback for select
  to authenticated using (user_id = auth.uid());

create policy pfb_insert on public.place_feedback for insert
  to authenticated with check (user_id = auth.uid());

create policy pfb_update on public.place_feedback for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================
-- 4. 公開 Investigation の読み取り拡張
-- member または visibility='public' なら読める (§23 security definer パターン)。
-- 置き換えるのは candidates / evidence / requirement_evaluations の select のみ。
-- investigations 本体・requirements・votes・investigation_events は member のみのまま
-- (§33: raw_query・requirement 文面・投票・グループ嗜好を公開ページへ露出しない)。
-- §23 無限再帰回避: investigations / investigation_members 自身のポリシーでは使わない。
-- ============================================================

create or replace function public.is_investigation_readable(inv uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_investigation_member(inv)
      or exists (
        select 1 from investigations i
        where i.id = inv
          and i.visibility = 'public'
      );
$$;

revoke all on function public.is_investigation_readable(uuid) from public;
grant execute on function public.is_investigation_readable(uuid) to authenticated;

drop policy cand_select on public.candidates;
create policy cand_select on public.candidates for select
  to authenticated
  using (public.is_investigation_readable(investigation_id));

-- evidence は 0003 と同じ例外構造 (§23: shared 行は investigation_id が null) のまま、
-- member 判定だけ readable 判定に置き換える。
drop policy ev_select on public.evidence;
create policy ev_select on public.evidence for select
  to authenticated
  using (
    (investigation_id is not null
      and public.is_investigation_readable(investigation_id))
    or (investigation_id is null
      and exists (
        select 1 from public.candidates c
        where c.place_id = evidence.place_id
          and public.is_investigation_readable(c.investigation_id)
      ))
  );

drop policy eval_select on public.requirement_evaluations;
create policy eval_select on public.requirement_evaluations for select
  to authenticated
  using (public.is_investigation_readable(investigation_id));

-- ============================================================
-- 5. RPC (0005 と同じ規律: security definer + set search_path + revoke/grant)
-- シグネチャは issue #102 の確定契約。名前・引数を変えない。
-- ============================================================

-- 公開設定の変更。created_by 本人のみ (§33: 公開は明示操作)。
create or replace function public.set_investigation_visibility(
  p_investigation uuid,
  p_visibility text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_visibility is null or p_visibility not in ('private','public') then
    raise exception 'invalid visibility: %', p_visibility;
  end if;

  update investigations
     set visibility = p_visibility
   where id = p_investigation
     and created_by = auth.uid();

  if not found then
    raise exception 'investigation not found or not owned by current user';
  end if;
end;
$$;

revoke all on function public.set_investigation_visibility(uuid, text) from public;
grant execute on function public.set_investigation_visibility(uuid, text) to authenticated;

-- 0003 の inv_update ポリシーは editor メンバーにも investigations の UPDATE を許すため、
-- editor が visibility を直接変更できてしまう穴を BEFORE UPDATE トリガーで塞ぐ (owner 限定。§33)。
-- service role (auth.uid() is null) は対象外なので Edge Functions の status 更新等には影響しない。
create or replace function public.guard_visibility_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.visibility is distinct from old.visibility
     and auth.uid() is not null
     and auth.uid() <> old.created_by then
    raise exception 'visibility は owner のみ変更できます';
  end if;
  return new;
end;
$$;

create trigger trg_guard_visibility before update on public.investigations
for each row execute function public.guard_visibility_change();

-- 来店後フィードバック投稿 (§44.5)。user_id は auth.uid() 固定 (外から受け取らない)。
-- 挿入後、該当 place の place_facts を決定論 SQL で再計算する (最小3件 §33)。
create or replace function public.submit_place_feedback(
  p_place uuid,
  p_visited_at date default null,
  p_rating smallint default null,
  p_aspect text default null,
  p_aspect_value text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_key text;
  v_total int;
  v_top_value text;
  v_top_count int;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  if not exists (select 1 from places p where p.id = p_place) then
    raise exception 'place not found: %', p_place;
  end if;

  -- aspect の無い aspect_value は集計不能なゴミになるため拒否する
  if p_aspect_value is not null and p_aspect is null then
    raise exception 'aspect_value requires aspect';
  end if;

  -- rating / aspect の値域はテーブルの check 制約が検証する (§44.5)
  insert into place_feedback (place_id, user_id, visited_at, rating, aspect, aspect_value)
  values (p_place, v_uid, p_visited_at, p_rating, p_aspect, p_aspect_value)
  returning id into v_id;

  -- feedback → place_facts 反映 (§44.5「集計値のみを place_facts の noise_level 等へ反映 (最小3件)」)
  -- aspect → ClaimKey 対応はドメイン非依存の命名 (§44.6)
  if p_aspect is not null then
    v_key := case p_aspect
      when 'noise'   then 'noise_level'
      when 'space'   then 'space_comfort'
      when 'value'   then 'value_for_money'
      when 'service' then 'service_quality'
    end;

    select count(*)::int into v_total
    from place_feedback f
    where f.place_id = p_place
      and f.aspect = p_aspect
      and f.aspect_value is not null;

    -- 3 件未満は反映しない (§33 最小件数しきい値)
    if v_total >= 3 then
      -- 多数派 aspect_value (同数の場合は aspect_value 昇順で決定論的に選ぶ)
      select f.aspect_value, count(*)::int
        into v_top_value, v_top_count
      from place_feedback f
      where f.place_id = p_place
        and f.aspect = p_aspect
        and f.aspect_value is not null
      group by f.aspect_value
      order by count(*) desc, f.aspect_value asc
      limit 1;

      -- 矛盾 (多数派比率 < 0.6) は conflicting=true のまま行を残す。潰さない (§44.5, §15)
      insert into place_facts
        (place_id, key, value, confidence, evidence_count, conflicting, last_verified_at)
      values (
        p_place,
        v_key,
        jsonb_build_object(
          'value', v_top_value,
          'count', v_total,
          'share', round(v_top_count::numeric / v_total, 4)
        ),
        least(1.0, v_total / 10.0),
        v_total,
        (v_top_count::numeric / v_total) < 0.6,
        now()
      )
      on conflict (place_id, key) do update set
        value = excluded.value,
        confidence = excluded.confidence,
        evidence_count = excluded.evidence_count,
        conflicting = excluded.conflicting,
        last_verified_at = excluded.last_verified_at;
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function public.submit_place_feedback(uuid, date, smallint, text, text) from public;
grant execute on function public.submit_place_feedback(uuid, date, smallint, text, text) to authenticated;

-- フィードバック集計 (§33「来店後の評価は集計値のみ」)。生の行・user_id は返さない。
-- visited_count は visited_at が入った distinct user 数。
-- aspects は同一 aspect+aspect_value の件数が 3 件以上のもののみ (§33 最小件数しきい値 / §44.5 最小3件)。
create or replace function public.get_place_feedback_summary(p_place_ids uuid[])
returns table (
  place_id uuid,
  visited_count integer,
  rating_count integer,
  rating_avg real,
  aspects jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id as place_id,
    coalesce((
      select count(distinct f.user_id)::int
      from place_feedback f
      where f.place_id = p.id
        and f.visited_at is not null
    ), 0) as visited_count,
    coalesce((
      select count(*)::int
      from place_feedback f
      where f.place_id = p.id
        and f.rating is not null
    ), 0) as rating_count,
    (
      select avg(f.rating)::real
      from place_feedback f
      where f.place_id = p.id
        and f.rating is not null
    ) as rating_avg,
    coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'aspect', a.aspect,
                 'aspect_value', a.aspect_value,
                 'count', a.cnt
               )
               order by a.aspect, a.cnt desc, a.aspect_value
             )
      from (
        select f.aspect, f.aspect_value, count(*)::int as cnt
        from place_feedback f
        where f.place_id = p.id
          and f.aspect is not null
          and f.aspect_value is not null
        group by f.aspect, f.aspect_value
        having count(*) >= 3
      ) a
    ), '[]'::jsonb) as aspects
  from places p
  where p.id = any (p_place_ids);
$$;

revoke all on function public.get_place_feedback_summary(uuid[]) from public;
grant execute on function public.get_place_feedback_summary(uuid[]) to authenticated;

-- 公開 Investigation のメタ情報。visibility='public' の行のみ。
-- raw_query / normalized_query / share_token は返さない (§33)。
create or replace function public.get_public_investigation(p_investigation uuid)
returns table (
  id uuid,
  title text,
  status text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.title, i.status, i.created_at
  from investigations i
  where i.id = p_investigation
    and i.visibility = 'public';
$$;

revoke all on function public.get_public_investigation(uuid) from public;
grant execute on function public.get_public_investigation(uuid) to authenticated;
