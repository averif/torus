import { useEffect, useRef } from 'react';
import {
  buildMesh,
  CAMERA_DISTANCE,
  createFrame,
  hitTest,
  lightAt,
  MAX_EXTENT,
  render,
  rotateModelX,
  rotateView,
  rotationX,
  type Effect,
  type Frame,
  type Mesh,
} from './torus';

const FONT_FAMILY = 'Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace';
/** Radians per second: tumble about the ring's own diameter, and turn about the screen's vertical. */
const SPEED_A = 0.75;
const SPEED_B = 0.42;
/** Starting tilt so the first frame shows the ring from slightly above. */
const START_A = -0.65;
/** Fraction of the shorter viewport side the torus may span. */
const FIT = 0.92;
/** Surface samples per character cell along each direction. */
const SAMPLES_PER_CELL = 1.8;
/** Radians of drag rotation per pixel, as a multiple of 1 / shorter viewport side. */
const DRAG_SENSITIVITY = Math.PI;
/** Seconds for a flick's spin to fade and the automatic rotation to return. */
const SETTLE_TIME = 1.2;
/** Highest spin a flick can leave behind, in radians per second. */
const MAX_FLICK = 8;
/** A release this long after the last movement counts as holding still. */
const FLICK_WINDOW_MS = 80;
/** A press that moves less than this and ends sooner than TAP_MS is a tap, not a drag. */
const TAP_SLOP_PX = 8;
const TAP_MS = 350;
/** Automatic rotation speed when the visitor prefers reduced motion. */
const REDUCED_SPEED = 0.25;

/** Void Mode phase lengths in seconds: collapse, empty screen, reconstruction. */
const COLLAPSE_S = 1.0;
const VOID_S = 0.5;
const FORM_S = 1.2;
/** Extra rotation speed at the peak of the collapse, as a multiple of normal. */
const COLLAPSE_SPIN = 5;
/** Radians the characters twist on their way into the centre. */
const SWIRL = 2.5;

type Phase = 'normal' | 'collapse' | 'void' | 'reconstruct';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Void Mode at `t` seconds after the tap: which phase it is in, how fast the
 * ring spins (multiple of normal), and the renderer effect for that moment.
 */
function voidModeAt(t: number, effect: Effect): { phase: Phase; spin: number } {
  if (t < COLLAPSE_S) {
    const p = t / COLLAPSE_S;
    effect.collapse = p;
    // The last survivors become a single bright point.
    effect.core = clamp01((p - 0.55) / 0.3);
    return { phase: 'collapse', spin: 1 + COLLAPSE_SPIN * p * p };
  }
  t -= COLLAPSE_S;
  if (t < VOID_S) {
    effect.collapse = 1;
    effect.core = 1 - clamp01(t / 0.18);
    return { phase: 'void', spin: 1 + COLLAPSE_SPIN };
  }
  t -= VOID_S;
  if (t < FORM_S) {
    const r = t / FORM_S;
    // Running the collapse backwards grows the ring out of the centre point.
    effect.collapse = 1 - r;
    effect.core = 1 - clamp01(r / 0.2);
    return { phase: 'reconstruct', spin: 1 + COLLAPSE_SPIN * (1 - r) * (1 - r) };
  }
  effect.collapse = 0;
  effect.core = 0;
  return { phase: 'normal', spin: 1 };
}

function measureChar(pre: HTMLPreElement): number {
  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(200);
  pre.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 200;
  pre.removeChild(probe);
  return width;
}

export default function AsciiTorus() {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const pre = preRef.current!;
    const decoder = new TextDecoder('ascii');
    const orientation = rotationX(START_A);
    const light = new Float32Array(3);
    const effect: Effect = { collapse: 0, swirl: SWIRL, move: true, core: 0 };
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame: Frame;
    let mesh: Mesh;
    let raf = 0;
    let last = performance.now();

    // Void Mode: time of the tap that started it, while it runs.
    let phase: Phase = 'normal';
    let voidStart = 0;

    // Drag state. Pointer deltas accumulate between frames and are applied in tick.
    let dragId: number | null = null;
    let downX = 0, downY = 0, downTime = 0;
    let lastX = 0, lastY = 0, lastMove = 0;
    let pendingX = 0, pendingY = 0;
    // Screen-space spin (rad/s) left by a flick, and how much auto rotation is active (0..1).
    let spinX = 0, spinY = 0;
    let auto = 1;

    const layout = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const fontSize = Math.max(7, Math.min(15, Math.round(Math.min(w, h) / 72)));
      const lineHeight = Math.round(fontSize * 1.1);
      pre.style.fontSize = `${fontSize}px`;
      pre.style.lineHeight = `${lineHeight}px`;
      const charW = measureChar(pre);
      const charH = lineHeight;

      const cols = Math.floor(w / charW);
      const rows = Math.floor(h / charH);
      // Scale so the nearest point under perspective still fits the viewport.
      const fitPx = (Math.min(cols * charW, rows * charH) * FIT) / 2;
      const scale = (fitPx * (CAMERA_DISTANCE - MAX_EXTENT)) / (CAMERA_DISTANCE * MAX_EXTENT);
      frame = createFrame(cols, rows, scale, charW, charH);

      const cell = Math.min(charW, charH) / SAMPLES_PER_CELL;
      const ringSteps = Math.ceil((2 * Math.PI * fitPx) / cell);
      const sectionSteps = Math.ceil((fitPx * 1.5) / cell);
      mesh = buildMesh(ringSteps, sectionSteps);
    };

    const radiansPerPixel = () => DRAG_SENSITIVITY / Math.min(window.innerWidth, window.innerHeight);

    const isOnTorus = (x: number, y: number) => {
      const rect = pre.getBoundingClientRect();
      return hitTest(frame, Math.floor((x - rect.left) / frame.charW), Math.floor((y - rect.top) / frame.charH));
    };

    const startVoidMode = (now: number) => {
      phase = 'collapse';
      voidStart = now;
      spinX = spinY = 0;
      auto = 1;
    };

    const onDown = (e: PointerEvent) => {
      // The object can't be held while it is collapsing or re-forming.
      if (dragId !== null || phase !== 'normal') return;
      dragId = e.pointerId;
      downX = lastX = e.clientX;
      downY = lastY = e.clientY;
      downTime = lastMove = e.timeStamp;
      spinX = spinY = 0;
      auto = 0;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== dragId) return;
      const k = radiansPerPixel();
      // Signs make the near surface follow the pointer.
      const ax = -(e.clientY - lastY) * k;
      const ay = -(e.clientX - lastX) * k;
      pendingX += ax;
      pendingY += ay;
      const dt = (e.timeStamp - lastMove) / 1000;
      if (dt > 0) {
        // Smoothed pointer velocity, used as the flick spin on release.
        spinX += (ax / dt - spinX) * 0.5;
        spinY += (ay / dt - spinY) * 0.5;
      }
      lastX = e.clientX;
      lastY = e.clientY;
      lastMove = e.timeStamp;
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== dragId) return;
      dragId = null;
      const tap =
        e.type === 'pointerup' &&
        e.timeStamp - downTime < TAP_MS &&
        Math.hypot(e.clientX - downX, e.clientY - downY) < TAP_SLOP_PX;
      if (tap && isOnTorus(e.clientX, e.clientY)) {
        startVoidMode(performance.now());
        return;
      }
      if (e.timeStamp - lastMove > FLICK_WINDOW_MS || motionQuery.matches) spinX = spinY = 0;
      const speed = Math.hypot(spinX, spinY);
      if (speed > MAX_FLICK) {
        spinX *= MAX_FLICK / speed;
        spinY *= MAX_FLICK / speed;
      }
    };

    const tick = (now: number) => {
      // Cap dt so returning to a background tab doesn't jump.
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const reduced = motionQuery.matches;

      let spin = 1;
      if (phase !== 'normal') {
        ({ phase, spin } = voidModeAt(Math.max(0, now - voidStart) / 1000, effect));
        if (reduced) spin = 1;
      }
      effect.move = !reduced;

      if (dragId !== null) {
        rotateView(orientation, pendingX, pendingY);
      } else {
        // Let the flick fade while the automatic rotation eases back in.
        const fade = Math.exp(-dt / (SETTLE_TIME / 3));
        spinX *= fade;
        spinY *= fade;
        auto += (1 - auto) * (1 - fade);
        const rate = auto * spin * (reduced ? REDUCED_SPEED : 1) * dt;
        rotateView(orientation, spinX * dt, spinY * dt + SPEED_B * rate);
        rotateModelX(orientation, SPEED_A * rate);
      }
      pendingX = pendingY = 0;

      lightAt(reduced ? 0 : now / 1000, light);
      pre.textContent = decoder.decode(render(mesh, frame, orientation, light, effect));
      raf = requestAnimationFrame(tick);
    };

    layout();
    raf = requestAnimationFrame(tick);
    window.addEventListener('resize', layout);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', layout);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  return (
    <pre
      ref={preRef}
      aria-hidden
      style={{ margin: 0, color: '#fff', fontFamily: FONT_FAMILY, whiteSpace: 'pre', userSelect: 'none' }}
    />
  );
}
