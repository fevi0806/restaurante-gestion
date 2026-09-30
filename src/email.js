// Envío del resumen semanal por email (solo si está configurado; ver la guía)
import { onRequest } from './api.js';

export async function weeklyEmail(env) {
  // se genera el resumen con los permisos del superusuario, como si lo pidiera desde la app
  const u = await env.DB.prepare('SELECT id FROM users WHERE is_super = 1 AND active = 1 ORDER BY id LIMIT 1').first();
  if (!u) return;
  const token = 'cron-' + crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+5 minutes'))`).bind(token, u.id).run();
  try {
    const res = await onRequest({ request: new Request('https://app/api/summary', { headers: { cookie: 'sid=' + token } }), env, params: { route: ['summary'] } });
    const d = await res.json();
    const eur = (n) => (Number(n) || 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
    const pct = (n) => (n == null ? '—' : (Math.round(n * 10) / 10).toLocaleString('es-ES') + ' %');
    const row = (l, v) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${l}</td><td style="padding:4px 0"><b>${v}</b></td></tr>`;
    const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2>Resumen semanal · ${d.from} al ${d.to}</h2><table>
      ${row('Ventas sin IVA', eur(d.cur.revenue))}${row('Caja real cobrada', eur(d.cur.cash.total))}${row('Food cost real', pct(d.cur.food_cost_real))}
      ${row('Mermas', eur(d.cur.waste))}${row('Consumo de personal', eur(d.cur.staff))}${row('Compras', eur(d.cur.purchases))}${row('Resultado estimado', eur(d.cur.result))}</table>
      <p>Detalle completo en la app: Panel de control → Resumen semanal.</p></div>`;
    await env.EMAIL.send({ to: env.SUMMARY_TO, from: env.SUMMARY_FROM, subject: `Resumen semanal ${d.from} – ${d.to}`, html, text: html.replace(/<[^>]+>/g, ' ') });
  } finally {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
}
