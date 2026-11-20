import csv, hmac, io, json, math, os, time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import firebase_admin
from firebase_admin import credentials, messaging
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, ConfigDict, Field, model_validator

DATABASE_URL = os.environ["DATABASE_URL"]
API_KEY = os.environ["GATEWAY_API_KEY"]
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
SESSION_SECRET = os.environ.get("SESSION_SECRET") or ADMIN_PASSWORD
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://shreylism.github.io").split(",") if o.strip()]
ONLINE_SECONDS = 90
ALERT_MAX_AGE = timedelta(minutes=2)
MAX_TOKENS = 1000
ADMIN_TOKEN_HOURS = 8

# ---------- fire decision thresholds ----------
TH = {
    "temp_warn": 35.0, "temp_fire": 40.0,
    "rate_warn": 5.0,  "rate_fire": 8.0,
    "co_warn": 7.5,   "co_fire": 15.0,
    "pm25_warn": 200.0, "pm25_fire": 250.0,
    "pm10_warn": 200.0, "pm10_fire": 250.0,
}
LEVEL_NAMES = ["NORMAL", "WARNING", "FIRE SUSPECTED", "FIRE ALERT"]
LOGIC_VERSION = "firesense-central-v1"
CAMERA_TRIGGER_LEVEL = 1
CAMERA_TRIGGER_MODE = "ALL_WARNING_THRESHOLDS"
CAMERA_CAPTURE_INTERVAL_SECONDS = 5


def public_logic_config():
    return {
        "logic_version": LOGIC_VERSION,
        "thresholds": TH,
        "levels": LEVEL_NAMES,
        "camera_trigger_level": CAMERA_TRIGGER_LEVEL,
        "camera_trigger_level_name": LEVEL_NAMES[CAMERA_TRIGGER_LEVEL],
        "camera_trigger_mode": CAMERA_TRIGGER_MODE,
        "camera_capture_interval_seconds": CAMERA_CAPTURE_INTERVAL_SECONDS,
        "camera_trigger_condition": (
            f"TEMP >= {TH['temp_warn']} C AND CO >= {TH['co_warn']} ppm "
            f"AND PM2.5 >= {TH['pm25_warn']} ug/m3 "
            f"AND PM10 >= {TH['pm10_warn']} ug/m3; "
            "all four must be present and true"
        ),
        "classification": {
            "temperature": "temp_c >= temp_fire OR temp_rate_c_min >= rate_fire => strong temperature signal; warn thresholds produce WARNING",
            "co": "co_ppm >= co_fire => strong CO signal; co_warn produces WARNING",
            "particles": "pm25 >= pm25_fire OR pm10 >= pm10_fire => strong smoke signal; warn thresholds produce WARNING",
            "level_3": "3 or more strong signal groups (temperature, CO, and particles)",
            "level_2": "2 strong signal groups",
            "level_1": "1 strong signal group or any warning signal",
            "level_0": "no warning or strong signals",
            "missing_sensors": "missing sensor values are ignored; they are not treated as zero",
        },
    }


def classify(temp, rate, co, pm25, pm10):
    """Return (level 0-3, reasons). IR sensor is not installed."""
    strong, warn, why = set(), set(), []

    def ge(value, threshold):
        return value is not None and value >= threshold

    if ge(temp, TH["temp_fire"]) or ge(rate, TH["rate_fire"]):
        strong.add("temperature")
        why.append("temperature")
    elif ge(temp, TH["temp_warn"]) or ge(rate, TH["rate_warn"]):
        warn.add("temperature")

    if ge(co, TH["co_fire"]):
        strong.add("co")
        why.append("CO")
    elif ge(co, TH["co_warn"]):
        warn.add("co")

    if ge(pm25, TH["pm25_fire"]) or ge(pm10, TH["pm10_fire"]):
        strong.add("particles")
        why.append("smoke particles")
    elif ge(pm25, TH["pm25_warn"]) or ge(pm10, TH["pm10_warn"]):
        warn.add("particles")

    strong_count = len(strong)
    if strong_count >= 3:
        return 3, why
    if strong_count == 2:
        return 2, why
    if strong_count == 1 or warn:
        return 1, why
    return 0, why


def camera_warning_checks(temp, co, pm25, pm10):
    return {
        "temperature": temp is not None and temp >= TH["temp_warn"],
        "co": co is not None and co >= TH["co_warn"],
        "pm25": pm25 is not None and pm25 >= TH["pm25_warn"],
        "pm10": pm10 is not None and pm10 >= TH["pm10_warn"],
    }


def all_warning_thresholds_met(temp, co, pm25, pm10):
    checks = camera_warning_checks(temp, co, pm25, pm10)
    return all(checks.values())


pool = ConnectionPool(
    DATABASE_URL,
    min_size=1,
    max_size=5,
    open=False,
    kwargs={"row_factory": dict_row, "prepare_threshold": None},
)

# ---------- Firebase notifications ----------
FCM_READY = False
try:
    _sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if _sa:
        firebase_admin.initialize_app(credentials.Certificate(json.loads(_sa)))
        FCM_READY = True
    else:
        print("FIREBASE_SERVICE_ACCOUNT not set: notifications disabled")
except Exception as e:
    print("Firebase init failed:", e)


@asynccontextmanager
async def lifespan(app):
    pool.open()
    yield
    pool.close()


app = FastAPI(title="FIRESENSE API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Reading(BaseModel):
    model_config = ConfigDict(extra="allow")
    device_id: str
    gateway_id: Optional[str] = None
    ts: Optional[datetime] = None
    seq: Optional[int] = None
    rssi: Optional[float] = None
    snr: Optional[float] = None
    co_ppm: Optional[float] = None
    temp_c: Optional[float] = None
    pm25: Optional[float] = None
    pm10: Optional[float] = None
    pm1: Optional[float] = None
    pm4: Optional[float] = None
    ir: Optional[float] = None
    status: int = Field(0, ge=0, le=2)
    raw_b64: Optional[str] = None

    @model_validator(mode="after")
    def clean(self):
        for f in (
            "rssi", "snr", "co_ppm", "temp_c",
            "pm25", "pm10", "pm1", "pm4", "ir"
        ):
            v = getattr(self, f)
            if v is not None and not math.isfinite(v):
                setattr(self, f, None)
        if self.seq is not None and not (-2**31 <= self.seq < 2**31):
            self.seq = self.seq % 2147483647
        return self


class Heartbeat(BaseModel):
    gateway_id: str


class PushToken(BaseModel):
    token: str = Field(min_length=20, max_length=4096)


class Login(BaseModel):
    password: str = Field(max_length=200)


def check(key: Optional[str]):
    if not key or not hmac.compare_digest(key, API_KEY):
        raise HTTPException(401, "bad api key")


# ---------- admin login ----------
def _sign(msg: str) -> str:
    return hmac.new(SESSION_SECRET.encode(), msg.encode(), "sha256").hexdigest()


def make_token() -> str:
    exp = int(time.time()) + ADMIN_TOKEN_HOURS * 3600
    return f"{exp}.{_sign(str(exp))}"


def require_admin(authorization: Optional[str] = Header(None)):
    if not ADMIN_PASSWORD:
        raise HTTPException(503, "admin login is not configured")
    try:
        scheme, token = (authorization or "").split(" ", 1)
        exp, sig = token.split(".", 1)
        ok = (
            scheme.lower() == "bearer"
            and hmac.compare_digest(sig, _sign(exp))
            and int(exp) > time.time()
        )
    except Exception:
        ok = False
    if not ok:
        raise HTTPException(401, "admin login required")


def send_push(title: str, body: str):
    if not FCM_READY:
        return
    try:
        with pool.connection() as c:
            tokens = [
                x["token"]
                for x in c.execute("select token from push_tokens").fetchall()
            ]
        if not tokens:
            return
        tokens = tokens[:500]
        msg = messaging.MulticastMessage(
            data={"title": title, "body": body},
            tokens=tokens,
            android=messaging.AndroidConfig(priority="high"),
            webpush=messaging.WebpushConfig(
                headers={"Urgency": "high", "TTL": "300"}
            ),
        )
        resp = messaging.send_each_for_multicast(msg)
        dead = [
            t for t, x in zip(tokens, resp.responses)
            if not x.success and isinstance(
                x.exception,
                (messaging.UnregisteredError, messaging.SenderIdMismatchError)
            )
        ]
        if dead:
            with pool.connection() as c:
                c.execute(
                    "delete from push_tokens where token = any(%s)", (dead,)
                )
        print(
            f"push sent: {resp.success_count} ok, "
            f"{resp.failure_count} failed, {len(dead)} removed"
        )
    except Exception as e:
        print("push error:", e)


def fire_alert(alerts: list):
    r, level, why = alerts[0]
    bits = []
    if r.co_ppm is not None:
        bits.append(f"{r.co_ppm:.0f} ppm CO")
    if r.temp_c is not None:
        bits.append(f"{r.temp_c:.1f} C")
    if r.pm25 is not None:
        bits.append(f"PM2.5 {r.pm25:.0f}")
    detail = ", ".join(bits) if bits else "dangerous readings"
    send_push(
        LEVEL_NAMES[level],
        f"Device {r.device_id}: {detail}. Check the dashboard now."
    )


def store(c, r: Reading, alerts: Optional[list] = None) -> bool:
    ts = r.ts or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)

    received_at = datetime.now(timezone.utc)

    # Temperature rate of rise (degrees C/minute).
    rate = None
    if r.temp_c is not None:
        p = c.execute(
            """select temp_c, ts from readings
               where device_id=%s and temp_c is not null
                 and ts <= %s and ts >= %s
               order by ts desc limit 1""",
            (
                r.device_id,
                ts - timedelta(seconds=30),
                ts - timedelta(minutes=5),
            ),
        ).fetchone()
        if p:
            minutes = (ts - p["ts"]).total_seconds() / 60
            if minutes > 0:
                rate = (r.temp_c - p["temp_c"]) / minutes

    level, why = classify(r.temp_c, rate, r.co_ppm, r.pm25, r.pm10)
    status = 2 if level >= 2 else level

    extra = dict(r.model_extra or {})
    extra["pi_status"] = r.status
    if rate is not None:
        extra["temp_rate_c_min"] = round(rate, 2)

    prev = c.execute(
        "select last_level from devices where device_id=%s",
        (r.device_id,),
    ).fetchone()
    prev_level = (prev["last_level"] or 0) if prev else 0

    row = c.execute(
        """insert into readings
           (device_id,gateway_id,ts,seq,rssi,snr,co_ppm,temp_c,pm25,pm10,
            status,raw_b64,pm1,pm4,extra,level)
           values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           on conflict (device_id,ts,seq) do nothing returning id""",
        (
            r.device_id, r.gateway_id, ts, r.seq, r.rssi, r.snr,
            r.co_ppm, r.temp_c, r.pm25, r.pm10, status, r.raw_b64,
            r.pm1, r.pm4, Jsonb(extra), level,
        ),
    ).fetchone()

    newest = c.execute(
        "select max(ts) as newest_ts from readings where device_id=%s",
        (r.device_id,),
    ).fetchone()
    is_latest_measurement = (
        newest["newest_ts"] is None or ts >= newest["newest_ts"]
    )

    c.execute(
        """insert into devices
           (device_id,last_seen,last_status,last_level)
           values (%s,%s,%s,%s)
           on conflict (device_id) do update set
             last_status = case when %s then excluded.last_status
                                else devices.last_status end,
             last_level = case when %s then excluded.last_level
                               else devices.last_level end,
             last_seen = greatest(devices.last_seen, excluded.last_seen)""",
        (
            r.device_id, received_at, status, level,
            is_latest_measurement, is_latest_measurement,
        ),
    )

    # Clear the live camera alarm when any one warning condition clears.
    latest_values = c.execute(
        """select temp_c, co_ppm, pm25, pm10
           from readings where device_id=%s
           order by ts desc, id desc limit 1""",
        (r.device_id,),
    ).fetchone()

    current_warning_event = bool(
        latest_values and all_warning_thresholds_met(
            latest_values["temp_c"],
            latest_values["co_ppm"],
            latest_values["pm25"],
            latest_values["pm10"],
        )
    )

    if not current_warning_event:
        c.execute(
            """update camera_snapshots
               set alarm=false
               where id=(
                   select id from camera_snapshots
                   where device_id=%s
                   order by captured_at desc, id desc limit 1
               ) and alarm=true""",
            (r.device_id,),
        )

    # Push sensor-level fire alerts only on a fresh upward level transition.
    if (
        alerts is not None
        and row is not None
        and level >= 2
        and level > prev_level
        and datetime.now(timezone.utc) - ts < ALERT_MAX_AGE
    ):
        alerts.append((r, level, why))

    return row is not None


@app.get("/")
def root():
    return {"service": "FIRESENSE API", "docs": "/docs"}


@app.get("/health")
def health():
    return {"ok": True, "push": FCM_READY}


# ---------- from Raspberry Pi ----------
@app.post("/api/v1/readings", status_code=201)
def add_reading(
    r: Reading,
    bg: BackgroundTasks,
    x_api_key: Optional[str] = Header(None),
):
    check(x_api_key)
    alerts: list = []
    try:
        with pool.connection() as c:
            stored = store(c, r, alerts)
    except Exception as e:
        print("store failed:", repr(e), r.model_dump(exclude={"raw_b64"}))
        raise
    return {"stored": stored}


@app.post("/api/v1/readings/batch", status_code=201)
def add_batch(
    rs: List[Reading],
    bg: BackgroundTasks,
    x_api_key: Optional[str] = Header(None),
):
    check(x_api_key)
    alerts: list = []
    stored = failed = 0
    with pool.connection() as c:
        for r in rs:
            try:
                with c.transaction():
                    stored += store(c, r, alerts)
            except Exception as e:
                failed += 1
                print("store failed:", repr(e), r.model_dump(exclude={"raw_b64"}))
    if rs and failed == len(rs):
        raise HTTPException(500, "all readings failed, see server log")
    return {"received": len(rs), "stored": stored, "failed": failed}


@app.post("/api/v1/gateway/heartbeat")
def heartbeat(h: Heartbeat, x_api_key: Optional[str] = Header(None)):
    check(x_api_key)
    with pool.connection() as c:
        c.execute(
            """insert into gateways (gateway_id,last_seen)
               values (%s, now())
               on conflict (gateway_id) do update set last_seen=now()""",
            (h.gateway_id,),
        )
    return {"ok": True}


# ---------- central decision configuration ----------
@app.get("/api/v1/config")
def logic_config():
    return public_logic_config()


@app.get("/api/v1/devices/{device_id}/decision")
def device_decision(device_id: str):
    with pool.connection() as c:
        row = c.execute(
            """select d.last_seen, d.last_level,
                      r.co_ppm, r.temp_c, r.pm25, r.pm10, r.pm1, r.pm4
               from devices d
               left join lateral (
                   select co_ppm, temp_c, pm25, pm10, pm1, pm4
                   from readings where device_id=d.device_id
                   order by ts desc, id desc limit 1
               ) r on true
               where d.device_id=%s""",
            (device_id,),
        ).fetchone()

    if not row:
        raise HTTPException(404, "device has no readings yet")

    online = bool(
        row["last_seen"]
        and row["last_seen"] >
            datetime.now(timezone.utc) - timedelta(seconds=ONLINE_SECONDS)
    )
    level = int(row["last_level"] or 0) if online else 0

    checks = camera_warning_checks(
        row["temp_c"], row["co_ppm"], row["pm25"], row["pm10"]
    )
    camera_trigger = bool(online and all(checks.values()))

    return {
        "device_id": device_id,
        "online": online,
        "level": level,
        "level_name": LEVEL_NAMES[level],
        "camera_trigger": camera_trigger,
        "camera_trigger_mode": CAMERA_TRIGGER_MODE,
        "camera_capture_interval_seconds": CAMERA_CAPTURE_INTERVAL_SECONDS,
        "camera_trigger_checks": checks,
        "camera_trigger_level": CAMERA_TRIGGER_LEVEL,
        "logic_version": LOGIC_VERSION,
        "readings": {
            "co_ppm": float(row["co_ppm"]) if row["co_ppm"] is not None else None,
            "temp_c": float(row["temp_c"]) if row["temp_c"] is not None else None,
            "pm25": float(row["pm25"]) if row["pm25"] is not None else None,
            "pm10": float(row["pm10"]) if row["pm10"] is not None else None,
            "pm1": float(row["pm1"]) if row["pm1"] is not None else None,
            "pm4": float(row["pm4"]) if row["pm4"] is not None else None,
            "ir": None,
        },
        "thresholds": TH,
    }


# ---------- phone notifications ----------
@app.post("/api/v1/push/register")
def push_register(t: PushToken):
    with pool.connection() as c:
        n = c.execute(
            "select count(*) as n from push_tokens"
        ).fetchone()["n"]
        if n >= MAX_TOKENS:
            raise HTTPException(429, "too many registered phones")
        c.execute(
            "insert into push_tokens (token) values (%s) on conflict do nothing",
            (t.token,),
        )
    return {"ok": True}


@app.post("/api/v1/push/test")
def push_test(
    bg: BackgroundTasks,
    x_api_key: Optional[str] = Header(None),
):
    check(x_api_key)
    bg.add_task(
        send_push,
        "FireSense test",
        "If you can read this, notifications work.",
    )
    return {"queued": True, "push_ready": FCM_READY}


# ---------- admin ----------
@app.post("/api/v1/admin/login")
def admin_login(body: Login):
    if not ADMIN_PASSWORD:
        raise HTTPException(503, "admin login is not configured")
    if not hmac.compare_digest(
        body.password.encode(), ADMIN_PASSWORD.encode()
    ):
        time.sleep(1)
        raise HTTPException(401, "wrong password")
    return {"token": make_token(), "expires_hours": ADMIN_TOKEN_HOURS}


@app.get(
    "/api/v1/admin/overview",
    dependencies=[Depends(require_admin)],
)
def admin_overview():
    with pool.connection() as c:
        readings = c.execute(
            "select count(*) as n, max(ts) as last from readings"
        ).fetchone()
        phones = c.execute(
            "select count(*) as n from push_tokens"
        ).fetchone()["n"]
        devs = c.execute(
            "select device_id, last_seen, last_status, last_level "
            "from devices order by 1"
        ).fetchall()
        gws = c.execute(
            "select gateway_id, last_seen from gateways order by 1"
        ).fetchall()

    return {
        "readings": readings["n"],
        "last_reading": readings["last"],
        "phones_registered": phones,
        "devices": devs,
        "gateways": gws,
        "thresholds": TH,
        "levels": LEVEL_NAMES,
        "push_ready": FCM_READY,
    }


@app.post(
    "/api/v1/admin/push-test",
    dependencies=[Depends(require_admin)],
)
def admin_push_test(bg: BackgroundTasks):
    bg.add_task(
        send_push,
        "FireSense test",
        "Admin test notification.",
    )
    return {"queued": True, "push_ready": FCM_READY}


@app.delete(
    "/api/v1/admin/device/{device_id}",
    dependencies=[Depends(require_admin)],
)
def admin_delete_device(device_id: str):
    with pool.connection() as c:
        n = c.execute(
            "delete from readings where device_id=%s",
            (device_id,),
        ).rowcount
        c.execute(
            "delete from devices where device_id=%s",
            (device_id,),
        )
    return {"deleted_readings": n}


DEVICE_NAMES = {"node-01": "Node 1"}


@app.get("/api/v1/status")
def live_status():
    with pool.connection() as c:
        devs = c.execute(
            """select d.device_id, d.last_level, d.last_seen,
                      (d.last_seen > now() - make_interval(secs => %s)) as online,
                      r.co_ppm, r.temp_c, r.pm25, r.pm10, r.pm1, r.pm4
               from devices d
               left join lateral (
                   select co_ppm, temp_c, pm25, pm10, pm1, pm4
                   from readings
                   where device_id=d.device_id
                   order by ts desc, id desc limit 1
               ) r on true
               order by d.device_id""",
            (ONLINE_SECONDS,),
        ).fetchall()

        gw = c.execute(
            """select coalesce(
                   bool_or(last_seen > now() - make_interval(secs => %s)),
                   false
               ) as online from gateways""",
            (ONLINE_SECONDS,),
        ).fetchone()

        tot = c.execute(
            "select count(*) as n from readings"
        ).fetchone()
        last = c.execute(
            "select ts, rssi from readings order by ts desc limit 1"
        ).fetchone()

    f = lambda v: float(v) if v is not None else 0.0
    out = []

    for d in devs:
        pm25_raw = d["pm25"]
        pm10_raw = d["pm10"]
        pm25, pm10 = f(pm25_raw), f(pm10_raw)
        online = bool(d["online"])
        level = int(d["last_level"] or 0) if online else 0

        checks = camera_warning_checks(
            d["temp_c"], d["co_ppm"], pm25_raw, pm10_raw
        )
        camera_trigger = bool(online and all(checks.values()))

        out.append({
            "id": d["device_id"],
            "name": DEVICE_NAMES.get(d["device_id"], d["device_id"]),
            "online": online,
            "level": level,
            "level_name": LEVEL_NAMES[level],
            "camera_trigger": camera_trigger,
            "camera_trigger_mode": CAMERA_TRIGGER_MODE,
            "camera_capture_interval_seconds": CAMERA_CAPTURE_INTERVAL_SECONDS,
            "camera_trigger_checks": checks,
            "co": f(d["co_ppm"]),
            "temp": f(d["temp_c"]),
            "pm25": pm25,
            "pm10": pm10,
            "pm1": f(d["pm1"]),
            "pm4": f(d["pm4"]),
            "ir": None,
            "smoke": (
                pm25 >= TH["pm25_fire"]
                or pm10 >= TH["pm10_fire"]
            ),
        })

    return {
        "logic_version": LOGIC_VERSION,
        "thresholds": TH,
        "levels": LEVEL_NAMES,
        "camera_trigger_mode": CAMERA_TRIGGER_MODE,
        "camera_capture_interval_seconds": CAMERA_CAPTURE_INTERVAL_SECONDS,
        "camera_trigger_condition": (
            f"TEMP >= {TH['temp_warn']} C AND CO >= {TH['co_warn']} ppm "
            f"AND PM2.5 >= {TH['pm25_warn']} ug/m3 "
            f"AND PM10 >= {TH['pm10_warn']} ug/m3; "
            "all four must be present and true"
        ),
        "gateway": {"online": bool(gw["online"])},
        "packets": {
            "total": tot["n"],
            "last_ts": (
                last["ts"] if last
                else datetime.now(timezone.utc)
            ).isoformat(),
            "rssi": (
                round(last["rssi"])
                if last and last["rssi"] is not None else 0
            ),
        },
        "devices": out,
    }


# ---------- public read-only endpoints ----------
@app.get("/api/v1/devices")
def devices():
    q = (
        "select {k}, last_seen, "
        "(last_seen > now() - make_interval(secs => %s)) as online "
        "from {t} order by 1"
    )
    with pool.connection() as c:
        d = c.execute(
            q.format(k="device_id, last_status", t="devices"),
            (ONLINE_SECONDS,),
        ).fetchall()
        g = c.execute(
            q.format(k="gateway_id", t="gateways"),
            (ONLINE_SECONDS,),
        ).fetchall()
    return {"gateways": g, "devices": d}


@app.get("/api/v1/readings/latest")
def latest(device_id: str):
    with pool.connection() as c:
        row = c.execute(
            "select * from readings where device_id=%s "
            "order by ts desc limit 1",
            (device_id,),
        ).fetchone()

    if not row:
        raise HTTPException(404, "no readings yet")

    row["level_name"] = (
        LEVEL_NAMES[row["level"]]
        if row.get("level") is not None else None
    )
    return row


RANGES = {
    "1h": (timedelta(hours=1), "10 seconds"),
    "24h": (timedelta(hours=24), "1 minute"),
    "7d": (timedelta(days=7), "10 minutes"),
}


@app.get("/api/v1/readings")
def history(
    device_id: str,
    range: str = Query("1h", pattern="^(1h|24h|7d)$"),
):
    span, step = RANGES[range]
    with pool.connection() as c:
        rows = c.execute(
            """select date_bin(
                       %s::interval, ts, timestamptz '2000-01-01'
                   ) as ts,
                      avg(co_ppm) as co_ppm,
                      avg(temp_c) as temp_c,
                      avg(pm25) as pm25,
                      avg(pm10) as pm10,
                      avg(pm1) as pm1,
                      avg(pm4) as pm4,
                      max(status) as status
               from readings
               where device_id=%s and ts >= %s
               group by 1 order by 1""",
            (
                step,
                device_id,
                datetime.now(timezone.utc) - span,
            ),
        ).fetchall()
    return rows


@app.get("/api/v1/stats")
def stats():
    with pool.connection() as c:
        return c.execute(
            "select count(*) as total_packets, "
            "max(ts) as last_packet_at from readings"
        ).fetchone()


@app.get("/api/v1/readings/export.csv")
def export_csv(
    device_id: str,
    hours: int = Query(168, ge=1, le=720),
):
    cols = [
        "ts", "device_id", "gateway_id", "seq", "rssi", "snr",
        "co_ppm", "temp_c", "pm1", "pm25", "pm4", "pm10", "status",
    ]
    with pool.connection() as c:
        rows = c.execute(
            f"select {','.join(cols)} from readings "
            "where device_id=%s and ts >= %s order by ts",
            (
                device_id,
                datetime.now(timezone.utc) - timedelta(hours=hours),
            ),
        ).fetchall()

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for r in rows:
        w.writerow([r[k] for k in cols])

    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=readings.csv"
        },
    )


# ---------- camera AI uploads ----------
CAMERA_API_KEY = os.environ.get("CAMERA_API_KEY", "")
CAMERA_MAX_IMAGE_BYTES = 2 * 1024 * 1024
CAMERA_KEEP_PER_DEVICE = 500


def check_camera_key(key: Optional[str]):
    if not CAMERA_API_KEY:
        raise HTTPException(503, "camera API is not configured")
    if not key or not hmac.compare_digest(key, CAMERA_API_KEY):
        raise HTTPException(401, "bad camera api key")


@app.post("/api/v1/camera/snapshots", status_code=201)
async def add_camera_snapshot(
    request: Request,
    bg: BackgroundTasks,
    device_id: str = Query(..., min_length=1, max_length=100),
    prediction: str = Query(..., min_length=1, max_length=40),
    confidence: float = Query(..., ge=0, le=100),
    fire_probability: float = Query(..., ge=0, le=100),
    alarm: bool = Query(False),
    timestamp: Optional[datetime] = Query(None),
    x_camera_key: Optional[str] = Header(None, alias="X-Camera-Key"),
):
    check_camera_key(x_camera_key)

    normalized_prediction = prediction.strip().upper()
    ai_fire = normalized_prediction == "FIRE"

    content_type = request.headers.get(
        "content-type", "image/jpeg"
    ).split(";")[0].strip().lower()

    if content_type not in ("image/jpeg", "image/jpg", "image/png"):
        raise HTTPException(
            415, "only JPEG or PNG camera images are accepted"
        )

    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(400, "empty image")
    if len(image_bytes) > CAMERA_MAX_IMAGE_BYTES:
        raise HTTPException(413, "image is larger than 2 MB")

    captured_at = timestamp or datetime.now(timezone.utc)
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=timezone.utc)
    captured_at = captured_at.astimezone(timezone.utc)

    # Re-check the all-four-warning condition before storing an alarm.
    with pool.connection() as c:
        active_device = c.execute(
            """select d.last_seen, r.temp_c, r.co_ppm, r.pm25, r.pm10
               from devices d
               left join lateral (
                   select temp_c, co_ppm, pm25, pm10
                   from readings
                   where device_id=d.device_id
                   order by ts desc, id desc limit 1
               ) r on true
               where d.device_id=%s""",
            (device_id,),
        ).fetchone()

        sensor_condition_active = False
        if active_device:
            device_online = bool(
                active_device["last_seen"]
                and active_device["last_seen"] >
                    datetime.now(timezone.utc)
                    - timedelta(seconds=ONLINE_SECONDS)
            )
            sensor_condition_active = bool(
                device_online and all_warning_thresholds_met(
                    active_device["temp_c"],
                    active_device["co_ppm"],
                    active_device["pm25"],
                    active_device["pm10"],
                )
            )

        effective_alarm = bool(
            ai_fire and sensor_condition_active
        )

        previous = c.execute(
            """select alarm from camera_snapshots
               where device_id=%s
               order by captured_at desc, id desc limit 1""",
            (device_id,),
        ).fetchone()
        previous_alarm = bool(previous["alarm"]) if previous else False

        row = c.execute(
            """insert into camera_snapshots
               (device_id, captured_at, prediction, confidence,
                fire_probability, alarm, content_type, image_bytes)
               values (%s,%s,%s,%s,%s,%s,%s,%s)
               returning id, device_id, captured_at, prediction,
                         confidence, fire_probability, alarm""",
            (
                device_id, captured_at, normalized_prediction,
                confidence, fire_probability, effective_alarm,
                content_type, image_bytes,
            ),
        ).fetchone()

        c.execute(
            """delete from camera_snapshots
               where device_id=%s
                 and id not in (
                     select id from camera_snapshots
                     where device_id=%s
                     order by captured_at desc, id desc
                     limit %s
                 )""",
            (device_id, device_id, CAMERA_KEEP_PER_DEVICE),
        )

    # Push only on an effective OFF -> ON transition.
    if effective_alarm and not previous_alarm:
        bg.add_task(
            send_push,
            "FIRESENSE FIRE CONFIRMED",
            f"Camera AI confirmed FIRE for {device_id} "
            f"({confidence:.1f}% confidence). "
            "Check the FIRESENSE app now.",
        )

    return {
        "stored": True,
        "id": row["id"],
        "device_id": row["device_id"],
        "timestamp": row["captured_at"].isoformat(),
        "prediction": row["prediction"],
        "confidence": float(row["confidence"]),
        "fire_probability": float(row["fire_probability"]),
        "alarm": bool(row["alarm"]),
        "sensor_condition_active": sensor_condition_active,
        "image_url": f"/api/v1/camera/image/{row['id']}",
    }


@app.get("/api/v1/camera/snapshots")
def get_camera_snapshots(
    request: Request,
    limit: int = Query(24, ge=1, le=100),
):
    with pool.connection() as c:
        rows = c.execute(
            """select id, device_id, captured_at, prediction,
                      confidence, fire_probability, alarm
               from camera_snapshots
               order by captured_at desc, id desc
               limit %s""",
            (limit,),
        ).fetchall()

    items = []
    for row in rows:
        image_url = (
            f"{str(request.base_url).rstrip('/')}"
            f"/api/v1/camera/image/{row['id']}"
        )
        ts = row["captured_at"].isoformat()
        items.append({
            "id": row["id"],
            "device_id": row["device_id"],
            "ts": ts,
            "timestamp": ts,
            "prediction": row["prediction"],
            "confidence": float(row["confidence"]),
            "fire_probability": float(row["fire_probability"]),
            "alarm": bool(row["alarm"]),
            "url": image_url,
            "image_url": image_url,
        })

    return {"items": items, "count": len(items)}


@app.get("/api/v1/camera/image/{snapshot_id}")
def get_camera_image(snapshot_id: int):
    with pool.connection() as c:
        row = c.execute(
            "select content_type, image_bytes "
            "from camera_snapshots where id=%s",
            (snapshot_id,),
        ).fetchone()

    if not row:
        raise HTTPException(404, "camera image not found")

    return Response(
        content=bytes(row["image_bytes"]),
        media_type=row["content_type"],
        headers={"Cache-Control": "no-store"},
    )
