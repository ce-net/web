"""CE App Platform client.

The HTTP surface (hub):
  POST   /tasks                       dispatch a compute job to a live node, await the result
  GET    /db/<app>/<key>              read a stored JSON value (404 -> None)
  PUT    /db/<app>/<key>              store a JSON value
  DELETE /db/<app>/<key>             delete a key
  GET    /db/<app>?prefix=&limit=     newest-first list of {key, value}
  WS     /rt/<app>/<room>             realtime pub/sub room

Only stdlib is needed for tasks + db (urllib). Realtime uses the `websockets` library.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

DEFAULT_BASE = "https://ce-net.com"


class CeError(Exception):
    """Raised when a hub request fails."""

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


def _http_base(base: str) -> str:
    return base.rstrip("/")


def _ws_base(base: str) -> str:
    """http(s) origin -> ws(s) origin, mirroring @ce/client.wsBase."""
    base = _http_base(base)
    if base.startswith("https:"):
        return "wss:" + base[len("https:"):]
    if base.startswith("http:"):
        return "ws:" + base[len("http:"):]
    return base


def _request(method: str, url: str, body: Optional[Any] = None) -> tuple[int, bytes]:
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except urllib.error.URLError as exc:  # network-level failure
        raise CeError(f"{method} {url} failed: {exc.reason}") from exc


class Db:
    """Persistent KV namespaced per app (mirrors @ce/client `db`)."""

    def __init__(self, base: str, app: str) -> None:
        self._root = f"{_http_base(base)}/db/{urllib.parse.quote(app, safe='')}"

    def get(self, key: str) -> Optional[Any]:
        """GET /db/<app>/<key> -> stored JSON value, or None if 404."""
        status, raw = _request("GET", f"{self._root}/{urllib.parse.quote(key, safe='')}")
        if status == 404:
            return None
        if status >= 400:
            raise CeError(f"db.get({key!r}) failed: {status}", status)
        return json.loads(raw) if raw else None

    def set(self, key: str, val: Any) -> Dict[str, Any]:
        """PUT /db/<app>/<key> with a JSON value."""
        status, raw = _request(
            "PUT", f"{self._root}/{urllib.parse.quote(key, safe='')}", val
        )
        if status >= 400:
            raise CeError(f"db.set({key!r}) failed: {status}", status)
        return json.loads(raw) if raw else {"ok": True, "key": key}

    def delete(self, key: str) -> Dict[str, Any]:
        """DELETE /db/<app>/<key>."""
        status, raw = _request("DELETE", f"{self._root}/{urllib.parse.quote(key, safe='')}")
        if status >= 400:
            raise CeError(f"db.delete({key!r}) failed: {status}", status)
        return json.loads(raw) if raw else {"ok": True}

    # Alias to match @ce/client's `del` (a reserved word in Python).
    def del_(self, key: str) -> Dict[str, Any]:
        return self.delete(key)

    def list(self, prefix: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """GET /db/<app>?prefix=&limit= -> newest-first list of {key, value}."""
        params: Dict[str, str] = {}
        if prefix:
            params["prefix"] = str(prefix)
        if limit is not None:
            params["limit"] = str(limit)
        qs = ("?" + urllib.parse.urlencode(params)) if params else ""
        status, raw = _request("GET", f"{self._root}{qs}")
        if status >= 400:
            raise CeError(f"db.list failed: {status}", status)
        data = json.loads(raw) if raw else {}
        items = data.get("items")
        return items if isinstance(items, list) else []


class Room:
    """A realtime pub/sub room over websocket (mirrors @ce/client `room`).

    Use as a context manager. `send` queues until connected; `on` registers a
    handler; `run` blocks the calling thread dispatching incoming messages.
    JSON text frames are decoded; non-JSON frames are delivered as raw strings.
    """

    def __init__(self, base: str, app: str, name: str) -> None:
        self._url = (
            f"{_ws_base(base)}/rt/{urllib.parse.quote(app, safe='')}"
            f"/{urllib.parse.quote(name, safe='')}"
        )
        self._handlers: List[Callable[[Any], None]] = []
        self._open_handlers: List[Callable[[], None]] = []
        self._outbox: List[str] = []
        self._ws = None
        self._closed = False
        self._lock = threading.Lock()

    # ---- handler registration ----

    def on(self, fn: Callable[[Any], None]) -> Callable[[], None]:
        """Subscribe to messages. Returns an unsubscribe callable."""
        self._handlers.append(fn)

        def off() -> None:
            try:
                self._handlers.remove(fn)
            except ValueError:
                pass

        return off

    def on_open(self, fn: Callable[[], None]) -> Callable[[], None]:
        self._open_handlers.append(fn)

        def off() -> None:
            try:
                self._open_handlers.remove(fn)
            except ValueError:
                pass

        return off

    # ---- io ----

    def send(self, obj: Any) -> None:
        """Send a text frame. Objects are JSON-encoded; strings sent verbatim."""
        data = obj if isinstance(obj, str) else json.dumps(obj)
        with self._lock:
            ws = self._ws
        if ws is not None:
            try:
                ws.send(data)
                return
            except Exception:  # noqa: BLE001 -- fall through to buffering on any send error
                pass
        with self._lock:
            self._outbox.append(data)

    def run(self, reconnect: bool = True) -> None:
        """Connect and block, dispatching messages until close() (or the process exits).

        With reconnect=True (default) it retries with a fixed backoff, matching the
        reconnect behavior of @ce/client.
        """
        import time

        from websockets.sync.client import connect  # lazy import: tasks/db need no ws dep

        while not self._closed:
            try:
                with connect(self._url) as ws:
                    with self._lock:
                        self._ws = ws
                        pending = self._outbox
                        self._outbox = []
                    for m in pending:
                        try:
                            ws.send(m)
                        except Exception:  # noqa: BLE001
                            pass
                    for fn in list(self._open_handlers):
                        try:
                            fn()
                        except Exception:  # noqa: BLE001
                            pass
                    for raw in ws:
                        payload: Any = raw
                        if isinstance(raw, (bytes, bytearray)):
                            raw = raw.decode("utf-8", "replace")
                        try:
                            payload = json.loads(raw)
                        except (ValueError, TypeError):
                            payload = raw
                        for fn in list(self._handlers):
                            try:
                                fn(payload)
                            except Exception:  # noqa: BLE001
                                pass
            except Exception:  # noqa: BLE001 -- connection error: reconnect or bail
                if not reconnect or self._closed:
                    raise
            finally:
                with self._lock:
                    self._ws = None
            if not reconnect or self._closed:
                break
            time.sleep(1.5)

    def close(self) -> None:
        """Stop reconnecting and close the socket."""
        self._closed = True
        with self._lock:
            ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass

    def __enter__(self) -> "Room":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()


class Client:
    """CE App Platform client.

    Parameters
    ----------
    app: the app id whose namespace this client reads/writes (default "demo").
    base: the http(s) origin of the hub (default https://ce-net.com).
    """

    def __init__(self, app: str = "demo", base: str = DEFAULT_BASE) -> None:
        self.app = app
        self.base = _http_base(base)
        self.db = Db(self.base, app)

    def room(self, name: str) -> Room:
        """Open (or join) a realtime room over websocket."""
        return Room(self.base, self.app, name)

    def run_task(
        self,
        lang: str = "wasm",
        *,
        code: Optional[str] = None,
        func: Optional[str] = None,
        input: Any = None,
        module: Optional[str] = None,
        args: Optional[List[int]] = None,
        ret: Optional[str] = None,
        target: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Dispatch a compute job to a live node and await the result (POST /tasks).

        For source-code tasks (lang in {"js", "python", ...}) pass `code` and optional
        `func` (default "task") + `input`. For wasm tasks pass `module`, `func`, `args`,
        and optional `ret`. Optionally pin a `target` node id.

        Returns the hub's JSON result, e.g.
        {"node", "lang", "func", "ok", "value", "ms", "error"}.
        """
        body: Dict[str, Any] = {"lang": lang}
        if lang != "wasm":
            if code is None:
                raise CeError(f"{lang} task requires `code`")
            body["code"] = code
            body["func"] = func or "task"
            body["input"] = input
        else:
            if module is not None:
                body["module"] = module
            if func is not None:
                body["func"] = func
            body["args"] = args or []
            if ret is not None:
                body["ret"] = ret
        if target is not None:
            body["target"] = target

        status, raw = _request("POST", f"{self.base}/tasks", body)
        data = json.loads(raw) if raw else {}
        if status >= 400:
            msg = data.get("error") if isinstance(data, dict) else None
            raise CeError(msg or f"run_task failed: {status}", status)
        return data


def create_client(app: str = "demo", base: str = DEFAULT_BASE) -> Client:
    """Factory mirroring @ce/client's `createClient`."""
    return Client(app=app, base=base)
