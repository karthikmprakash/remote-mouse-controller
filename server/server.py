import asyncio
import json
import shutil
import socket
import subprocess
import sys
import threading
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import websockets
from pynput.mouse import Button
from pynput.mouse import Controller as MouseController

try:
    from pynput.keyboard import Controller as KeyboardController
    from pynput.keyboard import Key
except Exception:  # pragma: no cover - platform / permission dependent
    KeyboardController = None
    Key = None

# Configuration
HTTP_PORT = 8000
WS_PORT = 8765
MOVE_MULTIPLIER = 1.5  # Increase if movement feels slow
SCROLL_MULTIPLIER = 1.0  # Positive dy scrolls up in pynput; we'll invert client dy

mouse = MouseController()
keyboard = KeyboardController() if KeyboardController else None

# Friendly names → macOS application names for `open -a`
APP_ALIASES = {
    "vscode": "Visual Studio Code",
    "vs code": "Visual Studio Code",
    "code": "Visual Studio Code",
    "chrome": "Google Chrome",
    "iterm": "iTerm",
    "iterm2": "iTerm",
    "settings": "System Settings",
    "system preferences": "System Settings",
}

class MovementWorker:
    """Ordered mouse command worker with movement coalescing.

    WebSocket input never blocks on the macOS accessibility API. If several
    consecutive pointer samples arrive while macOS is applying one, they're
    collapsed rather than replayed later as stale cursor motion.
    """

    def __init__(self):
        self._condition = threading.Condition()
        self._commands = deque()
        threading.Thread(target=self._run, daemon=True).start()

    def add(self, dx: float, dy: float) -> None:
        with self._condition:
            if self._commands and self._commands[-1][0] == "move":
                _, queued_dx, queued_dy = self._commands[-1]
                self._commands[-1] = ("move", queued_dx + dx, queued_dy + dy)
            else:
                self._commands.append(("move", dx, dy))
            self._condition.notify()

    def button(self, action: str, button, count: int = 1) -> None:
        with self._condition:
            self._commands.append((action, button, count))
            self._condition.notify()

    def _run(self) -> None:
        while True:
            with self._condition:
                while not self._commands:
                    self._condition.wait()
                command = self._commands.popleft()

            try:
                action = command[0]
                if action == "move":
                    _, dx, dy = command
                    mouse.move(dx * MOVE_MULTIPLIER, dy * MOVE_MULTIPLIER)
                elif action == "click":
                    _, button, count = command
                    mouse.click(button, count)
                elif action == "down":
                    mouse.press(command[1])
                elif action == "up":
                    mouse.release(command[1])
            except Exception:
                pass


movement = MovementWorker()


def get_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


def get_web_dir() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "web"


# Optimized binary protocol for mouse movements
def parse_binary_message(data):
    """Parse binary message: [type:1][data:4]"""
    if len(data) < 5:
        return None

    msg_type = data[0]
    if msg_type == 1:  # move
        dx = int.from_bytes(data[1:3], "little", signed=True) / 100.0
        dy = int.from_bytes(data[3:5], "little", signed=True) / 100.0
        return {"type": "move", "dx": dx, "dy": dy}
    elif msg_type == 2:  # click
        button = data[1]
        count = data[2]
        return {
            "type": "click",
            "button": "left" if button == 1 else "right",
            "count": count,
        }
    elif msg_type == 3:  # down
        button = data[1]
        return {"type": "down", "button": "left" if button == 1 else "right"}
    elif msg_type == 4:  # up
        button = data[1]
        return {"type": "up", "button": "left" if button == 1 else "right"}
    elif msg_type == 5:  # scroll
        dx = int.from_bytes(data[1:3], "little", signed=True) / 100.0
        dy = int.from_bytes(data[3:5], "little", signed=True) / 100.0
        return {"type": "scroll", "dx": dx, "dy": dy}
    return None


async def handle_ws(websocket):
    # Optimize WebSocket for low latency
    try:
        # Access the underlying socket for TCP_NODELAY
        if hasattr(websocket, "sock"):
            websocket.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        elif hasattr(websocket, "_socket"):
            websocket._socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except Exception:
        # If we can't set TCP_NODELAY, continue anyway
        pass

    async for message in websocket:
        try:
            # Try binary protocol first, fallback to JSON
            if isinstance(message, bytes):
                data = parse_binary_message(message)
            else:
                data = json.loads(message)

            if not data:
                continue

            msg_type = data.get("type")

            if msg_type == "move":
                movement.add(float(data.get("dx", 0)), float(data.get("dy", 0)))

            elif msg_type == "click":
                button_name = data.get("button", "left").lower()
                count = int(data.get("count", 1))
                button = Button.left if button_name == "left" else Button.right
                movement.button("click", button, count)

            elif msg_type == "down":
                button_name = data.get("button", "left").lower()
                button = Button.left if button_name == "left" else Button.right
                movement.button("down", button)

            elif msg_type == "up":
                button_name = data.get("button", "left").lower()
                button = Button.left if button_name == "left" else Button.right
                movement.button("up", button)

            elif msg_type == "scroll":
                dx = float(data.get("dx", 0))
                dy = float(data.get("dy", 0))
                try:
                    mouse.scroll(dx * SCROLL_MULTIPLIER, dy * SCROLL_MULTIPLIER)
                except Exception:
                    pass

        except json.JSONDecodeError:
            continue
        except Exception:
            continue


# ---------- macOS control helpers ----------
def run_checked(cmd, timeout: float = 12, success_message: str = "ok"):
    """Run a command and report real success/failure (unlike fire-and-forget Popen)."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            if not err:
                err = f"Command failed (exit {result.returncode})"
            return False, err
        out = (result.stdout or "").strip()
        return True, out or success_message
    except subprocess.TimeoutExpired:
        return False, "Command timed out"
    except FileNotFoundError as e:
        return False, f"Command not found: {e.filename or cmd[0]}"
    except Exception as e:
        return False, str(e)


def run_osascript(*lines: str, success_message: str = "ok"):
    cmd = ["osascript"]
    for line in lines:
        cmd.extend(["-e", line])
    return run_checked(cmd, success_message=success_message)


def resolve_app_name(app_name: str) -> str:
    name = (app_name or "").strip()
    if not name:
        return name
    return APP_ALIASES.get(name.lower(), name)


def open_app(app_name: str):
    app = resolve_app_name(app_name)
    if not app:
        return False, "No app name provided"
    # `open -a` returns non-zero when the app cannot be found.
    ok, msg = run_checked(
        ["open", "-a", app],
        success_message=f"Launched {app}",
    )
    if ok:
        return True, f"Launched {app}"
    return False, msg or f"Could not open {app}"


def open_url(url: str):
    url = (url or "").strip()
    if not url:
        return False, "No URL provided"
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https", "file"}:
        return False, "URL must start with http://, https://, or file://"
    ok, msg = run_checked(["open", url], success_message=f"Opened {url}")
    if ok:
        return True, f"Opened {url}"
    return False, msg


def get_volume() -> int:
    ok, out = run_osascript("output volume of (get volume settings)")
    if ok:
        try:
            return max(0, min(100, int(out)))
        except Exception:
            return 50
    return 50


def set_volume(v: int):
    v = max(0, min(100, int(v)))
    ok, msg = run_osascript(
        f"set volume output volume {v}",
        success_message=f"Volume {v}%",
    )
    if ok:
        return True, f"Volume {v}%"
    return False, msg


def toggle_mute():
    ok, out = run_osascript("output muted of (get volume settings)")
    if not ok:
        return False, out
    is_muted = out.lower() == "true"
    new_muted = not is_muted
    ok, msg = run_osascript(
        f"set volume output muted {str(new_muted).lower()}",
        success_message="Muted" if new_muted else "Unmuted",
    )
    if ok:
        return True, "Muted" if new_muted else "Unmuted"
    return False, msg


def tap_media_key(key_name: str):
    """Send a system media key so Spotify/YouTube/Music all respond."""
    key_map = {}
    if Key is not None:
        key_map = {
            "play_pause": getattr(Key, "media_play_pause", None),
            "next_track": getattr(Key, "media_next", None),
            "prev_track": getattr(Key, "media_previous", None),
            "mute_toggle": getattr(Key, "media_volume_mute", None),
            "volume_up": getattr(Key, "media_volume_up", None),
            "volume_down": getattr(Key, "media_volume_down", None),
        }
    key = key_map.get(key_name)
    if keyboard is not None and key is not None:
        try:
            keyboard.press(key)
            keyboard.release(key)
            labels = {
                "play_pause": "Play / Pause",
                "next_track": "Next track",
                "prev_track": "Previous track",
                "mute_toggle": "Mute toggled",
                "volume_up": "Volume up",
                "volume_down": "Volume down",
            }
            return True, labels.get(key_name, "ok")
        except Exception:
            pass
    return False, "media key unavailable"


def _media_app_fallback(action: str):
    """Fall back to whichever media app is running (Spotify, then Music)."""
    scripts = {
        "play_pause": (
            'if application "Spotify" is running then\n'
            '  tell application "Spotify" to playpause\n'
            'else\n'
            '  tell application "Music" to playpause\n'
            "end if"
        ),
        "next_track": (
            'if application "Spotify" is running then\n'
            '  tell application "Spotify" to next track\n'
            'else\n'
            '  tell application "Music" to next track\n'
            "end if"
        ),
        "prev_track": (
            'if application "Spotify" is running then\n'
            '  tell application "Spotify" to previous track\n'
            'else\n'
            '  tell application "Music" to previous track\n'
            "end if"
        ),
    }
    script = scripts.get(action)
    if not script:
        return False, "unsupported media action"
    return run_checked(
        ["osascript", "-e", script],
        success_message="Media command sent",
    )


def play_pause_media():
    ok, msg = tap_media_key("play_pause")
    if ok:
        return ok, msg
    return _media_app_fallback("play_pause")


def next_track():
    ok, msg = tap_media_key("next_track")
    if ok:
        return ok, msg
    return _media_app_fallback("next_track")


def prev_track():
    ok, msg = tap_media_key("prev_track")
    if ok:
        return ok, msg
    return _media_app_fallback("prev_track")


def volume_up():
    # Prefer OS volume API for reliable step size + feedback; media key as backup.
    v = min(100, get_volume() + 10)
    ok, msg = set_volume(v)
    if ok:
        return ok, msg
    return tap_media_key("volume_up")


def volume_down():
    v = max(0, get_volume() - 10)
    ok, msg = set_volume(v)
    if ok:
        return ok, msg
    return tap_media_key("volume_down")


def mute_toggle():
    ok, msg = toggle_mute()
    if ok:
        return ok, msg
    return tap_media_key("mute_toggle")


def lock_screen():
    # CGSession was removed on modern macOS. Prefer the login framework API,
    # then fall back to the Control+Command+Q shortcut (needs Accessibility).
    try:
        import ctypes

        login = ctypes.CDLL(
            "/System/Library/PrivateFrameworks/login.framework/Versions/Current/login"
        )
        login.SACLockScreenImmediate()
        return True, "Screen locked"
    except Exception as primary_error:
        ok, msg = run_osascript(
            'tell application "System Events" to keystroke "q" using {control down, command down}',
            success_message="Screen locked",
        )
        if ok:
            return True, "Screen locked"
        return False, f"Lock failed ({primary_error}); fallback: {msg}"


def sleep_display():
    if shutil.which("pmset"):
        return run_checked(["pmset", "displaysleepnow"], success_message="Display sleeping")
    return False, "pmset not available"


def keystroke(keys, using=None, success_message="ok"):
    if using:
        script = f'tell application "System Events" to keystroke "{keys}" using {using}'
    else:
        script = f'tell application "System Events" to keystroke "{keys}"'
    return run_osascript(script, success_message=success_message)


def key_code(code, using=None, success_message="ok"):
    if using:
        script = f'tell application "System Events" to key code {code} using {using}'
    else:
        script = f'tell application "System Events" to key code {code}'
    return run_osascript(script, success_message=success_message)


def mission_control():
    # Control + Up Arrow
    return key_code(126, "{control down}", "Mission Control")


def show_desktop():
    # Mission Control "Show Desktop" — F11 / fn varies; Control+Down is App Exposé.
    # Use the standard keyboard shortcut Control + Command + F3 equivalent via key code 103
    # (Show Desktop on many Macs is Mission Control desktop button). Prefer Spotlight-free:
    return key_code(103, success_message="Show Desktop")


def spotlight():
    return keystroke(" ", "{command down}", "Spotlight")


def screenshot_selection():
    return keystroke("4", "{command down, shift down}", "Screenshot selection")


def screenshot_screen():
    return keystroke("3", "{command down, shift down}", "Screenshot saved")


def copy_clipboard():
    return keystroke("c", "{command down}", "Copied")


def paste_clipboard():
    return keystroke("v", "{command down}", "Pasted")


def undo_action():
    return keystroke("z", "{command down}", "Undo")


def select_all():
    return keystroke("a", "{command down}", "Select All")


def empty_trash():
    return run_osascript(
        'tell application "Finder" to empty trash',
        success_message="Trash emptied",
    )


def toggle_dark_mode():
    return run_osascript(
        'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode',
        success_message="Appearance toggled",
    )


def quit_frontmost():
    return keystroke("q", "{command down}", "Quit frontmost app")


CONTROL_ACTIONS = {
    "volume_up": volume_up,
    "volume_down": volume_down,
    "mute_toggle": mute_toggle,
    "play_pause": play_pause_media,
    "next_track": next_track,
    "prev_track": prev_track,
    "lock": lock_screen,
    "sleep_display": sleep_display,
    "mission_control": mission_control,
    "show_desktop": show_desktop,
    "spotlight": spotlight,
    "screenshot": screenshot_selection,
    "screenshot_full": screenshot_screen,
    "copy": copy_clipboard,
    "paste": paste_clipboard,
    "undo": undo_action,
    "select_all": select_all,
    "empty_trash": empty_trash,
    "dark_mode": toggle_dark_mode,
    "quit_front": quit_frontmost,
}


# ---------- HTTP handler ----------
class StaticHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        web_dir = get_web_dir()
        super().__init__(*args, directory=str(web_dir), **kwargs)

    def handle(self):
        # Phones often reset the socket on background/nav; don't spam the console.
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError, TimeoutError):
            pass

    def log_message(self, format, *args):
        return

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/command":
            return super().do_POST()

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._json(400, {"status": "error", "error": "bad json"})

        t = data.get("type")
        try:
            if t == "ping":
                return self._json(200, {"status": "ok", "message": "pong"})

            if t == "launch":
                app = data.get("app", "")
                ok, msg = open_app(app)
                payload = {"status": "ok" if ok else "error"}
                if ok:
                    payload["message"] = msg
                else:
                    payload["error"] = msg
                    payload["message"] = msg
                return self._json(200 if ok else 500, payload)

            if t == "open_url":
                url = data.get("url", "")
                ok, msg = open_url(url)
                payload = {"status": "ok" if ok else "error"}
                if ok:
                    payload["message"] = msg
                else:
                    payload["error"] = msg
                    payload["message"] = msg
                return self._json(200 if ok else 500, payload)

            if t == "control":
                action = data.get("action")
                handler = CONTROL_ACTIONS.get(action)
                if not handler:
                    return self._json(
                        400, {"status": "error", "error": f"unknown action: {action}"}
                    )
                ok, msg = handler()
                payload = {"status": "ok" if ok else "error"}
                if ok:
                    payload["message"] = msg
                else:
                    payload["error"] = msg
                    payload["message"] = msg
                return self._json(200 if ok else 500, payload)

            return self._json(400, {"status": "error", "error": f"unknown type: {t}"})
        except Exception as e:
            return self._json(500, {"status": "error", "error": str(e)})


def ensure_tls_certs():
    """Create a reusable self-signed cert so phones can use Gyro (needs HTTPS)."""
    cert_dir = Path.home() / ".remote-mouse"
    cert_file = cert_dir / "cert.pem"
    key_file = cert_dir / "key.pem"
    if cert_file.exists() and key_file.exists():
        return cert_file, key_file

    cert_dir.mkdir(parents=True, exist_ok=True)
    openssl = shutil.which("openssl")
    if not openssl:
        return None, None

    # SAN includes LAN IP so mobile Safari accepts the host more readily
    # after the user trusts the cert once.
    ip = get_lan_ip()
    san = f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}"
    base_cmd = [
        openssl,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "825",
        "-nodes",
        "-keyout",
        str(key_file),
        "-out",
        str(cert_file),
        "-subj",
        "/CN=Remote Mouse",
    ]
    try:
        subprocess.run(
            base_cmd + ["-addext", san],
            check=True,
            capture_output=True,
            text=True,
        )
        return cert_file, key_file
    except Exception:
        try:
            subprocess.run(
                base_cmd,
                check=True,
                capture_output=True,
                text=True,
            )
            return cert_file, key_file
        except Exception as e:
            print(f"Could not create TLS certificate: {e}")
            try:
                if cert_file.exists():
                    cert_file.unlink()
                if key_file.exists():
                    key_file.unlink()
            except Exception:
                pass
            return None, None


def start_http_server(ssl_context=None):
    server_address = ("0.0.0.0", HTTP_PORT)
    httpd = ThreadingHTTPServer(server_address, StaticHandler)
    scheme = "http"
    if ssl_context is not None:
        httpd.socket = ssl_context.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"
    print(f"{scheme.upper()} server listening on {scheme}://0.0.0.0:{HTTP_PORT}")
    httpd.serve_forever()


async def start_ws_server(ssl_context=None):
    scheme = "wss" if ssl_context is not None else "ws"
    print(f"WebSocket server listening on {scheme}://0.0.0.0:{WS_PORT}")
    # compression=None avoids per-frame deflate cost on tiny binary move packets
    async with websockets.serve(
        handle_ws,
        "0.0.0.0",
        WS_PORT,
        max_size=2**20,
        # Pointer packets become stale immediately. Keep the receive queue
        # tiny so a slow cursor update cannot build seconds of bufferbloat.
        max_queue=1,
        compression=None,
        ssl=ssl_context,
    ):
        await asyncio.Future()  # run forever


async def async_main(ssl_context=None):
    await start_ws_server(ssl_context)


def main():
    import ssl

    ip = get_lan_ip()
    cert_file, key_file = ensure_tls_certs()
    ssl_context = None
    if cert_file and key_file:
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.load_cert_chain(certfile=str(cert_file), keyfile=str(key_file))

    scheme = "https" if ssl_context else "http"
    print("Remote Mouse Server (Optimized)")
    print("===============================")
    print(f"Open on your phone: {scheme}://{ip}:{HTTP_PORT}")
    print(f"Controls page:      {scheme}://{ip}:{HTTP_PORT}/apps.html")
    if ssl_context:
        print("Gyro mode needs HTTPS — if the browser warns about the certificate,")
        print("tap Advanced → Proceed (or install/trust ~/.remote-mouse/cert.pem).")
    else:
        print("TLS cert not available (openssl missing) — Gyro may be blocked on iPhone.")
        print("Install openssl or open the page via a trusted HTTPS tunnel.")
    print("If the cursor does not move, grant Accessibility permissions:")
    print(
        "System Settings → Privacy & Security → Accessibility → enable Terminal/Python"
    )

    http_thread = threading.Thread(
        target=start_http_server, kwargs={"ssl_context": ssl_context}, daemon=True
    )
    http_thread.start()

    try:
        asyncio.run(async_main(ssl_context))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
