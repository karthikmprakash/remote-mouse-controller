(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let audioCtx = null;

  function unlockAudio() {
    // iOS only allows AudioContext after a user gesture
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playTick(kind = 'soft') {
    if (reduceMotion) return;
    try {
      const ctx = unlockAudio();
      if (!ctx) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = kind === 'strong' ? 220 : 160;
      const peak = kind === 'strong' ? 0.16 : 0.1;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'strong' ? 0.09 : 0.055));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
    } catch (_) {}
  }

  function haptic(ms = 10, kind = 'soft') {
    // iOS Safari has no Vibration API — use a short audio tick instead.
    const canVibrate = typeof navigator.vibrate === 'function';
    if (canVibrate) {
      try { navigator.vibrate(ms); } catch (_) {}
    }
    if (!canVibrate || kind === 'strong') {
      playTick(kind);
    }
  }

  function ensureToastHost() {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  let toastTimer = null;

  function showToast(message, tone = 'ok', duration = 2200) {
    const host = ensureToastHost();
    host.innerHTML = '';
    const el = document.createElement('div');
    el.className = `toast is-${tone}`;
    el.innerHTML = `<span class="toast-dot" aria-hidden="true"></span><span>${message}</span>`;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => {
        if (el.parentNode === host) host.removeChild(el);
      }, reduceMotion ? 0 : 280);
    }, duration);
  }

  function wireModal({ infoBtn, infoModal, closeModal }) {
    if (!infoBtn || !infoModal || !closeModal) return;

    const open = () => {
      infoModal.classList.remove('hidden');
      infoModal.setAttribute('aria-hidden', 'false');
      haptic(8);
    };

    const close = () => {
      infoModal.classList.add('hidden');
      infoModal.setAttribute('aria-hidden', 'true');
    };

    infoBtn.addEventListener('click', open);
    closeModal.addEventListener('click', close);
    infoModal.addEventListener('click', (e) => {
      if (e.target === infoModal) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !infoModal.classList.contains('hidden')) close();
    });
  }

  function setConnectionStatus(text, status = 'yellow') {
    const statusText = document.getElementById('status-text');
    const statusIndicator = document.getElementById('status-indicator');
    if (statusText) statusText.textContent = text;
    if (statusIndicator) statusIndicator.className = `status-${status}`;
  }

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  async function requestFullscreenExperience() {
    haptic(10);

    if (isStandalone()) {
      showToast('Already running fullscreen', 'ok');
      return;
    }

    // Android Chrome / desktop: native fullscreen API
    const root = document.documentElement;
    if (root.requestFullscreen || root.webkitRequestFullscreen) {
      try {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          if (document.exitFullscreen) await document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
          showToast('Exited fullscreen', 'ok');
          return;
        }
        if (root.requestFullscreen) await root.requestFullscreen();
        else root.webkitRequestFullscreen();
        showToast('Fullscreen on', 'ok');
        return;
      } catch (_) {
        // Fall through to install guidance
      }
    }

    if (isIos()) {
      showToast('iPhone: Share → Add to Home Screen', 'warn', 4200);
      return;
    }

    showToast('Use browser menu → Install / Add to Home screen', 'warn', 4200);
  }

  function wireFullscreenButton(btn = document.getElementById('fullscreen-btn')) {
    if (!btn) return;
    btn.addEventListener('click', () => {
      requestFullscreenExperience();
    });
  }

  // Hide install/fullscreen chrome noise when already installed
  if (isStandalone()) {
    document.documentElement.classList.add('is-standalone');
  }

  wireFullscreenButton();

  window.RemoteUI = {
    haptic,
    unlockAudio,
    playTick,
    showToast,
    wireModal,
    setConnectionStatus,
    reduceMotion,
    requestFullscreenExperience,
    isStandalone,
  };
})();
