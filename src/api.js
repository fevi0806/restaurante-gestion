// API de la aplicación de gestión del restaurante (Cloudflare Pages Functions + D1)

const ALL = ['direccion', 'cocina', 'sala'];

// ---------- permisos ----------
// El superusuario lo puede todo y decide con casillas qué puede hacer cada persona.
const PERMS = [
  'panel.ver', 'informes.ver', 'costes.ver',
  'caja.registrar', 'caja.ver',
  'pedidos.ver', 'pedidos.crear',
  'recepcion.ver', 'recepcion.crear', 'recepcion.anular',
  'mermas.registrar', 'mermas.ver_todas', 'mermas.borrar',
  'stock.ver', 'inventario.hacer',
  'escandallos.ver', 'escandallos.editar',
  'productos.editar', 'ventas.gestionar', 'gastos.gestionar',
];
const TEMPLATES = {
  sala: ['caja.registrar', 'mermas.registrar', 'escandallos.ver'],
  cocina: ['pedidos.ver', 'pedidos.crear', 'recepcion.ver', 'recepcion.crear', 'mermas.registrar', 'mermas.ver_todas', 'stock.ver', 'inventario.hacer', 'escandallos.ver', 'escandallos.editar', 'productos.editar', 'costes.ver'],
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

async function hashPass(pass, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return toHex(salt) + ':' + toHex(bits);
}
async function checkPass(pass, stored) {
  const [salt] = String(stored).split(':');
  return (await hashPass(pass, salt)) === stored;
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
  return { restaurant_name: s.restaurant_name || 'Mi restaurante', iva_pct: Number(s.iva_pct ?? 10), food_cost_target: Number(s.food_cost_target ?? 30) };
}

// ---------- consultas reutilizables ----------
const PRODUCTS_SQL = `
  SELECT p.id, p.name, p.category, p.unit, p.price, p.supplier_id, p.min_stock, s.name AS supplier_name,
         COALESCE((SELECT SUM(m.qty) FROM movements m WHERE m.product_id = p.id), 0) AS stock
  FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
  WHERE p.active = 1 ORDER BY p.category, p.name`;

const RECIPES_SQL = `
  SELECT r.id, r.name, r.category, r.pvp, r.portions, r.pos_name, r.notes,
         COALESCE(SUM(rl.qty / (1 - MIN(rl.waste_pct, 95) / 100.0) * p.price), 0) / NULLIF(r.portions, 0) AS cost,
         COUNT(rl.id) AS n_lines
  FROM recipes r
  LEFT JOIN recipe_lines rl ON rl.recipe_id = r.id
  LEFT JOIN products p ON p.id = rl.product_id
  WHERE r.active = 1 GROUP BY r.id ORDER BY r.category, r.name`;

// Ingredientes brutos por RACIÓN de una receta
async function recipePerPortion(env, recipeId) {
  const r = await env.DB.prepare('SELECT id, name, portions FROM recipes WHERE id = ? AND active = 1').bind(recipeId).first();
  if (!r) throw new HttpError(404, 'Plato no encontrado');
  const { results } = await env.DB.prepare(
    `SELECT rl.product_id, rl.qty, rl.waste_pct, p.price, p.name, p.unit FROM recipe_lines rl JOIN products p ON p.id = rl.product_id WHERE rl.recipe_id = ?`
  ).bind(recipeId).all();
  const portions = Number(r.portions) || 1;
  return {
    recipe: r,
    lines: results.map((l) => ({ ...l, gross: l.qty / (1 - Math.min(l.waste_pct || 0, 95) / 100) / portions })),
  };
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
  const ph = ids.map(() => '?').join(',');
  const [{ results: prods }, { results: fmts }] = await Promise.all([
    env.DB.prepare(`SELECT id, name, unit, price FROM products WHERE id IN (${ph})`).bind(...ids).all(),
    env.DB.prepare(`SELECT * FROM product_formats WHERE product_id IN (${ph})`).bind(...ids).all(),
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

// ---------- CRUD genérico de maestros ----------
const TABLES = {
  suppliers: { cols: ['name', 'contact', 'phone', 'email', 'order_days', 'notes', 'cif'], read: null, write: 'productos.editar', required: ['name'] },
  products: { cols: ['name', 'category', 'unit', 'price', 'supplier_id', 'min_stock'], read: null, write: 'productos.editar', required: ['name', 'unit'] },
  fixed_costs: { cols: ['concept', 'category', 'amount', 'frequency', 'notes'], read: 'gastos.gestionar', write: 'gastos.gestionar', required: ['concept'] },
};

function pick(obj, cols) {
  const out = {};
  for (const c of cols) if (c in obj) out[c] = obj[c] === '' ? null : obj[c];
  return out;
}

async function crud(table, id, method, request, env, user) {
  const cfg = TABLES[table];
  if (method === 'GET') {
    if (cfg.read) need(user, cfg.read);
    const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE active = 1 ORDER BY 2`).all();
    return json(results);
  }
  need(user, cfg.write);
  if (method === 'DELETE') {
    await env.DB.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  }
  const data = pick(await body(request), cfg.cols);
  if (method === 'POST') {
    for (const c of cfg.required) if (!data[c]) throw new HttpError(400, `Falta el campo ${c}`);
    const keys = Object.keys(data);
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
export async function onRequest({ request, env, params }) {
  const url = new URL(request.url);
  const parts = Array.isArray(params.route) ? params.route : [params.route].filter(Boolean);
  try {
    return await route(parts, request.method, request, env, url);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Error del servidor: ' + e.message }, 500);
  }
}

async function route(parts, method, request, env, url) {
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
    const u = await env.DB.prepare('SELECT * FROM users WHERE username = ? AND active = 1').bind(String(d.username || '').trim()).first();
    if (!u || !(await checkPass(String(d.password || ''), u.pass))) throw new HttpError(401, 'Usuario o contraseña incorrectos');
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

  const user = await getUser(request, env);
  if (!user) throw new HttpError(401, 'Sesión caducada. Vuelve a entrar.');

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
      recipes = recipes.map(({ cost, ...r }) => r);
      formats = formats.map(({ price, ...f }) => f);
    }
    return json({ user, settings: st, suppliers: sup.results, products, recipes, formats });
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
    const stmts = ['restaurant_name', 'iva_pct', 'food_cost_target'].filter((k) => k in d)
      .map((k) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(d[k])));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }

  // --- maestros ---
  if (a === 'products' && b === 'bulk' && method === 'POST') return productsBulk(request, env, user);
  if (a === 'products' && (method === 'POST' || method === 'PUT')) {
    const d = await request.clone().json().catch(() => ({}));
    if (d.unit && !['kg', 'l', 'ud'].includes(d.unit)) throw new HttpError(400, 'La unidad base debe ser kg, l o ud. Las cajas, botellas o sacos se añaden como formatos.');
    const res = await crud(a, b, method, request, env, user);
    if (res.ok && Array.isArray(d.formats)) {
      const id = method === 'POST' ? (await res.clone().json()).id : Number(b);
      await syncFormats(env, id, d.formats);
    }
    return res;
  }
  if (TABLES[a]) return crud(a, b, method, request, env, user);

  // --- usuarios y permisos (solo superusuario) ---
  if (a === 'users') {
    need(user, 'super');
    if (method === 'GET') {
      const { results } = await env.DB.prepare('SELECT id, name, username, role, active, is_super, perms FROM users ORDER BY active DESC, is_super DESC, name').all();
      return json({ users: results.map((u) => ({ ...u, is_super: !!u.is_super, perms: permsOf(u) })), perms: PERMS, templates: TEMPLATES });
    }
    const d = await body(request);
    if (d.role && !ALL.includes(d.role)) throw new HttpError(400, 'Rol no válido');
    const perms = Array.isArray(d.perms) ? JSON.stringify(d.perms.filter((x) => PERMS.includes(x))) : undefined;
    if (method === 'POST') {
      if (!d.name || !d.username || String(d.password || '').length < 6) throw new HttpError(400, 'Nombre, usuario y contraseña (mín. 6 caracteres)');
      try {
        const r = await env.DB.prepare('INSERT INTO users (name, username, pass, role, is_super, perms) VALUES (?,?,?,?,?,?) RETURNING id')
          .bind(d.name, d.username.trim(), await hashPass(d.password), d.role || 'sala', d.is_super ? 1 : 0, perms ?? JSON.stringify(TEMPLATES[d.role || 'sala'])).first();
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
  if (a === 'orders') {
    need(user, method === 'GET' ? ['pedidos.ver', 'pedidos.crear'] : 'pedidos.crear');
    if (method === 'GET' && !b) {
      const { results } = await env.DB.prepare(
        `SELECT o.*, s.name AS supplier_name, u.name AS user_name,
                (SELECT SUM(qty * COALESCE(price, 0)) FROM order_lines WHERE order_id = o.id) AS total,
                (SELECT COUNT(*) FROM order_lines WHERE order_id = o.id) AS n_lines
         FROM orders o JOIN suppliers s ON s.id = o.supplier_id LEFT JOIN users u ON u.id = o.user_id
         ORDER BY CASE o.status WHEN 'enviado' THEN 0 WHEN 'borrador' THEN 1 ELSE 2 END, o.id DESC LIMIT 200`
      ).all();
      return json(results);
    }
    if (method === 'GET' && b) {
      const o = await env.DB.prepare(
        `SELECT o.*, s.name AS supplier_name, s.phone, s.email, s.contact FROM orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?`
      ).bind(b).first();
      if (!o) throw new HttpError(404, 'Pedido no encontrado');
      const { results } = await env.DB.prepare(
        `SELECT ol.*, p.name, p.unit FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY p.name`
      ).bind(b).all();
      return json({ ...o, lines: results });
    }
    if (method === 'POST' && !b) {
      const d = await body(request);
      const lines = (d.lines || []).filter((l) => l.product_id && Number(l.qty) > 0);
      if (!d.supplier_id || !lines.length) throw new HttpError(400, 'Elige proveedor y al menos un producto');
      const { pmap, fmap } = await unitCtx(env, lines.map((l) => l.product_id));
      const rows = lines.map((l) => {
        const p = pmap[l.product_id];
        if (!p) throw new HttpError(400, 'Producto no encontrado');
        const u = unitInfo(p, l.unit, fmap);
        return { p, qty: Number(l.qty), base: Number(l.qty) * u.factor, unit: l.unit || p.unit, label: u.label };
      });
      const o = await env.DB.prepare(
        `INSERT INTO orders (supplier_id, status, order_date, expected_date, notes, user_id) VALUES (?,?,?,?,?,?) RETURNING id`
      ).bind(d.supplier_id, d.status === 'borrador' ? 'borrador' : 'enviado', todayStr(), d.expected_date || null, d.notes || null, user.id).first();
      await runBatch(env, rows.map((r) => env.DB.prepare(
        `INSERT INTO order_lines (order_id, product_id, qty, price, input_qty, input_unit, unit_label) VALUES (?,?,?,?,?,?,?)`
      ).bind(o.id, r.p.id, r2(r.base), r.p.price, r.qty, r.unit, r.label)));
      return json({ id: o.id });
    }
    if (method === 'PUT' && b && c === 'status') {
      const d = await body(request);
      if (!['borrador', 'enviado', 'cancelado'].includes(d.status)) throw new HttpError(400, 'Estado no válido');
      await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(d.status, b).run();
      return json({ ok: true });
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
    if (method === 'POST') {
      const d = await body(request);
      const lines = (d.lines || []).filter((l) => l.product_id && Number(l.qty) > 0);
      if (!d.supplier_id || !lines.length) throw new HttpError(400, 'Falta proveedor o productos');
      const date = isDate(d.receipt_date) ? d.receipt_date : todayStr();
      const { pmap, fmap } = await unitCtx(env, lines.map((l) => l.product_id));
      for (const l of lines) if (!pmap[l.product_id]) throw new HttpError(400, 'Producto no encontrado');
      const total = lines.reduce((s, l) => s + Number(l.qty) * Number(l.price || 0), 0); // cantidad × precio en la unidad escrita
      const rec = await env.DB.prepare(
        `INSERT INTO receipts (supplier_id, order_id, delivery_note, receipt_date, total, notes, user_id) VALUES (?,?,?,?,?,?,?) RETURNING id`
      ).bind(d.supplier_id, d.order_id || null, d.delivery_note || null, date, r2(total), d.notes || null, user.id).first();

      const stmts = [], priceChanges = [], seen = new Set();
      for (const l of lines) {
        const p = pmap[l.product_id];
        const u = unitInfo(p, l.unit, fmap);
        const inQty = Number(l.qty), inPrice = Number(l.price || 0);
        const qty = r2(inQty * u.factor), price = r2(inPrice / u.factor); // a unidad base
        const grp = uuid();
        stmts.push(env.DB.prepare(`INSERT INTO receipt_lines (receipt_id, product_id, qty, price, ordered_qty, input_qty, input_unit, unit_label, input_price) VALUES (?,?,?,?,?,?,?,?,?)`)
          .bind(rec.id, p.id, qty, price, l.ordered_qty ?? null, inQty, l.unit || p.unit, u.label, inPrice));
        if (u.format && inPrice > 0) stmts.push(env.DB.prepare('UPDATE product_formats SET price = ? WHERE id = ?').bind(inPrice, u.format.id));
        if (seen.has(p.id)) { stmts.push(env.DB.prepare(
          `INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(p.id, 'entrada', qty, price, `Albarán ${d.delivery_note || '#' + rec.id}`, grp, 'albaran', rec.id, user.id, date)); continue; }
        seen.add(p.id);
        stmts.push(env.DB.prepare(
          `INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(p.id, 'entrada', qty, price, `Albarán ${d.delivery_note || '#' + rec.id}`, grp, 'albaran', rec.id, user.id, date));
        if (price > 0 && Math.abs(price - Number(p.price)) > 0.0005) {
          priceChanges.push({ name: p.name, unit: p.unit, old: p.price, new: price, pct: p.price ? ((price - p.price) / p.price) * 100 : null,
            label: u.label, old_in: p.price * u.factor, new_in: inPrice });
          stmts.push(env.DB.prepare('INSERT INTO price_history (product_id, old_price, new_price, receipt_id) VALUES (?,?,?,?)').bind(p.id, p.price, price, rec.id));
          stmts.push(env.DB.prepare('UPDATE products SET price = ? WHERE id = ?').bind(price, p.id));
        }
      }
      if (d.order_id) stmts.push(env.DB.prepare(`UPDATE orders SET status = 'recibido' WHERE id = ?`).bind(d.order_id));
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
        if (!p) throw new HttpError(400, 'Producto no encontrado');
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
    if (method === 'POST') {
      const d = await body(request);
      const counts = (d.counts || []).filter((x) => x.product_id && x.counted !== '' && x.counted !== null && !isNaN(Number(x.counted)));
      if (!counts.length) throw new HttpError(400, 'No has contado ningún producto');
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
        totalDiff += delta * p.price;
        diffs.push({ name: p.name, unit: p.unit, expected: p.stock, counted: Number(cnt.counted), delta, value: delta * p.price, detail: cnt.detail || null });
        stmts.push(env.DB.prepare(
          `INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(p.id, 'ajuste', delta, p.price, `Inventario ${date}`, uuid(), 'inventario', inv.id, user.id, date));
      }
      stmts.push(env.DB.prepare('UPDATE inventories SET total_diff_value = ? WHERE id = ?').bind(r2(totalDiff), inv.id));
      await runBatch(env, stmts);
      return json({ id: inv.id, diffs, total_diff_value: r2(totalDiff) });
    }
  }

  // --- escandallos ---
  if (a === 'recipes') {
    if (b === 'bulk' && method === 'POST') return recipesBulk(request, env, user);
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
      const vals = [d.name.trim(), d.category || null, Number(d.pvp) || 0, Number(d.portions) || 1, d.pos_name || null, d.notes || null];
      let id = b;
      try {
        if (method === 'POST') {
          id = (await env.DB.prepare('INSERT INTO recipes (name, category, pvp, portions, pos_name, notes) VALUES (?,?,?,?,?,?) RETURNING id').bind(...vals).first()).id;
        } else {
          await env.DB.prepare('UPDATE recipes SET name=?, category=?, pvp=?, portions=?, pos_name=?, notes=?, active=1 WHERE id=?').bind(...vals, id).run();
        }
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe un plato con ese nombre');
        throw e;
      }
      if (Array.isArray(d.lines)) {
        const valid = d.lines.filter((l) => l.product_id && Number(l.qty) > 0);
        const { pmap, fmap } = await unitCtx(env, valid.map((l) => l.product_id));
        const stmts = [env.DB.prepare('DELETE FROM recipe_lines WHERE recipe_id = ?').bind(id)];
        for (const l of valid) {
          const p = pmap[l.product_id];
          if (!p) continue;
          const u = unitInfo(p, l.unit, fmap);
          stmts.push(env.DB.prepare('INSERT INTO recipe_lines (recipe_id, product_id, qty, waste_pct, input_qty, input_unit) VALUES (?,?,?,?,?,?)')
            .bind(id, p.id, Number(l.qty) * u.factor, Math.min(Math.max(Number(l.waste_pct) || 0, 0), 95), Number(l.qty), l.unit || p.unit));
        }
        await runBatch(env, stmts);
      }
      return json({ id });
    }
    if (method === 'DELETE' && b) {
      need(user, 'escandallos.editar');
      await env.DB.prepare('UPDATE recipes SET active = 0 WHERE id = ?').bind(b).run();
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
function normUnit(u) {
  const x = String(u || '').trim().toLowerCase();
  if (['kg', 'kilo', 'kilos', 'kgs', 'g', 'gr', 'gramos'].includes(x)) return 'kg';
  if (['l', 'lt', 'litro', 'litros', 'ml', 'cl'].includes(x)) return 'l';
  return 'ud';
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
      `INSERT INTO products (name, category, unit, price, supplier_id) VALUES (?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET category = COALESCE(excluded.category, category), unit = excluded.unit,
         price = CASE WHEN excluded.price > 0 THEN excluded.price ELSE price END,
         supplier_id = COALESCE(excluded.supplier_id, supplier_id), active = 1`
    ).bind(String(i.name).trim(), i.category || null, normUnit(i.unit), Number(String(i.price ?? 0).replace(',', '.')) || 0, sid || null);
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

async function recipesBulk(request, env, user) {
  need(user, 'escandallos.editar');
  const d = await body(request);
  const items = (d.items || []).filter((i) => i.name && String(i.name).trim());
  const stmts = items.map((i) => env.DB.prepare(
    `INSERT INTO recipes (name, category, pvp, pos_name) VALUES (?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET pvp = CASE WHEN excluded.pvp > 0 THEN excluded.pvp ELSE pvp END,
       category = COALESCE(excluded.category, category), pos_name = COALESCE(pos_name, excluded.pos_name), active = 1`
  ).bind(String(i.name).trim(), i.category || null, Number(String(i.pvp ?? 0).replace(',', '.')) || 0, String(i.name).trim()));
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
    env.DB.prepare('SELECT id, name, pos_name FROM recipes WHERE active = 1').all(),
  ]);
  const norm = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
  const amap = Object.fromEntries(aliases.map((a) => [norm(a.pos_name), a]));
  const rmap = {};
  for (const r of recipes) { rmap[norm(r.name)] = r.id; if (r.pos_name) rmap[norm(r.pos_name)] = r.id; }
  const matched = [], pending = [];
  for (const row of rows) {
    const k = norm(row.name ?? row.pos_name);
    if (!k || !(Number(row.units) > 0)) continue;
    const a = amap[k];
    if (a) matched.push({ pos_name: row.name ?? row.pos_name, recipe_id: a.recipe_id, factor: a.factor, pvp: a.pvp, units: row.units, revenue: row.revenue });
    else if (rmap[k]) matched.push({ pos_name: row.name ?? row.pos_name, recipe_id: rmap[k], factor: 1, units: row.units, revenue: row.revenue });
    else pending.push({ pos_name: row.name ?? row.pos_name, units: row.units, revenue: row.revenue });
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
  const { results: recs } = await env.DB.prepare(`SELECT id, name, pvp, portions FROM recipes WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
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
  const { results: lines } = await env.DB.prepare(
    `SELECT rl.recipe_id, rl.product_id, rl.qty, rl.waste_pct, p.price FROM recipe_lines rl JOIN products p ON p.id = rl.product_id
     WHERE rl.recipe_id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();

  let totalRevenue = 0;
  const saleRows = [], consumption = {};
  for (const rec of recs) {
    const agg = byRecipe[rec.id];
    if (!agg) continue;
    const revenue = agg.revenue;
    totalRevenue += revenue;
    saleRows.push({ recipe_id: rec.id, units: agg.units, revenue });
    const portions = Number(rec.portions) || 1;
    for (const l of lines.filter((x) => x.recipe_id === rec.id)) {
      const gross = (l.qty / (1 - Math.min(l.waste_pct || 0, 95) / 100) / portions) * agg.units;
      consumption[l.product_id] = consumption[l.product_id] || { qty: 0, price: l.price };
      consumption[l.product_id].qty += gross;
    }
  }
  const imp = await env.DB.prepare(
    'INSERT INTO sales_imports (date_from, date_to, filename, rows, revenue, user_id) VALUES (?,?,?,?,?,?) RETURNING id'
  ).bind(d.date_from, d.date_to, d.filename || null, saleRows.length, r2(totalRevenue), user.id).first();
  const stmts = saleRows.map((s) => env.DB.prepare('INSERT INTO sales (import_id, recipe_id, sale_date, units, revenue) VALUES (?,?,?,?,?)')
    .bind(imp.id, s.recipe_id, d.date_to, s.units, r2(s.revenue)));
  for (const [pid, c] of Object.entries(consumption)) {
    stmts.push(env.DB.prepare(
      `INSERT INTO movements (product_id, type, qty, unit_cost, label, grp, ref_type, ref_id, user_id, mov_date) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(Number(pid), 'venta', -r2(c.qty), c.price, `Ventas ${d.date_from} → ${d.date_to}`, `venta-${imp.id}`, 'venta', imp.id, user.id, d.date_to));
  }
  await runBatch(env, stmts);
  const noRecipe = recs.filter((r) => !lines.some((l) => l.recipe_id === r.id)).map((r) => r.name);
  return { id: imp.id, revenue: r2(totalRevenue), dishes: saleRows.length, without_recipe: noRecipe };
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
    .filter((r) => r.pvp > 0 && r.n_lines > 0)
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
    recipes_without_lines: dishes.results.filter((r) => r.n_lines === 0).length,
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
         WHERE rc.n_lines > 0 GROUP BY r.id`, from, to),
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
  } else throw new HttpError(404, 'Pestaña no encontrada');
  return json(out);
}

// ---------- informes ----------
const REPORTS = {
  resultado: 'Cuenta de resultados del periodo',
  compras_proveedor: 'Compras por proveedor (albaranes)',
  compras_producto: 'Compras por producto',
  mermas: 'Mermas (detalle)',
  personal: 'Consumo de personal (detalle)',
  foodcost: 'Food cost y margen por plato',
  ventas: 'Ventas por plato',
  caja: 'Cuadre de caja diario',
  stock: 'Inventario valorado (stock actual)',
  descuadres: 'Descuadres de inventario',
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
    columns = [C('receipt_date', 'Fecha', 'date'), C('supplier', 'Proveedor'), C('delivery_note', 'Albarán'), C('lines', 'Líneas', 'num'), C('user', 'Recibió'), C('total', 'Total', 'eur')];
    rows = await q(`SELECT r.receipt_date, s.name AS supplier, r.delivery_note, (SELECT COUNT(*) FROM receipt_lines WHERE receipt_id = r.id) AS lines, u.name AS user, r.total
      FROM receipts r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN users u ON u.id = r.user_id WHERE r.receipt_date BETWEEN ? AND ? ORDER BY s.name, r.receipt_date`, from, to);
    total = { total: rows.reduce((x, r) => x + r.total, 0) };
  } else if (type === 'compras_producto') {
    columns = [C('name', 'Producto'), C('category', 'Categoría'), C('supplier', 'Proveedor'), C('qty', 'Cantidad', 'num'), C('unit', 'Ud'), C('avg_price', 'Precio medio', 'eur'), C('min_price', 'Mín.', 'eur'), C('max_price', 'Máx.', 'eur'), C('value', 'Importe', 'eur')];
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
    columns = [C('name', 'Producto'), C('category', 'Categoría'), C('supplier_name', 'Proveedor'), C('stock', 'Stock', 'num'), C('unit', 'Ud'), C('price', 'Precio', 'eur'), C('value', 'Valor', 'eur')];
    rows = (await q(PRODUCTS_SQL)).map((p) => ({ ...p, value: Math.max(p.stock, 0) * p.price }));
    total = { value: rows.reduce((x, r) => x + r.value, 0) };
  } else if (type === 'descuadres') {
    columns = [C('inv_date', 'Fecha', 'date'), C('name', 'Producto'), C('expected', 'Teórico', 'num'), C('counted', 'Contado', 'num'), C('unit', 'Ud'), C('detail', 'Recuento'), C('diff', 'Diferencia', 'num'), C('value', 'Valor', 'eur'), C('user', 'Quién')];
    rows = await q(`SELECT i.inv_date, p.name, il.expected, il.counted, p.unit, il.detail, il.counted - il.expected AS diff,
        (SELECT SUM(m.qty * m.unit_cost) FROM movements m WHERE m.ref_type = 'inventario' AND m.ref_id = i.id AND m.product_id = il.product_id) AS value, u.name AS user
      FROM inventory_lines il JOIN inventories i ON i.id = il.inventory_id JOIN products p ON p.id = il.product_id LEFT JOIN users u ON u.id = i.user_id
      WHERE i.inv_date BETWEEN ? AND ? ORDER BY i.inv_date, value`, from, to);
    total = { value: rows.reduce((x, r) => x + (r.value || 0), 0) };
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
  required: ['supplier_name', 'supplier_cif', 'document_number', 'date', 'lines', 'total_without_vat', 'total_with_vat'],
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
  if (!raw || !Array.isArray(raw.lines) || !raw.lines.length) return json({ failed: true, message: 'No he encontrado líneas de productos en la foto. Mete los datos a mano o prueba con otra foto más recta y con luz.' });

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
      source, printed_unit: l.unit || '', qty, price: Math.round(price * 10000) / 10000, line_total: Number(l.line_total) || qty * price,
      product_id: product?.id || null, unit: product ? (learned?.unit || unitGuess(product, l.unit)) : null, confidence,
    };
  });
  const scan = await env.DB.prepare('INSERT INTO ocr_scans (user_id, provider, supplier_id, result) VALUES (?,?,?,?) RETURNING id')
    .bind(user.id, provider, supplier?.id || null, JSON.stringify(raw)).first();
  return json({
    ocr_id: scan.id, provider,
    supplier_id: supplier?.id || null, supplier_name: raw.supplier_name || '', supplier_cif: raw.supplier_cif || '',
    delivery_note: raw.document_number || '', date: isDate(raw.date) ? raw.date : null,
    total_without_vat: raw.total_without_vat || null, total_with_vat: raw.total_with_vat || null, lines,
  });
}
