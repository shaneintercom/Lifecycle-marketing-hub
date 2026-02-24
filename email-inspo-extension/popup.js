const SUPABASE_URL = 'https://uasecpkhdkonpwomaeze.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhc2VjcGtoZGtvbnB3b21hZXplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MjkzMzMsImV4cCI6MjA4NzEwNTMzM30.jmCTT5ta7u3f8FIwlkYKQ1amLJ6Qn-MVxBv4S3ToQaw';
const BUCKET = 'Email Inspo';

let originalDataUrl   = null;  // source image (full screenshot or uploaded file)
let screenshotDataUrl = null;  // what actually gets saved
let selStart = null;
let selEnd   = null;

const img        = document.getElementById('screenshot-preview');
const cropCanvas = document.getElementById('crop-canvas');
const ctx        = cropCanvas.getContext('2d');

// ── Auto-capture on open ──────────────────────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab) return;

  try {
    document.getElementById('f-source').value =
      new URL(tab.url).hostname.replace(/^www\./, '');
  } catch (_) {}

  chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
    document.getElementById('screenshot-loading').style.display = 'none';
    if (chrome.runtime.lastError || !dataUrl) {
      showCaptureError('Could not auto-capture — drag and drop or upload a screenshot below.');
      return;
    }
    loadImage(dataUrl);
  });
});

function showCaptureError(msg) {
  document.getElementById('screenshot-loading').style.display = 'none';
  const el = document.getElementById('screenshot-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Load image into crop UI (used by both auto-capture and file upload) ───────
function loadImage(dataUrl) {
  originalDataUrl   = dataUrl;
  screenshotDataUrl = dataUrl;
  // Reset crop state
  selStart = null; selEnd = null;
  document.getElementById('crop-actions').style.visibility = 'hidden';
  document.getElementById('crop-hint').textContent = 'Drag to crop to just the email';
  img.src = dataUrl;
}

// Size canvas once image renders — uses device pixel ratio for sharp overlay
img.addEventListener('load', () => {
  const container = document.getElementById('crop-container');
  container.style.display = 'block';
  document.getElementById('screenshot-error').style.display = 'none';
  document.getElementById('screenshot-loading').style.display = 'none';

  requestAnimationFrame(() => {
    const dpr  = window.devicePixelRatio || 1;
    const cssW = container.clientWidth;
    const cssH = container.clientHeight;

    // Size canvas at device pixels for a sharp overlay on Retina screens
    cropCanvas.width  = cssW * dpr;
    cropCanvas.height = cssH * dpr;
    cropCanvas.style.width  = cssW + 'px';
    cropCanvas.style.height = cssH + 'px';
    ctx.scale(dpr, dpr);   // draw in CSS coords from here on
    ctx.clearRect(0, 0, cssW, cssH);

    document.getElementById('crop-bar').style.display = 'flex';
  });
});

// ── Crop drag interaction ─────────────────────────────────────────────────────
cropCanvas.addEventListener('mousedown', (e) => {
  const r    = cropCanvas.getBoundingClientRect();
  const cssW = r.width;
  const cssH = r.height;

  selStart = { x: e.clientX - r.left, y: e.clientY - r.top };
  selEnd   = { ...selStart };
  document.getElementById('crop-actions').style.visibility = 'hidden';
  ctx.clearRect(0, 0, cssW, cssH);

  const onMove = (e) => {
    const r = cropCanvas.getBoundingClientRect();
    selEnd = {
      x: Math.max(0, Math.min(r.width,  e.clientX - r.left)),
      y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
    };
    drawSelection(r.width, r.height);
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    const w = Math.abs(selEnd.x - selStart.x);
    const h = Math.abs(selEnd.y - selStart.y);
    if (w < 10 || h < 10) {
      selStart = null; selEnd = null;
      ctx.clearRect(0, 0, cssW, cssH);
      return;
    }
    drawSelection(cssW, cssH);
    document.getElementById('crop-actions').style.visibility = 'visible';
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
});

function drawSelection(cssW, cssH) {
  ctx.clearRect(0, 0, cssW, cssH);
  if (!selStart || !selEnd) return;

  const x = Math.min(selStart.x, selEnd.x);
  const y = Math.min(selStart.y, selEnd.y);
  const w = Math.abs(selEnd.x - selStart.x);
  const h = Math.abs(selEnd.y - selStart.y);

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.clearRect(x, y, w, h);

  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, w, h);

  // Corner handles
  const hs = 5;
  ctx.fillStyle = '#3b82f6';
  [[x, y], [x+w-hs, y], [x, y+h-hs], [x+w-hs, y+h-hs]].forEach(([hx, hy]) => {
    ctx.fillRect(hx, hy, hs, hs);
  });
}

// ── Apply crop ────────────────────────────────────────────────────────────────
document.getElementById('apply-btn').addEventListener('click', () => {
  if (!selStart || !selEnd || !originalDataUrl) return;

  const container = document.getElementById('crop-container');
  const cssW = container.clientWidth;

  const x = Math.min(selStart.x, selEnd.x);
  const y = Math.min(selStart.y, selEnd.y);
  const w = Math.abs(selEnd.x - selStart.x);
  const h = Math.abs(selEnd.y - selStart.y);

  const source = new Image();
  source.onload = () => {
    // Scale from CSS display pixels to original image pixels
    const scale = source.naturalWidth / cssW;

    const out = document.createElement('canvas');
    out.width  = Math.round(w * scale);
    out.height = Math.round(h * scale);
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(
      source,
      Math.round(x * scale), Math.round(y * scale), out.width, out.height,
      0, 0, out.width, out.height
    );

    screenshotDataUrl = out.toDataURL('image/png');

    // Update preview to cropped result
    img.src = screenshotDataUrl;
    selStart = null; selEnd = null;
    document.getElementById('crop-actions').style.visibility = 'hidden';
    document.getElementById('crop-hint').textContent = '✓ Cropped — drag to re-crop';
    setStatus('');
  };
  source.src = originalDataUrl;  // always crop from original for max quality
});

// ── Reset crop ────────────────────────────────────────────────────────────────
document.getElementById('reset-btn').addEventListener('click', () => {
  screenshotDataUrl = originalDataUrl;
  img.src = originalDataUrl;
  selStart = null; selEnd = null;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, cropCanvas.width / dpr, cropCanvas.height / dpr);
  document.getElementById('crop-actions').style.visibility = 'hidden';
  document.getElementById('crop-hint').textContent = 'Drag to crop to just the email';
  setStatus('');
});

// ── File upload (high quality path) ──────────────────────────────────────────
document.getElementById('upload-trigger').addEventListener('click', () => {
  document.getElementById('f-file').click();
});

document.getElementById('f-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  readFile(file);
  e.target.value = '';
});

function readFile(file) {
  if (!file.type.startsWith('image/')) { setStatus('Please select an image file.', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    loadImage(ev.target.result);
    setStatus('Screenshot loaded — drag to crop if needed.', 'info');
    setTimeout(() => setStatus(''), 2500);
  };
  reader.readAsDataURL(file);
}

// ── Drag & drop anywhere on the popup ────────────────────────────────────────
document.addEventListener('dragover',  (e) => { e.preventDefault(); document.body.classList.add('drag-over'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drag-over'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) readFile(file);
});

// ── Save ─────────────────────────────────────────────────────────────────────
function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type || '';
}

document.getElementById('save-btn').addEventListener('click', async () => {
  const source   = document.getElementById('f-source').value.trim();
  const type     = document.getElementById('f-type').value;
  const category = document.getElementById('f-category').value;
  const notes    = document.getElementById('f-notes').value.trim();

  if (!source)            { setStatus('Brand/source is required.', 'error'); return; }
  if (!screenshotDataUrl) { setStatus('No image — capture or upload a screenshot first.', 'error'); return; }

  const btn = document.getElementById('save-btn');
  btn.textContent = 'Saving…';
  btn.disabled = true;
  setStatus('');

  try {
    const blob     = await (await fetch(screenshotDataUrl)).blob();
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.png`;

    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(BUCKET)}/${filename}`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'image/png' },
        body: blob,
      }
    );
    if (!uploadRes.ok) {
      const e = await uploadRes.json().catch(() => ({}));
      throw new Error(e.message || `Upload failed (${uploadRes.status})`);
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;

    const insertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/lifecycle_swipe_file`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'apikey': SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          image_url:     publicUrl,
          campaign_name: source,
          type:          type     || null,
          category:      category || null,
          notes:         notes    || null,
        }),
      }
    );
    if (!insertRes.ok) {
      const e = await insertRes.json().catch(() => ({}));
      throw new Error(e.message || `Save failed (${insertRes.status})`);
    }

    setStatus('✓ Saved to Email Inspo!', 'success');
    btn.textContent = 'Saved ✓';
    setTimeout(() => {
      ['f-source','f-type','f-category','f-notes'].forEach(id => {
        document.getElementById(id).value = '';
      });
      btn.textContent = 'Save to Email Inspo';
      btn.disabled = false;
      setStatus('');
    }, 2000);

  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
    btn.textContent = 'Save to Email Inspo';
    btn.disabled = false;
  }
});
