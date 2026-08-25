#!/usr/bin/env node
// "What's this?" — tiny zero-dependency server.
// Serves the web app and proxies frames to a local Ollama vision model.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT   = process.env.PORT   || 8080;
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL  = process.env.MODEL  || 'gemma3:12b';
const WEB    = path.join(__dirname, '..', 'web');

// Two prompts: a fuller answer when the child asks, a one-liner when we narrate.
const PROMPTS = {
  ask: `You are a warm, playful friend talking to a child aged 4 to 7 who just pointed a camera at something and asked "what's this?".

Reply with 2 or 3 very short sentences. Say what the main thing is, then one fun, true fact a small child would love.
Use simple words a 5 year old knows. Sound excited and kind.
Never mention photos, images, cameras or pictures. Never say "I see" or "this appears to be" — just talk about the thing itself.
If something is unsafe for a child (a knife, a stove, a road), gently say to be careful near it.`,

  ambient: `You are a warm, playful friend quietly describing the world to a child aged 4 to 7.

Reply with ONE short, cheerful sentence about the most interesting thing in front of them right now.
Use simple words a 5 year old knows.
Never mention photos, images, cameras or pictures. Never say "I see" — just name the thing.`
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

async function describe(image, mode) {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: PROMPTS[mode] || PROMPTS.ask,
      images: [image],
      stream: false,
      think: false,                       // ignored by non-thinking models
      keep_alive: '2h',                   // stay resident: a cold load costs ~17s
      options: {
        temperature: 0.7,
        num_predict: mode === 'ambient' ? 45 : 90
      }
    })
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.response || '').trim();
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
      const text = await describe(image, mode);
      console.log(`[${mode}] ${Date.now() - started}ms  ${text.slice(0, 70)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text, ms: Date.now() - started }));
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
async function warm() {
  try {
    const t = Date.now();
    await describe(PIXEL, 'ambient');
    console.log(`model warm in ${Date.now() - t}ms`);
  } catch (err) { console.error('warm-up failed:', err.message); }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`what's this? → http://0.0.0.0:${PORT}  (model: ${MODEL}, ollama: ${OLLAMA})`);
  warm();
});
