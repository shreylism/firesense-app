importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyARCJE33mjlRhmls89gY2DSkyb6EfnfRJw",
  authDomain: "g63-fireguard.firebaseapp.com",
  projectId: "g63-fireguard",
  storageBucket: "g63-fireguard.firebasestorage.app",
  messagingSenderId: "578559262203",
  appId: "1:578559262203:web:cb3c7286c2ad30c6651f5e"
});

const messaging = firebase.messaging();

// The backend sends data-only messages, and this shows them.
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  self.registration.showNotification(d.title || 'FireSense alert', {
    body: d.body || 'Check the dashboard.',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'firesense-alert',
    requireInteraction: true
  });
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow('./'));
});
