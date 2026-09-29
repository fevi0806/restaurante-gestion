/* Gestión del restaurante — interfaz (sin dependencias ni compilación) */
'use strict';

// ---------------- utilidades ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => (Number(n) || 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const num = (n, d = 2) => (Number(n) || 0).toLocaleString('es-ES', { maximumFractionDigits: d });
const pct = (n) => (n === null || n === undefined || isNaN(n) ? '—' : num(n, 1) + ' %');
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const today = () => iso(new Date());
const fdate = (s) => (s ? new Date(String(s).slice(0, 10) + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' }) : '');
const parseNum = (v) => {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[€\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  return Number(s);
};
const norm = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const halfFactor = (name) => (/(^|\s)(1\/2|½|media|medio)(\s|$)/i.test(String(name)) ? 0.5 : /(^|\s)(1\/4|cuarto)(\s|$)/i.test(String(name)) ? 0.25 : 1);

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), err ? 5000 : 2600);
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch('/api/' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('No hay conexión con el servidor. Comprueba internet y vuelve a intentarlo.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (res.status === 401 && !opts.noRedirect) { S.user = null; renderLogin(); throw new Error('Sesión caducada'); }
  if (!res.ok) throw new Error((data && data.error) || 'Error ' + res.status);
  return data;
}

// Envuelve acciones: muestra error y evita doble clic
async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

// ---------------- estado ----------------
const S = { user: null, settings: {}, suppliers: [], products: [], recipes: [], formats: [] };
// permisos: el superusuario lo puede todo; el resto, lo que tenga marcado
const can = (p) => !!S.user && (S.user.is_super || (S.user.perms || []).includes(p));
const canAny = (...ps) => ps.some(can);
const ROLE_NAMES = { direccion: 'Dirección', cocina: 'Cocina', sala: 'Sala' };
const prodLabel = (p) => `${p.name} (${p.unit})`;
const prodById = (id) => S.products.find((p) => p.id === Number(id));
const recById = (id) => S.recipes.find((r) => r.id === Number(id));
const prodFromLabel = (v) => S.products.find((p) => prodLabel(p) === v || norm(p.name) === norm(v));
const recFromLabel = (v) => S.recipes.find((r) => norm(r.name) === norm(v));
const ivaDiv = () => 1 + (Number(S.settings.iva_pct) || 0) / 100;

// ---------------- unidades y formatos ----------------
// Unidad base del producto: kg, l o ud. Se puede escribir en g/ml/cl o en sus formatos (caja, saco, botella…)
const SUBUNITS = { kg: [['g', 0.001], ['kg', 1]], l: [['ml', 0.001], ['cl', 0.01], ['l', 1]], ud: [['ud', 1]] };
const fmtsOf = (p) => S.formats.filter((f) => f.product_id === p.id);
function unitOpts(p) {
  return [
    ...(SUBUNITS[p.unit] || [[p.unit, 1]]).map(([u, f]) => ({ v: u, label: u, short: u, factor: f })),
    ...fmtsOf(p).map((f) => ({ v: 'f:' + f.id, label: `${f.name} (${num(f.factor, 3)} ${p.unit})`, short: f.name, factor: f.factor, price: f.price })),
  ];
}
const unitOpt = (p, u) => unitOpts(p).find((o) => o.v === u) || { v: p.unit, label: p.unit, short: p.unit, factor: 1 };
const unitFactor = (p, u) => unitOpt(p, u).factor;
const unitShort = (p, u) => unitOpt(p, u).short;
const unitSelect = (p, sel, attrs = '') => `<select class="unit" ${attrs}>${unitOpts(p).map((o) => `<option value="${esc(o.v)}" ${o.v === sel ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
const defaultBuyUnit = (p) => { const f = fmtsOf(p).find((x) => x.is_default); return f ? 'f:' + f.id : p.unit; };
const defaultRecipeUnit = (p) => (p.unit === 'kg' ? 'g' : p.unit === 'l' ? 'ml' : p.unit);
// Precio de una unidad escrita: el del formato si se conoce; si no, precio base × factor
const unitPrice = (p, u) => { const o = unitOpt(p, u); return o.price > 0 ? o.price : (p.price || 0) * o.factor; };
function stockText(p, q) {
  const f = fmtsOf(p).filter((x) => x.factor > 1).sort((a, b) => b.factor - a.factor)[0];
  let t = `${num(q)} ${p.unit}`;
  if (f && q >= f.factor) {
    const n = Math.floor(q / f.factor + 1e-9), rest = q - n * f.factor;
    t += ` <span class="small muted">(${n} × ${esc(f.name)}${rest > 0.0001 ? ` + ${num(rest)} ${p.unit}` : ''})</span>`;
  }
  return t;
}

async function reload() {
  const d = await api('bootstrap');
  Object.assign(S, d);
  S.formats = d.formats || [];
  renderDatalists();
}
function renderDatalists() {
  let dl = $('#datalists');
  if (!dl) { dl = document.createElement('div'); dl.id = 'datalists'; document.body.appendChild(dl); }
  dl.innerHTML = `<datalist id="dl-prod">${S.products.map((p) => `<option value="${esc(prodLabel(p))}">`).join('')}</datalist>
    <datalist id="dl-rec">${S.recipes.map((r) => `<option value="${esc(r.name)}">`).join('')}</datalist>
    <datalist id="dl-pcat">${[...new Set(S.products.map((p) => p.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="dl-rcat">${[...new Set(S.recipes.map((r) => r.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
}

// ---------------- modal genérico ----------------
function modal(html, { onOpen } = {}) {
  const dlg = $('#modal'), form = $('#modal-form');
  form.innerHTML = html;
  return new Promise((resolve) => {
    const close = (v) => { dlg.close(); resolve(v); };
    form.onsubmit = (e) => { e.preventDefault(); close(e.submitter?.value || 'ok'); };
    dlg.onclose = () => resolve(null);
    $$('[data-close]', form).forEach((b) => (b.onclick = (e) => { e.preventDefault(); close(null); }));
    dlg.showModal();
    onOpen && onOpen(form);
  });
}
function fieldHtml(f, v) {
  const val = v ?? f.value ?? '';
  const req = f.required ? 'required' : '';
  let input;
  if (f.type === 'select') input = `<select name="${f.name}" ${req}>${f.options.map(([k, t]) => `<option value="${esc(k)}" ${String(k) === String(val) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  else if (f.type === 'textarea') input = `<textarea name="${f.name}">${esc(val)}</textarea>`;
  else input = `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(val)}" ${f.type === 'number' ? 'step="any" inputmode="decimal"' : ''} ${f.list ? `list="${f.list}"` : ''} ${req} ${f.attrs || ''}>`;
  return `<div class="field"><label>${esc(f.label)}</label>${input}${f.help ? `<div class="small muted">${esc(f.help)}</div>` : ''}</div>`;
}
async function formModal(title, fields, values = {}, submit = 'Guardar') {
  const r = await modal(`<h2>${esc(title)}</h2>${fields.map((f) => fieldHtml(f, values[f.name])).join('')}
    <div class="actions"><button data-close>Cancelar</button><button class="primary" value="ok">${esc(submit)}</button></div>`);
  if (!r) return null;
  const out = {};
  for (const f of fields) {
    const el = $(`[name="${f.name}"]`, $('#modal-form'));
    out[f.name] = f.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value.trim();
  }
  return out;
}
const confirmModal = (msg, ok = 'Sí, continuar') =>
  modal(`<p>${esc(msg)}</p><div class="actions"><button data-close>Cancelar</button><button class="primary danger" value="ok">${esc(ok)}</button></div>`);

// ---------------- arranque, login ----------------
async function boot() {
  let st;
  try {
    st = await api('setup-status', { noRedirect: true });
  } catch {
    // sin servidor no se puede entrar: mejor decirlo que mostrar un login que nunca funcionará
    $('#app').innerHTML = `<div class="login"><div class="card"><h1>No se puede conectar con el servidor</h1>
      <p>Las pantallas se han publicado, pero la parte de servidor (<code>/api</code>) no responde, así que no se puede entrar ni crear usuarios.</p>
      <p class="small muted">Suele deberse a que Cloudflare no ha leído <code>wrangler.toml</code> (nombre mal escrito, carpetas <code>src</code> y <code>public</code> fuera de su sitio) o a que se ha subido solo la carpeta <code>public</code>. Revisa el apartado de publicación de la guía.</p>
      <button class="primary" onclick="location.reload()">Reintentar</button></div></div>`;
    return;
  }
  try {
    if (st.needsSetup) return renderSetup();
    await reload();
    renderShell();
  } catch (e) {
    if (!S.user) renderLogin();
    else $('#app').innerHTML = `<div class="boot">${esc(e.message)}</div>`;
  }
}

function renderSetup() {
  $('#app').innerHTML = `<div class="login"><form class="card" id="f">
    <h1>Puesta en marcha</h1>
    <p class="muted small">Crea el usuario de dirección. Después podrás dar de alta al resto del equipo.</p>
    ${fieldHtml({ name: 'restaurant_name', label: 'Nombre del restaurante', required: true })}
    ${fieldHtml({ name: 'name', label: 'Tu nombre', required: true })}
    ${fieldHtml({ name: 'username', label: 'Usuario para entrar', required: true, attrs: 'autocomplete="username" autocapitalize="none"' })}
    ${fieldHtml({ name: 'password', label: 'Contraseña (mínimo 6)', type: 'password', required: true, attrs: 'autocomplete="new-password" minlength="6"' })}
    <button class="primary" style="width:100%">Crear y entrar</button></form></div>`;
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    act(e.submitter, async () => {
      await api('setup', { body: d, noRedirect: true });
      await api('login', { body: d, noRedirect: true });
      await reload(); renderShell();
    });
  };
}

function renderLogin() {
  $('#app').innerHTML = `<div class="login"><form class="card" id="f">
    <h1>${esc(S.settings.restaurant_name || 'Gestión del restaurante')}</h1>
    ${fieldHtml({ name: 'username', label: 'Usuario', required: true, attrs: 'autocomplete="username" autocapitalize="none"' })}
    ${fieldHtml({ name: 'password', label: 'Contraseña', type: 'password', required: true, attrs: 'autocomplete="current-password"' })}
    <button class="primary" style="width:100%">Entrar</button></form></div>`;
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    act(e.submitter, async () => {
      await api('login', { body: Object.fromEntries(new FormData(e.target)), noRedirect: true });
      await reload(); renderShell();
    });
  };
}

// ---------------- estructura y navegación ----------------
const NAV = [
  { r: 'inicio', t: 'Inicio', i: '🏠', need: [] },
  { r: 'panel', t: 'Panel de control', i: '📈', need: ['panel.ver'] },
  { r: 'informes', t: 'Informes', i: '🗂️', need: ['informes.ver'] },
  { r: 'caja', t: 'Caja del día', i: '💶', need: ['caja.registrar', 'caja.ver'] },
  { sep: true },
  { r: 'pedidos', t: 'Pedidos', i: '📝', need: ['pedidos.ver', 'pedidos.crear'] },
  { r: 'recepcion', t: 'Recepción', i: '📦', need: ['recepcion.ver', 'recepcion.crear'] },
  { r: 'mermas', t: 'Mermas y personal', i: '🗑️', need: ['mermas.registrar', 'mermas.ver_todas'] },
  { r: 'stock', t: 'Stock e inventario', i: '📊', need: ['stock.ver', 'inventario.hacer'] },
  { r: 'escandallos', t: 'Escandallos', i: '🍽️', need: ['escandallos.ver', 'escandallos.editar'] },
  { sep: true },
  { r: 'ventas', t: 'Ventas Qamarero', i: '🧾', need: ['ventas.gestionar'] },
  { r: 'gastos', t: 'Gastos fijos', i: '🏷️', need: ['gastos.gestionar'] },
  { r: 'productos', t: 'Productos', i: '🥕', need: ['productos.editar'] },
  { r: 'proveedores', t: 'Proveedores', i: '🚚', need: ['productos.editar'] },
  { sep: true },
  { r: 'usuarios', t: 'Usuarios y permisos', i: '👥', need: ['super'] },
  { r: 'ajustes', t: 'Ajustes', i: '⚙️', need: ['super'] },
];
const allowed = (n) => !n.need || !n.need.length || n.need.some((p) => (p === 'super' ? S.user?.is_super : can(p)));
// separadores solo entre grupos con algo visible
const visibleNav = () => NAV.filter((n, i) => (n.sep ? NAV.slice(i + 1).some((x) => !x.sep && allowed(x)) && NAV.slice(0, i).some((x) => !x.sep && allowed(x)) && !NAV[i + 1]?.sep : allowed(n)));

function renderShell() {
  $('#app').innerHTML = `<div class="shell" id="shell">
    <nav class="side" id="side">
      <div class="brand">${esc(S.settings.restaurant_name)}<small>Control de consumo</small></div>
      ${visibleNav().map((n) => (n.sep ? '<div class="sep"></div>' : `<a href="#/${n.r}" data-r="${n.r}"><span>${n.i}</span>${esc(n.t)}</a>`)).join('')}
      <div class="sep"></div>
      <div class="who">${esc(S.user.name)}${S.user.is_super ? ' · Superusuario' : ''}<br><button class="sm" id="logout">Salir</button></div>
    </nav>
    <div>
      <div class="topbar"><button id="menu" aria-label="Menú">☰</button><span class="t" id="ttl"></span></div>
      <main class="main" id="view"></main>
    </div></div>`;
  $('#menu').onclick = () => $('#shell').classList.toggle('nav-open');
  $('#side').onclick = (e) => { if (e.target.closest('a')) $('#shell').classList.remove('nav-open'); };
  $('#shell').addEventListener('click', (e) => { if (e.target.id === 'shell') $('#shell').classList.remove('nav-open'); });
  $('#logout').onclick = async () => { await api('logout', { body: {} }).catch(() => {}); S.user = null; renderLogin(); };
  route();
}

window.addEventListener('hashchange', () => S.user && route());

async function route() {
  const [path, qs] = (location.hash.slice(2) || 'inicio').split('?');
  const [r, id] = path.split('/');
  const q = new URLSearchParams(qs || '');
  const nav = NAV.find((n) => n.r === r);
  if (!nav || !allowed(nav)) { location.hash = '#/inicio'; return; }
  $$('#side a').forEach((a) => a.classList.toggle('active', a.dataset.r === r));
  $('#ttl').textContent = nav.t;
  const old = $('#view'), view = old.cloneNode(false);
  old.replaceWith(view);
  view.innerHTML = '<div class="boot">Cargando…</div>';
  window.scrollTo(0, 0);
  try { await VIEWS[r](view, id, q); } catch (e) { view.innerHTML = `<div class="card"><p class="txt-bad">${esc(e.message)}</p></div>`; }
}
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };

// ================= VISTAS =================
const VIEWS = {};

// ---------- Inicio ----------
// Pestaña "Resumen" del panel de control
async function panelResumen(v, q, head, from, to) {
  const now = new Date();
  const periods = {
    mes: [iso(new Date(now.getFullYear(), now.getMonth(), 1)), today()],
    anterior: [iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))],
    semana: [iso(new Date(Date.now() - 6 * 86400000)), today()],
    ano: [iso(new Date(now.getFullYear(), 0, 1)), today()],
  };
  const d = await api(`dashboard?from=${from}&to=${to}`);
  const target = d.settings.food_cost_target;
  const fcCls = (x) => (x === null ? '' : x > target + 3 ? 'bad' : x <= target ? 'good' : '');
  const per = Object.entries(periods).find(([, p]) => p[0] === from && p[1] === to)?.[0];
  const noSales = !d.revenue;

  void per;
  v.innerHTML = head + `
    ${d.pending_pos ? `<div class="card" style="border-color:var(--accent)"><b>${d.pending_pos} nombre(s) de Qamarero sin vincular.</b> Sus ventas no cuentan hasta que los asignes a un plato. <a href="#/ventas?tab=pendientes">Vincular ahora →</a></div>` : ''}
    ${noSales ? `<div class="card"><b>Aún no hay ventas en este periodo.</b> <span class="muted">Importa las ventas de Qamarero para calcular el food cost.</span> <a href="#/ventas">Importar ventas →</a></div>` : ''}
    <div class="grid k">
      ${kpi('Ventas (sin IVA)', eur(d.revenue), `${num(d.units_sold, 0)} raciones`)}
      ${kpi('Food cost real', pct(d.food_cost_real), `Objetivo ${num(target)} %`, fcCls(d.food_cost_real))}
      ${kpi('Food cost teórico', pct(d.food_cost_theoretical), 'Según escandallos')}
      ${kpi('Resultado estimado', eur(d.result), 'Ventas − consumo − fijos', d.result < 0 ? 'bad' : 'good')}
      ${kpi('Mermas', eur(d.waste), pct(d.revenue ? (d.waste / d.revenue) * 100 : null) + ' de ventas', d.waste > 0 ? 'bad' : '')}
      ${kpi('Consumo de personal', eur(d.staff), '')}
      ${kpi('Descuadre de inventario', eur(d.inv_diff), d.inv_diff > 0 ? 'Falta producto' : d.inv_diff < 0 ? 'Sobra producto' : 'Sin inventarios', d.inv_diff > 0 ? 'bad' : '')}
      ${kpi('Compras', eur(d.purchases), `${d.n_receipts} albaranes`)}
      ${kpi('Gastos fijos del periodo', eur(d.fixed_period), `${eur(d.fixed_monthly)}/mes · ${pct(d.fixed_pct)}`)}
      ${kpi('Stock valorado hoy', eur(d.stock_value), '')}
      ${kpi('Caja real cobrada', eur(d.cash.total), d.cash.days ? `${d.cash.days} días · ${d.cash.covers ? 'ticket medio ' + eur(d.cash.total / d.cash.covers) : 'sin comensales'}` : 'Sin cajas registradas')}
      ${kpi('Descuadre de caja', d.cash.days_with_pos ? eur(d.cash.diff) : '—', d.cash.days_with_pos ? `frente al cierre de Qamarero (${d.cash.days_with_pos} días)` : 'Anota el cierre de Qamarero en la caja', d.cash.diff < -1 ? 'bad' : '')}
    </div>
    <div class="card" style="margin-top:16px"><h3>¿Dónde se va el dinero de la comida?</h3>
      ${consumptionBar(d)}
    </div>
    <div class="grid two">
      ${tableCard('Platos con food cost alto', d.dish_alerts, ['Plato', 'Coste', 'PVP', 'FC'], (r) => [esc(r.name), eur(r.cost), eur(r.pvp), `<span class="txt-bad">${pct(r.fc)}</span>`], `Todos los platos escandallados están dentro del objetivo${d.recipes_without_lines ? ` · ${d.recipes_without_lines} ${d.recipes_without_lines === 1 ? 'plato' : 'platos'} sin escandallo` : ''}`)}
      ${tableCard('Mayores mermas', d.top_waste, ['Producto', 'Cantidad', 'Valor'], (r) => [esc(r.name), `${num(r.qty)} ${esc(r.unit)}`, eur(r.value)], 'Sin mermas registradas en el periodo')}
      ${tableCard('Cambios de precio (45 días)', d.price_changes, ['Producto', 'Antes', 'Ahora', ''], (r) => { const ch = r.old_price ? ((r.new_price - r.old_price) / r.old_price) * 100 : 0; return [esc(r.name), eur(r.old_price), eur(r.new_price), `<span class="${ch > 0 ? 'txt-bad' : 'txt-ok'}">${ch > 0 ? '+' : ''}${num(ch, 1)} %</span>`]; }, 'Sin cambios de precio')}
      ${tableCard('Compras por proveedor', d.by_supplier, ['Proveedor', 'Total'], (r) => [esc(r.name), eur(r.total)], 'Sin compras en el periodo')}
      ${tableCard('Platos más vendidos', d.top_dishes, ['Plato', 'Raciones', 'Ventas'], (r) => [esc(r.name), num(r.units, 1), eur(r.revenue)], 'Sin ventas importadas')}
      ${tableCard('Bajo stock mínimo', d.low_stock, ['Producto', 'Stock', 'Mínimo'], (r) => [esc(r.name), `<span class="txt-bad">${num(r.stock)}</span> ${esc(r.unit)}`, num(r.min_stock)], 'Nada por debajo del mínimo')}
    </div>`;
}
const kpi = (l, v, s, cls = '') => `<div class="kpi ${cls}"><div class="l">${esc(l)}</div><div class="v">${v}</div><div class="s">${esc(s || '')}</div></div>`;
function tableCard(title, rows, heads, fn, empty) {
  return `<div class="card"><h3>${esc(title)}</h3>${rows && rows.length ? `<div class="table-wrap"><table><thead><tr>${heads.map((h, i) => `<th class="${i ? 'num' : ''}">${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${fn(r).map((c, i) => `<td class="${i ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<div class="empty small">${esc(empty)}</div>`}</div>`;
}
function consumptionBar(d) {
  const parts = [['Consumo según escandallos', d.theoretical, 'var(--ok)'], ['Mermas', d.waste, 'var(--bad)'], ['Personal', d.staff, 'var(--accent)'], ['Descuadre inventario', Math.max(d.inv_diff, 0), '#7a5ea8']];
  const total = parts.reduce((s, p) => s + Math.max(p[1], 0), 0);
  if (!total) return '<div class="empty small">Sin datos todavía: importa ventas y registra mermas para ver el reparto.</div>';
  return `<div style="display:flex;height:22px;border-radius:6px;overflow:hidden;margin:6px 0 10px">${parts.map(([, v, c]) => (v > 0 ? `<i style="width:${(v / total) * 100}%;background:${c}"></i>` : '')).join('')}</div>
    <div class="row small">${parts.map(([t, v, c]) => `<span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${c};margin-right:5px"></i>${esc(t)}: <b>${eur(v)}</b></span>`).join('')}</div>`;
}

VIEWS.inicio = async (v) => {
  await reload();
  const acts = [
    ['recepcion.crear', '#/recepcion/nueva?scan=1', '📷', 'Escanear albarán'],
    ['recepcion.crear', '#/recepcion/nueva', '📦', 'Recibir mercancía'],
    ['pedidos.crear', '#/pedidos/nuevo', '📝', 'Hacer pedido'],
    ['mermas.registrar', '#/mermas', '🗑️', 'Registrar merma'],
    ['mermas.registrar', '#/mermas?tipo=consumo_personal', '🍴', 'Comida de personal'],
    ['caja.registrar', '#/caja', '💶', 'Cerrar caja'],
    ['inventario.hacer', '#/stock?tab=inventario', '📋', 'Hacer inventario'],
    ['escandallos.ver', '#/escandallos', '🍽️', 'Fichas técnicas'],
    ['panel.ver', '#/panel', '📈', 'Panel de control'],
    ['informes.ver', '#/informes', '🗂️', 'Informes'],
  ].filter(([p]) => can(p));
  const low = canAny('stock.ver', 'pedidos.crear') ? S.products.filter((p) => p.min_stock > 0 && p.stock < p.min_stock) : [];
  let kp = '';
  if (can('panel.ver')) {
    const now = new Date();
    const d = await api(`dashboard?from=${iso(new Date(now.getFullYear(), now.getMonth(), 1))}&to=${today()}`).catch(() => null);
    if (d) kp = `<h3 style="margin-top:20px">Este mes</h3><div class="grid k">${kpi('Ventas sin IVA', eur(d.revenue), '')}${kpi('Food cost real', pct(d.food_cost_real), `Objetivo ${num(d.settings.food_cost_target)} %`, d.food_cost_real > d.settings.food_cost_target + 3 ? 'bad' : '')}${kpi('Mermas + personal', eur(d.waste + d.staff), '')}${kpi('Resultado estimado', eur(d.result), '', d.result < 0 ? 'bad' : 'good')}</div>
      ${d.pending_pos ? `<div class="card" style="margin-top:12px;border-color:var(--accent)"><b>${d.pending_pos} nombre(s) de Qamarero sin vincular.</b> <a href="#/ventas?tab=pendientes">Vincular →</a></div>` : ''}`;
  }
  v.innerHTML = `<h1>Hola, ${esc(S.user.name.split(' ')[0])}</h1>
    ${acts.length ? `<div class="quick">${acts.map(([, h, i, t]) => `<a href="${h}"><span>${i}</span>${esc(t)}</a>`).join('')}</div>` : '<div class="card">Todavía no tienes permisos asignados. Pídeselos al responsable.</div>'}
    ${kp}
    ${low.length ? `<div style="margin-top:16px">${tableCard('Bajo stock mínimo', low, ['Producto', 'Stock', 'Mínimo'], (r) => [esc(r.name), `<span class="txt-bad">${stockText(r, r.stock)}</span>`, `${num(r.min_stock)} ${esc(r.unit)}`], '')}</div>` : ''}`;
};

// ---------- Pedidos ----------
const ST_PILL = { borrador: 'pill', enviado: 'pill warn', recibido: 'pill ok', cancelado: 'pill bad' };
VIEWS.pedidos = async (v, id) => {
  if (id === 'nuevo') return pedidoNuevo(v);
  if (id) return pedidoDetalle(v, id);
  const list = await api('orders');
  v.innerHTML = `<div class="row between"><h1>Pedidos a proveedores</h1><a class="btn primary" href="#/pedidos/nuevo">+ Nuevo pedido</a></div>
    <div class="card">${list.length ? `<div class="table-wrap"><table><thead><tr><th>Nº</th><th>Fecha</th><th>Proveedor</th><th>Estado</th><th class="num">Líneas</th><th class="num">Importe est.</th></tr></thead><tbody>
    ${list.map((o) => `<tr class="click" data-h="#/pedidos/${o.id}"><td>#${o.id}</td><td>${fdate(o.order_date)}</td><td>${esc(o.supplier_name)}</td><td><span class="${ST_PILL[o.status]}">${o.status}</span></td><td class="num">${o.n_lines}</td><td class="num">${eur(o.total)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Todavía no hay pedidos.</div>'}</div>`;
  bindRowLinks(v);
};
const bindRowLinks = (el) => $$('tr[data-h]', el).forEach((tr) => (tr.onclick = () => go(tr.dataset.h)));

async function pedidoNuevo(v) {
  if (!S.suppliers.length) { v.innerHTML = `<div class="card">Primero da de alta proveedores y productos. <a href="#/proveedores">Ir a proveedores →</a></div>`; return; }
  const lines = {}; // product_id -> { qty, unit }
  v.innerHTML = `<h1>Nuevo pedido</h1><div class="card">
    <div class="row"><div class="field"><label>Proveedor</label><select id="sup"><option value="">Elige proveedor…</option>${S.suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Entrega prevista</label><input type="date" id="exp"></div></div>
    <div id="sinfo" class="small muted"></div>
    <div id="plist"></div>
    <div class="row" style="margin:10px 0"><input list="dl-prod" id="extra" placeholder="Añadir otro producto…" style="flex:1"><button id="addx">Añadir</button></div>
    <div class="field"><label>Notas para el proveedor</label><textarea id="notes"></textarea></div>
    <div class="sticky-foot row between"><b id="tot"></b><div class="row"><button id="draft">Guardar borrador</button><button class="primary" id="send">Guardar pedido</button></div></div></div>`;
  const draw = () => {
    const sid = Number($('#sup').value);
    const s = S.suppliers.find((x) => x.id === sid);
    $('#sinfo').textContent = s ? [s.order_days && `Días de pedido: ${s.order_days}`, s.phone, s.email].filter(Boolean).join(' · ') : '';
    const prods = S.products.filter((p) => p.supplier_id === sid || lines[p.id]);
    $('#plist').innerHTML = !sid ? '' : prods.length ? `<div class="table-wrap"><table><thead><tr><th>Producto</th><th class="num">Stock</th><th class="num">Mínimo</th><th class="num">Pedir</th><th>Formato</th></tr></thead><tbody>
      ${prods.map((p) => { const l = lines[p.id] || { qty: '', unit: defaultBuyUnit(p) }; const low = p.min_stock > 0 && p.stock < p.min_stock;
        const sug = low ? Math.ceil(((p.min_stock - p.stock) / unitFactor(p, l.unit)) * 10) / 10 : '';
        return `<tr class="${low ? 'flag' : ''}"><td>${esc(p.name)}<div class="small muted">${esc(p.category || '')}${p.price ? ' · ' + eur(unitPrice(p, l.unit)) + ' / ' + esc(unitShort(p, l.unit)) : ''}</div></td><td class="num">${stockText(p, p.stock)}</td><td class="num">${num(p.min_stock)}</td>
        <td class="num"><input class="qty" type="number" step="any" inputmode="decimal" min="0" data-p="${p.id}" value="${l.qty}" placeholder="${sug ? num(sug, 1) : ''}"></td>
        <td>${unitSelect(p, l.unit, `data-u="${p.id}"`)}</td></tr>`; }).join('')}
      </tbody></table></div><div class="small muted">Resaltado: por debajo del mínimo (la sugerencia aparece en gris).</div>` : '<div class="empty small">Este proveedor no tiene productos asignados. Añádelos abajo o en Productos.</div>';
    $$('#plist input[data-p]').forEach((i) => (i.oninput = () => { const p = prodById(i.dataset.p); lines[p.id] = { qty: i.value === '' ? '' : Number(i.value), unit: $(`[data-u="${p.id}"]`).value }; total(); }));
    $$('#plist select[data-u]').forEach((sel) => (sel.onchange = () => { const pidv = sel.dataset.u; lines[pidv] = { qty: lines[pidv]?.qty ?? '', unit: sel.value }; draw(); }));
    total();
  };
  const total = () => { const t = Object.entries(lines).reduce((s, [pidv, l]) => { const p = prodById(pidv); return s + (Number(l.qty) || 0) * (p ? unitPrice(p, l.unit) : 0); }, 0); $('#tot').textContent = t ? 'Estimado: ' + eur(t) : ''; };
  $('#sup').onchange = draw;
  $('#addx').onclick = () => { const p = prodFromLabel($('#extra').value); if (!p) return toast('Producto no encontrado', true); lines[p.id] = lines[p.id] || { qty: '', unit: defaultBuyUnit(p) }; $('#extra').value = ''; draw(); };
  const save = (status, btn) => act(btn, async () => {
    const payload = { supplier_id: Number($('#sup').value), status, expected_date: $('#exp').value || null, notes: $('#notes').value,
      lines: Object.entries(lines).filter(([, l]) => Number(l.qty) > 0).map(([product_id, l]) => ({ product_id: Number(product_id), qty: Number(l.qty), unit: l.unit })) };
    if (!payload.supplier_id) throw new Error('Elige un proveedor');
    if (!payload.lines.length) throw new Error('Indica al menos una cantidad');
    const r = await api('orders', { body: payload });
    toast('Pedido guardado'); go('#/pedidos/' + r.id);
  });
  $('#draft').onclick = (e) => save('borrador', e.target);
  $('#send').onclick = (e) => save('enviado', e.target);
}

async function pedidoDetalle(v, id) {
  const o = await api('orders/' + id);
  const total = o.lines.reduce((s, l) => s + l.qty * (l.price || 0), 0);
  const text = `Hola${o.contact ? ' ' + o.contact : ''}, pedido de ${S.settings.restaurant_name}${o.expected_date ? ' para el ' + fdate(o.expected_date) : ''}:\n` + o.lines.map((l) => `- ${num(l.input_qty ?? l.qty, 3)} ${l.unit_label || l.unit} ${l.name}`).join('\n') + (o.notes ? `\n\n${o.notes}` : '') + '\n\nGracias.';
  const phone = String(o.phone || '').replace(/\D/g, '');
  v.innerHTML = `<div class="row between"><h1>Pedido #${o.id} · ${esc(o.supplier_name)}</h1><span class="${ST_PILL[o.status]}">${o.status}</span></div>
    <div class="card"><div class="small muted">Hecho el ${fdate(o.order_date)}${o.expected_date ? ' · entrega prevista ' + fdate(o.expected_date) : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Importe</th></tr></thead><tbody>
    ${o.lines.map((l) => { const iq = l.input_qty ?? l.qty; return `<tr><td>${esc(l.name)}</td><td class="num">${num(iq, 3)} ${esc(l.unit_label || l.unit)}${l.unit_label && l.unit_label !== l.unit ? `<div class="small muted">${num(l.qty, 3)} ${esc(l.unit)}</div>` : ''}</td><td class="num">${eur(iq ? (l.qty * (l.price || 0)) / iq : 0)}</td><td class="num">${eur(l.qty * (l.price || 0))}</td></tr>`; }).join('')}
    </tbody><tfoot><tr><th colspan="3">Total estimado</th><th class="num">${eur(total)}</th></tr></tfoot></table></div>
    ${o.notes ? `<p><b>Notas:</b> ${esc(o.notes)}</p>` : ''}
    <div class="row" style="margin-top:12px">
      ${o.status !== 'recibido' && o.status !== 'cancelado' ? `<a class="btn primary" href="#/recepcion/nueva?pedido=${o.id}">📦 Recibir mercancía</a>` : ''}
      <button id="copy">Copiar texto</button>
      ${phone ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${phone.length === 9 ? '34' + phone : phone}?text=${encodeURIComponent(text)}">Enviar por WhatsApp</a>` : ''}
      ${o.email ? `<a class="btn" href="mailto:${esc(o.email)}?subject=${encodeURIComponent('Pedido ' + S.settings.restaurant_name)}&body=${encodeURIComponent(text)}">Enviar por email</a>` : ''}
      ${o.status === 'borrador' ? '<button data-st="enviado">Marcar enviado</button>' : ''}
      ${o.status !== 'recibido' && o.status !== 'cancelado' ? '<button class="danger" data-st="cancelado">Cancelar pedido</button>' : ''}
    </div></div>`;
  $('#copy').onclick = () => navigator.clipboard.writeText(text).then(() => toast('Texto copiado'));
  $$('[data-st]', v).forEach((b) => (b.onclick = () => act(b, async () => { await api(`orders/${id}/status`, { method: 'PUT', body: { status: b.dataset.st } }); route(); })));
}

// ---------- Recepción ----------
VIEWS.recepcion = async (v, id, q) => {
  if (id === 'nueva') return recepcionNueva(v, q.get('pedido'));
  if (id) return recepcionDetalle(v, id);
  const [list, orders] = await Promise.all([api('receipts'), api('orders')]);
  const pend = orders.filter((o) => o.status === 'enviado');
  v.innerHTML = `<div class="row between"><h1>Recepción de mercancía</h1><a class="btn primary" href="#/recepcion/nueva">+ Recibir sin pedido</a></div>
    ${pend.length ? `<div class="card"><h3>Pedidos pendientes de recibir</h3><div class="table-wrap"><table><tbody>${pend.map((o) => `<tr class="click" data-h="#/recepcion/nueva?pedido=${o.id}"><td>#${o.id}</td><td>${esc(o.supplier_name)}</td><td>${fdate(o.order_date)}</td><td class="num"><span class="btn sm primary">Recibir →</span></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="card"><h3>Albaranes registrados</h3>${list.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Proveedor</th><th>Albarán</th><th>Recibió</th><th class="num">Total</th></tr></thead><tbody>
    ${list.map((r) => `<tr class="click" data-h="#/recepcion/${r.id}"><td>${fdate(r.receipt_date)}</td><td>${esc(r.supplier_name)}</td><td>${esc(r.delivery_note || '—')}</td><td>${esc(r.user_name || '')}</td><td class="num">${eur(r.total)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Sin albaranes todavía.</div>'}</div>`;
  bindRowLinks(v);
};

async function recepcionNueva(v, orderId, prefill) {
  let order = null, lines = [];
  if (orderId) {
    order = await api('orders/' + orderId);
    lines = order.lines.map((l) => { const p = prodById(l.product_id); const unit = l.input_unit || p?.unit; return { product_id: l.product_id, unit, ordered_qty: l.input_qty ?? l.qty, qty: l.input_qty ?? l.qty, price: p ? unitPrice(p, unit) : l.price }; });
  }
  if (prefill) lines = prefill.lines;
  v.innerHTML = `<h1>Recibir mercancía${order ? ` · pedido #${order.id}` : ''}</h1><div class="card">
    <div class="row">
      <div class="field"><label>Proveedor</label>${order ? `<input value="${esc(order.supplier_name)}" disabled>` : `<select id="sup"><option value="">Elige proveedor…</option>${S.suppliers.map((s) => `<option value="${s.id}" ${prefill?.supplier_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`}</div>
      <div class="field"><label>Nº de albarán</label><input id="dn" value="${esc(prefill?.delivery_note || '')}"></div>
      <div class="field"><label>Fecha</label><input type="date" id="date" value="${esc(prefill?.date || today())}"></div>
    </div>
    ${prefill?.ocr_id ? `<div class="card scanned"><b>📷 Leído del documento.</b> Revisa cada línea antes de registrar.
      ${!prefill.supplier_id && prefill.supplier_name ? `<div style="margin-top:6px">Proveedor leído: <b>${esc(prefill.supplier_name)}</b>${prefill.supplier_cif ? ' · ' + esc(prefill.supplier_cif) : ''}. Elígelo arriba o <button type="button" class="sm" id="newsup">Crear proveedor</button></div>` : ''}
      ${prefill.total_read ? `<div id="totcheck" style="margin-top:6px"></div>` : ''}
      ${prefill.lines.some((l) => !l.product_id) ? '<div class="txt-warn" style="margin-top:6px">Hay líneas sin producto: asígnalas o quítalas (por ejemplo, material que no controlas).</div>' : ''}</div>` : ''}
    <div id="ocrslot"></div>
    <p class="small muted">Comprueba cantidades y precios con el albarán. Puedes anotar en el formato en que llega (cajas, sacos, botellas…): la app lo pasa a su unidad de control. Las diferencias con lo pedido o con el último precio se resaltan.</p>
    <div id="lines"></div>
    <div class="row" style="margin:10px 0"><input list="dl-prod" id="extra" placeholder="Añadir producto al albarán…" style="flex:1"><button id="addx">Añadir</button></div>
    <div class="field"><label>Incidencias / notas</label><textarea id="notes" placeholder="Producto en mal estado, faltas, devoluciones…">${esc(prefill?.notes || '')}</textarea></div>
    <div class="sticky-foot row between"><b id="tot"></b><button class="primary" id="save">Registrar entrada</button></div></div>`;
  const draw = () => {
    $('#lines').innerHTML = lines.length ? `<div class="table-wrap"><table><thead><tr><th>Producto</th>${order ? '<th class="num">Pedido</th>' : ''}<th class="num">Recibido</th><th>Formato</th><th class="num">Precio</th><th class="num">Importe</th><th></th></tr></thead><tbody>
      ${lines.map((l, i) => { const p = prodById(l.product_id);
        if (!p) return `<tr class="flag"><td colspan="${order ? 3 : 2}"><div class="small">Albarán: <b>${esc(l.source || '')}</b> · ${num(l.qty, 3)} ${esc(l.printed_unit || '')} · ${eur(l.price)}</div><input list="dl-prod" data-pick="${i}" placeholder="¿Qué producto es? Escribe para buscar…"></td><td colspan="3" class="small muted">Sin producto asignado</td><td><button class="sm" data-del="${i}" aria-label="Quitar">✕</button></td></tr>`;
        const f = unitFactor(p, l.unit); const basePrice = f ? Number(l.price) / f : 0;
        const pd = p.price > 0 && Math.abs(basePrice - p.price) > 0.0005; const qd = order && l.ordered_qty != null && Math.abs(Number(l.qty) - l.ordered_qty) > 0.0005;
        return `<tr class="${pd || qd || l.warn ? 'flag' : ''}"><td>${esc(p.name)}${l.confidence === 'revisar' ? ' <span class="pill warn">revisar</span>' : l.confidence === 'aprendido' ? ' <span class="pill ok">conocido</span>' : ''}${l.source ? `<div class="small muted">Albarán: ${esc(l.source)}${l.printed_unit ? ' · ' + esc(l.printed_unit) : ''}</div>` : ''}<div class="small ${pd ? 'txt-warn' : 'muted'}">${pd ? `Antes ${eur(p.price * f)} / ${esc(unitShort(p, l.unit))}` : f !== 1 ? `= ${num(l.qty * f, 3)} ${esc(p.unit)}` : ''}</div></td>
        ${order ? `<td class="num">${l.ordered_qty != null ? num(l.ordered_qty, 3) : '—'}</td>` : ''}
        <td class="num"><input class="qty" type="number" step="any" inputmode="decimal" data-i="${i}" data-k="qty" value="${l.qty}"></td>
        <td>${unitSelect(p, l.unit, `data-i="${i}" data-k="unit"`)}</td>
        <td class="num"><input class="qty" type="number" step="any" inputmode="decimal" data-i="${i}" data-k="price" value="${Math.round(l.price * 10000) / 10000}"></td>
        <td class="num">${eur(l.qty * l.price)}</td><td><button class="sm" data-del="${i}" aria-label="Quitar">✕</button></td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty small">Añade los productos del albarán o escanéalo.</div>';
    $$('#lines [data-k]').forEach((inp) => (inp.onchange = () => {
      const l = lines[inp.dataset.i], p = prodById(l.product_id);
      if (inp.dataset.k === 'unit') { l.unit = inp.value; l.price = unitPrice(p, l.unit); } else l[inp.dataset.k] = Number(inp.value) || 0;
      draw();
    }));
    $$('#lines [data-del]').forEach((b) => (b.onclick = () => { lines.splice(b.dataset.del, 1); draw(); }));
    $$('#lines [data-pick]').forEach((inp) => (inp.onchange = () => {
      const p = prodFromLabel(inp.value); if (!p) return toast('Producto no encontrado. Si es nuevo, créalo en Productos.', true);
      const l = lines[inp.dataset.pick]; l.product_id = p.id; l.unit = defaultBuyUnit(p); l.warn = false; draw();
    }));
    const tot = lines.reduce((s, l) => s + l.qty * l.price, 0);
    $('#tot').textContent = 'Total: ' + eur(tot);
    if ($('#totcheck')) { const dif = tot - prefill.total_read; $('#totcheck').innerHTML = `Base imponible del documento: <b>${eur(prefill.total_read)}</b> · suma de líneas: <b>${eur(tot)}</b> ${Math.abs(dif) > 0.02 * prefill.total_read + 0.05 ? `<span class="txt-warn">(diferencia ${eur(dif)}: revisa)</span>` : '<span class="txt-ok">✓ cuadra</span>'}`; }
  };
  $('#addx').onclick = () => { const p = prodFromLabel($('#extra').value); if (!p) return toast('Producto no encontrado', true); const unit = defaultBuyUnit(p); lines.push({ product_id: p.id, qty: 0, unit, price: unitPrice(p, unit), ordered_qty: null }); $('#extra').value = ''; draw(); };
  $('#save').onclick = (e) => act(e.target, async () => {
    const supplier_id = order ? order.supplier_id : Number($('#sup').value);
    if (!supplier_id) throw new Error('Elige el proveedor');
    if (lines.some((l) => !l.product_id)) throw new Error('Asigna un producto a cada línea o quita las que no controlas');
    const payload = { supplier_id, order_id: order?.id, delivery_note: $('#dn').value, receipt_date: $('#date').value, notes: $('#notes').value, ocr_id: prefill?.ocr_id, supplier_cif: prefill?.supplier_cif,
      lines: lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit: l.unit, price: l.price, ordered_qty: l.ordered_qty, source: l.source })) };
    const r = await api('receipts', { body: payload });
    await reload();
    if (r.price_changes.length) {
      await modal(`<h2>Entrada registrada · ${eur(r.total)}</h2><p>Han cambiado estos precios. Los escandallos ya usan el precio nuevo:</p>
        <table><tbody>${r.price_changes.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${eur(c.old_in ?? c.old)} → <b>${eur(c.new_in ?? c.new)}</b> <span class="small muted">/ ${esc(c.label || c.unit)}</span></td><td class="num ${c.pct > 0 ? 'txt-bad' : 'txt-ok'}">${c.pct === null ? '' : (c.pct > 0 ? '+' : '') + num(c.pct, 1) + ' %'}</td></tr>`).join('')}</tbody></table>
        <div class="actions"><button class="primary" value="ok">Entendido</button></div>`);
    } else toast('Entrada registrada · ' + eur(r.total));
    go('#/recepcion');
  });
  if ($('#newsup')) $('#newsup').onclick = (e) => act(e.target, async () => {
    const r = await api('suppliers', { body: { name: prefill.supplier_name, cif: prefill.supplier_cif } });
    await reload(); prefill.supplier_id = r.id; recepcionNueva(v, null, prefill);
  });
  if (!order && window.ocrSlot) window.ocrSlot(v, (data) => recepcionNueva(v, null, data));
  draw();
}

async function recepcionDetalle(v, id) {
  const r = await api('receipts/' + id);
  v.innerHTML = `<h1>Albarán ${esc(r.delivery_note || '#' + r.id)} · ${esc(r.supplier_name)}</h1><div class="card">
    <div class="small muted">${fdate(r.receipt_date)}${r.order_id ? ` · pedido <a href="#/pedidos/${r.order_id}">#${r.order_id}</a>` : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Producto</th><th class="num">Pedido</th><th class="num">Recibido</th><th class="num">Precio</th><th class="num">Importe</th></tr></thead><tbody>
    ${r.lines.map((l) => { const lab = l.unit_label || l.unit; const iq = l.input_qty ?? l.qty; const ip = l.input_price ?? l.price; return `<tr><td>${esc(l.name)}</td><td class="num">${l.ordered_qty != null ? num(l.ordered_qty, 3) : '—'}</td><td class="num">${num(iq, 3)} ${esc(lab)}${lab !== l.unit ? `<div class="small muted">${num(l.qty, 3)} ${esc(l.unit)}</div>` : ''}</td><td class="num">${eur(ip)}</td><td class="num">${eur(l.qty * l.price)}</td></tr>`; }).join('')}
    </tbody><tfoot><tr><th colspan="4">Total</th><th class="num">${eur(r.total)}</th></tr></tfoot></table></div>
    ${r.notes ? `<p><b>Incidencias:</b> ${esc(r.notes)}</p>` : ''}
    ${can('recepcion.anular') ? '<button class="danger" id="del">Anular albarán</button>' : ''}</div>`;
  if ($('#del')) $('#del').onclick = (e) => act(e.target, async () => {
    if (!(await confirmModal('Se anulará el albarán y se quitará su mercancía del stock. Los precios actualizados no se revierten.', 'Anular'))) return;
    await api('receipts/' + id, { method: 'DELETE' }); await reload(); toast('Albarán anulado'); go('#/recepcion');
  });
}

// ---------- Mermas y consumo de personal ----------
const REASONS = {
  merma: ['Caducado', 'Mal estado', 'Error de elaboración', 'Rotura / caída', 'Devuelto por cliente', 'Sobreproducción', 'Otro'],
  consumo_personal: ['Comida de personal', 'Bebida de personal', 'Invitación', 'Degustación / prueba', 'Otro'],
};
VIEWS.mermas = async (v, _id, q) => {
  let tipo = q.get('tipo') === 'consumo_personal' ? 'consumo_personal' : 'merma';
  let modo = tipo === 'consumo_personal' ? 'plato' : 'producto';
  const from = iso(new Date(Date.now() - 30 * 86400000));
  const list = await api(`movements?types=merma,consumo_personal&from=${from}`);
  v.innerHTML = `<h1>Mermas y consumo de personal</h1>
    <form class="card" id="f">
      <div class="row" style="margin-bottom:12px"><div class="seg" id="tipo"><button type="button" data-v="merma">🗑️ Merma</button><button type="button" data-v="consumo_personal">🍴 Consumo de personal</button></div>
      <div class="seg" id="modo"><button type="button" data-v="producto">Producto</button><button type="button" data-v="plato">Plato</button></div></div>
      <div class="row">
        <div class="field" style="flex:2 1 240px"><label id="lwhat"></label><input id="what" required autocomplete="off"></div>
        <div class="field"><label id="lqty"></label><input id="qty" type="number" step="any" inputmode="decimal" min="0" required></div>
        <div class="field" id="ubox" style="flex:0 1 150px"></div>
      </div>
      <div class="row">
        <div class="field"><label>Motivo</label><select id="reason"></select></div>
        <div class="field"><label>Fecha</label><input type="date" id="date" value="${today()}"></div>
      </div>
      <div class="field"><label>Notas (opcional)</label><input id="notes"></div>
      <div id="preview" class="small muted" style="margin-bottom:10px"></div>
      <button class="primary" style="width:100%">Registrar</button>
    </form>
    <div class="card"><h3>Últimos 30 días</h3>${list.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Qué</th><th>Motivo</th><th>Quién</th>${can('costes.ver') ? '<th class="num">Valor</th>' : ''}<th></th></tr></thead><tbody>
      ${list.map((m) => `<tr><td>${fdate(m.mov_date)}</td><td><span class="pill ${m.type === 'merma' ? 'bad' : 'warn'}">${m.type === 'merma' ? 'Merma' : 'Personal'}</span></td><td>${esc(m.label)}${m.notes ? `<div class="small muted">${esc(m.notes)}</div>` : ''}</td><td>${esc(m.reason || '')}</td><td>${esc(m.user_name || '')}</td>${can('costes.ver') ? `<td class="num">${eur(m.value)}</td>` : ''}
      <td>${can('mermas.borrar') || m.user_id === S.user.id ? `<button class="sm" data-del="${m.id}" aria-label="Borrar">✕</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Nada registrado en los últimos 30 días.</div>'}</div>`;
  const sync = () => {
    $$('#tipo button').forEach((b) => b.classList.toggle('on', b.dataset.v === tipo));
    $$('#modo button').forEach((b) => b.classList.toggle('on', b.dataset.v === modo));
    $('#lwhat').textContent = modo === 'plato' ? 'Plato' : 'Producto';
    $('#lqty').textContent = modo === 'plato' ? 'Raciones' : 'Cantidad';
    $('#what').setAttribute('list', modo === 'plato' ? 'dl-rec' : 'dl-prod');
    $('#what').placeholder = modo === 'plato' ? 'Escribe el plato…' : 'Escribe el producto…';
    $('#reason').innerHTML = REASONS[tipo].map((r) => `<option>${r}</option>`).join('');
    preview();
  };
  let curProd = null;
  const preview = () => {
    const w = $('#what').value, qn = Number($('#qty').value);
    const p = modo === 'plato' ? recFromLabel(w) : prodFromLabel(w);
    if (modo === 'producto' && p !== curProd) {
      curProd = p;
      $('#ubox').innerHTML = p ? `<label>Unidad</label>${unitSelect(p, p.unit, 'id="unit"')}` : '';
      if (p) $('#unit').onchange = preview;
    }
    if (modo === 'plato' && curProd) { curProd = null; $('#ubox').innerHTML = ''; }
    if (!p) { $('#preview').textContent = ''; return; }
    if (modo === 'producto') { const f = unitFactor(p, $('#unit')?.value); $('#preview').textContent = qn ? `= ${num(qn * f, 3)} ${p.unit}${p.price !== undefined ? ' · valor ' + eur(qn * f * p.price) : ''}` : `Se controla en ${p.unit}`; }
    else $('#preview').textContent = p.n_lines ? (p.cost !== undefined && qn ? `Coste estimado ${eur(qn * p.cost)} (descuenta sus ingredientes)` : 'Descuenta los ingredientes de su escandallo') : '⚠️ Este plato aún no tiene escandallo: regístralo por producto.';
  };
  $$('#tipo button').forEach((b) => (b.onclick = () => { tipo = b.dataset.v; sync(); }));
  $$('#modo button').forEach((b) => (b.onclick = () => { modo = b.dataset.v; $('#what').value = ''; sync(); }));
  $('#what').oninput = $('#qty').oninput = preview;
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    act(e.submitter, async () => {
      const w = $('#what').value;
      const body = { type: tipo, qty: Number($('#qty').value), reason: $('#reason').value, notes: $('#notes').value, date: $('#date').value };
      if (modo === 'plato') { const r = recFromLabel(w); if (!r) throw new Error('Plato no encontrado. Elígelo de la lista.'); body.recipe_id = r.id; }
      else { const p = prodFromLabel(w); if (!p) throw new Error('Producto no encontrado. Elígelo de la lista.'); body.product_id = p.id; body.unit = $('#unit')?.value || p.unit; }
      await api('movements', { body });
      toast('Registrado'); go(`#/mermas?tipo=${tipo}&t=${Date.now()}`);
    });
  };
  $$('[data-del]', v).forEach((b) => (b.onclick = () => act(b, async () => {
    if (!(await confirmModal('¿Borrar este registro?', 'Borrar'))) return;
    await api('movements/' + b.dataset.del, { method: 'DELETE' }); toast('Borrado'); route();
  })));
  sync();
};

// ---------- Stock e inventario ----------
VIEWS.stock = async (v, _id, q) => {
  const tab = q.get('tab') || 'stock';
  await reload();
  const tabs = `<div class="tabs">${[['stock', 'Stock actual'], ['inventario', 'Hacer inventario'], ['precios', 'Historial de precios']].map(([k, t]) => `<a href="#/stock?tab=${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>`;
  const cats = [...new Set(S.products.map((p) => p.category || 'Sin categoría'))];

  if (tab === 'precios') {
    const ph = await api('price-history?days=180');
    v.innerHTML = `<h1>Stock e inventario</h1>${tabs}${tableCard('Cambios de precio (últimos 6 meses)', ph, ['Producto', 'Fecha', 'Antes', 'Ahora', 'Cambio'], (r) => { const ch = r.old_price ? ((r.new_price - r.old_price) / r.old_price) * 100 : 0; return [`${esc(r.name)}<div class="small muted">${esc(r.supplier_name || '')}</div>`, fdate(r.created_at), eur(r.old_price), eur(r.new_price), `<span class="${ch > 0 ? 'txt-bad' : 'txt-ok'}">${ch > 0 ? '+' : ''}${num(ch, 1)} %</span>`]; }, 'Sin cambios de precio registrados')}`;
    return;
  }

  if (tab === 'inventario') {
    const invs = await api('inventory');
    v.innerHTML = `<h1>Stock e inventario</h1>${tabs}<div class="card">
      <p class="small muted">Cuenta lo que hay físicamente y apúntalo. Deja en blanco lo que no cuentes. La app compara con el stock teórico y registra la diferencia como descuadre.</p>
      <div class="row"><div class="field"><label>Fecha del recuento</label><input type="date" id="date" value="${today()}"></div><div class="field" style="flex:2 1 240px"><label>Buscar</label><input id="search" placeholder="Filtrar productos…"></div></div>
      ${cats.map((c) => `<h3 style="margin-top:14px">${esc(c)}</h3><div class="table-wrap"><table><tbody>${S.products.filter((p) => (p.category || 'Sin categoría') === c).map((p) => {
        const fm = fmtsOf(p).slice().sort((a, b) => b.factor - a.factor);
        return `<tr data-n="${esc(norm(p.name))}" data-row="${p.id}"><td>${esc(p.name)}<div class="small muted">Teórico ${stockText(p, p.stock)}</div></td>
        <td class="num"><div class="row" style="justify-content:flex-end;gap:6px">${fm.map((f) => `<label class="cnt"><input class="qty" type="number" step="any" inputmode="decimal" min="0" data-f="${f.factor}" data-l="${esc(f.name)}"><span>${esc(f.name)}</span></label>`).join('')}
        <label class="cnt"><input class="qty" type="number" step="any" inputmode="decimal" min="0" data-f="1" data-l="${esc(p.unit)}"><span>${fm.length ? 'sueltos ' : ''}${esc(p.unit)}</span></label></div>
        <div class="small muted" data-total></div></td></tr>`; }).join('')}</tbody></table></div>`).join('') || '<div class="empty">No hay productos.</div>'}
      <div class="field" style="margin-top:12px"><label>Notas</label><input id="notes"></div>
      <div class="sticky-foot row between"><span class="small muted" id="cnt">0 contados</span><button class="primary" id="save">Guardar inventario</button></div></div>
      ${tableCard('Inventarios anteriores', invs, ['Fecha', 'Quién', 'Descuadre'], (i) => [fdate(i.inv_date), esc(i.user_name || ''), `<span class="${i.total_diff_value < 0 ? 'txt-bad' : ''}">${eur(i.total_diff_value)}</span>`], 'Aún no se ha hecho ningún inventario')}`;
    $('#search').oninput = () => { const s = norm($('#search').value); $$('tr[data-n]', v).forEach((tr) => tr.classList.toggle('hidden', s && !tr.dataset.n.includes(s))); };
    const rowCount = (tr) => {
      const ins = $$('input[data-f]', tr).filter((i) => i.value !== '');
      if (!ins.length) return null;
      return { product_id: Number(tr.dataset.row), counted: ins.reduce((s, i) => s + Number(i.value) * Number(i.dataset.f), 0), detail: ins.map((i) => `${num(Number(i.value), 3)} ${i.dataset.l}`).join(' + ') };
    };
    v.addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-row]');
      if (tr) { const c = rowCount(tr), p = prodById(tr.dataset.row); $('[data-total]', tr).textContent = c ? `Total ${num(c.counted, 3)} ${p.unit} · diferencia ${c.counted - p.stock > 0 ? '+' : ''}${num(c.counted - p.stock, 3)}` : ''; }
      $('#cnt').textContent = $$('tr[data-row]', v).filter((t) => rowCount(t)).length + ' contados';
    });
    $('#save').onclick = (e) => act(e.target, async () => {
      const counts = $$('tr[data-row]', v).map(rowCount).filter(Boolean);
      if (!counts.length) throw new Error('No has apuntado ningún recuento');
      const r = await api('inventory', { body: { date: $('#date').value, notes: $('#notes').value, counts } });
      await modal(`<h2>Inventario guardado</h2>${r.diffs.length ? `<p>Descuadre total: <b class="${r.total_diff_value < 0 ? 'txt-bad' : 'txt-ok'}">${eur(r.total_diff_value)}</b> <span class="small muted">(negativo = falta producto)</span></p>
        <div class="table-wrap"><table><thead><tr><th>Producto</th><th class="num">Teórico</th><th class="num">Contado</th><th class="num">Valor</th></tr></thead><tbody>${r.diffs.sort((a, b) => a.value - b.value).map((d) => `<tr><td>${esc(d.name)}${d.detail ? `<div class="small muted">${esc(d.detail)}</div>` : ''}</td><td class="num">${num(d.expected)}</td><td class="num">${num(d.counted)} ${esc(d.unit)}</td><td class="num ${d.value < 0 ? 'txt-bad' : 'txt-ok'}">${eur(d.value)}</td></tr>`).join('')}</tbody></table></div>` : '<p>Todo cuadra con el stock teórico. 👍</p>'}
        <div class="actions"><button class="primary" value="ok">Cerrar</button></div>`);
      go('#/stock?tab=stock');
    });
    return;
  }

  const totalVal = S.products.reduce((s, p) => s + Math.max(p.stock, 0) * (p.price || 0), 0);
  v.innerHTML = `<h1>Stock e inventario</h1>${tabs}<div class="card">
    <div class="row between"><div class="field" style="flex:2 1 240px;margin:0"><input id="search" placeholder="Buscar producto…"></div><b>Valor total: ${eur(totalVal)}</b></div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Producto</th><th>Categoría</th><th class="num">Stock teórico</th><th class="num">Mínimo</th><th class="num">Precio</th><th class="num">Valor</th></tr></thead><tbody>
    ${S.products.map((p) => `<tr data-n="${esc(norm(p.name + ' ' + (p.category || '')))}" class="${p.min_stock > 0 && p.stock < p.min_stock ? 'flag' : ''}"><td>${esc(p.name)}<div class="small muted">${esc(p.supplier_name || '')}</div></td><td>${esc(p.category || '')}</td><td class="num ${p.stock < 0 ? 'txt-bad' : ''}">${stockText(p, p.stock)}</td><td class="num">${num(p.min_stock)}</td><td class="num">${eur(p.price)}</td><td class="num">${eur(Math.max(p.stock, 0) * p.price)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No hay productos</td></tr>'}
    </tbody></table></div>
    <p class="small muted">Stock teórico = entradas − ventas según escandallo − mermas − consumo de personal ± ajustes de inventario. Un stock negativo suele indicar un albarán sin registrar o un escandallo con cantidades bajas.</p></div>`;
  $('#search').oninput = () => { const s = norm($('#search').value); $$('tr[data-n]', v).forEach((tr) => tr.classList.toggle('hidden', s && !tr.dataset.n.includes(s))); };
};

// ---------- Escandallos ----------
VIEWS.escandallos = async (v, id) => {
  if (id) return escandalloEdit(v, id);
  await reload();
  const showCost = can('costes.ver');
  const target = Number(S.settings.food_cost_target) || 30;
  v.innerHTML = `<div class="row between"><h1>Escandallos</h1><div class="row">${can('escandallos.editar') ? '<button id="imp">Importar carta</button><a class="btn primary" href="#/escandallos/nuevo">+ Nuevo plato</a>' : ''}</div></div>
    <div class="card"><div class="field"><input id="search" placeholder="Buscar plato…"></div>
    <div class="table-wrap"><table><thead><tr><th>Plato</th><th>Categoría</th>${showCost ? '<th class="num">Coste ración</th>' : ''}<th class="num">PVP</th>${showCost ? '<th class="num">Food cost</th><th class="num">Margen</th>' : ''}</tr></thead><tbody>
    ${S.recipes.map((r) => { const net = r.pvp / ivaDiv(); const fc = net ? (r.cost / net) * 100 : null;
      return `<tr class="click" data-h="#/escandallos/${r.id}" data-n="${esc(norm(r.name + ' ' + (r.category || '')))}"><td>${esc(r.name)}${r.n_lines ? '' : ' <span class="pill warn">sin escandallo</span>'}</td><td>${esc(r.category || '')}</td>
      ${showCost ? `<td class="num">${r.n_lines ? eur(r.cost) : '—'}</td>` : ''}<td class="num">${eur(r.pvp)}</td>
      ${showCost ? `<td class="num">${r.n_lines && fc !== null ? `<span class="${fc > target + 3 ? 'txt-bad' : fc <= target ? 'txt-ok' : 'txt-warn'}">${pct(fc)}</span>` : '—'}</td><td class="num">${r.n_lines ? eur(net - r.cost) : '—'}</td>` : ''}</tr>`; }).join('') || `<tr><td colspan="6" class="empty">No hay platos. ${can('escandallos.editar') ? 'Importa tu carta de Qamarero o crea el primero.' : ''}</td></tr>`}
    </tbody></table></div>${showCost ? `<p class="small muted">Food cost sobre PVP sin IVA (${num(S.settings.iva_pct)} %). Objetivo: ${num(target)} %. Los costes se recalculan solos con el último precio de compra.</p>` : ''}</div>`;
  bindRowLinks(v);
  $('#search').oninput = () => { const s = norm($('#search').value); $$('tr[data-n]', v).forEach((tr) => tr.classList.toggle('hidden', s && !tr.dataset.n.includes(s))); };
  if ($('#imp')) $('#imp').onclick = () => importWizard({
    title: 'Importar carta (platos y precios)',
    help: 'Exporta desde Qamarero el listado de productos de la carta (Excel o CSV). Se crearán los platos que no existan y se actualizará el PVP de los que sí.',
    cols: [['name', 'Nombre del plato', true], ['pvp', 'Precio de venta (con IVA)', false], ['category', 'Categoría / familia', false]],
    send: async (items) => { const r = await api('recipes/bulk', { body: { items: items.map((i) => ({ ...i, pvp: parseNum(i.pvp) || 0 })) } }); await reload(); return `${r.count} platos importados`; },
  }).then(() => route());
};

async function escandalloEdit(v, id) {
  const isNew = id === 'nuevo';
  const r = isNew ? { name: '', category: '', pvp: 0, portions: 1, notes: '', lines: [] } : await api('recipes/' + id);
  const ro = !can('escandallos.editar');
  const showCost = can('costes.ver');
  // cada línea se edita en la unidad en que se escribió (g, ml, ud, formato…)
  const lines = r.lines.map((l) => ({ product_id: l.product_id, qty: l.input_qty ?? l.qty, unit: l.input_unit || l.unit, waste_pct: l.waste_pct }));
  const target = Number(S.settings.food_cost_target) || 30;
  v.innerHTML = `<h1>${isNew ? 'Nuevo plato' : esc(r.name)}</h1><div class="card">
    <div class="row">
      ${fieldHtml({ name: 'name', label: 'Nombre del plato', required: true, attrs: ro ? 'disabled' : '' }, r.name)}
      ${fieldHtml({ name: 'category', label: 'Categoría', list: 'dl-rcat', attrs: ro ? 'disabled' : '' }, r.category)}
    </div><div class="row">
      ${fieldHtml({ name: 'pvp', label: 'PVP con IVA (€)', type: 'number', attrs: ro ? 'disabled' : '' }, r.pvp)}
      ${fieldHtml({ name: 'portions', label: 'Raciones que salen', type: 'number', help: 'Si la receta es para una olla de 10 raciones, pon 10', attrs: ro ? 'disabled' : '' }, r.portions)}
    </div>
    <h3>Ingredientes</h3>
    <p class="small muted">Escribe la cantidad neta que lleva el plato en la unidad que prefieras (180 g, 40 ml, 1 ud…). El % de merma es lo que se pierde al limpiar o cocinar: la app calcula el peso bruto que sale del stock.</p>
    <div id="lines"></div>
    ${ro ? '' : '<div class="row" style="margin:10px 0"><input list="dl-prod" id="extra" placeholder="Añadir ingrediente…" style="flex:1"><button id="addx">Añadir</button></div>'}
    ${fieldHtml({ name: 'notes', label: 'Elaboración / emplatado', type: 'textarea', attrs: ro ? 'disabled' : '' }, r.notes)}
    ${showCost ? '<div class="grid k" id="sum"></div>' : ''}
    ${ro ? '' : `<div class="sticky-foot row between"><div>${!isNew ? '<button class="danger" id="del">Eliminar plato</button>' : ''}</div><button class="primary" id="save">Guardar escandallo</button></div>`}</div>`;
  const val = (n) => $(`[name="${n}"]`, v).value;
  const draw = () => {
    let total = 0;
    $('#lines').innerHTML = lines.length ? `<div class="table-wrap"><table><thead><tr><th>Ingrediente</th><th class="num">Neto</th><th>Unidad</th><th class="num">Merma %</th><th class="num">Bruto</th>${showCost ? '<th class="num">Coste</th>' : ''}${ro ? '' : '<th></th>'}</tr></thead><tbody>
      ${lines.map((l, i) => { const p = prodById(l.product_id); if (!p) return '';
        const f = unitFactor(p, l.unit), grossIn = l.qty / (1 - Math.min(l.waste_pct || 0, 95) / 100), cost = grossIn * f * (p.price || 0); total += cost;
        return `<tr><td>${esc(p.name)}</td>
        <td class="num">${ro ? num(l.qty, 3) : `<input class="qty" type="number" step="any" inputmode="decimal" data-i="${i}" data-k="qty" value="${l.qty}">`}</td>
        <td>${ro ? esc(unitShort(p, l.unit)) : unitSelect(p, l.unit, `data-i="${i}" data-k="unit"`)}</td>
        <td class="num">${ro ? num(l.waste_pct) : `<input class="qty" type="number" step="any" inputmode="decimal" min="0" max="95" data-i="${i}" data-k="waste_pct" value="${l.waste_pct || 0}">`}</td>
        <td class="num">${num(grossIn, 3)} ${esc(unitShort(p, l.unit))}</td>${showCost ? `<td class="num">${eur(cost)}</td>` : ''}${ro ? '' : `<td><button class="sm" data-del="${i}" aria-label="Quitar">✕</button></td>`}</tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty small">Sin ingredientes todavía.</div>';
    $$('#lines [data-k]').forEach((inp) => (inp.onchange = () => {
      const l = lines[inp.dataset.i];
      if (inp.dataset.k === 'unit') { const p = prodById(l.product_id); l.qty = Math.round(((l.qty * unitFactor(p, l.unit)) / unitFactor(p, inp.value)) * 10000) / 10000; l.unit = inp.value; } // mantiene la misma cantidad real
      else l[inp.dataset.k] = Number(inp.value) || 0;
      draw();
    }));
    $$('#lines [data-del]').forEach((b) => (b.onclick = () => { lines.splice(b.dataset.del, 1); draw(); }));
    if (showCost) {
      const portions = Number(val('portions')) || 1, pvp = Number(val('pvp')) || 0, net = pvp / ivaDiv(), cr = total / portions, fc = net ? (cr / net) * 100 : null;
      $('#sum').innerHTML = kpi('Coste total receta', eur(total), '') + kpi('Coste por ración', eur(cr), '') + kpi('PVP sin IVA', eur(net), '') +
        kpi('Food cost', pct(fc), `Objetivo ${num(target)} %`, fc === null ? '' : fc > target + 3 ? 'bad' : fc <= target ? 'good' : '') +
        kpi('Margen por ración', eur(net - cr), '') + kpi('PVP para objetivo', eur((cr / (target / 100)) * ivaDiv()), 'con IVA');
    }
  };
  if (!ro) {
    $('#addx').onclick = () => { const p = prodFromLabel($('#extra').value); if (!p) return toast('Producto no encontrado. Créalo antes en Productos.', true); lines.push({ product_id: p.id, qty: 0, unit: defaultRecipeUnit(p), waste_pct: 0 }); $('#extra').value = ''; draw(); $$('#lines input[data-k="qty"]').pop()?.focus(); };
    $('[name="pvp"]', v).oninput = $('[name="portions"]', v).oninput = draw;
    $('#save').onclick = (e) => act(e.target, async () => {
      const body = { name: val('name'), category: val('category'), pvp: Number(val('pvp')) || 0, portions: Number(val('portions')) || 1, notes: val('notes'), pos_name: r.pos_name, lines };
      if (!body.name) throw new Error('Pon nombre al plato');
      const res = await api('recipes' + (isNew ? '' : '/' + id), { method: isNew ? 'POST' : 'PUT', body });
      await reload(); toast('Escandallo guardado'); if (isNew) go('#/escandallos/' + res.id); else draw();
    });
    if ($('#del')) $('#del').onclick = (e) => act(e.target, async () => { if (!(await confirmModal(`¿Eliminar "${r.name}"?`, 'Eliminar'))) return; await api('recipes/' + id, { method: 'DELETE' }); await reload(); go('#/escandallos'); });
  }
  draw();
}

// ---------- lector de Excel/CSV ----------
let xlsxLoading;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  const urls = ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'];
  const load = (i) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = urls[i]; s.onload = res; s.onerror = () => (i + 1 < urls.length ? load(i + 1).then(res, rej) : rej(new Error('No se pudo cargar el lector de Excel. Guarda el archivo como CSV y vuelve a intentarlo.'))); document.head.appendChild(s); });
  return (xlsxLoading ||= load(0).catch((e) => { xlsxLoading = null; throw e; }));
}
// Lector CSV propio: detecta ; , o tabulador y respeta comillas
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function readSheet(file) {
  let rows;
  if (/\.(csv|txt)$/i.test(file.name)) {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf); // CSV guardado desde Excel en Windows
    rows = parseCSV(text);
  } else {
    await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  }
  const h = rows.findIndex((r) => r.filter((c) => String(c).trim() !== '').length >= 2);
  if (h < 0) throw new Error('El archivo parece vacío');
  const headers = rows[h].map((c, i) => String(c).trim() || `Columna ${i + 1}`);
  return { headers, data: rows.slice(h + 1).filter((r) => r.some((c) => String(c).trim() !== '')) };
}
function guessCol(headers, words) {
  const i = headers.findIndex((hd) => words.some((w) => norm(hd).includes(w)));
  return i;
}
const COL_GUESS = {
  name: ['producto', 'articulo', 'nombre', 'plato', 'descripcion', 'concepto'], pvp: ['pvp', 'precio'], price: ['precio', 'coste', 'importe'],
  category: ['categoria', 'familia', 'grupo', 'seccion'], units: ['unidades', 'cantidad', 'uds', 'cant', 'vendid'], revenue: ['total', 'importe', 'venta', 'facturado'],
  unit: ['unidad', 'medida', 'formato'], supplier_name: ['proveedor'],
};

// Asistente genérico: subir archivo -> elegir columnas -> enviar
async function importWizard({ title, help, cols, send }) {
  const r = await modal(`<h2>${esc(title)}</h2><p class="small muted">${esc(help)}</p>
    <div class="field"><label>Archivo Excel o CSV</label><input type="file" id="file" accept=".xlsx,.xls,.csv,.txt"></div>
    <div id="map"></div><div class="actions"><button data-close>Cancelar</button><button class="primary" value="ok" id="go" disabled>Importar</button></div>`, {
    onOpen: (f) => {
      $('#file', f).onchange = async () => {
        try {
          const sh = await readSheet($('#file', f).files[0]);
          f._sheet = sh;
          $('#map', f).innerHTML = `<p class="small">${sh.data.length} filas. Indica qué columna es cada dato:</p>` + cols.map(([k, t, req]) => {
            const g = guessCol(sh.headers, COL_GUESS[k] || [k]);
            return `<div class="field"><label>${esc(t)}${req ? '' : ' (opcional)'}</label><select data-col="${k}">${req ? '' : '<option value="-1">— no tengo —</option>'}${sh.headers.map((hd, i) => `<option value="${i}" ${i === g ? 'selected' : ''}>${esc(hd)}</option>`).join('')}</select></div>`;
          }).join('');
          $('#go', f).disabled = false;
        } catch (e) { toast(e.message, true); }
      };
    },
  });
  if (!r) return;
  const f = $('#modal-form');
  const map = Object.fromEntries($$('[data-col]', f).map((s) => [s.dataset.col, Number(s.value)]));
  const items = f._sheet.data.map((row) => Object.fromEntries(Object.entries(map).filter(([, i]) => i >= 0).map(([k, i]) => [k, typeof row[i] === 'string' ? row[i].trim() : row[i]]))).filter((it) => String(it[cols[0][0]] ?? '').trim());
  try { toast(await send(items)); } catch (e) { toast(e.message, true); }
}

// ---------- Ventas Qamarero ----------
VIEWS.ventas = async (v, _id, q) => {
  const tab = q.get('tab') || 'importar';
  const pend = await api('pos-pending');
  const tabs = `<div class="tabs">${[['importar', 'Importar ventas'], ['pendientes', `Pendientes${pend.length ? ` (${pend.length})` : ''}`], ['vinculos', 'Vínculos'], ['historial', 'Historial'], ['automatico', 'Automático']].map(([k, t]) => `<a href="#/ventas?tab=${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>`;
  const head = `<h1>Ventas de Qamarero</h1>${tabs}`;
  const recOpts = (sel) => `<option value="">Elige plato…</option>${S.recipes.map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}`;

  if (tab === 'pendientes') {
    v.innerHTML = head + `<div class="card"><p class="small muted">Nombres que llegaron de Qamarero sin plato asociado. Vincúlalos una vez y las próximas ventas con ese nombre se asignarán solas. Para medias raciones usa factor 0,5.</p>
      ${pend.length ? `<div class="table-wrap"><table><thead><tr><th>Nombre en Qamarero</th><th class="num">Uds</th><th>Plato</th><th class="num">Factor</th><th class="num">PVP variante</th><th></th></tr></thead><tbody>
      ${pend.map((p, i) => `<tr data-i="${i}"><td>${esc(p.pos_name)}<div class="small muted">${fdate(p.date_from)} → ${fdate(p.date_to)}</div></td><td class="num">${num(p.units)}</td>
        <td><select data-k="recipe">${recOpts(recFromLabel(p.pos_name)?.id)}</select></td>
        <td class="num"><input class="qty" type="number" step="any" data-k="factor" value="${halfFactor(p.pos_name)}"></td>
        <td class="num"><input class="qty" type="number" step="any" data-k="pvp" placeholder="opcional"></td>
        <td><div class="row" style="flex-wrap:nowrap"><button class="sm primary" data-ok>Vincular</button><button class="sm" data-ign title="No es comida (p. ej. propina, suplemento)">Ignorar</button></div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No hay nada pendiente. 👍</div>'}</div>`;
    $$('tr[data-i]', v).forEach((tr) => {
      const p = pend[tr.dataset.i];
      $('[data-ok]', tr).onclick = (e) => act(e.target, async () => {
        const recipe_id = Number($('[data-k=recipe]', tr).value);
        if (!recipe_id) throw new Error('Elige el plato');
        await api('pos-pending/resolve', { body: { pos_name: p.pos_name, recipe_id, factor: Number($('[data-k=factor]', tr).value) || 1, pvp: Number($('[data-k=pvp]', tr).value) || null } });
        toast('Vinculado y volcado'); route();
      });
      $('[data-ign]', tr).onclick = (e) => act(e.target, async () => { await api('pos-pending/resolve', { body: { pos_name: p.pos_name, ignore: true } }); route(); });
    });
    return;
  }

  if (tab === 'vinculos') {
    const al = await api('pos-aliases');
    v.innerHTML = head + `<div class="card"><div class="row between"><p class="small muted" style="margin:0">Cómo se traduce cada nombre de Qamarero a un plato con escandallo.</p><button class="primary" id="add">+ Nuevo vínculo</button></div>
      ${al.length ? `<div class="table-wrap"><table><thead><tr><th>Nombre en Qamarero</th><th>Plato</th><th class="num">Factor</th><th class="num">PVP variante</th><th></th></tr></thead><tbody>
      ${al.map((a) => `<tr><td>${esc(a.pos_name)}</td><td>${esc(a.recipe_name || '(plato eliminado)')}</td><td class="num">× ${num(a.factor, 3)}</td><td class="num">${a.pvp ? eur(a.pvp) : '—'}</td><td><button class="sm" data-del="${a.id}">✕</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Aún no hay vínculos. Se crean al importar ventas.</div>'}</div>`;
    $('#add').onclick = async () => {
      const d = await formModal('Nuevo vínculo', [
        { name: 'pos_name', label: 'Nombre exacto en Qamarero', required: true },
        { name: 'recipe_id', label: 'Plato', type: 'select', options: S.recipes.map((r) => [r.id, r.name]), required: true },
        { name: 'factor', label: 'Factor (raciones del plato)', type: 'number', value: 1, help: '0,5 = media ración · 2 = ración doble' },
        { name: 'pvp', label: 'PVP de esta variante con IVA (opcional)', type: 'number' },
      ]);
      if (d) act(null, async () => { await api('pos-aliases', { body: d }); route(); });
    };
    $$('[data-del]', v).forEach((b) => (b.onclick = () => act(b, async () => { await api('pos-aliases/' + b.dataset.del, { method: 'DELETE' }); route(); })));
    return;
  }

  if (tab === 'historial') {
    const imps = await api('sales/imports');
    v.innerHTML = head + tableCard('Volcados de ventas', imps, ['Periodo', 'Origen', 'Platos', 'Ventas sin IVA', ''], (i) => [`${fdate(i.date_from)} → ${fdate(i.date_to)}`, esc(i.filename || ''), num(i.rows, 0), eur(i.revenue), `<button class="sm danger" data-del="${i.id}">Deshacer</button>`], 'Todavía no se han importado ventas');
    $$('[data-del]', v).forEach((b) => (b.onclick = () => act(b, async () => {
      if (!(await confirmModal('Se borrarán esas ventas y su consumo teórico. Podrás volver a importarlas.', 'Deshacer'))) return;
      await api('sales/imports/' + b.dataset.del, { method: 'DELETE' }); toast('Importación deshecha'); route();
    })));
    return;
  }

  if (tab === 'automatico') {
    const endpoint = location.origin + '/api/integrations/sales';
    v.innerHTML = head + `<div class="card"><h2>Volcado automático</h2>
      <p>La app puede recibir las ventas sin que nadie suba archivos. Para ello Qamarero (o un intermediario) tiene que enviar cada día las ventas a esta dirección:</p>
      <p><code style="word-break:break-all">${esc(endpoint)}</code></p>
      <p>Protegida con una clave secreta que se genera aquí. Al generar una nueva, la anterior deja de funcionar.</p>
      <button class="primary" id="gen">Generar clave</button><div id="key" style="margin-top:12px"></div>
      <h3 style="margin-top:20px">Formato que acepta (para el técnico)</h3>
      <pre style="white-space:pre-wrap;background:var(--surface-2);padding:12px;border-radius:9px;font-size:.82rem">POST ${esc(endpoint)}
Authorization: Bearer &lt;clave&gt;
Content-Type: application/json

{ "date": "2026-09-28",
  "source": "Qamarero",
  "rows": [
    { "name": "Calamares", "units": 14, "revenue": 168.00 },
    { "name": "1/2 Calamares", "units": 6, "revenue": 45.00 } ] }</pre>
      <p class="small muted">"revenue" es el importe con IVA (opcional). Los nombres ya vinculados se vuelcan solos; los nuevos quedan en <a href="#/ventas?tab=pendientes">Pendientes</a>.</p></div>`;
    $('#gen').onclick = (e) => act(e.target, async () => {
      if (!(await confirmModal('¿Generar una clave nueva? Si ya había una conectada, dejará de funcionar.', 'Generar'))) return;
      const r = await api('settings/api-key', { body: {} });
      $('#key').innerHTML = `<div class="card" style="background:var(--warn-bg)"><b>Copia esta clave ahora, no se volverá a mostrar:</b><br><code style="word-break:break-all">${esc(r.key)}</code></div>`;
    });
    return;
  }

  // --- importar archivo ---
  v.innerHTML = head + `<div class="card">
    <p class="small muted">Exporta de Qamarero el informe de <b>ventas por producto</b> del periodo (Excel o CSV) y súbelo. Los nombres ya vinculados se asignan solos; los nuevos te los pregunto una vez.</p>
    <div class="row"><div class="field"><label>Desde</label><input type="date" id="from" value="${today()}"></div><div class="field"><label>Hasta</label><input type="date" id="to" value="${today()}"></div></div>
    <div class="field"><label>Archivo</label><input type="file" id="file" accept=".xlsx,.xls,.csv,.txt"></div>
    <div id="cols"></div><div id="res"></div></div>`;
  let sheet = null;
  $('#file').onchange = async () => {
    try {
      sheet = await readSheet($('#file').files[0]);
      const sel = (k, t, opt) => { const g = guessCol(sheet.headers, COL_GUESS[k]); return `<div class="field"><label>${t}</label><select id="c-${k}">${opt ? '<option value="-1">— no tengo —</option>' : ''}${sheet.headers.map((hd, i) => `<option value="${i}" ${i === g ? 'selected' : ''}>${esc(hd)}</option>`).join('')}</select></div>`; };
      $('#cols').innerHTML = `<div class="row">${sel('name', 'Columna del producto')}${sel('units', 'Columna de unidades')}${sel('revenue', 'Columna de importe con IVA', true)}</div><button class="primary" id="analyze">Analizar</button>`;
      $('#analyze').onclick = (e) => act(e.target, analyze);
    } catch (e) { toast(e.message, true); }
  };
  async function analyze() {
    const ci = (k) => Number($('#c-' + k).value);
    const agg = {};
    for (const row of sheet.data) {
      const name = String(row[ci('name')] ?? '').trim();
      const units = parseNum(row[ci('units')]);
      if (!name || !(units > 0)) continue;
      const k = norm(name);
      agg[k] ||= { name, units: 0, revenue: ci('revenue') >= 0 ? 0 : null };
      agg[k].units += units;
      if (ci('revenue') >= 0) agg[k].revenue += parseNum(row[ci('revenue')]) || 0;
    }
    const rows = Object.values(agg);
    if (!rows.length) throw new Error('No encuentro filas con producto y unidades');
    const { matched, pending } = await api('sales/match', { body: { rows } });
    $('#res').innerHTML = `<h3 style="margin-top:18px">Reconocidos (${matched.length})</h3>
      ${matched.length ? `<div class="table-wrap"><table><thead><tr><th>Qamarero</th><th>Plato</th><th class="num">Uds</th><th class="num">Importe</th></tr></thead><tbody>${matched.map((m) => `<tr><td>${esc(m.pos_name)}</td><td>${esc(recById(m.recipe_id)?.name)}${m.factor !== 1 ? ` × ${num(m.factor, 3)}` : ''}</td><td class="num">${num(m.units)}</td><td class="num">${m.revenue != null ? eur(m.revenue) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">Ninguno todavía.</div>'}
      <h3 style="margin-top:18px">Nuevos: asígnalos (${pending.length})</h3>
      ${pending.length ? `<p class="small muted">Elige el plato de cada nombre. Las medias raciones vienen con factor 0,5 propuesto. Lo que dejes sin asignar queda en Pendientes para más tarde. Marca "No es comida" en bebidas sin control, suplementos, etc.</p>
      <div class="table-wrap"><table><thead><tr><th>Qamarero</th><th class="num">Uds</th><th>Plato</th><th class="num">Factor</th><th class="num">PVP variante</th><th>No es comida</th></tr></thead><tbody>
      ${pending.map((p, i) => `<tr data-p="${i}"><td>${esc(p.pos_name)}</td><td class="num">${num(p.units)}</td><td><select data-k="recipe">${recOpts(null)}</select></td><td class="num"><input class="qty" type="number" step="any" data-k="factor" value="${halfFactor(p.pos_name)}"></td><td class="num"><input class="qty" type="number" step="any" data-k="pvp" placeholder="opcional"></td><td><input type="checkbox" data-k="ign" style="width:auto;min-height:0"></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty small">Todo reconocido. 👍</div>'}
      <div class="sticky-foot row between"><span class="small muted">Periodo ${fdate($('#from').value)} → ${fdate($('#to').value)}</span><button class="primary" id="doimp">Volcar ventas</button></div>`;
    $('#doimp').onclick = (e) => act(e.target, async () => {
      const rowsOut = [...matched], left = [];
      $$('tr[data-p]').forEach((tr) => {
        const p = pending[tr.dataset.p];
        if ($('[data-k=ign]', tr).checked) return;
        const rid = Number($('[data-k=recipe]', tr).value);
        if (rid) rowsOut.push({ ...p, recipe_id: rid, factor: Number($('[data-k=factor]', tr).value) || 1, pvp: Number($('[data-k=pvp]', tr).value) || null });
        else left.push(p);
      });
      if (!$('#from').value || !$('#to').value || $('#from').value > $('#to').value) throw new Error('Revisa las fechas del periodo');
      if (!rowsOut.length && !left.length) throw new Error('No hay nada que volcar');
      const body = { date_from: $('#from').value, date_to: $('#to').value, filename: $('#file').files[0]?.name, save_aliases: true, rows: rowsOut, pending: left };
      const r0 = await api('sales/import', { body });
      const r = r0.id ? r0 : null;
      await modal(`<h2>Ventas volcadas</h2>${r ? `<p><b>${eur(r.revenue)}</b> sin IVA en ${r.dishes} ${r.dishes === 1 ? 'plato' : 'platos'}.</p>` : ''}
        ${left.length ? `<p>${left.length} ${left.length === 1 ? 'nombre queda' : 'nombres quedan'} en <b>Pendientes</b>.</p>` : ''}
        ${r?.without_recipe?.length ? `<p class="txt-warn">Sin escandallo (no descuentan stock): ${r.without_recipe.map(esc).join(', ')}</p>` : ''}
        <div class="actions"><button class="primary" value="ok">Cerrar</button></div>`);
      go('#/ventas?tab=historial');
    });
  }
};

// ---------- Gastos fijos ----------
VIEWS.gastos = async (v) => {
  const list = await api('fixed_costs');
  const monthly = (f) => f.amount / (f.frequency === 'anual' ? 12 : f.frequency === 'trimestral' ? 3 : 1);
  const total = list.reduce((s, f) => s + monthly(f), 0);
  v.innerHTML = `<div class="row between"><h1>Gastos fijos</h1><button class="primary" id="add">+ Nuevo gasto</button></div>
    <div class="grid k">${kpi('Total mensual', eur(total), '')}${kpi('Total anual', eur(total * 12), '')}${kpi('Por día', eur(total / 30.4375), 'lo que hay que cubrir cada día abierto o no')}</div>
    <div class="card" style="margin-top:16px">${list.length ? `<div class="table-wrap"><table><thead><tr><th>Concepto</th><th>Categoría</th><th class="num">Importe</th><th>Periodicidad</th><th class="num">Al mes</th></tr></thead><tbody>
    ${list.map((f) => `<tr class="click" data-id="${f.id}"><td>${esc(f.concept)}</td><td>${esc(f.category || '')}</td><td class="num">${eur(f.amount)}</td><td>${f.frequency}</td><td class="num">${eur(monthly(f))}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Añade alquiler, nóminas, seguridad social, suministros, seguros, gestoría, cuotas de software…</div>'}</div>`;
  const F = [
    { name: 'concept', label: 'Concepto', required: true },
    { name: 'category', label: 'Categoría', type: 'select', options: ['Personal', 'Local', 'Suministros', 'Servicios', 'Financiero', 'Marketing', 'Otros'].map((x) => [x, x]) },
    { name: 'amount', label: 'Importe (€)', type: 'number', required: true },
    { name: 'frequency', label: 'Periodicidad', type: 'select', options: [['mensual', 'Mensual'], ['trimestral', 'Trimestral'], ['anual', 'Anual']] },
    { name: 'notes', label: 'Notas' },
  ];
  $('#add').onclick = async () => { const d = await formModal('Nuevo gasto fijo', F); if (d) act(null, async () => { await api('fixed_costs', { body: d }); route(); }); };
  $$('tr[data-id]', v).forEach((tr) => (tr.onclick = async () => {
    const f = list.find((x) => x.id === Number(tr.dataset.id));
    const r = await modal(`<h2>Editar gasto</h2>${F.map((x) => fieldHtml(x, f[x.name])).join('')}<div class="actions"><button class="danger" value="del">Eliminar</button><button data-close>Cancelar</button><button class="primary" value="ok">Guardar</button></div>`);
    if (!r) return;
    act(null, async () => {
      if (r === 'del') await api('fixed_costs/' + f.id, { method: 'DELETE' });
      else await api('fixed_costs/' + f.id, { method: 'PUT', body: Object.fromEntries(F.map((x) => [x.name, x.type === 'number' ? Number($(`[name=${x.name}]`, $('#modal-form')).value) : $(`[name=${x.name}]`, $('#modal-form')).value])) });
      route();
    });
  }));
};

// ---------- Productos ----------
const BASE_UNITS = [['kg', 'kg (se escandalla en g o kg)'], ['l', 'litro (se escandalla en ml, cl o l)'], ['ud', 'unidad (botellas, latas, piezas…)']];
VIEWS.productos = async (v, id) => {
  await reload();
  if (id) return productoEdit(v, id);
  v.innerHTML = `<div class="row between"><h1>Productos</h1><div class="row"><button id="imp">Importar Excel</button><a class="btn primary" href="#/productos/nuevo">+ Nuevo producto</a></div></div>
    <div class="card"><div class="field"><input id="search" placeholder="Buscar…"></div><div class="table-wrap"><table><thead><tr><th>Producto</th><th>Categoría</th><th>Proveedor</th><th>Control</th><th>Formatos</th><th class="num">Precio</th><th class="num">Mínimo</th></tr></thead><tbody>
    ${S.products.map((p) => `<tr class="click" data-h="#/productos/${p.id}" data-n="${esc(norm(p.name + ' ' + (p.category || '') + ' ' + (p.supplier_name || '')))}"><td>${esc(p.name)}</td><td>${esc(p.category || '')}</td><td>${esc(p.supplier_name || '')}</td><td>${esc(p.unit)}</td><td class="small">${fmtsOf(p).map((f) => esc(f.name)).join(', ') || '<span class="muted">—</span>'}</td><td class="num">${eur(p.price)} / ${esc(p.unit)}</td><td class="num">${num(p.min_stock)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Sin productos. Impórtalos desde un Excel con tus tarifas de proveedor o créalos uno a uno.</td></tr>'}
    </tbody></table></div></div>`;
  bindRowLinks(v);
  $('#search').oninput = () => { const s2 = norm($('#search').value); $$('tr[data-n]', v).forEach((tr) => tr.classList.toggle('hidden', s2 && !tr.dataset.n.includes(s2))); };
  $('#imp').onclick = () => importWizard({
    title: 'Importar productos',
    help: 'Sube un Excel o CSV con tus productos (por ejemplo, la tarifa de un proveedor). Los que ya existan con el mismo nombre se actualizan. Si la tarifa trae formato (Caja 24, Saco 25 kg…) indícalo y se crea el formato.',
    cols: [['name', 'Nombre del producto', true], ['unit', 'Unidad de control (kg, l, ud)', false], ['price', 'Precio por unidad sin IVA', false], ['category', 'Categoría', false], ['supplier_name', 'Proveedor', false], ['format_name', 'Nombre del formato (Caja 24…)', false], ['format_factor', 'Unidades que trae el formato', false], ['format_price', 'Precio del formato sin IVA', false]],
    send: async (items) => { const r = await api('products/bulk', { body: { items: items.map((i) => ({ ...i, price: parseNum(i.price) || 0 })) } }); await reload(); return `${r.count} productos importados`; },
  }).then(() => route());
};

async function productoEdit(v, id) {
  const isNew = id === 'nuevo';
  const p = isNew ? { name: '', category: '', unit: 'kg', price: 0, supplier_id: '', min_stock: 0 } : prodById(id);
  if (!p) throw new Error('Producto no encontrado');
  const formats = isNew ? [] : fmtsOf(p).map((f) => ({ ...f }));
  v.innerHTML = `<h1>${isNew ? 'Nuevo producto' : esc(p.name)}</h1><form class="card" id="f">
    <div class="row">${fieldHtml({ name: 'name', label: 'Nombre', required: true, help: 'Si compras la misma bebida en 35 cl y 20 cl, crea un producto para cada tamaño' }, p.name)}
      ${fieldHtml({ name: 'category', label: 'Categoría', list: 'dl-pcat', help: 'Carne, pescado, verdura, bebida, limpieza…' }, p.category)}</div>
    <div class="row">${fieldHtml({ name: 'unit', label: 'Unidad de control', type: 'select', options: BASE_UNITS, help: 'Es la unidad en la que se guarda el stock. Recetas, pedidos e inventarios pueden escribirse en otras (g, ml, cajas…)' }, ['kg', 'l', 'ud'].includes(p.unit) ? p.unit : 'ud')}
      ${fieldHtml({ name: 'supplier_id', label: 'Proveedor habitual', type: 'select', options: [['', '—'], ...S.suppliers.map((x) => [x.id, x.name])] }, p.supplier_id ?? '')}</div>
    <div class="row">${fieldHtml({ name: 'price', label: 'Precio por unidad de control sin IVA (€)', type: 'number', help: 'Se actualiza solo con cada albarán' }, p.price)}
      ${fieldHtml({ name: 'min_stock', label: 'Stock mínimo (en unidad de control)', type: 'number', help: 'Por debajo se avisa para pedir' }, p.min_stock)}</div>
    <h3 style="margin-top:8px">Formatos de compra y recuento</h3>
    <p class="small muted">Cómo te llega o cómo lo cuentas: caja de 24 botellas, saco de 25 kg, garrafa de 5 l, barril de 30 l… Escribe cuántas unidades de control trae cada formato. El marcado como habitual sale por defecto en pedidos y recepción.</p>
    <div id="fmts"></div><button type="button" id="addf" class="sm">+ Añadir formato</button>
    <div class="sticky-foot row between" style="margin-top:14px"><div>${!isNew ? '<button type="button" class="danger" id="del">Eliminar producto</button>' : ''}</div><div class="row"><a class="btn" href="#/productos">Cancelar</a><button class="primary">Guardar</button></div></div></form>`;
  const unitNow = () => $('[name=unit]', v).value;
  const drawF = () => {
    const u = unitNow();
    $('#fmts').innerHTML = formats.length ? `<div class="table-wrap"><table><thead><tr><th>Nombre del formato</th><th class="num">Trae (${esc(u)})</th><th class="num">Precio formato</th><th class="num">Sale a</th><th>Habitual</th><th></th></tr></thead><tbody>
      ${formats.map((f, i) => `<tr><td><input data-i="${i}" data-k="name" value="${esc(f.name)}" placeholder="Caja 24"></td>
        <td class="num"><input class="qty" type="number" step="any" data-i="${i}" data-k="factor" value="${f.factor ?? ''}"></td>
        <td class="num"><input class="qty" type="number" step="any" data-i="${i}" data-k="price" value="${f.price ?? ''}" placeholder="opcional"></td>
        <td class="num small">${f.price > 0 && f.factor > 0 ? eur(f.price / f.factor) + ' / ' + esc(u) : ''}</td>
        <td><input type="radio" name="def" data-i="${i}" ${f.is_default ? 'checked' : ''} style="width:auto;min-height:0"></td>
        <td><button type="button" class="sm" data-del="${i}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">Sin formatos: se compra y se cuenta directamente en ' + esc(u) + '.</div>';
    $$('#fmts input[data-k]').forEach((inp) => (inp.onchange = () => {
      const f = formats[inp.dataset.i];
      f[inp.dataset.k] = inp.dataset.k === 'name' ? inp.value : inp.value === '' ? null : Number(inp.value);
      // si se pone precio al formato habitual y el producto no tiene precio, se deduce el precio unitario
      if (inp.dataset.k !== 'name' && f.price > 0 && f.factor > 0 && (f.is_default || formats.length === 1) && !(Number($('[name=price]', v).value) > 0)) $('[name=price]', v).value = Math.round((f.price / f.factor) * 10000) / 10000;
      drawF();
    }));
    $$('#fmts input[type=radio]').forEach((r) => (r.onchange = () => { formats.forEach((f, i) => (f.is_default = i === Number(r.dataset.i) ? 1 : 0)); }));
    $$('#fmts [data-del]').forEach((b) => (b.onclick = () => { formats.splice(b.dataset.del, 1); drawF(); }));
  };
  $('#addf').onclick = () => { formats.push({ name: '', factor: '', price: null, is_default: formats.length ? 0 : 1 }); drawF(); $$('#fmts input[data-k=name]').pop()?.focus(); };
  $('[name=unit]', v).onchange = drawF;
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    act(e.submitter, async () => {
      const d = Object.fromEntries(new FormData(e.target));
      delete d.def;
      const body = { ...d, price: Number(d.price) || 0, min_stock: Number(d.min_stock) || 0, supplier_id: d.supplier_id ? Number(d.supplier_id) : null,
        formats: formats.filter((f) => String(f.name || '').trim() && Number(f.factor) > 0) };
      if (formats.some((f) => String(f.name || '').trim() && !(Number(f.factor) > 0))) throw new Error('Indica cuántas unidades trae cada formato');
      const r = await api('products' + (isNew ? '' : '/' + id), { method: isNew ? 'POST' : 'PUT', body });
      await reload(); toast('Producto guardado'); go('#/productos');
      void r;
    });
  };
  if ($('#del')) $('#del').onclick = (e) => act(e.target, async () => { if (!(await confirmModal(`¿Eliminar "${p.name}"? Su historial se conserva.`, 'Eliminar'))) return; await api('products/' + id, { method: 'DELETE' }); await reload(); go('#/productos'); });
  drawF();
}

// ---------- Proveedores ----------
VIEWS.proveedores = async (v) => {
  await reload();
  const F = [
    { name: 'name', label: 'Nombre', required: true }, { name: 'contact', label: 'Persona de contacto' },
    { name: 'phone', label: 'Teléfono / WhatsApp', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
    { name: 'order_days', label: 'Días de pedido y reparto', help: 'Ej.: pedir lunes y jueves antes de las 12; reparte al día siguiente' },
    { name: 'notes', label: 'Notas', type: 'textarea' },
  ];
  v.innerHTML = `<div class="row between"><h1>Proveedores</h1><button class="primary" id="add">+ Nuevo proveedor</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Proveedor</th><th>Contacto</th><th>Teléfono</th><th>Días de pedido</th><th class="num">Productos</th></tr></thead><tbody>
    ${S.suppliers.map((s) => `<tr class="click" data-id="${s.id}"><td>${esc(s.name)}</td><td>${esc(s.contact || '')}</td><td>${esc(s.phone || '')}</td><td>${esc(s.order_days || '')}</td><td class="num">${S.products.filter((p) => p.supplier_id === s.id).length}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Sin proveedores.</td></tr>'}
    </tbody></table></div></div>`;
  $('#add').onclick = async () => { const d = await formModal('Nuevo proveedor', F); if (d) act(null, async () => { await api('suppliers', { body: d }); await reload(); route(); }); };
  $$('tr[data-id]', v).forEach((tr) => (tr.onclick = async () => {
    const s = S.suppliers.find((x) => x.id === Number(tr.dataset.id));
    const r = await modal(`<h2>Editar proveedor</h2>${F.map((x) => fieldHtml(x, s[x.name])).join('')}<div class="actions"><button class="danger" value="del">Eliminar</button><button data-close>Cancelar</button><button class="primary" value="ok">Guardar</button></div>`);
    if (!r) return;
    act(null, async () => {
      if (r === 'del') await api('suppliers/' + s.id, { method: 'DELETE' });
      else await api('suppliers/' + s.id, { method: 'PUT', body: Object.fromEntries(F.map((x) => [x.name, $(`[name=${x.name}]`, $('#modal-form')).value])) });
      await reload(); route();
    });
  }));
};

// ---------- gráficas (SVG propio, sin librerías) ----------
const CH = {};
let chN = 0;
function bucketLabel(k, group) {
  if (group === 'month') return new Date(k + '-15T12:00:00').toLocaleDateString('es-ES', { month: 'short', year: '2-digit' });
  const t = new Date(k + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  return group === 'week' ? 'sem. ' + t : t;
}
function niceStep(range) {
  const raw = range / 4, p = 10 ** Math.floor(Math.log10(raw || 1)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
// type: 'bar' (agrupadas), 'stack' (apiladas) o 'line'. series: [{ name, values, color }]
function chart({ labels, group, series, type = 'bar', fmt = eur, ref = null, height = 230, axisFmt }) {
  const id = 'ch' + ++chN;
  const W = 720, H = height, L = 58, R = 12, T = 12, B = 28, pw = W - L - R, ph = H - T - B, n = labels.length || 1;
  const vals = series.flatMap((s) => s.values.filter((x) => x != null));
  const stackTotals = type === 'stack' ? labels.map((_, i) => series.reduce((t, s) => t + Math.max(s.values[i] || 0, 0), 0)) : [];
  let lo = Math.min(0, ...vals, ref ?? 0), hi = Math.max(0, ...(type === 'stack' ? stackTotals : vals), ref ?? 0);
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
  const band = pw / n, xc = (i) => L + band * i + band / 2;
  const af = axisFmt || ((v) => (Math.abs(hi) >= 10000 ? num(v / 1000, 1) + ' k' : num(v, step < 1 ? 2 : step % 1 ? 1 : 0)));
  let g = '';
  for (let v = lo; v <= hi + 1e-9; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid${Math.abs(v) < 1e-9 ? ' zero' : ''}"/><text x="${L - 8}" y="${y(v) + 4}" class="ax" text-anchor="end">${esc(af(v))}</text>`;
  const every = Math.ceil(n / 8);
  labels.forEach((k, i) => { if (i % every === 0) g += `<text x="${xc(i)}" y="${H - 8}" class="ax" text-anchor="middle">${esc(bucketLabel(k, group))}</text>`; });
  const bar = (x, w, v0, v1, color) => {
    const top = Math.min(y(v0), y(v1)), bot = Math.max(y(v0), y(v1)), h = Math.max(bot - top, v1 === v0 ? 0 : 1), r = Math.min(4, w / 2, h);
    if (!h) return '';
    const up = v1 >= v0; // redondeo en el extremo de datos, recto en la base
    return up ? `<path d="M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${top + h} Z" fill="${color}"/>`
      : `<path d="M${x},${top} V${bot - r} Q${x},${bot} ${x + r},${bot} H${x + w - r} Q${x + w},${bot} ${x + w},${bot - r} V${top} Z" fill="${color}"/>`;
  };
  let marks = '';
  if (type === 'line') {
    series.forEach((s) => {
      let d = '', pen = false;
      s.values.forEach((v, i) => { if (v == null || isNaN(v)) { pen = false; return; } d += `${pen ? 'L' : 'M'}${xc(i)},${y(v)} `; pen = true; });
      marks += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      const has = (i) => s.values[i] != null && !isNaN(s.values[i]);
      s.values.forEach((v, i) => { if (has(i) && (n <= 12 || (!has(i - 1) && !has(i + 1)))) marks += `<circle cx="${xc(i)}" cy="${y(v)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`; });
    });
  } else {
    const inner = Math.min(band * 0.72, type === 'stack' ? 34 : 18 * series.length + 2 * (series.length - 1));
    labels.forEach((_, i) => {
      if (type === 'stack') {
        let acc = 0;
        series.forEach((s) => { const v = Math.max(s.values[i] || 0, 0); if (!v) return; marks += bar(xc(i) - inner / 2, inner, acc, acc + v - (acc ? (hi - lo) * 0.004 : 0), s.color); acc += v; });
      } else {
        const w = (inner - 2 * (series.length - 1)) / series.length;
        series.forEach((s, k) => { const v = s.values[i]; if (v == null || !v) return; marks += bar(xc(i) - inner / 2 + k * (w + 2), w, 0, v, typeof s.color === 'function' ? s.color(v) : s.color); });
      }
    });
  }
  if (ref != null) marks += `<line x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}" class="ref"/><text x="${W - R}" y="${y(ref) - 6}" class="ax" text-anchor="end">objetivo ${esc(fmt(ref))}</text>`;
  const hits = labels.map((_, i) => `<rect x="${L + band * i}" y="${T}" width="${band}" height="${ph}" fill="transparent" data-i="${i}"/>`).join('');
  CH[id] = { labels, group, series, fmt, type };
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${typeof s.color === 'function' ? 'var(--s1)' : s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `${legend}<div class="chart" data-ch="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))}">${g}${marks}<line class="xhair" x1="0" x2="0" y1="${T}" y2="${T + ph}" style="display:none"/>${hits}</svg><div class="tip" hidden></div></div>`;
}
function bindCharts(root) {
  $$('.chart', root).forEach((el) => {
    const c = CH[el.dataset.ch], tip = $('.tip', el), svg = $('svg', el), xh = $('.xhair', el);
    const show = (e) => {
      const r = e.target.closest('rect[data-i]'); if (!r) return;
      const i = Number(r.dataset.i);
      tip.innerHTML = `<b>${esc(bucketLabel(c.labels[i], c.group))}</b>` + c.series.map((s) => `<div><i style="background:${typeof s.color === 'function' ? s.color(s.values[i]) : s.color}"></i>${esc(s.name)}: <b>${s.values[i] == null || isNaN(s.values[i]) ? '—' : esc(c.fmt(s.values[i]))}</b></div>`).join('') + (c.type === 'stack' ? `<div>Total: <b>${esc(c.fmt(c.series.reduce((t, s) => t + (s.values[i] || 0), 0)))}</b></div>` : '');
      tip.hidden = false;
      const box = el.getBoundingClientRect(), rr = r.getBoundingClientRect();
      const x = rr.left - box.left + rr.width / 2;
      tip.style.left = Math.min(Math.max(x - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth) + 'px';
      if (c.type === 'line') { const sx = Number(r.getAttribute('x')) + Number(r.getAttribute('width')) / 2; xh.setAttribute('x1', sx); xh.setAttribute('x2', sx); xh.style.display = ''; }
    };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; xh.style.display = 'none'; });
  });
}
// ranking horizontal (proveedores, motivos…)
function hbars(rows, label, value, fmt = eur, limit = 10) {
  const list = rows.filter((r) => Number(r[value]) > 0).slice(0, limit);
  if (!list.length) return '<div class="empty small">Sin datos en el periodo</div>';
  const max = Math.max(...list.map((r) => r[value]));
  const total = rows.reduce((t, r) => t + (Number(r[value]) || 0), 0);
  return `<div class="hbars">${list.map((r) => `<div class="hb"><div class="hb-l">${esc(r[label])}</div><div class="hb-b"><i style="width:${(r[value] / max) * 100}%"></i></div><div class="hb-v">${esc(fmt(r[value]))} <span class="muted">${total ? num((r[value] / total) * 100, 0) + ' %' : ''}</span></div></div>`).join('')}</div>`;
}
const card = (title, body, sub = '') => `<div class="card"><h3>${esc(title)}</h3>${sub ? `<p class="small muted" style="margin-top:-6px">${sub}</p>` : ''}${body}</div>`;

// ---------- Panel de control ----------
const PANEL_TABS = [['resumen', 'Resumen'], ['ventas', 'Ventas'], ['compras', 'Compras'], ['mermas', 'Mermas y personal'], ['foodcost', 'Food cost y platos'], ['caja', 'Caja']];
function periods() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  return {
    semana: ['7 días', iso(new Date(Date.now() - 6 * 86400000)), today()],
    mes: ['Este mes', iso(new Date(y, m, 1)), today()],
    anterior: ['Mes anterior', iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))],
    trimestre: ['3 meses', iso(new Date(y, m - 2, 1)), today()],
    ano: ['Este año', iso(new Date(y, 0, 1)), today()],
  };
}
function periodBar(base, from, to, extra = '') {
  const P = periods(), cur = Object.entries(P).find(([, p]) => p[1] === from && p[2] === to)?.[0];
  return `<div class="row no-print" style="margin-bottom:12px">
    <div class="seg" data-per>${Object.entries(P).map(([k, p]) => `<button type="button" data-k="${k}" class="${cur === k ? 'on' : ''}">${p[0]}</button>`).join('')}</div>
    <input type="date" data-from value="${from}" style="width:auto"><input type="date" data-to value="${to}" style="width:auto">${extra}</div>`;
}
function bindPeriod(v, build) {
  const P = periods();
  $$('[data-per] button', v).forEach((b) => (b.onclick = () => go(build(P[b.dataset.k][1], P[b.dataset.k][2]))));
  $$('[data-from],[data-to]', v).forEach((i) => (i.onchange = () => go(build($('[data-from]', v).value, $('[data-to]', v).value))));
}

VIEWS.panel = async (v, _id, q) => {
  const tab = q.get('tab') || 'resumen';
  const P = periods();
  const from = q.get('from') || P.mes[1], to = q.get('to') || P.mes[2], grp = q.get('group') || '';
  const url = (t, f = from, tt = to, g = grp) => `#/panel?tab=${t}&from=${f}&to=${tt}${g ? '&group=' + g : ''}`;
  const groupSel = tab === 'resumen' ? '' : `<select data-group style="width:auto">${[['', 'Agrupar: automático'], ['day', 'Por día'], ['week', 'Por semana'], ['month', 'Por mes']].map(([k, t]) => `<option value="${k}" ${k === grp ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  const head = `<h1>Panel de control</h1>${periodBar('panel', from, to, groupSel)}
    <div class="tabs no-print">${PANEL_TABS.map(([k, t]) => `<a href="${url(k)}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>`;
  const wire = () => { bindPeriod(v, (f, t) => url(tab, f, t)); const gs = $('[data-group]', v); if (gs) gs.onchange = () => go(url(tab, from, to, gs.value)); bindCharts(v); };
  if (tab === 'resumen') { await panelResumen(v, q, head, from, to); wire(); return; }
  const d = await api(`stats/${tab}?from=${from}&to=${to}${grp ? '&group=' + grp : ''}`);
  const L = { labels: d.labels, group: d.group };
  let body = '';
  if (tab === 'ventas') {
    body = `<div class="grid k">${kpi('Ventas sin IVA (Qamarero)', eur(d.total_revenue), '')}${kpi('Caja real cobrada', eur(d.total_cash), 'con IVA')}${kpi('Comensales', num(d.total_covers, 0), '')}${kpi('Ticket medio', d.avg_ticket ? eur(d.avg_ticket) : '—', 'caja ÷ comensales')}</div>
      ${card('Ventas por ' + ({ day: 'día', week: 'semana', month: 'mes' })[d.group], chart({ ...L, series: [{ name: 'Qamarero (sin IVA)', values: d.revenue, color: 'var(--s1)' }, { name: 'Caja real (sin IVA)', values: d.cash, color: 'var(--s2)' }] }), 'Si las dos barras no coinciden, hay ventas sin pasar por el TPV o cobros sin registrar.')}
      <div class="grid two">${card('Ventas por categoría', hbars(d.categories, 'name', 'value'))}
      ${card('Platos más vendidos', tbl(d.dishes.slice(0, 15), [['Plato', 'name'], ['Raciones', 'units', (x) => num(x, 1)], ['Ventas', 'revenue', eur]], 'Importa ventas de Qamarero para ver este ranking'))}</div>`;
  } else if (tab === 'compras') {
    body = `<div class="grid k">${kpi('Compras del periodo', eur(d.total), 'sin IVA, según albaranes')}${kpi('Proveedores', num(d.suppliers.length, 0), '')}${kpi('Subidas de precio', num(d.prices.filter((x) => x.new_price > x.old_price).length, 0), 'productos que han subido')}</div>
      ${card('Compras por ' + ({ day: 'día', week: 'semana', month: 'mes' })[d.group], chart({ ...L, series: [{ name: 'Compras', values: d.purchases, color: 'var(--s1)' }] }))}
      <div class="grid two">${card('Por proveedor', hbars(d.suppliers, 'name', 'value'))}${card('Por categoría de producto', hbars(d.categories, 'name', 'value'))}</div>
      <div class="grid two">${card('Productos en los que más se gasta', tbl(d.products, [['Producto', 'name'], ['Cantidad', 'qty', (x, r) => num(x, 2) + ' ' + r.unit], ['Precio medio', 'avg_price', eur], ['Importe', 'value', eur]], 'Sin compras'))}
      ${card('Cambios de precio', tbl(d.prices, [['Producto', 'name'], ['Fecha', 'created_at', fdate], ['Antes', 'old_price', eur], ['Ahora', 'new_price', eur], ['Cambio', 'new_price', (x, r) => { const c = r.old_price ? ((x - r.old_price) / r.old_price) * 100 : 0; return `<span class="${c > 0 ? 'txt-bad' : 'txt-ok'}">${c > 0 ? '+' : ''}${num(c, 1)} %</span>`; }]], 'Sin cambios de precio'))}</div>`;
  } else if (tab === 'mermas') {
    const tw = d.waste.reduce((a, b) => a + b, 0), ts = d.staff.reduce((a, b) => a + b, 0);
    body = `<div class="grid k">${kpi('Mermas', eur(tw), '', tw > 0 ? 'bad' : '')}${kpi('Consumo de personal', eur(ts), '')}${kpi('Total', eur(tw + ts), '')}</div>
      ${card('Evolución', chart({ ...L, series: [{ name: 'Mermas', values: d.waste, color: 'var(--s1)' }, { name: 'Personal', values: d.staff, color: 'var(--s2)' }] }))}
      <div class="grid two">${card('Mermas por motivo', hbars(d.reasons.filter((r) => r.type === 'merma'), 'name', 'value'))}${card('Consumo de personal por motivo', hbars(d.reasons.filter((r) => r.type === 'consumo_personal'), 'name', 'value'))}</div>
      <div class="grid two">${card('Productos que más se tiran', tbl(d.products, [['Producto', 'name'], ['Cantidad', 'qty', (x, r) => num(x, 2) + ' ' + r.unit], ['Valor', 'value', eur]], 'Sin mermas'))}
      ${card('Por persona que registra', tbl(d.users, [['Persona', 'name'], ['Registros', 'n', (x) => num(x, 0)], ['Mermas', 'waste', eur], ['Personal', 'staff', eur]], 'Sin registros'), 'Quien más registra no es quien más tira: es quien apunta. Úsalo para ver quién no registra.')}</div>`;
  } else if (tab === 'foodcost') {
    const CL = { estrella: ['ok', 'Estrella', 'Se vende mucho y deja buen margen: cuídalo y destácalo'], vaca: ['warn', 'Caballo de batalla', 'Se vende mucho pero deja poco margen: revisa precio o ración'], puzzle: ['warn', 'Enigma', 'Deja buen margen pero se vende poco: promociónalo o cambia su posición en la carta'], perro: ['bad', 'Perro', 'Se vende poco y deja poco: candidato a salir de la carta'], 'sin ventas': ['', 'Sin ventas', ''] };
    body = `${card('Food cost real y teórico', chart({ ...L, type: 'line', fmt: (x) => pct(x), axisFmt: (x) => num(x, 0) + ' %', ref: d.target, series: [{ name: 'Real (con mermas, personal y descuadres)', values: d.fc_real, color: 'var(--s1)' }, { name: 'Teórico (según escandallos)', values: d.fc_theoretical, color: 'var(--s2)' }] }), 'La distancia entre las dos líneas es dinero que se pierde sin explicación: raciones grandes, producto que desaparece o escandallos desajustados.')}
      ${card('Ingeniería de menú', `<div class="row small" style="margin-bottom:10px">${Object.entries(CL).filter(([k]) => k !== 'sin ventas').map(([, [c, t, h]]) => `<span><span class="pill ${c}">${t}</span> ${esc(h)}</span>`).join('')}</div>` +
        tbl(d.dishes, [['Plato', 'name'], ['Coste', 'cost', eur], ['PVP', 'pvp', eur], ['Food cost', 'fc', (x) => `<span class="${x > d.target + 3 ? 'txt-bad' : x <= d.target ? 'txt-ok' : 'txt-warn'}">${pct(x)}</span>`], ['Margen ud', 'margin', eur], ['Vendidas', 'units', (x) => num(x, 1)], ['Margen total', 'contribution', eur], ['', 'class', (x) => `<span class="pill ${CL[x][0]}">${CL[x][1]}</span>`]], 'No hay platos con escandallo'),
        `Margen medio ponderado por ración: <b>${eur(d.avg_margin)}</b>. Un plato es "popular" si vende al menos el 70 % de la media.`)}`;
  } else if (tab === 'caja') {
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    body = `<div class="grid k">${kpi('Efectivo', eur(sum(d.cash)), '')}${kpi('Tarjeta', eur(sum(d.card)), '')}${kpi('Bizum y otros', eur(sum(d.other)), '')}${kpi('Descuadre acumulado', eur(sum(d.diff)), 'frente al cierre de Qamarero', sum(d.diff) < -1 ? 'bad' : '')}</div>
      ${card('Cobros', chart({ ...L, type: 'stack', series: [{ name: 'Efectivo', values: d.cash, color: 'var(--s1)' }, { name: 'Tarjeta', values: d.card, color: 'var(--s2)' }, { name: 'Bizum y otros', values: d.other, color: 'var(--s3)' }] }))}
      ${card('Descuadre de caja', chart({ ...L, height: 180, series: [{ name: 'Descuadre', values: d.diff, color: (x) => (x < 0 ? 'var(--bad)' : 'var(--ok)') }] }), 'Por debajo de cero falta dinero respecto a lo que marca Qamarero.')}
      ${card('Días', tbl(d.days.slice().reverse(), [['Día', 'day', fdate], ['Efectivo', 'cash', eur], ['Tarjeta', 'card', eur], ['Total', 'total', eur], ['Qamarero', 'pos_total', (x) => (x == null ? '—' : eur(x))], ['Descuadre', 'total', (x, r) => (r.pos_total == null ? '—' : `<span class="${x - r.pos_total < -1 ? 'txt-bad' : ''}">${eur(x - r.pos_total)}</span>`)], ['Comensales', 'covers', (x) => (x ? num(x, 0) : '—')]], 'Sin cajas registradas'))}`;
  }
  v.innerHTML = head + body;
  wire();
};
// tabla sencilla: cols = [[título, campo, formato(valor, fila)]]
function tbl(rows, cols, empty) {
  if (!rows || !rows.length) return `<div class="empty small">${esc(empty)}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${cols.map(([t], i) => `<th class="${i ? 'num' : ''}">${esc(t)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map(([, k, f], i) => `<td class="${i ? 'num' : ''}">${f ? f(r[k], r) : esc(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- Informes ----------
VIEWS.informes = async (v, _id, q) => {
  const list = await api('reports');
  const P = periods();
  const type = q.get('tipo') || 'resultado', from = q.get('from') || P.mes[1], to = q.get('to') || P.mes[2];
  const url = (t, f = from, tt = to) => `#/informes?tipo=${t}&from=${f}&to=${tt}`;
  let r = null, err = '';
  try { r = await api(`reports/${type}?from=${from}&to=${to}`); } catch (e) { err = e.message; }
  const fmtCell = (c, x) => (x == null || x === '' ? '' : c.t === 'eur' ? eur(x) : c.t === 'pct' ? pct(x) : c.t === 'num' ? num(x, 3) : c.t === 'date' ? fdate(x) : String(x));
  v.innerHTML = `<h1 class="no-print">Informes</h1>
    <div class="card no-print"><div class="row"><div class="field" style="flex:2 1 260px"><label>Informe</label><select id="tipo">${Object.entries(list).map(([k, t]) => `<option value="${k}" ${k === type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div></div>
      ${periodBar('informes', from, to)}
      <div class="row"><button class="primary" id="xlsx" ${r ? '' : 'disabled'}>⬇ Descargar Excel</button><button id="csv" ${r ? '' : 'disabled'}>⬇ CSV</button><button id="print" ${r ? '' : 'disabled'}>🖨 Imprimir / PDF</button></div></div>
    ${err ? `<div class="card txt-bad">${esc(err)}</div>` : `<div class="card report">
      <div class="print-only"><b>${esc(r.restaurant)}</b></div>
      <h2>${esc(r.title)}</h2><p class="small muted">Del ${fdate(r.from)} al ${fdate(r.to)} · generado el ${new Date().toLocaleString('es-ES')}</p>
      ${r.rows.length ? `<div class="table-wrap"><table><thead><tr>${r.columns.map((c) => `<th class="${['eur', 'pct', 'num'].includes(c.t) ? 'num' : ''}">${esc(c.l)}</th>`).join('')}</tr></thead><tbody>
        ${r.rows.map((row) => `<tr>${r.columns.map((c) => `<td class="${['eur', 'pct', 'num'].includes(c.t) ? 'num' : ''}">${esc(fmtCell(c, row[c.k]))}</td>`).join('')}</tr>`).join('')}</tbody>
        ${r.total ? `<tfoot><tr>${r.columns.map((c, i) => `<th class="${['eur', 'pct', 'num'].includes(c.t) ? 'num' : ''}">${i === 0 ? 'Total' : esc(fmtCell(c, r.total[c.k]))}</th>`).join('')}</tr></tfoot>` : ''}</table></div>` : '<div class="empty">No hay datos en este periodo.</div>'}</div>`}`;
  $('#tipo').onchange = () => go(url($('#tipo').value));
  bindPeriod(v, (f, t) => url(type, f, t));
  if (!r) return;
  const fname = `${r.title.replace(/[^\wáéíóúñ ]+/gi, '').replace(/\s+/g, '_')}_${r.from}_${r.to}`;
  const aoa = () => [[r.title], [`Del ${r.from} al ${r.to}`], [], r.columns.map((c) => c.l), ...r.rows.map((row) => r.columns.map((c) => (c.t === 'date' ? row[c.k] : row[c.k] ?? ''))), ...(r.total ? [r.columns.map((c, i) => (i === 0 ? 'Total' : r.total[c.k] ?? ''))] : [])];
  const csv = () => {
    const cell = (x) => (typeof x === 'number' ? String(Math.round(x * 10000) / 10000).replace('.', ',') : `"${String(x ?? '').replace(/"/g, '""')}"`);
    const blob = new Blob(['﻿' + aoa().map((row) => row.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#csv').onclick = csv;
  $('#print').onclick = () => window.print();
  $('#xlsx').onclick = (e) => act(e.target, async () => {
    try {
      await loadXLSX();
      const ws = XLSX.utils.aoa_to_sheet(aoa());
      ws['!cols'] = r.columns.map((c) => ({ wch: Math.max(10, c.l.length + 2) }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Informe');
      XLSX.writeFile(wb, fname + '.xlsx');
    } catch { toast('No se pudo generar el Excel; descargo un CSV que Excel abre igual'); csv(); }
  });
};

// ---------- Caja del día ----------
VIEWS.caja = async (v, _id, q) => {
  const day = q.get('dia') || today();
  const full = can('caja.ver');
  const res = await api(`cash?from=${iso(new Date(Date.now() - (full ? 45 : 7) * 86400000))}&to=${today()}`);
  const cur = res.days.find((d) => d.day === day) || { day };
  const F = [['cash', 'Efectivo cobrado'], ['card', 'Tarjeta / datáfono'], ['bizum', 'Bizum / transferencia'], ['other', 'Otros (vales, plataformas…)']];
  v.innerHTML = `<div class="row between"><h1>Caja del día</h1>${full ? `<a class="btn" href="#/panel?tab=caja">📈 Ver estadísticas</a>` : ''}</div>
    <form class="card" id="f">
      <div class="row"><div class="field" style="flex:0 1 200px"><label>Día</label><input type="date" id="day" value="${day}" ${res.min_day ? `min="${res.min_day}"` : ''} max="${today()}"></div>
      ${cur.updated_at ? `<div class="small muted">Registrada por ${esc(cur.user_name || '')} · ${esc(cur.updated_at)}</div>` : ''}</div>
      <div class="row">${F.map(([k, l]) => `<div class="field"><label>${l} (€)</label><input type="number" step="0.01" inputmode="decimal" name="${k}" value="${cur[k] ?? ''}">${k === 'cash' ? '<button type="button" class="sm" id="count" style="margin-top:6px">🪙 Contar billetes y monedas</button>' : ''}</div>`).join('')}</div>
      <div class="row">
        <div class="field"><label>Cierre Z de Qamarero (€ con IVA)</label><input type="number" step="0.01" inputmode="decimal" name="pos_total" value="${cur.pos_total ?? ''}">${cur.qamarero_import ? `<div class="small muted">Ventas importadas de ese día: ${eur(cur.qamarero_import)}</div>` : ''}</div>
        <div class="field"><label>Pagos hechos con dinero de caja (€)</label><input type="number" step="0.01" inputmode="decimal" name="cash_out" value="${cur.cash_out ?? ''}"><div class="small muted">Proveedores, compras de última hora… No se restan del total.</div></div>
        <div class="field"><label>Comensales</label><input type="number" step="1" inputmode="numeric" name="covers" value="${cur.covers ?? ''}"></div>
      </div>
      <div class="field"><label>Notas / incidencias</label><input name="notes" value="${esc(cur.notes || '')}"></div>
      <div class="grid k" id="sum" style="margin-bottom:12px"></div>
      <button class="primary" style="width:100%">Guardar caja</button>
    </form>
    ${card(full ? 'Últimos 45 días' : 'Última semana', tbl(res.days, [['Día', 'day', (x) => `<a href="#/caja?dia=${x}">${fdate(x)}</a>`], ['Total', 'total', eur], ['Qamarero', 'pos_total', (x) => (x == null ? '—' : eur(x))], ['Descuadre', 'total', (x, r) => (r.pos_total == null ? '—' : `<span class="${x - r.pos_total < -1 ? 'txt-bad' : x - r.pos_total > 1 ? 'txt-warn' : 'txt-ok'}">${eur(x - r.pos_total)}</span>`)], ['Comensales', 'covers', (x) => (x ? num(x, 0) : '—')], ['Quién', 'user_name', (x) => esc(x || '')]], 'Todavía no hay cajas registradas'))}`;
  const val = (n) => Number($(`[name=${n}]`, v).value) || 0;
  const summary = () => {
    const total = F.reduce((t, [k]) => t + val(k), 0), pos = $('[name=pos_total]', v).value;
    const diff = pos === '' ? null : total - Number(pos), cov = val('covers');
    $('#sum').innerHTML = kpi('Total cobrado', eur(total), '') + kpi('Descuadre', diff == null ? '—' : eur(diff), diff == null ? 'Anota el cierre de Qamarero' : diff < -1 ? 'Falta dinero' : diff > 1 ? 'Sobra dinero' : 'Cuadra', diff != null && diff < -1 ? 'bad' : diff != null && Math.abs(diff) <= 1 ? 'good' : '') + kpi('Ticket medio', cov ? eur(total / cov) : '—', '');
  };
  v.addEventListener('input', summary);
  $('#day').onchange = () => go('#/caja?dia=' + $('#day').value);
  $('#count').onclick = async () => {
    const D = [500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];
    let fondo = 0; try { fondo = Number(localStorage.getItem('fondo_caja')) || 0; } catch { /* sin almacenamiento */ }
    const r = await modal(`<h2>Contar efectivo</h2><div class="grid" style="grid-template-columns:repeat(3,1fr);gap:8px">${D.map((d) => `<label class="cnt" style="align-items:stretch"><span>${d >= 5 ? d + ' € (billete)' : d >= 1 ? d + ' €' : d * 100 + ' cént.'}</span><input class="qty" type="number" min="0" step="1" inputmode="numeric" data-d="${d}" style="width:100%"></label>`).join('')}</div>
      <div class="field" style="margin-top:12px"><label>Fondo de caja que se deja (€)</label><input type="number" step="0.01" id="fondo" value="${fondo}"></div>
      <p>Contado: <b id="ct">0,00 €</b> · Efectivo del día: <b id="ce">0,00 €</b></p><div class="actions"><button data-close>Cancelar</button><button class="primary" value="ok">Usar este importe</button></div>`, {
      onOpen: (f) => { const upd = () => { const t = $$('[data-d]', f).reduce((s2, i) => s2 + (Number(i.value) || 0) * Number(i.dataset.d), 0); $('#ct', f).textContent = eur(t); $('#ce', f).textContent = eur(t - (Number($('#fondo', f).value) || 0)); f._t = t; }; f.addEventListener('input', upd); },
    });
    if (!r) return;
    const f = $('#modal-form'), fo = Number($('#fondo', f).value) || 0;
    try { localStorage.setItem('fondo_caja', String(fo)); } catch { /* sin almacenamiento */ }
    $('[name=cash]', v).value = Math.round(((f._t || 0) - fo) * 100) / 100; summary();
  };
  $('#f').onsubmit = (e) => { e.preventDefault(); act(e.submitter, async () => { await api('cash/' + $('#day').value, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('Caja guardada'); go(`#/caja?dia=${$('#day').value}&t=${Date.now()}`); }); };
  summary();
};

// ---------- Usuarios y permisos ----------
const PERM_GROUPS = [
  ['Panel e informes', [['panel.ver', 'Ver el panel de control y las estadísticas'], ['informes.ver', 'Sacar informes (Excel / PDF)'], ['costes.ver', 'Ver precios, costes y márgenes']]],
  ['Caja', [['caja.registrar', 'Registrar la caja del día (hasta 7 días atrás)'], ['caja.ver', 'Ver el histórico de caja y los descuadres']]],
  ['Compras', [['pedidos.ver', 'Ver pedidos'], ['pedidos.crear', 'Hacer pedidos a proveedores'], ['recepcion.ver', 'Ver albaranes recibidos'], ['recepcion.crear', 'Recibir mercancía y escanear albaranes'], ['recepcion.anular', 'Anular albaranes']]],
  ['Mermas y personal', [['mermas.registrar', 'Registrar mermas y consumo de personal'], ['mermas.ver_todas', 'Ver los registros de todos (si no, solo los suyos)'], ['mermas.borrar', 'Borrar registros de otros']]],
  ['Stock y cocina', [['stock.ver', 'Ver el stock'], ['inventario.hacer', 'Hacer inventarios'], ['escandallos.ver', 'Ver fichas técnicas (escandallos)'], ['escandallos.editar', 'Crear y cambiar escandallos']]],
  ['Administración', [['productos.editar', 'Productos, formatos y proveedores'], ['ventas.gestionar', 'Importar y vincular ventas de Qamarero'], ['gastos.gestionar', 'Gastos fijos']]],
];
VIEWS.usuarios = async (v, id) => {
  const res = await api('users');
  if (id) return usuarioEdit(v, id, res);
  v.innerHTML = `<div class="row between"><h1>Usuarios y permisos</h1><a class="btn primary" href="#/usuarios/nuevo">+ Nuevo usuario</a></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Usuario</th><th>Acceso</th><th>Estado</th></tr></thead><tbody>
    ${res.users.map((u) => `<tr class="click" data-h="#/usuarios/${u.id}"><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${u.is_super ? '<span class="pill ok">Superusuario</span>' : `${templateName(u.perms, res.templates)} <span class="small muted">· ${u.perms.length} permisos</span>`}</td><td>${u.active ? '<span class="pill ok">activo</span>' : '<span class="pill">baja</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted">El superusuario lo ve y lo puede todo y decide qué puede hacer cada persona. Al resto se le marcan los permisos uno a uno; las plantillas (Sala, Cocina, Dirección) son un punto de partida.</p></div>`;
  bindRowLinks(v);
};
function templateName(perms, T) {
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const k = Object.keys(T).find((t) => same(perms, T[t]));
  return k ? ROLE_NAMES[k] : 'Personalizado';
}
async function usuarioEdit(v, id, res) {
  const isNew = id === 'nuevo';
  const u = isNew ? { name: '', username: '', is_super: false, active: 1, perms: res.templates.sala, role: 'sala' } : res.users.find((x) => x.id === Number(id));
  if (!u) throw new Error('Usuario no encontrado');
  const me = u.id === S.user.id;
  v.innerHTML = `<h1>${isNew ? 'Nuevo usuario' : esc(u.name)}</h1><form class="card" id="f">
    <div class="row">${fieldHtml({ name: 'name', label: 'Nombre', required: true }, u.name)}${fieldHtml({ name: 'username', label: 'Usuario para entrar', required: true, attrs: `autocapitalize="none" ${isNew ? '' : 'disabled'}` }, u.username)}</div>
    <div class="row">${fieldHtml({ name: 'password', label: isNew ? 'Contraseña inicial (mín. 6)' : 'Nueva contraseña (vacío = no cambiar)', attrs: `minlength="6" ${isNew ? 'required' : ''} autocomplete="new-password"` })}
      ${fieldHtml({ name: 'active', label: 'Estado', type: 'select', options: [['1', 'Activo'], ['0', 'De baja (no puede entrar)']], attrs: me ? 'disabled' : '' }, String(u.active))}</div>
    <label class="check"><input type="checkbox" id="super" ${u.is_super ? 'checked' : ''} ${me ? 'disabled' : ''}> <span><b>Superusuario</b> — lo puede todo, incluidos usuarios, permisos y ajustes</span></label>
    <div id="permbox" style="margin-top:14px">
      <div class="row" style="margin-bottom:10px"><span class="small muted">Empezar desde plantilla:</span>${Object.keys(res.templates).map((t) => `<button type="button" class="sm" data-tpl="${t}">${ROLE_NAMES[t]}</button>`).join('')}<button type="button" class="sm" data-tpl="">Ninguno</button></div>
      <div class="grid two">${PERM_GROUPS.map(([g, ps]) => `<div class="permgroup"><h3>${esc(g)}</h3>${ps.map(([k, t]) => `<label class="check"><input type="checkbox" data-p="${k}" ${u.perms.includes(k) ? 'checked' : ''}> <span>${esc(t)}</span></label>`).join('')}</div>`).join('')}</div>
    </div>
    <div class="sticky-foot row between" style="margin-top:14px"><a class="btn" href="#/usuarios">Volver</a><button class="primary">Guardar</button></div></form>`;
  const sync = () => { $('#permbox').style.opacity = $('#super').checked ? 0.4 : 1; $$('[data-p]', v).forEach((c) => (c.disabled = $('#super').checked)); };
  $('#super').onchange = sync;
  $$('[data-tpl]', v).forEach((b) => (b.onclick = () => { const set = b.dataset.tpl ? res.templates[b.dataset.tpl] : []; $$('[data-p]', v).forEach((c) => (c.checked = set.includes(c.dataset.p))); }));
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    act(e.submitter, async () => {
      const fd = Object.fromEntries(new FormData(e.target));
      const perms = $$('[data-p]', v).filter((c) => c.checked).map((c) => c.dataset.p);
      const tpl = Object.keys(res.templates).find((t) => res.templates[t].length === perms.length && res.templates[t].every((x) => perms.includes(x)));
      const body = { name: fd.name, perms, is_super: $('#super').checked, role: $('#super').checked ? 'direccion' : tpl || (perms.includes('panel.ver') ? 'direccion' : perms.includes('pedidos.crear') ? 'cocina' : 'sala') };
      if (fd.password) body.password = fd.password;
      if (!me) body.active = Number(fd.active ?? 1);
      if (isNew) await api('users', { body: { ...body, username: fd.username } });
      else await api('users/' + id, { method: 'PUT', body });
      if (me) await reload();
      toast('Usuario guardado'); go('#/usuarios');
    });
  };
  sync();
}

// ---------- Escáner de albaranes (OCR) en recepción ----------
const blobToB64 = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
async function fileToPayload(file) {
  if (file.type === 'application/pdf') return { media_type: 'application/pdf', data: await blobToB64(file) };
  try {
    const img = await createImageBitmap(file);
    const sc = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return { media_type: 'image/jpeg', data: await blobToB64(blob) };
  } catch {
    if (/^image\/(jpeg|png|webp)$/.test(file.type)) return { media_type: file.type, data: await blobToB64(file) };
    throw new Error('No puedo abrir esa imagen. Haz la foto en JPG o usa un PDF.');
  }
}
window.ocrSlot = async (v, restart) => {
  const slot = $('#ocrslot', v);
  if (!slot || !can('recepcion.crear')) return;
  const st = await api('ocr/status').catch(() => ({}));
  slot.innerHTML = `<div class="scan"><label class="btn primary ${st.provider ? '' : 'disabled'}">📷 Escanear albarán o factura<input type="file" id="scanf" accept="image/*,application/pdf" capture="environment" multiple hidden ${st.provider ? '' : 'disabled'}></label>
    <span class="small muted">${st.provider ? 'Foto con buena luz, recta y entera (puedes subir varias páginas). Si no lo lee bien, rellena o corrige a mano abajo.' : 'El escáner no está activado (ver guía). Mete los datos a mano abajo.'}</span></div>`;
  const inp = $('#scanf', v);
  if (!inp) return;
  inp.onchange = () => act(null, async () => {
    const files = [...inp.files].slice(0, 5);
    if (!files.length) return;
    slot.innerHTML = '<div class="scan"><b>Leyendo el documento…</b> <span class="small muted">suele tardar 10-30 segundos</span></div>';
    try {
      const payload = await Promise.all(files.map(fileToPayload));
      const r = await api('ocr', { body: { files: payload } });
      if (r.failed) { toast(r.message, true); window.ocrSlot(v, restart); $('#extra', v)?.focus(); return; }
      await reload();
      const lines = r.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit: l.unit, price: l.price, source: l.source, printed_unit: l.printed_unit, confidence: l.confidence, warn: l.confidence === 'revisar' || !l.product_id, ordered_qty: null }));
      await restart({ supplier_id: r.supplier_id, supplier_name: r.supplier_name, supplier_cif: r.supplier_cif, delivery_note: r.delivery_note, date: r.date, ocr_id: r.ocr_id, total_read: r.total_without_vat,
        notes: '', lines });
    } catch (e) { toast(e.message, true); window.ocrSlot(v, restart); }
  });
};

// ---------- Ajustes ----------
VIEWS.ajustes = async (v) => {
  v.innerHTML = `<h1>Ajustes</h1><form class="card" id="f">
    ${fieldHtml({ name: 'restaurant_name', label: 'Nombre del restaurante', required: true }, S.settings.restaurant_name)}
    ${fieldHtml({ name: 'iva_pct', label: 'IVA de venta (%)', type: 'number', help: 'Se usa para calcular el food cost sobre precio sin IVA' }, S.settings.iva_pct)}
    ${fieldHtml({ name: 'food_cost_target', label: 'Food cost objetivo (%)', type: 'number' }, S.settings.food_cost_target)}
    <button class="primary">Guardar</button></form>`;
  $('#f').onsubmit = (e) => { e.preventDefault(); act(e.submitter, async () => { await api('settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); await reload(); renderShell(); toast('Ajustes guardados'); }); };
};

boot();
