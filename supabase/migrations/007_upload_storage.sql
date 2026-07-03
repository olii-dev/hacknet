-- Temporary staging bucket for large uploads (client -> storage -> Mega ingest)

insert into storage.buckets (id, name, public, file_size_limit)
values ('hacknet-uploads', 'hacknet-uploads', false, 1073741824)
on conflict (id) do update set file_size_limit = 1073741824;

create policy "Users upload own staging files"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'hacknet-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users read own staging files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'hacknet-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users delete own staging files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'hacknet-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
