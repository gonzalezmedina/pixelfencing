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

// ─────────────────────────────────────────────────────────────────────────────
// Pixel Fencing — Chiptune Audio Engine
//
// Drop-in replacement for the audio section of game.js (lines ~78-283).
// Pure WebAudio, no assets, no libraries. Paste directly inside the game IIFE.
//
// Public entry points (unchanged from the old engine):
//   initAudio()            playSfx(notes, wave, volume)
//   setTrack(name)         stopTrack()
//   toggleSound()          saveSoundSettings()   loadSoundSettings()
//   soundOn / sfxOn / musicOn flags        playMelody(melody, wave)  [legacy]
//
// New: a full SFX bank (sfx*), three structured loopable tracks, a master gain
// with separate music/sfx buses, and a lookahead scheduler so music stays in
// time and loops seamlessly.
// ─────────────────────────────────────────────────────────────────────────────

var audioCtx = null;
var soundOn = false;
var sfxOn = true;
var musicOn = false;
var SOUND_KEY = (typeof _KP !== 'undefined' ? _KP : 'pf_') + 'soundSettings';

// Buses: master ← (musicGain, sfxGain)
var masterGain = null;
var musicGain = null;
var sfxGain = null;
var noiseBuffer = null;

var MASTER_VOL = 0.9;
var MUSIC_VOL = 0.16;
var SFX_VOL = 0.55;

// ── Note table ───────────────────────────────────────────────────────────────
// Generated 12-TET from A4=440. Both sharp (Cs4) and flat (Db4) spellings.
// R is the rest sentinel (frequency 0) and is never turned into an oscillator.
var NOTE = (function () {
    var sharps = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];
    var flat = { Cs: 'Db', Ds: 'Eb', Fs: 'Gb', Gs: 'Ab', As: 'Bb' };
    var t = { R: 0 };
    for (var oct = 1; oct <= 7; oct++) {
        for (var i = 0; i < 12; i++) {
            var midi = (oct + 1) * 12 + i;
            var f = Math.round(440 * Math.pow(2, (midi - 69) / 12) * 100) / 100;
            t[sharps[i] + oct] = f;
            if (flat[sharps[i]]) t[flat[sharps[i]] + oct] = f;
        }
    }
    return t;
})();

// Resolve a note name or raw frequency to Hz. Unknown names resolve to a rest
// rather than NaN, so a typo can never produce an invalid oscillator.
function noteFreq(x) {
    if (typeof x === 'number') return isFinite(x) && x > 0 ? x : 0;
    var f = NOTE[x];
    return typeof f === 'number' ? f : 0;
}

// ── Settings persistence ─────────────────────────────────────────────────────
function saveSoundSettings() {
    try {
        localStorage.setItem(SOUND_KEY, JSON.stringify({ soundOn: soundOn, sfx: sfxOn, music: musicOn }));
    } catch (e) {}
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
    } catch (e) {}
}

// ── Dry-run instrumentation (headless validation only) ───────────────────────
// When active, tone/noise calls are recorded instead of played, so the whole
// SFX bank and every track can be validated without an AudioContext.
var _dryLog = null;
var _stats = { musicNodes: 0, sfxNodes: 0 };

function __dryStart() { _dryLog = []; return _dryLog; }
function __dryStop() { var l = _dryLog; _dryLog = null; return l || []; }
function __stats() { return { musicNodes: _stats.musicNodes, sfxNodes: _stats.sfxNodes }; }

// ── Core engine ──────────────────────────────────────────────────────────────
function initAudio() {
    if (!audioCtx) {
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            audioCtx = new AC();
        } catch (e) { audioCtx = null; return; }

        try {
            masterGain = audioCtx.createGain();
            masterGain.gain.value = MASTER_VOL;
            masterGain.connect(audioCtx.destination);

            musicGain = audioCtx.createGain();
            musicGain.gain.value = MUSIC_VOL;
            musicGain.connect(masterGain);

            sfxGain = audioCtx.createGain();
            sfxGain.gain.value = SFX_VOL;
            sfxGain.connect(masterGain);

            noiseBuffer = _makeNoiseBuffer(2.0);
        } catch (e) { audioCtx = null; return; }

        try {
            audioCtx.onstatechange = function () {
                if (audioCtx && audioCtx.state === 'interrupted') _resumeAndRestore();
            };
            document.addEventListener('visibilitychange', function () {
                if (!document.hidden && audioCtx && soundOn) _resumeAndRestore();
            });
        } catch (e) {}
    }
    if (audioCtx.state !== 'running') { try { audioCtx.resume(); } catch (e) {} }
}

function _resumeAndRestore() {
    if (!audioCtx) return;
    var restore = function () {
        if (musicOn && soundOn && currentTrack && !_schedTimer) {
            var t = currentTrack; currentTrack = null; setTrack(t);
        }
    };
    try {
        if (audioCtx.state !== 'running') {
            var p = audioCtx.resume();
            if (p && p.then) p.then(restore, function () {}); else restore();
        } else restore();
    } catch (e) {}
}

function setMasterVolume(v) {
    MASTER_VOL = Math.max(0, Math.min(1, v));
    if (masterGain && audioCtx) {
        try { masterGain.gain.setTargetAtTime(MASTER_VOL, audioCtx.currentTime, 0.02); } catch (e) {}
    }
}

function _makeNoiseBuffer(seconds) {
    var rate = audioCtx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = audioCtx.createBuffer(1, len, rate);
    var d = buf.getChannelData(0);
    // Slightly smoothed white noise — less fizzy, more "crowd"/"blade" texture.
    var last = 0;
    for (var i = 0; i < len; i++) {
        var w = Math.random() * 2 - 1;
        last = (last + 0.06 * w) / 1.06;
        d[i] = w * 0.7 + last * 3.0;
        if (d[i] > 1) d[i] = 1; else if (d[i] < -1) d[i] = -1;
    }
    return buf;
}

// True when a sound may be produced right now.
function _ready(isMusic) {
    if (_dryLog) return true;
    if (!audioCtx || !soundOn) return false;
    if (isMusic ? !musicOn : !sfxOn) return false;
    if (audioCtx.state === 'closed') return false;
    if (audioCtx.state !== 'running') { try { audioCtx.resume(); } catch (e) {} }
    return true;
}

// Music voices are tracked so stopTrack() can hard-cancel anything pending.
var _musicNodes = [];

function _trackNode(node, isMusic) {
    if (isMusic) {
        _stats.musicNodes++;
        _musicNodes.push(node);
        try {
            node.onended = function () {
                var i = _musicNodes.indexOf(node);
                if (i >= 0) _musicNodes.splice(i, 1);
            };
        } catch (e) {}
    } else {
        _stats.sfxNodes++;
    }
}

// One oscillator voice.
// o: { t, dur, freq, to, type, vol, attack, sustain, sweep, detune, filter, music }
function _tone(o) {
    var dur = Math.max(0.03, o.dur || 0.1);
    var f0 = noteFreq(o.freq);
    if (f0 <= 0) return null;
    var f1 = (o.to == null) ? f0 : noteFreq(o.to);
    if (f1 <= 0) f1 = f0;
    var vol = (o.vol == null) ? 0.2 : o.vol;

    if (_dryLog) {
        _dryLog.push({ kind: 'tone', freq: f0, to: f1, dur: dur, vol: vol, type: o.type || 'square', t: o.t || 0 });
        return null;
    }
    if (!audioCtx) return null;

    var bus = o.music ? musicGain : sfxGain;
    var t0 = o.t;
    var atk = Math.min((o.attack == null ? 0.006 : o.attack), dur * 0.4);
    if (atk < 0.001) atk = 0.001;
    var sus = (o.sustain == null) ? 0.65 : o.sustain;
    var tDecay = t0 + atk + Math.min(0.06, dur * 0.3);

    var osc = audioCtx.createOscillator();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) {
        if (o.sweep === 'linear') osc.frequency.linearRampToValueAtTime(f1, t0 + dur);
        else osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    }
    if (o.detune) osc.detune.setValueAtTime(o.detune, t0);

    var env = audioCtx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + atk);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * sus), tDecay);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    var tail = env;
    osc.connect(env);
    if (o.filter) tail = _chainFilter(tail, o.filter, t0, dur);
    tail.connect(bus);

    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    _trackNode(osc, !!o.music);
    return osc;
}

function _chainFilter(from, f, t0, dur) {
    var biq = audioCtx.createBiquadFilter();
    biq.type = f.type || 'lowpass';
    biq.frequency.setValueAtTime(Math.max(20, Math.min(20000, f.freq || 2000)), t0);
    if (f.to != null) {
        var target = Math.max(20, Math.min(20000, f.to));
        try { biq.frequency.exponentialRampToValueAtTime(target, t0 + dur); } catch (e) {}
    }
    if (f.q != null) biq.Q.setValueAtTime(f.q, t0);
    from.connect(biq);
    return biq;
}

// One filtered-noise voice.
// o: { t, dur, vol, filter:{type,freq,to,q}, attack, playbackRate, music }
function _noise(o) {
    var dur = Math.max(0.02, o.dur || 0.15);
    var vol = (o.vol == null) ? 0.2 : o.vol;
    var f = o.filter || { type: 'bandpass', freq: 1200, q: 1 };

    if (_dryLog) {
        _dryLog.push({ kind: 'noise', dur: dur, vol: vol, freq: f.freq, to: (f.to == null ? f.freq : f.to), t: o.t || 0 });
        return null;
    }
    if (!audioCtx || !noiseBuffer) return null;

    var src = audioCtx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    if (o.playbackRate) src.playbackRate.setValueAtTime(o.playbackRate, o.t);

    var t0 = o.t;
    var atk = Math.min((o.attack == null ? 0.008 : o.attack), dur * 0.5);
    if (atk < 0.001) atk = 0.001;

    var env = audioCtx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + atk);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    var node = _chainFilter(src, f, t0, dur);
    node.connect(env);
    env.connect(o.music ? musicGain : sfxGain);

    src.start(t0);
    src.stop(t0 + dur + 0.02);
    _trackNode(src, !!o.music);
    return src;
}

// Legacy API: notes are [[freq, durationMs], ...] played back to back.
function playSfx(notes, wave, volume) {
    if (!_ready(false)) return;
    var vol = volume || 0.15;
    var base = _dryLog ? 0 : audioCtx.currentTime + 0.005;
    var t = 0;
    for (var i = 0; i < notes.length; i++) {
        var freq = noteFreq(notes[i][0]);
        var dur = notes[i][1] / 1000;
        if (freq > 0) _tone({ t: base + t, dur: dur, freq: freq, type: wave || 'square', vol: vol, sustain: 0.8 });
        t += dur;
    }
}

// Schedule a list of voice descriptors relative to "now".
function _seq(voices) {
    if (!_ready(false)) return;
    var base = _dryLog ? 0 : audioCtx.currentTime + 0.005;
    for (var i = 0; i < voices.length; i++) {
        var v = voices[i];
        var o = {};
        for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = v[k];
        o.t = base + (v.t || 0);
        if (o.kind === 'noise') _noise(o); else _tone(o);
    }
}

// ── SFX bank ─────────────────────────────────────────────────────────────────

// Blade clash / parry — bright metallic: inharmonic partials + a noise chirp.
function sfxBlade() {
    _seq([
        { kind: 'noise', t: 0, dur: 0.09, vol: 0.30, filter: { type: 'bandpass', freq: 5200, to: 2600, q: 1.6 }, attack: 0.001 },
        { t: 0, dur: 0.18, freq: 'A6', to: 'E6', type: 'triangle', vol: 0.20, attack: 0.001, sustain: 0.35 },
        { t: 0.005, dur: 0.26, freq: 3320, to: 2210, type: 'triangle', vol: 0.13, attack: 0.001, sustain: 0.25 },
        { t: 0.01, dur: 0.34, freq: 'E5', to: 'A4', type: 'sine', vol: 0.10, attack: 0.002, sustain: 0.3 }
    ]);
}

// Parry — like the clash but shorter, higher and with a ringing tail.
function sfxParry() {
    _seq([
        { kind: 'noise', t: 0, dur: 0.06, vol: 0.26, filter: { type: 'highpass', freq: 3800, q: 0.8 }, attack: 0.001 },
        { t: 0, dur: 0.14, freq: 'D6', to: 'A5', type: 'square', vol: 0.13, attack: 0.001, sustain: 0.3 },
        { t: 0.02, dur: 0.42, freq: 4699, to: 4400, type: 'sine', vol: 0.09, attack: 0.002, sustain: 0.45 },
        { t: 0.02, dur: 0.42, freq: 3136, to: 2960, type: 'sine', vol: 0.07, attack: 0.002, sustain: 0.45 }
    ]);
}

// Lunge — an air whoosh that sweeps up then away.
function sfxLunge() {
    _seq([
        { kind: 'noise', t: 0, dur: 0.30, vol: 0.26, filter: { type: 'bandpass', freq: 420, to: 3400, q: 1.1 }, attack: 0.07 },
        { kind: 'noise', t: 0.10, dur: 0.24, vol: 0.16, filter: { type: 'lowpass', freq: 2600, to: 500, q: 0.7 }, attack: 0.02 },
        { t: 0, dur: 0.22, freq: 'A3', to: 'A4', type: 'sine', vol: 0.09, attack: 0.05, sustain: 0.8, sweep: 'linear' }
    ]);
}

// Riposte — quick answering attack: a fast rising triplet off the parry.
function sfxRiposte() {
    _seq([
        { t: 0.00, dur: 0.05, freq: 'A4', type: 'square', vol: 0.12, sustain: 0.9 },
        { t: 0.045, dur: 0.05, freq: 'E5', type: 'square', vol: 0.13, sustain: 0.9 },
        { t: 0.09, dur: 0.16, freq: 'A5', type: 'square', vol: 0.14, sustain: 0.55 },
        { kind: 'noise', t: 0.09, dur: 0.10, vol: 0.13, filter: { type: 'bandpass', freq: 3600, to: 1800, q: 1.4 }, attack: 0.001 }
    ]);
}

// Feint — a teasing wobble that goes nowhere.
function sfxFeint() {
    _seq([
        { t: 0.00, dur: 0.05, freq: 'G5', type: 'triangle', vol: 0.10, sustain: 0.9 },
        { t: 0.045, dur: 0.05, freq: 'D5', type: 'triangle', vol: 0.10, sustain: 0.9 },
        { t: 0.09, dur: 0.11, freq: 'G5', to: 'A5', type: 'triangle', vol: 0.10, sustain: 0.6 }
    ]);
}

// Whiff — attack meets nothing but air.
function sfxWhiff() {
    _seq([
        { kind: 'noise', t: 0, dur: 0.20, vol: 0.14, attack: 0.05,
          filter: { type: 'bandpass', freq: 1600, to: 300, q: 0.9 } },
        { t: 0, dur: 0.16, freq: 'D4', to: 'A3', type: 'sine', vol: 0.08, sustain: 0.6 }
    ]);
}

// No point awarded — one short flat buzz (softer sibling of the double-touch).
function sfxNoPoint() {
    _seq([
        { t: 0.00, dur: 0.09, freq: 'A4', type: 'square', vol: 0.11, sustain: 1, attack: 0.002,
          filter: { type: 'lowpass', freq: 1600, q: 2 } },
        { t: 0.09, dur: 0.20, freq: 'F4', type: 'square', vol: 0.11, sustain: 1, attack: 0.002,
          filter: { type: 'lowpass', freq: 1400, q: 2 } },
        { t: 0.09, dur: 0.20, freq: 'E4', type: 'sawtooth', vol: 0.07, sustain: 1, attack: 0.002,
          filter: { type: 'lowpass', freq: 1200, q: 2 } }
    ]);
}

// Exhausted — a sagging low sigh.
function sfxExhausted() {
    _seq([
        { t: 0.00, dur: 0.12, freq: 'D3', type: 'sine', vol: 0.12, sustain: 0.8 },
        { t: 0.11, dur: 0.30, freq: 'C3', to: 'A2', type: 'sine', vol: 0.12, sustain: 0.5 },
        { kind: 'noise', t: 0.05, dur: 0.28, vol: 0.07, attack: 0.06,
          filter: { type: 'lowpass', freq: 700, to: 260, q: 0.7 } }
    ]);
}

// Touch scored FOR you — confident ascending hit-confirm.
function sfxTouchFor() {
    _seq([
        { kind: 'noise', t: 0, dur: 0.05, vol: 0.20, filter: { type: 'bandpass', freq: 4200, q: 2 }, attack: 0.001 },
        { t: 0.00, dur: 0.075, freq: 'E5', type: 'square', vol: 0.17, sustain: 0.9 },
        { t: 0.07, dur: 0.075, freq: 'A5', type: 'square', vol: 0.18, sustain: 0.9 },
        { t: 0.14, dur: 0.075, freq: 'Cs6', type: 'square', vol: 0.18, sustain: 0.9 },
        { t: 0.21, dur: 0.34, freq: 'E6', type: 'square', vol: 0.19, sustain: 0.55 },
        { t: 0.21, dur: 0.34, freq: 'A5', type: 'triangle', vol: 0.13, sustain: 0.55 }
    ]);
}

// Touch scored AGAINST you — duller, descending, filtered down.
function sfxTouchAgainst() {
    _seq([
        { kind: 'noise', t: 0, dur: 0.08, vol: 0.16, filter: { type: 'lowpass', freq: 1400, to: 380, q: 0.9 }, attack: 0.002 },
        { t: 0.00, dur: 0.11, freq: 'G4', type: 'triangle', vol: 0.16, sustain: 0.8, filter: { type: 'lowpass', freq: 1800, to: 900 } },
        { t: 0.10, dur: 0.11, freq: 'Eb4', type: 'triangle', vol: 0.16, sustain: 0.8, filter: { type: 'lowpass', freq: 1600, to: 800 } },
        { t: 0.20, dur: 0.40, freq: 'C4', to: 'B3', type: 'triangle', vol: 0.17, sustain: 0.5, filter: { type: 'lowpass', freq: 1400, to: 500 } },
        { t: 0.20, dur: 0.40, freq: 'C3', type: 'sine', vol: 0.12, sustain: 0.5 }
    ]);
}

// Double touch / no point — flat two-tone buzzer.
function sfxDoubleTouch() {
    _seq([
        { t: 0.00, dur: 0.17, freq: 'Bb3', type: 'square', vol: 0.15, sustain: 1, attack: 0.002, filter: { type: 'lowpass', freq: 1500, q: 3 } },
        { t: 0.00, dur: 0.17, freq: 'B3', type: 'sawtooth', vol: 0.11, sustain: 1, attack: 0.002, filter: { type: 'lowpass', freq: 1300, q: 3 } },
        { t: 0.21, dur: 0.30, freq: 'Bb3', type: 'square', vol: 0.15, sustain: 1, attack: 0.002, filter: { type: 'lowpass', freq: 1500, q: 3 } },
        { t: 0.21, dur: 0.30, freq: 'B3', type: 'sawtooth', vol: 0.11, sustain: 1, attack: 0.002, filter: { type: 'lowpass', freq: 1300, q: 3 } }
    ]);
}

// Footwork step — subtle, randomly detuned so repeats never sound identical.
function sfxStep() {
    var r = 0.85 + Math.random() * 0.34;          // pitch jitter
    var v = 0.09 + Math.random() * 0.045;         // level jitter
    _seq([
        { kind: 'noise', t: 0, dur: 0.045 + Math.random() * 0.03, vol: v, attack: 0.001,
          filter: { type: 'bandpass', freq: 900 * r, to: 380 * r, q: 1.3 } },
        { t: 0, dur: 0.06, freq: 130 * r, to: 78 * r, type: 'sine', vol: v * 0.8, attack: 0.001, sustain: 0.4 }
    ]);
}

// Menu move — short blip.
function sfxMenuMove() {
    _seq([{ t: 0, dur: 0.055, freq: 'E5', type: 'square', vol: 0.11, sustain: 0.9 }]);
}

// Menu confirm — rising two-note.
function sfxMenuConfirm() {
    _seq([
        { t: 0.00, dur: 0.06, freq: 'A5', type: 'square', vol: 0.12, sustain: 0.9 },
        { t: 0.055, dur: 0.16, freq: 'E6', type: 'square', vol: 0.12, sustain: 0.6 }
    ]);
}

// Menu back — falling two-note.
function sfxMenuBack() {
    _seq([
        { t: 0.00, dur: 0.06, freq: 'E5', type: 'square', vol: 0.11, sustain: 0.9 },
        { t: 0.055, dur: 0.15, freq: 'A4', type: 'square', vol: 0.11, sustain: 0.6 }
    ]);
}

// Bout start — "Allez!" fanfare.
function sfxAllez() {
    _seq([
        { t: 0.00, dur: 0.13, freq: 'D5', type: 'square', vol: 0.16, sustain: 0.9 },
        { t: 0.00, dur: 0.13, freq: 'D4', type: 'triangle', vol: 0.11, sustain: 0.9 },
        { t: 0.13, dur: 0.13, freq: 'A5', type: 'square', vol: 0.16, sustain: 0.9 },
        { t: 0.13, dur: 0.13, freq: 'A4', type: 'triangle', vol: 0.11, sustain: 0.9 },
        { t: 0.26, dur: 0.42, freq: 'D6', type: 'square', vol: 0.18, sustain: 0.55 },
        { t: 0.26, dur: 0.42, freq: 'Fs5', type: 'triangle', vol: 0.12, sustain: 0.55 },
        { t: 0.26, dur: 0.42, freq: 'D4', type: 'triangle', vol: 0.10, sustain: 0.55 },
        { kind: 'noise', t: 0.26, dur: 0.10, vol: 0.14, filter: { type: 'bandpass', freq: 3000, q: 1.2 }, attack: 0.002 }
    ]);
}

// Halt — referee whistle: two close, slightly warbling high tones + air.
function sfxHalt() {
    _seq([
        { kind: 'noise', t: 0, dur: 0.34, vol: 0.10, filter: { type: 'bandpass', freq: 2600, to: 2400, q: 3 }, attack: 0.02 },
        { t: 0.00, dur: 0.34, freq: 2637, to: 2794, type: 'sine', vol: 0.18, attack: 0.02, sustain: 0.85 },
        { t: 0.00, dur: 0.34, freq: 2794, to: 2637, type: 'sine', vol: 0.14, attack: 0.02, sustain: 0.85 },
        { t: 0.34, dur: 0.10, freq: 2794, to: 2200, type: 'sine', vol: 0.12, sustain: 0.4 }
    ]);
}

// Crowd swell — long filtered noise that opens up and settles.
function sfxCrowd(intensity) {
    var k = (intensity == null) ? 1 : Math.max(0.3, Math.min(1.6, intensity));
    _seq([
        { kind: 'noise', t: 0, dur: 1.5, vol: 0.16 * k, attack: 0.5,
          filter: { type: 'bandpass', freq: 500, to: 1900, q: 0.6 } },
        { kind: 'noise', t: 0.18, dur: 1.3, vol: 0.10 * k, attack: 0.45,
          filter: { type: 'lowpass', freq: 900, to: 3200, q: 0.5 }, playbackRate: 0.8 },
        { kind: 'noise', t: 0.35, dur: 1.1, vol: 0.07 * k, attack: 0.4,
          filter: { type: 'highpass', freq: 1800, to: 900, q: 0.7 }, playbackRate: 1.3 }
    ]);
}

// Match point sting — tense, unresolved.
function sfxMatchPoint() {
    _seq([
        { t: 0.00, dur: 0.15, freq: 'A4', type: 'square', vol: 0.14, sustain: 0.9 },
        { t: 0.00, dur: 0.15, freq: 'A3', type: 'triangle', vol: 0.10, sustain: 0.9 },
        { t: 0.15, dur: 0.15, freq: 'C5', type: 'square', vol: 0.14, sustain: 0.9 },
        { t: 0.30, dur: 0.62, freq: 'E5', type: 'square', vol: 0.15, sustain: 0.6 },
        { t: 0.30, dur: 0.62, freq: 'Gs5', type: 'square', vol: 0.10, sustain: 0.6 },
        { t: 0.30, dur: 0.62, freq: 'A2', type: 'triangle', vol: 0.13, sustain: 0.6 },
        { kind: 'noise', t: 0.30, dur: 0.55, vol: 0.07, attack: 0.25, filter: { type: 'bandpass', freq: 800, to: 2400, q: 0.9 } }
    ]);
}

// Victory fanfare.
function sfxVictory() {
    _seq([
        { t: 0.00, dur: 0.11, freq: 'C5', type: 'square', vol: 0.16, sustain: 0.9 },
        { t: 0.10, dur: 0.11, freq: 'E5', type: 'square', vol: 0.16, sustain: 0.9 },
        { t: 0.20, dur: 0.11, freq: 'G5', type: 'square', vol: 0.16, sustain: 0.9 },
        { t: 0.30, dur: 0.22, freq: 'C6', type: 'square', vol: 0.17, sustain: 0.8 },
        { t: 0.52, dur: 0.11, freq: 'G5', type: 'square', vol: 0.15, sustain: 0.9 },
        { t: 0.62, dur: 0.70, freq: 'C6', type: 'square', vol: 0.18, sustain: 0.6 },
        { t: 0.62, dur: 0.70, freq: 'E6', type: 'triangle', vol: 0.11, sustain: 0.6 },
        // bass answer
        { t: 0.00, dur: 0.30, freq: 'C3', type: 'triangle', vol: 0.13, sustain: 0.7 },
        { t: 0.30, dur: 0.30, freq: 'G3', type: 'triangle', vol: 0.13, sustain: 0.7 },
        { t: 0.62, dur: 0.70, freq: 'C3', type: 'triangle', vol: 0.14, sustain: 0.6 },
        { kind: 'noise', t: 0.62, dur: 0.9, vol: 0.09, attack: 0.35, filter: { type: 'bandpass', freq: 700, to: 2200, q: 0.7 } }
    ]);
}

// Defeat sting.
function sfxDefeat() {
    _seq([
        { t: 0.00, dur: 0.22, freq: 'A4', type: 'square', vol: 0.13, sustain: 0.8, filter: { type: 'lowpass', freq: 2200, to: 1200 } },
        { t: 0.20, dur: 0.22, freq: 'G4', type: 'square', vol: 0.13, sustain: 0.8, filter: { type: 'lowpass', freq: 2000, to: 1100 } },
        { t: 0.40, dur: 0.22, freq: 'F4', type: 'square', vol: 0.13, sustain: 0.8, filter: { type: 'lowpass', freq: 1800, to: 1000 } },
        { t: 0.60, dur: 0.85, freq: 'E4', type: 'square', vol: 0.14, sustain: 0.5, filter: { type: 'lowpass', freq: 1600, to: 600 } },
        { t: 0.60, dur: 0.85, freq: 'C4', type: 'triangle', vol: 0.10, sustain: 0.5 },
        { t: 0.60, dur: 0.90, freq: 'A2', to: 'A1', type: 'triangle', vol: 0.14, sustain: 0.5 }
    ]);
}

// Tournament champion theme — the big one.
function sfxChampion() {
    _seq([
        { kind: 'noise', t: 0, dur: 0.12, vol: 0.16, filter: { type: 'bandpass', freq: 3200, q: 1 }, attack: 0.002 },
        { t: 0.00, dur: 0.16, freq: 'G4', type: 'square', vol: 0.16, sustain: 0.9 },
        { t: 0.15, dur: 0.16, freq: 'C5', type: 'square', vol: 0.16, sustain: 0.9 },
        { t: 0.30, dur: 0.16, freq: 'E5', type: 'square', vol: 0.16, sustain: 0.9 },
        { t: 0.45, dur: 0.30, freq: 'G5', type: 'square', vol: 0.17, sustain: 0.8 },
        { t: 0.75, dur: 0.15, freq: 'E5', type: 'square', vol: 0.15, sustain: 0.9 },
        { t: 0.90, dur: 0.15, freq: 'G5', type: 'square', vol: 0.15, sustain: 0.9 },
        { t: 1.05, dur: 1.05, freq: 'C6', type: 'square', vol: 0.18, sustain: 0.6 },
        { t: 1.05, dur: 1.05, freq: 'E6', type: 'triangle', vol: 0.11, sustain: 0.6 },
        { t: 1.05, dur: 1.05, freq: 'G5', type: 'triangle', vol: 0.10, sustain: 0.6 },
        // bass
        { t: 0.00, dur: 0.45, freq: 'C3', type: 'triangle', vol: 0.14, sustain: 0.7 },
        { t: 0.45, dur: 0.30, freq: 'G2', type: 'triangle', vol: 0.14, sustain: 0.7 },
        { t: 0.75, dur: 0.30, freq: 'C3', type: 'triangle', vol: 0.14, sustain: 0.7 },
        { t: 1.05, dur: 1.10, freq: 'C2', type: 'triangle', vol: 0.16, sustain: 0.6 },
        { kind: 'noise', t: 1.05, dur: 1.2, vol: 0.11, attack: 0.4, filter: { type: 'bandpass', freq: 600, to: 2600, q: 0.6 } }
    ]);
}

// ── Music: track definitions ─────────────────────────────────────────────────
// Parts are written as sequential [noteName, durationInBeats] pairs so each
// part is trivially readable; the compiler turns them into absolute beat
// offsets. Every part in a track must sum to the same number of beats.

function _rep(seq, n) {
    var out = [];
    for (var i = 0; i < n; i++) out = out.concat(seq);
    return out;
}

var TRACKS = {

    // Calm, noble, slightly fanfare-like. D minor, 16-beat loop.
    menu: {
        bpm: 92,
        parts: [
            { // bass — root/fifth walk
                type: 'triangle', vol: 0.30, sustain: 0.55, gate: 0.92,
                notes: [
                    ['D2', 1], ['A2', 1], ['D3', 1], ['A2', 1],
                    ['Bb1', 1], ['F2', 1], ['Bb2', 1], ['F2', 1],
                    ['F2', 1], ['C3', 1], ['F3', 1], ['C3', 1],
                    ['A1', 1], ['E2', 1], ['A2', 1], ['Cs3', 1]
                ]
            },
            { // inner arpeggio pad
                type: 'triangle', vol: 0.11, sustain: 0.5, gate: 0.85,
                notes: [].concat(
                    _rep([['D4', 0.5], ['F4', 0.5], ['A4', 0.5], ['F4', 0.5]], 2),
                    _rep([['Bb3', 0.5], ['D4', 0.5], ['F4', 0.5], ['D4', 0.5]], 2),
                    _rep([['A3', 0.5], ['C4', 0.5], ['F4', 0.5], ['C4', 0.5]], 2),
                    _rep([['A3', 0.5], ['Cs4', 0.5], ['E4', 0.5], ['Cs4', 0.5]], 2)
                )
            },
            { // lead
                type: 'square', vol: 0.17, sustain: 0.6, gate: 0.9,
                filter: { type: 'lowpass', freq: 3600, q: 0.7 },
                notes: [
                    ['D4', 1], ['A4', 1], ['F4', 0.5], ['A4', 0.5], ['D5', 1],
                    ['C5', 1], ['Bb4', 1], ['A4', 1], ['R', 1],
                    ['F4', 1], ['A4', 0.5], ['C5', 0.5], ['F5', 1], ['E5', 1],
                    ['D5', 1], ['Cs5', 1], ['D5', 1], ['R', 1]
                ]
            }
        ]
    },

    // Tense, driving, minor key. A minor / A harmonic minor, 16-beat loop.
    bout: {
        bpm: 152,
        parts: [
            { // driving eighth-note bass, Am - F - G - E
                type: 'sawtooth', vol: 0.22, sustain: 0.35, gate: 0.55,
                filter: { type: 'lowpass', freq: 1500, q: 1.2 },
                notes: [].concat(
                    _rep([['A1', 0.5]], 6), [['A1', 0.5], ['E2', 0.5]],
                    _rep([['F1', 0.5]], 6), [['F1', 0.5], ['C2', 0.5]],
                    _rep([['G1', 0.5]], 6), [['G1', 0.5], ['D2', 0.5]],
                    _rep([['E1', 0.5]], 6), [['E1', 0.5], ['Gs1', 0.5]]
                )
            },
            { // hats — offbeat noise ticks
                type: 'noise', vol: 0.055, gate: 0.35,
                filter: { type: 'highpass', freq: 6200, q: 0.8 },
                notes: _rep([['R', 0.5], ['x', 0.5]], 16)
            },
            { // lead — chromatic, agitated
                type: 'square', vol: 0.155, sustain: 0.5, gate: 0.88,
                filter: { type: 'lowpass', freq: 3000, q: 0.9 },
                notes: [
                    ['A4', 0.5], ['A4', 0.5], ['C5', 0.5], ['E5', 0.5],
                    ['D5', 1], ['C5', 0.5], ['B4', 0.5],
                    ['A4', 0.5], ['C5', 0.5], ['F5', 0.5], ['E5', 0.5],
                    ['D5', 1], ['C5', 1],
                    ['B4', 0.5], ['C5', 0.5], ['D5', 0.5], ['Ds5', 0.5],
                    ['E5', 1], ['D5', 0.5], ['C5', 0.5],
                    ['B4', 0.5], ['A4', 0.5], ['Gs4', 0.5], ['A4', 0.5],
                    ['B4', 1], ['Gs4', 1]
                ]
            },
            { // counter-line, sparse stabs an octave down
                type: 'triangle', vol: 0.10, sustain: 0.45, gate: 0.7,
                notes: [
                    ['A3', 2], ['E3', 2],
                    ['F3', 2], ['C4', 2],
                    ['G3', 2], ['D4', 2],
                    ['E3', 2], ['Gs3', 2]
                ]
            }
        ]
    },

    // Triumphant. C major, 16-beat loop.
    champion: {
        bpm: 126,
        parts: [
            { // bass — march root/fifth
                type: 'triangle', vol: 0.30, sustain: 0.5, gate: 0.75,
                notes: [
                    ['C2', 0.5], ['C2', 0.5], ['G2', 0.5], ['C3', 0.5],
                    ['C2', 0.5], ['G2', 0.5], ['C3', 0.5], ['G2', 0.5],
                    ['F2', 0.5], ['F2', 0.5], ['C3', 0.5], ['F3', 0.5],
                    ['F2', 0.5], ['C3', 0.5], ['A2', 0.5], ['C3', 0.5],
                    ['G2', 0.5], ['G2', 0.5], ['D3', 0.5], ['G3', 0.5],
                    ['G2', 0.5], ['D3', 0.5], ['B2', 0.5], ['D3', 0.5],
                    ['C2', 0.5], ['C2', 0.5], ['G2', 0.5], ['C3', 0.5],
                    ['E3', 0.5], ['G3', 0.5], ['C3', 0.5], ['G2', 0.5]
                ]
            },
            { // harmony — sustained chord tones
                type: 'triangle', vol: 0.10, sustain: 0.55, gate: 0.95,
                notes: [
                    ['E4', 2], ['G4', 2],
                    ['A4', 2], ['C5', 2],
                    ['B4', 2], ['D5', 2],
                    ['C5', 2], ['G4', 2]
                ]
            },
            { // lead fanfare
                type: 'square', vol: 0.17, sustain: 0.6, gate: 0.9,
                filter: { type: 'lowpass', freq: 4200, q: 0.7 },
                notes: [
                    ['G4', 0.5], ['C5', 0.5], ['E5', 1], ['G5', 1.5], ['E5', 0.5],
                    ['F5', 1], ['A5', 1], ['G5', 1.5], ['E5', 0.5],
                    ['D5', 0.5], ['G5', 0.5], ['B5', 1], ['A5', 1.5], ['G5', 0.5],
                    ['E5', 1], ['G5', 1], ['C6', 2]
                ]
            }
        ]
    }
};

// Compile a track's parts into flat, time-ordered event lists (cached).
function _compile(track) {
    if (track._compiled) return track._compiled;
    var spb = 60 / track.bpm;
    var parts = [];
    var loopBeats = 0;
    for (var p = 0; p < track.parts.length; p++) {
        var part = track.parts[p];
        var beat = 0;
        var events = [];
        for (var i = 0; i < part.notes.length; i++) {
            var name = part.notes[i][0];
            var d = part.notes[i][1];
            if (name !== 'R') {
                var f = (part.type === 'noise') ? 0 : noteFreq(name);
                if (part.type === 'noise' || f > 0) events.push({ b: beat, d: d, f: f });
            }
            beat += d;
        }
        if (beat > loopBeats) loopBeats = beat;
        parts.push({ def: part, idx: p, events: events, beats: beat });
    }
    track._compiled = { spb: spb, loopBeats: loopBeats, parts: parts };
    return track._compiled;
}

// ── Music scheduler ──────────────────────────────────────────────────────────
var SCHED_TICK_MS = 25;      // timer resolution
var SCHED_AHEAD = 0.20;      // seconds of lookahead

var currentTrack = null;
var _schedTimer = null;
var _playing = null;         // compiled track currently playing
var _loopStart = 0;          // ctx time of the current loop's beat 0
var _cursors = null;         // per-part index into events

var _schedTrace = null;   // validation hook: records scheduled note times

function _emit(part, ev, when, spb) {
    var def = part.def;
    if (_schedTrace && _schedTrace.length < 4000) _schedTrace.push({ p: part.idx, b: ev.b, when: when });
    var gate = (def.gate == null) ? 0.9 : def.gate;
    var dur = Math.max(0.03, ev.d * spb * gate);
    if (def.type === 'noise') {
        _noise({ t: when, dur: dur, vol: def.vol, filter: def.filter, attack: 0.001, music: true });
    } else {
        _tone({
            t: when, dur: dur, freq: ev.f, type: def.type, vol: def.vol,
            sustain: def.sustain, attack: def.attack, filter: def.filter, music: true
        });
    }
}

function _schedulerTick() {
    if (!audioCtx || !_playing) return;
    if (!soundOn || !musicOn) { stopTrack(); return; }
    if (audioCtx.state === 'closed') { stopTrack(); return; }

    var spb = _playing.spb;
    var loopDur = _playing.loopBeats * spb;
    var horizon = audioCtx.currentTime + SCHED_AHEAD;
    var guard = 0;

    while (guard++ < 64) {
        var pending = false;
        for (var p = 0; p < _playing.parts.length; p++) {
            var part = _playing.parts[p];
            var evs = part.events;
            while (_cursors[p] < evs.length) {
                var ev = evs[_cursors[p]];
                var when = _loopStart + ev.b * spb;
                if (when > horizon) break;
                _emit(part, ev, when, spb);
                _cursors[p]++;
            }
            if (_cursors[p] < evs.length) pending = true;
        }
        if (!pending && loopDur > 0 && _loopStart + loopDur <= horizon) {
            _loopStart += loopDur;
            for (var q = 0; q < _cursors.length; q++) _cursors[q] = 0;
            continue;
        }
        break;
    }
}

function stopTrack() {
    if (_schedTimer) { clearInterval(_schedTimer); _schedTimer = null; }
    _playing = null;
    _cursors = null;

    if (!audioCtx) { _musicNodes.length = 0; return; }
    var now = audioCtx.currentTime;
    for (var i = 0; i < _musicNodes.length; i++) {
        try { _musicNodes[i].onended = null; } catch (e) {}
        try { _musicNodes[i].stop(now + 0.06); } catch (e) {}
    }
    _musicNodes.length = 0;

    if (musicGain) {
        try {
            musicGain.gain.cancelScheduledValues(now);
            musicGain.gain.setValueAtTime(musicGain.gain.value, now);
            musicGain.gain.linearRampToValueAtTime(0.0001, now + 0.05);
            musicGain.gain.setValueAtTime(MUSIC_VOL, now + 0.08);
        } catch (e) {
            try { musicGain.gain.value = MUSIC_VOL; } catch (e2) {}
        }
    }
}

function setTrack(track) {
    if (track === currentTrack && _schedTimer) return;
    currentTrack = track;
    stopTrack();
    if (!track || !soundOn || !musicOn) return;
    if (!audioCtx) return;
    var def = TRACKS[track];
    if (!def) return;
    if (audioCtx.state !== 'running') { try { audioCtx.resume(); } catch (e) {} }

    _playing = _compile(def);
    _cursors = [];
    for (var i = 0; i < _playing.parts.length; i++) _cursors.push(0);
    _loopStart = audioCtx.currentTime + 0.12;

    _schedulerTick();
    _schedTimer = setInterval(_schedulerTick, SCHED_TICK_MS);
}

// Legacy monophonic helper, kept for compatibility. Does not loop; the
// resulting voices are registered so stopTrack() cancels them.
function playMelody(melody, waveType) {
    stopTrack();
    if (!audioCtx || !soundOn || !musicOn) return;
    var t = audioCtx.currentTime + 0.05;
    for (var i = 0; i < melody.length; i++) {
        var f = noteFreq(melody[i][0]);
        var d = melody[i][1] / 1000;
        if (f > 0) _tone({ t: t, dur: d * 0.9, freq: f, type: waveType || 'square', vol: 0.3, music: true });
        t += d;
    }
}

// ── Toggles ──────────────────────────────────────────────────────────────────
function _markDirty() { try { dirty = true; } catch (e) {} }

function toggleSound() {
    if (!soundOn) {
        initAudio();
        soundOn = true;
        var t = currentTrack;
        currentTrack = null;
        if (musicOn) setTrack(t || 'menu');
    } else {
        soundOn = false;
        stopTrack();
        currentTrack = null;
    }
    saveSoundSettings();
    _markDirty();
}

function toggleMusic() {
    musicOn = !musicOn;
    if (musicOn && soundOn) {
        var t = currentTrack;
        currentTrack = null;
        setTrack(t || 'menu');
    } else {
        stopTrack();
    }
    saveSoundSettings();
    _markDirty();
}

function toggleSfx() {
    sfxOn = !sfxOn;
    saveSoundSettings();
    _markDirty();
}

// ── Export shim (harmless when pasted into the game IIFE) ────────────────────

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
var titleFocus = 0;        // 0=Tourney 1=Quick 2=Choose 3=2P 4=Roster 5=Records 6=Settings
var TITLE_FOCUS_COUNT = 7;
var fsFocusIdx = 0;        // 0..15 = grid cell, 16=Back, 17=Start
var rosterFocusIdx = 0;    // 0..15 = grid cell, 16=Back
var settingsFocus = 0;     // 0=Sound 1=Music 2=Effects 3=Weapon 4=Difficulty
                           // 5=Tutorial 6=Delete 7=Close
var SETTINGS_FOCUS_COUNT = 8;
var bracketFocus = 1;      // 0=Quit 1=Continue (Continue is the natural default)

// Focus is rendered as the button's own gold border (via the `primary`
// parameter to drawButton) — no separate outline. Match Pixel Rugby.
function drawFocusBorder() { /* no-op — focus is in-button */ }

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
var S_STATS = 11;
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

// ── Career stats ──
//
// Everything the player does is counted. Without this nothing in the game
// persists past a single sitting, and there is no reason to come back.
//
var STATS_KEY = _KP + 'stats';
var stats = null;

function defaultStats() {
    return {
        bouts: 0, wins: 0, losses: 0,
        touchesFor: 0, touchesAgainst: 0,
        parries: 0, ripostes: 0, feints: 0, doubles: 0,
        tournaments: 0, titles: 0, finals: 0,
        bestStreak: 0, curStreak: 0,
        byWeapon: { foil: { w: 0, l: 0 }, epee: { w: 0, l: 0 }, sabre: { w: 0, l: 0 } },
        byCountry: {}          // code -> { w, l }
    };
}

function loadStats() {
    stats = defaultStats();
    try {
        var raw = localStorage.getItem(STATS_KEY);
        if (!raw) return;
        var s = JSON.parse(raw);
        if (s && typeof s === 'object') {
            for (var k in stats) {
                if (Object.prototype.hasOwnProperty.call(s, k) &&
                    typeof s[k] === typeof stats[k]) stats[k] = s[k];
            }
            // Older saves may predate these sub-objects.
            if (!stats.byWeapon) stats.byWeapon = defaultStats().byWeapon;
            if (!stats.byCountry) stats.byCountry = {};
            for (var wk in WEAPONS) if (!stats.byWeapon[wk]) stats.byWeapon[wk] = { w: 0, l: 0 };
        }
    } catch (e) { stats = defaultStats(); }
}

function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {}
}

function statsRecordTouch(scorer) {
    if (!stats) return;
    if (!scorer) { stats.doubles++; stats.touchesFor++; stats.touchesAgainst++; }
    else if (scorer.side === 1) {
        stats.touchesFor++;
        if (scorer.wasRiposte) stats.ripostes++;
        if (scorer.feint) stats.feints++;
    } else stats.touchesAgainst++;
}

function statsRecordParry() { if (stats) stats.parries++; }

function statsRecordBout(won, mine, theirs) {
    if (!stats) return;
    stats.bouts++;
    if (won) {
        stats.wins++;
        stats.curStreak++;
        if (stats.curStreak > stats.bestStreak) stats.bestStreak = stats.curStreak;
    } else {
        stats.losses++;
        stats.curStreak = 0;
    }
    var bw = stats.byWeapon[weaponKey];
    if (bw) { if (won) bw.w++; else bw.l++; }
    var code = bp1 && bp1.fencer ? bp1.fencer.code : null;
    if (code) {
        if (!stats.byCountry[code]) stats.byCountry[code] = { w: 0, l: 0 };
        if (won) stats.byCountry[code].w++; else stats.byCountry[code].l++;
    }
    saveStats();
}

// ── Favorite fencer ──
var FAV_KEY = _KP + 'favorite';
function loadFavorite() {
    try { return localStorage.getItem(FAV_KEY) || ''; } catch(e) { return ''; }
}
function saveFavorite(code) {
    try { localStorage.setItem(FAV_KEY, code); } catch(e) {}
}

// ── Bout state ──
//
// The piste is 14 meters long, side-on. Position 0 = center, ±2 = en-garde
// lines, ±7 = back of piste. Each fencer has a position and an `act` phase
// that drives the state machine. Right-of-way is tracked via `boutAttacker`.
//
// The action set is a timing triangle rather than a single attack button:
//
//   ATTACK  beats  a fencer who is just moving (and beats a late parry)
//   PARRY   beats  ATTACK          → and opens a RIPOSTE window
//   FEINT   beats  PARRY           → the blade goes around the block
//   RETREAT beats  ATTACK on distance, but concedes ground and tempo
//
// Everything costs stamina, so nothing can be spammed. Weapon choice
// (foil / épée / sabre) changes reach, speed and — for épée — whether
// right-of-way exists at all.
//
var PISTE_LEN = 14, PISTE_HALF = 7;
var BODY_R = 0.48;        // half-width of fencer's body hit zone (m),
                          // matched to the drawn sprite so bodies never overlap
var WALK_SPD = 4.2;       // m/s when advancing/retreating
var SIMUL_WINDOW = 110;   // ms — both attacks within this = simultaneous

// ── Weapons ──
//
// Foil  — torso target, right-of-way, balanced.
// Épée  — whole-body target, NO right-of-way (double touches score for both),
//         longest reach, slowest. Trading is a real and dangerous option.
// Sabre — right-of-way, fastest and shortest reach, cuts arrive wide so the
//         parry window is tighter but a successful parry pays more.
//
var WEAPONS = {
    foil: {
        key: 'foil', name: 'FOIL',
        blurb: 'RIGHT OF WAY · TORSO TARGET',
        desc: 'The classic. Whoever attacks first owns the point — block to steal it back.',
        reach: 1.75,
        priority: true,
        doubleTouch: false,
        tExtend: 170, tPeak: 80, tRecover: 380, tRecoverParried: 700,
        tParry: 200, tParryRecover: 140,
        riposteWindow: 520,
        walkMul: 1.0,
        staminaMul: 1.0
    },
    epee: {
        key: 'epee', name: 'EPEE',
        blurb: 'NO RIGHT OF WAY · WHOLE BODY',
        desc: 'No priority rules. Hit first, or hit together and you BOTH score. Longest reach.',
        reach: 2.15,
        priority: false,
        doubleTouch: true,
        tExtend: 205, tPeak: 95, tRecover: 430, tRecoverParried: 720,
        tParry: 185, tParryRecover: 150,
        riposteWindow: 460,
        walkMul: 0.92,
        staminaMul: 1.1
    },
    sabre: {
        key: 'sabre', name: 'SABRE',
        blurb: 'RIGHT OF WAY · CUTS · FASTEST',
        desc: 'Cut and thrust at speed. Short reach, brutal tempo, blink and the point is gone.',
        reach: 1.45,
        priority: true,
        doubleTouch: false,
        tExtend: 120, tPeak: 65, tRecover: 300, tRecoverParried: 640,
        tParry: 150, tParryRecover: 120,
        riposteWindow: 600,
        walkMul: 1.16,
        staminaMul: 0.9
    }
};
var WEAPON_ORDER = ['foil', 'epee', 'sabre'];
var WEAPON_KEY = _KP + 'weapon';
var weaponKey = 'foil';
function weapon() { return WEAPONS[weaponKey] || WEAPONS.foil; }
function loadWeapon() {
    try {
        var v = localStorage.getItem(WEAPON_KEY);
        if (v && WEAPONS[v]) weaponKey = v;
    } catch (e) {}
}
function saveWeapon() { try { localStorage.setItem(WEAPON_KEY, weaponKey); } catch (e) {} }

// ── Stamina ──
//
// Every committed action costs. Idle regenerates fastest, footwork regenerates
// slowly, so the fencer who never resets runs dry and gets slow. This is what
// stops the bout collapsing into lunge-spam.
//
var STAM_MAX = 100;
var STAM_COST = { lunge: 18, feint: 27, parry: 9, riposte: 11 };
var STAM_REGEN_IDLE = 26;   // per second
var STAM_REGEN_MOVE = 10;   // per second
var STAM_TIRED = 26;        // below this, actions slow down
var STAM_TIRED_MUL = 1.45;  // duration multiplier when tired

// Feints: press attack a second time early in the extend to disengage around
// a parry. Costs more, and whiffs badly if they never blocked.
var FEINT_WINDOW = 150;     // ms after starting a lunge in which ↑ becomes a feint

// Touch target — set per bout (5 for pool bouts, 15 for the final).
var BOUT_TARGET = 5;
var BOUT_TIME_MS = 180000;  // 3:00 on the clock

var bp1 = null, bp2 = null;
var boutAttacker = 0;     // 0=none, 1=p1, 2=p2
var boutSimul = false;    // simultaneous-attack flag
var boutMsg = '';
var boutMsgSub = '';      // secondary line under the main call
var boutMsgT = 0;
var boutHaltT = 0;        // time remaining in halt phase before reset
var boutClock = BOUT_TIME_MS;
var boutLastCall = '';    // 'touch1' | 'touch2' | 'double' | 'nopoint'
var boutMatchPoint = false;
var boutSuddenDeath = false;
var twoPlayer = false;
var bp1Keys = { advance: false, retreat: false };
var bp2Keys = { advance: false, retreat: false };

// How far forward the body travels during a lunge. Without this the attack is
// a pure range check and the measure game — the heart of fencing — disappears.
var LUNGE_ADVANCE = 0.85;   // metres the torso covers at full extension

// Where the piste is currently drawn (screen y). FX and blade maths need it.
var _pisteYCenter = 0;

// The fencer's effective position, including the lunge's forward travel.
function effPos(f) {
    var dir = f.side === 1 ? 1 : -1;
    return f.pos + dir * lungeTravel(f);
}

// 0..1 eased body travel through the attack, in metres.
function lungeTravel(f) {
    var w = weapon();
    var t = 0;
    if (f.act === 'lunge_extend') {
        t = 1 - (f.actT / Math.max(1, actDur(f, w.tExtend)));
        t = t * t * (3 - 2 * t);                     // smoothstep out of the guard
    } else if (f.act === 'lunge_peak') {
        t = 1;
    } else if (f.act === 'riposte') {
        t = 0.55 * (1 - (f.actT / Math.max(1, actDur(f, Math.round(w.tExtend * 0.62)))));
    } else if (f.act === 'lunge_recover') {
        t = Math.max(0, f.actT / Math.max(1, actDur(f, w.tRecover)));
        t = t * t;                                    // slump back to guard
    } else {
        return 0;
    }
    return LUNGE_ADVANCE * Math.max(0, Math.min(1, t)) * (f.wasRiposte ? 0.6 : 1);
}

// ── AI opponent ────────────────────────────────────────────────────────────
//
// The AI plays with the same verbs and the same stamina budget the player has,
// and it never reads state it shouldn't: an incoming attack is only "seen"
// after `reactionMs` of exposure, and every choice goes through a random roll.
//
// Two dials stack. `difficulty` sets the base competence. The fencer's own
// STYLE decides how they use it — a counter-attacker and a pressure fencer at
// the same difficulty feel like different opponents, which is what makes the
// 16-strong roster mean something.
//
var AI_STYLES = {
    // Comes forward relentlessly, attacks often, blocks rarely.
    pressure:   { label: 'PRESSURE',  aggr: 1.35, parry: 0.78, dist: -0.35, feint: 0.9,  patience: 0.55, riposte: 0.8 },
    // Sits at long range, waits for you to commit, then blocks and ripostes.
    counter:    { label: 'COUNTER',   aggr: 0.62, parry: 1.42, dist: 0.45,  feint: 0.7,  patience: 1.5,  riposte: 1.35 },
    // Textbook — no strong preference, punishes mistakes.
    classical:  { label: 'CLASSICAL', aggr: 1.0,  parry: 1.1,  dist: 0.0,   feint: 1.0,  patience: 1.0,  riposte: 1.1 },
    // Unpredictable tempo, heavy feint usage, hard to read.
    deceptive:  { label: 'DECEPTIVE', aggr: 1.05, parry: 0.95, dist: 0.1,   feint: 1.9,  patience: 0.8,  riposte: 1.0 },
    // Explosive: long stillness then a sudden fast attack from distance.
    explosive:  { label: 'EXPLOSIVE', aggr: 1.15, parry: 0.7,  dist: 0.3,   feint: 0.6,  patience: 1.7,  riposte: 0.75 }
};
var AI_STYLE_ORDER = ['pressure', 'counter', 'classical', 'deceptive', 'explosive'];

// Deterministic per-country style so a given flag always fences the same way.
function styleFor(fencer) {
    if (!fencer) return AI_STYLES.classical;
    if (fencer.style && AI_STYLES[fencer.style]) return AI_STYLES[fencer.style];
    var h = 0, code = fencer.code || '';
    for (var i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) & 0xffff;
    return AI_STYLES[AI_STYLE_ORDER[h % AI_STYLE_ORDER.length]];
}
function styleNameFor(fencer) {
    if (!fencer) return '';
    if (fencer.style && AI_STYLES[fencer.style]) return AI_STYLES[fencer.style].label;
    return styleFor(fencer).label;
}

var ai = null;

function newAI() {
    // Reaction is expressed as a FRACTION of the weapon's extend time, not as
    // a fixed millisecond figure. A flat 215ms against a 170ms lunge meant the
    // attack had already landed before the AI was allowed to perceive it, so
    // on Normal it could essentially never parry.
    var w0 = weapon();
    var k;
    if (difficulty === 0) {
        // EASY — usually too slow to catch the attack, holds a safe distance
        k = { reactFrac: 1.05, parryChance: 0.30, lungeRatePerSec: 0.85, feintChance: 0.05, riposteChance: 0.35, mistake: 0.30 };
    } else if (difficulty === 2) {
        // HARD — reads the attack early, blocks and ripostes, presses distance
        k = { reactFrac: 0.42, parryChance: 0.80, lungeRatePerSec: 2.0, feintChance: 0.32, riposteChance: 0.92, mistake: 0.04 };
    } else {
        k = { reactFrac: 0.68, parryChance: 0.58, lungeRatePerSec: 1.4, feintChance: 0.18, riposteChance: 0.70, mistake: 0.14 };
    }
    k.reactionMs = Math.round(w0.tExtend * k.reactFrac);

    var st = styleFor(bp2 && bp2.fencer);
    var strength = (bp2 && bp2.fencer && typeof bp2.fencer.strength === 'number') ? bp2.fencer.strength : 3;
    // Strength is worth real competence now, not the old ±8% nudge.
    var sB = (strength - 3) * 0.09;   // -0.27 .. +0.18

    var reach = weapon().reach;
    // The centre-to-centre gap at which a lunge just reaches.
    var hitGap = BODY_R * 2 + reach + LUNGE_ADVANCE;
    return {
        style: st,
        reactionMs: Math.max(55, k.reactionMs - (strength - 3) * 18),
        parryChance: clamp01(k.parryChance * st.parry + sB),
        riposteChance: clamp01(k.riposteChance * st.riposte + sB),
        feintChance: clamp01(k.feintChance * st.feint + sB * 0.5),
        lungeRatePerSec: k.lungeRatePerSec * st.aggr * (1 + sB),
        mistake: Math.max(0.01, k.mistake * (1 - sB)),
        // Preferred measure, expressed relative to the distance at which an
        // attack can actually land. Sitting at 1.5-2.5m was deep inside lunge
        // range, so the AI lived permanently inside the player's measure.
        idealMin: hitGap * 0.80 + st.dist,
        idealMax: hitGap * 1.18 + st.dist,
        engageDist: hitGap * 1.65 + st.dist,
        patience: st.patience,
        moveJitterMs: [90, 240],
        perceivedAttackTimer: -1,
        actionCooldown: 0,
        idleHoldTimer: 0,
        commitTimer: 0,       // counts down to a deliberate attack
        lastDist: 99
    };
}

function clamp01(v) { return Math.max(0.02, Math.min(0.97, v)); }

function aiSetMove(dir) {
    // AI controls bp2 — `advance` means moving toward p1 (decreasing x).
    bp2Keys.advance = (dir === 'advance');
    bp2Keys.retreat = (dir === 'retreat');
}

function updateAI(dt) {
    if (!ai || twoPlayer) return;
    var f = bp2, opp = bp1;
    var w = weapon();

    if (ai.actionCooldown > 0) ai.actionCooldown -= dt;
    if (ai.idleHoldTimer > 0) ai.idleHoldTimer -= dt;
    if (ai.commitTimer > 0) ai.commitTimer -= dt;

    // A queued feint fires a beat into an attack that's already under way, so
    // it has to be handled before the "committed" bail-out below.
    if (ai.pendingFeint > 0) {
        ai.pendingFeint -= dt;
        if (ai.pendingFeint <= 0) {
            ai.pendingFeint = 0;
            if (f.act === 'lunge_extend') startLunge(f, opp);
        }
    }

    // Committed to an action — can't change its mind, same as the player.
    if (f.act !== 'idle') {
        ai.perceivedAttackTimer = -1;
        aiSetMove('hold');
        return;
    }

    // Riposte window is open — take it, at a rate set by skill and style.
    if (f.riposteT > 0) {
        if (Math.random() < ai.riposteChance * (dt / 120)) {
            startLunge(f, opp);
            ai.actionCooldown = 300;
            return;
        }
    }

    var dist = f.pos - opp.pos;     // positive (bp2 is right of bp1)
    var oppAttacking = (opp.act === 'lunge_extend' || opp.act === 'lunge_peak' ||
                        opp.act === 'riposte') &&
                       (!w.priority || boutAttacker === opp.side);

    // Reaction tracking — the attack is only perceived after reactionMs.
    if (oppAttacking) {
        if (ai.perceivedAttackTimer < 0) ai.perceivedAttackTimer = 0;
        else ai.perceivedAttackTimer += dt;
    } else {
        ai.perceivedAttackTimer = -1;
    }

    if (oppAttacking && ai.perceivedAttackTimer >= ai.reactionMs && ai.actionCooldown <= 0) {
        var threatened = Math.abs(dist) <= (BODY_R * 2 + w.reach + LUNGE_ADVANCE + 0.35);
        if (threatened && Math.random() < ai.parryChance && f.stamina > STAM_COST.parry) {
            startParry(f, opp);
            ai.actionCooldown = 320;
            return;
        }
        // Not blocking: break distance instead. Retreating out of measure is
        // a legitimate answer, and it costs the attacker their tempo.
        if (threatened) { aiSetMove('retreat'); return; }
    }

    // Tired — back off and breathe rather than flailing.
    if (f.stamina < STAM_TIRED * 0.8 && !oppAttacking) {
        aiSetMove(dist < ai.idealMax ? 'retreat' : 'hold');
        if (Math.random() < 0.4) return;
    }

    // ── Distance management ──
    // Never retreat off the rear limit — that concedes the touch outright.
    var cornered = f.pos >= PISTE_HALF - 0.9;
    if (cornered) {
        if (f.stamina > STAM_COST.lunge && Math.random() < 0.5) {
            startLunge(f, opp);            // fight out of the corner
            ai.actionCooldown = 500;
            return;
        }
        aiSetMove(dist < ai.idealMin ? 'hold' : 'advance');
        return;
    }
    if (dist > ai.engageDist) { aiSetMove('advance'); return; }
    if (dist < ai.idealMin) { aiSetMove('retreat'); return; }
    if (dist > ai.idealMax) { aiSetMove('advance'); return; }

    // In measure — hold with jitter so the footwork doesn't look robotic.
    if (ai.idleHoldTimer > 0) {
        aiSetMove('hold');
    } else {
        ai.idleHoldTimer = ai.moveJitterMs[0] + Math.random() * (ai.moveJitterMs[1] - ai.moveJitterMs[0]);
        var roll = Math.random();
        // Patient styles spend more time holding and probing.
        var advBias = 0.35 / ai.patience;
        if (roll < advBias) aiSetMove('advance');
        else if (roll < advBias + 0.2) aiSetMove('retreat');
        else aiSetMove('hold');
    }

    // ── Attack decision ──
    var canAttack = ai.actionCooldown <= 0 && f.stamina > STAM_COST.lunge &&
                    (!w.priority || boutAttacker !== opp.side);
    if (!canAttack) return;

    var lungeProb = ai.lungeRatePerSec * dt / 1000;
    // Punish a whiffed attack — the recovery window is the free hit.
    if (opp.act === 'lunge_recover') lungeProb *= 4.5;
    // Only commit from a distance that can actually land.
    var inMeasure = Math.abs(dist) <= (BODY_R * 2 + w.reach + LUNGE_ADVANCE);
    if (!inMeasure) lungeProb *= 0.12;

    if (Math.random() < lungeProb) {
        startLunge(f, opp);
        ai.actionCooldown = 620;
        // Feint: follow up inside the window to go around an expected block.
        ai.pendingFeint = (Math.random() < ai.feintChance) ? (40 + Math.random() * 80) : 0;
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
        actElapsed: 0,
        touches: 0,
        flash: 0,
        stamina: STAM_MAX,
        riposteT: 0,        // >0 = riposte window open
        feint: false,       // current attack is a feint
        wasRiposte: false,  // current attack came out of a parry
        lean: 0,            // -1 retreating, +1 advancing (torso weight)
        stepT: 0,
        stepFrame: 0,
        skinIdx: skinFor(fencer),
        gasp: 0,            // out-of-breath indicator timer
        endT: 0,            // time spent retreating on the rear limit
        streak: 0,          // consecutive touches scored
        scorePop: 0         // scoreboard digit pop timer
    };
}

function resetEnGarde() {
    // Keep stamina between phrases — recovering it is part of the pacing —
    // but give a chunk back so nobody starts a phrase unable to act.
    bp1.pos = -2; bp1.act = 'idle'; bp1.actT = 0; bp1.actElapsed = 0; bp1.flash = 0;
    bp2.pos = 2;  bp2.act = 'idle'; bp2.actT = 0; bp2.actElapsed = 0; bp2.flash = 0;
    bp1.riposteT = bp2.riposteT = 0;
    bp1.feint = bp2.feint = false;
    bp1.wasRiposte = bp2.wasRiposte = false;
    bp1.lean = bp2.lean = 0;
    bp1.stamina = Math.min(STAM_MAX, bp1.stamina + 34);
    bp2.stamina = Math.min(STAM_MAX, bp2.stamina + 34);
    boutAttacker = 0;
    boutSimul = false;
    bp1Keys.advance = bp1Keys.retreat = false;
    bp2Keys.advance = bp2Keys.retreat = false;
    fxClearLights();
}

function startBout(f1, f2, opts) {
    opts = opts || {};
    bp1 = newFencerState(f1, 1);
    bp2 = newFencerState(f2, 2);
    twoPlayer = !!opts.twoPlayer;
    ai = twoPlayer ? null : newAI();
    BOUT_TARGET = opts.target || 5;
    boutClock = opts.time || BOUT_TIME_MS;
    boutSuddenDeath = false;
    boutMatchPoint = false;
    boutLastCall = '';
    boutAttacker = 0;
    boutSimul = false;
    boutMsg = 'EN GARDE';
    boutMsgSub = '';
    boutMsgT = 900;
    fxReset();
    camSnap();
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
function toggleSfxSetting() {
    sfxOn = !sfxOn;
    saveSoundSettings();
    if (sfxOn) sfxMenuConfirm();
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
        localStorage.removeItem(STATS_KEY);
        localStorage.removeItem(WEAPON_KEY);
    } catch(e) {}
    soundOn = false; sfxOn = true; musicOn = false;
    difficulty = 1;
    weaponKey = 'foil';
    stats = defaultStats();
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
    var dlgH = Math.min(VIEW_H - 12, p ? 570 : 402);
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
        drawButton(bx, by, bw, bh, 'Sound: ' + (soundOn ? 'ON' : 'OFF'), settingsFocus === 0);
        _settingsRects.sound = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap;
        drawButton(bx, by, bw, bh, 'Music: ' + (musicOn ? 'ON' : 'OFF'), settingsFocus === 1);
        _settingsRects.music = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap;
        // sfxOn was saved and honoured but had no way to change it.
        drawButton(bx, by, bw, bh, 'Effects: ' + (sfxOn ? 'ON' : 'OFF'), settingsFocus === 2);
        _settingsRects.sfx = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap;
        drawButton(bx, by, bw, bh, 'Weapon: ' + weapon().name, settingsFocus === 3);
        _settingsRects.weapon = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap;
        drawButton(bx, by, bw, bh, 'Difficulty: ' + _diffNames[difficulty], settingsFocus === 4);
        _settingsRects.difficulty = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap;
        drawButton(bx, by, bw, bh, 'How to Play', settingsFocus === 5);
        _settingsRects.tutorial = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap;
        drawButton(bx, by, bw, bh, 'Delete All Data', settingsFocus === 6);
        _settingsRects.del = { x: bx, y: by, w: bw, h: bh };
        by += bh + gap + (p ? 6 : 4);
        drawButton(bx, by, bw, bh, 'Close', settingsFocus === 7);
        _settingsRects.close = { x: bx, y: by, w: bw, h: bh };
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
        drawButton(bx, cby, cbw, bh, 'Delete', settingsFocus === 0);
        _settingsRects.confirmDel = { x: bx, y: cby, w: cbw, h: bh };
        drawButton(bx + cbw + gap, cby, cbw, bh, 'Cancel', settingsFocus === 1);
        _settingsRects.cancelDel = { x: bx + cbw + gap, y: cby, w: cbw, h: bh };
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
    var dlgW = p ? VIEW_W - 30 : 440;
    var dlgH = Math.min(VIEW_H - 16, p ? VIEW_H - 80 : 356);
    var dlgX = Math.round((VIEW_W - dlgW) / 2);
    var dlgY = Math.round((VIEW_H - dlgH) / 2);
    drawPixelRoundRect(dlgX, dlgY, dlgW, dlgH, 4, COLOR_GOLD);
    drawPixelRoundRect(dlgX + 3, dlgY + 3, dlgW - 6, dlgH - 6, 4, COLOR_BG_DARK);

    ctx.font = 'bold ' + (p ? 14 : 11) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillText('HOW TO FENCE', dlgX + dlgW / 2, dlgY + (p ? 26 : 22));

    var lineH = p ? 15 : 12;
    var ly = dlgY + (p ? 54 : 44);
    var leftX = dlgX + 20;

    // ── Controls table ──
    ctx.font = 'bold ' + (p ? 9 : 7) + 'px ' + FONT;
    var rows;
    if (_isTouchDevice) {
        rows = [
            ['HOLD L/R',   'Move along the piste'],
            ['TAP',        'Attack'],
            ['TAP TWICE',  'Feint — go around a block'],
            ['SWIPE DOWN', 'Block'],
            ['SWIPE UP',   'Attack / riposte']
        ];
    } else {
        rows = [
            ['\u2190 \u2192',  'Move along the piste'],
            ['\u2191 / SPACE', 'Attack'],
            ['\u2191 \u2191',  'Feint — go around a block'],
            ['\u2193',         'Block'],
            ['ESC',            'Quit']
        ];
    }
    for (var i = 0; i < rows.length; i++) {
        ctx.textAlign = 'left'; ctx.fillStyle = COLOR_GOLD;
        ctx.fillText(rows[i][0], leftX, ly);
        ctx.fillStyle = '#fff';
        ctx.fillText(rows[i][1], leftX + (p ? 130 : 92), ly);
        ly += lineH;
    }

    // ── The triangle ──
    ly += p ? 10 : 8;
    ctx.font = 'bold ' + (p ? 9 : 7) + 'px ' + FONT;
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillText('BLOCK beats ATTACK  \u2192  FEINT beats BLOCK', leftX, ly);
    ly += p ? 15 : 12;

    ctx.font = (p ? 9 : 7) + 'px ' + FONT;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    var rules;
    if (weapon().key === 'epee') {
        rules = [
            'EPEE has no priority. Whoever lands first',
            'scores — and if you both land together,',
            'you BOTH get a point. Longest reach.',
            '',
            'Block an attack, then attack straight back:',
            'that RIPOSTE is fast and hard to stop.',
            '',
            'Every action costs stamina (the bar under',
            'your score). Run dry and you slow down.'
        ];
    } else {
        rules = [
            'Whoever attacks first has the upper hand.',
            'Only their hit scores.',
            '',
            'No upper hand? BLOCK to steal it, then',
            'RIPOSTE immediately — fast and hard to stop.',
            '',
            'Expecting a block? Attack TWICE to FEINT',
            'around it. Feints miss badly, so time them.',
            '',
            'Every action costs stamina (the bar under',
            'your score). Run dry and you slow down.'
        ];
    }
    for (var ri = 0; ri < rules.length; ri++) {
        if (rules[ri]) ctx.fillText(rules[ri], leftX, ly);
        ly += p ? 13 : 10;
    }

    // Got it button
    var btnH = p ? 44 : 32;
    var btnW = p ? 200 : 160;
    var btnY = dlgY + dlgH - btnH - 14;
    drawButton(dlgX + dlgW / 2 - btnW / 2, btnY, btnW, btnH, 'Got It', true);
    _tutorialBtn = { x: dlgX + dlgW / 2 - btnW / 2, y: btnY, w: btnW, h: btnH };
}

// ── FX layer ───────────────────────────────────────────────────────────────
//
// One generic particle pool plus the screen-level effects that sell an impact:
// shake, hit-stop, full-screen flash, and the scoring lights. Everything here
// is purely cosmetic — the simulation never reads it — so it can be skipped
// entirely on a slow frame without desyncing anything.
//
var fxParticles = [];
var FX_MAX = 260;
var fxShakeMag = 0, fxShakeT = 0, fxShakeDur = 0;
var fxHitStopT = 0;
var fxFlashT = 0, fxFlashDur = 0, fxFlashColor = '#ffffff';
var fxLightL = 0, fxLightR = 0;       // scoring-light lamp timers (ms)
var fxCrowdHype = 0;                  // 0..1 crowd excitement, decays
var fxCrowdFlashes = [];              // camera flashes in the stands
var fxTrails = [];                    // blade motion trails

function fxReset() {
    fxParticles.length = 0;
    fxTrails.length = 0;
    fxCrowdFlashes.length = 0;
    fxShakeMag = fxShakeT = fxHitStopT = fxFlashT = 0;
    fxLightL = fxLightR = 0;
    fxCrowdHype = 0;
}

function fxClearLights() { fxLightL = fxLightR = 0; }

function fxShake(mag, dur) {
    // Don't let a small shake stomp a big one that's still playing.
    if (mag >= fxShakeMag || fxShakeT <= 0) {
        fxShakeMag = mag;
        fxShakeT = dur;
        fxShakeDur = dur;
    }
}

function fxHitStop(ms) { fxHitStopT = Math.max(fxHitStopT, ms); }

function fxFlash(ms, color) {
    fxFlashT = ms; fxFlashDur = ms; fxFlashColor = color || '#ffffff';
}

// The iconic red/green scoring box lights.
function fxLight(side) {
    if (side === 1) fxLightL = 1500; else fxLightR = 1500;
    fxFlash(55, side === 1 ? 'rgba(255,120,120,0.20)' : 'rgba(140,255,170,0.18)');
}

function fxPush(p) {
    if (fxParticles.length >= FX_MAX) fxParticles.shift();
    fxParticles.push(p);
}

// Bright metallic sparks — used for blade contact.
function fxSpark(x, y, n, color) {
    for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2;
        var sp = 40 + Math.random() * 150;
        fxPush({
            x: x, y: y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp - 30,
            life: 260 + Math.random() * 220,
            maxLife: 480,
            size: Math.random() < 0.35 ? 2 : 1,
            grav: 420,
            drag: 0.88,
            color: color || '#ffe9a0'
        });
    }
}

function fxClash(x, y) {
    fxSpark(x, y, 14, '#fff6d0');
    fxSpark(x, y, 6, '#9fd8ff');
    fxFlash(50, 'rgba(220,242,255,0.18)');
}

// Coloured burst in the scorer's colours when a touch lands.
function fxBloodBurst(x, y, colors) {
    var pal = (colors && colors.length) ? colors : ['#ffd700'];
    for (var i = 0; i < 22; i++) {
        var a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
        var sp = 60 + Math.random() * 190;
        fxPush({
            x: x, y: y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            life: 420 + Math.random() * 380,
            maxLife: 800,
            size: Math.random() < 0.5 ? 2 : 3,
            grav: 520,
            drag: 0.9,
            color: pal[i % pal.length]
        });
    }
    fxSpark(x, y, 10, '#ffffff');
}

// Scuff of dust kicked up off the piste.
function fxDust(x, yOff, dir, n) {
    n = n || 5;
    var y = _pisteYCenter + (yOff || 0);
    for (var i = 0; i < n; i++) {
        fxPush({
            x: x - dir * 6, y: y - 2 - Math.random() * 3,
            vx: -dir * (18 + Math.random() * 55),
            vy: -(8 + Math.random() * 34),
            life: 240 + Math.random() * 240,
            maxLife: 480,
            size: 1 + (Math.random() < 0.3 ? 1 : 0),
            grav: 130,
            drag: 0.9,
            color: 'rgba(190,215,245,0.75)'
        });
    }
}

// A short-lived streak following the point of the blade.
function fxTrail(f) {
    fxTrails.push({ f: f, pts: [], life: 340, maxLife: 340 });
    if (fxTrails.length > 6) fxTrails.shift();
}

function crowdReact(side) {
    fxCrowdHype = 1;
    var n = 5 + Math.floor(Math.random() * 6);
    for (var i = 0; i < n; i++) {
        fxCrowdFlashes.push({
            x: Math.random() * VIEW_W,
            y: _crowdTop + 3 + Math.random() * Math.max(4, _crowdH - 6),
            life: 90 + Math.random() * 260,
            delay: Math.random() * 500
        });
    }
    sfxCrowd(side ? 1 : 0.6);
}

function fxUpdate(dt) {
    var dts = dt / 1000;
    for (var i = fxParticles.length - 1; i >= 0; i--) {
        var p = fxParticles[i];
        p.life -= dt;
        if (p.life <= 0) { fxParticles.splice(i, 1); continue; }
        p.vy += p.grav * dts;
        var d = Math.pow(p.drag, dt / 16.67);
        p.vx *= d; p.vy *= d;
        p.x += p.vx * dts;
        p.y += p.vy * dts;
    }
    for (var t = fxTrails.length - 1; t >= 0; t--) {
        var tr = fxTrails[t];
        tr.life -= dt;
        if (tr.life <= 0) { fxTrails.splice(t, 1); continue; }
        var f = tr.f;
        if (f && (f.act === 'lunge_extend' || f.act === 'lunge_peak' || f.act === 'riposte')) {
            tr.pts.push({ x: bladeTipX(f), y: bladeTipY(f), t: 170 });
            if (tr.pts.length > 10) tr.pts.shift();
        }
        for (var k = tr.pts.length - 1; k >= 0; k--) {
            tr.pts[k].t -= dt;
            if (tr.pts[k].t <= 0) tr.pts.splice(k, 1);
        }
    }
    for (var c = fxCrowdFlashes.length - 1; c >= 0; c--) {
        var cf = fxCrowdFlashes[c];
        if (cf.delay > 0) { cf.delay -= dt; continue; }
        cf.life -= dt;
        if (cf.life <= 0) fxCrowdFlashes.splice(c, 1);
    }
    if (fxShakeT > 0) fxShakeT -= dt;
    if (fxFlashT > 0) fxFlashT -= dt;
    if (fxLightL > 0) fxLightL -= dt;
    if (fxLightR > 0) fxLightR -= dt;
    if (fxCrowdHype > 0) fxCrowdHype = Math.max(0, fxCrowdHype - dts * 0.55);
    if (bp1 && bp1.scorePop > 0) bp1.scorePop -= dt;
    if (bp2 && bp2.scorePop > 0) bp2.scorePop -= dt;
}

// Current shake offset, applied by draw() around the whole frame.
function fxShakeOffset() {
    if (fxShakeT <= 0) return null;
    var k = fxShakeT / Math.max(1, fxShakeDur);
    var m = fxShakeMag * k * k;
    return {
        x: (Math.random() * 2 - 1) * m,
        y: (Math.random() * 2 - 1) * m * 0.7
    };
}

function fxDrawParticles() {
    for (var i = 0; i < fxParticles.length; i++) {
        var p = fxParticles[i];
        var a = Math.max(0, Math.min(1, p.life / p.maxLife));
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
}

function fxDrawTrails() {
    for (var t = 0; t < fxTrails.length; t++) {
        var pts = fxTrails[t].pts;
        for (var i = 0; i < pts.length; i++) {
            var a = (pts[i].t / 170) * 0.5 * (i / Math.max(1, pts.length));
            if (a <= 0) continue;
            ctx.globalAlpha = a;
            ctx.fillStyle = '#eaf4ff';
            ctx.fillRect(Math.round(pts[i].x) - 1, Math.round(pts[i].y) - 1, 3, 2);
        }
    }
    ctx.globalAlpha = 1;
}

function fxDrawFlash() {
    if (fxFlashT <= 0) return;
    ctx.globalAlpha = Math.max(0, Math.min(1, fxFlashT / Math.max(1, fxFlashDur)));
    ctx.fillStyle = fxFlashColor;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalAlpha = 1;
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
    invalidateTournamentCache();
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

// Every drawFencer call site passed skinIdx 0, so the 2-5 tones per country
// in fencers.json were never used. Derive a stable index from the code.
function skinFor(fencer) {
    if (!fencer || !fencer.skin || !fencer.skin.length) return 0;
    var h = 0, c = fencer.code || '';
    for (var i = 0; i < c.length; i++) h = (h * 37 + c.charCodeAt(i) * 7) & 0xffff;
    return h % fencer.skin.length;
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
    invalidateTournamentCache();
    tournament = null;
    try { localStorage.removeItem(TOURNEY_KEY); } catch(e) {}
}

// ── Actions ────────────────────────────────────────────────────────────────
//
// Every committed action funnels through here so stamina, tempo and the
// right-of-way bookkeeping stay in one place.

// Scale an action's duration by how tired the fencer is.
function actDur(f, ms) {
    return (f.stamina < STAM_TIRED) ? Math.round(ms * STAM_TIRED_MUL) : ms;
}

function canAct(f, cost) {
    return f.act === 'idle' && f.stamina >= cost * 0.5;
}

function spend(f, cost) {
    f.stamina = Math.max(0, f.stamina - cost * weapon().staminaMul);
}

// Claim right-of-way for `f`, or flag a clash if the opponent just went too.
function claimPriority(f, opp) {
    var w = weapon();
    if (!w.priority) return;                 // épée: no right of way at all
    if (boutAttacker === 0) {
        boutAttacker = f.side;
    } else if (boutAttacker !== f.side) {
        // Opponent already attacking — near-simultaneous starts are a clash,
        // but only if both are actually close enough to land. A panic lunge
        // from across the piste must not cancel a real attack.
        var gap = Math.abs(f.pos - opp.pos);
        var bothInMeasure = gap <= (BODY_R * 2 + w.reach + LUNGE_ADVANCE * 1.2);
        if (opp.act === 'lunge_extend' &&
            (actDur(opp, w.tExtend) - opp.actT) < SIMUL_WINDOW && bothInMeasure) {
            boutSimul = true;
        }
        // Otherwise this is a counter-attack: priority stays with the opponent.
    }
}

function startLunge(f, opp) {
    var w = weapon();
    // Second press early in the extend converts the attack into a feint.
    if (f.act === 'lunge_extend' && !f.feint && f.actElapsed <= FEINT_WINDOW &&
        f.stamina >= STAM_COST.feint * 0.5) {
        f.feint = true;
        f.actT += 110;                       // the disengage costs a beat
        spend(f, STAM_COST.feint - STAM_COST.lunge);
        fxSpark(bladeTipX(f), bladeTipY(f), 5, '#ffe9a0');
        sfxFeint();
        boutMsg = 'FEINT!';
        boutMsgSub = '';
        boutMsgT = 620;
        return;
    }
    // Riposte — the reward for a successful parry. Fast, and it keeps priority.
    if (f.act === 'idle' && f.riposteT > 0) {
        if (f.stamina < STAM_COST.riposte * 0.5) return;
        spend(f, STAM_COST.riposte);
        f.act = 'riposte';
        f.actT = actDur(f, Math.round(w.tExtend * 0.62));
        f.actElapsed = 0;
        f.riposteT = 0;
        f.wasRiposte = true;
        if (w.priority) { boutAttacker = f.side; boutSimul = false; }
        sfxRiposte();
        fxTrail(f);
        return;
    }
    if (!canAct(f, STAM_COST.lunge)) return;
    if (f.stamina <= 2) { sfxExhausted(); f.gasp = 420; return; }

    spend(f, STAM_COST.lunge);
    f.act = 'lunge_extend';
    f.actT = actDur(f, w.tExtend);
    f.actElapsed = 0;
    f.feint = false;
    f.wasRiposte = false;
    claimPriority(f, opp);
    sfxLunge();
    fxTrail(f);
    fxDust(pisteX(f.pos), 0, f.side === 1 ? 1 : -1);
}

function startParry(f, opp) {
    var w = weapon();
    if (!canAct(f, STAM_COST.parry)) return;
    spend(f, STAM_COST.parry);
    f.act = 'parry';
    f.actT = actDur(f, w.tParry);
    f.actElapsed = 0;
    f.flash = 200;
    // Catch an attack already in flight.
    var incoming = (opp.act === 'lunge_extend' || opp.act === 'lunge_peak' ||
                    opp.act === 'riposte');
    var theirs = !w.priority || boutAttacker === opp.side;
    if (incoming && theirs) {
        if (opp.feint) {
            // Feint beats the parry: the blade goes around it and they keep
            // coming. The defender is now committed to a block that isn't there.
            boutMsg = 'DECEIVED!';
            boutMsgSub = 'THEY WENT AROUND YOUR BLOCK';
            boutMsgT = 700;
            f.act = 'parry_recover';
            f.actT = actDur(f, w.tParryRecover + 150);
            f.flash = 120;
            sfxWhiff();
            return;
        }
        resolveParry(f, opp);
    }
}

// A clean parry: the attacker is thrown into a long recovery and the defender
// gets a riposte window that they must actually use.
function resolveParry(defender, attacker) {
    var w = weapon();
    attacker.act = 'lunge_recover';
    attacker.actT = actDur(attacker, w.tRecoverParried);
    attacker.actElapsed = 0;
    attacker.flash = 0;
    attacker.feint = false;
    defender.act = 'parry_recover';
    defender.actT = actDur(defender, w.tParryRecover);
    defender.actElapsed = 0;
    defender.flash = 350;
    defender.riposteT = w.riposteWindow;
    if (w.priority) { boutAttacker = defender.side; boutSimul = false; }
    if (defender.side === 1) {
        boutMsg = 'PARRY!';
        boutMsgSub = 'RIPOSTE NOW';
    } else {
        boutMsg = 'BLOCKED';
        boutMsgSub = '';
    }
    boutMsgT = 900;
    fxClash(bladeTipX(attacker), bladeTipY(attacker));
    fxShake(5, 160);
    fxHitStop(70);
    sfxParry();
    if (defender.side === 1) statsRecordParry();
}

// Where the point of the blade currently is, in screen space — used by FX.
function bladeTipX(f) {
    var dir = f.side === 1 ? 1 : -1;
    var ext = (f.act === 'lunge_peak' || f.act === 'riposte') ? 1 :
              (f.act === 'lunge_extend' ? 1 - (f.actT / Math.max(1, actDur(f, weapon().tExtend))) : 0.25);
    return pisteX(effPos(f) + dir * (BODY_R + reachOf(f) * ext));
}
function bladeTipY(f) {
    return _pisteYCenter - 22;
}

// Would the other fencer's attack have arrived too? Used to validate clashes.
function defenderCanReach(defender, attacker) {
    if (defender.act !== 'lunge_extend' && defender.act !== 'lunge_peak' &&
        defender.act !== 'riposte') return false;
    var dir = defender.side === 1 ? 1 : -1;
    var tip = defender.pos + dir * (BODY_R + LUNGE_ADVANCE + reachOf(defender));
    return (dir === 1) ? (tip >= attacker.pos - BODY_R) : (tip <= attacker.pos + BODY_R);
}

function reachOf(f) {
    var w = weapon();
    var r = w.reach;
    if (f.act === 'riposte') r *= 0.88;      // riposte is short but very fast
    if (f.stamina < STAM_TIRED) r *= 0.94;   // tired arms fall short
    return r;
}

function tryHit(attacker, defender) {
    // Called when the attacker's point arrives. Decide if a touch lands.
    var w = weapon();
    var dir = attacker.side === 1 ? 1 : -1;
    var ap = effPos(attacker), dp = effPos(defender);
    var tip = ap + dir * (BODY_R + reachOf(attacker));
    var inRange = (dir === 1)
        ? (tip >= dp - BODY_R && ap < dp)
        : (tip <= dp + BODY_R && ap > dp);
    if (!inRange) {
        // Short. Whiffing a feint is expensive — that is the risk.
        if (attacker.feint) {
            attacker.actT = actDur(attacker, w.tRecover + 180);
            if (attacker.side === 1) {
                boutMsg = 'FEINT MISSED';
                boutMsgSub = '';
                boutMsgT = 700;
            }
        }
        sfxWhiff();
        return;
    }

    // Defender is mid-parry: blocked, unless this was a feint going around it.
    if (defender.act === 'parry' && !attacker.feint) {
        resolveParry(defender, attacker);
        return;
    }

    // Épée: no right of way. Both points landing inside the window score.
    if (w.doubleTouch) {
        var theyAlsoLanded = (defender.act === 'lunge_extend' &&
            (actDur(defender, w.tExtend) - defender.actT) < SIMUL_WINDOW) ||
            defender.act === 'lunge_peak';
        if (theyAlsoLanded) {
            scoreTouch(null, 'DOUBLE TOUCH', 'BOTH LIGHTS — ONE EACH');
            return;
        }
        scoreTouch(attacker, null, null);
        return;
    }

    // A clash only stands if their point could also have arrived.
    if (boutSimul && defenderCanReach(defender, attacker)) {
        haltNoPoint('SIMULTANEOUS', 'BOTH ATTACKED — NO POINT');
        return;
    }

    if (boutAttacker === attacker.side) {
        scoreTouch(attacker, null, null);
    } else {
        // The point landed but the other fencer owned the phrase.
        haltNoPoint(
            attacker.side === 1 ? 'NO POINT' : 'OFF TARGET',
            attacker.side === 1 ? 'THEY ATTACKED FIRST — BLOCK NEXT TIME'
                                : 'YOUR ATTACK HAD PRIORITY');
    }
}

// ── Scoring ────────────────────────────────────────────────────────────────

function haltNoPoint(msg, sub) {
    boutMsg = msg;
    boutMsgSub = sub || '';
    boutMsgT = 1300;
    boutHaltT = 1250;
    boutLastCall = 'nopoint';
    state = S_BOUT_HALT;
    fxShake(3, 120);
    sfxNoPoint();
}

// `scorer` null means a double touch (épée) — both fencers get one.
function scoreTouch(scorer, msg, sub) {
    var w = weapon();
    if (!scorer) {
        bp1.touches++; bp2.touches++;
        bp1.scorePop = 600; bp2.scorePop = 600;
        bp1.flash = 600; bp2.flash = 600;
        bp1.act = 'touched'; bp1.actT = 1100;
        bp2.act = 'touched'; bp2.actT = 1100;
        boutLastCall = 'double';
        boutMsg = msg || 'DOUBLE TOUCH';
        boutMsgSub = sub || '';
        fxLight(1); fxLight(2);
        fxShake(8, 260);
        fxHitStop(110);
        sfxDoubleTouch();
    } else {
        var victim = (scorer === bp1) ? bp2 : bp1;
        scorer.touches++;
        scorer.scorePop = 600;
        scorer.streak++;
        victim.streak = 0;
        victim.flash = 600;
        victim.act = 'touched';
        victim.actT = 1150;
        boutLastCall = (scorer.side === 1) ? 'touch1' : 'touch2';
        var how = scorer.wasRiposte ? 'RIPOSTE' : (scorer.feint ? 'FEINT' : null);
        if (scorer.side === 1) {
            boutMsg = how ? (how + ' — TOUCH!') : 'TOUCH!';
            boutMsgSub = 'POINT TO YOU';
        } else {
            boutMsg = 'TOUCH AGAINST';
            boutMsgSub = 'POINT TO ' + scorer.fencer.name.toUpperCase();
        }
        fxLight(scorer.side);
        fxBloodBurst(pisteX(victim.pos), _pisteYCenter - 26, scorer.fencer.colors);
        fxShake(scorer.side === 1 ? 9 : 6, 280);
        fxHitStop(130);
        if (scorer.side === 1) sfxTouchFor(); else sfxTouchAgainst();
    }
    boutMsgT = 1500;
    boutHaltT = 1450;
    state = S_BOUT_HALT;
    crowdReact(scorer ? scorer.side : 0);
    statsRecordTouch(scorer);

    // Match point drama — fire the sting once, on the touch that sets it up.
    if (!boutMatchPoint && Math.max(bp1.touches, bp2.touches) >= BOUT_TARGET - 1 &&
        !boutOver()) {
        boutMatchPoint = true;
        sfxMatchPoint();
    }
}

// ── Per-fencer update ──────────────────────────────────────────────────────

function updateFencer(f, opp, dt) {
    var w = weapon();
    if (f.flash > 0) f.flash = Math.max(0, f.flash - dt);
    if (f.gasp > 0) f.gasp = Math.max(0, f.gasp - dt);
    if (f.riposteT > 0) f.riposteT = Math.max(0, f.riposteT - dt);

    // Stamina: idle recovers fast, footwork recovers slowly, actions not at all.
    var keys = (f.side === 1) ? bp1Keys : bp2Keys;
    if (f.act === 'idle') {
        var moving = keys.advance || keys.retreat;
        f.stamina = Math.min(STAM_MAX, f.stamina +
            (moving ? STAM_REGEN_MOVE : STAM_REGEN_IDLE) * dt / 1000);
    }

    if (f.act === 'idle') return;
    f.actT -= dt;
    f.actElapsed += dt;
    if (f.actT > 0) return;

    if (f.act === 'lunge_extend') {
        f.act = 'lunge_peak';
        f.actT = actDur(f, w.tPeak);
        f.actElapsed = 0;
        tryHit(f, opp);
        return;
    }
    if (f.act === 'riposte') {
        f.act = 'lunge_peak';
        f.actT = actDur(f, Math.round(w.tPeak * 0.8));
        f.actElapsed = 0;
        tryHit(f, opp);
        return;
    }
    if (f.act === 'lunge_peak') {
        f.act = 'lunge_recover';
        f.actT = actDur(f, w.tRecover);
        f.actElapsed = 0;
        return;
    }
    if (f.act === 'lunge_recover') {
        f.act = 'idle';
        f.feint = false;
        f.wasRiposte = false;
        // Recovered without landing → the phrase is over, priority resets.
        if (boutAttacker === f.side) { boutAttacker = 0; boutSimul = false; }
        return;
    }
    if (f.act === 'parry') { f.act = 'parry_recover'; f.actT = actDur(f, w.tParryRecover); f.actElapsed = 0; return; }
    if (f.act === 'parry_recover') { f.act = 'idle'; f.actElapsed = 0; return; }
    if (f.act === 'touched') { f.act = 'idle'; f.actElapsed = 0; return; }
}

// ── Bout update ────────────────────────────────────────────────────────────

function boutOver() {
    return bp1.touches >= BOUT_TARGET || bp2.touches >= BOUT_TARGET;
}

function finishBout() {
    state = S_BOUT_RESULT;
    var playerWon = bp1.touches > bp2.touches;
    boutMsg = (playerWon ? bp1.fencer.name.toUpperCase() : bp2.fencer.name.toUpperCase()) + ' WINS!';
    boutMsgSub = '';
    boutMsgT = 0;
    boutMatchPoint = false;
    statsRecordBout(playerWon, bp1.touches, bp2.touches);
    if (boutContext === 'tournament' && tournament) finishTournamentMatch();
    if (playerWon) { spawnConfetti(bp1.fencer.colors); sfxVictory(); }
    else sfxDefeat();
    if (musicOn) { stopTrack(); currentTrack = null; }
}

function updateBout(dt) {
    // Hit-stop freezes the simulation for a few frames on impact.
    if (fxHitStopT > 0) {
        fxHitStopT -= dt;
        fxUpdate(dt);
        camUpdate(dt);
        dirty = true;
        return;
    }
    fxUpdate(dt);
    camUpdate(dt);

    if (state === S_BOUT_INTRO) {
        boutMsgT -= dt;
        if (boutMsgT <= 0) {
            if (boutMsg === 'EN GARDE') { boutMsg = 'READY?'; boutMsgSub = ''; boutMsgT = 550; }
            else if (boutMsg === 'READY?') { boutMsg = 'FENCE!'; boutMsgSub = ''; boutMsgT = 550; sfxAllez(); }
            else { state = S_BOUT_PLAY; boutMsg = ''; boutMsgSub = ''; }
        }
        dirty = true;
        return;
    }

    if (state === S_BOUT_PLAY) {
        var dts = dt / 1000;
        var w = weapon();
        boutClock = Math.max(0, boutClock - dt);

        // Movement (only while not committed to an action)
        var spd = WALK_SPD * w.walkMul;
        var s1 = bp1.stamina < STAM_TIRED ? 0.8 : 1;
        var s2 = bp2.stamina < STAM_TIRED ? 0.8 : 1;
        bp1.lean = 0; bp2.lean = 0;
        if (bp1.act === 'idle') {
            if (bp1Keys.advance) { bp1.pos += spd * s1 * dts; bp1.lean = 1; }
            if (bp1Keys.retreat) { bp1.pos -= spd * s1 * dts; bp1.lean = -1; }
        }
        if (bp2.act === 'idle') {
            if (bp2Keys.advance) { bp2.pos -= spd * s2 * dts; bp2.lean = 1; }
            if (bp2Keys.retreat) { bp2.pos += spd * s2 * dts; bp2.lean = -1; }
        }
        // Footwork step sounds + dust
        stepTick(bp1, dt);
        stepTick(bp2, dt);

        bp1.pos = Math.max(-PISTE_HALF, Math.min(PISTE_HALF, bp1.pos));
        bp2.pos = Math.max(-PISTE_HALF, Math.min(PISTE_HALF, bp2.pos));

        // Running out of piste concedes the touch, as it does in the sport.
        // Without this the rear five metres were purely decorative and
        // endless retreating was a free defence.
        if (checkPisteEnd(bp1, bp2, dt) || checkPisteEnd(bp2, bp1, dt)) return;
        var minGap = 2 * BODY_R + 0.1;
        if (bp2.pos - bp1.pos < minGap) {
            var mid = (bp1.pos + bp2.pos) / 2;
            bp1.pos = mid - minGap / 2;
            bp2.pos = mid + minGap / 2;
        }

        updateTouchHold();
        updateAI(dt);
        updateFencer(bp1, bp2, dt);
        updateFencer(bp2, bp1, dt);

        if (boutMsgT > 0) boutMsgT -= dt;

        // Time out — leader takes it, tie goes to sudden death (first touch).
        if (boutClock <= 0) {
            if (bp1.touches === bp2.touches) {
                boutSuddenDeath = true;
                boutClock = 60000;
                boutMsg = 'SUDDEN DEATH';
                boutMsgSub = 'NEXT TOUCH WINS';
                boutMsgT = 1600;
                sfxMatchPoint();
                } else {
                BOUT_TARGET = Math.max(bp1.touches, bp2.touches);
                finishBout();
                return;
            }
        }
        dirty = true;
        return;
    }

    if (state === S_BOUT_HALT) {
        if (boutMsgT > 0) boutMsgT -= dt;
        if (boutHaltT > 0) boutHaltT -= dt;
        if (boutHaltT <= 0) {
            if (boutOver() || (boutSuddenDeath && bp1.touches !== bp2.touches)) {
                if (boutSuddenDeath) BOUT_TARGET = Math.max(bp1.touches, bp2.touches);
                finishBout();
            } else {
                resetEnGarde();
                state = S_BOUT_PLAY;
                boutMsg = '';
                boutMsgSub = '';
            }
        }
        dirty = true;
        return;
    }
}

// A fencer pinned on their rear limit who keeps retreating gives up a point.
var PISTE_END_GRACE = 650;   // ms of grace before the referee calls it
function checkPisteEnd(f, opp, dt) {
    var atEnd = (f.side === 1) ? (f.pos <= -PISTE_HALF + 0.02)
                               : (f.pos >= PISTE_HALF - 0.02);
    var keys = (f.side === 1) ? bp1Keys : bp2Keys;
    if (!atEnd || !keys.retreat || f.act !== 'idle') {
        f.endT = 0;
        return false;
    }
    f.endT = (f.endT || 0) + dt;
    if (f.endT < PISTE_END_GRACE) return false;
    f.endT = 0;
    scoreTouch(opp, null, null);
    boutMsg = (f.side === 1) ? 'OFF THE END' : 'THEY RAN OUT OF PISTE';
    boutMsgSub = (f.side === 1) ? 'YOU RETREATED PAST THE LINE — POINT AGAINST'
                                : 'POINT TO YOU';
    return true;
}

// Footwork step cadence — a step sound and a puff of dust on each footfall.
function stepTick(f, dt) {
    var keys = (f.side === 1) ? bp1Keys : bp2Keys;
    if (f.act !== 'idle' || (!keys.advance && !keys.retreat)) { f.stepT = 0; return; }
    f.stepT -= dt;
    if (f.stepT <= 0) {
        f.stepT = 210;
        f.stepFrame = (f.stepFrame + 1) % 2;
        sfxStep();
        fxDust(pisteX(f.pos), 0, keys.advance ? (f.side === 1 ? 1 : -1) : (f.side === 1 ? -1 : 1), 2);
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
// ── Fencer sprite ────────────────────────────────────────────────────────────
//
// Procedural pixel art, pure canvas rects. Side-view foil fencer drawn on a
// fixed logical grid of 26 x 20 sprite-pixels, scaled by `s`.
//
//   drawFencer(px, py, fencer, size, facing, pose, skinIdx, opts)
//
//   px, py:   px = horizontal CENTER (body anchor), py = FEET baseline
//   fencer:   { colors: [primary, secondary], skin: [hex, ...] }
//   size:     base scale multiplier
//   facing:   'right' (default) or 'left'   (mirrored about px)
//   skinIdx:  index into fencer.skin
//   pose:     'en-garde' | 'advance' | 'retreat' | 'prep' | 'lunge' |
//             'recover' | 'parry-high' | 'parry-low' | 'riposte' |
//             'touched' | 'salute' | 'victory'
//   opts:     { bladeExt: 0..1, bobFrame: int, lean: -1..1 }
//
// The figure is built from a tiny skeleton (hip / shoulder / mask + 3-point
// arms and legs) which is stroked with `r()` rects, so every pose shares the
// same body construction and only the joint coordinates differ.
//
function drawFencer(px, py, fencer, size, facing, pose, skinIdx, opts) {
    var s = (size || 1) * 1.8;
    var fr = facing !== 'left';
    pose = pose || 'en-garde';
    opts = opts || {};
    var bladeExt = Math.max(0, Math.min(1, opts.bladeExt || 0));
    var bobFrame = opts.bobFrame || 0;
    var lean = Math.max(-1, Math.min(1, opts.lean || 0));
    var primary = (fencer && fencer.colors && fencer.colors[0]) || '#0055a4';
    var secondary = (fencer && fencer.colors && fencer.colors[1]) || '#ffffff';
    var SKIN_DEF = (typeof SKIN_MED !== 'undefined') ? SKIN_MED : '#e8c89e';
    var GOLD = (typeof COLOR_GOLD !== 'undefined') ? COLOR_GOLD : '#FFD700';
    var skins = (fencer && fencer.skin) || [SKIN_DEF];
    var sk = skins[(skinIdx || 0) % skins.length];

    // Constant uniform colors
    var WHITE = '#fafafa';        // jacket / breeches / sock (near side)
    var WHITE_SHADE = '#d8d8de';  // shading on the near side
    var FAR = '#b6bac6';          // far-side limbs (pushed back in depth)
    var FAR_DK = '#9aa0ae';       // far-side shading
    var MASK = '#3a3a3a';         // mask frame
    var MASK_DARK = '#26262c';    // back of mask / padding
    var MESH = '#6a6f7c';         // mask mesh face
    var MESH_LT = '#8d93a2';      // mesh highlight
    var GLOVE = '#1a1a1a';
    var SHOE = '#1a1a1a';
    var SHOE_SOLE = '#0a0a0a';
    var BLADE = '#dddddd';
    var BLADE_DARK = '#888888';
    var HAIR = '#3b2a1e';

    // Logical sprite grid is 26 wide x 20 tall. Column CX lands on `px`; the
    // bottom edge of row H-2 (the shoe sole) lands on `py`, row H-1 is the
    // ground shadow. Blades may reach 1-3 rows above row 0 in salute/victory.
    var H = 20, CX = 10;
    var ox = Math.round(px - CX * s);
    var oy = Math.round(py - (H - 1) * s);
    // 2-frame footwork bob: whole body 1px up on odd frames (shadow stays put)
    var bob = (bobFrame % 2 === 1) ? -1 : 0;

    function r(x, y, w, h, c) {
        ctx.fillStyle = c;
        ctx.fillRect(ox + x * s, oy + (y + bob) * s, w * s, h * s);
    }
    function rg(x, y, w, h, c) { // ground layer: not affected by the bob
        ctx.fillStyle = c;
        ctx.fillRect(ox + x * s, oy + y * s, w * s, h * s);
    }
    // Stroke a straight segment between two points with a given thickness.
    function seg(a, b, th, c) {
        var x0 = Math.round(a[0]), y0 = Math.round(a[1]);
        var x1 = Math.round(b[0]), y1 = Math.round(b[1]);
        var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        var horiz = dx >= dy;
        var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
        var half = Math.floor((th - 1) / 2);
        for (var guard = 0; guard < 64; guard++) {
            if (horiz) r(x0, y0 - half, 1, th, c);
            else r(x0 - half, y0, th, 1, c);
            if (x0 === x1 && y0 === y1) break;
            var e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x0 += sx; }
            if (e2 < dx) { err += dx; y0 += sy; }
        }
    }
    function add(p, dx, dy) { return [p[0] + dx, p[1] + dy]; }

    // ── Pose table ───────────────────────────────────────────────────────────
    // hip / sh(oulder) drive the torso; mask is the mask's top-left corner.
    // Legs: knee, ankle, foot [x, yTop, w]. Arms: [shoulder, elbow, hand].
    // blade: [dx, dy] direction + len. ext*: how far bladeExt pushes hand/blade.
    var C;
    switch (pose) {

    case 'advance':   // weight forward, front foot lifted mid-step
        C = { mask: [9, 2], sh: [11, 8], hip: [10, 12],
              backLeg:  { knee: [7, 14], ankle: [7, 16], foot: [5, 17, 4] },
              frontLeg: { knee: [13, 13], ankle: [15, 15], foot: [14, 15, 4], lift: 1 },
              frontArm: [[12, 8], [13, 10], [16, 9]],
              backArm:  [[10, 9], [7, 8], [6, 5]],
              blade: [1, -0.32], bladeLen: 7, extReach: 2, extLen: 4 };
        break;

    case 'retreat':   // weight back, back foot lifted mid-step
        C = { mask: [7, 2], sh: [9, 8], hip: [8, 12],
              frontLeg: { knee: [13, 14], ankle: [13, 16], foot: [12, 17, 4] },
              backLeg:  { knee: [7, 13], ankle: [5, 15], foot: [3, 15, 4], lift: 1 },
              frontArm: [[10, 8], [11, 10], [14, 9]],
              backArm:  [[8, 9], [5, 8], [4, 5]],
              blade: [1, -0.32], bladeLen: 7, extReach: 2, extLen: 4 };
        break;

    case 'prep':      // coiled, about to explode — deep knees, blade drawn back
        C = { mask: [8, 4], sh: [9, 10], hip: [9, 13],
              backLeg:  { knee: [6, 15], ankle: [5, 16], foot: [3, 17, 4] },
              frontLeg: { knee: [13, 15], ankle: [14, 16], foot: [13, 17, 5] },
              frontArm: [[10, 10], [12, 12], [13, 11]],
              backArm:  [[8, 10], [6, 10], [5, 8]],
              blade: [1, -0.55], bladeLen: 7, extReach: 1, extLen: 2 };
        break;

    case 'lunge':     // full extension
        C = { mask: [11, 3], sh: [12, 9], hip: [8, 13],
              backLeg:  { knee: [5, 15], ankle: [3, 16], foot: [0, 17, 5] },
              frontLeg: { knee: [16, 14], ankle: [16, 16], foot: [15, 17, 5] },
              frontArm: [[13, 9], [15, 9], [17, 9]],
              backArm:  [[10, 10], [7, 10], [4, 11]],
              blade: [1, 0], bladeLen: 6, extReach: 0, extLen: 2,
              torsoW: 5 };
        break;

    case 'recover':   // pulling back out of the lunge, off balance
        C = { mask: [6, 2], sh: [8, 8], hip: [9, 12],
              backLeg:  { knee: [6, 14], ankle: [5, 16], foot: [3, 17, 4] },
              frontLeg: { knee: [12, 13], ankle: [13, 15], foot: [12, 15, 4], lift: 1 },
              frontArm: [[9, 9], [11, 11], [13, 10]],
              backArm:  [[7, 9], [4, 9], [2, 7]],
              blade: [1, -0.2], bladeLen: 5, extReach: 0, extLen: 3 };
        break;

    case 'parry-high': // blade up, covering the high line
        C = { mask: [8, 2], sh: [10, 8], hip: [9, 12],
              backLeg:  { knee: [6, 14], ankle: [6, 16], foot: [4, 17, 4] },
              frontLeg: { knee: [13, 14], ankle: [13, 16], foot: [12, 17, 4] },
              frontArm: [[11, 8], [13, 9], [14, 9]],
              backArm:  [[9, 9], [6, 8], [5, 5]],
              blade: [0.55, -1], bladeLen: 8, extReach: 1, extLen: 2 };
        break;

    case 'parry-low':  // blade down, covering the low line
        C = { mask: [8, 2], sh: [10, 8], hip: [9, 12],
              backLeg:  { knee: [6, 14], ankle: [6, 16], foot: [4, 17, 4] },
              frontLeg: { knee: [13, 14], ankle: [13, 16], foot: [12, 17, 4] },
              frontArm: [[11, 8], [12, 10], [13, 11]],
              backArm:  [[9, 9], [6, 8], [5, 5]],
              blade: [1, 0.55], bladeLen: 8, extReach: 1, extLen: 2 };
        break;

    case 'riposte':   // fast counter-thrust, blade out but feet under the body
        C = { mask: [10, 2], sh: [11, 8], hip: [9, 12],
              backLeg:  { knee: [6, 14], ankle: [6, 16], foot: [4, 17, 4] },
              frontLeg: { knee: [13, 14], ankle: [13, 16], foot: [12, 17, 4] },
              frontArm: [[12, 8], [14, 8], [16, 8]],
              backArm:  [[10, 9], [7, 10], [5, 9]],
              blade: [1, -0.1], bladeLen: 6, extReach: 1, extLen: 3 };
        break;

    case 'touched':   // recoiling from a hit, arched back, arms flung
        C = { mask: [5, 3], sh: [8, 8], hip: [11, 12],
              backLeg:  { knee: [9, 15], ankle: [7, 16], foot: [5, 17, 4] },
              frontLeg: { knee: [13, 14], ankle: [14, 16], foot: [13, 17, 4] },
              frontArm: [[9, 8], [11, 6], [12, 4]],
              backArm:  [[8, 9], [5, 7], [3, 5]],
              blade: [1, -0.7], bladeLen: 6, extReach: 0, extLen: 0 };
        break;

    case 'salute':    // blade vertical in front of the mask
        C = { mask: [8, 1], sh: [10, 7], hip: [10, 12],
              backLeg:  { knee: [8, 14], ankle: [7, 16], foot: [5, 17, 4] },
              frontLeg: { knee: [11, 14], ankle: [11, 16], foot: [10, 17, 4] },
              frontArm: [[11, 8], [13, 9], [14, 7]],
              backArm:  [[9, 8], [8, 10], [8, 12]],
              blade: [0, -1], bladeLen: 7, extReach: 0, extLen: 0 };
        break;

    case 'victory':   // mask off, arms raised
        C = { mask: [8, 1], sh: [10, 7], hip: [10, 12], bare: 1,
              backLeg:  { knee: [8, 14], ankle: [7, 16], foot: [5, 17, 4] },
              frontLeg: { knee: [12, 14], ankle: [12, 16], foot: [11, 17, 4] },
              frontArm: [[11, 7], [13, 5], [15, 3]],
              backArm:  [[9, 7], [7, 5], [6, 3]],
              blade: [0.2, -1], bladeLen: 5, extReach: 0, extLen: 0 };
        break;

    default:          // 'en-garde' — idle guard
        pose = 'en-garde';
        C = { mask: [8, 2], sh: [10, 8], hip: [9, 12],
              backLeg:  { knee: [6, 14], ankle: [6, 16], foot: [4, 17, 4] },
              frontLeg: { knee: [13, 14], ankle: [13, 16], foot: [12, 17, 4] },
              frontArm: [[11, 8], [12, 10], [15, 9]],
              backArm:  [[9, 9], [6, 8], [5, 5]],
              blade: [1, -0.3], bladeLen: 7, extReach: 2, extLen: 4 };
        break;
    }

    // ── Apply opts.lean (weight transfer): shift the upper body, drag the hip ─
    var lx = Math.round(lean * 2);
    var hx = Math.round(lean * 1);
    if (lx || hx) {
        C.mask = add(C.mask, lx, 0);
        C.sh = add(C.sh, lx, 0);
        C.hip = add(C.hip, hx, 0);
        C.frontArm = C.frontArm.map(function (p) { return add(p, lx, 0); });
        C.backArm = C.backArm.map(function (p) { return add(p, lx, 0); });
    }

    // ── Apply opts.bladeExt: slide hand (and half the elbow) along the blade ──
    var bl = C.blade, bmag = Math.sqrt(bl[0] * bl[0] + bl[1] * bl[1]) || 1;
    var bdx = bl[0] / bmag, bdy = bl[1] / bmag;
    var reach = (C.extReach || 0) * bladeExt;
    var bladeLen = C.bladeLen + Math.round((C.extLen || 0) * bladeExt);
    var hand = add(C.frontArm[2], bdx * reach, bdy * reach);
    var elbow = add(C.frontArm[1], bdx * reach * 0.5, bdy * reach * 0.5);
    var shoulder = C.frontArm[0];

    // ── Transform for facing ─────────────────────────────────────────────────
    if (!fr) {
        ctx.save();
        ctx.translate(px, 0);
        ctx.scale(-1, 1);
        ctx.translate(-px, 0);
    }

    // ── Ground shadow (sized to the actual stance) ───────────────────────────
    var planted = [C.backLeg.foot, C.frontLeg.foot].filter(function (f, i) {
        return !(i === 0 ? C.backLeg.lift : C.frontLeg.lift);
    });
    var f0 = Math.min.apply(null, planted.map(function (f) { return f[0]; }));
    var f1 = Math.max.apply(null, planted.map(function (f) { return f[0] + f[2]; }));
    rg(f0 - 1, H - 1, (f1 - f0) + 2, 1, 'rgba(0,0,0,0.20)');

    // ── Helpers for the body parts ───────────────────────────────────────────
    function drawLeg(L, near) {
        var cloth = near ? WHITE : FAR;
        // hips split so the two legs open into a readable V
        var hip = add(C.hip, near ? 1 : -1, 0);
        seg(hip, L.knee, 3, cloth);            // thigh / breeches (thicker)
        seg(L.knee, L.ankle, 2, cloth);        // sock (thinner)
        r(L.knee[0], L.knee[1], 2, 1, near ? WHITE_SHADE : FAR_DK); // knee crease
        var f = L.foot;
        var up = near ? SHOE : '#242832';
        if (L.lift) {                          // lifted foot: toe angled up
            r(f[0] + 1, f[1], f[2] - 1, 1, up);
            r(f[0], f[1] + 1, f[2], 1, near ? SHOE_SOLE : '#141821');
        } else {
            r(f[0] + 1, f[1], f[2] - 1, 1, up);
            r(f[0], f[1] + 1, f[2], 1, near ? SHOE_SOLE : '#141821');
        }
    }

    // Sleeved arm: white jacket to the wrist, one pixel of skin, then the glove.
    // The far arm stays low-contrast (no skin, muted glove) so it reads as depth
    // instead of as loose noise floating next to the body.
    function drawArm(A, near, handColor) {
        var sleeve = near ? WHITE : FAR;
        seg(A[0], A[1], 2, sleeve);            // upper arm
        seg(A[1], A[2], 2, sleeve);            // forearm
        if (near) {
            var ex = A[2][0] - A[1][0], ey = A[2][1] - A[1][1];
            var m = Math.max(Math.abs(ex), Math.abs(ey)) || 1;
            r(Math.round(A[2][0] - ex / m), Math.round(A[2][1] - ey / m), 1, 1, sk);
        }
        r(Math.round(A[2][0]), Math.round(A[2][1]), 1, 1,
          handColor || (near ? GLOVE : '#4a4f5c'));
    }

    function shade(hex) {
        // darken a hex colour ~22% for far-side limbs
        var n = parseInt(hex.slice(1), 16);
        var rr = Math.round(((n >> 16) & 255) * 0.78);
        var gg = Math.round(((n >> 8) & 255) * 0.78);
        var bb = Math.round((n & 255) * 0.78);
        return 'rgb(' + rr + ',' + gg + ',' + bb + ')';
    }

    function drawMask(mx, my) {
        // Two-tone so the mesh face reads apart from the padded shell.
        r(mx + 1, my, 3, 1, MASK_DARK);    // crown
        r(mx, my + 1, 1, 3, MASK_DARK);    // back of the head
        r(mx + 1, my + 1, 3, 3, MESH);     // mesh face
        r(mx + 2, my + 1, 2, 1, MESH_LT);  // light catching the top of the mesh
        r(mx + 4, my + 1, 1, 3, MASK);     // front rim of the mask
        r(mx + 1, my + 4, 3, 1, MASK);     // chin bar
        r(mx + 1, my + 3, 1, 1, MASK);     // jaw shading
        r(mx, my, 1, 1, secondary);        // team stripe on the crown
        r(mx + 1, my + 5, 4, 1, WHITE);    // bib
        r(mx, my + 4, 1, 2, WHITE_SHADE);  // nape of the bib
    }

    function drawHead(mx, my) {            // mask off (victory)
        r(mx + 1, my, 3, 1, HAIR);
        r(mx, my + 1, 1, 2, HAIR);
        r(mx + 1, my + 1, 4, 3, sk);
        r(mx + 1, my + 1, 3, 1, HAIR);
        r(mx + 3, my + 2, 1, 1, '#2a2018'); // eye
        r(mx + 1, my + 4, 3, 1, sk);        // jaw
        r(mx + 1, my + 5, 3, 1, WHITE);     // collar
    }

    // ── Draw order: far limbs, torso, near leg, head, near arm, blade ────────
    drawLeg(C.backLeg, false);
    drawArm(C.backArm, false, C.bare ? shade(sk) : null);

    // Torso: stroke hip → shoulder with a 5-wide jacket, then the lamé plate
    var torsoW = C.torsoW || 5;
    seg(C.hip, C.sh, torsoW, WHITE);
    seg(add(C.hip, -2, 0), add(C.sh, -2, 0), 1, WHITE_SHADE);     // back edge
    r(C.hip[0] - 2, C.hip[1], torsoW, 1, WHITE_SHADE);            // waistband
    seg(add(C.hip, 0, 0), add(C.sh, 0, 1), torsoW - 2, primary);  // lamé plate
    r(C.sh[0] - 1, C.sh[1], 3, 1, secondary);                     // collar band
    r(C.sh[0] + 2, C.sh[1] + 1, 1, 1, WHITE);                     // front shoulder

    drawLeg(C.frontLeg, true);
    // crotch notch — keeps the two legs from merging into one white mass
    r(C.hip[0], C.hip[1] + 1, 1, 2, FAR_DK);

    if (C.bare) drawHead(C.mask[0], C.mask[1]);
    else drawMask(C.mask[0], C.mask[1]);

    // Held mask (victory)
    if (C.heldMask) {
        var hm = C.heldMask;
        r(hm[0] + 1, hm[1] - 1, 2, 1, MASK_DARK);
        r(hm[0], hm[1], 4, 3, MASK_DARK);
        r(hm[0] + 1, hm[1], 2, 2, MESH);
        r(hm[0] + 3, hm[1] + 3, 1, 1, WHITE_SHADE);  // bib dangling
    }

    // Weapon arm on top
    drawArm([shoulder, elbow, hand], true, GLOVE);

    // ── Weapon: guard, blade, tip ────────────────────────────────────────────
    var gx = hand[0] + bdx, gy = hand[1] + bdy;
    r(Math.round(gx), Math.round(gy), 1, 1, GOLD);          // bell guard
    r(Math.round(gx + bdy), Math.round(gy - bdx), 1, 1, GOLD);
    // opts.reachPx pins the point of the blade to the simulated reach, so what
    // you see connecting is exactly what the hit test uses. Without it the
    // drawn blade and the hitbox drift apart as the view scales.
    if (opts.reachPx && bdx > 0.3) {
        var wantTip = CX + (opts.reachPx / s);          // logical px from origin
        var needed = (wantTip - gx) / bdx;
        if (isFinite(needed)) bladeLen = Math.max(3, needed);
    }
    var b0 = [gx + bdx, gy + bdy];
    var b1 = [gx + bdx * bladeLen, gy + bdy * bladeLen];
    seg(b0, b1, 1, BLADE);
    r(Math.round(b1[0]), Math.round(b1[1]), 1, 1, BLADE_DARK);

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
var _titleSettingsBtn = { x: 0, y: 0, w: 0, h: 0 };
var _title2PBtn = { x: 0, y: 0, w: 0, h: 0 };
var _titleStatsBtn = { x: 0, y: 0, w: 0, h: 0 };
var _titleQuickBtn = { x: 0, y: 0, w: 0, h: 0 };

function drawTitle() {
    var p = isPortrait();
    // Fixed-size type so the bar doesn't grow with viewport
    var titleFont = p ? 28 : 24;
    var bylineFont = p ? 9 : 7;
    var barH = p ? 76 : 58;
    var btnH = p ? 50 : 34;
    var btnW = p ? Math.min(380, VIEW_W - 60) : 220;
    var btnGap = p ? 12 : 10;
    // Footer button row (Settings, like Pixel Rugby's bottom-right placement)
    var footerBtnW = p ? 110 : 90;
    var footerBtnH = p ? 30 : 22;
    var footerMargin = p ? 16 : 14;
    var footerY = VIEW_H - footerBtnH - footerMargin;

    // Background fill
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // Title banner
    ctx.fillStyle = COLOR_BG_DARK;
    ctx.fillRect(0, 0, VIEW_W, barH);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(0, barH - 2, VIEW_W, 2);

    var titleY = Math.round(barH * 0.42);
    ctx.font = 'bold ' + titleFont + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillText('PIXEL FENCING', VIEW_W / 2 + 3, titleY + 3);
    ctx.fillStyle = '#fff';
    ctx.fillText('PIXEL FENCING', VIEW_W / 2, titleY);
    ctx.font = bylineFont + 'px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('BY JORGE GONZALEZ MEDINA', VIEW_W / 2, barH - (p ? 16 : 12));

    // Five stacked main buttons. Difficulty lives in the Settings modal;
    // Settings and Records sit in the footer row.
    var totalBtnH = btnH * 5 + btnGap * 4;
    var btnTopY = footerY - totalBtnH - (p ? 20 : 14);

    // Available middle space between banner and buttons. Sprite size is sized
    // to fit ~70% of that height so it never collides with the banner.
    var midSpaceTop = barH + 8;
    var midSpaceBottom = btnTopY - 8;
    var midSpaceH = midSpaceBottom - midSpaceTop;
    var midSpaceCY = Math.round((midSpaceTop + midSpaceBottom) / 2);

    // drawFencer renders 19 logical px tall * 1.8 internal scale = 34.2 * size pixels.
    // Cap so the sprite uses at most 70% (landscape) / 78% (portrait) of midSpaceH.
    var fillRatio = p ? 0.78 : 0.70;
    var maxSpriteH = midSpaceH * fillRatio;
    var spriteSize = Math.max(1.5, Math.min(p ? 4.84 : 3.4, maxSpriteH / (20 * 1.8)));
    var spritePxH = 20 * 1.8 * spriteSize;
    // Place feet on the piste; piste sits a little below midSpaceCY so the
    // sprite's BODY (not feet) ends up roughly at midSpaceCY.
    var pisteCY = Math.round(midSpaceCY + spritePxH * 0.35);
    drawTitlePiste(VIEW_W / 2, pisteCY, p ? Math.min(320, VIEW_W - 80) : 260);

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
        // Idle animation: slow footwork bob + blade slowly extending and
        // retracting (like a fencer testing distance / warming up).
        var t = performance.now();
        var titleBob = Math.floor(t / 320);
        // Sine wave 0..1 over a 2.4-second cycle. Keep mostly extended (offset
        // 0.55 + 0.45*sin) so the blade is visible most of the time.
        var titleBladeExt = 0.55 + 0.45 * Math.sin(t / 380);
        drawFencer(VIEW_W / 2, pisteCY, titleFencer, spriteSize, 'right', 'en-garde',
            skinFor(titleFencer), { bobFrame: titleBob, bladeExt: titleBladeExt });
    }

    var tourneyLabel = hasSavedTournament() ? 'Continue Tournament' : 'Tournament';
    var bx = VIEW_W / 2 - btnW / 2;
    var rowY = btnTopY;
    drawButton(bx, rowY, btnW, btnH, tourneyLabel, titleFocus === 0);
    _titleTourneyBtn = { x: bx, y: rowY, w: btnW, h: btnH }; rowY += btnH + btnGap;
    drawButton(bx, rowY, btnW, btnH, 'Quick Bout', titleFocus === 1);
    _titleQuickBtn = { x: bx, y: rowY, w: btnW, h: btnH }; rowY += btnH + btnGap;
    drawButton(bx, rowY, btnW, btnH, 'Choose & Fence', titleFocus === 2);
    _titlePracticeBtn = { x: bx, y: rowY, w: btnW, h: btnH }; rowY += btnH + btnGap;
    drawButton(bx, rowY, btnW, btnH, '2 Players', titleFocus === 3);
    _title2PBtn = { x: bx, y: rowY, w: btnW, h: btnH }; rowY += btnH + btnGap;
    drawButton(bx, rowY, btnW, btnH, 'Roster', titleFocus === 4);
    _titleRosterBtn = { x: bx, y: rowY, w: btnW, h: btnH };

    // Footer: Records bottom-left, Settings bottom-right
    var recX = footerMargin + SAFE_X;
    drawButton(recX, footerY, footerBtnW, footerBtnH, 'Records', titleFocus === 5);
    _titleStatsBtn = { x: recX, y: footerY, w: footerBtnW, h: footerBtnH };
    var setX = VIEW_W - footerBtnW - footerMargin - SAFE_X;
    drawButton(setX, footerY, footerBtnW, footerBtnH, 'Settings', titleFocus === 6);
    _titleSettingsBtn = { x: setX, y: footerY, w: footerBtnW, h: footerBtnH };

    // Current weapon, so the player always knows what Quick Bout will start.
    ctx.font = 'bold ' + (p ? 9 : 7) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(weapon().name + '  ·  ' + _diffNames[difficulty],
        VIEW_W / 2, footerY + footerBtnH / 2);
}

// loadTournament() parses JSON and rebuilds objects; calling it every frame
// from drawTitle was pure waste. Cache the answer and invalidate on write.
var _savedTourneyCache = null;
function hasSavedTournament() {
    if (_savedTourneyCache === null) _savedTourneyCache = !!loadTournament();
    return _savedTourneyCache;
}
function invalidateTournamentCache() { _savedTourneyCache = null; }

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

        // Cell card — gold border when focused
        var cardX = gridX + col * cellW + 4;
        var cardY = cyTop + 2;
        var cardW = cellW - 8;
        var cardH = cellH - 6;
        var rosterFocused = (rosterFocusIdx === i);
        drawPixelRoundRect(cardX, cardY, cardW, cardH, 3, rosterFocused ? COLOR_GOLD : COLOR_BG_DARK);
        drawPixelRoundRect(cardX + 1, cardY + 1, cardW - 2, cardH - 2, 3, COLOR_BG_LIGHT);

        // Flag chip in top-left
        var flagW = p ? 16 : 13;
        var flagH = p ? 11 : 9;
        drawFlag(cardX + 4, cardY + 4, flagW, flagH, f.code);

        // Sprite — feet sit a bit above the label
        var labelH = p ? 22 : 18;
        var feetY = cardY + cardH - labelH - 4;
        var spriteSize = Math.max(1.3, Math.min(2.6, (cellH - labelH - 22) / 22));
        var pose = rosterFlipped[f.code] ? 'lunge' : 'en-garde';
        drawFencer(cx, feetY, f, spriteSize, 'right', pose, skinFor(f));

        // Label
        ctx.font = 'bold ' + (p ? 10 : 8) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(f.code, cx, cardY + cardH - labelH + 4);

        // Style label sits under the code, clear of the sprite.
        ctx.font = (p ? 6 : 5) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.fillStyle = COLOR_GOLD;
        ctx.fillText(styleNameFor(f), cx, cardY + cardH - 6);
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = (p ? 7 : 6) + 'px ' + FONT;
        ctx.fillText(f.strength + '*', cardX + cardW - 4, cardY + 9);

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
    drawButton(backX, backY, backW, bottomBtnH, 'Back', rosterFocusIdx === 16);
    _rosterBackBtn = { x: backX, y: backY, w: backW, h: bottomBtnH };
}
// ── Bout rendering ──
//
// The scene is built back-to-front: hall, stands, scoring apparatus, piste,
// fencers, then HUD. The piste geometry is the single source of truth for
// scale — the sprite is sized FROM it so that the drawn blade tip and the
// simulated hit reach are the same distance. They used to disagree by ~40% in
// portrait, which is what made attacks feel like they whiffed at contact.

var _pisteMargin = 30;
var _crowdTop = 0, _crowdH = 0, _playTop = 0;

// ── Camera ──
//
// The strip is 14 m long but a phrase happens inside about 4 m of it. Drawing
// the whole strip statically made the fencers either microscopic or, once
// scaled up to be readable, far too large for the piste they stand on. So the
// view tracks the action and zooms with the distance between the fencers —
// which also gives the bout its sense of closing and breaking measure.
//
var camCenter = 0, camPxPerM = 48;
var FENCER_H_M = 1.8;        // a fencer is this tall, in piste metres
var SPRITE_ROWS = 20;        // drawFencer's logical grid height

// How much of the strip is on screen. Portrait is narrow, so it holds a
// tighter view to keep the fencers a readable size.
function camMinViewM() { return isPortrait() ? 5.6 : 9.5; }
function camMaxViewM() { return isPortrait() ? 9.0 : 14.0; }

function camAvailW() { return VIEW_W - 2 * (_pisteMargin + SAFE_X); }

function camUpdate(dt) {
    if (!bp1 || !bp2) return;
    var a = effPos(bp1), b = effPos(bp2);
    var span = Math.abs(b - a) + 4.4;          // padding so nobody sits on the edge
    var viewM = Math.max(camMinViewM(), Math.min(camMaxViewM(), span));
    var targetPxPerM = camAvailW() / viewM;
    var halfView = viewM / 2;
    var targetCenter = (a + b) / 2;
    // Never show past the ends of the strip.
    if (viewM >= PISTE_LEN) targetCenter = 0;
    else targetCenter = Math.max(-PISTE_HALF + halfView,
                                 Math.min(PISTE_HALF - halfView, targetCenter));
    // Frame-rate independent smoothing.
    var k = 1 - Math.pow(0.0025, dt / 1000);
    camCenter += (targetCenter - camCenter) * k;
    camPxPerM += (targetPxPerM - camPxPerM) * k;
}

function camSnap() {
    if (!bp1 || !bp2) return;
    camCenter = 0;
    camPxPerM = camAvailW() / ((camMinViewM() + camMaxViewM()) / 2);
    camUpdate(1000);
}

function pisteX(m) { return VIEW_W / 2 + (m - camCenter) * camPxPerM; }
function pisteScale() { return camPxPerM; }

// Sprite scale follows the camera so a fencer is always FENCER_H_M tall in
// world terms — one scale for both the body and the strip it stands on.
function boutSpriteSize() {
    return (FENCER_H_M * camPxPerM) / (SPRITE_ROWS * 1.8);
}

// Distance from body centre to the point of the blade, in screen pixels.
// Passed to drawFencer so the drawn blade and the hit test always agree.
function reachPxOf(f) {
    return (BODY_R + reachOf(f)) * camPxPerM;
}

function drawPiste(yCenter) {
    var pisteH = 22;
    var py = yCenter - pisteH / 2;
    var x0 = pisteX(-PISTE_HALF);
    var x1 = pisteX(PISTE_HALF);

    // Hall floor: everything from just above the strip to the bottom edge, so
    // the lower third of the screen reads as floor instead of empty sky.
    ctx.fillStyle = '#16386a';
    ctx.fillRect(0, py - 6, VIEW_W, VIEW_H - (py - 6));
    ctx.fillStyle = '#112f5c';
    ctx.fillRect(0, py + pisteH + 10, VIEW_W, VIEW_H - (py + pisteH + 10));
    // Reflected strip glow on the polished floor
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = COLOR_BG_LIGHT;
    ctx.fillRect(pisteX(-PISTE_HALF), py + pisteH, pisteX(PISTE_HALF) - pisteX(-PISTE_HALF), 9);
    ctx.globalAlpha = 1;
    // Cable spool + score-box trunk at the foot of the strip
    ctx.fillStyle = '#0c2246';
    ctx.fillRect(0, VIEW_H - 22, VIEW_W, 22);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, VIEW_H - 22, VIEW_W, 1);

    // Strip
    ctx.fillStyle = COLOR_BG_LIGHT;
    ctx.fillRect(x0, py, x1 - x0, pisteH);
    // Subtle top-lit band so the strip reads as a surface, not a bar
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x0, py, x1 - x0, Math.floor(pisteH / 3));
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.fillRect(x0, py + pisteH - 4, x1 - x0, 4);

    // Borders
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0, py, x1 - x0, 1);
    ctx.fillRect(x0, py + pisteH - 1, x1 - x0, 1);
    // Centre line (gold)
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillRect(pisteX(0) - 1, py - 4, 2, pisteH + 8);
    // En-garde lines
    ctx.fillStyle = '#fff';
    ctx.fillRect(pisteX(-2), py - 2, 1, pisteH + 4);
    ctx.fillRect(pisteX(2),  py - 2, 1, pisteH + 4);
    // Warning lines — hatched, because backing past them matters
    for (var s = -1; s <= 1; s += 2) {
        var wx = pisteX(5 * s);
        ctx.fillStyle = 'rgba(255,180,80,0.55)';
        for (var hy = py + 2; hy < py + pisteH - 2; hy += 3) ctx.fillRect(wx, hy, 1, 2);
    }
    // Metre ticks
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    for (var m = -PISTE_HALF + 1; m <= PISTE_HALF - 1; m++) {
        if (m === 0 || m === -2 || m === 2 || m === -5 || m === 5) continue;
        ctx.fillRect(pisteX(m), py + pisteH - 3, 1, 2);
    }
}

// Which sprite pose the current action should draw.
function fencerPose(f) {
    switch (f.act) {
        case 'lunge_extend':  return f.actElapsed < 45 ? 'prep' : 'lunge';
        case 'lunge_peak':    return 'lunge';
        case 'riposte':       return 'riposte';
        case 'lunge_recover': return 'recover';
        case 'parry':         return 'parry-high';
        case 'parry_recover': return 'parry-low';
        case 'touched':       return 'touched';
        default:
            if (f.lean > 0) return 'advance';
            if (f.lean < 0) return 'retreat';
            return 'en-garde';
    }
}

// ── Scoreboard ──

function scoreboardH() { return isPortrait() ? 52 : 42; }

function fmtClock(ms) {
    var t = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
}

function drawScoreRibbon() {
    var p = isPortrait();
    var h = scoreboardH();
    ctx.fillStyle = COLOR_BG_DARK;
    ctx.fillRect(0, 0, VIEW_W, h);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(0, h - 1, VIEW_W, 1);

    var nameFont = p ? 12 : 10;
    var scoreFont = p ? 26 : 22;
    var midY = Math.round(h / 2) - (p ? 4 : 3);
    ctx.textBaseline = 'middle';

    // ── Left fencer ──
    drawFlag(SAFE_X + 8, midY - 6, 16, 12, bp1.fencer.code);
    ctx.font = 'bold ' + nameFont + 'px ' + FONT;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText(bp1.fencer.code, SAFE_X + 28, midY);
    drawScoreDigit(bp1, SAFE_X + 62, midY, scoreFont, 'left');

    // ── Right fencer ──
    drawFlag(VIEW_W - SAFE_X - 24, midY - 6, 16, 12, bp2.fencer.code);
    ctx.font = 'bold ' + nameFont + 'px ' + FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.fillText(bp2.fencer.code, VIEW_W - SAFE_X - 28, midY);
    drawScoreDigit(bp2, VIEW_W - SAFE_X - 62, midY, scoreFont, 'right');

    // ── Centre: clock, weapon, target ──
    ctx.textAlign = 'center';
    var urgent = boutClock < 20000;
    ctx.font = 'bold ' + (p ? 16 : 14) + 'px ' + FONT;
    ctx.fillStyle = boutSuddenDeath ? '#ff6666'
                  : (urgent && Math.floor(performance.now() / 400) % 2 === 0 ? '#ffaa44' : '#fff');
    ctx.fillText(fmtClock(boutClock), VIEW_W / 2, midY - 3);
    ctx.font = 'bold ' + (p ? 8 : 7) + 'px ' + FONT;
    var sub, subCol = 'rgba(255,255,255,0.62)';
    if (boutSuddenDeath) {
        sub = 'SUDDEN DEATH';
        subCol = '#ff8888';
    } else if (boutMatchPoint) {
        // One touch from the end — say so, and make it pulse.
        var lead = bp1.touches > bp2.touches ? bp1 : (bp2.touches > bp1.touches ? bp2 : null);
        sub = lead ? (lead.side === 1 ? 'MATCH POINT — YOURS' : 'MATCH POINT — THEIRS')
                   : 'MATCH POINT';
        subCol = (Math.floor(performance.now() / 320) % 2 === 0) ? COLOR_GOLD : '#fff';
    } else {
        sub = weapon().name + '  ·  FIRST TO ' + BOUT_TARGET;
    }
    ctx.fillStyle = subCol;
    ctx.fillText(sub, VIEW_W / 2, midY + (p ? 11 : 9));

    // ── Scoring lights ──
    // The single most iconic image in the sport, and it was missing.
    var lampW = p ? 26 : 22, lampH = p ? 12 : 10;
    var lampY = h - lampH - 3;
    drawLamp(SAFE_X + 8, lampY, lampW, lampH, '#ff4444', fxLightL > 0);
    drawLamp(VIEW_W - SAFE_X - 8 - lampW, lampY, lampW, lampH, '#44ff77', fxLightR > 0);

    // ── Stamina bars ──
    var barW = Math.min(120, VIEW_W / 2 - lampW - 70);
    drawStaminaBar(SAFE_X + 14 + lampW, lampY + 1, barW, lampH - 2, bp1, false);
    drawStaminaBar(VIEW_W - SAFE_X - 14 - lampW - barW, lampY + 1, barW, lampH - 2, bp2, true);
}

function drawScoreDigit(f, x, y, size, align) {
    // Pops on increment so a touch registers even in peripheral vision.
    var pop = f.scorePop > 0 ? (f.scorePop / 600) : 0;
    var sz = Math.round(size * (1 + pop * 0.5));
    ctx.font = 'bold ' + sz + 'px ' + FONT;
    ctx.textAlign = align;
    ctx.fillStyle = pop > 0 ? '#fff' : COLOR_GOLD;
    ctx.fillText(String(f.touches), x, y);
}

function drawLamp(x, y, w, h, color, on) {
    ctx.fillStyle = '#000';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = on ? color : 'rgba(255,255,255,0.09)';
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    if (on) {
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = color;
        ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
        ctx.globalAlpha = 1;
    }
}

function drawStaminaBar(x, y, w, h, f, rightToLeft) {
    if (w < 20) return;
    var frac = Math.max(0, Math.min(1, f.stamina / STAM_MAX));
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x, y, w, h);
    var fw = Math.round((w - 2) * frac);
    var col = f.stamina < STAM_TIRED ? '#ff7744'
            : (f.stamina < STAM_MAX * 0.6 ? '#ffcc44' : '#7fd8ff');
    ctx.fillStyle = col;
    if (rightToLeft) ctx.fillRect(x + 1 + (w - 2 - fw), y + 1, fw, h - 2);
    else ctx.fillRect(x + 1, y + 1, fw, h - 2);
    // Flash the bar when the fencer is gassed and tried to act anyway.
    if (f.gasp > 0 && Math.floor(performance.now() / 100) % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(x, y, w, h);
    }
}

// ── Priority / tempo indicator ──
//
// Sits over each fencer rather than printing the answer in the middle of the
// screen. Gold chevron = you own the phrase; red = they do, block to take it.

function drawPriorityIndicator(yCenter) {
    var yTop = yCenter - Math.round(SPRITE_ROWS * 1.8 * boutSpriteSize()) - 16;
    if (bp1.riposteT > 0) {
        drawCallout(pisteX(effPos(bp1)), yTop, 'RIPOSTE!', COLOR_GOLD, true);
        return;
    }
    if (boutAttacker === 0 && !boutSimul) return;
    if (boutSimul) {
        drawCallout(VIEW_W / 2, yTop, 'CLASH', '#ffaa44', false);
        return;
    }
    if (!weapon().priority) return;   // épée has no right of way to show
    var mine = (boutAttacker === 1);
    drawCallout(pisteX(effPos(mine ? bp1 : bp2)), yTop,
        mine ? 'ATTACK' : 'BLOCK!', mine ? COLOR_GOLD : '#ff5555', mine);
}

// Flash a warning once the player is past their rear warning line.
function drawPisteWarning(yCenter) {
    if (!bp1 || state !== S_BOUT_PLAY) return;
    if (bp1.pos > -5) return;
    var atEnd = bp1.pos <= -PISTE_HALF + 0.05;
    if (Math.floor(performance.now() / 260) % 2 === 0 && !atEnd) return;
    ctx.font = 'bold 8px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = atEnd ? '#ff5555' : '#ffaa44';
    ctx.fillText(atEnd ? 'END OF PISTE!' : 'RUNNING OUT OF PISTE',
        pisteX(bp1.pos), yCenter + 20);
}

function drawCallout(x, y, label, color, up) {
    ctx.font = 'bold 9px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var pulse = 0.75 + 0.25 * Math.sin(performance.now() / 130);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = color;
    ctx.fillText(label, x, y);
    ctx.beginPath();
    ctx.moveTo(x - 5, y + 8);
    ctx.lineTo(x + 5, y + 8);
    ctx.lineTo(x, y + 14);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
}

// ── Fencers ──

function drawFencerOnPiste(f, yFeet, spriteSize) {
    var sx = pisteX(effPos(f));

    // Ground shadow, tightening as the body drops into the lunge
    var sw = spriteSize * (f.act === 'lunge_peak' ? 30 : 20);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(Math.round(sx - sw / 2), yFeet - 1, Math.round(sw), 2);

    // Impact glow
    if (f.act === 'touched' && f.flash > 0) {
        var alpha = Math.min(1, f.flash / 600);
        ctx.globalAlpha = alpha * 0.5;
        ctx.fillStyle = '#ff5050';
        ctx.fillRect(Math.round(sx - 22), yFeet - 52, 44, 52);
        ctx.globalAlpha = 1;
    }

    var bladeExt = 0;
    if (f.act === 'lunge_extend') {
        bladeExt = 1 - (f.actT / Math.max(1, actDur(f, weapon().tExtend)));
    } else if (f.act === 'riposte') {
        bladeExt = 1 - (f.actT / Math.max(1, actDur(f, Math.round(weapon().tExtend * 0.62))));
    } else if (f.act === 'lunge_peak') {
        bladeExt = 1;
    } else if (f.act === 'lunge_recover') {
        bladeExt = Math.max(0, f.actT / Math.max(1, actDur(f, weapon().tRecover)) * 0.6);
    }

    // Idle breathing so a standing fencer is never a frozen image.
    var bobFrame = 0;
    if (f.act === 'idle') {
        var keys = (f.side === 1) ? bp1Keys : bp2Keys;
        bobFrame = (keys.advance || keys.retreat)
            ? f.stepFrame
            : (Math.sin(performance.now() / 620 + f.side) > 0.72 ? 1 : 0);
    }

    // Only pin the blade length for the poses that can actually score — the
    // parries angle the blade off-axis and must keep their authored length.
    var pose = fencerPose(f);
    var thrusting = (pose === 'lunge' || pose === 'riposte');
    drawFencer(sx, yFeet, f.fencer, spriteSize, f.facing, pose, f.skinIdx || 0,
        { bladeExt: bladeExt, bobFrame: bobFrame, lean: f.lean,
          weapon: weaponKey, reachPx: thrusting ? reachPxOf(f) : 0 });

    // Out-of-breath puff
    if (f.gasp > 0 || (f.act === 'idle' && f.stamina < STAM_TIRED &&
        Math.floor(performance.now() / 500) % 4 === 0)) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#cfe4ff';
        var gx = sx + (f.facing === 'right' ? 12 : -14) * spriteSize * 0.5;
        ctx.fillRect(Math.round(gx), Math.round(yFeet - 44 * spriteSize * 0.5), 2, 2);
        ctx.globalAlpha = 1;
    }
}

// ── Bout message ──
//
// Auto-shrinks to fit. Long calls used to run off both edges in portrait.

function drawBoutMessage(yCenter) {
    if (!boutMsg || boutMsgT <= 0) return;
    var p = isPortrait();
    var maxW = VIEW_W - 24;

    var fontSize = p ? 20 : 18;
    ctx.font = 'bold ' + fontSize + 'px ' + FONT;
    while (fontSize > 7 && ctx.measureText(boutMsg).width > maxW - 24) {
        fontSize--;
        ctx.font = 'bold ' + fontSize + 'px ' + FONT;
    }
    var mainW = ctx.measureText(boutMsg).width;

    var subSize = 0, subW = 0;
    if (boutMsgSub) {
        subSize = Math.max(6, Math.round(fontSize * 0.5));
        ctx.font = 'bold ' + subSize + 'px ' + FONT;
        while (subSize > 5 && ctx.measureText(boutMsgSub).width > maxW - 24) {
            subSize--;
            ctx.font = 'bold ' + subSize + 'px ' + FONT;
        }
        subW = ctx.measureText(boutMsgSub).width;
    }

    var w = Math.min(maxW, Math.max(mainW, subW) + 26);
    var h = fontSize + (boutMsgSub ? subSize + 10 : 0) + 16;
    var bx = Math.round(VIEW_W / 2 - w / 2);
    var spriteH = Math.round(SPRITE_ROWS * 1.8 * boutSpriteSize());
    var by = Math.max(_playTop + 6,
                      Math.round(_pisteYCenter - spriteH - 46 - h));

    // Slide-and-fade in over the first 120ms
    var age = Math.min(1, (1 - Math.max(0, Math.min(1, boutMsgT / 1500))) * 12);
    ctx.globalAlpha = Math.min(1, 0.35 + age);
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(bx, by, w, h);
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillRect(bx, by, w, 2);
    ctx.fillRect(bx, by + h - 2, w, 2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold ' + fontSize + 'px ' + FONT;
    ctx.fillStyle = '#fff';
    ctx.fillText(boutMsg, VIEW_W / 2, by + 8 + fontSize / 2);
    if (boutMsgSub) {
        ctx.font = 'bold ' + subSize + 'px ' + FONT;
        ctx.fillStyle = COLOR_GOLD;
        ctx.fillText(boutMsgSub, VIEW_W / 2, by + h - 10 - subSize / 2);
    }
    ctx.globalAlpha = 1;
}

// Touch gesture state for the bout. Mobile uses no on-screen buttons —
// instead: hold left/right half = walk, tap = lunge, swipe down = parry,
// swipe up = lunge.
var _touchActive = false;
// Swipe threshold in VIEW units. 22 was ~17 real px in portrait, so ordinary
// thumb drift while holding to walk fired unintended attacks.
var TOUCH_SWIPE_DIST = 34;
var TOUCH_TAP_MS = 190;
var TOUCH_HOLD_MS = 210;   // must exceed TOUCH_TAP_MS or tap and hold overlap

function drawBoutControlsHint(yBottom) {
    ctx.font = '7px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    if (_isTouchDevice) {
        ctx.fillText('HOLD = MOVE   TAP = ATTACK   SWIPE DOWN = BLOCK   TAP TWICE = FEINT',
            VIEW_W / 2, yBottom);
        return;
    }
    if (twoPlayer) {
        ctx.fillText('P1  A D  MOVE   W ATTACK   S BLOCK          P2  ← →  MOVE   ↑ ATTACK   ↓ BLOCK',
            VIEW_W / 2, yBottom);
        return;
    }
    ctx.fillText('← → MOVE    ↑ ATTACK (TWICE = FEINT)    ↓ BLOCK    ESC QUIT',
        VIEW_W / 2, yBottom);
}

// ── Crowd ──
//
// Rendered once to an offscreen canvas and blitted, instead of ~2,000 fillRect
// calls every frame. Reactions are drawn live on top of the cached bitmap.

var _crowdCache = null, _crowdCacheKey = '';

function buildCrowdCache(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    var g = c.getContext('2d');
    g.fillStyle = '#08182f';
    g.fillRect(0, 0, w, h);

    // Tiered stands — darker and denser toward the back
    var rowSpacing = 7;
    var rows = Math.max(3, Math.floor((h - 6) / rowSpacing));
    var colSpacing = 8;
    var cols = Math.ceil(w / colSpacing) + 2;
    var palette = ['#5d6c8a', '#4a5874', '#5b6c8a', '#6f7d99', '#3d4a64',
                   '#7c5c4a', '#5a4030', '#8a6450', '#46527a', '#6b7a96'];
    for (var rr = 0; rr < rows; rr++) {
        var ry = 3 + rr * rowSpacing;
        var depth = 1 - (rr / rows) * 0.45;      // front rows brighter
        var stagger = (rr % 2) * (colSpacing / 2);
        // Terrace step
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.fillRect(0, ry + 4, w, 2);
        for (var cc = 0; cc < cols; cc++) {
            var cx = Math.floor(cc * colSpacing - stagger);
            if (cx < -6 || cx > w) continue;
            var seed = ((rr + 1) * 31 + (cc + 1) * 17) & 0xff;
            if (seed % 11 === 0) continue;       // empty seat
            var col = palette[seed % palette.length];
            g.globalAlpha = depth;
            g.fillStyle = col;
            g.fillRect(cx, ry, 4, 3);            // head
            g.fillStyle = 'rgba(0,0,0,0.35)';
            g.fillRect(cx, ry + 3, 4, 1);        // shoulder shadow
            g.globalAlpha = 1;
        }
    }
    // Front rail + banner strip
    g.fillStyle = '#12294a';
    g.fillRect(0, h - 5, w, 5);
    g.fillStyle = COLOR_GOLD;
    g.globalAlpha = 0.35;
    g.fillRect(0, h - 5, w, 1);
    g.globalAlpha = 1;
    return c;
}

function drawCrowd(yTop, height) {
    _crowdTop = yTop; _crowdH = height;
    var key = Math.round(VIEW_W) + 'x' + Math.round(height);
    if (!_crowdCache || _crowdCacheKey !== key) {
        _crowdCache = buildCrowdCache(VIEW_W, height);
        _crowdCacheKey = key;
    }
    // Excitement lifts the whole stand a pixel on the beat.
    var bob = (fxCrowdHype > 0.3 && Math.floor(performance.now() / 130) % 2 === 0) ? -1 : 0;
    ctx.drawImage(_crowdCache, 0, yTop + bob);

    // Camera flashes
    for (var i = 0; i < fxCrowdFlashes.length; i++) {
        var cf = fxCrowdFlashes[i];
        if (cf.delay > 0) continue;
        ctx.globalAlpha = Math.max(0, Math.min(1, cf.life / 120)) * 0.9;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(cf.x), Math.round(cf.y), 3, 2);
        ctx.globalAlpha = 1;
    }
}

// Spectators on the near side of the piste, seen from behind and in shadow.
function drawForegroundStand(top) {
    var h = VIEW_H - top;
    if (h <= 0) return;
    ctx.fillStyle = '#0a1c36';
    ctx.fillRect(0, top, VIEW_W, h);
    // Barrier along the front of the strip
    ctx.fillStyle = '#14304f';
    ctx.fillRect(0, top - 4, VIEW_W, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(0, top - 4, VIEW_W, 1);

    // Rows get larger toward the camera.
    var rows = Math.max(1, Math.floor(h / 26));
    for (var r = 0; r < rows; r++) {
        var scale = 1 + r * 0.35;
        var ry = top + 8 + r * Math.round(h / rows);
        var hw = Math.round(7 * scale);        // head width
        var hh = Math.round(6 * scale);
        var step = Math.round(20 * scale);
        var offset = (r % 2) * Math.round(step / 2);
        var shade = 0.55 - r * 0.12;
        for (var x = -offset; x < VIEW_W + step; x += step) {
            var seed = ((r + 3) * 41 + (x + 7) * 13) & 0xff;
            if (seed % 9 === 0) continue;
            var bob = (fxCrowdHype > 0.35 &&
                       (seed + Math.floor(performance.now() / 150)) % 3 === 0) ? -2 : 0;
            ctx.globalAlpha = Math.max(0.25, shade);
            ctx.fillStyle = '#000913';
            ctx.fillRect(x, ry + bob, hw, hh);                       // head
            ctx.fillRect(x - Math.round(hw * 0.4), ry + hh + bob,
                         Math.round(hw * 1.8), Math.round(hh * 1.4)); // shoulders
            ctx.globalAlpha = 1;
        }
    }
}

// Overhead hall lighting, truss and banners — fills the space above the piste.
function drawArena(top, bottom) {
    var h = bottom - top;
    if (h <= 0) return;
    // Deep hall wash, darker toward the roof
    ctx.fillStyle = '#1a4680';
    ctx.fillRect(0, top, VIEW_W, h);
    ctx.fillStyle = 'rgba(4,18,40,0.45)';
    ctx.fillRect(0, top, VIEW_W, Math.min(h, 26));

    // Roof truss
    ctx.fillStyle = '#0d2244';
    ctx.fillRect(0, top + 6, VIEW_W, 3);
    for (var tx = 0; tx < VIEW_W; tx += 14) {
        ctx.fillRect(tx, top, 2, 7);
    }

    // Hanging banners — the two nations in the bout
    var bannerY = top + 12;
    var bh = Math.min(38, Math.max(16, h * 0.22));
    drawBanner(VIEW_W * 0.10, bannerY, 34, bh, bp1.fencer);
    drawBanner(VIEW_W * 0.90 - 34, bannerY, 34, bh, bp2.fencer);

    // Overhead scoreboard. Mostly this is what fills a tall portrait screen,
    // but it earns its place by making the score readable from the action.
    // Only on tall screens. In landscape the hall is short, and a board big
    // enough to read would crowd out the action it sits above.
    if (h > 240) drawJumbotron(top + 12 + Math.max(0, (h - 240) * 0.30), h);
    // Light pools falling on the strip
    var pools = 4;
    for (var i = 0; i < pools; i++) {
        var cx = VIEW_W * (i + 0.5) / pools;
        var grd = ctx.createLinearGradient(0, top, 0, bottom);
        grd.addColorStop(0, 'rgba(255,245,210,0.10)');
        grd.addColorStop(1, 'rgba(255,245,210,0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.moveTo(cx - 14, top);
        ctx.lineTo(cx + 14, top);
        ctx.lineTo(cx + 52, bottom);
        ctx.lineTo(cx - 52, bottom);
        ctx.closePath();
        ctx.fill();
        // The lamp itself
        ctx.fillStyle = '#ffeeb0';
        ctx.fillRect(Math.round(cx) - 10, top + 1, 20, 3);
        ctx.fillStyle = 'rgba(255,238,176,0.35)';
        ctx.fillRect(Math.round(cx) - 13, top, 26, 5);
    }
}

// Big hanging scoreboard above the piste.
function drawJumbotron(top, hallH) {
    var w = Math.min(VIEW_W * 0.52, 230);
    var h = Math.min(hallH * 0.42, 96);
    if (h < 42) return;
    var x = Math.round(VIEW_W / 2 - w / 2);
    var y = Math.round(top + Math.min(24, hallH * 0.10));

    // Rigging
    ctx.fillStyle = '#0d2244';
    ctx.fillRect(x + Math.round(w * 0.2), top - 6, 2, y - top + 6);
    ctx.fillRect(x + Math.round(w * 0.8), top - 6, 2, y - top + 6);

    // Case
    ctx.fillStyle = '#050f1f';
    ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    ctx.fillStyle = '#0a1830';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(x, y, w, 2);

    var midY = Math.round(y + h * 0.46);
    var big = Math.round(Math.min(h * 0.42, w * 0.16));
    ctx.textBaseline = 'middle';

    // Flags + codes
    var fw = Math.round(w * 0.13), fh = Math.round(fw * 0.68);
    drawFlag(x + 8, y + 7, fw, fh, bp1.fencer.code);
    drawFlag(x + w - 8 - fw, y + 7, fw, fh, bp2.fencer.code);
    ctx.font = 'bold ' + Math.max(6, Math.round(big * 0.34)) + 'px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'left';
    ctx.fillText(bp1.fencer.code, x + 10 + fw, y + 7 + fh / 2);
    ctx.textAlign = 'right';
    ctx.fillText(bp2.fencer.code, x + w - 10 - fw, y + 7 + fh / 2);

    // Score
    ctx.font = 'bold ' + big + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = bp1.scorePop > 0 ? '#fff' : COLOR_GOLD;
    ctx.fillText(String(bp1.touches), x + Math.round(w * 0.28), midY);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText('-', x + Math.round(w * 0.5), midY);
    ctx.fillStyle = bp2.scorePop > 0 ? '#fff' : COLOR_GOLD;
    ctx.fillText(String(bp2.touches), x + Math.round(w * 0.72), midY);

    // Clock strip
    ctx.font = 'bold ' + Math.max(6, Math.round(big * 0.30)) + 'px ' + FONT;
    ctx.fillStyle = boutSuddenDeath ? '#ff8888' : 'rgba(255,255,255,0.7)';
    ctx.fillText(boutSuddenDeath ? 'SUDDEN DEATH' : fmtClock(boutClock),
        x + w / 2, y + h - Math.max(8, h * 0.14));

    // Lamps on the case
    var lw = Math.round(w * 0.16), lh = Math.max(4, Math.round(h * 0.10));
    drawLamp(x + 6, y + h - lh - 4, lw, lh, '#ff4444', fxLightL > 0);
    drawLamp(x + w - 6 - lw, y + h - lh - 4, lw, lh, '#44ff77', fxLightR > 0);
}

// A hanging cloth banner in a nation's colours.
function drawBanner(x, y, w, h, fencer) {
    x = Math.round(x); y = Math.round(y);
    var c = (fencer && fencer.colors) || ['#0055a4', '#ffffff'];
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x + 2, y + 2, w, h);
    ctx.fillStyle = c[0];
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = c[1] || '#fff';
    ctx.fillRect(x, y + Math.round(h * 0.62), w, Math.max(2, Math.round(h * 0.12)));
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(x, y, w, 2);
    // Pole
    ctx.fillStyle = '#3a4a66';
    ctx.fillRect(x - 2, y - 2, w + 4, 2);
    if (fencer && fencer.code) {
        ctx.font = 'bold 7px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(fencer.code, x + w / 2, y + Math.round(h * 0.32));
    }
}

// The referee — stands piste-side and signals the call. Solves the priority
// readability problem far better than a label ever did.
function drawReferee(x, yFeet, s) {
    var SUIT = '#12233d', SKIN = '#e8c89e', TIE = '#c8302c';
    function r(px, py, pw, ph, c) {
        ctx.fillStyle = c;
        ctx.fillRect(Math.round(x + px * s), Math.round(yFeet + py * s),
                     Math.ceil(pw * s), Math.ceil(ph * s));
    }
    // Signal arms depend on the last call.
    var call = boutLastCall;
    var raiseL = (call === 'touch1' || call === 'double');
    var raiseR = (call === 'touch2' || call === 'double');
    var halt = (state === S_BOUT_HALT);

    r(-3, -12, 6, 5, SKIN);            // head
    r(-3, -12, 6, 2, '#2a2a2a');       // hair
    r(-4, -7, 8, 7, SUIT);             // torso
    r(-1, -7, 2, 4, TIE);
    // Arms
    if (halt && raiseL) { r(-7, -14, 2, 7, SUIT); r(-7, -16, 2, 2, SKIN); }
    else { r(-6, -7, 2, 5, SUIT); r(-6, -2, 2, 2, SKIN); }
    if (halt && raiseR) { r(5, -14, 2, 7, SUIT); r(5, -16, 2, 2, SKIN); }
    else { r(4, -7, 2, 5, SUIT); r(4, -2, 2, 2, SKIN); }
    // Legs
    r(-3, 0, 2, 5, '#1a2a44');
    r(1, 0, 2, 5, '#1a2a44');
    r(-4, 5, 4, 1, '#0d0d0d');
    r(0, 5, 4, 1, '#0d0d0d');
}

// Leaving the result screen: back to the bracket, the podium, or the title.
function advanceFromBoutResult() {
    if (boutContext === 'tournament' && tournament) {
        if (tournament.champion && tournament.champion.code === tournament.playerCode) {
            state = S_CHAMPION;
            sfxChampion();
            spawnConfetti(tournament.champion.colors);
        } else if (tournament.playerEliminated) {
            state = S_GAME_OVER;
            sfxDefeat();
        } else {
            state = S_BRACKET;
            sfxMenuConfirm();
        }
        if (musicOn) {
            currentTrack = null;
            setTrack(state === S_CHAMPION ? 'champion' : 'menu');
        }
        dirty = true;
    } else {
        exitBout();
    }
}

// Restart the same pairing without walking back through the menus.
function boutRematch() {
    sfxMenuConfirm();
    var wasTwoPlayer = twoPlayer;
    startBout(bp1.fencer, bp2.fencer, { twoPlayer: wasTwoPlayer, target: BOUT_TARGET });
}

// Small quit control, always present — ESC is desktop-only and mobile players
// were previously locked into a bout until someone reached the target.
var _boutQuitBtn = { x: 0, y: 0, w: 0, h: 0 };
function drawBoutQuit() {
    var p = isPortrait();
    var w = p ? 34 : 28, h = p ? 22 : 18;
    var x = VIEW_W - SAFE_X - w - 6;
    var y = VIEW_H - h - 4;
    ctx.globalAlpha = 0.55;
    drawPixelRoundRect(x, y, w, h, 2, COLOR_BG_DARK);
    ctx.globalAlpha = 1;
    ctx.font = 'bold ' + (p ? 8 : 7) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('QUIT', x + w / 2, y + h / 2);
    _boutQuitBtn = { x: x, y: y, w: w, h: h };
}

function drawBout() {
    var p = isPortrait();
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    var crowdTop = scoreboardH();
    // Portrait screens are very tall; a fixed-height stand left a huge empty
    // band above the piste, so the arena scales with the space available.
    var crowdH = p ? Math.round(Math.min(190, Math.max(60, VIEW_H * 0.15)))
                   : 58;
    drawCrowd(crowdTop, crowdH);

    var playTop = crowdTop + crowdH;
    var playBottom = VIEW_H - (_isTouchDevice ? 10 : 20);
    _playTop = playTop;
    // Sit the strip low in the play area so the fencers have headroom and the
    // hall fills the space above them.
    var pisteY = Math.round(playTop + (playBottom - playTop) * (p ? 0.66 : 0.84));
    _pisteYCenter = pisteY;

    drawArena(playTop, pisteY - 12);
    drawPiste(pisteY);
    // Near-side stand fills the foreground on tall screens and frames the
    // strip the way a real venue does.
    var fgTop = Math.max(pisteY + 34, VIEW_H - Math.round(VIEW_H * 0.22));
    if (VIEW_H - fgTop > 46) drawForegroundStand(fgTop);

    // Referee stands off the strip on the near side, in front of the action.
    drawReferee(VIEW_W * 0.16, pisteY + 20, p ? 2.0 : 1.9);

    var spriteSize = boutSpriteSize();

    // Draw the trailing fencer first so the attacker overlaps in front.
    var first = (effPos(bp1) < effPos(bp2)) ? bp1 : bp2;
    var second = (first === bp1) ? bp2 : bp1;
    drawFencerOnPiste(first, pisteY, spriteSize);
    drawFencerOnPiste(second, pisteY, spriteSize);

    fxDrawTrails();
    fxDrawParticles();

    drawPriorityIndicator(pisteY);
    drawPisteWarning(pisteY);
    drawScoreRibbon();
    drawBoutMessage(pisteY);
    drawBoutControlsHint(VIEW_H - 10);
    if (state !== S_BOUT_RESULT) drawBoutQuit();

    fxDrawFlash();

    if (state === S_BOUT_RESULT) drawBoutResultOverlay(p);
}

function drawBoutResultOverlay(p) {
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawConfetti();

    var playerWon = bp1.touches > bp2.touches;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold ' + (p ? 20 : 18) + 'px ' + FONT;
    ctx.fillStyle = playerWon ? COLOR_GOLD : '#ff8888';
    ctx.fillText(playerWon ? 'VICTORY' : 'DEFEAT', VIEW_W / 2, VIEW_H / 2 - 74);

    ctx.font = 'bold ' + (p ? 11 : 10) + 'px ' + FONT;
    ctx.fillStyle = '#fff';
    ctx.fillText(boutMsg, VIEW_W / 2, VIEW_H / 2 - 52);

    ctx.font = 'bold ' + (p ? 30 : 26) + 'px ' + FONT;
    ctx.fillStyle = '#fff';
    ctx.fillText(bp1.touches + ' - ' + bp2.touches, VIEW_W / 2, VIEW_H / 2 - 20);

    // A small phrase breakdown, so the result says something about how it went.
    ctx.font = (p ? 8 : 7) + 'px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(weapon().name + '  ·  ' + bp1.fencer.name.toUpperCase() +
        ' vs ' + bp2.fencer.name.toUpperCase(), VIEW_W / 2, VIEW_H / 2 + 6);

    var btnW = p ? 200 : 170;
    var btnH = p ? 42 : 32;
    var gap = 8;
    var canRematch = (boutContext !== 'tournament');
    var by = Math.round(VIEW_H / 2 + 26);
    if (canRematch) {
        drawButton(VIEW_W / 2 - btnW / 2, by, btnW, btnH, 'Rematch', boutResultFocus === 0);
        _boutRematchBtn = { x: VIEW_W / 2 - btnW / 2, y: by, w: btnW, h: btnH };
        by += btnH + gap;
    } else {
        _boutRematchBtn = { x: 0, y: 0, w: 0, h: 0 };
    }
    drawButton(VIEW_W / 2 - btnW / 2, by, btnW, btnH,
        boutContext === 'tournament' ? 'Continue' : 'Back to Title',
        canRematch ? boutResultFocus === 1 : true);
    _boutResultBtn = { x: VIEW_W / 2 - btnW / 2, y: by, w: btnW, h: btnH };
}
var _boutResultBtn = { x: 0, y: 0, w: 0, h: 0 };
var _boutRematchBtn = { x: 0, y: 0, w: 0, h: 0 };
var boutResultFocus = 0;

// ── Records screen ─────────────────────────────────────────────────────────
//
// Everything the player has done, kept across sessions. Without this nothing
// carries between sittings and there's no reason to come back.

var _statsBackBtn = { x: 0, y: 0, w: 0, h: 0 };
var _statsResetBtn = { x: 0, y: 0, w: 0, h: 0 };
var statsFocus = 0;

function enterStats() {
    sfxMenuConfirm();
    statsFocus = 0;
    state = S_STATS;
    dirty = true;
}

function pct(a, b) {
    var t = a + b;
    return t === 0 ? '—' : Math.round((a / t) * 100) + '%';
}

function drawStatsScreen() {
    var p = isPortrait();
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawBar('RECORDS', '', '');

    var s = stats || defaultStats();
    var top = BAR_H + (p ? 18 : 12);
    var colGap = 16;
    var margin = SAFE_X + (p ? 18 : 26);
    var colW = (VIEW_W - margin * 2 - colGap) / 2;
    var lh = p ? 16 : 13;
    var fs = p ? 9 : 8;

    function section(x, y, title) {
        ctx.font = 'bold ' + fs + 'px ' + FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = COLOR_GOLD;
        ctx.fillText(title, x, y);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x, y + Math.round(lh * 0.45), colW, 1);
        return y + lh;
    }
    function row(x, y, k, v) {
        ctx.font = fs + 'px ' + FONT;
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(k, x, y);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#fff';
        ctx.fillText(String(v), x + colW, y);
        return y + lh;
    }

    // ── Left column: career ──
    var lx = margin, ly = top;
    ly = section(lx, ly, 'CAREER');
    ly = row(lx, ly, 'BOUTS', s.bouts);
    ly = row(lx, ly, 'WON', s.wins);
    ly = row(lx, ly, 'LOST', s.losses);
    ly = row(lx, ly, 'WIN RATE', pct(s.wins, s.losses));
    ly = row(lx, ly, 'BEST STREAK', s.bestStreak);
    ly = row(lx, ly, 'CURRENT STREAK', s.curStreak);
    ly += 4;
    ly = section(lx, ly, 'TOUCHES');
    ly = row(lx, ly, 'SCORED', s.touchesFor);
    ly = row(lx, ly, 'CONCEDED', s.touchesAgainst);
    ly = row(lx, ly, 'DIFFERENCE',
        (s.touchesFor - s.touchesAgainst > 0 ? '+' : '') + (s.touchesFor - s.touchesAgainst));

    // ── Right column: technique + weapons ──
    var rx = margin + colW + colGap, ry = top;
    ry = section(rx, ry, 'TECHNIQUE');
    ry = row(rx, ry, 'PARRIES', s.parries);
    ry = row(rx, ry, 'RIPOSTES LANDED', s.ripostes);
    ry = row(rx, ry, 'FEINTS LANDED', s.feints);
    ry = row(rx, ry, 'DOUBLE TOUCHES', s.doubles);
    ry += 4;
    ry = section(rx, ry, 'BY WEAPON');
    for (var i = 0; i < WEAPON_ORDER.length; i++) {
        var wk = WEAPON_ORDER[i];
        var bw = (s.byWeapon && s.byWeapon[wk]) || { w: 0, l: 0 };
        ry = row(rx, ry, WEAPONS[wk].name, bw.w + 'W ' + bw.l + 'L');
    }
    ry += 4;
    ry = section(rx, ry, 'TOURNAMENTS');
    ry = row(rx, ry, 'ENTERED', s.tournaments);
    ry = row(rx, ry, 'FINALS', s.finals);
    ry = row(rx, ry, 'TITLES WON', s.titles);

    // ── Most-used country ──
    var best = null, bestN = 0;
    for (var code in s.byCountry) {
        var c = s.byCountry[code];
        var n = c.w + c.l;
        if (n > bestN) { bestN = n; best = code; }
    }
    if (best) {
        var f = fencerByCode(best);
        ctx.font = fs + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillText('MOST FENCED: ' + (f ? f.name.toUpperCase() : best) +
            '  (' + s.byCountry[best].w + 'W ' + s.byCountry[best].l + 'L)',
            VIEW_W / 2, Math.max(ly, ry) + lh);
    }

    var btnH = p ? 42 : 30;
    var btnW = p ? 150 : 120;
    var btnY = VIEW_H - btnH - (p ? 18 : 12);
    drawButton(SAFE_X + (p ? 18 : 26), btnY, btnW, btnH, 'Back', statsFocus === 0);
    _statsBackBtn = { x: SAFE_X + (p ? 18 : 26), y: btnY, w: btnW, h: btnH };
    var rX = VIEW_W - btnW - SAFE_X - (p ? 18 : 26);
    drawButton(rX, btnY, btnW, btnH, 'Reset', statsFocus === 1);
    _statsResetBtn = { x: rX, y: btnY, w: btnW, h: btnH };
}

// ── Mode entry points ──────────────────────────────────────────────────────

// Straight into a bout with the saved favourite and last weapon. The old flow
// was five taps between every 30-second bout.
function enterQuickBout() {
    ensureAudioStarted();
    sfxMenuConfirm();
    boutContext = 'practice';
    var mine = fencerByCode(loadFavorite()) || FENCERS[0];
    if (!mine) return;
    var opp = randomOpponent(mine.code);
    startBout(mine, opp, { target: 5 });
}

function enterTwoPlayer() {
    ensureAudioStarted();
    sfxMenuConfirm();
    boutContext = 'versus';
    fsHighlightCode = loadFavorite() || (FENCERS[0] && FENCERS[0].code) || '';
    fsFocusIdx = 0;
    for (var i = 0; i < FENCERS.length; i++) {
        if (FENCERS[i].code === fsHighlightCode) { fsFocusIdx = i; break; }
    }
    fs2pStage = 1;
    fs2pFirst = null;
    state = S_FENCER_SELECT;
    dirty = true;
}

function randomOpponent(excludeCode) {
    var pool = [];
    for (var i = 0; i < FENCERS.length; i++) {
        if (FENCERS[i].code !== excludeCode) pool.push(FENCERS[i]);
    }
    if (!pool.length) return FENCERS[0];
    return pool[Math.floor(Math.random() * pool.length)];
}

function cycleWeapon(dir) {
    var i = WEAPON_ORDER.indexOf(weaponKey);
    if (i < 0) i = 0;
    i = (i + (dir || 1) + WEAPON_ORDER.length) % WEAPON_ORDER.length;
    weaponKey = WEAPON_ORDER[i];
    saveWeapon();
    sfxMenuMove();
    dirty = true;
}

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
var _fsWeaponBtns = [];
var fs2pStage = 0;      // 0 = single player, 1 = P1 picking, 2 = P2 picking
var fs2pFirst = null;

function drawFencerSelect() {
    var p = isPortrait();
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    var title = (fs2pStage === 1) ? 'PLAYER 1 — PICK'
              : (fs2pStage === 2) ? 'PLAYER 2 — PICK'
              : 'PICK YOUR FENCER';
    drawBar(title, '', _diffNames[difficulty]);

    var cols = 4, rows = 4;
    var wpnRowH = p ? 30 : 24;
    var topPad = BAR_H + wpnRowH + (p ? 18 : 12);
    var bottomBtnH = p ? 44 : 30;
    var bottomPad = bottomBtnH + (p ? 56 : 44);
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
        drawFencer(cardX + cardW / 2, feetY, f, spriteSize, 'right', 'en-garde', skinFor(f));

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

    // ── Weapon selector ──
    // Sits above the grid because it changes how the whole bout plays, not
    // just who you look like.
    var wy = BAR_H + (p ? 6 : 4);
    var wBtnW = Math.min(110, Math.floor((gridW - 16) / 3));
    var wStartX = Math.round(VIEW_W / 2 - (wBtnW * 3 + 12) / 2);
    _fsWeaponBtns = [];
    for (var wi = 0; wi < WEAPON_ORDER.length; wi++) {
        var wk = WEAPON_ORDER[wi];
        var wx = wStartX + wi * (wBtnW + 6);
        var sel = (wk === weaponKey);
        drawButton(wx, wy, wBtnW, wpnRowH - 6, WEAPONS[wk].name, sel);
        _fsWeaponBtns.push({ x: wx, y: wy, w: wBtnW, h: wpnRowH - 6, key: wk });
    }

    // What the highlighted fencer and weapon actually mean.
    ctx.font = (p ? 8 : 7) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    var infoY = VIEW_H - bottomBtnH - (p ? 26 : 20);
    ctx.fillText(weapon().blurb, VIEW_W / 2, infoY - (p ? 11 : 9));
    var hf = fencerByCode(fsHighlightCode);
    if (hf) {
        ctx.fillStyle = COLOR_GOLD;
        ctx.fillText(hf.name.toUpperCase() + '  ·  ' + styleNameFor(hf) +
            '  ·  ' + hf.strength + '/5', VIEW_W / 2, infoY);
    }

    // Footer: Back + Confirm
    var btnY = VIEW_H - bottomBtnH - 8;
    var btnW = p ? 140 : 110;
    drawButton(SAFE_X + 12, btnY, btnW, bottomBtnH, 'Back', fsFocusIdx === 16);
    _fsBackBtn = { x: SAFE_X + 12, y: btnY, w: btnW, h: bottomBtnH };
    var confirmEnabled = !!fsHighlightCode;
    drawButton(VIEW_W - SAFE_X - btnW - 12, btnY, btnW, bottomBtnH,
        confirmEnabled ? 'Start' : 'Pick One', fsFocusIdx === 17 || confirmEnabled);
    _fsConfirmBtn = { x: VIEW_W - SAFE_X - btnW - 12, y: btnY, w: btnW, h: bottomBtnH };
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
    drawButton(VIEW_W / 2 - btnW / 2, btnY, btnW, bottomBtnH, label, bracketFocus === 1);
    _bracketBtn = { x: VIEW_W / 2 - btnW / 2, y: btnY, w: btnW, h: bottomBtnH };
    // Back-to-title (small, top-left)
    drawButton(SAFE_X + 8, btnY, p ? 80 : 70, bottomBtnH, 'Quit', bracketFocus === 0);
    _bracketBackBtn = { x: SAFE_X + 8, y: btnY, w: p ? 80 : 70, h: bottomBtnH };
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
    drawFencer(leftX, spriteY, playerFencer, spriteSize, 'right', 'salute', skinFor(playerFencer));
    drawFencer(rightX, spriteY, opponent, spriteSize, 'left', 'salute', skinFor(opponent));

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
    drawButton(VIEW_W / 2 - btnW / 2, btnY, btnW, btnH, 'Fence!', true);
    _matchIntroBtn = { x: VIEW_W / 2 - btnW / 2, y: btnY, w: btnW, h: btnH };
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

    // Fit the sprite to the gap between the title and the name plate so it
    // never grows up over the heading.
    var headingBottom = BAR_H + (p ? 78 : 62);
    var nameY = Math.round(VIEW_H * 0.74);
    var room = nameY - 24 - headingBottom;
    var spriteSize = Math.max(2, Math.min(p ? 6 : 5, room / (20 * 1.8)));
    var spriteY = nameY - 22;

    // Podium
    var podW = Math.round(48 * spriteSize);
    ctx.fillStyle = '#0a1c33';
    ctx.fillRect(Math.round(VIEW_W / 2 - podW / 2), spriteY, podW, 10);
    ctx.fillStyle = COLOR_GOLD;
    ctx.fillRect(Math.round(VIEW_W / 2 - podW / 2), spriteY, podW, 2);

    drawFencer(VIEW_W / 2, spriteY, champ, spriteSize, 'right', 'victory', skinFor(champ),
        { bobFrame: Math.floor(performance.now() / 300) });

    ctx.font = 'bold ' + (p ? 16 : 12) + 'px ' + FONT;
    ctx.fillStyle = '#fff';
    ctx.fillText(champ.name.toUpperCase(), VIEW_W / 2, nameY);

    // Confetti above everything except button
    drawConfetti();

    // Button
    var btnH = p ? 48 : 34;
    var btnW = p ? 240 : 180;
    var btnY = VIEW_H - btnH - (p ? 24 : 16);
    drawButton(VIEW_W / 2 - btnW / 2, btnY, btnW, btnH, 'Title', true);
    _endScreenBtn = { x: VIEW_W / 2 - btnW / 2, y: btnY, w: btnW, h: btnH };
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
}

function draw() {
    // Clear first — rounding between VIEW_H and the backing store could leave
    // an unpainted seam of black at the right/bottom edge.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLOR_BG_DARK;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(SCALE, SCALE);
    ctx.imageSmoothingEnabled = false;

    // Screen shake wraps the whole frame.
    var shake = fxShakeOffset();
    if (shake) ctx.translate(shake.x, shake.y);

    _focusedRect = null;
    if (state === S_TITLE) drawTitle();
    else if (state === S_ROSTER) drawRoster();
    else if (state === S_FENCER_SELECT) drawFencerSelect();
    else if (state === S_BRACKET) drawBracket();
    else if (state === S_MATCH_INTRO) drawMatchIntro();
    else if (state === S_CHAMPION) drawChampion();
    else if (state === S_GAME_OVER) drawGameOver();
    else if (state === S_STATS) drawStatsScreen();
    else if (state === S_BOUT_INTRO || state === S_BOUT_PLAY ||
             state === S_BOUT_HALT || state === S_BOUT_RESULT) drawBout();
    if (tutorialVisible) drawTutorial();
    if (settingsVisible) drawSettings();
    drawFocusBorder();
    ctx.restore();
}

// ── Input / navigation ──
// Browsers need a gesture before audio can start. Only do the one-time
// unlock — never re-enable sound the player has deliberately turned off.
var _audioUnlocked = false;
function ensureAudioStarted() {
    initAudio();
    if (!_audioUnlocked) {
        _audioUnlocked = true;
        if (soundOn && musicOn && !currentTrack) setTrack('menu');
    }
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
    sfxMenuConfirm();
    boutContext = 'practice';
    fs2pStage = 0;
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
    sfxMenuConfirm();

    // Two-player: the first pick belongs to P1, then P2 chooses.
    if (boutContext === 'versus') {
        if (fs2pStage === 1) {
            fs2pFirst = fencerByCode(fsHighlightCode);
            saveFavorite(fsHighlightCode);
            fs2pStage = 2;
            dirty = true;
            return;
        }
        var second = fencerByCode(fsHighlightCode);
        fs2pStage = 0;
        startBout(fs2pFirst, second, { twoPlayer: true, target: 5 });
        return;
    }

    saveFavorite(fsHighlightCode);
    if (boutContext === 'tournament') {
        tournament = newTournament(fsHighlightCode);
        if (stats) { stats.tournaments++; saveStats(); }
        saveTournament();
        state = S_BRACKET;
        dirty = true;
    } else {
        var player = fencerByCode(fsHighlightCode);
        startBout(player, randomOpponent(fsHighlightCode), { target: 5 });
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
    var playerWon;
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
    if (stats && round0IsFinal(tournament)) { stats.finals++; }
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
    // Once the player is out, run the rest of the draw to completion so the
    // Eliminated screen can actually name the champion.
    if (tournament.playerEliminated) simulateToChampion(tournament);
    if (stats && tournament.champion &&
        tournament.champion.code === tournament.playerCode) {
        stats.titles++;
        saveStats();
    }
    saveTournament();
}

function round0IsFinal(t) {
    return t.rounds[t.roundIdx] && t.rounds[t.roundIdx].length === 1;
}

// Play out every remaining round with the CPU so `champion` is never left null.
function simulateToChampion(t) {
    var guard = 0;
    while (!t.champion && guard++ < 8) {
        simulateRemainingMatches(t);
        var r = t.rounds[t.roundIdx];
        if (r.length === 1) { t.champion = r[0].winner; break; }
        buildNextRound(t);
    }
}

function exitBout() {
    sfxMenuBack();
    ai = null;
    if (musicOn) { currentTrack = null; setTrack('menu'); }
    if (boutContext === 'tournament' && tournament) {
        // Quitting a tournament bout is a forfeit. Returning to the bracket
        // with the match still unplayed made it an unlimited free retry.
        if (state === S_BOUT_INTRO || state === S_BOUT_PLAY || state === S_BOUT_HALT) {
            bp2.touches = Math.max(bp2.touches, BOUT_TARGET);
            statsRecordBout(false, bp1.touches, bp2.touches);
            finishTournamentMatch();
        }
        state = tournament.playerEliminated ? S_GAME_OVER : S_BRACKET;
    } else {
        if (state === S_BOUT_PLAY || state === S_BOUT_HALT) {
            statsRecordBout(false, bp1.touches, bp2.touches);
        }
        state = S_TITLE;
    }
    twoPlayer = false;
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
            if (pointInRect(pt, _settingsRects.sound))      { toggleSoundSetting(); return; }
            if (pointInRect(pt, _settingsRects.music))      { toggleMusicSetting(); return; }
            if (pointInRect(pt, _settingsRects.sfx))        { toggleSfxSetting(); return; }
            if (pointInRect(pt, _settingsRects.weapon))     { cycleWeapon(1); return; }
            if (pointInRect(pt, _settingsRects.difficulty)) { cycleDifficulty(); return; }
            if (pointInRect(pt, _settingsRects.tutorial))   { settingsVisible = false; openTutorial(); return; }
            if (pointInRect(pt, _settingsRects.del))        { settingsConfirmDelete = 1; sfxBlade(); dirty = true; return; }
            if (pointInRect(pt, _settingsRects.close))      { closeSettings(); return; }
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
        ensureAudioStarted();
        if (pointInRect(pt, _titleSettingsBtn)) { openSettings(); return; }
        if (pointInRect(pt, _titleStatsBtn))    { enterStats(); return; }
        if (pointInRect(pt, _titleTourneyBtn))  { enterTournament(); return; }
        if (pointInRect(pt, _titleQuickBtn))    { enterQuickBout(); return; }
        if (pointInRect(pt, _titlePracticeBtn)) { enterPracticeBout(); return; }
        if (pointInRect(pt, _title2PBtn))       { enterTwoPlayer(); return; }
        if (pointInRect(pt, _titleRosterBtn))   { enterRoster(); return; }
        return;
    }
    if (state === S_STATS) {
        if (pointInRect(pt, _statsBackBtn)) { sfxMenuBack(); state = S_TITLE; dirty = true; return; }
        if (pointInRect(pt, _statsResetBtn)) {
            stats = defaultStats(); saveStats(); sfxMenuConfirm(); dirty = true; return;
        }
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
        for (var wj = 0; wj < _fsWeaponBtns.length; wj++) {
            if (pointInRect(pt, _fsWeaponBtns[wj])) {
                weaponKey = _fsWeaponBtns[wj].key; saveWeapon();
                sfxMenuMove(); dirty = true; return;
            }
        }
        if (pointInRect(pt, _fsBackBtn)) {
            fs2pStage = 0; state = S_TITLE; sfxMenuBack(); dirty = true; return;
        }
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
        if (pointInRect(pt, _boutRematchBtn)) { boutRematch(); return; }
        if (pointInRect(pt, _boutResultBtn)) { advanceFromBoutResult(); return; }
        return;
    }
    if (state === S_CHAMPION || state === S_GAME_OVER) {
        if (pointInRect(pt, _endScreenBtn)) { endScreenContinue(); return; }
        return;
    }
    if ((state === S_BOUT_PLAY || state === S_BOUT_INTRO || state === S_BOUT_HALT) &&
        pointInRect(pt, _boutQuitBtn)) {
        exitBout();
        return;
    }
    if (state === S_BOUT_PLAY) {
        // Track each finger separately so moving and striking can overlap.
        boutTouchStart(e);
        _touchActive = true;
    }
}

// ── Bout touch gestures ────────────────────────────────────────────────────
//
// Per-finger tracking. The old single-touch model meant a second finger
// overwrote the first's start state, and lifting either one cancelled
// movement — so you could not hold a direction with one thumb and strike
// with the other, in a game entirely about closing distance and striking.
//
// One finger held anywhere = move (left half retreats, right half advances).
// A separate tap = attack. Tap twice = feint. Swipe down = block.

var _touches = {};        // identifier -> { x0, y0, t0, fired, moving }
var _lastTapT = 0;

function boutTouchId(e, changed) {
    return (changed && changed.identifier !== undefined) ? changed.identifier : 'mouse';
}

function eachChanged(e, fn) {
    if (e.changedTouches && e.changedTouches.length) {
        for (var i = 0; i < e.changedTouches.length; i++) fn(e.changedTouches[i]);
    } else {
        fn(e);
    }
}

function boutTouchStart(e) {
    eachChanged(e, function (t) {
        var pt = canvasCoords(t);
        if (pt.x < 0) return;
        _touches[boutTouchId(e, t)] = {
            x0: pt.x, y0: pt.y, t0: performance.now(), fired: false, moving: false
        };
    });
}

function boutTouchMove(e) {
    eachChanged(e, function (t) {
        var id = boutTouchId(e, t);
        var st = _touches[id];
        if (!st || st.fired) return;
        var pt = canvasCoords(t);
        if (pt.x < 0) return;
        var dx = pt.x - st.x0, dy = pt.y - st.y0;
        var ax = Math.abs(dx), ay = Math.abs(dy);
        if (Math.max(ax, ay) < TOUCH_SWIPE_DIST) return;
        if (ay > ax * 1.3) {
            // Vertical swipe: down blocks, up attacks.
            st.fired = true;
            if (dy > 0) startParry(bp1, bp2); else boutPlayerAttack();
            releaseMove(st);
        } else {
            // Horizontal drag steers this finger's movement.
            st.moving = true;
            setMove(dx > 0 ? 'advance' : 'retreat');
        }
    });
}

function boutTouchEnd(e) {
    eachChanged(e, function (t) {
        var id = boutTouchId(e, t);
        var st = _touches[id];
        if (!st) return;
        var held = performance.now() - st.t0;
        if (!st.fired && !st.moving && held < TOUCH_TAP_MS) boutPlayerAttack();
        releaseMove(st);
        delete _touches[id];
    });
    if (!anyMovingTouch()) { bp1Keys.advance = false; bp1Keys.retreat = false; }
}

function anyMovingTouch() {
    for (var k in _touches) if (_touches[k].moving) return true;
    return false;
}

function setMove(dir) {
    bp1Keys.advance = (dir === 'advance');
    bp1Keys.retreat = (dir === 'retreat');
}

function releaseMove(st) {
    if (st) st.moving = false;
    if (!anyMovingTouch()) { bp1Keys.advance = false; bp1Keys.retreat = false; }
}

// Tap attacks; a second tap inside the feint window turns it into a feint,
// which startLunge already handles when an attack is mid-extend.
function boutPlayerAttack() {
    startLunge(bp1, bp2);
    _lastTapT = performance.now();
}

// Called every frame from updateBout — promotes a long stationary touch into
// hold-to-walk once it is clearly neither a tap nor a swipe.
function updateTouchHold() {
    if (state !== S_BOUT_PLAY) return;
    var now = performance.now();
    var dir = null;
    for (var k in _touches) {
        var st = _touches[k];
        if (st.fired) continue;
        if (now - st.t0 < TOUCH_HOLD_MS) continue;
        st.moving = true;
        dir = (st.x0 < VIEW_W / 2) ? 'retreat' : 'advance';
    }
    if (dir) setMove(dir);
    else if (!anyMovingTouch()) { bp1Keys.advance = false; bp1Keys.retreat = false; }
}

function onPointerMove(e) {
    if (state !== S_BOUT_PLAY) return;
    if (e.preventDefault) e.preventDefault();
    boutTouchMove(e);
}

function onPointerUp(e) {
    if (state === S_BOUT_PLAY) boutTouchEnd(e);
    _touchActive = false;
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
                else if (settingsFocus === 2) toggleSfxSetting();
                else if (settingsFocus === 3) cycleWeapon(1);
                else if (settingsFocus === 4) cycleDifficulty();
                else if (settingsFocus === 5) { settingsVisible = false; openTutorial(); }
                else if (settingsFocus === 6) { settingsConfirmDelete = 1; settingsFocus = 1; sfxMenuBack(); dirty = true; }
                else if (settingsFocus === 7) closeSettings();
            } else {
                if (settingsFocus === 0) {
                    if (settingsConfirmDelete === 1) { settingsConfirmDelete = 2; sfxBlade(); dirty = true; }
                    else { deleteAllData(); }
                } else { settingsConfirmDelete = 0; settingsFocus = 6; sfxMenuBack(); dirty = true; }
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
            else if (titleFocus === 1) enterQuickBout();
            else if (titleFocus === 2) enterPracticeBout();
            else if (titleFocus === 3) enterTwoPlayer();
            else if (titleFocus === 4) enterRoster();
            else if (titleFocus === 5) enterStats();
            else if (titleFocus === 6) openSettings();
            return;
        }
        // Letter shortcuts
        if (e.key === 'p' || e.key === 'P') { enterQuickBout(); return; }
        if (e.key === 'r' || e.key === 'R') { enterRoster(); return; }
        if (e.key === 's' || e.key === 'S') { openSettings(); return; }
        if (e.key === 'v' || e.key === 'V') { enterTwoPlayer(); return; }
        if (e.key === 'k' || e.key === 'K') { enterStats(); return; }
        if (e.key === 'w' || e.key === 'W') { cycleWeapon(1); return; }
        return;
    }
    if (state === S_STATS) {
        if (e.key === 'Escape' || e.key === 'Backspace') { sfxMenuBack(); state = S_TITLE; dirty = true; return; }
        if (e.key === 'Tab' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault(); statsFocus = 1 - statsFocus; dirty = true; return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (statsFocus === 0) { sfxMenuBack(); state = S_TITLE; }
            else { stats = defaultStats(); saveStats(); sfxMenuConfirm(); }
            dirty = true;
            return;
        }
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
        var canRematch = (boutContext !== 'tournament');
        if (canRematch && (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
                           e.key === 'Tab')) {
            e.preventDefault();
            boutResultFocus = 1 - boutResultFocus;
            dirty = true;
            return;
        }
        if (e.key === 'r' || e.key === 'R') { if (canRematch) boutRematch(); return; }
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
            if (canRematch && boutResultFocus === 0 && e.key !== 'Escape') {
                boutRematch();
                return;
            }
            advanceFromBoutResult();
        }
        return;
    }
    if (state === S_BOUT_INTRO || state === S_BOUT_HALT) {
        if (e.key === 'Escape') { exitBout(); }
        return;
    }
    if (state === S_BOUT_PLAY) {
        if (e.key === 'Escape') { exitBout(); return; }
        var k = e.key;
        // Player 1 — arrows in single-player, WASD when sharing the keyboard.
        if (twoPlayer) {
            if (k === 'a' || k === 'A') { bp1Keys.retreat = true; e.preventDefault(); return; }
            if (k === 'd' || k === 'D') { bp1Keys.advance = true; e.preventDefault(); return; }
            if (k === 'w' || k === 'W') { startLunge(bp1, bp2); e.preventDefault(); return; }
            if (k === 's' || k === 'S') { startParry(bp1, bp2); e.preventDefault(); return; }
            // Player 2 drives the right-hand fencer with the arrow keys.
            if (k === 'ArrowLeft')  { bp2Keys.retreat = true; e.preventDefault(); return; }
            if (k === 'ArrowRight') { bp2Keys.advance = true; e.preventDefault(); return; }
            if (k === 'ArrowUp')    { startLunge(bp2, bp1); e.preventDefault(); return; }
            if (k === 'ArrowDown')  { startParry(bp2, bp1); e.preventDefault(); return; }
            return;
        }
        // bp2 advances toward bp1, so "retreat" for it is the rightward key.
        if (k === 'ArrowLeft')  { bp1Keys.retreat = true; e.preventDefault(); return; }
        if (k === 'ArrowRight') { bp1Keys.advance = true; e.preventDefault(); return; }
        if (k === 'ArrowUp' || k === ' ') { startLunge(bp1, bp2); e.preventDefault(); return; }
        if (k === 'ArrowDown') { startParry(bp1, bp2); e.preventDefault(); return; }
    }
}

function onKeyUp(e) {
    if (state !== S_BOUT_PLAY) return;
    var k = e.key;
    if (twoPlayer) {
        if (k === 'a' || k === 'A') { bp1Keys.retreat = false; return; }
        if (k === 'd' || k === 'D') { bp1Keys.advance = false; return; }
        if (k === 'ArrowLeft')  { bp2Keys.retreat = false; return; }
        if (k === 'ArrowRight') { bp2Keys.advance = false; return; }
        return;
    }
    if (k === 'ArrowLeft')  { bp1Keys.retreat = false; return; }
    if (k === 'ArrowRight') { bp1Keys.advance = false; return; }
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
    window.addEventListener('orientationchange', function() { setTimeout(resize, 120); });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('touchstart', onPointerDown, { passive: false });
    canvas.addEventListener('touchmove', onPointerMove, { passive: false });
    canvas.addEventListener('mousemove', onPointerMove);
    canvas.addEventListener('mouseup', onPointerUp);
    canvas.addEventListener('touchend', onPointerUp, { passive: false });
    canvas.addEventListener('touchcancel', onPointerUp, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // When the window loses focus, drop all held keys so the fencer doesn't drift forever
    window.addEventListener('blur', function() {
        bp1Keys.advance = bp1Keys.retreat = false;
        bp2Keys.advance = bp2Keys.retreat = false;
    });
    loadSoundSettings();
    loadDifficulty();
    loadWeapon();
    loadStats();
    loadFencersData(function() {
        state = S_TITLE;
        dirty = true;
        lastTime = performance.now();
        requestAnimationFrame(loop);
    });
}

window._fenceInit = init;

// Debug hook — exposes just enough state for automated playthrough tests.
// Guarded so it never runs for players.
if (DEBUG || (typeof window !== 'undefined' && window.location &&
              /127\.0\.0\.1|localhost/.test(window.location.hostname))) {
    window.__pfState = function () {
        return {
            state: state,
            p1: bp1 ? bp1.touches : null,
            p2: bp2 ? bp2.touches : null,
            stam1: bp1 ? Math.round(bp1.stamina) : null,
            weapon: weaponKey,
            gap: (bp1 && bp2) ? +(bp2.pos - bp1.pos).toFixed(2) : null,
            hitGap: +(BODY_R * 2 + weapon().reach + LUNGE_ADVANCE).toFixed(2),
            act1: bp1 ? bp1.act : null,
            act2: bp2 ? bp2.act : null,
            attacker: boutAttacker,
            riposte: bp1 ? bp1.riposteT > 0 : false,
            pos1: bp1 ? +bp1.pos.toFixed(2) : null,
            round: tournament ? tournament.roundIdx : null,
            eliminated: tournament ? tournament.playerEliminated : null,
            champion: tournament && tournament.champion ? tournament.champion.code : null
        };
    };
}

})();
