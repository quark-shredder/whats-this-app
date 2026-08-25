/* "What's this?" — a camera the world talks back to. */

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), tiny = $('tiny');
const bubble = $('bubble'), bubbleText = $('bubbleText');
const shutter = $('shutter'), pauseBtn = $('pause'), livedot = $('livedot');
const pip = $('pip'), buddyFace = $('buddyFace');
const aim = $('aim'), flyer = $('flyer');
const photo = $('photo'), shot = $('shot'), bar = $('bar');
const cameraScreen = $('camera');

const CROP        = 0.65;   // fraction of the frame Pip actually looks at
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
const VOICE_LANG = 'en-IN';   // preferred; falls back to any English voice

// The grown-up's choices, remembered on this device. The phone's voice list is
// nothing like the laptop's, so this has to be set on the phone itself.
const prefs = Object.assign(
  { voiceName: null, rate: 0.8, pitch: 1.1 },
  JSON.parse(localStorage.getItem('whatsthis-voice') || '{}')
);
const savePrefs = () => localStorage.setItem('whatsthis-voice', JSON.stringify(prefs));

let voice = null;
function englishVoices() {
  return speechSynthesis.getVoices()
    .filter(v => v.lang.toLowerCase().startsWith('en'))
    .sort((a, b) => (b.lang.replace('_','-') === VOICE_LANG) - (a.lang.replace('_','-') === VOICE_LANG)
                 || a.name.localeCompare(b.name));
}

function pickVoice() {
  const all = speechSynthesis.getVoices();
  if (prefs.voiceName) {
    voice = all.find(v => v.name === prefs.voiceName) || null;
    if (voice) return;
  }
  const pool = englishVoices();
  const indian = pool.filter(v => v.lang.replace('_', '-') === VOICE_LANG);
  const from = indian.length ? indian : pool;
  voice = from.find(v => /female|neural|natural/i.test(v.name))
       || from.find(v => /google/i.test(v.name)) || from[0] || null;
}
speechSynthesis.onvoiceschanged = pickVoice; pickVoice();

// Speaks `text`. If `onWord` is given it is called with the character offset of
// each word as that word is spoken, so the caption can follow along.
function speak(text, onWord) {
  return new Promise(resolve => {
    if (!text || !('speechSynthesis' in window)) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = prefs.rate; u.pitch = prefs.pitch;

    let fallback = null;
    if (onWord) {
      u.onboundary = e => { if (e.name === 'word') onWord(e.charIndex); };
      // Some Android voices never fire boundary events. If none arrive shortly
      // after speech starts, step through the words on a timer instead.
      u.onstart = () => {
        let fired = false;
        const seen = u.onboundary;
        u.onboundary = e => { fired = true; seen(e); };
        setTimeout(() => {
          if (fired) return;
          const offsets = [];
          const re = /\S+/g; let m;
          while ((m = re.exec(text))) offsets.push(m.index);
          const per = (text.length / 14) / prefs.rate * 1000 / Math.max(offsets.length, 1);
          let i = 0;
          fallback = setInterval(() => {
            if (i >= offsets.length) return clearInterval(fallback);
            onWord(offsets[i++]);
          }, per);
        }, 350);
      };
    }
    const done = () => { clearInterval(fallback); resolve(); };
    u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  });
}

/* ── Pip roams ──────────────────────────────────────────────
   He drifts around the live area, but is kept out of the caption, the photo
   stack and the aim brackets, so he never covers what the child is reading
   or pointing at. */
let roamTimer = null;

function roam() {
  const screenRect = cameraScreen.getBoundingClientRect();
  const hud = document.querySelector('.hud').getBoundingClientRect();
  const keepOut = [
    aim.getBoundingClientRect(),                       // never sit on what they're aiming at
    document.querySelector('.back').getBoundingClientRect(),
    hud                                                // never over the caption or button
  ];
  const size = 48, pad = 12;
  const minX = screenRect.left + pad, maxX = screenRect.right - size - pad;
  const minY = screenRect.top + pad,  maxY = hud.top - size - pad;
  if (maxX <= minX || maxY <= minY) return;

  const clashes = (x, y) => keepOut.some(r =>
    x + size + pad > r.left && x - pad < r.right &&
    y + size + pad > r.top  && y - pad < r.bottom);

  // Try a few random spots; if the screen is too crowded to find a clear one,
  // leave him where he is rather than dropping him on the caption.
  for (let i = 0; i < 24; i++) {
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    if (clashes(x, y)) continue;
    pip.style.transform =
      `translate(${Math.round(x - screenRect.left)}px, ${Math.round(y - screenRect.top)}px)`;
    return;
  }
}

function startRoaming() { roam(); clearInterval(roamTimer); roamTimer = setInterval(roam, 2100); }
function stopRoaming() { clearInterval(roamTimer); roamTimer = null; }

/* ── the wait ───────────────────────────────────────────────
   Three seconds is a long time for a small child staring at a
   frozen button, so we give them a friend to watch instead. */
// Pip's faces, from Kenney's CC0 set. Each one is a mood.
const FACES = { think: 'face_h', curious: 'face_e', happy: 'face_l', oops: 'face_i' };
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

const pick = a => a[Math.floor(Math.random() * a.length)];

function setFace(mood) { buddyFace.src = `char/${FACES[mood]}.png`; }

function startThinking() {
  setFace('think');
  pip.hidden = false;
  startRoaming();

  // A moving bar reads as progress; a word alone reads as a stuck app.
  bar.hidden = false;
  bubble.hidden = false;
  $('replay').hidden = true;
  shutter.hidden = true;               // nothing to hammer while Pip is looking

  clearInterval(thinkTimer);
  thinkTimer = setInterval(() => setFace(Math.random() < 0.5 ? 'think' : 'curious'), 1500);
}

function stopThinking() {
  clearInterval(thinkTimer); thinkTimer = null;
  bar.hidden = true;
  shutter.hidden = false;
}

// Pip cheers when the answer lands, then settles back to roaming.
function celebrate() {
  clearInterval(thinkTimer); thinkTimer = null;
  bar.hidden = true;
  setFace('happy');
  setTimeout(() => setFace('curious'), 1200);
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

// Draw the current frame, longest side capped at `max`, as a JPEG data URL.
// `crop` keeps only the middle of the frame. Measured on cluttered scenes, this
// is what fixes "Image collage. Various textures" - telling the model to look at
// the middle barely helped, actually cropping to it took 1/4 correct to 4/4.
function grab(max, quality, crop = 1) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return null;
  const side = Math.min(w, h) * crop;
  const sx = (w - side) / 2, sy = (h - side) / 2;
  const out = Math.min(max, Math.round(side));
  canvas.width = canvas.height = out;
  canvas.getContext('2d').drawImage(video, sx, sy, side, side, 0, 0, out, out);
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

/* ── the snapshot flight ────────────────────────────────────
   The shot must not cover the camera, or the child cannot aim at the next
   thing. So it starts over the aim brackets and flies down onto the stack. */
function flyToStack(dataUrl) {
  const from = aim.getBoundingClientRect();
  photo.hidden = false;
  const to = photo.getBoundingClientRect();

  flyer.src = dataUrl;
  Object.assign(flyer.style, {
    left: from.left + 'px', top: from.top + 'px',
    width: from.width + 'px', height: from.height + 'px',
    transition: 'none', transform: 'none', opacity: '1'
  });
  flyer.hidden = false;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    flyer.style.transition = 'transform .5s cubic-bezier(.4,.1,.3,1), opacity .5s ease-in';
    flyer.style.transform =
      `translate(${dx}px, ${dy}px) scale(${to.width / from.width}, ${to.height / from.height})`;
  }));

  setTimeout(() => { shot.src = dataUrl; flyer.hidden = true; flyer.removeAttribute('src'); }, 520);
}

function clearStack() {
  photo.hidden = true; shot.removeAttribute('src');
  flyer.hidden = true; flyer.removeAttribute('src');
}

/* ── the model call ─────────────────────────────────────── */
async function describe(imageDataUrl, m) {
  const t0 = performance.now();
  const body = JSON.stringify({ image: imageDataUrl.split(',')[1], mode: m });
  const kb = Math.round(body.length / 1024);

  // One retry: on a phone the connection drops often enough that a single
  // blip should not become "I couldn't see that".
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch('/api/describe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body, signal: ctrl.signal, keepalive: false
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      console.log(`[${m}] tap->caption ${Math.round(performance.now() - t0)}ms ` +
                  `(server ${data.ms}ms: see ${data.seeMs} say ${data.sayMs}) upload ${kb}KB` +
                  (attempt > 1 ? ` [retry ${attempt}]` : ''));
      return data.text;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      console.warn(`[${m}] attempt ${attempt} failed after ` +
                   `${Math.round(performance.now() - t0)}ms: ${err.message}`);
    }
  }
  throw lastErr;
}

// The caption is rendered one <span> per word so the spoken word can be lit up.
// wordAt maps a character offset back to its span.
let wordSpans = [], wordStarts = [];

function show(raw) {
  // The model likes blank lines. white-space:pre on each word span would render
  // them literally and blow holes in the caption, so flatten to single spaces.
  const text = String(raw).replace(/\s+/g, ' ').trim();
  bar.hidden = true;
  $('replay').hidden = false;
  bubbleText.scrollTop = 0;
  bubbleText.textContent = '';
  wordSpans = []; wordStarts = [];
  const re = /\S+\s*/g; let m;
  while ((m = re.exec(text))) {
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = m[0];
    bubbleText.append(span);
    wordSpans.push(span); wordStarts.push(m.index);
  }
  bubble.hidden = false;
}

function lightWord(charIndex) {
  let idx = 0;
  while (idx + 1 < wordStarts.length && wordStarts[idx + 1] <= charIndex) idx++;
  wordSpans.forEach((s, i) => s.classList.toggle('lit', i === idx));
  // The caption is only ~11% of the screen now, so long answers must scroll
  // themselves - always keeping the word being spoken in view.
  const el = wordSpans[idx];
  if (el && bubbleText.scrollHeight > bubbleText.clientHeight + 2) {
    const want = el.offsetTop - (bubbleText.clientHeight - el.offsetHeight) / 2;
    bubbleText.scrollTo({ top: Math.max(0, want), behavior: 'smooth' });
  }
}

function clearWords() { wordSpans.forEach(s => s.classList.remove('lit')); }

/* ── ask mode: one tap, one answer ──────────────────────── */
async function ask() {
  // Small children tap a big button many times. Extra taps are dropped, but
  // Pip wiggles so the tap still feels like it did something.
  if (busy) {
    pip.classList.remove('nudge');
    void pip.offsetWidth;             // restart the animation
    pip.classList.add('nudge');
    setTimeout(() => pip.classList.remove('nudge'), 450);
    return;
  }
  busy = true;
  cameraScreen.classList.remove('fresh');
  chime();                 // instant feedback on the tap itself
  startThinking();
  try {
    const full = grab(768, 0.7, CROP);
    if (!full) throw new Error('no frame');
    flyToStack(full);      // the shot lands on the stack, camera stays visible
    const text = await describe(full, 'ask');
    celebrate();
    show(text);
    // Ready for the next picture as soon as the answer is here - making a child
    // sit through the whole sentence before they can tap again is too long.
    busy = false; shutter.hidden = false;
    save(grab(180, 0.5, CROP), text);
    await speak(text, lightWord);
    clearWords();
  } catch (err) {
    clearInterval(thinkTimer); thinkTimer = null;
    bar.hidden = true;
    setFace('oops'); setTimeout(() => setFace('curious'), 1500);
    const oops = "Hmm, I couldn't see that. Let's try again!";
    show(oops); await speak(oops);
  } finally {
    busy = false;
    bar.hidden = true;
    shutter.hidden = false;
  }
}

/* ── ambient mode: it keeps talking on its own ──────────── */
async function ambientLoop() {
  while (ambientOn) {
    if (sceneChanged()) {
      try {
        const full = grab(768, 0.65, 1);
        if (full) {
          const text = await describe(full, 'ambient');
          if (!ambientOn) break;
          show(text);
          save(grab(180, 0.5, CROP), text);
          await speak(text, lightWord); // next look waits until this finishes
          clearWords();
        }
      } catch (_) { /* a dropped frame is not worth telling a child about */ }
    }
    await new Promise(r => setTimeout(r, AMBIENT_MS));
  }
}

async function startAmbient() {
  ambientOn = true; lastFrame = null;
  clearStack();            // ambient watches the world live, never frozen
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

/* ── voice settings ─────────────────────────────────────── */
const SAMPLE = "Ooh! It's a fluffy cat. Grey like a cloud!";

// The speech API does not report gender. Android's Google voices encode it in the
// voiceURI (en-in-x-ahp#female_1-local); elsewhere we fall back to known voice
// names. Anything we cannot place is shown as unknown rather than guessed.
const FEMALE_NAMES = /^(Samantha|Karen|Moira|Tessa|Fiona|Veena|Kathy|Princess|Victoria|Allison|Ava|Susan|Zoe|Nicky|Serena|Kate|Stephanie|Shelley|Sandy|Flo|Grandma|Superstar|Nora|Alva|Ellen|Anna|Carmit|Damayanti|Lekha|Paulina|Sara|Yuna|Amelie|Joana|Luciana|Milena|Monica|Mónica)\b/i;
const MALE_NAMES   = /^(Rishi|Daniel|Albert|Fred|Ralph|Alex|Tom|Aaron|Arthur|Gordon|Lee|Oliver|Rocko|Reed|Eddy|Grandpa|Junior|Jester|Bruce|Diego|Jorge|Juan|Maged|Thomas|Xander|Yuri|Nikos)\b/i;

function genderOf(v) {
  const uri = (v.voiceURI || '') + ' ' + v.name;
  if (/#\s*female|_female|\bfemale\b/i.test(uri)) return 'female';
  if (/#\s*male|_male|\bmale\b/i.test(uri))       return 'male';
  if (FEMALE_NAMES.test(v.name)) return 'female';
  if (MALE_NAMES.test(v.name))   return 'male';
  return null;
}

let genderFilter = 'all';

function renderVoices() {
  const list = $('voiceList'); list.innerHTML = '';
  let vs = englishVoices();
  if (!vs.length) { list.textContent = 'No voices found on this device.'; return; }

  const counts = { all: vs.length, female: 0, male: 0 };
  vs.forEach(v => { const g = genderOf(v); if (g) counts[g]++; });
  if (genderFilter !== 'all') vs = vs.filter(v => genderOf(v) === genderFilter);

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const g of ['all', 'female', 'male']) {
    const c = document.createElement('button');
    c.className = 'chip' + (genderFilter === g ? ' on' : '');
    c.textContent = `${g === 'all' ? 'All' : g === 'female' ? 'Female' : 'Male'} (${counts[g]})`;
    c.onclick = () => { genderFilter = g; renderVoices(); };
    chips.append(c);
  }
  list.append(chips);

  if (!vs.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No voices on this phone are labelled ' + genderFilter + '.';
    list.append(p); return;
  }

  for (const v of vs) {
    const g = genderOf(v);
    const b = document.createElement('button');
    b.className = 'vbtn' + (voice && v.name === voice.name ? ' sel' : '');
    b.innerHTML = `${v.name} <span class="gtag">${g === 'female' ? '♀' : g === 'male' ? '♂' : '?'}</span>` +
                  `<small>${v.lang}${v.localService ? '' : ' · needs network'}</small>`;
    b.onclick = () => {
      voice = v; prefs.voiceName = v.name; savePrefs();
      [...list.querySelectorAll('.vbtn')].forEach(c => c.classList.remove('sel'));
      b.classList.add('sel');
      speak(SAMPLE);
    };
    list.append(b);
  }
}

function bindSlider(id, key) {
  const el = $(id), out = $(id + 'Val');
  el.value = prefs[key];
  out.textContent = (+prefs[key]).toFixed(2);
  el.oninput = () => { out.textContent = (+el.value).toFixed(2); };
  el.onchange = () => { prefs[key] = +el.value; savePrefs(); speak(SAMPLE); };
}
bindSlider('rate', 'rate');
bindSlider('pitch', 'pitch');

/* ── navigation ─────────────────────────────────────────── */
// `push` is false when the move came from the browser's own back button,
// so we don't add another entry and trap the child in a loop.
async function go(to, push = true) {
  if (push) {
    // Home is the base entry; every other screen adds one, so Back returns
    // to the app's home screen instead of leaving the app entirely.
    if (to === 'home') history.replaceState({ screen: 'home' }, '');
    else history.pushState({ screen: to }, '');
  }
  stopAmbient();
  stopThinking();
  stopRoaming();
  clearStack();
  speechSynthesis.cancel();
  bubble.hidden = true;

  const screen = (to === 'ask' || to === 'ambient') ? 'camera' : to;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === screen));

  if (screen === 'camera') {
    mode = to;
    cameraScreen.classList.add('fresh');
    bubble.hidden = true; photo.hidden = true;
    pip.hidden = (to === 'ambient');
    if (to !== 'ambient') startRoaming();
    try { await startCamera(); }
    catch { show("I can't open the camera. Ask a grown-up to help!"); return; }
    if (to === 'ambient') startAmbient();
  } else {
    stopCamera();
    if (to === 'book') renderBook();
    if (to === 'voice') renderVoices();
  }
}

document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));

// Android's back button (and the browser's) moves within the app.
history.replaceState({ screen: 'home' }, '');
window.addEventListener('popstate', e => go((e.state && e.state.screen) || 'home', false));
shutter.onclick  = ask;
pauseBtn.onclick = () => { ambientOn ? stopAmbient() : startAmbient(); };
$('replay').onclick = () => speak(bubbleText.textContent, lightWord).then(clearWords);

// Pause everything when the app goes to the background.
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopAmbient(); speechSynthesis.cancel(); } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
