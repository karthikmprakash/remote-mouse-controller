"""API smoke tests for /api/command (mocked pynput + subprocess)."""
import json
import re
import sys
import threading
import types
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _install_stubs():
    mouse_mod = types.ModuleType("pynput.mouse")

    class Button:
        left = 1
        right = 2

    class Controller:
        position = (0, 0)

        def move(self, *a, **k):
            pass

        def click(self, *a, **k):
            pass

        def press(self, *a, **k):
            pass

        def release(self, *a, **k):
            pass

        def scroll(self, *a, **k):
            pass

    mouse_mod.Button = Button
    mouse_mod.Controller = Controller

    kb_mod = types.ModuleType("pynput.keyboard")

    class Key:
        media_play_pause = "play"
        media_next = "next"
        media_previous = "prev"
        media_volume_mute = "mute"
        media_volume_up = "volup"
        media_volume_down = "voldown"

    class KbController:
        def press(self, *a, **k):
            pass

        def release(self, *a, **k):
            pass

    kb_mod.Key = Key
    kb_mod.Controller = KbController

    pynput = types.ModuleType("pynput")
    pynput.mouse = mouse_mod
    pynput.keyboard = kb_mod
    sys.modules["pynput"] = pynput
    sys.modules["pynput.mouse"] = mouse_mod
    sys.modules["pynput.keyboard"] = kb_mod

    ws = types.ModuleType("websockets")

    async def serve(*a, **k):
        class CM:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                pass

        return CM()

    ws.serve = serve
    sys.modules["websockets"] = ws


def main():
    _install_stubs()
    sys.path.insert(0, str(ROOT / "server"))
    import server  # noqa: E402

    def ok_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = ""
            stderr = ""

        joined = " ".join(str(c) for c in cmd)
        if "output volume" in joined:
            R.stdout = "40"
        elif "output muted" in joined:
            R.stdout = "false"
        return R()

    def fail_run(cmd, **kwargs):
        class R:
            returncode = 1
            stdout = ""
            stderr = "Unable to find application"

        return R()

    server.subprocess.run = ok_run

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.StaticHandler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def post(payload):
        conn = HTTPConnection("127.0.0.1", port, timeout=5)
        body = json.dumps(payload).encode()
        conn.request(
            "POST",
            "/api/command",
            body=body,
            headers={"Content-Type": "application/json"},
        )
        res = conn.getresponse()
        data = json.loads(res.read().decode())
        conn.close()
        return res.status, data

    failures = []

    def check(name, cond, detail=None):
        if not cond:
            failures.append((name, detail))
            print("FAIL", name, detail)
        else:
            print("PASS", name)

    st, data = post({"type": "ping"})
    check("ping", st == 200 and data.get("message") == "pong", data)

    st, data = post({"type": "launch", "app": "Safari"})
    check("launch", st == 200 and data.get("status") == "ok", data)

    st, data = post({"type": "control", "action": "play_pause"})
    check("play_pause", st == 200 and data.get("status") == "ok", data)

    st, data = post({"type": "control", "action": "spotlight"})
    check("spotlight", st == 200 and data.get("status") == "ok", data)

    st, data = post({"type": "control", "action": "nope"})
    check("unknown action", st == 400, data)

    st, data = post({"type": "open_url", "url": "javascript:alert(1)"})
    check("reject bad url", st == 500 and data.get("status") == "error", data)

    server.subprocess.run = fail_run
    st, data = post({"type": "launch", "app": "NopeApp"})
    check("launch failure", st == 500 and "error" in data, data)

    html = (ROOT / "web" / "apps.html").read_text()
    actions = set(re.findall(r'data-action="([^"]+)"', html))
    missing = actions - set(server.CONTROL_ACTIONS)
    check("html actions registered", not missing, missing)

    httpd.shutdown()
    if failures:
        raise SystemExit(1)
    print("All checks passed")


if __name__ == "__main__":
    main()
