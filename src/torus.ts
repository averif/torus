// ASCII torus renderer: a solid of revolution with a superellipse
// cross-section. Exponent 2 with equal half-sizes gives a round donut.

/** Distance from the ring's axis to the centre of the cross-section. */
const RING_RADIUS = 1;
/** Half-width of the cross-section along the radius. */
const HALF_WIDTH = 0.4;
/** Half-height of the cross-section along the ring's axis. */
const HALF_HEIGHT = 0.4;
/** Superellipse exponent: 2 = ellipse, larger = boxier. */
const EXPONENT = 2;
/** Furthest any surface point gets from the origin (used to fit the screen). */
export const MAX_EXTENT = (() => {
  let max = 0;
  for (let i = 0; i < 360; i++) {
    const t = (i / 360) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    const u = HALF_WIDTH * Math.sign(c) * Math.abs(c) ** (2 / EXPONENT);
    const v = HALF_HEIGHT * Math.sign(s) * Math.abs(s) ** (2 / EXPONENT);
    max = Math.max(max, Math.hypot(RING_RADIUS + u, v));
  }
  return max;
})();
/** Camera distance from the origin, in model units. */
export const CAMERA_DISTANCE = 7;

const RAMP = '.,-~:;=!*#$@';
const RAMP_CODES = Uint8Array.from(RAMP, (c) => c.charCodeAt(0));
const SPACE = 32;
const NEWLINE = 10;

/** Unlit faces: just enough to keep the silhouette readable. */
const AMBIENT = 0.06;
const DIFFUSE = 0.8;
const SPECULAR = 0.65;
const SHININESS = 28;

/**
 * Direction towards the light at time `t` (seconds), in view space.
 * It drifts slowly around the upper left in front of the viewer (camera
 * looks down +z), so highlights wander over the surface on their own.
 */
export function lightAt(t: number, out: Float32Array = new Float32Array(3)): Float32Array {
  const x = -0.35 + 0.45 * Math.sin(t * 0.23);
  const y = 0.8 + 0.25 * Math.sin(t * 0.31 + 1.3);
  const z = -1;
  const len = Math.hypot(x, y, z);
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  return out;
}

export interface Mesh {
  count: number;
  /** Interleaved x, y, z, nx, ny, nz per point. */
  data: Float32Array;
  /** Two stable pseudo-random values in [0, 1) per point, used to stagger effects. */
  seeds: Float32Array;
}

/** Per-frame transition applied on top of the normal view (see `render`). */
export interface Effect {
  /** 0 = intact torus, 1 = every point absorbed into the centre. */
  collapse: number;
  /** Radians the points twist about the view axis on their way to the centre. */
  swirl: number;
  /** False keeps points in place so they only dissolve (reduced motion). */
  move: boolean;
  /** Brightness 0..1 of a single glyph at the centre; 0 draws nothing. */
  core: number;
}

export const NO_EFFECT: Effect = { collapse: 0, swirl: 0, move: true, core: 0 };
/** How far apart in time points start their own collapse, relative to the whole. */
const STAGGER = 0.6;
const SWIRL_STEPS = 256;
const swirlCos = new Float32Array(SWIRL_STEPS + 1);
const swirlSin = new Float32Array(SWIRL_STEPS + 1);

function hash(n: number): number {
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
}

/** Cross-section outline sampled at even arc-length spacing, with normals. */
function crossSection(steps: number): Float32Array {
  const fine = steps * 16;
  const e = 2 / EXPONENT;
  const pts: number[] = [];
  for (let i = 0; i <= fine; i++) {
    const t = (i / fine) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    pts.push(HALF_WIDTH * Math.sign(c) * Math.abs(c) ** e, HALF_HEIGHT * Math.sign(s) * Math.abs(s) ** e);
  }
  const cumulative = new Float64Array(fine + 1);
  for (let i = 1; i <= fine; i++) {
    cumulative[i] = cumulative[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  }

  // Resample evenly, then take the superellipse gradient as the normal.
  const out = new Float32Array(steps * 4);
  const total = cumulative[fine];
  let j = 0;
  for (let k = 0; k < steps; k++) {
    const target = (k / steps) * total;
    while (cumulative[j + 1] < target) j++;
    const f = (target - cumulative[j]) / (cumulative[j + 1] - cumulative[j] || 1);
    const u = pts[2 * j] + (pts[2 * j + 2] - pts[2 * j]) * f;
    const v = pts[2 * j + 1] + (pts[2 * j + 3] - pts[2 * j + 1]) * f;
    const gu = Math.sign(u) * Math.abs(u / HALF_WIDTH) ** (EXPONENT - 1) / HALF_WIDTH;
    const gv = Math.sign(v) * Math.abs(v / HALF_HEIGHT) ** (EXPONENT - 1) / HALF_HEIGHT;
    const len = Math.hypot(gu, gv) || 1;
    out.set([u, v, gu / len, gv / len], k * 4);
  }
  return out;
}

/** Builds the surface point cloud. The ring's symmetry axis is y. */
export function buildMesh(ringSteps: number, sectionSteps: number): Mesh {
  const section = crossSection(sectionSteps);
  const count = ringSteps * sectionSteps;
  const data = new Float32Array(count * 6);
  let o = 0;
  for (let i = 0; i < ringSteps; i++) {
    const phi = (i / ringSteps) * Math.PI * 2;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    for (let k = 0; k < sectionSteps; k++) {
      const u = section[k * 4], v = section[k * 4 + 1];
      const nu = section[k * 4 + 2], nv = section[k * 4 + 3];
      const r = RING_RADIUS + u;
      data[o++] = r * cp;
      data[o++] = v;
      data[o++] = r * sp;
      data[o++] = nu * cp;
      data[o++] = nv;
      data[o++] = nu * sp;
    }
  }
  const seeds = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    seeds[2 * i] = hash(i * 12.9898 + 1.7);
    seeds[2 * i + 1] = hash(i * 78.233 + 4.1);
  }
  return { count, data, seeds };
}

export interface Frame {
  cols: number;
  rows: number;
  /** Pixels per model unit at the origin's depth, before perspective. */
  scale: number;
  charW: number;
  charH: number;
  zbuf: Float32Array;
  /** Index of the nearest point in each cell, or -1. */
  winner: Int32Array;
  /** rows * (cols + 1) ASCII bytes, newline-terminated rows. */
  out: Uint8Array;
}

export function createFrame(cols: number, rows: number, scale: number, charW: number, charH: number): Frame {
  return {
    cols, rows, scale, charW, charH,
    zbuf: new Float32Array(cols * rows),
    winner: new Int32Array(cols * rows),
    out: new Uint8Array(rows * (cols + 1)),
  };
}

/** Row-major 3x3 rotation matrix, model space to view space. */
export type Orientation = Float64Array;

export function rotationX(t: number): Orientation {
  const c = Math.cos(t), s = Math.sin(t);
  return Float64Array.of(1, 0, 0, 0, c, -s, 0, s, c);
}

/**
 * Applies view-space rotations (about the screen's x axis, then its y axis)
 * on top of `m` in place, so turns always follow the screen, not the model.
 */
export function rotateView(m: Orientation, ax: number, ay: number): void {
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
  for (let j = 0; j < 3; j++) {
    const r0 = m[j], r1 = m[3 + j], r2 = m[6 + j];
    const y1 = r1 * cx - r2 * sx;
    const z1 = r1 * sx + r2 * cx;
    m[j] = r0 * cy + z1 * sy;
    m[3 + j] = y1;
    m[6 + j] = z1 * cy - r0 * sy;
  }
  orthonormalise(m);
}

/** Spins the model about its own x axis (an in-plane diameter) in place. */
export function rotateModelX(m: Orientation, t: number): void {
  const c = Math.cos(t), s = Math.sin(t);
  for (let i = 0; i < 9; i += 3) {
    const a = m[i + 1], b = m[i + 2];
    m[i + 1] = a * c + b * s;
    m[i + 2] = b * c - a * s;
  }
  orthonormalise(m);
}

/** Removes accumulated rounding error so the ring never skews over time. */
function orthonormalise(m: Orientation): void {
  let l = Math.hypot(m[0], m[1], m[2]);
  m[0] /= l; m[1] /= l; m[2] /= l;
  const d = m[0] * m[3] + m[1] * m[4] + m[2] * m[5];
  m[3] -= d * m[0]; m[4] -= d * m[1]; m[5] -= d * m[2];
  l = Math.hypot(m[3], m[4], m[5]);
  m[3] /= l; m[4] /= l; m[5] /= l;
  m[6] = m[1] * m[5] - m[2] * m[4];
  m[7] = m[2] * m[3] - m[0] * m[5];
  m[8] = m[0] * m[4] - m[1] * m[3];
}

/** Output of `displace`: x, y, z and brightness factor. */
const moved = new Float64Array(4);

/**
 * Applies the collapse to one view-space point, writing the result to `moved`.
 * Returns false when the point is hidden: dropped for sparsity, already
 * absorbed into the centre, or not yet re-formed.
 */
function displace(
  seeds: Float32Array, i: number, x: number, y: number, z: number,
  collapse: number, keep: number, move: boolean,
): boolean {
  moved[0] = x; moved[1] = y; moved[2] = z; moved[3] = 1;
  if (seeds[2 * i + 1] > keep) return false;
  // Each point runs its own staggered 0..1 progress.
  const local = collapse * (1 + STAGGER) - seeds[2 * i] * STAGGER;
  if (local >= 1) return false;
  if (local <= 0) return true;
  moved[3] = 1 - local;
  if (move) {
    const f = local * local;
    const shrink = 1 - f;
    const k = (f * SWIRL_STEPS) | 0;
    const c = swirlCos[k], s = swirlSin[k];
    moved[0] = (x * c - y * s) * shrink;
    moved[1] = (x * s + y * c) * shrink;
    moved[2] = z * shrink;
  }
  return true;
}

/** True if any surface was drawn within `radius` cells of (col, row) last frame. */
export function hitTest(frame: Frame, col: number, row: number, radius = 1): boolean {
  for (let r = row - radius; r <= row + radius; r++) {
    for (let c = col - radius; c <= col + radius; c++) {
      if (r >= 0 && r < frame.rows && c >= 0 && c < frame.cols && frame.winner[r * frame.cols + c] >= 0) return true;
    }
  }
  return false;
}

/**
 * Orients the mesh by `m`, applies `effect`, projects and z-buffers, then
 * shades only the nearest point per cell with Blinn-Phong lighting.
 */
export function render(
  mesh: Mesh,
  frame: Frame,
  m: Orientation,
  light: Float32Array,
  effect: Effect = NO_EFFECT,
): Uint8Array {
  const { cols, rows, scale, charW, charH, zbuf, winner, out } = frame;
  const { data, seeds, count } = mesh;
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
  const lx = light[0], ly = light[1], lz = light[2];
  const halfCols = cols / 2, halfRows = rows / 2;
  const kx = (scale / charW) * CAMERA_DISTANCE, ky = (scale / charH) * CAMERA_DISTANCE;
  const rampMax = RAMP_CODES.length - 1;
  const { collapse, swirl, move } = effect;
  const active = collapse > 0;
  // Fewer characters survive as the collapse deepens.
  const keep = 1 - collapse * 0.6;

  zbuf.fill(0);
  winner.fill(-1);
  out.fill(SPACE);

  // Swirl angles are looked up rather than computed per point.
  if (active && move) {
    for (let k = 0; k <= SWIRL_STEPS; k++) {
      const a = (swirl * k) / SWIRL_STEPS;
      swirlCos[k] = Math.cos(a);
      swirlSin[k] = Math.sin(a);
    }
  }

  for (let i = 0, o = 0; i < count; i++, o += 6) {
    const x = data[o], y = data[o + 1], z = data[o + 2];
    let vx = m0 * x + m1 * y + m2 * z;
    let vy = m3 * x + m4 * y + m5 * z;
    let vz = m6 * x + m7 * y + m8 * z;
    if (active) {
      if (!displace(seeds, i, vx, vy, vz, collapse, keep, move)) continue;
      vx = moved[0]; vy = moved[1]; vz = moved[2];
    }
    const ooz = 1 / (vz + CAMERA_DISTANCE);
    const col = (halfCols + kx * vx * ooz) | 0;
    const row = (halfRows - ky * vy * ooz) | 0;
    if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
    const idx = row * cols + col;
    if (ooz <= zbuf[idx]) continue;
    zbuf[idx] = ooz;
    winner[idx] = i;
  }

  for (let idx = 0; idx < winner.length; idx++) {
    const i = winner[idx];
    if (i < 0) continue;
    const o = i * 6;
    const x = data[o], y = data[o + 1], z = data[o + 2];
    let px = m0 * x + m1 * y + m2 * z;
    let py = m3 * x + m4 * y + m5 * z;
    let pz = m6 * x + m7 * y + m8 * z;
    let fade = 1;
    if (active) {
      displace(seeds, i, px, py, pz, collapse, keep, move);
      px = moved[0]; py = moved[1]; pz = moved[2]; fade = moved[3];
    }
    const nx = data[o + 3], ny = data[o + 4], nz = data[o + 5];
    const wx = m0 * nx + m1 * ny + m2 * nz;
    const wy = m3 * nx + m4 * ny + m5 * nz;
    const wz = m6 * nx + m7 * ny + m8 * nz;

    // Direction to the eye differs per point, so even flat faces get a moving highlight.
    const ez = -(pz + CAMERA_DISTANCE);
    const eLen = Math.hypot(px, py, ez);
    let hx = lx - px / eLen, hy = ly - py / eLen, hz = lz + ez / eLen;
    const hLen = Math.hypot(hx, hy, hz);
    hx /= hLen; hy /= hLen; hz /= hLen;

    const diffuse = wx * lx + wy * ly + wz * lz;
    const nh = wx * hx + wy * hy + wz * hz;
    let lum = AMBIENT;
    if (diffuse > 0) lum += DIFFUSE * diffuse + (nh > 0 ? SPECULAR * nh ** SHININESS : 0);
    lum *= fade;

    // Unlit faces keep the dimmest glyph so the silhouette stays readable.
    const level = Math.min(rampMax, (lum * (rampMax + 1)) | 0);
    out[((idx / cols) | 0) * (cols + 1) + (idx % cols)] = RAMP_CODES[level];
  }

  if (effect.core > 0) {
    const level = Math.min(rampMax, (effect.core * (rampMax + 1)) | 0);
    out[(halfRows | 0) * (cols + 1) + (halfCols | 0)] = RAMP_CODES[level];
  }

  for (let r = 0; r < rows; r++) out[r * (cols + 1) + cols] = NEWLINE;
  return out;
}
