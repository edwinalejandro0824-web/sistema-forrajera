-- ============================================================================
-- Base de datos del Sistema Forrajera (Supabase). Tablas forr_* y vistas forrajera_* (pueden convivir en el mismo proyecto que otro sistema).
-- Misma estructura de seguridad que CifraStock + tablas en español con bultos y granel.
-- ============================================================================
create extension if not exists pgcrypto with schema extensions;

-- ---------- datos de la app y usuarios ----------
create table public.forr_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9._-]{3,30}$'),
  name text not null check (char_length(name) between 1 and 40),
  role text not null check (role in ('admin','staff')),
  store text not null default '',
  created_at timestamptz not null default now()
);
alter table public.forr_profiles enable row level security;

create table public.forr_docs (
  coll text not null check (coll in ('stores','items','prod','movements','settings')),
  id text not null check (id ~ '^[A-Za-z0-9_\-]{1,120}$'),
  data jsonb not null default '{}'::jsonb,
  store text generated always as (case when coll = 'stores' then id else coalesce(data->>'store', '') end) stored,
  ts double precision generated always as (case when jsonb_typeof(data->'ts') = 'number' then (data->>'ts')::double precision end) stored,
  updated_at timestamptz not null default now(),
  primary key (coll, id)
);
create index forr_docs_coll_ts on public.forr_docs (coll, ts desc);
create index forr_docs_coll_store on public.forr_docs (coll, store);
alter table public.forr_docs enable row level security;

-- solo cuenta como verificada la sesión que confirmó el código del autenticador (aal2)
create or replace function public.mfa_ok() returns boolean language sql stable set search_path = '' as
$$ select coalesce((auth.jwt()->>'aal') = 'aal2', false) $$;
create or replace function public.forr_my_role() returns text language sql stable security definer set search_path = '' as
$$ select role from public.forr_profiles where id = auth.uid() and public.mfa_ok() $$;
create or replace function public.forr_my_store() returns text language sql stable security definer set search_path = '' as
$$ select store from public.forr_profiles where id = auth.uid() and public.mfa_ok() $$;
create or replace function public.forr_is_admin() returns boolean language sql stable security definer set search_path = '' as
$$ select coalesce((select role = 'admin' from public.forr_profiles where id = auth.uid()) and public.mfa_ok(), false) $$;

create policy profiles_read on public.forr_profiles for select to authenticated using (id = (select auth.uid()) or (select public.forr_is_admin()));
create policy profiles_need_mfa on public.forr_profiles as restrictive for select to authenticated using ((select public.mfa_ok()));

create policy docs_read on public.forr_docs for select to authenticated using (
  (select public.forr_is_admin())
  or ((select public.forr_my_role()) = 'staff' and coll in ('stores','items','prod','movements') and store = (select public.forr_my_store())));
create policy docs_insert on public.forr_docs for insert to authenticated with check (
  (select public.forr_is_admin())
  or ((select public.forr_my_role()) = 'staff' and coll in ('prod','movements') and store = (select public.forr_my_store())));
create policy docs_update on public.forr_docs for update to authenticated using (
  (select public.forr_is_admin())
  or ((select public.forr_my_role()) = 'staff' and coll in ('items','prod') and store = (select public.forr_my_store()))
) with check (
  (select public.forr_is_admin())
  or ((select public.forr_my_role()) = 'staff' and coll in ('items','prod') and store = (select public.forr_my_store())));
create policy docs_delete on public.forr_docs for delete to authenticated using ((select public.forr_is_admin()));
create policy docs_need_mfa on public.forr_docs as restrictive for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));

-- el encargado solo puede cambiar existencias (vender, comprar), no nombres, precios ni mínimos
create or replace function public.forr_docs_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.coll = 'items' and auth.uid() is not null and not public.forr_is_admin() then
    new.data := old.data || jsonb_strip_nulls(jsonb_build_object(
      'qty', new.data->'qty', 'alerted', new.data->'alerted', 'usage', new.data->'usage', 'updatedAt', new.data->'updatedAt'));
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger docs_guard before insert or update on public.forr_docs for each row execute function public.forr_docs_guard();

create or replace function public.forr_doc_patch(p_coll text, p_id text, p_patch jsonb) returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.forr_docs set data = data || p_patch where coll = p_coll and id = p_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
end $$;

-- ---------- cuentas ----------
create or replace function public.forr_setup_needed() returns boolean language sql stable security definer set search_path = '' as
$$ select not exists (select 1 from public.forr_profiles where role = 'admin') $$;

create or replace function public.forr_create_account(p_username text, p_password text, p_name text, p_role text, p_store text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := gen_random_uuid(); em text;
begin
  p_username := lower(trim(p_username));
  if not public.forr_is_admin() then
    if exists (select 1 from public.forr_profiles) or p_role <> 'admin' then raise exception 'not_allowed' using errcode = '42501'; end if;
  end if;
  if p_username !~ '^[a-z0-9._-]{3,30}$' then raise exception 'bad_username'; end if;
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'short_password'; end if;
  if p_role not in ('admin','staff') then raise exception 'bad_role'; end if;
  if p_role = 'staff' and not exists (select 1 from public.forr_docs where coll = 'stores' and id = p_store) then raise exception 'bad_store'; end if;
  if exists (select 1 from public.forr_profiles where username = p_username) then raise exception 'taken'; end if;
  em := p_username || '@forrajera.app';
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('name', p_name), now(), now(), '', '', '', '', '', '', '', '');
  insert into auth.identities (user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (uid, uid::text, jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());
  insert into public.forr_profiles (id, username, name, role, store)
  values (uid, p_username, left(coalesce(nullif(trim(p_name), ''), p_username), 40), p_role, case when p_role = 'staff' then p_store else '' end);
  return uid;
end $$;

create or replace function public.forr_set_password(p_user uuid, p_password text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.forr_is_admin() then raise exception 'not_allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.forr_profiles where id = p_user) then raise exception 'not_found' using errcode = 'P0002'; end if;
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'short_password'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = p_user;
end $$;

create or replace function public.forr_change_my_password(p_old text, p_new text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.mfa_ok() or not exists (select 1 from public.forr_profiles where id = auth.uid()) then raise exception 'not_allowed' using errcode = '42501'; end if;
  if char_length(coalesce(p_new, '')) < 8 then raise exception 'short_password'; end if;
  if not exists (select 1 from auth.users where id = auth.uid() and encrypted_password = extensions.crypt(p_old, encrypted_password)) then raise exception 'bad_password'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf')), updated_at = now() where id = auth.uid();
end $$;

create or replace function public.forr_delete_account(p_user uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.forr_is_admin() then raise exception 'not_allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.forr_profiles where id = p_user) then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_user = auth.uid() then raise exception 'self'; end if;
  if (select role from public.forr_profiles where id = p_user) = 'admin' and (select count(*) from public.forr_profiles where role = 'admin') <= 1 then raise exception 'last_admin'; end if;
  delete from auth.users where id = p_user;
end $$;

create or replace function public.forr_reset_mfa(p_user uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.forr_is_admin() then raise exception 'not_allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.forr_profiles where id = p_user) then raise exception 'not_found' using errcode = 'P0002'; end if;
  delete from auth.mfa_factors where user_id = p_user;
  delete from auth.sessions where user_id = p_user;
end $$;

revoke all on function public.forr_my_role(), public.forr_my_store(), public.forr_is_admin(), public.forr_set_password(uuid, text), public.forr_change_my_password(text, text),
  public.forr_delete_account(uuid), public.forr_reset_mfa(uuid), public.forr_doc_patch(text, text, jsonb) from public, anon;
grant execute on function public.forr_my_role(), public.forr_my_store(), public.forr_is_admin(), public.forr_set_password(uuid, text), public.forr_change_my_password(text, text),
  public.forr_delete_account(uuid), public.forr_reset_mfa(uuid), public.forr_doc_patch(text, text, jsonb) to authenticated;
revoke all on function public.forr_docs_guard() from public, anon, authenticated;
grant execute on function public.forr_setup_needed(), public.forr_create_account(text, text, text, text, text) to anon, authenticated;
grant execute on function public.mfa_ok() to authenticated, anon;

alter publication supabase_realtime add table public.forr_docs, public.forr_profiles;

-- ============================================================================
-- Tablas en español (solo para ver en el panel de Supabase; se llenan solas)
-- ============================================================================
create schema if not exists reportes_forr;
revoke all on schema reportes_forr from public, anon, authenticated;

create or replace function reportes_forr.num(v jsonb) returns numeric language sql immutable set search_path = '' as
$$ select case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric else 0 end $$;
create or replace function reportes_forr.fecha(v jsonb) returns timestamptz language sql immutable set search_path = '' as
$$ select case when jsonb_typeof(v) = 'number' then to_timestamp((v #>> '{}')::double precision / 1000) end $$;
create or replace function reportes_forr.categoria(c text) returns text language sql immutable set search_path = '' as
$$ select case c when 'alim' then 'Alimento balanceado' when 'gran' then 'Granos y semillas' when 'forr' then 'Forrajes y pacas'
  when 'sal' then 'Sales y minerales' when 'med' then 'Medicinas y vitaminas' when 'acc' then 'Accesorios' else 'Otros' end $$;
create or replace function reportes_forr.tipo(t text) returns text language sql immutable set search_path = '' as
$$ select case t when 'venta' then 'Venta' when 'compra' then 'Compra' else 'Ajuste' end $$;
create or replace function reportes_forr.tipo_venta(m text) returns text language sql immutable set search_path = '' as
$$ select case m when 'bulto' then 'Bulto' when 'granel' then 'Granel (kg)' when 'pieza' then 'Pieza' end $$;
create or replace function reportes_forr.unidad_venta(m text, n numeric) returns text language sql immutable set search_path = '' as
$$ select case m when 'bulto' then case when n = 1 then 'bulto' else 'bultos' end when 'granel' then 'kg' when 'pieza' then 'pzas' end $$;

create table public.forrajera_tiendas (id text primary key, nombre text not null, es_ejemplo boolean not null default false, creada timestamptz);
create table public.forrajera_inventario (
  id text primary key, tienda_id text, tienda text, nombre text not null, categoria text, se_vende_por text,
  kg_por_bulto numeric, bultos numeric, kg_sueltos numeric, existencia numeric, unidad text,
  minimo numeric, estado text, pedir numeric, unidad_pedido text,
  costo numeric, precio_venta numeric, precio_kg numeric, valor numeric, proveedor text, es_ejemplo boolean not null default false, actualizado timestamptz
);
create table public.forrajera_movimientos (
  id text primary key, fecha timestamptz, tipo text, direccion text, producto_id text, producto text, tienda_id text, tienda text, categoria text,
  cambio numeric, saldo numeric, unidad text, tipo_venta text, cantidad numeric, unidad_venta text, nota text, cliente text,
  precio_unidad numeric, precio_venta numeric, importe numeric, proveedor text, documento text, usuario text, referencia text
);
create index on public.forrajera_inventario (tienda_id);
create index on public.forrajera_movimientos (fecha desc);
alter table public.forrajera_tiendas enable row level security;
alter table public.forrajera_inventario enable row level security;
alter table public.forrajera_movimientos enable row level security;
revoke all on public.forrajera_tiendas, public.forrajera_inventario, public.forrajera_movimientos from anon, authenticated;

create or replace function reportes_forr.sync_producto(p_id text) returns void language plpgsql security definer set search_path = '' as $$
declare d jsonb; tn text; q numeric; mn numeric; mx numeric; bag numeric; tgt numeric; falta numeric; uc numeric;
begin
  select data into d from public.forr_docs where coll = 'items' and id = p_id;
  if d is null then delete from public.forrajera_inventario where id = p_id; return; end if;
  select data->>'name' into tn from public.forr_docs where coll = 'stores' and id = d->>'store';
  q := reportes_forr.num(d->'qty'); mn := reportes_forr.num(d->'min'); mx := reportes_forr.num(d->'max'); bag := reportes_forr.num(d->'bag');
  tgt := case when mx > 0 then mx else mn * 2 end; falta := greatest(0, ceil(tgt - q));
  uc := case when bag > 0 then reportes_forr.num(d->'cost') / bag else reportes_forr.num(d->'cost') end;
  insert into public.forrajera_inventario (id, tienda_id, tienda, nombre, categoria, se_vende_por, kg_por_bulto, bultos, kg_sueltos, existencia, unidad,
    minimo, estado, pedir, unidad_pedido, costo, precio_venta, precio_kg, valor, proveedor, es_ejemplo, actualizado)
  values (p_id, d->>'store', coalesce(tn, 'Sin tienda'), d->>'name', reportes_forr.categoria(d->>'cat'),
    case when bag > 0 then 'Bulto y granel' else 'Pieza' end, nullif(bag, 0),
    case when bag > 0 then floor(q / bag) end, case when bag > 0 then round(q - floor(q / bag) * bag, 2) end,
    q, case when bag > 0 then 'kg' else coalesce(nullif(d->>'unit', ''), 'pzas') end, mn,
    case when q <= 0 then 'Agotado' when q <= mn then 'Por agotarse' else 'En orden' end,
    case when q > mn then 0 when bag > 0 then ceil(falta / bag) else falta end,
    case when bag > 0 then 'bultos' else coalesce(nullif(d->>'unit', ''), 'pzas') end,
    nullif(reportes_forr.num(d->'cost'), 0), nullif(reportes_forr.num(d->'price'), 0), nullif(reportes_forr.num(d->'priceKg'), 0),
    round(q * uc, 2), nullif(d->>'supplier', ''), coalesce((d->>'example')::boolean, false), reportes_forr.fecha(d->'updatedAt'))
  on conflict (id) do update set tienda_id = excluded.tienda_id, tienda = excluded.tienda, nombre = excluded.nombre, categoria = excluded.categoria,
    se_vende_por = excluded.se_vende_por, kg_por_bulto = excluded.kg_por_bulto, bultos = excluded.bultos, kg_sueltos = excluded.kg_sueltos,
    existencia = excluded.existencia, unidad = excluded.unidad, minimo = excluded.minimo, estado = excluded.estado, pedir = excluded.pedir,
    unidad_pedido = excluded.unidad_pedido, costo = excluded.costo, precio_venta = excluded.precio_venta, precio_kg = excluded.precio_kg,
    valor = excluded.valor, proveedor = excluded.proveedor, es_ejemplo = excluded.es_ejemplo, actualizado = excluded.actualizado;
end $$;

create or replace function reportes_forr.sync_tienda(p_id text) returns void language plpgsql security definer set search_path = '' as $$
declare d jsonb;
begin
  select data into d from public.forr_docs where coll = 'stores' and id = p_id;
  if d is null then delete from public.forrajera_tiendas where id = p_id; return; end if;
  insert into public.forrajera_tiendas (id, nombre, es_ejemplo, creada) values (p_id, d->>'name', coalesce((d->>'example')::boolean, false), reportes_forr.fecha(d->'createdAt'))
  on conflict (id) do update set nombre = excluded.nombre, es_ejemplo = excluded.es_ejemplo, creada = excluded.creada;
  update public.forrajera_inventario set tienda = d->>'name' where tienda_id = p_id;
  update public.forrajera_movimientos set tienda = d->>'name' where tienda_id = p_id;
end $$;

create or replace function reportes_forr.sync_movimiento(p_id text) returns void language plpgsql security definer set search_path = '' as $$
declare d jsonb; it jsonb; tn text; dl numeric; amt numeric; pv numeric; md text; un numeric;
begin
  select data into d from public.forr_docs where coll = 'movements' and id = p_id;
  if d is null then delete from public.forrajera_movimientos where id = p_id; return; end if;
  select data->>'name' into tn from public.forr_docs where coll = 'stores' and id = d->>'store';
  select data into it from public.forr_docs where coll = 'items' and id = d->>'item';
  dl := reportes_forr.num(d->'delta'); md := nullif(d->>'mode', ''); un := nullif(reportes_forr.num(d->'units'), 0);
  if d->>'type' = 'venta' then
    pv := nullif(reportes_forr.num(d->'pv'), 0);
    amt := coalesce(nullif(reportes_forr.num(d->'total'), 0), round(coalesce(un, abs(dl)) * coalesce(pv, 0), 2));
  elsif d->>'type' = 'compra' then
    amt := nullif(reportes_forr.num(d->'total'), 0);
  end if;
  insert into public.forrajera_movimientos (id, fecha, tipo, direccion, producto_id, producto, tienda_id, tienda, categoria, cambio, saldo, unidad,
    tipo_venta, cantidad, unidad_venta, nota, cliente, precio_unidad, precio_venta, importe, proveedor, documento, usuario, referencia)
  values (p_id, reportes_forr.fecha(d->'ts'), reportes_forr.tipo(d->>'type'), case when dl >= 0 then 'Entrada' else 'Salida' end, d->>'item', d->>'name',
    d->>'store', coalesce(tn, 'Sin tienda'), reportes_forr.categoria(d->>'cat'), dl, reportes_forr.num(d->'qty'),
    case when reportes_forr.num(it->'bag') > 0 then 'kg' else coalesce(nullif(it->>'unit', ''), 'pzas') end,
    reportes_forr.tipo_venta(md), coalesce(un, abs(dl)), reportes_forr.unidad_venta(md, coalesce(un, abs(dl))), nullif(d->>'sale', ''), nullif(d->>'client', ''),
    nullif(reportes_forr.num(d->'pu'), 0), pv, amt, nullif(d->>'sup', ''), nullif(d->>'doc', ''), nullif(d->>'by', ''), nullif(d->>'ref', ''))
  on conflict (id) do update set fecha = excluded.fecha, tipo = excluded.tipo, direccion = excluded.direccion, producto_id = excluded.producto_id,
    producto = excluded.producto, tienda_id = excluded.tienda_id, tienda = excluded.tienda, categoria = excluded.categoria, cambio = excluded.cambio,
    saldo = excluded.saldo, unidad = excluded.unidad, tipo_venta = excluded.tipo_venta, cantidad = excluded.cantidad, unidad_venta = excluded.unidad_venta,
    nota = excluded.nota, cliente = excluded.cliente, precio_unidad = excluded.precio_unidad, precio_venta = excluded.precio_venta, importe = excluded.importe,
    proveedor = excluded.proveedor, documento = excluded.documento, usuario = excluded.usuario, referencia = excluded.referencia;
end $$;

create or replace function reportes_forr.docs_sync() returns trigger language plpgsql security definer set search_path = '' as $$
declare c text := coalesce(new.coll, old.coll); i text := coalesce(new.id, old.id);
begin
  if c = 'items' then perform reportes_forr.sync_producto(i);
  elsif c = 'stores' then perform reportes_forr.sync_tienda(i);
  elsif c = 'movements' then perform reportes_forr.sync_movimiento(i);
  end if;
  return null;
end $$;
create trigger docs_sync after insert or update or delete on public.forr_docs for each row execute function reportes_forr.docs_sync();

-- ---------- resúmenes ----------
create view public.forrajera_inventario_resumen with (security_invoker = true) as
select count(*) filter (where estado = 'Agotado') as agotados, count(*) filter (where estado = 'Por agotarse') as por_agotarse,
  count(*) filter (where estado = 'En orden') as en_orden, count(*) as total_productos,
  coalesce(sum(bultos), 0) as bultos_en_bodega, coalesce(sum(existencia) filter (where se_vende_por = 'Bulto y granel'), 0) as kg_en_bodega,
  coalesce(sum(valor), 0) as valor_inventario
from public.forrajera_inventario;

create view public.forrajera_por_reponer with (security_invoker = true) as
select tienda, nombre as producto, categoria, bultos, kg_sueltos, existencia, unidad, estado, pedir, unidad_pedido, proveedor,
  round(pedir * coalesce(costo, 0), 2) as costo_estimado
from public.forrajera_inventario where estado <> 'En orden'
order by case estado when 'Agotado' then 0 else 1 end, tienda, producto;

create view public.forrajera_por_tienda with (security_invoker = true) as
select t.nombre as tienda, count(p.id) as productos, count(p.id) filter (where p.estado = 'Agotado') as agotados,
  count(p.id) filter (where p.estado = 'Por agotarse') as por_agotarse, coalesce(sum(p.valor), 0) as valor_inventario
from public.forrajera_tiendas t left join public.forrajera_inventario p on p.tienda_id = t.id
group by t.id, t.nombre order by t.nombre;

create view public.forrajera_entradas_salidas with (security_invoker = true) as
select fecha, direccion, tipo, producto, tienda, categoria, tipo_venta, cantidad, unidad_venta, abs(cambio) as cambio_existencia, unidad, saldo,
  importe, precio_unidad as costo_compra, precio_venta, nota, cliente, proveedor, documento, usuario
from public.forrajera_movimientos order by fecha desc;

create view public.forrajera_compras with (security_invoker = true) as
select fecha, producto, tienda, cantidad, coalesce(unidad_venta, unidad) as unidad, precio_unidad as costo, importe as total, proveedor, documento, usuario
from public.forrajera_movimientos where tipo = 'Compra' order by fecha desc;

create view public.forrajera_compras_historial_precios with (security_invoker = true) as
select fecha, producto, proveedor, costo, cantidad, unidad, total from public.forrajera_compras where costo is not null order by producto, fecha;

create view public.forrajera_ventas with (security_invoker = true) as
select fecha, to_char(fecha at time zone 'America/Mexico_City', 'YYYY-MM') as mes, nota, cliente, producto, tienda, tipo_venta, cantidad, unidad_venta,
  precio_venta, importe, usuario
from public.forrajera_movimientos where tipo = 'Venta' order by fecha desc;

create view public.forrajera_ventas_notas with (security_invoker = true) as
select nota, min(fecha) as fecha, max(cliente) as cliente, max(tienda) as tienda, count(*) as renglones, sum(importe) as total, max(usuario) as usuario
from public.forrajera_ventas where nota is not null group by nota order by fecha desc;

create view public.forrajera_ventas_metas with (security_invoker = true) as
select m.key as mes, reportes_forr.num(m.value) as meta
from public.forr_docs g cross join lateral jsonb_each(coalesce(g.data->'months', '{}'::jsonb)) m
where g.coll = 'settings' and g.id = 'goals' order by mes desc;

create view public.forrajera_ventas_por_mes with (security_invoker = true) as
with v as (select mes, sum(importe) as vendido, count(distinct coalesce(nota, fecha::text)) as notas,
  sum(cantidad) filter (where tipo_venta = 'Bulto') as bultos, sum(cantidad) filter (where tipo_venta = 'Granel (kg)') as kg_granel
  from public.forrajera_ventas group by mes)
select coalesce(v.mes, g.mes) as mes, coalesce(v.vendido, 0) as vendido, coalesce(v.notas, 0) as notas, coalesce(v.bultos, 0) as bultos_vendidos,
  coalesce(v.kg_granel, 0) as kg_a_granel, g.meta,
  case when g.meta > 0 then round(coalesce(v.vendido, 0) / g.meta * 100, 1) end as porcentaje_meta,
  case when g.meta > 0 and coalesce(v.vendido, 0) >= g.meta then 'Meta cumplida' when g.meta > 0 then 'En camino' else 'Sin meta' end as estado_meta,
  case when g.meta > 0 then greatest(0, g.meta - coalesce(v.vendido, 0)) end as falta
from v full join public.forrajera_ventas_metas g on g.mes = v.mes order by mes desc;

create view public.forrajera_ventas_por_producto with (security_invoker = true) as
select mes, producto, sum(cantidad) filter (where tipo_venta = 'Bulto') as bultos, sum(cantidad) filter (where tipo_venta = 'Granel (kg)') as kg_granel,
  sum(cantidad) filter (where tipo_venta = 'Pieza') as piezas, sum(importe) as vendido
from public.forrajera_ventas group by mes, producto order by mes desc, vendido desc nulls last;

create view public.forrajera_usuarios with (security_invoker = true) as
select p.name as nombre, p.username as usuario, case p.role when 'admin' then 'Administrador' else 'Encargado' end as rol,
  case when p.role = 'admin' then 'Todas' else coalesce(t.nombre, 'Sin tienda') end as tienda,
  exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified') as autenticador_activo,
  'Guardada cifrada (no se puede ver)'::text as contrasena, u.last_sign_in_at as ultimo_acceso, p.created_at as creado
from public.forr_profiles p join auth.users u on u.id = p.id left join public.forrajera_tiendas t on t.id = p.store order by p.name;

create view public.forrajera_avisos with (security_invoker = true) as
select nullif(a.data->>'email', '') as correo_avisos, reportes_forr.fecha(a.data->'updatedAt') as actualizado
from public.forr_docs a where a.coll = 'settings' and a.id = 'alerts';

create view public.forrajera_reinicio with (security_invoker = true) as
select (r.data ? 'hash') as clave_de_reinicio_creada, reportes_forr.fecha(r.data->'last'->'at') as ultimo_reinicio,
  r.data->'last'->>'by' as reiniciado_por, r.data->'last'->>'count' as registros_borrados
from public.forr_docs r where r.coll = 'settings' and r.id = 'reset';

create view public.forrajera_mi_cuenta with (security_invoker = true) as
select p.username as usuario, p.name as nombre, case p.role when 'admin' then 'Administrador' else 'Encargado' end as rol,
  'Guardada cifrada (no se puede ver)'::text as contrasena, u.updated_at as cuenta_actualizada,
  exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified') as autenticador_activo, u.last_sign_in_at as ultimo_acceso
from public.forr_profiles p join auth.users u on u.id = p.id order by p.name;

revoke all on public.forrajera_inventario_resumen, public.forrajera_por_reponer, public.forrajera_por_tienda, public.forrajera_entradas_salidas, public.forrajera_compras,
  public.forrajera_compras_historial_precios, public.forrajera_ventas, public.forrajera_ventas_notas, public.forrajera_ventas_metas, public.forrajera_ventas_por_mes, public.forrajera_ventas_por_producto,
  public.forrajera_usuarios, public.forrajera_avisos, public.forrajera_reinicio, public.forrajera_mi_cuenta from anon, authenticated;
revoke all on all functions in schema reportes_forr from public, anon, authenticated;
