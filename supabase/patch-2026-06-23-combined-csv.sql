alter table votes add column if not exists voter_id uuid;
alter table votes add column if not exists voter_position text;
alter table votes add column if not exists voter_name text;
alter table votes add column if not exists voter_phone_last4 text;

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

grant execute on function submit_vote(uuid, text, text[], text) to anon;
