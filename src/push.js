// Avisos al móvil (Web Push), gratis y sin servicios externos.
//
// Para no gastar CPU (el plan gratuito de Workers da 10 ms por petición) el aviso viaja VACÍO:
// el servidor solo "toca el timbre" del móvil con una firma VAPID (que se reutiliza durante horas)
// y el propio móvil pide después a la app qué avisos tiene pendientes. Así no hay que cifrar nada.
import { json, HttpError, body, permsOf } from './api.js';

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = (s) => b64u(new TextEncoder().encode(s));

async function getSetting(env, key) {
  return (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first())?.value ?? null;
}
const setSetting = (env, key, value) =>
  env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();

// Claves VAPID: se crean solas la primera vez y se guardan en Ajustes
export async function vapidKeys(env) {
  let pub = await getSetting(env, 'vapid_public'), jwk = await getSetting(env, 'vapid_jwk');
  if (!pub || !jwk) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
    jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid_public', ?)`).bind(pub),
      env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid_jwk', ?)`).bind(jwk),
    ]);
    // si otra petición se adelantó, usar las suyas
    pub = await getSetting(env, 'vapid_public'); jwk = await getSetting(env, 'vapid_jwk');
  }
  return { pub, jwk };
}

// Firma VAPID por servicio de avisos (Google, Apple, Mozilla…). Vale 12 h, así que se firma pocas veces al día.
const jwtCache = new Map();
async function vapidHeader(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const hit = jwtCache.get(aud);
  if (hit && hit.exp - now > 3600) return hit.header;
  const { pub, jwk } = await vapidKeys(env);
  const sub = (await getSetting(env, 'app_origin')) || 'mailto:avisos@example.com';
  const exp = now + 12 * 3600;
  const unsigned = `${b64uStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64uStr(JSON.stringify({ aud, exp, sub }))}`;
  const key = await crypto.subtle.importKey('jwk', JSON.parse(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const header = `vapid t=${unsigned}.${b64u(sig)}, k=${pub}`;
  jwtCache.set(aud, { exp, header });
  return header;
}

// Guarda avisos para unas personas y hace sonar sus móviles
export async function enqueuePush(env, userIds, n, { now = true } = {}) {
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return 0;
  await env.DB.batch(ids.map((id) => env.DB.prepare('INSERT INTO notices (user_id, title, body, url, tag) VALUES (?,?,?,?,?)')
    .bind(id, String(n.title).slice(0, 120), String(n.body || '').slice(0, 600), n.url || '/', n.tag || null)));
  if (now) { try { await deliver(env); } catch (e) { console.error('avisos', e); } }
  return ids.length;
}

// Envía los timbres pendientes (como mucho 40 móviles por vez: límite de subpeticiones del plan gratuito)
export async function deliver(env) {
  const { results: users } = await env.DB.prepare(`SELECT DISTINCT user_id FROM notices WHERE sent_at IS NULL AND created_at > datetime('now', '-2 days') LIMIT 60`).all();
  if (!users.length) return { sent: 0 };
  const uids = users.map((u) => u.user_id);
  const { results: subs } = await env.DB.prepare(`SELECT * FROM push_subs WHERE user_id IN (${uids.map(() => '?').join(',')}) LIMIT 40`).bind(...uids).all();
  let sent = 0;
  const gone = [];
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await fetch(s.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', Authorization: await vapidHeader(env, s.endpoint) }, body: new Uint8Array(0) });
      if (r.status === 404 || r.status === 410) gone.push(s.id);
      else if (r.ok) sent++;
      else console.error('aviso rechazado', r.status, await r.text().catch(() => ''));
    } catch (e) { console.error('aviso', e); }
  }));
  const done = [...new Set(subs.map((s) => s.user_id))];
  // quien no tiene móvil activado lo verá dentro de la app; no se reintenta
  const noSubs = uids.filter((u) => !subs.some((s) => s.user_id === u));
  const mark = [...done, ...noSubs];
  const stmts = [];
  if (mark.length) stmts.push(env.DB.prepare(`UPDATE notices SET sent_at = datetime('now') WHERE sent_at IS NULL AND user_id IN (${mark.map(() => '?').join(',')})`).bind(...mark));
  if (gone.length) stmts.push(env.DB.prepare(`DELETE FROM push_subs WHERE id IN (${gone.map(() => '?').join(',')})`).bind(...gone));
  stmts.push(env.DB.prepare(`DELETE FROM notices WHERE created_at < datetime('now', '-60 days')`));
  await env.DB.batch(stmts);
  return { sent, removed: gone.length };
}

// Usuarios activos con un permiso (o superusuarios)
export async function pushUsersWith(env, perm) {
  const { results } = await env.DB.prepare('SELECT id, role, is_super, perms FROM users WHERE active = 1').all();
  return results.filter((u) => u.is_super || permsOf(u).includes(perm)).map((u) => u.id);
}

export async function push(env, user, ctx, method, b, request, url) {
  ctx.audit = false;
  if (b === 'key' && method === 'GET') return json({ key: (await vapidKeys(env)).pub });
  if (b === 'subscribe' && method === 'POST') {
    const d = await body(request);
    const s = d.subscription || {};
    if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth) throw new HttpError(400, 'Suscripción no válida');
    if (!/^https:\/\//.test(s.endpoint)) throw new HttpError(400, 'Suscripción no válida');
    const last = await env.DB.prepare('SELECT MAX(id) AS m FROM notices WHERE user_id = ?').bind(user.id).first();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, ua, last_id) VALUES (?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, last_id = excluded.last_id`)
        .bind(user.id, s.endpoint, s.keys.p256dh, s.keys.auth, String(request.headers.get('user-agent') || '').slice(0, 200), last?.m || 0),
      // remitente de la firma VAPID: la dirección de la app
      env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('app_origin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(url.origin),
    ]);
    return json({ ok: true });
  }
  if (b === 'unsubscribe' && method === 'POST') {
    const d = await body(request);
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String(d.endpoint || ''), user.id).run();
    return json({ ok: true });
  }
  // El móvil pregunta qué avisos tiene (lo llama el service worker al sonar el timbre)
  if (b === 'inbox' && method === 'POST') {
    const d = await body(request).catch(() => ({}));
    const sub = d.endpoint ? await env.DB.prepare('SELECT id, last_id FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(d.endpoint, user.id).first() : null;
    const since = sub ? sub.last_id : 0;
    let { results } = await env.DB.prepare(`SELECT id, title, body, url, tag FROM notices WHERE user_id = ? AND id > ? AND created_at > datetime('now', '-2 days') ORDER BY id DESC LIMIT 5`).bind(user.id, since).all();
    // si otro timbre ya los recogió, se repite el último (con la misma etiqueta sustituye al anterior, no duplica)
    if (!results.length) results = (await env.DB.prepare(`SELECT id, title, body, url, tag FROM notices WHERE user_id = ? AND created_at > datetime('now', '-10 minutes') ORDER BY id DESC LIMIT 1`).bind(user.id).all()).results;
    if (sub && results.length) await env.DB.prepare('UPDATE push_subs SET last_id = MAX(last_id, ?) WHERE id = ?').bind(results[0].id, sub.id).run();
    return json({ items: results.reverse() });
  }
  // últimos avisos de la persona (para verlos dentro de la app)
  if (b === 'notices' && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT id, title, body, url, created_at FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT 30`).bind(user.id).all();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').bind(user.id).first();
    return json({ items: results, devices: n.n });
  }
  if (b === 'test' && method === 'POST') {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').bind(user.id).first();
    if (!n.n) throw new HttpError(400, 'Este usuario aún no tiene ningún móvil con avisos activados');
    await enqueuePush(env, [user.id], { title: 'Avisos activados ✓', body: 'Así te llegarán los horarios y los pedidos por aprobar.', url: '/#/inicio', tag: 'prueba' });
    return json({ ok: true, devices: n.n });
  }
  if (b === 'flush' && method === 'POST') return json(await deliver(env));
  throw new HttpError(404, 'No encontrado');
}
