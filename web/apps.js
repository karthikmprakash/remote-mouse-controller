(() => {
  const ui = window.RemoteUI || {};

  ui.wireModal?.({
    infoBtn: document.getElementById('info-btn'),
    infoModal: document.getElementById('info-modal'),
    closeModal: document.getElementById('close-modal'),
  });

  function setStatus(text, status = 'yellow') {
    ui.setConnectionStatus?.(text, status);
  }

  function flashTile(btn, kind) {
    btn.classList.remove('is-loading', 'is-success', 'is-error');
    btn.classList.add(kind === 'ok' ? 'is-success' : 'is-error');
    setTimeout(() => {
      btn.classList.remove('is-success', 'is-error');
    }, 700);
  }

  async function sendCommand(payload, btn) {
    if (btn) {
      btn.classList.add('is-loading', 'is-pressed');
    }
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {
        throw new Error(res.ok ? 'Invalid server response' : `HTTP ${res.status}`);
      }
      if (!res.ok || data.status !== 'ok') {
        throw new Error(data.error || data.message || 'Command failed');
      }
      const msg = data.message && data.message !== 'ok' ? data.message : 'Done';
      ui.showToast?.(msg, 'ok');
      ui.haptic?.(14);
      if (btn) flashTile(btn, 'ok');
      setStatus('Connected', 'green');
    } catch (e) {
      ui.showToast?.(e.message || 'Command failed', 'err', 2800);
      ui.haptic?.([20, 40, 20]);
      if (btn) flashTile(btn, 'err');
      // Network failures mean we're disconnected; command errors do not.
      if (e instanceof TypeError) {
        setStatus('Disconnected', 'red');
      }
    } finally {
      if (btn) btn.classList.remove('is-loading', 'is-pressed');
    }
  }

  function checkConnection() {
    fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ping' }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.status === 'ok') {
          setStatus('Connected', 'green');
        } else {
          setStatus('Disconnected', 'red');
        }
      })
      .catch(() => {
        setStatus('Disconnected', 'red');
      });
  }

  setStatus('Connecting…', 'yellow');
  checkConnection();
  setInterval(checkConnection, 5000);

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.tile');
    if (!btn || btn.disabled) return;
    const type = btn.dataset.type;
    ui.haptic?.(8);

    if (type === 'launch') {
      sendCommand({ type: 'launch', app: btn.dataset.app }, btn);
    } else if (type === 'control') {
      sendCommand({ type: 'control', action: btn.dataset.action }, btn);
    } else if (type === 'open_url') {
      sendCommand({ type: 'open_url', url: btn.dataset.url }, btn);
    }
  });
})();
