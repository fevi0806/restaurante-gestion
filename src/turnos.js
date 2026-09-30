// Planificador de turnos del personal: cuadrante semanal por departamento (Cocina, Sala…),
// turnos partidos, avisos legales, cobertura de servicios, coste previsto y envío al equipo.
import { json, HttpError, body, need, can, isDate, settings, localDay } from './api.js';
import { enqueuePush, pushUsersWith, deliver } from './push.js';

const KINDS = ['trabajo', 'libre', 'vacaciones', 'baja', 'festivo'];
const KIND_TXT = { libre: 'Libre', vacaciones: 'Vacaciones', baja: 'Baja', festivo: 'Festivo' };
const DAY_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const DAY_LONG = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Reglas por defecto: Estatuto de los Trabajadores (art. 34.3 y 37.1). El convenio de hostelería de la provincia manda: se ajustan en Reglas.
export const DEFAULT_RULES = { min_rest: 12, max_day: 9, weekly_rest: 36, max_segs: 2 };
const DEFAULT_SERVICES = [{ name: 'Comida', start: '13:00', end: '16:00' }, { name: 'Cena', start: '20:30', end: '23:30' }];

// ---------- fechas y horas ----------
const D = (s) => new Date(s + 'T12:00:00Z');
const ds = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return ds(d); };
export const mondayOf = (s) => { const d = D(s); return addDays(s, -((d.getUTCDay() + 6) % 7)); };
const weekDays = (w) => Array.from({ length: 7 }, (_, i) => addDays(w, i));
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim()); if (!m) return null; const h = +m[1], mi = +m[2]; if (h > 24 || mi > 59 || (h === 24 && mi)) return null; return h * 60 + mi; };
const hhmm = (t) => { const m = toMin(t); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const hoursTxt = (min) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return m ? `${h} h ${m} min` : `${h} h`; };
const r1 = (n) => Math.round(n * 100) / 100;

// Tramos de un día en minutos desde las 0:00 de ese día; si el final es anterior al inicio, pasa de medianoche
function segMins(segs) {
  return (segs || []).map(([a, b]) => { const s = toMin(a); let e = toMin(b); if (e <= s) e += 1440; return [s, e]; });
}
export function segsHours(segs) { return segMins(segs).reduce((t, [s, e]) => t + (e - s), 0) / 60; }
const parseSegs = (x) => { try { const v = typeof x === 'string' ? JSON.parse(x) : x; return Array.isArray(v) ? v : []; } catch { return []; } };

function cleanSegs(raw, maxSegs) {
  const segs = parseSegs(raw).filter((s) => Array.isArray(s) && (s[0] || s[1]));
  if (!segs.length) throw new HttpError(400, 'Pon al menos un tramo con hora de entrada y de salida');
  if (segs.length > 3) throw new HttpError(400, 'Como mucho 3 tramos en un día');
  const out = segs.map(([a, b]) => {
    if (toMin(a) === null || toMin(b) === null) throw new HttpError(400, `Hora no válida: ${a || '?'}–${b || '?'} (usa el formato 13:00)`);
    if (toMin(a) === toMin(b) || (toMin(a) === 0 && toMin(b) === 1440)) throw new HttpError(400, `El tramo ${a}–${b} no tiene duración`);
    return [hhmm(a), toMin(b) === 1440 ? '00:00' : hhmm(b)];
  }).sort((x, y) => toMin(x[0]) - toMin(y[0]));
  const m = segMins(out);
  for (let i = 1; i < m.length; i++) if (m[i][0] < m[i - 1][1]) throw new HttpError(400, `Los tramos ${out[i - 1].join('–')} y ${out[i].join('–')} se solapan`);
  if (m.length && m[m.length - 1][1] > 1440 + 12 * 60) throw new HttpError(400, 'Un turno no puede acabar más allá del mediodía del día siguiente');
  void maxSegs;
  return out;
}

// ---------- configuración ----------
async function config(env) {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'turnos_%'`).all();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const j = (k, def) => { try { return s[k] ? JSON.parse(s[k]) : def; } catch { return def; } };
  return {
    departments: j('turnos_departments', ['Cocina', 'Sala']),
    rules: { ...DEFAULT_RULES, ...j('turnos_rules', {}) },
    services: j('turnos_services', DEFAULT_SERVICES),
    mins: j('turnos_mins', {}),
    token: s.turnos_token || null,
  };
}
const setSetting = (env, key, value) =>
  env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);
const newToken = () => [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 20);

// ---------- comprobaciones legales ----------
// shifts: todos los turnos de la semana y de los días de al lado (domingo anterior y lunes siguiente)
export function checkWeek(week, staff, shifts, rules) {
  const out = [];
  const idx = (day) => Math.round((D(day) - D(week)) / 86400000);
  for (const p of staff) {
    const mine = shifts.filter((x) => x.staff_id === p.id && x.kind === 'trabajo');
    const byDay = {};
    for (const x of mine) {
      const i = idx(x.day), m = segMins(parseSegs(x.segs));
      if (!m.length) continue;
      byDay[i] = { day: x.day, iv: m.map(([s, e]) => [i * 1440 + s, i * 1440 + e]), min: m.reduce((t, [s, e]) => t + e - s, 0) };
    }
    const warn = (level, text, day) => out.push({ staff_id: p.id, name: p.name, level, text, day: day || null });
    // jornada diaria
    let weekMin = 0;
    for (let i = 0; i < 7; i++) {
      const d = byDay[i]; if (!d) continue;
      weekMin += d.min;
      if (d.min > rules.max_day * 60) warn('bad', `${DAY_LONG[i]}: ${hoursTxt(d.min)} de trabajo (máximo ${rules.max_day} h al día)`, d.day);
      if (d.iv.length > Math.max(1, rules.max_segs || 2)) warn('warn', `${DAY_LONG[i]}: ${d.iv.length} tramos (tu regla permite ${rules.max_segs})`, d.day);
    }
    // descanso entre jornadas (se incluye el domingo anterior y el lunes siguiente)
    const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
    for (let k = 1; k < days.length; k++) {
      const a = byDay[days[k - 1]], b = byDay[days[k]];
      if (days[k] < 0 || days[k - 1] > 6) continue;
      const end = Math.max(...a.iv.map((x) => x[1])), start = Math.min(...b.iv.map((x) => x[0]));
      const gap = start - end;
      if (gap < 0) warn('bad', `el turno del ${DAY_LONG[(days[k - 1] + 7) % 7]} se solapa con el del ${DAY_LONG[days[k] % 7]}`, b.day);
      else if (gap < rules.min_rest * 60) warn('bad', `solo descansa ${hoursTxt(gap)} entre la salida del ${DAY_LONG[(days[k - 1] + 7) % 7]} y la entrada del ${DAY_LONG[days[k] % 7]} (mínimo ${rules.min_rest} h)`, b.day);
    }
    // descanso semanal: el mayor descanso seguido que EMPIEZA en esta semana (puede acabar el lunes siguiente);
    // el que empezó la semana anterior cuenta para aquella
    const iv = days.flatMap((i) => byDay[i].iv).filter(([, e]) => e > 0).sort((a, b) => a[0] - b[0]);
    let best = 0, cur = 0;
    for (const [s, e] of iv) { if (s > cur && cur < 7 * 1440) best = Math.max(best, s - cur); cur = Math.max(cur, e); }
    best = Math.max(best, 8 * 1440 - cur);
    if (iv.some(([s, e]) => e > 0 && s < 7 * 1440) && best < rules.weekly_rest * 60)
      warn('warn', `no tiene ${rules.weekly_rest} h seguidas de descanso esta semana (el mayor descanso es de ${hoursTxt(best)}). Solo es válido si lo compensa en la semana siguiente (se puede acumular en 14 días).`);
    // horas de contrato
    const h = weekMin / 60;
    if (p.weekly_hours > 0 && h > p.weekly_hours + 0.01) warn('warn', `${num1(h)} h planificadas y tiene contrato de ${num1(p.weekly_hours)} h (+${num1(h - p.weekly_hours)} h extra)`);
    else if (p.weekly_hours > 0 && h > 0 && h < p.weekly_hours - 0.5) warn('info', `${num1(h)} h planificadas de ${num1(p.weekly_hours)} h de contrato (faltan ${num1(p.weekly_hours - h)} h)`);
  }
  return out;
}
const num1 = (n) => String(Math.round(n * 10) / 10).replace('.', ',');

// cuántas personas de cada departamento cubren cada servicio (al menos la mitad del servicio)
function coverage(week, staff, shifts, cfg) {
  const days = weekDays(week), res = {};
  for (const dep of cfg.departments) {
    res[dep] = {};
    for (const sv of cfg.services) {
      const s0 = toMin(sv.start); let s1 = toMin(sv.end); if (s1 <= s0) s1 += 1440;
      res[dep][sv.name] = days.map((day) => shifts.filter((x) => x.day === day && x.kind === 'trabajo' && staff.find((p) => p.id === x.staff_id)?.department === dep)
        .filter((x) => segMins(parseSegs(x.segs)).reduce((t, [a, b]) => t + Math.max(0, Math.min(b, s1) - Math.max(a, s0)), 0) >= (s1 - s0) / 2).length);
    }
  }
  return res;
}

async function revenueRef(env, week) {
  const st = await settings(env);
  const end = addDays(week, 6);
  const s = await env.DB.prepare('SELECT SUM(revenue) AS v FROM sales WHERE sale_date BETWEEN ? AND ?').bind(week, end).first();
  if (s.v > 0) return { value: s.v, source: 'ventas de esa semana' };
  const c = await env.DB.prepare('SELECT SUM(cash + card + bizum + other) AS v, COUNT(*) AS n FROM cash_days WHERE day BETWEEN ? AND ?').bind(week, end).first();
  if (c.v > 0 && c.n >= 5) return { value: c.v / (1 + st.iva_pct / 100), source: 'caja de esa semana (sin IVA)' };
  const since = addDays(week, -56);
  const a = await env.DB.prepare('SELECT SUM(revenue) AS v, MIN(sale_date) AS d0 FROM sales WHERE sale_date BETWEEN ? AND ?').bind(since, addDays(week, -1)).first();
  if (a.v > 0) { const n = Math.max(7, (D(week) - D(a.d0)) / 86400000); return { value: (a.v / n) * 7, source: 'media de las últimas semanas' }; }
  if (st.expected_revenue) return { value: (st.expected_revenue / 30.4375) * 7, source: 'facturación prevista' };
  return null;
}

async function loadWeek(env, week) {
  const [{ results: staff }, { results: shifts }, wk] = await Promise.all([
    env.DB.prepare(`SELECT * FROM staff WHERE active = 1 OR id IN (SELECT staff_id FROM shifts WHERE day BETWEEN ? AND ?) ORDER BY sort, name`).bind(week, addDays(week, 6)).all(),
    env.DB.prepare('SELECT id, staff_id, day, kind, segs, note FROM shifts WHERE day BETWEEN ? AND ? ORDER BY day').bind(addDays(week, -1), addDays(week, 7)).all(),
    env.DB.prepare('SELECT * FROM schedule_weeks WHERE week = ?').bind(week).first(),
  ]);
  return { staff, shifts: shifts.map((x) => ({ ...x, segs: parseSegs(x.segs) })), wk: wk || { week, status: 'borrador', changed: null } };
}

// ---------- mensajes para el equipo ----------
function dateLong(s) { const d = D(s); return `${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`; }
export function dayLine(x) {
  if (!x) return 'Libre';
  if (x.kind !== 'trabajo') return KIND_TXT[x.kind] || x.kind;
  const segs = parseSegs(x.segs);
  return segs.map((s) => s.join('–')).join(' y ') + (x.note ? ` (${x.note})` : '');
}
function personalText(p, week, shifts, origin, restaurant, changed) {
  const days = weekDays(week);
  const lines = days.map((d, i) => { const x = shifts.find((s) => s.staff_id === p.id && s.day === d); return `${DAY_SHORT[i]} ${D(d).getUTCDate()}: ${dayLine(x)}`; });
  const h = shifts.filter((s) => s.staff_id === p.id && days.includes(s.day) && s.kind === 'trabajo').reduce((t, s) => t + segsHours(s.segs), 0);
  return `Hola ${p.name.split(' ')[0]}, ${changed ? 'ha cambiado tu horario' : 'tu horario'} en ${restaurant} de la semana del ${dateLong(week)} al ${dateLong(days[6])}:\n${lines.join('\n')}\nTotal: ${num1(h)} h` +
    (p.token ? `\nSiempre actualizado aquí: ${origin}/#/h/${p.token}` : '');
}
function messagesFor(staff, week, shifts, origin, restaurant, only, changed) {
  return staff.filter((p) => p.active && (!only || only.includes(p.id))).map((p) => ({
    staff_id: p.id, name: p.name, department: p.department, phone: p.phone, email: p.email, has_app: !!p.user_id,
    text: personalText(p, week, shifts, origin, restaurant, changed),
  }));
}

async function notifyStaff(env, staff, week, shifts, only, changed, byName) {
  const days = weekDays(week);
  const targets = staff.filter((p) => p.active && p.user_id && (!only || only.includes(p.id)));
  let n = 0;
  for (const p of targets) {
    const mine = days.map((d, i) => { const x = shifts.find((s) => s.staff_id === p.id && s.day === d); return x && x.kind === 'trabajo' ? `${DAY_SHORT[i]} ${parseSegs(x.segs).map((s) => s[0]).join('/')}` : null; }).filter(Boolean);
    n += await enqueuePush(env, [p.user_id], {
      title: changed ? 'Ha cambiado tu horario' : `Tu horario: semana del ${dateLong(week)}`,
      body: mine.length ? `Trabajas: ${mine.join(' · ')}` : 'Esta semana no tienes turnos de trabajo.',
      url: `/#/mihorario?week=${week}`, tag: 'horario-' + week,
    }, { now: false });
  }
  return n;
}

// ---------- API ----------
export async function turnos(env, user, ctx, method, b, c, request, url) {
  const manage = can(user, 'turnos.gestionar');
  const cfg = await config(env);
  const q = url.searchParams;
  const restaurant = (await settings(env)).restaurant_name;
  ctx.audit = ctx.audit || null;

  // mi horario (cualquiera que tenga ficha de personal vinculada a su usuario)
  if (b === 'mine' && method === 'GET') {
    const p = await env.DB.prepare('SELECT * FROM staff WHERE user_id = ? AND active = 1').bind(user.id).first();
    if (!p) return json({ linked: false });
    return json({ linked: true, ...(await personView(env, p, q.get('week'))) });
  }

  if (!b && method === 'GET') {
    need(user, ['turnos.ver', 'turnos.gestionar']);
    const week = mondayOf(isDate(q.get('week')) ? q.get('week') : localDay());
    const { staff, shifts, wk } = await loadWeek(env, week);
    const { results: templates } = await env.DB.prepare('SELECT * FROM shift_templates WHERE active = 1 ORDER BY department, name').all();
    if (!manage && wk.status !== 'publicado')
      return json({ week, days: weekDays(week), status: 'borrador', hidden: true, departments: cfg.departments });
    const inWeek = shifts.filter((x) => x.day >= week && x.day <= addDays(week, 6));
    const people = manage ? staff : staff.map(({ phone, email, cost_hour, weekly_hours, token, user_id, ...p }) => p);
    const out = {
      week, days: weekDays(week), status: wk.status, published_at: wk.published_at,
      changed: JSON.parse(wk.changed || '[]'), staff: people, shifts: inWeek, templates: templates.map((t) => ({ ...t, segs: parseSegs(t.segs) })),
      departments: cfg.departments, services: cfg.services, mins: cfg.mins,
    };
    if (manage) {
      out.rules = cfg.rules;
      out.warnings = checkWeek(week, staff.filter((p) => p.active), shifts, cfg.rules);
      out.coverage = coverage(week, staff, inWeek, cfg);
      out.adjacent = shifts.filter((x) => x.day < week || x.day > addDays(week, 6));
      const cost = {}; let total = 0, hours = 0, noCost = 0;
      for (const p of staff) {
        const h = inWeek.filter((x) => x.staff_id === p.id && x.kind === 'trabajo').reduce((t, x) => t + segsHours(x.segs), 0);
        hours += h;
        if (!(p.cost_hour > 0)) { if (h) noCost++; continue; }
        cost[p.department] = (cost[p.department] || 0) + h * p.cost_hour; total += h * p.cost_hour;
      }
      out.cost = { total: r1(total), by_dept: cost, hours: r1(hours), without_cost: noCost, revenue: await revenueRef(env, week) };
      out.token = cfg.token;
      out.origin = url.origin;
    }
    return json(out);
  }

  // ---- a partir de aquí, gestión ----
  need(user, 'turnos.gestionar');

  if (b === 'staff') {
    if (method === 'GET') {
      const { results } = await env.DB.prepare(`SELECT s.*, u.name AS user_name FROM staff s LEFT JOIN users u ON u.id = s.user_id WHERE s.active = 1 ORDER BY s.department, s.sort, s.name`).all();
      const { results: users } = await env.DB.prepare('SELECT id, name, username FROM users WHERE active = 1 ORDER BY name').all();
      return json({ staff: results, users });
    }
    const d = method === 'DELETE' ? {} : await body(request);
    const data = {};
    for (const k of ['name', 'department', 'position', 'phone', 'email']) if (k in d) data[k] = String(d[k] ?? '').trim() || null;
    for (const k of ['weekly_hours', 'cost_hour', 'sort']) if (k in d) data[k] = d[k] === '' || d[k] === null ? null : Number(d[k]);
    if ('user_id' in d) data.user_id = d.user_id ? Number(d.user_id) : null;
    if (method === 'POST' && !c) {
      if (!data.name) throw new HttpError(400, 'Pon el nombre');
      data.department = data.department || cfg.departments[0];
      data.token = newToken();
      const keys = Object.keys(data);
      const r = await env.DB.prepare(`INSERT INTO staff (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) RETURNING id`).bind(...keys.map((k) => data[k])).first();
      ctx.audit = { action: 'alta', entity: 'personal', id: r.id, summary: `Alta en el cuadrante: ${data.name} (${data.department})` };
      return json({ id: r.id });
    }
    if (!c) throw new HttpError(400, 'Falta la persona');
    const old = await env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(c).first();
    if (!old) throw new HttpError(404, 'No encontrado');
    if (method === 'DELETE') {
      await env.DB.prepare('UPDATE staff SET active = 0 WHERE id = ?').bind(c).run();
      ctx.audit = { action: 'baja', entity: 'personal', id: c, summary: `Baja del cuadrante: ${old.name}` };
      return json({ ok: true });
    }
    if (d.new_token || !old.token) data.token = newToken();
    if (data.user_id) {
      const other = await env.DB.prepare('SELECT name FROM staff WHERE user_id = ? AND id <> ? AND active = 1').bind(data.user_id, c).first();
      if (other) throw new HttpError(409, `Ese usuario ya está vinculado a ${other.name}`);
    }
    const keys = Object.keys(data);
    if (keys.length) await env.DB.prepare(`UPDATE staff SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).bind(...keys.map((k) => data[k]), c).run();
    ctx.audit = { action: 'modificación', entity: 'personal', id: c, summary: `Ficha de personal de ${old.name} modificada`, detail: old };
    return json({ ok: true, token: data.token });
  }

  if (b === 'templates') {
    if (method === 'DELETE' && c) { await env.DB.prepare('UPDATE shift_templates SET active = 0 WHERE id = ?').bind(c).run(); ctx.audit = { entity: 'turnos', summary: 'Turno tipo borrado' }; return json({ ok: true }); }
    const d = await body(request);
    if (!String(d.name || '').trim()) throw new HttpError(400, 'Ponle un nombre (p. ej. "Partido mediodía y noche")');
    const segs = JSON.stringify(cleanSegs(d.segs, cfg.rules.max_segs));
    if (method === 'POST' && !c) {
      const r = await env.DB.prepare('INSERT INTO shift_templates (name, department, segs) VALUES (?,?,?) RETURNING id').bind(d.name.trim(), d.department || null, segs).first();
      ctx.audit = { entity: 'turnos', summary: `Turno tipo nuevo: ${d.name}` };
      return json({ id: r.id });
    }
    if (method === 'PUT' && c) {
      await env.DB.prepare('UPDATE shift_templates SET name = ?, department = ?, segs = ? WHERE id = ?').bind(d.name.trim(), d.department || null, segs, c).run();
      ctx.audit = { entity: 'turnos', summary: `Turno tipo modificado: ${d.name}` };
      return json({ ok: true });
    }
  }

  if (b === 'config' && (method === 'PUT' || method === 'POST')) {
    const d = await body(request);
    const stmts = [];
    if (Array.isArray(d.departments)) {
      const deps = [...new Set(d.departments.map((x) => String(x).trim()).filter(Boolean))];
      if (!deps.length) throw new HttpError(400, 'Hace falta al menos un departamento');
      stmts.push(setSetting(env, 'turnos_departments', JSON.stringify(deps)));
    }
    if (d.rules) {
      const r = {};
      for (const k of Object.keys(DEFAULT_RULES)) if (d.rules[k] !== undefined && d.rules[k] !== '' && !isNaN(Number(d.rules[k]))) r[k] = Number(d.rules[k]);
      stmts.push(setSetting(env, 'turnos_rules', JSON.stringify(r)));
    }
    if (Array.isArray(d.services)) {
      const sv = d.services.filter((x) => x && String(x.name || '').trim()).map((x) => {
        if (toMin(x.start) === null || toMin(x.end) === null) throw new HttpError(400, `Horas del servicio "${x.name}" no válidas`);
        return { name: String(x.name).trim(), start: hhmm(x.start), end: hhmm(x.end) };
      });
      stmts.push(setSetting(env, 'turnos_services', JSON.stringify(sv)));
    }
    if (d.mins && typeof d.mins === 'object') stmts.push(setSetting(env, 'turnos_mins', JSON.stringify(d.mins)));
    if (stmts.length) await env.DB.batch(stmts);
    ctx.audit = { entity: 'turnos', summary: 'Reglas y servicios del cuadrante modificados' };
    return json({ ok: true });
  }

  if (b === 'link' && method === 'POST') {
    const t = newToken();
    await setSetting(env, 'turnos_token', t).run();
    ctx.audit = { entity: 'turnos', summary: 'Enlace del cuadrante para el equipo ' + (cfg.token ? 'cambiado (el anterior deja de funcionar)' : 'creado') };
    return json({ token: t });
  }

  // guardar uno o varios días (un turno por persona y día)
  if (b === 'shifts' && method === 'POST') {
    const d = await body(request);
    const items = Array.isArray(d.items) ? d.items : [];
    if (!items.length) throw new HttpError(400, 'Nada que guardar');
    if (items.length > 400) throw new HttpError(400, 'Demasiados cambios de una vez');
    const stmts = [], touched = {};
    for (const it of items) {
      if (!it.staff_id || !isDate(it.day)) throw new HttpError(400, 'Persona o día no válidos');
      const kind = it.kind || '';
      const w = mondayOf(it.day);
      (touched[w] = touched[w] || new Set()).add(Number(it.staff_id));
      if (!kind || kind === 'vacio') { stmts.push(env.DB.prepare('DELETE FROM shifts WHERE staff_id = ? AND day = ?').bind(it.staff_id, it.day)); continue; }
      if (!KINDS.includes(kind)) throw new HttpError(400, 'Tipo de día no válido');
      const segs = kind === 'trabajo' ? JSON.stringify(cleanSegs(it.segs, cfg.rules.max_segs)) : null;
      stmts.push(env.DB.prepare(`INSERT INTO shifts (staff_id, day, kind, segs, note, updated_at) VALUES (?,?,?,?,?, datetime('now'))
        ON CONFLICT(staff_id, day) DO UPDATE SET kind = excluded.kind, segs = excluded.segs, note = excluded.note, updated_at = excluded.updated_at`)
        .bind(it.staff_id, it.day, kind, segs, String(it.note || '').trim().slice(0, 80) || null));
    }
    await markChanged(env, touched, stmts);
    await env.DB.batch(stmts);
    ctx.audit = { entity: 'turnos', action: 'modificación', summary: `Cuadrante: ${items.length} día(s) cambiados` };
    return json({ ok: true });
  }

  // copiar una semana en otra
  if (b === 'copy' && method === 'POST') {
    const d = await body(request);
    if (!isDate(d.week)) throw new HttpError(400, 'Semana no válida');
    const to = mondayOf(d.week), from = mondayOf(isDate(d.from) ? d.from : addDays(to, -7));
    if (from === to) throw new HttpError(400, 'Elige otra semana de origen');
    const dep = d.department || null;
    const { results: src } = await env.DB.prepare(`SELECT sh.* FROM shifts sh JOIN staff s ON s.id = sh.staff_id AND s.active = 1
      WHERE sh.day BETWEEN ? AND ? ${dep ? 'AND s.department = ?' : ''}`).bind(from, addDays(from, 6), ...(dep ? [dep] : [])).all();
    if (!src.length) throw new HttpError(400, 'La semana de origen está vacía');
    const ids = [...new Set(src.map((x) => x.staff_id))];
    const off = Math.round((D(to) - D(from)) / 86400000);
    const stmts = [env.DB.prepare(`DELETE FROM shifts WHERE day BETWEEN ? AND ? AND staff_id IN (${ids.map(() => '?').join(',')})`).bind(to, addDays(to, 6), ...ids)];
    for (const x of src) stmts.push(env.DB.prepare(`INSERT INTO shifts (staff_id, day, kind, segs, note) VALUES (?,?,?,?,?)`).bind(x.staff_id, addDays(x.day, off), x.kind, x.segs, x.note));
    await markChanged(env, { [to]: new Set(ids) }, stmts);
    await env.DB.batch(stmts);
    ctx.audit = { entity: 'turnos', action: 'copia', summary: `Cuadrante: copiada la semana del ${from} a la del ${to}${dep ? ' (' + dep + ')' : ''}` };
    return json({ ok: true, copied: src.length });
  }

  if (b === 'clear' && method === 'POST') {
    const d = await body(request);
    const w = mondayOf(d.week);
    const dep = d.department || null;
    const { results: ids } = await env.DB.prepare(`SELECT DISTINCT staff_id FROM shifts sh JOIN staff s ON s.id = sh.staff_id WHERE day BETWEEN ? AND ? ${dep ? 'AND s.department = ?' : ''}`).bind(w, addDays(w, 6), ...(dep ? [dep] : [])).all();
    const stmts = [env.DB.prepare(`DELETE FROM shifts WHERE day BETWEEN ? AND ? ${dep ? 'AND staff_id IN (SELECT id FROM staff WHERE department = ?)' : ''}`).bind(w, addDays(w, 6), ...(dep ? [dep] : []))];
    await markChanged(env, { [w]: new Set(ids.map((x) => x.staff_id)) }, stmts);
    await env.DB.batch(stmts);
    ctx.audit = { entity: 'turnos', action: 'borrado', summary: `Cuadrante de la semana del ${w} vaciado${dep ? ' (' + dep + ')' : ''}` };
    return json({ ok: true });
  }

  // publicar: avisa a cada persona con su horario y a los responsables
  if ((b === 'publish' || b === 'notify') && method === 'POST') {
    const d = await body(request);
    if (!isDate(d.week)) throw new HttpError(400, 'Semana no válida');
    const week = mondayOf(d.week);
    const { staff, shifts, wk } = await loadWeek(env, week);
    const inWeek = shifts.filter((x) => x.day >= week && x.day <= addDays(week, 6));
    if (!inWeek.length) throw new HttpError(400, 'El cuadrante de esta semana está vacío');
    const republish = b === 'notify';
    const only = republish ? JSON.parse(wk.changed || '[]') : null;
    if (republish && !only.length) throw new HttpError(400, 'No hay cambios pendientes de avisar');
    await env.DB.prepare(`INSERT INTO schedule_weeks (week, status, published_at, published_by, changed) VALUES (?, 'publicado', datetime('now'), ?, '[]')
      ON CONFLICT(week) DO UPDATE SET status = 'publicado', published_at = datetime('now'), published_by = excluded.published_by, changed = '[]'`).bind(week, user.id).run();
    const token = cfg.token || newToken();
    if (!cfg.token) await setSetting(env, 'turnos_token', token).run();
    // personal sin enlace propio: se le crea
    const noTok = staff.filter((p) => !p.token);
    if (noTok.length) { await env.DB.batch(noTok.map((p) => { p.token = newToken(); return env.DB.prepare('UPDATE staff SET token = ? WHERE id = ?').bind(p.token, p.id); })); }
    const pushed = await notifyStaff(env, staff, week, inWeek, only, republish, user.name);  // se envían todos juntos abajo
    // responsables: aviso general (menos quien publica y quien ya tiene el suyo)
    const staffUsers = new Set(staff.filter((p) => p.user_id && (!only || only.includes(p.id))).map((p) => p.user_id));
    const bosses = (await pushUsersWith(env, 'turnos.gestionar')).filter((id) => id !== user.id && !staffUsers.has(id));
    const viewers = republish ? [] : (await pushUsersWith(env, 'turnos.ver')).filter((id) => id !== user.id && !staffUsers.has(id) && !bosses.includes(id));
    const names = only ? staff.filter((p) => only.includes(p.id)).map((p) => p.name.split(' ')[0]).join(', ') : '';
    await enqueuePush(env, [...bosses, ...viewers], {
      title: republish ? 'Cambios en el cuadrante' : 'Cuadrante publicado',
      body: republish ? `${user.name} ha cambiado el horario de ${names} (semana del ${dateLong(week)})` : `${user.name} ha publicado el cuadrante de la semana del ${dateLong(week)}`,
      url: `/#/turnos?week=${week}`, tag: 'cuadrante-' + week,
    }, { now: false });
    try { await deliver(env); } catch (e) { console.error('avisos', e); }
    ctx.audit = { entity: 'turnos', action: republish ? 'aviso de cambios' : 'publicación', summary: republish ? `Cuadrante del ${week}: avisados los cambios a ${names}` : `Cuadrante de la semana del ${week} publicado` };
    return json({ ok: true, pushed, token, messages: messagesFor(staff, week, inWeek, url.origin, restaurant, only, republish) });
  }

  if (b === 'messages' && method === 'GET') {
    const week = mondayOf(isDate(q.get('week')) ? q.get('week') : localDay());
    const { staff, shifts } = await loadWeek(env, week);
    return json({ messages: messagesFor(staff, week, shifts.filter((x) => x.day >= week && x.day <= addDays(week, 6)), url.origin, restaurant, null, false) });
  }

  throw new HttpError(404, 'No encontrado');
}

// Si la semana ya estaba publicada, apunta a quién le ha cambiado el horario (para avisar solo a esas personas)
async function markChanged(env, touched, stmts) {
  for (const [w, set] of Object.entries(touched)) {
    const wk = await env.DB.prepare('SELECT changed, status FROM schedule_weeks WHERE week = ?').bind(w).first();
    if (!wk || wk.status !== 'publicado') continue;
    const ch = new Set([...JSON.parse(wk.changed || '[]'), ...set]);
    stmts.push(env.DB.prepare('UPDATE schedule_weeks SET changed = ? WHERE week = ?').bind(JSON.stringify([...ch]), w));
  }
}

// horario de una persona: semana pedida (o la actual) y la siguiente, solo lo publicado
async function personView(env, p, weekQ) {
  const w0 = mondayOf(isDate(weekQ) ? weekQ : localDay());
  const weeks = [w0, addDays(w0, 7)];
  const { results: pub } = await env.DB.prepare(`SELECT week, published_at FROM schedule_weeks WHERE status = 'publicado' AND week IN (?, ?)`).bind(...weeks).all();
  const { results: sh } = await env.DB.prepare('SELECT day, kind, segs, note FROM shifts WHERE staff_id = ? AND day BETWEEN ? AND ? ORDER BY day').bind(p.id, weeks[0], addDays(weeks[1], 6)).all();
  return {
    person: { id: p.id, name: p.name, department: p.department, position: p.position },
    weeks: weeks.map((w) => {
      const ok = pub.find((x) => x.week === w);
      const days = weekDays(w).map((day) => { const x = ok ? sh.find((s) => s.day === day) : null; return { day, kind: x ? x.kind : ok ? 'libre' : null, segs: x ? parseSegs(x.segs) : [], note: x?.note || null }; });
      return { week: w, published: !!ok, published_at: ok?.published_at || null, days, hours: r1(days.filter((d) => d.kind === 'trabajo').reduce((t, d) => t + segsHours(d.segs), 0)) };
    }),
  };
}

// Enlaces sin contraseña: el del equipo (cuadrante completo) y el personal de cada trabajador
export async function publicSchedule(env, token) {
  if (!/^[a-z0-9]{8,40}$/.test(token)) throw new HttpError(404, 'Enlace no válido');
  const cfg = await config(env);
  const restaurant = (await settings(env)).restaurant_name;
  const p = await env.DB.prepare('SELECT * FROM staff WHERE token = ? AND active = 1').bind(token).first();
  if (p) return json({ kind: 'persona', restaurant, ...(await personView(env, p)) });
  if (!cfg.token || token !== cfg.token) throw new HttpError(404, 'Este enlace ya no es válido. Pide el nuevo al responsable.');
  const w0 = mondayOf(localDay());
  const weeks = [];
  for (const w of [w0, addDays(w0, 7)]) {
    const wk = await env.DB.prepare(`SELECT published_at FROM schedule_weeks WHERE week = ? AND status = 'publicado'`).bind(w).first();
    if (!wk) { weeks.push({ week: w, published: false }); continue; }
    const { staff, shifts } = await loadWeek(env, w);
    const inWeek = shifts.filter((x) => x.day >= w && x.day <= addDays(w, 6));
    const ids = new Set(inWeek.map((x) => x.staff_id));
    weeks.push({ week: w, published: true, published_at: wk.published_at, days: weekDays(w),
      staff: staff.filter((s) => s.active || ids.has(s.id)).map((s) => ({ id: s.id, name: s.name, department: s.department, position: s.position })),
      shifts: inWeek.map(({ staff_id, day, kind, segs, note }) => ({ staff_id, day, kind, segs, note })) });
  }
  return json({ kind: 'equipo', restaurant, departments: cfg.departments, weeks });
}

// Recordatorio de la tarde: "mañana entras a las…" (lo lanza la tarea programada, una vez al día a partir de las 20:00)
export async function eveningReminders(env) {
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }));
  const day = localDay();
  if (hour < 20 || hour > 22) return 0;
  const done = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'turnos_reminded'`).first();
  if (done?.value === day) return 0;
  await setSetting(env, 'turnos_reminded', day).run();
  const tomorrow = addDays(day, 1);
  const { results } = await env.DB.prepare(`SELECT sh.*, s.user_id, s.name FROM shifts sh JOIN staff s ON s.id = sh.staff_id AND s.active = 1 AND s.user_id IS NOT NULL
    JOIN schedule_weeks w ON w.week = ? AND w.status = 'publicado' WHERE sh.day = ? AND sh.kind = 'trabajo'`).bind(mondayOf(tomorrow), tomorrow).all();
  let n = 0;
  for (const x of results) {
    n += await enqueuePush(env, [x.user_id], { title: `Mañana ${DAY_LONG[(D(tomorrow).getUTCDay() + 6) % 7]}: ${parseSegs(x.segs).map((s) => s[0]).join(' y ')}`, body: `Tu turno: ${dayLine(x)}`, url: '/#/mihorario', tag: 'manana-' + tomorrow }, { now: false });
  }
  if (n) await deliver(env);
  return n;
}
