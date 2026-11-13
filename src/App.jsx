import { useEffect, useState } from "react";
import { useLive, loadHistory } from "./useLive.js";
import { DEMO, csvUrl, login, logout, isAdmin, get, put } from "./api.js";
import { startAlarm, stopAlarm, unlockAudio } from "./alarm.js";
import { enableAlerts } from "./push.js";

const LEVEL = ["Normal", "Warning", "Fire suspected", "Fire alert"];
const CLS = ["", "warn", "crit", "crit"];
const METRICS = { co: "CO", temp: "Temperature", pm25: "PM2.5", pm10: "PM10" };
const RANGES = { "1h": "1 hour", "24h": "24 hours", "7d": "7 days" };
const TABS = [["overview", "Overview", "◧"], ["sensors", "Sensors", "◉"], ["history", "History", "∿"], ["alerts", "Alerts", "▲"], ["camera", "Camera", "▣"], ["devices", "Devices", "▣"]];

export default function App() {
  const { data, live } = useLive();
  const [sel, setSel] = useState("node-01");
  const [tab, setTab] = useState(location.hash.slice(1) || "overview");
  const [admin, setAdmin] = useState(isAdmin());
  const [log, setLog] = useState([]);
  const [prev, setPrev] = useState({});
  const [toast, setToast] = useState("");
  const devices = data?.devices ?? [];
  const worst = devices.filter((d) => d.online).reduce((a, d) => (d.level > (a?.level ?? 0) ? d : a), null);
  const cur = devices.find((d) => d.id === sel) ?? devices[0];
  const go = (t) => { setTab(t); location.hash = t; };
    const [silenced, setSilenced] = useState(false);
    const alarmOn = (worst?.level ?? 0) >= 2;
    useEffect(() => {
      window.addEventListener("pointerdown", unlockAudio, { once: true });
    }, []);
    useEffect(() => {
      if (alarmOn && !silenced) startAlarm("Fire detected at " + worst.name + ". Please evacuate.");
      else stopAlarm();
      if (!alarmOn && silenced) setSilenced(false);
    }, [alarmOn, silenced]);

  useEffect(() => {
    if (!devices.length) return;
    const next = {}, add = [];
    devices.forEach((d) => {
      next[d.id] = d.level;
      if (prev[d.id] !== undefined && d.level !== prev[d.id]) {
        const text = d.level === 0 ? "Back to normal" : `CO ${d.co.toFixed(0)} ppm, PM2.5 ${d.pm25.toFixed(0)}${d.smoke ? ", smoke detected" : ""}`;
        add.push({ t: new Date(), name: d.name, level: d.level, text });
        if (d.level >= 2) { setToast(`Fire alert: ${d.name}, ${text}`); setTimeout(() => setToast(""), 6000); }
      }
    });
    setPrev(next);
    if (add.length) setLog((l) => [...add.reverse(), ...l].slice(0, 100));
  }, [data]);

  const open = log.filter((e) => e.level > 0).length;
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><h1>FIRESENSE</h1><div className="sub">{admin ? "Admin" : "Public view"}</div></div>
        <nav>
          {TABS.map(([k, label, ic]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => go(k)}><span aria-hidden="true">{ic}</span> {label}{k === "alerts" && open > 0 && <b className="badge">{open}</b>}</button>
          ))}
        </nav>
        <div className="sidefoot"><AlertsButton /><span className={"pill " + (live ? "live" : "off")}><span className="dot" />{live ? "Live" : "Reconnecting"}</span></div>
      </aside>
      <main>
        <div className="top"><h2 className="title">{(TABS.find((t) => t[0] === tab) || TABS[0])[1]}</h2><Banner worst={worst} compact /></div>
        {!data ? <p className="sub">Waiting for data…</p> : (
          <>
            {tab === "overview" && (<>
              <NodePick devices={devices} sel={sel} setSel={setSel} />
              {cur && <Cards d={cur} />}
              <div className="two"><History device={cur?.id} /><div>
                <PacketCard data={data} />
                <StatusCard data={data} devices={devices} />
              </div></div>
            </>)}
            {tab === "sensors" && <Sensors devices={devices} setSel={(i) => { setSel(i); go("overview"); }} />}
            {tab === "history" && (<><NodePick devices={devices} sel={sel} setSel={setSel} /><History device={cur?.id} /></>)}
            {tab === "alerts" && <Alerts log={log} />}
            {tab === "camera" && <Camera />}
            {tab === "devices" && <div className="two"><StatusCard data={data} devices={devices} /><PacketCard data={data} /></div>}
            {tab === "admin" && <Admin admin={admin} setAdmin={setAdmin} sel={sel} />}
          </>
        )}
      </main>
      {toast && <div className="toast" role="alert">{toast}</div>}
      {alarmOn && !silenced && <button className="silence" onClick={() => setSilenced(true)}>Silence alarm</button>}
    </div>
  );
}

function NodePick({ devices, sel, setSel }) {
  return <div className="chips">{devices.map((d) => <button key={d.id} className={d.id === sel ? "on" : ""} onClick={() => setSel(d.id)}>{d.name}{d.level > 0 && " ●"}</button>)}</div>;
}

function PacketCard({ data }) {
  return (
    <div className="card">
      <h2>Packets</h2>
      <div className="val mono">{data.packets.total.toLocaleString()}</div>
      <div className="sub">Total received</div>
      <div className="row"><span className="lbl">Last packet</span><span className="mono">{new Date(data.packets.last_ts).toLocaleTimeString()}</span></div>
      <div className="row"><span className="lbl">Signal</span><span className="mono">{data.packets.rssi} dBm</span></div>
    </div>
  );
}

function StatusCard({ data, devices }) {
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h2>Status</h2>
      <div className="row"><span>Gateway (Pi + SX1302)</span><span className={"pill " + (data.gateway.online ? "" : "off")}>{data.gateway.online ? "Online" : "Offline"}</span></div>
      {devices.map((d) => (
        <div className="row" key={d.id}>
          <span>{d.name} <span className="sub mono">{d.id}</span></span>
          <span className={"pill " + (d.online ? CLS[d.level] : "off")}>{d.online ? LEVEL[d.level] : "Offline"}</span>
        </div>
      ))}
    </div>
  );
}

function Sensors({ devices, setSel }) {
  return (
    <div className="card tablewrap">
      <table>
        <thead><tr><th>Node</th><th>Status</th><th>CO (ppm)</th><th>Temp (°C)</th><th>PM2.5</th><th>PM10</th><th>Smoke</th></tr></thead>
        <tbody>{devices.map((d) => (
          <tr key={d.id} onClick={() => setSel(d.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSel(d.id)}>
            <td>{d.name}<div className="sub mono">{d.id}</div></td>
            <td><span className={"pill " + (d.online ? CLS[d.level] : "off")}>{d.online ? LEVEL[d.level] : "Offline"}</span></td>
            <td className="mono">{d.co.toFixed(1)}</td><td className="mono">{d.temp.toFixed(1)}</td>
            <td className="mono">{d.pm25.toFixed(0)}</td><td className="mono">{d.pm10.toFixed(0)}</td>
            <td><span className={"pill " + (d.smoke ? "crit" : "")}>{d.smoke ? "Detected" : "None"}</span></td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

function Alerts({ log }) {
  return (
    <div className="card">
      <h2>Alert log</h2>
      {log.length === 0 ? <p className="sub">No alerts since this page was opened. In production this list comes from the alerts table.</p>
        : log.map((e, i) => (
          <div className="row" key={i}>
            <span><span className={"pill " + CLS[e.level]}>{e.level ? LEVEL[e.level] : "Resolved"}</span> <b>{e.name}</b> <span className="sub">{e.text}</span></span>
            <span className="mono sub">{e.t.toLocaleTimeString()}</span>
          </div>))}
    </div>
  );
}

function Banner({ worst, compact }) {
  const l = worst?.level ?? 0;
  return (
    <div className={"banner " + CLS[l]}>
      <span><b>{["All clear", "Fire warning", "Fire suspected", "Fire alert"][l]}</b>{!compact && <><br /><span className="sub" style={{ color: "inherit" }}>{["All online sensors read normal.", "Readings are above warning limits.", "Two sensor types at fire level. Check the area now.", "Multiple sensors at fire level. Evacuate and check now."][l]}</span></>}</span>
      <span className="mono">{l ? worst.name : ""}</span>
    </div>
  );
}

function Cards({ d }) {
  const C = ({ label, v, unit, cls }) => <div className={"card " + (cls || "")}><div className="lbl">{label}</div><div className="val mono">{v}<small>{unit}</small></div></div>;
  return (
    <div className="grid">
      <C label="Carbon monoxide" v={d.co.toFixed(1)} unit="ppm" cls={d.co >= 50 ? "crit" : d.co >= 25 ? "warn" : ""} />
      <C label="Temperature" v={d.temp.toFixed(1)} unit="°C" cls={d.temp >= 65 ? "crit" : d.temp >= 55 ? "warn" : ""} />
      <C label="PM2.5" v={d.pm25.toFixed(0)} unit="µg/m³" cls={d.pm25 >= 200 ? "crit" : d.pm25 >= 100 ? "warn" : ""} />
      <C label="PM10" v={d.pm10.toFixed(0)} unit="µg/m³" cls={d.pm10 >= 250 ? "crit" : d.pm10 >= 150 ? "warn" : ""} />
      <div className={"card " + (d.smoke ? "crit" : "")}><div className="lbl">Smoke / fire</div><div className="val" style={{ marginTop: 4 }}><span className={"pill " + (d.smoke ? "crit" : "")}>{d.smoke ? "Detected" : "None"}</span></div></div>
    </div>
  );
}

function History({ device, latest }) {
  const [range, setRange] = useState("1h");
  const [metric, setMetric] = useState("co");
  const [pts, setPts] = useState([]);
  useEffect(() => {
    if (!device) return;
    let off = false;
    const run = () => loadHistory(device, range, metric).then((p) => !off && setPts(p.map((x) => x[metric])));
    run();
    const h = setInterval(run, DEMO ? 1e9 : range === "1h" ? 30000 : 120000);
    return () => { off = true; clearInterval(h); };
  }, [device, range, metric]);

  const W = 600, H = 190, L = 34, B = 20, T = 8;
  const mx = Math.max(...pts, 1) * 1.15;
  const x = (i) => L + (W - L - 6) * i / Math.max(pts.length - 1, 1);
  const y = (v) => T + (H - T - B) * (1 - v / mx);
  const path = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const lim = { co: 25, temp: 55, pm25: 100, pm10: 150 }[metric] ?? null;
  const lbl = { "1h": ["60 min ago", "30", "now"], "24h": ["24 h ago", "12 h", "now"], "7d": ["7 days ago", "3.5 d", "now"] }[range];

  return (
    <div className="card">
      <h2>History</h2>
      <div className="chips">{Object.entries(RANGES).map(([k, v]) => <button key={k} className={k === range ? "on" : ""} onClick={() => setRange(k)}>{v}</button>)}</div>
      <div className="chips">{Object.entries(METRICS).map(([k, v]) => <button key={k} className={k === metric ? "on" : ""} onClick={() => setMetric(k)}>{v}</button>)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sensor history chart">
        {[0, 1, 2, 3].map((k) => <g key={k}><line x1={L} x2={W} y1={y(mx * k / 3)} y2={y(mx * k / 3)} stroke="var(--line)" /><text className="ax" x="2" y={y(mx * k / 3) + 3}>{(mx * k / 3).toFixed(0)}</text></g>)}
        {lim && lim < mx && <line x1={L} x2={W} y1={y(lim)} y2={y(lim)} stroke="var(--warn)" strokeDasharray="4 4" />}
        <text className="ax" x={L} y="186">{lbl[0]}</text><text className="ax" x={W / 2} y="186">{lbl[1]}</text><text className="ax" x={W - 24} y="186">{lbl[2]}</text>
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      </svg>
      <div style={{ marginTop: 8 }}>
        {DEMO ? <span className="sub">CSV export is available once the backend is connected.</span>
          : <a className="btn" href={csvUrl(device, range)} download>Download CSV</a>}
      </div>
    </div>
  );
}

function Admin({ admin, setAdmin, sel }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [cfg, setCfg] = useState({ co_warn: 35, co_crit: 100, pm25_warn: 55, offline_min: 5 });
  const [saved, setSaved] = useState("");
  useEffect(() => { if (admin && !DEMO) get("/api/v1/config").then(setCfg).catch(() => {}); }, [admin]);

  if (!admin) return (
    <div className="card">
      <h2>Admin sign in</h2>
      <input type="password" value={pw} placeholder="Password" onChange={(e) => setPw(e.target.value)} />{" "}
      <button onClick={async () => (await login(pw)) ? setAdmin(true) : setErr("Wrong password.")}>Sign in</button>
      {err && <p className="sub">{err}</p>}
    </div>
  );
  const F = ({ k, label }) => <div className="row"><span>{label}</span><input type="number" value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: +e.target.value })} /></div>;
  return (
    <>
      <div className="card">
        <h2>Alert thresholds</h2>
        <F k="co_warn" label="CO warning (ppm)" /><F k="co_crit" label="CO critical (ppm)" />
        <F k="pm25_warn" label="PM2.5 warning (µg/m³)" /><F k="offline_min" label="Offline after (minutes)" />
        <p><button onClick={() => (DEMO ? Promise.resolve() : put("/api/v1/config", cfg)).then(() => setSaved("Saved"), () => setSaved("Could not save"))}>Save changes</button> <span className="sub">{saved}</span></p>
      </div>
      {DEMO && (
        <div className="card" style={{ marginTop: 10 }}>
          <h2>Test the alerts</h2>
          <button onClick={() => window.fsSimulate(sel, "warn")}>Simulate warning</button>{" "}
          <button onClick={() => window.fsSimulate(sel, "fire")}>Simulate fire</button>{" "}
          <button onClick={() => window.fsSimulate(sel, null)}>Reset</button>
        </div>
      )}
      <p><button onClick={() => { logout(); setAdmin(false); }}>Sign out</button></p>
    </>
  );
}


function Camera() {
  const [shots, setShots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (DEMO) {
      setLoading(false);
      return;
    }

    let active = true;
    const run = async () => {
      try {
        const response = await get("/api/v1/camera/snapshots?limit=24");
        if (!active) return;
        // Backend returns { items: [...], count: n }.
        setShots(Array.isArray(response) ? response : (response.items || []));
        setError("");
      } catch (e) {
        if (active) setError("Could not load camera snapshots. Please check the backend connection.");
      } finally {
        if (active) setLoading(false);
      }
    };

    run();
    const h = setInterval(run, 15000);
    return () => {
      active = false;
      clearInterval(h);
    };
  }, []);

  if (DEMO) {
    return (
      <div className="card">
        <h2>Camera</h2>
        <p className="sub">Camera snapshots will appear here when the live backend is connected.</p>
      </div>
    );
  }

  if (loading) return <div className="card"><h2>Camera</h2><p className="sub">Loading camera snapshots…</p></div>;

  if (!shots.length) {
    return (
      <div className="card">
        <h2>Camera</h2>
        {error ? <p className="sub">{error}</p> : <p className="sub">No camera snapshots received yet.</p>}
      </div>
    );
  }

  const latest = shots[0];
  const capturedAt = (s) => s.captured_at || s.ts || s.timestamp;
  const percent = (v) => Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)}%` : "—";
  const ageMin = capturedAt(latest) ? (Date.now() - new Date(capturedAt(latest)).getTime()) / 60000 : null;
  const ageText = ageMin === null ? "" : ageMin < 120 ? `${Math.round(ageMin)} min` : `${(ageMin / 60).toFixed(1)} h`;

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row">
          <h2>Latest camera snapshot</h2>
          <span className={"pill " + (latest.alarm ? "crit" : "")}>{latest.alarm ? "ALARM ON" : "No alarm"}</span>
        </div>
        {latest.url && (
          <a href={latest.url} target="_blank" rel="noreferrer">
            <img
              src={latest.url}
              alt={"Latest snapshot from " + (latest.device_id || "camera")}
              style={{ display: "block", width: "100%", maxHeight: 440, objectFit: "contain", borderRadius: 8, background: "var(--line)" }}
            />
          </a>
        )}
        <div className="grid" style={{ marginTop: 12 }}>
          <div><div className="lbl">Prediction</div><b>{latest.prediction || "—"}</b></div>
          <div><div className="lbl">Confidence</div><b className="mono">{percent(latest.confidence)}</b></div>
          <div><div className="lbl">Fire probability</div><b className="mono">{percent(latest.fire_probability)}</b></div>
          <div><div className="lbl">Device</div><b className="mono">{latest.device_id || "—"}</b></div>
        </div>
        <p className="sub mono">Captured: {capturedAt(latest) ? new Date(capturedAt(latest)).toLocaleString() : "Time unavailable"}{" "}           {ageMin !== null && ageMin > 5 && <span className="pill off">No new snapshot for {ageText}</span>}</p>
      </div>

      <div className="card">
        <h2>Camera history</h2>
        {error && <p className="sub">{error}</p>}
        <div className="shots">
          {shots.map((s) => (
            <figure key={s.id || s.url}>
              {s.url && <a href={s.url} target="_blank" rel="noreferrer">
                <img src={s.url} alt={"Snapshot from " + (s.device_id || "camera")} loading="lazy" />
              </a>}
              <figcaption className="sub mono">
                {s.device_id || "Camera"} · {capturedAt(s) ? new Date(capturedAt(s)).toLocaleString() : "Time unavailable"}
                <br />{s.prediction || "—"} · Confidence: {percent(s.confidence)}
                <br />Fire: {percent(s.fire_probability)} · {s.alarm ? "ALARM" : "No alarm"}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}

function AlertsButton() {
  const isOn = () => { try { return "Notification" in window && Notification.permission === "granted" && localStorage.getItem("alerts") === "on"; } catch { return false; } };
  const [ok, setOk] = useState(isOn());
  const [msg, setMsg] = useState("");
  return (
    <div style={{ marginBottom: 8 }}>
      {ok ? <span className="pill">Alerts on</span>
        : <button className="on" onClick={async () => { unlockAudio(); try { await enableAlerts(); setOk(true); setMsg(""); } catch (e) { setMsg(e.message); } }}>Enable alerts</button>}
      {msg && <p className="sub">{msg}</p>}
    </div>
  );
}
