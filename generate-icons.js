// Genera icon-192.png e icon-512.png con Node.js puro (sin dependencias)
const zlib = require("zlib");
const fs   = require("fs");

// ── CRC32 ────────────────────────────────────────────────────────────────────
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const l = Buffer.allocUnsafe(4); l.writeUInt32BE(data.length);
  const c = Buffer.allocUnsafe(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([l, t, data, c]);
}

// ── Canvas simple ─────────────────────────────────────────────────────────────
function makeCanvas(size) {
  const px = new Uint8Array(size * size * 4); // RGBA

  function set(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    // Alpha compositing sobre fondo existente
    const sa = a / 255, da = px[i+3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    px[i]   = (r * sa + px[i]   * da * (1-sa)) / oa;
    px[i+1] = (g * sa + px[i+1] * da * (1-sa)) / oa;
    px[i+2] = (b * sa + px[i+2] * da * (1-sa)) / oa;
    px[i+3] = oa * 255;
  }

  function fillRect(x1, y1, w, h, r, g, b, a = 255) {
    for (let y = y1; y < y1+h; y++)
      for (let x = x1; x < x1+w; x++) set(x, y, r, g, b, a);
  }

  // Círculo relleno (con antialiasing simple)
  function fillCircle(cx, cy, radius, r, g, b, a = 255) {
    const r2 = (cx, cy, x, y) => Math.sqrt((x-cx)**2 + (y-cy)**2);
    for (let y = Math.floor(cy-radius)-1; y <= Math.ceil(cy+radius)+1; y++) {
      for (let x = Math.floor(cx-radius)-1; x <= Math.ceil(cx+radius)+1; x++) {
        const d = r2(cx, cy, x+0.5, y+0.5);
        if (d < radius - 0.5) set(x, y, r, g, b, a);
        else if (d < radius + 0.5) {
          const alpha = Math.round((radius + 0.5 - d) * a);
          set(x, y, r, g, b, alpha);
        }
      }
    }
  }

  // Rectángulo con esquinas redondeadas
  function fillRoundRect(x, y, w, h, rad, r, g, b, a = 255) {
    fillRect(x+rad, y,     w-rad*2, h,       r, g, b, a);
    fillRect(x,     y+rad, w,       h-rad*2, r, g, b, a);
    fillCircle(x+rad,   y+rad,   rad, r, g, b, a);
    fillCircle(x+w-rad, y+rad,   rad, r, g, b, a);
    fillCircle(x+rad,   y+h-rad, rad, r, g, b, a);
    fillCircle(x+w-rad, y+h-rad, rad, r, g, b, a);
  }

  // Línea gruesa
  function line(x0, y0, x1, y1, thickness, r, g, b, a = 255) {
    const dx = x1-x0, dy = y1-y0, len = Math.sqrt(dx*dx+dy*dy);
    const steps = Math.ceil(len * 2);
    for (let i = 0; i <= steps; i++) {
      const t = i/steps;
      const px_ = x0+dx*t, py_ = y0+dy*t;
      fillCircle(px_, py_, thickness/2, r, g, b, a);
    }
  }

  // Arco (curva bezier cuadrática) para la sonrisa
  function arc(x0, y0, cx, cy, x1, y1, thickness, r, g, b, a = 255) {
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const t = i/steps;
      const qx = (1-t)*(1-t)*x0 + 2*(1-t)*t*cx + t*t*x1;
      const qy = (1-t)*(1-t)*y0 + 2*(1-t)*t*cy + t*t*y1;
      fillCircle(qx, qy, thickness/2, r, g, b, a);
    }
  }

  function toPNG() {
    const sig = Buffer.from([137,80,78,71,13,10,26,10]);
    const ihdr = Buffer.allocUnsafe(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;

    const raw = Buffer.allocUnsafe(size * (1 + size*4));
    let pos = 0;
    for (let y = 0; y < size; y++) {
      raw[pos++] = 0;
      for (let x = 0; x < size; x++) {
        const i = (y*size+x)*4;
        raw[pos++]=px[i]; raw[pos++]=px[i+1]; raw[pos++]=px[i+2]; raw[pos++]=px[i+3];
      }
    }

    return Buffer.concat([
      sig,
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0))
    ]);
  }

  return { set, fillRect, fillCircle, fillRoundRect, line, arc, toPNG };
}

// ── Dibujo del ícono ──────────────────────────────────────────────────────────
function drawIcon(size) {
  const c = makeCanvas(size);
  const s = size;
  const sc = v => Math.round(v * s / 512); // escalar desde diseño 512px

  // Fondo transparente → ya está (todo en 0)

  // Fondo azul con esquinas redondeadas
  c.fillRoundRect(0, 0, s, s, sc(80), 37, 99, 235);

  // ── Sobre (envelope) ─────────────────────────────────────────────
  const ex = sc(88),  ey = sc(160);
  const ew = sc(336), eh = sc(240);
  const er = sc(18);

  // Cuerpo del sobre — blanco
  c.fillRoundRect(ex, ey, ew, eh, er, 255, 255, 255);

  // Flap del sobre (triángulo en la parte de abajo del sobre)
  // Dibujamos un triángulo con la punta hacia abajo
  const midX = ex + ew/2;
  const flapY = ey + eh - sc(10);
  for (let row = 0; row < sc(130); row++) {
    const halfW = (row / sc(130)) * (ew/2 - er);
    const y = ey + row;
    const x0 = Math.round(midX - halfW);
    const x1 = Math.round(midX + halfW);
    for (let x = x0; x <= x1; x++) {
      c.set(x, y, 219, 234, 254); // azul muy claro para el flap
    }
  }

  // Línea diagonal izquierda del flap (borde)
  c.line(ex+er, ey+sc(2), midX, ey+sc(118), sc(3), 147, 197, 253);
  // Línea diagonal derecha del flap
  c.line(ex+ew-er, ey+sc(2), midX, ey+sc(118), sc(3), 147, 197, 253);

  // ── Carita feliz ─────────────────────────────────────────────────
  const faceX = s/2;
  const faceY = ey + eh*0.62;

  // Ojo izquierdo
  c.fillCircle(faceX - sc(52), faceY - sc(22), sc(18), 37, 99, 235);
  // Ojo derecho
  c.fillCircle(faceX + sc(52), faceY - sc(22), sc(18), 37, 99, 235);

  // Sonrisa (arco cuadrático)
  c.arc(
    faceX - sc(62), faceY + sc(8),   // punto inicio
    faceX,          faceY + sc(54),  // punto control
    faceX + sc(62), faceY + sc(8),   // punto fin
    sc(10), 37, 99, 235
  );

  return c.toPNG();
}

// ── Generar archivos ──────────────────────────────────────────────────────────
console.log("Generando íconos...");
fs.writeFileSync("icon-512.png", drawIcon(512));
console.log("✅ icon-512.png");
fs.writeFileSync("icon-192.png", drawIcon(192));
console.log("✅ icon-192.png");
// Apple touch icon (180x180)
fs.writeFileSync("apple-touch-icon.png", drawIcon(180));
console.log("✅ apple-touch-icon.png");
console.log("Listo.");
