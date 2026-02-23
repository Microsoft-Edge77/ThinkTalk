importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyCrgPMXzSyS6NXNajPxr0x_J-CTESOtp5w",
    messagingSenderId: "1038562300660",
    projectId: "chat-github-6abb5",
    appId: "1:1038562300660:web:b57b74a7539466e16384a1"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    self.registration.showNotification(payload.notification.title, {
        body: payload.notification.body,
        icon: '/favicon.ico'
    });
});
