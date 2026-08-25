# What's this?

A camera a small child can point at the world to hear what it is.

Two modes:

- **🔍 What's this?** — the child taps the big button, and the thing in front of
  them is named and explained in two or three sentences, read aloud.
- **👀 Look Around** — no tapping. Every ~5 seconds it looks and says one cheerful
  sentence about whatever is in front of the camera. It stays quiet when the scene
  hasn't changed, so it doesn't narrate the same wall forever.

Everything the child sees and hears is saved to **📖 My Book** — a scrollable list
of thumbnails; tapping one says it again.

## How it works

Everything runs on one machine — the camera frame goes to a vision model in a
local Ollama, and the reply is spoken by the phone's own voice. No image ever
leaves the tailnet, and there is no per-picture cost.

```
phone (PWA) ──https──> Mac :8080 (node) ──> ollama :11435 ──> gemma3:4b
                                 │
                    phone's own TTS voice reads the reply
```

## Running it

```bash
./run-local.sh          # starts Ollama (Metal) and the app server
```

Serve it over HTTPS so Chrome will allow camera access (tailnet only, not public):

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 http://127.0.0.1:8080
```

On the child's phone: install Tailscale, sign in, open
`https://dev-ws-arjun.tail4c7473.ts.net`, then Chrome **⋮ → Add to Home screen**.

The server warms the model on boot and holds it for 2 hours (`keep_alive`), and
retries until Ollama answers — a cold load costs seconds you don't want a child
waiting through.

## Measured latency

Same 768px frame, warm model, `gemma3:4b`:

| host | per frame | note |
|---|---|---|
| MacBook M3 Pro (Metal) | **2.5-3.2s** | current dev machine; ~3.2 GB resident |
| RTX 5090 | 0.25s | ~10x faster; needs a dedicated always-on box |

Output length barely matters — dropping `num_predict` 40 -> 15 moved 2.60s to
2.53s. The cost is the vision encoder, not text generation, so smaller frames
are the lever if this needs to get faster.

Model footprints measured on the 5090:

| model | VRAM | latency |
|---|---|---|
| qwen2.5vl:3b | 5,768 MiB | 0.06s |
| **gemma3:4b** | **5,082 MiB** | **0.25s** |
| gemma3:12b | 11,544 MiB | 0.39s |

## Tuning

In `web/app.js`:

- `AMBIENT_MS` (5000) — gap between automatic looks
- `DIFF_THRESH` (9) — how much the scene must change before it speaks again
- `MAX_HISTORY` (60) — entries kept in My Book

The wording for each mode lives in `PROMPTS` in `server/server.js`.

To swap the phone voice for a cloud voice later, replace the body of `speak()` in
`web/app.js`. Nothing else calls the speech API.
