// Empty VITE_API_URL = demo mode (simulated data).
export const API = import.meta.env.VITE_API_URL || "";
export const DEMO = !API;
const WS = API.replace(/^http/, "ws");

let token = sessionStorage.getItem("fs_token") || "";
export const isAdmin = () => !!token;
const headers = () => (token ? { Authorization: `Bearer ${token}` } : {});

export async function get(path) {
  const r = await fetch(API + path, { headers: headers() });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
export async function put(path, body) {
  const r = await fetch(API + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers() },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
export async function login(password) {
  if (DEMO) { token = "demo"; return true; }
  const r = await fetch(API + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) return false;
  token = (await r.json()).access_token;
  sessionStorage.setItem("fs_token", token);
  return true;
}
export function logout() { token = ""; sessionStorage.removeItem("fs_token"); }

export const csvUrl = (device, range) =>
  `${API}/api/v1/export.csv?device=${device}&range=${range}`;
export const wsUrl = () => `${WS}/ws/live`;
