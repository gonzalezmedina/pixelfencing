#!/usr/bin/env node
//
// generate-icons.js — produces apple-touch-icon.png (1200x1200) and
// favicon.png (32x32) by rendering the same en-garde fencer sprite that
// the title screen uses, on a blue background.
//
// Pure Node, no dependencies — uses zlib for PNG IDAT compression and a
// minimal CRC32 + chunk encoder.
//
// Run: node scripts/generate-icons.js
//
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Minimal PNG encoder ──
const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type RGBA
    ihdr[10] = 0;  // compression: deflate
    ihdr[11] = 0;  // filter: adaptive
    ihdr[12] = 0;  // interlace: none
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter byte: None
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── Palette (matches game.js) ──
function rgb(s) {
    s = s.replace('#', '');
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
const C = {
    BG:         rgb('#1e4e8e'), // COLOR_BG (cobalt)
    BG_DARK:    rgb('#0e2a4a'), // for icon border
    GOLD:       rgb('#FFD700'),
    WHITE:      rgb('#fafafa'),
    WHITE_SH:   rgb('#d8d8de'),
    MASK:       rgb('#3a3a3a'),
    MESH:       rgb('#7a7a7a'),
    GLOVE:      rgb('#1a1a1a'),
    SHOE:       rgb('#1a1a1a'),
    SHOE_SOLE:  rgb('#0a0a0a'),
    BLADE:      rgb('#dddddd'),
    BLADE_DARK: rgb('#888888'),
    // Italy lamé colors (default title fencer)
    PRIMARY:    rgb('#008c45'),
    SECONDARY:  rgb('#cd212a'),
    SKIN:       rgb('#f5d0b0'),
};

// ── Sprite definition (en-garde pose, ported from drawFencer in game.js) ──
const sprite = [];
function r(x, y, w, h, c) { sprite.push({ x, y, w, h, c }); }
function buildSprite() {
    // Mask
    r(7, 2, 4, 4, C.MASK);
    r(6, 3, 1, 2, C.MASK);
    r(11, 3, 1, 2, C.MASK);
    r(8, 3, 1, 1, C.MESH);
    r(10, 3, 1, 1, C.MESH);
    r(9, 4, 1, 1, C.MESH);
    // Bib
    r(7, 6, 4, 1, C.WHITE);
    // Jacket torso
    r(6, 7, 6, 4, C.WHITE);
    r(6, 11, 6, 1, C.WHITE_SH);
    // Lamé (Italy green) + collar accents (red)
    r(7, 7, 4, 3, C.PRIMARY);
    r(6, 7, 1, 1, C.SECONDARY);
    r(11, 7, 1, 1, C.SECONDARY);
    // Weapon arm forward
    r(11, 8, 1, 2, C.WHITE);
    r(12, 8, 2, 1, C.SKIN);
    r(14, 8, 1, 1, C.GLOVE);
    r(15, 8, 1, 1, C.GOLD);
    // Long blade — extended for icon clarity
    r(16, 8, 8, 1, C.BLADE);
    r(24, 8, 1, 1, C.BLADE_DARK);
    // Back arm raised
    r(5, 6, 1, 1, C.WHITE);
    r(4, 5, 1, 1, C.WHITE);
    r(3, 4, 1, 1, C.WHITE);
    r(3, 3, 1, 1, C.WHITE);
    r(3, 2, 1, 1, C.SKIN);
    r(4, 2, 1, 1, C.SKIN);
    // Breeches
    r(5, 11, 7, 1, C.WHITE);
    r(10, 12, 2, 1, C.WHITE);
    r(11, 13, 2, 1, C.WHITE);
    r(4, 12, 2, 1, C.WHITE);
    r(3, 13, 2, 1, C.WHITE);
    // Socks
    r(11, 14, 2, 2, C.WHITE);
    r(3, 14, 2, 2, C.WHITE);
    // Shoes
    r(11, 16, 4, 1, C.SHOE);
    r(11, 17, 4, 1, C.SHOE_SOLE);
    r(1, 16, 4, 1, C.SHOE);
    r(1, 17, 4, 1, C.SHOE_SOLE);
}
buildSprite();

// Sprite logical bounds (for centering)
const SPRITE_X_MIN = 1, SPRITE_X_MAX = 24; // 24 = blade tip
const SPRITE_Y_MIN = 2, SPRITE_Y_MAX = 17;
const SPRITE_W = SPRITE_X_MAX - SPRITE_X_MIN + 1; // 24
const SPRITE_H = SPRITE_Y_MAX - SPRITE_Y_MIN + 1; // 16

// ── Renderer ──
function renderIcon(width, height, opts) {
    opts = opts || {};
    const fillRatio = opts.fillRatio || 0.78;
    const buf = Buffer.alloc(width * height * 4);
    // Background — solid blue unless `transparent` is set
    if (!opts.transparent) {
        for (let i = 0; i < width * height; i++) {
            buf[i * 4]     = C.BG[0];
            buf[i * 4 + 1] = C.BG[1];
            buf[i * 4 + 2] = C.BG[2];
            buf[i * 4 + 3] = 255;
        }
    }
    // (otherwise the buffer stays all-zero which is fully transparent)
    // Sprite scale: largest integer that keeps sprite within fillRatio of icon
    let scale = Math.max(1, Math.floor(Math.min(
        width  * fillRatio / SPRITE_W,
        height * fillRatio / SPRITE_H
    )));
    if (opts.forceScale) scale = opts.forceScale;
    const renderedW = SPRITE_W * scale;
    const renderedH = SPRITE_H * scale;
    const ox = Math.floor((width  - renderedW) / 2);
    const oy = Math.floor((height - renderedH) / 2);
    // Draw sprite ops
    for (const op of sprite) {
        for (let dy = 0; dy < op.h; dy++) {
            for (let dx = 0; dx < op.w; dx++) {
                const sx = op.x + dx;
                const sy = op.y + dy;
                const px0 = ox + (sx - SPRITE_X_MIN) * scale;
                const py0 = oy + (sy - SPRITE_Y_MIN) * scale;
                for (let py = 0; py < scale; py++) {
                    for (let px = 0; px < scale; px++) {
                        const x = px0 + px, y = py0 + py;
                        if (x < 0 || y < 0 || x >= width || y >= height) continue;
                        const idx = (y * width + x) * 4;
                        buf[idx]     = op.c[0];
                        buf[idx + 1] = op.c[1];
                        buf[idx + 2] = op.c[2];
                        buf[idx + 3] = 255;
                    }
                }
            }
        }
    }
    return { rgba: buf, scale };
}

// ── Generate ──
const outDir = path.resolve(__dirname, '..', 'assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// 1200×1200 apple-touch-icon (also used as PWA maskable)
{
    const W = 1200, H = 1200;
    const { rgba, scale } = renderIcon(W, H, { fillRatio: 0.78 });
    const png = encodePNG(W, H, rgba);
    const out = path.join(outDir, 'apple-touch-icon.png');
    fs.writeFileSync(out, png);
    console.log(`apple-touch-icon.png  ${W}×${H}  scale ${scale}x  ${png.length} bytes`);
}

// Favicon — sized to the sprite's exact bounding box (no padding) on a
// transparent background, so it sits cleanly on any browser chrome.
{
    const W = SPRITE_W, H = SPRITE_H; // 24 × 16
    const { rgba, scale } = renderIcon(W, H, { forceScale: 1, transparent: true });
    const png = encodePNG(W, H, rgba);
    const out = path.join(outDir, 'favicon.png');
    fs.writeFileSync(out, png);
    console.log(`favicon.png           ${W}×${H}  scale ${scale}x  ${png.length} bytes  (transparent, tight bounds)`);
}
