-- Bultos cerrados y bulto abierto: la existencia a granel se lleva en dos partes (closed = bultos enteros, open = kg del bulto abierto).
-- El encargado también puede mover closed/open al vender o comprar.
create or replace function public.forr_docs_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.coll = 'items' and auth.uid() is not null and not public.forr_is_admin() then
    new.data := old.data || jsonb_strip_nulls(jsonb_build_object(
      'qty', new.data->'qty', 'closed', new.data->'closed', 'open', new.data->'open',
      'alerted', new.data->'alerted', 'usage', new.data->'usage', 'updatedAt', new.data->'updatedAt'));
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.forr_docs_guard() from public, anon, authenticated;

create or replace function reportes_forr.tipo(t text) returns text language sql immutable set search_path = '' as
$$ select case t when 'venta' then 'Venta' when 'compra' then 'Compra' when 'abrir' then 'Bulto abierto' else 'Ajuste' end $$;

drop view public.forrajera_inventario_resumen;
drop view public.forrajera_por_reponer;
alter table public.forrajera_inventario rename column bultos to bultos_cerrados;
alter table public.forrajera_inventario rename column kg_sueltos to kg_bulto_abierto;
alter table public.forrajera_movimientos add column bultos_cerrados_despues numeric, add column kg_abierto_despues numeric;

create or replace function reportes_forr.sync_producto(p_id text) returns void language plpgsql security definer set search_path = '' as $$
declare d jsonb; tn text; q numeric; mn numeric; mx numeric; bag numeric; tgt numeric; falta numeric; uc numeric; cl numeric; op numeric;
begin
  select data into d from public.forr_docs where coll = 'items' and id = p_id;
  if d is null then delete from public.forrajera_inventario where id = p_id; return; end if;
  select data->>'name' into tn from public.forr_docs where coll = 'stores' and id = d->>'store';
  q := reportes_forr.num(d->'qty'); mn := reportes_forr.num(d->'min'); mx := reportes_forr.num(d->'max'); bag := reportes_forr.num(d->'bag');
  if bag > 0 then
    if jsonb_typeof(d->'closed') = 'number' then cl := reportes_forr.num(d->'closed'); op := reportes_forr.num(d->'open');
    else cl := floor(q / bag); op := round(q - floor(q / bag) * bag, 2); end if;
  end if;
  tgt := case when mx > 0 then mx else mn * 2 end; falta := greatest(0, ceil(tgt - q));
  uc := case when bag > 0 then reportes_forr.num(d->'cost') / bag else reportes_forr.num(d->'cost') end;
  insert into public.forrajera_inventario (id, tienda_id, tienda, nombre, categoria, se_vende_por, kg_por_bulto, bultos_cerrados, kg_bulto_abierto, existencia, unidad,
    minimo, estado, pedir, unidad_pedido, costo, precio_venta, precio_kg, valor, proveedor, es_ejemplo, actualizado)
  values (p_id, d->>'store', coalesce(tn, 'Sin tienda'), d->>'name', reportes_forr.categoria(d->>'cat'),
    case when bag > 0 then 'Bulto y granel' else 'Pieza' end, nullif(bag, 0), cl, op,
    q, case when bag > 0 then 'kg' else coalesce(nullif(d->>'unit', ''), 'pzas') end, mn,
    case when q <= 0 then 'Agotado' when q <= mn then 'Por agotarse' else 'En orden' end,
    case when q > mn then 0 when bag > 0 then ceil(falta / bag) else falta end,
    case when bag > 0 then 'bultos' else coalesce(nullif(d->>'unit', ''), 'pzas') end,
    nullif(reportes_forr.num(d->'cost'), 0), nullif(reportes_forr.num(d->'price'), 0), nullif(reportes_forr.num(d->'priceKg'), 0),
    round(q * uc, 2), nullif(d->>'supplier', ''), coalesce((d->>'example')::boolean, false), reportes_forr.fecha(d->'updatedAt'))
  on conflict (id) do update set tienda_id = excluded.tienda_id, tienda = excluded.tienda, nombre = excluded.nombre, categoria = excluded.categoria,
    se_vende_por = excluded.se_vende_por, kg_por_bulto = excluded.kg_por_bulto, bultos_cerrados = excluded.bultos_cerrados, kg_bulto_abierto = excluded.kg_bulto_abierto,
    existencia = excluded.existencia, unidad = excluded.unidad, minimo = excluded.minimo, estado = excluded.estado, pedir = excluded.pedir,
    unidad_pedido = excluded.unidad_pedido, costo = excluded.costo, precio_venta = excluded.precio_venta, precio_kg = excluded.precio_kg,
    valor = excluded.valor, proveedor = excluded.proveedor, es_ejemplo = excluded.es_ejemplo, actualizado = excluded.actualizado;
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
    tipo_venta, cantidad, unidad_venta, nota, cliente, precio_unidad, precio_venta, importe, proveedor, documento, usuario, referencia,
    bultos_cerrados_despues, kg_abierto_despues)
  values (p_id, reportes_forr.fecha(d->'ts'), reportes_forr.tipo(d->>'type'),
    case when d->>'type' = 'abrir' then 'Interno' when dl >= 0 then 'Entrada' else 'Salida' end, d->>'item', d->>'name',
    d->>'store', coalesce(tn, 'Sin tienda'), reportes_forr.categoria(d->>'cat'), dl, reportes_forr.num(d->'qty'),
    case when reportes_forr.num(it->'bag') > 0 then 'kg' else coalesce(nullif(it->>'unit', ''), 'pzas') end,
    reportes_forr.tipo_venta(md), coalesce(un, abs(dl)), reportes_forr.unidad_venta(md, coalesce(un, abs(dl))), nullif(d->>'sale', ''), nullif(d->>'client', ''),
    nullif(reportes_forr.num(d->'pu'), 0), pv, amt, nullif(d->>'sup', ''), nullif(d->>'doc', ''), nullif(d->>'by', ''), nullif(d->>'ref', ''),
    case when jsonb_typeof(d->'closedAfter') = 'number' then reportes_forr.num(d->'closedAfter') end,
    case when jsonb_typeof(d->'openAfter') = 'number' then reportes_forr.num(d->'openAfter') end)
  on conflict (id) do update set fecha = excluded.fecha, tipo = excluded.tipo, direccion = excluded.direccion, producto_id = excluded.producto_id,
    producto = excluded.producto, tienda_id = excluded.tienda_id, tienda = excluded.tienda, categoria = excluded.categoria, cambio = excluded.cambio,
    saldo = excluded.saldo, unidad = excluded.unidad, tipo_venta = excluded.tipo_venta, cantidad = excluded.cantidad, unidad_venta = excluded.unidad_venta,
    nota = excluded.nota, cliente = excluded.cliente, precio_unidad = excluded.precio_unidad, precio_venta = excluded.precio_venta, importe = excluded.importe,
    proveedor = excluded.proveedor, documento = excluded.documento, usuario = excluded.usuario, referencia = excluded.referencia,
    bultos_cerrados_despues = excluded.bultos_cerrados_despues, kg_abierto_despues = excluded.kg_abierto_despues;
end $$;

create view public.forrajera_inventario_resumen with (security_invoker = true) as
select count(*) filter (where estado = 'Agotado') as agotados, count(*) filter (where estado = 'Por agotarse') as por_agotarse,
  count(*) filter (where estado = 'En orden') as en_orden, count(*) as total_productos,
  coalesce(sum(bultos_cerrados), 0) as bultos_cerrados_en_bodega, coalesce(sum(kg_bulto_abierto), 0) as kg_en_bultos_abiertos,
  coalesce(sum(existencia) filter (where se_vende_por = 'Bulto y granel'), 0) as kg_en_bodega,
  coalesce(sum(valor), 0) as valor_inventario
from public.forrajera_inventario;

create view public.forrajera_por_reponer with (security_invoker = true) as
select tienda, nombre as producto, categoria, bultos_cerrados, kg_bulto_abierto, existencia, unidad, estado, pedir, unidad_pedido, proveedor,
  round(pedir * coalesce(costo, 0), 2) as costo_estimado
from public.forrajera_inventario where estado <> 'En orden'
order by case estado when 'Agotado' then 0 else 1 end, tienda, producto;

create view public.forrajera_bultos_abiertos with (security_invoker = true) as
select fecha, producto, tienda, bultos_cerrados_despues, kg_abierto_despues, referencia as motivo, usuario
from public.forrajera_movimientos where tipo = 'Bulto abierto' order by fecha desc;

revoke all on public.forrajera_inventario_resumen, public.forrajera_por_reponer, public.forrajera_bultos_abiertos from anon, authenticated;
revoke all on all functions in schema reportes_forr from public, anon, authenticated;

select reportes_forr.sync_producto(id) from public.forr_docs where coll = 'items';
