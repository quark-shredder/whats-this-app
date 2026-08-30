/* "What's this?" — a camera the world talks back to. */

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), tiny = $('tiny');
const bubble = $('bubble'), bubbleText = $('bubbleText');
const shutter = $('shutter'), pauseBtn = $('pause'), livedot = $('livedot');
const pip = $('pip'), buddyFace = $('buddyFace');
const aim = $('aim'), flyer = $('flyer');
const photo = $('photo'), shot = $('shot'), bar = $('bar');
const cameraScreen = $('camera'), warming = $('warming');

// What Pip actually looks at: a rectangle around the middle, measured against
// the frame's short side. Taller than wide, which suits a phone held upright.
const CROP_W      = 0.68;   // measured: 71.5% pulls clutter back in and loses the subject
const CROP_H      = 0.74;
const AMBIENT_MS  = 5000;   // gap between automatic looks
const DIFF_THRESH = 9;      // 0-255; below this the scene counts as "unchanged"
const MAX_HISTORY = 60;

let mode = 'ask';           // 'ask' | 'ambient'
let stream = null, busy = false, ambientOn = false, wakeLock = null;
let lastFrame = null;       // 16x16 grayscale of the last frame we described

/* ── the log ────────────────────────────────────────────────
   The phone is usually nowhere near a console, so keep a short ring buffer
   of what happened and show it in settings. */
const LOG_MAX = 40;
function logLine(kind, msg) {
  const line = `${new Date().toLocaleTimeString()} ${kind} ${msg}`;
  console.log('[whatsthis]', line);
  try {
    const all = JSON.parse(localStorage.getItem('whatsthis-log') || '[]');
    all.unshift(line);
    localStorage.setItem('whatsthis-log', JSON.stringify(all.slice(0, LOG_MAX)));
  } catch (_) {}
}
window.addEventListener('error', e => logLine('ERR', e.message));
window.addEventListener('unhandledrejection', e => logLine('ERR', 'unhandled: ' + (e.reason && e.reason.message || e.reason)));

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
    const done = () => {
      clearInterval(fallback);
      if (onWord) onWord(text.length);   // land on the final word, never mid-sentence
      resolve();
    };
    u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  });
}

/* ── where Pip stands ───────────────────────────────────────
   Random drifting reads as noise. Pip is anchored to whatever is happening:
   he leans over the brackets while looking, sits beside the caption while
   reading it out, and waits by the button when there is nothing to do. */
let idleTimer = null;

function placePip(x, y) {
  const r = cameraScreen.getBoundingClientRect();
  const size = 48, pad = 10;
  x = Math.max(r.left + pad, Math.min(x, r.right - size - pad));
  y = Math.max(r.top + pad,  Math.min(y, r.bottom - size - pad));
  pip.style.transform = `translate(${Math.round(x - r.left)}px, ${Math.round(y - r.top)}px)`;
}

function pipTo(where) {
  const r = cameraScreen.getBoundingClientRect();
  const box = aim.getBoundingClientRect();
  const size = 48;

  if (where === 'looking') {
    // perched on the top edge of the brackets, peering in at the thing
    placePip(box.right - size * 1.6, box.top - size * 0.55);
  } else if (where === 'reading') {
    // tucked just above the left end of the caption, like a reader at the page
    const b = bubble.getBoundingClientRect();
    placePip(b.left + 6, b.top - size * 0.72);
  } else {
    // idle: hovering just above and right of the button, clear of the HUD
    const sh = shutter.getBoundingClientRect();
    placePip(sh.right + 16, sh.top - size - 10);
  }
}

// A small, slow sway while idle so he looks alive without wandering off.
function startIdleSway() {
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (busy || speechSynthesis.speaking) return;
    const sh = shutter.getBoundingClientRect();
    placePip(sh.right + 10 + Math.random() * 30, sh.top - 58 - Math.random() * 22);
  }, 3200);
}
function stopRoaming() { clearInterval(idleTimer); idleTimer = null; }
function startRoaming() { pipTo('idle'); startIdleSway(); }

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
  pipTo('looking');            // Pip leans in over the brackets

  // The previous answer must go: leaving it up while a new picture is being
  // looked at tells the child the old caption belongs to the new photo.
  bubbleText.textContent = '';
  wordSpans = []; wordStarts = [];
  bubbleText.scrollTop = 0;

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
  requestAnimationFrame(() => pipTo('reading'));   // come and read it out
  setTimeout(() => setFace('curious'), 1200);
}

/* ── camera ─────────────────────────────────────────────── */
// A child taps the tile several times while waiting, so overlapping calls must
// share one attempt rather than each asking the OS for the camera again.
let cameraPending = null;

async function startCamera() {
  if (stream && video.videoWidth) return;
  if (cameraPending) return cameraPending;

  cameraPending = (async () => {
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false
      });
      video.srcObject = stream;
    }
    await video.play();
    // play() resolves before there are pixels; wait for a real frame so we do
    // not hand the child a black screen and call it ready.
    if (!video.videoWidth) {
      await new Promise(res => {
        const done = () => { video.removeEventListener('loadeddata', done); res(); };
        video.addEventListener('loadeddata', done);
        setTimeout(done, 4000);
      });
    }
  })();

  try { await cameraPending; } finally { cameraPending = null; }
}
function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; video.srcObject = null;
}

// Draw the current frame, longest side capped at `max`, as a JPEG data URL.
// `crop` keeps only the middle of the frame. Measured on cluttered scenes, this
// is what fixes "Image collage. Various textures" - telling the model to look at
// the middle barely helped, actually cropping to it took 1/4 correct to 4/4.
function grab(max, quality, cropW = 1, cropH = cropW) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return null;
  const base = Math.min(w, h);
  const cw = Math.min(w, base * cropW), ch = Math.min(h, base * cropH);
  const sx = (w - cw) / 2, sy = (h - ch) / 2;
  const scale = Math.min(1, max / Math.max(cw, ch));
  const ow = Math.round(cw * scale), oh = Math.round(ch * scale);
  canvas.width = ow; canvas.height = oh;
  canvas.getContext('2d').drawImage(video, sx, sy, cw, ch, 0, 0, ow, oh);
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
  // blip should not become an error the child sees.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch('/api/describe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body, signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      logLine('OK', `${m} ${Math.round(performance.now() - t0)}ms ` +
                    `(see ${data.seeMs} say ${data.sayMs}) ${kb}KB` +
                    (attempt > 1 ? ` retry${attempt}` : ''));
      return data.text;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      logLine('FAIL', `${m} attempt${attempt} after ${Math.round(performance.now() - t0)}ms: ` +
                      `${err.name}: ${err.message}`);
    }
  }
  throw lastErr;
}

// Work out what actually went wrong, so the child sees the right thing and the
// grown-up gets a clue. A dead network and a sick model are different problems.
async function diagnose() {
  if (!navigator.onLine) return { kid: "I can't hear my helper right now!", why: 'phone is offline' };
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return { kid: "My helper is having a nap!", why: `health http ${res.status}` };
    const h = await res.json();
    return { kid: "Hmm, I couldn't see that. Let's try again!", why: `server ok (${h.model}), the look itself failed` };
  } catch (err) {
    return {
      kid: "I can't find my helper! Ask a grown-up.",
      why: `cannot reach the server (${err.name}) - is Tailscale on, and is the Mac awake?`
    };
  }
}

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
  // Hand back the normalised string. Speaking the raw text instead would drift:
  // the engine reports charIndex against what it was given, and every collapsed
  // run of whitespace would push the highlight further behind the voice.
  return text;
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
    const full = grab(768, 0.7, CROP_W, CROP_H);
    if (!full) throw new Error('no frame');
    flyToStack(full);      // the shot lands on the stack, camera stays visible
    const text = await describe(full, 'ask');
    celebrate();
    const spoken = show(text);
    // Ready for the next picture as soon as the answer is here - making a child
    // sit through the whole sentence before they can tap again is too long.
    busy = false; shutter.hidden = false;
    save(grab(180, 0.5, CROP_W, CROP_H), text);
    await speak(spoken, lightWord);
    clearWords();
    pipTo('idle'); startIdleSway();
  } catch (err) {
    clearInterval(thinkTimer); thinkTimer = null;
    bar.hidden = true;
    setFace('oops'); setTimeout(() => setFace('curious'), 1500);
    const d = await diagnose();
    logLine('DIAG', d.why);
    await speak(show(d.kid));
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
        const full = grab(768, 0.65, 1, 1);
        if (full) {
          const text = await describe(full, 'ambient');
          if (!ambientOn) break;
          const spoken = show(text);
          save(grab(180, 0.5, 1, 1), text);          // ambient saves the whole scene
          await speak(spoken, lightWord); // next look waits until this finishes
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

/* ── swipe the picture away ─────────────────────────────────
   Flick the photo sideways and it sails off, taking the caption with it and
   leaving a clean camera again. A whole-hand gesture is easier for a small
   child than finding a close button. */
function resetToFresh() {
  speechSynthesis.cancel();
  clearInterval(thinkTimer); thinkTimer = null;
  bar.hidden = true;
  bubble.hidden = true;
  bubbleText.textContent = '';
  wordSpans = []; wordStarts = [];
  clearStack();
  cameraScreen.classList.add('fresh');
  shutter.hidden = false;
  setFace('curious');
  pipTo('idle'); startIdleSway();
}

(function enableSwipe() {
  let startX = 0, startY = 0, dx = 0, dragging = false, decided = false;

  const finish = fling => {
    photo.style.transition = 'transform .32s ease-out, opacity .32s ease-out';
    if (fling) {
      const dir = dx < 0 ? -1 : 1;
      photo.style.transform = `translateX(${dir * window.innerWidth}px) rotate(${dir * 18}deg)`;
      photo.style.opacity = '0';
      setTimeout(() => {
        photo.style.transition = photo.style.transform = photo.style.opacity = '';
        resetToFresh();
      }, 320);
    } else {
      photo.style.transform = '';
      setTimeout(() => { photo.style.transition = ''; }, 320);
    }
  };

  photo.addEventListener('pointerdown', e => {
    if (photo.hidden) return;
    dragging = true; decided = false; dx = 0;
    startX = e.clientX; startY = e.clientY;
    photo.style.transition = 'none';
    photo.setPointerCapture(e.pointerId);
  });

  photo.addEventListener('pointermove', e => {
    if (!dragging) return;
    dx = e.clientX - startX;
    const dy = e.clientY - startY;
    // Let a vertical drag scroll the page rather than stealing it as a swipe.
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      if (Math.abs(dy) > Math.abs(dx)) { dragging = false; photo.style.transition = ''; return; }
    }
    photo.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
    photo.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 340));
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    finish(Math.abs(dx) > 90);           // a small flick is enough
  };
  photo.addEventListener('pointerup', end);
  photo.addEventListener('pointercancel', end);
})();

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

// Live connection check, so a grown-up can see at a glance whether the phone
// can actually reach the Mac.
async function checkConn() {
  const el = $('conn');
  if (!el) return;
  if (!navigator.onLine) {
    el.className = 'conn bad'; el.textContent = 'Phone has no network at all.'; return;
  }
  el.className = 'conn'; el.textContent = 'Checking…';
  const t = performance.now();
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
    const h = await res.json();
    el.className = 'conn ok';
    el.textContent = `Connected in ${Math.round(performance.now() - t)}ms · ${h.model}`;
  } catch (err) {
    el.className = 'conn bad';
    el.textContent = 'Cannot reach the helper. Is Tailscale on, and the Mac awake?';
  }
}

function renderLog() {
  const el = $('logView');
  if (!el) return;
  let all = [];
  try { all = JSON.parse(localStorage.getItem('whatsthis-log') || '[]'); } catch (_) {}
  el.textContent = all.length ? all.join('\n') : 'Nothing logged yet.';
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
$('clearLog').onclick = () => { localStorage.removeItem('whatsthis-log'); renderLog(); };
$('conn').onclick = checkConn;
addEventListener('online',  () => logLine('NET', 'back online'));
addEventListener('offline', () => logLine('NET', 'went offline'));

/* ── navigation ─────────────────────────────────────────── */
// `push` is false when the move came from the browser's own back button,
// so we don't add another entry and trap the child in a loop.
let navigating = false;

async function go(to, push = true) {
  // Repeat taps while a screen is opening should be absorbed, not queued up.
  if (navigating) return;
  navigating = true;
  try { await navigate(to, push); } finally { navigating = false; }
}

async function navigate(to, push) {
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
    pip.hidden = true;                    // Pip is in the warming panel meanwhile
    shutter.disabled = true;              // nothing to tap until there is a picture

    warming.hidden = !!video.videoWidth;  // already live? no need for the panel
    try {
      await startCamera();
      warming.hidden = true;
      shutter.disabled = false;
      pip.hidden = (to === 'ambient');
      if (to !== 'ambient') startRoaming();
      if (to === 'ambient') startAmbient();
    } catch (err) {
      warming.hidden = true;
      logLine('CAM', 'failed: ' + err.name + ': ' + err.message);
      show("I can't open my eyes. Ask a grown-up to help!");
    }
  } else {
    warming.hidden = true;
    stopCamera();
    if (to === 'book') renderBook();
    if (to === 'voice') { renderVoices(); renderLog(); checkConn(); }
  }
}

document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
photo.addEventListener('click', () => {
  if (bubbleText.textContent.trim()) speak(bubbleText.textContent, lightWord).then(clearWords);
});

// Android's back button (and the browser's) moves within the app.
history.replaceState({ screen: 'home' }, '');
window.addEventListener('popstate', e => go((e.state && e.state.screen) || 'home', false));
shutter.onclick  = ask;
pauseBtn.onclick = () => { ambientOn ? stopAmbient() : startAmbient(); };
$('replay').onclick = () => speak(bubbleText.textContent, lightWord).then(clearWords);

// Pause everything when the app goes to the background.
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopAmbient(); speechSynthesis.cancel(); } });

/* ── keeping itself up to date ───────────────────────────────
   Installed to the home screen there is no address bar and the body does not
   scroll, so there is no reload gesture at all. The app therefore checks for a
   new version itself and swaps to it when the child is not mid-sentence. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    const check = () => reg.update().catch(() => {});
    check();
    setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }).catch(() => {});

  // A new worker taking control means new files are live; reload to pick them
  // up, but never while Pip is mid-answer.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    const whenIdle = () => {
      if (busy || speechSynthesis.speaking) return setTimeout(whenIdle, 1000);
      location.reload();
    };
    whenIdle();
  });
}
