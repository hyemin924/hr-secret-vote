create extension if not exists pgcrypto;

create table if not exists app_settings (
  key text primary key,
  value jsonb not null
);

create table if not exists voters (
  id uuid primary key default gen_random_uuid(),
  position text not null,
  name text not null,
  phone_last4 text not null,
  has_voted boolean not null default false,
  signature text,
  signed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists votes (
  receipt text primary key,
  submitted_at timestamptz not null default now(),
  voter_id uuid,
  voter_position text,
  voter_name text,
  voter_phone_last4 text,
  priorities jsonb not null
);

alter table app_settings enable row level security;
alter table voters enable row level security;
alter table votes enable row level security;

insert into app_settings (key, value) values
  ('committee_title', '"인사자문위원회 비밀투표"'),
  ('ballot_title', '""'),
  ('priority_count', '3'),
  ('is_open', 'true'),
  ('notice', '"직위, 성함, 핸드폰번호 뒷자리 4개를 입력한 뒤 우선순위 교과를 작성하고 서명해 주세요."')
on conflict (key) do nothing;

-- IMPORTANT: Run this line in Supabase SQL Editor after replacing 0331 with your real admin password.
-- The password itself is not exposed to the website after this SQL is saved.
insert into app_settings (key, value) values
  ('admin_password_hash', to_jsonb(crypt('0331', gen_salt('bf'))))
on conflict (key) do nothing;

create or replace function setting_text(p_key text, p_default text)
returns text language sql stable security definer as $$
  select coalesce((select value #>> '{}' from app_settings where key = p_key), p_default);
$$;

create or replace function is_admin(p_password text)
returns boolean language sql stable security definer as $$
  select coalesce(
    (select crypt(p_password, value #>> '{}') = (value #>> '{}')
       from app_settings
      where key = 'admin_password_hash'),
    false
  );
$$;

create or replace function get_public_session()
returns jsonb language sql stable security definer as $$
  select jsonb_build_object(
    'committeeTitle', setting_text('committee_title', '인사자문위원회 비밀투표'),
    'ballotTitle', setting_text('ballot_title', ''),
    'priorityCount', setting_text('priority_count', '3')::int,
    'isOpen', setting_text('is_open', 'true')::boolean,
    'notice', setting_text('notice', '직위, 성함, 핸드폰번호 뒷자리 4개를 입력한 뒤 우선순위 교과를 작성하고 서명해 주세요.')
  );
$$;

create or replace function verify_voter(p_position text, p_name text, p_phone_last4 text)
returns jsonb language plpgsql security definer as $$
declare
  v voters%rowtype;
begin
  if setting_text('is_open', 'true')::boolean is false then
    return jsonb_build_object('error', '현재 투표가 열려 있지 않습니다.');
  end if;

  select * into v
    from voters
   where position = trim(p_position)
     and name = trim(p_name)
     and phone_last4 = trim(p_phone_last4)
   limit 1;

  if v.id is null then
    return jsonb_build_object('error', '등록된 직위/성함/핸드폰번호 뒷자리 4개와 일치하지 않습니다.');
  end if;
  if v.has_voted then
    return jsonb_build_object('error', '이미 제출이 완료된 참여자입니다.');
  end if;

  return jsonb_build_object(
    'voterId', v.id,
    'voter', jsonb_build_object('position', v.position, 'name', v.name)
  );
end;
$$;

create or replace function submit_vote(p_voter_id uuid, p_phone_last4 text, p_priorities text[], p_signature text)
returns jsonb language plpgsql security definer as $$
declare
  v voters%rowtype;
  cleaned text[];
  receipt text;
  required_count int := setting_text('priority_count', '3')::int;
begin
  if setting_text('is_open', 'true')::boolean is false then
    return jsonb_build_object('error', '현재 투표가 열려 있지 않습니다.');
  end if;

  select * into v from voters where id = p_voter_id and phone_last4 = trim(p_phone_last4) for update;
  if v.id is null then
    return jsonb_build_object('error', '참여자 확인에 실패했습니다.');
  end if;
  if v.has_voted then
    return jsonb_build_object('error', '이미 제출이 완료된 참여자입니다.');
  end if;

  select array_agg(nullif(trim(x), '')) into cleaned from unnest(p_priorities) as x;
  cleaned := array_remove(cleaned, null);

  if coalesce(array_length(cleaned, 1), 0) < required_count then
    return jsonb_build_object('error', required_count || '순위까지 모두 입력해 주세요.');
  end if;

  if (select count(*) from unnest(cleaned) x) <> (select count(distinct lower(x)) from unnest(cleaned) x) then
    return jsonb_build_object('error', '같은 교과를 중복 입력할 수 없습니다.');
  end if;

  if p_signature is null or left(p_signature, 22) <> 'data:image/png;base64,' or length(p_signature) < 500 then
    return jsonb_build_object('error', '서명을 입력해 주세요.');
  end if;

  receipt := 'receipt-' || encode(gen_random_bytes(8), 'hex');
  insert into votes (receipt, voter_id, voter_position, voter_name, voter_phone_last4, priorities)
  values (receipt, v.id, v.position, v.name, v.phone_last4, to_jsonb(cleaned));
  update voters set has_voted = true, signature = p_signature, signed_at = now() where id = v.id;

  return jsonb_build_object('receipt', receipt);
end;
$$;

create or replace function admin_state(p_password text)
returns jsonb language plpgsql security definer as $$
begin
  if not is_admin(p_password) then
    return jsonb_build_object('error', '비밀번호가 올바르지 않습니다.');
  end if;

  return jsonb_build_object(
    'session', get_public_session(),
    'voters', coalesce((select jsonb_agg(to_jsonb(v) order by created_at, name) from voters v), '[]'::jsonb),
    'votes', coalesce((select jsonb_agg(to_jsonb(v) order by submitted_at) from votes v), '[]'::jsonb)
  );
end;
$$;

create or replace function admin_save_state(p_password text, p_state jsonb)
returns jsonb language plpgsql security definer as $$
declare
  item jsonb;
begin
  if not is_admin(p_password) then
    return jsonb_build_object('error', '비밀번호가 올바르지 않습니다.');
  end if;

  insert into app_settings (key, value) values
    ('committee_title', to_jsonb(coalesce(p_state #>> '{session,committeeTitle}', '인사자문위원회 비밀투표'))),
    ('ballot_title', to_jsonb(coalesce(p_state #>> '{session,ballotTitle}', ''))),
    ('priority_count', to_jsonb(greatest(1, least(10, coalesce((p_state #>> '{session,priorityCount}')::int, 3))))),
    ('is_open', to_jsonb(coalesce((p_state #>> '{session,isOpen}')::boolean, true))),
    ('notice', to_jsonb(coalesce(p_state #>> '{session,notice}', '')))
  on conflict (key) do update set value = excluded.value;

  delete from voters
   where not exists (
     select 1
       from jsonb_array_elements(coalesce(p_state->'voters', '[]'::jsonb)) x
      where nullif(x->>'id', '')::uuid = voters.id
   )
   and has_voted = false;

  for item in select * from jsonb_array_elements(coalesce(p_state->'voters', '[]'::jsonb)) loop
    if nullif(trim(item->>'position'), '') is null or nullif(trim(item->>'name'), '') is null then
      continue;
    end if;

    if nullif(item->>'id', '') is not null and exists (select 1 from voters where id = (item->>'id')::uuid) then
      update voters
         set position = trim(item->>'position'),
             name = trim(item->>'name'),
             phone_last4 = trim(item->>'phone_last4')
       where id = (item->>'id')::uuid;
    else
      insert into voters (position, name, phone_last4)
      values (trim(item->>'position'), trim(item->>'name'), trim(item->>'phone_last4'));
    end if;
  end loop;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function admin_reset_votes(p_password text)
returns jsonb language plpgsql security definer as $$
begin
  if not is_admin(p_password) then
    return jsonb_build_object('error', '비밀번호가 올바르지 않습니다.');
  end if;

  delete from votes where true;
  update voters set has_voted = false, signature = null, signed_at = null where true;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function get_public_session() to anon;
grant execute on function verify_voter(text, text, text) to anon;
grant execute on function submit_vote(uuid, text, text[], text) to anon;
grant execute on function admin_state(text) to anon;
grant execute on function admin_save_state(text, jsonb) to anon;
grant execute on function admin_reset_votes(text) to anon;
