(() => {
  const pad = document.getElementById('pad');
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const infoBtn = document.getElementById('info-btn');
  const infoModal = document.getElementById('info-modal');
  const closeModal = document.getElementById('close-modal');

  function setStatus(text, status = 'yellow') {
    statusText.textContent = text;
    statusIndicator.className = `status-${status}`;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    pad.width = Math.floor(window.innerWidth * dpr);
    pad.height = Math.floor(window.innerHeight * dpr);
    pad.style.width = window.innerWidth + 'px';
    pad.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  const ctx = pad.getContext('2d');
  function renderDot(x, y) {
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, pad.width, pad.height);
    ctx.beginPath();
    ctx.arc(x * dpr, y * dpr, 12 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(100, 180, 255, 0.18)';
    ctx.fill();
  }

  function wsUrl() {
    const host = window.location.hostname;
    const port = 8765; // WS server port
    const protocol = 'ws://';
    return `${protocol}${host}:${port}`;
  }

  let ws;
  function connectWs() {
    try { ws && ws.close(); } catch {}
    setStatus('Connecting...', 'yellow');
    ws = new WebSocket(wsUrl());
    ws.onopen = () => setStatus('Connected', 'green');
    ws.onclose = () => setStatus('Disconnected', 'red');
    ws.onerror = () => setStatus('Connection Error', 'red');
    ws.onmessage = () => {};
  }
  connectWs();
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (ws && ws.readyState === WebSocket.CLOSED) {
        setStatus('Reconnecting...', 'yellow');
      }
      connectWs();
    }
  }, 2500);

  // Optimized binary protocol for mouse movements
  function sendBinary(type, dx = 0, dy = 0, button = 1, count = 1) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const buffer = new ArrayBuffer(5);
      const view = new DataView(buffer);
      view.setUint8(0, type);
      
      if (type === 1 || type === 5) { // move or scroll
        view.setInt16(1, Math.round(dx * 100), true);
        view.setInt16(3, Math.round(dy * 100), true);
      } else { // click, down, up
        view.setUint8(1, button);
        view.setUint8(2, count);
      }
      
      ws.send(buffer);
    }
  }

  // Fallback JSON send for compatibility
  function sendJson(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // Performance optimizations
  let lastMoveTime = 0;
  const MOVE_THROTTLE_MS = 8; // 8ms = ~120fps
  let pendingMove = { dx: 0, dy: 0 };
  let moveTimeout = null;

  function sendMove(dx, dy) {
    const now = performance.now();
    pendingMove.dx += dx;
    pendingMove.dy += dy;
    
    if (now - lastMoveTime >= MOVE_THROTTLE_MS) {
      // Send immediately
      sendBinary(1, pendingMove.dx, pendingMove.dy);
      pendingMove = { dx: 0, dy: 0 };
      lastMoveTime = now;
    } else if (!moveTimeout) {
      // Schedule delayed send
      moveTimeout = setTimeout(() => {
        sendBinary(1, pendingMove.dx, pendingMove.dy);
        pendingMove = { dx: 0, dy: 0 };
        lastMoveTime = performance.now();
        moveTimeout = null;
      }, MOVE_THROTTLE_MS - (now - lastMoveTime));
    }
  }

  let isTouching = false;
  let lastX = 0, lastY = 0;
  let touchStartTime = 0;
  let totalMove = 0;
  let isTwoFinger = false;

  function onTouchStart(e) {
    e.preventDefault();
    const t = e.touches[0];
    isTouching = true;
    isTwoFinger = e.touches.length >= 2;
    lastX = t.clientX; lastY = t.clientY;
    touchStartTime = performance.now();
    totalMove = 0;
    renderDot(lastX, lastY);
  }

  function onTouchMove(e) {
    e.preventDefault();
    const t = e.touches[0];
    const dx = t.clientX - lastX;
    const dy = t.clientY - lastY;
    lastX = t.clientX; lastY = t.clientY;
    totalMove += Math.abs(dx) + Math.abs(dy);

    if (e.touches.length >= 2 || isTwoFinger) {
      // Two-finger scroll: send scroll deltas (dy dominant)
      sendBinary(5, 0, dy);
    } else {
      // One-finger move - use optimized binary protocol
      sendMove(dx, dy);
    }
    renderDot(lastX, lastY);
  }

  function onTouchEnd(e) {
    e.preventDefault();
    const dt = performance.now() - touchStartTime;
    if (!isTwoFinger && totalMove < 12 && dt < 220) {
      // Tap to click
      sendBinary(2, 0, 0, 1, 1);
    }
    isTouching = false;
    isTwoFinger = false;
    ctx.clearRect(0, 0, pad.width, pad.height);
  }

  pad.addEventListener('touchstart', onTouchStart, { passive: false });
  pad.addEventListener('touchmove', onTouchMove, { passive: false });
  pad.addEventListener('touchend', onTouchEnd, { passive: false });
  pad.addEventListener('touchcancel', onTouchEnd, { passive: false });

  // Mouse support for desktop testing
  let mouseDown = false;
  pad.addEventListener('mousedown', (e) => {
    mouseDown = true;
    lastX = e.clientX; lastY = e.clientY;
    renderDot(lastX, lastY);
  });
  pad.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    sendMove(dx, dy);
    renderDot(lastX, lastY);
  });
  pad.addEventListener('mouseup', () => {
    if (mouseDown) {
      sendBinary(2, 0, 0, 1, 1);
    }
    mouseDown = false;
    ctx.clearRect(0, 0, pad.width, pad.height);
  });

  // Modal functionality
  infoBtn.addEventListener('click', () => {
    infoModal.classList.remove('hidden');
  });

  closeModal.addEventListener('click', () => {
    infoModal.classList.add('hidden');
  });

  // Close modal when clicking outside
  infoModal.addEventListener('click', (e) => {
    if (e.target === infoModal) {
      infoModal.classList.add('hidden');
    }
  });

  // Close modal with Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !infoModal.classList.contains('hidden')) {
      infoModal.classList.add('hidden');
    }
  });
})();