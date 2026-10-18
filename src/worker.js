// Punto de entrada en Cloudflare Workers: /api/* va al servidor; el resto son las pantallas (carpeta public)
import { onRequest } from './api.js';
import { ensureSchema } from './migrate.js';
import { deliver } from './push.js';
import { eveningReminders } from './turnos.js';
import { recomputeStock } from './migrate.js';
import { localDay } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
      return onRequest({ request, env, ctx, params: { route } });
    }
    return env.ASSETS.fetch(request);
  },
  // Tareas programadas (ver [triggers] en wrangler.toml):
  //  - cada 15 min: avisos al móvil pendientes y, de 20:00 a 22:00, el recordatorio "mañana entras a las…"
  //  - lunes 7:00 UTC: resumen semanal por email (opcional; necesita EMAIL, SUMMARY_TO y SUMMARY_FROM)
  async scheduled(event, env, ctx) {
    if (event.cron === '0 7 * * 1') {
      if (!env.EMAIL || !env.SUMMARY_TO || !env.SUMMARY_FROM) return;
      const { weeklyEmail } = await import('./email.js');
      ctx.waitUntil(weeklyEmail(env));
      return;
    }
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      // una vez al día, de madrugada, se recalcula el stock guardado desde los movimientos (autocorrección)
      const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }));
      if (hour >= 4 && hour < 6) {
        const last = (await env.DB.prepare(`SELECT value FROM settings WHERE key = 'stock_heal'`).first())?.value;
        if (last !== localDay()) {
          await recomputeStock(env);
          await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('stock_heal', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(localDay()).run();
        }
      }
      await eveningReminders(env);
      await deliver(env);
    })().catch((e) => console.error('tarea programada', e)));
  },
};
