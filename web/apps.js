(() => {
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const infoBtn = document.getElementById('info-btn');
  const infoModal = document.getElementById('info-modal');
  const closeModal = document.getElementById('close-modal');

  function setStatus(text, status = 'yellow') {
    statusText.textContent = text;
    statusIndicator.className = `status-${status}`;
  }

  async function sendCommand(payload) {
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'ok') {
        throw new Error(data.error || 'Command failed');
      }
      setStatus('OK: ' + (data.message || 'Done'), 'green');
      // Reset to connected status after 2 seconds
      setTimeout(() => setStatus('Connected', 'green'), 2000);
    } catch (e) {
      setStatus('Error: ' + e.message, 'red');
      // Reset to connected status after 3 seconds
      setTimeout(() => setStatus('Connected', 'green'), 3000);
    }
  }

  // Check connection status
  function checkConnection() {
    fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ping' }),
    }).then(() => {
      setStatus('Connected', 'green');
    }).catch(() => {
      setStatus('Disconnected', 'red');
    });
  }

  // Initial connection check
  setStatus('Connecting...', 'yellow');
  checkConnection();

  // Check connection every 5 seconds
  setInterval(checkConnection, 5000);

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.tile');
    if (!btn) return;
    const type = btn.dataset.type;

    if (type === 'launch') {
      const app = btn.dataset.app;
      sendCommand({ type: 'launch', app });
    } else if (type === 'control') {
      const action = btn.dataset.action;
      sendCommand({ type: 'control', action });
    } else if (type === 'open_url') {
      const url = btn.dataset.url;
      sendCommand({ type: 'open_url', url });
    }
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