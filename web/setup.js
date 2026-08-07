(() => {
  const qrFrame = document.getElementById('qr-frame');
  const phoneUrlEl = document.getElementById('phone-url');
  const openPhone = document.getElementById('open-phone');
  const copyBtn = document.getElementById('copy-url');
  const accessBtn = document.getElementById('open-access');
  const accessPill = document.getElementById('access-pill');
  const accessText = document.getElementById('access-text');
  const toastHost = document.querySelector('.toast-host');

  function toast(message, tone = 'ok') {
    if (!toastHost) return;
    toastHost.innerHTML = '';
    const el = document.createElement('div');
    el.className = `toast is-${tone} is-visible`;
    el.innerHTML = `<span class="toast-dot" aria-hidden="true"></span><span>${message}</span>`;
    toastHost.appendChild(el);
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 280);
    }, 2200);
  }

  function setAccess(trusted) {
    if (!accessPill || !accessText) return;
    accessPill.classList.remove('is-ok', 'is-bad', 'is-unknown');
    if (trusted === true) {
      accessPill.classList.add('is-ok');
      accessText.textContent = 'Mouse control allowed';
    } else if (trusted === false) {
      accessPill.classList.add('is-bad');
      accessText.textContent = 'Accessibility permission needed';
    } else {
      accessPill.classList.add('is-unknown');
      accessText.textContent = 'Enable Accessibility if the cursor won’t move';
    }
  }

  async function loadPair() {
    const res = await fetch('/api/pair', { cache: 'no-store' });
    if (!res.ok) throw new Error('Could not load pairing info');
    return res.json();
  }

  async function loadQr(url) {
    const res = await fetch(`/api/qr.svg?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Could not build QR code');
    return res.text();
  }

  async function refresh() {
    const info = await loadPair();
    const phoneUrl = info.phone_url;
    phoneUrlEl.textContent = phoneUrl;
    openPhone.href = phoneUrl;
    setAccess(info.accessibility_trusted);

    const svg = await loadQr(phoneUrl);
    qrFrame.innerHTML = svg;
  }

  copyBtn?.addEventListener('click', async () => {
    const text = phoneUrlEl?.textContent?.trim();
    if (!text || text === 'Loading address…') return;
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied', 'ok');
    } catch (_) {
      toast('Could not copy — select the link instead', 'warn');
    }
  });

  accessBtn?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'control', action: 'open_accessibility' }),
      });
      const data = await res.json();
      if (data.status === 'ok') toast('Opened Accessibility settings', 'ok');
      else toast(data.error || 'Could not open settings', 'warn');
      setTimeout(refresh, 1200);
    } catch (_) {
      toast('Could not open settings', 'err');
    }
  });

  refresh().catch((err) => {
    phoneUrlEl.textContent = 'Setup server unavailable';
    toast(err.message || 'Setup failed', 'err');
  });

  setInterval(() => {
    loadPair()
      .then((info) => setAccess(info.accessibility_trusted))
      .catch(() => {});
  }, 4000);
})();
