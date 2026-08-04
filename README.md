# Remote Mouse

Control your Mac's mouse from your phone using a web-based trackpad or gyro/accelerometer sensors.

## Prerequisites
- macOS (you are on Darwin 24.x)
- Python 3.9+ recommended
- Modern mobile browser with sensor support (for gyro mode)

## Setup
```bash
cd /Users/karthikmprakash/Documents/Personal/Projects/remote-mouse
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server/server.py
```

Then, on your phone (connected to the same Wi‑Fi), open the URL printed in the terminal, e.g. `http://YOUR_LAPTOP_IP:8000`.

## Modes

### Trackpad Mode (Default)
- One-finger move: moves the cursor
- One-finger tap: left click
- Two-finger move: scroll
- Press & hold, then move: drag / select

### Gyro Mode
Uses the phone’s real-time gyroscope / orientation sensors (`DeviceOrientationEvent`):
- Toggle **Gyro** in the top bar
- Tilt the phone to move the Mac cursor
- On-screen **Left / Right / Drag / Recenter** buttons
- Sensitivity slider
- **iPhone note:** Safari only grants motion permission on **HTTPS**. The server auto-creates a self-signed cert and serves `https://YOUR_IP:8000` — accept the certificate warning once.

### Controls Page (`/apps.html`)
- Launch common Mac apps (VS Code, Safari, Spotify, etc.)
- Volume, mute, and system-wide media play/pause/next/prev (works with Spotify, Music, browser media)
- System actions: Spotlight, Mission Control, Show Desktop, Screenshot, Dark Mode, Sleep Display, Lock, Quit frontmost app
- Edit shortcuts: Copy, Paste, Undo, Select All
- Open a local URL (e.g. `localhost:3000`)

## Features
- **Pad / Gyro toggle**: switch pointer modes live on the trackpad page
- **Real-time sensors**: Device Orientation API at display refresh rate
- **System Media Keys**: Playback buttons use macOS media keys (not Apple Music only)
- **Honest Feedback**: Failed launches/commands show an error toast instead of a false success
- **Drag Mode**: Press & hold on the trackpad, or toggle Drag in gyro mode
- **Responsive Design**: Works on phones and tablets

## Performance Optimizations
The server has been optimized for low latency:

- **Binary Protocol**: Mouse movements use a compact 5-byte binary format instead of JSON
- **Movement Batching**: Multiple small movements are combined for smoother cursor motion
- **TCP_NODELAY**: Disabled Nagle's algorithm to reduce network latency
- **Throttled Updates**: Mouse updates are limited to ~120fps to prevent overwhelming the system
- **Optimized WebSocket**: Reduced message overhead and improved connection handling

### Latency Improvements
- **Before**: ~50-100ms latency with JSON protocol
- **After**: ~8-16ms latency with binary protocol and batching
- **Network**: Reduced packet size by ~80% for mouse movements

## macOS Accessibility Permission
The first time, macOS may block cursor control. Grant permission:
- System Settings → Privacy & Security → Accessibility
- Enable your terminal app and `Python` under the list

If it still does not move, quit and reopen the terminal, then rerun the server.

## Troubleshooting
- If the phone cannot connect, ensure your Mac and phone are on the same network and your Mac's firewall allows incoming connections for Python.
- If movement feels slow/fast, tweak `MOVE_MULTIPLIER` in `server/server.py`.
- For scroll sensitivity, tweak `SCROLL_MULTIPLIER`.
- If gyro mode doesn't work, check if your browser supports the Device Orientation API and grant sensor permissions.
- **iPhone gyro:** use the `https://` URL from the server terminal (HTTP cannot access motion sensors). Accept the self-signed certificate warning.
- Some older Android browsers allow gyro over HTTP; iOS always needs HTTPS.
- For best performance, ensure your phone and Mac are on the same WiFi network with good signal strength.