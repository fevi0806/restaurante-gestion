// Service worker: solo avisos al móvil (no guarda nada en caché).
// El aviso llega vacío y aquí se pregunta a la app qué hay que mostrar.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => e.waitUntil((async () => {
  let items = [];
  try {
    const sub = await self.registration.pushManager.getSubscription();
    const r = await fetch('/api/push/inbox', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub && sub.endpoint }) });
    if (r.ok) items = (await r.json()).items || [];
  } catch (err) { /* sin conexión: aviso genérico */ }
  if (!items.length) items = [{ title: 'Tienes avisos nuevos', body: 'Toca para abrir la app.', url: '/', tag: 'generico' }];
  for (const n of items.slice(-3)) {
    await self.registration.showNotification(n.title, { body: n.body || '', tag: n.tag || undefined, renotify: !!n.tag, data: { url: n.url || '/' }, icon: '/icon-192.png', badge: '/icon-192.png' });
  }
})()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (c.url.startsWith(self.location.origin)) { await c.focus(); return c.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
