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
const prodLabel = (p) => `${p.name} (${p.unit})${p.prep_recipe_id ? ' · elaboración' : ''}`;
const prodById = (id) => S.products.find((p) => p.id === Number(id));
const recById = (id) => S.recipes.find((r) => r.id === Number(id));
const prodFromLabel = (v) => S.products.find((p) => prodLabel(p) === v || norm(p.name) === norm(v));
const recFromLabel = (v) => S.recipes.find((r) => norm(r.name) === norm(v));
const ivaDiv = () => 1 + (Number(S.settings.iva_pct) || 0) / 100;

// ---------------- unidades y formatos ----------------
// Unidad base del artículo: kg, l o ud. Se puede escribir en g/ml/cl o en sus formatos (caja, saco, botella…)
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
  // la carta son los platos; las elaboraciones (bechamel, sofrito…) van aparte
  S.allRecipes = d.recipes;
  S.recipes = d.recipes.filter((r) => (r.kind || 'plato') === 'plato');
  S.preps = d.recipes.filter((r) => r.kind === 'elaboracion');
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
    // El aviso de "cerrado" del cuadro anterior llega con retraso: si ya se ha abierto otro (p. ej. "¿Darlo de alta?" → "Nuevo artículo"),
    // no debe cerrar el nuevo. Solo cuenta si el cuadro está de verdad cerrado (Escape).
    dlg.onclose = () => { if (!dlg.open) resolve(null); };
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
  // enlaces de horario sin contraseña
  const pub = location.hash.match(/^#\/h\/([a-z0-9]+)/);
  if (pub) return renderPublic(pub[1]);
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
  { r: 'appcc', t: 'APPCC', i: '🧊', need: ['appcc.registrar', 'appcc.gestionar'] },
  { sep: true },
  { r: 'pedidos', t: 'Pedidos', i: '📝', need: ['pedidos.ver', 'pedidos.crear'] },
  { r: 'recepcion', t: 'Recepción', i: '📦', need: ['recepcion.ver', 'recepcion.crear'] },
  { r: 'mermas', t: 'Mermas y personal', i: '🗑️', need: ['mermas.registrar', 'mermas.ver_todas'] },
  { r: 'stock', t: 'Stock e inventario', i: '📊', need: ['stock.ver', 'inventario.hacer'] },
  { r: 'escandallos', t: 'Carta y escandallos', i: '🍽️', need: ['escandallos.ver', 'escandallos.editar'] },
  { sep: true },
  { r: 'ventas', t: 'Ventas Qamarero', i: '🧾', need: ['ventas.gestionar'] },
  { r: 'gastos', t: 'Gastos fijos', i: '🏷️', need: ['gastos.gestionar'] },
  { r: 'productos', t: 'Existencias', i: '🥕', need: ['productos.editar'] },
  { r: 'proveedores', t: 'Proveedores', i: '🚚', need: ['productos.editar'] },
  { sep: true },
  { r: 'usuarios', t: 'Usuarios y permisos', i: '👥', need: ['super'] },
  { r: 'actividad', t: 'Registro de actividad', i: '🕵️', need: ['super'] },
  { r: 'copias', t: 'Copias de seguridad', i: '💾', need: ['super'] },
  { r: 'ajustes', t: 'Ajustes', i: '⚙️', need: ['super'] },
];
function setAlertBadge(al) {
  const a = $('#side a[data-r="inicio"]'); if (!a) return;
  a.querySelector('.badge-count')?.remove();
  const n = al.filter((x) => x.level !== 'info').length;
  if (n) a.insertAdjacentHTML('beforeend', `<span class="badge-count" title="Avisos">${n}</span>`);
}
const allowed = (n) => (!n.when || n.when()) && (!n.need || !n.need.length || n.need.some((p) => (p === 'super' ? S.user?.is_super : can(p))));
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
  api('alerts').then(setAlertBadge).catch(() => {});
  $('#logout').onclick = async () => { await unsyncPush(); await api('logout', { body: {} }).catch(() => {}); S.user = null; renderLogin(); };
  syncPush();
  route();
}

window.addEventListener('hashchange', () => {
  const pub = location.hash.match(/^#\/h\/([a-z0-9]+)/);
  if (pub) return renderPublic(pub[1]);
  if (S.user) { if (!$('#view')) renderShell(); else route(); }
});

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
      ${kpi('Descuadre de inventario', eur(d.inv_diff), d.inv_diff > 0 ? 'Falta género' : d.inv_diff < 0 ? 'Sobra género' : 'Sin inventarios', d.inv_diff > 0 ? 'bad' : '')}
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
      ${tableCard('Mayores mermas', d.top_waste, ['Artículo', 'Cantidad', 'Valor'], (r) => [esc(r.name), `${num(r.qty)} ${esc(r.unit)}`, eur(r.value)], 'Sin mermas registradas en el periodo')}
      ${tableCard('Cambios de precio (45 días)', d.price_changes, ['Artículo', 'Antes', 'Ahora', ''], (r) => { const ch = r.old_price ? ((r.new_price - r.old_price) / r.old_price) * 100 : 0; return [esc(r.name), eur(r.old_price), eur(r.new_price), `<span class="${ch > 0 ? 'txt-bad' : 'txt-ok'}">${ch > 0 ? '+' : ''}${num(ch, 1)} %</span>`]; }, 'Sin cambios de precio')}
      ${tableCard('Compras por proveedor', d.by_supplier, ['Proveedor', 'Total'], (r) => [esc(r.name), eur(r.total)], 'Sin compras en el periodo')}
      ${tableCard('Platos más vendidos', d.top_dishes, ['Plato', 'Raciones', 'Ventas'], (r) => [esc(r.name), num(r.units, 1), eur(r.revenue)], 'Sin ventas importadas')}
      ${tableCard('Bajo stock mínimo', d.low_stock, ['Artículo', 'Stock', 'Mínimo'], (r) => [esc(r.name), `<span class="txt-bad">${num(r.stock)}</span> ${esc(r.unit)}`, num(r.min_stock)], 'Nada por debajo del mínimo')}
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
    ['appcc.registrar', '#/appcc', '🧊', 'Temperaturas y limpieza'],
    ['turnos.gestionar', '#/turnos', '🗓️', 'Cuadrante de turnos'],
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
  const al = await api('alerts').catch(() => []);
  setAlertBadge(al);
  const alertsCard = al.length ? `<div class="card alerts"><h3>Avisos</h3>${al.map((x) => `<a class="alert ${x.level}" href="${x.link}"><span>${x.icon}</span><span>${esc(x.text)}</span><span class="muted">›</span></a>`).join('')}</div>` : '<div class="card small muted">✓ Sin avisos. Todo en orden.</div>';
  v.innerHTML = `<h1>Hola, ${esc(S.user.name.split(' ')[0])}</h1>${S.me_staff ? '<div id="today-shift"></div>' : ''}<div id="pushc"></div>${alertsCard}
    ${acts.length ? `<div class="quick">${acts.map(([, h, i, t]) => `<a href="${h}"><span>${i}</span>${esc(t)}</a>`).join('')}</div>` : '<div class="card">Todavía no tienes permisos asignados. Pídeselos al responsable.</div>'}
    ${kp}
    ${low.length ? `<div style="margin-top:16px">${tableCard('Bajo stock mínimo', low, ['Artículo', 'Stock', 'Mínimo'], (r) => [esc(r.name), `<span class="txt-bad">${stockText(r, r.stock)}</span>`, `${num(r.min_stock)} ${esc(r.unit)}`], '')}</div>` : ''}`;
  if (S.me_staff) todayShiftCard($('#today-shift'));
  if (S.me_staff || can('pedidos.aprobar') || can('pedidos.crear') || can('turnos.gestionar'))
    pushCard($('#pushc'), S.me_staff ? 'Tu horario cuando se publique o cambie, recordatorio la tarde antes' + (can('pedidos.aprobar') ? ' y los pedidos por aprobar.' : ' y la respuesta a tus pedidos.') : can('pedidos.aprobar') ? 'Te suena el móvil cuando haya un pedido por aprobar.' : 'Te avisamos cuando aprueben o rechacen tus pedidos.');
};

// ---------- Pedidos ----------
const ST_PILL = { borrador: 'pill', pendiente: 'pill bad', enviado: 'pill warn', recibido: 'pill ok', cancelado: 'pill bad' };
const ST_NAME = { borrador: 'borrador', pendiente: 'pendiente de aprobar', enviado: 'enviado', recibido: 'recibido', cancelado: 'cancelado' };
const waLink = (phone, text) => { const d = String(phone || '').replace(/\D/g, ''); return d ? `https://wa.me/${d.length === 9 ? '34' + d : d}?text=${encodeURIComponent(text)}` : null; };
// avisar a quien aprueba: WhatsApp o email con el enlace al pedido, en un toque
async function notifyApprovers(o, approvers) {
  const link = `${location.origin}/#/pedidos/${o.id}`;
  const text = `Hola {n}, hay un pedido para aprobar en ${S.settings.restaurant_name}: #${o.id} a ${o.supplier_name} (${o.n} artículos${o.total ? ', ' + eur(o.total) : ''}), hecho por ${S.user.name}.\nRevísalo aquí: ${link}`;
  await modal(`<h2>Pedido enviado a aprobación</h2><p>Avisa a quien lo aprueba para que lo revise y lo envíe al proveedor:</p>
    ${approvers.length ? approvers.map((a) => { const t = text.replace('{n}', a.name.split(' ')[0]); const wa = waLink(a.phone, t);
      return `<div class="row between task"><b>${esc(a.name)}</b><div class="row">${wa ? `<a class="btn primary" target="_blank" rel="noopener" href="${wa}">WhatsApp</a>` : ''}${a.email ? `<a class="btn" href="mailto:${esc(a.email)}?subject=${encodeURIComponent(`Pedido #${o.id} para aprobar`)}&body=${encodeURIComponent(t)}">Email</a>` : ''}${!wa && !a.email ? '<span class="small muted">sin teléfono ni email (añádelos en Usuarios)</span>' : ''}</div></div>`; }).join('')
      : '<p class="small muted">No hay nadie más con permiso para aprobar pedidos. El superusuario puede darlo en Usuarios y permisos.</p>'}
    <p class="small muted">También le aparecerá en sus avisos al entrar en la app.</p><div class="actions"><button class="primary" value="ok">Hecho</button></div>`);
}
VIEWS.pedidos = async (v, id, q) => {
  if (id === 'nuevo') return pedidoNuevo(v);
  if (id && q?.get('editar')) { await reload(); const o = await api('orders/' + id); if (!o.can_edit) throw new Error('Este pedido ya no se puede cambiar'); return pedidoNuevo(v, o); }
  if (id) return pedidoDetalle(v, id, q);
  const list = await api('orders');
  v.innerHTML = `<div class="row between"><h1>Pedidos a proveedores</h1><a class="btn primary" href="#/pedidos/nuevo">+ Nuevo pedido</a></div>
    <div class="card">${list.length ? `<div class="table-wrap"><table><thead><tr><th>Nº</th><th>Fecha</th><th>Proveedor</th><th>Estado</th><th class="num">Líneas</th><th class="num">Importe est.</th></tr></thead><tbody>
    ${list.map((o) => `<tr class="click" data-h="#/pedidos/${o.id}"><td>#${o.id}</td><td>${fdate(o.order_date)}</td><td>${esc(o.supplier_name)}</td><td><span class="${ST_PILL[o.status]}">${ST_NAME[o.status] || o.status}</span></td><td class="num">${o.n_lines}</td><td class="num">${eur(o.total)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Todavía no hay pedidos.</div>'}</div>`;
  bindRowLinks(v);
};
const bindRowLinks = (el) => $$('tr[data-h]', el).forEach((tr) => (tr.onclick = () => go(tr.dataset.h)));

async function pedidoNuevo(v, existing) {
  if (!S.suppliers.length) { v.innerHTML = `<div class="card">Primero da de alta proveedores y artículos. <a href="#/proveedores">Ir a proveedores →</a></div>`; return; }
  const lines = {}; // product_id -> { qty, unit }
  if (existing) existing.lines.forEach((l) => (lines[l.product_id] = { qty: l.input_qty ?? l.qty, unit: l.input_unit || l.unit }));
  const approver = can('pedidos.aprobar');
  v.innerHTML = `<h1>${existing ? `Editar pedido #${existing.id}` : 'Nuevo pedido'}</h1><div class="card">
    <div class="row"><div class="field"><label>Proveedor</label><select id="sup"><option value="">Elige proveedor…</option>${S.suppliers.map((s) => `<option value="${s.id}" ${existing?.supplier_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Entrega prevista</label><input type="date" id="exp" value="${esc(existing?.expected_date || '')}"></div></div>
    <div id="sinfo" class="small muted"></div>
    <div class="row bulkbar" id="sugbar" style="display:none"><b>✨ Pedido sugerido</b><span class="row">cubrir <input id="sdays" type="number" min="1" max="30" value="3" style="width:70px"> días</span><button type="button" id="sugg">Calcular</button><span class="small muted" id="sugnote"></span></div>
    <div id="plist"></div>
    <div class="row" style="margin:10px 0"><input list="dl-prod" id="extra" placeholder="Añadir otro artículo…" style="flex:1"><button id="addx">Añadir</button></div>
    <div class="field"><label>Notas para el proveedor</label><textarea id="notes">${esc(existing?.notes || '')}</textarea></div>
    <div class="sticky-foot row between"><b id="tot"></b><div class="row">${existing ? `<a class="btn" href="#/pedidos/${existing.id}">Cancelar</a>` : ''}<button id="draft">Guardar borrador</button>
      ${approver ? '<button class="primary" id="send">Aprobar y enviar al proveedor</button>' : '<button class="primary" id="send">Enviar a aprobación</button>'}</div></div></div>`;
  const draw = () => {
    const sid = Number($('#sup').value);
    const s = S.suppliers.find((x) => x.id === sid);
    $('#sinfo').textContent = s ? [s.order_days && `Días de pedido: ${s.order_days}`, s.phone, s.email].filter(Boolean).join(' · ') : '';
    const prods = S.products.filter((p) => p.supplier_id === sid || lines[p.id]);
    $('#plist').innerHTML = !sid ? '' : prods.length ? `<div class="table-wrap"><table><thead><tr><th>Artículo</th><th class="num">Stock</th><th class="num">Mínimo</th><th class="num">Pedir</th><th>Formato</th></tr></thead><tbody>
      ${prods.map((p) => { const l = lines[p.id] || { qty: '', unit: defaultBuyUnit(p) }; const low = p.min_stock > 0 && p.stock < p.min_stock;
        const sug = low ? Math.ceil(((p.min_stock - p.stock) / unitFactor(p, l.unit)) * 10) / 10 : '';
        return `<tr class="${low ? 'flag' : ''}"><td>${esc(p.name)}<div class="small muted">${esc(p.category || '')}${p.price ? ' · ' + eur(unitPrice(p, l.unit)) + ' / ' + esc(unitShort(p, l.unit)) : ''}</div></td><td class="num">${stockText(p, p.stock)}</td><td class="num">${num(p.min_stock)}</td>
        <td class="num"><input class="qty" type="number" step="any" inputmode="decimal" min="0" data-p="${p.id}" value="${l.qty}" placeholder="${sug ? num(sug, 1) : ''}"></td>
        <td>${unitSelect(p, l.unit, `data-u="${p.id}"`)}</td></tr>`; }).join('')}
      </tbody></table></div><div class="small muted">Resaltado: por debajo del mínimo (la sugerencia aparece en gris).</div>` : '<div class="empty small">Este proveedor no tiene artículos asignados. Añádelos abajo o en Existencias.</div>';
    $$('#plist input[data-p]').forEach((i) => (i.oninput = () => { const p = prodById(i.dataset.p); lines[p.id] = { qty: i.value === '' ? '' : Number(i.value), unit: $(`[data-u="${p.id}"]`).value }; total(); }));
    $$('#plist select[data-u]').forEach((sel) => (sel.onchange = () => { const pidv = sel.dataset.u; lines[pidv] = { qty: lines[pidv]?.qty ?? '', unit: sel.value }; draw(); }));
    total();
  };
  const total = () => { const t = Object.entries(lines).reduce((s, [pidv, l]) => { const p = prodById(pidv); return s + (Number(l.qty) || 0) * (p ? unitPrice(p, l.unit) : 0); }, 0); $('#tot').textContent = t ? 'Estimado: ' + eur(t) : ''; };
  $('#sup').onchange = () => { $('#sugbar').style.display = $('#sup').value ? '' : 'none'; draw(); };
  $('#sugg').onclick = (e) => act(e.target, async () => {
    const r = await api(`orders/suggest?supplier_id=${$('#sup').value}&days=${$('#sdays').value}`);
    let n = 0;
    r.lines.forEach((l) => { if (l.qty > 0) { lines[l.product_id] = { qty: l.qty, unit: l.unit }; n++; } else if (lines[l.product_id] && !lines[l.product_id].qty) delete lines[l.product_id]; });
    $('#sugnote').textContent = n ? `${n === 1 ? '1 artículo propuesto' : n + ' artículos propuestos'} según el consumo de las últimas 4 semanas${r.weekday_factor > 1.05 ? ' (incluye días fuertes: +' + Math.round((r.weekday_factor - 1) * 100) + ' %)' : ''}, el stock actual y el mínimo. Revísalo antes de enviar.` : 'Con el stock actual no hace falta pedir nada para esos días.';
    draw();
  });
  $('#addx').onclick = () => { const p = prodFromLabel($('#extra').value); if (!p) return toast('Artículo no encontrado', true); lines[p.id] = lines[p.id] || { qty: '', unit: defaultBuyUnit(p) }; $('#extra').value = ''; draw(); };
  const save = (status, btn) => act(btn, async () => {
    const payload = { supplier_id: Number($('#sup').value), status, expected_date: $('#exp').value || null, notes: $('#notes').value,
      lines: Object.entries(lines).filter(([, l]) => Number(l.qty) > 0).map(([product_id, l]) => ({ product_id: Number(product_id), qty: Number(l.qty), unit: l.unit })) };
    if (!payload.supplier_id) throw new Error('Elige un proveedor');
    if (!payload.lines.length) throw new Error('Indica al menos una cantidad');
    const r = await api('orders' + (existing ? '/' + existing.id : ''), { method: existing ? 'PUT' : 'POST', body: payload });
    if (r.status === 'pendiente') {
      const sup = S.suppliers.find((x) => x.id === payload.supplier_id);
      const total = payload.lines.reduce((t, l) => t + l.qty * unitPrice(prodById(l.product_id), l.unit), 0);
      await notifyApprovers({ id: r.id, supplier_name: sup?.name || '', n: payload.lines.length, total }, r.approvers);
    } else toast(r.status === 'enviado' ? 'Pedido aprobado: envíalo al proveedor' : 'Borrador guardado');
    go('#/pedidos/' + r.id + (r.status === 'enviado' ? '?enviar=1' : ''));
  });
  $('#draft').onclick = (e) => save('borrador', e.target);
  $('#send').onclick = (e) => save(approver ? 'enviado' : 'pendiente', e.target);
  if (existing) { $('#sugbar').style.display = ''; draw(); }
}

async function pedidoDetalle(v, id, q) {
  const o = await api('orders/' + id);
  const total = o.lines.reduce((s, l) => s + l.qty * (l.price || 0), 0);
  const text = `Hola${o.contact ? ' ' + o.contact : ''}, pedido de ${S.settings.restaurant_name}${o.expected_date ? ' para el ' + fdate(o.expected_date) : ''}:\n` + o.lines.map((l) => `- ${num(l.input_qty ?? l.qty, 3)} ${l.unit_label || l.unit} ${l.name}`).join('\n') + (o.notes ? `\n\n${o.notes}` : '') + '\n\nGracias.';
  const phone = String(o.phone || '').replace(/\D/g, '');
  const pend = o.status === 'pendiente';
  v.innerHTML = `<div class="row between"><h1>Pedido #${o.id} · ${esc(o.supplier_name)}</h1><span class="${ST_PILL[o.status]}">${ST_NAME[o.status] || o.status}</span></div>
    ${pend && o.can_approve ? `<div class="card" style="border-color:var(--bad)"><b>Pendiente de tu aprobación.</b> Revísalo: puedes cambiar cantidades o artículos, o aprobarlo tal cual y enviarlo al proveedor.
      <div class="row" style="margin-top:10px"><button class="primary" id="approve">✓ Aprobar y enviar al proveedor</button><a class="btn" href="#/pedidos/${o.id}?editar=1">✏️ Modificar</a><button class="danger" id="reject">Rechazar</button></div></div>` : ''}
    ${pend && !o.can_approve ? `<div class="card" style="border-color:var(--accent)">Esperando aprobación. <button class="sm" id="renotify">Volver a avisar</button></div>` : ''}
    ${o.status === 'enviado' && q?.get('enviar') ? `<div class="card" style="border-color:var(--ok)"><b>Pedido aprobado.</b> Envíaselo ahora al proveedor con los botones de abajo.</div>` : ''}
    <div class="card"><div class="small muted">Hecho el ${fdate(o.order_date)}${o.user_name ? ' por ' + esc(o.user_name) : ''}${o.approved_by_name ? ' · aprobado por ' + esc(o.approved_by_name) : ''}${o.expected_date ? ' · entrega prevista ' + fdate(o.expected_date) : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Artículo</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Importe</th></tr></thead><tbody>
    ${o.lines.map((l) => { const iq = l.input_qty ?? l.qty; return `<tr><td>${esc(l.name)}</td><td class="num">${num(iq, 3)} ${esc(l.unit_label || l.unit)}${l.unit_label && l.unit_label !== l.unit ? `<div class="small muted">${num(l.qty, 3)} ${esc(l.unit)}</div>` : ''}</td><td class="num">${eur(iq ? (l.qty * (l.price || 0)) / iq : 0)}</td><td class="num">${eur(l.qty * (l.price || 0))}</td></tr>`; }).join('')}
    </tbody><tfoot><tr><th colspan="3">Total estimado</th><th class="num">${eur(total)}</th></tr></tfoot></table></div>
    ${o.notes ? `<p><b>Notas:</b> ${esc(o.notes)}</p>` : ''}
    <div class="row" style="margin-top:12px">
      ${o.status === 'enviado' ? `<a class="btn primary" href="#/recepcion/nueva?pedido=${o.id}">📦 Recibir mercancía</a>` : ''}
      ${o.status === 'enviado' || o.status === 'recibido' ? `<button id="copy">Copiar texto</button>
      ${phone ? `<a class="btn ${q?.get('enviar') ? 'primary' : ''}" target="_blank" rel="noopener" href="https://wa.me/${phone.length === 9 ? '34' + phone : phone}?text=${encodeURIComponent(text)}">Enviar al proveedor por WhatsApp</a>` : ''}
      ${o.email ? `<a class="btn" href="mailto:${esc(o.email)}?subject=${encodeURIComponent('Pedido ' + S.settings.restaurant_name)}&body=${encodeURIComponent(text)}">Enviar al proveedor por email</a>` : ''}
      ${!phone && !o.email ? '<span class="small muted">El proveedor no tiene teléfono ni email: copia el texto o añádelos en Proveedores.</span>' : ''}` : ''}
      ${o.can_edit && !pend ? `<a class="btn" href="#/pedidos/${o.id}?editar=1">✏️ Modificar</a>` : ''}
      ${o.status === 'borrador' ? `<button data-st="${o.can_approve ? 'enviado' : 'pendiente'}">${o.can_approve ? 'Aprobar y enviar' : 'Enviar a aprobación'}</button>` : ''}
      ${o.status !== 'recibido' && o.status !== 'cancelado' && !(pend && o.can_approve) && (o.can_approve || o.can_edit) ? '<button class="danger" data-st="cancelado">Cancelar pedido</button>' : ''}
    </div></div>`;
  if ($('#copy')) $('#copy').onclick = () => navigator.clipboard.writeText(text).then(() => toast('Texto copiado'));
  const setStatus = async (status, reason) => {
    const r = await api(`orders/${id}/status`, { method: 'PUT', body: { status, reason } });
    if (status === 'pendiente') await notifyApprovers({ id: o.id, supplier_name: o.supplier_name, n: o.lines.length, total }, r.approvers);
    go(`#/pedidos/${id}${status === 'enviado' ? '?enviar=1' : '?t=' + Date.now()}`);
  };
  $$('[data-st]', v).forEach((b) => (b.onclick = () => act(b, () => setStatus(b.dataset.st))));
  if ($('#approve')) $('#approve').onclick = (e) => act(e.target, () => setStatus('enviado'));
  if ($('#reject')) $('#reject').onclick = (e) => act(e.target, async () => {
    const r = await modal(`<h2>Rechazar pedido #${o.id}</h2><div class="field"><label>Motivo (lo verá quien lo hizo)</label><input id="why" placeholder="p. ej. ya hay género suficiente, pedir el jueves"></div><div class="actions"><button data-close>Volver</button><button class="primary danger" value="ok">Rechazar</button></div>`);
    if (r) await setStatus('cancelado', $('#why', $('#modal-form')).value);
  });
  if ($('#renotify')) $('#renotify').onclick = (e) => act(e.target, async () => notifyApprovers({ id: o.id, supplier_name: o.supplier_name, n: o.lines.length, total }, await api('orders/approvers')));
}

// ---------- Alta rápida de artículos (desde recepción) ----------
const titleCase = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/(^|\s|\()(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
// Deduce unidad de control y formato a partir de lo impreso en el albarán ("KG", "CAJA 24", "PACK 6"…)
function guessArticle(line) {
  const desc = String(line.description || line.source || '').trim();
  const u = norm(line.printed_unit || '');
  const m = desc.match(/\b(caja|cj|cja|pack|paq|paquete|bandeja|bdj|saco|fardo|garrafa|barril)\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*(kg|kgs|l|lt|lts|litros?|uds?|unidades|u)?\b/i);
  let unit = /^(kg|kgs|kilo|kilos|g|gr|grs)$/.test(u) ? 'kg' : /^(l|lt|lts|litro|litros|ml|cl)$/.test(u) ? 'l' : 'ud';
  let format = null;
  if (m) {
    const size = Number(m[2].replace(',', '.'));
    const inner = norm(m[3] || '');
    unit = /^kg/.test(inner) ? 'kg' : /^l/.test(inner) ? 'l' : 'ud';
    format = { name: `${titleCase(m[1])} ${m[2]}${m[3] && unit !== 'ud' ? ' ' + unit : ''}`, factor: size };
  } else if (/^(saco|sac)$/.test(u)) { unit = 'kg'; format = { name: 'Saco', factor: '' }; }
  const name = titleCase(desc.replace(/^\s*[A-Z0-9-]{2,}\s+(?=\D)/, '')).slice(0, 80);
  return { name, unit, format };
}
async function newArticleModal(line, supplier_id) {
  const g = guessArticle(line);
  const r = await modal(`<h2>Nuevo artículo</h2>
    ${line.source ? `<p class="small muted">En el documento: <b>${esc(line.source)}</b> · ${num(line.qty, 3)} ${esc(line.printed_unit || '')} · ${eur(line.price)}</p>` : ''}
    ${fieldHtml({ name: 'name', label: 'Nombre', required: true }, g.name)}
    <div class="row">${fieldHtml({ name: 'category', label: 'Categoría', list: 'dl-pcat' })}
    ${fieldHtml({ name: 'unit', label: 'Se controla en', type: 'select', options: BASE_UNITS }, g.unit)}</div>
    <div class="row">${fieldHtml({ name: 'fname', label: 'Formato en que llega (opcional)', help: 'Caja 24, Saco 25 kg, Barril 30 l… Vacío si llega por kilos o unidades sueltas' }, g.format?.name || '')}
    ${fieldHtml({ name: 'ffactor', label: 'Cuántas unidades de control trae', type: 'number' }, g.format?.factor || '')}</div>
    <div class="actions"><button data-close>Cancelar</button><button class="primary" value="ok">Crear y usar</button></div>`);
  if (!r) return null;
  const f = $('#modal-form'), val = (n) => $(`[name=${n}]`, f).value.trim();
  const fname = val('fname'), factor = Number(val('ffactor'));
  if (fname && !(factor > 0)) throw new Error('Indica cuántas unidades trae el formato');
  const inFormat = fname && factor > 0;
  const price = Number(line.price) || 0;
  const body = { name: val('name'), category: val('category') || null, unit: val('unit'), supplier_id: supplier_id || null, from_receipt: true,
    price: inFormat ? Math.round((price / factor) * 10000) / 10000 : price,
    formats: inFormat ? [{ name: fname, factor, price: price || null, is_default: 1 }] : [] };
  const res = await api('products', { body });
  await reload();
  if (res.existing) toast(`"${body.name}" ya estaba en Existencias: se usa ese artículo`);
  const fmt = inFormat && S.formats.find((x) => x.product_id === res.id && norm(x.name) === norm(fname));
  const p = prodById(res.id);
  return { product_id: res.id, unit: fmt ? 'f:' + fmt.id : p && p.unit !== body.unit ? defaultBuyUnit(p) : body.unit };
}

// ---------- Recepción ----------
VIEWS.recepcion = async (v, id, q) => {
  if (id === 'nueva') return recepcionNueva(v, q.get('pedido'));
  if (id) return recepcionDetalle(v, id);
  const [list, orders] = await Promise.all([api('receipts'), api('orders')]);
  const pend = orders.filter((o) => o.status === 'enviado');
  v.innerHTML = `<div class="row between"><h1>Recepción de mercancía</h1><div class="row"><button id="impfac">Importar facturas (Excel)</button><a class="btn primary" href="#/recepcion/nueva">+ Recibir sin pedido</a></div></div>
    ${pend.length ? `<div class="card"><h3>Pedidos pendientes de recibir</h3><div class="table-wrap"><table><tbody>${pend.map((o) => `<tr class="click" data-h="#/recepcion/nueva?pedido=${o.id}"><td>#${o.id}</td><td>${esc(o.supplier_name)}</td><td>${fdate(o.order_date)}</td><td class="num"><span class="btn sm primary">Recibir →</span></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="card"><h3>Albaranes y facturas registrados</h3>${list.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Proveedor</th><th>Documento</th><th>Recibió</th><th class="num">Total</th></tr></thead><tbody>
    ${list.map((r) => `<tr class="click" data-h="#/recepcion/${r.id}"><td>${fdate(r.receipt_date)}</td><td>${esc(r.supplier_name)}</td><td>${r.doc_type === 'factura' ? 'Factura' : 'Albarán'} ${esc(r.delivery_note || '')}</td><td>${esc(r.user_name || '')}</td><td class="num">${eur(r.total)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Sin albaranes todavía.</div>'}</div>`;
  bindRowLinks(v);
  $('#impfac').onclick = () => comprasImport();
};

// Compras pasadas desde un Excel (una fila por línea de factura). Se envía por tandas de facturas completas.
function comprasImport() {
  return importWizard({
    title: 'Importar facturas de compra', sheetHint: ['compra', 'factura'],
    help: 'Una fila por línea de factura: proveedor, nº de factura, fecha, artículo, cantidad, unidad y precio. Cada factura entra como recepción con su fecha, suma al stock y no se repite si ya estaba importada. Los proveedores y artículos que no existan se dan de alta.',
    cols: [['name', 'Artículo', true, ['articulo', 'linea de mercancia', 'descripcion', 'producto', 'concepto']], ['supplier_name', 'Proveedor', true, ['proveedor']], ['cif', 'CIF del proveedor', false, ['cif', 'nif']],
      ['doc', 'Nº de factura o albarán', false, ['n factura', 'no factura', 'factura', 'numero', 'documento', 'albaran']], ['date', 'Fecha', true, ['fecha']],
      ['qty', 'Cantidad', true, ['cantidad', 'unidades', 'uds', 'cant']], ['unit', 'Unidad', false, ['unidad', 'ud', 'medida', 'unidad kglitrounidad']],
      ['price', 'Precio unitario sin IVA', false, ['precio unitario', 'p unit', 'precio']], ['amount', 'Importe de la línea sin IVA', false, ['importe', 'precio sin iva', 'base', 'total']]],
    send: async (items) => {
      items.forEach((it, i) => (it._row = i + 2));
      // tandas sin partir facturas
      const groups = new Map();
      for (const it of items) { const k = `${norm(it.supplier_name)}|${String(it.doc ?? '').trim() || String(it.date)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
      const chunks = []; let cur = [];
      for (const g of groups.values()) { if (cur.length && cur.length + g.length > 400) { chunks.push(cur); cur = []; } cur.push(...g); }
      if (cur.length) chunks.push(cur);
      const agg = { lines: 0, invoices: 0, already: 0, total: 0, bad: [], ns: new Set(), na: new Set(), uu: new Set(), from: null, to: null, can_create: true };
      for (const [i, ch] of chunks.entries()) {
        toast(`Revisando… ${i + 1}/${chunks.length}`);
        const p = await api('receipts/import', { body: { items: ch, dry: true } });
        agg.lines += p.lines; agg.invoices += p.invoices; agg.already += p.already; agg.total += p.total; agg.bad.push(...p.bad); agg.can_create = p.can_create;
        p.new_suppliers.forEach((x) => agg.ns.add(x)); p.new_articles.forEach((x) => agg.na.add(x)); p.unknown_units.forEach((x) => agg.uu.add(x));
        if (p.from && (!agg.from || p.from < agg.from)) agg.from = p.from; if (p.to && (!agg.to || p.to > agg.to)) agg.to = p.to;
      }
      const r = await modal(`<h2>Revisa antes de importar</h2>
        <div class="grid k">${kpi('Facturas', num(agg.invoices - agg.already, 0), agg.already ? `${agg.already} ya estaban importadas (se saltan)` : `${fdate(agg.from)} → ${fdate(agg.to)}`)}${kpi('Líneas', num(agg.lines, 0), agg.bad.length ? `${agg.bad.length} con error` : '')}${kpi('Importe sin IVA', eur(agg.total), 'de las facturas nuevas')}${kpi('Altas', num(agg.ns.size + agg.na.size, 0), `${agg.ns.size} proveedores · ${agg.na.size} artículos`, agg.na.size > 50 ? 'bad' : '')}</div>
        ${agg.na.size ? `<details><summary class="small">Artículos que no existen y se darán de alta (${agg.na.size})</summary><div class="small">${[...agg.na].slice(0, 300).map(esc).join(' · ')}</div></details>
          <p class="small muted">Si son muchos, importa antes el catálogo (Existencias → Importar Excel) para que los nombres coincidan.</p>` : ''}
        ${agg.ns.size ? `<details><summary class="small">Proveedores nuevos (${agg.ns.size})</summary><div class="small">${[...agg.ns].map(esc).join(' · ')}</div></details>` : ''}
        ${agg.uu.size ? `<p class="small txt-warn">Unidades que no encajan con el artículo: ${[...agg.uu].map(esc).join(', ')}. Esas líneas entran tal cual (1 = 1 unidad base).</p>` : ''}
        ${agg.bad.length ? `<details><summary class="small txt-bad">${agg.bad.length} líneas con error (no se importan)</summary>${agg.bad.slice(0, 40).map((b) => `<div class="small">Fila ${b.row}: ${esc(b.name)} — ${esc(b.why)}</div>`).join('')}</details>` : ''}
        <p class="small muted">Cada factura suma al stock en su fecha y queda en Recepción. Los precios actuales de los artículos no se cambian.</p>
        <div class="actions"><button data-close>Cancelar</button><button class="primary" value="ok">Importar ${num(agg.invoices - agg.already, 0)} facturas</button></div>`);
      if (!r) return 'Importación cancelada';
      let inv = 0, ln = 0;
      for (const [i, ch] of chunks.entries()) {
        toast(`Importando… ${i + 1}/${chunks.length}`);
        const x = await api('receipts/import', { body: { items: ch } });
        inv += x.created_invoices; ln += x.created_lines;
      }
      await reload(); route();
      return `${inv} facturas importadas (${ln} líneas)`;
    },
  });
}

// Escandallos desde Excel: plato, ingrediente, cantidad por ración, unidad y mermas
function escandallosImport() {
  return importWizard({
    title: 'Importar escandallos', sheetHint: ['escandallo', 'receta', 'ficha'],
    help: 'Una fila por ingrediente: plato, ingrediente (tal como está en Existencias), cantidad neta POR RACIÓN, unidad (g, kg, ml, cl, l, ud o un formato) y, si quieres, % de merma de limpieza y de cocción. Sustituye los ingredientes de los platos que vengan en el archivo; los demás no se tocan.',
    template: ['plantilla-escandallos.csv', [['Plato', 'Ingrediente', 'Cantidad por ración', 'Unidad', 'Merma limpieza %', 'Merma cocción %'], ['Chocos fritos', 'Choco limpio', 180, 'g', 10, 0], ['Chocos fritos', 'Harina de freír', 25, 'g', 0, 0], ['Caña Cruzcampo', 'Cruzcampo barril 50 l', 20, 'cl', 3, 0]]],
    cols: [['recipe', 'Plato', true, ['plato', 'receta', 'producto']], ['name', 'Ingrediente', true, ['ingrediente', 'articulo']], ['qty', 'Cantidad por ración', true, ['cantidad', 'neto', 'gramos']],
      ['unit', 'Unidad', false, ['unidad', 'ud']], ['waste_pct', 'Merma de limpieza %', false, ['merma limpieza', 'limpieza', 'merma']], ['cook_pct', 'Merma de cocción %', false, ['coccion', 'merma coccion']]],
    send: async (items) => {
      const p = await api('recipes/lines-import', { body: { items, dry: true } });
      const r = await modal(`<h2>Revisa antes de guardar</h2>
        <div class="grid k">${kpi('Platos', num(p.recipes, 0), 'se sustituyen sus ingredientes')}${kpi('Ingredientes', num(p.lines, 0), '')}${kpi('Sin encontrar', num(p.missing_articles.length + p.missing_dishes.length, 0), 'se saltan', p.missing_articles.length + p.missing_dishes.length ? 'bad' : '')}</div>
        ${p.missing_dishes.length ? `<details open><summary class="small txt-bad">Platos que no están en la carta (${p.missing_dishes.length})</summary><div class="small">${p.missing_dishes.slice(0, 100).map(esc).join(' · ')}</div></details>` : ''}
        ${p.missing_articles.length ? `<details open><summary class="small txt-bad">Ingredientes que no están en Existencias (${p.missing_articles.length})</summary><div class="small">${p.missing_articles.slice(0, 100).map(esc).join(' · ')}</div><p class="small muted">Escríbelos igual que en Existencias o dalos de alta antes.</p></details>` : ''}
        ${p.bad.length ? `<details><summary class="small txt-bad">${p.bad.length} filas con error</summary>${p.bad.slice(0, 40).map((b) => `<div class="small">Fila ${b.row}: ${esc(b.name)} — ${esc(b.why)}</div>`).join('')}</details>` : ''}
        <div class="actions"><button data-close>Cancelar</button><button class="primary" value="ok" ${p.recipes ? '' : 'disabled'}>Guardar ${num(p.recipes, 0)} escandallos</button></div>`);
      if (!r) return 'Importación cancelada';
      const x = await api('recipes/lines-import', { body: { items } });
      await reload(); route();
      return `${x.saved} escandallos guardados`;
    },
  });
}

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
      <div class="field" style="flex:0 1 150px"><label>Documento</label><select id="doctype"><option value="albaran" ${prefill?.doc_type === 'factura' ? '' : 'selected'}>Albarán</option><option value="factura" ${prefill?.doc_type === 'factura' ? 'selected' : ''}>Factura</option></select></div>
      <div class="field"><label>Nº de documento</label><input id="dn" value="${esc(prefill?.delivery_note || '')}" placeholder="Nº de albarán o factura"></div>
      <div class="field"><label>Fecha</label><input type="date" id="date" value="${esc(prefill?.date || today())}"></div>
    </div>
    ${prefill?.ocr_id ? `<div class="card scanned"><b>📷 Leído del documento.</b> Revisa cada línea antes de registrar.
      ${!prefill.supplier_id && prefill.supplier_name ? `<div style="margin-top:6px">Proveedor leído: <b>${esc(prefill.supplier_name)}</b>${prefill.supplier_cif ? ' · ' + esc(prefill.supplier_cif) : ''}. Elígelo arriba o <button type="button" class="sm" id="newsup">Crear proveedor</button></div>` : ''}
      ${prefill.total_read ? `<div id="totcheck" style="margin-top:6px"></div>` : ''}
      ${prefill.lines.some((l) => !l.product_id) ? '<div class="txt-warn" style="margin-top:6px">Hay líneas sin artículo: búscalo, créalo nuevo o quita la línea (por ejemplo, material que no controlas).</div><button type="button" class="sm" id="createall" style="margin-top:6px"></button>' : ''}</div>` : ''}
    <div id="facnote" class="small txt-warn hidden" style="margin-bottom:8px">Registra aquí la factura solo si la mercancía entra ahora con ella. Si la factura agrupa albaranes que ya registraste, no la metas: duplicarías el stock.</div>
    <div id="ocrslot"></div>
    <p class="small muted">Comprueba cantidades y precios con el albarán o la factura. Puedes anotar en el formato en que llega (cajas, sacos, botellas…): la app lo pasa a su unidad de control. Las diferencias con lo pedido o con el último precio se resaltan.</p>
    <div id="lines"></div>
    <div class="row" style="margin:10px 0"><input list="dl-prod" id="extra" placeholder="Añadir artículo…" style="flex:1"><button id="addx">Añadir</button></div>
    <div class="row" style="align-items:flex-end">
      <div class="field" style="flex:0 1 200px"><label>Temperatura del género (°C)</label><input id="rtemp" type="number" step="0.1" inputmode="decimal" placeholder="refrigerado ≤ 4 · congelado ≤ −18"></div>
      <div class="field" style="flex:2 1 300px"><label class="check" style="margin:0"><input type="checkbox" id="rchk"> <span>Envases íntegros, etiquetado correcto, caducidades y temperatura correctas</span></label></div></div>
    <div class="small"><label class="check" style="margin:0 0 8px"><input type="checkbox" id="showlot"> <span>Anotar lote y caducidad de cada línea (trazabilidad APPCC)</span></label></div>
    <div class="field"><label>Incidencias / notas</label><textarea id="notes" placeholder="Género en mal estado, faltas, devoluciones…">${esc(prefill?.notes || '')}</textarea></div>
    <div class="sticky-foot row between"><b id="tot"></b><button class="primary" id="save">Registrar entrada</button></div></div>`;
  let showLot = false;
  const draw = () => {
    $('#lines').innerHTML = lines.length ? `<div class="table-wrap"><table><thead><tr><th>Artículo</th>${order ? '<th class="num">Pedido</th>' : ''}<th class="num">Recibido</th><th>Formato</th><th class="num">Precio</th><th class="num">Importe</th><th></th></tr></thead><tbody>
      ${lines.map((l, i) => { const p = prodById(l.product_id);
        if (!p) return `<tr class="flag"><td colspan="${order ? 3 : 2}"><div class="small">Albarán: <b>${esc(l.source || '')}</b> · ${num(l.qty, 3)} ${esc(l.printed_unit || '')} · ${eur(l.price)}</div><div class="row" style="flex-wrap:nowrap"><input list="dl-prod" data-pick="${i}" placeholder="¿Qué artículo es? Escribe para buscar…"><button type="button" class="sm" data-new="${i}" style="white-space:nowrap">+ Crear nuevo</button></div></td><td colspan="3" class="small muted">Sin artículo asignado</td><td><button class="sm" data-del="${i}" aria-label="Quitar">✕</button></td></tr>`;
        const f = unitFactor(p, l.unit); const basePrice = f ? Number(l.price) / f : 0;
        const pd = p.price > 0 && Math.abs(basePrice - p.price) > 0.0005; const qd = order && l.ordered_qty != null && Math.abs(Number(l.qty) - l.ordered_qty) > 0.0005;
        return `<tr class="${pd || qd || l.warn ? 'flag' : ''}"><td>${esc(p.name)}${l.confidence === 'revisar' ? ' <span class="pill warn">revisar</span>' : l.confidence === 'aprendido' ? ' <span class="pill ok">conocido</span>' : ''}${l.source ? `<div class="small muted">Albarán: ${esc(l.source)}${l.printed_unit ? ' · ' + esc(l.printed_unit) : ''}</div>` : ''}<div class="small ${pd ? 'txt-warn' : 'muted'}">${pd ? `Antes ${eur(p.price * f)} / ${esc(unitShort(p, l.unit))}` : f !== 1 ? `= ${num(l.qty * f, 3)} ${esc(p.unit)}` : ''}</div></td>
        ${order ? `<td class="num">${l.ordered_qty != null ? num(l.ordered_qty, 3) : '—'}</td>` : ''}
        <td class="num"><input class="qty" type="number" step="any" inputmode="decimal" data-i="${i}" data-k="qty" value="${l.qty}"></td>
        <td>${unitSelect(p, l.unit, `data-i="${i}" data-k="unit"`)}</td>
        <td class="num"><input class="qty" type="number" step="any" inputmode="decimal" data-i="${i}" data-k="price" value="${Math.round(l.price * 10000) / 10000}"></td>
        <td class="num">${eur(l.qty * l.price)}</td><td><button class="sm" data-del="${i}" aria-label="Quitar">✕</button></td></tr>
        ${showLot ? `<tr class="lotrow"><td colspan="${order ? 7 : 6}"><div class="row" style="gap:8px"><span class="small muted">↳ ${esc(p.name)}</span><input data-i="${i}" data-k="lot" value="${esc(l.lot || '')}" placeholder="Lote" style="width:160px"><label class="small muted" style="margin:0">Caduca</label><input type="date" data-i="${i}" data-k="expiry" value="${esc(l.expiry || '')}" style="width:auto"></div></td></tr>` : ''}`; }).join('')}
      </tbody></table></div>` : '<div class="empty small">Añade los artículos del documento o escanéalo.</div>';
    $$('#lines [data-k]').forEach((inp) => (inp.onchange = () => {
      const l = lines[inp.dataset.i], p = prodById(l.product_id);
      if (inp.dataset.k === 'lot' || inp.dataset.k === 'expiry') { l[inp.dataset.k] = inp.value; return; }
      if (inp.dataset.k === 'unit') { l.unit = inp.value; l.price = unitPrice(p, l.unit); } else l[inp.dataset.k] = Number(inp.value) || 0;
      draw();
    }));
    $$('#lines [data-del]').forEach((b) => (b.onclick = () => { lines.splice(b.dataset.del, 1); draw(); }));
    $$('#lines [data-new]').forEach((b) => (b.onclick = () => act(b, async () => {
      const l = lines[b.dataset.new];
      const r = await newArticleModal(l, supplierNow());
      if (!r) return;
      Object.assign(l, r, { warn: false }); toast('Artículo creado'); draw();
    })));
    const missing = lines.filter((l) => !l.product_id).length;
    if ($('#createall')) { $('#createall').classList.toggle('hidden', !missing); $('#createall').textContent = missing === 1 ? '+ Crear el artículo que falta' : `+ Crear los ${missing} artículos que faltan`; }
    $$('#lines [data-pick]').forEach((inp) => (inp.onchange = () => {
      const p = prodFromLabel(inp.value); if (!p) return toast('Artículo no encontrado. Si es nuevo, créalo en Existencias.', true);
      const l = lines[inp.dataset.pick]; l.product_id = p.id; l.unit = defaultBuyUnit(p); l.warn = false; draw();
    }));
    const tot = lines.reduce((s, l) => s + l.qty * l.price, 0);
    $('#tot').textContent = 'Total: ' + eur(tot);
    if ($('#totcheck')) { const dif = tot - prefill.total_read; $('#totcheck').innerHTML = `Base imponible del documento: <b>${eur(prefill.total_read)}</b> · suma de líneas: <b>${eur(tot)}</b> ${Math.abs(dif) > 0.02 * prefill.total_read + 0.05 ? `<span class="txt-warn">(diferencia ${eur(dif)}: revisa)</span>` : '<span class="txt-ok">✓ cuadra</span>'}`; }
  };
  const supplierNow = () => (order ? order.supplier_id : Number($('#sup')?.value) || prefill?.supplier_id || null);
  $('#addx').onclick = () => act($('#addx'), async () => {
    const txt = $('#extra').value.trim();
    if (!txt) return;
    let p = prodFromLabel(txt);
    if (!p) {
      if (!(await confirmModal(`"${txt}" no existe en Existencias. ¿Darlo de alta ahora?`, 'Crear artículo'))) return;
      const r = await newArticleModal({ description: txt, qty: 1, price: 0 }, supplierNow());
      if (!r) return;
      lines.push({ product_id: r.product_id, qty: 0, unit: r.unit, price: 0, ordered_qty: null }); $('#extra').value = ''; draw(); return;
    }
    const unit = defaultBuyUnit(p); lines.push({ product_id: p.id, qty: 0, unit, price: unitPrice(p, unit), ordered_qty: null }); $('#extra').value = ''; draw();
  });
  if ($('#createall')) $('#createall').onclick = (e) => act(e.target, async () => {
    const miss = lines.filter((l) => !l.product_id);
    const guesses = miss.map((l) => ({ l, g: guessArticle(l) }));
    const ok = await modal(`<h2>${miss.length === 1 ? 'Crear 1 artículo' : `Crear ${miss.length} artículos`}</h2><p class="small muted">Se darán de alta con este nombre y unidad, asignados a este proveedor. Luego puedes corregirlos en Existencias → Editar en lista.</p>
      <div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Control</th><th>Formato</th></tr></thead><tbody>${guesses.map(({ g }, i) => `<tr><td><input data-n="${i}" value="${esc(g.name)}"></td><td>${esc(g.unit)}</td><td>${g.format && g.format.factor ? esc(g.format.name) : '—'}</td></tr>`).join('')}</tbody></table></div>
      <div class="actions"><button data-close>Cancelar</button><button class="primary" value="ok">Crear todos</button></div>`);
    if (!ok) return;
    const names = $$('[data-n]', $('#modal-form')).map((i) => i.value.trim());
    const existing = new Map(S.products.map((p) => [norm(p.name), p.id]));
    for (let i = 0; i < guesses.length; i++) {
      const { l, g } = guesses[i], name = names[i] || g.name;
      if (!name) throw new Error('Pon un nombre a cada artículo');
      // ya existe (o lo acabamos de crear para otra línea): se usa ese
      if (existing.has(norm(name))) { l.product_id = existing.get(norm(name)); l._existing = true; l.warn = false; continue; }
      const inF = g.format && Number(g.format.factor) > 0, price = Number(l.price) || 0;
      const res = await api('products', { body: { name, unit: g.unit, supplier_id: supplierNow(), from_receipt: true, price: inF ? Math.round((price / g.format.factor) * 10000) / 10000 : price,
        formats: inF ? [{ name: g.format.name, factor: Number(g.format.factor), price: price || null, is_default: 1 }] : [] } });
      existing.set(norm(name), res.id);
      l.product_id = res.id; l.unit = g.unit; l._fmt = inF ? g.format.name : null; l._existing = !!res.existing; l.warn = false;
    }
    await reload();
    for (const l of miss) {
      const p = prodById(l.product_id);
      const fmt = l._fmt && S.formats.find((x) => x.product_id === l.product_id && norm(x.name) === norm(l._fmt));
      if (fmt) l.unit = 'f:' + fmt.id; else if (p && (l._existing || p.unit !== l.unit)) l.unit = defaultBuyUnit(p);
      delete l._fmt; delete l._existing;
    }
    toast(miss.length === 1 ? 'Artículo creado' : `${miss.length} artículos creados`); draw();
  });
  $('#save').onclick = (e) => act(e.target, async () => {
    const supplier_id = order ? order.supplier_id : Number($('#sup').value);
    if (!supplier_id) throw new Error('Elige el proveedor');
    if (lines.some((l) => !l.product_id)) throw new Error('Asigna un artículo a cada línea o quita las que no controlas');
    const payload = { supplier_id, order_id: order?.id, doc_type: $('#doctype').value, delivery_note: $('#dn').value, receipt_date: $('#date').value, notes: $('#notes').value, ocr_id: prefill?.ocr_id, supplier_cif: prefill?.supplier_cif,
      rec_temp: $('#rtemp').value, rec_check: $('#rchk').checked,
      lines: lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit: l.unit, price: l.price, ordered_qty: l.ordered_qty, source: l.source, lot: l.lot, expiry: l.expiry })) };
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
  $('#showlot').onchange = () => { showLot = $('#showlot').checked; draw(); };
  const docSync = () => $('#facnote').classList.toggle('hidden', $('#doctype').value !== 'factura');
  $('#doctype').onchange = docSync; docSync();
  if (!order && window.ocrSlot) window.ocrSlot(v, (data) => recepcionNueva(v, null, data));
  draw();
}

async function recepcionDetalle(v, id) {
  const r = await api('receipts/' + id);
  v.innerHTML = `<h1>${r.doc_type === 'factura' ? 'Factura' : 'Albarán'} ${esc(r.delivery_note || '#' + r.id)} · ${esc(r.supplier_name)}</h1><div class="card">
    <div class="small muted">${fdate(r.receipt_date)}${r.order_id ? ` · pedido <a href="#/pedidos/${r.order_id}">#${r.order_id}</a>` : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Artículo</th><th class="num">Pedido</th><th class="num">Recibido</th><th class="num">Precio</th><th class="num">Importe</th></tr></thead><tbody>
    ${r.lines.map((l) => { const lab = l.unit_label || l.unit; const iq = l.input_qty ?? l.qty; const ip = l.input_price ?? l.price; return `<tr><td>${esc(l.name)}</td><td class="num">${l.ordered_qty != null ? num(l.ordered_qty, 3) : '—'}</td><td class="num">${num(iq, 3)} ${esc(lab)}${lab !== l.unit ? `<div class="small muted">${num(l.qty, 3)} ${esc(l.unit)}</div>` : ''}</td><td class="num">${eur(ip)}</td><td class="num">${eur(l.qty * l.price)}</td></tr>`; }).join('')}
    </tbody><tfoot><tr><th colspan="4">Total</th><th class="num">${eur(r.total)}</th></tr></tfoot></table></div>
    ${r.rec_temp != null || r.rec_check != null ? `<p class="small">Control de recepción: ${r.rec_temp != null ? `temperatura ${num(r.rec_temp, 1)} °C` : 'sin temperatura'} · ${r.rec_check ? '✓ envases, etiquetado y caducidades correctos' : r.rec_check === 0 ? '⚠ con incidencias' : ''}</p>` : ''}
    ${r.lines.some((l) => l.lot || l.expiry) ? `<p class="small"><b>Lotes:</b> ${r.lines.filter((l) => l.lot || l.expiry).map((l) => `${esc(l.name)}${l.lot ? ' · lote ' + esc(l.lot) : ''}${l.expiry ? ' · cad. ' + fdate(l.expiry) : ''}`).join(' | ')}</p>` : ''}
    ${r.notes ? `<p><b>Incidencias:</b> ${esc(r.notes)}</p>` : ''}
    ${can('recepcion.anular') ? '<button class="danger" id="del">Anular documento</button>' : ''}</div>`;
  if ($('#del')) $('#del').onclick = (e) => act(e.target, async () => {
    if (!(await confirmModal('Se anulará el documento y se quitará su mercancía del stock. Los precios actualizados no se revierten.', 'Anular'))) return;
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
      <div class="seg" id="modo"><button type="button" data-v="producto">Artículo</button><button type="button" data-v="plato">Plato</button></div></div>
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
    $('#lwhat').textContent = modo === 'plato' ? 'Plato' : 'Artículo';
    $('#lqty').textContent = modo === 'plato' ? 'Raciones' : 'Cantidad';
    $('#what').setAttribute('list', modo === 'plato' ? 'dl-rec' : 'dl-prod');
    $('#what').placeholder = modo === 'plato' ? 'Escribe el plato…' : 'Escribe el artículo…';
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
    else $('#preview').textContent = p.n_lines ? (p.cost !== undefined && qn ? `Coste estimado ${eur(qn * p.cost)} (descuenta sus ingredientes)` : 'Descuenta los ingredientes de su escandallo') : '⚠️ Este plato aún no tiene escandallo: regístralo por artículo.';
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
      else { const p = prodFromLabel(w); if (!p) throw new Error('Artículo no encontrado. Elígelo de la lista.'); body.product_id = p.id; body.unit = $('#unit')?.value || p.unit; }
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
    v.innerHTML = `<h1>Stock e inventario</h1>${tabs}${tableCard('Cambios de precio (últimos 6 meses)', ph, ['Artículo', 'Fecha', 'Antes', 'Ahora', 'Cambio'], (r) => { const ch = r.old_price ? ((r.new_price - r.old_price) / r.old_price) * 100 : 0; return [`${esc(r.name)}<div class="small muted">${esc(r.supplier_name || '')}</div>`, fdate(r.created_at), eur(r.old_price), eur(r.new_price), `<span class="${ch > 0 ? 'txt-bad' : 'txt-ok'}">${ch > 0 ? '+' : ''}${num(ch, 1)} %</span>`]; }, 'Sin cambios de precio registrados')}`;
    return;
  }

  if (tab === 'inventario') {
    const invs = await api('inventory');
    v.innerHTML = `<h1>Stock e inventario</h1>${tabs}
      <div class="card row between" style="${invs.length ? '' : 'border-color:var(--accent)'}"><div><b>${invs.length ? '¿Tienes el recuento en un Excel?' : '¿Arrancas con el stock en un Excel?'}</b>
        <div class="small muted">Súbelo y la app da de alta los artículos que falten, actualiza precios y carga las cantidades${invs.length ? '' : ' como stock inicial'}.</div></div>
        <button class="primary" id="impinv">⬆ Importar desde Excel</button></div>
      <div class="card">
      <p class="small muted">Cuenta lo que hay físicamente y apúntalo. Deja en blanco lo que no cuentes. La app compara con el stock teórico y registra la diferencia como descuadre.</p>
      <div class="row"><div class="field"><label>Fecha del recuento</label><input type="date" id="date" value="${today()}"></div><div class="field" style="flex:2 1 240px"><label>Buscar</label><input id="search" placeholder="Filtrar artículos…"></div></div>
      ${cats.map((c) => `<h3 style="margin-top:14px">${esc(c)}</h3><div class="table-wrap"><table><tbody>${S.products.filter((p) => (p.category || 'Sin categoría') === c).map((p) => {
        const fm = fmtsOf(p).slice().sort((a, b) => b.factor - a.factor);
        return `<tr data-n="${esc(norm(p.name))}" data-row="${p.id}"><td>${esc(p.name)}<div class="small muted">Teórico ${stockText(p, p.stock)}</div></td>
        <td class="num"><div class="row" style="justify-content:flex-end;gap:6px">${fm.map((f) => `<label class="cnt"><input class="qty" type="number" step="any" inputmode="decimal" min="0" data-f="${f.factor}" data-l="${esc(f.name)}"><span>${esc(f.name)}</span></label>`).join('')}
        <label class="cnt"><input class="qty" type="number" step="any" inputmode="decimal" min="0" data-f="1" data-l="${esc(p.unit)}"><span>${fm.length ? 'sueltos ' : ''}${esc(p.unit)}</span></label></div>
        <div class="small muted" data-total></div></td></tr>`; }).join('')}</tbody></table></div>`).join('') || '<div class="empty">No hay artículos.</div>'}
      <div class="field" style="margin-top:12px"><label>Notas</label><input id="notes"></div>
      <div class="sticky-foot row between"><span class="small muted" id="cnt">0 contados</span><button class="primary" id="save">Guardar inventario</button></div></div>
      ${tableCard('Inventarios anteriores', invs, ['Fecha', 'Quién', 'Descuadre'], (i) => [fdate(i.inv_date), esc(i.user_name || ''), `<span class="${i.total_diff_value < 0 ? 'txt-bad' : ''}">${eur(i.total_diff_value)}</span>`], 'Aún no se ha hecho ningún inventario')}`;
    $('#search').oninput = () => { const s = norm($('#search').value); $$('tr[data-n]', v).forEach((tr) => tr.classList.toggle('hidden', s && !tr.dataset.n.includes(s))); };
    $('#impinv').onclick = () => inventarioImport($('#date').value);
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
      await modal(`<h2>Inventario guardado</h2>${r.diffs.length ? `<p>Descuadre total: <b class="${r.total_diff_value < 0 ? 'txt-bad' : 'txt-ok'}">${eur(r.total_diff_value)}</b> <span class="small muted">(negativo = falta género)</span></p>
        <div class="table-wrap"><table><thead><tr><th>Artículo</th><th class="num">Teórico</th><th class="num">Contado</th><th class="num">Valor</th></tr></thead><tbody>${r.diffs.sort((a, b) => a.value - b.value).map((d) => `<tr><td>${esc(d.name)}${d.detail ? `<div class="small muted">${esc(d.detail)}</div>` : ''}</td><td class="num">${num(d.expected)}</td><td class="num">${num(d.counted)} ${esc(d.unit)}</td><td class="num ${d.value < 0 ? 'txt-bad' : 'txt-ok'}">${eur(d.value)}</td></tr>`).join('')}</tbody></table></div>` : '<p>Todo cuadra con el stock teórico. 👍</p>'}
        <div class="actions"><button class="primary" value="ok">Cerrar</button></div>`);
      go('#/stock?tab=stock');
    });
    return;
  }

  const totalVal = S.products.reduce((s, p) => s + Math.max(p.stock, 0) * (p.price || 0), 0);
  v.innerHTML = `<h1>Stock e inventario</h1>${tabs}<div class="card">
    <div class="row between"><div class="field" style="flex:2 1 240px;margin:0"><input id="search" placeholder="Buscar artículo…"></div><b>Valor total: ${eur(totalVal)}</b></div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Artículo</th><th>Categoría</th><th class="num">Stock teórico</th><th class="num">Mínimo</th><th class="num">Precio</th><th class="num">Valor</th></tr></thead><tbody>
    ${S.products.map((p) => `<tr data-n="${esc(norm(p.name + ' ' + (p.category || '')))}" class="${p.min_stock > 0 && p.stock < p.min_stock ? 'flag' : ''}"><td>${esc(p.name)}<div class="small muted">${esc(p.supplier_name || '')}</div></td><td>${esc(p.category || '')}</td><td class="num ${p.stock < 0 ? 'txt-bad' : ''}">${stockText(p, p.stock)}</td><td class="num">${num(p.min_stock)}</td><td class="num">${eur(p.price)}</td><td class="num">${eur(Math.max(p.stock, 0) * p.price)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No hay artículos</td></tr>'}
    </tbody></table></div>
    <p class="small muted">Stock teórico = entradas − ventas según escandallo − mermas − consumo de personal ± ajustes de inventario. Un stock negativo suele indicar un albarán sin registrar o un escandallo con cantidades bajas.</p></div>`;
  $('#search').oninput = () => { const s = norm($('#search').value); $$('tr[data-n]', v).forEach((tr) => tr.classList.toggle('hidden', s && !tr.dataset.n.includes(s))); };
};

// ---------- Escandallos ----------
// ---------- Alérgenos (Reglamento UE 1169/2011) ----------
const ALLERGENS = [['gluten', 'Gluten', '🌾'], ['crustaceos', 'Crustáceos', '🦐'], ['huevos', 'Huevos', '🥚'], ['pescado', 'Pescado', '🐟'], ['cacahuetes', 'Cacahuetes', '🥜'],
  ['soja', 'Soja', '🫘'], ['lacteos', 'Lácteos', '🥛'], ['frutos_cascara', 'Frutos de cáscara', '🌰'], ['apio', 'Apio', '🥬'], ['mostaza', 'Mostaza', '🟡'],
  ['sesamo', 'Sésamo', '⚪'], ['sulfitos', 'Sulfitos', '🍷'], ['altramuces', 'Altramuces', '🌼'], ['moluscos', 'Moluscos', '🦑']];
const ALG = Object.fromEntries(ALLERGENS.map(([k, t, i]) => [k, { t, i }]));
const splitList = (x) => String(x || '').split(',').map((y) => y.trim()).filter((y) => ALG[y]);
const algIcons = (list) => list.map((k) => `<span class="alg" title="${esc(ALG[k].t)}">${ALG[k].i}</span>`).join('');
const algNames = (list) => list.map((k) => ALG[k].t).join(', ');
function algPicker(name, selected, locked = []) {
  return `<div class="algs">${ALLERGENS.map(([k, t, ic]) => { const lk = locked.includes(k); return `<label class="algc ${lk || selected.includes(k) ? 'on' : ''} ${lk ? 'lk' : ''}" title="${lk ? 'Lo lleva un ingrediente' : ''}"><input type="checkbox" data-${name}="${k}" ${lk || selected.includes(k) ? 'checked' : ''} ${lk ? 'disabled' : ''}><span>${ic}</span>${esc(t)}</label>`; }).join('')}</div>`;
}
function bindAlgPicker(root) { $$('.algc input', root).forEach((c) => (c.onchange = () => c.closest('.algc').classList.toggle('on', c.checked))); }

// ---------- Cálculo del escandallo (estándar de hostelería) ----------
// Neto = lo que lleva el plato. Bruto = neto ÷ (1 − merma limpieza) ÷ (1 − merma cocción). Coste = bruto × precio.
const yieldOf = (l) => Math.max((1 - Math.min(Number(l.waste_pct) || 0, 95) / 100) * (1 - Math.min(Number(l.cook_loss_pct) || 0, 95) / 100), 0.05);
function costing({ lines, portions, pvp, misc_pct }) {
  let ing = 0;
  const rows = lines.map((l) => {
    const p = prodById(l.product_id);
    if (!p) return { l, p: null };
    const gross = (Number(l.qty) || 0) / yieldOf(l), up = unitPrice(p, l.unit), cost = gross * up;
    ing += cost;
    return { l, p, gross, up, cost, yield: yieldOf(l) * 100 };
  });
  const por = Number(portions) || 1, misc = ing * ((Number(misc_pct) || 0) / 100), mp = (ing + misc) / por;
  const net = (Number(pvp) || 0) / ivaDiv(), fixedPct = S.fixed?.pct ?? null, gf = fixedPct != null ? net * (fixedPct / 100) : null;
  const target = Number(S.settings.food_cost_target) || 30;
  return { rows, ing, misc, total: ing + misc, mp, net, iva: (Number(pvp) || 0) - net, fc: net ? (mp / net) * 100 : null, margin: net - mp,
    mult: mp ? net / mp : null, gf, fixedPct, full: gf != null ? mp + gf : null, profit: gf != null ? net - mp - gf : null,
    profitPct: gf != null && net ? ((net - mp - gf) / net) * 100 : null, recPvp: (mp / (target / 100)) * ivaDiv(),
    breakEven: fixedPct != null && 1 - fixedPct / 100 > 0 ? (mp / (1 - fixedPct / 100)) * ivaDiv() : null };
}
// valores de un plato de la lista (sin abrir su ficha)
function dishNumbers(r) {
  const net = r.pvp / ivaDiv(), fx = S.fixed?.pct;
  const gf = fx != null ? net * (fx / 100) : null;
  const target = Number(S.settings.food_cost_target) || 30;
  return { net, fc: net && r.n_lines ? (r.cost / net) * 100 : null, gf, profit: gf != null && r.n_lines ? net - r.cost - gf : null,
    rec: r.n_lines && r.cost ? (r.cost / (target / 100)) * ivaDiv() : null };
}
// precio legible: en g/ml/cl se muestra por kg/l
const priceLabel = (p, unit, up) => (['g', 'ml', 'cl'].includes(unit) ? `${eur(p.price)}/${p.unit}` : `${eur(up)}/${unitShort(p, unit)}`);
const plateAllergens = (lines, extra) => [...new Set([...lines.flatMap((l) => splitList(prodById(l.product_id)?.allergens)), ...splitList(extra)])];

// ---------- Carta ----------
const CARTA_TABS = (tab) => `<div class="tabs">${[['platos', 'Platos de la carta'], ['elaboraciones', 'Elaboraciones'], ['produccion', 'Producción']].map(([k, t]) => `<a href="#/escandallos?tab=${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>`;
VIEWS.escandallos = async (v, id, q) => {
  if (id === 'lista') return cartaLista(v);
  if (id) return escandalloEdit(v, id, q);
  const tab = q?.get('tab') || 'platos';
  if (tab === 'elaboraciones') return elaboracionesList(v);
  if (tab === 'produccion') return produccionView(v, q);
  await reload();
  const showCost = can('costes.ver');
  const target = Number(S.settings.food_cost_target) || 30;
  const fx = S.fixed;
  const cats = [...new Set(S.recipes.map((r) => r.category || 'Sin categoría'))];
  v.innerHTML = `<div class="row between"><h1>Carta y escandallos</h1><div class="row">
      ${can('escandallos.editar') ? '<button id="imp">Importar carta</button><button id="impesc">Importar escandallos</button>' : ''}${canAny('escandallos.editar', 'ventas.gestionar') ? '<button id="exp">⬇ Exportar para Qamarero</button>' : ''}
      ${can('escandallos.editar') ? '<a class="btn" href="#/escandallos/lista">✏️ Editar en lista</a><a class="btn primary" href="#/escandallos/nuevo">+ Nuevo plato</a>' : ''}</div></div>
    ${CARTA_TABS('platos')}
    ${showCost ? `<div class="card small">${fx?.pct != null ? `Gastos fijos imputados: <b>${pct(fx.pct)}</b> del precio sin IVA de cada plato (${eur(fx.monthly)}/mes ÷ ${eur(fx.revenue)}/mes de facturación, según ${esc(fx.source)}).` : `Para repartir los gastos fijos entre los platos, indica la <b>facturación mensual prevista</b> en <a href="#/ajustes">Ajustes</a> o importa ventas${fx?.note ? ` (${esc(fx.note)})` : ''}.`} Objetivo de coste de materia prima: ${num(target)} %.</div>` : ''}
    <div class="card"><div class="row"><div class="field" style="flex:2 1 240px;margin:0"><input id="search" placeholder="Buscar plato…"></div>
      <select id="fcat" style="width:auto"><option value="">Todas las categorías</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Plato</th><th>Categoría</th>${showCost ? '<th class="num">Coste MP</th>' : ''}<th class="num">PVP</th>${showCost ? `<th class="num" title="Precio con IVA para quedar en el ${num(target)} % de coste">PVP recomendado</th><th class="num">% coste</th><th class="num">Gastos fijos</th><th class="num">Beneficio neto</th>` : ''}<th>Alérgenos</th></tr></thead><tbody>
    ${S.recipes.map((r) => { const d = dishNumbers(r); const al = [...new Set([...splitList(r.ing_allergens), ...splitList(r.allergens_extra)])];
      return `<tr class="click" data-h="#/escandallos/${r.id}" data-c="${esc(r.category || 'Sin categoría')}" data-n="${esc(norm(r.name + ' ' + (r.category || '')))}"><td>${esc(r.name)}${r.n_lines ? '' : ' <span class="pill warn">sin escandallo</span>'}</td><td>${esc(r.category || '')}</td>
      ${showCost ? `<td class="num">${r.n_lines ? eur(r.cost) : '—'}</td>` : ''}<td class="num">${eur(r.pvp)}</td>
      ${showCost ? `<td class="num">${d.rec ? `<span class="${r.pvp < d.rec - 0.05 ? 'txt-bad' : 'muted'}" title="${r.pvp < d.rec - 0.05 ? `Faltan ${eur(d.rec - r.pvp)} para llegar al objetivo` : 'El PVP actual ya cumple el objetivo'}">${eur(d.rec)}</span>` : '—'}</td><td class="num">${d.fc != null ? `<span class="${d.fc > target + 3 ? 'txt-bad' : d.fc <= target ? 'txt-ok' : 'txt-warn'}">${pct(d.fc)}</span>` : '—'}</td><td class="num">${d.gf != null ? eur(d.gf) : '—'}</td><td class="num">${d.profit != null ? `<span class="${d.profit < 0 ? 'txt-bad' : ''}">${eur(d.profit)}</span>` : '—'}</td>` : ''}
      <td>${algIcons(al) || (r.n_lines ? '<span class="muted small">ninguno</span>' : '<span class="muted small">—</span>')}${r.alg_unchecked ? ` <span class="pill warn" title="${r.alg_unchecked} ingrediente(s) sin revisar">revisar</span>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="9" class="empty">No hay platos. ${can('escandallos.editar') ? 'Importa tu carta de Qamarero o crea el primero.' : ''}</td></tr>`}
    </tbody></table></div>${showCost ? `<p class="small muted">Coste MP = materia prima por ración, incluido el % de varios. % coste sobre PVP sin IVA (${num(S.settings.iva_pct)} %). Beneficio neto = PVP sin IVA − materia prima − gastos fijos imputados. PVP recomendado = el precio con IVA para que la materia prima sea el ${num(target)} % (en rojo si el actual se queda por debajo).</p>` : ''}</div>`;
  bindRowLinks(v);
  const filt = () => { const q2 = norm($('#search').value), c = $('#fcat').value; $$('tr[data-n]', v).forEach((tr) => tr.classList.toggle('hidden', (q2 && !tr.dataset.n.includes(q2)) || (c && tr.dataset.c !== c))); };
  $('#search').oninput = filt; $('#fcat').onchange = filt;
  if ($('#exp')) $('#exp').onclick = (e) => act(e.target, exportCartaQamarero);
  if ($('#impesc')) $('#impesc').onclick = () => escandallosImport();
  if ($('#imp')) $('#imp').onclick = () => importWizard({
    title: 'Importar carta (platos y precios)', sheetHint: ['carta', 'plato'],
    help: 'Sube el Excel o CSV de la carta exportado de Qamarero. Se crean los platos que no existan y se actualiza el PVP de los que sí. La app guarda las columnas del archivo para poder exportar la carta después en el mismo formato.',
    cols: [['name', 'Nombre del plato', true, ['nombre', 'producto', 'articulo', 'plato', 'descripcion']], ['pvp', 'Precio de venta (con IVA)', false, ['pvp', 'precio']], ['category', 'Categoría / familia', false]],
    keepRaw: true,
    send: async (items, meta) => { const r = await api('recipes/bulk', { body: { items: items.map((i) => ({ ...i, pvp: parseNum(i.pvp) || 0 })), headers: meta.headers, map: meta.map } }); await reload(); return `${r.count} platos importados`; },
  }).then(() => route());
};

async function elaboracionesList(v) {
  await reload();
  const showCost = can('costes.ver');
  const usedIn = (pid) => S.allRecipes.filter((r) => String(r.ing_products || '').split(',').includes(String(pid))).length;
  v.innerHTML = `<div class="row between"><h1>Carta y escandallos</h1>${can('escandallos.editar') ? '<a class="btn primary" href="#/escandallos/nuevo?tipo=elaboracion">+ Nueva elaboración</a>' : ''}</div>
    ${CARTA_TABS('elaboraciones')}
    <div class="card"><p class="small muted" style="margin-top:0">Preparaciones que se hacen en cocina y se usan en varios platos: bechamel, sofrito, alioli, fondos, masas, salsas… Se escandallan una vez y se añaden a los platos como un ingrediente más. Su coste se actualiza solo cuando cambian los precios de sus ingredientes, y tienen su propio stock: al <b>producir</b> se descuentan sus ingredientes y se suma la elaboración.</p>
    <div class="table-wrap"><table><thead><tr><th>Elaboración</th><th class="num">Produce</th>${showCost ? '<th class="num">Coste por unidad</th>' : ''}<th class="num">Stock</th><th class="num">Usada en</th><th>Alérgenos</th>${can('produccion.registrar') ? '<th></th>' : ''}</tr></thead><tbody>
    ${S.preps.map((r) => { const p = prodById(r.product_id); return `<tr class="click" data-h="#/escandallos/${r.id}"><td>${esc(r.name)}${r.n_lines ? '' : ' <span class="pill warn">sin ingredientes</span>'}</td><td class="num">${num(r.yield_qty)} ${esc(r.yield_unit || '')}</td>
      ${showCost ? `<td class="num">${p ? eur(p.price) + ' / ' + esc(p.unit) : '—'}</td>` : ''}<td class="num">${p ? stockText(p, p.stock) : '—'}</td><td class="num">${usedIn(r.product_id)} ${usedIn(r.product_id) === 1 ? 'plato' : 'platos'}</td>
      <td>${algIcons(splitList(p?.allergens))}</td>${can('produccion.registrar') ? `<td><a class="btn sm" href="#/escandallos?tab=produccion&e=${r.id}" onclick="event.stopPropagation()">Producir</a></td>` : ''}</tr>`; }).join('') || '<tr><td colspan="7" class="empty">Aún no hay elaboraciones.</td></tr>'}
    </tbody></table></div></div>`;
  bindRowLinks(v);
}

async function produccionView(v, q) {
  await reload();
  const list = await api('production');
  const pre = Number(q?.get('e')) || '';
  v.innerHTML = `<h1>Carta y escandallos</h1>${CARTA_TABS('produccion')}
    ${can('produccion.registrar') ? `<form class="card" id="f"><h3>Registrar producción</h3>
      <div class="row"><div class="field" style="flex:2 1 220px"><label>Elaboración</label><select id="rec" required><option value="">Elige…</option>${S.preps.map((r) => `<option value="${r.id}" ${r.id === pre ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
      <div class="field"><label id="lq">Cantidad producida</label><input id="qty" type="number" step="any" inputmode="decimal" min="0" required></div>
      <div class="field"><label>Fecha</label><input type="date" id="date" value="${today()}"></div></div>
      <div class="field"><label>Notas / lote</label><input id="notes" placeholder="p. ej. lote 30/09, cámara 2"></div>
      <div id="prev" class="small muted" style="margin-bottom:10px"></div>
      <button class="primary" style="width:100%">Registrar producción</button></form>` : ''}
    <div class="card"><h3>Últimos 60 días</h3>${list.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Qué</th><th>Quién</th>${can('costes.ver') ? '<th class="num">Coste</th>' : ''}<th></th></tr></thead><tbody>
      ${list.map((x) => `<tr><td>${fdate(x.mov_date)}</td><td>${esc(x.label.replace('Producción: ', ''))}${x.notes ? `<div class="small muted">${esc(x.notes)}</div>` : ''}</td><td>${esc(x.user_name || '')}</td>${can('costes.ver') ? `<td class="num">${eur(x.cost)}</td>` : ''}
      <td>${S.user.is_super || x.user_id === S.user.id || can('mermas.borrar') ? `<button class="sm" data-undo="${esc(x.grp)}">Deshacer</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Todavía no hay producciones.</div>'}</div>`;
  const upd = () => {
    const r = S.preps.find((x) => x.id === Number($('#rec')?.value));
    if (!r) { if ($('#prev')) $('#prev').textContent = ''; return; }
    $('#lq').textContent = `Cantidad producida (${r.yield_unit})`;
    const qn = Number($('#qty').value) || 0, p = prodById(r.product_id);
    $('#prev').textContent = `La receta produce ${num(r.yield_qty)} ${r.yield_unit}.${qn ? ` Se descontarán los ingredientes de ${num(qn / r.yield_qty, 2)} veces la receta${p && can('costes.ver') ? ` (coste ${eur(qn * p.price)})` : ''}.` : ''}`;
  };
  if ($('#f')) {
    $('#rec').onchange = upd; $('#qty').oninput = upd; upd();
    $('#f').onsubmit = (e) => { e.preventDefault(); act(e.submitter, async () => {
      await api('production', { body: { recipe_id: Number($('#rec').value), qty: Number($('#qty').value), date: $('#date').value, notes: $('#notes').value } });
      toast('Producción registrada'); go(`#/escandallos?tab=produccion&t=${Date.now()}`);
    }); };
  }
  $$('[data-undo]', v).forEach((b) => (b.onclick = () => act(b, async () => {
    if (!(await confirmModal('¿Deshacer esta producción? Se devolverán los ingredientes al stock y se quitará lo producido.', 'Deshacer'))) return;
    await api('production/' + encodeURIComponent(b.dataset.undo), { method: 'DELETE' }); toast('Producción deshecha'); route();
  })));
}

async function exportCartaQamarero() {
  const r = await api('recipes/export');
  if (!r.from_qamarero && !(await confirmModal('Todavía no has importado la carta desde un archivo de Qamarero, así que no conozco su formato. Exportaré un archivo sencillo (nombre, categoría y precio). ¿Continuar?', 'Exportar igualmente'))) return;
  const aoa = [r.headers, ...r.rows];
  const name = `carta_qamarero_${today()}`;
  try {
    await loadXLSX();
    const ws = XLSX.utils.aoa_to_sheet(aoa), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, String(r.sheet || 'Productos').slice(0, 31));
    XLSX.writeFile(wb, name + '.xlsx');
  } catch { downloadCSV(name + '.csv', aoa); }
  toast(`Carta exportada: ${r.rows.length} platos`);
}

// ---------- Carta: edición en lista ----------
async function cartaLista(v) {
  if (!can('escandallos.editar')) throw new Error('No tienes permiso para editar la carta');
  await reload();
  const showCost = can('costes.ver'), target = Number(S.settings.food_cost_target) || 30;
  const rows = S.recipes.map((r) => ({ ...r, _o: { name: r.name, category: r.category || '', pvp: r.pvp, portions: r.portions } }));
  const cats = [...new Set(S.recipes.map((r) => r.category).filter(Boolean))];
  v.innerHTML = `<div class="row between"><h1>Carta: editar en lista</h1><a class="btn" href="#/escandallos">Volver</a></div>
    <div class="card"><div class="row"><div class="field" style="flex:2 1 220px;margin:0"><input id="search" placeholder="Filtrar…"></div>
      <select id="fcat" style="width:auto"><option value="">Todas las categorías</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
      <div class="row bulkbar"><b id="nsel">0 seleccionados</b>
        <span class="row"><input id="pct" type="number" step="any" placeholder="%" style="width:80px"><select id="rnd" style="width:auto"><option value="0.05">redondear a 0,05</option><option value="0.1">a 0,10</option><option value="0.5">a 0,50</option><option value="1">a 1 €</option><option value="0">sin redondeo</option></select><button type="button" id="apct">Cambiar PVP %</button></span>
        ${showCost ? '<button type="button" id="arec">Poner PVP recomendado</button>' : ''}
        <span class="row"><input id="ncat" list="dl-rcat" placeholder="Categoría" style="width:150px"><button type="button" id="acat">Poner categoría</button></span></div>
      <div class="table-wrap"><table class="grid-edit"><thead><tr><th><input type="checkbox" id="all"></th><th>Plato</th><th>Categoría</th><th class="num">Raciones</th><th class="num">PVP con IVA</th>${showCost ? '<th class="num">Coste MP</th><th class="num">PVP recomendado</th><th class="num">% coste</th><th class="num">Beneficio neto</th>' : ''}</tr></thead><tbody>
      ${rows.map((r, i) => `<tr data-i="${i}" data-n="${esc(norm(r.name))}" data-c="${esc(r.category || '')}"><td><input type="checkbox" data-sel></td>
        <td><input data-k="name" value="${esc(r.name)}"></td><td><input data-k="category" list="dl-rcat" value="${esc(r.category || '')}"></td>
        <td class="num"><input class="qty" type="number" step="any" data-k="portions" value="${r.portions}"></td><td class="num"><input class="qty" type="number" step="0.01" data-k="pvp" value="${r.pvp}"></td>
        ${showCost ? `<td class="num">${r.n_lines ? eur(r.cost) : '—'}</td><td class="num" data-rc></td><td class="num" data-fc></td><td class="num" data-pr></td>` : ''}</tr>`).join('')}</tbody></table></div>
      <div class="sticky-foot row between"><span class="small muted" id="nchg">Sin cambios</span><button class="primary" id="save" disabled>Guardar cambios</button></div></div>`;
  const tr = (i) => $(`tr[data-i="${i}"]`, v);
  const calc = (i) => {
    const r = rows[i], t = tr(i);
    ['name', 'category', 'portions', 'pvp'].forEach((k) => $(`[data-k=${k}]`, t).classList.toggle('chg', String(r[k] ?? '') !== String(r._o[k] ?? '')));
    if (!showCost) return;
    // si cambian las raciones, el coste por ración cambia en proporción
    const cost = r.n_lines ? (r.cost * r._o.portions) / (Number(r.portions) || 1) : null, d = dishNumbers({ ...r, cost });
    $('[data-fc]', t).innerHTML = d.fc != null ? `<span class="${d.fc > target + 3 ? 'txt-bad' : d.fc <= target ? 'txt-ok' : 'txt-warn'}">${pct(d.fc)}</span>` : '—';
    $('[data-rc]', t).innerHTML = d.rec ? `<span class="${r.pvp < d.rec - 0.05 ? 'txt-bad' : 'muted'}">${eur(d.rec)}</span>` : '—';
    $('[data-pr]', t).innerHTML = d.profit != null ? `<span class="${d.profit < 0 ? 'txt-bad' : ''}">${eur(d.profit)}</span>` : '—';
  };
  const changed = () => rows.map((r, i) => [r, i]).filter(([r]) => ['name', 'category', 'portions', 'pvp'].some((k) => String(r[k] ?? '') !== String(r._o[k] ?? '')));
  const status = () => { const n = changed().length; $('#nchg').textContent = n ? `${n} platos modificados` : 'Sin cambios'; $('#save').disabled = !n; $('#nsel').textContent = `${sel().length} seleccionados`; };
  const sel = () => $$('tr[data-i]', v).filter((t) => !t.classList.contains('hidden') && $('[data-sel]', t).checked).map((t) => Number(t.dataset.i));
  const setVal = (i, k, val) => { rows[i][k] = val; $(`[data-k=${k}]`, tr(i)).value = val; calc(i); };
  rows.forEach((_, i) => calc(i));
  v.addEventListener('input', (e) => { const t = e.target.closest('tr[data-i]'); if (t && e.target.dataset.k) { const k = e.target.dataset.k; rows[t.dataset.i][k] = ['pvp', 'portions'].includes(k) ? Number(e.target.value) : e.target.value; calc(t.dataset.i); } status(); });
  v.addEventListener('change', status);
  $('#all').onchange = () => { $$('tr[data-i]', v).forEach((t) => { if (!t.classList.contains('hidden')) $('[data-sel]', t).checked = $('#all').checked; }); status(); };
  const filt = () => { const q2 = norm($('#search').value), c = $('#fcat').value; $$('tr[data-i]', v).forEach((t) => t.classList.toggle('hidden', (q2 && !t.dataset.n.includes(q2)) || (c && t.dataset.c !== c))); };
  $('#search').oninput = filt; $('#fcat').onchange = filt;
  const need = () => { const s2 = sel(); if (!s2.length) throw new Error('Marca primero los platos (casilla de la izquierda)'); return s2; };
  $('#apct').onclick = () => act(null, async () => {
    const p2 = Number($('#pct').value); if (!p2) throw new Error('Indica el % (por ejemplo 5 o −3)');
    const step = Number($('#rnd').value);
    need().forEach((i) => { let x = rows[i].pvp * (1 + p2 / 100); if (step) x = Math.round(x / step) * step; setVal(i, 'pvp', Math.round(x * 100) / 100); }); status();
  });
  if ($('#arec')) $('#arec').onclick = () => act(null, async () => {
    const step = Number($('#rnd').value) || 0.05;
    need().forEach((i) => { const r = rows[i]; if (!r.n_lines) return; const x = (r.cost / (target / 100)) * ivaDiv(); setVal(i, 'pvp', Math.round(Math.ceil(x / step) * step * 100) / 100); }); status();
  });
  $('#acat').onclick = () => act(null, async () => { const c = $('#ncat').value.trim(); if (!c) throw new Error('Escribe la categoría'); need().forEach((i) => setVal(i, 'category', c)); status(); });
  $('#save').onclick = (e) => act(e.target, async () => {
    const items = changed().map(([r]) => { const o = { id: r.id }; ['name', 'category', 'portions', 'pvp'].forEach((k) => { if (String(r[k] ?? '') !== String(r._o[k] ?? '')) o[k] = r[k]; }); return o; });
    await api('recipes/bulk-edit', { method: 'PUT', body: { items } });
    toast(`${items.length} platos guardados`); route();
  });
  status();
}

// ---------- Ficha técnica (escandallo) ----------
async function escandalloEdit(v, id, q) {
  const isNew = id === 'nuevo';
  const r = isNew ? { name: '', category: '', pvp: 0, portions: 1, notes: '', lines: [], misc_pct: null, kind: q?.get('tipo') === 'elaboracion' ? 'elaboracion' : 'plato', yield_unit: 'kg' } : await api('recipes/' + id);
  const isPrep = r.kind === 'elaboracion';
  await reload();
  const ro = !can('escandallos.editar');
  const showCost = can('costes.ver');
  const lines = r.lines.map((l) => ({ product_id: l.product_id, qty: l.input_qty ?? l.qty, unit: l.input_unit || l.unit, waste_pct: l.waste_pct, cook_loss_pct: l.cook_loss_pct || 0 }));
  const target = Number(S.settings.food_cost_target) || 30;
  let photo = r.photo || null;
  const dis = ro ? 'disabled' : '';
  const own = r.product_id;
  const usedBy = isPrep && own ? S.allRecipes.filter((x) => String(x.ing_products || '').split(',').includes(String(own))) : [];
  v.innerHTML = `<div class="row between no-print"><h1>${isNew ? (isPrep ? 'Nueva elaboración' : 'Nuevo plato') : esc(r.name)}${isPrep ? ' <span class="pill">elaboración</span>' : ''}</h1><div class="row">${!isNew && isPrep && can('produccion.registrar') ? `<a class="btn" href="#/escandallos?tab=produccion&e=${r.id}">🍲 Registrar producción</a>` : ''}${!isNew ? '<button id="print">🖨 Imprimir ficha técnica</button>' : ''}<a class="btn" href="#/escandallos${isPrep ? '?tab=elaboraciones' : ''}">Volver</a></div></div>
    <div class="card no-print"><h3>${isPrep ? 'Datos de la elaboración' : 'Datos del plato'}</h3>
    <div class="row">${fieldHtml({ name: 'name', label: isPrep ? 'Nombre (bechamel, sofrito, fondo oscuro…)' : 'Nombre del plato', required: true, attrs: dis }, r.name)}${fieldHtml({ name: 'category', label: 'Categoría / familia', list: 'dl-rcat', attrs: dis }, r.category)}</div>
    ${isPrep ? `<div class="row">${fieldHtml({ name: 'yield_qty', label: 'La receta produce', type: 'number', required: true, help: 'Lo que sale de la receta completa, ya elaborado (p. ej. 5 l de bechamel)', attrs: dis }, r.yield_qty ?? '')}
      ${fieldHtml({ name: 'yield_unit', label: 'Unidad', type: 'select', options: [['kg', 'kg'], ['l', 'litros'], ['ud', 'unidades / raciones']], attrs: dis }, r.yield_unit || 'kg')}
      ${fieldHtml({ name: 'prep_time', label: 'Tiempo de elaboración', attrs: `${dis} placeholder="p. ej. 45 min"` }, r.prep_time)}</div>
      ${usedBy.length ? `<p class="small muted">Se usa en: ${usedBy.map((x) => `<a href="#/escandallos/${x.id}">${esc(x.name)}</a>`).join(', ')}</p>` : ''}`
    : `<div class="row">${fieldHtml({ name: 'portions', label: 'Nº de raciones que salen', type: 'number', help: 'Si la receta es para una olla de 10 raciones, pon 10', attrs: dis }, r.portions)}
      ${fieldHtml({ name: 'pvp', label: 'PVP con IVA (€)', type: 'number', attrs: dis }, r.pvp)}
      ${fieldHtml({ name: 'prep_time', label: 'Tiempo de elaboración', attrs: `${dis} placeholder="p. ej. 20 min"` }, r.prep_time)}</div>`}
    <div class="small muted">${r.updated_at ? `Actualizada el ${fdate(r.updated_at)}${r.author ? ' · ' + esc(r.author) : ''}` : ''}</div></div>

    <div class="card no-print"><h3>Ingredientes (por la receta completa)</h3>
    <p class="small muted">Escribe la <b>cantidad neta</b> que lleva el plato (180 g, 40 ml, 1 ud…) y las mermas: <b>limpieza</b> (pelar, desespinar, limpiar) y <b>cocción</b> (pérdida de peso al cocinar). La app calcula el <b>peso bruto</b> que sale del almacén y su coste con el último precio de compra.</p>
    <div id="lines"></div>
    ${ro ? '' : '<div class="row" style="margin:10px 0"><input list="dl-prod" id="extra" placeholder="Añadir ingrediente…" style="flex:1"><button id="addx">Añadir</button></div>'}
    ${showCost ? `<div class="row" style="align-items:flex-end">${fieldHtml({ name: 'misc_pct', label: '% de varios', type: 'number', help: `Sal, especias, aceite de fritura y pequeños ingredientes que no se pesan. Vacío = el general (${num(S.settings.misc_pct)} %)`, attrs: `${dis} placeholder="${num(S.settings.misc_pct)}"` }, r.misc_pct ?? '')}</div>` : ''}
    </div>

    ${showCost ? '<div class="card no-print"><h3>Análisis de coste por ración</h3><div class="grid k" id="sum"></div><div id="sumnote" class="small muted" style="margin-top:8px"></div></div>' : ''}

    <div class="card no-print"><h3>Alérgenos</h3><p class="small muted">Los que llevan sus ingredientes se marcan solos (se configuran en cada artículo de Existencias). Marca aquí los que añada la elaboración (por ejemplo, un rebozado o una salsa que no está como ingrediente).</p><div id="algwarn"></div><div id="algbox"></div></div>

    <div class="card no-print"><h3>Elaboración y presentación</h3>
    ${fieldHtml({ name: 'notes', label: 'Elaboración (paso a paso)', type: 'textarea', attrs: dis }, r.notes)}
    ${fieldHtml({ name: 'plating', label: 'Emplatado / presentación', type: 'textarea', attrs: dis }, r.plating)}
    ${fieldHtml({ name: 'conservation', label: 'Conservación y regeneración', type: 'textarea', attrs: `${dis} placeholder="Temperatura, vida útil, cómo se regenera…"` }, r.conservation)}
    <div class="field"><label>Foto del plato</label><div id="phbox"></div>${ro ? '' : '<label class="btn sm" style="margin-top:6px">📷 Subir foto<input type="file" id="phf" accept="image/*" hidden></label> <button type="button" class="sm" id="phdel">Quitar</button>'}</div>
    </div>
    ${ro ? '' : `<div class="card no-print sticky-foot row between" style="margin:0"><div>${!isNew ? '<button class="danger" id="del">Eliminar plato</button>' : ''}</div><button class="primary" id="save">Guardar ficha</button></div>`}
    <div id="printsheet" class="print-only"></div>`;
  const val = (n) => $(`[name="${n}"]`, v)?.value ?? '';
  const extraAlg = () => $$('[data-alg]', v).filter((c) => c.checked && !c.disabled).map((c) => c.dataset.alg);
  let extras = splitList(r.allergens_extra);
  const drawAlg = () => {
    const fromIng = [...new Set(lines.flatMap((l) => splitList(prodById(l.product_id)?.allergens)))];
    if ($('#algbox').innerHTML) extras = extraAlg();
    $('#algbox').innerHTML = algPicker('alg', extras, fromIng);
    const unchecked = lines.map((l) => prodById(l.product_id)).filter((p) => p && !p.allergens_checked);
    $('#algwarn').innerHTML = unchecked.length ? `<div class="txt-warn small" style="margin-bottom:8px">Ingredientes con alérgenos sin revisar: ${unchecked.map((p) => esc(p.name)).join(', ')}. <a href="#/productos/alergenos">Revisarlos</a></div>` : '';
    $$('[data-alg]', v).forEach((c) => (c.disabled = c.disabled || ro));
    bindAlgPicker($('#algbox'));
  };
  const drawPhoto = () => { $('#phbox').innerHTML = photo ? `<img src="${photo}" alt="Foto del plato" class="dishphoto">` : '<span class="small muted">Sin foto</span>'; };
  const calc = () => costing({ lines, portions: isPrep ? 1 : val('portions'), pvp: isPrep ? 0 : val('pvp'), misc_pct: val('misc_pct') === '' ? S.settings.misc_pct : val('misc_pct') });
  const draw = () => {
    const c = calc();
    $('#lines').innerHTML = lines.length ? `<div class="table-wrap"><table><thead><tr><th>Ingrediente</th><th class="num">Neto</th><th>Unidad</th><th class="num">Merma limpieza %</th><th class="num">Merma cocción %</th><th class="num">Rend.</th><th class="num">Bruto</th>${showCost ? '<th class="num">Precio</th><th class="num">Coste</th>' : ''}${ro ? '' : '<th></th>'}</tr></thead><tbody>
      ${c.rows.map(({ l, p, gross, up, cost, yield: y }, i) => (!p ? '' : `<tr><td>${esc(p.name)} ${algIcons(splitList(p.allergens))}</td>
        <td class="num">${ro ? num(l.qty, 3) : `<input class="qty" type="number" step="any" inputmode="decimal" data-i="${i}" data-k="qty" value="${l.qty}">`}</td>
        <td>${ro ? esc(unitShort(p, l.unit)) : unitSelect(p, l.unit, `data-i="${i}" data-k="unit"`)}</td>
        <td class="num">${ro ? num(l.waste_pct) : `<input class="qty" type="number" step="any" min="0" max="95" data-i="${i}" data-k="waste_pct" value="${l.waste_pct || 0}">`}</td>
        <td class="num">${ro ? num(l.cook_loss_pct) : `<input class="qty" type="number" step="any" min="0" max="95" data-i="${i}" data-k="cook_loss_pct" value="${l.cook_loss_pct || 0}">`}</td>
        <td class="num">${num(y, 0)} %</td><td class="num">${num(gross, 3)} ${esc(unitShort(p, l.unit))}</td>
        ${showCost ? `<td class="num small">${esc(priceLabel(p, l.unit, up))}</td><td class="num">${eur(cost)}</td>` : ''}${ro ? '' : `<td><button class="sm" data-del="${i}" aria-label="Quitar">✕</button></td>`}</tr>`)).join('')}
      </tbody>${showCost ? `<tfoot><tr><th colspan="8">Coste de ingredientes</th><th class="num">${eur(c.ing)}</th>${ro ? '' : '<th></th>'}</tr><tr><th colspan="8">Varios (${num(val('misc_pct') === '' ? S.settings.misc_pct : val('misc_pct'))} %)</th><th class="num">${eur(c.misc)}</th>${ro ? '' : '<th></th>'}</tr><tr><th colspan="8">Coste total de materia prima (${isPrep ? `lote de ${num(Number(val('yield_qty')) || 0)} ${esc(val('yield_unit'))}` : `${num(Number(val('portions')) || 1)} ${Number(val('portions')) === 1 ? 'ración' : 'raciones'}`})</th><th class="num">${eur(c.total)}</th>${ro ? '' : '<th></th>'}</tr></tfoot>` : ''}</table></div>` : '<div class="empty small">Sin ingredientes todavía.</div>';
    $$('#lines [data-k]').forEach((inp) => (inp.onchange = () => {
      const l = lines[inp.dataset.i];
      if (inp.dataset.k === 'unit') { const p = prodById(l.product_id); l.qty = Math.round(((l.qty * unitFactor(p, l.unit)) / unitFactor(p, inp.value)) * 10000) / 10000; l.unit = inp.value; }
      else l[inp.dataset.k] = Number(inp.value) || 0;
      draw();
    }));
    $$('#lines [data-del]').forEach((b) => (b.onclick = () => { lines.splice(b.dataset.del, 1); draw(); drawAlg(); }));
    if (showCost && isPrep) {
      const yq = Number(val('yield_qty')) || 0, yu = val('yield_unit'), p = prodById(own);
      $('#sum').innerHTML = kpi('Coste del lote', eur(c.total), `ingredientes + ${num(val('misc_pct') === '' ? S.settings.misc_pct : val('misc_pct'))} % varios`) +
        kpi(`Coste por ${yu === 'ud' ? 'unidad' : yu}`, yq ? eur(c.total / yq) : '—', 'es el precio con el que entra en los platos') +
        kpi('Stock actual', p ? stockText(p, p.stock) : '—', 'sube al producir, baja al vender platos') + kpi('Usada en', `${usedBy.length}`, usedBy.length === 1 ? 'plato' : 'platos');
      $('#sumnote').innerHTML = 'Al guardar, el nuevo coste se aplica a todos los platos que la llevan.';
    } else if (showCost) {
      const k = (l, x, s2 = '', cls = '') => kpi(l, x, s2, cls);
      $('#sum').innerHTML = k('Coste materia prima', eur(c.mp), 'por ración, con varios') + k('PVP sin IVA', eur(c.net), `IVA ${eur(c.iva)}`) +
        k('% coste materia prima', pct(c.fc), `Objetivo ${num(target)} %`, c.fc == null ? '' : c.fc > target + 3 ? 'bad' : c.fc <= target ? 'good' : '') +
        k('Margen bruto', eur(c.margin), c.mult ? `multiplicador × ${num(c.mult, 2)}` : '') +
        k('Gastos fijos imputados', c.gf != null ? eur(c.gf) : '—', c.fixedPct != null ? `${pct(c.fixedPct)} del PVP sin IVA` : 'Falta facturación prevista') +
        k('Beneficio neto', c.profit != null ? eur(c.profit) : '—', c.profitPct != null ? `${pct(c.profitPct)} del PVP sin IVA` : '', c.profit != null ? (c.profit < 0 ? 'bad' : 'good') : '') +
        k('PVP recomendado', eur(c.recPvp), `con IVA, para ${num(target)} % de coste`) + k('PVP mínimo sin pérdidas', c.breakEven ? eur(c.breakEven) : '—', 'con IVA, cubre materia prima y gastos fijos');
      $('#sumnote').innerHTML = S.fixed?.pct != null ? `Gastos fijos: ${eur(S.fixed.monthly)}/mes ÷ ${eur(S.fixed.revenue)}/mes de facturación (${esc(S.fixed.source)}) = ${pct(S.fixed.pct)}. Cada plato soporta ese % de su precio sin IVA.` : 'Para imputar los gastos fijos indica la facturación mensual prevista en Ajustes o importa ventas de Qamarero.';
    }
  };
  if (!ro) {
    $('#addx').onclick = () => { const p = prodFromLabel($('#extra').value); if (!p) return toast('Artículo no encontrado. Créalo antes en Existencias.', true); if (own && p.id === own) return toast('Una elaboración no puede llevarse a sí misma', true); lines.push({ product_id: p.id, qty: 0, unit: defaultRecipeUnit(p), waste_pct: 0, cook_loss_pct: 0 }); $('#extra').value = ''; draw(); drawAlg(); $$('#lines input[data-k="qty"]').pop()?.focus(); };
    ['pvp', 'portions', 'misc_pct', 'yield_qty', 'yield_unit'].forEach((n) => { const el = $(`[name="${n}"]`, v); if (el) { el.oninput = draw; el.onchange = draw; } });
    $('#phf').onchange = () => act(null, async () => { const f = $('#phf').files[0]; if (!f) return; photo = await compressImage(f, 900, 0.72); drawPhoto(); });
    $('#phdel').onclick = () => { photo = null; drawPhoto(); };
    $('#save').onclick = (e) => act(e.target, async () => {
      const body = { name: val('name'), category: val('category'), pvp: Number(val('pvp')) || 0, portions: Number(val('portions')) || 1, prep_time: val('prep_time'),
        kind: isPrep ? 'elaboracion' : 'plato', yield_qty: Number(val('yield_qty')) || null, yield_unit: val('yield_unit') || null,
        notes: val('notes'), plating: val('plating'), conservation: val('conservation'), misc_pct: val('misc_pct'), allergens_extra: extraAlg(), photo: photo || '', pos_name: r.pos_name, lines };
      if (!body.name) throw new Error(isPrep ? 'Pon nombre a la elaboración' : 'Pon nombre al plato');
      const res = await api('recipes' + (isNew ? '' : '/' + id), { method: isNew ? 'POST' : 'PUT', body });
      await reload(); toast(isPrep ? 'Elaboración guardada. Los platos que la usan ya tienen el coste nuevo.' : 'Ficha guardada'); go('#/escandallos/' + (isNew ? res.id : id) + (isNew ? '' : '?t=' + Date.now()));
    });
    if ($('#del')) $('#del').onclick = (e) => act(e.target, async () => { if (!(await confirmModal(`¿Eliminar "${r.name}"?`, 'Eliminar'))) return; await api('recipes/' + id, { method: 'DELETE' }); await reload(); go('#/escandallos' + (isPrep ? '?tab=elaboraciones' : '')); });
  }
  if ($('#print')) $('#print').onclick = () => { $('#printsheet').innerHTML = fichaTecnicaHTML({ ...r, name: val('name'), category: val('category'), pvp: isPrep ? 0 : val('pvp'), portions: isPrep ? 1 : val('portions'), yield_qty: val('yield_qty'), yield_unit: val('yield_unit'), prep_time: val('prep_time'), notes: val('notes'), plating: val('plating'), conservation: val('conservation') }, lines, calc(), [...new Set([...lines.flatMap((l) => splitList(prodById(l.product_id)?.allergens)), ...extraAlg()])], photo, showCost); window.print(); };
  draw(); drawAlg(); drawPhoto();
}

function fichaTecnicaHTML(r, lines, c, algs, photo, showCost) {
  const nl = (t) => esc(t || '').replace(/\n/g, '<br>');
  return `<div class="ficha"><div class="fh"><div><div class="small">${esc(S.settings.restaurant_name)} · Ficha técnica de escandallo</div><h1>${esc(r.name)}</h1>
      <div>${[r.kind === 'elaboracion' ? 'Elaboración' : '', r.category, r.kind === 'elaboracion' ? `produce ${num(Number(r.yield_qty) || 0)} ${r.yield_unit || ''}` : `${num(Number(r.portions) || 1)} ${Number(r.portions) === 1 ? 'ración' : 'raciones'}`, r.prep_time, r.pvp && r.kind !== 'elaboracion' ? 'PVP ' + eur(r.pvp) : ''].filter(Boolean).map(esc).join(' · ')}</div></div>${photo ? `<img src="${photo}" alt="">` : ''}</div>
    <table><thead><tr><th>Ingrediente</th><th>Neto</th><th>M. limpieza</th><th>M. cocción</th><th>Bruto</th>${showCost ? '<th>Precio</th><th>Coste</th>' : ''}</tr></thead><tbody>
    ${c.rows.filter((x) => x.p).map(({ l, p, gross, up, cost }) => `<tr><td>${esc(p.name)}</td><td>${num(l.qty, 3)} ${esc(unitShort(p, l.unit))}</td><td>${num(l.waste_pct)} %</td><td>${num(l.cook_loss_pct)} %</td><td>${num(gross, 3)} ${esc(unitShort(p, l.unit))}</td>${showCost ? `<td>${esc(priceLabel(p, l.unit, up))}</td><td>${eur(cost)}</td>` : ''}</tr>`).join('')}</tbody>
    ${showCost ? `<tfoot><tr><td colspan="6">Coste ingredientes</td><td>${eur(c.ing)}</td></tr><tr><td colspan="6">Varios</td><td>${eur(c.misc)}</td></tr><tr><td colspan="6"><b>Coste total materia prima</b></td><td><b>${eur(c.total)}</b></td></tr></tfoot>` : ''}</table>
    ${showCost && r.kind === 'elaboracion' ? `<table class="fk"><tr><td>Coste del lote</td><td>${eur(c.total)}</td><td>Coste por ${esc(r.yield_unit || 'unidad')}</td><td>${Number(r.yield_qty) ? eur(c.total / Number(r.yield_qty)) : '—'}</td></tr></table>` : ''}
    ${showCost && r.kind !== 'elaboracion' ? `<table class="fk"><tr><td>Coste MP por ración</td><td>${eur(c.mp)}</td><td>PVP con IVA</td><td>${eur(r.pvp)}</td></tr>
      <tr><td>PVP sin IVA</td><td>${eur(c.net)}</td><td>% coste MP</td><td>${pct(c.fc)}</td></tr>
      <tr><td>Margen bruto</td><td>${eur(c.margin)}</td><td>Multiplicador</td><td>${c.mult ? '× ' + num(c.mult, 2) : '—'}</td></tr>
      <tr><td>Gastos fijos imputados</td><td>${c.gf != null ? eur(c.gf) : '—'}</td><td>Beneficio neto</td><td>${c.profit != null ? eur(c.profit) : '—'}</td></tr></table>` : ''}
    <p><b>Alérgenos:</b> ${algs.length ? esc(algNames(algs)) : 'Ninguno de los 14 de declaración obligatoria'}</p>
    ${r.notes ? `<h3>Elaboración</h3><p>${nl(r.notes)}</p>` : ''}${r.plating ? `<h3>Emplatado</h3><p>${nl(r.plating)}</p>` : ''}${r.conservation ? `<h3>Conservación</h3><p>${nl(r.conservation)}</p>` : ''}
    <p class="small">Impreso el ${new Date().toLocaleDateString('es-ES')}</p></div>`;
}

async function compressImage(file, max, q) {
  const img = await createImageBitmap(file);
  const sc = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
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
// Lee un CSV o una hoja de un Excel. Con varias hojas: la pedida por nombre o la primera que tenga datos.
async function readSheet(file, sheetName) {
  let rows, sheetNames = [], name = null;
  if (/\.(csv|txt)$/i.test(file.name)) {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf); // CSV guardado desde Excel en Windows
    rows = parseCSV(text);
  } else {
    await loadXLSX();
    const wb = file._wb || (file._wb = XLSX.read(await file.arrayBuffer(), { type: 'array' }));
    sheetNames = wb.SheetNames;
    const rowsOf = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' });
    const hasTable = (rs) => rs.some((r) => r.filter((c) => String(c).trim() !== '').length >= 2);
    name = sheetName && sheetNames.includes(sheetName) ? sheetName : sheetNames.find((n) => hasTable(rowsOf(n))) || sheetNames[0];
    rows = rowsOf(name);
  }
  const h = rows.findIndex((r) => r.filter((c) => String(c).trim() !== '').length >= 2);
  if (h < 0) throw new Error('El archivo parece vacío');
  const headers = rows[h].map((c, i) => String(c).trim() || `Columna ${i + 1}`);
  return { headers, data: rows.slice(h + 1).filter((r) => r.some((c) => String(c).trim() !== '')), sheetNames, sheetName: name };
}
// primero coincidencia exacta ("Ud" = ud), después parcial; nunca una columna ya asignada a otro dato
function guessCol(headers, words, taken = new Set()) {
  const clean = (x) => norm(x).replace(/[^a-z0-9ñ ]/g, '').trim();
  const free = (i) => !taken.has(i);
  let i = headers.findIndex((hd, k) => free(k) && words.some((w) => clean(hd) === clean(w)));
  if (i < 0) i = headers.findIndex((hd, k) => free(k) && words.some((w) => clean(w).length >= 3 && clean(hd).includes(clean(w))));
  if (i >= 0) taken.add(i);
  return i;
}
const COL_GUESS = {
  name: ['producto', 'articulo', 'nombre', 'plato', 'descripcion', 'concepto'], pvp: ['pvp', 'precio'], price: ['precio', 'coste', 'importe'],
  category: ['categoria', 'familia', 'grupo', 'seccion'], units: ['unidades', 'cantidad', 'uds', 'cant', 'vendid'], revenue: ['total', 'importe', 'venta', 'facturado'],
  unit: ['unidad', 'medida'], supplier_name: ['proveedor'],
  cif: ['cif', 'nif', 'dni'], contact: ['contacto', 'persona', 'comercial'], phone: ['telefono', 'tlf', 'tel', 'movil', 'whatsapp'],
  email: ['email', 'e-mail', 'correo', 'mail'], order_days: ['dias', 'reparto', 'pedido'], notes: ['notas', 'observaciones', 'comentarios'],
  min_stock: ['minimo', 'min'], format_name: ['formato', 'envase', 'presentacion'], format_factor: ['unidades por', 'uds por', 'contiene', 'factor'], format_price: ['precio formato', 'precio caja', 'precio envase'],
};

// Inventario (o stock inicial) desde Excel, con vista previa antes de guardar
function inventarioImport(date) {
  return importWizard({
    title: 'Importar inventario desde Excel', sheetHint: ['recuento', 'inventario', 'stock'],
    help: 'Una fila por artículo con su cantidad. Si el mismo artículo sale en varias filas (p. ej. de varias facturas) podrás sumarlas. La unidad puede ser kg, g, l, ml, cl, ud o el nombre de un formato del artículo (caja, saco…).',
    template: ['plantilla-inventario.csv', [['Artículo', 'Cantidad', 'Unidad', 'Precio', 'Categoría', 'Proveedor'], ['Harina de fuerza', 12.5, 'kg', 0.92, 'Secos', 'Harinas del Sur'], ['Coca-Cola 35 cl', 48, 'ud', 0.65, 'Bebidas', 'Bebidas Cádiz'], ['Aceite de oliva virgen extra', 10, 'l', 6.8, 'Aceites', '']]],
    cols: [['name', 'Artículo', true], ['qty', 'Cantidad', true, ['cantidad', 'stock', 'existencias', 'recuento', 'uds', 'unidades', 'cant']], ['unit', 'Unidad (kg, g, l, ud, caja…)', false, ['ud', 'u', 'um', 'unid', 'unidad', 'unidad de medida', 'medida', 'formato']],
      ['price', 'Precio por esa unidad (sin IVA)', false, ['precio', 'coste', 'p. unit', 'pvp compra']], ['category', 'Categoría', false], ['supplier_name', 'Proveedor', false]],
    send: async (items) => {
      const noUnit = !items.some((i) => String(i.unit ?? '').trim());
      let pv = { ...(await api('inventory/import', { body: { items, dry: true } })), no_unit: noUnit };
      const table = (rows) => `<div class="table-wrap"><table><thead><tr><th>Artículo</th><th class="num">Cantidad</th><th class="num">Precio</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}${r.is_new ? ' <span class="pill warn">nuevo</span>' : ''}${r.unit_note && r.unit_note !== r.unit ? `<div class="small muted">leído en ${esc(r.unit_note)}</div>` : ''}</td><td class="num">${num(r.qty, 3)} ${esc(r.unit)}</td><td class="num">${r.price ? eur(r.price) + '/' + esc(r.unit) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
      const body = (p) => `<h2>Revisa antes de guardar</h2>
        <div class="grid k">${kpi('Filas leídas', num(p.rows, 0), [p.blank ? `${p.blank} sin contar (no se tocan)` : '', p.bad.length ? `${p.bad.length} con error` : ''].filter(Boolean).join(' · '))}${kpi('Artículos', num(p.articles, 0), `${p.matched} ya existían`)}${kpi('Nuevos', num(p.new_items.length, 0), p.can_create ? 'se darán de alta' : 'no tienes permiso para crearlos', p.new_items.length && !p.can_create ? 'bad' : '')}${kpi('Valor', eur(p.value), p.price_changes ? `${p.price_changes} precios cambian` : '')}</div>
        ${p.dups ? `<div class="field"><label>${p.dups} filas repiten un artículo que ya salía antes</label><select id="dup"><option value="sum">Sumar las cantidades</option><option value="last">Quedarme con la última fila</option></select></div>` : ''}
        ${p.no_unit ? '<p class="small txt-warn">⚠ No has indicado columna de unidad: todas las cantidades se toman en la unidad de cada artículo (kg, l o ud). Si tu Excel mezcla kilos y gramos, vuelve atrás y elige la columna.</p>' : ''}
        ${p.unknown_units.length ? `<p class="small txt-warn">Unidades que no conozco: ${p.unknown_units.map(esc).join(', ')}. En artículos nuevos se tomarán como «ud»; en los que ya existen, crea antes el formato (Existencias → artículo → formatos) para que se conviertan solas.</p>` : ''}
        ${p.bad.length ? `<details><summary class="small txt-bad">${p.bad.length} filas sin cantidad válida (no se importan)</summary>${p.bad.slice(0, 30).map((b) => `<div class="small">Fila ${b.row}: ${esc(b.name)} — ${esc(b.why)}</div>`).join('')}</details>` : ''}
        <h3>Muestra</h3>${table(p.sample)}
        ${p.new_items.length ? `<details><summary class="small">Ver los ${p.new_items.length} artículos nuevos</summary>${table(p.new_items.map((x) => ({ ...x, is_new: true })))}</details>` : ''}
        <label class="chk"><input type="checkbox" id="initial" ${p.first_inventory ? 'checked' : ''}><span>Es el <b>stock inicial</b>: entra como existencias y no cuenta como descuadre</span></label>
        ${p.price_changes ? `<label class="chk"><input type="checkbox" id="prices" checked><span>Actualizar los ${p.price_changes} precios que han cambiado</span></label>` : ''}
        <p class="small muted">Fecha del recuento: ${fdate(date)}. Los artículos que no estén en el Excel no se tocan.</p>
        <div class="actions"><button data-close>Cancelar</button><button class="primary" value="ok">Guardar inventario</button></div>`;
      let opts = {};
      const r = await modal(body(pv), { onOpen: (f) => {
        const dup = $('#dup', f);
        if (dup) dup.onchange = async () => { opts.dup = dup.value; pv = { ...(await api('inventory/import', { body: { items, dry: true, dup: dup.value } })), no_unit: noUnit }; const keep = dup.value; f.innerHTML = body(pv); $('#dup', f).value = keep; $('#dup', f).onchange = dup.onchange; $$('[data-close]', f).forEach((b) => (b.onclick = (e) => { e.preventDefault(); $('#modal').close(); })); };
      } });
      if (!r) return 'Importación cancelada';
      const f = $('#modal-form');
      const res = await api('inventory/import', { body: { items, date, dup: $('#dup', f)?.value || opts.dup || 'sum', initial: !!$('#initial', f)?.checked, update_prices: $('#prices', f) ? $('#prices', f).checked : true } });
      await reload(); route();
      return `Inventario guardado: ${res.counted} artículos${res.created ? `, ${res.created} nuevos` : ''}${res.prices ? `, ${res.prices} precios actualizados` : ''}`;
    },
  });
}

// Asistente genérico: subir archivo -> elegir columnas -> enviar
function downloadCSV(name, rows) {
  const cell = (x) => (typeof x === 'number' ? String(x).replace('.', ',') : `"${String(x ?? '').replace(/"/g, '""')}"`);
  const blob = new Blob(['\uFEFF' + rows.map((r) => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importWizard({ title, help, cols, send, template, keepRaw, sheetHint = [] }) {
  const r = await modal(`<h2>${esc(title)}</h2><p class="small muted">${esc(help)}</p>
    ${template ? `<p class="small"><button type="button" class="sm" id="tpl">⬇ Descargar plantilla</button> Rellénala en Excel y súbela. Puedes usar también tu propio archivo: te preguntaré qué columna es cada dato.</p>` : ''}
    <div class="field"><label>Archivo Excel o CSV</label><input type="file" id="file" accept=".xlsx,.xls,.csv,.txt"></div>
    <div id="map"></div><div class="actions"><button data-close>Cancelar</button><button class="primary" value="ok" id="go" disabled>Importar</button></div>`, {
    onOpen: (f) => {
      if (template) $('#tpl', f).onclick = () => downloadCSV(template[0], template[1]);
      // con varias hojas se elige la que mejor encaja con los datos que se piden
      const score = (sh) => { const taken = new Set(); return (sheetHint.some((w) => norm(sh.sheetName || '').includes(w)) ? 10 : 0) + cols.reduce((t, [k, , req, words]) => t + (guessCol(sh.headers, words || COL_GUESS[k] || [k], taken) >= 0 ? (req ? 3 : 1) : 0), 0) + Math.min(sh.data.length, 1); };
      const load = async (sheetName) => {
        const file = $('#file', f).files[0];
        let sh = await readSheet(file, sheetName);
        if (!sheetName && sh.sheetNames.length > 1) {
          let best = sh, bs = score(sh);
          for (const n of sh.sheetNames) { const x = await readSheet(file, n).catch(() => null); if (x && score(x) > bs) { best = x; bs = score(x); } }
          sh = best;
        }
        return sh;
      };
      const draw = async (sheetName) => {
        try {
          const sh = await load(sheetName);
          f._sheet = sh;
          const taken = new Set();
          $('#map', f).innerHTML = (sh.sheetNames.length > 1 ? `<div class="field"><label>Hoja del Excel</label><select id="sheet">${sh.sheetNames.map((n) => `<option ${n === sh.sheetName ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>` : '')
            + `<p class="small">${sh.data.length} filas. Indica qué columna es cada dato:</p>` + cols.map(([k, t, req, words]) => {
            const g = guessCol(sh.headers, words || COL_GUESS[k] || [k], taken);
            return `<div class="field"><label>${esc(t)}${req ? '' : ' (opcional)'}</label><select data-col="${k}">${req ? '' : '<option value="-1">— no tengo —</option>'}${sh.headers.map((hd, i) => `<option value="${i}" ${i === g ? 'selected' : ''}>${esc(hd)}</option>`).join('')}</select></div>`;
          }).join('');
          if ($('#sheet', f)) $('#sheet', f).onchange = () => draw($('#sheet', f).value);
          $('#go', f).disabled = false;
        } catch (e) { toast(e.message, true); }
      };
      $('#file', f).onchange = () => draw();
    },
  });
  if (!r) return;
  const f = $('#modal-form');
  const map = Object.fromEntries($$('[data-col]', f).map((s) => [s.dataset.col, Number(s.value)]));
  const items = f._sheet.data.map((row) => ({ ...Object.fromEntries(Object.entries(map).filter(([, i]) => i >= 0).map(([k, i]) => [k, typeof row[i] === 'string' ? row[i].trim() : row[i]])), ...(keepRaw ? { _raw: f._sheet.headers.map((_, i) => row[i] ?? '') } : {}) })).filter((it) => String(it[cols[0][0]] ?? '').trim());
  try { toast(await send(items, { headers: f._sheet.headers, map })); } catch (e) { toast(e.message, true); }
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
    const [imps, stale] = await Promise.all([api('sales/imports'), api('sales/stale')]);
    v.innerHTML = head + (stale.ids.length ? `<div class="card row between" style="border-color:var(--accent)"><div><b>Has cambiado escandallos después de volcar ventas.</b><div class="small muted">${stale.ids.length} volcado(s) se calcularon con los escandallos anteriores. Recalcula para que el consumo y el stock teórico usen los de ahora (las ventas en euros no cambian).</div></div><button class="primary" id="recalc">Recalcular consumo</button></div>` : '') + tableCard('Volcados de ventas', imps, ['Periodo', 'Origen', 'Platos', 'Ventas sin IVA', ''], (i) => [`${fdate(i.date_from)} → ${fdate(i.date_to)}`, esc(i.filename || ''), num(i.rows, 0), eur(i.revenue), `<button class="sm danger" data-del="${i.id}">Deshacer</button>`], 'Todavía no se han importado ventas');
    $$('[data-del]', v).forEach((b) => (b.onclick = () => act(b, async () => {
      if (!(await confirmModal('Se borrarán esas ventas y su consumo teórico. Podrás volver a importarlas.', 'Deshacer'))) return;
      await api('sales/imports/' + b.dataset.del, { method: 'DELETE' }); toast('Importación deshecha'); route();
    })));
    if ($('#recalc')) $('#recalc').onclick = (e) => act(e.target, async () => {
      for (const [i, id] of stale.ids.entries()) { toast(`Recalculando ${i + 1}/${stale.ids.length}…`); await api('sales/recalc/' + id, { body: {} }); }
      toast('Consumo recalculado con los escandallos actuales'); route();
    });
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
      ${matched.length ? `<div class="table-wrap"><table><thead><tr><th>Qamarero</th><th>Plato</th><th class="num">Uds</th><th class="num">Importe</th></tr></thead><tbody>${matched.map((m) => `<tr><td>${esc(m.pos_name)}</td><td>${esc(recById(m.recipe_id)?.name)}${m.factor !== 1 ? ` × ${num(m.factor, 3)}` : ''}${m.auto ? ' <span class="pill warn" title="Vinculado por parecido: revisa que sea correcto">auto</span>' : ''}</td><td class="num">${num(m.units)}</td><td class="num">${m.revenue != null ? eur(m.revenue) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">Ninguno todavía.</div>'}
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

// ---------- Artículos ----------
const BASE_UNITS = [['kg', 'kg (se escandalla en g o kg)'], ['l', 'litro (se escandalla en ml, cl o l)'], ['ud', 'unidad (botellas, latas, piezas…)']];
VIEWS.productos = async (v, id) => {
  await reload();
  if (id === 'lista') return existenciasLista(v);
  if (id === 'alergenos') return revisarAlergenos(v);
  if (id) return productoEdit(v, id);
  v.innerHTML = `<div class="row between"><h1>Existencias</h1><div class="row"><button id="imp">Importar Excel</button><a class="btn" href="#/productos/alergenos">🧠 Revisar alérgenos${S.products.filter((p) => !p.allergens_checked).length ? ` <span class="badge-count">${S.products.filter((p) => !p.allergens_checked).length}</span>` : ''}</a><a class="btn" href="#/productos/lista">✏️ Editar en lista</a><a class="btn primary" href="#/productos/nuevo">+ Nuevo artículo</a></div></div>
    <p class="small muted" style="margin-top:-6px">Existencias es todo lo que se compra a proveedores y se guarda en almacén: ingredientes, bebidas, limpieza… Lo que se vende está en <a href="#/escandallos">Carta</a>.</p>
    <div class="card"><div class="field"><input id="search" placeholder="Buscar…"></div><div class="table-wrap"><table><thead><tr><th>Artículo</th><th>Categoría</th><th>Proveedor</th><th>Control</th><th>Formatos</th><th class="num">Precio</th><th class="num">Mínimo</th><th>Alérgenos</th></tr></thead><tbody>
    ${S.products.map((p) => `<tr class="click" data-h="${p.prep_recipe_id ? '#/escandallos/' + p.prep_recipe_id : '#/productos/' + p.id}" data-n="${esc(norm(p.name + ' ' + (p.category || '') + ' ' + (p.supplier_name || '')))}"><td>${esc(p.name)}${p.prep_recipe_id ? ' <span class="pill">elaboración</span>' : ''}</td><td>${esc(p.category || '')}</td><td>${esc(p.supplier_name || '')}</td><td>${esc(p.unit)}</td><td class="small">${fmtsOf(p).map((f) => esc(f.name)).join(', ') || '<span class="muted">—</span>'}</td><td class="num">${eur(p.price)} / ${esc(p.unit)}</td><td class="num">${num(p.min_stock)}</td><td>${p.allergens_checked ? algIcons(splitList(p.allergens)) || '<span class="small muted">ninguno</span>' : '<span class="pill warn">sin revisar</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Sin artículos. Impórtalos desde un Excel con tus tarifas de proveedor o créalos uno a uno.</td></tr>'}
    </tbody></table></div></div>`;
  bindRowLinks(v);
  $('#search').oninput = () => { const s2 = norm($('#search').value); $$('tr[data-n]', v).forEach((tr) => tr.classList.toggle('hidden', s2 && !tr.dataset.n.includes(s2))); };
  $('#imp').onclick = () => importWizard({
    title: 'Importar existencias', sheetHint: ['articul', 'existencia', 'producto', 'catalogo'],
    help: 'Sube un Excel o CSV con tus artículos (por ejemplo, la tarifa de un proveedor). Los que ya existan con el mismo nombre se actualizan. Si la tarifa trae formato (Caja 24, Saco 25 kg…) indícalo y se crea el formato.',
    cols: [['name', 'Nombre del artículo', true, ['producto', 'articulo', 'nombre', 'descripcion']], ['unit', 'Unidad de control (kg, l, ud)', false], ['price', 'Precio por unidad sin IVA', false, ['precio unidad', 'precio ud', 'precio kg', 'precio']], ['category', 'Categoría', false], ['supplier_name', 'Proveedor', false], ['min_stock', 'Stock mínimo', false], ['format_name', 'Nombre del formato (Caja 24…)', false], ['format_factor', 'Unidades que trae el formato', false], ['format_price', 'Precio del formato sin IVA', false]],
    template: ['plantilla_existencias.csv', [['Artículo', 'Unidad', 'Precio unidad', 'Categoría', 'Proveedor', 'Mínimo', 'Formato', 'Unidades por formato', 'Precio formato'],
      ['Coca-Cola 35cl', 'ud', '', 'Bebida', 'Bebidas SL', 48, 'Caja 24', 24, 14.4], ['Harina de trigo', 'kg', '', 'Seco', 'Distribuciones Sur', 10, 'Saco 25 kg', 25, 22.5], ['Calamar', 'kg', 11.5, 'Pescado', 'Pescados Mar', 2, '', '', '']]],
    send: async (items) => { const r = await api('products/bulk', { body: { items: items.map((i) => ({ ...i, price: parseNum(i.price) || 0 })) } }); await reload(); return `${r.count} artículos importados`; },
  }).then(() => route());
};

async function revisarAlergenos(v) {
  if (!can('productos.editar')) throw new Error('No tienes permiso para editar existencias');
  const all = new URLSearchParams(location.hash.split('?')[1] || '').get('todos') === '1';
  v.innerHTML = `<h1>Revisar alérgenos</h1><div class="card"><b>Analizando artículos…</b> <span class="small muted">El diccionario es instantáneo; la IA tarda unos segundos si hay artículos que no reconoce.</span></div>`;
  await reload();
  const ids = all ? S.products.map((p) => p.id) : [];
  const r = await api('allergens/suggest', { body: { ids } });
  const rows = r.rows.map((x) => ({ ...x, sel: x.checked ? x.current : [...new Set([...x.current, ...x.dict, ...(x.ai || [])])] }));
  v.innerHTML = `<div class="row between"><h1>Revisar alérgenos</h1><div class="row"><a class="btn" href="#/productos/alergenos${all ? '' : '?todos=1'}">${all ? 'Ver solo sin revisar' : 'Ver todos los artículos'}</a><a class="btn" href="#/productos">Volver</a></div></div>
    <div class="card small">Sugerencias del <b>diccionario de hostelería</b>${r.ai ? ` y, para lo que no reconoce, de la <b>IA</b>${r.ai_used ? '' : ' (no ha respondido ahora; puedes volver a intentarlo más tarde)'}` : ''}. Toca un alérgeno para quitarlo o añadirlo. Al guardar, los artículos quedan como <b>revisados</b>.
      <br><b>Importante:</b> la referencia legal es la etiqueta o la ficha técnica del proveedor. Revisa sobre todo embutidos, salsas, preparados y congelados, que cambian según la marca.</div>
    ${rows.length ? `<div class="card"><div class="table-wrap"><table><thead><tr><th>Artículo</th><th>Alérgenos</th><th>Origen</th></tr></thead><tbody>
    ${rows.map((x, i) => `<tr data-i="${i}"><td><b>${esc(x.name)}</b></td><td><div class="algs small">${ALLERGENS.map(([k, t, ic]) => `<button type="button" class="algc ${x.sel.includes(k) ? 'on' : ''} ${x.sel.includes(k) || x.dict.includes(k) || (x.ai || []).includes(k) ? '' : 'faint'}" data-a="${k}" title="${esc(t)}">${ic} ${esc(t)}</button>`).join('')}</div></td>
      <td class="small muted">${x.checked ? 'revisado' : x.dict.length ? 'diccionario' : x.ai ? (x.ai.length ? 'IA' : 'IA: ninguno') : 'sin sugerencia'}</td></tr>`).join('')}</tbody></table></div>
    <div class="sticky-foot row between"><span class="small muted">${rows.length} artículos</span><button class="primary" id="save">Guardar y marcar como revisados</button></div></div>` : '<div class="card empty">Todos los artículos tienen los alérgenos revisados. 👍</div>'}`;
  $$('tr[data-i] [data-a]', v).forEach((b) => (b.onclick = () => {
    const x = rows[b.closest('tr').dataset.i], k = b.dataset.a;
    x.sel = x.sel.includes(k) ? x.sel.filter((y) => y !== k) : [...x.sel, k];
    b.classList.toggle('on', x.sel.includes(k)); b.classList.remove('faint');
  }));
  if ($('#save')) $('#save').onclick = (e) => act(e.target, async () => {
    await api('products/bulk-edit', { method: 'PUT', body: { items: rows.map((x) => ({ id: x.id, allergens: x.sel, allergens_checked: 1 })) } });
    toast(`${rows.length} artículos revisados`); go('#/productos');
  });
}

async function existenciasLista(v) {
  if (!can('productos.editar')) throw new Error('No tienes permiso para editar existencias');
  await reload();
  const F = ['name', 'category', 'supplier_id', 'price', 'min_stock'];
  const rows = S.products.map((p) => ({ ...p, supplier_id: p.supplier_id || '', category: p.category || '', _o: { name: p.name, category: p.category || '', supplier_id: p.supplier_id || '', price: p.price, min_stock: p.min_stock } }));
  const cats = [...new Set(S.products.map((p) => p.category).filter(Boolean))];
  const supOpts = (sel) => `<option value="">—</option>${S.suppliers.map((x) => `<option value="${x.id}" ${String(x.id) === String(sel) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`;
  v.innerHTML = `<div class="row between"><h1>Existencias: editar en lista</h1><a class="btn" href="#/productos">Volver</a></div>
    <div class="card"><div class="row"><div class="field" style="flex:2 1 220px;margin:0"><input id="search" placeholder="Filtrar…"></div>
      <select id="fcat" style="width:auto"><option value="">Todas las categorías</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
      <select id="fsup" style="width:auto"><option value="">Todos los proveedores</option>${S.suppliers.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
      <div class="row bulkbar"><b id="nsel">0 seleccionados</b>
        <span class="row"><input id="pct" type="number" step="any" placeholder="%" style="width:80px"><button type="button" id="apct">Cambiar precio %</button></span>
        <span class="row"><input id="ncat" list="dl-pcat" placeholder="Categoría" style="width:150px"><button type="button" id="acat">Poner categoría</button></span>
        <span class="row"><select id="nsup" style="width:auto">${supOpts('')}</select><button type="button" id="asup">Poner proveedor</button></span></div>
      <div class="table-wrap"><table class="grid-edit"><thead><tr><th><input type="checkbox" id="all"></th><th>Artículo</th><th>Categoría</th><th>Proveedor</th><th class="num">Precio sin IVA</th><th>Por</th><th class="num">Mínimo</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr data-i="${i}" data-n="${esc(norm(r.name))}" data-c="${esc(r.category)}" data-s="${r.supplier_id}"><td><input type="checkbox" data-sel></td>
        <td><input data-k="name" value="${esc(r.name)}"></td><td><input data-k="category" list="dl-pcat" value="${esc(r.category)}"></td>
        <td><select data-k="supplier_id">${supOpts(r.supplier_id)}</select></td>
        <td class="num"><input class="qty" type="number" step="0.0001" data-k="price" value="${r.price}" ${r.prep_recipe_id ? 'disabled title="Coste calculado desde su ficha de elaboración"' : ''}></td><td class="small muted">${esc(r.unit)}</td>
        <td class="num"><input class="qty" type="number" step="any" data-k="min_stock" value="${r.min_stock}"></td></tr>`).join('')}</tbody></table></div>
      <div class="sticky-foot row between"><span class="small muted" id="nchg">Sin cambios</span><button class="primary" id="save" disabled>Guardar cambios</button></div></div>`;
  const tr = (i) => $(`tr[data-i="${i}"]`, v);
  const mark = (i) => F.forEach((k) => $(`[data-k=${k}]`, tr(i)).classList.toggle('chg', String(rows[i][k] ?? '') !== String(rows[i]._o[k] ?? '')));
  const changed = () => rows.filter((r) => F.some((k) => String(r[k] ?? '') !== String(r._o[k] ?? '')));
  const sel = () => $$('tr[data-i]', v).filter((t) => !t.classList.contains('hidden') && $('[data-sel]', t).checked).map((t) => Number(t.dataset.i));
  const status = () => { const n = changed().length; $('#nchg').textContent = n ? `${n} artículos modificados` : 'Sin cambios'; $('#save').disabled = !n; $('#nsel').textContent = `${sel().length} seleccionados`; };
  const setVal = (i, k, val) => { rows[i][k] = val; $(`[data-k=${k}]`, tr(i)).value = val; mark(i); };
  const onEdit = (e) => { const t = e.target.closest('tr[data-i]'); if (t && e.target.dataset.k) { const k = e.target.dataset.k; rows[t.dataset.i][k] = ['price', 'min_stock'].includes(k) ? Number(e.target.value) : e.target.value; mark(t.dataset.i); } status(); };
  v.addEventListener('input', onEdit); v.addEventListener('change', onEdit);
  $('#all').onchange = () => { $$('tr[data-i]', v).forEach((t) => { if (!t.classList.contains('hidden')) $('[data-sel]', t).checked = $('#all').checked; }); status(); };
  const filt = () => { const q2 = norm($('#search').value), c = $('#fcat').value, sp = $('#fsup').value; $$('tr[data-i]', v).forEach((t) => t.classList.toggle('hidden', (q2 && !t.dataset.n.includes(q2)) || (c && t.dataset.c !== c) || (sp && t.dataset.s !== sp))); };
  $('#search').oninput = filt; $('#fcat').onchange = filt; $('#fsup').onchange = filt;
  const need = () => { const s2 = sel(); if (!s2.length) throw new Error('Marca primero los artículos (casilla de la izquierda)'); return s2; };
  $('#apct').onclick = () => act(null, async () => { const p2 = Number($('#pct').value); if (!p2) throw new Error('Indica el % (por ejemplo 5 o −3)'); need().forEach((i) => setVal(i, 'price', Math.round(rows[i].price * (1 + p2 / 100) * 10000) / 10000)); status(); });
  $('#acat').onclick = () => act(null, async () => { const c = $('#ncat').value.trim(); if (!c) throw new Error('Escribe la categoría'); need().forEach((i) => setVal(i, 'category', c)); status(); });
  $('#asup').onclick = () => act(null, async () => { const sp = $('#nsup').value; need().forEach((i) => setVal(i, 'supplier_id', sp)); status(); });
  $('#save').onclick = (e) => act(e.target, async () => {
    const items = changed().map((r) => { const o = { id: r.id }; F.forEach((k) => { if (String(r[k] ?? '') !== String(r._o[k] ?? '')) o[k] = r[k]; }); return o; });
    await api('products/bulk-edit', { method: 'PUT', body: { items } });
    toast(`${items.length} artículos guardados. Los escandallos ya usan los precios nuevos.`); route();
  });
  status();
}

async function productoEdit(v, id) {
  const isNew = id === 'nuevo';
  const p = isNew ? { name: '', category: '', unit: 'kg', price: 0, supplier_id: '', min_stock: 0 } : prodById(id);
  if (!p) throw new Error('Artículo no encontrado');
  const formats = isNew ? [] : fmtsOf(p).map((f) => ({ ...f }));
  v.innerHTML = `<h1>${isNew ? 'Nuevo artículo' : esc(p.name)}</h1><form class="card" id="f">
    <div class="row">${fieldHtml({ name: 'name', label: 'Nombre', required: true, help: 'Si compras la misma bebida en 35 cl y 20 cl, crea un artículo para cada tamaño' }, p.name)}
      ${fieldHtml({ name: 'category', label: 'Categoría', list: 'dl-pcat', help: 'Carne, pescado, verdura, bebida, limpieza…' }, p.category)}</div>
    <div class="row">${fieldHtml({ name: 'unit', label: 'Unidad de control', type: 'select', options: BASE_UNITS, help: 'Es la unidad en la que se guarda el stock. Recetas, pedidos e inventarios pueden escribirse en otras (g, ml, cajas…)' }, ['kg', 'l', 'ud'].includes(p.unit) ? p.unit : 'ud')}
      ${fieldHtml({ name: 'supplier_id', label: 'Proveedor habitual', type: 'select', options: [['', '—'], ...S.suppliers.map((x) => [x.id, x.name])] }, p.supplier_id ?? '')}</div>
    <div class="row">${fieldHtml({ name: 'price', label: 'Precio por unidad de control sin IVA (€)', type: 'number', help: 'Se actualiza solo con cada albarán' }, p.price)}
      ${fieldHtml({ name: 'min_stock', label: 'Stock mínimo (en unidad de control)', type: 'number', help: 'Por debajo se avisa para pedir' }, p.min_stock)}</div>
    <h3 style="margin-top:8px">Alérgenos que contiene</h3>
    <p class="small muted">Los platos que lo lleven los heredan automáticamente. Compruébalo con la etiqueta o la ficha técnica del proveedor. ${!isNew ? '<button type="button" class="sm" id="sugg">🧠 Sugerir</button>' : ''} ${!isNew && !p.allergens_checked ? '<span class="pill warn">sin revisar</span>' : ''}</p>
    <div id="algp">${algPicker('palg', splitList(p.allergens))}</div>
    <h3 style="margin-top:14px">Formatos de compra y recuento</h3>
    <p class="small muted">Cómo te llega o cómo lo cuentas: caja de 24 botellas, saco de 25 kg, garrafa de 5 l, barril de 30 l… Escribe cuántas unidades de control trae cada formato. El marcado como habitual sale por defecto en pedidos y recepción.</p>
    <div id="fmts"></div><button type="button" id="addf" class="sm">+ Añadir formato</button>
    <div class="sticky-foot row between" style="margin-top:14px"><div>${!isNew ? '<button type="button" class="danger" id="del">Eliminar artículo</button>' : ''}</div><div class="row"><a class="btn" href="#/productos">Cancelar</a><button class="primary">Guardar</button></div></div></form>`;
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
      // si se pone precio al formato habitual y el artículo no tiene precio, se deduce el precio unitario
      if (inp.dataset.k !== 'name' && f.price > 0 && f.factor > 0 && (f.is_default || formats.length === 1) && !(Number($('[name=price]', v).value) > 0)) $('[name=price]', v).value = Math.round((f.price / f.factor) * 10000) / 10000;
      drawF();
    }));
    $$('#fmts input[type=radio]').forEach((r) => (r.onchange = () => { formats.forEach((f, i) => (f.is_default = i === Number(r.dataset.i) ? 1 : 0)); }));
    $$('#fmts [data-del]').forEach((b) => (b.onclick = () => { formats.splice(b.dataset.del, 1); drawF(); }));
  };
  $('#addf').onclick = () => { formats.push({ name: '', factor: '', price: null, is_default: formats.length ? 0 : 1 }); drawF(); $$('#fmts input[data-k=name]').pop()?.focus(); };
  $('[name=unit]', v).onchange = drawF;
  bindAlgPicker($('#algp'));
  if ($('#sugg')) $('#sugg').onclick = (e) => act(e.target, async () => {
    const r = await api('allergens/suggest', { body: { ids: [p.id] } });
    const row = r.rows[0]; const sug = row ? [...new Set([...row.dict, ...(row.ai || [])])] : [];
    $$('[data-palg]', v).forEach((c) => { c.checked = sug.includes(c.dataset.palg); c.closest('.algc').classList.toggle('on', c.checked); });
    toast(sug.length ? `Sugeridos: ${algNames(sug)}. Revísalo y guarda.` : 'No se le conocen alérgenos. Revísalo y guarda.');
  });
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    act(e.submitter, async () => {
      const d = Object.fromEntries(new FormData(e.target));
      delete d.def;
      Object.keys(d).forEach((k) => { if (!['name', 'category', 'unit', 'supplier_id', 'price', 'min_stock'].includes(k)) delete d[k]; });
      const body = { ...d, price: Number(d.price) || 0, min_stock: Number(d.min_stock) || 0, supplier_id: d.supplier_id ? Number(d.supplier_id) : null,
        allergens: $$('[data-palg]', v).filter((c) => c.checked).map((c) => c.dataset.palg).join(',') || null, allergens_checked: 1,
        formats: formats.filter((f) => String(f.name || '').trim() && Number(f.factor) > 0) };
      if (formats.some((f) => String(f.name || '').trim() && !(Number(f.factor) > 0))) throw new Error('Indica cuántas unidades trae cada formato');
      const r = await api('products' + (isNew ? '' : '/' + id), { method: isNew ? 'POST' : 'PUT', body });
      await reload(); toast('Artículo guardado'); go('#/productos');
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
    { name: 'name', label: 'Nombre', required: true }, { name: 'cif', label: 'CIF / NIF', help: 'Sirve para reconocer al proveedor al escanear sus albaranes y facturas' }, { name: 'contact', label: 'Persona de contacto' },
    { name: 'phone', label: 'Teléfono / WhatsApp', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
    { name: 'order_days', label: 'Días de pedido y reparto', help: 'Ej.: pedir lunes y jueves antes de las 12; reparte al día siguiente' },
    { name: 'notes', label: 'Notas', type: 'textarea' },
  ];
  v.innerHTML = `<div class="row between"><h1>Proveedores</h1><div class="row"><button id="imp">Importar Excel</button><button class="primary" id="add">+ Nuevo proveedor</button></div></div>
    <div class="card"><div class="field"><input id="search" placeholder="Buscar por nombre o CIF…"></div><div class="table-wrap"><table><thead><tr><th>Proveedor</th><th>CIF</th><th>Contacto</th><th>Teléfono</th><th>Días de pedido</th><th class="num">Artículos</th></tr></thead><tbody>
    ${S.suppliers.map((s) => `<tr class="click" data-id="${s.id}" data-n="${esc(norm(s.name + ' ' + (s.cif || '')))}"><td>${esc(s.name)}</td><td>${s.cif ? esc(s.cif) : '<span class="muted small">falta</span>'}</td><td>${esc(s.contact || '')}</td><td>${esc(s.phone || '')}</td><td>${esc(s.order_days || '')}</td><td class="num">${S.products.filter((p) => p.supplier_id === s.id).length}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Sin proveedores. Impórtalos desde Excel o créalos uno a uno.</td></tr>'}
    </tbody></table></div></div>`;
  $('#search').oninput = () => { const q2 = norm($('#search').value); $$('tr[data-n]', v).forEach((tr) => tr.classList.toggle('hidden', q2 && !tr.dataset.n.includes(q2))); };
  $('#imp').onclick = () => importWizard({
    title: 'Importar proveedores', sheetHint: ['proveedor'],
    help: 'Sube un Excel o CSV con tus proveedores. Si ya existe uno con el mismo CIF (o, si no hay CIF, con el mismo nombre), se actualizan sus datos; si no, se crea. Las columnas vacías no borran lo que ya había.',
    cols: [['name', 'Nombre o razón social', true, ['proveedor', 'razon social', 'nombre', 'empresa']], ['cif', 'CIF / NIF', false], ['contact', 'Persona de contacto', false], ['phone', 'Teléfono', false], ['email', 'Email', false], ['order_days', 'Días de pedido y reparto', false], ['notes', 'Notas', false]],
    template: ['plantilla_proveedores.csv', [['Proveedor', 'CIF', 'Contacto', 'Teléfono', 'Email', 'Días de pedido', 'Notas'],
      ['Pescados Mar SL', 'B12345678', 'Juan', '600111222', 'pedidos@pescadosmar.es', 'Pedir L-X-V antes de 12h', ''], ['Bebidas SL', 'B87654321', 'Ana', '600333444', '', 'Martes', 'Envases retornables']]],
    send: async (items) => { const r = await api('suppliers/bulk', { body: { items } }); await reload(); return `Proveedores: ${r.created} nuevos, ${r.updated} actualizados`; },
  }).then(() => route());
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
const PANEL_TABS = [['resumen', 'Resumen'], ['semana', 'Resumen semanal'], ['ventas', 'Ventas'], ['compras', 'Compras'], ['mermas', 'Mermas y personal'], ['descuadres', 'Descuadres'], ['foodcost', 'Food cost y platos'], ['caja', 'Caja']];
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
  if (tab === 'semana') return resumenSemanal(v, q);
  const d = await api(`stats/${tab}?from=${from}&to=${to}${grp ? '&group=' + grp : ''}`);
  const L = { labels: d.labels, group: d.group };
  let body = '';
  if (tab === 'ventas') {
    body = `<div class="grid k">${kpi('Ventas sin IVA (Qamarero)', eur(d.total_revenue), '')}${kpi('Caja real cobrada', eur(d.total_cash), 'con IVA')}${kpi('Comensales', num(d.total_covers, 0), '')}${kpi('Ticket medio', d.avg_ticket ? eur(d.avg_ticket) : '—', 'caja ÷ comensales')}</div>
      ${card('Ventas por ' + ({ day: 'día', week: 'semana', month: 'mes' })[d.group], chart({ ...L, series: [{ name: 'Qamarero (sin IVA)', values: d.revenue, color: 'var(--s1)' }, { name: 'Caja real (sin IVA)', values: d.cash, color: 'var(--s2)' }] }), 'Si las dos barras no coinciden, hay ventas sin pasar por el TPV o cobros sin registrar.')}
      <div class="grid two">${card('Ventas por categoría', hbars(d.categories, 'name', 'value'))}
      ${card('Platos más vendidos', tbl(d.dishes.slice(0, 15), [['Plato', 'name'], ['Raciones', 'units', (x) => num(x, 1)], ['Ventas', 'revenue', eur]], 'Importa ventas de Qamarero para ver este ranking'))}</div>`;
  } else if (tab === 'compras') {
    body = `<div class="grid k">${kpi('Compras del periodo', eur(d.total), 'sin IVA, según albaranes')}${kpi('Proveedores', num(d.suppliers.length, 0), '')}${kpi('Subidas de precio', num(d.prices.filter((x) => x.new_price > x.old_price).length, 0), 'artículos que han subido')}</div>
      ${card('Compras por ' + ({ day: 'día', week: 'semana', month: 'mes' })[d.group], chart({ ...L, series: [{ name: 'Compras', values: d.purchases, color: 'var(--s1)' }] }))}
      <div class="grid two">${card('Por proveedor', hbars(d.suppliers, 'name', 'value'))}${card('Por categoría de artículo', hbars(d.categories, 'name', 'value'))}</div>
      <div class="grid two">${card('Artículos en los que más se gasta', tbl(d.products, [['Artículo', 'name'], ['Cantidad', 'qty', (x, r) => num(x, 2) + ' ' + r.unit], ['Precio medio', 'avg_price', eur], ['Importe', 'value', eur]], 'Sin compras'))}
      ${card('Cambios de precio', tbl(d.prices, [['Artículo', 'name'], ['Fecha', 'created_at', fdate], ['Antes', 'old_price', eur], ['Ahora', 'new_price', eur], ['Cambio', 'new_price', (x, r) => { const c = r.old_price ? ((x - r.old_price) / r.old_price) * 100 : 0; return `<span class="${c > 0 ? 'txt-bad' : 'txt-ok'}">${c > 0 ? '+' : ''}${num(c, 1)} %</span>`; }]], 'Sin cambios de precio'))}</div>`;
  } else if (tab === 'mermas') {
    const tw = d.waste.reduce((a, b) => a + b, 0), ts = d.staff.reduce((a, b) => a + b, 0);
    body = `<div class="grid k">${kpi('Mermas', eur(tw), '', tw > 0 ? 'bad' : '')}${kpi('Consumo de personal', eur(ts), '')}${kpi('Total', eur(tw + ts), '')}</div>
      ${card('Evolución', chart({ ...L, series: [{ name: 'Mermas', values: d.waste, color: 'var(--s1)' }, { name: 'Personal', values: d.staff, color: 'var(--s2)' }] }))}
      <div class="grid two">${card('Mermas por motivo', hbars(d.reasons.filter((r) => r.type === 'merma'), 'name', 'value'))}${card('Consumo de personal por motivo', hbars(d.reasons.filter((r) => r.type === 'consumo_personal'), 'name', 'value'))}</div>
      <div class="grid two">${card('Artículos que más se tiran', tbl(d.products, [['Artículo', 'name'], ['Cantidad', 'qty', (x, r) => num(x, 2) + ' ' + r.unit], ['Valor', 'value', eur]], 'Sin mermas'))}
      ${card('Por persona que registra', tbl(d.users, [['Persona', 'name'], ['Registros', 'n', (x) => num(x, 0)], ['Mermas', 'waste', eur], ['Personal', 'staff', eur]], 'Sin registros'), 'Quien más registra no es quien más tira: es quien apunta. Úsalo para ver quién no registra.')}</div>`;
  } else if (tab === 'foodcost') {
    const CL = { estrella: ['ok', 'Estrella', 'Se vende mucho y deja buen margen: cuídalo y destácalo'], vaca: ['warn', 'Caballo de batalla', 'Se vende mucho pero deja poco margen: revisa precio o ración'], puzzle: ['warn', 'Enigma', 'Deja buen margen pero se vende poco: promociónalo o cambia su posición en la carta'], perro: ['bad', 'Perro', 'Se vende poco y deja poco: candidato a salir de la carta'], 'sin ventas': ['', 'Sin ventas', ''] };
    body = `${card('Food cost real y teórico', chart({ ...L, type: 'line', fmt: (x) => pct(x), axisFmt: (x) => num(x, 0) + ' %', ref: d.target, series: [{ name: 'Real (con mermas, personal y descuadres)', values: d.fc_real, color: 'var(--s1)' }, { name: 'Teórico (según escandallos)', values: d.fc_theoretical, color: 'var(--s2)' }] }), 'La distancia entre las dos líneas es dinero que se pierde sin explicación: raciones grandes, género que desaparece o escandallos desajustados.')}
      ${card('Ingeniería de menú', `<div class="row small" style="margin-bottom:10px">${Object.entries(CL).filter(([k]) => k !== 'sin ventas').map(([, [c, t, h]]) => `<span><span class="pill ${c}">${t}</span> ${esc(h)}</span>`).join('')}</div>` +
        tbl(d.dishes, [['Plato', 'name'], ['Coste', 'cost', eur], ['PVP', 'pvp', eur], ['Food cost', 'fc', (x) => `<span class="${x > d.target + 3 ? 'txt-bad' : x <= d.target ? 'txt-ok' : 'txt-warn'}">${pct(x)}</span>`], ['Margen ud', 'margin', eur], ['Vendidas', 'units', (x) => num(x, 1)], ['Margen total', 'contribution', eur], ['', 'class', (x) => `<span class="pill ${CL[x][0]}">${CL[x][1]}</span>`]], 'No hay platos con escandallo'),
        `Margen medio ponderado por ración: <b>${eur(d.avg_margin)}</b>. Un plato es "popular" si vende al menos el 70 % de la media.`)}`;
  } else if (tab === 'descuadres') {
    const q3 = (x, r) => `${num(x, 2)} ${esc(r.unit)}`;
    body = `<div class="grid k">${kpi('Descuadre en el periodo', eur(d.total_descuadre), d.total_descuadre < 0 ? 'producto que falta y nada explica' : 'sobra producto', d.total_descuadre < -1 ? 'bad' : '')}
        ${kpi('Artículos contados', `${d.n_counted} de ${d.n_moved}`, 'con movimiento en el periodo')}</div>
      ${card('Dónde se va el género', d.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Artículo</th><th class="num">Entró</th><th class="num">Vendido (escandallo)</th><th class="num">Mermas + personal</th><th class="num">En producción</th><th class="num">Descuadre</th><th class="num">% s/ consumo</th><th class="num">Valor</th></tr></thead><tbody>
        ${d.rows.map((r) => `<tr><td>${esc(r.name)}<div class="small muted">último recuento ${fdate(r.last_count)}</div></td><td class="num">${q3(r.entradas, r)}</td><td class="num">${q3(r.ventas, r)}</td><td class="num">${q3(r.mermas + r.personal, r)}</td><td class="num">${r.produccion_uso ? q3(r.produccion_uso, r) : '—'}</td>
        <td class="num ${r.descuadre < 0 ? 'txt-bad' : ''}">${r.descuadre > 0 ? '+' : ''}${q3(r.descuadre, r)}</td><td class="num">${r.pct == null ? '—' : `<span class="${r.pct < -5 ? 'txt-bad' : r.pct < -2 ? 'txt-warn' : ''}">${pct(r.pct)}</span>`}</td><td class="num ${r.descuadre_valor < 0 ? 'txt-bad' : ''}">${eur(r.descuadre_valor)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">No hay recuentos de inventario en este periodo. Haz inventarios (semanales en lo caro) para ver dónde se va el género.</div>',
        'Descuadre = lo contado frente a lo que debería haber según entradas, ventas (por escandallo), mermas, comidas de personal y producción. Negativo: falta género que nadie ha registrado (raciones más grandes, errores de escandallo, consumos sin apuntar o producto que desaparece). Un % pequeño es normal; más de un 5 % merece mirarse.')}
      ${card('Qué conviene contar', tbl(d.to_count, [['Artículo', 'name'], ['Consumo en el periodo', 'consumo', (x, r) => q3(x, r)], ['Valor consumido', 'consumo_valor', eur], ['Último recuento', 'last_count', (x) => (x ? fdate(x) : 'nunca')]], 'Todo lo importante está contado en los últimos 14 días'),
        'Los artículos que más dinero mueven y llevan más de 14 días sin contarse. <a href="#/stock?tab=inventario">Hacer inventario →</a>')}`;
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
async function resumenSemanal(v, q) {
  const d = await api('summary' + (q.get('end') ? '?end=' + q.get('end') : ''));
  const c = d.cur, p = d.prev;
  const shift = (days) => { const t = new Date(d.to + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10); };
  const delta = (a, b, good = 'up', fmt = eur) => { if (b == null || !isFinite(b) || b === 0 || a == null) return ''; const ch = ((a - b) / Math.abs(b)) * 100; const isGood = good === 'up' ? ch >= 0 : ch <= 0; return `<span class="${Math.abs(ch) < 1 ? 'muted' : isGood ? 'txt-ok' : 'txt-bad'}">${ch > 0 ? '▲' : '▼'} ${num(Math.abs(ch), 0)} % vs semana anterior (${fmt(b)})</span>`; };
  const k = (l, val, sub) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${val}</div><div class="s">${sub}</div></div>`;
  const ap = d.appcc.expected ? Math.round((d.appcc.done / d.appcc.expected) * 100) : null;
  v.innerHTML = `<h1 class="no-print">Panel de control</h1><div class="tabs no-print">${PANEL_TABS.map(([kk, t]) => `<a href="#/panel?tab=${kk}" class="${kk === 'semana' ? 'on' : ''}">${t}</a>`).join('')}</div>
    <div class="row between no-print" style="margin-bottom:12px"><div class="row"><a class="btn sm" href="#/panel?tab=semana&end=${shift(-7)}">‹ Semana anterior</a>${d.to < today() ? `<a class="btn sm" href="#/panel?tab=semana&end=${shift(7)}">Semana siguiente ›</a>` : ''}</div><button id="pr">🖨 Imprimir / PDF</button></div>
    <div class="card report"><div class="print-only"><b>${esc(S.settings.restaurant_name)}</b></div><h2>Semana del ${fdate(d.from)} al ${fdate(d.to)}</h2>
    <div class="grid k">
      ${k('Ventas sin IVA', eur(c.revenue), delta(c.revenue, p.revenue))}
      ${k('Caja real cobrada', eur(c.cash.total), delta(c.cash.total, p.cash.total))}
      ${k('Food cost real', pct(c.food_cost_real), delta(c.food_cost_real, p.food_cost_real, 'down', pct))}
      ${k('Mermas', eur(c.waste), delta(c.waste, p.waste, 'down'))}
      ${k('Consumo de personal', eur(c.staff), delta(c.staff, p.staff, 'down'))}
      ${k('Compras', eur(c.purchases), delta(c.purchases, p.purchases, 'down'))}
      ${k('Descuadre de caja', c.cash.days_with_pos ? eur(c.cash.diff) : '—', c.cash.days_with_pos ? `${c.cash.days_with_pos} días con cierre de Qamarero` : 'sin cierres anotados')}
      ${k('Resultado estimado', eur(c.result), delta(c.result, p.result))}
    </div>
    <div class="grid two" style="margin-top:14px">
      <div><h3>Platos más vendidos</h3>${tbl(d.top, [['Plato', 'name'], ['Raciones', 'units', (x) => num(x, 1)], ['Ventas', 'revenue', eur]], 'Sin ventas importadas')}</div>
      <div><h3>Mayores descuadres</h3>${tbl(d.variance, [['Artículo', 'name'], ['Descuadre', 'descuadre', (x, r) => `${num(x, 2)} ${esc(r.unit)}`], ['Valor', 'descuadre_valor', eur]], 'Sin inventarios esta semana')}</div>
      <div><h3>Subidas de precio</h3>${tbl(d.prices, [['Artículo', 'name'], ['Antes', 'old_price', eur], ['Ahora', 'new_price', eur], ['', 'new_price', (x, r) => `<span class="${x > r.old_price ? 'txt-bad' : 'txt-ok'}">${x > r.old_price ? '+' : ''}${num(((x - r.old_price) / r.old_price) * 100, 1)} %</span>`]], 'Sin cambios de precio')}</div>
      <div><h3>APPCC</h3>${ap == null ? '<div class="empty small">Sin equipos configurados</div>' : `<p>Temperaturas anotadas: <b>${d.appcc.done} de ${d.appcc.expected}</b> (${ap} %)${d.appcc.out_of_range ? ` · <span class="txt-bad">${d.appcc.out_of_range} fuera de rango</span>` : ''}</p>`}</div>
    </div></div>`;
  $('#pr').onclick = () => window.print();
}

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
  ['Compras', [['pedidos.ver', 'Ver pedidos'], ['pedidos.crear', 'Hacer pedidos (quedan pendientes de aprobar)'], ['pedidos.aprobar', 'Aprobar pedidos y enviarlos al proveedor'], ['recepcion.ver', 'Ver albaranes recibidos'], ['recepcion.crear', 'Recibir mercancía y escanear albaranes'], ['recepcion.anular', 'Anular albaranes']]],
  ['Mermas y personal', [['mermas.registrar', 'Registrar mermas y consumo de personal'], ['mermas.ver_todas', 'Ver los registros de todos (si no, solo los suyos)'], ['mermas.borrar', 'Borrar registros de otros']]],
  ['Stock y cocina', [['stock.ver', 'Ver el stock'], ['inventario.hacer', 'Hacer inventarios'], ['escandallos.ver', 'Ver fichas técnicas (escandallos)'], ['escandallos.editar', 'Crear y cambiar platos de la carta, elaboraciones y escandallos'], ['produccion.registrar', 'Registrar producción de elaboraciones (bechamel, sofrito…)']]],
  ['APPCC', [['appcc.registrar', 'Apuntar temperaturas, limpiezas y controles del día'], ['appcc.gestionar', 'Configurar equipos y plan de limpieza, ver el histórico e informe para inspección']]],
  ['Turnos', [['turnos.ver', 'Ver el cuadrante de todo el equipo (su propio horario lo ve siempre)'], ['turnos.gestionar', 'Hacer y publicar el cuadrante, personal y turnos tipo']]],
  ['Administración', [['productos.editar', 'Existencias (artículos), formatos y proveedores'], ['ventas.gestionar', 'Importar y vincular ventas de Qamarero'], ['gastos.gestionar', 'Gastos fijos']]],
];
// Cualquier permiso que exista en el servidor y no esté arriba sale igualmente, en "Otros", para que nunca quede sin casilla.
function permGroupsFor(all) {
  const known = new Set(PERM_GROUPS.flatMap(([, ps]) => ps.map(([k]) => k)));
  const rest = (all || []).filter((k) => !known.has(k));
  return rest.length ? [...PERM_GROUPS, ['Otros', rest.map((k) => [k, k])]] : PERM_GROUPS;
}
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
    <div class="row">${fieldHtml({ name: 'phone', label: 'Móvil (WhatsApp)', type: 'tel', help: 'Para avisarle, por ejemplo, de pedidos pendientes de aprobar' }, u.phone || '')}${fieldHtml({ name: 'email', label: 'Email', type: 'email' }, u.email || '')}</div>
    <div class="row">${fieldHtml({ name: 'password', label: isNew ? 'Contraseña inicial (mín. 6)' : 'Nueva contraseña (vacío = no cambiar)', attrs: `minlength="6" ${isNew ? 'required' : ''} autocomplete="new-password"` })}
      ${fieldHtml({ name: 'active', label: 'Estado', type: 'select', options: [['1', 'Activo'], ['0', 'De baja (no puede entrar)']], attrs: me ? 'disabled' : '' }, String(u.active))}</div>
    <label class="check"><input type="checkbox" id="super" ${u.is_super ? 'checked' : ''} ${me ? 'disabled' : ''}> <span><b>Superusuario</b> — lo puede todo, incluidos usuarios, permisos y ajustes</span></label>
    <div id="permbox" style="margin-top:14px">
      <div class="row" style="margin-bottom:10px"><span class="small muted">Empezar desde plantilla:</span>${Object.keys(res.templates).map((t) => `<button type="button" class="sm" data-tpl="${t}">${ROLE_NAMES[t]}</button>`).join('')}<button type="button" class="sm" data-tpl="">Ninguno</button></div>
      <div class="grid two">${permGroupsFor(res.perms).map(([g, ps]) => `<div class="permgroup"><h3>${esc(g)}</h3>${ps.map(([k, t]) => `<label class="check"><input type="checkbox" data-p="${k}" ${u.perms.includes(k) ? 'checked' : ''}> <span>${esc(t)}</span></label>`).join('')}</div>`).join('')}</div>
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
      const body = { name: fd.name, phone: fd.phone, email: fd.email, perms, is_super: $('#super').checked, role: $('#super').checked ? 'direccion' : tpl || (perms.includes('panel.ver') ? 'direccion' : perms.includes('pedidos.crear') ? 'cocina' : 'sala') };
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
      await restart({ supplier_id: r.supplier_id, supplier_name: r.supplier_name, supplier_cif: r.supplier_cif, doc_type: r.doc_type, delivery_note: r.delivery_note, date: r.date, ocr_id: r.ocr_id, total_read: r.total_without_vat,
        notes: '', lines });
    } catch (e) { toast(e.message, true); window.ocrSlot(v, restart); }
  });
};

// ---------- APPCC ----------
const EQUIP_DEFAULTS = [
  { name: 'Cámara de refrigeración', kind: 'refrigeracion', min_temp: 0, max_temp: 5 },
  { name: 'Cámara de congelación', kind: 'congelacion', min_temp: null, max_temp: -18 },
  { name: 'Mesa fría / bajo mostrador', kind: 'refrigeracion', min_temp: 0, max_temp: 5 },
  { name: 'Vitrina expositora', kind: 'refrigeracion', min_temp: 0, max_temp: 5 },
  { name: 'Botellero', kind: 'refrigeracion', min_temp: 2, max_temp: 8 },
];
const TASK_DEFAULTS = [
  ['Superficies y tablas de corte', 'Cocina', 'diaria', 'Desengrasante + desinfectante apto alimentario'], ['Suelos de cocina', 'Cocina', 'diaria', 'Friegasuelos desengrasante'],
  ['Fogones, plancha y freidoras (exterior)', 'Cocina', 'diaria', 'Desengrasante'], ['Cubos de basura', 'Cocina', 'diaria', 'Desinfectante'],
  ['Barra, grifos de cerveza y cafetera', 'Barra', 'diaria', ''], ['Aseos', 'Sala', 'diaria', 'Desinfectante'],
  ['Interior de cámaras y neveras', 'Cocina', 'semanal', 'Desinfectante apto alimentario'], ['Campana y filtros', 'Cocina', 'semanal', 'Desengrasante'],
  ['Cambio de aceite de freidoras', 'Cocina', 'semanal', ''], ['Almacén y estanterías', 'Almacén', 'mensual', ''], ['Desagües y sumideros', 'Cocina', 'mensual', ''],
  ['Revisión de plagas (trampas y cebos)', 'General', 'mensual', 'Empresa DDD'],
];
const KIND_N = { refrigeracion: 'Refrigeración', congelacion: 'Congelación', caliente: 'Mantenimiento en caliente', otro: 'Otro' };
const rangeTxt = (e) => (e.min_temp != null && e.max_temp != null ? `${num(e.min_temp, 1)} a ${num(e.max_temp, 1)} °C` : e.max_temp != null ? `≤ ${num(e.max_temp, 1)} °C` : e.min_temp != null ? `≥ ${num(e.min_temp, 1)} °C` : 'sin rango');

VIEWS.appcc = async (v, _id, q) => {
  const tab = q.get('tab') || 'hoy';
  const tabs = [['hoy', 'Hoy'], ['caducidades', 'Caducidades'], ...(can('appcc.gestionar') ? [['informe', 'Informe para inspección'], ['config', 'Configuración']] : [])];
  const head = `<h1>APPCC</h1><div class="tabs no-print">${tabs.map(([k, t]) => `<a href="#/appcc?tab=${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>`;
  if (tab === 'hoy') {
    const t = await api('appcc/today');
    const due = t.tasks.filter((x) => x.due), okT = t.tasks.filter((x) => !x.due);
    v.innerHTML = head + `
      ${!t.equipment.length && !t.tasks.length ? `<div class="card">Aún no hay cámaras ni plan de limpieza. ${can('appcc.gestionar') ? '<a href="#/appcc?tab=config">Configúralo en un minuto →</a>' : 'Pide al responsable que lo configure.'}</div>` : ''}
      ${t.equipment.length ? `<div class="card"><h3>Temperaturas · ${fdate(t.day)}</h3><p class="small muted" style="margin-top:-6px">Anota la temperatura de cada equipo por la mañana y por la tarde. Si está fuera de rango, la app pide la medida correctora.</p>
        <div class="table-wrap"><table><thead><tr><th>Equipo</th><th>Rango</th><th>Mañana</th><th>Tarde</th></tr></thead><tbody>
        ${t.equipment.map((e) => `<tr><td><b>${esc(e.name)}</b><div class="small muted">${KIND_N[e.kind] || ''}</div></td><td class="small">${rangeTxt(e)}</td>
          ${['mañana', 'tarde'].map((sh) => { const r = e.readings.filter((x) => x.shift === sh).pop();
            return `<td>${r ? `<span class="${r.ok ? 'txt-ok' : 'txt-bad'}">${num(r.temp, 1)} °C</span> <span class="small muted">${esc(r.user_name || '')}</span>${r.action ? `<div class="small">${esc(r.action)}</div>` : ''}`
              : `<div class="row" style="gap:6px;flex-wrap:nowrap"><input class="qty" type="number" step="0.1" inputmode="decimal" data-eq="${e.id}" data-sh="${sh}" placeholder="°C" style="width:80px"><button class="sm primary" data-save="${e.id}|${sh}">Anotar</button></div>`}</td>`; }).join('')}</tr>`).join('')}
        </tbody></table></div></div>` : ''}
      ${t.tasks.length ? `<div class="card"><h3>Limpieza pendiente</h3>${due.length ? due.map((x) => `<div class="row between task"><div><b>${esc(x.name)}</b> <span class="pill">${x.frequency}</span><div class="small muted">${esc([x.zone, x.product].filter(Boolean).join(' · '))}${x.last_day ? ` · última vez ${fdate(x.last_day)}` : ' · nunca registrada'}</div></div><button class="primary sm" data-clean="${x.id}">✓ Hecho</button></div>`).join('') : '<div class="empty small">Todo al día. 👍</div>'}
        ${okT.length ? `<details style="margin-top:10px"><summary class="small muted">Al día (${okT.length})</summary>${okT.map((x) => `<div class="small" style="padding:4px 0">✓ ${esc(x.name)} <span class="muted">· ${fdate(x.last_day)}</span></div>`).join('')}</details>` : ''}</div>` : ''}
      ${t.expiring.length ? `<div class="card" style="border-color:var(--accent)"><h3>Caducan en 3 días o menos</h3>${tbl(t.expiring, [['Artículo', 'name', (x, r) => `${esc(x)}${r.lot ? `<div class="small muted">lote ${esc(r.lot)}</div>` : ''}`], ['Caduca', 'expiry', (x, r) => `<span class="${r.days_left < 0 ? 'txt-bad' : 'txt-warn'}">${fdate(x)}${r.days_left < 0 ? ' (caducado)' : r.days_left === 0 ? ' (hoy)' : ''}</span>`]], '')}<a href="#/appcc?tab=caducidades">Gestionar caducidades →</a></div>` : ''}`;
    $$('[data-save]', v).forEach((b) => (b.onclick = () => act(b, async () => {
      const [eq, sh] = b.dataset.save.split('|'), inp = $(`[data-eq="${eq}"][data-sh="${sh}"]`, v), temp = inp.value;
      if (temp === '') throw new Error('Escribe la temperatura');
      const e = t.equipment.find((x) => x.id === Number(eq)), n = Number(temp);
      const out = (e.min_temp != null && n < e.min_temp) || (e.max_temp != null && n > e.max_temp);
      let action = '';
      if (out) {
        const r = await modal(`<h2>⚠ ${esc(e.name)}: ${num(n, 1)} °C</h2><p>Está fuera del rango (${rangeTxt(e)}). Anota qué se ha hecho:</p>
          <div class="field"><textarea id="act" required placeholder="Regular el termostato y volver a medir en 1 h · trasladar el género a otra cámara · desechar el producto afectado · avisar al técnico…"></textarea></div><div class="actions"><button data-close>Cancelar</button><button class="primary" value="ok">Guardar</button></div>`);
        if (!r) return;
        action = $('#act', $('#modal-form')).value;
      }
      await api('appcc/temp', { body: { equipment_id: Number(eq), temp: n, shift: sh, action } });
      toast(out ? 'Anotado con medida correctora' : 'Temperatura anotada'); route();
    })));
    $$('[data-clean]', v).forEach((b) => (b.onclick = () => act(b, async () => { await api('appcc/clean', { body: { task_id: Number(b.dataset.clean) } }); toast('Limpieza registrada'); route(); })));
    return;
  }
  if (tab === 'caducidades') {
    const list = await api('appcc/expiry?days=' + (q.get('d') || 7));
    v.innerHTML = head + `<div class="card"><div class="row between"><p class="small muted" style="margin:0">Lotes con caducidad anotada en recepción que vencen pronto. Márcalos cuando se hayan gastado o retirado. Si hay que tirarlos, regístralo como merma.</p>
      <select id="dd" style="width:auto">${[3, 7, 15, 30].map((x) => `<option value="${x}" ${String(x) === (q.get('d') || '7') ? 'selected' : ''}>próximos ${x} días</option>`).join('')}</select></div>
      ${tbl(list, [['Artículo', 'name', (x, r) => `<b>${esc(x)}</b>${r.lot ? `<div class="small muted">lote ${esc(r.lot)}</div>` : ''}`], ['Proveedor', 'supplier', (x, r) => `${esc(x || '')}<div class="small muted">recibido ${fdate(r.receipt_date)}</div>`],
        ['Cantidad', 'qty', (x, r) => `${num(x, 2)} ${esc(r.unit)}`], ['Caduca', 'expiry', (x, r) => `<span class="${r.days_left < 0 ? 'txt-bad' : r.days_left <= 2 ? 'txt-warn' : ''}">${fdate(x)}</span><div class="small muted">${r.days_left < 0 ? `hace ${-r.days_left} días` : r.days_left === 0 ? 'hoy' : `en ${r.days_left} días`}</div>`],
        ['', 'id', (x, r) => `<div class="row" style="gap:6px;flex-wrap:nowrap;justify-content:flex-end"><a class="btn sm" href="#/mermas">Merma</a><button class="sm" data-done="${x}">Gastado / retirado</button></div>`]], 'Nada caduca en este plazo. 👍')}</div>`;
    $('#dd').onchange = () => go('#/appcc?tab=caducidades&d=' + $('#dd').value);
    $$('[data-done]', v).forEach((b) => (b.onclick = () => act(b, async () => { await api('appcc/expiry/' + b.dataset.done, { body: {} }); route(); })));
    return;
  }
  if (tab === 'config') {
    const [eq, tasks] = await Promise.all([api('appcc/equipment'), api('appcc/tasks')]);
    v.innerHTML = head + `<div class="card"><div class="row between"><h3 style="margin:0">Equipos (temperaturas)</h3><div class="row">${!eq.length ? '<button id="defeq">Añadir los habituales</button>' : ''}<button class="primary" id="addeq">+ Equipo</button></div></div>
      ${tbl(eq, [['Equipo', 'name', (x) => `<b>${esc(x)}</b>`], ['Tipo', 'kind', (x) => KIND_N[x] || x], ['Rango correcto', 'id', (x, r) => rangeTxt(r)], ['', 'id', (x) => `<button class="sm" data-eqe="${x}">Editar</button> <button class="sm danger" data-eqd="${x}">✕</button>`]], 'Sin equipos')}
      <p class="small muted">Rangos habituales: refrigeración 0 a 5 °C (pescado fresco mejor 0 a 2 °C), congelación −18 °C o menos, mantenimiento en caliente 65 °C o más. Ajústalos a lo que diga tu plan APPCC.</p></div>
      <div class="card"><div class="row between"><h3 style="margin:0">Plan de limpieza</h3><div class="row">${!tasks.length ? '<button id="deftk">Añadir un plan básico</button>' : ''}<button class="primary" id="addtk">+ Tarea</button></div></div>
      ${tbl(tasks, [['Tarea', 'name', (x) => `<b>${esc(x)}</b>`], ['Zona', 'zone'], ['Frecuencia', 'frequency'], ['Producto / método', 'product'], ['', 'id', (x) => `<button class="sm" data-tke="${x}">Editar</button> <button class="sm danger" data-tkd="${x}">✕</button>`]], 'Sin tareas')}</div>`;
    const EF = [{ name: 'name', label: 'Nombre', required: true }, { name: 'kind', label: 'Tipo', type: 'select', options: Object.entries(KIND_N) }, { name: 'min_temp', label: 'Temperatura mínima (°C)', type: 'number' }, { name: 'max_temp', label: 'Temperatura máxima (°C)', type: 'number' }];
    const TF = [{ name: 'name', label: 'Tarea', required: true }, { name: 'zone', label: 'Zona' }, { name: 'frequency', label: 'Frecuencia', type: 'select', options: [['diaria', 'Diaria'], ['semanal', 'Semanal'], ['mensual', 'Mensual']] }, { name: 'product', label: 'Producto / método' }];
    const edit = async (path, F, row) => { const d = await formModal(row ? 'Editar' : 'Nuevo', F, row || {}); if (!d) return; await api(`appcc/${path}${row ? '/' + row.id : ''}`, { method: row ? 'PUT' : 'POST', body: d }); route(); };
    $('#addeq').onclick = () => act(null, () => edit('equipment', EF));
    $('#addtk').onclick = () => act(null, () => edit('tasks', TF));
    if ($('#defeq')) $('#defeq').onclick = (e) => act(e.target, async () => { await api('appcc/equipment', { body: { items: EQUIP_DEFAULTS } }); toast('Equipos añadidos: revisa los nombres y rangos'); route(); });
    if ($('#deftk')) $('#deftk').onclick = (e) => act(e.target, async () => { await api('appcc/tasks', { body: { items: TASK_DEFAULTS.map(([name, zone, frequency, product]) => ({ name, zone, frequency, product })) } }); toast('Plan básico añadido: adáptalo a tu local'); route(); });
    $$('[data-eqe]', v).forEach((b) => (b.onclick = () => act(null, () => edit('equipment', EF, eq.find((x) => x.id === Number(b.dataset.eqe))))));
    $$('[data-tke]', v).forEach((b) => (b.onclick = () => act(null, () => edit('tasks', TF, tasks.find((x) => x.id === Number(b.dataset.tke))))));
    $$('[data-eqd],[data-tkd]', v).forEach((b) => (b.onclick = () => act(b, async () => { if (!(await confirmModal('¿Quitar?', 'Quitar'))) return; await api(`appcc/${b.dataset.eqd ? 'equipment/' + b.dataset.eqd : 'tasks/' + b.dataset.tkd}`, { method: 'DELETE' }); route(); })));
    return;
  }
  if (tab === 'informe') {
    const P = periods(), from = q.get('from') || P.mes[1], to = q.get('to') || P.mes[2];
    const r = await api(`appcc/report?from=${from}&to=${to}`);
    v.innerHTML = head + `<div class="no-print">${periodBar('appcc', from, to, '<button id="pr">🖨 Imprimir / PDF</button>')}</div>
      <div class="card report"><div class="print-only"><b>${esc(r.restaurant)}</b></div><h2>Registros APPCC</h2><p class="small muted">Del ${fdate(r.from)} al ${fdate(r.to)}</p>
      <h3>Control de temperaturas</h3>${tbl(r.temps, [['Día', 'day', fdate], ['Turno', 'shift'], ['Equipo', 'equipment'], ['Rango', 'equipment', (x, t) => rangeTxt(t)], ['Temp.', 'temp', (x, t) => `<span class="${t.ok ? '' : 'txt-bad'}">${num(x, 1)} °C</span>`], ['Medida correctora', 'action', (x) => esc(x || '')], ['Responsable', 'user_name']], 'Sin registros')}
      <h3>Limpieza y desinfección</h3>${tbl(r.cleaning, [['Día', 'day', fdate], ['Tarea', 'task'], ['Zona', 'zone'], ['Producto / método', 'product'], ['Responsable', 'user_name']], 'Sin registros')}
      <h3>Recepción de mercancías</h3>${tbl(r.receptions, [['Día', 'receipt_date', fdate], ['Proveedor', 'supplier'], ['Documento', 'delivery_note', (x, t) => `${t.doc_type === 'factura' ? 'Factura' : 'Albarán'} ${esc(x || '')}`], ['Temp.', 'rec_temp', (x) => (x == null ? '—' : num(x, 1) + ' °C')], ['Control', 'rec_check', (x) => (x ? '✓ correcto' : x === 0 ? 'incidencia' : '—')], ['Lotes / caducidades', 'lines', (x) => `<span class="small">${esc(x || '')}</span>`], ['Recibió', 'user_name']], 'Sin recepciones')}</div>`;
    bindPeriod(v, (f, t2) => `#/appcc?tab=informe&from=${f}&to=${t2}`);
    $('#pr').onclick = () => window.print();
  }
};

// ---------- Registro de actividad ----------
VIEWS.actividad = async (v, _id, q) => {
  const P = periods();
  const from = q.get('from') || iso(new Date(Date.now() - 30 * 86400000)), to = q.get('to') || today();
  const users = (await api('users')).users;
  const params = new URLSearchParams({ from, to });
  ['user', 'entity', 'q'].forEach((k) => q.get(k) && params.set(k, q.get(k)));
  const list = await api('audit?' + params);
  const ents = ['artículo', 'proveedor', 'plato', 'recepción', 'merma / consumo', 'caja', 'inventario', 'pedido', 'usuario', 'ventas', 'gasto fijo', 'ajustes', 'copia de seguridad', 'sesión'];
  const url = (o) => { const n = new URLSearchParams({ from, to }); ['user', 'entity', 'q'].forEach((k) => q.get(k) && n.set(k, q.get(k))); Object.entries(o).forEach(([k, x]) => (x ? n.set(k, x) : n.delete(k))); return '#/actividad?' + n; };
  void P;
  v.innerHTML = `<h1>Registro de actividad</h1>
    <div class="card"><div class="row">
      <div class="field"><label>Desde</label><input type="date" id="f" value="${from}"></div><div class="field"><label>Hasta</label><input type="date" id="t" value="${to}"></div>
      <div class="field"><label>Persona</label><select id="u"><option value="">Todas</option>${users.map((u) => `<option value="${u.id}" ${String(u.id) === q.get('user') ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Qué</label><select id="e"><option value="">Todo</option>${ents.map((x) => `<option ${x === q.get('entity') ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
      <div class="field" style="flex:2 1 200px"><label>Buscar</label><input id="s" value="${esc(q.get('q') || '')}" placeholder="p. ej. anulación, caja, calamar…"></div></div>
      <p class="small muted" style="margin:0">Queda registrado todo lo que se crea, cambia o borra, con quién y cuándo. Nadie puede borrar este registro desde la app.</p></div>
    <div class="card">${list.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha y hora</th><th>Persona</th><th>Qué pasó</th></tr></thead><tbody>
    ${list.map((x) => `<tr class="click" data-id="${x.id}"><td class="small" style="white-space:nowrap">${esc(new Date(x.at.replace(' ', 'T') + 'Z').toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }))}</td><td>${esc(x.user_name || '')}</td>
      <td><span class="pill ${/baja|borrado|anulación|restauración|deshacer/.test(x.action) ? 'bad' : /modificación|edición/.test(x.action) ? 'warn' : ''}">${esc(x.action)}</span> ${esc(x.summary || '')}</td></tr>`).join('')}</tbody></table></div>${list.length === 300 ? '<p class="small muted">Se muestran los 300 más recientes. Acota las fechas para ver más.</p>' : ''}` : '<div class="empty">No hay actividad con estos filtros.</div>'}</div>`;
  $('#f').onchange = () => go(url({ from: $('#f').value })); $('#t').onchange = () => go(url({ to: $('#t').value }));
  $('#u').onchange = () => go(url({ user: $('#u').value })); $('#e').onchange = () => go(url({ entity: $('#e').value }));
  $('#s').onchange = () => go(url({ q: $('#s').value.trim() }));
  $$('tr[data-id]', v).forEach((tr) => (tr.onclick = async () => {
    const d = await api('audit-detail/' + tr.dataset.id);
    let det = d.detail; try { det = JSON.stringify(JSON.parse(d.detail), null, 2); } catch { /* texto */ }
    await modal(`<h2>${esc(d.summary || '')}</h2><p class="small muted">${esc(d.user_name || '')} · ${esc(new Date(d.at.replace(' ', 'T') + 'Z').toLocaleString('es-ES'))}</p><pre class="small" style="white-space:pre-wrap;background:var(--surface-2);padding:10px;border-radius:8px;max-height:50vh;overflow:auto">${esc(det || '')}</pre><div class="actions"><button class="primary" value="ok">Cerrar</button></div>`);
  }));
};

// ---------- Copias de seguridad ----------
VIEWS.copias = async (v) => {
  const info = await api('backup');
  const total = Object.values(info.counts).reduce((a, b) => a + b, 0);
  const last = S.settings.last_backup;
  v.innerHTML = `<h1>Copias de seguridad</h1>
    <div class="card"><h2>Descargar copia</h2>
      <p>Descarga un archivo con <b>todos los datos</b> de la app (${num(total, 0)} registros). Guárdalo fuera de Cloudflare: en tu ordenador, un pendrive o Google Drive.</p>
      <p class="small muted">Última descarga: ${last ? esc(new Date(last.replace(' ', 'T') + 'Z').toLocaleString('es-ES')) : 'nunca'}. Recomendado: una vez por semana. Además, Cloudflare permite volver la base de datos a cualquier momento de los últimos 7 días (en su consola: D1 → Time Travel).</p>
      <button class="primary" id="dl">💾 Descargar copia completa</button> <span id="prog" class="small muted"></span></div>
    <div class="card"><h2>Restaurar una copia</h2>
      <p class="txt-bad"><b>Cuidado:</b> restaurar <b>borra todos los datos actuales</b> y los sustituye por los de la copia. Úsalo solo si ha pasado algo grave.</p>
      <div class="field"><label>Archivo de copia (.json)</label><input type="file" id="rf" accept=".json,application/json"></div>
      <button class="danger" id="rs" disabled>Restaurar esta copia</button> <span id="rprog" class="small muted"></span></div>`;
  $('#dl').onclick = (e) => act(e.target, async () => {
    const data = { app: 'gestion-restaurante', version: info.version, created_at: new Date().toISOString(), restaurant: S.settings.restaurant_name, tables: {} };
    let done = 0;
    for (const t of info.tables) {
      data.tables[t] = [];
      for (let off = 0; off < info.counts[t]; off += 500) {
        data.tables[t].push(...(await api(`backup/table/${t}?offset=${off}`)));
        done = Math.min(done + 500, total); $('#prog').textContent = `Descargando… ${Math.round((Object.values(data.tables).reduce((a, b) => a + b.length, 0) / Math.max(total, 1)) * 100)} %`;
      }
    }
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `copia_${(S.settings.restaurant_name || 'restaurante').replace(/\W+/g, '_')}_${today()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    await api('backup/done', { body: {} }); await reload();
    $('#prog').textContent = 'Copia descargada ✓';
  });
  $('#rf').onchange = () => ($('#rs').disabled = !$('#rf').files[0]);
  $('#rs').onclick = (e) => act(e.target, async () => {
    const data = JSON.parse(await $('#rf').files[0].text());
    if (data.app !== 'gestion-restaurante' || !data.tables) throw new Error('Ese archivo no es una copia de esta app');
    const n = Object.values(data.tables).reduce((a, b) => a + b.length, 0);
    const ok = await modal(`<h2>Restaurar copia</h2><p>Copia de <b>${esc(data.restaurant || '')}</b> del ${esc(new Date(data.created_at).toLocaleString('es-ES'))} con ${num(n, 0)} registros.</p>
      <p class="txt-bad">Se borrarán todos los datos actuales. Escribe <b>RESTAURAR</b> para confirmar.</p><input id="cf" autocomplete="off"><div class="actions"><button data-close>Cancelar</button><button class="primary danger" value="ok">Restaurar</button></div>`);
    if (!ok) return;
    if ($('#cf', $('#modal-form')).value.trim() !== 'RESTAURAR') throw new Error('No has escrito RESTAURAR');
    await api('backup/restore', { body: { confirm: 'RESTAURAR', wipe: true, created_at: data.created_at } });
    let done = 0;
    for (const t of info.tables) {
      const rows = data.tables[t] || [];
      for (let i = 0; i < rows.length; i += 200) {
        await api('backup/restore', { body: { confirm: 'RESTAURAR', table: t, rows: rows.slice(i, i + 200) } });
        done += Math.min(200, rows.length - i); $('#rprog').textContent = `Restaurando… ${Math.round((done / Math.max(n, 1)) * 100)} %`;
      }
    }
    await api('backup/restore', { body: { confirm: 'RESTAURAR', finish: true, user_ids: (data.tables.users || []).map((u) => u.id) } });
    toast('Copia restaurada'); setTimeout(() => location.reload(), 800);
  });
};

// ---------- Ajustes ----------
VIEWS.ajustes = async (v) => {
  v.innerHTML = `<h1>Ajustes</h1><form class="card" id="f">
    ${fieldHtml({ name: 'restaurant_name', label: 'Nombre del restaurante', required: true }, S.settings.restaurant_name)}
    ${fieldHtml({ name: 'iva_pct', label: 'IVA de venta (%)', type: 'number', help: 'Se usa para calcular el food cost sobre precio sin IVA' }, S.settings.iva_pct)}
    ${fieldHtml({ name: 'food_cost_target', label: 'Objetivo de coste de materia prima (%)', type: 'number', help: 'Lo habitual en restauración está entre el 25 y el 35 %' }, S.settings.food_cost_target)}
    <h3 style="margin-top:14px">Escandallos</h3>
    ${fieldHtml({ name: 'misc_pct', label: '% de varios por defecto', type: 'number', help: 'Sal, especias, aceite de fritura y pequeños ingredientes que no se pesan. Se suma al coste de cada plato (cada ficha puede cambiarlo)' }, S.settings.misc_pct)}
    ${fieldHtml({ name: 'expected_revenue', label: 'Facturación mensual prevista, sin IVA (€)', type: 'number', help: 'Para repartir los gastos fijos entre los platos. Si lo dejas vacío, se usa la media real de ventas (Qamarero) o de caja de los últimos 90 días' }, S.settings.expected_revenue ?? '')}
    <div class="small muted" style="margin-bottom:12px">${S.fixed?.pct != null ? `Ahora mismo: gastos fijos ${eur(S.fixed.monthly)}/mes ÷ ${eur(S.fixed.revenue)}/mes (${esc(S.fixed.source)}) = <b>${pct(S.fixed.pct)}</b> que se imputa a cada plato.` : `Todavía no se pueden imputar los gastos fijos: ${esc(S.fixed?.note || 'falta la facturación')}.`}</div>
    <button class="primary">Guardar</button></form>`;
  $('#f').onsubmit = (e) => { e.preventDefault(); act(e.submitter, async () => { await api('settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); await reload(); renderShell(); toast('Ajustes guardados'); }); };
};

// se arranca cuando están cargados todos los scripts (turnos.js añade vistas)
document.addEventListener('DOMContentLoaded', boot);
