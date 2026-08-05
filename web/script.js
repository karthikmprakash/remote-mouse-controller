(() => {
  const pad = document.getElementById('pad');
  const padHint = document.getElementById('pad-hint');
  const ui = window.RemoteUI || {};

  const LONG_PRESS_MS = 350;
  const TAP_MOVE_SLOP = 12;
  const TAP_MAX_MS = 280;
  const PINCH_SLOP = 14;
  const TWO_FINGER_MOVE_SLOP = 14;
  const ZOOM_SCALE = 0.045;
  let pointerMode = 'trackpad';

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
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.hostname}:8765`;
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
    if (type === 1 || type === 5 || type === 7) {
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

  // Absolute cursor (normalized 0..1). Used by gyro pointing mode.
  let pendingAbs = null;
  let absRaf = null;

  function flushAbs() {
    absRaf = null;
    if (!pendingAbs) return;
    if (!(ws && ws.readyState === WebSocket.OPEN)) {
      pendingAbs = null;
      return;
    }
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      absRaf = requestAnimationFrame(flushAbs);
      return;
    }

    pendingDx = 0;
    pendingDy = 0;
    if (moveRaf) {
      cancelAnimationFrame(moveRaf);
      moveRaf = null;
    }

    const { nx, ny } = pendingAbs;
    pendingAbs = null;
    const buffer = new ArrayBuffer(5);
    const view = new DataView(buffer);
    view.setUint8(0, 6);
    view.setUint16(1, Math.round(Math.max(0, Math.min(1, nx)) * 10000), true);
    view.setUint16(3, Math.round(Math.max(0, Math.min(1, ny)) * 10000), true);
    ws.send(buffer);
  }

  function sendAbs(nx, ny) {
    pendingAbs = { nx, ny };
    if (!absRaf) absRaf = requestAnimationFrame(flushAbs);
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
  let twoFingerSession = false;
  let twoFingerMode = null; // null | 'pending' | 'scroll' | 'pinch'
  let twoFingerMoved = false;
  let lastPinchDist = 0;
  let lastCentroidX = 0;
  let lastCentroidY = 0;
  let isDragging = false;
  let longPressTimer = null;
  let longPressRaf = null;

  function touchDistance(a, b) {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.hypot(dx, dy);
  }

  function touchCentroid(a, b) {
    return {
      x: (a.clientX + b.clientX) * 0.5,
      y: (a.clientY + b.clientY) * 0.5,
    };
  }

  function beginTwoFinger(touches) {
    const a = touches[0];
    const b = touches[1];
    const mid = touchCentroid(a, b);
    isTwoFinger = true;
    twoFingerSession = true;
    twoFingerMode = 'pending';
    twoFingerMoved = false;
    lastPinchDist = touchDistance(a, b);
    lastCentroidX = mid.x;
    lastCentroidY = mid.y;
    lastX = mid.x;
    lastY = mid.y;
    touchStartTime = performance.now();
    clearLongPress();
    if (isDragging) endDrag();
  }

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
    if (pointerMode !== 'trackpad') return;
    e.preventDefault();
    ui.unlockAudio?.(); // unlock iOS audio for the long-press tick
    hideHint();

    if (e.touches.length >= 2) {
      beginTwoFinger(e.touches);
      schedulePaint(lastX, lastY, { dragging: false, progress: 0 });
      return;
    }

    const t = e.touches[0];
    isTwoFinger = false;
    twoFingerSession = false;
    twoFingerMode = null;
    twoFingerMoved = false;
    lastX = t.clientX;
    lastY = t.clientY;
    touchStartTime = performance.now();
    totalMove = 0;

    armLongPress();
    schedulePaint(lastX, lastY, { dragging: isDragging, progress: 0 });
  }

  function onTouchMove(e) {
    if (pointerMode !== 'trackpad') return;
    e.preventDefault();

    if (e.touches.length >= 2) {
      if (!twoFingerSession) beginTwoFinger(e.touches);
      const a = e.touches[0];
      const b = e.touches[1];
      const mid = touchCentroid(a, b);
      const dist = touchDistance(a, b);
      const dPinch = dist - lastPinchDist;
      const dx = mid.x - lastCentroidX;
      const dy = mid.y - lastCentroidY;
      lastPinchDist = dist;
      lastCentroidX = mid.x;
      lastCentroidY = mid.y;
      lastX = mid.x;
      lastY = mid.y;

      const pinchMag = Math.abs(dPinch);
      const moveMag = Math.abs(dx) + Math.abs(dy);

      if (twoFingerMode === 'pending') {
        if (pinchMag >= PINCH_SLOP && pinchMag >= moveMag) {
          twoFingerMode = 'pinch';
          twoFingerMoved = true;
        } else if (moveMag >= TWO_FINGER_MOVE_SLOP) {
          twoFingerMode = 'scroll';
          twoFingerMoved = true;
        }
      }

      if (twoFingerMode === 'pinch') {
        if (Math.abs(dPinch) > 0.2) {
          // Positive distance change = zoom in
          sendBinary(7, 0, dPinch * ZOOM_SCALE);
        }
      } else if (twoFingerMode === 'scroll') {
        if (dy !== 0 || dx !== 0) {
          sendBinary(5, dx, dy);
        }
      }

      schedulePaint(lastX, lastY, { dragging: false, progress: 0 });
      return;
    }

    const t = e.touches[0];
    const dx = t.clientX - lastX;
    const dy = t.clientY - lastY;
    lastX = t.clientX;
    lastY = t.clientY;
    totalMove += Math.abs(dx) + Math.abs(dy);

    if (twoFingerSession) {
      // One finger remaining after a two-finger gesture — don't move cursor yet
      clearLongPress();
      if (isDragging) endDrag();
      schedulePaint(lastX, lastY, { dragging: false, progress: 0 });
      return;
    }

    if (!isDragging && totalMove >= TAP_MOVE_SLOP) {
      clearLongPress();
    }
    // Network first, paint second — cursor latency matters most
    sendMove(dx, dy);
    schedulePaint(lastX, lastY, {
      dragging: isDragging,
      progress: isDragging ? 1 : 0,
    });
  }

  function onTouchEnd(e) {
    if (pointerMode !== 'trackpad') return;
    e.preventDefault();
    clearLongPress();

    if (e.touches && e.touches.length > 0) {
      if (e.touches.length >= 2) {
        beginTwoFinger(e.touches);
      } else if (e.touches.length === 1) {
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        isTwoFinger = false;
      }
      return;
    }

    const dt = performance.now() - touchStartTime;

    if (isDragging) {
      endDrag();
    } else if (twoFingerSession) {
      if (
        !twoFingerMoved &&
        twoFingerMode !== 'scroll' &&
        twoFingerMode !== 'pinch' &&
        dt < TAP_MAX_MS
      ) {
        sendBinary(2, 0, 0, 2, 1); // right click
        ui.haptic?.(16, 'strong');
      }
    } else if (totalMove < TAP_MOVE_SLOP && dt < TAP_MAX_MS) {
      sendBinary(2, 0, 0, 1, 1);
      ui.haptic?.(12, 'soft');
    }

    isTwoFinger = false;
    twoFingerSession = false;
    twoFingerMode = null;
    twoFingerMoved = false;
    clearTouch();
  }

  pad.addEventListener('touchstart', onTouchStart, { passive: false });
  pad.addEventListener('touchmove', onTouchMove, { passive: false });
  pad.addEventListener('touchend', onTouchEnd, { passive: false });
  pad.addEventListener('touchcancel', onTouchEnd, { passive: false });

  let mouseDown = false;
  pad.addEventListener('mousedown', (e) => {
    if (pointerMode !== 'trackpad') return;
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
    if (pointerMode !== 'trackpad' || !mouseDown) return;
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
    if (pointerMode !== 'trackpad' || !mouseDown) return;
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
    if (pointerMode !== 'trackpad' || !mouseDown) return;
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
      gyroPaused = true;
    } else if (pointerMode === 'gyro') {
      gyroPaused = false;
    }
  });

  // ── Gyro / DeviceOrientation mode (absolute pointing) ─────
  let gyroActive = false;
  let gyroPaused = false;
  let gyroListening = false;
  let calBeta = NaN;
  let calGamma = NaN;
  let lastOrient = null;
  let gyroSensitivity = 1.4;
  // Degrees from center-aim to screen edge at sensitivity = 1
  const GYRO_BASE_HALF_FOV = 32;

  const modeLabel = document.getElementById('mode-label');
  const modeTrackpadBtn = document.getElementById('mode-trackpad');
  const modeGyroBtn = document.getElementById('mode-gyro');
  const gyroPanel = document.getElementById('gyro-panel');
  const gyroLeftBtn = document.getElementById('gyro-left');
  const gyroRightBtn = document.getElementById('gyro-right');
  const gyroDragBtn = document.getElementById('gyro-drag');
  const gyroRecenterBtn = document.getElementById('gyro-recenter');
  const gyroSensInput = document.getElementById('gyro-sensitivity');
  const hintTitle = document.getElementById('pad-hint-title');
  const hintSub = document.getElementById('pad-hint-sub');

  const TRACKPAD_HINT = {
    title: 'Touch to control',
    sub: 'Your phone is the trackpad for your Mac',
  };
  const GYRO_HINT = {
    title: 'Point to aim',
    sub: 'Aim the phone like a remote — Recenter maps this direction to screen center',
  };

  function isSecureEnoughForSensors() {
    return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  function sensorsSupported() {
    return typeof window.DeviceOrientationEvent !== 'undefined';
  }

  async function requestOrientationPermission() {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      if (!isSecureEnoughForSensors()) {
        throw new Error('Gyro on iPhone needs the https:// URL printed by the server');
      }
      const state = await DeviceOrientationEvent.requestPermission();
      if (state !== 'granted') {
        throw new Error('Motion permission denied');
      }
    }
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function recenterGyro(sample) {
    if (sample && Number.isFinite(sample.beta) && Number.isFinite(sample.gamma)) {
      calBeta = sample.beta;
      calGamma = sample.gamma;
    } else if (lastOrient) {
      calBeta = lastOrient.beta;
      calGamma = lastOrient.gamma;
    }
    sendAbs(0.5, 0.5);
    paintGyroCursor(0.5, 0.5);
    ui.showToast?.('Aim centered', 'ok');
    ui.haptic?.(16, 'soft');
  }

  function paintGyroCursor(nx, ny) {
    // Preview aim on the phone: keep the dot in the open field above controls
    const x = window.innerWidth * clamp01(nx);
    const y = window.innerHeight * (0.28 + clamp01(ny) * 0.32);
    schedulePaint(x, y, { dragging: isDragging, progress: isDragging ? 1 : 0 });
  }

  function onDeviceOrientation(e) {
    if (!gyroActive || gyroPaused || pointerMode !== 'gyro') return;
    if (e.beta == null || e.gamma == null) return;

    const beta = e.beta;
    const gamma = e.gamma;
    lastOrient = { beta, gamma };

    // First sample after enable → this direction becomes screen center
    if (!Number.isFinite(calBeta) || !Number.isFinite(calGamma)) {
      calBeta = beta;
      calGamma = gamma;
      sendAbs(0.5, 0.5);
      paintGyroCursor(0.5, 0.5);
      return;
    }

    const halfFov = GYRO_BASE_HALF_FOV / Math.max(0.5, gyroSensitivity);
    const dGamma = gamma - calGamma;
    const dBeta = beta - calBeta;

    // Absolute map: phone direction → Mac screen position
    // gamma = yaw-ish left/right; beta = pitch (invert so tip-up → cursor up)
    const nx = clamp01(0.5 + (dGamma / halfFov) * 0.5);
    const ny = clamp01(0.5 - (dBeta / halfFov) * 0.5);

    sendAbs(nx, ny);
    paintGyroCursor(nx, ny);
  }

  function startGyroListening() {
    if (gyroListening) return;
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
    gyroListening = true;
  }

  function stopGyroListening() {
    if (!gyroListening) return;
    window.removeEventListener('deviceorientation', onDeviceOrientation, true);
    gyroListening = false;
  }

  function setGyroPanelVisible(visible) {
    if (!gyroPanel) return;
    gyroPanel.classList.toggle('hidden', !visible);
    gyroPanel.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function updateModeChrome() {
    const isGyro = pointerMode === 'gyro';
    document.body.classList.toggle('is-gyro', isGyro);
    if (modeLabel) modeLabel.textContent = isGyro ? 'Gyro' : 'Trackpad';
    if (modeTrackpadBtn) {
      modeTrackpadBtn.classList.toggle('is-active', !isGyro);
      modeTrackpadBtn.setAttribute('aria-pressed', String(!isGyro));
    }
    if (modeGyroBtn) {
      modeGyroBtn.classList.toggle('is-active', isGyro);
      modeGyroBtn.setAttribute('aria-pressed', String(isGyro));
    }
    setGyroPanelVisible(isGyro && gyroActive);
    if (hintTitle && hintSub && padHint && !padHint.classList.contains('is-hidden')) {
      const copy = isGyro ? GYRO_HINT : TRACKPAD_HINT;
      hintTitle.textContent = copy.title;
      hintSub.textContent = copy.sub;
    }
  }

  async function enableGyro() {
    if (!sensorsSupported()) {
      ui.showToast?.('This browser has no orientation sensors', 'err', 3200);
      return false;
    }
    try {
      await requestOrientationPermission();
    } catch (err) {
      ui.showToast?.(err.message || 'Sensor permission failed', 'warn', 4200);
      return false;
    }

    calBeta = NaN;
    calGamma = NaN;
    lastOrient = null;
    gyroActive = true;
    gyroPaused = false;
    startGyroListening();
    setGyroPanelVisible(true);
    if (padHint) padHint.classList.remove('is-hidden');
    if (hintTitle && hintSub) {
      hintTitle.textContent = GYRO_HINT.title;
      hintSub.textContent = GYRO_HINT.sub;
    }
    ui.showToast?.('Gyro on — point to aim', 'ok');
    ui.haptic?.(18, 'strong');
    return true;
  }

  function disableGyro() {
    gyroActive = false;
    stopGyroListening();
    setGyroPanelVisible(false);
    clearTouch();
    if (isDragging) endDrag();
    if (gyroDragBtn) {
      gyroDragBtn.classList.remove('is-active');
      gyroDragBtn.setAttribute('aria-pressed', 'false');
    }
  }

  async function setPointerMode(mode) {
    if (mode === pointerMode) {
      if (mode === 'gyro' && !gyroActive) await enableGyro();
      return;
    }

    if (mode === 'gyro') {
      clearLongPress();
      if (isDragging) endDrag();
      mouseDown = false;
      const ok = await enableGyro();
      if (!ok) {
        updateModeChrome();
        return;
      }
      pointerMode = 'gyro';
    } else {
      disableGyro();
      pointerMode = 'trackpad';
      if (hintTitle && hintSub) {
        hintTitle.textContent = TRACKPAD_HINT.title;
        hintSub.textContent = TRACKPAD_HINT.sub;
      }
      if (padHint) padHint.classList.remove('is-hidden');
    }
    updateModeChrome();
  }

  modeTrackpadBtn?.addEventListener('click', () => {
    ui.unlockAudio?.();
    setPointerMode('trackpad');
  });
  modeGyroBtn?.addEventListener('click', () => {
    ui.unlockAudio?.();
    setPointerMode('gyro');
  });

  gyroLeftBtn?.addEventListener('click', () => {
    sendBinary(2, 0, 0, 1, 1);
    ui.haptic?.(12);
  });
  gyroRightBtn?.addEventListener('click', () => {
    sendBinary(2, 0, 0, 2, 1);
    ui.haptic?.(12);
  });
  gyroRecenterBtn?.addEventListener('click', () => {
    recenterGyro(lastOrient);
  });
  gyroDragBtn?.addEventListener('click', () => {
    if (isDragging) {
      endDrag();
      gyroDragBtn.classList.remove('is-active');
      gyroDragBtn.setAttribute('aria-pressed', 'false');
      ui.showToast?.('Drag off', 'ok');
    } else {
      beginDrag();
      gyroDragBtn.classList.add('is-active');
      gyroDragBtn.setAttribute('aria-pressed', 'true');
      ui.showToast?.('Drag on', 'ok');
    }
  });
  gyroSensInput?.addEventListener('input', () => {
    const v = parseFloat(gyroSensInput.value);
    if (Number.isFinite(v)) gyroSensitivity = v;
  });
  if (gyroSensInput) {
    gyroSensitivity = parseFloat(gyroSensInput.value) || 1.4;
  }

  updateModeChrome();
})();
