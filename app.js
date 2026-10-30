(function () {
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); };
  var sb = null, db = null, stores = [], items = [], moves = [], settings = {}, accounts = [], me = null;
  var filterStore = 'all', query = '', ready = { stores: false, items: false, accounts: false }, dirty = false;
  var chain = {}, toastTimer = null, sureTimer = null, sureId = null;

  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3800);
  }
  function fail(e) {
    var c = e && e.code;
    if (c === 'short') toast('No alcanza: no hay suficientes bultos cerrados o kg en el bulto abierto.');
    else if (c === 'quota_exceeded') toast('Se llenó el espacio de la base de datos. Elimina productos o historial que ya no uses.');
    else if (c === 'invalid_argument') toast('No tienes permiso para modificar el inventario con tu acceso actual.');
    else toast('No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.');
  }
  function queue(id, fn) {
    chain[id] = (chain[id] || Promise.resolve()).then(fn).catch(fail);
    return chain[id];
  }
  function num(v) { var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; }
  function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('es-MX'); }
  function status(i) { return i.qty <= 0 ? 'out' : (i.qty <= i.min ? 'low' : 'ok'); }
  var LABEL = { out: 'Agotado', low: 'Por agotarse', ok: 'En orden' };
  var CATS = { alim: 'Alimento balanceado', gran: 'Granos y semillas', forr: 'Forrajes y pacas', sal: 'Sales y minerales', med: 'Medicinas y vitaminas', acc: 'Accesorios', otro: 'Otros' }, CAT_ORDER = ['alim', 'gran', 'forr', 'sal', 'med', 'acc', 'otro'];
  var filterCat = 'all';
  function catOf(i) { return CATS[i && i.cat] ? i.cat : 'otro'; }
  // Bultos y granel: si el producto tiene «kg por bulto», su existencia se guarda en kg y se vende por bulto o a granel
  function isBulk(i) { return !!i && +i.bag > 0; }
  function baseUnit(i) { return isBulk(i) ? 'kg' : (i.unit || 'pzas'); }
  // Existencia a granel en dos partes: bultos cerrados (enteros) y kg del bulto abierto. Total kg = cerrados × kg por bulto + abierto
  function bulkState(v) {
    var bag = +v.bag || 0, q = +v.qty || 0;
    if (v.closed != null) return { closed: +v.closed || 0, open: +v.open || 0 };
    var c = Math.floor(q / bag + 1e-9); return { closed: c, open: Math.round((q - c * bag) * 100) / 100 };
  }
  function qtyText(i, q) {
    if (!isBulk(i)) return fmt(q == null ? i.qty : q) + ' ' + esc(baseUnit(i));
    if (q == null) { var st = bulkState(i); return fmt(st.closed) + (st.closed === 1 ? ' bulto cerrado' : ' bultos cerrados') + (st.open > 0 ? ' + ' + fmt(st.open) + ' kg abierto' : ''); }
    var b = Math.floor(q / i.bag + 1e-9), k = Math.round((q - b * i.bag) * 100) / 100;
    return (b ? fmt(b) + (b === 1 ? ' bulto' : ' bultos') : '') + (b && k ? ' + ' : '') + (k || !b ? fmt(k) + ' kg' : '');
  }
  function orderStr(i) { var q = toOrder(i); return isBulk(i) ? fmt(Math.ceil(q / i.bag)) + ' bultos' : fmt(q) + ' ' + esc(baseUnit(i)); }
  function storeName(id) { var s = stores.find(function (x) { return x.id === id; }); return s ? s.name : 'Sin tienda'; }

  /* ---------- render ---------- */
  function render() {
    if (!ready.stores || !ready.items || !me) return;
    var a = document.activeElement;
    if (a && $('#list').contains(a) && (a.tagName === 'INPUT')) { dirty = true; renderTop(); return; }
    dirty = false;
    renderTop(); renderList();
  }
  function renderTop() {
    if (me) applyRole();
    var items = vItems(), stores = vStores();
    var out = 0, low = 0, ok = 0, val = 0;
    items.forEach(function (i) { var s = status(i); if (s === 'out') out++; else if (s === 'low') low++; else ok++; if (unitCost(i) > 0) val += i.qty * unitCost(i); });
    $('#stats').innerHTML =
      '<div class="stat out"><b>' + out + '</b><span>Agotados</span></div>' +
      '<div class="stat low"><b>' + low + '</b><span>Por agotarse</span></div>' +
      '<div class="stat ok"><b>' + ok + '</b><span>En orden</span></div>' +
      (isAdmin() && val > 0 ? '<div class="stat"><b style="font-size:22px">' + money(val) + '</b><span>Valor del inventario</span></div>' : '');

    var hot = items.filter(function (i) { return status(i) !== 'ok'; })
      .sort(function (x, y) { return (status(x) === 'out' ? 0 : 1) - (status(y) === 'out' ? 0 : 1) || x.name.localeCompare(y.name, 'es'); });
    var mail = !isAdmin() ? 'Lo que se está acabando en tu tienda.' : settings.email ? 'Correo de avisos: ' + esc(settings.email) + '.' :'Falta tu correo para recibir avisos. Agrégalo en «Avisos y tiendas».';
    var h = '<header><h2>' + (hot.length ? hot.length + (hot.length === 1 ? ' producto necesita reposición' : ' productos necesitan reposición') : 'Alertas de stock') + '</h2><p>' + mail + '</p></header>';
    if (!hot.length) h += '<div class="allgood">' + (items.length ? 'Todo el inventario está por encima de su mínimo.' : 'Cuando agregues productos, aquí verás los que se estén acabando.') + '</div>';
    else h += '<ul>' + hot.slice(0, 30).map(function (i) {
      var s = status(i);
      return '<li><span class="who">' + esc(i.name) + '<small>' + esc(storeName(i.store)) + '</small></span>' +
        '<span class="qn">' + qtyText(i) + ' de mín. ' + qtyText(i, i.min) + (toOrder(i) > 0 ? ' · pedir ' + orderStr(i) : '') + '</span>' +
        '<span class="pill ' + s + '">' + LABEL[s] + '</span></li>';
    }).join('') + (hot.length > 30 ? '<li><span class="who">y ' + (hot.length - 30) + ' más en la lista de abajo</span></li>' : '') + '</ul>';
    var el = $('#alerts'); el.className = 'alerts' + (hot.length ? ' hot' : ''); el.innerHTML = h;

    var chips = '<button class="chip" data-store="all" aria-pressed="' + (filterStore === 'all') + '">Todas</button>';
    stores.forEach(function (s) {
      var n = items.filter(function (i) { return i.store === s.id && status(i) !== 'ok'; }).length;
      chips += '<button class="chip" data-store="' + esc(s.id) + '" aria-pressed="' + (filterStore === s.id) + '">' + esc(s.name) + (n ? '<em>' + n + '</em>' : '') + '</button>';
    });
    $('#chips').innerHTML = chips;
    syncSelects(); renderStoreList(); renderHist(); if (isAdmin()) renderAcc(items, stores); fillRepStores(); renderOps();
  }
  function syncSelects() {
    ['#a-store', '#i-store', '#u-store'].forEach(function (sel) {
      var el = $(sel), cur = el.value || (filterStore !== 'all' ? filterStore : '');
      el.innerHTML = stores.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join('');
      if (cur && stores.some(function (s) { return s.id === cur; })) el.value = cur;
    });
    var m = $('#s-mail'); if (document.activeElement !== m && m.value === '' && settings.email) m.value = settings.email;
  }
  function renderList() {
    var items = vItems(), stores = vStores();
    var rows = items.filter(function (i) {
      return (filterStore === 'all' || i.store === filterStore) && (filterCat === 'all' || catOf(i) === filterCat) && (!query || i.name.toLowerCase().indexOf(query) !== -1);
    }).sort(function (x, y) {
      var o = { out: 0, low: 1, ok: 2 };
      return o[status(x)] - o[status(y)] || x.name.localeCompare(y.name, 'es');
    });
    var el = $('#list');
    if (!stores.length && !isAdmin()) {
      el.innerHTML = '<div class="empty"><p>Tu usuario no tiene una tienda asignada. Pide al administrador que te la asigne.</p></div>';
      return;
    }
    if (!stores.length) {
      el.innerHTML = '<div class="empty"><h2>Empieza agregando tu forrajera</h2><p>Crea tu tienda o bodega (por ejemplo «Forrajera centro» o «Bodega»), agrega sus productos con la cantidad que tienes hoy y el mínimo con el que quieres que te avisemos. También puedes importar una lista completa pegándola desde Excel.</p>' +
        '<div class="bar"><button class="btn" id="go-store" type="button">Agregar tienda</button><button class="ghost" id="go-demo" type="button">Cargar datos de ejemplo</button></div></div>';
      return;
    }
    if (!rows.length) {
      el.innerHTML = '<div class="empty"><p>' + (query ? 'Ningún producto coincide con la búsqueda.' : 'Esta tienda todavía no tiene productos. Usa «Agregar producto» o «Importar lista de productos» aquí abajo.') + '</p></div>';
      return;
    }
    el.innerHTML = rows.map(function (i) {
      var s = status(i), sure = sureId === i.id;
      return '<div class="row ' + s + '" data-id="' + esc(i.id) + '">' +
        '<div class="nm"><strong>' + esc(i.name) + (i.example ? ' <small>(ejemplo)</small>' : '') + '</strong>' +
        '<small>' + esc(CATS[catOf(i)]) + ' · ' + esc(storeName(i.store)) + (isBulk(i) ? ' · bulto de ' + fmt(i.bag) + ' kg' : ' · ' + esc(baseUnit(i))) + (i.supplier ? ' · ' + esc(i.supplier) : '') + forecast(i) + '</small>' +
        '<small class="stock">Hay <b>' + qtyText(i) + '</b>' + (isBulk(i) ? ' · ' + fmt(i.qty) + ' kg en total' : '') + priceText(i) + '</small>' +
        '<button class="ghost admin-only more-btn" data-act="more">' + (openId === i.id ? 'Cerrar' : 'Precios y bulto') + '</button></div>' +
        (isBulk(i) ? bulkCtl(i) :
        '<div class="qty"><button class="sq" data-act="dec" aria-label="Restar uno a ' + esc(i.name) + '">−</button>' +
        '<input type="number" inputmode="decimal" min="0" step="any" data-act="qty" value="' + i.qty + '" aria-label="Cantidad en ' + esc(baseUnit(i)) + ' de ' + esc(i.name) + '" title="Cantidad en ' + esc(baseUnit(i)) + '">' +
        '<button class="sq" data-act="inc" aria-label="Sumar uno a ' + esc(i.name) + '">+</button><small class="un">' + esc(baseUnit(i)) + '</small></div>') +
        '<label class="mn">Mín. <input type="number" inputmode="decimal" min="0" step="any" data-act="min" value="' + (isBulk(i) ? r2(i.min / i.bag) : i.min) + '"' + (isAdmin() ? '' : ' disabled') + ' aria-label="Mínimo en ' + (isBulk(i) ? 'bultos' : esc(baseUnit(i))) + ' de ' + esc(i.name) + '"><small class="un">' + (isBulk(i) ? 'bultos' : esc(baseUnit(i))) + '</small></label>' +
        '<div class="st"><span class="pill ' + s + '">' + LABEL[s] + '</span><button class="ghost admin-only' + (sure ? ' sure' : '') + '" data-act="del">' + (sure ? '¿Seguro?' : 'Quitar') + '</button></div>' +
        (openId === i.id && isAdmin() ? extraHtml(i) : '') +
        '</div>';
    }).join('');
  }
  // controles de un producto a granel: bultos cerrados (− / +) y el bulto abierto con su barra de lo que queda
  function bulkCtl(i) {
    var st = bulkState(i), pct = Math.max(0, Math.min(100, st.open / i.bag * 100));
    return '<div class="qty bulkqty">' +
      '<div class="bq"><button class="sq" data-act="dec" aria-label="Restar un bulto cerrado a ' + esc(i.name) + '">−</button>' +
      '<input type="number" inputmode="numeric" min="0" step="1" data-act="closed" value="' + st.closed + '" aria-label="Bultos cerrados de ' + esc(i.name) + '">' +
      '<button class="sq" data-act="inc" aria-label="Sumar un bulto cerrado a ' + esc(i.name) + '">+</button><small class="un">bultos cerrados</small></div>' +
      '<div class="bq"><input type="number" inputmode="decimal" min="0" step="any" data-act="open" value="' + st.open + '" aria-label="Kg que quedan en el bulto abierto de ' + esc(i.name) + '">' +
      '<small class="un">kg en el abierto</small><button class="ghost" data-act="openbag" type="button"' + (st.closed < 1 ? ' disabled' : '') + '>Abrir bulto</button></div>' +
      '<div class="openbar" title="Quedan ' + fmt(st.open) + ' de ' + fmt(i.bag) + ' kg en el bulto abierto"><i style="width:' + pct + '%"></i></div>' +
      '</div>';
  }
  function priceText(i) {
    var p = [];
    if (i.price > 0) p.push(money(i.price) + (isBulk(i) ? ' el bulto' : ' c/u'));
    if (isBulk(i) && i.priceKg > 0) p.push(money(i.priceKg) + ' el kg');
    return p.length ? ' · ' + p.join(' · ') : '';
  }
  function renderStoreList() {
    var el = $('#storelist');
    el.innerHTML = stores.map(function (s) {
      var n = items.filter(function (i) { return i.store === s.id; }).length;
      var sure = sureId === 's:' + s.id;
      return '<div class="storeline"><span>' + esc(s.name) + ' <small class="hint">' + n + ' productos</small></span>' +
        '<button class="ghost' + (sure ? ' sure' : '') + '" data-delstore="' + esc(s.id) + '">' + (sure ? 'Confirmar: borra la tienda y sus productos' : 'Eliminar tienda') + '</button></div>';
    }).join('');
  }
  function renderHist() {
    var el = $('#hist');
    if (!moves.length) { el.innerHTML = '<p class="hint">Aquí aparecerán las entradas y salidas que registres.</p>'; return; }
    el.innerHTML = moves.slice(0, 40).map(function (m) {
      var d = new Date(m.ts).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return '<div><span>' + esc(TYPES[m.type] || 'Ajuste') + ' · ' + esc(m.name) + ' · ' + esc(storeName(m.store)) + (m.by ? ' · ' + esc(m.by) : '') + '</span><span class="d ' + (m.delta >= 0 ? 'pos' : 'neg') + '">' + (m.delta >= 0 ? '+' : '') + fmt(m.delta) + ' → ' + fmt(m.qty) + '</span><span class="hint">' + d + '</span></div>';
    }).join('');
  }

  /* ---------- writes ---------- */
  function logMove(item, delta, qty, type, ref, more) {
    return db.collection('movements').add(Object.assign({ item: item.id, name: item.name, store: item.store, cat: catOf(item), delta: delta, qty: qty, type: type || 'aj', ref: ref || '', by: me ? me.name : '', ts: Date.now() }, more || {})).catch(function () {});
  }
  function setQty(id, value) {
    var item = items.find(function (x) { return x.id === id; }); if (!item) return;
    if (!me || (!isAdmin() && item.store !== me.store)) return;
    if (value > 1e7) { toast('Esa cantidad es demasiado grande.'); return; }
    var q = Math.max(0, Math.round(value * 100) / 100); if (q === item.qty) return;
    var delta = q - item.qty;
    queue(id, function () {
      return db.doc('items/' + id).update(Object.assign({ qty: q, alerted: q > item.min ? false : !!item.alerted, updatedAt: Date.now() }, delta < 0 ? { usage: bumpUsage(item, -delta) } : {})).then(function () { return logMove(item, delta, q); });
    });
  }
  function setMin(id, value) {
    if (!isAdmin()) return;
    var item = items.find(function (x) { return x.id === id; }); if (!item) return;
    var m = Math.max(0, value); if (m === item.min) return;
    queue(id, function () { return db.doc('items/' + id).update({ min: m, alerted: item.qty > m ? false : !!item.alerted, updatedAt: Date.now() }); });
  }
  function armSure(key) {
    sureId = key; clearTimeout(sureTimer);
    sureTimer = setTimeout(function () { sureId = null; dirty = false; renderList(); renderStoreList(); renderUsers(); }, 3500);
  }
  function addStore(name, extra) {
    var ref = db.collection('stores').doc();
    return ref.set(Object.assign({ name: name, createdAt: Date.now() }, extra || {})).then(function () { return ref.id; });
  }
  function newItem(o) {
    var ref = db.collection('items').doc();
    return ref.set({ name: o.name, store: o.store, qty: o.qty, min: o.min, unit: o.unit || '', cat: CATS[o.cat] ? o.cat : 'otro', cost: (isFinite(o.cost) && o.cost > 0) ? o.cost : 0, costDozen: (isFinite(o.costDozen) && o.costDozen > 0) ? o.costDozen : 0, price: (isFinite(o.price) && o.price > 0) ? o.price : 0, priceKg: (isFinite(o.priceKg) && o.priceKg > 0) ? o.priceKg : 0, bag: (isFinite(o.bag) && o.bag > 0) ? o.bag : 0, closed: (o.bag > 0 && isFinite(o.closed)) ? o.closed : null, open: (o.bag > 0 && isFinite(o.open)) ? o.open : 0, supplier: String(o.supplier || '').slice(0, 60), max: (isFinite(o.max) && o.max > 0) ? o.max : 0, usage: [], recipe: [], alerted: false, example: !!o.example, updatedAt: Date.now() }).then(function () { return ref.id; });
  }

  /* ---------- events ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.dataset.store) { filterStore = t.dataset.store; dirty = false; renderTop(); renderList(); return; }
    if (t.id === 'go-store') { $('#p-set').open = true; $('#s-store').focus(); return; }
    if (t.id === 'go-demo') { loadDemo(); return; }
    if (t.dataset.delstore) {
      var sid = t.dataset.delstore;
      if (sureId === 's:' + sid) { sureId = null; deleteStore(sid); } else { armSure('s:' + sid); renderStoreList(); }
      return;
    }
    var row = t.closest('.row'); if (!row) return;
    var id = row.dataset.id, item = items.find(function (x) { return x.id === id; }); if (!item) return;
    if (t.dataset.act === 'more' && isAdmin()) { openId = (openId === id ? null : id); dirty = false; renderList(); return; }
    // − / + cambian de a un bulto cerrado en productos a granel, de a una pieza en los demás
    if (isBulk(item) && (t.dataset.act === 'dec' || t.dataset.act === 'inc')) { var sb0 = bulkState(item); setBulk(id, sb0.closed + (t.dataset.act === 'inc' ? 1 : -1), sb0.open); return; }
    if (t.dataset.act === 'openbag') { openBag(id); return; }
    if (t.dataset.act === 'dec') setQty(id, item.qty - 1);
    if (t.dataset.act === 'inc') setQty(id, item.qty + 1);
    if (t.dataset.act === 'del' && isAdmin()) {
      if (sureId === id) { sureId = null; queue(id, function () { return db.doc('items/' + id).delete(); }); }
      else { armSure(id); dirty = false; renderList(); }
    }
  });
  $('#list').addEventListener('change', function (e) {
    var t = e.target, row = t.closest('.row'); if (!row) return;
    if (t.dataset.act === 'cat') { setText(row.dataset.id, 'cat', CATS[t.value] ? t.value : 'otro'); return; }
    if (t.dataset.act === 'supplier') { setText(row.dataset.id, 'supplier', t.value.trim().slice(0, 60)); return; }
    var item = items.find(function (x) { return x.id === row.dataset.id; }), mult = isBulk(item) ? item.bag : 1;
    // la cantidad ideal se escribe en bultos (o piezas) y se guarda en kg
    if (t.dataset.act === 'max') { var mv = t.value.trim() === '' ? 0 : num(t.value); setField(row.dataset.id, 'max', isFinite(mv) ? r2(mv * mult) : mv); return; }
    if (t.dataset.act === 'cost' || t.dataset.act === 'price' || t.dataset.act === 'priceKg') { setField(row.dataset.id, t.dataset.act, t.value.trim() === '' ? 0 : num(t.value)); return; }
    if (t.dataset.act === 'bag') { setBag(row.dataset.id, num(t.value)); return; }
    if (t.dataset.act === 'closed' || t.dataset.act === 'open') {
      var stc = bulkState(item), nv = num(t.value);
      if (t.dataset.act === 'closed') setBulk(row.dataset.id, nv, stc.open); else setBulk(row.dataset.id, stc.closed, nv);
      return;
    }
    var v = num(t.value);
    if (!isFinite(v) || v < 0) { t.value = item ? (t.dataset.act === 'qty' ? item.qty : r2(item.min / mult)) : 0; return; }
    if (t.dataset.act === 'qty') setQty(row.dataset.id, v);
    if (t.dataset.act === 'min') setMin(row.dataset.id, r2(v * mult));
  });
  $('#list').addEventListener('focusout', function () { setTimeout(function () { if (dirty && !($('#list').contains(document.activeElement) && document.activeElement.tagName === 'INPUT')) render(); }, 60); });
  $('#f-cat').addEventListener('change', function (e) { filterCat = e.target.value; dirty = false; renderList(); });
  $('#search').addEventListener('input', function (e) { query = e.target.value.trim().toLowerCase(); renderList(); });

  $('#f-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('#a-name').value.trim(), store = $('#a-store').value;
    if (!db || !name) return;
    if (!store) { toast('Primero agrega una tienda en «Avisos y tiendas».'); return; }
    // a granel: bultos cerrados (enteros) + kg del bulto abierto; el total en kg se calcula
    var bulk = $('#a-sell').value === 'bulk', bag = num($('#a-bag').value), mult = 1;
    if (bulk) { if (!(bag > 0)) { toast('Escribe cuántos kg trae cada bulto.'); return; } mult = bag; }
    var n = Math.max(0, num($('#a-qty').value) || 0), loose = bulk ? Math.max(0, num($('#a-loose').value) || 0) : 0;
    if (bulk && n !== Math.floor(n)) { toast('Los bultos cerrados van en números enteros. Lo suelto escríbelo en «Kg en el bulto abierto».'); return; }
    newItem({ name: name, store: store, cat: $('#a-cat').value, qty: r2(n * mult + loose), closed: bulk ? n : null, open: bulk ? r2(loose) : 0, min: r2(Math.max(0, num($('#a-min').value) || 0) * mult), unit: bulk ? 'kg' : ($('#a-unit').value.trim() || 'pzas'), bag: bulk ? bag : 0,
      cost: num($('#a-cost').value), price: num($('#a-price').value), priceKg: bulk ? num($('#a-pricekg').value) : 0, max: r2((num($('#a-max').value) || 0) * mult), supplier: $('#a-supplier').value.trim().slice(0, 60) })
      .then(function () { $('#a-name').value = ''; $('#a-qty').value = '0'; $('#a-loose').value = ''; $('#a-name').focus(); toast('Producto agregado'); }).catch(fail);
  });
  // el formulario cambia sus etiquetas según se venda por bulto o por pieza
  function syncAddForm() {
    var bulk = $('#a-sell').value === 'bulk';
    Array.prototype.forEach.call(document.querySelectorAll('#f-add .bulk-only'), function (el) { el.hidden = !bulk; });
    Array.prototype.forEach.call(document.querySelectorAll('#f-add .piece-only'), function (el) { el.hidden = bulk; });
    $('#f-add .u-q').textContent = bulk ? 'Bultos cerrados (sin abrir)' : 'Cantidad que tienes hoy';
    $('#f-add .u-m').textContent = bulk ? 'Avisar cuando baje de (bultos)' : 'Avisar cuando baje de';
    $('#f-add .u-c').textContent = bulk ? 'Costo por bulto (compra)' : 'Costo por pieza (compra)';
    $('#f-add .u-p').textContent = bulk ? 'Precio de venta por bulto' : 'Precio de venta por pieza';
    $('#f-add .u-x').textContent = bulk ? 'Cantidad ideal en bultos (opcional)' : 'Cantidad ideal (opcional)';
  }
  $('#a-sell').addEventListener('change', syncAddForm);
  syncAddForm();
  $('#f-store').addEventListener('submit', function (e) {
    e.preventDefault();
    var n = $('#s-store').value.trim(); if (!db || !n) return;
    addStore(n).then(function (id) { $('#s-store').value = ''; if (filterStore === 'all' && stores.length === 0) filterStore = id; toast('Tienda agregada'); }).catch(fail);
  });
  $('#f-mail').addEventListener('submit', function (e) {
    e.preventDefault();
    var m = $('#s-mail').value.trim(); if (!db) return;
    db.doc('settings/alerts').set({ email: m, updatedAt: Date.now() }).then(function () { toast('Correo guardado'); }).catch(fail);
  });
  $('#i-go').addEventListener('click', function () {
    var store = $('#i-store').value, raw = $('#i-text').value, msg = $('#i-msg');
    if (!store) { msg.textContent = 'Primero agrega una tienda.'; return; }
    var lines = raw.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var existing = {}; items.forEach(function (i) { if (i.store === store) existing[i.name.toLowerCase()] = true; });
    var todo = [], skipped = 0, bad = 0;
    lines.forEach(function (l, idx) {
      var sep = l.indexOf('\t') !== -1 ? '\t' : (l.indexOf(';') !== -1 ? ';' : ',');
      var p = l.split(sep).map(function (x) { return x.trim(); });
      // producto, cantidad (bultos o piezas), mínimo, kg por bulto, costo, precio, precio por kg, proveedor
      var name = p[0], qty = num(p[1]), min = num(p[2]), bag = num(p[3]), m = bag > 0 ? bag : 1;
      if (!name || !isFinite(qty)) { if (idx > 0) bad++; return; }
      if (existing[name.toLowerCase()]) { skipped++; return; }
      existing[name.toLowerCase()] = true;
      todo.push({ name: name.slice(0, 80), store: store, cat: $('#i-cat').value, qty: r2(Math.max(0, Math.floor(qty)) * m), closed: bag > 0 ? Math.max(0, Math.floor(qty)) : null, open: 0, min: isFinite(min) ? r2(Math.max(0, min) * m) : 0, bag: bag > 0 ? bag : 0, unit: bag > 0 ? 'kg' : 'pzas', cost: num(p[4]), price: num(p[5]), priceKg: bag > 0 ? num(p[6]) : 0, supplier: (p[7] || '').slice(0, 60) });
    });
    if (!todo.length) { msg.textContent = 'No encontré productos nuevos para importar.' + (skipped ? ' ' + skipped + ' ya existían.' : ''); return; }
    $('#i-go').disabled = true;
    var n = 0;
    (function next() {
      if (n >= todo.length) {
        $('#i-go').disabled = false; $('#i-text').value = '';
        msg.textContent = 'Importados ' + n + ' productos.' + (skipped ? ' Omitidos por repetidos: ' + skipped + '.' : '') + (bad ? ' Líneas que no pude leer: ' + bad + '.' : '');
        return;
      }
      msg.textContent = 'Importando ' + (n + 1) + ' de ' + todo.length + '…';
      newItem(todo[n]).then(function () { n++; next(); }).catch(function (err) { $('#i-go').disabled = false; msg.textContent = 'Se detuvo después de ' + n + ' productos.'; fail(err); });
    })();
  });

  function deleteStore(sid) {
    var mine = items.filter(function (i) { return i.store === sid; });
    var p = Promise.resolve();
    mine.forEach(function (i) { p = p.then(function () { return db.doc('items/' + i.id).delete(); }); });
    p.then(function () { return db.doc('stores/' + sid).delete(); }).then(function () { if (filterStore === sid) filterStore = 'all'; toast('Tienda eliminada'); }).catch(fail);
  }
  function loadDemo() {
    // nombre, categoría, kg por bulto (0 = pieza), bultos/piezas, mínimo, costo, precio bulto/pieza, precio kg, proveedor, unidad
    var demo = [
      ['Alimento para pollo engorda', 'alim', 40, 12, 5, 520, 590, 16, 'Alimentos del Bajío'], ['Alimento para cerdo inicio', 'alim', 40, 6, 6, 610, 690, 18.5, 'Alimentos del Bajío'],
      ['Alimento para ganado lechero', 'alim', 40, 20, 8, 430, 495, 13.5, 'Purina'], ['Alimento para perro adulto', 'alim', 25, 4, 3, 690, 790, 34, 'Purina'],
      ['Maíz quebrado', 'gran', 40, 15, 10, 300, 350, 9.5, 'Granos La Laguna'], ['Sorgo', 'gran', 40, 3, 6, 260, 310, 8.5, 'Granos La Laguna'],
      ['Salvado de trigo', 'gran', 30, 9, 5, 210, 250, 9, 'Molinos del Norte'], ['Sal mineral', 'sal', 25, 7, 4, 330, 390, 17, 'Minerales MX'],
      ['Paca de alfalfa', 'forr', 0, 30, 20, 120, 150, 0, 'Rancho El Alamo', 'pacas'], ['Bebedero para aves 4 L', 'acc', 0, 8, 3, 65, 95, 0, 'Agropecuaria Norte', 'pzas'],
      ['Ivermectina 50 ml', 'med', 0, 5, 3, 140, 185, 0, 'Veterinaria Central', 'pzas']
    ];
    addStore('Forrajera (ejemplo)', { example: true }).then(function (id) {
      var p = Promise.resolve();
      demo.forEach(function (d) {
        var m = d[2] > 0 ? d[2] : 1;
        p = p.then(function () { return newItem({ name: d[0], cat: d[1], bag: d[2], store: id, qty: d[3] * m + (d[2] > 0 ? Math.round(d[2] / 3) : 0), closed: d[2] > 0 ? d[3] : null, open: d[2] > 0 ? Math.round(d[2] / 3) : 0, min: d[4] * m, cost: d[5], price: d[6], priceKg: d[7], supplier: d[8], unit: d[2] > 0 ? 'kg' : d[9], max: d[4] * m * 3, example: true }); });
      });
      return p.then(function () { filterStore = id; toast('Ejemplo cargado. Bórralo cuando quieras con «Eliminar tienda».'); });
    }).catch(fail);
  }

  /* ---------- cuentas automaticas ---------- */
  var openId = null, orderText = '';
  function money(n) { return '$' + (Math.round(n * 100) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5); }
  function bumpUsage(item, used) {
    var day = today(), u = (item.usage || []).map(function (e) { return { d: e.d, n: e.n }; });
    var last = u[u.length - 1];
    if (last && last.d === day) last.n = Math.round((last.n + used) * 100) / 100;
    else u.push({ d: day, n: Math.round(used * 100) / 100 });
    return u.filter(function (e) { return daysBetween(e.d, day) < 30; });
  }
  function daysLeft(i) {
    var u = i.usage || [];
    if (u.length < 3 || i.qty <= 0) return null;
    var span = Math.max(7, Math.min(30, daysBetween(u[0].d, today()) + 1));
    var total = u.reduce(function (a, e) { return a + (+e.n || 0); }, 0), avg = total / span;
    return avg > 0 ? i.qty / avg : null;
  }
  function forecast(i) {
    var d = daysLeft(i); if (d === null) return '';
    return ' · ' + (d < 1 ? 'menos de 1 día' : '≈ ' + Math.round(d) + ' días');
  }
  // costo por unidad base (por kg en productos a granel: costo del bulto ÷ kg del bulto)
  function unitCost(i) { var c = i.cost > 0 ? i.cost : (i.costDozen > 0 ? i.costDozen / 12 : 0); return isBulk(i) ? c / i.bag : c; }
  function target(i) { return i.max > 0 ? i.max : i.min * 2; }
  function toOrder(i) { return Math.max(0, Math.ceil(target(i) - i.qty)); }
  function extraHtml(i) {
    var b = isBulk(i), u = b ? 'bulto' : 'pieza';
    return '<div class="extra"><label class="f">Categoría<select data-act="cat">' + CAT_ORDER.map(function (c) { return '<option value="' + c + '"' + (catOf(i) === c ? ' selected' : '') + '>' + CATS[c] + '</option>'; }).join('') + '</select></label><label class="f">Proveedor<input type="text" maxlength="60" data-act="supplier" value="' + esc(i.supplier || '') + '"></label>' +
      (b ? '<label class="f">Kg por bulto<input type="number" inputmode="decimal" min="0" step="any" data-act="bag" value="' + i.bag + '"></label>' : '') +
      '<label class="f">Costo por ' + u + ' (compra)<input type="number" inputmode="decimal" min="0" step="any" data-act="cost" value="' + (i.cost || '') + '"></label>' +
      '<label class="f">Precio de venta por ' + u + '<input type="number" inputmode="decimal" min="0" step="any" data-act="price" value="' + (i.price || '') + '"></label>' +
      (b ? '<label class="f">Precio por kg (granel)<input type="number" inputmode="decimal" min="0" step="any" data-act="priceKg" value="' + (i.priceKg || '') + '"></label>' : '') +
      '<label class="f">Cantidad ideal (' + (b ? 'bultos' : esc(baseUnit(i))) + ')<input type="number" inputmode="decimal" min="0" step="any" data-act="max" value="' + (i.max ? r2(i.max / (b ? i.bag : 1)) : '') + '"></label></div>';
  }
  function setField(id, field, v) {
    if (!isAdmin()) return;
    if (!isFinite(v) || v < 0) { toast('Escribe un número válido.'); return; }
    var item = items.find(function (x) { return x.id === id; }); if (!item || (+item[field] || 0) === v) return;
    queue(id, function () { var d = { updatedAt: Date.now() }; d[field] = v; return db.doc('items/' + id).update(d); });
  }
  function setText(id, field, v) {
    if (!isAdmin()) return;
    var item = items.find(function (x) { return x.id === id; }); if (!item || String(item[field] || '') === v) return;
    queue(id, function () { var d = { updatedAt: Date.now() }; d[field] = v; return db.doc('items/' + id).update(d); });
  }
  function renderAcc(its, sts) {
    var tot = { n: 0, out: 0, low: 0, val: 0 };
    var trs = sts.map(function (s) {
      var mine = its.filter(function (i) { return i.store === s.id; }), out = 0, low = 0, val = 0;
      mine.forEach(function (i) { var st = status(i); if (st === 'out') out++; else if (st === 'low') low++; if (unitCost(i) > 0) val += i.qty * unitCost(i); });
      tot.n += mine.length; tot.out += out; tot.low += low; tot.val += val;
      return '<tr><td>' + esc(s.name) + '</td><td>' + mine.length + '</td><td>' + out + '</td><td>' + low + '</td><td>' + (val ? money(val) : '—') + '</td></tr>';
    }).join('');
    var nocost = its.filter(function (i) { return !(unitCost(i) > 0); }).length;
    $('#acc-sum').innerHTML = sts.length ?
      '<div class="tablewrap"><table><thead><tr><th>Tienda</th><th>Productos</th><th>Agotados</th><th>Por agotarse</th><th>Valor</th></tr></thead><tbody>' + trs + '</tbody>' +
      '<tfoot><tr><td>Total</td><td>' + tot.n + '</td><td>' + tot.out + '</td><td>' + tot.low + '</td><td>' + (tot.val ? money(tot.val) : '—') + '</td></tr></tfoot></table></div>' +
      (nocost ? '<p class="hint">' + nocost + ' productos sin precio. Agrégalo en «Proveedor y precios» de cada producto para calcular el valor.</p>' : '') :
      '<p class="hint">Aquí verás el resumen por tienda cuando agregues tiendas y productos.</p>';
    var ctr = CAT_ORDER.map(function (c) {
      var mine = its.filter(function (i) { return catOf(i) === c; }), out = 0, low = 0, val = 0;
      mine.forEach(function (i) { var st = status(i); if (st === 'out') out++; else if (st === 'low') low++; if (unitCost(i) > 0) val += i.qty * unitCost(i); });
      return mine.length ? '<tr><td>' + CATS[c] + '</td><td>' + mine.length + '</td><td>' + out + '</td><td>' + low + '</td><td>' + (val ? money(val) : '—') + '</td></tr>' : '';
    }).join('');
    $('#acc-cat').innerHTML = ctr ? '<div class="tablewrap"><table><thead><tr><th>Categoría</th><th>Productos</th><th>Agotados</th><th>Por agotarse</th><th>Valor</th></tr></thead><tbody>' + ctr + '</tbody></table></div>' : '<p class="hint">Aún no hay productos.</p>';
    var need = its.filter(function (i) { return status(i) !== 'ok'; });
    var txt = 'Pedido sugerido · ' + new Date().toLocaleDateString('es-MX') + '\n', html = '', totalCost = 0;
    sts.forEach(function (s) {
      var mine = need.filter(function (i) { return i.store === s.id; }).sort(function (x, y) { return x.name.localeCompare(y.name, 'es'); });
      if (!mine.length) return;
      html += '<h3>' + esc(s.name) + '</h3><ul>'; txt += '\n' + s.name + '\n';
      mine.forEach(function (i) {
        // a granel se pide en bultos completos
        var q = toOrder(i), bags = isBulk(i) ? Math.ceil(q / i.bag) : 0, c = unitCost(i) > 0 ? (isBulk(i) ? bags * i.bag : q) * unitCost(i) : 0; totalCost += c;
        var qs = isBulk(i) ? fmt(bags) + (bags === 1 ? ' bulto' : ' bultos') : fmt(q) + ' ' + baseUnit(i);
        html += '<li><span>' + esc(i.name) + (i.supplier ? ' <small class="hint">· ' + esc(i.supplier) + '</small>' : '') + '</span><span class="qn">' + (q ? 'pedir ' + esc(qs) : 'revisar') + (c ? ' · ' + money(c) : '') + '</span></li>';
        txt += '- ' + i.name + (i.supplier ? ' [' + i.supplier + ']' : '') + ': ' + (q ? 'pedir ' + qs : 'revisar') + (c ? ' (' + money(c) + ')' : '') + '\n';
      });
      html += '</ul>';
    });
    if (totalCost) { html += '<p class="hint">Costo estimado del pedido: ' + money(totalCost) + '</p>'; txt += '\nCosto estimado: ' + money(totalCost) + '\n'; }
    orderText = html ? txt : '';
    $('#acc-order').innerHTML = html || '<p class="hint">No hay productos por reponer.</p>';
    $('#acc-copy').disabled = !html;
  }
  $('#acc-copy').addEventListener('click', function () {
    if (!orderText) return;
    try { navigator.clipboard.writeText(orderText).then(function () { toast('Pedido copiado'); }, function () { toast('No se pudo copiar. Selecciona el texto del pedido y cópialo.'); }); }
    catch (e) { toast('No se pudo copiar. Selecciona el texto del pedido y cópialo.'); }
  });

  /* ---------- reporte de historial ---------- */
  var repText = '', repCsv = '', repSig = '';
  function csvCell(v) {
    v = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(v) && isNaN(Number(v))) v = String.fromCharCode(39) + v;
    return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function fillRepStores() {
    var el = $('#r-store'); if (!el || !me) return;
    var sts = vStores();
    var sig = (isAdmin() ? 'A' : 'S') + sts.map(function (s) { return s.id + ':' + s.name; }).join('|');
    if (sig === repSig) return;
    repSig = sig;
    var cur = el.value;
    el.innerHTML = (isAdmin() ? '<option value="all">Todas las tiendas</option>' : '') + sts.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join('');
    if (cur && Array.prototype.some.call(el.options, function (o) { return o.value === cur; })) el.value = cur;
  }
  function openReport() {
    setTab('rep'); var p = $('#p-rep'); p.open = true;
    try { p.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
    fillRepStores();
    repData = null; $('#r-out').innerHTML = ''; ['#r-copy', '#r-csv', '#r-pdf', '#r-png'].forEach(function (x) { $(x).disabled = true; });
    markType(''); $('#r-msg').textContent = 'Elige qué reporte quieres: general o por categoría (alimento, granos, forrajes, sales, medicinas o accesorios).';
  }
  function markType(v) { Array.prototype.forEach.call(document.querySelectorAll('#r-types .chip'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.rcat === v)); }); }
  $('#r-types').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    $('#r-cat').value = b.dataset.rcat; markType(b.dataset.rcat); genReport();
  });
  function genReport(n) {
    n = n || 0; markType($('#r-cat').value);
    if (!db || !me) return;
    if (!ready.items || !ready.stores) {
      if (n < 10) { $('#r-msg').textContent = 'Cargando datos…'; setTimeout(function () { genReport(n + 1); }, 700); }
      return;
    }
    var days = +$('#r-period').value || 7, since = new Date();
    since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
    var sel = isAdmin() ? ($('#r-store').value || 'all') : me.store;
    $('#r-msg').textContent = 'Generando…'; $('#r-go').disabled = true;
    db.collection('movements').where('ts', '>=', since.getTime()).orderBy('ts', 'desc').limit(1000).get().then(function (snap) {
      var mv = snap.docs.map(function (d) { return d.data(); }).filter(function (m) { return sel === 'all' || m.store === sel; });
      buildReport(mv, days, sel, snap.size >= 1000);
      $('#r-msg').textContent = '';
    }).catch(function (e) { $('#r-msg').textContent = 'No se pudo generar el reporte.'; fail(e); })
      .then(function () { $('#r-go').disabled = false; });
  }
  var repData = null;
  function buildReport(mv, days, sel, capped) {
    var cf = $('#r-cat').value || 'all';
    var scope = vItems().filter(function (i) { return (sel === 'all' || i.store === sel) && (cf === 'all' || catOf(i) === cf); });
    var rows = {};
    scope.forEach(function (i) { rows[i.id] = { name: i.name, store: i.store, cat: catOf(i), unit: i.unit || '', inn: 0, out: 0, qty: i.qty, st: status(i), gone: false, sup: i.supplier || '', pu: i.cost || 0, pd: i.costDozen || 0, uc: unitCost(i) }; });
    var mvs = [];
    mv.forEach(function (m) {
      var r = rows[m.item];
      if (!r) {
        var mc = CATS[m.cat] ? m.cat : 'otro';
        if (cf !== 'all' && mc !== cf) return;
        r = rows[m.item] = { name: m.name, store: m.store, cat: mc, unit: '', inn: 0, out: 0, qty: null, st: null, gone: true, sup: '', pu: 0, pd: 0, uc: 0 };
      }
      if (m.delta > 0) r.inn += m.delta; else r.out += -m.delta;
      mvs.push(m);
    });
    var all = Object.keys(rows).map(function (k) { return rows[k]; });
    var groups = CAT_ORDER.map(function (c) {
      var rs = all.filter(function (r) { return r.cat === c; }).sort(function (a, b) { return b.out - a.out || a.name.localeCompare(b.name, 'es'); });
      var val = 0; rs.forEach(function (r) { if (r.qty !== null && r.uc > 0) val += r.qty * r.uc; });
      return { cat: c, name: CATS[c], rows: rs, val: val };
    }).filter(function (g) { return g.rows.length; });
    var nOut = all.filter(function (r) { return r.st === 'out'; }).length, nLow = all.filter(function (r) { return r.st === 'low'; }).length;
    var total = groups.reduce(function (a, g) { return a + g.val; }, 0);
    var label = (sel === 'all' ? 'Todas las tiendas' : storeName(sel)) + (cf === 'all' ? '' : ' · ' + CATS[cf]);
    var period = days === 1 ? 'Hoy' : 'Últimos ' + days + ' días';
    function fdate(ts) { return new Date(ts).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    function sign(d) { return (d > 0 ? '+' : '') + fmt(d); }
    var sinceD = new Date(); sinceD.setHours(0, 0, 0, 0); sinceD.setDate(sinceD.getDate() - (days - 1)); var pr = prodRows(sel, cf, sinceD);
    repData = { prod: pr, label: label, period: period, date: new Date().toLocaleDateString('es-MX'), groups: groups, mv: mvs, nOut: nOut, nLow: nLow, total: total, capped: capped, n: all.length, fdate: fdate, sign: sign, catOf: function (m) { return (rows[m.item] || {}).cat || 'otro'; } };
    var h = '<div class="stats"><div class="stat"><b>' + mvs.length + '</b><span>Movimientos</span></div>' +
      '<div class="stat out"><b>' + nOut + '</b><span>Agotados ahora</span></div>' +
      '<div class="stat low"><b>' + nLow + '</b><span>Por agotarse</span></div>' +
      (total > 0 ? '<div class="stat"><b style="font-size:22px">' + money(total) + '</b><span>Valor del inventario</span></div>' : '') + '</div>' +
      '<p class="hint">' + esc(label) + ' · ' + period + (capped ? ' · se muestran los últimos 1000 movimientos' : '') + '</p>';
    if (!groups.length) h += '<p class="hint">Todavía no hay productos.</p>';
    groups.forEach(function (g) {
      h += '<h2 style="font-size:15px">' + esc(g.name) + ' <small class="hint">· ' + g.rows.length + ' productos' + (g.val ? ' · ' + money(g.val) : '') + '</small></h2>' +
        '<div class="tablewrap"><table><thead><tr><th>Producto</th><th>Proveedor</th><th>Tienda</th><th>Entró</th><th>Salió</th><th>Saldo</th><th>Precio unidad</th><th>Precio docena</th><th>Estado</th></tr></thead><tbody>' +
        g.rows.map(function (r) {
          return '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.sup || '—') + '</td><td>' + esc(storeName(r.store)) + '</td><td class="pos">' + (r.inn ? '+' + fmt(r.inn) : '—') + '</td><td class="neg">' + (r.out ? '−' + fmt(r.out) : '—') + '</td><td>' + (r.qty === null ? '—' : fmt(r.qty) + (r.unit ? ' ' + esc(r.unit) : '')) + '</td><td>' + (r.pu ? money(r.pu) : '—') + '</td><td>' + (r.pd ? money(r.pd) : '—') + '</td><td>' + (r.gone ? 'Eliminado' : LABEL[r.st]) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    });
    if (pr.length) {
      var tm = 0, ts = 0;
      h += '<h2 style="font-size:15px">Producción y ventas por semana</h2><div class="tablewrap"><table><thead><tr><th>Semana</th><th>Producto</th><th>Fabricados</th><th>Vendidos</th></tr></thead><tbody>' + pr.map(function (r) { tm += r.made; ts += r.sold; return '<tr><td>' + esc(weekLabel(r.w)) + '</td><td>' + esc(r.name) + '</td><td class="pos">' + fmt(r.made) + '</td><td class="neg">' + fmt(r.sold) + '</td></tr>'; }).join('') + '</tbody><tfoot><tr><td></td><td>Total</td><td>' + fmt(tm) + '</td><td>' + fmt(ts) + '</td></tr></tfoot></table></div>';
    }
    h += '<h2 style="font-size:15px">Movimientos</h2>' +
      (mvs.length ? '<div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Categoría</th><th>Producto</th><th>Tienda</th><th>Cambio</th><th>Saldo</th><th>Usuario</th></tr></thead><tbody>' +
        mvs.slice(0, 100).map(function (m) {
          return '<tr><td>' + fdate(m.ts) + '</td><td>' + (TYPES[m.type] || 'Ajuste') + '</td><td>' + CATS[repData.catOf(m)] + '</td><td>' + esc(m.name) + '</td><td>' + esc(storeName(m.store)) + '</td><td class="' + (m.delta > 0 ? 'pos' : 'neg') + '">' + sign(m.delta) + '</td><td>' + fmt(m.qty) + '</td><td>' + esc(m.by || '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' + (mvs.length > 100 ? '<p class="hint">Se muestran 100 de ' + mvs.length + ' aquí. El PDF y la imagen traen hasta 300 y el CSV trae todos.</p>' : '') : '<p class="hint">No hubo movimientos en este periodo.</p>');
    $('#r-out').innerHTML = h;
    repText = 'Reporte de historial de inventario\n' + label + ' · ' + period + ' · ' + repData.date + '\n\n' +
      'Movimientos: ' + mvs.length + ' · Agotados: ' + nOut + ' · Por agotarse: ' + nLow + (total > 0 ? ' · Valor: ' + money(total) : '') + '\n';
    if (pr.length) repText += '\nPRODUCCIÓN Y VENTAS POR SEMANA\n' + pr.map(function (r) { return '- ' + weekLabel(r.w) + ' · ' + r.name + ': fabricados ' + fmt(r.made) + ', vendidos ' + fmt(r.sold); }).join('\n') + '\n';
    groups.forEach(function (g) {
      repText += '\n' + g.name.toUpperCase() + ' (entró / salió / saldo)\n' + g.rows.map(function (r) { return '- ' + r.name + (r.sup ? ' [' + r.sup + ']' : '') + ' (' + storeName(r.store) + '): +' + fmt(r.inn) + ' / -' + fmt(r.out) + ' / saldo ' + (r.qty === null ? '—' : fmt(r.qty)) + (r.unit ? ' ' + r.unit : '') + (r.st && r.st !== 'ok' ? ' [' + LABEL[r.st] + ']' : '') + (r.pu ? ' · unidad ' + money(r.pu) : '') + (r.pd ? ' · docena ' + money(r.pd) : ''); }).join('\n') + '\n';
    });
    repCsv = '﻿' + ['Fecha', 'Tipo', 'Categoría', 'Tienda', 'Producto', 'Proveedor', 'Precio unidad', 'Precio docena', 'Cambio', 'Saldo', 'Usuario'].join(',') + '\n' +
      mvs.map(function (m) { var r = rows[m.item] || {}; return [new Date(m.ts).toLocaleString('es-MX'), TYPES[m.type] || 'Ajuste', CATS[repData.catOf(m)], storeName(m.store), m.name, r.sup || '', r.pu || '', r.pd || '', m.delta, m.qty, m.by || ''].map(csvCell).join(','); }).join('\n');
    $('#r-copy').disabled = false; $('#r-csv').disabled = !mvs.length; $('#r-pdf').disabled = false; $('#r-png').disabled = false;
  }

  $('#rep-quick').addEventListener('click', openReport);
  $('#r-go').addEventListener('click', function () { genReport(); });
  $('#r-copy').addEventListener('click', function () {
    if (!repText) return;
    try { navigator.clipboard.writeText(repText).then(function () { toast('Reporte copiado'); }, function () { toast('No se pudo copiar. Selecciona las tablas y cópialas.'); }); }
    catch (e) { toast('No se pudo copiar. Selecciona las tablas y cópialas.'); }
  });
  $('#r-csv').addEventListener('click', function () {
    if (!repCsv) return;
    saveFile('historial-inventario-' + today() + '.csv', new Blob([repCsv], { type: 'text/csv;charset=utf-8' }));
  });

  /* ---------- reporte en PDF e imagen (se dibuja en la propia pagina, sin librerias externas) ---------- */
  function paintReport(R) {
    var W = 1240, H = 1754, M = 64, CW = W - 2 * M, pages = [], cv, g, y;
    var FONT = '"IBM Plex Sans", Arial, Helvetica, sans-serif', INK = '#142033', MUTED = '#5B6878', LINE = '#DDE3EA';
    var COL = { out: '#B3261E', low: '#B26A00', ok: '#1E7B3A' };
    function newPage() { cv = document.createElement('canvas'); cv.width = W; cv.height = H; g = cv.getContext('2d'); g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, W, H); g.textBaseline = 'middle'; pages.push(cv); y = M; }
    function font(sz, w) { g.font = (w || 400) + ' ' + sz + 'px ' + FONT; }
    function fit(t, w) { t = String(t); if (g.measureText(t).width <= w) return t; while (t.length > 1 && g.measureText(t + '…').width > w) t = t.slice(0, -1); return t + '…'; }
    function room(h) { if (y + h > H - M - 20) newPage(); }
    function line(t, sz, w, col) { room(sz * 1.6); font(sz, w); g.fillStyle = col || INK; g.textAlign = 'left'; g.fillText(fit(t, CW), M, y + sz * 0.8); y += sz * 1.6; }
    function table(cols, rows) {
      var RH = 36, x0;
      function head() {
        room(RH * 2); g.fillStyle = '#EEF2F7'; g.fillRect(M, y, CW, RH); font(17, 600); g.fillStyle = MUTED; x0 = M;
        cols.forEach(function (c) { var cw = CW * c.w; g.textAlign = c.a === 'r' ? 'right' : 'left'; g.fillText(fit(c.h, cw - 16), c.a === 'r' ? x0 + cw - 8 : x0 + 8, y + RH / 2); x0 += cw; });
        y += RH;
      }
      head();
      rows.forEach(function (r, ri) {
        if (y + RH > H - M - 20) { newPage(); head(); }
        if (ri % 2) { g.fillStyle = '#F8FAFC'; g.fillRect(M, y, CW, RH); }
        g.fillStyle = LINE; g.fillRect(M, y + RH - 1, CW, 1);
        font(18, 400); x0 = M;
        cols.forEach(function (c, ci) {
          var v = r[ci], t = v && v.t !== undefined ? v.t : v, cw = CW * c.w;
          g.fillStyle = v && v.c ? v.c : INK; font(18, v && v.b ? 600 : 400); g.textAlign = c.a === 'r' ? 'right' : 'left';
          g.fillText(fit(t == null ? '' : t, cw - 16), c.a === 'r' ? x0 + cw - 8 : x0 + 8, y + RH / 2); x0 += cw;
        });
        y += RH;
      });
      y += 18;
    }
    newPage();
    font(40, 700); g.fillStyle = INK; g.textAlign = 'left'; g.fillText('Reporte de historial de inventario', M, y + 30); y += 62;
    font(21, 400); g.fillStyle = MUTED; g.fillText(fit(R.label + ' · ' + R.period + ' · ' + R.date, CW), M, y + 12); y += 44;
    var boxes = [[String(R.n), 'Productos', INK], [String(R.mv.length), 'Movimientos', INK], [String(R.nOut), 'Agotados ahora', COL.out], [String(R.nLow), 'Por agotarse', COL.low]];
    if (R.total > 0) boxes.push([money(R.total), 'Valor del inventario', INK]);
    var bw = (CW - 16 * (boxes.length - 1)) / boxes.length;
    boxes.forEach(function (b, i) {
      var bx = M + i * (bw + 16); g.fillStyle = '#F4F6F8'; g.fillRect(bx, y, bw, 96); g.fillStyle = b[2]; font(34, 700); g.textAlign = 'left'; g.fillText(fit(b[0], bw - 24), bx + 14, y + 36); font(17, 400); g.fillStyle = MUTED; g.fillText(fit(b[1], bw - 24), bx + 14, y + 74);
    });
    y += 96 + 30;
    if (!R.groups.length) line('Todavía no hay productos.', 20, 400, MUTED);
    var pc = [{ h: 'Producto', w: 0.23 }, { h: 'Proveedor', w: 0.13 }, { h: 'Entró', w: 0.07, a: 'r' }, { h: 'Salió', w: 0.07, a: 'r' }, { h: 'Saldo', w: 0.10, a: 'r' }, { h: 'P. unidad', w: 0.09, a: 'r' }, { h: 'P. docena', w: 0.08, a: 'r' }, { h: 'Valor', w: 0.10, a: 'r' }, { h: 'Estado', w: 0.13 }];
    R.groups.forEach(function (gp) {
      room(36 * 3 + 40);
      line(gp.name + '  ·  ' + gp.rows.length + (gp.rows.length === 1 ? ' producto' : ' productos') + (gp.val ? '  ·  ' + money(gp.val) : ''), 26, 700, INK);
      table(pc, gp.rows.map(function (r) {
        var sc = r.gone ? MUTED : COL[r.st];
        return [{ t: r.name, c: r.st && r.st !== 'ok' ? sc : INK, b: r.st && r.st !== 'ok' }, r.sup || '—', r.inn ? '+' + fmt(r.inn) : '—', r.out ? '-' + fmt(r.out) : '—', r.qty === null ? '—' : fmt(r.qty) + (r.unit ? ' ' + r.unit : ''), r.pu ? money(r.pu) : '—', r.pd ? money(r.pd) : '—', r.qty !== null && r.uc > 0 ? money(r.qty * r.uc) : '—', { t: r.gone ? 'Eliminado' : LABEL[r.st], c: sc, b: r.st !== 'ok' }];
      }));
    });
    if (R.prod.length) {
      var tm = 0, ts = 0;
      room(36 * 3 + 40); line('Producción y ventas por semana', 26, 700, INK);
      var prr = R.prod.map(function (r) { tm += r.made; ts += r.sold; return [weekLabel(r.w), r.name, { t: fmt(r.made), c: COL.ok, b: true }, { t: fmt(r.sold), c: COL.out, b: true }]; });
      prr.push([{ t: '', b: true }, { t: 'Total', b: true }, { t: fmt(tm), b: true }, { t: fmt(ts), b: true }]);
      table([{ h: 'Semana', w: 0.25 }, { h: 'Producto', w: 0.37 }, { h: 'Fabricados', w: 0.19, a: 'r' }, { h: 'Vendidos', w: 0.19, a: 'r' }], prr);
    }
    room(36 * 3 + 40);
    line('Movimientos del periodo', 26, 700, INK);
    if (!R.mv.length) line('No hubo movimientos en este periodo.', 20, 400, MUTED);
    else {
      var LIM = 300, mvr = R.mv.slice(0, LIM);
      table([{ h: 'Fecha', w: 0.15 }, { h: 'Tipo', w: 0.10 }, { h: 'Categoría', w: 0.13 }, { h: 'Producto', w: 0.22 }, { h: 'Tienda', w: 0.13 }, { h: 'Cambio', w: 0.08, a: 'r' }, { h: 'Saldo', w: 0.08, a: 'r' }, { h: 'Usuario', w: 0.11 }],
        mvr.map(function (m) { return [R.fdate(m.ts), TYPES[m.type] || 'Ajuste', CATS[R.catOf(m)], m.name, storeName(m.store), { t: R.sign(m.delta), c: m.delta > 0 ? COL.ok : COL.out, b: true }, fmt(m.qty), m.by || '']; }));
      if (R.mv.length > LIM) line('Se muestran ' + LIM + ' de ' + R.mv.length + ' movimientos. El archivo CSV trae todos.', 18, 400, MUTED);
    }
    pages.forEach(function (p, i) {
      var c = p.getContext('2d'); c.textBaseline = 'middle'; c.font = '400 16px ' + FONT; c.fillStyle = MUTED;
      c.textAlign = 'left'; c.fillText('Sistema CifraStock V1 · ' + R.date, M, H - 36); c.textAlign = 'right'; c.fillText('Página ' + (i + 1) + ' de ' + pages.length, W - M, H - 36);
    });
    return pages;
  }
  function pdfBlob(pages) {
    var enc = new TextEncoder(), parts = [], offs = [], len = 0, N = pages.length;
    function add(x) { var u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); len += u.length; }
    function obj(n, body) { offs[n] = len; add(n + ' 0 obj\n' + body + '\nendobj\n'); }
    add('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    var kids = []; for (var i = 0; i < N; i++) kids.push((3 + 3 * i) + ' 0 R');
    obj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + N + ' >>');
    pages.forEach(function (cv, i) {
      var b = atob(cv.toDataURL('image/jpeg', 0.92).split(',')[1]), jp = new Uint8Array(b.length);
      for (var k = 0; k < b.length; k++) jp[k] = b.charCodeAt(k);
      var pn = 3 + 3 * i, cn = pn + 1, im = pn + 2, c = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q';
      obj(pn, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ' + im + ' 0 R >> >> /Contents ' + cn + ' 0 R >>');
      obj(cn, '<< /Length ' + c.length + ' >>\nstream\n' + c + '\nendstream');
      offs[im] = len; add(im + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + cv.width + ' /Height ' + cv.height + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jp.length + ' >>\nstream\n'); add(jp); add('\nendstream\nendobj\n');
    });
    var total = 3 * N + 3, xr = len, x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (var n = 1; n < total; n++) x += ('0000000000' + offs[n]).slice(-10) + ' 00000 n \n';
    add(x + 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xr + '\n%%EOF');
    return new Blob(parts, { type: 'application/pdf' });
  }
  function saveFile(name, data) {
    try {
      var blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast('Archivo listo');
    } catch (e) { toast('No se pudo descargar el archivo.'); }
    return Promise.resolve();
  }
  function exportReport(kind) {
    if (!repData) return;
    var btn = $(kind === 'pdf' ? '#r-pdf' : '#r-png'); btn.disabled = true; $('#r-msg').textContent = 'Preparando archivo…';
    var wait = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    wait.then(function () {
      var pages = paintReport(repData);
      if (kind === 'pdf') return saveFile('historial-inventario-' + today() + '.pdf', pdfBlob(pages));
      if (pages.length > 14) { toast('El reporte es muy largo para una sola imagen (' + pages.length + ' páginas). Usa «Descargar PDF» o elige un periodo o categoría más corta.'); return; }
      var out = document.createElement('canvas'); out.width = pages[0].width; out.height = pages[0].height * pages.length;
      var o = out.getContext('2d'); pages.forEach(function (p, i) { o.drawImage(p, 0, i * p.height); });
      return new Promise(function (res) { out.toBlob(res, 'image/png'); }).then(function (blob) { if (!blob) { toast('No se pudo crear la imagen.'); return; } return saveFile('historial-inventario-' + today() + '.png', blob); });
    }).catch(function () { toast('No se pudo crear el archivo.'); }).then(function () { btn.disabled = false; $('#r-msg').textContent = ''; });
  }
  $('#r-pdf').addEventListener('click', function () { exportReport('pdf'); });
  $('#r-png').addEventListener('click', function () { exportReport('png'); });

  /* ---------- produccion, compras y recetas (todo conectado al inventario) ---------- */
  var prodDocs = [], curTab = 'inv', opsSig = {};
  var TYPES = { prod: 'Producción', cons: 'Consumo', venta: 'Venta', compra: 'Compra', abrir: 'Bulto abierto', aj: 'Ajuste' };
  function pad2(n) { return ('0' + n).slice(-2); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseYmd(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function weekStart(s) { var d = parseYmd(s), k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return ymd(d); }
  function dshort(d) { return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }); }
  function weekLabel(w) { var a = parseYmd(w), b = new Date(a); b.setDate(b.getDate() + 6); return dshort(a) + ' – ' + dshort(b); }
  function monthLabel(m) { var p = m.split('-'); return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function itemById(id) { return vItems().find(function (x) { return x.id === id; }); }
  function recipeCost(it) { var c = 0; (it.recipe || []).forEach(function (r) { var g = itemById(r.id); if (g) c += r.q * unitCost(g); }); return c; }
  function lock(id, fn) { var p = (chain[id] || Promise.resolve()).then(fn); chain[id] = p.catch(function () {}); return p; }
  function applyDelta(id, delta, type, ref, extra) {
    return lock(id, function () {
      return db.doc('items/' + id).get().then(function (snap) {
        if (!snap.exists) throw { code: 'gone' };
        var v = snap.data(), it = { id: id, name: String(v.name || ''), store: v.store, cat: CATS[v.cat] ? v.cat : 'otro', qty: +v.qty || 0, min: +v.min || 0, usage: Array.isArray(v.usage) ? v.usage : [] };
        var q = Math.max(0, r2(it.qty + delta)), real = r2(q - it.qty);
        var up = { qty: q, alerted: q > it.min ? false : !!v.alerted, updatedAt: Date.now() };
        if (real < 0) up.usage = bumpUsage(it, -real);
        if (extra && extra.item) Object.keys(extra.item).forEach(function (k) { up[k] = extra.item[k]; });
        return db.doc('items/' + id).update(up).then(function () { return logMove(it, real, q, type, ref, extra && extra.mv); }).then(function () { return q; });
      });
    });
  }
  // Mueve bultos cerrados y kg del bulto abierto en un solo paso (lee el valor actual de la base para no pisar a otro usuario).
  // plan: lista de pasos { dClosed, dOpen, type, ref, mv, item } o función (estado, kgPorBulto) que la devuelve. Cada paso queda en el historial.
  function bulkTx(id, plan) {
    return lock(id, function () {
      return db.doc('items/' + id).get().then(function (snap) {
        if (!snap.exists) throw { code: 'gone' };
        var v = snap.data(), bag = +v.bag || 0, st = bulkState(v);
        var it = { id: id, name: String(v.name || ''), store: v.store, cat: CATS[v.cat] ? v.cat : 'otro', qty: +v.qty || 0, min: +v.min || 0, usage: Array.isArray(v.usage) ? v.usage : [] };
        var steps = (typeof plan === 'function' ? plan(st, bag) : plan).filter(Boolean);
        var c = st.closed, o = st.open, q0 = r2(c * bag + o), logs = [], up = {};
        steps.forEach(function (s) {
          c += s.dClosed || 0; o = r2(o + (s.dOpen || 0));
          if (c < 0 || c !== Math.floor(c) || o < 0) throw { code: 'short' };
          var q = r2(c * bag + o); logs.push({ s: s, delta: r2(q - q0), q: q, c: c, o: o }); q0 = q;
          if (s.item) Object.keys(s.item).forEach(function (k) { up[k] = s.item[k]; });
        });
        var qf = r2(c * bag + o), used = r2(it.qty - qf);
        Object.assign(up, { closed: c, open: o, qty: qf, alerted: qf > it.min ? false : !!v.alerted, updatedAt: Date.now() });
        if (used > 0) up.usage = bumpUsage(it, used);
        return db.doc('items/' + id).update(up).then(function () {
          var p = Promise.resolve();
          logs.forEach(function (l) { p = p.then(function () { return logMove(it, l.delta, l.q, l.s.type, l.s.ref, Object.assign({ closedAfter: l.c, openAfter: l.o }, l.s.mv || {})); }); });
          return p;
        }).then(function () { return { qty: qf, closed: c, open: o }; });
      });
    });
  }
  function canEdit(item) { return !!item && !!me && (isAdmin() || item.store === me.store); }
  // ajuste manual desde el inventario (conteo físico)
  function setBulk(id, closed, open) {
    var item = items.find(function (x) { return x.id === id; }); if (!canEdit(item)) return;
    if (!(closed >= 0) || closed !== Math.floor(closed) || !(open >= 0) || closed > 1e6 || open > 1e7) { toast('Los bultos cerrados van en números enteros y los kg no pueden ser negativos.'); renderList(); return; }
    bulkTx(id, function (st) { return (st.closed === closed && Math.abs(st.open - open) < 1e-9) ? [] : [{ dClosed: closed - st.closed, dOpen: r2(open - st.open), type: 'aj', ref: 'Ajuste de inventario' }]; })
      .catch(function (e) { fail(e); renderList(); });
  }
  // pasa un bulto de «cerrados» al bulto abierto (se suma a lo que quede abierto)
  function openBag(id) {
    var item = items.find(function (x) { return x.id === id; }); if (!canEdit(item)) return;
    bulkTx(id, function (st, bag) { return [{ dClosed: -1, dOpen: bag, type: 'abrir', ref: 'Bulto abierto a mano' }]; })
      .then(function (r) { toast('Bulto abierto: ahora hay ' + fmt(r.open) + ' kg en el abierto y ' + fmt(r.closed) + ' cerrados.'); }).catch(fail);
  }
  // cambiar los kg por bulto recalcula el total en kg con los mismos bultos cerrados y abierto
  function setBag(id, bag) {
    var item = items.find(function (x) { return x.id === id; }); if (!isAdmin() || !item) return;
    if (!(bag > 0) || bag > 1e4) { toast('Escribe cuántos kg trae cada bulto.'); renderList(); return; }
    var st = bulkState(item);
    queue(id, function () { return db.doc('items/' + id).update({ bag: bag, closed: st.closed, open: st.open, qty: r2(st.closed * bag + st.open), updatedAt: Date.now() }); });
  }
  function recordProd(item, day, made, sold) {
    var month = day.slice(0, 7), pid = 'p_' + item.id + '_' + month, w = weekStart(day);
    return lock('prod:' + pid, function () {
      return db.doc('prod/' + pid).get().then(function (s) {
        var d = s.exists ? s.data() : {}, weeks = Object.assign({}, d.weeks || {}), cur = weeks[w] || { made: 0, sold: 0 };
        weeks[w] = { made: r2((+cur.made || 0) + made), sold: r2((+cur.sold || 0) + sold) };
        return db.doc('prod/' + pid).set({ item: item.id, name: item.name, store: item.store, month: month, weeks: weeks, updatedAt: Date.now() });
      });
    });
  }
  function weekTotals(itemId) {
    var w = weekStart(today()), made = 0, sold = 0;
    prodDocs.forEach(function (d) { if (d.item === itemId && d.weeks && d.weeks[w]) { made += +d.weeks[w].made || 0; sold += +d.weeks[w].sold || 0; } });
    return { made: made, sold: sold };
  }
  function prodRows(sel, cf, sinceDate) {
    if (cf !== 'all' && cf !== 'pt') return [];
    var w0 = weekStart(ymd(sinceDate)), map = {};
    prodDocs.forEach(function (d) {
      if (!isAdmin() && d.store !== (me && me.store)) return;
      if (sel !== 'all' && d.store !== sel) return;
      Object.keys(d.weeks || {}).forEach(function (w) {
        if (w < w0) return;
        var k = w + '|' + d.item, r = map[k] = map[k] || { w: w, name: d.name, made: 0, sold: 0 };
        r.made += +d.weeks[w].made || 0; r.sold += +d.weeks[w].sold || 0;
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.w < b.w ? -1 : a.w > b.w ? 1 : a.name.localeCompare(b.name, 'es'); });
  }

  /* pestañas */
  function setTab(t) {
    if (!isAdmin() && (t === 'adm' || t === 'me')) t = 'inv';
    curTab = t;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (el) { el.hidden = el.dataset.tab !== t; });
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === t)); });
    renderOps();
  }
  $('#tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b && b.dataset.tab) { setTab(b.dataset.tab); window.scrollTo(0, 0); } });

  function fillSelect(sel, list, label, keep) {
    var el = $(sel); if (!el) return;
    var sig = list.map(function (x) { return x.id + ':' + label(x); }).join('|');
    if (opsSig[sel] === sig) return;
    opsSig[sel] = sig;
    var cur = el.value;
    el.innerHTML = list.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(label(x)) + '</option>'; }).join('');
    if (cur && list.some(function (x) { return x.id === cur; })) el.value = cur;
  }
  function byName(a, b) { return a.name.localeCompare(b.name, 'es'); }
  function renderOps() {
    if (!me || !ready.items) return;
    var all = vItems().slice().sort(byName);
    var lab = function (x) { return x.name + ' · ' + storeName(x.store); };
    fillSelect('#s-item', all, lab); fillSelect('#by-item', all, lab);
    syncSaleModes(); syncBuyModes();
    if (curTab === 'buy') renderBuys();
    if (curTab === 'ven') { renderCart(); renderSales(); }
  }

  /* ---------- nota de venta: por bulto, a granel (kg) o por pieza ---------- */
  var cart = [];
  var MODES = { bulto: 'Bulto', granel: 'Granel (kg)', pieza: 'Pieza' };
  function modeUnit(m, n) { return m === 'bulto' ? (n === 1 ? 'bulto' : 'bultos') : m === 'granel' ? 'kg' : 'pzas'; }
  function modePrice(it, m) { return m === 'granel' ? (it.priceKg || 0) : (it.price || 0); }
  function syncSaleModes() {
    var it = itemById($('#s-item').value), sel = $('#s-mode'), want = it ? (isBulk(it) ? ['bulto', 'granel'] : ['pieza']) : [];
    var sig = (it ? it.id : '') + want.join();
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig; var cur = sel.value;
    sel.innerHTML = want.map(function (m) { return '<option value="' + m + '">' + MODES[m] + '</option>'; }).join('');
    if (want.indexOf(cur) !== -1) sel.value = cur;
    $('#s-price').value = it ? (modePrice(it, sel.value) || '') : '';
    renderSaleHint();
  }
  // Simula cómo quedaría un producto a granel tras los renglones de la nota (bulto sale de cerrados; granel del abierto, abriendo los que hagan falta)
  function simulate(it, lines) {
    var st = bulkState(it), c = st.closed, o = st.open, opened = 0;
    for (var k = 0; k < lines.length; k++) {
      var l = lines[k];
      if (l.mode === 'bulto') { c -= l.qty; if (c < 0) return { err: 'bultos cerrados' }; }
      else {
        if (o + 1e-9 < l.qty) { var need = Math.ceil(r2(l.qty - o) / it.bag); if (need > c) return { err: 'kg' }; c -= need; o = r2(o + need * it.bag); opened += need; }
        o = r2(o - l.qty);
      }
    }
    return { closed: c, open: o, opened: opened };
  }
  function renderSaleHint() {
    var it = itemById($('#s-item').value), m = $('#s-mode').value, q = num($('#s-qty').value), p = num($('#s-price').value);
    if (!it) { $('#s-hint').textContent = 'Primero agrega productos en Administración.'; return; }
    var t = 'Hay ' + qtyText(it).replace(/&[^;]+;/g, '');
    if (isBulk(it)) t += ' · bulto de ' + fmt(it.bag) + ' kg';
    if (q > 0 && p >= 0) t += ' · importe ' + money(q * p);
    if (isBulk(it) && m === 'granel' && q > 0) {
      var prev = cart.filter(function (l) { return l.id === it.id; }), before = simulate(it, prev), after = simulate(it, prev.concat([{ mode: 'granel', qty: q }]));
      if (!after.err && after.opened > (before.opened || 0)) { var n = after.opened - (before.opened || 0); t += ' · se abrirá' + (n === 1 ? ' 1 bulto' : 'n ' + n + ' bultos') + ' nuevo' + (n === 1 ? '' : 's'); }
    }
    $('#s-hint').textContent = t;
  }
  $('#s-item').addEventListener('change', function () { $('#s-mode').dataset.sig = ''; syncSaleModes(); });
  $('#s-mode').addEventListener('change', function () { var it = itemById($('#s-item').value); $('#s-price').value = it ? (modePrice(it, $('#s-mode').value) || '') : ''; renderSaleHint(); });
  ['#s-qty', '#s-price'].forEach(function (s) { $(s).addEventListener('input', renderSaleHint); });
  $('#f-sale').addEventListener('submit', function (e) {
    e.preventDefault();
    var it = itemById($('#s-item').value), m = $('#s-mode').value, q = num($('#s-qty').value), p = num($('#s-price').value);
    if (!it) { toast('Elige el producto.'); return; }
    if (!isFinite(q) || q <= 0 || q > 1e6) { toast('Escribe la cantidad.'); return; }
    if (!isFinite(p) || p < 0 || p > 1e7) { toast('Escribe el precio.'); return; }
    if (m === 'bulto' && q !== Math.floor(q)) { toast('Por bulto se venden bultos completos. Para medio bulto usa «Granel (kg)».'); return; }
    var base = m === 'bulto' ? r2(q * it.bag) : q, prev = cart.filter(function (l) { return l.id === it.id; });
    var have = qtyText(it).replace(/&[^;]+;/g, '') + (prev.length ? ' y ya llevas parte en la nota' : '');
    if (isBulk(it)) {
      var sim = simulate(it, prev.concat([{ mode: m, qty: q }]));
      if (sim.err) { toast('No alcanza: hay ' + have + '.'); return; }
    } else if (prev.reduce(function (a, l) { return a + l.base; }, 0) + base > it.qty + 1e-9) { toast('No alcanza: hay ' + have + '.'); return; }
    cart.push({ id: it.id, name: it.name, mode: m, qty: q, base: base, pv: r2(p), total: r2(q * p) });
    $('#s-qty').value = ''; renderCart(); renderSaleHint(); $('#s-qty').focus();
  });
  function renderCart() {
    var el = $('#s-cart'), tot = cart.reduce(function (a, l) { return a + l.total; }, 0);
    el.innerHTML = cart.length ? '<div class="tablewrap"><table><thead><tr><th>Producto</th><th>Tipo</th><th>Cantidad</th><th>Precio</th><th>Importe</th><th></th></tr></thead><tbody>' + cart.map(function (l, i) {
      return '<tr><td>' + esc(l.name) + '</td><td>' + MODES[l.mode] + '</td><td>' + fmt(l.qty) + ' ' + modeUnit(l.mode, l.qty) + '</td><td>' + money(l.pv) + '</td><td>' + money(l.total) + '</td><td><button class="ghost" type="button" data-cdel="' + i + '">Quitar</button></td></tr>';
    }).join('') + '</tbody><tfoot><tr><td colspan="4">Total de la nota</td><td>' + money(tot) + '</td><td></td></tr></tfoot></table></div>' : '<p class="hint">La nota está vacía. Agrega productos arriba.</p>';
    $('#s-go').disabled = !cart.length;
    $('#s-total').textContent = cart.length ? money(tot) : '';
  }
  $('#s-cart').addEventListener('click', function (e) { var i = e.target.dataset && e.target.dataset.cdel; if (i == null) return; cart.splice(+i, 1); renderCart(); });
  $('#s-clear').addEventListener('click', function () { cart = []; renderCart(); });
  $('#s-go').addEventListener('click', function () {
    if (!db || !me || !cart.length) return;
    var client = $('#s-client').value.trim().slice(0, 60), folio = 'N' + Date.now().toString(36).toUpperCase().slice(-6), lines = cart.slice(), tot = 0;
    $('#s-go').disabled = true; $('#s-msg').textContent = 'Registrando…';
    var p = Promise.resolve(), done = 0;
    lines.forEach(function (l) {
      p = p.then(function () {
        var ref = 'Nota ' + folio + (client ? ' · ' + client : ''), mv = { pv: l.pv, total: l.total, mode: l.mode, units: l.qty, sale: folio, client: client };
        var run = l.mode === 'bulto' ? bulkTx(l.id, [{ dClosed: -l.qty, type: 'venta', ref: ref, mv: mv }])
          // a granel sale del bulto abierto; si no alcanza, primero se abren los bultos necesarios y queda anotado
          : l.mode === 'granel' ? bulkTx(l.id, function (st, bag) {
            var need = st.open + 1e-9 < l.qty ? Math.ceil(r2(l.qty - st.open) / bag) : 0;
            return [need ? { dClosed: -need, dOpen: need * bag, type: 'abrir', ref: 'Abierto para venta a granel · Nota ' + folio } : null, { dOpen: -l.qty, type: 'venta', ref: ref, mv: mv }];
          })
          : applyDelta(l.id, -l.base, 'venta', ref, { mv: mv });
        return run.then(function () { done++; tot += l.total; });
      });
    });
    p.then(function () {
      cart = []; $('#s-client').value = ''; $('#s-msg').textContent = '';
      toast('Venta registrada · Nota ' + folio + ' · ' + money(tot));
    }).catch(function (err) {
      cart = lines.slice(done); $('#s-msg').textContent = done ? 'Se registraron ' + done + ' renglones; los que quedan siguen en la nota.' : '';
      if (err && err.code === 'gone') toast('Un producto de la nota fue eliminado.'); else fail(err);
    }).then(function () { renderCart(); renderOps(); });
  });

  /* ---------- compras: por bulto, por kg o por pieza ---------- */
  function syncBuyModes() {
    var it = itemById($('#by-item').value), sel = $('#by-mode'), want = it ? (isBulk(it) ? ['bulto', 'granel'] : ['pieza']) : [];
    var sig = (it ? it.id : '') + want.join();
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    sel.innerHTML = want.map(function (m) { return '<option value="' + m + '">' + (m === 'bulto' ? 'Bultos' : m === 'granel' ? 'Kilos' : 'Piezas') + '</option>'; }).join('');
    if (it) { $('#by-sup').value = it.supplier || ''; $('#by-cost').value = it.cost || ''; }
    $('#by-cost-l').firstChild.textContent = it && isBulk(it) ? 'Costo por bulto (opcional)' : 'Costo por pieza (opcional)';
  }
  $('#by-item').addEventListener('change', function () { $('#by-mode').dataset.sig = ''; syncBuyModes(); });
  $('#f-buy').addEventListener('submit', function (e) {
    e.preventDefault(); if (!db || !me) return;
    var item = itemById($('#by-item').value), m = $('#by-mode').value, q = num($('#by-qty').value), pu = num($('#by-cost').value), sup = $('#by-sup').value.trim().slice(0, 60), doc = $('#by-doc').value.trim().slice(0, 40);
    if (!item) { toast('Elige el producto que compraste.'); return; }
    if (!isFinite(q) || q <= 0) { toast('Escribe la cantidad comprada.'); return; }
    if (q > 1e6 || (isFinite(pu) && pu > 1e7)) { toast('La cantidad o el precio es demasiado grande.'); return; }
    if (m === 'bulto' && q !== Math.floor(q)) { toast('Los bultos van en números enteros. Si llegaron kilos sueltos, elige «Kilos».'); return; }
    var base = m === 'bulto' ? r2(q * item.bag) : q;
    var up = {}; if (isFinite(pu) && pu > 0) up.cost = pu; if (sup) up.supplier = sup;
    var perBase = up.cost ? (isBulk(item) ? up.cost / item.bag : up.cost) : 0;
    var ref = doc ? 'Doc. ' + doc : '', mv = { pu: up.cost || 0, sup: sup || item.supplier || '', doc: doc, mode: m, units: q, total: r2(base * perBase) };
    $('#by-go').disabled = true;
    // bultos comprados entran como cerrados; kilos sueltos se suman al bulto abierto
    var run = !isBulk(item) ? applyDelta(item.id, base, 'compra', ref, { item: up, mv: mv })
      : bulkTx(item.id, [m === 'bulto' ? { dClosed: q, type: 'compra', ref: ref, mv: mv, item: up } : { dOpen: q, type: 'compra', ref: ref, mv: mv, item: up }]);
    run.then(function (r) {
      var txt = isBulk(item) ? fmt(r.closed) + ' bultos cerrados + ' + fmt(r.open) + ' kg abierto' : qtyText(item, r).replace(/&[^;]+;/g, '');
      $('#by-qty').value = ''; $('#by-doc').value = ''; toast('Compra registrada: ' + item.name + ' ahora tiene ' + txt);
    }).catch(fail).then(function () { $('#by-go').disabled = false; renderOps(); });
  });
  function renderBuys() {
    var rows = moves.filter(function (m) { return m.type === 'compra' && (isAdmin() || m.store === (me && me.store)); }).slice(0, 25);
    $('#by-out').innerHTML = rows.length ? '<div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Producto</th><th>Cantidad</th><th>Costo</th><th>Total</th><th>Proveedor</th><th>Documento</th><th>Usuario</th></tr></thead><tbody>' + rows.map(function (m) {
      var it = items.find(function (x) { return x.id === m.item; }), cant = m.units ? fmt(m.units) + ' ' + modeUnit(m.mode, m.units) : '+' + fmt(m.delta);
      return '<tr><td>' + new Date(m.ts).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</td><td>' + esc(m.name) + '</td><td class="pos">' + cant + '</td><td>' + (m.pu ? money(m.pu) + (it && isBulk(it) ? '/bulto' : '') : '—') + '</td><td>' + (m.total ? money(m.total) : '—') + '</td><td>' + esc(m.sup || '—') + '</td><td>' + esc(m.doc || '—') + '</td><td>' + esc(m.by || '') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="hint">Aquí verás las compras que registres. Cada compra suma al inventario.</p>';
  }

  /* ---------- ventas, metas y gráficas ---------- */
  var salesDocs = [], buyDocs = [], goals = {};
  function ymOf(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function ymAdd(ym, k) { var p = ym.split('-'), d = new Date(+p[0], +p[1] - 1 + k, 1); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function daysIn(ym) { var p = ym.split('-'); return new Date(+p[0], +p[1], 0).getDate(); }
  function monthShort(ym) { var p = ym.split('-'); return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('es-MX', { month: 'short' }).replace('.', ''); }
  // Importe de una venta: el guardado; si es una venta antigua sin precio, usa el precio de venta actual del producto
  function saleAmount(m) {
    if (+m.total > 0) return +m.total;
    var it = items.find(function (x) { return x.id === m.item; }), p = +m.pv || (it && it.price) || 0;
    return r2(Math.abs(+m.delta || 0) * p);
  }
  function niceMax(v) { if (!(v > 0)) return 1; var e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; }
  function shortMoney(n) { return n >= 1e6 ? '$' + fmt(r2(n / 1e6)) + 'M' : n >= 1e4 ? '$' + fmt(Math.round(n / 100) / 10) + 'k' : '$' + fmt(Math.round(n)); }

  // Gráfica SVG de una sola serie (línea o barras) con línea de meta opcional y tooltip al pasar el mouse
  function drawChart(el, o) {
    var W = Math.max(280, el.clientWidth || 600), H = 220, L = 52, R = 14, T = 18, B = 26, n = o.values.length;
    var vals = o.values.filter(function (v) { return v != null; });
    var max = niceMax(Math.max(o.ref || 0, Math.max.apply(null, vals.concat([0]))) * 1.08);
    var pw = W - L - R, ph = H - T - B, band = pw / Math.max(1, n);
    function x(i) { return o.kind === 'bar' ? L + i * band + band / 2 : L + (n <= 1 ? pw / 2 : i * pw / (n - 1)); }
    function y(v) { return T + ph * (1 - v / max); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.title || '') + '">';
    for (var g = 0; g <= 4; g++) { var gv = max * g / 4, gy = y(gv); s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '"/><text class="axis" x="' + (L - 6) + '" y="' + (gy + 4) + '" text-anchor="end">' + (o.yfmt || shortMoney)(gv) + '</text>'; }
    var every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 46))));
    o.labels.forEach(function (lb, i) { if (i % every === 0 || i === n - 1) s += '<text class="axis" x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(lb) + '</text>'; });
    if (o.kind === 'bar') {
      var bw = Math.min(48, band * 0.62);
      o.values.forEach(function (v, i) {
        if (!(v > 0)) return;
        var x0 = x(i) - bw / 2, y0 = y(v), h = y(0) - y0, r = Math.min(4, h, bw / 2);
        s += '<path class="barm" d="M' + x0 + ',' + y(0) + 'V' + (y0 + r) + 'Q' + x0 + ',' + y0 + ' ' + (x0 + r) + ',' + y0 + 'H' + (x0 + bw - r) + 'Q' + (x0 + bw) + ',' + y0 + ' ' + (x0 + bw) + ',' + (y0 + r) + 'V' + y(0) + 'Z"/>';
      });
    } else {
      var pts = []; o.values.forEach(function (v, i) { if (v != null) pts.push([x(i), y(v)]); });
      if (pts.length) {
        s += '<path class="area" d="M' + pts[0][0] + ',' + y(0) + pts.map(function (p) { return 'L' + p[0] + ',' + p[1]; }).join('') + 'L' + pts[pts.length - 1][0] + ',' + y(0) + 'Z"/>';
        s += '<path class="ln" d="' + pts.map(function (p, k) { return (k ? 'L' : 'M') + p[0] + ',' + p[1]; }).join('') + '"/>';
        var lp = pts[pts.length - 1]; s += '<circle class="dot" r="5" cx="' + lp[0] + '" cy="' + lp[1] + '"/>';
      }
    }
    if (o.ref > 0) s += '<line class="goal" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(o.ref) + '" y2="' + y(o.ref) + '"/><text class="goaltxt" x="' + (W - R) + '" y="' + (y(o.ref) - 6) + '" text-anchor="end">' + esc(o.refLabel || 'Meta') + '</text>';
    s += '<line class="cross" id="cx" x1="0" x2="0" y1="' + T + '" y2="' + y(0) + '" visibility="hidden"/>';
    o.values.forEach(function (v, i) { var hx = o.kind === 'bar' ? L + i * band : x(i) - (n <= 1 ? pw / 2 : pw / (n - 1) / 2); s += '<rect class="hit" data-i="' + i + '" x="' + hx + '" y="' + T + '" width="' + (o.kind === 'bar' ? band : (n <= 1 ? pw : pw / (n - 1))) + '" height="' + ph + '"/>'; });
    s += '</svg><div class="tip" hidden></div>';
    el.innerHTML = s;
    var tip = el.querySelector('.tip'), cx = el.querySelector('#cx');
    el.onmousemove = function (e) {
      var t = e.target.closest('.hit'); if (!t) return;
      var i = +t.dataset.i, v = o.values[i]; if (v == null) { tip.hidden = true; cx.setAttribute('visibility', 'hidden'); return; }
      var sc = el.clientWidth / W;
      tip.innerHTML = o.tips[i]; tip.hidden = false; tip.style.left = Math.min(el.clientWidth - 70, Math.max(70, x(i) * sc)) + 'px'; tip.style.top = (y(v) * sc) + 'px';
      if (o.kind !== 'bar') { cx.setAttribute('x1', x(i)); cx.setAttribute('x2', x(i)); cx.setAttribute('visibility', 'visible'); }
    };
    el.onmouseleave = function () { tip.hidden = true; cx.setAttribute('visibility', 'hidden'); };
  }

  function renderSales() {
    if (!me) return;
    var cur = ymOf(Date.now()), ms = $('#v-month'), months = [];
    for (var k = 0; k < 12; k++) months.push(ymAdd(cur, -k));
    var sig = months.join('|');
    if (opsSig['#v-month'] !== sig) { opsSig['#v-month'] = sig; var c0 = ms.value; ms.innerHTML = months.map(function (m) { return '<option value="' + m + '">' + esc(monthLabel(m)) + '</option>'; }).join(''); ms.value = months.indexOf(c0) !== -1 ? c0 : cur; }
    var ym = ms.value || cur;
    var ss = $('#v-store'), stSig = stores.map(function (s) { return s.id + s.name; }).join('|');
    if (isAdmin() && opsSig['#v-store'] !== stSig) { opsSig['#v-store'] = stSig; var c1 = ss.value; ss.innerHTML = '<option value="all">Todas las tiendas</option>' + stores.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join(''); ss.value = c1 && (c1 === 'all' || stores.some(function (s) { return s.id === c1; })) ? c1 : 'all'; }
    var st = isAdmin() ? (ss.value || 'all') : me.store;
    var mine = salesDocs.filter(function (m) { return st === 'all' || m.store === st; });
    var inMonth = mine.filter(function (m) { return ymOf(m.ts) === ym; });
    var total = 0, units = 0; inMonth.forEach(function (m) { total += saleAmount(m); units += Math.abs(+m.delta || 0); });
    // comparación con el mes anterior a la misma fecha
    var isCur = ym === cur, dayNow = new Date().getDate(), prev = ymAdd(ym, -1), prevTotal = 0;
    mine.forEach(function (m) { if (ymOf(m.ts) === prev && (!isCur || new Date(m.ts).getDate() <= dayNow)) prevTotal += saleAmount(m); });
    var ch = prevTotal > 0 ? Math.round((total - prevTotal) / prevTotal * 100) : null;
    // bultos completos, kilos a granel y piezas por separado; notas = ventas distintas
    var bultos = 0, granel = 0, piezas = 0, notes = {}, todayAmt = 0, tday = today();
    inMonth.forEach(function (m) {
      var u = +m.units || Math.abs(+m.delta || 0);
      if (m.mode === 'bulto') bultos += u; else if (m.mode === 'granel') granel += u; else piezas += u;
      notes[m.sale || m.ts] = 1;
    });
    mine.forEach(function (m) { if (ymd(new Date(m.ts)) === tday) todayAmt += saleAmount(m); });
    $('#v-stats').innerHTML =
      '<div class="stat"><b style="font-size:24px">' + money(total) + '</b><span>Ventas de ' + esc(monthLabel(ym)) + '</span></div>' +
      (isCur ? '<div class="stat"><b style="font-size:24px">' + money(todayAmt) + '</b><span>Vendido hoy</span></div>' : '') +
      '<div class="stat"><b>' + Object.keys(notes).length + '</b><span>Notas de venta</span></div>' +
      '<div class="stat"><b style="font-size:20px">' + fmt(bultos) + ' <small>bultos</small></b><span>' + fmt(granel) + ' kg a granel' + (piezas ? ' · ' + fmt(piezas) + ' piezas' : '') + '</span></div>' +
      '<div class="stat"><b style="font-size:24px">' + (ch === null ? '—' : (ch >= 0 ? '▲ ' : '▼ ') + Math.abs(ch) + '%') + '</b><span>vs. ' + esc(monthLabel(prev)) + (isCur ? ' a la misma fecha' : '') + '</span></div>';

    // meta del mes (la define el administrador; aplica a todas las tiendas)
    var goal = +goals[ym] || 0, gEl = $('#v-goal');
    if (!isAdmin()) { gEl.hidden = true; }
    else {
      gEl.hidden = false;
      // la meta se compara con las ventas de todas las tiendas
      var allTotal = salesDocs.filter(function (m) { return ymOf(m.ts) === ym; }).reduce(function (a, m) { return a + saleAmount(m); }, 0);
      var allPct = goal > 0 ? Math.round(allTotal / goal * 100) : 0, done = goal > 0 && allTotal >= goal, left = Math.max(0, goal - allTotal), daysLeft = isCur ? daysIn(ym) - dayNow + 1 : 0;
      var gh = '<h2>Meta de ventas · ' + esc(monthLabel(ym)) + '</h2>';
      if (goal > 0) {
        gh += '<div class="goalrow"><span><b>' + money(allTotal) + '</b> <span class="hint">de ' + money(goal) + '</span></span><span class="pill ' + (done ? 'ok' : 'low') + '">' + (done ? '✓ Meta cumplida' : allPct + '% de la meta') + '</span></div>';
        gh += '<div class="progress' + (done ? ' done' : '') + '" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.min(100, allPct) + '"><div style="width:' + Math.min(100, allPct) + '%"></div></div>';
        gh += '<p class="hint">' + (done ? '¡Llegaste a la meta! Llevas ' + money(allTotal - goal) + ' por encima.' : 'Faltan ' + money(left) + (daysLeft > 0 ? ' · necesitas vender unos ' + money(left / daysLeft) + ' por día en los ' + daysLeft + ' días que quedan' : '') + '.') + (st !== 'all' ? ' La meta es de todas las tiendas juntas.' : '') + '</p>';
      } else gh += '<p class="hint">Todavía no hay meta para este mes. Escribe cuánto quieres vender y verás aquí cómo vas avanzando.</p>';
      gh += '<form id="f-goal" class="bar"><label class="f" style="flex:0 1 220px">Meta del mes ($)<input type="number" id="g-amount" min="0" step="any" value="' + (goal || '') + '"></label><button class="btn" type="submit" style="align-self:flex-end">Guardar meta</button></form>';
      if (!(document.activeElement && document.activeElement.id === 'g-amount')) gEl.innerHTML = gh;
    }

    // acumulado por día
    var nd = daysIn(ym), daily = []; for (var d = 0; d < nd; d++) daily.push(0);
    inMonth.forEach(function (m) { daily[new Date(m.ts).getDate() - 1] += saleAmount(m); });
    var cum = [], acc = 0, lastDay = isCur ? dayNow : nd;
    daily.forEach(function (v, i) { acc += v; cum.push(i < lastDay ? r2(acc) : null); });
    $('#v-cum-hint').textContent = goal > 0 && st === 'all' ? 'La línea punteada es la meta del mes.' : 'Suma de lo vendido día a día.';
    if (!inMonth.length) $('#v-cum').innerHTML = '<p class="hint">Todavía no hay ventas en ' + esc(monthLabel(ym)) + '. Regístralas en la pestaña Producción.</p>';
    else drawChart($('#v-cum'), { kind: 'line', title: 'Ventas acumuladas', labels: daily.map(function (v, i) { return String(i + 1); }), values: cum, ref: st === 'all' ? goal : 0, refLabel: 'Meta ' + shortMoney(goal),
      tips: cum.map(function (v, i) { return (i + 1) + ' ' + esc(monthShort(ym)) + ' · acumulado <b>' + money(v || 0) + '</b><br>ese día ' + money(daily[i]); }) });

    // por mes (6 meses)
    var m6 = []; for (var j = 5; j >= 0; j--) m6.push(ymAdd(ym, -j));
    var mt = m6.map(function (mm) { return r2(mine.filter(function (m) { return ymOf(m.ts) === mm; }).reduce(function (a, m) { return a + saleAmount(m); }, 0)); });
    if (!mt.some(function (v) { return v > 0; })) $('#v-months').innerHTML = '<p class="hint">Sin ventas en los últimos 6 meses.</p>';
    else drawChart($('#v-months'), { kind: 'bar', title: 'Ventas por mes', labels: m6.map(monthShort), values: mt,
      tips: mt.map(function (v, i) { var gg = +goals[m6[i]] || 0; return esc(monthLabel(m6[i])) + ' · <b>' + money(v) + '</b>' + (gg && st === 'all' ? '<br>meta ' + money(gg) + ' (' + Math.round(v / gg * 100) + '%)' : ''); }) });

    // por producto
    var byP = {}; inMonth.forEach(function (m) { var r = byP[m.item] = byP[m.item] || { name: m.name, amt: 0, u: 0, item: items.find(function (x) { return x.id === m.item; }) }; r.amt += saleAmount(m); r.u += Math.abs(+m.delta || 0); });
    var pl = Object.keys(byP).map(function (k) { return byP[k]; }).sort(function (a, b) { return b.amt - a.amt || b.u - a.u; }), pmax = pl.length ? Math.max(pl[0].amt, 1) : 1;
    $('#v-prods').innerHTML = pl.length ? '<div class="hbar">' + pl.slice(0, 12).map(function (r) { return '<span title="' + esc(r.name) + '">' + esc(r.name) + '</span><div class="trk"><div style="width:' + (r.amt / pmax * 100) + '%"></div></div><span class="v">' + money(r.amt) + ' · ' + (r.item ? qtyText(r.item, r.u) : fmt(r.u)) + '</span>'; }).join('') + '</div>' : '<p class="hint">Sin ventas este mes.</p>';

    // precio de compra de un insumo
    if (isAdmin()) {
      var withPrice = {}; buyDocs.forEach(function (m) { if (+m.pu > 0) withPrice[m.item] = m.name; });
      var opts = Object.keys(withPrice).map(function (k) { return { id: k, name: withPrice[k] }; }).sort(byName);
      fillSelect('#v-ins', opts, function (x) { return x.name; });
      var ins = $('#v-ins').value, pts = buyDocs.filter(function (m) { return m.item === ins && +m.pu > 0; });
      if (!pts.length) $('#v-price').innerHTML = '<p class="hint">Cuando registres compras con precio, aquí verás cómo cambia el precio de cada insumo.</p>';
      else drawChart($('#v-price'), { kind: 'line', title: 'Precio de compra', labels: pts.map(function (m) { return new Date(m.ts).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }); }), values: pts.map(function (m) { return +m.pu; }),
        yfmt: function (v) { return '$' + fmt(r2(v)); }, tips: pts.map(function (m) { return esc(new Date(m.ts).toLocaleDateString('es-MX')) + ' · <b>' + money(+m.pu) + '</b> por unidad' + (m.sup ? '<br>' + esc(m.sup) : ''); }) });
    }

    // últimas ventas
    var last = inMonth.slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 20);
    $('#v-list').innerHTML = last.length ? '<div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Nota</th><th>Producto</th><th>Tipo</th><th>Cantidad</th><th>Precio</th><th>Importe</th><th>Cliente</th><th>Tienda</th><th>Usuario</th></tr></thead><tbody>' + last.map(function (m) {
      var u = +m.units || Math.abs(+m.delta || 0), amt = saleAmount(m);
      return '<tr><td>' + new Date(m.ts).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</td><td>' + esc(m.sale || '—') + '</td><td>' + esc(m.name) + '</td><td>' + (MODES[m.mode] || '—') + '</td><td>' + fmt(u) + ' ' + (m.mode ? modeUnit(m.mode, u) : '') + '</td><td>' + (u ? money(+m.pv || amt / u) : '—') + '</td><td class="pos">' + money(amt) + '</td><td>' + esc(m.client || '—') + '</td><td>' + esc(storeName(m.store)) + '</td><td>' + esc(m.by || '') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="hint">Sin ventas este mes.</p>';
  }
  $('#v-month').addEventListener('change', renderSales);
  $('#v-store').addEventListener('change', renderSales);
  $('#v-ins').addEventListener('change', renderSales);
  $('#v-goal').addEventListener('submit', function (e) {
    if (e.target.id !== 'f-goal') return;
    e.preventDefault(); if (!isAdmin() || !db) return;
    var v = num($('#g-amount').value), ym = $('#v-month').value;
    if (!isFinite(v) || v < 0 || v > 1e12) { toast('Escribe una meta válida.'); return; }
    var months = Object.assign({}, goals); if (v > 0) months[ym] = r2(v); else delete months[ym];
    $('#g-amount').blur();
    db.doc('settings/goals').set({ months: months, updatedAt: Date.now() }).then(function () { toast(v > 0 ? 'Meta guardada' : 'Meta quitada'); }).catch(fail);
  });
  var resizeT = null;
  window.addEventListener('resize', function () { clearTimeout(resizeT); resizeT = setTimeout(function () { if (curTab === 'ven') renderSales(); }, 200); });

  /* ---------- respaldo y restauracion (solo administrador) ---------- */
  var BK_ID = /^[A-Za-z0-9_\-]{1,120}$/;
  function sstr(v, n) { return String(v == null ? '' : v).slice(0, n); }
  function snum(v, max) { v = +v; return isFinite(v) ? Math.max(-max, Math.min(max, v)) : 0; }
  var BK_CLEAN = {
    stores: function (d) { return { name: sstr(d.name, 60), createdAt: snum(d.createdAt, 1e15), example: !!d.example }; },
    items: function (d) {
      return { name: sstr(d.name, 80), store: sstr(d.store, 120), cat: CATS[d.cat] ? d.cat : 'otro', qty: Math.max(0, snum(d.qty, 1e9)), min: Math.max(0, snum(d.min, 1e9)), max: Math.max(0, snum(d.max, 1e9)), cost: Math.max(0, snum(d.cost, 1e9)), costDozen: Math.max(0, snum(d.costDozen, 1e9)), price: Math.max(0, snum(d.price, 1e9)), priceKg: Math.max(0, snum(d.priceKg, 1e9)), bag: Math.max(0, snum(d.bag, 1e6)), closed: d.closed == null ? null : Math.max(0, Math.floor(snum(d.closed, 1e9))), open: Math.max(0, snum(d.open, 1e9)), unit: sstr(d.unit, 16), supplier: sstr(d.supplier, 60), alerted: !!d.alerted, example: !!d.example, updatedAt: snum(d.updatedAt, 1e15),
        usage: (Array.isArray(d.usage) ? d.usage : []).slice(0, 40).map(function (u) { return { d: sstr(u && u.d, 10), n: Math.max(0, snum(u && u.n, 1e9)) }; }),
        recipe: (Array.isArray(d.recipe) ? d.recipe : []).slice(0, 60).filter(function (r) { return r && BK_ID.test(String(r.id)); }).map(function (r) { return { id: String(r.id), q: Math.max(0, snum(r.q, 1e9)) }; }) };
    },
    prod: function (d) {
      var w = {}; Object.keys(d.weeks && typeof d.weeks === 'object' ? d.weeks : {}).slice(0, 60).forEach(function (k) { if (/^\d{4}-\d{2}-\d{2}$/.test(k)) w[k] = { made: Math.max(0, snum(d.weeks[k].made, 1e9)), sold: Math.max(0, snum(d.weeks[k].sold, 1e9)) }; });
      return { item: sstr(d.item, 120), name: sstr(d.name, 80), store: sstr(d.store, 120), month: sstr(d.month, 7), weeks: w, updatedAt: snum(d.updatedAt, 1e15) };
    },
    movements: function (d) { return { item: sstr(d.item, 120), name: sstr(d.name, 80), store: sstr(d.store, 120), cat: CATS[d.cat] ? d.cat : 'otro', delta: snum(d.delta, 1e9), qty: Math.max(0, snum(d.qty, 1e9)), type: TYPES[d.type] ? d.type : 'aj', ref: sstr(d.ref, 80), by: sstr(d.by, 40), ts: snum(d.ts, 1e15), pu: Math.max(0, snum(d.pu, 1e9)), sup: sstr(d.sup, 60), doc: sstr(d.doc, 40), pv: Math.max(0, snum(d.pv, 1e9)), total: Math.max(0, snum(d.total, 1e12)), mode: ({ bulto: 1, granel: 1, pieza: 1 })[d.mode] ? d.mode : '', units: Math.max(0, snum(d.units, 1e9)), sale: sstr(d.sale, 20), client: sstr(d.client, 60) }; }
  };
  function readAll(name) { return db.collection(name).limit(1000).get().then(function (s) { return s.docs.map(function (x) { return { id: x.id, data: x.data() }; }); }); }
  $('#bk-dl').addEventListener('click', function () {
    if (!isAdmin() || !db) return;
    var btn = $('#bk-dl'); btn.disabled = true; $('#bk-msg').textContent = 'Preparando respaldo…';
    Promise.all(['stores', 'items', 'prod', 'movements'].map(readAll)).then(function (r) {
      var out = { v: 1, app: 'control-de-stock', at: new Date().toISOString(), stores: r[0], items: r[1], prod: r[2], movements: r[3] };
      return saveFile('respaldo-inventario-' + today() + '.json', JSON.stringify(out));
    }).catch(fail).then(function () { btn.disabled = false; $('#bk-msg').textContent = ''; });
  });
  $('#bk-go').addEventListener('click', function () {
    if (!isAdmin() || !db) return;
    var f = $('#bk-file').files[0], msg = $('#bk-msg');
    if (!f) { msg.textContent = 'Elige primero el archivo de respaldo.'; return; }
    if ($('#bk-word').value.trim().toUpperCase() !== 'RESTAURAR') { msg.textContent = 'Escribe RESTAURAR para confirmar.'; return; }
    if (f.size > 20 * 1024 * 1024) { msg.textContent = 'El archivo es demasiado grande.'; return; }
    var rd = new FileReader();
    rd.onerror = function () { msg.textContent = 'No pude leer el archivo.'; };
    rd.onload = function () {
      var data; try { data = JSON.parse(rd.result); } catch (e) { msg.textContent = 'El archivo no es un respaldo válido.'; return; }
      if (!data || data.v !== 1 || data.app !== 'control-de-stock') { msg.textContent = 'El archivo no es un respaldo de este sistema.'; return; }
      var jobs = [];
      ['stores', 'items', 'prod', 'movements'].forEach(function (c) {
        (Array.isArray(data[c]) ? data[c] : []).slice(0, 2000).forEach(function (x) { if (x && BK_ID.test(String(x.id)) && x.data && typeof x.data === 'object') jobs.push([c, String(x.id), BK_CLEAN[c](x.data)]); });
      });
      if (!jobs.length) { msg.textContent = 'El respaldo no trae datos.'; return; }
      $('#bk-go').disabled = true; var n = 0;
      (function next() {
        if (n >= jobs.length) { $('#bk-go').disabled = false; $('#bk-file').value = ''; $('#bk-word').value = ''; msg.textContent = 'Restaurados ' + n + ' registros.'; toast('Respaldo restaurado'); return; }
        msg.textContent = 'Restaurando ' + n + ' de ' + jobs.length + '…';
        var part = jobs.slice(n, n + 10);
        Promise.all(part.map(function (j) { return db.doc(j[0] + '/' + j[1]).set(j[2]); })).then(function () { n += part.length; next(); })
          .catch(function (e) { $('#bk-go').disabled = false; msg.textContent = 'Se detuvo después de ' + n + ' registros.'; fail(e); });
      })();
    };
    rd.readAsText(f);
  });

  /* ---------- seguridad: cierre por inactividad ---------- */
  var idleTimer = null, IDLE_MS = 20 * 60 * 1000;
  function bumpIdle() {
    if (!me) return; clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { if (me) logout('Cerramos tu sesión por inactividad. Entra de nuevo.'); }, IDLE_MS);
  }
  ['click', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, bumpIdle, { passive: true }); });

  /* ---------- reinicio protegido ---------- */
  var resetCfg = null, rsFails = 0;
  function renderReset() {
    if (!isAdmin()) return;
    $('#rs-setup').hidden = !!resetCfg; $('#rs-run').hidden = !resetCfg;
    var last = resetCfg && resetCfg.last;
    $('#rs-last').textContent = last ? 'Último reinicio: ' + new Date(last.at).toLocaleString('es-MX') + ' por ' + (last.by || '—') + ' (' + last.count + ' registros borrados).' : '';
  }
  function wipe(name) {
    var n = 0, guard = 0;
    function step() {
      if (++guard > 60) return Promise.resolve(n);
      return db.collection(name).limit(200).get().then(function (snap) {
        if (snap.empty) return n;
        var ids = snap.docs.map(function (d) { return d.id; }), i = 0;
        function chunk() {
          if (i >= ids.length) return Promise.resolve();
          var part = ids.slice(i, i + 10); i += 10;
          return Promise.all(part.map(function (id) { return db.doc(name + '/' + id).delete(); })).then(function () { n += part.length; return chunk(); });
        }
        return chunk().then(step);
      });
    }
    return step();
  }
  function doReset(scope) {
    return wipe('prod').then(function () { return wipe('items'); }).then(function (a) {
      return wipe('movements').then(function (b) {
        return (scope === 'all' ? wipe('stores') : Promise.resolve(0)).then(function (c) { return a + b + c; });
      });
    });
  }
  $('#f-rskey').addEventListener('submit', function (e) {
    e.preventDefault(); if (!isAdmin() || !db || resetCfg) return;
    var k = $('#rs-new').value;
    if (k.length < 8) { toast('La clave debe tener al menos 8 caracteres.'); return; }
    if (k !== $('#rs-new2').value) { toast('Las claves no coinciden.'); return; }
    var salt = newSalt();
    hashPass(k, salt).then(function (hash) { return db.doc('settings/reset').set({ salt: salt, hash: hash, updatedAt: Date.now() }); })
      .then(function () { $('#rs-new').value = ''; $('#rs-new2').value = ''; toast('Clave de reinicio guardada'); }).catch(fail);
  });
  $('#f-rschange').addEventListener('submit', function (e) {
    e.preventDefault(); if (!isAdmin() || !db || !resetCfg) return;
    var cur = $('#rs-cur').value, nk = $('#rs-chg').value;
    if (nk.length < 8) { toast('La clave nueva debe tener al menos 8 caracteres.'); return; }
    hashPass(cur, resetCfg.salt).then(function (h) {
      if (h !== resetCfg.hash) throw { code: 'badkey' };
      var salt = newSalt();
      return hashPass(nk, salt).then(function (hash) { return db.doc('settings/reset').update({ salt: salt, hash: hash, updatedAt: Date.now() }); });
    }).then(function () { $('#rs-cur').value = ''; $('#rs-chg').value = ''; toast('Clave de reinicio cambiada'); })
      .catch(function (x) { if (x && x.code === 'badkey') toast('La clave actual no es correcta.'); else fail(x); });
  });
  $('#f-reset').addEventListener('submit', function (e) {
    e.preventDefault(); if (!isAdmin() || !db || !resetCfg) return;
    var msg = $('#rs-msg'), word = $('#rs-word').value.trim(), key = $('#rs-key').value, scope = $('#rs-scope').value, wait = 0;
    if (word !== 'REINICIAR') { msg.textContent = 'Escribe REINICIAR en mayúsculas para confirmar.'; return; }
    $('#rs-go').disabled = true; msg.textContent = 'Verificando la clave…';
    hashPass(key, resetCfg.salt).then(function (h) {
      if (h !== resetCfg.hash) throw { code: 'badkey' };
      rsFails = 0; msg.textContent = 'Reiniciando…';
      return doReset(scope);
    }).then(function (count) {
      $('#rs-key').value = ''; $('#rs-word').value = ''; openId = null;
      msg.textContent = 'Listo. Se borraron ' + count + ' registros.'; toast('Sistema reiniciado');
      return db.doc('settings/reset').update({ last: { at: Date.now(), by: me.name, scope: scope, count: count } }).catch(function () {});
    }).catch(function (x) {
      if (x && x.code === 'badkey') { rsFails++; msg.textContent = 'La clave de reinicio no es correcta.'; wait = Math.min(rsFails, 10) * 1000; }
      else msg.textContent = 'No se pudo completar el reinicio. Revisa la conexión y vuelve a intentarlo.';
    }).then(function () { setTimeout(function () { $('#rs-go').disabled = false; }, wait); });
  });

  /* ---------- cuentas y acceso (Supabase Auth) ---------- */
  var fails = 0, bootMsg = 'Conectando…', setupMode = false, profSub = null, EMAIL = '@forrajera.app';
  function isAdmin() { return !!me && me.role === 'admin'; }
  function vItems() { return (!me || isAdmin()) ? items : items.filter(function (i) { return i.store === me.store; }); }
  function vStores() { return (!me || isAdmin()) ? stores : stores.filter(function (s) { return s.id === me.store; }); }
  function toHex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function newSalt() { var a = new Uint8Array(16); crypto.getRandomValues(a); return toHex(a); }
  function hashPass(pass, salt) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 150000 }, k, 256);
    }).then(toHex);
  }
  function toAcc(p) { return { id: p.id, user: p.username, name: p.name, role: p.role, store: p.store || '' }; }
  function rpcMsg(e) { return String((e && e.message) || ''); }
  function applyRole() {
    document.body.classList.toggle('role-staff', !isAdmin());
    $('#whoami').textContent = me.name + ' · ' + (isAdmin() ? 'Administrador' : 'Encargado de ' + storeName(me.store));
    if (!isAdmin()) filterStore = me.store;
  }
  function showApp() { $('#login').hidden = true; $('#app').hidden = false; dirty = false; applyRole(); setTab('inv'); bumpIdle(); render(); if (location.hash === '#reporte') setTimeout(openReport, 300); renderReset(); }
  function stopData() {
    if (db) { db.close(); db = null; }
    if (profSub && sb) { sb.removeChannel(profSub); profSub = null; }
    stores = []; items = []; moves = []; prodDocs = []; settings = {}; accounts = []; resetCfg = null; salesDocs = []; buyDocs = []; goals = {};
    ready.stores = false; ready.items = false;
  }
  function logout(msg) {
    me = null; stopData(); clearTimeout(idleTimer);
    if (sb) sb.auth.signOut().catch(function () {});
    $('#app').hidden = true; $('#login').hidden = false; hideMfa();
    document.body.classList.remove('role-staff'); filterStore = 'all';
    $('#l-pass').value = ''; $('#l-pass2').value = '';
    refreshSetup(); $('#l-err').textContent = msg || '';
  }
  function refreshSetup() {
    if (!sb) return;
    sb.rpc('forr_setup_needed').then(function (r) {
      if (r.error) throw r.error;
      setupMode = r.data === true; ready.accounts = true; renderLogin();
    }).catch(function () {
      ready.accounts = false; bootMsg = 'No se pudo conectar con la base de datos. Reintentando…'; renderLogin();
      setTimeout(refreshSetup, 5000);
    });
  }
  // Entra al sistema con la sesión de Supabase ya iniciada
  function enter(user) {
    return sb.from('forr_profiles').select('id,username,name,role,store').eq('id', user.id).maybeSingle().then(function (r) {
      if (r.error) throw r.error;
      if (!r.data) throw { code: 'noprofile' };
      stopData(); me = toAcc(r.data); accounts = [me];
      start(CSDB.create(sb)); watchProfiles(); loadAccounts();
      showApp();
    });
  }

  /* ---------- segundo paso: código del autenticador (TOTP) ---------- */
  var mfaFactor = null, mfaFails = 0;
  function hideMfa() { mfaFactor = null; $('#f-mfa').hidden = true; $('#f-login').hidden = false; $('#m-code').value = ''; $('#m-err').textContent = ''; $('#m-setup').hidden = true; $('#m-qr').removeAttribute('src'); $('#m-secret').textContent = ''; }
  function showMfa(factorId, totp) {
    mfaFactor = factorId;
    $('#f-login').hidden = true; $('#f-mfa').hidden = false; $('#m-err').textContent = ''; $('#m-code').value = '';
    $('#m-setup').hidden = !totp;
    if (totp) { $('#m-qr').src = totp.qr_code; $('#m-secret').textContent = totp.secret; }
    $('#m-hint').textContent = totp ? 'Después escribe aquí el código de 6 dígitos que te muestra la app.' : 'Abre tu app autenticadora y escribe el código de 6 dígitos de Forrajera.';
    $('#m-code').focus();
  }
  // Tras la contraseña: si ya verificó el código entra; si tiene autenticador lo pide; si no, lo registra
  function afterPassword(user) {
    return sb.auth.mfa.getAuthenticatorAssuranceLevel().then(function (r) {
      if (r.error) throw r.error;
      if (r.data.currentLevel === 'aal2') return enter(user);
      return sb.auth.mfa.listFactors().then(function (f) {
        if (f.error) throw f.error;
        var ok = f.data.totp || [];
        if (ok.length) { showMfa(ok[0].id, null); return; }
        var stale = (f.data.all || []).filter(function (x) { return x.factor_type === 'totp' && x.status !== 'verified'; });
        return Promise.all(stale.map(function (x) { return sb.auth.mfa.unenroll({ factorId: x.id }); })).then(function () {
          return sb.auth.mfa.enroll({ factorType: 'totp', issuer: 'Forrajera', friendlyName: 'Forrajera ' + Date.now() });
        }).then(function (e) { if (e.error) throw e.error; showMfa(e.data.id, e.data.totp); });
      });
    });
  }
  $('#f-mfa').addEventListener('submit', function (e) {
    e.preventDefault(); if (!sb || !mfaFactor) return;
    var code = $('#m-code').value.replace(/\D/g, ''), err = $('#m-err');
    if (code.length !== 6) { err.textContent = 'Escribe los 6 dígitos.'; return; }
    $('#m-go').disabled = true; err.textContent = '';
    var wait = 0;
    sb.auth.mfa.challengeAndVerify({ factorId: mfaFactor, code: code }).then(function (r) {
      if (r.error) throw { code: 'badcode' };
      mfaFails = 0;
      return sb.auth.getSession().then(function (s) {
        var ses = s.data && s.data.session; if (!ses) throw { code: 'net' };
        sb.realtime.setAuth(ses.access_token);
        hideMfa(); return enter(ses.user);
      });
    }).catch(function (x) {
      if (x && x.code === 'badcode') { mfaFails++; wait = Math.min(mfaFails, 10) * 1000; err.textContent = 'Código incorrecto o vencido. Espera el siguiente y vuelve a intentar.'; $('#m-code').value = ''; return; }
      if (x && x.code === 'noprofile') { logout('Esta cuenta no tiene acceso al sistema.'); return; }
      err.textContent = 'No se pudo verificar. Revisa tu internet e inténtalo de nuevo.';
    }).then(function () { setTimeout(function () { $('#m-go').disabled = false; }, wait); });
  });
  $('#m-back').addEventListener('click', function () { logout(); });
  function loadAccounts() {
    if (!me) return;
    var q = sb.from('forr_profiles').select('id,username,name,role,store');
    if (!isAdmin()) q = q.eq('id', me.id);
    q.then(function (r) {
      if (r.error || !me) return;
      accounts = r.data.map(toAcc);
      var cur = accounts.find(function (a) { return a.id === me.id; });
      if (!cur) { logout('Tu cuenta fue eliminada. Pide acceso al administrador.'); return; }
      var roleChanged = cur.role !== me.role || cur.store !== me.store;
      me = cur; renderUsers();
      if (roleChanged) { applyRole(); setTab(curTab); render(); }
    });
  }
  function watchProfiles() {
    profSub = sb.channel('forr-profiles-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'forr_profiles' }, function () { loadAccounts(); }).subscribe();
  }
  function renderLogin() {
    if (me) return;
    var setup = ready.accounts && setupMode;
    $('#l-name-wrap').hidden = !setup; $('#l-pass2-wrap').hidden = !setup;
    $('#l-go').textContent = setup ? 'Crear usuario principal' : 'Entrar';
    $('#l-go').disabled = !ready.accounts;
    $('#l-hint').textContent = !ready.accounts ? bootMsg : (setup ? 'Aún no hay usuarios. Crea el usuario principal (administrador). Después podrás crear usuarios para tus encargados.' : 'Entra con tu usuario y contraseña.');
    $('#l-pass').autocomplete = setup ? 'new-password' : 'current-password';
  }
  function renderUsers() {
    var el = $('#userlist'); if (!el || !isAdmin()) return;
    el.innerHTML = accounts.slice().sort(function (x, y) { return String(x.name).localeCompare(String(y.name), 'es'); }).map(function (a) {
      var sure = sureId === 'u:' + a.id;
      return '<div class="storeline"><span>' + esc(a.name) + ' <small class="hint">@' + esc(a.user) + ' · ' + (a.role === 'admin' ? 'Administrador' : 'Encargado de ' + esc(storeName(a.store))) + '</small></span>' +
        '<span class="pw"><input type="password" id="pw-' + esc(a.id) + '" placeholder="Nueva contraseña" autocomplete="new-password" aria-label="Nueva contraseña de ' + esc(a.name) + '"><button class="ghost" data-resetuser="' + esc(a.id) + '">Cambiar</button>' +
        '<button class="ghost' + (sureId === 'm:' + a.id ? ' sure' : '') + '" data-resetmfa="' + esc(a.id) + '">' + (sureId === 'm:' + a.id ? 'Confirmar reinicio' : 'Reiniciar autenticador') + '</button>' +
        (a.id === me.id ? '' : '<button class="ghost' + (sure ? ' sure' : '') + '" data-deluser="' + esc(a.id) + '">' + (sure ? 'Confirmar' : 'Eliminar') + '</button>') + '</span></div>';
    }).join('');
  }

  $('#f-login').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!sb || !ready.accounts) return;
    var user = $('#l-user').value.trim().toLowerCase(), pass = $('#l-pass').value, err = $('#l-err');
    err.textContent = '';
    var p = Promise.resolve();
    if (setupMode) {
      var name = ($('#l-name').value.trim() || user).slice(0, 40);
      if (!/^[a-z0-9._-]{3,30}$/.test(user)) { err.textContent = 'El usuario debe tener de 3 a 30 letras minúsculas, números, punto o guion.'; return; }
      if (pass.length < 8) { err.textContent = 'La contraseña debe tener al menos 8 caracteres.'; return; }
      if (pass !== $('#l-pass2').value) { err.textContent = 'Las contraseñas no coinciden.'; return; }
      p = sb.rpc('forr_create_account', { p_username: user, p_password: pass, p_name: name, p_role: 'admin', p_store: '' }).then(function (r) { if (r.error) throw { code: 'setup', e: r.error }; });
    } else if (!/^[a-z0-9._-]{3,30}$/.test(user)) { err.textContent = 'Usuario o contraseña incorrectos.'; return; }
    $('#l-go').disabled = true;
    var wait = 0;
    p.then(function () { return sb.auth.signInWithPassword({ email: user + EMAIL, password: pass }); })
      .then(function (r) {
        if (r.error) throw { code: r.error.status === 400 ? 'login' : 'net' };
        fails = 0; setupMode = false; $('#l-pass').value = ''; $('#l-pass2').value = '';
        return afterPassword(r.data.user);
      })
      .catch(function (x) {
        if (x && x.code === 'setup') { err.textContent = /taken|not_allowed/.test(rpcMsg(x.e)) ? 'Ya se creó un usuario principal. Entra con tus datos.' : 'No se pudo crear el usuario. Inténtalo de nuevo.'; refreshSetup(); return; }
        if (x && x.code === 'noprofile') { sb.auth.signOut().catch(function () {}); err.textContent = 'Esta cuenta no tiene acceso al sistema.'; return; }
        if (x && x.code === 'login') { fails++; wait = Math.min(fails, 10) * 1000; err.textContent = 'Usuario o contraseña incorrectos.'; return; }
        err.textContent = 'No se pudo conectar. Revisa tu internet e inténtalo de nuevo.';
      })
      .then(function () { setTimeout(function () { $('#l-go').disabled = !ready.accounts; }, wait); });
  });
  $('#logout').addEventListener('click', function () { logout(); });

  $('#f-user').addEventListener('submit', function (e) {
    e.preventDefault(); if (!isAdmin() || !sb) return;
    var user = $('#u-user').value.trim().toLowerCase(), name = ($('#u-name').value.trim() || user).slice(0, 40), pass = $('#u-pass').value, role = $('#u-role').value, store = $('#u-store').value;
    if (!/^[a-z0-9._-]{3,30}$/.test(user)) { toast('El usuario debe tener de 3 a 30 letras minúsculas, números, punto o guion.'); return; }
    if (accounts.some(function (a) { return a.user === user; })) { toast('Ese usuario ya existe.'); return; }
    if (pass.length < 8) { toast('La contraseña debe tener al menos 8 caracteres.'); return; }
    if (role === 'staff' && !store) { toast('Elige la tienda del encargado. Primero agrega la tienda si no existe.'); return; }
    sb.rpc('forr_create_account', { p_username: user, p_password: pass, p_name: name, p_role: role, p_store: role === 'staff' ? store : '' }).then(function (r) {
      if (r.error) { toast(/taken/.test(rpcMsg(r.error)) ? 'Ese usuario ya existe.' : 'No se pudo crear el usuario.'); return; }
      $('#u-name').value = ''; $('#u-user').value = ''; $('#u-pass').value = ''; toast('Usuario creado'); loadAccounts();
    }, function () { toast('No se pudo crear el usuario. Revisa tu conexión.'); });
  });
  $('#userlist').addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t || !isAdmin()) return;
    // Si alguien pierde su celular: borra su autenticador y la próxima vez que entre escanea uno nuevo
    if (t.dataset.resetmfa) {
      var mid = t.dataset.resetmfa;
      if (sureId !== 'm:' + mid) { armSure('m:' + mid); renderUsers(); return; }
      sureId = null;
      sb.rpc('forr_reset_mfa', { p_user: mid }).then(function (r) {
        if (r.error) { toast('No se pudo reiniciar el autenticador.'); renderUsers(); return; }
        if (mid === me.id) { logout('Reiniciaste tu autenticador. Entra de nuevo y escanea el código nuevo.'); return; }
        toast('Autenticador reiniciado. Al entrar tendrá que escanear un código nuevo.'); renderUsers();
      });
      return;
    }
    if (t.dataset.resetuser) {
      var id = t.dataset.resetuser, inp = document.getElementById('pw-' + id);
      if (!inp) return;
      if (inp.value.length < 8) { toast('La contraseña debe tener al menos 8 caracteres.'); return; }
      sb.rpc('forr_set_password', { p_user: id, p_password: inp.value }).then(function (r) {
        if (r.error) { toast('No se pudo cambiar la contraseña.'); return; }
        inp.value = ''; toast('Contraseña cambiada');
      });
    }
    if (t.dataset.deluser) {
      var uid = t.dataset.deluser, acc = accounts.find(function (a) { return a.id === uid; });
      if (sureId === 'u:' + uid) {
        sureId = null;
        if (acc && acc.role === 'admin' && accounts.filter(function (a) { return a.role === 'admin'; }).length <= 1) { toast('Debe quedar al menos un administrador.'); renderUsers(); return; }
        sb.rpc('forr_delete_account', { p_user: uid }).then(function (r) {
          if (r.error) { toast(/last_admin/.test(rpcMsg(r.error)) ? 'Debe quedar al menos un administrador.' : 'No se pudo eliminar el usuario.'); return; }
          toast('Usuario eliminado'); loadAccounts();
        });
      } else { armSure('u:' + uid); renderUsers(); }
    }
  });
  $('#f-pw').addEventListener('submit', function (e) {
    e.preventDefault(); if (!me || !sb) return;
    var cur = $('#pw-cur').value, nw = $('#pw-new').value;
    if (nw.length < 8) { toast('La contraseña nueva debe tener al menos 8 caracteres.'); return; }
    sb.rpc('forr_change_my_password', { p_old: cur, p_new: nw }).then(function (r) {
      if (r.error) { toast(/bad_password/.test(rpcMsg(r.error)) ? 'La contraseña actual no es correcta.' : 'No se pudo cambiar la contraseña.'); return; }
      $('#pw-cur').value = ''; $('#pw-new').value = ''; toast('Contraseña cambiada');
    });
  });

  /* ---------- start ---------- */
  function start(d) {
    db = d;
    function onErr(e) {
      if (e && e.code === 'invalid_argument') { $('#sync').textContent = 'Sin acceso'; toast('Tu usuario no tiene permiso para ver estos datos.'); return; }
      $('#sync').textContent = 'Sin conexión con la base de datos'; fail(e);
    }
    db.collection('stores').orderBy('name').limit(100).onSnapshot(function (s) {
      stores = s.docs.map(function (x) { return Object.assign({ id: x.id }, x.data()); }); ready.stores = true;
      if (isAdmin() && filterStore !== 'all' && !stores.some(function (x) { return x.id === filterStore; })) filterStore = 'all';
      render(); renderUsers();
    }, onErr);
    db.collection('items').limit(1000).onSnapshot(function (s) {
      items = s.docs.map(function (x) { var v = x.data(); return Object.assign({ id: x.id }, v, { qty: +v.qty || 0, min: +v.min || 0, cost: +v.cost || 0, costDozen: +v.costDozen || 0, price: +v.price || 0, priceKg: +v.priceKg || 0, bag: +v.bag || 0, closed: v.closed == null ? null : (+v.closed || 0), open: +v.open || 0, supplier: String(v.supplier || ''), max: +v.max || 0, usage: Array.isArray(v.usage) ? v.usage : [], name: String(v.name || ''), cat: CATS[v.cat] ? v.cat : 'otro', recipe: Array.isArray(v.recipe) ? v.recipe.map(function (r) { return { id: String(r.id), q: +r.q || 0 }; }) : [] }); });
      ready.items = true; $('#sync').textContent = items.length + ' productos · sincronizado'; render();
    }, onErr);
    // ventas y compras de los últimos 12 meses para las gráficas
    var since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(1); since.setMonth(since.getMonth() - 11);
    db.collection('movements').where('type', '==', 'venta').where('ts', '>=', since.getTime()).orderBy('ts').limit(5000).onSnapshot(function (s) {
      salesDocs = s.docs.map(function (x) { return x.data(); }); if (me && curTab === 'ven') renderSales();
    }, function () {});
    db.collection('movements').where('type', '==', 'compra').where('ts', '>=', since.getTime()).orderBy('ts').limit(5000).onSnapshot(function (s) {
      buyDocs = s.docs.map(function (x) { return x.data(); }); if (me && curTab === 'ven') renderSales();
    }, function () {});
    db.collection('movements').orderBy('ts', 'desc').limit(200).onSnapshot(function (s) {
      moves = s.docs.map(function (x) { return x.data(); }); renderHist(); if (me && curTab === 'buy') renderBuys();
    }, function () {});
    if (isAdmin()) {
      db.doc('settings/reset').onSnapshot(function (s) { resetCfg = s.exists ? s.data() : null; renderReset(); }, function () {});
      db.doc('settings/alerts').onSnapshot(function (s) { settings = s.exists ? s.data() : {}; render(); }, function () {});
      db.doc('settings/goals').onSnapshot(function (s) { goals = (s.exists && s.data().months) || {}; if (curTab === 'ven') renderSales(); }, function () {});
      // limpia historial con más de 2 años (se conservan ventas y compras recientes para las gráficas)
      db.collection('movements').where('ts', '<', Date.now() - 730 * 864e5).limit(50).get().then(function (s) {
        s.docs.forEach(function (x) { db.doc('movements/' + x.id).delete().catch(function () {}); });
      }).catch(function () {});
    }
  }
  renderLogin();
  var CFG = window.CIFRASTOCK || {};
  if (!window.supabase || !window.CSDB || !CFG.url) {
    bootMsg = 'No se pudo cargar el sistema. Revisa tu conexión a internet y recarga la página.'; renderLogin();
  } else {
    sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'forrajera-auth' } });
    sb.auth.getSession().then(function (r) {
      var s = r.data && r.data.session;
      if (!s) { refreshSetup(); return; }
      return afterPassword(s.user).catch(function () { sb.auth.signOut().catch(function () {}); refreshSetup(); });
    });
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT' && me) logout('Tu sesión terminó. Entra de nuevo.'); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && db) db.refreshAll(); });
    window.addEventListener('online', function () { if (db) db.refreshAll(); });
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(function () {});
})();
