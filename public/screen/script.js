const SCREEN_BASE = '/screen';

function screenPath(path) {
  return `${SCREEN_BASE}${path}`;
}

// ====== PHRASES ======
const fiveMinMessages = [
  "¡Quedan 5 minutos!, ¡A terminar fuerte!",
  "¡Últimos 5 minutos!, ¡Vamos con todo!",
  "¡Los ultimos 5 minutos!, ¡Vamos con el último empujón, ya casi!",
  "¡Cinco minutos más!, ¡Mantené el ritmo!",
  "¡Los cinco minutos finales!, ¡Concentrado y fuerte!"
];

// Updated: 10-minute remaining messages
const tenMinMessages = [
  "¡Ya quedan diez minutos!,  ¡A terminar fuerte!",
  "¡Los últimos diez minutos!,  ¡Vamos con todo!",
  "¡Los últimos diez minutos!,  ¡Vamos con el último empujón, ya casi!"
];

const sessionEndMessages = [
  "¡Sesión completada!,  ¡Buen trabajo!.",
  "¡Entrenamiento terminado!,  ¡Excelente esfuerzo!."
];

const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];

// ====== TIMER ======
let blocks = [
  { name: "BLOCK A", duration: 18 * 60, color: "#00f2ff" },
  { name: "-- PAUSE --", duration: 15, color: "transparent", isPause: true },
  { name: "BLOCK B", duration: 15 * 60, color: "#ff00f2" },
  { name: "-- PAUSE --", duration: 15, color: "transparent", isPause: true },
  { name: "PW", duration: 7 * 60, color: "#f2ff00" }
];

let currentBlock = 0;
let totalSeconds = 0;
let remaining = 0;
let timeout;
let timerStarted = false;
let clockInterval;
let startConsumed = false;

let fiveMinCalled = false;
let sessionCongratsCalled = false;

// HOURLY FLAGS
let last50Hour = null;
let last55Hour = null;
let last10Hour = null;

function playBeep() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const oscillatorFallback = () => {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880; // A5
      gain.gain.value = 0.2;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      setTimeout(() => { osc.stop(); }, 250);
    } catch (err) {
      console.error('Oscillator fallback failed:', err);
    }
  };

  fetch(screenPath("/beep.mp3"))
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
    .then(ab => ctx.decodeAudioData(ab))
    .then(buf => {
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      // Tamer beep level to avoid harshness at higher system volume
      gain.gain.value = 1.2;
      src.buffer = buf;
      src.connect(gain).connect(ctx.destination);
      src.start(0);
    })
    .catch(e => {
      console.error("Beep playback error:", e);
      oscillatorFallback();
    });
}

function setMode(mode) {
  document.body.classList.remove('timer-mode', 'clock-mode');
  document.body.classList.add(`${mode}-mode`);
}

function showRealTime() {
  const now = new Date();
  const hrs = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('timer').textContent = `${hrs}:${mins}`;

  const dayLabels = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"];
  const day = now.getDay();
  const label = dayLabels[day === 0 ? 6 : day - 1];

  const blockEl = document.getElementById('block-name');
  blockEl.textContent = label;
  blockEl.classList.add('f-day');

  setMode("clock");
}

function startClock() {
  showRealTime();
  clockInterval = setInterval(showRealTime, 1000);
}

function stopClock() {
  clearInterval(clockInterval);
}

function resetVisuals() {
  document.querySelector('.progress').style.width = "0%";
}

function startNextBlock() {
  clearTimeout(timeout);

  if (currentBlock >= blocks.length) {
    document.getElementById('timer').textContent = "//";
    document.getElementById('block-name').textContent = "";

    if (!sessionCongratsCalled) {
      sessionCongratsCalled = true;
      fetch(screenPath('/volume/ramp/50?duration=1200&from=88'));
      setTimeout(() => speakMessage(pickRandom(sessionEndMessages)), 200);
    }

    setTimeout(() => {
      timerStarted = false;
      currentBlock = 0;
      resetVisuals();
      setMode("clock");
      startClock();
    }, 2000);
    return;
  }

  const block = blocks[currentBlock];
  totalSeconds = block.duration;
  remaining = totalSeconds;

  fiveMinCalled = false;
  playBeep();
  setMode("timer");

  document.getElementById('block-name').textContent = block.name;
  const progress = document.querySelector('.progress');
  progress.style.background = block.color || "transparent";
  progress.style.width = "0%";

  updateScreen();
}

function updateScreen() {
  const block = blocks[currentBlock];

  if (!block.isPause && remaining === 10 * 60 && !fiveMinCalled) {
    fiveMinCalled = true;
    speakMessage(pickRandom(tenMinMessages));
  }

  if (block.isPause) {
    document.getElementById('timer').textContent = "--:--";
  } else {
    const mins = String(Math.floor(remaining / 60)).padStart(2, '0');
    const secs = String(remaining % 60).padStart(2, '0');
    document.getElementById('timer').textContent = `${mins}:${secs}`;
    const elapsed = totalSeconds - remaining;
    const percent = (elapsed / totalSeconds) * 100;
    document.querySelector('.progress').style.width = `${percent}%`;
  }

  if (remaining > 0) {
    remaining--;
    timeout = setTimeout(updateScreen, 1000);
  } else {
    currentBlock++;
    startNextBlock();
  }
}

async function checkForStartSignal() {
  if (startConsumed || timerStarted) return;

  try {
    const res = await fetch(screenPath('/start.txt'));
    const text = await res.text();
    if (text.trim() === 'START') {
      startConsumed = true;
      sessionCongratsCalled = false;
      timerStarted = true;
      stopClock();
      startNextBlock();
    }
  } catch (err) {
    console.error("Error leyendo start.txt:", err);
  }
}

function checkHourlyVolumeCues() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const s = now.getSeconds();

  // :50:00 → volumen 50, mensaje 5 min, volumen 88
  if (m === 45 && s === 0 && last50Hour !== h) {
    last50Hour = h;
    fetch(screenPath('/volume/ramp/50?duration=1500&from=88'));
    setTimeout(() => {
      speakMessage(pickRandom(tenMinMessages));
    }, 500);
    setTimeout(() => {
      fetch(screenPath('/volume/ramp/88?duration=1500'));
    }, 6000);
  }

  // :55:58 → volumen 50, mensaje de cierre, NO subir volumen
  if (m === 55 && s >= 0 && last55Hour !== h) {
    last55Hour = h;
    fetch(screenPath('/volume/ramp/50?duration=1500&from=88'));
    setTimeout(() => {
      speakMessage(pickRandom(sessionEndMessages));
    }, 500);
  }

  // :08:00 → volumen 88
  if (m === 8 && s === 0 && last10Hour !== h) {
    fetch(screenPath('/volume/ramp/88?duration=1600'));
    last10Hour = h;
  }
}


// ====== STARTUP ======
startClock();
setInterval(checkForStartSignal, 1000);
setInterval(checkHourlyVolumeCues, 500);

// ====== TTS via server proxy (override) ======
// Voice-only gain/processing (does not change system volume)
// Slightly higher default voice gain with safety processing
let VOICE_GAIN = parseFloat(localStorage.getItem('voiceGain') || '1.3');
// Clamp any previously stored excessive value
VOICE_GAIN = Math.max(0.1, Math.min(3, isFinite(VOICE_GAIN) ? VOICE_GAIN : 1.3));
let _voiceCtx, _voiceCompressor, _voiceLimiter, _voiceGain, _voicePreHP, _voicePresence, _voiceAirLP, _voiceSoftClip, _voiceChainWired;

function _makeSoftClipCurve(amount = 0.6) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1; // -1..1
    curve[i] = Math.tanh(x * (1 + amount * 2));
  }
  return curve;
}

function ensureVoiceChain() {
  if (!_voiceCtx) {
    _voiceCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Radio-ish EQ: HPF -> presence boost -> LPF (softer)
  if (!_voicePreHP) {
    const f = _voiceCtx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 120; // cut low rumble
    f.Q.value = 0.7;
    _voicePreHP = f;
  }
  if (!_voicePresence) {
    const f = _voiceCtx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = 2500; // presence
    f.Q.value = 0.8;
    f.gain.value = 0.8; // gentler ~+0.8 dB
    _voicePresence = f;
  }
  if (!_voiceAirLP) {
    const f = _voiceCtx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 8000; // keep clarity while avoiding harsh sibilance
    f.Q.value = 0.7;
    _voiceAirLP = f;
  }
  if (!_voiceCompressor) {
    const c = _voiceCtx.createDynamicsCompressor();
    // Gentle leveling for clarity without over-loudness
    c.threshold.value = -24;
    c.knee.value = 28;
    c.ratio.value = 2.2;
    c.attack.value = 0.01;
    c.release.value = 0.25;
    _voiceCompressor = c;
  }
  if (!_voiceGain) {
    _voiceGain = _voiceCtx.createGain();
  }
  if (!_voiceSoftClip) {
    const ws = _voiceCtx.createWaveShaper();
    ws.curve = _makeSoftClipCurve(0.35); // gentler soft clip before limiter
    try { ws.oversample = '2x'; } catch {}
    _voiceSoftClip = ws;
  }
  if (!_voiceLimiter) {
    // Final safety limiter to catch peaks without audible pumping
    const l = _voiceCtx.createDynamicsCompressor();
    l.threshold.value = -3; // more headroom
    l.knee.value = 0;
    l.ratio.value = 18;
    l.attack.value = 0.005;
    l.release.value = 0.12;
    _voiceLimiter = l;
  }
  // Chain (without source): HP -> Presence -> LP -> Comp -> Gain -> SoftClip -> Limiter -> Dest
  if (!_voiceChainWired) {
    _voicePreHP
      .connect(_voicePresence)
      .connect(_voiceAirLP)
      .connect(_voiceCompressor)
      .connect(_voiceGain)
      .connect(_voiceSoftClip)
      .connect(_voiceLimiter)
      .connect(_voiceCtx.destination);
    _voiceChainWired = true;
  }
  _voiceGain.gain.value = VOICE_GAIN;
  return _voiceCtx;
}
async function speakMessageServer(text) {
  try {
    const res = await fetch(screenPath('/tts'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`TTS ${res.status}: ${errText}`);
    }

    const blob = await res.blob();
    const arrayBuf = await blob.arrayBuffer();
    const ctx = ensureVoiceChain();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    const buffer = await ctx.decodeAudioData(arrayBuf);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Feed source into EQ chain head
    source.connect(_voicePreHP);
    source.start(0);
  } catch (e) {
    console.error('ElevenLabs TTS error:', e);
  }
}

// ====== One-time audio unlock (user gesture) ======
let _audioUnlocked = false;
async function unlockAudioOnce() {
  if (_audioUnlocked) return;
  try {
    const ctx = ensureVoiceChain();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    // Warm-up: brief near-silent oscillator so future plays are allowed
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    osc.frequency.value = 440;
    osc.connect(g).connect(ctx.destination);
    osc.start();
    setTimeout(() => { try { osc.stop(); } catch {} }, 60);
    _audioUnlocked = true;
    // Remove all unlock listeners after success
    ['pointerdown','keydown','touchstart'].forEach(evt => {
      window.removeEventListener(evt, unlockAudioOnce);
    });
    console.log('Audio unlocked');
  } catch (e) {
    console.warn('Audio unlock failed:', e);
  }
}
['pointerdown','keydown','touchstart'].forEach(evt => {
  window.addEventListener(evt, unlockAudioOnce, { once: true });
});

// Helper with timeout for server calls
async function _fetchWithTimeout(input, init = {}, timeoutMs = 7000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

// Server-backed TTS only. Secrets stay on the server.
async function speakMessage(text) {
  try {
    const res = await _fetchWithTimeout(screenPath('/tts'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    }, 7000);
    if (!res.ok) throw new Error(`TTS ${res.status}`);
    const blob = await res.blob();
    const arrayBuf = await blob.arrayBuffer();
    const ctx = ensureVoiceChain();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    const buffer = await ctx.decodeAudioData(arrayBuf);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(_voicePreHP);
    source.start(0);
  } catch (e) {
    console.error('Server /tts failed:', e);
  }
}

// Enable Audio overlay hookup
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('audio-overlay');
  const enableBtn = document.getElementById('enable-audio-btn');
  if (enableBtn) {
    enableBtn.addEventListener('click', async () => {
      await unlockAudioOnce();
      if (overlay) overlay.style.display = 'none';
    });
  }
  // If audio already running, hide overlay
  try {
    const ctx = ensureVoiceChain();
    if (ctx && ctx.state === 'running' && overlay) overlay.style.display = 'none';
  } catch {}
});

// Try to resume audio context after tab visibility changes or page show
function tryResumeAudio() {
  try {
    if (_audioUnlocked) {
      if (_voiceCtx && _voiceCtx.state === 'closed') {
        _voiceCtx = null; // recreate
      }
      const ctx = ensureVoiceChain();
      if (ctx.state !== 'running') {
        ctx.resume().catch(() => {});
      }
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') tryResumeAudio();
});
window.addEventListener('pageshow', tryResumeAudio);

// Quick helper to tweak and persist voice gain at runtime
function setVoiceGain(val) {
  const v = Math.max(0.1, Math.min(3, Number(val) || 1.0));
  VOICE_GAIN = v;
  try { if (_voiceGain) _voiceGain.gain.value = v; } catch {}
  try { localStorage.setItem('voiceGain', String(v)); } catch {}
  console.log('VOICE_GAIN set to', v);
}
// Expose in console for quick testing: setVoiceGain(1.6)
window.setVoiceGain = setVoiceGain;
