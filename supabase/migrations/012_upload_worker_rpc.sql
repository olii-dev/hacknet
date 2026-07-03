-- Lets the upload worker pick a Mega account using the uploader's JWT
-- (no service role key needed on Fly.io)

create or replace function public.pick_mega_account_for_upload(incoming_bytes bigint)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  max_accounts constant int := 10;
  quota constant bigint := 20::bigint * 1024 * 1024 * 1024;
  usage bigint[] := array_fill(0::bigint, array[max_accounts]);
  row record;
  idx int;
begin
  if incoming_bytes is null or incoming_bytes < 1 then
    raise exception 'Invalid upload size.';
  end if;

  for row in
    select coalesce(mega_account_index, 0) as account_index, coalesce(sum(size_bytes), 0)::bigint as used
    from public.files
    group by coalesce(mega_account_index, 0)
  loop
    if row.account_index >= 0 and row.account_index < max_accounts then
      usage[row.account_index + 1] := row.used;
    end if;
  end loop;

  for idx in 0..(max_accounts - 1) loop
    if quota - usage[idx + 1] >= incoming_bytes then
      return idx;
    end if;
  end loop;

  raise exception 'Hacknet is out of storage space right now. Try again later or ask a moderator to add capacity.';
end;
$$;

revoke all on function public.pick_mega_account_for_upload(bigint) from public;
grant execute on function public.pick_mega_account_for_upload(bigint) to authenticated;
