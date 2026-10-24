// Actualización automática de la base de datos.
// Al arrancar una versión nueva, la app crea las tablas que falten y añade las columnas nuevas.
// Todo es repetible: si algo ya existe, se ignora. Así nunca hay que pegar SQL en la consola.
import { SCHEMA } from './schema.js';

export const SCHEMA_VERSION = 13;

// Columnas añadidas después de la primera versión (para bases de datos ya creadas)
const COLUMNS = [
  ['sales_imports', 'calc_at TEXT'],
  ['order_lines', 'input_qty REAL'], ['order_lines', 'input_unit TEXT'], ['order_lines', 'unit_label TEXT'],
  ['receipt_lines', 'input_qty REAL'], ['receipt_lines', 'input_unit TEXT'], ['receipt_lines', 'unit_label TEXT'], ['receipt_lines', 'input_price REAL'],
  ['recipe_lines', 'input_qty REAL'], ['recipe_lines', 'input_unit TEXT'],
  ['users', 'is_super INTEGER NOT NULL DEFAULT 0'], ['users', 'perms TEXT'],
  ['suppliers', 'cif TEXT'],
  ['receipts', "doc_type TEXT NOT NULL DEFAULT 'albaran'"],
  ['products', 'allergens TEXT'], ['products', 'allergens_checked INTEGER NOT NULL DEFAULT 0'],
  ['recipes', 'pos_raw TEXT'], ['recipes', 'plating TEXT'], ['recipes', 'conservation TEXT'], ['recipes', 'prep_time TEXT'],
  ['recipes', 'misc_pct REAL'], ['recipes', 'allergens_extra TEXT'], ['recipes', 'photo TEXT'], ['recipes', 'author TEXT'], ['recipes', 'updated_at TEXT'],
  ['recipe_lines', 'cook_loss_pct REAL NOT NULL DEFAULT 0'],
  ['recipes', "kind TEXT NOT NULL DEFAULT 'plato'"], ['recipes', 'yield_qty REAL'], ['recipes', 'yield_unit TEXT'], ['recipes', 'product_id INTEGER'],
  ['products', 'prep_recipe_id INTEGER'],
  ['orders', 'approved_by INTEGER'], ['orders', 'approved_at TEXT'], ['users', 'phone TEXT'], ['users', 'email TEXT'],
  ['receipts', 'rec_temp REAL'], ['receipts', 'rec_check INTEGER'],
  ['receipt_lines', 'lot TEXT'], ['receipt_lines', 'expiry TEXT'], ['receipt_lines', 'expiry_done INTEGER NOT NULL DEFAULT 0'],
  ['products', 'stock_cache REAL NOT NULL DEFAULT 0'],
  ['products', 'other_suppliers TEXT'],
];

// Stock guardado en el propio artículo y actualizado al momento con cada movimiento (antes se sumaban todos
// los movimientos en cada consulta y se agotaba el cupo diario de lecturas de la base de datos).
export const STOCK_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS mov_stock_ins AFTER INSERT ON movements BEGIN UPDATE products SET stock_cache = stock_cache + NEW.qty WHERE id = NEW.product_id; END`,
  `CREATE TRIGGER IF NOT EXISTS mov_stock_del AFTER DELETE ON movements BEGIN UPDATE products SET stock_cache = stock_cache - OLD.qty WHERE id = OLD.product_id; END`,
  `CREATE TRIGGER IF NOT EXISTS mov_stock_upd AFTER UPDATE OF qty, product_id ON movements BEGIN UPDATE products SET stock_cache = stock_cache - OLD.qty WHERE id = OLD.product_id; UPDATE products SET stock_cache = stock_cache + NEW.qty WHERE id = NEW.product_id; END`,
];
export async function recomputeStock(env) {
  await env.DB.prepare(`UPDATE products SET stock_cache = COALESCE((SELECT SUM(m.qty) FROM movements m WHERE m.product_id = products.id), 0)`).run();
}

const benign = (e) => /duplicate column|already exists/i.test(String(e?.message || e));

async function run(env, sql) {
  try { await env.DB.prepare(sql).run(); } catch (e) { if (!benign(e)) throw new Error(`${e.message} — en: ${sql.slice(0, 80)}`); }
}

// Amplía los valores permitidos de una columna con CHECK (SQLite no deja cambiarlo: se rehace la tabla)
async function widenCheck(env, table, after, value) {
  const t = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(table).first();
  if (!t || t.sql.includes(`'${value}'`)) return;
  const create = t.sql.replace(new RegExp(`CREATE TABLE\\s+"?${table}"?`, 'i'), `CREATE TABLE ${table}_new`)
    .replace(`'${after}'`, `'${after}','${value}'`);
  if (!create.includes(`'${value}'`)) throw new Error(`No se pudo ampliar la tabla ${table}`);
  await env.DB.batch([
    env.DB.prepare(`DROP TABLE IF EXISTS ${table}_new`),
    env.DB.prepare(create),
    env.DB.prepare(`INSERT INTO ${table}_new SELECT * FROM ${table}`),
    env.DB.prepare(`DROP TABLE ${table}`),
    env.DB.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`),
  ]);
  for (const sql of SCHEMA.filter((s) => new RegExp(`CREATE INDEX .* ON ${table}\\(`, 'i').test(s))) await run(env, sql);
}
async function ensureCheck(env, table, after, value) {
  // se comprueba después: si dos arranques coinciden, el segundo podría deshacer el cambio
  for (let i = 0; i < 3; i++) {
    await widenCheck(env, table, after, value);
    const t = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(table).first();
    if (t?.sql.includes(`'${value}'`)) return;
  }
  throw new Error(`No se pudo actualizar la tabla ${table}`);
}

const EXTRA = [];
export function addMigration(fn) { EXTRA.push(fn); }

let ready = null;
export function ensureSchema(env) {
  if (!ready) {
    // si la base de datos no contesta, no se queda esperando para siempre: la próxima petición lo vuelve a intentar
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('la base de datos no responde ahora mismo; vuelve a intentarlo en un momento')), 20000); });
    ready = Promise.race([migrate(env), timeout]).finally(() => clearTimeout(timer)).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function migrate(env) {
  let v = 0;
  try { v = Number((await env.DB.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).first())?.value) || 0; } catch { v = 0; }
  if (v >= SCHEMA_VERSION) return;
  // 1) tablas e índices que falten (las columnas nuevas de tablas antiguas se añaden después)
  for (const sql of SCHEMA) {
    if (/^CREATE INDEX/i.test(sql)) continue;
    await run(env, sql);
  }
  // 2) columnas nuevas en tablas que ya existían
  for (const [table, col] of COLUMNS) await run(env, `ALTER TABLE ${table} ADD COLUMN ${col}`);
  // 3) cambios de estructura (las columnas nuevas ya están, así que la copia de filas cuadra)
  await ensureCheck(env, 'movements', 'ajuste', 'produccion');
  await ensureCheck(env, 'orders', 'borrador', 'pendiente');
  for (const fn of EXTRA) await fn(env, run);
  // disparadores del stock (después de rehacer tablas, que los borraría) y cálculo inicial
  for (const sql of STOCK_TRIGGERS) await run(env, sql);
  if (v < 11) await recomputeStock(env);
  if (v < 13) await rebuildProductSuppliers(env);
  // 4) índices (ya con todas las columnas)
  for (const sql of SCHEMA.filter((s) => /^CREATE INDEX/i.test(s))) await run(env, sql);
  // datos
  await run(env, `UPDATE users SET is_super = 1 WHERE role = 'direccion' AND NOT EXISTS (SELECT 1 FROM users WHERE is_super = 1)`);
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(SCHEMA_VERSION)).run();
}

// Qué proveedores han traído cada artículo (según los albaranes y facturas), con su último precio.
// En el artículo se guarda la lista de los que no son el habitual, para no tener que leer los albaranes en cada pantalla.
export async function rebuildProductSuppliers(env) {
  await env.DB.batch([
    // los apuntados a mano (receipts = 0) se conservan mientras exista el artículo; los de los albaranes se rehacen
    env.DB.prepare('DELETE FROM product_suppliers WHERE receipts > 0 OR product_id NOT IN (SELECT id FROM products) OR supplier_id NOT IN (SELECT id FROM suppliers)'),
    env.DB.prepare(`INSERT OR REPLACE INTO product_suppliers (product_id, supplier_id, last_price, last_date, receipts)
      SELECT product_id, supplier_id, price, d, n FROM (
        SELECT rl.product_id, r.supplier_id, rl.price, r.receipt_date AS d,
               COUNT(*) OVER (PARTITION BY rl.product_id, r.supplier_id) AS n,
               ROW_NUMBER() OVER (PARTITION BY rl.product_id, r.supplier_id ORDER BY r.receipt_date DESC, r.id DESC) AS rn
        FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id WHERE r.supplier_id IS NOT NULL) WHERE rn = 1`),
    env.DB.prepare(`UPDATE products SET other_suppliers = (SELECT GROUP_CONCAT(ps.supplier_id) FROM product_suppliers ps
      WHERE ps.product_id = products.id AND ps.supplier_id <> COALESCE(products.supplier_id, 0))`),
  ]);
}
