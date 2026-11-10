import { initializeApp, getApps, getApp } from "firebase/app";
import { getMessaging, getToken } from "firebase/messaging";
import { API } from "./api.js";

const FCFG = { apiKey: "AIzaSyARCJE33mjlRhmls89gY2DSkyb6EfnfRJw", authDomain: "g63-fireguard.firebaseapp.com", projectId: "g63-fireguard", messagingSenderId: "578559262203", appId: "1:578559262203:web:cb3c7286c2ad30c6651f5e" };
const VAPID = "BDAqJ_RjyRbOK4EE4bYpIgc99Kf4ftlC1w3jnTzanhXAOafO9mH5LxsjfKbkpd_70nWYjhQAtbtKWPP6A98kmZA";

export async function enableAlerts() {
  if (!("Notification" in window) || !("serviceWorker" in navigator))
    throw new Error("This browser cannot show notifications. On iPhone, tap Share, then Add to Home Screen, and open the app from its icon.");
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error("Notifications are blocked. Allow them for this site in your phone settings.");
  const app = getApps().length ? getApp() : initializeApp(FCFG);
  const reg = await navigator.serviceWorker.register(import.meta.env.BASE_URL + "firebase-messaging-sw.js");
  await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(app), { vapidKey: VAPID, serviceWorkerRegistration: reg });
  if (!token) throw new Error("no token received");
  const r = await fetch((API || "https://firesense-backend.onrender.com") + "/api/v1/push/register", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
  });
  if (!r.ok) throw new Error("server said " + r.status);
  try { localStorage.setItem("alerts", "on"); } catch {}
}