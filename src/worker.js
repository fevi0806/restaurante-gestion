// Punto de entrada en Cloudflare Workers: /api/* va al servidor; el resto son las pantallas (carpeta public)
import { onRequest } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
      return onRequest({ request, env, ctx, params: { route } });
    }
    return env.ASSETS.fetch(request);
  },
  // Resumen semanal por email (opcional; ver la guía): necesita el enlace EMAIL y las variables SUMMARY_TO y SUMMARY_FROM
  async scheduled(event, env, ctx) {
    if (!env.EMAIL || !env.SUMMARY_TO || !env.SUMMARY_FROM) return;
    const { weeklyEmail } = await import('./email.js');
    ctx.waitUntil(weeklyEmail(env));
  },
};
