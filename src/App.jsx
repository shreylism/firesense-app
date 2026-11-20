        setError("");
      } catch (e) {
        if (active) setError("Could not load camera snapshots. Please check the backend connection.");
      } finally {
        if (active) setLoading(false);
      }
    };

    run();
    const h = setInterval(run, 5000);
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
  const snapshotImageUrl = (shot) => {
    const raw = shot.image_url || shot.url;
    if (!raw) return "";
    return raw.startsWith("/") ? `${API}${raw}` : raw;
  };
  const latestImageUrl = snapshotImageUrl(latest);
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
        {latestImageUrl && (
          <a href={latestImageUrl} target="_blank" rel="noreferrer">
            <img
              src={latestImageUrl}
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
        <p className="sub mono">Captured: {capturedAt(latest) ? new Date(capturedAt(latest)).toLocaleString() : "Time unavailable"}{" "}{ageMin !== null && ageMin > 5 && <span className="pill off">No new snapshot for {ageText}</span>}</p>
      </div>

      <div className="card">
        <h2>Camera history</h2>
        {error && <p className="sub">{error}</p>}
        <div className="shots">
          {shots.map((s) => (
            <figure key={s.id || s.image_url || s.url}>
              {snapshotImageUrl(s) && <a href={snapshotImageUrl(s)} target="_blank" rel="noreferrer">
                <img src={snapshotImageUrl(s)} alt={"Snapshot from " + (s.device_id || "camera")} loading="lazy" />
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
