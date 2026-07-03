-- Local file storage on self-hosted disk (storage_path on Ubuntu, etc.)

alter table public.files
  add column if not exists storage_path text;

alter table public.files
  alter column mega_url drop not null;

create index if not exists files_storage_path_idx on public.files (storage_path)
  where storage_path is not null;
