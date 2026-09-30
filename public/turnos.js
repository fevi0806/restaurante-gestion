/* Turnos del personal, "Mi horario", enlaces sin contraseña y avisos al móvil.
   Se carga después de app.js y usa sus utilidades ($, esc, api, modal, VIEWS…). */
'use strict';

// ---------------- avisos al móvil (Web Push) ----------------
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToU8 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

async function pushState() {
  if (!pushSupported()) return isIOS && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration('/').catch(() => null);
  const sub = reg && (await reg.pushManager.getSubscription().catch(() => null));
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}
async function enablePush() {
  if (!pushSupported()) throw new Error(isIOS ? 'En iPhone primero añade la app a la pantalla de inicio (Compartir → Añadir a pantalla de inicio) y ábrela desde ahí.' : 'Este navegador no admite avisos.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Sin permiso no se pueden enviar avisos. Actívalo en los ajustes del navegador para esta web.');
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const { key } = await api('push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) });
  await api('push/subscribe', { body: { subscription: sub.toJSON() } });
  await api('push/test', { body: {} }).catch(() => {});
}
// al entrar: si este móvil ya tenía avisos, se asignan a quien ha entrado (móvil compartido)
async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration('/').catch(() => null);
  const sub = reg && (await reg.pushManager.getSubscription().catch(() => null));
  if (sub) await api('push/subscribe', { body: { subscription: sub.toJSON() } }).catch(() => {});
}
async function unsyncPush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration('/').catch(() => null);
  const sub = reg && (await reg.pushManager.getSubscription().catch(() => null));
  if (sub) await api('push/unsubscribe', { body: { endpoint: sub.endpoint } }).catch(() => {});
}
// tarjeta para activar los avisos en este móvil
async function pushCard(el, why) {
  const st = await pushState();
  if (st === 'on' || st === 'unsupported') { el.innerHTML = st === 'on' ? '<div class="small muted" style="margin:8px 0">🔔 Avisos activados en este dispositivo.</div>' : ''; return; }
  el.innerHTML = `<div class="card push-card"><div><b>🔔 Recibe los avisos en el móvil</b><div class="small muted">${esc(why)}</div>
    ${st === 'ios-install' ? '<div class="small" style="margin-top:6px">En iPhone: toca <b>Compartir</b> → <b>Añadir a pantalla de inicio</b>, abre la app desde ese icono y vuelve aquí.</div>' : ''}
    ${st === 'denied' ? '<div class="small txt-bad" style="margin-top:6px">Los avisos están bloqueados para esta web. Actívalos en los ajustes del navegador (candado junto a la dirección → Notificaciones).</div>' : ''}</div>
    ${st === 'off' ? '<button class="primary" data-push>Activar avisos</button>' : ''}</div>`;
  const b = $('[data-push]', el);
  if (b) b.onclick = () => act(b, async () => { await enablePush(); toast('Avisos activados. Te llegará uno de prueba.'); pushCard(el, why); });
}

// ---------------- utilidades de turnos ----------------
const DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const DOW_L = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const KIND_LABEL = { trabajo: 'Trabajo', libre: 'Libre', vacaciones: 'Vacaciones', baja: 'Baja', festivo: 'Festivo' };
const KIND_CLS = { libre: 'k-libre', vacaciones: 'k-vac', baja: 'k-baja', festivo: 'k-fest' };
const addD = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const mondayOfD = (s) => { const d = new Date(s + 'T12:00:00'); return addD(s, -((d.getDay() + 6) % 7)); };
const dnum = (s) => new Date(s + 'T12:00:00').getDate();
const weekTitle = (w) => { const a = new Date(w + 'T12:00:00'), b = new Date(addD(w, 6) + 'T12:00:00'); const m = (d) => d.toLocaleDateString('es-ES', { month: 'short' }).replace('.', ''); return `${a.getDate()}${a.getMonth() === b.getMonth() ? '' : ' ' + m(a)} – ${b.getDate()} ${m(b)}`; };
const segMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const segsH = (segs) => (segs || []).reduce((t, [a, b]) => { const s = segMin(a); let e = segMin(b); if (e <= s) e += 1440; return t + (e - s) / 60; }, 0);
const hTxt = (h) => num(h, 1) + ' h';
const segsTxt = (segs) => (segs || []).map((s) => s.join('–')).join(' · ');
const cellHtml = (x) => {
  if (!x) return '<span class="muted">·</span>';
  if (x.kind !== 'trabajo') return `<span class="kpill ${KIND_CLS[x.kind] || ''}">${KIND_LABEL[x.kind] || x.kind}</span>${x.note ? `<div class="small muted">${esc(x.note)}</div>` : ''}`;
  return (x.segs || []).map((s) => `<div class="tseg">${s[0]}–${s[1]}</div>`).join('') + (x.note ? `<div class="small muted">${esc(x.note)}</div>` : '');
};

// ---------------- vista Turnos ----------------
VIEWS.turnos = async (v, _id, q) => {
  const manage = can('turnos.gestionar');
  const tab = manage ? q.get('tab') || 'cuadrante' : 'cuadrante';
  const week = mondayOfD(q.get('week') || today());
  const tabs = manage ? `<div class="tabs no-print">${[['cuadrante', 'Cuadrante'], ['personal', 'Personal'], ['tipos', 'Turnos tipo'], ['reglas', 'Reglas y servicios']].map(([k, t]) => `<a href="#/turnos?tab=${k}&week=${week}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>` : '';
  const head = `<h1 class="no-print">Turnos del personal</h1>${tabs}`;
  if (tab === 'personal') return turnosPersonal(v, head);
  if (tab === 'tipos') return turnosTipos(v, head);
  if (tab === 'reglas') return turnosReglas(v, head, week);

  const g = await api('turnos?week=' + week);
  const dep = q.get('dep') || lsGet('turnos-dep') || '';
  const nav = `<div class="row between no-print" style="margin-bottom:12px">
    <div class="row weeknav"><a class="btn sm" href="#/turnos?week=${addD(week, -7)}" aria-label="Semana anterior">‹</a><b>Semana ${weekTitle(week)}</b><a class="btn sm" href="#/turnos?week=${addD(week, 7)}" aria-label="Semana siguiente">›</a>${week !== mondayOfD(today()) ? `<a class="btn sm" href="#/turnos">Esta semana</a>` : ''}</div>
    ${g.hidden ? '' : `<div class="tabs" style="margin:0">${['', ...g.departments].map((d) => `<a href="#" data-dep="${esc(d)}" class="${dep === d ? 'on' : ''}">${d ? esc(d) : 'Todos'}</a>`).join('')}</div>`}</div>`;
  if (g.hidden) {
    v.innerHTML = head + nav + `<div class="card empty">El cuadrante de esta semana aún no se ha publicado.</div>${S.me_staff ? '<a class="btn" href="#/mihorario">Ver mi horario →</a>' : ''}`;
    return;
  }
  const staffOf = (d) => g.staff.filter((p) => (p.department === d) && (!dep || dep === d));
  const shift = (sid, day) => g.shifts.find((x) => x.staff_id === sid && x.day === day);
  const warnDay = (sid, day) => (g.warnings || []).filter((w) => w.staff_id === sid && w.day === day && w.level !== 'info');
  const hoursOf = (sid) => g.shifts.filter((x) => x.staff_id === sid && x.kind === 'trabajo').reduce((t, x) => t + segsH(x.segs), 0);
  const deps = [...g.departments, ...[...new Set(g.staff.map((p) => p.department))].filter((d) => !g.departments.includes(d))].filter((d) => !dep || d === dep);
  const todayS = today();
  const changed = g.changed || [];
  const status = g.status === 'publicado' ? (changed.length ? `<span class="pill warn">Publicado · ${changed.length} ${changed.length === 1 ? 'cambio' : 'cambios'} sin avisar</span>` : `<span class="pill ok">Publicado</span>`) : '<span class="pill">Borrador</span>';
  const bad = (g.warnings || []).filter((w) => w.level === 'bad').length, warnN = (g.warnings || []).filter((w) => w.level === 'warn').length;
  const rev = g.cost?.revenue;
  const kpis = manage ? `<div class="grid k no-print" style="margin-bottom:14px">
      ${kpi('Horas planificadas', hTxt(g.cost.hours), `${g.staff.filter((p) => p.active).length} personas`)}
      ${kpi('Coste de personal previsto', eur(g.cost.total), g.cost.without_cost ? `${g.cost.without_cost} sin coste/hora` : Object.entries(g.cost.by_dept).filter(([, x]) => x > 0).map(([k, x]) => `${k} ${eur(x)}`).join(' · '))}
      ${kpi('Sobre ventas', rev ? pct((g.cost.total / rev.value) * 100) : '—', rev ? `${eur(rev.value)} · ${rev.source}` : 'Sin ventas de referencia')}
      ${kpi('Avisos', bad + warnN ? String(bad + warnN) : '✓', bad ? `${bad} incumplen descansos o jornada` : warnN ? 'revisa horas y descansos' : 'Descansos y jornadas correctos', bad ? 'bad' : '')}
    </div>` : '';
  const actions = manage ? `<div class="row no-print" style="margin-bottom:12px">
      ${status}
      <span style="flex:1"></span>
      <button class="sm" id="copy">Copiar semana anterior</button>
      <button class="sm" id="clear">Vaciar</button>
      <button class="sm" id="print">Imprimir</button>
      <button class="sm" id="share">Enlace para el equipo</button>
      ${g.status === 'publicado' && changed.length ? `<button class="primary" id="notify">Avisar cambios (${changed.length})</button>` : ''}
      ${g.status === 'publicado' && !changed.length ? '<button class="sm" id="resend">Reenviar por WhatsApp</button>' : ''}
      ${g.status !== 'publicado' ? '<button class="primary" id="publish">Publicar y avisar</button>' : ''}
    </div>` : `<div class="row no-print" style="margin-bottom:12px">${status}<span style="flex:1"></span><button class="sm" id="print">Imprimir</button></div>`;

  const svcRows = (d) => manage && g.services?.length ? g.services.map((sv) => {
    const cov = g.coverage?.[d]?.[sv.name] || [];
    const min = Number(g.mins?.[d]?.[sv.name]) || 0;
    return `<tr class="cov"><td class="small">${esc(sv.name)} <span class="muted">${sv.start}–${sv.end}</span>${min ? `<span class="muted"> · mín. ${min}</span>` : ''}</td>${g.days.map((_, i) => `<td class="${min && cov[i] < min ? 'lack' : ''}">${cov[i] ?? 0}</td>`).join('')}<td></td></tr>`;
  }).join('') : '';
  const grid = deps.map((d) => {
    const people = staffOf(d);
    if (!people.length && !manage) return '';
    return `<tbody><tr class="dep"><th colspan="9">${esc(d)}</th></tr>
      ${people.map((p) => { const h = hoursOf(p.id), over = p.weekly_hours > 0 && h > p.weekly_hours + 0.01;
        return `<tr class="${p.active === 0 ? 'muted' : ''}"><td class="who-c"><b>${esc(p.name)}</b>${p.position ? `<div class="small muted">${esc(p.position)}</div>` : ''}${changed.includes(p.id) ? '<div class="small txt-warn no-print">cambiado</div>' : ''}</td>
          ${g.days.map((day) => { const w = warnDay(p.id, day); return `<td class="cell ${manage ? 'edit' : ''} ${day === todayS ? 'today' : ''} ${w.length ? 'warnc' : ''}" data-s="${p.id}" data-d="${day}" ${w.length ? `title="${esc(w.map((x) => x.text).join('\n'))}"` : ''}>${cellHtml(shift(p.id, day))}</td>`; }).join('')}
          <td class="num"><b class="${over ? 'txt-warn' : ''}">${hTxt(h)}</b>${p.weekly_hours ? `<div class="small muted">de ${num(p.weekly_hours, 1)}</div>` : ''}</td></tr>`; }).join('')}
      ${!people.length ? `<tr><td colspan="9" class="small muted">Nadie en ${esc(d)}. ${manage ? '<a href="#/turnos?tab=personal">Añadir personal →</a>' : ''}</td></tr>` : ''}
      ${svcRows(d)}</tbody>`;
  }).join('');
  const warns = (g.warnings || []);
  const warnCard = manage && warns.length ? `<div class="card no-print"><h3>Revisa antes de publicar</h3>${warns.sort((a, b) => ({ bad: 0, warn: 1, info: 2 }[a.level] - { bad: 0, warn: 1, info: 2 }[b.level])).map((w) => `<div class="alert ${w.level === 'bad' ? 'bad' : w.level === 'warn' ? 'warn' : 'info'}"><span>${w.level === 'bad' ? '⛔' : w.level === 'warn' ? '⚠️' : 'ℹ️'}</span><span><b>${esc(w.name)}</b>: ${esc(w.text)}</span></div>`).join('')}
    <p class="small muted" style="margin:8px 0 0">Límites del Estatuto de los Trabajadores (12 h entre jornadas, 9 h al día, día y medio de descanso a la semana). Si el convenio de hostelería dice otra cosa, cámbialos en <a href="#/turnos?tab=reglas&week=${week}">Reglas</a>.</p></div>` : '';

  v.innerHTML = head + nav + kpis + actions + `
    <div class="print-only"><h2>${esc(S.settings.restaurant_name)} · Cuadrante semana ${weekTitle(week)}${dep ? ' · ' + esc(dep) : ''}</h2></div>
    <div class="card sched-wrap">${manage ? '' : dayView(g.days, g.staff, g.shifts, deps, 'dv')}<div class="table-wrap ${manage ? '' : 'wide-only'}"><table class="sched"><thead><tr><th></th>${g.days.map((day, i) => `<th class="${day === todayS ? 'today' : ''}">${DOW[i]} ${dnum(day)}</th>`).join('')}<th class="num">Horas</th></tr></thead>${grid}</table></div>
    ${manage ? '<p class="small muted no-print" style="margin:10px 0 0">Toca una casilla para poner el turno. Un turno partido son dos tramos (p. ej. 12:00–16:00 y 20:00–00:00).</p>' : ''}</div>
    ${warnCard}`;

  $$('[data-dep]', v).forEach((a) => (a.onclick = (e) => { e.preventDefault(); lsSet('turnos-dep', a.dataset.dep); go(`#/turnos?week=${week}&dep=${encodeURIComponent(a.dataset.dep)}`); }));
  $('#print').onclick = () => window.print();
  bindDayView(v);
  if (!manage) return;
  $$('td.cell.edit', v).forEach((td) => (td.onclick = () => editShift(g, Number(td.dataset.s), td.dataset.d)));
  $('#copy').onclick = (e) => act(e.target, async () => {
    const has = g.shifts.some((x) => !dep || g.staff.find((p) => p.id === x.staff_id)?.department === dep);
    if (has && !(await confirmModal(`Se sustituirán los turnos de esta semana${dep ? ' de ' + dep : ''} por los de la semana anterior. ¿Seguimos?`, 'Sí, copiar'))) return;
    const r = await api('turnos/copy', { body: { week, department: dep || null } });
    toast(`${r.copied} días copiados`); route();
  });
  $('#clear').onclick = (e) => act(e.target, async () => {
    if (!(await confirmModal(`¿Vaciar el cuadrante de esta semana${dep ? ' (solo ' + dep + ')' : ''}?`, 'Sí, vaciar'))) return;
    await api('turnos/clear', { body: { week, department: dep || null } }); toast('Semana vaciada'); route();
  });
  $('#share').onclick = () => shareTeamLink(g);
  if ($('#publish')) $('#publish').onclick = (e) => act(e.target, async () => {
    if (bad && !(await confirmModal(`Hay ${bad} aviso(s) de descansos o jornada sin resolver. ¿Publicar igualmente?`, 'Publicar igualmente'))) return;
    const r = await api('turnos/publish', { body: { week } });
    await publishedModal(r, false); route();
  });
  if ($('#notify')) $('#notify').onclick = (e) => act(e.target, async () => { const r = await api('turnos/notify', { body: { week } }); await publishedModal(r, true); route(); });
  if ($('#resend')) $('#resend').onclick = (e) => act(e.target, async () => { const r = await api('turnos/messages?week=' + week); await publishedModal({ ...r, token: g.token, resend: true }, false); });
};

// editor de una casilla (persona + día)
async function editShift(g, sid, day) {
  const p = g.staff.find((x) => x.id === sid);
  const cur = g.shifts.find((x) => x.staff_id === sid && x.day === day);
  const di = g.days.indexOf(day);
  const tpls = g.templates.filter((t) => !t.department || t.department === p.department);
  let kind = cur ? cur.kind : 'trabajo';
  const segs = cur?.segs?.length ? cur.segs.slice() : [];
  const segRow = (i) => `<div class="row segrow" style="gap:8px;flex-wrap:nowrap"><span class="small muted" style="white-space:nowrap">Tramo ${i + 1}</span><input type="time" data-a="${i}" value="${segs[i]?.[0] || ''}"><span>a</span><input type="time" data-b="${i}" value="${segs[i]?.[1] || ''}"></div>`;
  const r = await modal(`<h2>${esc(p.name)} · ${DOW_L[di]} ${dnum(day)}</h2>
    <div class="kinds">${Object.entries(KIND_LABEL).map(([k, t]) => `<button type="button" class="chipb ${kind === k ? 'on' : ''}" data-k="${k}">${t}</button>`).join('')}</div>
    <div id="work">
      ${tpls.length ? `<div class="small muted" style="margin:10px 0 4px">Turnos tipo</div><div class="kinds">${tpls.map((t) => `<button type="button" class="chipb" data-t="${t.id}">${esc(t.name)} <span class="muted">${esc(segsTxt(t.segs))}</span></button>`).join('')}</div>` : '<p class="small muted">Consejo: crea turnos tipo (mañana, noche, partido…) en la pestaña «Turnos tipo» para rellenar con un toque.</p>'}
      <div style="margin-top:10px">${[0, 1, 2].map(segRow).join('')}</div>
      <div class="small muted" id="hrs"></div>
    </div>
    <div class="field" style="margin-top:10px"><label>Nota (opcional)</label><input id="note" maxlength="80" value="${esc(cur?.note || '')}" placeholder="p. ej. cierra caja, apoyo en sala…"></div>
    <div class="small muted" style="margin:6px 0 4px">Aplicar también a:</div>
    <div class="kinds">${g.days.map((d, i) => `<label class="chipb ${d === day ? 'on' : ''}"><input type="checkbox" data-day="${d}" ${d === day ? 'checked disabled' : ''} hidden>${DOW[i]}</label>`).join('')}</div>
    <div class="actions">${cur ? '<button value="del" class="danger">Quitar</button>' : ''}<button data-close>Cancelar</button><button class="primary" value="ok">Guardar</button></div>`, {
    onOpen: (f) => {
      const upd = () => {
        $('#work', f).classList.toggle('hidden', kind !== 'trabajo');
        $$('[data-k]', f).forEach((b) => b.classList.toggle('on', b.dataset.k === kind));
        const ss = [0, 1, 2].map((i) => [$(`[data-a="${i}"]`, f).value, $(`[data-b="${i}"]`, f).value]).filter(([a, b]) => a && b);
        $('#hrs', f).textContent = ss.length ? `Total: ${hTxt(segsH(ss))}` : '';
      };
      $$('[data-k]', f).forEach((b) => (b.onclick = () => { kind = b.dataset.k; upd(); }));
      $$('[data-t]', f).forEach((b) => (b.onclick = () => { const t = tpls.find((x) => x.id === Number(b.dataset.t)); [0, 1, 2].forEach((i) => { $(`[data-a="${i}"]`, f).value = t.segs[i]?.[0] || ''; $(`[data-b="${i}"]`, f).value = t.segs[i]?.[1] || ''; }); kind = 'trabajo'; upd(); }));
      $$('input[type=time]', f).forEach((i) => (i.oninput = upd));
      $$('label.chipb input', f).forEach((i) => (i.onchange = () => i.parentElement.classList.toggle('on', i.checked)));
      upd();
      if (!cur) $('[data-a="0"]', f).focus();
    },
  });
  if (!r) return;
  const f = $('#modal-form');
  const days = [day, ...$$('[data-day]', f).filter((i) => i.checked && !i.disabled).map((i) => i.dataset.day)];
  const ss = [0, 1, 2].map((i) => [$(`[data-a="${i}"]`, f).value, $(`[data-b="${i}"]`, f).value]).filter(([a, b]) => a || b);
  const note = $('#note', f).value;
  const items = days.map((d) => (r === 'del' ? { staff_id: sid, day: d, kind: '' } : { staff_id: sid, day: d, kind, segs: kind === 'trabajo' ? ss : null, note }));
  try { await api('turnos/shifts', { body: { items } }); route(); } catch (e) { toast(e.message, true); }
}

// después de publicar: avisos automáticos + WhatsApp/email en un toque
async function publishedModal(r, changes) {
  const withApp = r.messages.filter((m) => m.has_app).length;
  const link = r.token ? `${location.origin}/#/h/${r.token}` : null;
  await modal(`<h2>${r.resend ? 'Enviar horarios' : changes ? 'Cambios avisados' : 'Cuadrante publicado'}</h2>
    ${r.resend ? '' : `<p>${r.pushed ? `🔔 Aviso enviado al móvil de <b>${r.pushed}</b> ${r.pushed === 1 ? 'persona' : 'personas'} que tienen la app con avisos.` : withApp ? 'Las personas con usuario lo verán en «Mi horario» al entrar.' : ''}</p>`}
    <p class="small muted">Para quien no tenga la app, un toque y le mandas su horario por WhatsApp o email (con su enlace personal, siempre actualizado):</p>
    <div class="msgs">${r.messages.map((m) => { const wa = waLink(m.phone, m.text);
      return `<div class="row between task"><div><b>${esc(m.name)}</b> <span class="small muted">${esc(m.department || '')}${m.has_app ? ' · tiene la app' : ''}</span></div><div class="row" style="gap:6px">${wa ? `<a class="btn sm primary" target="_blank" rel="noopener" href="${wa}">WhatsApp</a>` : ''}${m.email ? `<a class="btn sm" href="mailto:${esc(m.email)}?subject=${encodeURIComponent('Tu horario · ' + S.settings.restaurant_name)}&body=${encodeURIComponent(m.text)}">Email</a>` : ''}<button type="button" class="sm" data-copy="${esc(m.text)}">Copiar</button></div></div>`; }).join('')}</div>
    ${link ? `<div class="field" style="margin-top:12px"><label>Enlace del cuadrante completo (para el grupo de WhatsApp del equipo)</label><div class="row" style="flex-wrap:nowrap"><input readonly value="${esc(link)}"><button type="button" class="sm" data-copy="${esc(link)}">Copiar</button></div></div>` : ''}
    <div class="actions"><button class="primary" value="ok">Hecho</button></div>`, {
    onOpen: (f) => $$('[data-copy]', f).forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copiado'); } catch { toast('No se pudo copiar', true); } })),
  });
}

async function shareTeamLink(g) {
  let token = g.token;
  const draw = () => `<h2>Enlace para el equipo</h2><p class="small muted">Cualquiera con este enlace ve el cuadrante <b>publicado</b> de esta semana y la siguiente, sin contraseña y sin teléfonos ni costes. Ideal para fijarlo en el grupo de WhatsApp del personal.</p>
    ${token ? `<div class="row" style="flex-wrap:nowrap"><input readonly value="${location.origin}/#/h/${token}"><button type="button" class="sm" id="cp">Copiar</button></div>
      <p class="small muted">Si alguien que ya no está en el equipo lo tiene, crea uno nuevo: el anterior deja de funcionar.</p>` : '<p>Aún no hay enlace.</p>'}
    <div class="actions"><button type="button" id="gen">${token ? 'Crear uno nuevo' : 'Crear enlace'}</button><button class="primary" value="ok">Cerrar</button></div>`;
  await modal(draw(), { onOpen: function bind(f) {
    if ($('#cp', f)) $('#cp', f).onclick = async () => { try { await navigator.clipboard.writeText(`${location.origin}/#/h/${token}`); toast('Copiado'); } catch { toast('Cópialo a mano', true); } };
    $('#gen', f).onclick = (e) => act(e.target, async () => { if (token && !(await Promise.resolve(confirm('El enlace anterior dejará de funcionar. ¿Crear uno nuevo?')))) return; token = (await api('turnos/link', { body: {} })).token; g.token = token; f.innerHTML = draw(); bind(f); $$('[data-close]', f); });
  } });
}

// ---------- pestaña Personal ----------
async function turnosPersonal(v, head) {
  const [{ staff, users }, g] = await Promise.all([api('turnos/staff'), api('turnos?week=' + mondayOfD(today()))]);
  const deps = g.departments;
  v.innerHTML = head + `<div class="card"><div class="row between"><p class="small muted" style="margin:0;flex:1 1 300px">Quién entra en el cuadrante. Vincula a cada persona con su usuario de la app para que vea «Mi horario» y le lleguen los avisos al móvil. El coste por hora (sueldo + Seguridad Social) sirve para el coste de personal previsto.</p><button class="primary" id="add">+ Añadir persona</button></div>
    ${staff.length ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Nombre</th><th>Departamento</th><th class="num">Contrato</th><th class="num">Coste/h</th><th>Móvil / email</th><th>Usuario de la app</th><th></th></tr></thead><tbody>
      ${staff.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.position ? `<div class="small muted">${esc(p.position)}</div>` : ''}</td><td>${esc(p.department)}</td><td class="num">${p.weekly_hours ? num(p.weekly_hours, 1) + ' h' : '—'}</td><td class="num">${p.cost_hour ? eur(p.cost_hour) : '—'}</td>
        <td class="small">${esc([p.phone, p.email].filter(Boolean).join(' · ') || '—')}</td><td class="small">${p.user_name ? esc(p.user_name) : '<span class="muted">sin vincular</span>'}</td>
        <td><div class="row" style="flex-wrap:nowrap;gap:6px"><button class="sm" data-link="${p.id}" title="Enlace personal «mi horario»">🔗</button><button class="sm" data-ed="${p.id}">Editar</button></div></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Aún no hay nadie. Añade al equipo de cocina y de sala.</div>'}</div>`;
  const fields = [
    { name: 'name', label: 'Nombre', required: true },
    { name: 'department', label: 'Departamento', type: 'select', options: deps.map((d) => [d, d]) },
    { name: 'position', label: 'Puesto (opcional)', attrs: 'placeholder="Jefe de cocina, cocinero, office, camarero, encargado…"' },
    { name: 'weekly_hours', label: 'Horas de contrato a la semana', type: 'number', help: 'Para avisar de horas extra o de horas que faltan' },
    { name: 'cost_hour', label: 'Coste por hora para la empresa (€)', type: 'number', help: 'Opcional. Sueldo bruto + Seguridad Social ÷ horas' },
    { name: 'phone', label: 'Móvil (para WhatsApp)', type: 'tel' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'user_id', label: 'Usuario de la app', type: 'select', options: [['', '— sin usuario —'], ...users.map((u) => [u.id, `${u.name} (${u.username})`])] },
  ];
  $('#add').onclick = async () => { const d = await formModal('Añadir persona', fields, { department: deps[0] }); if (!d) return; try { await api('turnos/staff', { body: d }); toast('Añadida'); route(); } catch (e) { toast(e.message, true); } };
  $$('[data-ed]', v).forEach((b) => (b.onclick = async () => {
    const p = staff.find((x) => x.id === Number(b.dataset.ed));
    const r = await modal(`<h2>${esc(p.name)}</h2>${fields.map((f) => fieldHtml(f, p[f.name])).join('')}<div class="actions"><button value="del" class="danger">Dar de baja</button><button data-close>Cancelar</button><button class="primary" value="ok">Guardar</button></div>`);
    if (!r) return;
    try {
      if (r === 'del') { if (!(await confirmModal(`¿Quitar a ${p.name} del cuadrante? Sus turnos pasados se conservan.`, 'Dar de baja'))) return; await api('turnos/staff/' + p.id, { method: 'DELETE' }); toast('Dada de baja'); return route(); }
      const f = $('#modal-form'), d = {};
      for (const fl of fields) { const el = $(`[name="${fl.name}"]`, f); d[fl.name] = fl.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value.trim(); }
      await api('turnos/staff/' + p.id, { method: 'PUT', body: d }); toast('Guardado'); route();
    } catch (e) { toast(e.message, true); }
  }));
  $$('[data-link]', v).forEach((b) => (b.onclick = async () => {
    const p = staff.find((x) => x.id === Number(b.dataset.link));
    const url = `${location.origin}/#/h/${p.token}`;
    const r = await modal(`<h2>Enlace personal de ${esc(p.name)}</h2><p class="small muted">Con este enlace ve su horario publicado sin usuario ni contraseña. Mándaselo una vez y que lo guarde.</p>
      <div class="row" style="flex-wrap:nowrap"><input readonly value="${esc(url)}"><button type="button" class="sm" id="cp">Copiar</button></div>
      <div class="actions"><button value="new">Crear uno nuevo</button>${waLink(p.phone, url) ? `<a class="btn primary" target="_blank" rel="noopener" href="${waLink(p.phone, `Hola ${p.name.split(' ')[0]}, aquí tienes tu horario, siempre actualizado: ${url}`)}">Enviar por WhatsApp</a>` : ''}<button class="primary" value="ok">Cerrar</button></div>`,
    { onOpen: (f) => ($('#cp', f).onclick = async () => { try { await navigator.clipboard.writeText(url); toast('Copiado'); } catch { toast('Cópialo a mano', true); } }) });
    if (r === 'new') { await api('turnos/staff/' + p.id, { method: 'PUT', body: { new_token: true } }); toast('Enlace nuevo creado; el anterior ya no funciona'); route(); }
  }));
}

// ---------- pestaña Turnos tipo ----------
async function turnosTipos(v, head) {
  const g = await api('turnos?week=' + mondayOfD(today()));
  const t = g.templates;
  v.innerHTML = head + `<div class="card"><div class="row between"><p class="small muted" style="margin:0;flex:1 1 300px">Los horarios que más se repiten, para rellenar el cuadrante con un toque. Pueden tener uno, dos o tres tramos (turno partido) y pasar de medianoche.</p><button class="primary" id="add">+ Turno tipo</button></div>
    ${t.length ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Nombre</th><th>Departamento</th><th>Tramos</th><th class="num">Horas</th><th></th></tr></thead><tbody>${t.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.department || 'Todos')}</td><td>${esc(segsTxt(x.segs))}</td><td class="num">${hTxt(segsH(x.segs))}</td><td><button class="sm" data-ed="${x.id}">Editar</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">Aún no hay turnos tipo.</div><button class="sm" id="seed">Crear unos de ejemplo (cocina partido, sala mañana/noche…)</button>`}</div>`;
  const edit = async (x) => {
    const segs = x?.segs || [];
    const r = await modal(`<h2>${x ? 'Editar turno tipo' : 'Nuevo turno tipo'}</h2>
      ${fieldHtml({ name: 'name', label: 'Nombre', required: true, attrs: 'placeholder="Partido, Mañana, Noche, Cierre…"' }, x?.name)}
      ${fieldHtml({ name: 'department', label: 'Departamento', type: 'select', options: [['', 'Todos'], ...g.departments.map((d) => [d, d])] }, x?.department || '')}
      ${[0, 1, 2].map((i) => `<div class="row segrow" style="gap:8px;flex-wrap:nowrap;margin-bottom:6px"><span class="small muted" style="white-space:nowrap">Tramo ${i + 1}</span><input type="time" data-a="${i}" value="${segs[i]?.[0] || ''}"><span>a</span><input type="time" data-b="${i}" value="${segs[i]?.[1] || ''}"></div>`).join('')}
      <div class="actions">${x ? '<button value="del" class="danger">Borrar</button>' : ''}<button data-close>Cancelar</button><button class="primary" value="ok">Guardar</button></div>`);
    if (!r) return;
    const f = $('#modal-form');
    try {
      if (r === 'del') { await api('turnos/templates/' + x.id, { method: 'DELETE' }); return route(); }
      const body = { name: $('[name=name]', f).value, department: $('[name=department]', f).value || null, segs: [0, 1, 2].map((i) => [$(`[data-a="${i}"]`, f).value, $(`[data-b="${i}"]`, f).value]).filter(([a, b]) => a || b) };
      await api('turnos/templates' + (x ? '/' + x.id : ''), { method: x ? 'PUT' : 'POST', body }); toast('Guardado'); route();
    } catch (e) { toast(e.message, true); }
  };
  $('#add').onclick = () => edit(null);
  $$('[data-ed]', v).forEach((b) => (b.onclick = () => edit(t.find((x) => x.id === Number(b.dataset.ed)))));
  if ($('#seed')) $('#seed').onclick = (e) => act(e.target, async () => {
    const [coc, sala] = [g.departments.find((d) => /cocina/i.test(d)) || null, g.departments.find((d) => /sala/i.test(d)) || null];
    const ex = [['Partido', coc, [['12:00', '16:00'], ['20:00', '00:00']]], ['Mediodía', coc, [['11:00', '17:00']]], ['Noche', coc, [['19:00', '00:30']]],
      ['Mañana', sala, [['10:00', '17:00']]], ['Tarde-noche', sala, [['17:00', '01:00']]], ['Partido sala', sala, [['12:30', '16:30'], ['20:00', '00:30']]]];
    for (const [name, department, segs] of ex) await api('turnos/templates', { body: { name, department, segs } });
    toast('Turnos de ejemplo creados: ajústalos a vuestro horario'); route();
  });
}

// ---------- pestaña Reglas y servicios ----------
async function turnosReglas(v, head, week) {
  const g = await api('turnos?week=' + week);
  const r = g.rules;
  const svc = g.services.length ? g.services : [{ name: 'Comida', start: '13:00', end: '16:00' }, { name: 'Cena', start: '20:30', end: '23:30' }];
  const svRow = (s, i) => `<tr data-sv="${i}"><td><input data-f="name" value="${esc(s?.name || '')}" placeholder="Comida, Cena…"></td><td><input type="time" data-f="start" value="${s?.start || ''}"></td><td><input type="time" data-f="end" value="${s?.end || ''}"></td>
    ${g.departments.map((d) => `<td><input type="number" min="0" class="qty" data-min="${esc(d)}" value="${s ? g.mins?.[d]?.[s.name] ?? '' : ''}" placeholder="—"></td>`).join('')}</tr>`;
  v.innerHTML = head + `<form class="card" id="f">
    <h3>Departamentos</h3>
    ${fieldHtml({ name: 'departments', label: 'Separados por comas', help: 'Cada uno tiene su bloque en el cuadrante, p. ej. Cocina, Sala, Barra, Office' }, g.departments.join(', '))}
    <h3 style="margin-top:16px">Límites legales</h3>
    <p class="small muted" style="margin-top:-6px">Por defecto, los del Estatuto de los Trabajadores (art. 34 y 37). El convenio colectivo de hostelería de tu provincia manda: si fija otros, cámbialos aquí.</p>
    <div class="grid two">
      ${fieldHtml({ name: 'min_rest', label: 'Descanso mínimo entre jornadas (horas)', type: 'number' }, r.min_rest)}
      ${fieldHtml({ name: 'max_day', label: 'Máximo de trabajo en un día (horas)', type: 'number' }, r.max_day)}
      ${fieldHtml({ name: 'weekly_rest', label: 'Descanso semanal seguido (horas)', type: 'number', help: '36 h = día y medio' }, r.weekly_rest)}
      ${fieldHtml({ name: 'max_segs', label: 'Tramos máximos al día', type: 'number', help: '2 = un turno partido' }, r.max_segs)}
    </div>
    <h3 style="margin-top:16px">Servicios y personal mínimo</h3>
    <p class="small muted" style="margin-top:-6px">Debajo de cada departamento, el cuadrante cuenta cuántas personas cubren cada servicio y marca en rojo si hay menos del mínimo.</p>
    <div class="table-wrap"><table><thead><tr><th>Servicio</th><th>Desde</th><th>Hasta</th>${g.departments.map((d) => `<th>Mín. ${esc(d)}</th>`).join('')}</tr></thead><tbody id="svs">${svc.map(svRow).join('')}${svRow(null, svc.length)}</tbody></table></div>
    <button class="primary" style="margin-top:14px">Guardar</button></form>`;
  $('#f').onsubmit = (e) => { e.preventDefault(); act(e.submitter, async () => {
    const f = $('#f');
    const rows = $$('#svs tr', f).map((tr) => ({ name: $('[data-f=name]', tr).value.trim(), start: $('[data-f=start]', tr).value, end: $('[data-f=end]', tr).value, tr })).filter((x) => x.name);
    const mins = {};
    for (const x of rows) for (const inp of $$('[data-min]', x.tr)) if (inp.value !== '') (mins[inp.dataset.min] = mins[inp.dataset.min] || {})[x.name] = Number(inp.value);
    await api('turnos/config', { method: 'PUT', body: {
      departments: $('[name=departments]', f).value.split(',').map((x) => x.trim()).filter(Boolean),
      rules: Object.fromEntries(['min_rest', 'max_day', 'weekly_rest', 'max_segs'].map((k) => [k, $(`[name=${k}]`, f).value])),
      services: rows.map(({ name, start, end }) => ({ name, start, end })), mins,
    } });
    toast('Guardado'); route();
  }); };
}

// ---------------- Mi horario ----------------
function personWeeksHtml(d) {
  const todayS = today();
  return d.weeks.map((w) => `<div class="card"><div class="row between"><h3 style="margin:0">Semana ${weekTitle(w.week)}</h3>${w.published ? `<b>${hTxt(w.hours)}</b>` : ''}</div>
    ${w.published ? `<div class="mydays">${w.days.map((x, i) => `<div class="myday ${x.day === todayS ? 'today' : ''} ${x.kind !== 'trabajo' ? 'off' : ''}"><div class="dn">${DOW[i]} <b>${dnum(x.day)}</b></div><div>${x.kind === 'trabajo' ? x.segs.map((s) => `<span class="tseg">${s[0]}–${s[1]}</span>`).join(' ') : `<span class="kpill ${KIND_CLS[x.kind] || ''}">${KIND_LABEL[x.kind] || 'Libre'}</span>`}${x.note ? `<div class="small muted">${esc(x.note)}</div>` : ''}</div></div>`).join('')}</div>`
      : '<div class="empty small">Aún no publicado.</div>'}</div>`).join('');
}
VIEWS.mihorario = async (v, _id, q) => {
  const d = await api('turnos/mine' + (q.get('week') ? '?week=' + q.get('week') : ''));
  if (!d.linked) { v.innerHTML = '<h1>Mi horario</h1><div class="card">Tu usuario aún no está vinculado a una ficha del cuadrante. Pídeselo al responsable (Turnos → Personal).</div>'; return; }
  v.innerHTML = `<h1>Mi horario</h1><div id="pushc"></div>${personWeeksHtml(d)}
    ${canAny('turnos.ver', 'turnos.gestionar') ? '<a class="btn" href="#/turnos">Ver el cuadrante de todo el equipo →</a>' : ''}`;
  pushCard($('#pushc'), 'Te avisamos cuando se publique o cambie tu horario, y la tarde antes de cada turno.');
};

// tarjeta de Inicio: hoy y mañana
async function todayShiftCard(el) {
  const d = await api('turnos/mine').catch(() => null);
  if (!d?.linked) return;
  const all = d.weeks.flatMap((w) => (w.published ? w.days : []));
  const t = today(), m = addD(t, 1);
  const line = (x) => (!x ? '—' : x.kind === 'trabajo' ? x.segs.map((s) => s.join('–')).join(' y ') : KIND_LABEL[x.kind] || 'Libre');
  const td = all.find((x) => x.day === t), tm = all.find((x) => x.day === m);
  if (!td && !tm) return;
  el.innerHTML = `<a class="card row between" href="#/mihorario" style="text-decoration:none"><div><div class="small muted">Hoy</div><b>${esc(line(td))}</b></div><div><div class="small muted">Mañana</div><b>${esc(line(tm))}</b></div><span class="muted">Mi horario ›</span></a>`;
}

// vista por días para el móvil: quién trabaja y a qué hora
function dayView(days, staff, shifts, deps, id) {
  const t = today(), sel = days.includes(t) ? t : days[0];
  return `<div class="dayview" id="${id}"><div class="kinds">${days.map((d, i) => `<button type="button" class="chipb ${d === sel ? 'on' : ''}" data-dv="${d}">${DOW[i]} ${dnum(d)}</button>`).join('')}</div>
    ${days.map((d) => `<div class="dv-day ${d === sel ? '' : 'hidden'}" data-dd="${d}">${deps.map((dp) => {
      const rows = staff.filter((p) => p.department === dp).map((p) => ({ p, x: shifts.find((z) => z.staff_id === p.id && z.day === d) }));
      const work = rows.filter((r) => r.x?.kind === 'trabajo').sort((a, b) => a.x.segs[0][0].localeCompare(b.x.segs[0][0]));
      const off = rows.filter((r) => r.x?.kind !== 'trabajo');
      if (!rows.length) return '';
      return `<h3 style="margin-top:12px">${esc(dp)}</h3>${work.map((r) => `<div class="myday"><div><b>${esc(r.p.name.split(' ')[0])}</b></div><div>${r.x.segs.map((sg) => `<span class="tseg">${sg[0]}–${sg[1]}</span>`).join(' ')}${r.x.note ? `<div class="small muted">${esc(r.x.note)}</div>` : ''}</div></div>`).join('') || '<div class="small muted">Nadie trabaja.</div>'}
        ${off.length ? `<div class="small muted" style="margin-top:4px">No trabajan: ${off.map((r) => esc(r.p.name.split(' ')[0]) + (r.x && r.x.kind !== 'libre' ? ` (${KIND_LABEL[r.x.kind].toLowerCase()})` : '')).join(', ')}</div>` : ''}`;
    }).join('')}</div>`).join('')}</div>`;
}
function bindDayView(root) {
  $$('[data-dv]', root).forEach((b) => (b.onclick = () => {
    const box = b.closest('.dayview');
    $$('[data-dv]', box).forEach((x) => x.classList.toggle('on', x === b));
    $$('[data-dd]', box).forEach((x) => x.classList.toggle('hidden', x.dataset.dd !== b.dataset.dv));
  }));
}

// ---------------- páginas sin contraseña (#/h/<enlace>) ----------------
async function renderPublic(token) {
  document.title = 'Horario';
  $('#app').innerHTML = '<div class="boot">Cargando…</div>';
  let d;
  try {
    const r = await fetch('/api/public/turnos/' + encodeURIComponent(token));
    d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Enlace no válido');
  } catch (e) { $('#app').innerHTML = `<div class="login"><div class="card"><h1>Horario</h1><p>${esc(e.message)}</p></div></div>`; return; }
  const todayS = today();
  let body;
  if (d.kind === 'persona') body = `<h1>${esc(d.person.name)}</h1><p class="muted" style="margin-top:-8px">${esc(d.person.department)}${d.person.position ? ' · ' + esc(d.person.position) : ''}</p>${personWeeksHtml(d)}`;
  else body = d.weeks.map((w) => {
    if (!w.published) return `<div class="card"><h3>Semana ${weekTitle(w.week)}</h3><div class="empty small">Aún no publicado.</div></div>`;
    const deps = [...d.departments, ...[...new Set(w.staff.map((s) => s.department))].filter((x) => !d.departments.includes(x))];
    return `<div class="card sched-wrap"><h3>Semana ${weekTitle(w.week)}</h3>${dayView(w.days, w.staff, w.shifts, deps, 'dv-' + w.week)}<div class="table-wrap wide-only"><table class="sched"><thead><tr><th></th>${w.days.map((day, i) => `<th class="${day === todayS ? 'today' : ''}">${DOW[i]} ${dnum(day)}</th>`).join('')}</tr></thead>
      ${deps.map((dp) => { const ppl = w.staff.filter((s) => s.department === dp); if (!ppl.length) return ''; return `<tbody><tr class="dep"><th colspan="8">${esc(dp)}</th></tr>${ppl.map((p) => `<tr><td class="who-c"><b>${esc(p.name)}</b>${p.position ? `<div class="small muted">${esc(p.position)}</div>` : ''}</td>${w.days.map((day) => `<td class="cell ${day === todayS ? 'today' : ''}">${cellHtml(w.shifts.find((x) => x.staff_id === p.id && x.day === day))}</td>`).join('')}</tr>`).join('')}</tbody>`; }).join('')}
      </table></div></div>`;
  }).join('');
  $('#app').innerHTML = `<div class="public"><div class="pub-head"><b>${esc(d.restaurant)}</b><span class="muted small">Horario publicado · se actualiza solo</span></div>${body}
    <p class="small muted" style="text-align:center">Guarda este enlace en favoritos o en la pantalla de inicio.</p></div>`;
  bindDayView($('#app'));
}

// ---------------- enganches con la app ----------------
NAV.splice(NAV.findIndex((n) => n.r === 'appcc') + 1, 0,
  { r: 'turnos', t: 'Turnos', i: '🗓️', need: ['turnos.ver', 'turnos.gestionar'] },
  { r: 'mihorario', t: 'Mi horario', i: '⏰', need: [], when: () => !!S.me_staff });
