/* Agenda de eventos: reservas de grupos (comidas de empresa, cumpleaños, comuniones…).
   Se carga después de app.js y usa sus utilidades ($, esc, api, modal, VIEWS…). */
'use strict';

const EV_ST = {
  consulta: ['Consulta', 'pill'],
  reservado: ['Reservado', 'pill warn'],
  confirmado: ['Confirmado', 'pill ok'],
  celebrado: ['Celebrado', 'pill'],
  cancelado: ['Cancelado', 'pill bad'],
};
const EV_KINDS = ['Comida de empresa', 'Cumpleaños', 'Comunión', 'Bautizo', 'Boda', 'Despedida', 'Reunión familiar', 'Grupo turístico', 'Otro'];
const evPill = (s) => `<span class="${(EV_ST[s] || EV_ST.consulta)[1]}">${(EV_ST[s] || EV_ST.consulta)[0]}</span>`;
const cap1 = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const evDay = (s) => cap1(new Date(s + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
const evAdd = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const evHours = (e) => (e.start_time ? e.start_time + (e.end_time ? '–' + e.end_time : '') : e.service || '');
const evPeople = (e) => `${e.people} pers.${e.kids ? ` (${e.kids} niños)` : ''}`;
const evActive = (e) => e.status !== 'cancelado';

NAV.push({ r: 'eventos', g: 'dia', t: 'Eventos y grupos', i: '🎉', need: ['eventos.ver', 'eventos.gestionar'], d: 'Reservas de grupos: comuniones, comidas de empresa, cumpleaños…' });
PERM_GROUPS.splice(PERM_GROUPS.findIndex((g) => g[0] === 'Turnos') + 1, 0,
  ['Eventos', [['eventos.ver', 'Ver la agenda de eventos y grupos (sin precios ni señales)'], ['eventos.gestionar', 'Apuntar, cambiar y cancelar eventos; ver precios y señales']]]);

VIEWS.eventos = async (v, id, q) => {
  if (id) return eventoForm(v, id === 'nuevo' ? null : Number(id), q);
  const manage = can('eventos.gestionar');
  const tab = q.get('tab') || 'proximos';
  const tabs = `<div class="tabs no-print">${[['proximos', 'Próximos'], ['calendario', 'Calendario'], ['pasados', 'Pasados y cancelados']].map(([k, t]) => `<a href="#/eventos?tab=${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>`;
  const head = `<div class="row" style="justify-content:space-between"><h1>Eventos y grupos</h1>${manage ? '<a class="btn primary no-print" href="#/eventos/nuevo">+ Nuevo evento</a>' : ''}</div>${tabs}`;
  const day = today();

  if (tab === 'calendario') {
    const month = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : day.slice(0, 7);
    const first = month + '-01';
    const d0 = new Date(first + 'T12:00:00');
    const start = evAdd(first, -((d0.getDay() + 6) % 7));
    const last = iso(new Date(d0.getFullYear(), d0.getMonth() + 1, 0, 12));
    const end = evAdd(last, 6 - ((new Date(last + 'T12:00:00').getDay() + 6) % 7));
    const list = await api(`events?from=${start}&to=${end}`);
    const by = {};
    list.forEach((e) => (by[e.event_date] = by[e.event_date] || []).push(e));
    const mAdd = (n) => { const d = new Date(d0); d.setMonth(d.getMonth() + n); return iso(d).slice(0, 7); };
    const title = cap1(d0.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }));
    let cells = '';
    for (let s = start; s <= end; s = evAdd(s, 1)) {
      const evs = by[s] || [], pax = evs.filter(evActive).reduce((t, e) => t + (e.people || 0), 0);
      cells += `<div class="evday ${s.slice(0, 7) !== month ? 'out' : ''} ${s === day ? 'today' : ''}" ${manage ? `data-new="${s}"` : ''}>
        <div class="evd"><b>${new Date(s + 'T12:00:00').getDate()}</b>${pax ? `<span class="small">${pax} pers.</span>` : ''}</div>
        ${evs.map((e) => `<a href="#/eventos/${e.id}" class="evchip st-${e.status}" title="${esc(e.title)} · ${evPeople(e)}"><span class="evt">${e.start_time ? `<b>${e.start_time}</b> ` : ''}${esc(e.title)} · </span><b>${e.people}</b></a>`).join('')}</div>`;
    }
    v.innerHTML = head + `<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:10px">
        <a class="btn" href="#/eventos?tab=calendario&m=${mAdd(-1)}">‹</a><h3 style="margin:0">${title}</h3><a class="btn" href="#/eventos?tab=calendario&m=${mAdd(1)}">›</a></div>
        <div class="evcal">${['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((x) => `<div class="evh">${x}</div>`).join('')}${cells}</div>
        ${manage ? '<div class="small muted" style="margin-top:8px">Toca un día vacío para apuntar un evento en esa fecha.</div>' : ''}</div>`;
    $$('[data-new]', v).forEach((c) => (c.onclick = (ev) => { if (!ev.target.closest('a')) go(`#/eventos/nuevo?date=${c.dataset.new}`); }));
    return;
  }

  const past = tab === 'pasados';
  const list = past ? await api(`events?to=${evAdd(day, 400)}`) : await api(`events?from=${day}`);
  const rows = past ? list.filter((e) => e.event_date < day || e.status === 'cancelado' || e.status === 'celebrado').reverse() : list.filter((e) => e.status !== 'cancelado' && e.status !== 'celebrado');
  if (!rows.length) {
    v.innerHTML = head + `<div class="card empty">${past ? 'No hay eventos pasados ni cancelados.' : 'No hay eventos apuntados a partir de hoy.'}${manage && !past ? '<div style="margin-top:12px"><a class="btn primary" href="#/eventos/nuevo">Apuntar el primero</a></div>' : ''}</div>`;
    return;
  }
  const groups = {};
  rows.forEach((e) => (groups[e.event_date] = groups[e.event_date] || []).push(e));
  const upcoming = rows.filter(evActive);
  const sum = !past ? `<div class="grid k" style="margin-bottom:14px">
      ${kpi('Próximos 7 días', String(upcoming.filter((e) => e.event_date <= evAdd(day, 7)).length), `${upcoming.filter((e) => e.event_date <= evAdd(day, 7)).reduce((t, e) => t + e.people, 0)} personas`)}
      ${kpi('Este mes y siguientes', String(upcoming.length), `${upcoming.reduce((t, e) => t + e.people, 0)} personas`)}
      ${kpi('Sin confirmar', String(upcoming.filter((e) => e.status === 'consulta').length), 'consultas pendientes', upcoming.some((e) => e.status === 'consulta' && e.event_date <= evAdd(day, 3)) ? 'bad' : '')}
      ${manage ? kpi('Señales por cobrar', eur(upcoming.filter((e) => e.deposit > 0 && !e.deposit_paid).reduce((t, e) => t + e.deposit, 0)), `${upcoming.filter((e) => e.deposit > 0 && !e.deposit_paid).length} eventos`) : ''}
    </div>` : '';
  v.innerHTML = head + sum + Object.entries(groups).map(([d, evs]) => {
    const pax = evs.filter(evActive).reduce((t, e) => t + (e.people || 0), 0);
    return `<div class="card evgroup"><div class="row" style="justify-content:space-between"><h3 style="margin:0">${d === day ? 'Hoy · ' : d === evAdd(day, 1) ? 'Mañana · ' : ''}${evDay(d)}</h3><span class="muted small">${pax} personas en grupos</span></div>
      ${evs.map((e) => `<a class="evrow" href="#/eventos/${e.id}">
        <div class="evtime">${esc(evHours(e)) || '—'}</div>
        <div class="evmain"><b>${esc(e.title)}</b> ${evPill(e.status)}<div class="small muted">${[e.kind, evPeople(e), e.space, e.contact_name && `${e.contact_name}${e.phone ? ' · ' + e.phone : ''}`].filter(Boolean).map(esc).join(' · ')}</div>
          ${e.allergies ? `<div class="small txt-bad">⚠️ ${esc(e.allergies)}</div>` : ''}
          ${manage && e.deposit > 0 && !e.deposit_paid && e.status !== 'cancelado' ? `<div class="small" style="color:var(--warn)">Señal de ${eur(e.deposit)} sin cobrar</div>` : ''}</div>
        <div class="muted">›</div></a>`).join('')}</div>`;
  }).join('');
};

async function eventoForm(v, id, q) {
  const manage = can('eventos.gestionar');
  const e = id ? await api('events/' + id) : { event_date: q.get('date') || today(), status: 'consulta', service: 'Comida', kind: '' };
  const sameDay = (await api(`events?from=${e.event_date}&to=${e.event_date}`)).filter((x) => x.id !== id && evActive(x));
  const ro = !manage ? 'disabled' : '';
  const f = (name, label, type = 'text', extra = '') => `<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${esc(e[name] ?? '')}" ${type === 'number' ? 'step="any" inputmode="decimal"' : ''} ${extra} ${ro}></div>`;
  const sel = (name, label, opts) => `<div class="field"><label>${label}</label><select name="${name}" ${ro}>${opts.map(([k, t]) => `<option value="${esc(k)}" ${String(e[name] ?? '') === String(k) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
  const ta = (name, label, ph = '') => `<div class="field"><label>${label}</label><textarea name="${name}" placeholder="${esc(ph)}" rows="4" ${ro}>${esc(e[name] ?? '')}</textarea></div>`;
  const total = (Number(e.price_pp) || 0) * (Number(e.people) || 0);
  const wa = e.phone && waLink(e.phone, evConfirmText(e));
  v.innerHTML = `<div class="no-print">
    <div class="row" style="justify-content:space-between"><h1>${id ? esc(e.title) : 'Nuevo evento'} ${id ? evPill(e.status) : ''}</h1><a class="btn" href="#/eventos">← Agenda</a></div>
    ${sameDay.length ? `<div class="card flagcard small"><b>Ese día ya hay ${sameDay.length} evento(s):</b> ${sameDay.map((x) => `<a href="#/eventos/${x.id}">${esc(x.title)}</a> (${evPeople(x)}${x.start_time ? ', ' + x.start_time : ''}${x.space ? ', ' + esc(x.space) : ''})`).join(' · ')}</div>` : ''}
    <form id="evf" class="card">
      <h3>Cuándo</h3>
      <div class="row">${f('event_date', 'Fecha', 'date', 'required')}${sel('service', 'Servicio', [['Comida', 'Comida'], ['Cena', 'Cena'], ['Desayuno', 'Desayuno'], ['Merienda', 'Merienda'], ['Todo el día', 'Todo el día']])}${f('start_time', 'Hora de llegada', 'time')}${f('end_time', 'Hasta', 'time')}</div>
      <h3>Quién</h3>
      <div class="row">${f('title', 'Nombre del evento o cliente', 'text', 'required placeholder="Comunión de Lucía, Empresa Pérez…"')}${sel('kind', 'Tipo', [['', '—'], ...EV_KINDS.map((k) => [k, k])])}</div>
      <div class="row">${f('people', 'Personas (total)', 'number', 'required min="1"')}${f('kids', 'De ellos, niños', 'number', 'min="0"')}${f('space', 'Espacio / mesas', 'text', 'list="dl-evspace" placeholder="Salón, terraza, mesa larga…"')}</div>
      <div class="row">${f('contact_name', 'Persona de contacto')}${f('phone', 'Teléfono', 'tel')}${f('email', 'Email', 'email')}</div>
      <h3>Menú</h3>
      ${ta('menu', 'Menú acordado', 'Entrantes al centro, segundo a elegir, postre, bebida…')}
      ${ta('allergies', 'Alergias e intolerancias', 'Ej.: 2 celíacos, 1 sin lactosa, 1 vegetariano')}
      ${manage ? `<h3>Precio y señal</h3>
      <div class="row">${f('price_pp', 'Precio por persona (€)', 'number')}<div class="field"><label>Total previsto</label><div id="evtot" style="padding:10px 0;font-weight:700">${total ? eur(total) : '—'}</div></div>${f('deposit', 'Señal pedida (€)', 'number')}</div>
      <div class="row"><label class="check" style="flex:1 1 200px"><input type="checkbox" name="deposit_paid" ${e.deposit_paid ? 'checked' : ''}> Señal cobrada</label>${f('deposit_date', 'Fecha de cobro', 'date')}${f('final_total', 'Importe final cobrado (€)', 'number')}</div>` : ''}
      <h3>Estado y notas</h3>
      <div class="row">${sel('status', 'Estado', Object.entries(EV_ST).map(([k, [t]]) => [k, t]))}</div>
      ${ta('notes', 'Notas', 'Decoración, tarta, horario de llegada, quién lo atendió…')}
      ${manage ? `<div class="row" style="justify-content:flex-end;gap:8px">${id ? '<button type="button" class="danger" id="evdel">Borrar</button>' : ''}<button class="primary">${id ? 'Guardar cambios' : 'Apuntar evento'}</button></div>` : ''}
    </form>
    ${id ? `<div class="row" style="margin-top:10px">
      ${wa ? `<a class="btn" target="_blank" rel="noopener" href="${wa}">💬 Enviar confirmación por WhatsApp</a>` : ''}
      <button class="btn" id="evprint">🖨️ Hoja para cocina y sala</button>
      ${e.created_by_name ? `<span class="small muted">Apuntado por ${esc(e.created_by_name)}${e.created_at ? ' el ' + fdate(e.created_at) : ''}</span>` : ''}</div>` : ''}
    <datalist id="dl-evspace"><option value="Salón"><option value="Terraza"><option value="Barra"><option value="Mesa larga"><option value="Todo el local"></datalist>
  </div>
  ${id ? evPrintSheet(e) : ''}`;

  const form = $('#evf', v);
  const recalc = () => { const t = (parseNum(form.price_pp?.value) || 0) * (parseNum(form.people.value) || 0); if ($('#evtot', v)) $('#evtot', v).textContent = t ? eur(t) : '—'; };
  if (form.price_pp) { form.price_pp.oninput = recalc; form.people.addEventListener('input', recalc); }
  if (form.deposit_paid) form.deposit_paid.onchange = () => { if (form.deposit_paid.checked && !form.deposit_date.value) form.deposit_date.value = today(); };
  if ($('#evprint', v)) $('#evprint', v).onclick = () => window.print();
  if (!manage) return;
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const btn = ev.submitter;
    act(btn, async () => {
      const d = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        d[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : parseNum(el.value)) : el.value.trim();
      }
      if (id) await api('events/' + id, { method: 'PUT', body: d });
      else { const r = await api('events', { body: d }); id = r.id; }
      toast('Evento guardado');
      go('#/eventos/' + id);
    });
  };
  const del = $('#evdel', v);
  if (del) del.onclick = () => act(del, async () => {
    const r = await modal(`<h2>¿Qué hacemos con este evento?</h2><p>Si el cliente lo ha anulado, mejor márcalo como <b>cancelado</b>: queda en el historial. Borrar lo elimina del todo (por ejemplo, si se apuntó por error).</p>
      <div class="actions"><button data-close>Volver</button><button value="cancel">Marcar cancelado</button><button class="primary danger" value="del">Borrar</button></div>`);
    if (r === 'cancel') { await api('events/' + id, { method: 'PUT', body: { status: 'cancelado' } }); toast('Evento cancelado'); go('#/eventos/' + id); }
    if (r === 'del') { await api('events/' + id, { method: 'DELETE' }); toast('Evento borrado'); go('#/eventos'); }
  });
}

function evConfirmText(e) {
  const r = S.settings.restaurant_name || 'el restaurante';
  return `Hola${e.contact_name ? ' ' + e.contact_name.split(' ')[0] : ''}, te escribimos de ${r} para confirmar vuestra reserva:\n` +
    `📅 ${evDay(e.event_date)}${e.start_time ? ' a las ' + e.start_time : e.service ? ' (' + e.service.toLowerCase() + ')' : ''}\n` +
    `👥 ${e.people} personas${e.kids ? ` (${e.kids} niños)` : ''}\n` +
    (e.menu ? `🍽️ Menú: ${e.menu}\n` : '') +
    (e.price_pp ? `💶 ${eur(e.price_pp)} por persona\n` : '') +
    (e.deposit > 0 ? (e.deposit_paid ? `✅ Señal de ${eur(e.deposit)} recibida, ¡gracias!\n` : `Para cerrar la reserva necesitamos una señal de ${eur(e.deposit)}.\n`) : '') +
    `Si hay alguna alergia o cambio en el número de personas, avísanos con tiempo. ¡Os esperamos!`;
}

// hoja impresa para cocina y sala: sin precios
function evPrintSheet(e) {
  const line = (t, x) => (x ? `<tr><th style="text-align:left;width:30%;vertical-align:top">${t}</th><td>${esc(x).replace(/\n/g, '<br>')}</td></tr>` : '');
  return `<div class="print-only"><h1>${esc(e.title)}</h1><h2>${evDay(e.event_date)} · ${esc(evHours(e))}</h2>
    <table>${line('Personas', evPeople(e))}${line('Tipo', e.kind)}${line('Espacio', e.space)}${line('Contacto', [e.contact_name, e.phone].filter(Boolean).join(' · '))}
    ${line('Menú', e.menu)}${line('⚠️ Alergias', e.allergies)}${line('Notas', e.notes)}${line('Estado', (EV_ST[e.status] || EV_ST.consulta)[0])}</table></div>`;
}
