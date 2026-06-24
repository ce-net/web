"""Minimal runnable example for the `ce` Python SDK.

    python examples/quickstart.py

Talks to the live hub at https://ce-net.com. The realtime section is optional and
only runs with --room (it blocks); database always runs.
"""

import sys

import ce


def main() -> None:
    client = ce.Client(app="demo")  # base defaults to https://ce-net.com
    print("app:", client.app, "base:", client.base)

    # Database: persistent KV namespaced per app.
    client.db.set("hello", {"from": "python-sdk", "n": 1})
    print("get   ->", client.db.get("hello"))
    print("list  ->", client.db.list(prefix="hello", limit=10))
    client.db.delete("hello")
    print("after delete ->", client.db.get("hello"))

    # Task: dispatch a Python compute job to a live browser node.
    # Requires at least one browser node connected (open https://ce-net.com/node).
    try:
        res = client.run_task(
            lang="python",
            code="def task(x):\n    return sum(i * i for i in range(x))",
            input=5,
        )
        print("task  ->", res.get("value"), "ok=", res.get("ok"), "ms=", res.get("ms"))
    except ce.CeError as exc:
        print("task  -> skipped:", exc, "(status", exc.status, ")")

    # Realtime room (blocks): only with --room.
    if "--room" in sys.argv:
        with client.room("lobby") as room:
            room.on(lambda msg: print("room ->", msg))
            room.send({"text": "hello from python"})
            print("listening on room 'lobby' (ctrl-c to stop)...")
            room.run()


if __name__ == "__main__":
    main()
