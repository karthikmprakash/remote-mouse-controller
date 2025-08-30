#!/bin/bash
source .venv/bin/activate 
pyinstaller \
  --onefile \
  --add-data "web:web" \
  --collect-all websockets \
  --collect-all pynput \
  server/server.py

