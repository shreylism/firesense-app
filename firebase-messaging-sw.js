importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
firebase.initializeApp({apiKey:"AIzaSyARCJE33mjlRhmls89gY2DSkyb6EfnfRJw",authDomain:"g63-fireguard.firebaseapp.com",projectId:"g63-fireguard",messagingSenderId:"578559262203",appId:"1:578559262203:web:cb3c7286c2ad30c6651f5e"});
const messaging = firebase.messaging();
messaging.onBackgroundMessage(function (p) {
  const d = p.data || {};
  self.registration.showNotification(d.title || 'FireSense', {
    body: d.body || '', tag: 'fire', requireInteraction: true,
    vibrate: [300, 150, 300], icon: 'icon-192.png'
  });
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(clients.openWindow('./'));
});
