-- 202608230001: Terms consent recording (#272).
--
-- 民法548条の2〜4対応の同意記録。利用規約の受諾（Terms）と任意の
-- パーソナライズ同意（user_preference_profiles / personalization-v2）は別記録。
--
-- 境界:
-- - profiles.terms_version / terms_accepted_at は本人のみが読める (0015 prof_select_own)。
-- - 書き込みは security definer RPC record_terms_consent が正本。
--   永久アカウントのみ (current_user_is_permanent) で、版数は DB 側で再検証。
-- - 監査イベントは追記専用。利用者に UPDATE/DELETE は許可されない (0011)。

alter table public.profiles
  add column terms_version text
    check (terms_version is null or terms_version = 'terms-v1');

alter table public.profiles
  add column terms_accepted_at timestamptz;

comment on column public.profiles.terms_version is
  'Accepted Terms version. Null until the user explicitly accepts through record_terms_consent().';
comment on column public.profiles.terms_accepted_at is
  'When the Terms were accepted (server time, set by record_terms_consent()).';

-- event_type に terms_consent_accepted を追加 (0011 のインライン CHECK を名前付きで再定義)
alter table public.user_product_audit_events
  drop constraint if exists user_product_audit_events_event_type_check;
alter table public.user_product_audit_events
  add constraint user_product_audit_events_event_type_check
  check (event_type in (
    'preference_profile_saved',
    'preference_profile_deleted',
    'terms_consent_accepted'
  ));

-- consent_version に terms-v1 を追加 (202608160002 で personalization-v1/v2 を許可済み)
alter table public.user_product_audit_events
  drop constraint if exists user_product_audit_events_consent_version_check;
alter table public.user_product_audit_events
  add constraint user_product_audit_events_consent_version_check
  check (
    consent_version is null
    or consent_version in ('personalization-v1', 'personalization-v2', 'terms-v1')
  );

create or replace function public.record_terms_consent(p_terms_version text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.current_user_is_permanent() then
    raise exception 'permanent account required' using errcode = '42501';
  end if;

  if p_terms_version <> 'terms-v1' then
    raise exception 'unsupported terms consent version' using errcode = '22023';
  end if;

  -- プロフィール未作成の永続ユーザー（例: サインイン直後の初回同意）にも
  -- 同意記録を書くため行を作る。display_name は後続の表示名保存
  -- (saveAccountDisplayName / join-investigation upsert) が上書きする。
  if not exists (select 1 from public.profiles where id = auth.uid()) then
    insert into public.profiles (id, display_name, terms_version, terms_accepted_at)
    values (auth.uid(), '', p_terms_version, now());
  else
    update public.profiles
    set terms_version = p_terms_version, terms_accepted_at = now()
    where id = auth.uid();
  end if;

  insert into public.user_product_audit_events (
    actor_user_id, event_type, source, consent_version
  ) values (
    auth.uid(), 'terms_consent_accepted', 'account', p_terms_version
  );
end;
$$;

revoke all on function public.record_terms_consent(text) from public;
grant execute on function public.record_terms_consent(text) to authenticated;
