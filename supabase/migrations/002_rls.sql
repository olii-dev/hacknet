-- Row Level Security policies

alter table public.profiles enable row level security;
alter table public.files enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.collections enable row level security;
alter table public.collection_files enable row level security;
alter table public.reports enable row level security;

-- Helper: check if current user is moderator or admin
create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('moderator', 'admin')
  );
$$;

-- Profiles
create policy "Profiles are publicly readable"
  on public.profiles for select
  using (true);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Files
create policy "Approved files are publicly readable"
  on public.files for select
  using (
    status = 'approved'
    or uploader_id = auth.uid()
    or public.is_moderator()
  );

create policy "Authenticated users can upload files"
  on public.files for insert
  with check (auth.uid() = uploader_id);

create policy "Uploaders can update own files"
  on public.files for update
  using (uploader_id = auth.uid() or public.is_moderator())
  with check (uploader_id = auth.uid() or public.is_moderator());

create policy "Uploaders and moderators can delete files"
  on public.files for delete
  using (uploader_id = auth.uid() or public.is_moderator());

-- Comments
create policy "Comments are publicly readable"
  on public.comments for select
  using (true);

create policy "Authenticated users can comment"
  on public.comments for insert
  with check (auth.uid() = user_id);

create policy "Users can delete own comments"
  on public.comments for delete
  using (auth.uid() = user_id or public.is_moderator());

-- Likes
create policy "Likes are publicly readable"
  on public.likes for select
  using (true);

create policy "Authenticated users can like"
  on public.likes for insert
  with check (auth.uid() = user_id);

create policy "Users can unlike"
  on public.likes for delete
  using (auth.uid() = user_id);

-- Collections
create policy "Public collections are readable"
  on public.collections for select
  using (is_public = true or user_id = auth.uid() or public.is_moderator());

create policy "Authenticated users can create collections"
  on public.collections for insert
  with check (auth.uid() = user_id);

create policy "Owners can update collections"
  on public.collections for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Owners can delete collections"
  on public.collections for delete
  using (user_id = auth.uid());

-- Collection files
create policy "Collection files readable if collection is accessible"
  on public.collection_files for select
  using (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (c.is_public = true or c.user_id = auth.uid() or public.is_moderator())
    )
  );

create policy "Collection owners can add files"
  on public.collection_files for insert
  with check (
    exists (
      select 1 from public.collections c
      where c.id = collection_id and c.user_id = auth.uid()
    )
  );

create policy "Collection owners can remove files"
  on public.collection_files for delete
  using (
    exists (
      select 1 from public.collections c
      where c.id = collection_id and c.user_id = auth.uid()
    )
  );

-- Reports
create policy "Moderators can read all reports"
  on public.reports for select
  using (reporter_id = auth.uid() or public.is_moderator());

create policy "Authenticated users can report"
  on public.reports for insert
  with check (auth.uid() = reporter_id);

create policy "Moderators can update reports"
  on public.reports for update
  using (public.is_moderator())
  with check (public.is_moderator());
