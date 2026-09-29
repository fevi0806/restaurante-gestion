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
};
