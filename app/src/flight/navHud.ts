import { type NavState, type V3, toBody } from '../physics/nav';
import { C, formatDistance } from '../physics/units';

/** What the altimeter needs, in units of M (and metres per M for display). */
export interface AltitudeInfo {
  r: number;
  horizon: number;
  /** Labelled landmarks on the altimeter ladder: name and radius. */
  landmarks: [string, number][];
  metresPerM: number;
}

const W = 600;
const H = 236;
const BALL_R = 92;
const BALL = { x: W / 2, y: 112 };
const LADDER = { top: 24, bottom: 196 };
/** Tape lines: scale labels face outward, the live readout faces the navball. */
const SPEED_X = 128;
const ALT_X = W - 128;

const MAX_RAPIDITY = Math.atanh(0.9999);
const ALT_MIN = 0.01;
const ALT_MAX = 3000;

/** What the caution lamps need. */
export interface Lamps {
  /** No signal from far away is reaching the ship. */
  homeLost: boolean;
  /** Tidal stretching across the hull, in g. */
  tidalG: number;
}

const MONO = "ui-monospace, 'Cascadia Mono', Consolas, 'SF Mono', monospace";

/**
 * Cockpit instruments, built as if they were real hardware:
 *  - a navball: a rigid ball on a gyro platform, showing the local sky (blue half away from
 *    the hole, brown toward it, north the spin axis, east the way it spins). While the
 *    navigation computer has a valid reference it keeps the platform aligned; when it
 *    doesn't, the ball rides on the gyroscopes alone and an OFF flag drops.
 *  - a speed tape relative to the chosen reference observer, and an altimeter computed from
 *    the navigation state, marked with the hole's landmarks;
 *  - an annunciator strip: the reference mode and caution lamps.
 */
export class NavHud {
  private ctx: CanvasRenderingContext2D;
  private ball = document.createElement('canvas');
  private ballCtx: CanvasRenderingContext2D;
  private image: ImageData;
  private scale: number;

  constructor(readonly canvas: HTMLCanvasElement) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.scale = Math.min(dpr, 1.5);
    const d = Math.round(2 * BALL_R * this.scale);
    this.ball.width = d;
    this.ball.height = d;
    this.ballCtx = this.ball.getContext('2d')!;
    this.image = this.ballCtx.createImageData(d, d);
  }

  /** `target`: direction to the target along the ship's axes (right, up, forward), if any. */
  draw(nav: NavState, alt: AltitudeInfo, target: V3 | null, lamps: Lamps) {
    const failed = !nav.valid;
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(5, 8, 14, 0.72)';
    roundRect(c, 0.5, 0.5, W - 1, H - 1, 10);
    c.fill();
    c.strokeStyle = 'rgba(120, 150, 200, 0.2)';
    c.stroke();

    this.drawBall(nav, target);
    if (failed) this.offFlag();
    this.drawSpeed(nav, failed);
    this.drawAltitude(alt);
    this.annunciators(nav, lamps);

    c.fillStyle = '#c9d4e8';
    c.font = `600 12px ${MONO}`;
    c.textAlign = 'center';
    const sign = (v: number) => (v >= 0 ? '+' : '−');
    const num = (v: number, n: number) => String(Math.abs(Math.round(v))).padStart(n, '0');
    c.fillText(
      `HDG ${num(nav.heading % 360, 3)}  PIT ${sign(nav.pitch)}${num(nav.pitch, 2)}  ROL ${sign(nav.roll)}${num(nav.roll, 3)}`,
      BALL.x,
      H - 13,
    );
  }

  /** Mode readout and caution lamps along the top edge. */
  private annunciators(nav: NavState, lamps: Lamps) {
    const mode = { static: 'REF STAT', zamo: 'REF ZAMO', river: 'REF RIVR' }[nav.requested];
    const blink = Math.floor(performance.now() / 400) % 2 === 0;
    const severe = lamps.tidalG > 100;
    const items: [string, string | null][] = [
      [mode, '#7fe0a0'],
      ['NAV', nav.valid ? null : '#ffb020'],
      ['SIG', lamps.homeLost ? '#ffb020' : null],
      ['TIDE', lamps.tidalG > 1 && !(severe && blink) ? (severe ? '#ff4a3a' : '#ffb020') : null],
    ];
    const w = [62, 38, 38, 42];
    const gap = 6;
    let x = BALL.x - (w.reduce((s, v) => s + v, 0) + gap * (w.length - 1)) / 2;
    const c = this.ctx;
    c.font = `700 10px ${MONO}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    items.forEach(([label, lit], i) => {
      roundRect(c, x, 4, w[i], 14, 3);
      c.fillStyle = lit ?? 'rgba(40, 46, 58, 0.9)';
      c.fill();
      c.strokeStyle = 'rgba(150, 165, 190, 0.35)';
      c.lineWidth = 1;
      c.stroke();
      c.fillStyle = lit ? '#14100a' : 'rgba(150, 160, 180, 0.55)';
      c.fillText(label, x + w[i] / 2, 11.5);
      x += w[i] + gap;
    });
    c.textBaseline = 'alphabetic';
  }

  // ---------------------------------------------------------------- navball

  private drawBall(nav: NavState, target: V3 | null) {
    // Each point of the ball is a direction along the ship's axes; the ball matrix turns it
    // into East–North–Up. A rotation, so the ball's grid never stretches.
    const [E, N, U] = nav.ball;
    const d = this.ball.width;
    const px = this.image.data;
    const half = d / 2;
    const deg = 180 / Math.PI;
    for (let j = 0; j < d; j++) {
      const sy = (half - j - 0.5) / half;
      for (let i = 0; i < d; i++) {
        const sx = (i + 0.5 - half) / half;
        const q = sx * sx + sy * sy;
        const o = (j * d + i) * 4;
        if (q > 1) {
          px[o + 3] = 0;
          continue;
        }
        const sz = Math.sqrt(1 - q);
        const e = sx * E[0] + sy * E[1] + sz * E[2];
        const n = sx * N[0] + sy * N[1] + sz * N[2];
        const u = sx * U[0] + sy * U[1] + sz * U[2];
        const el = Math.asin(Math.max(-1, Math.min(1, u))) * deg;
        const az = Math.atan2(e, n) * deg;
        let r: number;
        let g: number;
        let b: number;
        if (el >= 0) {
          const k = el / 90;
          r = 38 + 50 * k;
          g = 104 + 60 * k;
          b = 196 + 40 * k;
        } else {
          const k = -el / 90;
          r = 128 - 60 * k;
          g = 82 - 40 * k;
          b = 42 - 20 * k;
        }
        // Grid: elevation every 30°, azimuth every 30° (thinning toward the poles).
        const lw = 0.9 / this.scale;
        const elLine = Math.abs(((el + 15) % 30 + 30) % 30 - 15) < lw;
        const azLine = Math.abs(((az + 15) % 30 + 30) % 30 - 15) * Math.cos(el / deg) < lw && Math.abs(el) < 80;
        if (Math.abs(el) < 0.9 * lw * 1.6) {
          r = g = b = 245;
        } else if (elLine || azLine) {
          r = r * 0.55 + 110;
          g = g * 0.55 + 110;
          b = b * 0.55 + 110;
        }
        const shade = 0.5 + 0.5 * sz;
        px[o] = r * shade;
        px[o + 1] = g * shade;
        px[o + 2] = b * shade;
        px[o + 3] = 255;
      }
    }
    this.ballCtx.putImageData(this.image, 0, 0);
    const c = this.ctx;
    c.drawImage(this.ball, BALL.x - BALL_R, BALL.y - BALL_R, 2 * BALL_R, 2 * BALL_R);
    c.beginPath();
    c.arc(BALL.x, BALL.y, BALL_R, 0, 2 * Math.PI);
    c.strokeStyle = 'rgba(200, 215, 240, 0.5)';
    c.lineWidth = 1.5;
    c.stroke();

    // Compass letters on the horizon.
    c.font = `700 11px ${MONO}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const [label, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
      const w: V3 = [Math.sin((az * Math.PI) / 180), Math.cos((az * Math.PI) / 180), 0];
      const p = this.onBall(toBody(nav, w));
      if (p && p.z > 0.25) {
        c.fillStyle = 'rgba(255,255,255,0.9)';
        c.fillText(label, p.x, p.y - 8);
      }
    }

    // Markers from the navigation solution: none without one.
    if (nav.valid) {
      const at = (w: V3) => this.onBall(toBody(nav, w));
      if (nav.speed > 1e-5) {
        const v = nav.velocity.map((x) => x / nav.speed) as V3;
        this.marker(at(v), '#d8ff5a', 'prograde');
        this.marker(at(v.map((x) => -x) as V3), '#d8ff5a', 'retrograde');
        const h = Math.hypot(v[0], v[1]);
        if (h > 1e-6) {
          const n: V3 = [-v[1] / h, v[0] / h, 0];
          this.marker(at(n), '#c58cff', 'normal');
          this.marker(at(n.map((x) => -x) as V3), '#c58cff', 'antinormal');
        }
      }
      this.marker(at([0, 0, -1]), '#ff6ad5', 'hole');
      this.marker(at([0, 0, 1]), '#5ad8ff', 'radialOut');
    }
    if (target) this.marker(this.onBall(target), '#ffd75a', 'target');

    // The ship's nose, fixed at the centre.
    c.strokeStyle = '#ffb347';
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(BALL.x - 26, BALL.y);
    c.lineTo(BALL.x - 10, BALL.y);
    c.lineTo(BALL.x - 4, BALL.y + 7);
    c.lineTo(BALL.x, BALL.y);
    c.lineTo(BALL.x + 4, BALL.y + 7);
    c.lineTo(BALL.x + 10, BALL.y);
    c.lineTo(BALL.x + 26, BALL.y);
    c.stroke();
    c.textBaseline = 'alphabetic';
  }

  /** Screen position on the ball of a ship-frame direction (right, up, forward), front half only. */
  private onBall([x, y, z]: V3) {
    if (z < 0) return null;
    return { x: BALL.x + x * BALL_R, y: BALL.y - y * BALL_R, z };
  }

  private marker(
    p: { x: number; y: number } | null,
    color: string,
    kind: 'prograde' | 'retrograde' | 'hole' | 'radialOut' | 'normal' | 'antinormal' | 'target',
  ) {
    if (!p) return;
    const c = this.ctx;
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = 2;
    if (kind === 'normal' || kind === 'antinormal') {
      // A triangle (normal) or upside-down triangle (anti-normal), with a centre dot.
      const s = kind === 'normal' ? 1 : -1;
      c.beginPath();
      c.moveTo(p.x, p.y - 8 * s);
      c.lineTo(p.x + 7, p.y + 5 * s);
      c.lineTo(p.x - 7, p.y + 5 * s);
      c.closePath();
      c.stroke();
      c.beginPath();
      c.arc(p.x, p.y, 1.6, 0, 2 * Math.PI);
      c.fill();
      return;
    }
    if (kind === 'target') {
      c.beginPath();
      c.moveTo(p.x, p.y - 9);
      c.lineTo(p.x + 9, p.y);
      c.lineTo(p.x, p.y + 9);
      c.lineTo(p.x - 9, p.y);
      c.closePath();
      c.stroke();
      c.beginPath();
      c.arc(p.x, p.y, 1.6, 0, 2 * Math.PI);
      c.fill();
      return;
    }
    c.beginPath();
    c.arc(p.x, p.y, 7, 0, 2 * Math.PI);
    c.stroke();
    c.beginPath();
    if (kind === 'radialOut') {
      c.arc(p.x, p.y, 1.8, 0, 2 * Math.PI);
      c.fill();
      c.beginPath();
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        c.moveTo(p.x + 5 * dx, p.y + 5 * dy);
        c.lineTo(p.x + 9 * dx, p.y + 9 * dy);
      }
    } else if (kind === 'prograde') {
      c.arc(p.x, p.y, 1.8, 0, 2 * Math.PI);
      c.fill();
      c.beginPath();
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1]]) {
        c.moveTo(p.x + 7 * dx, p.y + 7 * dy);
        c.lineTo(p.x + 12 * dx, p.y + 12 * dy);
      }
    } else if (kind === 'retrograde') {
      c.moveTo(p.x - 5, p.y - 5);
      c.lineTo(p.x + 5, p.y + 5);
      c.moveTo(p.x + 5, p.y - 5);
      c.lineTo(p.x - 5, p.y + 5);
    } else {
      c.arc(p.x, p.y, 3, 0, 2 * Math.PI);
      c.fill();
      c.font = '700 9px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('HOLE', p.x, p.y + 17);
    }
    c.stroke();
  }

  // ---------------------------------------------------------------- tapes

  private ladder(x: number, title: string) {
    const c = this.ctx;
    c.strokeStyle = 'rgba(160, 180, 215, 0.45)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x, LADDER.top);
    c.lineTo(x, LADDER.bottom);
    c.stroke();
    c.fillStyle = '#8494b0';
    c.font = '600 10px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(title, x, LADDER.bottom + 16);
  }

  /**
   * Scale marks on the outer side of a tape. Labels that would collide are nudged apart
   * (with a short leader line back to their true position).
   */
  private ticks(x: number, side: 1 | -1, marks: { y: number; label: string; color: string }[]) {
    const c = this.ctx;
    const sorted = [...marks].sort((a, b) => a.y - b.y);
    const placed: number[] = [];
    for (const m of sorted) placed.push(Math.max(m.y, (placed.at(-1) ?? -Infinity) + 11));
    // If pushed off the bottom, shift the whole stack back up.
    const over = (placed.at(-1) ?? 0) - (LADDER.bottom + 4);
    if (over > 0) for (let i = 0; i < placed.length; i++) placed[i] -= over;
    for (let i = placed.length - 2; i >= 0; i--) placed[i] = Math.min(placed[i], placed[i + 1] - 11);
    c.font = '9px system-ui, sans-serif';
    c.textAlign = side > 0 ? 'left' : 'right';
    c.textBaseline = 'middle';
    sorted.forEach((m, i) => {
      c.strokeStyle = m.color;
      c.fillStyle = m.color;
      c.beginPath();
      c.moveTo(x, m.y);
      c.lineTo(x + 6 * side, m.y);
      c.lineTo(x + 10 * side, placed[i]);
      c.stroke();
      c.fillText(m.label, x + 13 * side, placed[i]);
    });
    c.textBaseline = 'alphabetic';
  }

  /** The live readout: an arrow touching the tape from the navball side, with the value. */
  private pointer(x: number, y: number, toward: 1 | -1, text: string, sub: string) {
    const c = this.ctx;
    const ty = Math.min(Math.max(y, LADDER.top + 6), LADDER.bottom - 14);
    c.fillStyle = '#ffb347';
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + 9 * toward, y - 6);
    c.lineTo(x + 9 * toward, y + 6);
    c.closePath();
    c.fill();
    c.font = `700 13px ${MONO}`;
    c.textAlign = toward > 0 ? 'left' : 'right';
    c.textBaseline = 'middle';
    c.fillText(text, x + 13 * toward, ty);
    c.fillStyle = '#9fb0cc';
    c.font = `10px ${MONO}`;
    c.fillText(sub, x + 13 * toward, ty + 14);
    c.textBaseline = 'alphabetic';
  }

  /** A striped warning flag across the ball, like the OFF flag on a real attitude indicator. */
  private offFlag() {
    const c = this.ctx;
    const w = 66;
    const h = 24;
    const x = BALL.x - w / 2;
    const y = BALL.y - BALL_R * 0.55;
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.fillStyle = '#e8681c';
    c.fillRect(x, y, w, h);
    c.strokeStyle = '#1a1206';
    c.lineWidth = 6;
    for (let k = -h; k < w + h; k += 14) {
      c.beginPath();
      c.moveTo(x + k, y + h);
      c.lineTo(x + k + h, y);
      c.stroke();
    }
    c.restore();
    c.fillStyle = '#fff3e6';
    c.font = '800 15px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.strokeStyle = '#1a1206';
    c.lineWidth = 3;
    c.strokeText('OFF', BALL.x, y + h / 2 + 1);
    c.fillText('OFF', BALL.x, y + h / 2 + 1);
    c.textBaseline = 'alphabetic';
  }

  /** Speed against the reference observer, on a rapidity scale so 0.9, 0.99, 0.999 c all fit. */
  private drawSpeed(nav: NavState, failed = false) {
    const x = SPEED_X;
    this.ladder(x, 'SPEED');
    const yOf = (v: number) => LADDER.bottom - (Math.atanh(Math.min(v, 0.99999)) / MAX_RAPIDITY) * (LADDER.bottom - LADDER.top);
    const dim = 'rgba(200, 212, 235, 0.7)';
    this.ticks(
      x,
      -1,
      [0, 0.5, 0.9, 0.99, 0.999].map((v) => ({ y: yOf(v), label: v === 0 ? '0' : `${v}c`, color: dim })),
    );
    // No valid reference: the tape has nothing to measure against.
    if (failed) {
      const blink = Math.floor(performance.now() / 500) % 2 === 0;
      this.pointer(x + 2, LADDER.top, 1, blink ? '-.---c' : '', 'NO REF');
      return;
    }
    const y = Math.max(LADDER.top, yOf(nav.speed));
    const kms = (nav.speed * C) / 1000;
    const vertical = nav.velocity[2];
    const arrow = Math.abs(vertical) < 1e-9 ? '' : vertical > 0 ? '▲ ' : '▼ ';
    this.pointer(x + 2, y, 1, fmtSpeed(nav.speed), `${kms < 1e5 ? kms.toFixed(kms < 10 ? 2 : 0) : kms.toExponential(2)} km/s`);
    const c = this.ctx;
    c.fillStyle = '#9fb0cc';
    c.font = '10px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(`vertical ${arrow}${fmtSpeed(Math.abs(vertical))}`, x, LADDER.bottom + 28);
  }

  /** Height above the horizon on a log scale, marked with the hole's landmarks. */
  private drawAltitude(alt: AltitudeInfo) {
    const x = ALT_X;
    this.ladder(x, 'ALTITUDE');
    const span = Math.log10(ALT_MAX / ALT_MIN);
    const yOf = (h: number) => LADDER.bottom - (Math.log10(Math.max(h, ALT_MIN) / ALT_MIN) / span) * (LADDER.bottom - LADDER.top);
    const dim = 'rgba(200, 212, 235, 0.6)';
    const marks = [1, 10, 100, 1000].map((h) => ({ y: yOf(h), label: `${h}M`, color: dim }));
    for (const [name, r] of alt.landmarks) {
      const h = r - alt.horizon;
      if (h > ALT_MIN && h < ALT_MAX) marks.push({ y: yOf(h), label: name, color: '#7fd0ff' });
    }
    marks.push({ y: LADDER.bottom, label: 'horizon', color: '#ff7a7a' });
    this.ticks(x, 1, marks);
    const h = alt.r - alt.horizon;
    const y = Math.min(LADDER.bottom, Math.max(LADDER.top, yOf(h)));
    // Computed from the navigation state, so it doesn't stop at the horizon: it just goes
    // negative and pegs the tape.
    const m = Math.abs(h);
    const minus = h < 0 ? '−' : '';
    this.pointer(x - 2, y, -1, `${minus}${m < 10 ? m.toFixed(2) : m.toFixed(0)} M`, `${minus}${formatDistance(m * alt.metresPerM)}`);
  }
}

function fmtSpeed(v: number) {
  if (v < 1e-4) return `${(v * 1e6).toFixed(0)}µc`;
  if (v < 0.01) return `${(v * 1000).toFixed(2)}mc`;
  if (v < 0.99) return `${v.toFixed(3)}c`;
  return `${v.toFixed(5)}c`;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
