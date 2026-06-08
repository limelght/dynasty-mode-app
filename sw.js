self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  const payload = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch (_) {
      return {body: event.data ? event.data.text() : ''};
    }
  })();

  event.waitUntil(self.registration.showNotification(payload.title || 'Dynasty Mode', {
    body: payload.body || 'New league update available.',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: payload.url || '/'
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data || '/'));
});
