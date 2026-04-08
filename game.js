(function() {
'use strict';

// ── Constants ──
var VIEW_W = 500, VIEW_H = 400, SAFE_X = 0;
var FONT = '"Press Start 2P", monospace';
var DEBUG = window.location.search.indexOf('debug=true') >= 0;
var _KP = 'pf_'; // localStorage key prefix

// Blue palette — fencing's "green pitch" equivalent
var COLOR_BG       = '#1e4e8e'; // main field/background blue (cobalt)
var COLOR_BG_DARK  = '#0e2a4a'; // bar / shadow blue (deep navy)
var COLOR_BG_LIGHT = '#3a78c8'; // accent / highlight blue (steel)
var COLOR_UI_BG    = '#2a5fa0'; // button fill
var COLOR_GOLD     = '#FFD700'; // primary highlight (medal gold)
var COLOR_WHITE    = '#ffffff';

var canvas, ctx, SCALE = 1, dirty = true;
var _isTouchDevice = false;

// Skin tone palette (matches pixelrugby's keys so JSON colors interop)
var SKIN_LIGHT = '#f5d0b0';
var SKIN_MED   = '#e8c89e';
var SKIN_TAN   = '#c8a07a';
var SKIN_BROWN = '#a0724e';
var SKIN_DARK  = '#6b4226';

// Fencer roster — loaded from /fencers.json
var FENCERS = [];
var FLAGS = {};
var _fencersLoaded = false;
function loadFencersData(callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/fencers.json', true);
    xhr.onload = function() {
        if (xhr.status === 200) {
            try {
                var data = JSON.parse(xhr.responseText);
                FENCERS = data.fencers || [];
                FLAGS = data.flags || {};
                _fencersLoaded = true;
            } catch(e) {}
        }
        if (callback) callback();
    };
    xhr.onerror = function() { if (callback) callback(); };
    xhr.send();
}

// drawFlag — render a small pixel flag for a country code at (fx, fy) with
// dimensions (fw, fh). Flag definitions live in fencers.json under `flags`.
// First entry is the background (no x/y/w/h means full rect); subsequent
// entries are colored stripes/blocks specified as fractional rects.
function drawFlag(fx, fy, fw, fh, code) {
    var flag = FLAGS[code];
    if (!flag || !flag.length) {
        ctx.fillStyle = '#888';
        ctx.fillRect(fx, fy, fw, fh);
    } else {
        ctx.fillStyle = flag[0].c;
        ctx.fillRect(fx, fy, fw, fh);
        for (var i = 0; i < flag.length; i++) {
            var s = flag[i];
            if (s.x === undefined && s.y === undefined && s.w === undefined && s.h === undefined && i === 0) continue;
            var sx = fx + (s.x || 0) * fw;
            var sy = fy + (s.y || 0) * fh;
            var sw = (s.w !== undefined ? s.w : 1) * fw;
            var sh = (s.h !== undefined ? s.h : 1) * fh;
            ctx.fillStyle = s.c;
            ctx.fillRect(Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh));
        }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
}

// ── Chiptune Audio (ported from pixelrugby) ──
var audioCtx = null;
var soundOn = false;
var sfxOn = true;
var musicOn = false;
var SOUND_KEY = _KP + 'soundSettings';

function saveSoundSettings() {
    try { localStorage.setItem(SOUND_KEY, JSON.stringify({ soundOn: soundOn, sfx: sfxOn, music: musicOn })); } catch(e) {}
}
function loadSoundSettings() {
    try {
        var raw = localStorage.getItem(SOUND_KEY);
        if (raw) {
            var s = JSON.parse(raw);
            soundOn = !!s.soundOn;
            sfxOn = !!s.sfx;
            musicOn = !!s.music;
        }
    } catch(e) {}
}

var currentTrack = null;
var trackTimeout = null;
var trackGain = null;

var NOTE = {
    C3:131, D3:147, Eb3:156, E3:165, F3:175, G3:196, Ab3:208, A3:220, Bb3:233, B3:247,
    C4:262, D4:294, Eb4:311, E4:330, F4:349, G4:392, Ab4:415, A4:440, Bb4:466, B4:494,
    C5:523, D5:587, Eb5:622, E5:659, F5:698, G5:784, A5:880,
    R:0
};

// Menu theme — elegant, anticipatory (D minor — classical/duel feel)
var menuMelody = [
    [NOTE.D4,180],[NOTE.A4,180],[NOTE.F4,180],[NOTE.A4,180],
    [NOTE.D5,360],[NOTE.C5,180],[NOTE.Bb4,180],
    [NOTE.A4,360],[NOTE.G4,180],[NOTE.F4,180],
    [NOTE.E4,540],
    [NOTE.R,120],
    [NOTE.D4,180],[NOTE.F4,180],[NOTE.A4,180],[NOTE.D5,180],
    [NOTE.E5,360],[NOTE.D5,180],[NOTE.C5,180],
    [NOTE.Bb4,180],[NOTE.A4,180],[NOTE.G4,180],[NOTE.F4,180],
    [NOTE.D4,540],
    [NOTE.R,240]
];

// Bout theme — tense, aggressive A minor with chromatic descents (sword duel feel)
var boutMelody = [
    [NOTE.A3,120],[NOTE.A3,120],[NOTE.E4,120],[NOTE.A4,120],
    [NOTE.B4,240],[NOTE.A4,120],[NOTE.G4,120],
    [NOTE.F4,120],[NOTE.E4,120],[NOTE.F4,120],[NOTE.E4,120],
    [NOTE.A4,360],
    [NOTE.R,80],
    [NOTE.A3,120],[NOTE.C4,120],[NOTE.E4,120],[NOTE.A4,120],
    [NOTE.C5,240],[NOTE.B4,120],[NOTE.A4,120],
    [NOTE.G4,120],[NOTE.F4,120],[NOTE.E4,120],[NOTE.D4,120],
    [NOTE.E4,360],
    [NOTE.R,80],
    // Bridge — chromatic climb
    [NOTE.E4,100],[NOTE.F4,100],[NOTE.G4,100],[NOTE.Ab4,100],
    [NOTE.A4,200],[NOTE.G4,100],[NOTE.F4,100],
    [NOTE.E4,100],[NOTE.D4,100],[NOTE.C4,100],[NOTE.B3,100],
    [NOTE.A3,300],
    [NOTE.R,100]
];

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        trackGain = audioCtx.createGain();
        trackGain.gain.value = 0.12;
        trackGain.connect(audioCtx.destination);
        audioCtx.onstatechange = function() {
            if (audioCtx.state === 'interrupted') {
                audioCtx.resume().then(function() {
                    if (musicOn && currentTrack && !trackTimeout) {
                        var t = currentTrack; currentTrack = null; setTrack(t);
                    }
                });
            }
        };
        document.addEventListener('visibilitychange', function() {
            if (!document.hidden && audioCtx && soundOn) {
                if (audioCtx.state !== 'running') {
                    try {
                        audioCtx.resume().then(function() {
                            if (musicOn && currentTrack) {
                                var t = currentTrack; currentTrack = null; setTrack(t);
                            }
                        });
                    } catch(e) {}
                } else if (musicOn && currentTrack && !trackTimeout) {
                    var t = currentTrack; currentTrack = null; setTrack(t);
                }
            }
        });
    }
    if (audioCtx.state !== 'running') { try { audioCtx.resume(); } catch(e) {} }
}

function playSfx(notes, wave, volume) {
    if (!audioCtx || !soundOn || !sfxOn) return;
    if (audioCtx.state !== 'running') { try { audioCtx.resume(); } catch(e) {} }
    var vol = volume || 0.15;
    var time = audioCtx.currentTime + 0.01;
    var t = 0;
    for (var i = 0; i < notes.length; i++) {
        var freq = notes[i][0], dur = notes[i][1] / 1000;
        if (freq > 0) {
            var osc = audioCtx.createOscillator();
            var env = audioCtx.createGain();
            osc.type = wave || 'square';
            osc.frequency.value = freq;
            env.gain.setValueAtTime(vol, time + t);
            env.gain.exponentialRampToValueAtTime(0.001, time + t + dur * 0.95);
            osc.connect(env);
            env.connect(audioCtx.destination);
            osc.start(time + t);
            osc.stop(time + t + dur);
        }
        t += dur;
    }
}

// Placeholder fencing SFX — short metallic clink for "select"
function sfxBlade() {
    playSfx([[NOTE.A5,40],[NOTE.E5,60]], 'triangle', 0.10);
}

// Victory fanfare — bright ascending arpeggio + held note
function sfxVictory() {
    playSfx([
        [NOTE.C5,100],[NOTE.E5,100],[NOTE.G5,100],[NOTE.C5,200],
        [NOTE.R,40],
        [NOTE.G5,100],[NOTE.C5,400]
    ], 'square', 0.16);
}

// Defeat stinger — descending minor
function sfxDefeat() {
    playSfx([
        [NOTE.A4,180],[NOTE.G4,180],[NOTE.F4,180],[NOTE.E4,400]
    ], 'square', 0.13);
}

function playMelody(melody, waveType) {
    stopTrack();
    if (!audioCtx || !soundOn || !musicOn) return;
    var time = audioCtx.currentTime + 0.05;
    var totalDuration = 0;
    for (var i = 0; i < melody.length; i++) {
        var freq = melody[i][0];
        var dur = melody[i][1] / 1000;
        if (freq > 0) {
            var osc = audioCtx.createOscillator();
            var env = audioCtx.createGain();
            osc.type = waveType || 'square';
            osc.frequency.value = freq;
            env.gain.setValueAtTime(0.3, time + totalDuration);
            env.gain.exponentialRampToValueAtTime(0.01, time + totalDuration + dur * 0.9);
            osc.connect(env);
            env.connect(trackGain);
            osc.start(time + totalDuration);
            osc.stop(time + totalDuration + dur);
        }
        totalDuration += dur;
    }
    trackTimeout = setTimeout(function() {
        if (soundOn && currentTrack) playMelody(melody, waveType);
    }, totalDuration * 1000 + 50);
}

function stopTrack() {
    if (trackTimeout) { clearTimeout(trackTimeout); trackTimeout = null; }
    if (trackGain && audioCtx) {
        trackGain.disconnect();
        trackGain = audioCtx.createGain();
        trackGain.gain.value = 0.12;
        trackGain.connect(audioCtx.destination);
    }
}

function setTrack(track) {
    if (track === currentTrack) return;
    currentTrack = track;
    stopTrack();
    if (!soundOn) return;
    if (track === 'menu') playMelody(menuMelody, 'square');
    else if (track === 'bout') playMelody(boutMelody, 'sawtooth');
}

function toggleSound() {
    if (!soundOn) {
        initAudio();
        soundOn = true;
        currentTrack = null;
        if (musicOn) setTrack('menu');
    } else {
        soundOn = false;
        stopTrack();
        currentTrack = null;
    }
    saveSoundSettings();
    dirty = true;
}

// ── Resize / canvas setup ──
function resize() {
    var touchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    var dpr = window.devicePixelRatio || 1;
    _isTouchDevice = touchDevice;

    // Fullscreen — fill the entire viewport (no padding, edge-to-edge).
    // VIEW_W/VIEW_H grow to match the viewport aspect ratio so content
    // never gets letterboxed.
    var vpW = window.innerWidth;
    var vpH = window.innerHeight;
    var aspect = vpH / vpW;
    SAFE_X = 0;

    if (aspect >= 1) {
        // Portrait — base width 500, height grows with aspect
        var isTablet = Math.min(vpW, vpH) >= 700;
        VIEW_W = isTablet ? 620 : 500;
        VIEW_H = Math.max(400, Math.round(VIEW_W * aspect));
        BAR_H = 36;
        BAR_FONT = 16;
    } else {
        // Landscape — base height 400, width grows with aspect
        VIEW_H = 400;
        VIEW_W = Math.max(500, Math.round(VIEW_H / aspect));
        BAR_H = 24;
        BAR_FONT = 12;
        // Inset content from edges on super-widescreen touch devices (notch / rounded corners)
        SAFE_X = (vpW / vpH >= 2.0 && touchDevice) ? Math.round(VIEW_W * 0.065) : 0;
    }

    // Canvas fills the viewport. CSS pixels = viewport pixels exactly.
    var scale = Math.min(vpW / VIEW_W, vpH / VIEW_H);
    canvas.style.width = vpW + 'px';
    canvas.style.height = vpH + 'px';
    canvas.width = Math.floor(vpW * dpr);
    canvas.height = Math.floor(vpH * dpr);
    SCALE = scale * dpr;
    dirty = true;
}

function canvasCoords(e) {
    var rect = canvas.getBoundingClientRect();
    var src = (e.touches && e.touches[0]) ? e.touches[0] : (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
    if (!src) return { x: -1, y: -1 };
    return {
        x: (src.clientX - rect.left) / rect.width * VIEW_W,
        y: (src.clientY - rect.top) / rect.height * VIEW_H
    };
}

function isPortrait() { return VIEW_H > VIEW_W; }

// ── Focus / keyboard navigation (Phase 6.5) ──
//
// Each navigable screen tracks its own focus index. After drawing the screen,
// it sets `_focusedRect` to the rect of the focused button/cell, and the main
// draw() pass calls drawFocusBorder() to overlay a pulsing gold border.
//
var _focusedRect = null;
var titleFocus = 0;        // 0=Tournament 1=Practice 2=Roster 3=Difficulty 4=Settings
var TITLE_FOCUS_COUNT = 5;
var fsFocusIdx = 0;        // 0..15 = grid cell, 16=Back, 17=Start
var rosterFocusIdx = 0;    // 0..15 = grid cell, 16=Back
var settingsFocus = 0;     // 0=Sound 1=Music 2=Tutorial 3=Delete 4=Close (or 0=Delete 1=Cancel in confirm)
var SETTINGS_FOCUS_COUNT = 5;
var bracketFocus = 1;      // 0=Quit 1=Continue (Continue is the natural default)

function drawFocusBorder() {
    if (!_focusedRect) return;
    var pulse = (Math.floor(performance.now() / 250) % 2) === 0;
    if (!pulse) return;
    var r = _focusedRect;
    ctx.strokeStyle = COLOR_GOLD;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x - 2.5, r.y - 2.5, r.w + 5, r.h + 5);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x - 4.5, r.y - 4.5, r.w + 9, r.h + 9);
}

// ── States ──
var S_TITLE = 0;
var S_ROSTER = 1;
var S_BOUT_INTRO = 2;
var S_BOUT_PLAY = 3;
var S_BOUT_HALT = 4;
var S_BOUT_RESULT = 5;
var S_FENCER_SELECT = 6;
var S_BRACKET = 7;
var S_MATCH_INTRO = 8;
var S_CHAMPION = 9;
var S_GAME_OVER = 10;
var state = S_TITLE;
var rosterFlipped = {}; // code -> true means show lunge instead of en-garde

// ── Difficulty ──
//
// 0=Easy, 1=Normal, 2=Hard. Stored as a single int in localStorage.
//
var DIFFICULTY_KEY = _KP + 'difficulty';
var difficulty = 1;
var _diffNames = ['EASY', 'NORMAL', 'HARD'];
function loadDifficulty() {
    try { var v = parseInt(localStorage.getItem(DIFFICULTY_KEY), 10); if (v >= 0 && v <= 2) difficulty = v; } catch(e) {}
}
function saveDifficulty() {
    try { localStorage.setItem(DIFFICULTY_KEY, String(difficulty)); } catch(e) {}
}
function cycleDifficulty() {
    difficulty = (difficulty + 1) % 3;
    saveDifficulty();
    sfxBlade();
    dirty = true;
}

// ── Favorite fencer ──
var FAV_KEY = _KP + 'favorite';
function loadFavorite() {
    try { return localStorage.getItem(FAV_KEY) || ''; } catch(e) { return ''; }
}
function saveFavorite(code) {
    try { localStorage.setItem(FAV_KEY, code); } catch(e) {}
}

// ── Bout state (foil, 1v1, hot-seat) ──
//
// The piste is 14 meters long, side-on. Position 0 = center, ±2 = en-garde
// lines, ±7 = back of piste. Each fencer has a position and an `act` phase
// that drives the state machine. Right-of-way is tracked via `boutAttacker`.
//
var PISTE_LEN = 14, PISTE_HALF = 7;
var BODY_R = 0.32;        // half-width of fencer's body hit zone (m)
var LUNGE_REACH = 1.7;    // additional reach during lunge peak (m)
var WALK_SPD = 4.2;       // m/s when advancing/retreating
var BOUT_TARGET = 5;      // first to 5 touches wins
var SIMUL_WINDOW = 100;   // ms — both lunges within this = simultaneous

// Per-fencer durations (ms)
var T_LUNGE_EXTEND = 170;
var T_LUNGE_PEAK = 80;
var T_LUNGE_RECOVER = 380;
var T_LUNGE_RECOVER_PARRIED = 700;
var T_PARRY = 200;
var T_PARRY_RECOVER = 140;

var bp1 = null, bp2 = null;
var boutAttacker = 0;     // 0=none, 1=p1, 2=p2
var boutSimul = false;    // simultaneous-attack flag
var boutMsg = '';
var boutMsgT = 0;
var boutHaltT = 0;        // time remaining in halt phase before reset
var boutFlashT = 0;       // visual flash for parries / impacts
var bp1Keys = { advance: false, retreat: false };
var bp2Keys = { advance: false, retreat: false };

// ── AI opponent (Phase 4) ──
//
// Single difficulty for now ("normal"). Difficulty knobs are bundled in the
// `ai` object so swapping presets later is a one-liner. The AI never reads
// state it shouldn't (no perfect prescience): it perceives an incoming attack
// only after `reactionMs` and lunges based on its own random rolls.
//
var ai = null;

function newAI() {
    // Difficulty presets
    var k;
    if (difficulty === 0) {
        // EASY — slow reactions, rare parries, infrequent lunges, sits a bit far
        k = { reactionMs: 360, parryChance: 0.25, lungeRatePerSec: 0.85, idealMin: 1.7, idealMax: 2.8, engageDist: 4.4 };
    } else if (difficulty === 2) {
        // HARD — fast reactions, parries often, aggressive
        k = { reactionMs: 130, parryChance: 0.78, lungeRatePerSec: 2.1, idealMin: 1.45, idealMax: 2.45, engageDist: 3.6 };
    } else {
        // NORMAL — current Phase 4 baseline
        k = { reactionMs: 220, parryChance: 0.55, lungeRatePerSec: 1.4, idealMin: 1.55, idealMax: 2.55, engageDist: 4.0 };
    }
    // Strength modifier — stronger fencers are slightly sharper
    if (bp2 && bp2.fencer && typeof bp2.fencer.strength === 'number') {
        var sBoost = (bp2.fencer.strength - 3) * 0.04; // -0.08 .. +0.08
        k.parryChance = Math.max(0.05, Math.min(0.95, k.parryChance + sBoost));
        k.lungeRatePerSec *= (1 + sBoost);
        k.reactionMs = Math.max(80, k.reactionMs - (bp2.fencer.strength - 3) * 18);
    }
    return {
        reactionMs: k.reactionMs,
        parryChance: k.parryChance,
        lungeRatePerSec: k.lungeRatePerSec,
        idealMin: k.idealMin,
        idealMax: k.idealMax,
        engageDist: k.engageDist,
        moveJitterMs: [80, 220],
        perceivedAttackTimer: -1,
        actionCooldown: 0,
        idleHoldTimer: 0
    };
}

function aiSetMove(dir) {
    // AI controls bp2 — `advance` means moving toward p1 (decreasing x).
    bp2Keys.advance = (dir === 'advance');
    bp2Keys.retreat = (dir === 'retreat');
}

function updateAI(dt) {
    if (!ai) return;
    var f = bp2, opp = bp1;

    // Cooldowns always tick
    if (ai.actionCooldown > 0) ai.actionCooldown -= dt;
    if (ai.idleHoldTimer > 0) ai.idleHoldTimer -= dt;

    // While committed to an action, AI can't change its mind
    if (f.act !== 'idle') {
        ai.perceivedAttackTimer = -1;
        aiSetMove('hold');
        return;
    }

    var dist = f.pos - opp.pos;     // positive (bp2 is right of bp1)
    var oppAttacking = (opp.act === 'lunge_extend' || opp.act === 'lunge_peak') &&
                       boutAttacker === opp.side;

    // Reaction tracking — only "perceives" the attack after reactionMs of exposure
    if (oppAttacking) {
        if (ai.perceivedAttackTimer < 0) ai.perceivedAttackTimer = 0;
        else ai.perceivedAttackTimer += dt;
    } else {
        ai.perceivedAttackTimer = -1;
    }

    // React to attack
    if (oppAttacking && ai.perceivedAttackTimer >= ai.reactionMs && ai.actionCooldown <= 0) {
        if (Math.random() < ai.parryChance) {
            startParry(f, opp);
            ai.actionCooldown = 350;
            return;
        }
        // Otherwise, hard retreat to dodge
        aiSetMove('retreat');
        return;
    }

    // Distance management
    if (dist > ai.engageDist) {
        aiSetMove('advance');
        return;
    }
    if (dist < ai.idealMin) {
        aiSetMove('retreat');
        return;
    }
    if (dist > ai.idealMax) {
        aiSetMove('advance');
        return;
    }

    // In ideal range — hold position with occasional jitter, decide whether to lunge
    if (ai.idleHoldTimer > 0) {
        aiSetMove('hold');
    } else {
        // Re-roll a small random hold
        ai.idleHoldTimer = ai.moveJitterMs[0] + Math.random() * (ai.moveJitterMs[1] - ai.moveJitterMs[0]);
        // Pick a random micro-move
        var roll = Math.random();
        if (roll < 0.35) aiSetMove('advance');
        else if (roll < 0.55) aiSetMove('retreat');
        else aiSetMove('hold');
    }

    // Lunge decision (independent of move) — only when attacker has no priority
    if (ai.actionCooldown <= 0 && boutAttacker !== opp.side) {
        var lungeProb = ai.lungeRatePerSec * dt / 1000;
        // Boost odds when opponent is in lunge_recover (free-hit window)
        if (opp.act === 'lunge_recover') lungeProb *= 4;
        if (Math.random() < lungeProb) {
            startLunge(f, opp);
            ai.actionCooldown = 700;
        }
    }
}

function newFencerState(fencer, side) {
    return {
        fencer: fencer,
        side: side,                     // 1 = left, 2 = right
        pos: side === 1 ? -2 : 2,       // en-garde lines
        facing: side === 1 ? 'right' : 'left',
        act: 'idle',
        actT: 0,
        touches: 0,
        flash: 0
    };
}

function resetEnGarde() {
    bp1.pos = -2; bp1.act = 'idle'; bp1.actT = 0; bp1.flash = 0;
    bp2.pos = 2;  bp2.act = 'idle'; bp2.actT = 0; bp2.flash = 0;
    boutAttacker = 0;
    boutSimul = false;
    bp1Keys.advance = bp1Keys.retreat = false;
    bp2Keys.advance = bp2Keys.retreat = false;
}

function startBout(f1, f2) {
    bp1 = newFencerState(f1, 1);
    bp2 = newFencerState(f2, 2);
    ai = newAI();
    boutAttacker = 0;
    boutSimul = false;
    boutMsg = 'EN GARDE...';
    boutMsgT = 1100;
    state = S_BOUT_INTRO;
    if (musicOn) { currentTrack = null; setTrack('bout'); }
    // First-time tutorial
    if (!isTutorialSeen()) tutorialVisible = true;
    dirty = true;
}

// ── Settings modal (Phase 6) ──
//
// Sound on/off, music on/off, tutorial replay, delete-all-data with two-step
// confirm. Drawn on top of whatever screen is active. Toggleable from title.
//
var settingsVisible = false;
var settingsConfirmDelete = 0;  // 0 none, 1 first confirm, 2 final confirm
var _settingsRects = {};

function openSettings() {
    settingsVisible = true;
    settingsConfirmDelete = 0;
    settingsFocus = 0;
    sfxBlade();
    dirty = true;
}
function closeSettings() {
    settingsVisible = false;
    settingsConfirmDelete = 0;
    sfxBlade();
    dirty = true;
}
function toggleSoundSetting() {
    soundOn = !soundOn;
    if (soundOn) { initAudio(); if (musicOn) setTrack('menu'); }
    else { stopTrack(); currentTrack = null; }
    saveSoundSettings();
    dirty = true;
}
function toggleMusicSetting() {
    musicOn = !musicOn;
    if (musicOn) {
        if (!soundOn) { soundOn = true; initAudio(); }
        currentTrack = null;
        setTrack(state === S_BOUT_PLAY ? 'bout' : 'menu');
    } else {
        stopTrack();
        currentTrack = null;
    }
    saveSoundSettings();
    dirty = true;
}
function deleteAllData() {
    try {
        localStorage.removeItem(SOUND_KEY);
        localStorage.removeItem(DIFFICULTY_KEY);
        localStorage.removeItem(FAV_KEY);
        localStorage.removeItem(TOURNEY_KEY);
        localStorage.removeItem(_KP + 'tutorialSeen');
    } catch(e) {}
    soundOn = false; sfxOn = true; musicOn = false;
    difficulty = 1;
    tournament = null;
    settingsVisible = false;
    settingsConfirmDelete = 0;
    state = S_TITLE;
    dirty = true;
}

function drawSettings() {
    var p = isPortrait();
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    var dlgW = p ? VIEW_W - 40 : 340;
    var dlgH = p ? 420 : 290;
    var dlgX = Math.round((VIEW_W - dlgW) / 2);
    var dlgY = Math.round((VIEW_H - dlgH) / 2);
    drawPixelRoundRect(dlgX, dlgY, dlgW, dlgH, 4, COLOR_GOLD);
    drawPixelRoundRect(dlgX + 3, dlgY + 3, dlgW - 6, dlgH - 6, 4, COLOR_BG_DARK);

    ctx.font = 'bold ' + (p ? 14 : 11) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillText('SETTINGS', dlgX + dlgW / 2, dlgY + (p ? 26 : 22));

    var bw = dlgW - 40;
    var bh = p ? 40 : 30;
    var bx = dlgX + 20;
    var by = dlgY + (p ? 56 : 46);
    var gap = p ? 10 : 8;

    if (settingsConfirmDelete === 0) {
        drawButton(bx, by, bw, bh, 'Sound: ' + (soundOn ? 'ON' : 'OFF'), soundOn);
        _settingsRects.sound = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap;
        drawButton(bx, by, bw, bh, 'Music: ' + (musicOn ? 'ON' : 'OFF'), musicOn);
        _settingsRects.music = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap;
        drawButton(bx, by, bw, bh, 'How to Play', false);
        _settingsRects.tutorial = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap;
        drawButton(bx, by, bw, bh, 'Delete All Data', false);
        _settingsRects.del = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap + (p ? 6 : 4);
        drawButton(bx, by, bw, bh, 'Close', true);
        _settingsRects.close = { x: bx, y: by, w: bw, h: bh };
        // Focus
        var fkeys = ['sound', 'music', 'tutorial', 'del', 'close'];
        _focusedRect = _settingsRects[fkeys[settingsFocus]] || null;
    } else {
        // Confirmation
        ctx.font = 'bold ' + (p ? 13 : 10) + 'px ' + FONT;
        ctx.fillStyle = '#ff6666';
        ctx.fillText(settingsConfirmDelete === 1 ? 'DELETE ALL DATA?' : '!! REALLY SURE !!',
            dlgX + dlgW / 2, dlgY + (p ? 80 : 65));
        ctx.font = (p ? 9 : 7) + 'px ' + FONT;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText('All saves, settings, and progress', dlgX + dlgW / 2, dlgY + (p ? 110 : 90));
        ctx.fillText('will be erased.', dlgX + dlgW / 2, dlgY + (p ? 124 : 102));

        var cby = dlgY + (p ? 160 : 130);
        var cbw = (bw - gap) / 2;
        drawButton(bx, cby, cbw, bh, 'Delete', false);
        _settingsRects.confirmDel = { x: bx, y: cby, w: cbw, h: bh };
        drawButton(bx + cbw + gap, cby, cbw, bh, 'Cancel', true);
        _settingsRects.cancelDel = { x: bx + cbw + gap, y: cby, w: cbw, h: bh };
        // Focus: 0 = Delete, 1 = Cancel (default to Cancel for safety)
        _focusedRect = (settingsFocus === 0) ? _settingsRects.confirmDel : _settingsRects.cancelDel;
    }
}

// ── Tutorial overlay (Phase 6) ──
var tutorialVisible = false;
var TUTORIAL_KEY = _KP + 'tutorialSeen';
var _tutorialBtn = { x: 0, y: 0, w: 0, h: 0 };
function isTutorialSeen() { try { return !!localStorage.getItem(TUTORIAL_KEY); } catch(e) { return false; } }
function markTutorialSeen() { try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch(e) {} }
function openTutorial() { tutorialVisible = true; sfxBlade(); dirty = true; }
function closeTutorial() { tutorialVisible = false; markTutorialSeen(); sfxBlade(); dirty = true; }

function drawTutorial() {
    var p = isPortrait();
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    var dlgW = p ? VIEW_W - 30 : 380;
    var dlgH = p ? VIEW_H - 80 : 290;
    var dlgX = Math.round((VIEW_W - dlgW) / 2);
    var dlgY = Math.round((VIEW_H - dlgH) / 2);
    drawPixelRoundRect(dlgX, dlgY, dlgW, dlgH, 4, COLOR_GOLD);
    drawPixelRoundRect(dlgX + 3, dlgY + 3, dlgW - 6, dlgH - 6, 4, COLOR_BG_DARK);

    ctx.font = 'bold ' + (p ? 14 : 11) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillText('HOW TO FENCE', dlgX + dlgW / 2, dlgY + (p ? 26 : 22));

    var lineH = p ? 16 : 13;
    var ly = dlgY + (p ? 56 : 46);
    var leftX = dlgX + 20;
    var rightX = dlgX + dlgW - 20;
    ctx.font = 'bold ' + (p ? 9 : 7) + 'px ' + FONT;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';

    var rows;
    if (_isTouchDevice) {
        rows = [
            ['LEFT BUTTON',  'Retreat'],
            ['RIGHT BUTTON', 'Advance'],
            ['LUNGE BUTTON', 'Attack — first to lunge gets PRIORITY'],
            ['PARRY BUTTON', 'Block — flips priority, opens riposte'],
            ['',            ''],
            ['FIRST TO 5',  'touches wins the bout']
        ];
    } else {
        rows = [
            ['\u2190 \u2192',  'Move along the piste'],
            ['\u2191 / SPACE', 'Lunge — first to attack gets PRIORITY'],
            ['\u2193',         'Parry — block + flip priority'],
            ['ESC',           'Quit'],
            ['',              ''],
            ['FIRST TO 5',    'touches wins the bout']
        ];
    }
    for (var i = 0; i < rows.length; i++) {
        if (rows[i][0]) {
            ctx.textAlign = 'left'; ctx.fillStyle = COLOR_GOLD;
            ctx.fillText(rows[i][0], leftX, ly);
            ctx.textAlign = 'left'; ctx.fillStyle = '#fff';
            ctx.fillText(rows[i][1], leftX + (p ? 130 : 100), ly);
        }
        ly += lineH;
    }

    // Priority explainer
    ctx.font = (p ? 8 : 7) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText('Counter-attacks without priority do NOT score.', dlgX + dlgW / 2, ly + 4);
    ctx.fillText('Parry an attack to take priority and riposte!',  dlgX + dlgW / 2, ly + 16);

    // Got it button
    var btnH = p ? 44 : 32;
    var btnW = p ? 200 : 160;
    var btnY = dlgY + dlgH - btnH - 16;
    drawButton(dlgX + dlgW / 2 - btnW / 2, btnY, btnW, btnH, 'Got It', true);
    _tutorialBtn = { x: dlgX + dlgW / 2 - btnW / 2, y: btnY, w: btnW, h: btnH };
    _focusedRect = _tutorialBtn;
}

// ── Confetti (Phase 6 — champion celebration) ──
var confettiParticles = [];
function spawnConfetti(colors) {
    confettiParticles = [];
    var palette = ['#FFD700', '#fff', '#ff4444', '#44ff44', '#4488ff', '#ff44ff'];
    if (colors) palette = palette.concat(colors);
    for (var i = 0; i < 110; i++) {
        confettiParticles.push({
            x: Math.random() * VIEW_W,
            y: -10 - Math.random() * 150,
            vx: (Math.random() - 0.5) * 2,
            vy: 0.5 + Math.random() * 1.5,
            rot: Math.random() * Math.PI * 2,
            rotV: (Math.random() - 0.5) * 0.15,
            w: 3 + Math.random() * 4,
            h: 2 + Math.random() * 3,
            c: palette[Math.floor(Math.random() * palette.length)],
            life: 1
        });
    }
}
function updateConfetti(dt) {
    for (var i = confettiParticles.length - 1; i >= 0; i--) {
        var p = confettiParticles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.rotV;
        p.vy += 0.03;
        p.vx *= 0.99;
        p.life -= dt / 6000;
        if (p.life <= 0 || p.y > VIEW_H + 20) confettiParticles.splice(i, 1);
    }
}
function drawConfetti() {
    for (var i = 0; i < confettiParticles.length; i++) {
        var p = confettiParticles[i];
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.min(1, p.life * 2);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
    }
    ctx.globalAlpha = 1;
}

// ── Tournament (Phase 5) ──
//
// Single-elimination 16 → 8 → 4 → 2 → 1. Player picks one fencer; others
// are seeded into a randomized bracket. Player plays their own match each
// round; CPU-vs-CPU matches are simulated probabilistically by strength.
//
var ROUND_NAMES = ['ROUND OF 16', 'QUARTERFINAL', 'SEMIFINAL', 'FINAL'];
var TOURNEY_KEY = _KP + 'tournament';
var tournament = null;       // current tournament object (or null when not playing)
var boutContext = 'practice'; // 'practice' or 'tournament'

function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
}

function newTournament(playerCode) {
    // Build a 16-fencer field. Always include the player; fill the rest from FENCERS.
    var pool = FENCERS.slice();
    shuffle(pool);
    // Make sure player is in the pool
    var hasPlayer = false;
    for (var i = 0; i < pool.length; i++) if (pool[i].code === playerCode) { hasPlayer = true; break; }
    if (!hasPlayer && FENCERS.length) {
        for (var j = 0; j < FENCERS.length; j++) {
            if (FENCERS[j].code === playerCode) { pool.unshift(FENCERS[j]); break; }
        }
    }
    var field = pool.slice(0, 16);
    // Re-shuffle so the player's bracket position is random
    shuffle(field);

    // Round 0: 8 matches
    var round0 = [];
    for (var k = 0; k < 16; k += 2) {
        round0.push({
            a: field[k], b: field[k + 1],
            winner: null, scoreA: 0, scoreB: 0, played: false,
            playerInvolved: (field[k].code === playerCode || field[k + 1].code === playerCode)
        });
    }
    return {
        playerCode: playerCode,
        rounds: [round0],
        roundIdx: 0,
        playerEliminated: false,
        champion: null
    };
}

function findPlayerMatch(t) {
    if (t.playerEliminated) return -1;
    var round = t.rounds[t.roundIdx];
    for (var i = 0; i < round.length; i++) {
        if (round[i].playerInvolved && !round[i].played) return i;
    }
    return -1;
}

function simulateMatch(m) {
    var sa = (m.a.strength || 3);
    var sb = (m.b.strength || 3);
    // Each touch is decided by relative strength with a small luck factor
    var pa = sa / (sa + sb);
    // Add ±0.06 random form swing per match (re-rolled each call)
    var formA = (Math.random() - 0.5) * 0.12;
    pa = Math.max(0.1, Math.min(0.9, pa + formA));
    m.scoreA = 0; m.scoreB = 0;
    while (m.scoreA < BOUT_TARGET && m.scoreB < BOUT_TARGET) {
        if (Math.random() < pa) m.scoreA++;
        else m.scoreB++;
    }
    m.winner = m.scoreA > m.scoreB ? m.a : m.b;
    m.played = true;
}

function simulateRemainingMatches(t) {
    var round = t.rounds[t.roundIdx];
    for (var i = 0; i < round.length; i++) {
        if (!round[i].played) simulateMatch(round[i]);
    }
}

function buildNextRound(t) {
    var prev = t.rounds[t.roundIdx];
    if (prev.length === 1) {
        // Tournament over — record champion
        t.champion = prev[0].winner;
        return;
    }
    var next = [];
    for (var i = 0; i < prev.length; i += 2) {
        var a = prev[i].winner, b = prev[i + 1].winner;
        next.push({
            a: a, b: b,
            winner: null, scoreA: 0, scoreB: 0, played: false,
            playerInvolved: (a.code === t.playerCode || b.code === t.playerCode)
        });
    }
    t.rounds.push(next);
    t.roundIdx++;
}

function saveTournament() {
    if (!tournament) { try { localStorage.removeItem(TOURNEY_KEY); } catch(e) {} return; }
    try {
        // Strip out fencer objects, keep codes
        var lite = {
            playerCode: tournament.playerCode,
            roundIdx: tournament.roundIdx,
            playerEliminated: tournament.playerEliminated,
            championCode: tournament.champion ? tournament.champion.code : null,
            rounds: tournament.rounds.map(function(r) {
                return r.map(function(m) {
                    return {
                        a: m.a.code, b: m.b.code,
                        winner: m.winner ? m.winner.code : null,
                        scoreA: m.scoreA, scoreB: m.scoreB,
                        played: m.played, playerInvolved: m.playerInvolved
                    };
                });
            })
        };
        localStorage.setItem(TOURNEY_KEY, JSON.stringify(lite));
    } catch(e) {}
}

function fencerByCode(code) {
    for (var i = 0; i < FENCERS.length; i++) if (FENCERS[i].code === code) return FENCERS[i];
    return null;
}

function loadTournament() {
    try {
        var raw = localStorage.getItem(TOURNEY_KEY);
        if (!raw) return null;
        var lite = JSON.parse(raw);
        var t = {
            playerCode: lite.playerCode,
            roundIdx: lite.roundIdx,
            playerEliminated: lite.playerEliminated,
            champion: lite.championCode ? fencerByCode(lite.championCode) : null,
            rounds: lite.rounds.map(function(r) {
                return r.map(function(m) {
                    return {
                        a: fencerByCode(m.a), b: fencerByCode(m.b),
                        winner: m.winner ? fencerByCode(m.winner) : null,
                        scoreA: m.scoreA, scoreB: m.scoreB,
                        played: m.played, playerInvolved: m.playerInvolved
                    };
                });
            })
        };
        // Sanity: any null fencer means stale save (roster changed) — discard
        for (var i = 0; i < t.rounds.length; i++) {
            for (var j = 0; j < t.rounds[i].length; j++) {
                var m = t.rounds[i][j];
                if (!m.a || !m.b) return null;
            }
        }
        return t;
    } catch(e) { return null; }
}

function clearTournament() {
    tournament = null;
    try { localStorage.removeItem(TOURNEY_KEY); } catch(e) {}
}

function startLunge(f, opp) {
    if (f.act !== 'idle') return;
    f.act = 'lunge_extend';
    f.actT = T_LUNGE_EXTEND;
    // Priority: first to lunge gets priority. Counter-attacks don't.
    if (boutAttacker === 0) {
        boutAttacker = f.side;
    } else if (boutAttacker !== f.side) {
        // Opponent is already attacking — check for simultaneous
        if (opp.act === 'lunge_extend' && (T_LUNGE_EXTEND - opp.actT) < SIMUL_WINDOW) {
            boutSimul = true;
        }
        // Counter-attack: priority stays with opponent
    }
    sfxBlade();
}

function startParry(f, opp) {
    if (f.act !== 'idle') return;
    f.act = 'parry';
    f.actT = T_PARRY;
    f.flash = 200;
    // Check if opponent is currently mid-lunge — instant parry success
    if ((opp.act === 'lunge_extend' || opp.act === 'lunge_peak') && boutAttacker === opp.side) {
        // Successful parry — flip priority, attacker enters extra recovery
        opp.act = 'lunge_recover';
        opp.actT = T_LUNGE_RECOVER_PARRIED;
        opp.flash = 0;
        f.act = 'parry_recover';
        f.actT = T_PARRY_RECOVER;
        f.flash = 350;
        boutAttacker = f.side;
        boutSimul = false;
        boutMsg = 'PARRY!';
        boutMsgT = 700;
        // Bright metallic clink
        playSfx([[NOTE.E5, 30], [NOTE.B5, 50], [NOTE.E5, 30]], 'triangle', 0.14);
    }
}

function tryHit(attacker, defender) {
    // Called when attacker enters lunge_peak. Decide if a touch lands.
    var dir = attacker.side === 1 ? 1 : -1;
    var tip = attacker.pos + dir * (BODY_R + LUNGE_REACH);
    var inRange = (dir === 1)
        ? (tip >= defender.pos - BODY_R && attacker.pos < defender.pos)
        : (tip <= defender.pos + BODY_R && attacker.pos > defender.pos);
    if (!inRange) return; // miss — fall through to lunge_recover normally

    // Defender mid-parry → parried (rare path: parry started before our peak)
    if (defender.act === 'parry') {
        attacker.act = 'lunge_recover';
        attacker.actT = T_LUNGE_RECOVER_PARRIED;
        defender.act = 'parry_recover';
        defender.actT = T_PARRY_RECOVER;
        defender.flash = 350;
        boutAttacker = defender.side;
        boutSimul = false;
        boutMsg = 'PARRY!';
        boutMsgT = 700;
        playSfx([[NOTE.E5, 30], [NOTE.B5, 50], [NOTE.E5, 30]], 'triangle', 0.14);
        return;
    }

    if (boutSimul) {
        // Simultaneous — no touch
        boutMsg = 'SIMULTANEOUS';
        boutMsgT = 1100;
        boutHaltT = 1100;
        state = S_BOUT_HALT;
        playSfx([[NOTE.A4, 80], [NOTE.A4, 80]], 'square', 0.10);
        return;
    }

    if (boutAttacker === attacker.side) {
        // Valid touch — attacker has priority
        attacker.touches++;
        defender.flash = 600;
        defender.act = 'touched';
        defender.actT = 1200;
        boutMsg = (attacker.side === 1 ? 'TOUCH LEFT!' : 'TOUCH RIGHT!');
        boutMsgT = 1400;
        boutHaltT = 1400;
        state = S_BOUT_HALT;
        playSfx([[NOTE.E5, 60], [NOTE.A5, 100], [NOTE.E6, 220]], 'square', 0.16);
    } else {
        // Counter-attack hit — no score
        boutMsg = 'NO TOUCH';
        boutMsgT = 900;
        boutHaltT = 900;
        state = S_BOUT_HALT;
        playSfx([[NOTE.A4, 80], [NOTE.F4, 120]], 'square', 0.10);
    }
}

function updateFencer(f, opp, dt) {
    if (f.flash > 0) f.flash = Math.max(0, f.flash - dt);
    if (f.act === 'idle') return;
    f.actT -= dt;
    if (f.actT > 0) return;
    // Phase transition
    if (f.act === 'lunge_extend') {
        f.act = 'lunge_peak';
        f.actT = T_LUNGE_PEAK;
        tryHit(f, opp);
        return;
    }
    if (f.act === 'lunge_peak') { f.act = 'lunge_recover'; f.actT = T_LUNGE_RECOVER; return; }
    if (f.act === 'lunge_recover') {
        f.act = 'idle';
        // If this fencer was attacker and recovered cleanly without a touch → priority clears
        if (boutAttacker === f.side) { boutAttacker = 0; boutSimul = false; }
        return;
    }
    if (f.act === 'parry') { f.act = 'parry_recover'; f.actT = T_PARRY_RECOVER; return; }
    if (f.act === 'parry_recover') { f.act = 'idle'; return; }
    if (f.act === 'touched') { f.act = 'idle'; return; }
}

function updateBout(dt) {
    if (state === S_BOUT_INTRO) {
        boutMsgT -= dt;
        if (boutMsgT <= 0) {
            if (boutMsg === 'EN GARDE...') { boutMsg = 'FENCE!'; boutMsgT = 600; }
            else { state = S_BOUT_PLAY; boutMsg = ''; }
        }
        dirty = true;
        return;
    }
    if (state === S_BOUT_PLAY) {
        var dts = dt / 1000;
        // Movement (only if idle)
        if (bp1.act === 'idle') {
            if (bp1Keys.advance) bp1.pos += WALK_SPD * dts;
            if (bp1Keys.retreat) bp1.pos -= WALK_SPD * dts;
        }
        if (bp2.act === 'idle') {
            // p2 advances toward p1 (negative x)
            if (bp2Keys.advance) bp2.pos -= WALK_SPD * dts;
            if (bp2Keys.retreat) bp2.pos += WALK_SPD * dts;
        }
        bp1.pos = Math.max(-PISTE_HALF, Math.min(PISTE_HALF, bp1.pos));
        bp2.pos = Math.max(-PISTE_HALF, Math.min(PISTE_HALF, bp2.pos));
        var minGap = 2 * BODY_R + 0.1;
        if (bp2.pos - bp1.pos < minGap) {
            var mid = (bp1.pos + bp2.pos) / 2;
            bp1.pos = mid - minGap / 2;
            bp2.pos = mid + minGap / 2;
        }

        updateAI(dt);
        updateFencer(bp1, bp2, dt);
        updateFencer(bp2, bp1, dt);

        if (boutMsgT > 0) boutMsgT -= dt;
        dirty = true;
        return;
    }
    if (state === S_BOUT_HALT) {
        if (boutMsgT > 0) boutMsgT -= dt;
        if (boutHaltT > 0) boutHaltT -= dt;
        if (boutHaltT <= 0) {
            // Bout end?
            if (bp1.touches >= BOUT_TARGET || bp2.touches >= BOUT_TARGET) {
                state = S_BOUT_RESULT;
                boutMsg = (bp1.touches > bp2.touches
                    ? bp1.fencer.name.toUpperCase() + ' WINS!'
                    : bp2.fencer.name.toUpperCase() + ' WINS!');
                boutMsgT = 0;
                // If this was a tournament match, record the result now
                if (boutContext === 'tournament' && tournament) {
                    finishTournamentMatch();
                }
                if (musicOn) { stopTrack(); currentTrack = null; }
            } else {
                resetEnGarde();
                state = S_BOUT_PLAY;
                boutMsg = '';
            }
        }
        dirty = true;
        return;
    }
}

// ── Drawing helpers ──
var BAR_H = 24;
var BAR_FONT = 12;

function drawPixelRoundRect(x, y, w, h, r, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x + r, y, w - r * 2, h);
    ctx.fillRect(x, y + r, w, h - r * 2);
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
}

function drawButton(x, y, w, h, label, primary, bgColor) {
    var r = h >= 40 ? 5 : 3;
    var bg = bgColor || COLOR_UI_BG;
    var b = h >= 40 ? 3 : 2;
    drawPixelRoundRect(x + b, y + b, w, h, r, 'rgba(0,0,0,0.4)');
    drawPixelRoundRect(x, y, w, h, r, primary ? COLOR_GOLD : COLOR_WHITE);
    drawPixelRoundRect(x + b, y + b, w - b * 2, h - b * 2, r, bg);
    ctx.fillStyle = '#fff';
    var btnFont = h >= 70 ? 18 : (h >= 40 ? 13 : (h >= 28 ? 10 : 8));
    ctx.font = 'bold ' + btnFont + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.toUpperCase(), x + w / 2, y + h / 2 + 1);
}

function drawBar(left, center, right) {
    ctx.fillStyle = COLOR_BG_DARK;
    ctx.fillRect(0, 0, VIEW_W, BAR_H);
    ctx.textBaseline = 'middle';
    if (left) {
        ctx.font = 'bold ' + BAR_FONT + 'px ' + FONT;
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillText(left.toUpperCase(), SAFE_X + 13, BAR_H / 2 + 2);
        ctx.fillStyle = '#fff'; ctx.fillText(left.toUpperCase(), SAFE_X + 12, BAR_H / 2 + 1);
    }
    if (center) {
        ctx.font = 'bold ' + (BAR_FONT + 1) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillText(center.toUpperCase(), VIEW_W / 2 + 1, BAR_H / 2 + 2);
        ctx.fillStyle = '#fff'; ctx.fillText(center.toUpperCase(), VIEW_W / 2, BAR_H / 2 + 1);
    }
    if (right) {
        ctx.font = 'bold ' + BAR_FONT + 'px ' + FONT;
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillText(right.toUpperCase(), VIEW_W - SAFE_X - 11, BAR_H / 2 + 2);
        ctx.fillStyle = '#fff'; ctx.fillText(right.toUpperCase(), VIEW_W - SAFE_X - 12, BAR_H / 2 + 1);
    }
}

// ── Fencer sprite ──
//
// Procedural pixel art. Side-view foil fencer ~16w × 19h pixels (en-garde) or
// ~22w × 14h (lunge). Drawn in 1-px units scaled by `s`.
//   px, py:    body center / ground level (feet)
//   fencer:    { colors: [primary, secondary], skin: [hex,...] }
//   size:      base scale multiplier
//   facing:    'right' (default) or 'left'
//   pose:      'en-garde' (default) or 'lunge'
//   skinIdx:   index into fencer.skin (for variety across same nation)
//
function drawFencer(px, py, fencer, size, facing, pose, skinIdx, opts) {
    var s = (size || 1) * 1.8;
    var fr = facing !== 'left';
    pose = pose || 'en-garde';
    opts = opts || {};
    var bladeExt = Math.max(0, Math.min(1, opts.bladeExt || 0));
    var bobFrame = opts.bobFrame || 0;
    var primary = (fencer && fencer.colors && fencer.colors[0]) || '#0055a4';
    var secondary = (fencer && fencer.colors && fencer.colors[1]) || '#ffffff';
    var skins = (fencer && fencer.skin) || [SKIN_MED];
    var sk = skins[(skinIdx || 0) % skins.length];

    // Constant uniform colors
    var WHITE = '#fafafa';        // jacket / breeches / sock
    var WHITE_SHADE = '#d8d8de';  // jacket shading
    var MASK = '#3a3a3a';         // mask shell
    var MESH = '#7a7a7a';         // mask mesh dots
    var GLOVE = '#1a1a1a';
    var SHOE = '#1a1a1a';
    var SHOE_SOLE = '#0a0a0a';
    var BLADE = '#dddddd';
    var BLADE_DARK = '#888888';

    // Origin: place ox so the body center sits at px, oy so feet (last row) sit at py.
    // Sprite logical width / height varies by pose.
    var W = pose === 'lunge' ? 24 : 16;
    var H = pose === 'lunge' ? 18 : 19;
    var ox = Math.round(px - (W / 2) * s);
    // 2-frame footwork bob: 1 pixel up on odd frames
    var bob = (bobFrame % 2 === 1) ? -1 : 0;
    var oy = Math.round(py - (H - 1) * s) + Math.round(bob * s);

    function r(x, y, w, h, c) {
        ctx.fillStyle = c;
        ctx.fillRect(ox + x * s, oy + y * s, w * s, h * s);
    }

    if (!fr) {
        ctx.save();
        ctx.translate(px, 0);
        ctx.scale(-1, 1);
        ctx.translate(-px, 0);
    }

    // ── Shadow ──
    r(3, H - 1, W - 6, 1, 'rgba(0,0,0,0.18)');

    if (pose === 'en-garde') {
        // ── EN-GARDE ─────────────────────────────────────────────
        // Mask
        r(7, 2, 4, 4, MASK);
        r(6, 3, 1, 2, MASK);    // back of mask
        r(11, 3, 1, 2, MASK);   // chin guard
        r(8, 3, 1, 1, MESH);
        r(10, 3, 1, 1, MESH);
        r(9, 4, 1, 1, MESH);
        // Bib (under mask)
        r(7, 6, 4, 1, WHITE);

        // Jacket torso
        r(6, 7, 6, 4, WHITE);
        r(6, 11, 6, 1, WHITE_SHADE); // bottom shade
        // Lamé (electrified target plate — primary team color)
        r(7, 7, 4, 3, primary);
        // Collar accent (secondary)
        r(6, 7, 1, 1, secondary);
        r(11, 7, 1, 1, secondary);

        // Weapon arm (forward, slightly downward)
        r(11, 8, 1, 2, WHITE);   // shoulder/sleeve
        r(12, 8, 2, 1, sk);      // forearm
        r(14, 8, 1, 1, GLOVE);   // glove
        // Hilt (gold guard)
        r(15, 8, 1, 1, COLOR_GOLD);
        // Blade — base length 6px, extends with bladeExt (0..1) up to +6px
        var bladeLen = 6 + Math.round(bladeExt * 6);
        r(16, 8, bladeLen, 1, BLADE);
        r(16 + bladeLen, 8, 1, 1, BLADE_DARK); // tip

        // Back arm raised (curled up behind head, classic foil pose)
        r(5, 6, 1, 1, WHITE);    // shoulder
        r(4, 5, 1, 1, WHITE);    // upper arm
        r(3, 4, 1, 1, WHITE);    // forearm rising
        r(3, 3, 1, 1, WHITE);
        r(3, 2, 1, 1, sk);       // hand peeking up
        r(4, 2, 1, 1, sk);

        // Breeches (white knickers)
        r(5, 11, 7, 1, WHITE);
        // Front leg — bent, knee forward
        r(10, 12, 2, 1, WHITE);
        r(11, 13, 2, 1, WHITE);
        // Back leg — bent, knee back
        r(4, 12, 2, 1, WHITE);
        r(3, 13, 2, 1, WHITE);

        // Long socks (white, below knee)
        r(11, 14, 2, 2, WHITE);  // front
        r(3, 14, 2, 2, WHITE);   // back

        // Shoes
        r(11, 16, 4, 1, SHOE);   // front shoe
        r(11, 17, 4, 1, SHOE_SOLE);
        r(1, 16, 4, 1, SHOE);    // back shoe
        r(1, 17, 4, 1, SHOE_SOLE);

    } else {
        // ── LUNGE ────────────────────────────────────────────────
        // Body leans forward & down. Front leg shoots out. Sprite is wider, shorter.
        // Mask
        r(8, 2, 4, 3, MASK);
        r(7, 3, 1, 2, MASK);
        r(12, 3, 1, 2, MASK);
        r(9, 3, 1, 1, MESH);
        r(11, 3, 1, 1, MESH);
        r(10, 4, 1, 1, MESH);

        // Torso tilted forward — taller in front, shorter in back
        r(7, 5, 5, 4, WHITE);
        r(7, 9, 5, 1, WHITE_SHADE);
        // Lamé
        r(8, 5, 4, 3, primary);
        r(7, 5, 1, 1, secondary);
        r(12, 5, 1, 1, secondary);

        // Weapon arm fully extended forward, blade reaches far
        r(12, 6, 1, 1, WHITE);    // shoulder
        r(13, 6, 3, 1, sk);       // forearm
        r(16, 6, 1, 1, GLOVE);    // glove
        r(17, 6, 1, 1, COLOR_GOLD); // hilt
        r(18, 6, 5, 1, BLADE);    // blade
        r(23, 6, 1, 1, BLADE_DARK);

        // Back arm extended back-up for balance
        r(6, 5, 1, 1, WHITE);
        r(5, 5, 1, 1, WHITE);
        r(4, 4, 1, 1, WHITE);
        r(4, 3, 1, 1, sk);

        // Hips
        r(7, 9, 4, 1, WHITE);
        // Front leg — fully extended forward (almost horizontal)
        r(11, 10, 2, 1, WHITE);   // upper thigh stretched
        r(13, 10, 2, 1, WHITE);
        r(15, 11, 2, 1, WHITE);   // shin sock area
        r(17, 11, 2, 1, WHITE);
        r(19, 12, 2, 1, WHITE);   // ankle
        r(19, 13, 3, 1, SHOE);    // front foot planted
        r(19, 14, 3, 1, SHOE_SOLE);

        // Back leg — straight, back foot planted, knee straight
        r(6, 10, 2, 1, WHITE);    // back thigh
        r(5, 11, 2, 1, WHITE);
        r(4, 12, 2, 1, WHITE);    // sock
        r(4, 13, 2, 1, WHITE);
        r(2, 14, 4, 1, SHOE);     // back shoe
        r(2, 15, 4, 1, SHOE_SOLE);
    }

    if (!fr) ctx.restore();
}

// Decorative piste illustration on the title screen — horizontal strip.
function drawTitlePiste(cx, cy, w) {
    // Decorative piste under the title fencer. Just a horizontal strip with
    // gold center line and white en-garde marks.
    var pisteH = 12;
    var pisteY = cy - pisteH / 2;
    ctx.fillStyle = COLOR_BG_LIGHT;
    ctx.fillRect(cx - w / 2, pisteY, w, pisteH);
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - w / 2, pisteY, w, 1);
    ctx.fillRect(cx - w / 2, pisteY + pisteH - 1, w, 1);
    // Center line (gold)
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillRect(cx - 1, pisteY - 3, 2, pisteH + 6);
    // En-garde marks (1/4 and 3/4)
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - w / 4, pisteY - 2, 1, pisteH + 4);
    ctx.fillRect(cx + w / 4, pisteY - 2, 1, pisteH + 4);
}

var _titleTourneyBtn = { x: 0, y: 0, w: 0, h: 0 };
var _titlePracticeBtn = { x: 0, y: 0, w: 0, h: 0 };
var _titleRosterBtn = { x: 0, y: 0, w: 0, h: 0 };
var _titleDiffBtn = { x: 0, y: 0, w: 0, h: 0 };
var _titleSettingsBtn = { x: 0, y: 0, w: 0, h: 0 };

function drawTitle() {
    var p = isPortrait();
    // Scale title type to viewport so very wide canvases don't waste space
    var titleFont = p ? Math.min(40, Math.floor(VIEW_W / 14)) : Math.min(36, Math.floor(VIEW_W / 16));
    var bylineFont = p ? 11 : 8;
    var barH = p ? Math.round(titleFont * 3.0) : Math.round(titleFont * 2.6);
    var btnH = p ? 52 : 36;
    var btnW = p ? Math.min(420, VIEW_W - 60) : 240;
    var btnGap = p ? 12 : 10;

    // Background fill
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Title banner
    ctx.fillStyle = COLOR_BG_DARK;
    ctx.fillRect(0, 0, VIEW_W, barH);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(0, barH - 2, VIEW_W, 2);

    var titleY = barH / 2 - (p ? 10 : 6);
    ctx.font = 'bold ' + titleFont + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillText('PIXEL FENCING', VIEW_W / 2 + 3, titleY + 3);
    ctx.fillStyle = '#fff';
    ctx.fillText('PIXEL FENCING', VIEW_W / 2, titleY);
    ctx.font = bylineFont + 'px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('BY JORGE GONZALEZ MEDINA', VIEW_W / 2, titleY + titleFont / 2 + (p ? 24 : 19));

    // Settings — small button top-LEFT of the banner (out of the title's way)
    var setW = p ? 90 : 80;
    var setH = p ? 28 : 22;
    drawButton(SAFE_X + 10, 10, setW, setH, 'Settings', false);
    _titleSettingsBtn = { x: SAFE_X + 10, y: 10, w: setW, h: setH };

    // Three stacked main buttons + difficulty button at bottom
    var diffBtnH = p ? 32 : 24;
    var totalBtnH = btnH * 3 + btnGap * 2 + diffBtnH + btnGap;
    var btnTopY = VIEW_H - totalBtnH - (p ? 32 : 24);

    // Center the fencer + piste vertically in the space between banner and buttons
    var midSpaceTop = barH;
    var midSpaceBottom = btnTopY;
    var midSpaceCY = Math.round((midSpaceTop + midSpaceBottom) / 2);
    var pisteCY = midSpaceCY + (p ? 30 : 20);
    drawTitlePiste(VIEW_W / 2, pisteCY, p ? Math.min(320, VIEW_W - 80) : 280);

    // Title fencer — favorite if set, else Italy. Feet stand ON the piste centerline.
    var fav = loadFavorite();
    var titleFencer = null;
    if (fav) titleFencer = fencerByCode(fav);
    if (!titleFencer) {
        for (var ti = 0; ti < FENCERS.length; ti++) {
            if (FENCERS[ti].code === 'ITA') { titleFencer = FENCERS[ti]; break; }
        }
    }
    if (!titleFencer && FENCERS.length) titleFencer = FENCERS[0];
    if (titleFencer) {
        var spriteSize = p ? 4.6 : 3.6;
        // drawFencer's `py` is the feet baseline → place feet on the piste's centerline
        drawFencer(VIEW_W / 2, pisteCY, titleFencer, spriteSize, 'right', 'en-garde', 0);
    }

    var pulse = (Math.floor(performance.now() / 500) % 2) === 0;
    var savedTourney = !!loadTournament();
    var tourneyLabel = savedTourney ? 'Continue Tournament' : 'Tournament';
    drawButton(VIEW_W / 2 - btnW / 2, btnTopY, btnW, btnH, tourneyLabel, pulse);
    drawButton(VIEW_W / 2 - btnW / 2, btnTopY + btnH + btnGap, btnW, btnH, 'Practice Bout', false);
    drawButton(VIEW_W / 2 - btnW / 2, btnTopY + (btnH + btnGap) * 2, btnW, btnH, 'Roster', false);
    _titleTourneyBtn = { x: VIEW_W / 2 - btnW / 2, y: btnTopY, w: btnW, h: btnH };
    _titlePracticeBtn = { x: VIEW_W / 2 - btnW / 2, y: btnTopY + btnH + btnGap, w: btnW, h: btnH };
    _titleRosterBtn = { x: VIEW_W / 2 - btnW / 2, y: btnTopY + (btnH + btnGap) * 2, w: btnW, h: btnH };

    var diffY = btnTopY + (btnH + btnGap) * 3;
    var diffW = p ? 220 : 180;
    drawButton(VIEW_W / 2 - diffW / 2, diffY, diffW, diffBtnH,
        'Difficulty: ' + _diffNames[difficulty], false);
    _titleDiffBtn = { x: VIEW_W / 2 - diffW / 2, y: diffY, w: diffW, h: diffBtnH };

    // Compute focus rect from titleFocus
    var titleRects = [_titleTourneyBtn, _titlePracticeBtn, _titleRosterBtn, _titleDiffBtn, _titleSettingsBtn];
    _focusedRect = titleRects[titleFocus] || null;
}

// ── Roster gallery ──
// 4×4 grid of all fencers in en-garde, country code below. Tap one to flip
// it to the lunge pose (toggle). Validates the sprite system end-to-end.
var _rosterBackBtn = { x: 0, y: 0, w: 0, h: 0 };
var _rosterCells = []; // {x, y, w, h, code} for hit-testing

function drawRoster() {
    var p = isPortrait();
    // Background
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawBar('', 'ROSTER', '');

    // Grid: 4 cols × 4 rows = 16
    var cols = 4, rows = 4;
    var topPad = BAR_H + (p ? 24 : 16);
    var bottomBtnH = p ? 44 : 30;
    var bottomPad = bottomBtnH + (p ? 28 : 20);
    var gridH = VIEW_H - topPad - bottomPad;
    var gridW = Math.min(VIEW_W - 24, p ? VIEW_W - 24 : 480);
    var gridX = Math.round((VIEW_W - gridW) / 2);
    var cellW = Math.floor(gridW / cols);
    var cellH = Math.floor(gridH / rows);

    _rosterCells = [];
    for (var i = 0; i < FENCERS.length && i < cols * rows; i++) {
        var col = i % cols;
        var row = Math.floor(i / cols);
        var cx = gridX + col * cellW + cellW / 2;
        var cyTop = topPad + row * cellH;
        var f = FENCERS[i];

        // Cell card
        var cardX = gridX + col * cellW + 4;
        var cardY = cyTop + 2;
        var cardW = cellW - 8;
        var cardH = cellH - 6;
        drawPixelRoundRect(cardX, cardY, cardW, cardH, 3, COLOR_BG_DARK);
        drawPixelRoundRect(cardX + 1, cardY + 1, cardW - 2, cardH - 2, 3, COLOR_BG_LIGHT);

        // Flag chip in top-left
        var flagW = p ? 16 : 13;
        var flagH = p ? 11 : 9;
        drawFlag(cardX + 4, cardY + 4, flagW, flagH, f.code);

        // Sprite — feet sit a bit above the label
        var labelH = p ? 14 : 11;
        var feetY = cardY + cardH - labelH - 6;
        var spriteSize = Math.max(1.4, Math.min(2.8, (cellH - labelH - 24) / 22));
        var pose = rosterFlipped[f.code] ? 'lunge' : 'en-garde';
        drawFencer(cx, feetY, f, spriteSize, 'right', pose, 0);

        // Label
        ctx.font = 'bold ' + (p ? 10 : 8) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(f.code, cx, cardY + cardH - labelH / 2 - 1);

        _rosterCells.push({ x: cardX, y: cardY, w: cardW, h: cardH, code: f.code });
    }

    // Hint
    ctx.font = (p ? 9 : 7) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(_isTouchDevice ? 'TAP A FENCER TO LUNGE' : 'CLICK A FENCER TO LUNGE',
        VIEW_W / 2, VIEW_H - bottomBtnH - (p ? 18 : 12));

    // Back button (bottom-center)
    var backW = p ? 160 : 110;
    var backX = VIEW_W / 2 - backW / 2;
    var backY = VIEW_H - bottomBtnH - 8;
    drawButton(backX, backY, backW, bottomBtnH, 'Back', true);
    _rosterBackBtn = { x: backX, y: backY, w: backW, h: bottomBtnH };

    // Focus rect
    if (rosterFocusIdx >= 0 && rosterFocusIdx < _rosterCells.length) _focusedRect = _rosterCells[rosterFocusIdx];
    else if (rosterFocusIdx === 16) _focusedRect = _rosterBackBtn;
    else _focusedRect = null;
}

// ── Bout rendering ──

// Map a piste meter coordinate to screen X. The piste fills (VIEW_W - 2*margin)
// pixels wide and runs from -PISTE_HALF to +PISTE_HALF meters.
var _pisteMargin = 30;
function pisteX(m) {
    var avail = VIEW_W - 2 * _pisteMargin;
    return _pisteMargin + (m + PISTE_HALF) * (avail / PISTE_LEN);
}
function pisteScale() {
    return (VIEW_W - 2 * _pisteMargin) / PISTE_LEN;
}

function drawPiste(yCenter) {
    var px2m = pisteScale();
    var pisteH = 22;
    var py = yCenter - pisteH / 2;
    var x0 = pisteX(-PISTE_HALF);
    var x1 = pisteX(PISTE_HALF);
    // Strip
    ctx.fillStyle = COLOR_BG_LIGHT;
    ctx.fillRect(x0, py, x1 - x0, pisteH);
    // Top/bottom borders
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0, py, x1 - x0, 1);
    ctx.fillRect(x0, py + pisteH - 1, x1 - x0, 1);
    // Center line (gold)
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillRect(pisteX(0) - 1, py - 4, 2, pisteH + 8);
    // En-garde lines (white, ±2m)
    ctx.fillStyle = '#fff';
    ctx.fillRect(pisteX(-2), py - 2, 1, pisteH + 4);
    ctx.fillRect(pisteX(2),  py - 2, 1, pisteH + 4);
    // Warning lines (±5m, dim)
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(pisteX(-5), py + 2, 1, pisteH - 4);
    ctx.fillRect(pisteX(5),  py + 2, 1, pisteH - 4);
    // Tick marks every meter
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (var m = -PISTE_HALF + 1; m <= PISTE_HALF - 1; m++) {
        if (m === 0 || m === -2 || m === 2 || m === -5 || m === 5) continue;
        ctx.fillRect(pisteX(m), py + pisteH - 3, 1, 2);
    }
}

function fencerPose(f) {
    if (f.act === 'lunge_extend' || f.act === 'lunge_peak') return 'lunge';
    return 'en-garde';
}

function drawScoreRibbon() {
    var p = isPortrait();
    var y = BAR_H + 2;
    var h = p ? 36 : 30;
    ctx.fillStyle = COLOR_BG_DARK;
    ctx.fillRect(0, y, VIEW_W, h);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(0, y + h - 1, VIEW_W, 1);

    var nameFont = p ? 12 : 10;
    var scoreFont = p ? 24 : 20;
    ctx.textBaseline = 'middle';

    // Left fencer — flag + code + score
    drawFlag(SAFE_X + 8, y + h / 2 - 6, 16, 12, bp1.fencer.code);
    ctx.font = 'bold ' + nameFont + 'px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(bp1.fencer.code, SAFE_X + 28, y + h / 2);
    ctx.font = 'bold ' + scoreFont + 'px ' + FONT;
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillText(String(bp1.touches), SAFE_X + 28 + nameFont * 4, y + h / 2 + 1);

    // Right fencer
    drawFlag(VIEW_W - SAFE_X - 24, y + h / 2 - 6, 16, 12, bp2.fencer.code);
    ctx.font = 'bold ' + nameFont + 'px ' + FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.fillText(bp2.fencer.code, VIEW_W - SAFE_X - 28, y + h / 2);
    ctx.font = 'bold ' + scoreFont + 'px ' + FONT;
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillText(String(bp2.touches), VIEW_W - SAFE_X - 28 - nameFont * 4, y + h / 2 + 1);

    // Center: target
    ctx.font = 'bold ' + (p ? 10 : 8) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('FIRST TO ' + BOUT_TARGET, VIEW_W / 2, y + h / 2);
}

function drawPriorityIndicator(yCenter) {
    if (boutAttacker === 0) return;
    var f = boutAttacker === 1 ? bp1 : bp2;
    var x = pisteX(f.pos);
    var arrowY = yCenter - 38;
    ctx.fillStyle = COLOR_GOLD;
    ctx.font = 'bold 8px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var label = boutSimul ? 'SIMUL' : 'PRIORITY';
    ctx.fillText(label, x, arrowY - 6);
    // Arrow
    ctx.beginPath();
    ctx.moveTo(x - 5, arrowY);
    ctx.lineTo(x + 5, arrowY);
    ctx.lineTo(x, arrowY + 6);
    ctx.closePath();
    ctx.fill();
}

function drawFencerOnPiste(f, yFeet, spriteSize) {
    var sx = pisteX(f.pos);
    // Touched flash — red ring
    if (f.act === 'touched' && f.flash > 0) {
        var alpha = Math.min(1, f.flash / 600);
        ctx.fillStyle = 'rgba(255,80,80,' + (alpha * 0.7) + ')';
        ctx.beginPath();
        ctx.arc(sx, yFeet - 18, 28, 0, Math.PI * 2);
        ctx.fill();
    }
    // Parry flash — cyan flicker
    if ((f.act === 'parry' || f.act === 'parry_recover') && f.flash > 0) {
        var pa = Math.min(1, f.flash / 350);
        ctx.fillStyle = 'rgba(180,230,255,' + (pa * 0.55) + ')';
        ctx.beginPath();
        ctx.arc(sx, yFeet - 18, 22, 0, Math.PI * 2);
        ctx.fill();
    }
    // Animation knobs
    var bladeExt = 0;
    if (f.act === 'lunge_extend') {
        // Progress 0→1 over the extend phase
        bladeExt = 1 - (f.actT / T_LUNGE_EXTEND);
    } else if (f.act === 'lunge_recover') {
        // Reverse blade extension on recovery (en-garde sprite, blade pulls in)
        bladeExt = Math.max(0, f.actT / T_LUNGE_RECOVER * 0.6);
    }
    // Footwork bob — only when actively moving in idle state
    var keys = (f.side === 1) ? bp1Keys : bp2Keys;
    var moving = (f.act === 'idle') && (keys.advance || keys.retreat);
    var bobFrame = moving ? Math.floor(performance.now() / 160) : 0;
    drawFencer(sx, yFeet, f.fencer, spriteSize, f.facing, fencerPose(f), 0,
        { bladeExt: bladeExt, bobFrame: bobFrame });
    // Parry visual: vertical raised blade overlay
    if (f.act === 'parry') {
        var bx = sx + (f.facing === 'right' ? 8 : -8);
        ctx.fillStyle = '#dddddd';
        ctx.fillRect(bx - 1, yFeet - 38, 2, 18);
        ctx.fillStyle = COLOR_GOLD;
        ctx.fillRect(bx - 2, yFeet - 22, 4, 2);
    }
}

function drawBoutMessage(yCenter) {
    if (!boutMsg || boutMsgT <= 0) return;
    var p = isPortrait();
    var fontSize = p ? 22 : 18;
    ctx.font = 'bold ' + fontSize + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var w = ctx.measureText(boutMsg).width + 24;
    var h = fontSize + 14;
    var bx = Math.round(VIEW_W / 2 - w / 2);
    var by = Math.round(yCenter - h / 2 - 60);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(bx, by, w, h);
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillRect(bx, by, w, 2);
    ctx.fillRect(bx, by + h - 2, w, 2);
    ctx.fillStyle = '#fff';
    ctx.fillText(boutMsg, VIEW_W / 2, by + h / 2 + 1);
}

// Touch button hit-rects for the bout — set by drawBoutTouchControls
var _btnRetreat = { x:0, y:0, w:0, h:0 };
var _btnAdvance = { x:0, y:0, w:0, h:0 };
var _btnLunge   = { x:0, y:0, w:0, h:0 };
var _btnParry   = { x:0, y:0, w:0, h:0 };
var _btnQuit    = { x:0, y:0, w:0, h:0 };

function drawBoutTouchControls() {
    // 4-button layout at the bottom of the bout screen, plus a small Quit
    // button in the top-right of the score ribbon area.
    var p = isPortrait();
    var pad = p ? 10 : 8;
    var btnH = p ? 56 : 44;
    var areaY = VIEW_H - btnH - pad;
    var groupGap = p ? 12 : 10;
    var pairW = (VIEW_W - pad * 2 - groupGap) / 2;
    var btnW = (pairW - pad) / 2;
    // Left pair (movement)
    var lx = pad;
    drawButton(lx, areaY, btnW, btnH, '\u2190', false);
    _btnRetreat = { x: lx, y: areaY, w: btnW, h: btnH };
    drawButton(lx + btnW + pad, areaY, btnW, btnH, '\u2192', false);
    _btnAdvance = { x: lx + btnW + pad, y: areaY, w: btnW, h: btnH };
    // Right pair (combat) — Lunge (primary, gold), Parry (secondary)
    var rx = pad + pairW + groupGap;
    drawButton(rx, areaY, btnW, btnH, 'PARRY', false);
    _btnParry = { x: rx, y: areaY, w: btnW, h: btnH };
    drawButton(rx + btnW + pad, areaY, btnW, btnH, 'LUNGE', true);
    _btnLunge = { x: rx + btnW + pad, y: areaY, w: btnW, h: btnH };
    // Quit (small, top-right)
    var qW = p ? 50 : 42;
    var qH = p ? 22 : 18;
    drawButton(VIEW_W - qW - 8 - SAFE_X, BAR_H + 6, qW, qH, 'Quit', false);
    _btnQuit = { x: VIEW_W - qW - 8 - SAFE_X, y: BAR_H + 6, w: qW, h: qH };
}

function drawBoutControlsHint(yBottom) {
    if (_isTouchDevice) { drawBoutTouchControls(); return; }
    if (isPortrait()) return;
    ctx.font = '7px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('\u2190 \u2192 MOVE      \u2191 LUNGE      \u2193 PARRY      ESC QUIT',
        VIEW_W / 2, yBottom);
}

function drawCrowd(yTop, height) {
    // Crowd: rows of small mask-shaped pixel heads in dim colors. Bobs slightly
    // every 600ms by shifting alternating columns up/down 1px.
    var bgEnd = yTop + height;
    // Stand background — gradient via banded fills
    ctx.fillStyle = '#0a1f3a';
    ctx.fillRect(0, yTop, VIEW_W, height);
    ctx.fillStyle = '#0e2a4a';
    ctx.fillRect(0, yTop + height - 4, VIEW_W, 4);

    var rowSpacing = 7;
    var colSpacing = 8;
    var rows = Math.max(2, Math.floor((height - 6) / rowSpacing));
    var cols = Math.ceil(VIEW_W / colSpacing) + 1;
    var palette = ['#5d6c8a', '#4a5874', '#5b6c8a', '#6f7d99', '#3d4a64',
                   '#7c5c4a', '#5a4030', '#8a6450']; // muted dim civilian tones
    var bobFrame = Math.floor(performance.now() / 600);
    for (var rr = 0; rr < rows; rr++) {
        var ry = yTop + 4 + rr * rowSpacing;
        // Stagger every other row by half a column
        var stagger = (rr % 2) * (colSpacing / 2);
        for (var cc = 0; cc < cols; cc++) {
            var cx = Math.floor(cc * colSpacing - stagger);
            if (cx < -4 || cx > VIEW_W) continue;
            // Deterministic seed per (row,col)
            var seed = ((rr + 1) * 31 + (cc + 1) * 17) & 0xff;
            var col = palette[seed % palette.length];
            var bob = ((seed + bobFrame) % 3 === 0) ? -1 : 0;
            // Head: 3x3 block with darker outline below
            ctx.fillStyle = col;
            ctx.fillRect(cx, ry + bob, 4, 3);
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.fillRect(cx, ry + bob + 3, 4, 1);
        }
    }
    // Front rail
    ctx.fillStyle = '#1a3050';
    ctx.fillRect(0, bgEnd - 2, VIEW_W, 2);
}

function drawBout() {
    var p = isPortrait();
    // Background
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // Crowd
    var crowdTop = BAR_H + 36, crowdH = 60;
    drawCrowd(crowdTop, crowdH);

    drawBar('PIXEL FENCING', '', '');
    drawScoreRibbon();

    // Piste sits in lower-middle of canvas
    var pisteY = p ? Math.round(VIEW_H * 0.62) : Math.round(VIEW_H * 0.65);
    drawPiste(pisteY);

    var spriteSize = p ? 4 : 3.6;
    drawFencerOnPiste(bp1, pisteY, spriteSize);
    drawFencerOnPiste(bp2, pisteY, spriteSize);

    drawPriorityIndicator(pisteY);
    drawBoutMessage(pisteY);
    drawBoutControlsHint(VIEW_H - 14);

    // Result overlay
    if (state === S_BOUT_RESULT) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        ctx.font = 'bold ' + (p ? 22 : 18) + 'px ' + FONT;
        ctx.fillStyle = COLOR_GOLD;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(boutMsg, VIEW_W / 2, VIEW_H / 2 - 30);
        ctx.font = 'bold ' + (p ? 16 : 13) + 'px ' + FONT;
        ctx.fillStyle = '#fff';
        ctx.fillText(bp1.touches + ' — ' + bp2.touches, VIEW_W / 2, VIEW_H / 2 + 4);
        var btnW = p ? 200 : 160;
        var btnH = p ? 44 : 32;
        var btnY = VIEW_H / 2 + 36;
        drawButton(VIEW_W / 2 - btnW / 2, btnY, btnW, btnH, 'Back to Title', true);
        _boutResultBtn = { x: VIEW_W / 2 - btnW / 2, y: btnY, w: btnW, h: btnH };
    }
}
var _boutResultBtn = { x: 0, y: 0, w: 0, h: 0 };

// ── Fencer-select carousel ──
//
// Grid of all 16 fencers; click one to confirm. Used at the start of a new
// tournament. Re-uses the roster grid layout but with a "Confirm" footer
// button that takes the highlighted fencer.
//
var fsHighlightCode = '';
var _fsCells = [];
var _fsConfirmBtn = { x:0, y:0, w:0, h:0 };
var _fsBackBtn = { x:0, y:0, w:0, h:0 };

function drawFencerSelect() {
    var p = isPortrait();
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawBar('PICK YOUR FENCER', '', _diffNames[difficulty]);

    var cols = 4, rows = 4;
    var topPad = BAR_H + (p ? 20 : 14);
    var bottomBtnH = p ? 44 : 30;
    var bottomPad = bottomBtnH + (p ? 28 : 18);
    var gridH = VIEW_H - topPad - bottomPad;
    var gridW = Math.min(VIEW_W - 24, p ? VIEW_W - 24 : 480);
    var gridX = Math.round((VIEW_W - gridW) / 2);
    var cellW = Math.floor(gridW / cols);
    var cellH = Math.floor(gridH / rows);

    _fsCells = [];
    for (var i = 0; i < FENCERS.length && i < cols * rows; i++) {
        var col = i % cols;
        var row = Math.floor(i / cols);
        var f = FENCERS[i];
        var cardX = gridX + col * cellW + 4;
        var cardY = topPad + row * cellH + 2;
        var cardW = cellW - 8;
        var cardH = cellH - 6;
        var highlighted = (f.code === fsHighlightCode);
        // Card border
        var borderColor = highlighted ? COLOR_GOLD : COLOR_BG_DARK;
        drawPixelRoundRect(cardX, cardY, cardW, cardH, 3, borderColor);
        drawPixelRoundRect(cardX + 1, cardY + 1, cardW - 2, cardH - 2, 3, COLOR_BG_LIGHT);

        // Flag chip top-left
        var flagW = p ? 16 : 13;
        var flagH = p ? 11 : 9;
        drawFlag(cardX + 4, cardY + 4, flagW, flagH, f.code);

        var labelH = p ? 14 : 11;
        var feetY = cardY + cardH - labelH - 6;
        var spriteSize = Math.max(1.4, Math.min(2.8, (cellH - labelH - 24) / 22));
        drawFencer(cardX + cardW / 2, feetY, f, spriteSize, 'right', 'en-garde', 0);

        ctx.font = 'bold ' + (p ? 10 : 8) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = highlighted ? COLOR_GOLD : '#fff';
        ctx.fillText(f.code, cardX + cardW / 2, cardY + cardH - labelH / 2 - 1);

        // Strength stars on top-right
        ctx.font = (p ? 7 : 6) + 'px ' + FONT;
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(f.strength + '*', cardX + cardW - 4, cardY + 9);

        _fsCells.push({ x: cardX, y: cardY, w: cardW, h: cardH, code: f.code });
    }

    // Footer: Back + Confirm
    var btnY = VIEW_H - bottomBtnH - 8;
    var btnW = p ? 140 : 110;
    drawButton(SAFE_X + 12, btnY, btnW, bottomBtnH, 'Back', false);
    _fsBackBtn = { x: SAFE_X + 12, y: btnY, w: btnW, h: bottomBtnH };
    var confirmEnabled = !!fsHighlightCode;
    drawButton(VIEW_W - SAFE_X - btnW - 12, btnY, btnW, bottomBtnH,
        confirmEnabled ? 'Start' : 'Pick One', confirmEnabled);
    _fsConfirmBtn = { x: VIEW_W - SAFE_X - btnW - 12, y: btnY, w: btnW, h: bottomBtnH };

    // Focus rect
    if (fsFocusIdx >= 0 && fsFocusIdx < _fsCells.length) _focusedRect = _fsCells[fsFocusIdx];
    else if (fsFocusIdx === 16) _focusedRect = _fsBackBtn;
    else if (fsFocusIdx === 17) _focusedRect = _fsConfirmBtn;
    else _focusedRect = null;
}

// ── Bracket view ──
//
// Lists current round's pairings; player's match highlighted. After all CPU
// matches in a round are sim'd, the bracket displays the resolved winners and
// a "Continue" button advances to the next round.
//
var _bracketBtn = { x:0, y:0, w:0, h:0 };
var _bracketBackBtn = { x:0, y:0, w:0, h:0 };

function drawBracket() {
    var p = isPortrait();
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    var roundLabel = ROUND_NAMES[Math.min(tournament.roundIdx, ROUND_NAMES.length - 1)] || 'ROUND';
    drawBar(roundLabel, '', _diffNames[difficulty]);

    var round = tournament.rounds[tournament.roundIdx];
    var topPad = BAR_H + (p ? 18 : 14);
    var bottomBtnH = p ? 44 : 32;
    var listY = topPad;
    var listW = Math.min(VIEW_W - 30, 420);
    var listX = Math.round((VIEW_W - listW) / 2);
    var rowH = Math.max(p ? 36 : 26, Math.floor((VIEW_H - topPad - bottomBtnH - 30) / Math.max(1, round.length)));
    if (rowH > 50) rowH = 50;

    for (var i = 0; i < round.length; i++) {
        var m = round[i];
        var ry = listY + i * rowH;
        var bgColor = m.playerInvolved ? COLOR_GOLD : '#fff';
        drawPixelRoundRect(listX, ry, listW, rowH - 4, 3, bgColor);
        var fillColor = m.playerInvolved ? COLOR_BG_DARK : COLOR_BG_LIGHT;
        drawPixelRoundRect(listX + 2, ry + 2, listW - 4, rowH - 8, 3, fillColor);

        ctx.font = 'bold ' + (p ? 11 : 9) + 'px ' + FONT;
        ctx.textBaseline = 'middle';
        var midY = ry + (rowH - 4) / 2;

        // Left fencer
        var aColor = (m.played && m.winner === m.b) ? 'rgba(255,255,255,0.4)' : '#fff';
        ctx.textAlign = 'left';
        ctx.fillStyle = m.a.colors[0];
        ctx.fillRect(listX + 10, midY - 5, 4, 10);
        ctx.fillStyle = aColor;
        ctx.fillText(m.a.code, listX + 18, midY);
        // Right fencer
        ctx.textAlign = 'right';
        var bColor = (m.played && m.winner === m.a) ? 'rgba(255,255,255,0.4)' : '#fff';
        ctx.fillStyle = m.b.colors[0];
        ctx.fillRect(listX + listW - 14, midY - 5, 4, 10);
        ctx.fillStyle = bColor;
        ctx.fillText(m.b.code, listX + listW - 22, midY);
        // Score in middle
        ctx.textAlign = 'center';
        if (m.played) {
            ctx.fillStyle = COLOR_GOLD;
            ctx.fillText(m.scoreA + '-' + m.scoreB, listX + listW / 2, midY);
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.fillText('VS', listX + listW / 2, midY);
        }
    }

    // Footer button — context dependent
    var btnY = VIEW_H - bottomBtnH - 8;
    var btnW = p ? 220 : 180;
    var label, primary;
    var pIdx = findPlayerMatch(tournament);
    if (pIdx >= 0) {
        label = 'Play Match';
        primary = true;
    } else {
        // No player match left in round → if all played, advance; else "wait" (shouldn't happen)
        var allPlayed = true;
        for (var ai2 = 0; ai2 < round.length; ai2++) if (!round[ai2].played) { allPlayed = false; break; }
        if (allPlayed) {
            if (tournament.playerEliminated) { label = 'Continue'; primary = true; }
            else if (round.length === 1) { label = 'Crown Champion'; primary = true; }
            else { label = 'Next Round'; primary = true; }
        } else {
            label = 'Sim CPU';
            primary = true;
        }
    }
    drawButton(VIEW_W / 2 - btnW / 2, btnY, btnW, bottomBtnH, label, primary);
    _bracketBtn = { x: VIEW_W / 2 - btnW / 2, y: btnY, w: btnW, h: bottomBtnH };
    // Back-to-title (small, top-left)
    drawButton(SAFE_X + 8, btnY, p ? 80 : 70, bottomBtnH, 'Quit', false);
    _bracketBackBtn = { x: SAFE_X + 8, y: btnY, w: p ? 80 : 70, h: bottomBtnH };

    _focusedRect = (bracketFocus === 0) ? _bracketBackBtn : _bracketBtn;
}

// ── Match intro ──
//
// Shown before each player match: round name, both fencers facing each other,
// "Press Start" to begin the bout.
//
var _matchIntroBtn = { x:0, y:0, w:0, h:0 };
var _matchIntroOpponent = null;

function drawMatchIntro() {
    var p = isPortrait();
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    var roundLabel = ROUND_NAMES[Math.min(tournament.roundIdx, ROUND_NAMES.length - 1)] || '';
    drawBar(roundLabel, '', _diffNames[difficulty]);

    var pIdx = findPlayerMatch(tournament);
    if (pIdx < 0) return;
    var match = tournament.rounds[tournament.roundIdx][pIdx];
    var playerFencer, opponent, playerLeft;
    if (match.a.code === tournament.playerCode) {
        playerFencer = match.a; opponent = match.b; playerLeft = true;
    } else {
        playerFencer = match.b; opponent = match.a; playerLeft = false;
    }
    _matchIntroOpponent = opponent;

    // Big "VS" layout
    var titleY = BAR_H + (p ? 50 : 40);
    ctx.font = 'bold ' + (p ? 18 : 14) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillText(roundLabel, VIEW_W / 2, titleY);

    var spriteY = Math.round(VIEW_H * 0.55);
    var spriteSize = p ? 5 : 4.4;
    // Player on left, opponent on right (visually)
    var leftX = Math.round(VIEW_W * 0.28);
    var rightX = Math.round(VIEW_W * 0.72);
    // Flags above the sprites
    var flagW = p ? 36 : 28;
    var flagH = p ? 24 : 19;
    drawFlag(leftX - flagW / 2, spriteY - 110, flagW, flagH, playerFencer.code);
    drawFlag(rightX - flagW / 2, spriteY - 110, flagW, flagH, opponent.code);
    drawFencer(leftX, spriteY, playerFencer, spriteSize, 'right', 'en-garde', 0);
    drawFencer(rightX, spriteY, opponent, spriteSize, 'left', 'en-garde', 0);

    // VS in middle
    ctx.font = 'bold ' + (p ? 28 : 22) + 'px ' + FONT;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillText('VS', VIEW_W / 2 + 2, spriteY - 18 + 2);
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillText('VS', VIEW_W / 2, spriteY - 18);

    // Names below sprites
    ctx.font = 'bold ' + (p ? 13 : 10) + 'px ' + FONT;
    ctx.fillStyle = '#fff';
    ctx.fillText(playerFencer.name.toUpperCase(), leftX, spriteY + 14);
    ctx.fillText(opponent.name.toUpperCase(), rightX, spriteY + 14);
    // Strength stars
    ctx.font = (p ? 9 : 7) + 'px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('*'.repeat(playerFencer.strength), leftX, spriteY + 28);
    ctx.fillText('*'.repeat(opponent.strength), rightX, spriteY + 28);

    // Start button
    var btnH = p ? 50 : 36;
    var btnW = p ? 240 : 200;
    var btnY = VIEW_H - btnH - (p ? 24 : 16);
    var pulse = (Math.floor(performance.now() / 500) % 2) === 0;
    drawButton(VIEW_W / 2 - btnW / 2, btnY, btnW, btnH, 'Fence!', pulse);
    _matchIntroBtn = { x: VIEW_W / 2 - btnW / 2, y: btnY, w: btnW, h: btnH };
    _focusedRect = _matchIntroBtn;
}

// ── Champion / Game Over ──
var _endScreenBtn = { x:0, y:0, w:0, h:0 };

function drawChampion() {
    var p = isPortrait();
    ctx.fillStyle = COLOR_BG_DARK;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawBar('CHAMPION', '', '');

    if (!tournament || !tournament.champion) return;
    var champ = tournament.champion;

    ctx.font = 'bold ' + (p ? 26 : 22) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillText('CHAMPION!', VIEW_W / 2, BAR_H + (p ? 60 : 48));

    var spriteY = Math.round(VIEW_H * 0.58);
    var spriteSize = p ? 7 : 6;
    drawFencer(VIEW_W / 2, spriteY, champ, spriteSize, 'right', 'lunge', 0);

    ctx.font = 'bold ' + (p ? 16 : 12) + 'px ' + FONT;
    ctx.fillStyle = '#fff';
    ctx.fillText(champ.name.toUpperCase(), VIEW_W / 2, spriteY + 18);

    // Confetti above everything except button
    drawConfetti();

    // Button
    var btnH = p ? 48 : 34;
    var btnW = p ? 240 : 180;
    var btnY = VIEW_H - btnH - (p ? 24 : 16);
    drawButton(VIEW_W / 2 - btnW / 2, btnY, btnW, btnH, 'Title', true);
    _endScreenBtn = { x: VIEW_W / 2 - btnW / 2, y: btnY, w: btnW, h: btnH };
    _focusedRect = _endScreenBtn;
}

function drawGameOver() {
    var p = isPortrait();
    ctx.fillStyle = COLOR_BG_DARK;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawBar('ELIMINATED', '', '');

    ctx.font = 'bold ' + (p ? 26 : 22) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#cc4444';
    ctx.fillText('ELIMINATED', VIEW_W / 2, BAR_H + (p ? 60 : 48));

    if (tournament) {
        var roundLabel = ROUND_NAMES[Math.min(tournament.roundIdx, ROUND_NAMES.length - 1)];
        ctx.font = (p ? 12 : 10) + 'px ' + FONT;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText('OUT IN THE ' + roundLabel, VIEW_W / 2, BAR_H + (p ? 90 : 72));

        // Show champion if known
        if (tournament.champion) {
            ctx.font = (p ? 11 : 9) + 'px ' + FONT;
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.fillText('CHAMPION: ' + tournament.champion.name.toUpperCase(),
                VIEW_W / 2, VIEW_H / 2 + 20);
        }
    }

    var btnH = p ? 48 : 34;
    var btnW = p ? 240 : 180;
    var btnY = VIEW_H - btnH - (p ? 24 : 16);
    drawButton(VIEW_W / 2 - btnW / 2, btnY, btnW, btnH, 'Title', true);
    _endScreenBtn = { x: VIEW_W / 2 - btnW / 2, y: btnY, w: btnW, h: btnH };
    _focusedRect = _endScreenBtn;
}

function draw() {
    ctx.save();
    ctx.scale(SCALE, SCALE);
    ctx.imageSmoothingEnabled = false;
    _focusedRect = null;
    if (state === S_TITLE) drawTitle();
    else if (state === S_ROSTER) drawRoster();
    else if (state === S_FENCER_SELECT) drawFencerSelect();
    else if (state === S_BRACKET) drawBracket();
    else if (state === S_MATCH_INTRO) drawMatchIntro();
    else if (state === S_CHAMPION) drawChampion();
    else if (state === S_GAME_OVER) drawGameOver();
    else if (state === S_BOUT_INTRO || state === S_BOUT_PLAY ||
             state === S_BOUT_HALT || state === S_BOUT_RESULT) drawBout();
    if (tutorialVisible) drawTutorial();
    if (settingsVisible) drawSettings();
    drawFocusBorder();
    ctx.restore();
}

// ── Input / navigation ──
function ensureAudioStarted() {
    initAudio();
    if (!soundOn) { soundOn = true; musicOn = true; saveSoundSettings(); setTrack('menu'); }
}

function enterRoster() {
    ensureAudioStarted();
    sfxBlade();
    rosterFocusIdx = 0;
    state = S_ROSTER;
    dirty = true;
}

function exitRoster() {
    sfxBlade();
    state = S_TITLE;
    dirty = true;
}

function enterPracticeBout() {
    ensureAudioStarted();
    sfxBlade();
    boutContext = 'practice';
    fsHighlightCode = loadFavorite() || (FENCERS[0] && FENCERS[0].code) || '';
    // Sync focus to highlight
    fsFocusIdx = 0;
    for (var i = 0; i < FENCERS.length; i++) if (FENCERS[i].code === fsHighlightCode) { fsFocusIdx = i; break; }
    state = S_FENCER_SELECT;
    dirty = true;
}

function enterTournament() {
    ensureAudioStarted();
    sfxBlade();
    boutContext = 'tournament';
    // Resume saved tournament if present, else go to fencer select
    var saved = loadTournament();
    if (saved) {
        tournament = saved;
        // If player was eliminated, go to game over; else bracket
        if (tournament.playerEliminated) state = S_GAME_OVER;
        else if (tournament.champion && tournament.champion.code === tournament.playerCode) state = S_CHAMPION;
        else state = S_BRACKET;
    } else {
        fsHighlightCode = loadFavorite() || (FENCERS[0] && FENCERS[0].code) || '';
        fsFocusIdx = 0;
        for (var i = 0; i < FENCERS.length; i++) if (FENCERS[i].code === fsHighlightCode) { fsFocusIdx = i; break; }
        state = S_FENCER_SELECT;
    }
    dirty = true;
}

function confirmFencerSelect() {
    if (!fsHighlightCode) return;
    saveFavorite(fsHighlightCode);
    sfxBlade();
    if (boutContext === 'tournament') {
        tournament = newTournament(fsHighlightCode);
        saveTournament();
        state = S_BRACKET;
        dirty = true;
    } else {
        // Practice — pick a random opponent that isn't the player
        var opp = null;
        var pool = [];
        for (var i = 0; i < FENCERS.length; i++) if (FENCERS[i].code !== fsHighlightCode) pool.push(FENCERS[i]);
        opp = pool[Math.floor(Math.random() * pool.length)] || FENCERS[0];
        var player = fencerByCode(fsHighlightCode);
        startBout(player, opp);
    }
}

function startPlayerMatchFromBracket() {
    var pIdx = findPlayerMatch(tournament);
    if (pIdx < 0) return;
    state = S_MATCH_INTRO;
    dirty = true;
}

function bracketContinue() {
    var round = tournament.rounds[tournament.roundIdx];
    var pIdx = findPlayerMatch(tournament);
    if (pIdx >= 0) {
        startPlayerMatchFromBracket();
        return;
    }
    // No player match → finish CPU matches and advance
    simulateRemainingMatches(tournament);
    saveTournament();
    var allPlayed = true;
    for (var i = 0; i < round.length; i++) if (!round[i].played) { allPlayed = false; break; }
    if (allPlayed) {
        if (round.length === 1) {
            // Final complete
            buildNextRound(tournament);
            saveTournament();
            if (tournament.champion && tournament.champion.code === tournament.playerCode) {
                state = S_CHAMPION;
            } else if (tournament.playerEliminated) {
                state = S_GAME_OVER;
            } else {
                // Player not eliminated and not champion shouldn't really happen at final, but safe default
                state = S_CHAMPION;
            }
        } else {
            buildNextRound(tournament);
            saveTournament();
        }
    }
    dirty = true;
}

function startMatchIntroBout() {
    var pIdx = findPlayerMatch(tournament);
    if (pIdx < 0) return;
    var match = tournament.rounds[tournament.roundIdx][pIdx];
    var playerFencer, opponent;
    if (match.a.code === tournament.playerCode) { playerFencer = match.a; opponent = match.b; }
    else { playerFencer = match.b; opponent = match.a; }
    startBout(playerFencer, opponent);
}

function finishTournamentMatch() {
    // Called when bout result is shown for a tournament bout. Records the
    // result into the bracket, simulates remaining CPU matches, and either
    // ends the tournament or returns to bracket.
    var pIdx = findPlayerMatch(tournament);
    if (pIdx < 0) return;
    var match = tournament.rounds[tournament.roundIdx][pIdx];
    var playerWon, playerScore, oppScore;
    if (match.a.code === tournament.playerCode) {
        match.scoreA = bp1.touches; match.scoreB = bp2.touches;
        playerWon = bp1.touches > bp2.touches;
        match.winner = playerWon ? match.a : match.b;
    } else {
        match.scoreA = bp2.touches; match.scoreB = bp1.touches;
        playerWon = bp1.touches > bp2.touches;
        match.winner = playerWon ? match.b : match.a;
    }
    match.played = true;
    if (!playerWon) tournament.playerEliminated = true;
    simulateRemainingMatches(tournament);
    var round = tournament.rounds[tournament.roundIdx];
    var allPlayed = true;
    for (var i = 0; i < round.length; i++) if (!round[i].played) { allPlayed = false; break; }
    if (allPlayed && round.length > 1) {
        buildNextRound(tournament);
    } else if (allPlayed && round.length === 1) {
        // Just finished the final
        if (!tournament.champion) tournament.champion = round[0].winner;
    }
    saveTournament();
}

function exitBout() {
    sfxBlade();
    ai = null;
    if (musicOn) { currentTrack = null; setTrack('menu'); }
    if (boutContext === 'tournament' && tournament) {
        // Mid-bout quit — preserve tournament, return to bracket
        state = S_BRACKET;
    } else {
        state = S_TITLE;
    }
    dirty = true;
}

function endScreenContinue() {
    sfxBlade();
    clearTournament();
    state = S_TITLE;
    if (musicOn) { currentTrack = null; setTrack('menu'); }
    dirty = true;
}

function pointInRect(pt, rect) {
    return pt.x >= rect.x && pt.x <= rect.x + rect.w && pt.y >= rect.y && pt.y <= rect.y + rect.h;
}

function onPointerDown(e) {
    if (e.preventDefault) e.preventDefault();
    var pt = canvasCoords(e);
    if (pt.x < 0) return;

    // Modal overlays take input first
    if (settingsVisible) {
        if (settingsConfirmDelete === 0) {
            if (pointInRect(pt, _settingsRects.sound))    { toggleSoundSetting(); return; }
            if (pointInRect(pt, _settingsRects.music))    { toggleMusicSetting(); return; }
            if (pointInRect(pt, _settingsRects.tutorial)) { settingsVisible = false; openTutorial(); return; }
            if (pointInRect(pt, _settingsRects.del))      { settingsConfirmDelete = 1; sfxBlade(); dirty = true; return; }
            if (pointInRect(pt, _settingsRects.close))    { closeSettings(); return; }
        } else {
            if (pointInRect(pt, _settingsRects.confirmDel)) {
                if (settingsConfirmDelete === 1) { settingsConfirmDelete = 2; sfxBlade(); dirty = true; }
                else { deleteAllData(); }
                return;
            }
            if (pointInRect(pt, _settingsRects.cancelDel)) { settingsConfirmDelete = 0; sfxBlade(); dirty = true; return; }
        }
        return;
    }
    if (tutorialVisible) {
        if (pointInRect(pt, _tutorialBtn)) { closeTutorial(); return; }
        return;
    }

    if (state === S_TITLE) {
        if (pointInRect(pt, _titleSettingsBtn)) { openSettings(); return; }
        if (pointInRect(pt, _titleTourneyBtn))  { enterTournament(); return; }
        if (pointInRect(pt, _titlePracticeBtn)) { enterPracticeBout(); return; }
        if (pointInRect(pt, _titleRosterBtn))   { enterRoster(); return; }
        if (pointInRect(pt, _titleDiffBtn))     { cycleDifficulty(); return; }
        ensureAudioStarted();
        return;
    }
    if (state === S_ROSTER) {
        if (pointInRect(pt, _rosterBackBtn)) { exitRoster(); return; }
        for (var i = 0; i < _rosterCells.length; i++) {
            if (pointInRect(pt, _rosterCells[i])) {
                var code = _rosterCells[i].code;
                rosterFlipped[code] = !rosterFlipped[code];
                sfxBlade();
                dirty = true;
                return;
            }
        }
        return;
    }
    if (state === S_FENCER_SELECT) {
        if (pointInRect(pt, _fsBackBtn)) { state = S_TITLE; sfxBlade(); dirty = true; return; }
        if (pointInRect(pt, _fsConfirmBtn)) { confirmFencerSelect(); return; }
        for (var fi = 0; fi < _fsCells.length; fi++) {
            if (pointInRect(pt, _fsCells[fi])) {
                fsHighlightCode = _fsCells[fi].code;
                sfxBlade();
                dirty = true;
                return;
            }
        }
        return;
    }
    if (state === S_BRACKET) {
        if (pointInRect(pt, _bracketBackBtn)) {
            // Quit to title (tournament stays saved)
            sfxBlade();
            state = S_TITLE; dirty = true;
            return;
        }
        if (pointInRect(pt, _bracketBtn)) { sfxBlade(); bracketContinue(); return; }
        return;
    }
    if (state === S_MATCH_INTRO) {
        if (pointInRect(pt, _matchIntroBtn)) { sfxBlade(); startMatchIntroBout(); return; }
        return;
    }
    if (state === S_BOUT_RESULT) {
        if (pointInRect(pt, _boutResultBtn)) {
            if (boutContext === 'tournament' && tournament) {
                if (tournament.playerEliminated) { state = S_GAME_OVER; sfxDefeat(); }
                else if (tournament.champion && tournament.champion.code === tournament.playerCode) {
                    state = S_CHAMPION; sfxVictory();
                    spawnConfetti(tournament.champion.colors);
                }
                else { state = S_BRACKET; sfxBlade(); }
                if (musicOn) { currentTrack = null; setTrack('menu'); }
                dirty = true;
            } else {
                exitBout();
            }
            return;
        }
        return;
    }
    if (state === S_CHAMPION || state === S_GAME_OVER) {
        if (pointInRect(pt, _endScreenBtn)) { endScreenContinue(); return; }
        return;
    }
    if (state === S_BOUT_PLAY && _isTouchDevice) {
        if (pointInRect(pt, _btnQuit))    { exitBout(); return; }
        if (pointInRect(pt, _btnLunge))   { startLunge(bp1, bp2); return; }
        if (pointInRect(pt, _btnParry))   { startParry(bp1, bp2); return; }
        if (pointInRect(pt, _btnRetreat)) { bp1Keys.retreat = true; bp1Keys.advance = false; return; }
        if (pointInRect(pt, _btnAdvance)) { bp1Keys.advance = true; bp1Keys.retreat = false; return; }
    }
}

function onPointerUp(e) {
    if (state === S_BOUT_PLAY && _isTouchDevice) {
        // Touch ended — release any held movement
        bp1Keys.advance = false;
        bp1Keys.retreat = false;
    }
}

// Helpers for grid navigation in 4-col layouts
function gridMove(idx, dir, cols, total, footerCount) {
    // dir: 'up'|'down'|'left'|'right'
    // total = grid count (e.g. 16). footerCount = N footer buttons appended at indices [total..total+footerCount-1]
    if (idx >= total) {
        // In footer
        var fIdx = idx - total;
        if (dir === 'up') return total - cols + 0; // jump to last row, leftmost
        if (dir === 'left' && fIdx > 0) return idx - 1;
        if (dir === 'right' && fIdx < footerCount - 1) return idx + 1;
        return idx;
    }
    var col = idx % cols;
    var row = Math.floor(idx / cols);
    if (dir === 'left')  return (col > 0) ? idx - 1 : idx;
    if (dir === 'right') return (col < cols - 1 && idx + 1 < total) ? idx + 1 : idx;
    if (dir === 'up')    return (row > 0) ? idx - cols : idx;
    if (dir === 'down') {
        if (idx + cols < total) return idx + cols;
        // From bottom row, drop into footer (first footer button)
        if (footerCount > 0) return total;
        return idx;
    }
    return idx;
}

function onKeyDown(e) {
    // Modal overlays first
    if (settingsVisible) {
        if (e.key === 'Tab') {
            e.preventDefault();
            var max = (settingsConfirmDelete === 0) ? SETTINGS_FOCUS_COUNT : 2;
            settingsFocus = (settingsFocus + (e.shiftKey ? -1 : 1) + max) % max;
            dirty = true;
            return;
        }
        if (e.key === 'ArrowUp')   { var m = (settingsConfirmDelete === 0) ? SETTINGS_FOCUS_COUNT : 2; settingsFocus = (settingsFocus - 1 + m) % m; dirty = true; e.preventDefault(); return; }
        if (e.key === 'ArrowDown') { var m2 = (settingsConfirmDelete === 0) ? SETTINGS_FOCUS_COUNT : 2; settingsFocus = (settingsFocus + 1) % m2; dirty = true; e.preventDefault(); return; }
        if (e.key === 'ArrowLeft' && settingsConfirmDelete > 0)  { settingsFocus = 0; dirty = true; e.preventDefault(); return; }
        if (e.key === 'ArrowRight' && settingsConfirmDelete > 0) { settingsFocus = 1; dirty = true; e.preventDefault(); return; }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (settingsConfirmDelete === 0) {
                if (settingsFocus === 0) toggleSoundSetting();
                else if (settingsFocus === 1) toggleMusicSetting();
                else if (settingsFocus === 2) { settingsVisible = false; openTutorial(); }
                else if (settingsFocus === 3) { settingsConfirmDelete = 1; settingsFocus = 1; sfxBlade(); dirty = true; }
                else if (settingsFocus === 4) closeSettings();
            } else {
                if (settingsFocus === 0) {
                    if (settingsConfirmDelete === 1) { settingsConfirmDelete = 2; sfxBlade(); dirty = true; }
                    else { deleteAllData(); }
                } else { settingsConfirmDelete = 0; settingsFocus = 3; sfxBlade(); dirty = true; }
            }
            return;
        }
        if (e.key === 'Escape') { closeSettings(); }
        return;
    }
    if (tutorialVisible) {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { closeTutorial(); }
        return;
    }
    if (state === S_TITLE) {
        if (e.key === 'Tab') {
            e.preventDefault();
            titleFocus = (titleFocus + (e.shiftKey ? -1 : 1) + TITLE_FOCUS_COUNT) % TITLE_FOCUS_COUNT;
            dirty = true; return;
        }
        if (e.key === 'ArrowDown') { titleFocus = (titleFocus + 1) % TITLE_FOCUS_COUNT; dirty = true; e.preventDefault(); return; }
        if (e.key === 'ArrowUp')   { titleFocus = (titleFocus - 1 + TITLE_FOCUS_COUNT) % TITLE_FOCUS_COUNT; dirty = true; e.preventDefault(); return; }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if      (titleFocus === 0) enterTournament();
            else if (titleFocus === 1) enterPracticeBout();
            else if (titleFocus === 2) enterRoster();
            else if (titleFocus === 3) cycleDifficulty();
            else if (titleFocus === 4) openSettings();
            return;
        }
        // Letter shortcuts (still work)
        if (e.key === 'p' || e.key === 'P') { enterPracticeBout(); return; }
        if (e.key === 'r' || e.key === 'R') { enterRoster(); return; }
        if (e.key === 'd' || e.key === 'D') { cycleDifficulty(); return; }
        if (e.key === 's' || e.key === 'S') { openSettings(); return; }
        return;
    }
    if (state === S_ROSTER) {
        if (e.key === 'Escape' || e.key === 'Backspace') { exitRoster(); return; }
        if (e.key === 'Tab') {
            e.preventDefault();
            rosterFocusIdx = (rosterFocusIdx + (e.shiftKey ? -1 : 1) + 17) % 17;
            dirty = true; return;
        }
        if (e.key === 'ArrowLeft')  { rosterFocusIdx = gridMove(rosterFocusIdx, 'left',  4, 16, 1); dirty = true; e.preventDefault(); return; }
        if (e.key === 'ArrowRight') { rosterFocusIdx = gridMove(rosterFocusIdx, 'right', 4, 16, 1); dirty = true; e.preventDefault(); return; }
        if (e.key === 'ArrowUp')    { rosterFocusIdx = gridMove(rosterFocusIdx, 'up',    4, 16, 1); dirty = true; e.preventDefault(); return; }
        if (e.key === 'ArrowDown')  { rosterFocusIdx = gridMove(rosterFocusIdx, 'down',  4, 16, 1); dirty = true; e.preventDefault(); return; }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (rosterFocusIdx === 16) { exitRoster(); return; }
            if (rosterFocusIdx >= 0 && rosterFocusIdx < FENCERS.length) {
                var rcode = FENCERS[rosterFocusIdx].code;
                rosterFlipped[rcode] = !rosterFlipped[rcode];
                sfxBlade(); dirty = true;
            }
            return;
        }
        return;
    }
    if (state === S_FENCER_SELECT) {
        if (e.key === 'Escape' || e.key === 'Backspace') { state = S_TITLE; sfxBlade(); dirty = true; return; }
        if (e.key === 'Tab') {
            e.preventDefault();
            fsFocusIdx = (fsFocusIdx + (e.shiftKey ? -1 : 1) + 18) % 18;
            // Sync highlight when navigating into a grid cell
            if (fsFocusIdx < 16 && FENCERS[fsFocusIdx]) fsHighlightCode = FENCERS[fsFocusIdx].code;
            dirty = true; return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            var dir = e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowUp' ? 'up' : 'down';
            fsFocusIdx = gridMove(fsFocusIdx, dir, 4, 16, 2);
            if (fsFocusIdx < 16 && FENCERS[fsFocusIdx]) fsHighlightCode = FENCERS[fsFocusIdx].code;
            dirty = true; return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (fsFocusIdx === 16) { state = S_TITLE; sfxBlade(); dirty = true; return; }
            if (fsFocusIdx === 17) { confirmFencerSelect(); return; }
            // Grid: highlight + confirm in one press
            if (fsFocusIdx >= 0 && fsFocusIdx < FENCERS.length) {
                fsHighlightCode = FENCERS[fsFocusIdx].code;
                confirmFencerSelect();
            }
            return;
        }
        return;
    }
    if (state === S_BRACKET) {
        if (e.key === 'Escape') { state = S_TITLE; sfxBlade(); dirty = true; return; }
        if (e.key === 'Tab') {
            e.preventDefault();
            bracketFocus = 1 - bracketFocus; dirty = true; return;
        }
        if (e.key === 'ArrowLeft')  { bracketFocus = 0; dirty = true; e.preventDefault(); return; }
        if (e.key === 'ArrowRight') { bracketFocus = 1; dirty = true; e.preventDefault(); return; }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (bracketFocus === 0) { state = S_TITLE; sfxBlade(); dirty = true; }
            else { bracketContinue(); }
            return;
        }
        return;
    }
    if (state === S_MATCH_INTRO) {
        if (e.key === 'Escape') { state = S_BRACKET; sfxBlade(); dirty = true; return; }
        if (e.key === 'Enter' || e.key === ' ') { startMatchIntroBout(); return; }
        return;
    }
    if (state === S_CHAMPION || state === S_GAME_OVER) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { endScreenContinue(); return; }
        return;
    }
    if (state === S_BOUT_RESULT) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
            if (boutContext === 'tournament' && tournament) {
                if (tournament.playerEliminated) { state = S_GAME_OVER; sfxDefeat(); }
                else if (tournament.champion && tournament.champion.code === tournament.playerCode) {
                    state = S_CHAMPION; sfxVictory();
                    spawnConfetti(tournament.champion.colors);
                }
                else { state = S_BRACKET; sfxBlade(); }
                if (musicOn) { currentTrack = null; setTrack('menu'); }
                dirty = true;
            } else { exitBout(); }
        }
        return;
    }
    if (state === S_BOUT_INTRO || state === S_BOUT_HALT) {
        if (e.key === 'Escape') { exitBout(); }
        return;
    }
    if (state === S_BOUT_PLAY) {
        if (e.key === 'Escape') { exitBout(); return; }
        // Player (always bp1, on the left, facing right) — Arrow keys
        if (e.key === 'ArrowLeft')  { bp1Keys.retreat = true; e.preventDefault(); return; }
        if (e.key === 'ArrowRight') { bp1Keys.advance = true; e.preventDefault(); return; }
        if (e.key === 'ArrowUp' || e.key === ' ') { startLunge(bp1, bp2); e.preventDefault(); return; }
        if (e.key === 'ArrowDown') { startParry(bp1, bp2); e.preventDefault(); return; }
    }
}

function onKeyUp(e) {
    if (state !== S_BOUT_PLAY) return;
    if (e.key === 'ArrowLeft')  { bp1Keys.retreat = false; return; }
    if (e.key === 'ArrowRight') { bp1Keys.advance = false; return; }
}

// ── Game loop ──
var lastTime = 0;
function loop(ts) {
    requestAnimationFrame(loop);
    var dt = ts - lastTime;
    lastTime = ts;
    if (dt > 100) dt = 100;

    // Animated screens (pulsing focus border + animated buttons)
    if (state === S_TITLE || state === S_MATCH_INTRO || state === S_ROSTER ||
        state === S_FENCER_SELECT || state === S_BRACKET ||
        state === S_BOUT_RESULT || state === S_CHAMPION || state === S_GAME_OVER ||
        settingsVisible || tutorialVisible) dirty = true;
    // Bout states need continuous updates
    if (state === S_BOUT_INTRO || state === S_BOUT_PLAY || state === S_BOUT_HALT) {
        updateBout(dt);
    }
    // Confetti during champion screen
    if (state === S_CHAMPION && confettiParticles.length > 0) {
        updateConfetti(dt);
        dirty = true;
    }
    // Bout states with active animation also need continuous redraw
    if (state === S_BOUT_PLAY) dirty = true;

    if (dirty) {
        dirty = false;
        draw();
    }
}

function init() {
    canvas = document.getElementById('cFence');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    // Auto-focus so Tab/arrow keys go to the game, not browser chrome
    try { canvas.focus(); } catch(e) {}
    canvas.addEventListener('mousedown', function() { try { canvas.focus(); } catch(e) {} });
    resize();
    window.addEventListener('resize', resize);
    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('touchstart', onPointerDown, { passive: false });
    canvas.addEventListener('mouseup', onPointerUp);
    canvas.addEventListener('touchend', onPointerUp, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // When the window loses focus, drop all held keys so the fencer doesn't drift forever
    window.addEventListener('blur', function() {
        bp1Keys.advance = bp1Keys.retreat = false;
        bp2Keys.advance = bp2Keys.retreat = false;
    });
    loadSoundSettings();
    loadDifficulty();
    loadFencersData(function() {
        state = S_TITLE;
        dirty = true;
        lastTime = performance.now();
        requestAnimationFrame(loop);
    });
}

window._fenceInit = init;

})();
