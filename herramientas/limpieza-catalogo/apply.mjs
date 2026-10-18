// Aplica la limpieza sobre una copia de seguridad usando el propio código de la app y genera una copia nueva para restaurar.
// node apply.mjs <copia.json> <decisiones.json> <compras.json> <salida.json> <ruta app/src>
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [SRC, DEC, COMPRAS, OUT, APP] = process.argv.slice(2);
const worker = (await import(pathToFileURL(path.join(APP, 'worker.js')))).default;
const { recomputeStock } = await import(pathToFileURL(path.join(APP, 'migrate.js')));
const db = new DatabaseSync(':memory:');
const conv = (a) => a.map((x) => (x === undefined ? null : typeof x === 'boolean' ? Number(x) : x));
class Stmt { constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  async first(col) { const r = db.prepare(this.sql).get(...conv(this.args)); return r ? (col ? r[col] : { ...r }) : null; }
  async all() { return { results: db.prepare(this.sql).all(...conv(this.args)).map((r) => ({ ...r })) }; }
  async run() { const r = db.prepare(this.sql).run(...conv(this.args)); return { meta: { changes: Number(r.changes) } }; }
  async raw() { return db.prepare(this.sql).all(...conv(this.args)).map((r) => Object.values(r)); } }
const env = { DB: { prepare: (s) => new Stmt(s), batch: async (st) => { db.exec('BEGIN'); try { for (const s of st) await s.run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; } } };
const COOKIE = 'sid=limpieza-claude';
const call = async (method, p, body) => {
  const r = await worker.fetch(new Request('http://x/api/' + p, { method, headers: { 'content-type': 'application/json', cookie: COOKIE }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
};
const q = (sql, ...a) => db.prepare(sql).all(...a).map((r) => ({ ...r }));
const log = [];
const note = (t) => { log.push(t); };

// 1) base de datos con el esquema de la app y los datos de la copia
await call('GET', 'setup-status');
const backup = JSON.parse(fs.readFileSync(SRC, 'utf8'));
for (const [t, rows] of Object.entries(backup.tables)) {
  if (!rows.length) continue;
  const cols = q(`PRAGMA table_info(${t})`).map((c) => c.name);
  if (!cols.length) { note(`tabla desconocida ${t}`); continue; }
  db.exec(`DELETE FROM ${t}`);
  db.exec('BEGIN');
  for (const r of rows) { const ks = cols.filter((k) => k in r); db.prepare(`INSERT OR REPLACE INTO ${t} (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`).run(...conv(ks.map((k) => r[k]))); }
  db.exec('COMMIT');
}
db.prepare(`INSERT INTO settings (key, value) VALUES ('schema_version', '11') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
await recomputeStock(env);
db.prepare(`INSERT INTO users (id, name, username, pass, role, is_super, active) VALUES (99999, 'Limpieza del catálogo (Claude)', 'limpieza-claude', 'x', 'direccion', 1, 1)`).run();
db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES ('limpieza-claude', 99999, '2099-01-01')`).run();
const before = { products: q('SELECT COUNT(*) n FROM products WHERE active = 1')[0].n, suppliers: q('SELECT COUNT(*) n FROM suppliers WHERE active = 1')[0].n };
const openCount = () => Object.fromEntries(q(`SELECT l.product_id AS id, SUM(l.counted) AS c FROM inventory_lines l JOIN inventories i ON i.id = l.inventory_id WHERE i.notes LIKE '[arranque]%' GROUP BY l.product_id`).map((r) => [r.id, r.c]));
const cnt0 = openCount();

const D = JSON.parse(fs.readFileSync(DEC, 'utf8'));
const P = () => Object.fromEntries(q('SELECT * FROM products').map((p) => [p.id, p]));

// 3) fusiones: primero las líneas de abono/regalo (misma unidad), luego se convierten unidades y se fusionan los repetidos
const isJunk = (m) => !m.name && /abono|regalo|rectific/.test(m.note);
let merged = 0;
const runMerges = async (list) => {
  const byTarget = new Map();
  for (const m of list) { if (!byTarget.has(m.target)) byTarget.set(m.target, []); byTarget.get(m.target).push(m); }
  for (const [target, ms] of byTarget) {
    const sources = ms.flatMap((m) => m.sources.map(([s]) => s)).filter((s) => P()[s]?.active);
    if (!sources.length) continue;
    const r = await call('POST', 'products/merge', { target_id: target, source_ids: sources });
    if (r.status !== 200) { note(`✘ fusión en ${p0[target]?.name}: ${r.data?.error}`); continue; }
    merged += sources.length;
    const name = ms.find((m) => m.name)?.name;
    if (name && name !== P()[target].name) { const rr = await call('PUT', 'products/' + target, { name }); if (rr.status !== 200) note(`· no se pudo renombrar «${p0[target].name}» a «${name}»: ${rr.data?.error}`); }
  }
};
let p0 = P();
await runMerges(D.merges.filter(isJunk));
// 2) conversión de unidades de los repetidos que van en otra unidad o formato (antes de fusionar)
p0 = P();
for (const m of D.merges.filter((x) => !isJunk(x))) {
  const t = p0[m.target];
  for (const [s, f] of m.sources) {
    const sp = p0[s]; if (!sp || !t) continue;
    if (f === 1 && sp.unit === t.unit) continue;
    db.exec('BEGIN');
    db.prepare('UPDATE movements SET qty = qty * ?, unit_cost = unit_cost / ? WHERE product_id = ?').run(f, f, s);
    db.prepare('UPDATE receipt_lines SET qty = qty * ?, price = price / ? WHERE product_id = ?').run(f, f, s);
    db.prepare('UPDATE order_lines SET qty = qty * ?, price = price / ? WHERE product_id = ?').run(f, f, s);
    db.prepare('UPDATE inventory_lines SET counted = counted * ?, expected = expected * ? WHERE product_id = ?').run(f, f, s);
    db.prepare(`UPDATE recipe_lines SET qty = qty * ?, input_qty = qty * ?, input_unit = ? WHERE product_id = ?`).run(f, f, t.unit, s);
    db.prepare('UPDATE price_history SET old_price = old_price / ?, new_price = new_price / ? WHERE product_id = ?').run(f, f, s);
    db.prepare('UPDATE product_formats SET factor = factor * ? WHERE product_id = ?').run(f, s);
    db.prepare('UPDATE products SET unit = ?, price = price / ?, min_stock = min_stock * ? WHERE id = ?').run(t.unit, f, f, s);
    db.exec('COMMIT');
    // si el repetido era «una caja de N» y el principal no tiene ese formato, se le añade
    if (f !== 1 && !q('SELECT 1 FROM product_formats WHERE product_id = ? AND ABS(factor - ?) < 0.0001', m.target, f).length && sp.unit === 'ud') {
      const kind = (sp.name.match(/garrafa|cubo|cuba|saco|caja|bolsa|barril|lata|botella|brik|gastro|bandeja|paquete/i)?.[0] || (/\(\d+\)|c\d+|c\/\s?\d+/i.test(sp.name) ? 'caja' : f < 1 ? 'unidad' : 'envase')).toLowerCase();
      const qty = t.unit === 'kg' && f < 1 ? `${+(f * 1000).toFixed(0)} g` : t.unit === 'l' && f < 1 ? `${+(f * 100).toFixed(1)} cl` : `${+f.toFixed(3)} ${t.unit}`;
      const fname = `${kind[0].toUpperCase()}${kind.slice(1)} ${qty}`.replace(/ ud$/, '');
      try { db.prepare('INSERT INTO product_formats (product_id, name, factor, price) VALUES (?,?,?,?)').run(m.target, fname, f, sp.price ? sp.price : null); } catch { /* ya existe con ese nombre */ }
    }
  }
}
await recomputeStock(env);

await runMerges(D.merges.filter((x) => !isJunk(x)));

// 3b) artículos que se compran por envase y se usan por peso o volumen: pasan a kg o l, y el envase queda como formato
let converted = 0;
for (const [id, c] of Object.entries(D.convert || {})) {
  const p = P()[id]; if (!p?.active || p.unit !== 'ud') continue;
  const f = c.factor;
  db.exec('BEGIN');
  db.prepare('UPDATE movements SET qty = qty * ?, unit_cost = unit_cost / ? WHERE product_id = ?').run(f, f, id);
  db.prepare('UPDATE receipt_lines SET qty = qty * ?, price = price / ? WHERE product_id = ?').run(f, f, id);
  db.prepare('UPDATE order_lines SET qty = qty * ?, price = price / ? WHERE product_id = ?').run(f, f, id);
  db.prepare('UPDATE inventory_lines SET counted = counted * ?, expected = expected * ? WHERE product_id = ?').run(f, f, id);
  db.prepare(`UPDATE recipe_lines SET qty = qty * ?, input_qty = qty * ?, input_unit = ? WHERE product_id = ? AND (input_unit IS NULL OR input_unit NOT LIKE 'f:%')`).run(f, f, c.unit, id);
  db.prepare(`UPDATE recipe_lines SET qty = qty * ? WHERE product_id = ? AND input_unit LIKE 'f:%'`).run(f, id);
  db.prepare('UPDATE price_history SET old_price = old_price / ?, new_price = new_price / ? WHERE product_id = ?').run(f, f, id);
  db.prepare('UPDATE product_formats SET factor = factor * ? WHERE product_id = ?').run(f, id);
  db.prepare('UPDATE products SET unit = ?, price = price / ?, min_stock = min_stock * ? WHERE id = ?').run(c.unit, f, f, id);
  const hasDef = q('SELECT 1 FROM product_formats WHERE product_id = ? AND active = 1 AND is_default = 1', Number(id)).length;
  if (!q('SELECT 1 FROM product_formats WHERE product_id = ? AND active = 1 AND ABS(factor - ?) < 0.0001', Number(id), f).length)
    try { db.prepare('INSERT INTO product_formats (product_id, name, factor, price, is_default) VALUES (?,?,?,?,?)').run(Number(id), c.format, f, p.price || null, hasDef ? 0 : 1); } catch { /* nombre repetido */ }
  db.exec('COMMIT');
  converted++;
}

// formatos repetidos (mismo contenido) tras fusionar: se deja uno
for (const g of q(`SELECT product_id, factor, COUNT(*) n FROM product_formats WHERE active = 1 GROUP BY product_id, ROUND(factor, 4) HAVING n > 1`)) {
  const fs2 = q('SELECT id, name, is_default FROM product_formats WHERE product_id = ? AND active = 1 AND ABS(factor - ?) < 0.0001 ORDER BY is_default DESC, LENGTH(name) DESC', g.product_id, g.factor);
  for (const f of fs2.slice(1)) {
    for (const t of ['order_lines', 'receipt_lines', 'recipe_lines']) db.prepare(`UPDATE ${t} SET input_unit = ? WHERE input_unit = ?`).run('f:' + fs2[0].id, 'f:' + f.id);
    db.prepare('UPDATE product_formats SET active = 0, is_default = 0 WHERE id = ?').run(f.id);
  }
}

// 4) bajas
let bajas = 0;
for (const b of D.bajas) { if (!P()[b.id]?.active) continue; const r = await call('DELETE', 'products/' + b.id); if (r.status === 200) bajas++; else note(`✘ baja ${p0[b.id]?.name}: ${r.data?.error}`); }

// 5) nombres, categorías, precios y formatos
let upd = 0;
for (const [id, u] of Object.entries(D.updates)) {
  const p = P()[id]; if (!p?.active) continue;
  const body = {};
  if (u.name && u.name !== p.name) body.name = u.name;
  if (u.category && u.category !== p.category) body.category = u.category;
  if (u.price != null) body.price = u.price;
  if ('supplier_id' in u && u.supplier_id !== p.supplier_id) body.supplier_id = u.supplier_id;
  if (u.formats_add) {
    const cur = q('SELECT id, name, factor, price, is_default FROM product_formats WHERE product_id = ? AND active = 1', Number(id));
    const add = u.formats_add.filter((f) => !cur.some((c) => Math.abs(c.factor - f.factor) < 0.0001 || c.name.toLowerCase() === f.name.toLowerCase()));
    if (add.length) body.formats = [...cur.map((c) => ({ ...c, is_default: add.some((a) => a.is_default) ? 0 : c.is_default })), ...add];
  }
  if (!Object.keys(body).length) continue;
  let r = await call('PUT', 'products/' + id, body);
  if (r.status === 409 && body.name) { note(`· «${body.name}» ya existe: se queda como «${p.name}»`); delete body.name; r = await call('PUT', 'products/' + id, body); }
  if (r.status === 200) upd++; else note(`✘ cambio en ${p.name}: ${r.data?.error}`);
}

// 6) proveedores: repetidos y los que no son de género (sin artículos ni compras)
for (const [t, srcs] of D.supplier_merges) {
  const ok = srcs.filter((s) => q('SELECT 1 FROM suppliers WHERE id = ? AND active = 1', s).length);
  if (!ok.length) continue;
  const r = await call('POST', 'suppliers/merge', { target_id: t, source_ids: ok });
  if (r.status !== 200) note(`✘ fusión de proveedor ${t}: ${r.data?.error}`);
}
for (const [id, name] of Object.entries(D.supplier_names)) await call('PUT', 'suppliers/' + id, { name });

// 7) compras de las facturas como facturas recibidas (por facturas completas, sin partirlas)
const compras = JSON.parse(fs.readFileSync(COMPRAS, 'utf8'));
const names = Object.fromEntries(q('SELECT id, name, active FROM products').map((p) => [p.id, p]));
const docs = new Map();
for (const l of compras) {
  const p = names[l.pid]; if (!p?.active) { note(`compra sin artículo activo (${l.pid})`); continue; }
  const k = `${l.supplier_name}|${l.doc || l.date}`;
  if (!docs.has(k)) docs.set(k, []);
  docs.get(k).push({ name: p.name, supplier_name: l.supplier_name, cif: l.cif, doc: l.doc, date: l.date, qty: l.qty, unit: l.unit, price: l.price, amount: l.amount });
}
const stockBeforeImp = Object.fromEntries(q('SELECT id, stock_cache s FROM products').map((r) => [r.id, r.s]));
let batch = [], imp = { invoices: 0, lines: 0, already: 0, new_articles: [], new_suppliers: [] };
const flush = async () => {
  if (!batch.length) return;
  const r = await call('POST', 'receipts/import', { items: batch });
  if (r.status !== 200) note(`✘ importación de compras: ${r.data?.error}`);
  else { imp.invoices += r.data.created_invoices; imp.lines += r.data.created_lines; imp.already += r.data.already; imp.new_articles.push(...r.data.new_articles); imp.new_suppliers.push(...r.data.new_suppliers); }
  batch = [];
};
for (const lines of docs.values()) { if (batch.length + lines.length > 550) await flush(); batch.push(...lines); }
await flush();

// las compras históricas no cambian el stock (ya regularizado con el inventario): se compensa cada artículo
const regDay = q(`SELECT inv_date FROM inventories WHERE notes = 'Regularización: inventario de arranque' ORDER BY id DESC LIMIT 1`)[0]?.inv_date || new Date().toISOString().slice(0, 10);
const impQty = q(`SELECT rl.product_id, SUM(rl.qty) q, AVG(rl.price) pr FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id WHERE r.notes = 'Importada de Excel' AND r.user_id = 99999 GROUP BY rl.product_id`);
db.exec('BEGIN');
for (const x of impQty) if (Math.abs(x.q) > 1e-9) db.prepare(`INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?, 'entrada', ?, ?, 'Compras históricas importadas (no cambian el stock contado)', ?, 'stock_inicial', NULL, 99999, ?)`).run(x.product_id, -x.q, x.pr || 0, 'hist-' + x.product_id, regDay);
db.exec('COMMIT');

// 8) proveedores que no son de género: sin artículos ni facturas
let supBajas = [];
for (const s of q(`SELECT s.id, s.name FROM suppliers s WHERE s.active = 1 AND NOT EXISTS (SELECT 1 FROM products p WHERE p.supplier_id = s.id AND p.active = 1) AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.supplier_id = s.id)`)) {
  const r = await call('DELETE', 'suppliers/' + s.id); if (r.status === 200) supBajas.push(s.name);
}

// 9) comprobaciones
await recomputeStock(env);
const after = { products: q('SELECT COUNT(*) n FROM products WHERE active = 1')[0].n, suppliers: q('SELECT COUNT(*) n FROM suppliers WHERE active = 1')[0].n };
// lo contado en el inventario de arranque: cada repetido suma en su principal (con su factor)
const expect = { ...cnt0 };
const dest = {}; for (const m of D.merges) for (const [s, f] of m.sources) dest[s] = [m.target, f];
for (const id of Object.keys(cnt0)) { let i = Number(id), f = 1, n = 0; while (dest[i] && n++ < 10) { f *= dest[i][1]; i = dest[i][0]; } if (i !== Number(id)) { expect[i] = (expect[i] || 0) + cnt0[id] * f; delete expect[id]; } }
for (const [id, c] of Object.entries(D.convert || {})) if (expect[id] != null) expect[id] *= c.factor;
const cnt1 = openCount();
const countMismatch = Object.keys({ ...expect, ...cnt1 }).filter((k) => Math.abs((expect[k] || 0) - (cnt1[k] || 0)) > 0.001).map((k) => [names0()[k]?.name, expect[k], cnt1[k]]);
function names0() { return Object.fromEntries(q('SELECT id, name FROM products').map((p) => [p.id, p])); }
const countedBefore = Object.keys(cnt0).length, countedAfter = Object.keys(cnt1).length;
const orphanLines = q(`SELECT COUNT(*) n FROM inventory_lines l LEFT JOIN products p ON p.id = l.product_id WHERE p.id IS NULL`)[0].n;
const orphanRecipe = q(`SELECT r.name, p.name AS pn, p.active FROM recipe_lines rl JOIN recipes r ON r.id = rl.recipe_id LEFT JOIN products p ON p.id = rl.product_id WHERE p.id IS NULL OR p.active = 0`);
const drift = q(`SELECT COUNT(*) n FROM products p WHERE ABS(p.stock_cache - COALESCE((SELECT SUM(qty) FROM movements m WHERE m.product_id = p.id), 0)) > 0.0001`)[0].n;
const boot = await call('GET', 'bootstrap');

// 10) copia nueva en el formato de la app (sin el usuario temporal)
db.prepare('DELETE FROM sessions').run();
db.prepare('DELETE FROM users WHERE id = 99999').run();
const out = { app: 'gestion-restaurante', version: 11, created_at: new Date().toISOString(), restaurant: backup.restaurant, tables: {}, note: 'Copia con el catálogo limpio (Claude)' };
for (const t of Object.keys(backup.tables)) { try { out.tables[t] = q(`SELECT * FROM ${t}`); } catch { /* tabla que no existe */ } }
fs.writeFileSync(OUT, JSON.stringify(out));

const stockChanged = q('SELECT id, name, stock_cache s FROM products').filter((r) => Math.abs(r.s - (stockBeforeImp[r.id] ?? r.s)) > 0.001).map((r) => [r.name, stockBeforeImp[r.id], r.s]);
const res = { stockChanged, converted, countMismatch, before, after, merged, bajas, upd, imp: { ...imp, new_articles: imp.new_articles.length, new_suppliers: imp.new_suppliers }, supBajas, countedBefore, countedAfter, orphanLines, orphanRecipe, drift, bootstrap: boot.status, log };
fs.writeFileSync(OUT.replace(/\.json$/, '.informe.json'), JSON.stringify(res, null, 1));
console.log(JSON.stringify({ ...res, log: log.slice(0, 40), supBajas: supBajas.length }, null, 1));
