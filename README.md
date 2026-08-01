# Pixel Fencing

A retro pixel-art fencing game that runs in the browser. No build step, no
dependencies — a canvas, one script, and a JSON roster.

Play it at **[fencing.pixelrugby.com](https://fencing.pixelrugby.com)**.

## How it plays

You need to know one rule: **whoever attacks first owns the point.** If they
attacked first, your hit doesn't count — block instead, then hit them back.

That's it. You don't need to know anything about fencing; the game prints the
key to press on screen while you learn.

| Action | Keys | Touch |
|---|---|---|
| Move towards them | `→` | hold right |
| Back away | `←` | hold left |
| Attack | `↑` or `Space` | tap |
| Block | `↓` | swipe down |
| Fake (advanced) | `↑` twice, quickly | tap twice |
| Quit | `Esc` | QUIT button |

Underneath, it's a triangle:

- **Block beats attack.** A clean block throws the attacker into a long
  recovery and gives you a free shot — take it immediately or you lose it.
- **Fake beats block.** A second attack press early in the swing takes the
  blade around an expected block. It costs more and misses badly if they
  weren't blocking, so it's the last thing a new player needs.
- **Distance beats both**, if you read it. An attack carries you forward, so
  stepping in and out of range is the real game.

Every action spends **stamina** (the bar under your score). Run dry and you
slow down and fall short. Backing off the end of the strip concedes a point,
as it does in the sport.

## Bout length

Both numbers come from the sport:

- **First to 5** — every bout, in every mode. This is a real *pool* bout.
- **First to 15** — the tournament final only, with 9:00 on the clock. This is
  a real *direct elimination* bout, and it makes the last match of a run feel
  like the last match of a run.

Difficulty does not change the format. It used to, which meant the bout length
silently changed when you touched an unrelated setting.

## Difficulty

Starts on **Beginner**, where the opponent is a sparring partner: it rarely
blocks in time, attacks slowly, and never fakes. Normal and Hard expect you to
use all three verbs.

**Go Easy On Me** (Settings, on by default) quietly holds the opponent back
when it is more than one point ahead, so a bad start doesn't spiral.

## Swords

Three, and they play differently rather than just looking different. The
plain-language name is the headline; the sport's name is underneath.

- **Classic** (*foil*) — the standard. Whoever attacks first owns the point.
- **Simple** (*épée*) — no rules about who went first. Whoever lands, scores;
  land together and you both score. Longest reach.
- **Fast** (*sabre*) — same rules as Classic, roughly twice the speed, and you
  have to get closer.

## Modes

- **Play** — straight into a bout with your fencer and sword.
- **How to Play** — the rules, in about ten lines.
- **Tournament** — a 16-fencer single-elimination draw, saved between sessions.
  Rounds are first to 5; the final is first to 15.
- **2 Players** — local hot seat. P1 on `WASD`, P2 on the arrow keys.
- **My Fencer** — pick your fencer and sword.
- **Records** — career stats: wins, streaks, points, blocks, counter hits,
  fakes that worked, per-sword and per-country splits, titles.

## The roster

Sixteen nations, each with a **style** that changes how the AI plays them —
aggressive, defensive, balanced, tricky, sudden — layered over the difficulty
setting. A defensive and an aggressive fencer at the same difficulty are
genuinely different opponents.

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
