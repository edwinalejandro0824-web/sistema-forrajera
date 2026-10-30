/* Capa de datos: misma forma que usaba el sistema (collection / doc / onSnapshot), guardada en la tabla "forr_docs" de Supabase (separada de CifraStock). */
(function () {
  var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  function rid() { var a = new Uint8Array(20), o = ''; crypto.getRandomValues(a); for (var i = 0; i < a.length; i++) o += CHARS[a[i] % 62]; return o; }
  function col(f) { return f === 'ts' ? 'ts' : 'data->>' + f; }
  function err(e) {
    var x = new Error((e && e.message) || 'error');
    x.code = (e && (e.code === '42501' || /row-level security|permission/i.test(e.message || ''))) ? 'invalid_argument' : ((e && e.code) || 'error');
    x.raw = e; return x;
  }
  function snapDoc(id, data) { return { id: id, exists: !!data, data: function () { return data ? JSON.parse(JSON.stringify(data)) : undefined; } }; }
  function clone(o) { return { w: o.w.slice(), ord: o.ord, lim: o.lim }; }
  var OPS = { '>=': 'gte', '>': 'gt', '<=': 'lte', '<': 'lt', '==': 'eq' };

  function create(sb) {
    var listeners = {}, channel = null;
    function emit(coll) { (listeners[coll] || []).slice().forEach(function (fn) { fn(); }); }
    function ensureChannel() {
      if (channel) return;
      channel = sb.channel('forr-docs-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'forr_docs' }, function (p) {
        var c = (p.new && p.new.coll) || (p.old && p.old.coll);
        if (c) emit(c); else Object.keys(listeners).forEach(emit);
      }).subscribe();
    }
    function listen(coll, fn) {
      (listeners[coll] = listeners[coll] || []).push(fn); ensureChannel();
      return function () { listeners[coll] = (listeners[coll] || []).filter(function (f) { return f !== fn; }); };
    }
    // Vuelve a leer cuando algo cambia; agrupa cambios seguidos en una sola lectura.
    function watch(coll, run, cb, onErr) {
      var live = true, timer = null, busy = false, again = false;
      function go() {
        if (!live) return;
        if (busy) { again = true; return; }
        busy = true;
        run().then(function (s) { if (live) cb(s); }, function (e) { if (live && onErr) onErr(e); })
          .then(function () { busy = false; if (again) { again = false; go(); } });
      }
      function soon() { clearTimeout(timer); timer = setTimeout(go, 150); }
      var off = listen(coll, soon); go();
      return function () { live = false; clearTimeout(timer); off(); };
    }

    function Query(coll, o) { this.coll = coll; this.o = o || { w: [], ord: null, lim: null }; }
    Query.prototype.where = function (f, op, v) { var o = clone(this.o); o.w.push([f, op, v]); return new Query(this.coll, o); };
    Query.prototype.orderBy = function (f, dir) { var o = clone(this.o); o.ord = [f, dir === 'desc']; return new Query(this.coll, o); };
    Query.prototype.limit = function (n) { var o = clone(this.o); o.lim = n; return new Query(this.coll, o); };
    Query.prototype.get = function () {
      var q = sb.from('forr_docs').select('id,data').eq('coll', this.coll);
      this.o.w.forEach(function (w) { q = q[OPS[w[1]]](col(w[0]), w[2]); });
      if (this.o.ord) q = q.order(col(this.o.ord[0]), { ascending: !this.o.ord[1] });
      if (this.o.lim) q = q.limit(this.o.lim);
      return q.then(function (r) {
        if (r.error) throw err(r.error);
        var docs = r.data.map(function (x) { return snapDoc(x.id, x.data); });
        return { docs: docs, size: docs.length, empty: !docs.length };
      });
    };
    Query.prototype.onSnapshot = function (cb, onErr) { var self = this; return watch(this.coll, function () { return self.get(); }, cb, onErr); };

    function Doc(coll, id) { this.coll = coll; this.id = id; }
    Doc.prototype.get = function () {
      var id = this.id;
      return sb.from('forr_docs').select('data').eq('coll', this.coll).eq('id', id).maybeSingle().then(function (r) {
        if (r.error) throw err(r.error);
        return snapDoc(id, r.data ? r.data.data : null);
      });
    };
    Doc.prototype.set = function (data) {
      var c = this.coll;
      return sb.from('forr_docs').upsert({ coll: c, id: this.id, data: data }).then(function (r) { if (r.error) throw err(r.error); emit(c); });
    };
    Doc.prototype.update = function (patch) {
      var c = this.coll;
      return sb.rpc('forr_doc_patch', { p_coll: c, p_id: this.id, p_patch: patch }).then(function (r) { if (r.error) throw err(r.error); emit(c); });
    };
    Doc.prototype.delete = function () {
      var c = this.coll;
      return sb.from('forr_docs').delete().eq('coll', c).eq('id', this.id).then(function (r) { if (r.error) throw err(r.error); emit(c); });
    };
    Doc.prototype.onSnapshot = function (cb, onErr) { var self = this; return watch(this.coll, function () { return self.get(); }, cb, onErr); };

    function Coll(name) { Query.call(this, name); }
    Coll.prototype = Object.create(Query.prototype);
    Coll.prototype.doc = function (id) { return new Doc(this.coll, id || rid()); };
    Coll.prototype.add = function (data) { var d = this.doc(); return d.set(data).then(function () { return d; }); };

    return {
      collection: function (n) { return new Coll(n); },
      doc: function (path) { var p = path.split('/'); return new Doc(p[0], p[1]); },
      refreshAll: function () { Object.keys(listeners).forEach(emit); },
      close: function () { if (channel) sb.removeChannel(channel); channel = null; listeners = {}; }
    };
  }
  window.CSDB = { create: create };
})();
