#!/usr/bin/env node
// "What's this?" — tiny zero-dependency server.
// Serves the web app and proxies frames to a local Ollama vision model.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT   = process.env.PORT   || 8080;
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL  = process.env.MODEL  || 'gemma3:4b';
const WEB    = path.join(__dirname, '..', 'web');

// Two prompts: a fuller answer when the child asks, a one-liner when we narrate.
// Seeing and speaking are two different jobs. Asking one small model to do both at
// once made it worse at both - it called a cat a grasshopper while trying to be
// charming. So stage 1 only looks, and stage 2 only talks.

const SEE = `Look at this and answer in one short line, plainly and factually.
Name the single main thing. If you are not certain of the exact kind, give the general
kind instead - say "a flower", not a specific species you are unsure of.
Then add 2 or 3 plain words about what it looks like.
No excitement, no fun facts, no story. Just what is there.`;

const SAY = {
  ask: `You are Pip, a warm, playful little creature who is best friends with a child aged 4 to 7.

Pip has just looked at what the child pointed at, and this is exactly what is there:
"%s"

Tell the child about it in Pip's voice:
- Begin with ONE short happy word - Ooh, Wow, Hey, Look, Oh - and never more than one.
  Do not wrap it in quotation marks.
- Say what it is in your own warm words, using ONLY what is described above. Never add
  objects that are not mentioned, and never read the description back word for word.
- Then one simple, true, everyday thing about it - what it is for, what it feels like,
  what it does. If you are not sure something is true, say something simpler instead.
- Warm and playful. Short sentences. Three at most.
- Never mention photos, pictures, cameras, or say "I see".`,

  ambient: `You are Pip, a warm little creature quietly pointing things out to a child aged 4 to 7.

Pip has just looked around, and this is exactly what is there:
"%s"

Say ONE short cheerful sentence about it, in words a 5 year old knows.
Use ONLY what is described above - never add things that are not mentioned.
Never mention photos, pictures, cameras, or say "I see".`
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png'
};

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function ollama(body) {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ model: MODEL, stream: false, think: false,
                                         keep_alive: '2h' }, body))
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  return ((await res.json()).response || '').trim();
}

async function describe(image, mode) {
  // stage 1 - look, and only look
  const seen = await ollama({
    prompt: SEE, images: [image],
    options: { temperature: 0.2, num_predict: 40 }
  });
  if (!seen) throw new Error('nothing seen');

  // stage 2 - say it the way a small child wants to hear it
  const said = await ollama({
    prompt: (SAY[mode] || SAY.ask).replace('%s', seen),
    options: { temperature: 0.8, num_predict: mode === 'ambient' ? 45 : 90 }
  });
  return { text: said || seen, seen };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, model: MODEL, ollama: OLLAMA }));
  }

  if (url.pathname === '/api/describe' && req.method === 'POST') {
    const started = Date.now();
    try {
      const { image, mode } = JSON.parse(await readBody(req));
      if (!image) throw new Error('no image');
      const { text, seen } = await describe(image, mode);
      console.log(`[${mode}] ${Date.now() - started}ms  saw="${seen}"  ->  ${text.slice(0, 60)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text, seen, ms: Date.now() - started }));
    } catch (err) {
      console.error('describe failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // static files
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
});

// A 1x1 pixel is enough to make Ollama page the model into VRAM before
// the first real question arrives.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
async function warm(attempt = 1) {
  try {
    const t = Date.now();
    await describe(PIXEL, 'ambient');
    console.log(`model warm in ${Date.now() - t}ms`);
  } catch (err) {
    // On a reboot we usually start before Ollama's container is up, so keep
    // trying rather than leaving the first real question to pay a cold load.
    console.error(`warm-up attempt ${attempt} failed: ${err.message}`);
    if (attempt < 60) setTimeout(() => warm(attempt + 1), 30000);
    else console.error('giving up on warm-up; Ollama never came up');
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`what's this? → http://0.0.0.0:${PORT}  (model: ${MODEL}, ollama: ${OLLAMA})`);
  warm();
});
