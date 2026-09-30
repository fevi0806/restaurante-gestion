// Punto de entrada en Cloudflare Workers: /api/* va al servidor; el resto son las pantallas (carpeta public)
import { onRequest } from './api.js';
import { ensureSchema } from './migrate.js';
import { deliver } from './push.js';
import { eveningReminders } from './turnos.js';

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
      await eveningReminders(env);
      await deliver(env);
    })().catch((e) => console.error('tarea programada', e)));
  },
};
