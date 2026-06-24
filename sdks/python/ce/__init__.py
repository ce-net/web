"""ce -- Python client for the CE App Platform hub.

Mirrors the semantics of @ce/client (the browser JS client):

    import ce

    client = ce.Client(app="demo")            # default base https://ce-net.com
    client.db.set("greeting", {"hi": True})    # persistent KV, namespaced per app
    print(client.db.get("greeting"))
    print(client.db.list(prefix="greet"))

    result = client.run_task(lang="python", code="def task(x):\\n    return x*x", input=7)
    print(result["value"])

    with client.room("lobby") as room:         # realtime pub/sub over websocket
        room.on(lambda msg: print("got", msg))
        room.send({"text": "hello"})
        room.run()                             # block, dispatching messages

Surface parallels @ce/client: db.get/set/del/list, room(name).send/on.
Tasks map to POST /tasks; db maps to /db/<app>/<key>; realtime maps to /rt/<app>/<room>.
"""

from .client import Client, Db, Room, CeError, create_client

__all__ = ["Client", "Db", "Room", "CeError", "create_client"]
__version__ = "0.1.0"
