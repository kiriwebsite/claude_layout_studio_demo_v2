// Generates sample fixtures (no external deps) to test Layout Studio.
// Produces ./sample/{bg.png, logo.png, card.png, banner.png} and ./sample_ref.png
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function png(width, height, rgba) {
  // rgba: Buffer length width*height*4
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);

  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const body = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function solid(w, h, [r, g, b, a = 255]) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i*4]=r; buf[i*4+1]=g; buf[i*4+2]=b; buf[i*4+3]=a; }
  return buf;
}

function blit(dst, dw, src, sw, sh, ox, oy) {
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const di = ((oy + y) * dw + (ox + x)) * 4;
      const si = (y * sw + x) * 4;
      dst[di]=src[si]; dst[di+1]=src[si+1]; dst[di+2]=src[si+2]; dst[di+3]=src[si+3];
    }
  }
}

const W = 600, H = 400;
const dir = path.join(__dirname, "sample");
fs.mkdirSync(dir, { recursive: true });

// background: light gray
const bg = solid(W, H, [235, 238, 246]);
fs.writeFileSync(path.join(dir, "bg.png"), png(W, H, bg));

// assets
const logo   = solid(140, 70,  [91, 140, 255]);   // blue
const card   = solid(180, 120, [47, 184, 122]);   // green
const banner = solid(560, 60,  [224, 85, 107]);   // red

fs.writeFileSync(path.join(dir, "logo.png"),   png(140, 70,  logo));
fs.writeFileSync(path.join(dir, "card.png"),   png(180, 120, card));
fs.writeFileSync(path.join(dir, "banner.png"), png(560, 60,  banner));

// reference mock-up: bg + assets placed at the "intended" spots
const ref = Buffer.from(bg);
blit(ref, W, banner, 560, 60, 20, 16);    // banner across the top
blit(ref, W, logo,   140, 70, 20, 100);   // logo top-left
blit(ref, W, card,   180, 120, 380, 240); // card bottom-right
fs.writeFileSync(path.join(__dirname, "sample_ref.png"), png(W, H, ref));

console.log("Wrote sample/ (bg.png, logo.png, card.png, banner.png) and sample_ref.png");
