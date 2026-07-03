-- Track which Mega account stores each file (for multi-account pooling)

alter table public.files
  add column if not exists mega_account_index integer not null default 0;

create index if not exists files_mega_account_idx on public.files (mega_account_index);

-- Storage usage per Mega account (admin/moderator)
create or replace function public.get_mega_storage_stats()
returns table (
  mega_account_index integer,
  file_count bigint,
  bytes_used bigint
)
language sql
stable
security definer set search_path = public
as $$
  select
    coalesce(f.mega_account_index, 0) as mega_account_index,
    count(*)::bigint as file_count,
    coalesce(sum(f.size_bytes), 0)::bigint as bytes_used
  from public.files f
  group by f.mega_account_index
  order by mega_account_index;
$$;

grant execute on function public.get_mega_storage_stats to authenticated;
