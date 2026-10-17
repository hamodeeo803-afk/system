create extension if not exists pgcrypto with schema extensions;

create table if not exists public.erp_workspaces (
  singleton boolean primary key default true check (singleton),
  id uuid not null unique default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete restrict,
  data jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.erp_workspace_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.erp_workspaces(id) on delete cascade,
  username text not null,
  username_key text not null unique,
  role text not null check (role in ('admin', 'receipts', 'cashier', 'inventory', 'custom')),
  permissions jsonb not null default '[]'::jsonb,
  image text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.erp_access_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.erp_workspaces(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  username text not null,
  username_key text not null unique,
  created_at timestamptz not null default now()
);

alter table public.erp_workspaces enable row level security;
alter table public.erp_workspace_members enable row level security;
alter table public.erp_access_requests enable row level security;

create or replace function public.is_erp_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.erp_workspace_members
    where workspace_id = target_workspace
      and user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_erp_workspace_member(uuid) from public, anon;
grant execute on function public.is_erp_workspace_member(uuid) to authenticated;

create or replace function public.is_erp_workspace_admin(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.erp_workspace_members
    where workspace_id = target_workspace
      and user_id = (select auth.uid())
      and role = 'admin'
  );
$$;

revoke all on function public.is_erp_workspace_admin(uuid) from public, anon;
grant execute on function public.is_erp_workspace_admin(uuid) to authenticated;

drop policy if exists "Members can read their workspace" on public.erp_workspaces;
create policy "Members can read their workspace"
  on public.erp_workspaces for select to authenticated
  using (public.is_erp_workspace_member(id));

drop policy if exists "Members can read workspace accounts" on public.erp_workspace_members;
create policy "Members can read workspace accounts"
  on public.erp_workspace_members for select to authenticated
  using (public.is_erp_workspace_member(workspace_id));

drop policy if exists "Requesters and administrators can read access requests" on public.erp_access_requests;
create policy "Requesters and administrators can read access requests"
  on public.erp_access_requests for select to authenticated
  using (user_id = (select auth.uid()) or public.is_erp_workspace_admin(workspace_id));

grant select on public.erp_workspaces to authenticated;
grant select on public.erp_workspace_members to authenticated;
grant select on public.erp_access_requests to authenticated;

create or replace function public.erp_workspace_exists()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.erp_workspaces where singleton = true);
$$;

grant execute on function public.erp_workspace_exists() to anon, authenticated;
revoke all on function public.erp_workspace_exists() from public;
grant execute on function public.erp_workspace_exists() to anon, authenticated;

create or replace function public.bootstrap_erp_workspace(
  p_username text,
  p_permissions jsonb,
  p_image text,
  p_data jsonb
)
returns public.erp_workspace_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace public.erp_workspaces;
  new_member public.erp_workspace_members;
  safe_username text := btrim(p_username);
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if length(safe_username) < 3 or length(safe_username) > 40 then
    raise exception 'Username must contain 3 to 40 characters';
  end if;
  if lower(coalesce(auth.jwt() ->> 'email', '')) <> (
    'u' || substr(encode(extensions.digest(convert_to(lower(safe_username), 'UTF8'), 'sha256'), 'hex'), 1, 32)
    || '@users.nourgroup.app'
  ) then
    raise exception 'Username does not match the authenticated account';
  end if;

  insert into public.erp_workspaces (singleton, created_by, data)
  values (true, auth.uid(), coalesce(p_data, '{}'::jsonb))
  returning * into new_workspace;

  insert into public.erp_workspace_members (
    user_id, workspace_id, username, username_key, role, permissions, image
  )
  values (
    auth.uid(), new_workspace.id, safe_username, lower(safe_username),
    'admin', coalesce(p_permissions, '[]'::jsonb), coalesce(p_image, '')
  )
  returning * into new_member;

  return new_member;
end;
$$;

grant execute on function public.bootstrap_erp_workspace(text, jsonb, text, jsonb) to authenticated;
revoke all on function public.bootstrap_erp_workspace(text, jsonb, text, jsonb) from public, anon;

create or replace function public.submit_erp_access_request(p_username text)
returns public.erp_access_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  safe_username text := btrim(p_username);
  target_workspace uuid;
  new_request public.erp_access_requests;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if length(safe_username) < 3 or length(safe_username) > 40 then
    raise exception 'Username must contain 3 to 40 characters';
  end if;
  if lower(coalesce(auth.jwt() ->> 'email', '')) <> (
    'u' || substr(encode(extensions.digest(convert_to(lower(safe_username), 'UTF8'), 'sha256'), 'hex'), 1, 32)
    || '@users.nourgroup.app'
  ) then
    raise exception 'Username does not match the authenticated account';
  end if;

  select id into target_workspace
  from public.erp_workspaces
  where singleton = true;
  if target_workspace is null then
    raise exception 'The company workspace has not been created';
  end if;
  if exists (
    select 1 from public.erp_workspace_members
    where username_key = lower(safe_username)
  ) then
    raise exception 'Username is already registered';
  end if;

  insert into public.erp_access_requests (workspace_id, user_id, username, username_key)
  values (target_workspace, auth.uid(), safe_username, lower(safe_username))
  returning * into new_request;
  return new_request;
end;
$$;

grant execute on function public.submit_erp_access_request(text) to authenticated;
revoke all on function public.submit_erp_access_request(text) from public, anon;

create or replace function public.approve_erp_access_request(
  p_workspace_id uuid,
  p_request_id uuid,
  p_role text,
  p_permissions jsonb
)
returns public.erp_workspace_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  pending public.erp_access_requests;
  new_member public.erp_workspace_members;
begin
  if p_role not in ('receipts', 'cashier', 'inventory', 'custom') then
    raise exception 'Invalid account role';
  end if;
  if jsonb_typeof(p_permissions) <> 'array' or jsonb_array_length(p_permissions) = 0 then
    raise exception 'At least one permission is required';
  end if;

  select * into pending
  from public.erp_access_requests
  where id = p_request_id and workspace_id = p_workspace_id
  for update;
  if pending.id is null then
    raise exception 'Access request not found';
  end if;

  insert into public.erp_workspace_members (
    user_id, workspace_id, username, username_key, role, permissions, image
  )
  values (
    pending.user_id, pending.workspace_id, pending.username, pending.username_key,
    p_role, p_permissions, ''
  )
  returning * into new_member;

  delete from public.erp_access_requests where id = pending.id;
  return new_member;
end;
$$;

grant execute on function public.approve_erp_access_request(uuid, uuid, text, jsonb) to service_role;
revoke all on function public.approve_erp_access_request(uuid, uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.load_erp_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'workspace_id', w.id,
    'data', w.data,
    'version', w.version,
    'updated_at', w.updated_at
  )
  into result
  from public.erp_workspaces w
  join public.erp_workspace_members m on m.workspace_id = w.id
  where m.user_id = auth.uid()
  limit 1;

  if result is null then
    raise exception 'Workspace membership not found';
  end if;
  return result;
end;
$$;

grant execute on function public.load_erp_workspace() to authenticated;
revoke all on function public.load_erp_workspace() from public, anon;

create or replace function public.save_erp_workspace(p_data jsonb, p_expected_version bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_version bigint;
begin
  update public.erp_workspaces w
  set data = coalesce(p_data, '{}'::jsonb),
      version = w.version + 1,
      updated_at = now()
  where w.id = (
    select m.workspace_id
    from public.erp_workspace_members m
    where m.user_id = auth.uid()
    limit 1
  )
  and w.version = p_expected_version
  returning w.version into next_version;

  if next_version is null then
    raise exception using
      errcode = '40001',
      message = 'workspace_version_conflict';
  end if;
  return next_version;
end;
$$;

grant execute on function public.save_erp_workspace(jsonb, bigint) to authenticated;
revoke all on function public.save_erp_workspace(jsonb, bigint) from public, anon;
