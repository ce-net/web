#!/usr/bin/env python3
# ce-cast relay agent — the OPTIONAL headless-encoder side of the studio.
#
# DEFAULT PATH (encoder = "this-device"): the browser composites locally and WHIP-publishes one
# clean `program` stream; MediaMTX runOnReady -> fanout.sh copies it to the platforms (-c:v copy,
# no re-decode). In that mode THIS agent stays IDLE — it touches no ffmpeg and cannot corrupt or
# double-publish. That is the robust path and the default.
#
# HEADLESS PATH (encoder = this relay node id, or the literal "relay"): the agent composites the
# published cam+screen feeds itself. Compositing requires DECODING the feeds, which on a 2-vCPU box
# is the source of the historical corrupt-macroblock output — so this path is opt-in, defaults to
# 720p, and is really meant for a GPU/NVENC encoder node (where "encoder" is that node's id). Until
# the ce-adapter mesh-tunnel feed lands it still pulls the feeds over local RTSP.
#
# The scene graph is read from the CE MESH (not an HTTP /db poll): the agent subscribes to the
# cast app's scene room on its LOCAL node and applies the latest published scene. Safe by default:
# if no scene has arrived, the agent idles (it never composites off a stale value).
#
# Zero-cut: a decoupled UDP sender holds the platform connections; the agent ADOPTS already-running
# processes on its own restart (pid+sig files), so redeploying this agent is invisible to a stream.

import json, os, time, subprocess, urllib.request, urllib.error, hashlib, signal, threading

import zmq

PREFIX = os.environ.get("CAST_PREFIX", "c0be11e0ce")
APP_ID = os.environ.get("CAST_APP_ID", f"cast-{PREFIX}")
SCENE_TOPIC = f"ce-app/{APP_ID}/room/scene"
NODE_URL = os.environ.get("CE_NODE_URL", "http://127.0.0.1:8844").rstrip("/")
RELAY_DIR = os.environ.get("RELAY_DIR", "/opt/ce-cast/relay")
HLS_DIR = os.environ.get("HLS_DIR", f"{RELAY_DIR}/hls")
RUN_DIR = os.environ.get("RUN_DIR", f"{RELAY_DIR}/run")
MTX_API = "http://127.0.0.1:9997/v3/paths/list"
ZMQ_ADDR = "tcp://127.0.0.1:5555"
UDP = "udp://127.0.0.1:10000"

# This node's id — the headless path runs only when scene.encoder names THIS node (or "relay").
def read_node_id():
    try:
        with urllib.request.urlopen(f"{NODE_URL}/status", timeout=5) as r:
            return json.load(r).get("node_id", "")
    except Exception:
        return ""

def read_token():
    t = os.environ.get("CE_API_TOKEN")
    if t:
        return t.strip()
    for p in (os.environ.get("CE_API_TOKEN_FILE"),
              f"{os.path.expanduser('~')}/.local/share/ce/api.token",
              "/root/.local/share/ce/api.token"):
        if p and os.path.exists(p):
            try:
                return open(p).read().strip()
            except Exception:
                pass
    return None

NODE_ID = read_node_id()
TOKEN = read_token()

# 720p default — the headless composite path is CPU-bound on the 2-vCPU relay. 1080p is for a
# GPU/NVENC encoder node (selected by naming that node as scene.encoder).
DEFAULT_SCENE = {
    "rev": 0, "encoder": "this-device",
    "output": {"w": 1280, "h": 720, "fps": 30, "vBitrateK": 3500},
    "platforms": {"youtube": False, "kick": False, "x": False, "twitch": False},
    "screen": {"on": True, "source": "screen"},
    "camera": {"on": True, "source": "cam", "mirror": False},
    "layout": "pip", "pip": {"corner": "bottomRight", "sizePct": 28},
}

# ---- mesh scene subscriber (replaces the hub /db poll) ----------------------
_scene_lock = threading.Lock()
_latest_scene = None  # None until the first scene arrives -> agent idles (safe default)

def _auth_req(url, data=None, method=None):
    req = urllib.request.Request(url, data=data, method=method)
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    return req

def _subscribe(topic):
    try:
        body = json.dumps({"topic": topic}).encode()
        urllib.request.urlopen(_auth_req(f"{NODE_URL}/mesh/subscribe", body, "POST"), timeout=8).read()
        return True
    except Exception as e:
        print(f"scene subscribe failed: {e}", flush=True)
        return False

def _scene_stream_loop():
    """Subscribe to the scene topic and apply the newest published scene from the node's SSE stream.
    Reconnects with backoff. Each frame is {from, topic, payload_hex}; payload_hex is JSON scene."""
    global _latest_scene
    backoff = 1.0
    while True:
        _subscribe(SCENE_TOPIC)
        try:
            with urllib.request.urlopen(_auth_req(f"{NODE_URL}/mesh/messages/stream"), timeout=600) as r:
                backoff = 1.0
                for raw in r:
                    line = raw.decode("utf-8", "ignore").strip()
                    if not line.startswith("data:"):
                        continue
                    try:
                        msg = json.loads(line[5:].strip())
                    except Exception:
                        continue
                    if msg.get("topic") != SCENE_TOPIC:
                        continue
                    try:
                        scene = json.loads(bytes.fromhex(msg.get("payload_hex", "")).decode("utf-8"))
                    except Exception:
                        continue
                    if not isinstance(scene, dict):
                        continue
                    with _scene_lock:
                        cur = _latest_scene
                        if cur is None or scene.get("rev", 0) >= cur.get("rev", 0):
                            _latest_scene = scene
        except Exception as e:
            print(f"scene stream error: {e}; retrying in {backoff:.0f}s", flush=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)

def current_scene():
    with _scene_lock:
        s = None if _latest_scene is None else dict(_latest_scene)
    if s is None:
        return None  # no scene yet -> idle
    for k, v in DEFAULT_SCENE.items():
        s.setdefault(k, v)
    return s

def encoder_is_self(scene):
    enc = str(scene.get("encoder", "this-device"))
    return enc == "relay" or (NODE_ID and enc == NODE_ID)

def mtx_ready():
    try:
        with urllib.request.urlopen(MTX_API, timeout=5) as r:
            d = json.load(r)
        return {p["name"] for p in d.get("items", []) if p.get("ready")}
    except Exception:
        return set()

def load_keys():
    env = {}
    try:
        for line in open(f"{RELAY_DIR}/keys.env"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1); env[k] = v
    except Exception:
        pass
    return env

# ---- pid/sig process manager (enables ADOPT across agent restarts) ----------
def _pidf(n): return f"{RUN_DIR}/{n}.pid"
def _sigf(n): return f"{RUN_DIR}/{n}.sig"
def _alive(pid):
    try: os.kill(pid, 0); return True
    except Exception: return False
def running(n):
    try:
        pid = int(open(_pidf(n)).read().strip())
        return pid if _alive(pid) else None
    except Exception:
        return None
def saved_sig(n):
    try: return open(_sigf(n)).read().strip()
    except Exception: return None
def stop(n):
    pid = running(n)
    if pid:
        try: os.kill(pid, signal.SIGTERM)
        except Exception: pass
        for _ in range(30):
            if not _alive(pid): break
            time.sleep(0.1)
        if _alive(pid):
            try: os.kill(pid, signal.SIGKILL)
            except Exception: pass
    for f in (_pidf(n), _sigf(n)):
        try: os.remove(f)
        except Exception: pass
def start(n, cmd, sig):
    os.makedirs(RUN_DIR, exist_ok=True)
    stop(n)
    p = subprocess.Popen(cmd)
    open(_pidf(n), "w").write(str(p.pid)); open(_sigf(n), "w").write(sig)
    return p.pid
def ensure(n, cmd_fn, sig):
    if running(n) and saved_sig(n) == sig:
        return False
    start(n, cmd_fn(), sig)
    return True

# ---- layout math -----------------------------------------------------------
def layout_values(scene):
    W, H = scene["output"]["w"], scene["output"]["h"]
    OFF = W + 2000
    lay = scene.get("layout", "pip")
    cam_on = scene["camera"]["on"]; scr_on = scene["screen"]["on"]
    sScr, oScr = (W, H), (0, 0)
    sCam, oCam = (int(W * 0.28), int(W * 0.28 * 9 / 16)), (OFF, OFF)
    if lay == "screen" or (scr_on and not cam_on):
        sScr, oScr, oCam = (W, H), (0, 0), (OFF, OFF)
    elif lay in ("fullface", "camonly") or (cam_on and not scr_on):
        sScr, oScr = (W, H), (0, 0); sCam, oCam = (W, H), (0, 0)
    elif lay == "side":
        hw = W // 2; hh = int(hw * 9 / 16)
        sScr, oScr = (hw, hh), (0, (H - hh) // 2)
        sCam, oCam = (hw, hh), (hw, (H - hh) // 2)
    else:
        sScr, oScr = (W, H), (0, 0)
        pct = max(8, min(100, scene.get("pip", {}).get("sizePct", 28)))
        cw = int(W * pct / 100); ch = int(cw * 9 / 16); sCam = (cw, ch)
        m = int(W * 0.025); corner = scene.get("pip", {}).get("corner", "bottomRight")
        x = m if "Left" in corner else W - cw - m
        y = m if corner.startswith("top") else H - ch - m
        oCam = (x, y)
    if not cam_on: oCam = (OFF, OFF)
    if not scr_on and lay == "pip": oScr = (OFF, OFF)
    return sScr, oScr, sCam, oCam

def zmq_cmds(scene):
    sScr, oScr, sCam, oCam = layout_values(scene)
    return [f"scale@sScr w {sScr[0]}", f"scale@sScr h {sScr[1]}",
            f"scale@sCam w {sCam[0]}", f"scale@sCam h {sCam[1]}",
            f"overlay@oScr x {oScr[0]}", f"overlay@oScr y {oScr[1]}",
            f"overlay@oCam x {oCam[0]}", f"overlay@oCam y {oCam[1]}"]

def send_zmq(cmds):
    ctx = zmq.Context.instance()
    s = ctx.socket(zmq.REQ); s.setsockopt(zmq.RCVTIMEO, 800); s.setsockopt(zmq.SNDTIMEO, 800); s.setsockopt(zmq.LINGER, 0)
    s.connect(ZMQ_ADDR)
    try:
        for c in cmds:
            try: s.send_string(c); s.recv_string()
            except zmq.ZMQError: break
    finally:
        s.close()

# ---- structural signatures (what forces each process to restart) -----------
def comp_sig(scene, ready):
    o = scene["output"]
    return hashlib.sha1(json.dumps([o["w"], o["h"], o["fps"], o["vBitrateK"],
                                    "cam" in ready, "screen" in ready, scene["camera"]["mirror"]],
                                   sort_keys=True).encode()).hexdigest()[:16]
def enabled_platforms(scene, keys):
    out = []
    for p, (uk, kk) in {"youtube": ("YT_URL", "YT_KEY"), "kick": ("KICK_URL", "KICK_KEY"),
                        "x": ("X_URL", "X_KEY"), "twitch": ("TWITCH_URL", "TWITCH_KEY")}.items():
        if not scene["platforms"].get(p):
            continue
        url, key = keys.get(uk, ""), keys.get(kk, "")
        if url.startswith("srt://"):
            out.append((p, url, None))
        elif url and key:
            out.append((p, url.rstrip("/"), key))
    return out
def sender_sig(plats):
    return hashlib.sha1(json.dumps(sorted(p[0] for p in plats)).encode()).hexdigest()[:16]

# ---- compositor: cam+screen -> composite -> UDP (+ HLS preview) -------------
# NOTE: 720p veryfast by default; this DECODES the published feeds to composite them and is CPU-bound
# on the relay. Use a GPU/NVENC encoder node (named as scene.encoder) for 1080p / clean headroom.
def build_compositor(scene, ready):
    W, H, fps = scene["output"]["w"], scene["output"]["h"], scene["output"]["fps"]
    bv = scene["output"]["vBitrateK"]
    cam_ready = "cam" in ready; scr_ready = "screen" in ready
    a = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin", "-y"]
    if cam_ready: a += ["-rtsp_transport", "tcp", "-i", "rtsp://127.0.0.1:8554/cam"]
    else:         a += ["-f", "lavfi", "-i", f"color=c=0x222222:s=640x360:r={fps}"]
    a += ["-f", "lavfi", "-i", f"color=black:s={W}x{H}:r={fps}"]
    if scr_ready: a += ["-rtsp_transport", "tcp", "-i", "rtsp://127.0.0.1:8554/screen"]
    else:         a += ["-f", "lavfi", "-i", f"color=black:s={W}x{H}:r={fps}"]
    if not cam_ready: a += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]
    sScr, oScr, sCam, oCam = layout_values(scene)
    cam_pre = "hflip," if scene["camera"]["mirror"] else ""
    fg = (f"[1:v]null[base];[2:v]scale@sScr={sScr[0]}:{sScr[1]}[scr];"
          f"[0:v]{cam_pre}scale@sCam={sCam[0]}:{sCam[1]}[cam];"
          f"[base][scr]overlay@oScr=x={oScr[0]}:y={oScr[1]}:eval=frame[t];"
          f"[t][cam]overlay@oCam=x={oCam[0]}:y={oCam[1]}:eval=frame,zmq[v]")
    a += ["-filter_complex", fg, "-map", "[v]", "-map", ("0:a?" if cam_ready else "3:a")]
    a += ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
          "-b:v", f"{bv}k", "-maxrate", f"{bv}k", "-bufsize", f"{bv*2}k",
          "-g", str(fps * 2), "-pix_fmt", "yuv420p", "-r", str(fps),
          "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2"]
    os.makedirs(HLS_DIR, exist_ok=True)
    tee = (f"[f=mpegts]{UDP}?pkt_size=1316"
           f"|[f=hls:hls_time=1:hls_list_size=4:hls_flags=delete_segments+independent_segments:"
           f"hls_segment_filename={HLS_DIR}/seg_%05d.ts]{HLS_DIR}/program.m3u8")
    a += ["-f", "tee", tee]
    return a

def build_sender(plats):
    legs = []
    for _, url, key in plats:
        if url.startswith("srt://"): legs.append(f"[f=mpegts]{url}")
        else: legs.append(f"[f=flv:onfail=ignore]{url}/{key}")
    return ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin",
            "-fflags", "+genpts", "-i", f"{UDP}?fifo_size=1000000&overrun_nonfatal=1",
            "-c", "copy", "-f", "tee", "|".join(legs)]

# ---- main loop -------------------------------------------------------------
def main():
    cur_live = None
    threading.Thread(target=_scene_stream_loop, daemon=True).start()
    print(f"cast-agent up: node={NODE_ID[:12]} topic={SCENE_TOPIC} "
          f"(mesh-scene, idle-by-default, headless only when encoder names this node)", flush=True)

    prev = None; ready_committed = set()
    for _ in range(6):
        rr = mtx_ready()
        if rr == prev: ready_committed = rr; break
        prev = rr; time.sleep(0.4)
    else:
        ready_committed = prev or set()
    cand = ready_committed; stable = 2

    while True:
        scene = current_scene()
        keys = load_keys()

        # Headless compositor runs ONLY when the scene picks this node as the encoder. Otherwise the
        # browser-composite `program` path is authoritative and this agent stays idle (safe default).
        if scene is None or not encoder_is_self(scene):
            stop("compositor"); stop("sender"); cur_live = None
            time.sleep(0.6)
            continue

        r = mtx_ready()
        if r == cand: stable += 1
        else: cand = r; stable = 0
        if stable >= 2 and r != ready_committed: ready_committed = r
        ready = ready_committed

        want_comp = scene["camera"]["on"] or scene["screen"]["on"]
        if want_comp:
            csig = comp_sig(scene, ready)
            if ensure("compositor", lambda: build_compositor(scene, ready), csig):
                print(f"compositor (re)started: feeds={sorted(ready)} {scene['output']['w']}x{scene['output']['h']}@{scene['output']['fps']}", flush=True)
                cur_live = None; time.sleep(2)
        else:
            stop("compositor")

        plats = enabled_platforms(scene, keys)
        if plats:
            if ensure("sender", lambda: build_sender(plats), sender_sig(plats)):
                print(f"sender (re)started: platforms={[p[0] for p in plats]}", flush=True)
        else:
            stop("sender")

        if running("compositor"):
            live = json.dumps([scene.get("layout"), scene.get("pip"), scene["camera"]["on"], scene["screen"]["on"]], sort_keys=True)
            if live != cur_live:
                send_zmq(zmq_cmds(scene)); cur_live = live

        time.sleep(0.5)

if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: pass
