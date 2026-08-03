(() => {
  const pad = document.getElementById('pad');
  const padHint = document.getElementById('pad-hint');
  const ui = window.RemoteUI || {};

  const LONG_PRESS_MS = 350;
  const TAP_MOVE_SLOP = 12;
  const TAP_MAX_MS = 220;

  ui.wireModal?.({
    infoBtn: document.getElementById('info-btn'),
    infoModal: document.getElementById('info-modal'),
    closeModal: document.getElementById('close-modal'),
  });

  function setStatus(text, status = 'yellow') {
    ui.setConnectionStatus?.(text, status);
  }

  function hideHint() {
    if (padHint && !padHint.classList.contains('is-hidden')) {
      padHint.classList.add('is-hidden');
    }
  }

  // Cap DPR — full retina canvas clears are expensive on every frame
  function getDpr() {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  function resize() {
    const dpr = getDpr();
    pad.width = Math.floor(window.innerWidth * dpr);
    pad.height = Math.floor(window.innerHeight * dpr);
    pad.style.width = window.innerWidth + 'px';
    pad.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  const ctx = pad.getContext('2d', { alpha: true, desynchronized: true });

  let paintX = 0;
  let paintY = 0;
  let paintDragging = false;
  let paintProgress = 0;
  let paintScheduled = false;
  let showPaint = false;
  let lastPaintBounds = null;

  function paintTouch() {
    paintScheduled = false;
    if (lastPaintBounds) {
      ctx.clearRect(
        lastPaintBounds.x,
        lastPaintBounds.y,
        lastPaintBounds.size,
        lastPaintBounds.size,
      );
      lastPaintBounds = null;
    }
    if (!showPaint) return;

    const dpr = getDpr();
    const px = paintX * dpr;
    const py = paintY * dpr;
    const dragging = paintDragging;
    const progress = paintProgress;

    // Long-press ring (fills while holding)
    if (!dragging && progress > 0 && progress < 1) {
      ctx.beginPath();
      ctx.arc(px, py, 22 * dpr, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
      ctx.lineWidth = 3 * dpr;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(px, py, (dragging ? 16 : 12) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = dragging
      ? 'rgba(245, 158, 11, 0.35)'
      : 'rgba(45, 212, 191, 0.28)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(px, py, 4 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = dragging ? 'rgba(245, 158, 11, 0.95)' : 'rgba(240, 250, 247, 0.95)';
    ctx.fill();

    const radius = 28 * dpr;
    lastPaintBounds = {
      x: px - radius,
      y: py - radius,
      size: radius * 2,
    };
  }

  function schedulePaint(x, y, { dragging = false, progress = 0 } = {}) {
    paintX = x;
    paintY = y;
    paintDragging = dragging;
    paintProgress = progress;
    showPaint = true;
    if (paintScheduled) return;
    paintScheduled = true;
    requestAnimationFrame(paintTouch);
  }

  function clearTouch() {
    showPaint = false;
    paintProgress = 0;
    if (!paintScheduled) {
      requestAnimationFrame(paintTouch);
    }
  }

  function wsUrl() {
    return `ws://${window.location.hostname}:8765`;
  }

  let ws;
  let pendingDx = 0;
  let pendingDy = 0;
  let moveRaf = null;
  const MAX_BUFFERED_BYTES = 0;

  function connectWs() {
    try { ws && ws.close(); } catch {}
    setStatus('Connecting…', 'yellow');
    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => setStatus('Connected', 'green');
    ws.onclose = () => {
      pendingDx = 0;
      pendingDy = 0;
      setStatus('Disconnected', 'red');
    };
    ws.onerror = () => setStatus('Connection Error', 'red');
    ws.onmessage = () => {};
  }
  connectWs();
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (ws && ws.readyState === WebSocket.CLOSED) {
        setStatus('Reconnecting…', 'yellow');
      }
      connectWs();
    }
  }, 2500);

  function sendPacket(type, dx = 0, dy = 0, button = 1, count = 1) {
    if (!(ws && ws.readyState === WebSocket.OPEN)) return;
    // WebSocket.send() may enqueue asynchronously. A fresh five-byte buffer
    // prevents later events from mutating a packet that's still in flight.
    const buffer = new ArrayBuffer(5);
    const view = new DataView(buffer);
    view.setUint8(0, type);
    if (type === 1 || type === 5) {
      view.setInt16(1, Math.round(dx * 100), true);
      view.setInt16(3, Math.round(dy * 100), true);
    } else {
      view.setUint8(1, button);
      view.setUint8(2, count);
    }
    ws.send(buffer);
  }

  function flushMove(force = false) {
    moveRaf = null;
    if (pendingDx === 0 && pendingDy === 0) return;
    if (!(ws && ws.readyState === WebSocket.OPEN)) {
      pendingDx = 0;
      pendingDy = 0;
      return;
    }

    // Never append pointer packets to an existing network backlog. Keep
    // accumulating displacement locally and send one fresh aggregate packet.
    if (!force && ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      moveRaf = requestAnimationFrame(() => flushMove(false));
      return;
    }

    const dx = Math.max(-327.67, Math.min(327.67, pendingDx));
    const dy = Math.max(-327.67, Math.min(327.67, pendingDy));
    pendingDx -= dx;
    pendingDy -= dy;
    sendPacket(1, dx, dy);

    if (pendingDx !== 0 || pendingDy !== 0) {
      moveRaf = requestAnimationFrame(() => flushMove(false));
    }
  }

  function sendBinary(type, dx = 0, dy = 0, button = 1, count = 1) {
    // Preserve ordering: cursor movement must arrive before click/down/up.
    if (type !== 1) flushMove(true);
    sendPacket(type, dx, dy, button, count);
  }

  // Send immediately on a healthy socket. Only fall back to frame-coalescing
  // when a packet is already buffered, preserving low latency without floods.
  function sendMove(dx, dy) {
    if (dx === 0 && dy === 0) return;
    pendingDx += dx;
    pendingDy += dy;
    if (
      !moveRaf &&
      ws &&
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount <= MAX_BUFFERED_BYTES
    ) {
      flushMove(false);
    } else if (!moveRaf) {
      moveRaf = requestAnimationFrame(() => flushMove(false));
    }
  }

  let lastX = 0;
  let lastY = 0;
  let touchStartTime = 0;
  let totalMove = 0;
  let isTwoFinger = false;
  let isDragging = false;
  let longPressTimer = null;
  let longPressRaf = null;

  function setDragging(active) {
    isDragging = active;
    document.body.classList.toggle('is-dragging', active);
    document.body.classList.remove('is-drag-arming');
    const badge = document.getElementById('drag-badge');
    if (badge) badge.hidden = !active;
  }

  function beginDrag() {
    if (isDragging || isTwoFinger) return;
    sendBinary(3, 0, 0, 1, 1); // mouse down
    setDragging(true);
    ui.haptic?.(30, 'strong');
    schedulePaint(lastX, lastY, { dragging: true, progress: 1 });
  }

  function endDrag() {
    if (!isDragging) return;
    sendBinary(4, 0, 0, 1, 1); // mouse up
    setDragging(false);
  }

  function clearLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (longPressRaf) {
      cancelAnimationFrame(longPressRaf);
      longPressRaf = null;
    }
    document.body.classList.remove('is-drag-arming');
  }

  function armLongPress() {
    clearLongPress();
    document.body.classList.add('is-drag-arming');
    const start = performance.now();

    const tick = (now) => {
      const p = Math.min(1, (now - start) / LONG_PRESS_MS);
      schedulePaint(lastX, lastY, { dragging: false, progress: p });
      if (p < 1 && longPressTimer) {
        longPressRaf = requestAnimationFrame(tick);
      }
    };
    longPressRaf = requestAnimationFrame(tick);

    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (longPressRaf) {
        cancelAnimationFrame(longPressRaf);
        longPressRaf = null;
      }
      if (totalMove < TAP_MOVE_SLOP && !isTwoFinger) {
        beginDrag();
      } else {
        document.body.classList.remove('is-drag-arming');
      }
    }, LONG_PRESS_MS);
  }

  function onTouchStart(e) {
    e.preventDefault();
    ui.unlockAudio?.(); // unlock iOS audio for the long-press tick
    hideHint();
    const t = e.touches[0];
    isTwoFinger = e.touches.length >= 2;
    lastX = t.clientX;
    lastY = t.clientY;
    touchStartTime = performance.now();
    totalMove = 0;

    if (isTwoFinger) {
      clearLongPress();
      if (isDragging) endDrag();
      return;
    }

    armLongPress();
    schedulePaint(lastX, lastY, { dragging: isDragging, progress: 0 });
  }

  function onTouchMove(e) {
    e.preventDefault();
    const t = e.touches[0];
    const dx = t.clientX - lastX;
    const dy = t.clientY - lastY;
    lastX = t.clientX;
    lastY = t.clientY;
    totalMove += Math.abs(dx) + Math.abs(dy);

    if (e.touches.length >= 2 || isTwoFinger) {
      clearLongPress();
      if (isDragging) endDrag();
      isTwoFinger = true;
      sendBinary(5, 0, dy);
    } else {
      if (!isDragging && totalMove >= TAP_MOVE_SLOP) {
        clearLongPress();
      }
      // Network first, paint second — cursor latency matters most
      sendMove(dx, dy);
    }
    schedulePaint(lastX, lastY, {
      dragging: isDragging,
      progress: isDragging ? 1 : 0,
    });
  }

  function onTouchEnd(e) {
    e.preventDefault();
    clearLongPress();

    if (e.touches && e.touches.length > 0) {
      if (e.touches.length === 1) {
        isTwoFinger = false;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
      }
      return;
    }

    const dt = performance.now() - touchStartTime;

    if (isDragging) {
      endDrag();
    } else if (!isTwoFinger && totalMove < TAP_MOVE_SLOP && dt < TAP_MAX_MS) {
      sendBinary(2, 0, 0, 1, 1);
      ui.haptic?.(12, 'soft');
    }

    isTwoFinger = false;
    clearTouch();
  }

  pad.addEventListener('touchstart', onTouchStart, { passive: false });
  pad.addEventListener('touchmove', onTouchMove, { passive: false });
  pad.addEventListener('touchend', onTouchEnd, { passive: false });
  pad.addEventListener('touchcancel', onTouchEnd, { passive: false });

  let mouseDown = false;
  pad.addEventListener('mousedown', (e) => {
    ui.unlockAudio?.();
    hideHint();
    mouseDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
    totalMove = 0;
    touchStartTime = performance.now();
    isTwoFinger = false;
    armLongPress();
    schedulePaint(lastX, lastY, { dragging: false, progress: 0 });
  });
  pad.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    totalMove += Math.abs(dx) + Math.abs(dy);
    if (!isDragging && totalMove >= TAP_MOVE_SLOP) clearLongPress();
    sendMove(dx, dy);
    schedulePaint(lastX, lastY, { dragging: isDragging, progress: isDragging ? 1 : 0 });
  });
  pad.addEventListener('mouseup', () => {
    if (!mouseDown) return;
    mouseDown = false;
    clearLongPress();
    const dt = performance.now() - touchStartTime;
    if (isDragging) {
      endDrag();
    } else if (totalMove < TAP_MOVE_SLOP && dt < TAP_MAX_MS) {
      sendBinary(2, 0, 0, 1, 1);
    }
    clearTouch();
  });
  pad.addEventListener('mouseleave', () => {
    if (!mouseDown) return;
    mouseDown = false;
    clearLongPress();
    if (isDragging) endDrag();
    clearTouch();
  });

  window.addEventListener('blur', () => {
    clearLongPress();
    if (isDragging) endDrag();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearLongPress();
      if (isDragging) endDrag();
    }
  });
})();
