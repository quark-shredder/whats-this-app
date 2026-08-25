/* "What's this?" — a camera the world talks back to. */

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), tiny = $('tiny');
const bubble = $('bubble'), bubbleText = $('bubbleText');
const shutter = $('shutter'), pauseBtn = $('pause'), livedot = $('livedot');
const thinking = $('thinking'), critter = $('critter'), thinkingText = $('thinkingText');

const AMBIENT_MS  = 5000;   // gap between automatic looks
const DIFF_THRESH = 9;      // 0-255; below this the scene counts as "unchanged"
const MAX_HISTORY = 60;

let mode = 'ask';           // 'ask' | 'ambient'
let stream = null, busy = false, ambientOn = false, wakeLock = null;
let lastFrame = null;       // 16x16 grayscale of the last frame we described

/* ── voice ─────────────────────────────────────────────────
   Everything speaks through here. To swap in a cloud or
   self-hosted voice later, replace the body of speak() and
   nothing else in the app changes. */
const VOICE_LANG = 'en-IN';   // Indian English; falls back to any English voice
const VOICE_RATE = 0.8;       // slower than default — a 4-7 year old needs the gaps
const VOICE_PITCH = 1.1;

let voice = null;
function pickVoice() {
  const all = speechSynthesis.getVoices();
  // Prefer an Indian English voice, then any English one.
  const indian  = all.filter(v => v.lang.replace('_', '-') === VOICE_LANG);
  const english = all.filter(v => v.lang.startsWith('en'));
  const pool = indian.length ? indian : english;
  voice = pool.find(v => /female|neural|natural/i.test(v.name))
       || pool.find(v => /google/i.test(v.name)) || pool[0] || null;
  if (voice) console.log('voice:', voice.name, voice.lang);
}
speechSynthesis.onvoiceschanged = pickVoice; pickVoice();

function speak(text) {
  return new Promise(resolve => {
    if (!text || !('speechSynthesis' in window)) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = VOICE_RATE; u.pitch = VOICE_PITCH;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

/* ── the wait ───────────────────────────────────────────────
   Three seconds is a long time for a small child staring at a
   frozen button, so we give them a friend to watch instead. */
const CRITTERS = ['1f419', '1f996', '1f47e', '1f929', '1f440', '1f42c'];
const THINKING_WORDS = [
  'Let me look…', 'Ooh, what is it?', 'Thinking…',
  'Looking closely…', 'Almost got it…', 'Hmm, interesting…'
];
let thinkTimer = null;

// A soft two-note chime, synthesised so there is no audio file to ship.
let audioCtx = null;
function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    [880, 1320].forEach((freq, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      const t0 = audioCtx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.22, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + 0.4);
    });
  } catch (_) { /* audio is a bonus, never a blocker */ }
}

function startThinking() {
  const pick = a => a[Math.floor(Math.random() * a.length)];
  critter.src = `anim/${pick(CRITTERS)}.webp`;
  thinkingText.textContent = pick(THINKING_WORDS);
  thinking.hidden = false;
  clearInterval(thinkTimer);
  thinkTimer = setInterval(() => { thinkingText.textContent = pick(THINKING_WORDS); }, 1600);
}

function stopThinking() {
  clearInterval(thinkTimer); thinkTimer = null;
  thinking.hidden = true;
}

/* ── camera ─────────────────────────────────────────────── */
async function startCamera() {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
}
function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; video.srcObject = null;
}

// Draw the current frame, longest side capped at `max`, return a JPEG data URL.
function grab(max, quality) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return null;
  const s = Math.min(1, max / Math.max(w, h));
  canvas.width = Math.round(w * s); canvas.height = Math.round(h * s);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

// Cheap "has anything changed?" check so ambient mode doesn't
// narrate the same blank wall over and over.
function sceneChanged() {
  const ctx = tiny.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 16, 16);
  const px = ctx.getImageData(0, 0, 16, 16).data;
  const now = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const p = i * 4;
    now[i] = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) | 0;
  }
  if (!lastFrame) { lastFrame = now; return true; }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += Math.abs(now[i] - lastFrame[i]);
  const changed = sum / 256 > DIFF_THRESH;
  if (changed) lastFrame = now;
  return changed;
}

/* ── the model call ─────────────────────────────────────── */
async function describe(imageDataUrl, m) {
  const res = await fetch('/api/describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageDataUrl.split(',')[1], mode: m })
  });
  if (!res.ok) throw new Error('describe failed');
  return (await res.json()).text;
}

function show(text) {
  bubbleText.textContent = text;
  bubble.hidden = false;
}

/* ── ask mode: one tap, one answer ──────────────────────── */
async function ask() {
  if (busy) return;
  busy = true; shutter.disabled = true;
  bubble.hidden = true;
  chime();                 // instant feedback on the tap itself
  startThinking();
  try {
    const full = grab(768, 0.7);
    if (!full) throw new Error('no frame');
    const text = await describe(full, 'ask');
    stopThinking();
    show(text);
    save(grab(180, 0.5), text);
    await speak(text);
  } catch (err) {
    stopThinking();
    const oops = "Hmm, I couldn't see that. Let's try again!";
    show(oops); await speak(oops);
  } finally {
    stopThinking();
    busy = false; shutter.disabled = false;
  }
}

/* ── ambient mode: it keeps talking on its own ──────────── */
async function ambientLoop() {
  while (ambientOn) {
    if (sceneChanged()) {
      try {
        const full = grab(768, 0.65);
        if (full) {
          const text = await describe(full, 'ambient');
          if (!ambientOn) break;
          show(text);
          save(grab(180, 0.5), text);
          await speak(text);          // next look waits until this finishes
        }
      } catch (_) { /* a dropped frame is not worth telling a child about */ }
    }
    await new Promise(r => setTimeout(r, AMBIENT_MS));
  }
}

async function startAmbient() {
  ambientOn = true; lastFrame = null;
  livedot.hidden = false; pauseBtn.hidden = false; shutter.hidden = true;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  ambientLoop();
}
function stopAmbient() {
  ambientOn = false;
  speechSynthesis.cancel();
  livedot.hidden = true; pauseBtn.hidden = true; shutter.hidden = false;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

/* ── history ────────────────────────────────────────────── */
function load() { try { return JSON.parse(localStorage.getItem('whatsthis') || '[]'); } catch { return []; } }

function save(thumb, text) {
  if (!thumb) return;
  const items = load();
  items.unshift({ thumb, text, at: Date.now() });
  while (items.length > MAX_HISTORY) items.pop();
  try { localStorage.setItem('whatsthis', JSON.stringify(items)); }
  catch { // quota hit — halve it and retry once
    try { localStorage.setItem('whatsthis', JSON.stringify(items.slice(0, MAX_HISTORY / 2))); } catch {}
  }
}

function renderBook() {
  const items = load(), grid = $('grid');
  grid.innerHTML = '';
  $('empty').hidden = items.length > 0;
  for (const it of items) {
    const card = document.createElement('button');
    card.className = 'card';
    const img = document.createElement('img'); img.src = it.thumb; img.alt = '';
    const p = document.createElement('p'); p.textContent = it.text;
    card.append(img, p);
    card.onclick = () => speak(it.text);
    grid.append(card);
  }
}

/* ── navigation ─────────────────────────────────────────── */
async function go(to) {
  stopAmbient();
  stopThinking();
  speechSynthesis.cancel();
  bubble.hidden = true;

  const screen = (to === 'ask' || to === 'ambient') ? 'camera' : to;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === screen));

  if (screen === 'camera') {
    mode = to;
    try { await startCamera(); }
    catch { show("I can't open the camera. Ask a grown-up to help!"); return; }
    if (to === 'ambient') startAmbient();
  } else {
    stopCamera();
    if (to === 'book') renderBook();
  }
}

document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
shutter.onclick  = ask;
pauseBtn.onclick = () => { ambientOn ? stopAmbient() : startAmbient(); };
$('replay').onclick = () => speak(bubbleText.textContent);

// Pause everything when the app goes to the background.
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopAmbient(); speechSynthesis.cancel(); } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
