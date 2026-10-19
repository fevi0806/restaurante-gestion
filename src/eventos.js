// Agenda de eventos y reservas de grupos: comidas de empresa, cumpleaños, comuniones…
// Cada evento: fecha y hora, cliente y contacto, personas, menú y precio, señal, espacio, alergias y estado.
import { json, HttpError, body, need, can, isDate, localDay } from './api.js';

export const EVENT_STATUS = ['consulta', 'reservado', 'confirmado', 'celebrado', 'cancelado'];
export const EVENT_KINDS = ['Comida de empresa', 'Cumpleaños', 'Comunión', 'Bautizo', 'Boda', 'Despedida', 'Reunión familiar', 'Grupo turístico', 'Otro'];
const COLS = ['event_date', 'start_time', 'end_time', 'service', 'title', 'kind', 'people', 'kids', 'contact_name', 'phone', 'email', 'space',
  'menu', 'price_pp', 'deposit', 'deposit_paid', 'deposit_date', 'status', 'allergies', 'notes', 'final_total'];
const MONEY = ['price_pp', 'deposit', 'deposit_paid', 'deposit_date', 'final_total'];
const time = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const txt = (x, n = 2000) => (x == null || String(x).trim() === '' ? null : String(x).trim().slice(0, n));
const num = (x) => (x === '' || x == null || isNaN(Number(x)) ? null : Number(x));

function clean(d, old = {}) {
  const v = { ...old };
  if ('event_date' in d) v.event_date = d.event_date;
  if (!isDate(v.event_date)) throw new HttpError(400, 'Pon la fecha del evento');
  for (const k of ['start_time', 'end_time']) if (k in d) v[k] = d[k] ? time(d[k]) : null;
  if (d.start_time && !v.start_time) throw new HttpError(400, 'Hora no válida (usa el formato 14:00)');
  for (const k of ['service', 'title', 'kind', 'contact_name', 'phone', 'email', 'space', 'allergies']) if (k in d) v[k] = txt(d[k], 300);
  for (const k of ['menu', 'notes']) if (k in d) v[k] = txt(d[k], 4000);
  if (!v.title) throw new HttpError(400, 'Pon un nombre al evento (cliente o motivo)');
  for (const k of ['people', 'kids']) if (k in d) v[k] = num(d[k]) == null ? null : Math.max(0, Math.round(num(d[k])));
  if (!(v.people > 0)) throw new HttpError(400, 'Indica cuántas personas son');
  for (const k of ['price_pp', 'deposit', 'final_total']) if (k in d) v[k] = num(d[k]);
  if ('deposit_paid' in d) v.deposit_paid = d.deposit_paid ? 1 : 0;
  if ('deposit_date' in d) v.deposit_date = isDate(d.deposit_date) ? d.deposit_date : null;
  if (v.deposit_paid && !v.deposit_date) v.deposit_date = localDay();
  if ('status' in d) v.status = EVENT_STATUS.includes(d.status) ? d.status : 'consulta';
  v.status = v.status || 'consulta';
  return v;
}
// quien solo ve la agenda no ve precios ni señal
const strip = (user, e) => (can(user, 'eventos.gestionar') ? e : Object.fromEntries(Object.entries(e).filter(([k]) => !MONEY.includes(k))));

export async function eventos(env, user, ctx, method, id, request, url) {
  need(user, ['eventos.ver', 'eventos.gestionar']);
  if (method === 'GET' && !id) {
    ctx.audit = false;
    const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : '2000-01-01';
    const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : '2999-12-31';
    const { results } = await env.DB.prepare(`SELECT e.*, u.name AS created_by_name FROM events e LEFT JOIN users u ON u.id = e.created_by
      WHERE e.event_date BETWEEN ? AND ? ORDER BY e.event_date, COALESCE(e.start_time, '99:99'), e.id LIMIT 1000`).bind(from, to).all();
    return json(results.map((e) => strip(user, e)));
  }
  if (method === 'GET' && id) {
    ctx.audit = false;
    const e = await env.DB.prepare('SELECT e.*, u.name AS created_by_name FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?').bind(id).first();
    if (!e) throw new HttpError(404, 'Evento no encontrado');
    return json(strip(user, e));
  }
  need(user, 'eventos.gestionar');
  if (method === 'POST' && !id) {
    const v = clean(await body(request));
    const keys = COLS.filter((k) => v[k] !== undefined);
    const row = await env.DB.prepare(`INSERT INTO events (${keys.join(',')}, created_by) VALUES (${keys.map(() => '?').join(',')}, ?) RETURNING id`)
      .bind(...keys.map((k) => v[k]), user.id).first();
    ctx.audit = { action: 'alta', entity: 'evento', id: row.id, summary: `Alta de evento "${v.title}" el ${v.event_date} (${v.people} personas, ${v.status})` };
    return json({ id: row.id });
  }
  if (method === 'PUT' && id) {
    const old = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
    if (!old) throw new HttpError(404, 'Evento no encontrado');
    const v = clean(await body(request), old);
    const changed = COLS.filter((k) => String(v[k] ?? '') !== String(old[k] ?? ''));
    if (changed.length) await env.DB.prepare(`UPDATE events SET ${changed.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...changed.map((k) => v[k]), id).run();
    ctx.audit = { action: 'modificación', entity: 'evento', id, summary: `Evento "${v.title}" (${v.event_date}): ${changed.map((k) => `${k}: ${old[k] ?? '—'} → ${v[k] ?? '—'}`).join('; ').slice(0, 300) || 'sin cambios'}`, detail: old };
    return json({ ok: true });
  }
  if (method === 'DELETE' && id) {
    const old = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
    if (!old) return json({ ok: true });
    await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
    ctx.audit = { action: 'baja', entity: 'evento', id, summary: `Borrado el evento "${old.title}" del ${old.event_date}`, detail: old };
    return json({ ok: true });
  }
  throw new HttpError(405, 'Método no permitido');
}

// avisos para Inicio
export async function eventAlerts(env, user, add) {
  if (!can(user, 'eventos.ver') && !can(user, 'eventos.gestionar')) return;
  const day = localDay();
  const in7 = new Date(new Date(day + 'T12:00:00Z').getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const in3 = new Date(new Date(day + 'T12:00:00Z').getTime() + 3 * 86400000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(`SELECT id, event_date, title, people, status, deposit, deposit_paid FROM events WHERE event_date BETWEEN ? AND ? AND status NOT IN ('cancelado', 'celebrado') ORDER BY event_date`).bind(day, in7).all();
  const today = results.filter((e) => e.event_date === day);
  if (today.length) add('info', '🎉', `Hoy: ${today.map((e) => `${e.title} (${e.people} pers.)`).join(', ')}`, '#/eventos');
  if (can(user, 'eventos.gestionar')) {
    const unconf = results.filter((e) => e.event_date <= in3 && e.status === 'consulta');
    if (unconf.length) add('warn', '🎉', `${unconf.length} evento(s) en los próximos 3 días todavía sin confirmar`, '#/eventos');
    const dep = results.filter((e) => e.deposit > 0 && !e.deposit_paid && e.status !== 'consulta');
    if (dep.length) add('warn', '💶', `${dep.length} evento(s) de esta semana con la señal sin cobrar`, '#/eventos');
  }
  const rest = results.filter((e) => e.event_date !== day);
  if (rest.length) add('info', '🎉', `${rest.length} evento(s) en los próximos 7 días (${rest.reduce((t, e) => t + (e.people || 0), 0)} personas)`, '#/eventos');
}
