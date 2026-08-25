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

The camera frame goes to a vision model running on **erhulk's own GPU** via Ollama.
No image ever leaves the tailnet, and there is no per-picture cost. Speech is the
phone's built-in voice (Web Speech API).

```
phone (PWA) ──https──> erhulk:8080 (node) ──> ollama :11434 ──> gemma3:12b
                                    │
                       phone's own TTS voice reads the reply
```

## Running it

On erhulk:

```bash
cd ~/whats_this
MODEL=gemma3:12b PORT=8080 node server/server.js
```

The server warms the model on boot and holds it in VRAM for 2 hours
(`keep_alive`). Without that, the first question after an idle period takes ~17s
instead of ~0.6s.

### HTTPS without root

Chrome only grants camera access over HTTPS. `sudo tailscale serve` would be the
obvious way to get a cert, but `tailscaled` gates both `serve` and `cert` behind
root/operator, and we have no sudo on erhulk.

The way around it: run a **second `tailscaled` in userspace mode, owned by `ubuntu`**.
You own that daemon, so `serve` needs no root — and in userspace-networking mode
binding :443 is not a privileged OS bind either. It joins the tailnet as its own
node, `whats-this`, with its own Let's Encrypt cert.

```bash
/home/ubuntu/whats_this/start.sh     # starts app server + userspace tailscaled + serve
```

`start.sh` is idempotent and wired to `@reboot` in the `ubuntu` crontab, so the
whole thing comes back after a restart with no root involved.

**Live at `https://whats-this.tail4c7473.ts.net`** (tailnet only).

On the child's phone: install Tailscale, sign in to the tailnet, open that URL in
Chrome, then **⋮ → Add to Home screen**.

## Measured latency (RTX 5090, 768px frames)

| model | per frame | note |
|---|---|---|
| gemma4:e2b | 0.19s | fastest, slightly plainer wording |
| gemma4:e4b | 0.26s | |
| **gemma3:12b** | **0.44s** | current default — warmest tone |
| gemma4:26b | 0.29s | |
| mistral-small3.2:24b | 0.40s | |

Change with the `MODEL` env var; all six are already pulled on erhulk.

## Tuning

In `web/app.js`:

- `AMBIENT_MS` (5000) — gap between automatic looks
- `DIFF_THRESH` (9) — how much the scene must change before it speaks again
- `MAX_HISTORY` (60) — entries kept in My Book

The wording for each mode lives in `PROMPTS` in `server/server.js`.

To swap the phone voice for a cloud voice later, replace the body of `speak()` in
`web/app.js`. Nothing else calls the speech API.
