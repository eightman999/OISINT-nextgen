-- 0003: RLS (spec.md §23)
-- 最重要: investigations と investigation_members を相互参照させない。
-- 全ポリシーは security definer 関数経由 (§23, §36 Rule 12)。

-- ============================================================
-- テーブルレベル GRANT
-- 行レベルの制御は RLS が担う。テーブルレベルでは authenticated に
-- 必要最小限の操作のみ開ける (クライアント直接書き込み禁止のテーブルは select のみ §23)。
-- anon ロールには一切開けない (匿名サインイン後は authenticated になる §19)。
-- ============================================================

grant usage on schema public to authenticated, service_role;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.investigations to authenticated;
grant select on public.investigation_members to authenticated;
grant select, insert, delete on public.requirements to authenticated;
grant select, insert, update on public.votes to authenticated;
grant select on public.places to authenticated;
grant select on public.candidates to authenticated;
grant select on public.evidence to authenticated;
grant select on public.requirement_evaluations to authenticated;
grant select on public.investigation_events to authenticated;

grant all on all tables in schema public to service_role;

-- ============================================================
-- security definer 関数
-- ============================================================

create or replace function public.is_investigation_member(inv uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from investigation_members m
    where m.investigation_id = inv
      and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_investigation_member(uuid) from public;
grant execute on function public.is_investigation_member(uuid) to authenticated;

create or replace function public.is_investigation_editor(inv uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from investigation_members m
    where m.investigation_id = inv
      and m.user_id = auth.uid()
      and m.role in ('owner','editor')
  );
$$;

revoke all on function public.is_investigation_editor(uuid) from public;
grant execute on function public.is_investigation_editor(uuid) to authenticated;

-- ============================================================
-- profiles: 表示名のみの公開情報。select は認証済み全員、書き込みは本人のみ
-- ============================================================

alter table public.profiles enable row level security;

create policy prof_select on public.profiles for select
  to authenticated using (true);

create policy prof_insert on public.profiles for insert
  to authenticated with check (id = auth.uid());

create policy prof_update on public.profiles for update
  to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ============================================================
-- investigations (§23)
-- ============================================================

alter table public.investigations enable row level security;

create policy inv_select on public.investigations for select
  to authenticated
  using (created_by = auth.uid() or public.is_investigation_member(id));

create policy inv_update on public.investigations for update
  to authenticated
  using (public.is_investigation_editor(id));

create policy inv_insert on public.investigations for insert
  to authenticated
  with check (created_by = auth.uid());

-- ============================================================
-- investigation_members (§23)
-- 自己参照再帰を避けるため、自分の行のみ直接条件で判定する (推奨安全形)。
-- 他メンバー一覧は security definer RPC get_investigation_members() 経由 (0005)。
-- INSERT はクライアント禁止。参加は join-investigation Edge Function 経由 (§25.4)。
-- ============================================================

alter table public.investigation_members enable row level security;

create policy mem_select on public.investigation_members for select
  to authenticated
  using (user_id = auth.uid());

-- ============================================================
-- requirements (§23)
-- ============================================================

alter table public.requirements enable row level security;

create policy req_select on public.requirements for select
  to authenticated
  using (public.is_investigation_member(investigation_id));

create policy req_insert on public.requirements for insert
  to authenticated
  with check (public.is_investigation_editor(investigation_id)
              and created_by = auth.uid());

-- §25.3 の rerank契機「requirement 削除」の削除経路として必要
create policy req_delete on public.requirements for delete
  to authenticated
  using (public.is_investigation_editor(investigation_id));

-- ============================================================
-- votes (§23)
-- ============================================================

alter table public.votes enable row level security;

create policy vote_select on public.votes for select
  to authenticated
  using (public.is_investigation_member(investigation_id));

create policy vote_insert on public.votes for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.is_investigation_member(investigation_id)
    and exists (
      select 1 from public.candidates c
      where c.id = candidate_id
        and c.investigation_id = votes.investigation_id
    )
  );

create policy vote_update on public.votes for update
  to authenticated
  using (
    user_id = auth.uid()
    and public.is_investigation_member(investigation_id)
  )
  with check (
    user_id = auth.uid()
    and public.is_investigation_member(investigation_id)
    and exists (
      select 1 from public.candidates c
      where c.id = candidate_id
        and c.investigation_id = votes.investigation_id
    )
  );

-- ============================================================
-- candidates / evidence / requirement_evaluations / investigation_events (§23)
-- select = member のみ。書き込みポリシーは一切作らない (Edge Function が service role で書く)。
-- ============================================================

alter table public.candidates enable row level security;

create policy cand_select on public.candidates for select
  to authenticated
  using (public.is_investigation_member(investigation_id));

alter table public.evidence enable row level security;

-- evidence だけは例外 (§23)。scope='shared' 行 (investigation_id null) は
-- 「自分が member である Investigation の候補に紐づく place」の分だけ見える。
create policy ev_select on public.evidence for select
  to authenticated
  using (
    (investigation_id is not null
      and public.is_investigation_member(investigation_id))
    or (investigation_id is null
      and exists (
        select 1 from public.candidates c
        where c.place_id = evidence.place_id
          and public.is_investigation_member(c.investigation_id)
      ))
  );

alter table public.requirement_evaluations enable row level security;

create policy eval_select on public.requirement_evaluations for select
  to authenticated
  using (public.is_investigation_member(investigation_id));

alter table public.investigation_events enable row level security;

create policy event_select on public.investigation_events for select
  to authenticated
  using (public.is_investigation_member(investigation_id));

-- places: 店舗そのものの事実は公開情報 (§33)。select のみ全認証ユーザーへ開放。
alter table public.places enable row level security;

create policy place_select on public.places for select
  to authenticated using (true);
