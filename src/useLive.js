import { useEffect, useState } from "react";
import { DEMO, get } from "./api.js";

/* Payload shape (from GET /api/v1/status):
{ logic_version, thresholds, levels, camera_trigger_mode,
  gateway:{online}, packets:{total,last_ts,rssi},
  devices:[{id,name,online,level,level_name,camera_trigger,camera_trigger_checks,
            co,temp,pm25,pm10,pm1,pm4,smoke}] }
level: 0 normal, 1 warning, 2 fire suspected, 3 fire alert (same as main.py) */

// Copy of the backend thresholds. Used by demo mode and as a fallback.
// In real mode the dashboard uses data.thresholds sent by the API.
export const DEMO_TH = {
  temp_warn: 35.0, temp_fire: 40.0,
  co_warn: 7.5, co_fire: 15.0,
  pm25_warn: 120.0, pm25_fire: 150.0,
  pm10_warn: 120.0, pm10_fire: 150.0,
};
export const LEVEL_NAMES = ["NORMAL", "WARNING", "FIRE SUSPECTED", "FIRE ALERT"];

// Mirrors classify() in main.py (without the temperature rate-of-rise)
function demoClassify(temp, co, pm25, pm10) {
  const T = DEMO_TH;
  const strong = new Set();
  let warn = false;

  if (temp >= T.temp_fire) strong.add("temperature");
  else if (temp >= T.temp_warn) warn = true;

  if (co >= T.co_fire) strong.add("co");
  else if (co >= T.co_warn) warn = true;

  if (pm25 >= T.pm25_fire || pm10 >= T.pm10_fire) strong.add("particles");
  else if (pm25 >= T.pm25_warn || pm10 >= T.pm10_warn) warn = true;

  if (strong.size >= 3) return 3;
  if (strong.size === 2) return 2;
  if (strong.size === 1 || warn) return 1;
  return 0;
}

const NODES = [["node-01", "Kitchen"], ["node-02", "Workshop"], ["node-03", "Storage"]];
const r = (a, b) => a + Math.random() * (b - a);

function demoStream(push) {
  let total = 4820;
  const s = NODES.map(([id, name], i) => ({ id, name, online: true, base: i, co: 4 + i, temp: 22 + i, pm25: 8 + i * 2, pm10: 14 + i * 3, pm1: 5, pm4: 10, smoke: false }));
  window.fsSimulate = (id, mode) => { const d = s.find((x) => x.id === id); if (d) d.force = mode; };
  const tick = () => {
    total++;
    s.forEach((d) => {
      if (d.force === "fire") Object.assign(d, { co: r(16, 40), temp: r(41, 62), pm25: r(150, 220), pm10: r(155, 250) });
      else if (d.force === "warn") Object.assign(d, { co: r(7.5, 14), temp: r(35.5, 39), pm25: r(120, 145), pm10: r(120, 145) });
      else { d.co = Math.max(1, d.co + r(-.6, .6) + (4 + d.base - d.co) * .1); d.temp += r(-.2, .2) + (22 + d.base - d.temp) * .05; d.pm25 = Math.max(2, d.pm25 + r(-1, 1) + (8 + d.base * 2 - d.pm25) * .1); d.pm10 = Math.max(d.pm25, d.pm10 + r(-1, 1)); }
      d.smoke = d.pm25 >= DEMO_TH.pm25_fire || d.pm10 >= DEMO_TH.pm10_fire;
      d.level = demoClassify(d.temp, d.co, d.pm25, d.pm10);
      d.level_name = LEVEL_NAMES[d.level];
      d.camera_trigger_checks = {
        temperature: d.temp >= DEMO_TH.temp_warn,
        co: d.co >= DEMO_TH.co_warn,
        pm25: d.pm25 >= DEMO_TH.pm25_warn,
        pm10: d.pm10 >= DEMO_TH.pm10_warn,
      };
      d.camera_trigger = Object.values(d.camera_trigger_checks).every(Boolean);
    });
    push({
      thresholds: DEMO_TH,
      levels: LEVEL_NAMES,
      gateway: { online: true },
      packets: { total, last_ts: new Date().toISOString(), rssi: Math.round(r(-104, -92)) },
      devices: s.map((d) => ({ ...d })),
    });
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

/* History: GET /api/v1/readings?device_id=&range=1h|24h|7d */
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
