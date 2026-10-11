-- Run once in a NEW Supabase project's SQL Editor. This site hosts one family.
begin;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.family_members (
  user_id uuid primary key references auth.users(id),
  display_name text not null check (length(display_name) between 1 and 60),
  role text not null default 'member' check (role in ('admin', 'member')),
  active boolean not null default true
);
create table public.posts (
  id uuid primary key,
  author_id uuid not null references public.family_members(user_id),
  title text not null default '' check (length(title) <= 120),
  body text not null default '' check (length(body) <= 20000),
  caption text not null default '' check (length(caption) <= 1000),
  event_date date not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index posts_timeline on public.posts(event_date desc, created_at desc);
create index posts_author on public.posts(author_id);
create table public.photos (
  id uuid primary key,
  post_id uuid not null references public.posts(id) on delete cascade,
  path text not null unique,
  thumbnail_path text not null unique,
  width integer not null check (width between 1 and 2048),
  height integer not null check (height between 1 and 2048),
  byte_size integer not null check (byte_size between 1 and 4194304),
  position integer not null check (position between 0 and 19),
  unique(post_id, position)
);
create index photos_post on public.photos(post_id);

create function private.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.family_members where user_id = (select auth.uid()) and active);
$$;
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.family_members where user_id = (select auth.uid()) and active and role = 'admin');
$$;
create function private.owns_post(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_member() and exists(select 1 from public.posts where id = target and author_id = (select auth.uid()));
$$;
create function private.can_read_post(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_member() and exists(
    select 1 from public.posts p where p.id = target and (
      p.author_id = (select auth.uid())
      or (p.status = 'published' and (p.deleted_at is null or private.is_admin()))
    )
  );
$$;
create function private.storage_post_id(object_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when object_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}(\.thumb)?\.jpg$'
    then split_part(object_name, '/', 2)::uuid else null end;
$$;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to authenticated;

alter table public.family_members enable row level security;
alter table public.posts enable row level security;
alter table public.photos enable row level security;
revoke all on public.family_members, public.posts, public.photos from anon, authenticated;
grant select on public.family_members, public.posts, public.photos to authenticated;
create policy members_read on public.family_members for select to authenticated using (private.is_member());
create policy posts_read on public.posts for select to authenticated using (private.can_read_post(id));
create policy photos_read on public.photos for select to authenticated using (private.can_read_post(post_id));

-- All content writes go through an atomic, version-checked function. The browser
-- cannot change authorship, membership, or the relationship between photos/posts.
create function public.save_entry(
  entry_id uuid, expected_version integer, entry_title text, entry_body text,
  entry_caption text, entry_date date, entry_status text, entry_photos jsonb
) returns public.posts
language plpgsql security definer set search_path = '' as $$
declare
  existing public.posts;
  result public.posts;
  item jsonb;
  photo_id uuid;
  photo_index integer := 0;
  prefix text;
begin
  if not private.is_member() then raise exception 'Family membership required' using errcode = '42501'; end if;
  if entry_id is null or expected_version is null or entry_date is null
    or entry_status is null or entry_status not in ('draft', 'published')
    or entry_photos is null or jsonb_typeof(entry_photos) <> 'array' then
    raise exception 'Invalid entry';
  end if;
  if jsonb_array_length(entry_photos) > 20 then raise exception 'Too many photos'; end if;
  if entry_status = 'published' and length(trim(coalesce(entry_body, ''))) = 0 and jsonb_array_length(entry_photos) = 0 then
    raise exception 'A published story needs text or a photo';
  end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(entry_photos)) <> jsonb_array_length(entry_photos) then
    raise exception 'Duplicate or missing photo identifier';
  end if;
  select * into existing from public.posts where id = entry_id for update;
  if found then
    if existing.author_id <> auth.uid() or existing.deleted_at is not null then
      raise exception 'Only the author can edit an active story' using errcode = '42501';
    end if;
    if existing.version <> expected_version then raise exception 'Entry version conflict' using errcode = '40001'; end if;
  else
    if expected_version <> 0 then raise exception 'Entry version conflict' using errcode = '40001'; end if;
    insert into public.posts(id, author_id, event_date) values(entry_id, auth.uid(), entry_date);
  end if;
  prefix := auth.uid()::text || '/' || entry_id::text || '/';
  for item in select value from jsonb_array_elements(entry_photos) loop
    photo_id := (item->>'id')::uuid;
    if item->>'path' is distinct from prefix || photo_id::text || '.jpg'
      or item->>'thumbnail_path' is distinct from prefix || photo_id::text || '.thumb.jpg' then
      raise exception 'Invalid photo ownership' using errcode = '42501';
    end if;
    if not exists(select 1 from storage.objects where bucket_id = 'family-photos' and name = item->>'path')
      or not exists(select 1 from storage.objects where bucket_id = 'family-photos' and name = item->>'thumbnail_path') then
      raise exception 'Photo upload is incomplete';
    end if;
  end loop;
  delete from public.photos where post_id = entry_id;
  for item in select value from jsonb_array_elements(entry_photos) loop
    insert into public.photos(id, post_id, path, thumbnail_path, width, height, byte_size, position)
    values((item->>'id')::uuid, entry_id, item->>'path', item->>'thumbnail_path', (item->>'width')::integer,
      (item->>'height')::integer, (item->>'byte_size')::integer, photo_index);
    photo_index := photo_index + 1;
  end loop;
  update public.posts set title = trim(coalesce(entry_title, '')), body = coalesce(entry_body, ''),
    caption = coalesce(entry_caption, ''), event_date = entry_date, status = entry_status,
    version = case when expected_version = 0 then 1 else expected_version + 1 end, updated_at = now()
    where id = entry_id returning * into result;
  return result;
end;
$$;

create function public.set_entry_deleted(entry_id uuid, expected_version integer, is_deleted boolean)
returns public.posts language plpgsql security definer set search_path = '' as $$
declare existing public.posts; result public.posts;
begin
  if not private.is_member() then raise exception 'Family membership required' using errcode = '42501'; end if;
  select * into existing from public.posts where id = entry_id for update;
  if not found then raise exception 'Story not found'; end if;
  if existing.author_id <> auth.uid() and not (existing.status = 'published' and private.is_admin()) then
    raise exception 'Not allowed to manage this story' using errcode = '42501';
  end if;
  if expected_version is null or existing.version <> expected_version then raise exception 'Entry version conflict' using errcode = '40001'; end if;
  if is_deleted is null then raise exception 'Invalid trash status'; end if;
  update public.posts set deleted_at = case when is_deleted then now() else null end,
    version = version + 1, updated_at = now() where id = entry_id returning * into result;
  return result;
end;
$$;
revoke all on function public.save_entry(uuid, integer, text, text, text, date, text, jsonb) from public, anon, authenticated;
revoke all on function public.set_entry_deleted(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.save_entry(uuid, integer, text, text, text, date, text, jsonb) to authenticated;
grant execute on function public.set_entry_deleted(uuid, integer, boolean) to authenticated;

-- Keep privileged write implementations outside the exposed API schema.
alter function public.save_entry(uuid, integer, text, text, text, date, text, jsonb) set schema private;
alter function public.set_entry_deleted(uuid, integer, boolean) set schema private;

create function public.save_entry(
  entry_id uuid, expected_version integer, entry_title text, entry_body text,
  entry_caption text, entry_date date, entry_status text, entry_photos jsonb
) returns public.posts
language sql security invoker set search_path = '' as $$
  select private.save_entry(entry_id, expected_version, entry_title, entry_body,
    entry_caption, entry_date, entry_status, entry_photos);
$$;
create function public.set_entry_deleted(entry_id uuid, expected_version integer, is_deleted boolean)
returns public.posts language sql security invoker set search_path = '' as $$
  select private.set_entry_deleted(entry_id, expected_version, is_deleted);
$$;
revoke all on function private.save_entry(uuid, integer, text, text, text, date, text, jsonb) from public, anon, authenticated;
revoke all on function private.set_entry_deleted(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function private.save_entry(uuid, integer, text, text, text, date, text, jsonb) to authenticated;
grant execute on function private.set_entry_deleted(uuid, integer, boolean) to authenticated;
revoke all on function public.save_entry(uuid, integer, text, text, text, date, text, jsonb) from public, anon, authenticated;
revoke all on function public.set_entry_deleted(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.save_entry(uuid, integer, text, text, text, date, text, jsonb) to authenticated;
grant execute on function public.set_entry_deleted(uuid, integer, boolean) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('family-photos', 'family-photos', false, 2097152, array['image/jpeg']);

create policy family_photo_read on storage.objects for select to authenticated using (
  bucket_id = 'family-photos' and (
    exists(select 1 from public.photos p
      where (p.path = name or p.thumbnail_path = name) and private.can_read_post(p.post_id))
    -- Uploaders also need SELECT to remove their own interrupted uploads.
    or (split_part(name, '/', 1) = (select auth.uid())::text
      and private.owns_post(private.storage_post_id(name)))
  )
);
create policy family_photo_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'family-photos' and split_part(name, '/', 1) = (select auth.uid())::text
  and private.owns_post(private.storage_post_id(name))
  and exists(select 1 from public.posts where id = private.storage_post_id(name) and deleted_at is null)
);
create policy family_photo_remove on storage.objects for delete to authenticated using (
  bucket_id = 'family-photos' and split_part(name, '/', 1) = (select auth.uid())::text
  and private.owns_post(private.storage_post_id(name))
  and not exists(select 1 from public.photos p where p.path = name or p.thumbnail_path = name)
);
commit;
