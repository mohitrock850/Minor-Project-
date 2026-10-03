'use strict';

/**
 * Draws build/icon.ico -- the application icon electron-builder puts on the
 * executable, the Start Menu shortcut, the Desktop shortcut and the installer.
 *
 * It is generated rather than checked in as a binary because a generated icon
 * can be read, reviewed and changed: the whole design is the twenty lines of
 * `paint()` below. There is no image library and no toolchain -- PNG encoding is
 * zlib (which Node has) plus a CRC, and an .ico file is a small table of PNGs.
 *
 * The design follows Section 16's "very simple, clean, minimal": a deep indigo
 * rounded square, a timetable's grid in white, and exactly one amber cell -- a
 * scheduled class. Nothing else, because at 16x16 nothing else survives.
 *
 * Run it with:  npm run icon
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling factor, for edges that are not jagged

const INDIGO = [67, 56, 202];      // #4338ca -- the background square
const INDIGO_TOP = [79, 70, 229];  // #4f46e5 -- the header band
const WHITE = [255, 255, 255];
const AMBER = [245, 158, 11];      // #f59e0b -- the one placed class

// ---------------------------------------------------------------------------
// The drawing itself. Coordinates are fractions of the canvas, so one
// description serves every size.
// ---------------------------------------------------------------------------

/** Signed-distance test for a rounded rectangle, used for every shape here. */
function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Colour of one point, in fractional coordinates (0..1 across the icon).
 * Returns null for "transparent".
 */
function paint(u, v, small) {
  if (!inRoundedRect(u, v, 0.03, 0.03, 0.97, 0.97, 0.20)) return null;

  const base = v < 0.30 ? INDIGO_TOP : INDIGO;

  // The header band's two hanging tabs -- the binding rings of a wall planner.
  if (!small) {
    const ring = (cu) => inRoundedRect(u, v, cu - 0.035, 0.10, cu + 0.035, 0.20, 0.035);
    if (ring(0.33) || ring(0.67)) return WHITE;
  }

  // The grid: 4 columns x 3 rows of cells below the header band.
  const gridTop = small ? 0.34 : 0.38;
  const gridBottom = 0.86;
  const gridLeft = 0.14;
  const gridRight = 0.86;
  const cols = small ? 3 : 4;
  const rows = 3;
  const gap = small ? 0.035 : 0.045;
  const cellW = (gridRight - gridLeft - gap * (cols - 1)) / cols;
  const cellH = (gridBottom - gridTop - gap * (rows - 1)) / rows;
  const radius = small ? 0 : cellW * 0.22;

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const left = gridLeft + c * (cellW + gap);
      const top = gridTop + r * (cellH + gap);
      if (inRoundedRect(u, v, left, top, left + cellW, top + cellH, radius)) {
        // One cell is a placed class. Row 1, column 1 (0-indexed) reads as
        // "the middle of the week" at every size.
        const accent = r === 1 && c === 1;
        return accent ? AMBER : WHITE;
      }
    }
  }

  return base;
}

/** Renders one size into a raw RGBA buffer, supersampled then averaged down. */
function render(size) {
  const small = size <= 32;
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = (x * SS + sx + 0.5) * step;
          const v = (y * SS + sy + 0.5) * step;
          const colour = paint(u, v, small);
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 255;
          }
        }
      }
      const samples = SS * SS;
      const alpha = a / samples;
      const offset = (y * size + x) * 4;
      // Straight (non-premultiplied) alpha, which is what PNG stores: divide the
      // colour sums by the number of *covered* samples, not by all of them.
      const covered = a / 255 || 1;
      rgba[offset] = Math.round(r / covered);
      rgba[offset + 1] = Math.round(g / covered);
      rgba[offset + 2] = Math.round(b / covered);
      rgba[offset + 3] = Math.round(alpha);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) in front of every scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO container: a 6-byte header, one 16-byte entry per image, then the images.
// Windows has read PNG-compressed entries since Vista, so each entry is simply
// the PNG produced above.
// ---------------------------------------------------------------------------

function toIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, i) => {
    const at = i * 16;
    directory[at] = image.size >= 256 ? 0 : image.size;     // 0 means 256
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0;                                  // palette size
    directory[at + 3] = 0;                                  // reserved
    directory.writeUInt16LE(1, at + 4);                     // colour planes
    directory.writeUInt16LE(32, at + 6);                    // bits per pixel
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

// ---------------------------------------------------------------------------

const images = SIZES.map((size) => ({ size, data: toPng(render(size), size) }));
const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, toIco(images));

const bytes = fs.statSync(out).size;
console.log(`build/icon.ico written: ${SIZES.join(', ')} px, ${(bytes / 1024).toFixed(1)} KB`);
