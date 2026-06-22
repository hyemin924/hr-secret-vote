insert into app_settings (key, value)
values ('ballot_title', '""')
on conflict (key) do update set value = excluded.value;

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
grant execute on function admin_save_state(text, jsonb) to anon;
grant execute on function admin_reset_votes(text) to anon;
