import { useEffect, useState } from "react";
import { DEMO, get } from "./api.js";

/* Payload shape (same from GET /api/v1/status and the WebSocket):
{ gateway:{online}, packets:{total,last_ts,rssi},
  devices:[{id,name,online,level,co,temp,pm25,pm10,smoke}] }  level: 0 ok, 1 warning, 2 critical */

const NODES = [["node-01", "Kitchen"], ["node-02", "Workshop"], ["node-03", "Storage"]];
const r = (a, b) => a + Math.random() * (b - a);

function demoStream(push) {
  let total = 4820;
  const s = NODES.map(([id, name], i) => ({ id, name, online: true, base: i, co: 4 + i, temp: 22 + i, pm25: 8 + i * 2, pm10: 14 + i * 3, smoke: false }));
  window.fsSimulate = (id, mode) => { const d = s.find((x) => x.id === id); if (d) d.force = mode; };
  const tick = () => {
    total++;
    s.forEach((d) => {
      if (d.force === "fire") Object.assign(d, { co: r(120, 180), temp: r(48, 62), pm25: r(150, 220), pm10: r(170, 250), smoke: true });
      else if (d.force === "warn") Object.assign(d, { co: r(42, 60), pm25: r(60, 80), smoke: false });
      else { d.co = Math.max(1, d.co + r(-.6, .6) + (4 + d.base - d.co) * .1); d.temp += r(-.2, .2) + (22 + d.base - d.temp) * .05; d.pm25 = Math.max(2, d.pm25 + r(-1, 1) + (8 + d.base * 2 - d.pm25) * .1); d.pm10 = Math.max(d.pm25, d.pm10 + r(-1, 1)); d.smoke = false; }
      d.level = d.smoke || d.co >= 100 ? 2 : d.co >= 35 || d.pm25 >= 55 ? 1 : 0;
    });
    push({ gateway: { online: true }, packets: { total, last_ts: new Date().toISOString(), rssi: Math.round(r(-104, -92)) }, devices: s.map((d) => ({ ...d })) });
  };
  tick();
  const h = setInterval(tick, 2000);
  return () => clearInterval(h);
}

export function useLive() {
  const [data, setData] = useState(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    // Demo mode: simulated stream, no backend needed
    if (DEMO) {
      setLive(true);
      return demoStream(setData);
    }

    // Real mode: poll the backend every 3 seconds
    let stop = false;
    const poll = () =>
      get("/api/v1/status")
        .then((d) => { if (!stop) { setData(d); setLive(true); } })
        .catch(() => { if (!stop) setLive(false); });
    poll();
    const h = setInterval(poll, 3000);
    return () => { stop = true; clearInterval(h); };
  }, []);

  return { data, live };
}

/* History: GET /api/v1/history?device=&range=1h|24h|7d -> [{t,co,temp,pm25,pm10,smoke}] */
export async function loadHistory(device, range, metric) {
    if (!DEMO) {
      const rows = await get(`/api/v1/readings?device_id=${device}&range=${range}`);
      return rows
        .map((x) => ({ t: x.ts, co: x.co_ppm, temp: x.temp_c, pm25: x.pm25, pm10: x.pm10 }))
        .filter((x) => x[metric] != null)
        .map((x) => ({ ...x, [metric]: Number(x[metric]) }));
    }
  const n = range === "1h" ? 60 : range === "24h" ? 96 : 168;
  const base = { co: 5, temp: 22, pm25: 9, pm10: 15 }[metric];
  return Array.from({ length: n }, (_, i) => ({ t: i, [metric]: Math.max(0, base * (1 + .15 * Math.sin(i / n * 6.28 * (range === "7d" ? 7 : 1))) + r(-.3, .3) * base * .3) }));
}
