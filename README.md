# Pixel Fencing

A retro pixel-art fencing game that runs in the browser. No build step, no
dependencies — a canvas, one script, and a JSON roster.

Play it at **[fencing.pixelrugby.com](https://fencing.pixelrugby.com)**.

## The bout

Fencing is not a sword fight, it's an argument about who started it. The game
models that directly.

| Action | Keys | Touch |
|---|---|---|
| Move along the piste | `←` `→` | hold left / right |
| Attack | `↑` or `Space` | tap |
| Feint | `↑` twice, quickly | tap twice |
| Block | `↓` | swipe down |
| Riposte | `↑` right after a block | tap after a block |
| Quit | `Esc` | QUIT button |

It resolves as a triangle rather than a single button:

- **Block beats attack.** A clean parry throws the attacker into a long
  recovery and opens a **riposte** window — a fast counter that keeps priority.
  Blocking and then not riposting wastes it.
- **Feint beats block.** A second attack press early in the extension takes the
  blade around an expected parry. It costs more stamina and whiffs badly if
  they were never blocking.
- **Distance beats everything**, if you read it. A lunge carries the body
  forward, so stepping in and out of measure is the real game.

Every action spends **stamina**. Run dry and your actions slow down and your
reach falls short, so backing off to breathe is a genuine choice. Retreating
off the rear limit of the piste concedes a touch, as it does in the sport.

## Weapons

Three, and they play differently rather than just looking different:

- **Foil** — right of way, torso target. The classic.
- **Epee** — *no* right of way and the whole body is target. Hit first, or hit
  together and you **both** score. Longest reach, slowest. Trading is real.
- **Sabre** — right of way, fastest tempo, shortest reach. Blink and it's gone.

## Modes

- **Tournament** — a 16-fencer single-elimination draw, saved between sessions.
- **Quick Bout** — straight into a bout with your favourite fencer.
- **Choose & Fence** — pick fencer and weapon first.
- **2 Players** — local hot seat. P1 on `WASD`, P2 on the arrow keys.
- **Roster** — all 16 fencers and their styles.
- **Records** — career stats: wins, streaks, touches, parries, ripostes,
  feints, per-weapon and per-country splits, titles.

## The roster

Sixteen nations, each with a **fencing style** that changes how the AI plays
them — `pressure`, `counter`, `classical`, `deceptive`, `explosive` — layered
over the difficulty setting. A counter-attacker and a pressure fencer at the
same difficulty are genuinely different opponents.

## Running it

There is nothing to build. Serve the directory:

```sh
npx http-server -p 8123 -c-1
```

then open <http://127.0.0.1:8123>. Append `?debug=true` for debug output.

## Layout

| File | What's in it |
|---|---|
| `index.html` | Canvas, font face, service-worker registration |
| `game.js` | The whole game in one IIFE — audio, sprites, combat, AI, screens |
| `fencers.json` | Roster: colours, skin tones, strength, region, style, flags |
| `service-worker.js` | Offline cache (bump `CACHE_NAME` when shipping) |
| `scripts/generate-icons.js` | Regenerates the favicon and touch icon |

`game.js` is sectioned with `// ── Name ──` headers, in roughly this order:
constants and palette, audio engine, canvas and resize, state enum, persistence
(difficulty, favourite, weapon, career stats), bout rules and weapons, camera,
AI, fencer state, modals, FX, tournament model, combat, sprites, bout
rendering, per-screen draws, input, main loop.

Two things are worth knowing before changing the rendering:

- **The camera is the single source of scale.** `camPxPerM` drives both the
  piste and the sprite size, so a fencer is always `FENCER_H_M` tall in world
  terms.
- **The blade is pinned to the simulation.** `drawFencer` takes an
  `opts.reachPx`, so the drawn point and the hit test always agree. Don't draw
  a blade length independently of `reachOf()`.
