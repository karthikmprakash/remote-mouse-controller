import asyncio
import json
import os
import socket
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websockets
from pynput.mouse import Button
from pynput.mouse import Controller as MouseController

# Configuration
HTTP_PORT = 8000
WS_PORT = 8765
MOVE_MULTIPLIER = 1.5  # Increase if movement feels slow
SCROLL_MULTIPLIER = 1.0  # Positive dy scrolls up in pynput; we'll invert client dy

mouse = MouseController()

# Performance optimizations
MOUSE_BATCH_SIZE = 3  # Process multiple movements at once
MOUSE_THROTTLE_MS = 8  # Minimum time between mouse updates (8ms = ~120fps)


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


# Mouse movement batching for better performance
class MouseBatcher:
    def __init__(self):
        self.pending_moves = []
        self.last_update = 0
        self.lock = threading.Lock()

    def add_move(self, dx, dy):
        with self.lock:
            self.pending_moves.append((dx, dy))

    def process_moves(self):
        with self.lock:
            if not self.pending_moves:
                return

            # Combine multiple small movements
            total_dx = sum(dx for dx, _ in self.pending_moves)
            total_dy = sum(dy for _, dy in self.pending_moves)
            self.pending_moves.clear()

            # Apply movement
            try:
                x, y = mouse.position
                mouse.position = (
                    x + total_dx * MOVE_MULTIPLIER,
                    y + total_dy * MOVE_MULTIPLIER,
                )
            except Exception:
                pass


mouse_batcher = MouseBatcher()


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
                dx = float(data.get("dx", 0))
                dy = float(data.get("dy", 0))
                mouse_batcher.add_move(dx, dy)

            elif msg_type == "click":
                button_name = data.get("button", "left").lower()
                count = int(data.get("count", 1))
                button = Button.left if button_name == "left" else Button.right
                try:
                    mouse.click(button, count)
                except Exception:
                    pass

            elif msg_type == "down":
                button_name = data.get("button", "left").lower()
                button = Button.left if button_name == "left" else Button.right
                try:
                    mouse.press(button)
                except Exception:
                    pass

            elif msg_type == "up":
                button_name = data.get("button", "left").lower()
                button = Button.left if button_name == "left" else Button.right
                try:
                    mouse.release(button)
                except Exception:
                    pass

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


# Mouse processing loop
async def mouse_processing_loop():
    while True:
        mouse_batcher.process_moves()
        await asyncio.sleep(MOUSE_THROTTLE_MS / 1000.0)


# ---------- macOS control helpers ----------
import subprocess


def run_detached(cmd):
    try:
        subprocess.Popen(cmd)
        return True, "ok"
    except Exception as e:
        return False, str(e)


def run_output(cmd):
    try:
        out = subprocess.check_output(cmd)
        return True, out.decode("utf-8").strip()
    except Exception as e:
        return False, str(e)


def open_app(app_name: str):
    return run_detached(["open", "-a", app_name])


def open_url(url: str):
    return run_detached(["open", url])


def get_volume() -> int:
    ok, out = run_output(["osascript", "-e", "output volume of (get volume settings)"])
    if ok:
        try:
            return max(0, min(100, int(out)))
        except Exception:
            return 50
    return 50


def set_volume(v: int):
    v = max(0, min(100, int(v)))
    return run_detached(["osascript", "-e", f"set volume output volume {v}"])


def toggle_mute():
    ok, out = run_output(["osascript", "-e", "output muted of (get volume settings)"])
    if ok:
        is_muted = out.lower() == "true"
        return run_detached(
            ["osascript", "-e", f"set volume output muted {str(not is_muted).lower()}"]
        )
    return False, out


def play_pause_music():
    return run_detached(["osascript", "-e", 'tell application "Music" to playpause'])


def next_track():
    return run_detached(["osascript", "-e", 'tell application "Music" to next track'])


def prev_track():
    return run_detached(
        ["osascript", "-e", 'tell application "Music" to previous track']
    )


def lock_screen():
    # Switch to login window (locks session)
    return run_detached(
        [
            "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
            "-suspend",
        ]
    )


def sleep_display():
    return run_detached(["pmset", "displaysleepnow"])


# ---------- HTTP handler ----------
class StaticHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        web_dir = get_web_dir()
        super().__init__(*args, directory=str(web_dir), **kwargs)

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
            if t == "launch":
                app = data.get("app", "")
                ok, msg = open_app(app)
                return self._json(
                    200 if ok else 500,
                    {"status": "ok" if ok else "error", "message": msg},
                )

            elif t == "open_url":
                url = data.get("url", "")
                ok, msg = open_url(url)
                return self._json(
                    200 if ok else 500,
                    {"status": "ok" if ok else "error", "message": msg},
                )

            elif t == "control":
                action = data.get("action")
                if action == "volume_up":
                    v = get_volume()
                    ok, msg = set_volume(v + 10)
                    print(f"Volume up: {v + 10}")
                elif action == "volume_down":
                    v = get_volume()
                    ok, msg = set_volume(v - 10)
                elif action == "mute_toggle":
                    ok, msg = toggle_mute()
                elif action == "play_pause":
                    ok, msg = play_pause_music()
                elif action == "next_track":
                    ok, msg = next_track()
                elif action == "prev_track":
                    ok, msg = prev_track()
                elif action == "lock":
                    ok, msg = lock_screen()
                elif action == "sleep_display":
                    ok, msg = sleep_display()
                else:
                    return self._json(
                        400, {"status": "error", "error": "unknown action"}
                    )
                return self._json(
                    200 if ok else 500,
                    {"status": "ok" if ok else "error", "message": msg},
                )
            else:
                return self._json(400, {"status": "error", "error": "unknown type"})
        except Exception as e:
            return self._json(500, {"status": "error", "error": str(e)})


def start_http_server():
    server_address = ("0.0.0.0", HTTP_PORT)
    httpd = ThreadingHTTPServer(server_address, StaticHandler)
    print(f"HTTP server listening on http://0.0.0.0:{HTTP_PORT}")
    httpd.serve_forever()


async def start_ws_server():
    print(f"WebSocket server listening on ws://0.0.0.0:{WS_PORT}")
    async with websockets.serve(handle_ws, "0.0.0.0", WS_PORT, max_size=2**20):
        await asyncio.Future()  # run forever


async def async_main():
    """Main async function to run both servers"""
    await asyncio.gather(start_ws_server(), mouse_processing_loop())


def main():
    ip = get_lan_ip()
    print("Remote Mouse Server (Optimized)")
    print("===============================")
    print(f"Open on your phone: http://{ip}:{HTTP_PORT}")
    print(f"Controls page:      http://{ip}:{HTTP_PORT}/apps.html")
    print("If the cursor does not move, grant Accessibility permissions:")
    print(
        "System Settings → Privacy & Security → Accessibility → enable Terminal/Python"
    )

    http_thread = threading.Thread(target=start_http_server, daemon=True)
    http_thread.start()

    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
