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

## Seeing and speaking are two separate jobs

Asking one small model to identify an object *and* be charming *and* recall a fun
fact made it worse at all three - it called a cat a grasshopper while trying to be
playful, and told a child that tulips talk to each other through their roots.

So each request runs two passes over `gemma3:4b`:

1. **See** - a flat, factual prompt. No persona. "Name the single main thing. If you
   are not certain of the exact kind, give the general kind." Temperature 0.2.
2. **Say** - a text-only pass that turns that line into Pip's voice, and is told to
   use *only* what stage 1 reported.

Measured over the ten test images in `bench/images/`:

| prompt style | identified correctly | invented facts |
|---|---|---|
| persona doing everything | 7/10 | many |
| persona + hedging | ~5/10 | fewer |
| **see-only (stage 1)** | **9/10** | n/a |
| **two-stage (shipped)** | **9/10** | none seen |

The one it still misses is a playground slide, read as a staircase or ladder.

## Measured latency

`gemma3:4b`, two-stage, on an M3 Pro:

| | |
|---|---|
| first pass over 10 fresh images | 3.54s mean |
| warm repeat requests | 1.34s mean |

Image size does not matter - 768px and 256px measured the same, because the cost is
the vision encoder, not generation. Shorter output does not help either.

Models tried and rejected:

| model | why not |
|---|---|
| `qwen2.5vl:3b` | slower than gemma over a real image set (4.09s vs 2.92s), looser with facts |
| `qwen3-vl:4b` | a thinking model - reasoning eats the token budget, so replies come back empty unpredictably; 5.6s |
| `llama3.2-vision:11b` | 11B, would be slower still |
| Florence-2 | a captioner, not an instruct model - would need its own second stage |
| MLX runtime | ~3x slower than Ollama in our harness, and needs transformers pinned |

## Tuning

In `web/app.js`:

- `AMBIENT_MS` (5000) — gap between automatic looks
- `DIFF_THRESH` (9) — how much the scene must change before it speaks again
- `MAX_HISTORY` (60) — entries kept in My Book

The wording for each mode lives in `PROMPTS` in `server/server.js`.

To swap the phone voice for a cloud voice later, replace the body of `speak()` in
`web/app.js`. Nothing else calls the speech API.
