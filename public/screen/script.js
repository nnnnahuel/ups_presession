const SCREEN_BASE = '/screen';

function screenPath(path) {
  return `${SCREEN_BASE}${path}`;
}

// ====== MENSAJES ======
const tenMinMessages = [
  "¡Ya quedan diez minutos!, ¡A terminar fuerte!",
  "¡Los últimos diez minutos!, ¡Vamos con todo!",
  "¡Últimos diez minutos!, ¡Último empujón!"
];

const sessionEndMessages = [
  "¡Sesión completada!, ¡Buen trabajo!",
  "¡Entrenamiento terminado!, ¡Excelente esfuerzo!"
];

const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];

// ====== CLOCK MODE ======
let clockInterval;

// flags
let last45Hour = null;
let last55Hour = null;
let last08Hour = null;

function showRealTime() {
  const now = new Date();

  const hrs = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  const secs = String(now.getSeconds()).padStart(2, '0');

  document.getElementById('timer').textContent = `${hrs}:${mins}`;

  // Flash sutil cada minuto
  if (secs === "00") {
    document.body.classList.add('flash');
    setTimeout(() => {
      document.body.classList.remove('flash');
    }, 120);
  }
}

function startClock() {
  showRealTime();
  clockInterval = setInterval(showRealTime, 1000);
}

// ====== AUDIO ======
let _voiceCtx, _voiceGain;

function ensureAudio() {
  if (!_voiceCtx) {
    _voiceCtx = new (window.AudioContext || window.webkitAudioContext)();
    _voiceGain = _voiceCtx.createGain();
    _voiceGain.gain.value = 1.3;
    _voiceGain.connect(_voiceCtx.destination);
  }
  return _voiceCtx;
}

async function speakMessage(text) {
  try {
    const res = await fetch(screenPath('/tts'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });

    const blob = await res.blob();
    const arrayBuf = await blob.arrayBuffer();

    const ctx = ensureAudio();
    const buffer = await ctx.decodeAudioData(arrayBuf);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(_voiceGain);
    src.start(0);

  } catch (e) {
    console.error("TTS error:", e);
  }
}

// ====== HOURLY LOGIC ======
function checkHourlyEvents() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const s = now.getSeconds();

  // 45:00 → aviso 10 min
  if (m === 45 && s === 0 && last45Hour !== h) {
    last45Hour = h;

    fetch(screenPath('/volume/ramp/50?duration=1200&from=88'));
    setTimeout(() => {
      speakMessage(pickRandom(tenMinMessages));
    }, 400);

    setTimeout(() => {
      fetch(screenPath('/volume/ramp/88?duration=1200'));
    }, 6000);
  }

  // 55:00 → cierre
  if (m === 55 && s === 0 && last55Hour !== h) {
    last55Hour = h;

    fetch(screenPath('/volume/ramp/50?duration=1200&from=88'));
    setTimeout(() => {
      speakMessage(pickRandom(sessionEndMessages));
    }, 400);
  }

  // 08:00 → volumen normal
  if (m === 8 && s === 0 && last08Hour !== h) {
    last08Hour = h;
    fetch(screenPath('/volume/ramp/88?duration=1200'));
  }
}

// ====== INIT ======
startClock();
setInterval(checkHourlyEvents, 500);