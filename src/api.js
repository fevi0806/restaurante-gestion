// API de la aplicación de gestión del restaurante (Cloudflare Workers + D1)
import { ensureSchema, SCHEMA_VERSION } from './migrate.js';
import { turnos, publicSchedule } from './turnos.js';
import { push, enqueuePush, pushUsersWith } from './push.js';

const ALL = ['direccion', 'cocina', 'sala'];

// Los 14 alérgenos de declaración obligatoria (Reglamento UE 1169/2011)
const ALLERGENS = ['gluten', 'crustaceos', 'huevos', 'pescado', 'cacahuetes', 'soja', 'lacteos', 'frutos_cascara', 'apio', 'mostaza', 'sesamo', 'sulfitos', 'altramuces', 'moluscos'];

// Diccionario de hostelería para sugerir alérgenos a partir del nombre del artículo.
// Es una ayuda: la referencia legal es la etiqueta o ficha técnica del proveedor.
const ALLERGEN_WORDS = {
  gluten: ['harina', 'trigo', 'salsa de soja', 'pan', 'panko', 'rebozad', 'empanad', 'pasta', 'espagueti', 'macarron', 'tallarin', 'fideo', 'cebada', 'centeno', 'avena', 'espelta', 'kamut', 'semola', 'cuscus', 'bulgur', 'seitan', 'galleta', 'bizcocho', 'hojaldre', 'masa', 'picatoste', 'cerveza', 'malta', 'croqueta', 'tortillita', 'rosca', 'molleta', 'bollo', 'brioche', 'tostada', 'regaña', 'pizza', 'lasaña', 'canelon', 'gnocchi', 'cuscús', 'bechamel', 'rebozado'],
  crustaceos: ['gamba', 'langostino', 'cigala', 'bogavante', 'langosta', 'cangrejo', 'buey de mar', 'centolla', 'necora', 'camaron', 'carabinero', 'quisquilla', 'galera', 'santiaguino', 'krill', 'surimi', 'tortillita de camaron'],
  huevos: ['huevo', 'yema', 'clara', 'mayonesa', 'alioli', 'ali oli', 'tortilla', 'merengue', 'flan', 'natilla', 'tartara', 'rebozad', 'brioche', 'pasta fresca', 'huevas'],
  pescado: ['pescado', 'merluza', 'bacalao', 'atun', 'bonito', 'boqueron', 'anchoa', 'sardina', 'caballa', 'jurel', 'salmon', 'dorada', 'lubina', 'corvina', 'urta', 'pargo', 'rape', 'rodaballo', 'lenguado', 'acedia', 'pijota', 'pescadilla', 'cazon', 'raya', 'pez espada', 'emperador', 'mero', 'besugo', 'salmonete', 'chopito', 'huevas', 'mojama', 'caldo de pescado', 'fumet', 'surimi', 'tollo', 'bienmesabe', 'japuta', 'palometa', 'breca', 'herrera', 'baila'],
  cacahuetes: ['cacahuete', 'mani', 'maní'],
  soja: ['soja', 'tofu', 'edamame', 'miso', 'tempeh', 'salsa de soja', 'lecitina de soja'],
  lacteos: ['leche', 'queso', 'nata', 'mantequilla', 'yogur', 'kefir', 'requeson', 'mozzarella', 'parmesano', 'burrata', 'mascarpone', 'ricotta', 'cuajada', 'bechamel', 'helado', 'lactosa', 'suero', 'crema de leche', 'ghee', 'payoyo', 'manchego'],
  frutos_cascara: ['almendra', 'nuez', 'nueces', 'avellana', 'pistacho', 'anacardo', 'castaña', 'pecana', 'macadamia', 'pinon', 'piñon', 'praline', 'turron', 'mazapan', 'frutos secos', 'romesco'],
  apio: ['apio', 'apionabo'],
  mostaza: ['mostaza'],
  sesamo: ['sesamo', 'sésamo', 'ajonjoli', 'tahini', 'tahin', 'hummus'],
  sulfitos: ['vino', 'vinagre', 'jerez', 'manzanilla', 'fino', 'oloroso', 'amontillado', 'pedro ximenez', 'moscatel', 'cava', 'champan', 'sidra', 'vermut', 'brandy', 'uva pasa', 'pasas', 'orejon', 'fruta desecada', 'mosto', 'sulfito', 'membrillo', 'salchicha', 'chorizo', 'cerveza'],
  altramuces: ['altramuz', 'altramuces', 'chocho'],
  moluscos: ['calamar', 'choco', 'sepia', 'pulpo', 'chipiron', 'puntillita', 'almeja', 'chirla', 'coquina', 'berberecho', 'mejillon', 'ostra', 'vieira', 'zamburiña', 'navaja', 'longueiron', 'caracol', 'bigaro', 'burgado', 'lapa', 'bocina', 'cañailla', 'cañadilla', 'volandeira', 'oreja de mar', 'pota'],
};
function dictAllergens(name) {
  const n = ' ' + String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ') + ' ';
  const out = [];
  for (const [k, words] of Object.entries(ALLERGEN_WORDS)) {
    if (words.some((w) => n.includes(' ' + w.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))) out.push(k);
  }
  // "fino" o "manzanilla" solo cuentan como vino si no son otra cosa evidente
  if (out.includes('sulfitos') && /\b(manzanilla)\b/.test(n) && /\b(infusion|te|flor)\b/.test(n)) out.splice(out.indexOf('sulfitos'), 1);
  return out;
}

async function aiAllergens(env, names) {
  if (!env.AI || !names.length) return {};
  const prompt = `Eres técnico de seguridad alimentaria en un restaurante de Cádiz (España). Para cada artículo de almacén, indica qué alérgenos de declaración obligatoria (Reglamento UE 1169/2011) contiene normalmente.
Claves permitidas: ${ALLERGENS.join(', ')}.
Responde SOLO con un objeto JSON cuyas claves sean los nombres exactamente como te los doy y cuyos valores sean listas de claves (lista vacía si no contiene ninguno). No añadas explicaciones.
Artículos:
${names.map((x) => '- ' + x).join('\n')}`;
  try {
    const out = await env.AI.run(env.ALLERGEN_MODEL || env.OCR_CF_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: 2000 });
    const obj = out && typeof out.response === 'object' ? out.response : JSON.parse(String(out?.response || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
    const res = {};
    for (const [k, v] of Object.entries(obj || {})) if (Array.isArray(v)) res[k.trim().toLowerCase()] = v.map(String).filter((x) => ALLERGENS.includes(x));
    return res;
  } catch { return {}; }
}

// tablas de módulos posteriores que también entran en la copia
const BACKUP_EXTRA = ['appcc_equipment', 'appcc_temps', 'appcc_tasks', 'appcc_cleaning', 'staff', 'shift_templates', 'shifts', 'schedule_weeks'];

// ---------- permisos ----------
// El superusuario lo puede todo y decide con casillas qué puede hacer cada persona.
const PERMS = [
  'panel.ver', 'informes.ver', 'costes.ver',
  'caja.registrar', 'caja.ver',
  'pedidos.ver', 'pedidos.crear', 'pedidos.aprobar',
  'recepcion.ver', 'recepcion.crear', 'recepcion.anular',
  'mermas.registrar', 'mermas.ver_todas', 'mermas.borrar',
  'stock.ver', 'inventario.hacer',
  'escandallos.ver', 'escandallos.editar', 'produccion.registrar',
  'productos.editar', 'ventas.gestionar', 'gastos.gestionar',
  'appcc.registrar', 'appcc.gestionar',
  'turnos.ver', 'turnos.gestionar',
];
const TEMPLATES = {
  sala: ['caja.registrar', 'mermas.registrar', 'escandallos.ver', 'appcc.registrar', 'turnos.ver'],
  cocina: ['pedidos.ver', 'pedidos.crear', 'recepcion.ver', 'recepcion.crear', 'mermas.registrar', 'mermas.ver_todas', 'stock.ver', 'inventario.hacer', 'escandallos.ver', 'escandallos.editar', 'produccion.registrar', 'productos.editar', 'costes.ver', 'appcc.registrar', 'appcc.gestionar', 'turnos.ver'],
  direccion: PERMS,
};
const permsOf = (u) => {
  if (u.is_super) return PERMS;
  try { const p = JSON.parse(u.perms || 'null'); if (Array.isArray(p)) return p.filter((x) => PERMS.includes(x)); } catch { /* plantilla */ }
  return TEMPLATES[u.role] || [];
};
const can = (user, perm) => !!user && (user.is_super || (perm !== 'super' && user.perms.includes(perm)));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

const r2 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const uuid = () => crypto.randomUUID();
const todayStr = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ---------- contraseñas y sesiones ----------
const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array(h.match(/.{2}/g).map((x) => parseInt(x, 16)));

// Las iteraciones se guardan con el hash. 10.000 cabe holgado en el límite de 10 ms de CPU del plan gratuito de Workers.
const PBKDF2_ITER = 10000;
async function hashPass(pass, saltHex, iterations = PBKDF2_ITER) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${toHex(salt)}$${toHex(bits)}`;
}
async function checkPass(pass, stored) {
  const s = String(stored);
  if (s.startsWith('pbkdf2$')) {
    const [, iter, salt] = s.split('$');
    return (await hashPass(pass, salt, Number(iter))) === s;
  }
  // formato de la primera versión (salt:hash, 100.000 iteraciones)
  const [salt, hash] = s.split(':');
  const again = await hashPass(pass, salt, 100000);
  return again.split('$')[3] === hash;
}
async function sha256(s) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

async function getUser(request, env) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const u = await env.DB.prepare(
    `SELECT u.id, u.name, u.username, u.role, u.is_super, u.perms FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`
  ).bind(m[1]).first();
  if (!u) return null;
  return { id: u.id, name: u.name, username: u.username, role: u.role, is_super: !!u.is_super, perms: permsOf(u) };
}

function need(user, perm) {
  if (!user) throw new HttpError(401, 'Sesión caducada. Vuelve a entrar.');
  const list = Array.isArray(perm) ? perm : [perm];
  if (!list.some((p) => can(user, p))) throw new HttpError(403, 'No tienes permiso para esto. Pídeselo al responsable.');
}

async function body(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Datos no válidos'); }
}

async function settings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return { restaurant_name: s.restaurant_name || 'Mi restaurante', iva_pct: Number(s.iva_pct ?? 10), food_cost_target: Number(s.food_cost_target ?? 30),
    misc_pct: Number(s.misc_pct ?? 3), last_backup: s.last_backup || null, expected_revenue: s.expected_revenue ? Number(s.expected_revenue) : null, qamarero_cols: s.qamarero_carta_cols ? JSON.parse(s.qamarero_carta_cols) : null };
}

// ---------- consultas reutilizables ----------
const PRODUCTS_SQL = `
  SELECT p.id, p.name, p.category, p.unit, p.price, p.supplier_id, p.min_stock, p.allergens, p.allergens_checked, p.prep_recipe_id, s.name AS supplier_name,
         COALESCE((SELECT SUM(m.qty) FROM movements m WHERE m.product_id = p.id), 0) AS stock
  FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
  WHERE p.active = 1 ORDER BY p.category, p.name`;

// Rendimiento de una línea: lo que queda tras limpiar y cocinar (máx. 95 % de pérdida en total)
const YIELD_SQL = `MAX((1 - MIN(rl.waste_pct, 95) / 100.0) * (1 - MIN(COALESCE(rl.cook_loss_pct, 0), 95) / 100.0), 0.05)`;
const lineYield = (l) => Math.max((1 - Math.min(l.waste_pct || 0, 95) / 100) * (1 - Math.min(l.cook_loss_pct || 0, 95) / 100), 0.05);

const RECIPES_SQL = `
  SELECT r.id, r.name, r.category, r.pvp, r.portions, r.pos_name, r.notes, r.allergens_extra,
         COALESCE(r.kind, 'plato') AS kind, r.yield_qty, r.yield_unit, r.product_id,
         COALESCE(SUM(rl.qty / ${YIELD_SQL} * p.price), 0) / NULLIF(r.portions, 0) AS raw_cost,
         COALESCE(SUM(rl.qty / ${YIELD_SQL} * p.price), 0) / NULLIF(r.portions, 0)
           * (1 + COALESCE(r.misc_pct, (SELECT CAST(value AS REAL) FROM settings WHERE key = 'misc_pct'), 0) / 100.0) AS cost,
         COALESCE(r.misc_pct, (SELECT CAST(value AS REAL) FROM settings WHERE key = 'misc_pct'), 0) AS misc_pct,
         COUNT(rl.id) AS n_lines, GROUP_CONCAT(p.allergens) AS ing_allergens, GROUP_CONCAT(rl.product_id) AS ing_products,
         SUM(CASE WHEN rl.id IS NOT NULL AND COALESCE(p.allergens_checked, 0) = 0 THEN 1 ELSE 0 END) AS alg_unchecked
  FROM recipes r
  LEFT JOIN recipe_lines rl ON rl.recipe_id = r.id
  LEFT JOIN products p ON p.id = rl.product_id
  WHERE r.active = 1 GROUP BY r.id ORDER BY r.category, r.name`;

// Ingredientes brutos por RACIÓN de una receta
async function recipePerPortion(env, recipeId) {
  const r = await env.DB.prepare('SELECT id, name, portions FROM recipes WHERE id = ? AND active = 1').bind(recipeId).first();
  if (!r) throw new HttpError(404, 'Plato no encontrado');
  const { results } = await env.DB.prepare(
    `SELECT rl.product_id, rl.qty, rl.waste_pct, rl.cook_loss_pct, p.price, p.name, p.unit FROM recipe_lines rl JOIN products p ON p.id = rl.product_id WHERE rl.recipe_id = ?`
  ).bind(recipeId).all();
  const portions = Number(r.portions) || 1;
  return {
    recipe: r,
    lines: results.map((l) => ({ ...l, gross: l.qty / lineYield(l) / portions })),
  };
}

// Gastos fijos imputados a los platos en proporción a las ventas:
// % = gastos fijos mensuales ÷ facturación mensual (sin IVA). A cada plato le toca ese % de su PVP sin IVA.
async function fixedShare(env, st) {
  const { results } = await env.DB.prepare('SELECT amount, frequency FROM fixed_costs WHERE active = 1').all();
  const monthly = results.reduce((t, f) => t + f.amount / (f.frequency === 'anual' ? 12 : f.frequency === 'trimestral' ? 3 : 1), 0);
  let revenue = st.expected_revenue, source = 'prevista', note = null;
  if (!revenue) {
    // media real: ventas (o caja) de los últimos 90 días, repartidas entre los días que cubren los datos
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const days = (a, b) => (new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000 + 1;
    const s = await env.DB.prepare(`SELECT SUM(s.revenue) AS v, MIN(si.date_from) AS d0, MAX(si.date_to) AS d1 FROM sales s JOIN sales_imports si ON si.id = s.import_id WHERE s.sale_date >= ?`).bind(since).first();
    const c = await env.DB.prepare('SELECT SUM(cash + card + bizum + other) AS v, MIN(day) AS d0, MAX(day) AS d1 FROM cash_days WHERE day >= ?').bind(since).first();
    const pick = (x, div, label) => {
      if (!(x.v > 0)) return false;
      const n = days(x.d0 < since ? since : x.d0, x.d1);
      if (n < 14) { note = `solo hay ${Math.round(n)} días de ${label}; hacen falta al menos 14 o una facturación prevista en Ajustes`; return false; }
      revenue = (x.v / div / n) * 30.4375; source = `${label} (últimos ${Math.round(n)} días)`; return true;
    };
    if (!pick(s, 1, 'ventas Qamarero')) pick(c, 1 + st.iva_pct / 100, 'caja real');
  }
  return { monthly, revenue: revenue || null, pct: revenue ? (monthly / revenue) * 100 : null, source: revenue ? source : null, note };
}

// Cloudflare D1 admite como mucho 100 valores por consulta: las listas largas de ids se consultan por tandas
async function allIn(env, sql, ids, pre = [], post = []) {
  const out = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(sql.replace('(??)', `(${part.map(() => '?').join(',')})`)).bind(...pre, ...part, ...post).all();
    out.push(...results);
  }
  return { results: out };
}

async function runBatch(env, stmts) {
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}

// ---------- unidades y formatos ----------
// Cada producto tiene una unidad base (kg, l o ud). Se puede escribir en submúltiplos (g, ml, cl)
// o en cualquiera de sus formatos ("f:<id>", p. ej. Caja 24 = 24 ud). Todo se guarda en unidad base.
const SUBUNITS = { kg: { g: 0.001, kg: 1 }, l: { ml: 0.001, cl: 0.01, l: 1 }, ud: { ud: 1 } };

async function unitCtx(env, productIds) {
  const ids = [...new Set(productIds.map(Number).filter(Boolean))];
  if (!ids.length) return { pmap: {}, fmap: {} };
  const [{ results: prods }, { results: fmts }] = await Promise.all([
    allIn(env, 'SELECT id, name, unit, price FROM products WHERE id IN (??)', ids),
    allIn(env, 'SELECT * FROM product_formats WHERE product_id IN (??)', ids),
  ]);
  return { pmap: Object.fromEntries(prods.map((p) => [p.id, p])), fmap: Object.fromEntries(fmts.map((f) => [f.id, f])) };
}

// Devuelve { factor, label } para convertir una cantidad escrita en `unit` a la unidad base del producto
function unitInfo(p, unit, fmap) {
  if (!unit || unit === p.unit) return { factor: 1, label: p.unit };
  if (String(unit).startsWith('f:')) {
    const f = fmap[Number(String(unit).slice(2))];
    if (!f || f.product_id !== p.id) throw new HttpError(400, `Formato no válido para ${p.name}`);
    return { factor: Number(f.factor), label: f.name, format: f };
  }
  const s = SUBUNITS[p.unit]?.[unit];
  if (s == null) throw new HttpError(400, `La unidad "${unit}" no sirve para ${p.name} (se controla en ${p.unit})`);
  return { factor: s, label: unit };
}

async function syncFormats(env, productId, formats) {
  const { results: existing } = await env.DB.prepare('SELECT id, name FROM product_formats WHERE product_id = ?').bind(productId).all();
  const keep = new Set();
  const stmts = [];
  const clean = formats.filter((f) => String(f.name || '').trim() && Number(f.factor) > 0);
  const hasDefault = clean.some((f) => f.is_default);
  clean.forEach((f, i) => {
    const name = String(f.name).trim();
    const isDef = f.is_default ? 1 : !hasDefault && i === 0 ? 1 : 0;
    const price = Number(f.price) > 0 ? Number(f.price) : null;
    const ex = existing.find((e) => (f.id && e.id === Number(f.id)) || e.name.toLowerCase() === name.toLowerCase());
    if (ex) {
      keep.add(ex.id);
      stmts.push(env.DB.prepare('UPDATE product_formats SET name = ?, factor = ?, price = ?, is_default = ?, active = 1 WHERE id = ?').bind(name, Number(f.factor), price, isDef, ex.id));
    } else {
      stmts.push(env.DB.prepare('INSERT INTO product_formats (product_id, name, factor, price, is_default) VALUES (?,?,?,?,?)').bind(productId, name, Number(f.factor), price, isDef));
    }
  });
  for (const e of existing) if (!keep.has(e.id)) stmts.push(env.DB.prepare('UPDATE product_formats SET active = 0, is_default = 0 WHERE id = ?').bind(e.id));
  if (stmts.length) await runBatch(env, stmts);
}
// Añade los formatos que aún no tiene el artículo, sin tocar ni quitar los que ya hay.
async function addMissingFormats(env, productId, formats) {
  const { results: existing } = await env.DB.prepare('SELECT id, name, active FROM product_formats WHERE product_id = ?').bind(productId).all();
  const stmts = [];
  for (const f of formats) {
    const name = String(f.name || '').trim();
    if (!name || !(Number(f.factor) > 0)) continue;
    const ex = existing.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (ex && ex.active) continue;
    if (ex) stmts.push(env.DB.prepare('UPDATE product_formats SET factor = ?, active = 1 WHERE id = ?').bind(Number(f.factor), ex.id));
    else stmts.push(env.DB.prepare('INSERT INTO product_formats (product_id, name, factor, price, is_default) VALUES (?,?,?,?,0)').bind(productId, name, Number(f.factor), Number(f.price) > 0 ? Number(f.price) : null));
  }
  if (stmts.length) await runBatch(env, stmts);
}

// ---------- CRUD genérico de maestros ----------
const TABLES = {
  suppliers: { cols: ['name', 'contact', 'phone', 'email', 'order_days', 'notes', 'cif'], read: null, write: 'productos.editar', required: ['name'] },
  products: { cols: ['name', 'category', 'unit', 'price', 'supplier_id', 'min_stock', 'allergens', 'allergens_checked'], read: null, write: 'productos.editar', required: ['name', 'unit'] },
  fixed_costs: { cols: ['concept', 'category', 'amount', 'frequency', 'notes'], read: 'gastos.gestionar', write: 'gastos.gestionar', required: ['concept'] },
};

function pick(obj, cols) {
  const out = {};
  for (const c of cols) if (c in obj) out[c] = obj[c] === '' ? null : obj[c];
  return out;
}

async function crud(table, id, method, request, env, user, ctx = {}) {
  const cfg = TABLES[table];
  if (method === 'GET') {
    if (cfg.read) need(user, cfg.read);
    const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE active = 1 ORDER BY 2`).all();
    return json(results);
  }
  need(user, (method === 'POST' && ctx.createPerm) || cfg.write);
  if (method === 'DELETE') {
    const old = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
    if (table === 'products' && old?.prep_recipe_id) throw new HttpError(400, 'Este artículo es una elaboración: se gestiona desde Carta → Elaboraciones');
    if (old) ctx.audit = { action: 'baja', summary: `Baja de ${ENTITY[table]} "${old.name || old.concept}"`, detail: old };
    await env.DB.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  }
  const data = pick(await body(request), cfg.cols);
  if (method === 'POST') {
    for (const c of cfg.required) if (!data[c]) throw new HttpError(400, `Falta el campo ${c}`);
    const keys = Object.keys(data);
    // Un artículo dado de baja con el mismo nombre no se ve en ninguna lista: se reactiva en vez de dar "ya existe".
    if (table === 'products') {
      const ex = await env.DB.prepare('SELECT id, active, prep_recipe_id FROM products WHERE name = ? COLLATE NOCASE').bind(data.name).first();
      if (ex && !ex.active && !ex.prep_recipe_id) {
        await env.DB.prepare(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, active = 1 WHERE id = ?`).bind(...keys.map((k) => data[k]), ex.id).run();
        ctx.audit = { action: 'alta', summary: `Reactivación de ${ENTITY[table]} "${data.name}"` };
        return json({ id: ex.id, reactivated: true });
      }
      // Desde la recepción: si ya existe, se usa ese artículo.
      if (ex && ctx.reuseExisting) { ctx.audit = false; return json({ id: ex.id, existing: true }); }
    }
    try {
      const row = await env.DB.prepare(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) RETURNING id`
      ).bind(...keys.map((k) => data[k])).first();
      return json({ id: row.id });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe uno con ese nombre');
      throw e;
    }
  }
  if (method === 'PUT') {
    const keys = Object.keys(data);
    if (!keys.length) return json({ ok: true });
    const old = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
    if (old) {
      const changes = keys.filter((k) => String(old[k] ?? '') !== String(data[k] ?? '')).map((k) => `${k}: ${old[k] ?? '—'} → ${data[k] ?? '—'}`);
      ctx.audit = { action: 'modificación', summary: `Modificación de ${ENTITY[table]} "${old.name || old.concept}"${changes.length ? ': ' + changes.join('; ').slice(0, 300) : ''}`, detail: old };
    }
    try {
      await env.DB.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .bind(...keys.map((k) => data[k]), id).run();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe uno con ese nombre');
      throw e;
    }
    return json({ ok: true });
  }
  throw new HttpError(405, 'Método no permitido');
}

// ---------- router ----------
export async function onRequest({ request, env, params, ctx: wctx }) {
  const url = new URL(request.url);
  const parts = Array.isArray(params.route) ? params.route : [params.route].filter(Boolean);
  try {
    await ensureSchema(env);
  } catch (e) {
    console.error(e);
    return json({ error: 'No se pudo preparar la base de datos: ' + e.message }, 500);
  }
  const ctx = { audit: null, user: null };
  const mutating = !['GET', 'HEAD'].includes(request.method);
  // copia del cuerpo para el registro de actividad (sin fotos ni archivos)
  let raw = null;
  if (mutating && !['ocr', 'backup'].includes(parts[0])) raw = await request.clone().text().catch(() => null);
  try {
    const res = await route(parts, request.method, request, env, url, ctx);
    if (res.ok && (ctx.afterPrices || (mutating && ['products', 'receipts'].includes(parts[0])))) await refreshPrepCosts(env);
    // las ventas ya volcadas se calcularon con los escandallos de entonces: se apunta que han cambiado
    if (res.ok && mutating && parts[0] === 'recipes' && !(parts[1] === 'bulk-edit'))
      await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('recipes_changed_at', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    if (mutating && res.ok && ctx.user && ctx.audit !== false) {
      const p = writeAudit(env, ctx, parts, request.method, raw).catch((e) => console.error('auditoría', e));
      if (wctx?.waitUntil) wctx.waitUntil(p); else await p;
    }
    return res;
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Error del servidor: ' + e.message }, 500);
  }
}

// ---------- registro de actividad ----------
const ENTITY = { products: 'artículo', suppliers: 'proveedor', fixed_costs: 'gasto fijo', users: 'usuario', orders: 'pedido', receipts: 'recepción',
  movements: 'merma / consumo', inventory: 'inventario', recipes: 'plato', sales: 'ventas', 'pos-aliases': 'vínculo Qamarero', 'pos-pending': 'ventas pendientes',
  settings: 'ajustes', cash: 'caja', allergens: 'alérgenos', appcc: 'APPCC', production: 'producción', backup: 'copia de seguridad', integrations: 'integración', turnos: 'turnos', push: 'avisos' };
function cleanBody(raw) {
  let d = null;
  try { d = raw ? JSON.parse(raw) : null; } catch { return null; }
  if (!d || typeof d !== 'object') return d;
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (['password', 'pass', 'photo', 'files'].includes(k)) out[k] = '(oculto)';
    else if (Array.isArray(v) && v.length > 20) out[k] = `(${v.length} elementos)`;
    else out[k] = v;
  }
  return out;
}
function describe(parts, method, d) {
  const [a, b, c] = parts;
  const ent = ENTITY[a] || a;
  const name = d?.name || d?.concept || d?.delivery_note || '';
  const verb = method === 'DELETE' ? 'baja' : method === 'POST' ? 'alta' : 'modificación';
  if (b === 'bulk') return ['importación', ent, null, `Importación masiva de ${ent}s (${d?.items?.length ?? '?'} filas)`];
  if (b === 'bulk-edit') return ['edición en lista', ent, null, `Edición en lista de ${ent}s (${d?.items?.length ?? '?'} cambiados)`];
  if (a === 'orders' && c === 'status') return ['cambio de estado', ent, b, `Pedido #${b} → ${d?.status}`];
  if (a === 'users' && method === 'PUT') return ['modificación', ent, b, `Usuario #${b}: ${Object.keys(d || {}).filter((k) => k !== 'password').join(', ')}${d?.password ? ' y contraseña' : ''}`];
  if (a === 'settings' && b === 'api-key') return ['clave nueva', 'integración', null, 'Nueva clave para el volcado automático de ventas'];
  if (a === 'login') return ['entrada', 'sesión', null, 'Inicio de sesión'];
  return [verb, ent, b || null, `${verb[0].toUpperCase() + verb.slice(1)} de ${ent}${b ? ' #' + b : ''}${name ? ` "${name}"` : ''}`];
}
async function writeAudit(env, ctx, parts, method, raw) {
  if (['logout', 'setup'].includes(parts[0])) return;
  const d = cleanBody(raw);
  let [action, entity, id, summary] = describe(parts, method, d);
  const extra = ctx.audit || {};
  await env.DB.prepare('INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, summary, detail) VALUES (?,?,?,?,?,?,?)')
    .bind(ctx.user.id, ctx.user.name, extra.action || action, extra.entity || entity, String(extra.id ?? id ?? '') || null, extra.summary || summary,
      JSON.stringify({ datos: d, ...(extra.detail ? { antes: extra.detail } : {}) }).slice(0, 20000)).run();
}

async function route(parts, method, request, env, url, ctx = {}) {
  const [a, b, c] = parts;

  // --- arranque y sesión ---
  if (a === 'setup-status') {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    return json({ needsSetup: r.n === 0 });
  }
  if (a === 'setup' && method === 'POST') {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (r.n > 0) throw new HttpError(400, 'La aplicación ya está configurada');
    const d = await body(request);
    if (!d.name || !d.username || String(d.password || '').length < 6) throw new HttpError(400, 'Nombre, usuario y contraseña (mín. 6 caracteres)');
    await env.DB.prepare('INSERT INTO users (name, username, pass, role, is_super) VALUES (?,?,?,?,1)')
      .bind(d.name, d.username.trim(), await hashPass(d.password), 'direccion').run();
    if (d.restaurant_name) await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'restaurant_name'`).bind(d.restaurant_name).run();
    return json({ ok: true });
  }
  if (a === 'login' && method === 'POST') {
    const d = await body(request);
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const k = `${String(d.username || '').trim().toLowerCase()}|${ip}`;
    const fails = await env.DB.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE k = ? AND at > datetime('now', '-15 minutes')`).bind(k).first();
    if (fails.n >= 5) throw new HttpError(429, 'Demasiados intentos fallidos. Espera 15 minutos y vuelve a probar.');
    const u = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND active = 1').bind(String(d.username || '').trim()).first();
    if (!u || !(await checkPass(String(d.password || ''), u.pass))) {
      await env.DB.batch([env.DB.prepare('INSERT INTO login_attempts (k) VALUES (?)').bind(k), env.DB.prepare(`DELETE FROM login_attempts WHERE at < datetime('now', '-1 day')`)]);
      throw new HttpError(401, fails.n >= 3 ? `Usuario o contraseña incorrectos. Te quedan ${4 - fails.n} intento(s) antes de un bloqueo de 15 minutos.` : 'Usuario o contraseña incorrectos');
    }
    await env.DB.prepare('DELETE FROM login_attempts WHERE k = ?').bind(k).run();
    ctx.user = { id: u.id, name: u.name };
    const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`),
      env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`).bind(token, u.id),
    ]);
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    return json({ ok: true }, 200, { 'set-cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}` });
  }
  if (a === 'logout') {
    const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([^;]+)/);
    if (m) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(m[1]).run();
    return json({ ok: true }, 200, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
  }

  // --- entrada automática de ventas (Qamarero u otro sistema) con clave secreta ---
  if (a === 'integrations' && b === 'sales' && method === 'POST') {
    const auth = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
    const stored = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'sales_api_key_hash'`).first();
    if (!auth || !stored || (await sha256(auth)) !== stored.value) throw new HttpError(401, 'Clave no válida');
    const d = await body(request);
    const day = todayStr();
    const from = isDate(d.date_from) ? d.date_from : isDate(d.date) ? d.date : day;
    const to = isDate(d.date_to) ? d.date_to : from;
    const admin = await env.DB.prepare(`SELECT id FROM users WHERE role = 'direccion' AND active = 1 ORDER BY id LIMIT 1`).first();
    const { matched, pending } = await matchPosRows(env, d.rows || []);
    const out = { matched: matched.length, pending: pending.length };
    if (matched.length) out.import = await importSales(env, admin?.id || null, { date_from: from, date_to: to, filename: d.source || 'automático', rows: matched });
    if (pending.length) await savePending(env, pending, from, to, d.source || 'automático');
    return json(out);
  }

  // cuadrante publicado: se ve con el enlace, sin entrar
  if (a === 'public' && b === 'turnos' && c && method === 'GET') return publicSchedule(env, c);

  const user = await getUser(request, env);
  if (!user) throw new HttpError(401, 'Sesión caducada. Vuelve a entrar.');
  ctx.user = user;
  if (a === 'turnos') return turnos(env, user, ctx, method, b, c, request, url);
  if (a === 'push') return push(env, user, ctx, method, b, request, url);
  // las consultas masivas de lectura no se registran
  if (a === 'allergens' || (a === 'sales' && b === 'match')) ctx.audit = false;

  // --- registro de actividad ---
  if (a === 'audit') {
    need(user, 'super');
    const q = url.searchParams;
    const where = [], binds = [];
    if (q.get('user')) { where.push('user_id = ?'); binds.push(Number(q.get('user'))); }
    if (q.get('entity')) { where.push('entity = ?'); binds.push(q.get('entity')); }
    if (isDate(q.get('from'))) { where.push('at >= ?'); binds.push(q.get('from')); }
    if (isDate(q.get('to'))) { where.push("at < date(?, '+1 day')"); binds.push(q.get('to')); }
    if (q.get('q')) { where.push('summary LIKE ?'); binds.push('%' + q.get('q') + '%'); }
    const { results } = await env.DB.prepare(`SELECT id, at, user_id, user_name, action, entity, entity_id, summary FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`).bind(...binds).all();
    return json(results);
  }
  if (a === 'audit-detail' && b) {
    need(user, 'super');
    return json(await env.DB.prepare('SELECT * FROM audit_log WHERE id = ?').bind(b).first());
  }

  // --- copias de seguridad (por partes, para no pasar el límite de CPU del plan gratuito) ---
  if (a === 'backup') {
    need(user, 'super');
    const TABLES_ORDER = ['settings', 'users', 'suppliers', 'products', 'product_formats', 'price_history', 'orders', 'order_lines', 'receipts', 'receipt_lines',
      'movements', 'inventories', 'inventory_lines', 'recipes', 'recipe_lines', 'sales_imports', 'sales', 'pos_aliases', 'pos_pending', 'fixed_costs', 'cash_days',
      'ocr_scans', 'ocr_aliases', 'audit_log', ...BACKUP_EXTRA];
    const existing = new Set((await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).results.map((r) => r.name));
    const tables = TABLES_ORDER.filter((t) => existing.has(t));
    if (!b) {
      const counts = {};
      for (const t of tables) counts[t] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
      ctx.audit = false;
      return json({ version: SCHEMA_VERSION, tables, counts });
    }
    if (b === 'table' && tables.includes(c) && method === 'GET') {
      ctx.audit = false;
      const off = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      const { results } = await env.DB.prepare(`SELECT * FROM ${c} LIMIT 500 OFFSET ?`).bind(off).all();
      return json(results);
    }
    if (b === 'done' && method === 'POST') {
      await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('last_backup', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
      ctx.audit = { action: 'descarga', entity: 'copia de seguridad', summary: 'Descarga de copia de seguridad completa' };
      return json({ ok: true });
    }
    if (b === 'restore' && method === 'POST') {
      const d = await body(request);
      if (d.confirm !== 'RESTAURAR') throw new HttpError(400, 'Falta la confirmación');
      if (d.wipe) {
        // se vacía todo menos las sesiones, para no echar al que restaura
        const stmts = tables.slice().reverse().filter((t) => t !== 'users').map((t) => env.DB.prepare(`DELETE FROM ${t}`));
        await runBatch(env, stmts);
        ctx.audit = { action: 'restauración', entity: 'copia de seguridad', summary: `Restauración de copia de seguridad del ${String(d.created_at || '').slice(0, 16)}` };
        return json({ ok: true });
      }
      if (d.finish) {
        // usuarios que no estaban en la copia: fuera (salvo quien está restaurando)
        const ids = (d.user_ids || []).map(Number).filter(Boolean);
        if (ids.length) await env.DB.prepare(`DELETE FROM users WHERE id NOT IN (${ids.map(() => '?').join(',')}) AND id <> ?`).bind(...ids, user.id).run();
        await env.DB.prepare(`UPDATE users SET is_super = 1, active = 1 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE is_super = 1 AND active = 1)`).bind(user.id).run();
        ctx.audit = false;
        return json({ ok: true });
      }
      if (!tables.includes(d.table)) throw new HttpError(400, 'Tabla desconocida: ' + d.table);
      const rows = Array.isArray(d.rows) ? d.rows : [];
      const cols = (await env.DB.prepare(`PRAGMA table_info(${d.table})`).all()).results.map((r) => r.name);
      const stmts = rows.map((r) => { const ks = cols.filter((k) => k in r); return env.DB.prepare(`INSERT OR REPLACE INTO ${d.table} (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`).bind(...ks.map((k) => r[k])); });
      await runBatch(env, stmts);
      ctx.audit = false;
      return json({ ok: true, count: rows.length });
    }
  }

  // --- datos iniciales para la app ---
  if (a === 'bootstrap') {
    const [st, sup, prod, rec, fmt] = await Promise.all([
      settings(env),
      env.DB.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name').all(),
      env.DB.prepare(PRODUCTS_SQL).all(),
      env.DB.prepare(RECIPES_SQL).all(),
      env.DB.prepare('SELECT id, product_id, name, factor, price, is_default FROM product_formats WHERE active = 1 ORDER BY product_id, factor').all(),
    ]);
    let products = prod.results, recipes = rec.results, formats = fmt.results;
    if (!can(user, 'costes.ver')) {
      products = products.map(({ price, ...p }) => p);
      recipes = recipes.map(({ cost, raw_cost, ...r }) => r);
      formats = formats.map(({ price, ...f }) => f);
    }
    const fixed = can(user, 'costes.ver') ? await fixedShare(env, st) : null;
    const me = await env.DB.prepare('SELECT id, name, department, token FROM staff WHERE user_id = ? AND active = 1').bind(user.id).first();
    return json({ user, settings: { ...st, qamarero_cols: undefined, has_qamarero_format: !!st.qamarero_cols }, suppliers: sup.results, products, recipes, formats, fixed, allergens: ALLERGENS, me_staff: me || null });
  }

  // --- vínculos Qamarero -> plato ---
  if (a === 'pos-aliases') {
    need(user, 'ventas.gestionar');
    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT a.*, r.name AS recipe_name FROM pos_aliases a LEFT JOIN recipes r ON r.id = a.recipe_id ORDER BY a.pos_name`
      ).all();
      return json(results);
    }
    if (method === 'POST') {
      const d = await body(request);
      if (!d.pos_name || !d.recipe_id) throw new HttpError(400, 'Falta nombre o plato');
      await env.DB.prepare(
        `INSERT INTO pos_aliases (pos_name, recipe_id, factor, pvp) VALUES (?,?,?,?)
         ON CONFLICT(pos_name) DO UPDATE SET recipe_id = excluded.recipe_id, factor = excluded.factor, pvp = excluded.pvp`
      ).bind(String(d.pos_name).trim(), d.recipe_id, Number(d.factor) > 0 ? Number(d.factor) : 1, Number(d.pvp) > 0 ? Number(d.pvp) : null).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && b) {
      await env.DB.prepare('DELETE FROM pos_aliases WHERE id = ?').bind(b).run();
      return json({ ok: true });
    }
  }

  // --- ventas pendientes de vincular ---
  if (a === 'pos-pending') {
    need(user, 'ventas.gestionar');
    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT pos_name, COUNT(*) AS n, SUM(units) AS units, SUM(revenue) AS revenue, MIN(date_from) AS date_from, MAX(date_to) AS date_to,
                GROUP_CONCAT(id) AS ids FROM pos_pending GROUP BY pos_name COLLATE NOCASE ORDER BY units DESC`
      ).all();
      return json(results);
    }
    if (method === 'POST' && b === 'resolve') {
      // vincula un nombre pendiente a un plato y vuelca esas ventas
      const d = await body(request);
      if (!d.pos_name) throw new HttpError(400, 'Falta el nombre');
      const { results: rows } = await env.DB.prepare('SELECT * FROM pos_pending WHERE pos_name = ? COLLATE NOCASE').bind(d.pos_name).all();
      if (d.ignore) {
        await env.DB.prepare('DELETE FROM pos_pending WHERE pos_name = ? COLLATE NOCASE').bind(d.pos_name).run();
        return json({ ok: true, ignored: rows.length });
      }
      if (!d.recipe_id) throw new HttpError(400, 'Elige el plato');
      await env.DB.prepare(
        `INSERT INTO pos_aliases (pos_name, recipe_id, factor, pvp) VALUES (?,?,?,?)
         ON CONFLICT(pos_name) DO UPDATE SET recipe_id = excluded.recipe_id, factor = excluded.factor, pvp = excluded.pvp`
      ).bind(String(d.pos_name).trim(), d.recipe_id, Number(d.factor) > 0 ? Number(d.factor) : 1, Number(d.pvp) > 0 ? Number(d.pvp) : null).run();
      // un volcado por periodo original
      const byPeriod = {};
      for (const r of rows) (byPeriod[r.date_from + '|' + r.date_to] ||= []).push(r);
      for (const [k, list] of Object.entries(byPeriod)) {
        const [from, to] = k.split('|');
        await importSales(env, user.id, {
          date_from: from, date_to: to, filename: `Vinculado: ${d.pos_name}`,
          rows: list.map((r) => ({ recipe_id: d.recipe_id, factor: d.factor, pvp: d.pvp, units: r.units, revenue: r.revenue })),
        });
      }
      await env.DB.prepare('DELETE FROM pos_pending WHERE pos_name = ? COLLATE NOCASE').bind(d.pos_name).run();
      return json({ ok: true, imported: rows.length });
    }
  }

  // --- clave para la entrada automática ---
  if (a === 'settings' && b === 'api-key' && method === 'POST') {
    need(user, 'super');
    const key = 'rk_' + toHex(crypto.getRandomValues(new Uint8Array(24)));
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('sales_api_key_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(await sha256(key)).run();
    return json({ key });
  }

  if (a === 'settings' && method === 'PUT') {
    need(user, 'super');
    const d = await body(request);
    const stmts = ['restaurant_name', 'iva_pct', 'food_cost_target', 'misc_pct', 'expected_revenue'].filter((k) => k in d)
      .map((k) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(d[k])));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }

  // --- maestros ---
  if (a === 'products' && b === 'bulk' && method === 'POST') return productsBulk(request, env, user);
  if (a === 'products' && b === 'bulk-edit' && method === 'PUT') return productsBulkEdit(request, env, user);
  if (a === 'allergens' && b === 'suggest' && method === 'POST') {
    need(user, 'productos.editar');
    const d = await body(request);
    const ids = (d.ids || []).map(Number).filter(Boolean);
    const { results } = ids.length
      ? await allIn(env, 'SELECT id, name, allergens, allergens_checked FROM products WHERE active = 1 AND id IN (??)', ids.slice(0, 300))
      : await env.DB.prepare('SELECT id, name, allergens, allergens_checked FROM products WHERE active = 1 AND COALESCE(allergens_checked, 0) = 0 ORDER BY name LIMIT 300').all();
    results.sort((x, y) => x.name.localeCompare(y.name, 'es'));
    const rows = results.map((p) => ({ id: p.id, name: p.name, current: String(p.allergens || '').split(',').filter(Boolean), checked: !!p.allergens_checked, dict: dictAllergens(p.name), ai: null }));
    let aiUsed = false;
    if (d.use_ai !== false) {
      const ask = rows.filter((r) => !r.dict.length).map((r) => r.name);
      for (let i = 0; i < ask.length; i += 40) {
        const got = await aiAllergens(env, ask.slice(i, i + 40));
        if (Object.keys(got).length) aiUsed = true;
        rows.forEach((r) => { if (r.name.toLowerCase() in got) r.ai = got[r.name.toLowerCase()]; });
      }
    }
    return json({ rows, ai: !!env.AI, ai_used: aiUsed });
  }
  if (a === 'recipes' && b === 'bulk-edit' && method === 'PUT') return recipesBulkEdit(request, env, user);
  if (a === 'recipes' && b === 'export') return recipesExport(env, user);
  if (a === 'suppliers' && b === 'bulk' && method === 'POST') return suppliersBulk(request, env, user);
  if (a === 'products' && (method === 'POST' || method === 'PUT')) {
    const d = await request.clone().json().catch(() => ({}));
    if (d.unit && !['kg', 'l', 'ud'].includes(d.unit)) throw new HttpError(400, 'La unidad base debe ser kg, l o ud. Las cajas, botellas o sacos se añaden como formatos.');
    // Quien recibe mercancía puede dar de alta un artículo nuevo que llega en el albarán (no modificar los existentes).
    if (method === 'POST' && d.from_receipt) { ctx.createPerm = ['productos.editar', 'recepcion.crear']; ctx.reuseExisting = true; }
    const res = await crud(a, b, method, request, env, user, ctx);
    if (res.ok && Array.isArray(d.formats)) {
      const out = method === 'POST' ? await res.clone().json() : null;
      const id = method === 'POST' ? out.id : Number(b);
      // si ya existía, no se le tocan los formatos que tenga: solo se añade el que trae el albarán
      if (!out?.existing) await syncFormats(env, id, d.formats);
      else await addMissingFormats(env, id, d.formats);
    }
    return res;
  }
  if (TABLES[a]) return crud(a, b, method, request, env, user, ctx);

  // --- usuarios y permisos (solo superusuario) ---
  if (a === 'users') {
    need(user, 'super');
    if (method === 'GET') {
      const { results } = await env.DB.prepare('SELECT id, name, username, role, active, is_super, perms, phone, email FROM users ORDER BY active DESC, is_super DESC, name').all();
      return json({ users: results.map((u) => ({ ...u, is_super: !!u.is_super, perms: permsOf(u) })), perms: PERMS, templates: TEMPLATES });
    }
    const d = await body(request);
    if (d.role && !ALL.includes(d.role)) throw new HttpError(400, 'Rol no válido');
    const perms = Array.isArray(d.perms) ? JSON.stringify(d.perms.filter((x) => PERMS.includes(x))) : undefined;
    if (method === 'POST') {
      if (!d.name || !d.username || String(d.password || '').length < 6) throw new HttpError(400, 'Nombre, usuario y contraseña (mín. 6 caracteres)');
      try {
        const r = await env.DB.prepare('INSERT INTO users (name, username, pass, role, is_super, perms, phone, email) VALUES (?,?,?,?,?,?,?,?) RETURNING id')
          .bind(d.name, d.username.trim(), await hashPass(d.password), d.role || 'sala', d.is_super ? 1 : 0, perms ?? JSON.stringify(TEMPLATES[d.role || 'sala']), String(d.phone || '').trim() || null, String(d.email || '').trim() || null).first();
        return json({ id: r.id });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ese nombre de usuario ya existe');
        throw e;
      }
    }
    if (method === 'PUT') {
      const target = Number(b);
      if (target === user.id && (d.active === 0 || d.is_super === false)) throw new HttpError(400, 'No puedes quitarte a ti mismo el acceso de superusuario');
      if (d.is_super === false || d.active === 0) {
        const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE is_super = 1 AND active = 1 AND id <> ?').bind(target).first();
        const t = await env.DB.prepare('SELECT is_super FROM users WHERE id = ?').bind(target).first();
        if (t?.is_super && n.n === 0) throw new HttpError(400, 'Tiene que quedar al menos un superusuario activo');
      }
      const sets = [], vals = [];
      if (d.name) { sets.push('name = ?'); vals.push(d.name); }
      if ('phone' in d) { sets.push('phone = ?'); vals.push(String(d.phone || '').trim() || null); }
      if ('email' in d) { sets.push('email = ?'); vals.push(String(d.email || '').trim() || null); }
      if (d.role) { sets.push('role = ?'); vals.push(d.role); }
      if (d.active === 0 || d.active === 1) { sets.push('active = ?'); vals.push(d.active); }
      if (typeof d.is_super === 'boolean') { sets.push('is_super = ?'); vals.push(d.is_super ? 1 : 0); }
      if (perms !== undefined) { sets.push('perms = ?'); vals.push(perms); }
      if (d.password) {
        if (String(d.password).length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres');
        sets.push('pass = ?'); vals.push(await hashPass(d.password));
      }
      if (sets.length) await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, target).run();
      if (d.active === 0 || d.password) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target).run();
      return json({ ok: true });
    }
  }

  // --- pedidos ---
  if (a === 'orders' && b === 'suggest' && method === 'GET') {
    need(user, 'pedidos.crear');
    ctx.audit = false;
    return json(await suggestOrder(env, Number(url.searchParams.get('supplier_id')), Math.min(Math.max(Number(url.searchParams.get('days')) || 3, 1), 30)));
  }
  if (a === 'orders') {
    need(user, method === 'GET' ? ['pedidos.ver', 'pedidos.crear'] : 'pedidos.crear');
    if (method === 'GET' && !b) {
      const { results } = await env.DB.prepare(
        `SELECT o.*, s.name AS supplier_name, u.name AS user_name,
                (SELECT SUM(qty * COALESCE(price, 0)) FROM order_lines WHERE order_id = o.id) AS total,
                (SELECT COUNT(*) FROM order_lines WHERE order_id = o.id) AS n_lines
         FROM orders o JOIN suppliers s ON s.id = o.supplier_id LEFT JOIN users u ON u.id = o.user_id
         ORDER BY CASE o.status WHEN 'pendiente' THEN 0 WHEN 'enviado' THEN 1 WHEN 'borrador' THEN 2 ELSE 3 END, o.id DESC LIMIT 200`
      ).all();
      return json(results);
    }
    if (method === 'GET' && b === 'approvers') return json(await approvers(env, user.id));
    if (method === 'GET' && b) {
      const o = await env.DB.prepare(
        `SELECT o.*, s.name AS supplier_name, s.phone, s.email, s.contact, u.name AS user_name, ap.name AS approved_by_name
         FROM orders o JOIN suppliers s ON s.id = o.supplier_id LEFT JOIN users u ON u.id = o.user_id LEFT JOIN users ap ON ap.id = o.approved_by WHERE o.id = ?`
      ).bind(b).first();
      if (!o) throw new HttpError(404, 'Pedido no encontrado');
      const { results } = await env.DB.prepare(
        `SELECT ol.*, p.name, p.unit FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY p.name`
      ).bind(b).all();
      return json({ ...o, lines: results, can_edit: canEditOrder(user, o), can_approve: can(user, 'pedidos.aprobar') });
    }
    if ((method === 'POST' && !b) || (method === 'PUT' && b && !c)) {
      const d = await body(request);
      const lines = (d.lines || []).filter((l) => l.product_id && Number(l.qty) > 0);
      if (!d.supplier_id || !lines.length) throw new HttpError(400, 'Elige proveedor y al menos un artículo');
      let prev = null;
      if (method === 'PUT') {
        prev = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(b).first();
        if (!prev) throw new HttpError(404, 'Pedido no encontrado');
        if (!canEditOrder(user, prev)) throw new HttpError(403, prev.status === 'enviado' || prev.status === 'recibido' ? 'Este pedido ya se envió al proveedor y no se puede cambiar' : 'No puedes cambiar este pedido');
      }
      // quien no puede aprobar deja el pedido pendiente de aprobación
      const approver = can(user, 'pedidos.aprobar');
      const status = d.status === 'borrador' ? 'borrador' : approver ? (d.status === 'pendiente' ? 'pendiente' : 'enviado') : 'pendiente';
      const { pmap, fmap } = await unitCtx(env, lines.map((l) => l.product_id));
      const rows = lines.map((l) => {
        const p = pmap[l.product_id];
        if (!p) throw new HttpError(400, 'Artículo no encontrado');
        const u = unitInfo(p, l.unit, fmap);
        return { p, qty: Number(l.qty), base: Number(l.qty) * u.factor, unit: l.unit || p.unit, label: u.label };
      });
      const appr = status === 'enviado' ? [user.id] : [null];
      let o;
      if (prev) {
        o = { id: Number(b) };
        await env.DB.prepare(`UPDATE orders SET supplier_id = ?, status = ?, expected_date = ?, notes = ?, approved_by = ?, approved_at = CASE WHEN ? IS NOT NULL THEN datetime('now') END WHERE id = ?`)
          .bind(d.supplier_id, status, d.expected_date || null, d.notes || null, appr[0], appr[0], o.id).run();
        const old = (await env.DB.prepare('SELECT ol.input_qty, ol.unit_label, p.name FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ?').bind(o.id).all()).results;
        ctx.audit = { action: 'modificación', id: o.id, summary: `Pedido #${o.id} modificado por ${user.name}${status === 'enviado' ? ' y aprobado' : ''}`, detail: { antes: old } };
      } else {
        o = await env.DB.prepare(
          `INSERT INTO orders (supplier_id, status, order_date, expected_date, notes, user_id, approved_by, approved_at) VALUES (?,?,?,?,?,?,?, CASE WHEN ? IS NOT NULL THEN datetime('now') END) RETURNING id`
        ).bind(d.supplier_id, status, todayStr(), d.expected_date || null, d.notes || null, user.id, appr[0], appr[0]).first();
      }
      const stmts = prev ? [env.DB.prepare('DELETE FROM order_lines WHERE order_id = ?').bind(o.id)] : [];
      stmts.push(...rows.map((r) => env.DB.prepare(
        `INSERT INTO order_lines (order_id, product_id, qty, price, input_qty, input_unit, unit_label) VALUES (?,?,?,?,?,?,?)`
      ).bind(o.id, r.p.id, r2(r.base), r.p.price, r.qty, r.unit, r.label)));
      await runBatch(env, stmts);
      if (status === 'pendiente' && (!prev || prev.status !== 'pendiente')) {
        const sup = await env.DB.prepare('SELECT name FROM suppliers WHERE id = ?').bind(d.supplier_id).first();
        await enqueuePush(env, (await approvers(env, user.id)).map((x) => x.id), { title: 'Pedido para aprobar', body: `${user.name} ha hecho un pedido a ${sup?.name || 'un proveedor'} (${rows.length} artículos)`, url: `/#/pedidos/${o.id}`, tag: 'pedido-' + o.id });
      }
      return json({ id: o.id, status, approvers: status === 'pendiente' ? await approvers(env, user.id) : [] });
    }
    if (method === 'PUT' && b && c === 'status') {
      const d = await body(request);
      const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(b).first();
      if (!o) throw new HttpError(404, 'Pedido no encontrado');
      if (!['borrador', 'pendiente', 'enviado', 'cancelado'].includes(d.status)) throw new HttpError(400, 'Estado no válido');
      const approver = can(user, 'pedidos.aprobar');
      if (d.status === 'enviado' && !approver) throw new HttpError(403, 'Solo quien aprueba pedidos puede enviarlos al proveedor');
      if (!approver && o.user_id !== user.id) throw new HttpError(403, 'Solo puedes cambiar tus propios pedidos');
      if (['recibido', 'cancelado'].includes(o.status)) throw new HttpError(400, 'Este pedido ya está cerrado');
      const reason = String(d.reason || '').trim();
      await env.DB.prepare(`UPDATE orders SET status = ?, approved_by = CASE WHEN ? = 'enviado' THEN ? ELSE approved_by END, approved_at = CASE WHEN ? = 'enviado' THEN datetime('now') ELSE approved_at END,
        notes = CASE WHEN ? <> '' THEN COALESCE(notes || char(10), '') || ? ELSE notes END WHERE id = ?`)
        .bind(d.status, d.status, user.id, d.status, reason, `Rechazado por ${user.name}: ${reason}`, b).run();
      if (o.user_id && o.user_id !== user.id && ['enviado', 'cancelado'].includes(d.status))
        await enqueuePush(env, [o.user_id], { title: d.status === 'enviado' ? 'Pedido aprobado' : 'Pedido rechazado', body: `Tu pedido #${b} ${d.status === 'enviado' ? 'ha sido aprobado y enviado al proveedor' : 'ha sido rechazado' + (reason ? ': ' + reason : '')} (${user.name})`, url: `/#/pedidos/${b}`, tag: 'pedido-' + b });
      if (d.status === 'pendiente') await enqueuePush(env, (await approvers(env, user.id)).map((x) => x.id), { title: 'Pedido para aprobar', body: `${user.name} ha enviado el pedido #${b} a aprobación`, url: `/#/pedidos/${b}`, tag: 'pedido-' + b });
      ctx.audit = { action: d.status === 'enviado' ? 'aprobación' : d.status === 'cancelado' ? 'cancelación' : 'cambio de estado', id: b,
        summary: `Pedido #${b}: ${d.status === 'enviado' ? 'aprobado y enviado al proveedor' : d.status === 'cancelado' ? 'cancelado' + (reason ? ' (' + reason + ')' : '') : d.status === 'pendiente' ? 'enviado a aprobación' : d.status}` };
      return json({ ok: true, approvers: d.status === 'pendiente' ? await approvers(env, user.id) : [] });
    }
  }

  // --- recepción de mercancía (albaranes) ---
  if (a === 'receipts') {
    need(user, method === 'GET' ? ['recepcion.ver', 'recepcion.crear'] : 'recepcion.crear');
    if (method === 'GET' && !b) {
      const { results } = await env.DB.prepare(
        `SELECT r.*, s.name AS supplier_name, u.name AS user_name FROM receipts r JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN users u ON u.id = r.user_id ORDER BY r.receipt_date DESC, r.id DESC LIMIT 200`
      ).all();
      return json(results);
    }
    if (method === 'GET' && b) {
      const r = await env.DB.prepare(`SELECT r.*, s.name AS supplier_name FROM receipts r JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = ?`).bind(b).first();
      if (!r) throw new HttpError(404, 'Albarán no encontrado');
      const { results } = await env.DB.prepare(
        `SELECT rl.*, p.name, p.unit FROM receipt_lines rl JOIN products p ON p.id = rl.product_id WHERE rl.receipt_id = ? ORDER BY rl.id`
      ).bind(b).all();
      return json({ ...r, lines: results });
    }
    if (method === 'POST' && b === 'import') return receiptsImport(request, env, user);
    if (method === 'POST') {
      const d = await body(request);
      const lines = (d.lines || []).filter((l) => l.product_id && Number(l.qty) > 0);
      if (!d.supplier_id || !lines.length) throw new HttpError(400, 'Falta proveedor o artículos');
      const date = isDate(d.receipt_date) ? d.receipt_date : todayStr();
      const docType = d.doc_type === 'factura' ? 'factura' : 'albaran';
      const { pmap, fmap } = await unitCtx(env, lines.map((l) => l.product_id));
      for (const l of lines) if (!pmap[l.product_id]) throw new HttpError(400, 'Artículo no encontrado');
      const total = lines.reduce((s, l) => s + Number(l.qty) * Number(l.price || 0), 0); // cantidad × precio en la unidad escrita
      const rec = await env.DB.prepare(
        `INSERT INTO receipts (supplier_id, order_id, doc_type, delivery_note, receipt_date, total, notes, rec_temp, rec_check, user_id) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`
      ).bind(d.supplier_id, d.order_id || null, docType, d.delivery_note || null, date, r2(total), d.notes || null,
        d.rec_temp === '' || d.rec_temp == null || isNaN(Number(d.rec_temp)) ? null : Number(d.rec_temp), d.rec_check == null ? null : d.rec_check ? 1 : 0, user.id).first();
      const docLabel = `${docType === 'factura' ? 'Factura' : 'Albarán'} ${d.delivery_note || '#' + rec.id}`;

      const stmts = [], priceChanges = [], seen = new Set();
      for (const l of lines) {
        const p = pmap[l.product_id];
        const u = unitInfo(p, l.unit, fmap);
        const inQty = Number(l.qty), inPrice = Number(l.price || 0);
        const qty = r2(inQty * u.factor), price = r2(inPrice / u.factor); // a unidad base
        const grp = uuid();
        stmts.push(env.DB.prepare(`INSERT INTO receipt_lines (receipt_id, product_id, qty, price, ordered_qty, input_qty, input_unit, unit_label, input_price, lot, expiry) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(rec.id, p.id, qty, price, l.ordered_qty ?? null, inQty, l.unit || p.unit, u.label, inPrice, String(l.lot || '').trim() || null, isDate(l.expiry) ? l.expiry : null));
        if (u.format && inPrice > 0) stmts.push(env.DB.prepare('UPDATE product_formats SET price = ? WHERE id = ?').bind(inPrice, u.format.id));
        if (seen.has(p.id)) { stmts.push(env.DB.prepare(
          `INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(p.id, 'entrada', qty, price, docLabel, grp, 'albaran', rec.id, user.id, date)); continue; }
        seen.add(p.id);
        stmts.push(env.DB.prepare(
          `INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(p.id, 'entrada', qty, price, docLabel, grp, 'albaran', rec.id, user.id, date));
        if (price > 0 && Math.abs(price - Number(p.price)) > 0.0005) {
          priceChanges.push({ name: p.name, unit: p.unit, old: p.price, new: price, pct: p.price ? ((price - p.price) / p.price) * 100 : null,
            label: u.label, old_in: p.price * u.factor, new_in: inPrice });
          stmts.push(env.DB.prepare('INSERT INTO price_history (product_id, old_price, new_price, receipt_id) VALUES (?,?,?,?)').bind(p.id, p.price, price, rec.id));
          stmts.push(env.DB.prepare('UPDATE products SET price = ? WHERE id = ?').bind(price, p.id));
        }
      }
      if (d.order_id) stmts.push(env.DB.prepare(`UPDATE orders SET status = 'recibido' WHERE id = ?`).bind(d.order_id));
      ctx.afterPrices = true;
      // lo que venía de un escaneo: recordar qué producto es cada línea de este proveedor
      for (const l of lines) {
        if (!l.source) continue;
        stmts.push(env.DB.prepare(
          `INSERT INTO ocr_aliases (supplier_id, source, product_id, unit) VALUES (?,?,?,?)
           ON CONFLICT(supplier_id, source) DO UPDATE SET product_id = excluded.product_id, unit = excluded.unit`
        ).bind(d.supplier_id, normText(l.source), l.product_id, l.unit || null));
      }
      if (d.ocr_id) stmts.push(env.DB.prepare('UPDATE ocr_scans SET receipt_id = ? WHERE id = ?').bind(rec.id, d.ocr_id));
      if (d.supplier_cif) stmts.push(env.DB.prepare(`UPDATE suppliers SET cif = ? WHERE id = ? AND (cif IS NULL OR cif = '')`).bind(d.supplier_cif, d.supplier_id));
      await runBatch(env, stmts);
      return json({ id: rec.id, total: r2(total), price_changes: priceChanges });
    }
    if (method === 'DELETE' && b) {
      need(user, 'recepcion.anular');
      const old = await env.DB.prepare('SELECT r.*, s.name AS supplier FROM receipts r JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = ?').bind(b).first();
      if (old) ctx.audit = { action: 'anulación', summary: `Anulación de ${old.doc_type === 'factura' ? 'factura' : 'albarán'} ${old.delivery_note || '#' + old.id} de ${old.supplier} (${old.total} €)`, detail: old };
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM movements WHERE ref_type = 'albaran' AND ref_id = ?`).bind(b),
        env.DB.prepare('DELETE FROM receipt_lines WHERE receipt_id = ?').bind(b),
        env.DB.prepare('DELETE FROM receipts WHERE id = ?').bind(b),
      ]);
      return json({ ok: true });
    }
  }

  // --- mermas y consumo de personal ---
  if (a === 'movements') {
    if (method === 'GET') {
      need(user, ['mermas.registrar', 'mermas.ver_todas']);
      const types = (url.searchParams.get('types') || 'merma,consumo_personal').split(',').filter((t) => ['entrada', 'merma', 'consumo_personal', 'venta', 'ajuste'].includes(t));
      const from = url.searchParams.get('from') || '2000-01-01';
      const to = url.searchParams.get('to') || '2999-12-31';
      const { results } = await env.DB.prepare(
        `SELECT MAX(m.id) AS id, m.grp, m.type, m.mov_date, m.reason, m.notes, m.label, u.name AS user_name, m.user_id,
                -SUM(m.qty * m.unit_cost) AS value, COUNT(*) AS n
         FROM movements m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.type IN (${types.map(() => '?').join(',')}) AND m.mov_date BETWEEN ? AND ?
         GROUP BY m.grp ORDER BY m.mov_date DESC, MAX(m.id) DESC LIMIT 300`
      ).bind(...types, from, to).all();
      const mine = can(user, 'mermas.ver_todas') ? results : results.filter((r) => r.user_id === user.id);
      return json(can(user, 'costes.ver') ? mine : mine.map(({ value, ...r }) => r));
    }
    if (method === 'POST') {
      need(user, 'mermas.registrar');
      const d = await body(request);
      if (!['merma', 'consumo_personal'].includes(d.type)) throw new HttpError(400, 'Tipo no válido');
      const qty = Number(d.qty);
      if (!(qty > 0)) throw new HttpError(400, 'Indica una cantidad mayor que 0');
      const date = isDate(d.date) ? d.date : todayStr();
      const grp = uuid();
      const stmts = [];
      const ins = (pid, q, cost, label) => env.DB.prepare(
        `INSERT INTO movements (product_id, type, qty, unit_cost, reason, notes, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(pid, d.type, -r2(q), cost, d.reason || null, d.notes || null, label, grp, d.recipe_id ? 'plato' : null, d.recipe_id || null, user.id, date);
      if (d.recipe_id) {
        const { recipe, lines } = await recipePerPortion(env, d.recipe_id);
        if (!lines.length) throw new HttpError(400, `"${recipe.name}" no tiene escandallo todavía. Regístralo por ingredientes o completa su escandallo.`);
        const label = `${recipe.name} × ${qty}`;
        for (const l of lines) stmts.push(ins(l.product_id, l.gross * qty, l.price, label));
      } else {
        const { pmap, fmap } = await unitCtx(env, [d.product_id]);
        const p = pmap[d.product_id];
        if (!p) throw new HttpError(400, 'Artículo no encontrado');
        const u = unitInfo(p, d.unit, fmap);
        stmts.push(ins(p.id, qty * u.factor, p.price, `${p.name} · ${qty} ${u.label}`));
      }
      await env.DB.batch(stmts);
      return json({ ok: true });
    }
    if (method === 'DELETE' && b) {
      need(user, ['mermas.registrar', 'mermas.borrar']);
      const m = await env.DB.prepare('SELECT grp, type, user_id, created_at FROM movements WHERE id = ?').bind(b).first();
      if (!m || !['merma', 'consumo_personal'].includes(m.type)) throw new HttpError(404, 'Registro no encontrado');
      if (!can(user, 'mermas.borrar') && m.user_id !== user.id) throw new HttpError(403, 'Solo puedes borrar tus propios registros');
      const g = await env.DB.prepare(`SELECT MAX(m.label) AS label, m.type, m.mov_date, m.reason, -SUM(m.qty * m.unit_cost) AS value, u.name AS who FROM movements m LEFT JOIN users u ON u.id = m.user_id WHERE m.grp = ? GROUP BY m.grp`).bind(m.grp).first();
      ctx.audit = { action: 'borrado', summary: `Borrado de ${g.type === 'merma' ? 'merma' : 'consumo de personal'}: ${g.label} (${g.mov_date}, registrado por ${g.who || '?'}, ${Math.round((g.value || 0) * 100) / 100} €)`, detail: g };
      await env.DB.prepare('DELETE FROM movements WHERE grp = ?').bind(m.grp).run();
      return json({ ok: true });
    }
  }

  // --- inventario ---
  if (a === 'inventory') {
    need(user, 'inventario.hacer');
    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT i.*, u.name AS user_name FROM inventories i LEFT JOIN users u ON u.id = i.user_id ORDER BY i.id DESC LIMIT 50`
      ).all();
      return json(results);
    }
    if (method === 'POST' && b === 'import') return inventoryImport(request, env, user);
    if (method === 'POST') {
      const d = await body(request);
      return json(await saveInventory(env, user, d));
    }
  }

  // --- escandallos ---
  if (a === 'recipes') {
    if (b === 'bulk' && method === 'POST') return recipesBulk(request, env, user);
    if (b === 'lines-import' && method === 'POST') return recipeLinesImport(request, env, user);
    if (method === 'GET' && b) {
      need(user, 'escandallos.ver');
      const r = await env.DB.prepare('SELECT * FROM recipes WHERE id = ?').bind(b).first();
      if (!r) throw new HttpError(404, 'Plato no encontrado');
      const { results } = await env.DB.prepare(
        `SELECT rl.*, p.name, p.unit, p.price FROM recipe_lines rl JOIN products p ON p.id = rl.product_id WHERE rl.recipe_id = ? ORDER BY rl.id`
      ).bind(b).all();
      const lines = can(user, 'costes.ver') ? results : results.map(({ price, ...l }) => l);
      return json({ ...r, lines });
    }
    if (method === 'POST' || method === 'PUT') {
      need(user, 'escandallos.editar');
      const d = await body(request);
      if (!d.name) throw new HttpError(400, 'Pon nombre al plato');
      const isPrep = d.kind === 'elaboracion';
      if (isPrep && !(Number(d.yield_qty) > 0)) throw new HttpError(400, 'Indica cuánto produce la elaboración (por ejemplo 5 l)');
      if (isPrep && !['kg', 'l', 'ud'].includes(d.yield_unit)) throw new HttpError(400, 'La elaboración se mide en kg, l o ud');
      if (d.photo && String(d.photo).length > 400000) throw new HttpError(400, 'La foto es demasiado grande');
      const txt = (x) => (x == null || String(x).trim() === '' ? null : String(x));
      const cols = ['name', 'category', 'pvp', 'portions', 'pos_name', 'notes', 'plating', 'conservation', 'prep_time', 'misc_pct', 'allergens_extra', 'photo', 'author', 'kind', 'yield_qty', 'yield_unit'];
      const vals = [d.name.trim(), txt(d.category), isPrep ? 0 : Number(d.pvp) || 0, isPrep ? 1 : Number(d.portions) || 1, txt(d.pos_name), txt(d.notes), txt(d.plating), txt(d.conservation), txt(d.prep_time),
        d.misc_pct === '' || d.misc_pct == null || isNaN(Number(d.misc_pct)) ? null : Math.min(Math.max(Number(d.misc_pct), 0), 50),
        Array.isArray(d.allergens_extra) ? d.allergens_extra.filter((a) => ALLERGENS.includes(a)).join(',') : txt(d.allergens_extra), d.photo === undefined ? undefined : txt(d.photo), txt(d.author) || user.name,
        method === 'POST' || d.kind ? (isPrep ? 'elaboracion' : 'plato') : undefined, isPrep ? Number(d.yield_qty) : null, isPrep ? d.yield_unit : null];
      const use = cols.map((c, i) => [c, vals[i]]).filter(([, v]) => v !== undefined);
      let id = b;
      try {
        if (method === 'POST') {
          id = (await env.DB.prepare(`INSERT INTO recipes (${use.map((x) => x[0]).join(',')}) VALUES (${use.map(() => '?').join(',')}) RETURNING id`).bind(...use.map((x) => x[1])).first()).id;
        } else {
          await env.DB.prepare(`UPDATE recipes SET ${use.map((x) => x[0] + ' = ?').join(', ')}, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...use.map((x) => x[1]), id).run();
        }
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe un plato o elaboración con ese nombre');
        throw e;
      }
      // la elaboración tiene su artículo en Existencias (para su stock y para usarla como ingrediente)
      if (isPrep) await ensurePrepProduct(env, id, d.name.trim(), d.yield_unit, txt(d.category));
      const own = (await env.DB.prepare('SELECT product_id FROM recipes WHERE id = ?').bind(id).first())?.product_id;
      if (Array.isArray(d.lines)) {
        const valid = d.lines.filter((l) => l.product_id && Number(l.qty) > 0 && Number(l.product_id) !== own);
        const { pmap, fmap } = await unitCtx(env, valid.map((l) => l.product_id));
        const stmts = [env.DB.prepare('DELETE FROM recipe_lines WHERE recipe_id = ?').bind(id)];
        for (const l of valid) {
          const p = pmap[l.product_id];
          if (!p) continue;
          const u = unitInfo(p, l.unit, fmap);
          const pct = (x) => Math.min(Math.max(Number(x) || 0, 0), 95);
          stmts.push(env.DB.prepare('INSERT INTO recipe_lines (recipe_id, product_id, qty, waste_pct, cook_loss_pct, input_qty, input_unit) VALUES (?,?,?,?,?,?,?)')
            .bind(id, p.id, Number(l.qty) * u.factor, pct(l.waste_pct), pct(l.cook_loss_pct), Number(l.qty), l.unit || p.unit));
        }
        await runBatch(env, stmts);
      }
      await refreshPrepCosts(env);
      return json({ id });
    }
    if (method === 'DELETE' && b) {
      need(user, 'escandallos.editar');
      const old = await env.DB.prepare('SELECT id, name, pvp, kind, product_id FROM recipes WHERE id = ?').bind(b).first();
      if (old) ctx.audit = { action: 'baja', summary: `Baja ${old.kind === 'elaboracion' ? 'de la elaboración' : 'del plato'} "${old.name}"`, detail: old };
      if (old?.kind === 'elaboracion' && old.product_id) {
        const used = await env.DB.prepare(`SELECT r.name FROM recipe_lines rl JOIN recipes r ON r.id = rl.recipe_id AND r.active = 1 WHERE rl.product_id = ? AND r.id <> ? LIMIT 3`).bind(old.product_id, b).all();
        if (used.results.length) throw new HttpError(400, `No se puede borrar: la usan ${used.results.map((x) => x.name).join(', ')}`);
        await env.DB.prepare('UPDATE products SET active = 0 WHERE id = ?').bind(old.product_id).run();
      }
      await env.DB.prepare('UPDATE recipes SET active = 0 WHERE id = ?').bind(b).run();
      return json({ ok: true });
    }
  }

  // --- APPCC ---
  if (a === 'appcc') return appcc(env, user, ctx, method, b, c, request, url);

  // --- avisos y resumen semanal ---
  if (a === 'alerts' && method === 'GET') { ctx.audit = false; return json(await alerts(env, user)); }
  if (a === 'summary' && method === 'GET') { need(user, 'panel.ver'); return json(await weeklySummary(env, url.searchParams.get('end'))); }

  // --- producción de elaboraciones ---
  if (a === 'production') {
    if (method === 'GET') {
      need(user, ['produccion.registrar', 'escandallos.ver']);
      const { results } = await env.DB.prepare(`
        SELECT m.grp, m.mov_date, m.label, m.notes, u.name AS user_name, m.user_id, MAX(m.id) AS id,
               SUM(CASE WHEN m.qty > 0 THEN m.qty ELSE 0 END) AS produced, SUM(CASE WHEN m.qty < 0 THEN -m.qty * m.unit_cost ELSE 0 END) AS cost
        FROM movements m LEFT JOIN users u ON u.id = m.user_id WHERE m.type = 'produccion' AND m.mov_date >= date('now', '-60 days')
        GROUP BY m.grp ORDER BY m.mov_date DESC, MAX(m.id) DESC LIMIT 200`).all();
      return json(can(user, 'costes.ver') ? results : results.map(({ cost, ...x }) => x));
    }
    if (method === 'POST') {
      need(user, 'produccion.registrar');
      const d = await body(request);
      const qty = Number(d.qty);
      if (!(qty > 0)) throw new HttpError(400, 'Indica cuánto has producido');
      await refreshPrepCosts(env);
      const r = await env.DB.prepare(`SELECT id, name, yield_qty, yield_unit, product_id FROM recipes WHERE id = ? AND active = 1 AND kind = 'elaboracion'`).bind(d.recipe_id).first();
      if (!r) throw new HttpError(404, 'Elaboración no encontrada');
      const { lines } = await recipePerPortion(env, r.id);
      if (!lines.length) throw new HttpError(400, `"${r.name}" no tiene ingredientes en su ficha`);
      const f = qty / r.yield_qty, grp = uuid(), date = isDate(d.date) ? d.date : todayStr();
      const prod = await env.DB.prepare('SELECT price FROM products WHERE id = ?').bind(r.product_id).first();
      const label = `Producción: ${r.name} · ${qty} ${r.yield_unit}`;
      const ins = (pid, q, cost) => env.DB.prepare(`INSERT INTO movements (product_id, type, qty, unit_cost, notes, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(pid, 'produccion', r2(q), cost, d.notes || null, label, grp, 'produccion', r.id, user.id, date);
      const stmts = lines.map((l) => ins(l.product_id, -l.gross * f, l.price)); // recipePerPortion divide entre raciones (1 en elaboraciones)
      stmts.push(ins(r.product_id, qty, prod?.price || 0));
      await runBatch(env, stmts);
      ctx.audit = { action: 'alta', entity: 'producción', summary: label };
      return json({ ok: true, grp });
    }
    if (method === 'DELETE' && b) {
      need(user, 'produccion.registrar');
      const g = await env.DB.prepare(`SELECT grp, user_id, MAX(label) AS label FROM movements WHERE grp = ? AND type = 'produccion' GROUP BY grp`).bind(b).first();
      if (!g) throw new HttpError(404, 'Producción no encontrada');
      if (!user.is_super && g.user_id !== user.id && !can(user, 'mermas.borrar')) throw new HttpError(403, 'Solo puedes deshacer tus propias producciones');
      await env.DB.prepare('DELETE FROM movements WHERE grp = ?').bind(b).run();
      ctx.audit = { action: 'deshacer', entity: 'producción', summary: `Deshecha ${g.label}` };
      return json({ ok: true });
    }
  }

  // --- ventas importadas de Qamarero ---
  if (a === 'sales') {
    need(user, 'ventas.gestionar');
    if (b === 'imports' && method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT si.*, u.name AS user_name FROM sales_imports si LEFT JOIN users u ON u.id = si.user_id ORDER BY si.date_to DESC, si.id DESC LIMIT 100`
      ).all();
      return json(results);
    }
    if (b === 'imports' && method === 'DELETE' && c) {
      const old = await env.DB.prepare('SELECT * FROM sales_imports WHERE id = ?').bind(c).first();
      if (old) ctx.audit = { action: 'deshacer', entity: 'ventas', id: c, summary: `Deshecha la importación de ventas ${old.date_from} → ${old.date_to} (${old.revenue} €)`, detail: old };
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM movements WHERE ref_type = 'venta' AND ref_id = ?`).bind(c),
        env.DB.prepare('DELETE FROM sales WHERE import_id = ?').bind(c),
        env.DB.prepare('DELETE FROM sales_imports WHERE id = ?').bind(c),
      ]);
      return json({ ok: true });
    }
    if (b === 'match' && method === 'POST') {
      const d = await body(request);
      return json(await matchPosRows(env, d.rows || []));
    }
    if (b === 'stale' && method === 'GET') { ctx.audit = false; return json(await staleSales(env)); }
    if (b === 'recalc' && c && method === 'POST') {
      const r = await recalcSales(env, c, user.id);
      ctx.audit = { action: 'recálculo', entity: 'ventas', id: c, summary: `Consumo del volcado de ventas #${c} recalculado con los escandallos actuales` };
      return json(r);
    }
    if (b === 'import' && method === 'POST') return salesImport(request, env, user);
  }

  // --- OCR de albaranes y facturas ---
  if (a === 'ocr' && method === 'POST') {
    need(user, 'recepcion.crear');
    return ocrScan(request, env, user);
  }
  if (a === 'ocr' && b === 'status') {
    return json({ provider: ocrProvider(env) });
  }

  // --- caja real diaria ---
  if (a === 'cash') {
    need(user, ['caja.registrar', 'caja.ver']);
    const full = can(user, 'caja.ver');
    const minDay = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    if (method === 'GET') {
      let from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : minDay;
      const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : todayStr();
      if (!full && from < minDay) from = minDay; // sin permiso de ver caja: solo la última semana
      const { iva_pct } = await settings(env);
      const { results } = await env.DB.prepare(
        `SELECT c.*, (c.cash + c.card + c.bizum + c.other) AS total, u.name AS user_name,
                (SELECT SUM(s.revenue) FROM sales s JOIN sales_imports si ON si.id = s.import_id
                  WHERE s.sale_date = c.day AND si.date_from = si.date_to) * ? AS qamarero_import
         FROM cash_days c LEFT JOIN users u ON u.id = c.user_id WHERE c.day BETWEEN ? AND ? ORDER BY c.day DESC`
      ).bind(1 + iva_pct / 100, from, to).all();
      return json({ days: results, full, min_day: full ? null : minDay });
    }
    if (method === 'PUT' && isDate(b)) {
      if (!full && b < minDay) throw new HttpError(403, 'Solo puedes registrar la caja de los últimos 7 días');
      const prev = await env.DB.prepare('SELECT cash, card, bizum, other, cash_out, pos_total, covers, notes FROM cash_days WHERE day = ?').bind(b).first();
      ctx.audit = { action: prev ? 'modificación' : 'alta', id: b, summary: `${prev ? 'Modificación' : 'Cierre'} de caja del ${b}${prev ? ` (antes: efectivo ${prev.cash} €, tarjeta ${prev.card} €)` : ''}`, detail: prev };
      const d = await body(request);
      const n = (x) => (x === '' || x == null || isNaN(Number(x)) ? 0 : Number(x));
      const pos = d.pos_total === '' || d.pos_total == null || isNaN(Number(d.pos_total)) ? null : Number(d.pos_total);
      await env.DB.prepare(
        `INSERT INTO cash_days (day, cash, card, bizum, other, cash_out, pos_total, covers, notes, user_id, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
         ON CONFLICT(day) DO UPDATE SET cash = excluded.cash, card = excluded.card, bizum = excluded.bizum, other = excluded.other,
           cash_out = excluded.cash_out, pos_total = excluded.pos_total, covers = excluded.covers, notes = excluded.notes,
           user_id = excluded.user_id, updated_at = CURRENT_TIMESTAMP`
      ).bind(b, n(d.cash), n(d.card), n(d.bizum), n(d.other), n(d.cash_out), pos, d.covers ? Math.round(n(d.covers)) : null, d.notes || null, user.id).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && isDate(b)) {
      need(user, 'caja.ver');
      const prev = await env.DB.prepare('SELECT * FROM cash_days WHERE day = ?').bind(b).first();
      ctx.audit = { action: 'borrado', id: b, summary: `Borrado de la caja del ${b}`, detail: prev };
      await env.DB.prepare('DELETE FROM cash_days WHERE day = ?').bind(b).run();
      return json({ ok: true });
    }
  }

  // --- historial de precios ---
  if (a === 'price-history') {
    need(user, 'costes.ver');
    const days = Math.min(Number(url.searchParams.get('days')) || 60, 730);
    const { results } = await env.DB.prepare(
      `SELECT ph.*, p.name, p.unit, s.name AS supplier_name FROM price_history ph JOIN products p ON p.id = ph.product_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE ph.created_at >= datetime('now', ?) ORDER BY ph.id DESC LIMIT 200`
    ).bind(`-${days} days`).all();
    return json(results);
  }

  // --- estadísticas por pestaña e informes ---
  if (a === 'stats' && b) { need(user, 'panel.ver'); return stats(env, url, b); }
  if (a === 'reports' && !b) { need(user, 'informes.ver'); return json(REPORTS); }
  if (a === 'reports' && b) { need(user, 'informes.ver'); return report(env, url, b, user); }

  // --- cuadro de mando ---
  if (a === 'dashboard') {
    need(user, 'panel.ver');
    return dashboard(env, url);
  }

  throw new HttpError(404, 'Ruta no encontrada');
}

// ---------- importaciones ----------
// Proveedores desde Excel: si coincide el CIF (o, sin CIF, el nombre) se actualiza; si no, se crea
async function suppliersBulk(request, env, user) {
  need(user, 'productos.editar');
  const d = await body(request);
  const clean = (x) => String(x ?? '').trim();
  const cifKey = (x) => clean(x).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const items = (d.items || []).filter((i) => clean(i.name));
  const { results: sups } = await env.DB.prepare('SELECT id, name, cif FROM suppliers WHERE active = 1').all();
  const byCif = Object.fromEntries(sups.filter((x) => x.cif).map((x) => [cifKey(x.cif), x.id]));
  const byName = Object.fromEntries(sups.map((x) => [clean(x.name).toLowerCase(), x.id]));
  const F = ['name', 'cif', 'contact', 'phone', 'email', 'order_days', 'notes'];
  let created = 0, updated = 0;
  const stmts = [];
  for (const i of items) {
    const v = Object.fromEntries(F.map((k) => [k, clean(i[k]) || null]));
    if (v.cif) v.cif = v.cif.toUpperCase().replace(/[\s.-]/g, '');
    const id = (v.cif && byCif[cifKey(v.cif)]) || byName[v.name.toLowerCase()];
    if (id === -1) continue; // repetido dentro del mismo archivo
    if (id) {
      const keys = F.filter((k) => v[k] != null); // no borra lo que ya había si la columna viene vacía
      stmts.push(env.DB.prepare(`UPDATE suppliers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map((k) => v[k]), id));
      updated++;
    } else {
      stmts.push(env.DB.prepare(`INSERT INTO suppliers (${F.join(',')}) VALUES (${F.map(() => '?').join(',')})`).bind(...F.map((k) => v[k])));
      byName[v.name.toLowerCase()] = -1; // evita duplicados dentro del mismo archivo
      if (v.cif) byCif[cifKey(v.cif)] = -1;
      created++;
    }
  }
  await runBatch(env, stmts.filter(Boolean));
  return json({ ok: true, created, updated });
}

// en importaciones, una columna vacía no cambia lo que ya había
const unitIn = (u) => (String(u ?? '').trim() ? normUnit(u) : null);
const minIn = (m) => { const n = Number(String(m ?? '').replace(',', '.')); return String(m ?? '').trim() && !isNaN(n) ? n : null; };
function normUnit(u) {
  const x = String(u || '').trim().toLowerCase();
  if (['kg', 'kilo', 'kilos', 'kgs', 'g', 'gr', 'gramos'].includes(x)) return 'kg';
  if (['l', 'lt', 'litro', 'litros', 'ml', 'cl'].includes(x)) return 'l';
  return 'ud';
}


// Guarda un recuento: la diferencia con el stock teórico entra como ajuste
async function saveInventory(env, user, d) {
  const counts = (d.counts || []).filter((x) => x.product_id && x.counted !== '' && x.counted !== null && !isNaN(Number(x.counted)));
  if (!counts.length) throw new HttpError(400, 'No has contado ningún artículo');
  const date = isDate(d.date) ? d.date : todayStr();
  const { results: prods } = await env.DB.prepare(PRODUCTS_SQL).all();
  const pmap = Object.fromEntries(prods.map((p) => [p.id, p]));
  const inv = await env.DB.prepare('INSERT INTO inventories (inv_date, notes, user_id) VALUES (?,?,?) RETURNING id').bind(date, d.notes || null, user.id).first();
  const stmts = [], diffs = [];
  let totalDiff = 0;
  for (const cnt of counts) {
    const p = pmap[cnt.product_id];
    if (!p) continue;
    stmts.push(env.DB.prepare('INSERT INTO inventory_lines (inventory_id, product_id, expected, counted, detail) VALUES (?,?,?,?,?)')
      .bind(inv.id, p.id, r2(p.stock), r2(Number(cnt.counted)), cnt.detail || null));
    const delta = r2(Number(cnt.counted) - Number(p.stock));
    if (Math.abs(delta) < 0.0001) continue;
    if (d.initial) {
      // stock de arranque: entra como existencias, no como descuadre
      stmts.push(env.DB.prepare(`INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(p.id, 'entrada', delta, p.price, 'Stock inicial', uuid(), 'stock_inicial', inv.id, user.id, date));
      continue;
    }
    totalDiff += delta * p.price;
    diffs.push({ name: p.name, unit: p.unit, expected: p.stock, counted: Number(cnt.counted), delta, value: delta * p.price, detail: cnt.detail || null });
    stmts.push(env.DB.prepare(
      `INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(p.id, 'ajuste', delta, p.price, `Inventario ${date}`, uuid(), 'inventario', inv.id, user.id, date));
  }
  stmts.push(env.DB.prepare('UPDATE inventories SET total_diff_value = ? WHERE id = ?').bind(r2(totalDiff), inv.id));
  await runBatch(env, stmts);
  return { id: inv.id, diffs, total_diff_value: r2(totalDiff) };
}

// Inventario inicial (o cualquier recuento) desde un Excel: artículo, cantidad, unidad y, opcionalmente, precio, categoría y proveedor.
// Da de alta los artículos que falten, actualiza precios y guarda el recuento. Con dry = true solo devuelve la vista previa.
const normName = (x) => String(x || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
const numIn = (v) => { if (typeof v === 'number') return v; let t = String(v ?? '').replace(/[€\s]/g, ''); if (!t) return NaN; if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, ''); else t = t.replace(',', '.'); return Number(t); };
const SUB_FACTOR = { g: 0.001, gr: 0.001, gramos: 0.001, ml: 0.001, cl: 0.01 };
const KNOWN_UNITS = ['ud', 'uds', 'u', 'un', 'unidad', 'unidades', 'kg', 'kgs', 'kilo', 'kilos', 'g', 'gr', 'gramos', 'l', 'lt', 'litro', 'litros', 'ml', 'cl'];
async function inventoryImport(request, env, user) {
  const d = await body(request);
  const raw = (d.items || []).filter((i) => String(i.name || '').trim());
  if (!raw.length) throw new HttpError(400, 'El archivo no tiene filas con nombre de artículo');
  const { results: prods } = await env.DB.prepare(PRODUCTS_SQL).all();
  const { results: fmts } = await env.DB.prepare('SELECT * FROM product_formats WHERE active = 1').all();
  const byName = new Map(prods.map((p) => [normName(p.name), p]));
  const canCreate = can(user, 'productos.editar');
  const rows = [], bad = [], unknownUnits = new Set();
  let blank = 0;
  for (const [n, i] of raw.entries()) {
    const qty = numIn(i.qty);
    if (String(i.qty ?? '').trim() === '') { blank++; continue; }   // sin contar: no se toca
    if (isNaN(qty) || qty < 0) { bad.push({ row: n + 2, name: i.name, why: 'cantidad no válida' }); continue; }
    const p = byName.get(normName(i.name));
    const u = String(i.unit ?? '').trim().toLowerCase();
    const base = p ? p.unit : unitIn(u) || 'ud';
    let factor = 1, fmt = null;
    if (SUB_FACTOR[u] && ((base === 'kg' && ['g', 'gr', 'gramos'].includes(u)) || (base === 'l' && ['ml', 'cl'].includes(u)))) factor = SUB_FACTOR[u];
    else if (u && !KNOWN_UNITS.includes(u)) {
      // "caja", "saco", "botella"… : se busca un formato del artículo con ese nombre
      fmt = p ? fmts.find((f) => f.product_id === p.id && normName(f.name).includes(normName(u))) : null;
      if (fmt) factor = Number(fmt.factor);
      else unknownUnits.add(u);
    }
    const price = numIn(i.price);
    rows.push({ name: String(i.name).trim(), p, base, qty: qty * factor, price: price > 0 ? price / factor : null, category: String(i.category || '').trim() || null,
      supplier_name: String(i.supplier_name || '').trim() || null, unit_note: fmt ? fmt.name : null });
  }
  // artículos repetidos (p. ej. la misma harina en varias facturas): se suman o se queda la última fila
  const merged = new Map();
  let dups = 0;
  for (const r of rows) {
    const k = normName(r.name), m = merged.get(k);
    if (!m) { merged.set(k, { ...r }); continue; }
    dups++;
    m.qty = d.dup === 'last' ? r.qty : m.qty + r.qty;
    if (r.price) m.price = r.price;
    m.category = r.category || m.category; m.supplier_name = r.supplier_name || m.supplier_name;
  }
  const list = [...merged.values()];
  const news = list.filter((r) => !r.p);
  const value = list.reduce((t, r) => t + r.qty * (r.price ?? r.p?.price ?? 0), 0);
  const firstInv = !(await env.DB.prepare('SELECT id FROM inventories LIMIT 1').first());
  if (!rows.length) throw new HttpError(400, blank ? 'Ninguna fila tiene cantidad: rellena la columna de cantidad con lo que hayas contado' : 'No hay ninguna fila con cantidad válida');
  const preview = { rows: raw.length, blank, first_inventory: firstInv, unknown_units: [...unknownUnits].slice(0, 10), articles: list.length, matched: list.length - news.length, dups, bad, value: r2(value), can_create: canCreate,
    new_items: news.map((r) => ({ name: r.name, unit: r.base, qty: r2(r.qty), price: r.price ? r2(r.price) : null })),
    price_changes: list.filter((r) => r.p && r.price && Math.abs(r.price - r.p.price) > 0.005).length,
    sample: list.slice(0, 8).map((r) => ({ name: r.p?.name || r.name, unit: r.base, qty: r2(r.qty), price: r2(r.price ?? r.p?.price ?? 0), is_new: !r.p, unit_note: r.unit_note })) };
  if (d.dry) return json(preview);

  // 1) alta de artículos nuevos y de sus proveedores
  let created = 0;
  if (news.length && canCreate) {
    const { results: sups } = await env.DB.prepare('SELECT id, name FROM suppliers WHERE active = 1').all();
    const smap = Object.fromEntries(sups.map((x) => [normName(x.name), x.id]));
    for (const r of news) if (r.supplier_name && !smap[normName(r.supplier_name)])
      smap[normName(r.supplier_name)] = (await env.DB.prepare('INSERT INTO suppliers (name) VALUES (?) RETURNING id').bind(r.supplier_name).first()).id;
    await runBatch(env, news.map((r) => env.DB.prepare(`INSERT INTO products (name, category, unit, price, supplier_id) VALUES (?,?,?,?,?) ON CONFLICT(name) DO NOTHING`)
      .bind(r.name, r.category, r.base, r2(r.price || 0), r.supplier_name ? smap[normName(r.supplier_name)] : null)));
    created = news.length;
  }
  // 2) precios nuevos de los que ya existían (con historial)
  const stmts = [];
  if (canCreate && d.update_prices !== false) for (const r of list) if (r.p && r.price && Math.abs(r.price - r.p.price) > 0.00005) {
    stmts.push(env.DB.prepare('UPDATE products SET price = ? WHERE id = ?').bind(r2(r.price), r.p.id));
    stmts.push(env.DB.prepare('INSERT INTO price_history (product_id, old_price, new_price, receipt_id) VALUES (?,?,?,NULL)').bind(r.p.id, r.p.price, r2(r.price)));
  }
  if (stmts.length) await runBatch(env, stmts);
  // 3) el recuento
  const { results: now } = await env.DB.prepare('SELECT id, name FROM products WHERE active = 1').all();
  const idOf = new Map(now.map((p) => [normName(p.name), p.id]));
  const counts = list.map((r) => ({ product_id: idOf.get(normName(r.name)), counted: r2(r.qty), detail: 'Importado de Excel' })).filter((c) => c.product_id);
  const res = await saveInventory(env, user, { counts, date: d.date, initial: !!d.initial, notes: d.notes || (d.initial ? 'Stock inicial importado desde Excel' : 'Inventario importado desde Excel') });
  return json({ ...res, created, skipped: list.length - counts.length, prices: stmts.length / 2, counted: counts.length });
}

// Cantidad escrita -> unidad base del artículo (g -> kg, cl -> l, "caja" -> formato con ese nombre…)
function baseFactor(base, u, pid, fmts) {
  u = String(u ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!u || u === base) return { factor: 1, known: true };
  if (['g', 'gr', 'grs', 'gramos'].includes(u) && base === 'kg') return { factor: 0.001, known: true };
  if (['ml'].includes(u) && base === 'l') return { factor: 0.001, known: true };
  if (['cl'].includes(u) && base === 'l') return { factor: 0.01, known: true };
  if (['kg', 'kgs', 'kilo', 'kilos'].includes(u) && base === 'kg') return { factor: 1, known: true };
  if (['l', 'lt', 'litro', 'litros'].includes(u) && base === 'l') return { factor: 1, known: true };
  if (['ud', 'uds', 'u', 'un', 'unidad', 'unidades'].includes(u) && base === 'ud') return { factor: 1, known: true };
  const f = fmts.find((x) => x.product_id === pid && normName(x.name).includes(normName(u)));
  if (f) return { factor: Number(f.factor), known: true, format: f };
  return { factor: 1, known: false };
}
// fechas de Excel: 2026-07-31, 31/07/2026 o número de serie
function dateIn(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  const t = String(v ?? '').trim();
  if (isDate(t.slice(0, 10))) return t.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
const supKey = (s) => normName(s).replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9ñ ]/g, ' ').replace(/\b(s ?l ?u?|s ?a ?u?|slu|sau|sl|sa)\b/g, ' ').replace(/\s+/g, ' ').trim();
const cifKey = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Compras históricas (p. ej. facturas escaneadas en un Excel): una fila por línea de factura.
// Agrupa por proveedor + nº de factura + fecha, crea las recepciones con su fecha y no repite facturas ya importadas.
async function receiptsImport(request, env, user) {
  need(user, 'recepcion.crear');
  const d = await body(request);
  const raw = (d.items || []).filter((i) => String(i.name || '').trim());
  if (!raw.length) throw new HttpError(400, 'No hay líneas con artículo');
  if (raw.length > 600) throw new HttpError(400, 'Demasiadas líneas en un envío (máx. 600)');
  const canCreate = can(user, 'productos.editar');
  const [{ results: prods }, { results: fmts }, { results: sups }] = await Promise.all([
    env.DB.prepare('SELECT id, name, unit, price FROM products WHERE active = 1').all(),
    env.DB.prepare('SELECT * FROM product_formats WHERE active = 1').all(),
    env.DB.prepare('SELECT id, name, cif FROM suppliers WHERE active = 1').all(),
  ]);
  const pByName = new Map(prods.map((p) => [normName(p.name), p]));
  const sByCif = new Map(), sByName = new Map();
  for (const s of sups) { const c = cifKey(s.cif); if (c) { sByCif.set(c, s); if (/^[A-Z]\d{8}$/.test(c)) sByCif.set(c.slice(1), s); } sByName.set(supKey(s.name), s); }
  const findSup = (name, cif) => { const c = cifKey(cif); return (c && (sByCif.get(c) || sByCif.get(c.slice(1)))) || sByName.get(supKey(name)) || null; };

  const bad = [], newSups = new Map(), newProds = new Map(), unknownUnits = new Set(), newByCif = new Map(), newByName = new Map();
  const docs = new Map();
  for (const [n, i] of raw.entries()) {
    let qty = numIn(i.qty); const date = dateIn(i.date);
    if (!String(i.supplier_name || '').trim()) { bad.push({ row: i._row || n + 2, name: i.name, why: 'sin proveedor' }); continue; }
    if (!date) { bad.push({ row: i._row || n + 2, name: i.name, why: 'fecha no válida' }); continue; }
    if (isNaN(qty) || qty === 0) { bad.push({ row: i._row || n + 2, name: i.name, why: 'cantidad no válida' }); continue; }
    const sup = findSup(i.supplier_name, i.cif);
    let sk = sup ? 'id:' + sup.id : null;
    if (!sk) {
      // proveedor nuevo: el mismo aunque unas líneas traigan CIF y otras no
      const c = cifKey(i.cif), nk = supKey(i.supplier_name);
      sk = (c && newByCif.get(c)) || newByName.get(nk) || 'new:' + (c || nk);
      if (!newSups.has(sk)) newSups.set(sk, { name: String(i.supplier_name).trim(), cif: c || null });
      else if (c && !newSups.get(sk).cif) newSups.get(sk).cif = c;
      if (c) newByCif.set(c, sk); newByName.set(nk, sk);
    }
    const p = pByName.get(normName(i.name));
    const unitIn0 = String(i.unit ?? '').trim().toLowerCase();
    const base = p ? p.unit : unitIn(unitIn0) || 'ud';
    const bf = p ? baseFactor(base, unitIn0, p.id, fmts) : { factor: ['g', 'gr', 'gramos'].includes(unitIn0) ? 0.001 : unitIn0 === 'ml' ? 0.001 : unitIn0 === 'cl' ? 0.01 : 1, known: true };
    if (!bf.known) unknownUnits.add(unitIn0);
    let price = numIn(i.price); let amount = numIn(i.amount);
    if (isNaN(price) && !isNaN(amount)) price = amount / qty;
    if (isNaN(price)) price = 0;
    // abonos y rectificativas: cantidad negativa (devolución) con precio positivo
    if (price < 0) { price = -price; if (qty > 0) { qty = -qty; if (!isNaN(amount) && amount > 0) amount = -amount; } }
    if (!isNaN(amount) && amount > 0 && qty < 0) amount = -amount;
    if (!p && !newProds.has(normName(i.name))) newProds.set(normName(i.name), { name: String(i.name).trim(), unit: base, price: price / bf.factor, sk });
    const doc = String(i.doc ?? '').trim();
    const key = `${sk}|${doc || date}`;
    if (!docs.has(key)) docs.set(key, { sk, sup, doc, date, lines: [] });
    docs.get(key).lines.push({ key: normName(i.name), qty: qty * bf.factor, price: price / bf.factor, inQty: qty, inUnit: unitIn0 || base, inPrice: price, amount: !isNaN(amount) ? amount : qty * price });
  }
  // facturas ya importadas (mismo proveedor y nº, o sin nº: mismo proveedor, fecha e importe)
  const { results: existing } = await env.DB.prepare('SELECT supplier_id, delivery_note, receipt_date, total FROM receipts').all();
  const seen = new Set(existing.map((r) => `${r.supplier_id}|${r.delivery_note || ''}|${r.delivery_note ? '' : r.receipt_date + '|' + Math.round(r.total * 100)}`));
  const invs = [...docs.values()].map((v) => ({ ...v, total: v.lines.reduce((t, l) => t + l.amount, 0) }));
  for (const v of invs) v.dup = !!(v.sup && seen.has(`${v.sup.id}|${v.doc}|${v.doc ? '' : v.date + '|' + Math.round(v.total * 100)}`));
  const todo = invs.filter((v) => !v.dup);
  const preview = { lines: raw.length, invoices: invs.length, already: invs.length - todo.length, bad, can_create: canCreate,
    new_suppliers: [...newSups.values()].map((x) => x.name), new_articles: [...newProds.values()].map((x) => x.name),
    unknown_units: [...unknownUnits].slice(0, 10), total: r2(todo.reduce((t, v) => t + v.total, 0)),
    from: invs.reduce((m, v) => (!m || v.date < m ? v.date : m), null), to: invs.reduce((m, v) => (!m || v.date > m ? v.date : m), null) };
  if (d.dry) return json(preview);
  if ((newProds.size || newSups.size) && !canCreate) throw new HttpError(403, 'Hay proveedores o artículos nuevos y no tienes permiso para darlos de alta');

  // altas
  const supId = {};
  for (const v of invs) if (v.sup) supId[v.sk] = v.sup.id;
  for (const [sk, x] of newSups) supId[sk] = (await env.DB.prepare('INSERT INTO suppliers (name, cif) VALUES (?,?) RETURNING id').bind(x.name, x.cif).first()).id;
  if (newProds.size) await runBatch(env, [...newProds.values()].map((x) => env.DB.prepare('INSERT INTO products (name, unit, price, supplier_id) VALUES (?,?,?,?) ON CONFLICT(name) DO NOTHING')
    .bind(x.name, x.unit, r2(x.price), supId[x.sk] || null)));
  const { results: now } = await env.DB.prepare('SELECT id, name FROM products WHERE active = 1').all();
  const pid = new Map(now.map((p) => [normName(p.name), p.id]));
  // recepciones
  let lines = 0;
  for (const v of todo) {
    const rec = await env.DB.prepare(`INSERT INTO receipts (supplier_id, doc_type, delivery_note, receipt_date, total, notes, user_id) VALUES (?, 'factura', ?, ?, ?, ?, ?) RETURNING id`)
      .bind(supId[v.sk], v.doc || null, v.date, r2(v.total), 'Importada de Excel', user.id).first();
    const label = `Factura ${v.doc || '#' + rec.id}`;
    const st = [];
    for (const l of v.lines) {
      const id = pid.get(l.key); if (!id) continue;
      lines++;
      st.push(env.DB.prepare('INSERT INTO receipt_lines (receipt_id, product_id, qty, price, input_qty, input_unit, unit_label, input_price) VALUES (?,?,?,?,?,?,?,?)')
        .bind(rec.id, id, r2(l.qty), r2(l.price), l.inQty, l.inUnit, l.inUnit, l.inPrice));
      st.push(env.DB.prepare(`INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, 'entrada', r2(l.qty), r2(l.price), label, uuid(), 'albaran', rec.id, user.id, v.date));
    }
    await runBatch(env, st);
  }
  return json({ ...preview, created_invoices: todo.length, created_lines: lines, created_suppliers: newSups.size, created_articles: newProds.size });
}

// Escandallos desde Excel: una fila por ingrediente (plato, ingrediente, cantidad, unidad, mermas)
async function recipeLinesImport(request, env, user) {
  need(user, 'escandallos.editar');
  const d = await body(request);
  const raw = (d.items || []).filter((i) => String(i.recipe || '').trim() && String(i.name || '').trim());
  if (!raw.length) throw new HttpError(400, 'No hay filas con plato e ingrediente');
  const [{ results: prods }, { results: fmts }, { results: recs }] = await Promise.all([
    env.DB.prepare('SELECT id, name, unit FROM products WHERE active = 1').all(),
    env.DB.prepare('SELECT * FROM product_formats WHERE active = 1').all(),
    env.DB.prepare('SELECT id, name, pos_name, portions FROM recipes WHERE active = 1').all(),
  ]);
  const pByName = new Map(prods.map((p) => [normName(p.name), p]));
  const rByName = new Map(); for (const r of recs) { rByName.set(normName(r.name), r); if (r.pos_name) rByName.set(normName(r.pos_name), r); }
  const byRec = new Map(), missing = new Set(), noDish = new Set(), bad = [];
  for (const [n, i] of raw.entries()) {
    const r = rByName.get(normName(i.recipe)); if (!r) { noDish.add(String(i.recipe).trim()); continue; }
    const p = pByName.get(normName(i.name)); if (!p) { missing.add(String(i.name).trim()); continue; }
    const qty = numIn(i.qty);
    if (!(qty > 0)) { bad.push({ row: n + 2, name: `${i.recipe}: ${i.name}`, why: 'cantidad no válida' }); continue; }
    const u = String(i.unit ?? '').trim().toLowerCase() || (p.unit === 'kg' ? 'g' : p.unit === 'l' ? 'ml' : p.unit);
    const bf = baseFactor(p.unit, u, p.id, fmts);
    if (!bf.known) { bad.push({ row: n + 2, name: `${i.recipe}: ${i.name}`, why: `unidad «${u}» no vale para ${p.name} (${p.unit})` }); continue; }
    if (!byRec.has(r.id)) byRec.set(r.id, { r, lines: [] });
    const w = numIn(i.waste_pct), ck = numIn(i.cook_pct);
    byRec.get(r.id).lines.push({ p, qty: qty * bf.factor, inQty: qty, inUnit: bf.format ? 'f:' + bf.format.id : u, waste: w >= 0 ? Math.min(w, 95) : 0, cook: ck >= 0 ? Math.min(ck, 95) : 0 });
  }
  const preview = { rows: raw.length, recipes: byRec.size, lines: [...byRec.values()].reduce((t, x) => t + x.lines.length, 0),
    missing_articles: [...missing], missing_dishes: [...noDish], bad };
  if (d.dry) return json(preview);
  // las cantidades son por 1 ración: se guardan multiplicadas por las raciones de la ficha
  const st = [];
  for (const { r, lines } of byRec.values()) {
    const por = Number(r.portions) || 1;
    st.push(env.DB.prepare('DELETE FROM recipe_lines WHERE recipe_id = ?').bind(r.id));
    for (const l of lines) st.push(env.DB.prepare('INSERT INTO recipe_lines (recipe_id, product_id, qty, waste_pct, cook_loss_pct, input_qty, input_unit) VALUES (?,?,?,?,?,?,?)')
      .bind(r.id, l.p.id, r2(l.qty * por), l.waste, l.cook, r2(l.inQty * por), l.inUnit));
  }
  await runBatch(env, st);
  return json({ ...preview, saved: byRec.size });
}

async function productsBulk(request, env, user) {
  need(user, 'productos.editar');
  const d = await body(request);
  const items = (d.items || []).filter((i) => i.name && String(i.name).trim());
  const { results: sups } = await env.DB.prepare('SELECT id, name FROM suppliers WHERE active = 1').all();
  const smap = Object.fromEntries(sups.map((s) => [s.name.toLowerCase(), s.id]));
  for (const i of items) {
    const sn = String(i.supplier_name || '').trim();
    if (sn && !smap[sn.toLowerCase()]) {
      smap[sn.toLowerCase()] = (await env.DB.prepare('INSERT INTO suppliers (name) VALUES (?) RETURNING id').bind(sn).first()).id;
    }
  }
  const stmts = items.map((i) => {
    const sid = i.supplier_name ? smap[String(i.supplier_name).trim().toLowerCase()] : null;
    return env.DB.prepare(
      `INSERT INTO products (name, category, unit, price, supplier_id, min_stock) VALUES (?, ?, COALESCE(?, 'ud'), ?, ?, COALESCE(?, 0))
       ON CONFLICT(name) DO UPDATE SET category = COALESCE(excluded.category, category),
         unit = CASE WHEN ? IS NOT NULL THEN excluded.unit ELSE unit END,
         price = CASE WHEN excluded.price > 0 THEN excluded.price ELSE price END,
         min_stock = CASE WHEN ? IS NOT NULL THEN excluded.min_stock ELSE min_stock END,
         supplier_id = COALESCE(excluded.supplier_id, supplier_id), active = 1`
    ).bind(String(i.name).trim(), i.category || null, unitIn(i.unit), Number(String(i.price ?? 0).replace(',', '.')) || 0, sid || null, minIn(i.min_stock), unitIn(i.unit), minIn(i.min_stock));
  });
  await runBatch(env, stmts);
  // formatos opcionales de la tarifa (p. ej. "Caja 24" con 24 ud a 12 €)
  const withFmt = items.filter((i) => String(i.format_name || '').trim() && Number(String(i.format_factor ?? '').replace(',', '.')) > 0);
  if (withFmt.length) {
    const { results: prods } = await env.DB.prepare('SELECT id, name, price FROM products WHERE active = 1').all();
    const byName = Object.fromEntries(prods.map((p) => [p.name.toLowerCase(), p]));
    const f = [];
    for (const i of withFmt) {
      const p = byName[String(i.name).trim().toLowerCase()];
      if (!p) continue;
      const factor = Number(String(i.format_factor).replace(',', '.'));
      const fprice = Number(String(i.format_price ?? '').replace(',', '.')) || null;
      f.push(env.DB.prepare(
        `INSERT INTO product_formats (product_id, name, factor, price, is_default) VALUES (?,?,?,?,1)
         ON CONFLICT(product_id, name) DO UPDATE SET factor = excluded.factor, price = COALESCE(excluded.price, price), active = 1`
      ).bind(p.id, String(i.format_name).trim(), factor, fprice));
      if (fprice && !(Number(String(i.price ?? '').replace(',', '.')) > 0)) f.push(env.DB.prepare('UPDATE products SET price = ? WHERE id = ?').bind(r2(fprice / factor), p.id));
    }
    await runBatch(env, f);
  }
  return json({ ok: true, count: items.length });
}

async function productsBulkEdit(request, env, user) {
  need(user, 'productos.editar');
  const d = await body(request);
  const items = (d.items || []).filter((i) => Number(i.id));
  if (!items.length) return json({ ok: true, count: 0 });
  const { results: cur } = await allIn(env, 'SELECT id, price FROM products WHERE id IN (??)', items.map((i) => Number(i.id)));
  const old = Object.fromEntries(cur.map((p) => [p.id, p.price]));
  const allowed = ['name', 'category', 'price', 'supplier_id', 'min_stock', 'allergens', 'allergens_checked'];
  const stmts = [];
  for (const i of items) {
    const keys = allowed.filter((k) => k in i);
    if (!keys.length || !(i.id in old)) continue;
    const v = (k) => (k === 'price' || k === 'min_stock' ? Math.max(Number(i[k]) || 0, 0) : k === 'supplier_id' ? Number(i[k]) || null : k === 'allergens_checked' ? (i[k] ? 1 : 0) : k === 'allergens' ? (Array.isArray(i[k]) ? i[k] : String(i[k] || '').split(',')).filter((x) => ALLERGENS.includes(x)).join(',') || null : i[k] === '' ? null : i[k]);
    if (keys.includes('name') && !String(i.name || '').trim()) throw new HttpError(400, 'Hay un artículo sin nombre');
    stmts.push(env.DB.prepare(`UPDATE products SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).bind(...keys.map(v), i.id));
    if (keys.includes('price') && Math.abs(v('price') - old[i.id]) > 0.00005)
      stmts.push(env.DB.prepare('INSERT INTO price_history (product_id, old_price, new_price, receipt_id) VALUES (?,?,?,NULL)').bind(i.id, old[i.id], v('price')));
  }
  try { await runBatch(env, stmts); } catch (e) { if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Hay dos artículos con el mismo nombre'); throw e; }
  await refreshPrepCosts(env);
  return json({ ok: true, count: items.length });
}

async function recipesBulkEdit(request, env, user) {
  need(user, 'escandallos.editar');
  const d = await body(request);
  const items = (d.items || []).filter((i) => Number(i.id));
  const allowed = ['name', 'category', 'pvp', 'portions', 'misc_pct'];
  const stmts = [];
  for (const i of items) {
    const keys = allowed.filter((k) => k in i);
    if (!keys.length) continue;
    if (keys.includes('name') && !String(i.name || '').trim()) throw new HttpError(400, 'Hay un plato sin nombre');
    const v = (k) => (k === 'pvp' ? Math.max(Number(i.pvp) || 0, 0) : k === 'portions' ? Math.max(Number(i.portions) || 1, 0.01) : k === 'misc_pct' ? (i.misc_pct === '' || i.misc_pct == null ? null : Number(i.misc_pct)) : i[k] === '' ? null : i[k]);
    stmts.push(env.DB.prepare(`UPDATE recipes SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...keys.map(v), i.id));
  }
  try { await runBatch(env, stmts); } catch (e) { if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Hay dos platos con el mismo nombre'); throw e; }
  return json({ ok: true, count: items.length });
}

// ---------- avisos ----------
async function alerts(env, user) {
  const out = [];
  const add = (level, icon, text, link) => out.push({ level, icon, text, link });
  const q1 = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
  const day = localDay();
  const st = await settings(env);
  if (can(user, 'ventas.gestionar')) {
    const st2 = await staleSales(env);
    if (st2.ids.length) add('warn', '🔁', `Has cambiado escandallos después de volcar ventas: recalcula el consumo de ${st2.ids.length} volcado(s) para que el stock cuadre`, '#/ventas?tab=historial');
  }
  if (can(user, 'turnos.gestionar')) {
    // a partir del jueves, recordar el cuadrante de la semana siguiente
    const d = new Date(day + 'T12:00:00Z'), dow = (d.getUTCDay() + 6) % 7;
    const staffN = await q1('SELECT COUNT(*) AS n FROM staff WHERE active = 1');
    if (dow >= 3 && staffN.n) {
      const next = new Date(d.getTime() + (7 - dow) * 86400000).toISOString().slice(0, 10);
      const w = await q1(`SELECT status, changed FROM schedule_weeks WHERE week = ?`, next);
      if (!w || w.status !== 'publicado') add(dow >= 5 ? 'bad' : 'warn', '🗓️', 'El cuadrante de la semana que viene aún no está publicado', `#/turnos?week=${next}`);
    }
    const cur = new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10);
    const pend = await env.DB.prepare(`SELECT week, changed FROM schedule_weeks WHERE week >= ? AND status = 'publicado' AND changed IS NOT NULL AND changed <> '[]'`).bind(cur).all();
    for (const w of pend.results) add('warn', '🗓️', `Hay cambios en el cuadrante de la semana del ${w.week.slice(8)}/${w.week.slice(5, 7)} sin avisar al personal`, `#/turnos?week=${w.week}`);
  }
  if (can(user, 'caja.ver')) {
    const r = await q1(`SELECT COUNT(*) AS n, SUM((cash + card + bizum + other) - pos_total) AS diff FROM cash_days WHERE day >= date(?, '-7 days') AND pos_total IS NOT NULL AND (cash + card + bizum + other) - pos_total < -5`, day);
    if (r.n) add('bad', '💶', `Falta dinero en caja ${r.n} día(s) de la última semana (${Math.round(r.diff * 100) / 100} €)`, '#/panel?tab=caja');
  }
  if (can(user, 'caja.registrar')) {
    const r = await q1(`SELECT MAX(day) AS d FROM cash_days`);
    const yest = new Date(new Date(day + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    if (r.d && r.d < yest) add('warn', '💶', `No se ha registrado la caja desde el ${r.d}`, '#/caja');
  }
  if (can(user, 'costes.ver')) {
    const { results } = await env.DB.prepare(`SELECT p.name, ph.old_price, ph.new_price FROM price_history ph JOIN products p ON p.id = ph.product_id
      WHERE ph.created_at >= datetime('now', '-7 days') AND ph.old_price > 0 AND ph.new_price > ph.old_price * 1.05 ORDER BY (ph.new_price / ph.old_price) DESC`).all();
    if (results.length) add('warn', '📈', `Subidas de precio de más del 5 % esta semana: ${results.slice(0, 4).map((x) => `${x.name} (+${Math.round((x.new_price / x.old_price - 1) * 100)} %)`).join(', ')}${results.length > 4 ? '…' : ''}`, '#/panel?tab=compras');
  }
  if (can(user, 'panel.ver')) {
    const from = day.slice(0, 8) + '01';
    const d = await (await dashboard(env, new URL(`http://x/?from=${from}&to=${day}`))).json();
    if (d.food_cost_real != null && d.revenue > 0 && d.food_cost_real > st.food_cost_target + 3) add('bad', '🍽️', `Food cost real del mes: ${Math.round(d.food_cost_real * 10) / 10} % (objetivo ${st.food_cost_target} %)`, '#/panel?tab=foodcost');
    const w = await q1(`SELECT -SUM(CASE WHEN mov_date >= date(?, '-6 days') THEN qty * unit_cost END) AS week, -SUM(CASE WHEN mov_date < date(?, '-6 days') THEN qty * unit_cost END) / 4.0 AS avg4
      FROM movements WHERE type = 'merma' AND mov_date >= date(?, '-34 days')`, day, day, day);
    if (w.week > 30 && w.avg4 > 0 && w.week > w.avg4 * 1.5) add('warn', '🗑️', `Las mermas de esta semana (${Math.round(w.week)} €) superan en un ${Math.round((w.week / w.avg4 - 1) * 100)} % la media`, '#/panel?tab=mermas');
    const inv = await q1(`SELECT inv_date, total_diff_value FROM inventories ORDER BY id DESC LIMIT 1`);
    if (inv && inv.total_diff_value < -50) add('warn', '📋', `El último inventario (${inv.inv_date}) descuadró ${Math.round(inv.total_diff_value)} €`, '#/panel?tab=descuadres');
  }
  if (can(user, 'stock.ver') || can(user, 'pedidos.crear')) {
    const r = await q1(`SELECT COUNT(*) AS n FROM (SELECT p.id, p.min_stock, COALESCE((SELECT SUM(qty) FROM movements WHERE product_id = p.id), 0) AS s FROM products p WHERE p.active = 1 AND p.min_stock > 0) WHERE s < min_stock`);
    if (r.n) add('warn', '📦', `${r.n} artículo(s) por debajo del stock mínimo`, can(user, 'pedidos.crear') ? '#/pedidos/nuevo' : '#/stock');
  }
  if (can(user, 'pedidos.aprobar')) {
    const r = await q1(`SELECT COUNT(*) AS n FROM orders WHERE status = 'pendiente'`);
    if (r.n) add('bad', '📝', `${r.n} pedido(s) pendiente(s) de tu aprobación`, '#/pedidos');
  }
  if (can(user, 'pedidos.ver') || can(user, 'recepcion.crear')) {
    const r = await q1(`SELECT COUNT(*) AS n FROM orders WHERE status = 'enviado' AND COALESCE(expected_date, date(order_date, '+2 days')) < ?`, day);
    if (r.n) add('warn', '🚚', `${r.n} pedido(s) enviados sin recibir y ya fuera de plazo`, '#/recepcion');
  }
  if (can(user, 'appcc.registrar') || can(user, 'appcc.gestionar')) {
    const eq = await q1(`SELECT COUNT(*) AS n FROM appcc_equipment WHERE active = 1`);
    const shift = localHour() < 16 ? 'mañana' : 'tarde';
    if (eq.n) {
      const done = await q1(`SELECT COUNT(DISTINCT equipment_id) AS n FROM appcc_temps WHERE day = ? AND shift = ?`, day, shift);
      if (done.n < eq.n) add('warn', '🌡️', `Faltan ${eq.n - done.n} temperatura(s) por anotar (${shift})`, '#/appcc');
      const bad = await q1(`SELECT COUNT(*) AS n FROM appcc_temps WHERE day = ? AND ok = 0`, day);
      if (bad.n) add('bad', '🌡️', `${bad.n} lectura(s) de temperatura fuera de rango hoy`, '#/appcc');
    } else if (can(user, 'appcc.gestionar')) add('info', '🧊', 'Configura tus cámaras y el plan de limpieza para llevar el APPCC en la app', '#/appcc?tab=config');
    const exp = await expiring(env, 2);
    if (exp.length) add(exp.some((x) => x.days_left < 0) ? 'bad' : 'warn', '⏳', `${exp.length} lote(s) caducan en 2 días o menos${exp.some((x) => x.days_left < 0) ? ' (alguno ya caducado)' : ''}`, '#/appcc?tab=caducidades');
  }
  if (user.is_super) {
    const last = st.last_backup ? (Date.now() - new Date(st.last_backup.replace(' ', 'T') + 'Z')) / 86400000 : Infinity;
    if (last > 7) add('info', '💾', last === Infinity ? 'Todavía no has descargado ninguna copia de seguridad' : `La última copia de seguridad es de hace ${Math.floor(last)} días`, '#/copias');
  }
  if (can(user, 'productos.editar')) {
    const r = await q1(`SELECT COUNT(*) AS n FROM products WHERE active = 1 AND COALESCE(allergens_checked, 0) = 0`);
    if (r.n) add('info', '🧠', `${r.n} artículo(s) con alérgenos sin revisar`, '#/productos/alergenos');
  }
  if (can(user, 'ventas.gestionar')) {
    const r = await q1(`SELECT COUNT(DISTINCT pos_name) AS n FROM pos_pending`);
    if (r.n) add('warn', '🧾', `${r.n} nombre(s) de Qamarero sin vincular: sus ventas no cuentan`, '#/ventas?tab=pendientes');
  }
  if (can(user, 'escandallos.editar')) {
    const r = await q1(`SELECT COUNT(*) AS n FROM recipes r WHERE r.active = 1 AND COALESCE(r.kind, 'plato') = 'plato' AND NOT EXISTS (SELECT 1 FROM recipe_lines WHERE recipe_id = r.id)`);
    if (r.n) add('info', '🍽️', `${r.n} plato(s) de la carta sin escandallo`, '#/escandallos');
  }
  const order = { bad: 0, warn: 1, info: 2 };
  return out.sort((x, y) => order[x.level] - order[y.level]);
}

// ---------- resumen semanal (lunes a domingo) ----------
async function weeklySummary(env, endParam) {
  const today = localDay();
  const t = new Date((isDate(endParam) ? endParam : today) + 'T12:00:00Z');
  if (!isDate(endParam)) t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) - 1); // domingo pasado
  const to = t.toISOString().slice(0, 10), fromD = new Date(t); fromD.setUTCDate(fromD.getUTCDate() - 6);
  const from = fromD.toISOString().slice(0, 10);
  const prevTo = new Date(fromD); prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate() - 6);
  const dash = async (f, tt) => (await dashboard(env, new URL(`http://x/?from=${f}&to=${tt}`))).json();
  const [cur, prev, varc, top] = await Promise.all([
    dash(from, to), dash(prevFrom.toISOString().slice(0, 10), prevTo.toISOString().slice(0, 10)), variance(env, from, to),
    env.DB.prepare(`SELECT r.name, SUM(s.units) AS units, SUM(s.revenue) AS revenue FROM sales s JOIN recipes r ON r.id = s.recipe_id WHERE s.sale_date BETWEEN ? AND ? GROUP BY r.id ORDER BY revenue DESC LIMIT 5`).bind(from, to).all(),
  ]);
  const eq = await env.DB.prepare(`SELECT COUNT(*) AS n FROM appcc_equipment WHERE active = 1`).first();
  const tr = await env.DB.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS bad FROM appcc_temps WHERE day BETWEEN ? AND ?`).bind(from, to).first();
  const prices = (await env.DB.prepare(`SELECT p.name, p.unit, ph.old_price, ph.new_price FROM price_history ph JOIN products p ON p.id = ph.product_id WHERE date(ph.created_at) BETWEEN ? AND ? AND ph.old_price > 0 ORDER BY (ph.new_price - ph.old_price) / ph.old_price DESC LIMIT 5`).bind(from, to).all()).results;
  return {
    from, to, cur, prev, top: top.results, variance: varc.rows.slice(0, 5), prices,
    appcc: { expected: eq.n * 14, done: tr.n || 0, out_of_range: tr.bad || 0 },
  };
}

// ---------- aprobación de pedidos ----------
function canEditOrder(user, o) {
  if (!['borrador', 'pendiente'].includes(o.status)) return false;
  return can(user, 'pedidos.aprobar') || o.user_id === user.id;
}
async function approvers(env, exceptId) {
  const { results } = await env.DB.prepare('SELECT id, name, phone, email, is_super, perms FROM users WHERE active = 1').all();
  return results.filter((u) => u.id !== exceptId && permsOf(u).includes('pedidos.aprobar')).map(({ id, name, phone, email }) => ({ id, name, phone, email }));
}

// ---------- pedidos sugeridos ----------
// Consumo medio diario de las últimas 4 semanas (ventas por escandallo + mermas + personal + producción),
// ajustado al día de la semana, × días a cubrir + stock mínimo − stock actual. Se redondea al formato de compra.
async function suggestOrder(env, supplierId, days) {
  if (!supplierId) throw new HttpError(400, 'Elige el proveedor');
  const since = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.name, p.unit, p.min_stock, p.price,
      COALESCE((SELECT SUM(qty) FROM movements WHERE product_id = p.id), 0) AS stock,
      COALESCE((SELECT -SUM(qty) FROM movements WHERE product_id = p.id AND mov_date >= ? AND (type IN ('venta', 'merma', 'consumo_personal') OR (type = 'produccion' AND qty < 0))), 0) AS used,
      (SELECT MIN(mov_date) FROM movements WHERE product_id = p.id) AS first_mov
    FROM products p WHERE p.active = 1 AND p.supplier_id = ? AND p.prep_recipe_id IS NULL ORDER BY p.category, p.name`).bind(since, supplierId).all();
  // peso de los próximos días según cómo se reparte la venta por día de la semana
  const { results: wd } = await env.DB.prepare(`SELECT CAST(strftime('%w', sale_date) AS INTEGER) AS w, SUM(units) AS u FROM sales WHERE sale_date >= ? GROUP BY w`).bind(since).all();
  const totalU = wd.reduce((t, x) => t + x.u, 0);
  let factor = 1;
  if (totalU > 0) {
    const share = Object.fromEntries(wd.map((x) => [x.w, x.u / totalU]));
    let next = 0;
    for (let i = 1; i <= days; i++) next += share[(new Date(Date.now() + i * 86400000).getUTCDay())] || 0;
    factor = next / (days / 7); // >1 si se cubren días fuertes (fin de semana)
  }
  const { results: fmts } = await env.DB.prepare(`SELECT * FROM product_formats WHERE active = 1 AND is_default = 1`).all();
  const fmap = Object.fromEntries(fmts.map((f) => [f.product_id, f]));
  const out = results.map((p) => {
    const span = p.first_mov ? Math.min(28, Math.max(7, (Date.now() - new Date(p.first_mov + 'T12:00:00Z')) / 86400000)) : 28;
    const perDay = p.used / span;
    const needBase = Math.max(perDay * days * factor + p.min_stock - p.stock, 0);
    const f = fmap[p.id];
    let qty = 0, unit = p.unit;
    if (needBase > 0.0001) {
      if (f && f.factor > 0) { qty = Math.ceil(needBase / f.factor - 0.05); unit = 'f:' + f.id; }
      else qty = p.unit === 'ud' ? Math.ceil(needBase) : Math.ceil(needBase * 10) / 10;
    }
    return { product_id: p.id, name: p.name, stock: r2(p.stock), per_day: r2(perDay), min_stock: p.min_stock, need: r2(needBase), qty, unit };
  });
  return { days, weekday_factor: r2(factor), lines: out };
}

// ---------- APPCC ----------
const EQUIP_KINDS = ['refrigeracion', 'congelacion', 'caliente', 'otro'];
function localDay() { const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' })); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; }
const localHour = () => Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }));

async function appcc(env, user, ctx, method, b, c, request, url) {
  const day = localDay();
  // resumen del día: lo que falta por registrar
  if (b === 'today' && method === 'GET') {
    need(user, ['appcc.registrar', 'appcc.gestionar']);
    const [eq, temps, tasks, done, exp] = await Promise.all([
      env.DB.prepare('SELECT * FROM appcc_equipment WHERE active = 1 ORDER BY name').all(),
      env.DB.prepare(`SELECT t.*, u.name AS user_name FROM appcc_temps t LEFT JOIN users u ON u.id = t.user_id WHERE t.day = ? ORDER BY t.id`).bind(day).all(),
      env.DB.prepare('SELECT * FROM appcc_tasks WHERE active = 1 ORDER BY frequency, zone, name').all(),
      env.DB.prepare(`SELECT c.task_id, MAX(c.day) AS last_day, MAX(c.at) AS last_at FROM appcc_cleaning c GROUP BY c.task_id`).all(),
      expiring(env, 3),
    ]);
    const last = Object.fromEntries(done.results.map((x) => [x.task_id, x]));
    const span = { diaria: 0, semanal: 6, mensual: 29 };
    const dayDiff = (d) => (d ? Math.round((new Date(day + 'T12:00:00Z') - new Date(d + 'T12:00:00Z')) / 86400000) : Infinity);
    const shift = localHour() < 16 ? 'mañana' : 'tarde';
    return json({
      day, shift,
      equipment: eq.results.map((e) => ({ ...e, readings: temps.results.filter((t) => t.equipment_id === e.id) })),
      tasks: tasks.results.map((t) => { const l = last[t.id]; return { ...t, last_day: l?.last_day || null, due: dayDiff(l?.last_day) > (span[t.frequency] ?? 0) }; }),
      expiring: exp,
    });
  }
  if (b === 'temp' && method === 'POST') {
    need(user, ['appcc.registrar', 'appcc.gestionar']);
    const d = await body(request);
    const e = await env.DB.prepare('SELECT * FROM appcc_equipment WHERE id = ? AND active = 1').bind(d.equipment_id).first();
    if (!e) throw new HttpError(404, 'Equipo no encontrado');
    const t = Number(String(d.temp).replace(',', '.'));
    if (isNaN(t)) throw new HttpError(400, 'Indica la temperatura');
    const okT = (e.min_temp == null || t >= e.min_temp) && (e.max_temp == null || t <= e.max_temp);
    if (!okT && !String(d.action || '').trim()) throw new HttpError(400, 'Temperatura fuera de rango: anota la medida correctora (regular termostato, trasladar género, avisar al técnico…)');
    await env.DB.prepare('INSERT INTO appcc_temps (equipment_id, day, shift, temp, ok, action, user_id) VALUES (?,?,?,?,?,?,?)')
      .bind(e.id, day, d.shift === 'tarde' ? 'tarde' : 'mañana', t, okT ? 1 : 0, String(d.action || '').trim() || null, user.id).run();
    ctx.audit = { action: 'registro', entity: 'APPCC', summary: `Temperatura ${e.name}: ${t} °C${okT ? '' : ' (FUERA DE RANGO)'}` };
    return json({ ok: true, in_range: okT });
  }
  if (b === 'clean' && method === 'POST') {
    need(user, ['appcc.registrar', 'appcc.gestionar']);
    const d = await body(request);
    const t = await env.DB.prepare('SELECT * FROM appcc_tasks WHERE id = ? AND active = 1').bind(d.task_id).first();
    if (!t) throw new HttpError(404, 'Tarea no encontrada');
    await env.DB.prepare('INSERT INTO appcc_cleaning (task_id, day, notes, user_id) VALUES (?,?,?,?)').bind(t.id, day, String(d.notes || '').trim() || null, user.id).run();
    ctx.audit = { action: 'registro', entity: 'APPCC', summary: `Limpieza hecha: ${t.name}` };
    return json({ ok: true });
  }
  if ((b === 'temp' || b === 'clean') && method === 'DELETE' && c) {
    const table = b === 'temp' ? 'appcc_temps' : 'appcc_cleaning';
    const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(c).first();
    if (!row) throw new HttpError(404, 'Registro no encontrado');
    if (!can(user, 'appcc.gestionar') && !(row.user_id === user.id && row.day === day)) throw new HttpError(403, 'Solo puedes borrar tus registros de hoy');
    await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(c).run();
    ctx.audit = { action: 'borrado', entity: 'APPCC', summary: `Borrado registro de ${b === 'temp' ? 'temperatura' : 'limpieza'} del ${row.day}`, detail: row };
    return json({ ok: true });
  }
  // configuración de equipos y tareas
  if (b === 'equipment' || b === 'tasks') {
    const table = b === 'equipment' ? 'appcc_equipment' : 'appcc_tasks';
    if (method === 'GET') { need(user, ['appcc.registrar', 'appcc.gestionar']); return json((await env.DB.prepare(`SELECT * FROM ${table} WHERE active = 1 ORDER BY name`).all()).results); }
    need(user, 'appcc.gestionar');
    if (method === 'DELETE' && c) { await env.DB.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).bind(c).run(); return json({ ok: true }); }
    const d = await body(request);
    const items = Array.isArray(d.items) ? d.items : [d];
    const stmts = [];
    for (const i of items) {
      if (!String(i.name || '').trim()) throw new HttpError(400, 'Falta el nombre');
      const n = (x) => (x === '' || x == null || isNaN(Number(x)) ? null : Number(x));
      if (b === 'equipment') {
        const kind = EQUIP_KINDS.includes(i.kind) ? i.kind : 'otro';
        const vals = [i.name.trim(), kind, n(i.min_temp), n(i.max_temp)];
        stmts.push(method === 'PUT' && c ? env.DB.prepare('UPDATE appcc_equipment SET name=?, kind=?, min_temp=?, max_temp=? WHERE id = ?').bind(...vals, c)
          : env.DB.prepare('INSERT INTO appcc_equipment (name, kind, min_temp, max_temp) VALUES (?,?,?,?)').bind(...vals));
      } else {
        const freq = ['diaria', 'semanal', 'mensual'].includes(i.frequency) ? i.frequency : 'diaria';
        const vals = [i.name.trim(), String(i.zone || '').trim() || null, freq, String(i.product || '').trim() || null];
        stmts.push(method === 'PUT' && c ? env.DB.prepare('UPDATE appcc_tasks SET name=?, zone=?, frequency=?, product=? WHERE id = ?').bind(...vals, c)
          : env.DB.prepare('INSERT INTO appcc_tasks (name, zone, frequency, product) VALUES (?,?,?,?)').bind(...vals));
      }
    }
    await runBatch(env, stmts);
    return json({ ok: true, count: stmts.length });
  }
  // caducidades
  if (b === 'expiry') {
    need(user, ['appcc.registrar', 'appcc.gestionar', 'recepcion.crear']);
    if (method === 'GET') return json(await expiring(env, Math.min(Number(url.searchParams.get('days')) || 7, 60)));
    if (method === 'POST' && c) {
      const l = await env.DB.prepare('SELECT rl.id, rl.lot, rl.expiry, p.name FROM receipt_lines rl JOIN products p ON p.id = rl.product_id WHERE rl.id = ?').bind(c).first();
      if (!l) throw new HttpError(404, 'Lote no encontrado');
      await env.DB.prepare('UPDATE receipt_lines SET expiry_done = 1 WHERE id = ?').bind(c).run();
      ctx.audit = { action: 'cierre', entity: 'APPCC', summary: `Lote gastado o retirado: ${l.name}${l.lot ? ' (lote ' + l.lot + ')' : ''}, caduca ${l.expiry}` };
      return json({ ok: true });
    }
  }
  // informe para la inspección
  if (b === 'report' && method === 'GET') {
    need(user, ['appcc.gestionar', 'informes.ver']);
    const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : day.slice(0, 8) + '01';
    const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : day;
    const [temps, clean, recs] = await Promise.all([
      env.DB.prepare(`SELECT t.day, t.shift, e.name AS equipment, e.min_temp, e.max_temp, t.temp, t.ok, t.action, u.name AS user_name, t.at FROM appcc_temps t JOIN appcc_equipment e ON e.id = t.equipment_id LEFT JOIN users u ON u.id = t.user_id WHERE t.day BETWEEN ? AND ? ORDER BY t.day, e.name, t.shift`).bind(from, to).all(),
      env.DB.prepare(`SELECT c.day, k.name AS task, k.zone, k.frequency, k.product, c.notes, u.name AS user_name, c.at FROM appcc_cleaning c JOIN appcc_tasks k ON k.id = c.task_id LEFT JOIN users u ON u.id = c.user_id WHERE c.day BETWEEN ? AND ? ORDER BY c.day, k.zone, k.name`).bind(from, to).all(),
      env.DB.prepare(`SELECT r.receipt_date, s.name AS supplier, r.doc_type, r.delivery_note, r.rec_temp, r.rec_check, u.name AS user_name,
          (SELECT GROUP_CONCAT(p.name || COALESCE(' · lote ' || rl.lot, '') || COALESCE(' · cad. ' || rl.expiry, ''), ' | ') FROM receipt_lines rl JOIN products p ON p.id = rl.product_id WHERE rl.receipt_id = r.id) AS lines
        FROM receipts r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN users u ON u.id = r.user_id WHERE r.receipt_date BETWEEN ? AND ? ORDER BY r.receipt_date`).bind(from, to).all(),
    ]);
    const st = await settings(env);
    return json({ from, to, restaurant: st.restaurant_name, temps: temps.results, cleaning: clean.results, receptions: recs.results });
  }
  throw new HttpError(404, 'Ruta no encontrada');
}

async function expiring(env, days) {
  const { results } = await env.DB.prepare(`
    SELECT rl.id, rl.lot, rl.expiry, rl.qty, p.name, p.unit, p.id AS product_id, s.name AS supplier, r.receipt_date,
           CAST(julianday(rl.expiry) - julianday(date('now')) AS INTEGER) AS days_left
    FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id JOIN products p ON p.id = rl.product_id LEFT JOIN suppliers s ON s.id = r.supplier_id
    WHERE rl.expiry IS NOT NULL AND COALESCE(rl.expiry_done, 0) = 0 AND rl.expiry <= date('now', '+' || ? || ' days')
    ORDER BY rl.expiry LIMIT 200`).bind(String(days)).all();
  return results;
}

// ---------- elaboraciones intermedias ----------
async function ensurePrepProduct(env, recipeId, name, unit, category) {
  const r = await env.DB.prepare('SELECT product_id FROM recipes WHERE id = ?').bind(recipeId).first();
  let pid = r?.product_id;
  const exists = pid ? await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(pid).first() : null;
  let pname = name;
  const clash = await env.DB.prepare('SELECT id FROM products WHERE name = ? AND (prep_recipe_id IS NULL OR prep_recipe_id <> ?)').bind(pname, recipeId).first();
  if (clash) pname = `${name} (elaboración)`;
  if (!exists) {
    pid = (await env.DB.prepare(`INSERT INTO products (name, category, unit, price, prep_recipe_id, allergens_checked) VALUES (?,?,?,0,?,1)
      ON CONFLICT(name) DO UPDATE SET prep_recipe_id = excluded.prep_recipe_id, unit = excluded.unit, active = 1 RETURNING id`).bind(pname, category || 'Elaboraciones', unit, recipeId).first()).id;
    await env.DB.prepare('UPDATE recipes SET product_id = ? WHERE id = ?').bind(pid, recipeId).run();
  } else {
    await env.DB.prepare('UPDATE products SET name = ?, unit = ?, active = 1, prep_recipe_id = ? WHERE id = ?').bind(pname, unit, recipeId, pid).run();
  }
  return pid;
}

// Coste por kg/l/ud de cada elaboración = coste del lote ÷ lo que produce. Se repite por si unas usan otras.
// Sus alérgenos son los de sus ingredientes.
async function refreshPrepCosts(env) {
  for (let pass = 0; pass < 4; pass++) {
    const { results } = await env.DB.prepare(`
      SELECT r.id, r.product_id, r.yield_qty,
             COALESCE(SUM(rl.qty / ${YIELD_SQL} * p.price), 0) * (1 + COALESCE(r.misc_pct, (SELECT CAST(value AS REAL) FROM settings WHERE key = 'misc_pct'), 0) / 100.0) AS batch,
             GROUP_CONCAT(p.allergens) AS algs, MIN(COALESCE(p.allergens_checked, 0)) AS checked,
             (SELECT price FROM products WHERE id = r.product_id) AS cur, (SELECT allergens FROM products WHERE id = r.product_id) AS cur_alg
      FROM recipes r LEFT JOIN recipe_lines rl ON rl.recipe_id = r.id LEFT JOIN products p ON p.id = rl.product_id
      WHERE r.active = 1 AND r.kind = 'elaboracion' AND r.product_id IS NOT NULL GROUP BY r.id`).all();
    const stmts = [];
    for (const x of results) {
      const price = x.yield_qty > 0 ? Math.round((x.batch / x.yield_qty) * 10000) / 10000 : 0;
      const alg = [...new Set(String(x.algs || '').split(',').filter((a) => ALLERGENS.includes(a)))].sort().join(',') || null;
      if (Math.abs(price - (x.cur || 0)) > 0.00005 || alg !== (x.cur_alg || null))
        stmts.push(env.DB.prepare('UPDATE products SET price = ?, allergens = ?, allergens_checked = ? WHERE id = ?').bind(price, alg, x.checked ? 1 : 0, x.product_id));
    }
    if (!stmts.length) return;
    await runBatch(env, stmts);
  }
}

// Exporta la carta con las mismas columnas del archivo que se importó de Qamarero
async function recipesExport(env, user) {
  need(user, ['escandallos.editar', 'ventas.gestionar']);
  const st = await settings(env);
  const { results } = await env.DB.prepare('SELECT id, name, category, pvp, pos_name, pos_raw FROM recipes WHERE active = 1 ORDER BY id').all();
  const qc = st.qamarero_cols; // { headers: [...], map: { name: i, pvp: i, category: i } }
  const headers = qc?.headers?.length ? qc.headers : ['Nombre', 'Categoría', 'Precio'];
  const map = qc?.map || { name: 0, category: 1, pvp: 2 };
  const fmtPrice = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const rows = results.map((r) => {
    let row = [];
    try { row = JSON.parse(r.pos_raw || '[]'); } catch { row = []; }
    row = headers.map((_, i) => (row[i] ?? ''));
    if (map.name >= 0) row[map.name] = r.pos_name || r.name;
    if (map.pvp >= 0) row[map.pvp] = fmtPrice(r.pvp);
    if (map.category >= 0 && r.category) row[map.category] = r.category;
    return { row, known: !!r.pos_raw };
  });
  rows.sort((x, y) => Number(y.known) - Number(x.known)); // los nuevos, al final
  return json({ headers, rows: rows.map((x) => x.row), from_qamarero: !!qc, sheet: qc?.sheet || 'Productos' });
}

async function recipesBulk(request, env, user) {
  need(user, 'escandallos.editar');
  const d = await body(request);
  const items = (d.items || []).filter((i) => i.name && String(i.name).trim());
  const stmts = items.map((i) => env.DB.prepare(
    `INSERT INTO recipes (name, category, pvp, pos_name, pos_raw) VALUES (?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET pvp = CASE WHEN excluded.pvp > 0 THEN excluded.pvp ELSE pvp END,
       category = COALESCE(excluded.category, category), pos_name = COALESCE(pos_name, excluded.pos_name),
       pos_raw = COALESCE(excluded.pos_raw, pos_raw), active = 1`
  ).bind(String(i.name).trim(), i.category || null, Number(String(i.pvp ?? 0).replace(',', '.')) || 0, String(i.name).trim(), Array.isArray(i._raw) ? JSON.stringify(i._raw) : null));
  // formato del archivo de Qamarero, para poder exportar con las mismas columnas
  if (Array.isArray(d.headers) && d.headers.length && d.map)
    stmts.push(env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('qamarero_carta_cols', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(JSON.stringify({ headers: d.headers.map(String), map: d.map, sheet: d.sheet || null })));
  await runBatch(env, stmts);
  return json({ ok: true, count: items.length });
}

async function salesImport(request, env, user) {
  const d = await body(request);
  if (!isDate(d.date_from) || !isDate(d.date_to)) throw new HttpError(400, 'Indica las fechas del periodo');
  let saved = 0;
  if (Array.isArray(d.pending) && d.pending.length) saved = await savePending(env, d.pending, d.date_from, d.date_to, d.filename || 'manual');
  if (!(d.rows || []).length) return json({ pending_saved: saved });
  return json({ ...(await importSales(env, user.id, d)), pending_saved: saved });
}

async function savePending(env, pending, from, to, source) {
  const stmts = pending.filter((p) => p.pos_name && Number(p.units) > 0).map((p) => env.DB.prepare(
    'INSERT INTO pos_pending (pos_name, units, revenue, date_from, date_to, source) VALUES (?,?,?,?,?,?)'
  ).bind(String(p.pos_name).trim(), Number(p.units), p.revenue === '' || p.revenue == null || isNaN(Number(p.revenue)) ? null : Number(p.revenue), from, to, source));
  if (stmts.length) await runBatch(env, stmts);
  return stmts.length;
}

// Empareja nombres del TPV con platos: primero vínculos guardados, luego nombre del plato
async function matchPosRows(env, rows) {
  const [{ results: aliases }, { results: recipes }] = await Promise.all([
    env.DB.prepare('SELECT a.pos_name, a.recipe_id, a.factor, a.pvp FROM pos_aliases a JOIN recipes r ON r.id = a.recipe_id AND r.active = 1').all(),
    env.DB.prepare(`SELECT id, name, pos_name FROM recipes WHERE active = 1 AND COALESCE(kind, 'plato') = 'plato'`).all(),
  ]);
  const norm = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
  const amap = Object.fromEntries(aliases.map((a) => [norm(a.pos_name), a]));
  const rmap = {};
  for (const r of recipes) { rmap[norm(r.name)] = r.id; if (r.pos_name) rmap[norm(r.pos_name)] = r.id; }
  // parecido: sin tildes, signos ni plurales ("Ensaladilla de Gambas" = "Ensaladilla de Gamba", "Venao" = "Venado")
  const fz = (s) => norm(s).replace(/[^a-z0-9ñ ]/g, ' ').replace(/\bvenao\b/g, 'venado').split(/\s+/).filter(Boolean).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)).join(' ');
  const fzmap = {};
  for (const r of recipes) for (const n of [r.name, r.pos_name]) if (n) { const k2 = fz(n); fzmap[k2] = fzmap[k2] === undefined || fzmap[k2] === r.id ? r.id : null; }
  const HALF = /^(1\/2|½|media|medio)\s+(?:(?:racion|rac\.?)\s+)?(?:de\s+)?(.+)$/;
  const matched = [], pending = [];
  for (const row of rows) {
    const name = row.name ?? row.pos_name;
    const k = norm(name);
    if (!k || !(Number(row.units) > 0)) continue;
    const a = amap[k];
    if (a) { matched.push({ pos_name: name, recipe_id: a.recipe_id, factor: a.factor, pvp: a.pvp, units: row.units, revenue: row.revenue }); continue; }
    if (rmap[k]) { matched.push({ pos_name: name, recipe_id: rmap[k], factor: 1, units: row.units, revenue: row.revenue }); continue; }
    // medias raciones y variantes del nombre: se vinculan solas (y se recuerdan al importar)
    const h = HALF.exec(k);
    const id = h ? fzmap[fz(h[2])] : fzmap[fz(k)];
    if (id) matched.push({ pos_name: name, recipe_id: id, factor: h ? 0.5 : 1, units: row.units, revenue: row.revenue, auto: true });
    else pending.push({ pos_name: name, units: row.units, revenue: row.revenue });
  }
  return { matched, pending };
}

async function importSales(env, userId, d) {
  const rows = (d.rows || []).filter((r) => r.recipe_id && Number(r.units) > 0);
  if (!rows.length) throw new HttpError(400, 'No hay filas asociadas a platos');
  const user = { id: userId };
  const { iva_pct } = await settings(env);
  const div = 1 + iva_pct / 100;

  // guardar vínculos nombre Qamarero -> plato (con factor, p. ej. 1/2 ración = 0,5)
  if (d.save_aliases) {
    const alias = rows.filter((r) => r.pos_name).map((r) => env.DB.prepare(
      `INSERT INTO pos_aliases (pos_name, recipe_id, factor, pvp) VALUES (?,?,?,?)
       ON CONFLICT(pos_name) DO UPDATE SET recipe_id = excluded.recipe_id, factor = excluded.factor, pvp = COALESCE(excluded.pvp, pvp)`
    ).bind(String(r.pos_name).trim(), r.recipe_id, Number(r.factor) > 0 ? Number(r.factor) : 1, Number(r.pvp) > 0 ? Number(r.pvp) : null));
    if (alias.length) await runBatch(env, alias);
  }

  const ids = [...new Set(rows.map((r) => Number(r.recipe_id)))];
  const { results: recs } = await allIn(env, 'SELECT id, name, pvp, portions FROM recipes WHERE id IN (??)', ids);
  const rmap = Object.fromEntries(recs.map((r) => [r.id, r]));

  // agrupar por plato: raciones equivalentes = unidades vendidas × factor
  const byRecipe = {};
  for (const r of rows) {
    const rec = rmap[r.recipe_id];
    if (!rec) continue;
    const factor = Number(r.factor) > 0 ? Number(r.factor) : 1;
    const units = Number(r.units);
    const hasRevenue = r.revenue !== undefined && r.revenue !== null && r.revenue !== '' && !isNaN(Number(r.revenue));
    const gross = hasRevenue ? Number(r.revenue) : units * (Number(r.pvp) > 0 ? Number(r.pvp) : factor * rec.pvp);
    byRecipe[rec.id] = byRecipe[rec.id] || { units: 0, revenue: 0 };
    byRecipe[rec.id].units += units * factor;
    byRecipe[rec.id].revenue += gross / div;
  }
  let totalRevenue = 0;
  const saleRows = [];
  for (const rec of recs) {
    const agg = byRecipe[rec.id];
    if (!agg) continue;
    totalRevenue += agg.revenue;
    saleRows.push({ recipe_id: rec.id, units: agg.units, revenue: agg.revenue });
  }
  const { consumption, noRecipe } = await saleConsumption(env, saleRows);
  const imp = await env.DB.prepare(
    `INSERT INTO sales_imports (date_from, date_to, filename, rows, revenue, user_id, calc_at) VALUES (?,?,?,?,?,?, datetime('now')) RETURNING id`
  ).bind(d.date_from, d.date_to, d.filename || null, saleRows.length, r2(totalRevenue), user.id).first();
  const stmts = saleRows.map((s) => env.DB.prepare('INSERT INTO sales (import_id, recipe_id, sale_date, units, revenue) VALUES (?,?,?,?,?)')
    .bind(imp.id, s.recipe_id, d.date_to, s.units, r2(s.revenue)));
  stmts.push(...saleMovements(env, consumption, imp.id, d.date_from, d.date_to, user.id));
  await runBatch(env, stmts);
  return { id: imp.id, revenue: r2(totalRevenue), dishes: saleRows.length, without_recipe: noRecipe };
}

// Lo que se ha gastado de cada artículo por unas ventas (raciones × escandallo actual, con mermas de limpieza y cocción)
async function saleConsumption(env, saleRows) {
  const ids = [...new Set(saleRows.map((r) => Number(r.recipe_id)))];
  if (!ids.length) return { consumption: {}, noRecipe: [] };
  const [{ results: recs }, { results: lines }] = await Promise.all([
    allIn(env, 'SELECT id, name, portions FROM recipes WHERE id IN (??)', ids),
    allIn(env, `SELECT rl.recipe_id, rl.product_id, rl.qty, rl.waste_pct, rl.cook_loss_pct, p.price FROM recipe_lines rl JOIN products p ON p.id = rl.product_id
     WHERE rl.recipe_id IN (??)`, ids),
  ]);
  const rmap = Object.fromEntries(recs.map((r) => [r.id, r]));
  const consumption = {};
  for (const s of saleRows) {
    const rec = rmap[s.recipe_id];
    if (!rec) continue;
    const portions = Number(rec.portions) || 1;
    for (const l of lines.filter((x) => x.recipe_id === rec.id)) {
      consumption[l.product_id] = consumption[l.product_id] || { qty: 0, price: l.price };
      consumption[l.product_id].qty += (l.qty / lineYield(l) / portions) * s.units;
    }
  }
  return { consumption, noRecipe: recs.filter((r) => !lines.some((l) => l.recipe_id === r.id)).map((r) => r.name) };
}
function saleMovements(env, consumption, impId, from, to, userId) {
  return Object.entries(consumption).map(([pid, c]) => env.DB.prepare(
    `INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(Number(pid), 'venta', -r2(c.qty), c.price, `Ventas ${from} → ${to}`, `venta-${impId}`, 'venta', impId, userId, to));
}
// Rehace el consumo de un volcado de ventas con los escandallos de hoy (el importe vendido no cambia)
async function recalcSales(env, impId, userId) {
  const imp = await env.DB.prepare('SELECT * FROM sales_imports WHERE id = ?').bind(impId).first();
  if (!imp) throw new HttpError(404, 'Volcado no encontrado');
  const { results: rows } = await env.DB.prepare('SELECT recipe_id, units FROM sales WHERE import_id = ?').bind(impId).all();
  const { consumption, noRecipe } = await saleConsumption(env, rows);
  await runBatch(env, [
    env.DB.prepare(`DELETE FROM movements WHERE ref_type = 'venta' AND ref_id = ?`).bind(impId),
    ...saleMovements(env, consumption, impId, imp.date_from, imp.date_to, imp.user_id || userId),
    env.DB.prepare(`UPDATE sales_imports SET calc_at = datetime('now') WHERE id = ?`).bind(impId),
  ]);
  return { id: Number(impId), articles: Object.keys(consumption).length, without_recipe: noRecipe.length };
}
async function staleSales(env) {
  const ch = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'recipes_changed_at'`).first();
  if (!ch) return { changed_at: null, ids: [] };
  const { results } = await env.DB.prepare(`SELECT id FROM sales_imports WHERE COALESCE(calc_at, created_at) < ? ORDER BY date_to`).bind(ch.value).all();
  return { changed_at: ch.value, ids: results.map((r) => r.id) };
}

// ---------- cuadro de mando ----------
async function dashboard(env, url) {
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : todayStr().slice(0, 8) + '01';
  const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : todayStr();
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);

  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds);
  const [st, mv, purchases, sales, fixed, stockVal, topWaste, topDishes, prices, lowStock, bySupplier, dishes] = await Promise.all([
    settings(env),
    q(`SELECT type, -SUM(qty * unit_cost) AS value FROM movements WHERE mov_date BETWEEN ? AND ? GROUP BY type`, from, to).all(),
    q(`SELECT COALESCE(SUM(total), 0) AS v, COUNT(*) AS n FROM receipts WHERE receipt_date BETWEEN ? AND ?`, from, to).first(),
    q(`SELECT COALESCE(SUM(revenue), 0) AS v, COALESCE(SUM(units), 0) AS units FROM sales WHERE sale_date BETWEEN ? AND ?`, from, to).first(),
    env.DB.prepare(`SELECT concept, category, amount, frequency FROM fixed_costs WHERE active = 1`).all(),
    env.DB.prepare(`SELECT COALESCE(SUM(s.stock * p.price), 0) AS v FROM (SELECT product_id, SUM(qty) AS stock FROM movements GROUP BY product_id) s JOIN products p ON p.id = s.product_id WHERE p.active = 1 AND s.stock > 0`).first(),
    q(`SELECT p.name, p.unit, -SUM(m.qty) AS qty, -SUM(m.qty * m.unit_cost) AS value FROM movements m JOIN products p ON p.id = m.product_id
       WHERE m.type IN ('merma') AND m.mov_date BETWEEN ? AND ? GROUP BY p.id ORDER BY value DESC LIMIT 8`, from, to).all(),
    q(`SELECT r.name, SUM(s.units) AS units, SUM(s.revenue) AS revenue FROM sales s JOIN recipes r ON r.id = s.recipe_id
       WHERE s.sale_date BETWEEN ? AND ? GROUP BY r.id ORDER BY revenue DESC LIMIT 10`, from, to).all(),
    env.DB.prepare(`SELECT p.name, p.unit, ph.old_price, ph.new_price, ph.created_at FROM price_history ph JOIN products p ON p.id = ph.product_id
       WHERE ph.created_at >= datetime('now', '-45 days') ORDER BY ph.id DESC LIMIT 10`).all(),
    env.DB.prepare(`SELECT * FROM (${PRODUCTS_SQL}) WHERE min_stock > 0 AND stock < min_stock LIMIT 20`).all(),
    q(`SELECT s.name, SUM(r.total) AS total FROM receipts r JOIN suppliers s ON s.id = r.supplier_id WHERE r.receipt_date BETWEEN ? AND ? GROUP BY s.id ORDER BY total DESC LIMIT 8`, from, to).all(),
    env.DB.prepare(RECIPES_SQL).all(),
  ]);
  const pendingPos = await env.DB.prepare('SELECT COUNT(DISTINCT pos_name) AS n FROM pos_pending').first();
  const cash = await env.DB.prepare(
    `SELECT COUNT(*) AS days, COALESCE(SUM(cash + card + bizum + other), 0) AS total, COALESCE(SUM(cash), 0) AS cash, COALESCE(SUM(card), 0) AS card,
            COALESCE(SUM(bizum + other), 0) AS other, COALESCE(SUM(covers), 0) AS covers,
            SUM(CASE WHEN pos_total IS NOT NULL THEN (cash + card + bizum + other) - pos_total END) AS diff,
            SUM(CASE WHEN pos_total IS NOT NULL THEN 1 ELSE 0 END) AS days_with_pos
     FROM cash_days WHERE day BETWEEN ? AND ?`
  ).bind(from, to).first();

  const byType = Object.fromEntries(mv.results.map((r) => [r.type, r.value || 0]));
  const theoretical = byType.venta || 0;
  const waste = byType.merma || 0;
  const staff = byType.consumo_personal || 0;
  const invDiff = byType.ajuste || 0; // positivo = falta producto
  const realConsumption = theoretical + waste + staff + invDiff;
  const monthly = fixed.results.reduce((s, f) => s + f.amount / (f.frequency === 'anual' ? 12 : f.frequency === 'trimestral' ? 3 : 1), 0);
  const fixedPeriod = (monthly * days) / 30.4375;
  const revenue = sales.v;
  const div = 1 + st.iva_pct / 100;
  const pct = (x) => (revenue > 0 ? (x / revenue) * 100 : null);

  const dishAlerts = dishes.results
    .filter((r) => r.kind === 'plato' && r.pvp > 0 && r.n_lines > 0)
    .map((r) => ({ name: r.name, cost: r.cost, pvp: r.pvp, fc: (r.cost / (r.pvp / div)) * 100 }))
    .filter((r) => r.fc > st.food_cost_target + 5)
    .sort((x, y) => y.fc - x.fc)
    .slice(0, 8);

  return json({
    from, to, days, settings: st,
    revenue, units_sold: sales.units, purchases: purchases.v, n_receipts: purchases.n,
    theoretical, waste, staff, inv_diff: invDiff, real_consumption: realConsumption,
    food_cost_theoretical: pct(theoretical), food_cost_real: pct(realConsumption),
    fixed_monthly: monthly, fixed_period: fixedPeriod, fixed_pct: pct(fixedPeriod),
    result: revenue - realConsumption - fixedPeriod,
    stock_value: stockVal.v,
    top_waste: topWaste.results, top_dishes: topDishes.results, price_changes: prices.results,
    low_stock: lowStock.results, by_supplier: bySupplier.results, dish_alerts: dishAlerts,
    recipes_without_lines: dishes.results.filter((r) => r.kind === 'plato' && r.n_lines === 0).length,
    pending_pos: pendingPos.n,
    cash,
  });
}

// ---------- estadísticas ----------
function period(url) {
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : todayStr().slice(0, 8) + '01';
  const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : todayStr();
  const g = url.searchParams.get('group');
  const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const group = ['day', 'week', 'month'].includes(g) ? g : days <= 45 ? 'day' : days <= 200 ? 'week' : 'month';
  const bucket = (col) => (group === 'day' ? `${col}` : group === 'week' ? `date(${col}, '-' || ((strftime('%w', ${col}) + 6) % 7) || ' days')` : `substr(${col}, 1, 7)`);
  return { from, to, group, bucket };
}

// genera todas las etiquetas del periodo para que las series no tengan huecos
function buckets(from, to, group) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z'), end = new Date(to + 'T12:00:00Z');
  if (group === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  while (d <= end) {
    const k = d.toISOString().slice(0, 10);
    out.push(group === 'month' ? k.slice(0, 7) : k);
    if (group === 'day') d.setUTCDate(d.getUTCDate() + 1);
    else if (group === 'week') d.setUTCDate(d.getUTCDate() + 7);
    else { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); }
  }
  return [...new Set(out)];
}
const series = (keys, rows, field, key = 'b') => keys.map((k) => Number(rows.find((r) => r[key] === k)?.[field]) || 0);

async function stats(env, url, tab) {
  const { from, to, group, bucket } = period(url);
  const keys = buckets(from, to, group);
  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).all().then((r) => r.results);
  const st = await settings(env);
  const div = 1 + st.iva_pct / 100;
  const out = { from, to, group, labels: keys };

  if (tab === 'ventas') {
    const [sales, cash, dishes, cats] = await Promise.all([
      q(`SELECT ${bucket('sale_date')} AS b, SUM(revenue) AS revenue, SUM(units) AS units FROM sales WHERE sale_date BETWEEN ? AND ? GROUP BY b`, from, to),
      q(`SELECT ${bucket('day')} AS b, SUM(cash + card + bizum + other) AS total, SUM(covers) AS covers FROM cash_days WHERE day BETWEEN ? AND ? GROUP BY b`, from, to),
      q(`SELECT r.name, r.category, SUM(s.units) AS units, SUM(s.revenue) AS revenue FROM sales s JOIN recipes r ON r.id = s.recipe_id WHERE s.sale_date BETWEEN ? AND ? GROUP BY r.id ORDER BY revenue DESC`, from, to),
      q(`SELECT COALESCE(r.category, 'Sin categoría') AS name, SUM(s.revenue) AS value FROM sales s JOIN recipes r ON r.id = s.recipe_id WHERE s.sale_date BETWEEN ? AND ? GROUP BY 1 ORDER BY value DESC`, from, to),
    ]);
    const cashTotal = cash.reduce((x, r) => x + (r.total || 0), 0), covers = cash.reduce((x, r) => x + (r.covers || 0), 0);
    Object.assign(out, {
      revenue: series(keys, sales, 'revenue'), cash: series(keys, cash, 'total').map((v) => v / div), covers: series(keys, cash, 'covers'),
      total_revenue: sales.reduce((x, r) => x + (r.revenue || 0), 0), total_cash: cashTotal, total_covers: covers,
      avg_ticket: covers ? cashTotal / covers : null, dishes, categories: cats,
    });
  } else if (tab === 'compras') {
    const [pur, sup, cat, prices, prods] = await Promise.all([
      q(`SELECT ${bucket('receipt_date')} AS b, SUM(total) AS total FROM receipts WHERE receipt_date BETWEEN ? AND ? GROUP BY b`, from, to),
      q(`SELECT s.name, SUM(r.total) AS value, COUNT(*) AS n FROM receipts r JOIN suppliers s ON s.id = r.supplier_id WHERE r.receipt_date BETWEEN ? AND ? GROUP BY s.id ORDER BY value DESC`, from, to),
      q(`SELECT COALESCE(p.category, 'Sin categoría') AS name, SUM(rl.qty * rl.price) AS value FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id JOIN products p ON p.id = rl.product_id WHERE r.receipt_date BETWEEN ? AND ? GROUP BY 1 ORDER BY value DESC`, from, to),
      q(`SELECT p.name, p.unit, ph.old_price, ph.new_price, ph.created_at FROM price_history ph JOIN products p ON p.id = ph.product_id WHERE date(ph.created_at) BETWEEN ? AND ? ORDER BY (ph.new_price - ph.old_price) / NULLIF(ph.old_price, 0) DESC LIMIT 30`, from, to),
      q(`SELECT p.name, p.unit, SUM(rl.qty) AS qty, SUM(rl.qty * rl.price) AS value, SUM(rl.qty * rl.price) / NULLIF(SUM(rl.qty), 0) AS avg_price FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id JOIN products p ON p.id = rl.product_id WHERE r.receipt_date BETWEEN ? AND ? GROUP BY p.id ORDER BY value DESC LIMIT 30`, from, to),
    ]);
    Object.assign(out, { purchases: series(keys, pur, 'total'), total: pur.reduce((x, r) => x + (r.total || 0), 0), suppliers: sup, categories: cat, prices, products: prods });
  } else if (tab === 'mermas') {
    const [ser, reasons, prods, users] = await Promise.all([
      q(`SELECT ${bucket('mov_date')} AS b, -SUM(CASE WHEN type = 'merma' THEN qty * unit_cost END) AS waste, -SUM(CASE WHEN type = 'consumo_personal' THEN qty * unit_cost END) AS staff FROM movements WHERE type IN ('merma', 'consumo_personal') AND mov_date BETWEEN ? AND ? GROUP BY b`, from, to),
      q(`SELECT type, COALESCE(reason, 'Sin motivo') AS name, -SUM(qty * unit_cost) AS value, COUNT(DISTINCT grp) AS n FROM movements WHERE type IN ('merma', 'consumo_personal') AND mov_date BETWEEN ? AND ? GROUP BY type, 2 ORDER BY value DESC`, from, to),
      q(`SELECT p.name, p.unit, -SUM(m.qty) AS qty, -SUM(m.qty * m.unit_cost) AS value FROM movements m JOIN products p ON p.id = m.product_id WHERE m.type = 'merma' AND m.mov_date BETWEEN ? AND ? GROUP BY p.id ORDER BY value DESC LIMIT 20`, from, to),
      q(`SELECT COALESCE(u.name, '—') AS name, -SUM(CASE WHEN m.type = 'merma' THEN m.qty * m.unit_cost END) AS waste, -SUM(CASE WHEN m.type = 'consumo_personal' THEN m.qty * m.unit_cost END) AS staff, COUNT(DISTINCT m.grp) AS n
         FROM movements m LEFT JOIN users u ON u.id = m.user_id WHERE m.type IN ('merma', 'consumo_personal') AND m.mov_date BETWEEN ? AND ? GROUP BY m.user_id ORDER BY waste DESC`, from, to),
    ]);
    Object.assign(out, { waste: series(keys, ser, 'waste'), staff: series(keys, ser, 'staff'), reasons, products: prods, users });
  } else if (tab === 'foodcost') {
    const [sales, mv, dishes] = await Promise.all([
      q(`SELECT ${bucket('sale_date')} AS b, SUM(revenue) AS revenue FROM sales WHERE sale_date BETWEEN ? AND ? GROUP BY b`, from, to),
      q(`SELECT ${bucket('mov_date')} AS b, -SUM(CASE WHEN type = 'venta' THEN qty * unit_cost END) AS theo, -SUM(CASE WHEN type IN ('merma', 'consumo_personal', 'ajuste') THEN qty * unit_cost END) AS extra FROM movements WHERE type IN ('venta', 'merma', 'consumo_personal', 'ajuste') AND mov_date BETWEEN ? AND ? GROUP BY b`, from, to),
      q(`SELECT r.id, r.name, r.category, r.pvp, rc.cost, COALESCE(SUM(s.units), 0) AS units, COALESCE(SUM(s.revenue), 0) AS revenue
         FROM (${RECIPES_SQL}) rc JOIN recipes r ON r.id = rc.id LEFT JOIN sales s ON s.recipe_id = r.id AND s.sale_date BETWEEN ? AND ?
         WHERE rc.n_lines > 0 AND rc.kind = 'plato' GROUP BY r.id`, from, to),
    ]);
    const rev = series(keys, sales, 'revenue'), theo = series(keys, mv, 'theo'), extra = series(keys, mv, 'extra');
    // ingeniería de menú: popularidad (uds vs media) y margen unitario (vs media ponderada)
    const sold = dishes.filter((d) => d.units > 0);
    const totalUnits = sold.reduce((x, d) => x + d.units, 0);
    const margin = (d) => d.pvp / div - d.cost;
    const avgMargin = totalUnits ? sold.reduce((x, d) => x + margin(d) * d.units, 0) / totalUnits : 0;
    const popLine = sold.length ? (totalUnits / sold.length) * 0.7 : 0;
    Object.assign(out, {
      revenue: rev, fc_theoretical: rev.map((r, i) => (r ? (theo[i] / r) * 100 : null)), fc_real: rev.map((r, i) => (r ? ((theo[i] + extra[i]) / r) * 100 : null)),
      target: st.food_cost_target,
      dishes: dishes.map((d) => {
        const m = margin(d), popular = d.units >= popLine && d.units > 0, profitable = m >= avgMargin;
        return { ...d, net_price: d.pvp / div, margin: m, fc: d.pvp ? (d.cost / (d.pvp / div)) * 100 : null, contribution: m * d.units,
          class: !d.units ? 'sin ventas' : popular && profitable ? 'estrella' : popular ? 'vaca' : profitable ? 'puzzle' : 'perro' };
      }).sort((x, y) => y.contribution - x.contribution),
      avg_margin: avgMargin,
    });
  } else if (tab === 'caja') {
    const [days, sales] = await Promise.all([
      q(`SELECT day, cash, card, bizum, other, cash_out, pos_total, covers, (cash + card + bizum + other) AS total FROM cash_days WHERE day BETWEEN ? AND ? ORDER BY day`, from, to),
      q(`SELECT ${bucket('day')} AS b, SUM(cash) AS cash, SUM(card) AS card, SUM(bizum + other) AS other, SUM(CASE WHEN pos_total IS NOT NULL THEN cash + card + bizum + other - pos_total END) AS diff FROM cash_days WHERE day BETWEEN ? AND ? GROUP BY b`, from, to),
    ]);
    Object.assign(out, { cash: series(keys, sales, 'cash'), card: series(keys, sales, 'card'), other: series(keys, sales, 'other'), diff: series(keys, sales, 'diff'), days });
  } else if (tab === 'descuadres') {
    Object.assign(out, await variance(env, from, to));
  } else throw new HttpError(404, 'Pestaña no encontrada');
  return json(out);
}

// Descuadre por artículo: lo que dicen los recuentos frente a lo que debería haber
async function variance(env, from, to) {
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.name, p.unit, p.category, p.price, p.prep_recipe_id,
      SUM(CASE WHEN m.type = 'entrada' THEN m.qty ELSE 0 END) AS entradas,
      -SUM(CASE WHEN m.type = 'venta' THEN m.qty ELSE 0 END) AS ventas,
      -SUM(CASE WHEN m.type = 'merma' THEN m.qty ELSE 0 END) AS mermas,
      -SUM(CASE WHEN m.type = 'consumo_personal' THEN m.qty ELSE 0 END) AS personal,
      -SUM(CASE WHEN m.type = 'produccion' AND m.qty < 0 THEN m.qty ELSE 0 END) AS produccion_uso,
      SUM(CASE WHEN m.type = 'produccion' AND m.qty > 0 THEN m.qty ELSE 0 END) AS producido,
      SUM(CASE WHEN m.type = 'ajuste' THEN m.qty ELSE 0 END) AS descuadre,
      SUM(CASE WHEN m.type = 'ajuste' THEN m.qty * m.unit_cost ELSE 0 END) AS descuadre_valor
    FROM movements m JOIN products p ON p.id = m.product_id
    WHERE m.mov_date BETWEEN ? AND ? GROUP BY p.id`).bind(from, to).all();
  const { results: counts } = await env.DB.prepare(`
    SELECT il.product_id, MAX(i.inv_date) AS last_count, SUM(CASE WHEN i.inv_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS counts_in_period
    FROM inventory_lines il JOIN inventories i ON i.id = il.inventory_id GROUP BY il.product_id`).bind(from, to).all();
  const cmap = Object.fromEntries(counts.map((c) => [c.product_id, c]));
  const rows = results.map((r) => {
    const consumo = r.ventas + r.mermas + r.personal + r.produccion_uso;
    const c = cmap[r.id] || {};
    return { ...r, consumo, pct: consumo > 0 ? (r.descuadre / consumo) * 100 : null, last_count: c.last_count || null, counted: (c.counts_in_period || 0) > 0 };
  });
  const counted = rows.filter((r) => r.counted);
  const total = counted.reduce((t, r) => t + r.descuadre_valor, 0);
  // qué contar: lo que más valor mueve y hace más de 14 días que no se cuenta
  const stale = (d) => !d || (Date.now() - new Date(d + 'T12:00:00Z')) / 86400000 > 14;
  const toCount = rows.filter((r) => stale(r.last_count) && r.consumo > 0).map((r) => ({ ...r, consumo_valor: r.consumo * r.price }))
    .sort((a, b) => b.consumo_valor - a.consumo_valor).slice(0, 15);
  return {
    rows: counted.sort((a, b) => a.descuadre_valor - b.descuadre_valor),
    total_descuadre: total, n_counted: counted.length, n_moved: rows.length, to_count: toCount,
  };
}

// ---------- informes ----------
const REPORTS = {
  resultado: 'Cuenta de resultados del periodo',
  compras_proveedor: 'Compras por proveedor (albaranes)',
  compras_producto: 'Compras por artículo',
  mermas: 'Mermas (detalle)',
  personal: 'Consumo de personal (detalle)',
  foodcost: 'Food cost y margen por plato',
  ventas: 'Ventas por plato',
  caja: 'Cuadre de caja diario',
  stock: 'Inventario valorado (stock actual)',
  descuadres: 'Descuadres de inventario (recuentos)',
  desviacion: 'Descuadre por artículo (consumo teórico frente a real)',
  gastos: 'Gastos fijos',
};

async function report(env, url, type, user) {
  const { from, to } = period(url);
  const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).all().then((r) => r.results);
  const st = await settings(env);
  const div = 1 + st.iva_pct / 100;
  const C = (k, l, t = 'text') => ({ k, l, t });
  let columns, rows, total = null;
  if (!REPORTS[type]) throw new HttpError(404, 'Informe no encontrado');
  if (!can(user, 'costes.ver') && !['caja', 'ventas'].includes(type)) throw new HttpError(403, 'Este informe muestra costes. Necesitas permiso para ver costes.');

  if (type === 'resultado') {
    const r = await (await dashboard(env, url)).json();
    columns = [C('concepto', 'Concepto'), C('importe', 'Importe', 'eur'), C('pct', '% s/ventas', 'pct')];
    const p = (x) => (r.revenue ? (x / r.revenue) * 100 : null);
    rows = [
      { concepto: 'Ventas sin IVA (Qamarero)', importe: r.revenue, pct: 100 },
      { concepto: 'Caja real cobrada (con IVA)', importe: r.cash.total, pct: null },
      { concepto: 'Consumo según escandallos', importe: -r.theoretical, pct: p(r.theoretical) },
      { concepto: 'Mermas', importe: -r.waste, pct: p(r.waste) },
      { concepto: 'Consumo de personal', importe: -r.staff, pct: p(r.staff) },
      { concepto: 'Descuadre de inventario', importe: -r.inv_diff, pct: p(r.inv_diff) },
      { concepto: 'Margen bruto', importe: r.revenue - r.real_consumption, pct: p(r.revenue - r.real_consumption) },
      { concepto: 'Gastos fijos del periodo', importe: -r.fixed_period, pct: p(r.fixed_period) },
      { concepto: 'Resultado estimado', importe: r.result, pct: p(r.result) },
      { concepto: 'Compras registradas (albaranes)', importe: r.purchases, pct: p(r.purchases) },
    ];
  } else if (type === 'compras_proveedor') {
    columns = [C('receipt_date', 'Fecha', 'date'), C('supplier', 'Proveedor'), C('doc', 'Documento'), C('lines', 'Líneas', 'num'), C('user', 'Recibió'), C('total', 'Total', 'eur')];
    rows = await q(`SELECT r.receipt_date, s.name AS supplier, (CASE WHEN r.doc_type = 'factura' THEN 'Factura ' ELSE 'Albarán ' END) || COALESCE(r.delivery_note, '#' || r.id) AS doc, (SELECT COUNT(*) FROM receipt_lines WHERE receipt_id = r.id) AS lines, u.name AS user, r.total
      FROM receipts r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN users u ON u.id = r.user_id WHERE r.receipt_date BETWEEN ? AND ? ORDER BY s.name, r.receipt_date`, from, to);
    total = { total: rows.reduce((x, r) => x + r.total, 0) };
  } else if (type === 'compras_producto') {
    columns = [C('name', 'Artículo'), C('category', 'Categoría'), C('supplier', 'Proveedor'), C('qty', 'Cantidad', 'num'), C('unit', 'Ud'), C('avg_price', 'Precio medio', 'eur'), C('min_price', 'Mín.', 'eur'), C('max_price', 'Máx.', 'eur'), C('value', 'Importe', 'eur')];
    rows = await q(`SELECT p.name, p.category, s.name AS supplier, SUM(rl.qty) AS qty, p.unit, SUM(rl.qty * rl.price) / NULLIF(SUM(rl.qty), 0) AS avg_price, MIN(rl.price) AS min_price, MAX(rl.price) AS max_price, SUM(rl.qty * rl.price) AS value
      FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id JOIN products p ON p.id = rl.product_id LEFT JOIN suppliers s ON s.id = r.supplier_id
      WHERE r.receipt_date BETWEEN ? AND ? GROUP BY p.id, r.supplier_id ORDER BY value DESC`, from, to);
    total = { value: rows.reduce((x, r) => x + r.value, 0) };
  } else if (type === 'mermas' || type === 'personal') {
    const t = type === 'mermas' ? 'merma' : 'consumo_personal';
    columns = [C('mov_date', 'Fecha', 'date'), C('label', 'Qué'), C('reason', 'Motivo'), C('user', 'Quién'), C('notes', 'Notas'), C('value', 'Valor', 'eur')];
    rows = await q(`SELECT m.mov_date, m.label, m.reason, u.name AS user, m.notes, -SUM(m.qty * m.unit_cost) AS value FROM movements m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.type = ? AND m.mov_date BETWEEN ? AND ? GROUP BY m.grp ORDER BY m.mov_date, MAX(m.id)`, t, from, to);
    total = { value: rows.reduce((x, r) => x + r.value, 0) };
  } else if (type === 'foodcost') {
    const d = await (await stats(env, url, 'foodcost')).json();
    columns = [C('name', 'Plato'), C('category', 'Categoría'), C('cost', 'Coste ración', 'eur'), C('pvp', 'PVP con IVA', 'eur'), C('net_price', 'PVP sin IVA', 'eur'), C('fc', 'Food cost', 'pct'), C('margin', 'Margen ud', 'eur'), C('units', 'Vendidas', 'num'), C('contribution', 'Margen total', 'eur'), C('class', 'Clasificación')];
    rows = d.dishes;
    total = { units: rows.reduce((x, r) => x + r.units, 0), contribution: rows.reduce((x, r) => x + r.contribution, 0) };
  } else if (type === 'ventas') {
    columns = [C('name', 'Plato'), C('category', 'Categoría'), C('units', 'Raciones', 'num'), C('revenue', 'Ventas sin IVA', 'eur'), C('share', '% ventas', 'pct')];
    rows = await q(`SELECT r.name, r.category, SUM(s.units) AS units, SUM(s.revenue) AS revenue FROM sales s JOIN recipes r ON r.id = s.recipe_id WHERE s.sale_date BETWEEN ? AND ? GROUP BY r.id ORDER BY revenue DESC`, from, to);
    const t = rows.reduce((x, r) => x + r.revenue, 0);
    rows.forEach((r) => (r.share = t ? (r.revenue / t) * 100 : null));
    total = { units: rows.reduce((x, r) => x + r.units, 0), revenue: t };
  } else if (type === 'caja') {
    columns = [C('day', 'Día', 'date'), C('cash', 'Efectivo', 'eur'), C('card', 'Tarjeta', 'eur'), C('bizum', 'Bizum/transf.', 'eur'), C('other', 'Otros', 'eur'), C('total', 'Total caja', 'eur'), C('pos_total', 'Cierre Qamarero', 'eur'), C('diff', 'Descuadre', 'eur'), C('covers', 'Comensales', 'num'), C('ticket', 'Ticket medio', 'eur'), C('cash_out', 'Pagos desde caja', 'eur'), C('notes', 'Notas')];
    rows = (await q(`SELECT * FROM cash_days WHERE day BETWEEN ? AND ? ORDER BY day`, from, to)).map((r) => {
      const tot = r.cash + r.card + r.bizum + r.other;
      return { ...r, total: tot, diff: r.pos_total == null ? null : tot - r.pos_total, ticket: r.covers ? tot / r.covers : null };
    });
    const sum = (k) => rows.reduce((x, r) => x + (Number(r[k]) || 0), 0);
    total = { cash: sum('cash'), card: sum('card'), bizum: sum('bizum'), other: sum('other'), total: sum('total'), pos_total: sum('pos_total'), diff: sum('diff'), covers: sum('covers'), cash_out: sum('cash_out') };
  } else if (type === 'stock') {
    columns = [C('name', 'Artículo'), C('category', 'Categoría'), C('supplier_name', 'Proveedor'), C('stock', 'Stock', 'num'), C('unit', 'Ud'), C('price', 'Precio', 'eur'), C('value', 'Valor', 'eur')];
    rows = (await q(PRODUCTS_SQL)).map((p) => ({ ...p, value: Math.max(p.stock, 0) * p.price }));
    total = { value: rows.reduce((x, r) => x + r.value, 0) };
  } else if (type === 'descuadres') {
    columns = [C('inv_date', 'Fecha', 'date'), C('name', 'Artículo'), C('expected', 'Teórico', 'num'), C('counted', 'Contado', 'num'), C('unit', 'Ud'), C('detail', 'Recuento'), C('diff', 'Diferencia', 'num'), C('value', 'Valor', 'eur'), C('user', 'Quién')];
    rows = await q(`SELECT i.inv_date, p.name, il.expected, il.counted, p.unit, il.detail, il.counted - il.expected AS diff,
        (SELECT SUM(m.qty * m.unit_cost) FROM movements m WHERE m.ref_type = 'inventario' AND m.ref_id = i.id AND m.product_id = il.product_id) AS value, u.name AS user
      FROM inventory_lines il JOIN inventories i ON i.id = il.inventory_id JOIN products p ON p.id = il.product_id LEFT JOIN users u ON u.id = i.user_id
      WHERE i.inv_date BETWEEN ? AND ? ORDER BY i.inv_date, value`, from, to);
    total = { value: rows.reduce((x, r) => x + (r.value || 0), 0) };
  } else if (type === 'desviacion') {
    const vr = await variance(env, from, to);
    columns = [C('name', 'Artículo'), C('unit', 'Ud'), C('entradas', 'Entradas', 'num'), C('ventas', 'Ventas (escandallo)', 'num'), C('mermas', 'Mermas', 'num'), C('personal', 'Personal', 'num'),
      C('produccion_uso', 'Usado en producción', 'num'), C('descuadre', 'Descuadre', 'num'), C('pct', '% s/ consumo', 'pct'), C('descuadre_valor', 'Valor descuadre', 'eur'), C('last_count', 'Último recuento', 'date')];
    rows = vr.rows;
    total = { descuadre_valor: vr.total_descuadre };
  } else if (type === 'gastos') {
    columns = [C('concept', 'Concepto'), C('category', 'Categoría'), C('amount', 'Importe', 'eur'), C('frequency', 'Periodicidad'), C('monthly', 'Al mes', 'eur'), C('period', 'En el periodo', 'eur')];
    const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
    rows = (await q('SELECT * FROM fixed_costs WHERE active = 1 ORDER BY category, concept')).map((f) => {
      const m = f.amount / (f.frequency === 'anual' ? 12 : f.frequency === 'trimestral' ? 3 : 1);
      return { ...f, monthly: m, period: (m * days) / 30.4375 };
    });
    total = { monthly: rows.reduce((x, r) => x + r.monthly, 0), period: rows.reduce((x, r) => x + r.period, 0) };
  }
  return json({ type, title: REPORTS[type], from, to, restaurant: st.restaurant_name, columns, rows, total, list: REPORTS });
}

// ---------- OCR ----------
const normText = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'con', 'y', 'a', 'al', 'x', 'ud', 'uds', 'kg', 'gr', 'g', 'l', 'lt', 'cl', 'ml', 'caja', 'cj', 'pack', 'bot', 'botella']);
const tokens = (t) => new Set(normText(t).split(' ').filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)));
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w) || [...B].some((x) => x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x)))) inter++;
  return inter / Math.min(A.size, B.size) * (inter / Math.max(A.size, B.size)) ** 0.3;
}

const OCR_SCHEMA = {
  type: 'object',
  properties: {
    supplier_name: { type: 'string', description: 'Nombre comercial o razón social del proveedor que emite el documento' },
    supplier_cif: { type: 'string', description: 'CIF/NIF del proveedor (no el del cliente)' },
    document_type: { type: 'string', enum: ['albaran', 'factura'], description: 'albaran si es un albarán o nota de entrega; factura si es una factura' },
    document_number: { type: 'string', description: 'Número de albarán o factura' },
    date: { type: 'string', description: 'Fecha del documento en formato AAAA-MM-DD' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Código o referencia del artículo, si aparece' },
          description: { type: 'string', description: 'Descripción del artículo tal como está escrita' },
          quantity: { type: 'number', description: 'Cantidad facturada' },
          unit: { type: 'string', description: 'Unidad tal como aparece: KG, UD, CAJ, BOT, L…; vacío si no aparece' },
          unit_price: { type: 'number', description: 'Precio unitario sin IVA, después de descuentos' },
          line_total: { type: 'number', description: 'Importe de la línea sin IVA' },
        },
        required: ['description', 'quantity', 'unit', 'unit_price', 'line_total', 'code'],
        additionalProperties: false,
      },
    },
    total_without_vat: { type: 'number', description: 'Base imponible total' },
    total_with_vat: { type: 'number', description: 'Total con IVA' },
  },
  required: ['supplier_name', 'supplier_cif', 'document_type', 'document_number', 'date', 'lines', 'total_without_vat', 'total_with_vat'],
  additionalProperties: false,
};
const OCR_PROMPT = `Eres un asistente de un restaurante en España. Lee este albarán o factura de proveedor y extrae sus datos.
- Una línea por artículo; ignora portes, envases retornables con importe 0, subtotales y líneas de IVA.
- Precios y totales SIN IVA. Si hay descuento en la línea, unit_price ya descontado.
- Usa punto decimal. Si un número no se lee, pon 0. Si un texto no aparece, cadena vacía.
- Si el documento está escrito a mano, haz tu mejor lectura.`;

// Por defecto, la IA incluida gratis en Cloudflare (sin tarjeta, bloquea al pasar el cupo diario, no cobra).
// Claude solo se usa si se configura expresamente OCR_PROVIDER=claude con su clave.
function ocrProvider(env) {
  if (env.OCR_PROVIDER === 'claude' && env.ANTHROPIC_API_KEY) return 'claude';
  if (env.AI) return 'cloudflare';
  return null;
}

async function ocrClaude(env, files) {
  const content = files.map((f) => f.media_type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } }
    : { type: 'image', source: { type: 'base64', media_type: f.media_type, data: f.data } });
  content.push({ type: 'text', text: OCR_PROMPT });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: env.OCR_MODEL || 'claude-sonnet-5-5', max_tokens: 8000,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: OCR_SCHEMA } },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, 'No se pudo leer el documento: ' + (data.error?.message || res.status));
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return JSON.parse(text);
}

async function ocrCloudflare(env, files) {
  const imgs = files.filter((f) => f.media_type !== 'application/pdf');
  if (!imgs.length) throw new HttpError(400, 'Con la IA de Cloudflare solo se pueden leer fotos, no PDF. Haz una foto al documento.');
  const out = await env.AI.run(env.OCR_CF_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct', {
    messages: [{ role: 'user', content: [
      { type: 'text', text: OCR_PROMPT + '\nResponde SOLO con un JSON con esta estructura: ' + JSON.stringify(OCR_SCHEMA) },
      ...imgs.map((f) => ({ type: 'image_url', image_url: { url: `data:${f.media_type};base64,${f.data}` } })),
    ] }],
    max_tokens: 4000,
  });
  if (out && typeof out.response === 'object' && out.response) return out.response;
  const text = String(out?.response ?? '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('respuesta sin JSON');
  try { return JSON.parse(m[0]); } catch { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } // tolera comas finales
}

async function ocrScan(request, env, user) {
  const d = await body(request);
  const files = (d.files || []).filter((f) => f && f.data && /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(f.media_type)).slice(0, 5);
  if (!files.length) throw new HttpError(400, 'Adjunta una foto o PDF del albarán');
  const provider = ocrProvider(env);
  if (!provider) throw new HttpError(501, 'El escáner no está activado. Sigue el apartado "Activar el escáner de albaranes" de la guía. Mientras tanto, mete los datos a mano.');
  let raw;
  try {
    raw = provider === 'claude' ? await ocrClaude(env, files) : await ocrCloudflare(env, files);
  } catch (e) {
    const msg = String(e.message || e);
    // si falla (cupo gratuito del día agotado, foto ilegible…) se sigue a mano, sin perder nada
    const quota = /limit|quota|neuron|429|capacity/i.test(msg);
    return json({ failed: true, message: quota ? 'Se ha agotado el cupo gratuito de lectura de hoy. Mete los datos a mano; mañana vuelve a funcionar.' : 'No he podido leer el documento. Mete los datos a mano o prueba con una foto más nítida.', detail: msg.slice(0, 200) });
  }
  if (!raw || !Array.isArray(raw.lines) || !raw.lines.length) return json({ failed: true, message: 'No he encontrado líneas de artículos en la foto. Mete los datos a mano o prueba con otra foto más recta y con luz.' });

  // proveedor: por CIF y, si no, por parecido del nombre
  const { results: sups } = await env.DB.prepare('SELECT id, name, cif FROM suppliers WHERE active = 1').all();
  const cif = normText(raw.supplier_cif).replace(/ /g, '');
  let supplier = Number(d.supplier_id) ? sups.find((x) => x.id === Number(d.supplier_id)) : null;
  if (!supplier && cif.length >= 8) supplier = sups.find((x) => normText(x.cif).replace(/ /g, '') === cif);
  if (!supplier) {
    const best = sups.map((x) => ({ x, sc: similarity(x.name, raw.supplier_name) })).sort((a1, b1) => b1.sc - a1.sc)[0];
    if (best && best.sc >= 0.5) supplier = best.x;
  }

  // productos: primero lo aprendido con este proveedor, después parecido del nombre
  const { results: prods } = await env.DB.prepare('SELECT id, name, unit, price, supplier_id FROM products WHERE active = 1').all();
  const { results: fmts } = await env.DB.prepare('SELECT * FROM product_formats WHERE active = 1').all();
  const aliases = supplier ? (await env.DB.prepare('SELECT source, product_id, unit FROM ocr_aliases WHERE supplier_id = ?').bind(supplier.id).all()).results : [];
  const amap = Object.fromEntries(aliases.map((x) => [x.source, x]));
  const unitGuess = (p, printed) => {
    const u = normText(printed);
    if (p.unit === 'kg' && /^(kg|kgs|kilo|kilos)$/.test(u)) return 'kg';
    if (p.unit === 'kg' && /^(g|gr|grs)$/.test(u)) return 'g';
    if (p.unit === 'l' && /^(l|lt|lts|litro|litros)$/.test(u)) return 'l';
    if (p.unit === 'ud' && /^(ud|uds|u|un|unid|unidad|unidades|bot|botella)$/.test(u)) return 'ud';
    const def = fmts.find((f) => f.product_id === p.id && f.is_default);
    if (/^(caj|cja|cj|caja|cajas|pack|paq|saco|sac|barril|garrafa|bandeja|bdj)/.test(u) && def) return 'f:' + def.id;
    return p.unit;
  };
  const lines = (raw.lines || []).filter((l) => l.description && Number(l.quantity)).map((l) => {
    const qty = Number(l.quantity);
    const price = Number(l.line_total) > 0 ? Number(l.line_total) / qty : Number(l.unit_price) || 0;
    const source = [l.code, l.description].filter(Boolean).join(' ').trim();
    const learned = amap[normText(source)];
    let product = learned ? prods.find((p) => p.id === learned.product_id) : null, confidence = learned ? 'aprendido' : null;
    if (!product) {
      const cands = prods.map((p) => ({ p, sc: similarity(p.name, l.description) + (supplier && p.supplier_id === supplier.id ? 0.1 : 0) })).sort((a1, b1) => b1.sc - a1.sc);
      if (cands[0] && cands[0].sc >= 0.45) { product = cands[0].p; confidence = cands[0].sc >= 0.75 ? 'alta' : 'revisar'; }
    }
    return {
      source, description: l.description || '', printed_unit: l.unit || '', qty, price: Math.round(price * 10000) / 10000, line_total: Number(l.line_total) || qty * price,
      product_id: product?.id || null, unit: product ? (learned?.unit || unitGuess(product, l.unit)) : null, confidence,
    };
  });
  const scan = await env.DB.prepare('INSERT INTO ocr_scans (user_id, provider, supplier_id, result) VALUES (?,?,?,?) RETURNING id')
    .bind(user.id, provider, supplier?.id || null, JSON.stringify(raw)).first();
  return json({
    ocr_id: scan.id, provider,
    supplier_id: supplier?.id || null, supplier_name: raw.supplier_name || '', supplier_cif: raw.supplier_cif || '',
    doc_type: /factura/i.test(raw.document_type || '') ? 'factura' : 'albaran',
    delivery_note: raw.document_number || '', date: isDate(raw.date) ? raw.date : null,
    total_without_vat: raw.total_without_vat || null, total_with_vat: raw.total_with_vat || null, lines,
  });
}

export { json, HttpError, body, need, can, runBatch, r2, isDate, settings, localDay, permsOf, uuid, todayStr };
