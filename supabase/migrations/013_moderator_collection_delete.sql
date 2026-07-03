-- Let moderators delete any collection (owners already could).

drop policy if exists "Owners can delete collections" on public.collections;

create policy "Owners and moderators can delete collections"
  on public.collections for delete
  using (user_id = auth.uid() or public.is_moderator());
