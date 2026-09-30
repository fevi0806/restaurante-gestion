// Actualización automática de la base de datos.
// Al arrancar una versión nueva, la app crea las tablas que falten y añade las columnas nuevas.
// Todo es repetible: si algo ya existe, se ignora. Así nunca hay que pegar SQL en la consola.
import { SCHEMA } from './schema.js';

export const SCHEMA_VERSION = 9;

// Columnas añadidas después de la primera versión (para bases de datos ya creadas)
const COLUMNS = [
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
];

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
  if (!ready) ready = migrate(env).catch((e) => { ready = null; throw e; });
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
  // 4) índices (ya con todas las columnas)
  for (const sql of SCHEMA.filter((s) => /^CREATE INDEX/i.test(s))) await run(env, sql);
  // datos
  await run(env, `UPDATE users SET is_super = 1 WHERE role = 'direccion' AND NOT EXISTS (SELECT 1 FROM users WHERE is_super = 1)`);
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(SCHEMA_VERSION)).run();
}
