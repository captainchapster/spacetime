/**
 * The transmission from home: a video feed shown the way it would actually arrive.
 *
 * Home broadcasts continuously from far away. Its signal reaches the ship shifted in
 * frequency by g (received / emitted), and by the same token its frames arrive g times as
 * fast as the ship's own clock ticks: g = dt_home / dτ. So the feed's position, in home
 * seconds, advances by g × (the ship's proper time) every frame. Hovering low, home's signal
 * is blueshifted and the feed races; falling in, it is redshifted and slows; if no signal
 * reaches the ship, there is static. (Light delay from home is a constant offset and is left
 * out: the feed starts when the journey does.)
 *
 * The built-in feed is a mission-control channel: home's clock, a live waveform, and short
 * messages sent at fixed moments of home's time. Or the player can load a video of their own
 * (it never leaves their computer); its sound is pitch-shifted by the same factor.
 */

/** Messages from home, by home seconds since departure. */
const MESSAGES: [number, string][] = [
  [0, 'Channel open. We can hear you.'],
  [45, 'Everyone is here in the control room.'],
  [600, 'Ten minutes. Your signal is strong.'],
  [3600, "An hour since you left. The coffee's gone cold."],
  [6 * 3600, "Night shift's taken over. We're still watching."],
  [86400, 'A whole day here. The kids drew your ship.'],
  [7 * 86400, "A week. We're keeping your chair."],
  [30 * 86400, "A month. It's raining. It's always raining."],
  [365.25 * 86400, "A year. We're all a little older."],
  [10 * 365.25 * 86400, "Ten years. Some of us aren't here any more. We still listen."],
  [50 * 365.25 * 86400, 'Fifty years. They teach your flight in schools now.'],
];

/** Browsers play video from 1/16 to 16 times normal speed; outside that, frames are scrubbed. */
const MIN_RATE = 1 / 16;
const MAX_RATE = 16;

export interface FeedInput {
  /** The ship's proper time that passed this frame, in seconds. */
  dTauSeconds: number;
  /** Real seconds this frame took (to turn the feed's advance into a playback rate). */
  dtReal: number;
  /** Home's signal: received / emitted frequency, or null if none reaches the ship. */
  g: number | null;
  /** The journey is over. */
  ended: boolean;
}

export class Transmission {
  readonly panel = document.createElement('div');
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private status = document.createElement('div');
  private video: HTMLVideoElement | null = null;
  private videoUrl: string | null = null;
  /** Home seconds of the feed received so far. */
  private feedTime = 0;
  /** Home's date and time when the journey began. */
  private departed = new Date();
  volume = 0.8;

  constructor() {
    this.panel.id = 'feed';
    this.panel.className = 'panel';
    this.canvas.width = 384;
    this.canvas.height = 216;
    this.ctx = this.canvas.getContext('2d')!;
    this.status.className = 'status';
    const screen = document.createElement('div');
    screen.className = 'screen';
    screen.append(this.canvas);
    this.panel.append(screen, this.status);
    document.body.appendChild(this.panel);
  }

  get visible() {
    return this.panel.classList.contains('show');
  }

  setVisible(on: boolean) {
    this.panel.classList.toggle('show', on);
    if (!on) this.video?.pause();
  }

  /** A new journey: the transmission starts again. */
  restart() {
    this.feedTime = 0;
    this.departed = new Date();
    if (this.video) this.video.currentTime = 0;
  }

  /** Play a video of the player's own through the feed (or null for the built-in channel). */
  loadVideo(file: File | null) {
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.video?.pause();
    this.video = null;
    this.videoUrl = null;
    if (!file) return;
    const v = document.createElement('video');
    this.videoUrl = URL.createObjectURL(file);
    v.src = this.videoUrl;
    v.loop = true;
    v.playsInline = true;
    // Let the pitch follow the playback rate: the sound is shifted by g as well.
    v.preservesPitch = false;
    this.video = v;
    this.restart();
  }

  update({ dTauSeconds, dtReal, g, ended }: FeedInput) {
    if (!this.visible) return;
    const lost = g === null || ended;
    const advance = lost ? 0 : g * dTauSeconds;
    this.feedTime += advance;
    // How fast the feed is playing in real time, and against the ship's own clock.
    const rate = dtReal > 0 ? advance / dtReal : 0;
    if (this.video) this.playVideo(rate, lost);
    else this.drawChannel(lost);
    if (lost) this.drawStatic();
    this.drawOverlay(rate, g, lost);
  }

  // ---------------------------------------------------------------- the player's video

  private playVideo(rate: number, lost: boolean) {
    const v = this.video!;
    const c = this.ctx;
    const { width: W, height: H } = this.canvas;
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
    const playable = !lost && rate >= MIN_RATE && rate <= MAX_RATE;
    if (duration === null) {
      // Length unknown (some recordings don't say): play at the right rate, unsynced.
      if (playable) {
        v.playbackRate = rate;
        v.muted = false;
        v.volume = this.volume;
        if (v.paused) void v.play().catch(() => {});
      } else if (!v.paused) v.pause();
    } else {
      const want = this.feedTime % duration;
      if (playable) {
        // Within what a browser can play: real playback, sound and all, kept in step.
        v.playbackRate = rate;
        v.muted = false;
        v.volume = this.volume;
        if (v.paused) void v.play().catch(() => {});
        if (Math.abs(v.currentTime - want) > 0.35 && Math.abs(v.currentTime - want) < duration - 0.35) v.currentTime = want;
      } else {
        // Too fast or too slow to play (or no signal): show the right frame, silently.
        if (!v.paused) v.pause();
        v.muted = true;
        if (Math.abs(v.currentTime - want) > 0.04) v.currentTime = want;
      }
    }
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    if (v.readyState >= 2) {
      const s = Math.min(W / v.videoWidth, H / v.videoHeight);
      const w = v.videoWidth * s;
      const h = v.videoHeight * s;
      c.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
    }
  }

  // ---------------------------------------------------------------- the built-in channel

  private drawChannel(lost: boolean) {
    const c = this.ctx;
    const { width: W, height: H } = this.canvas;
    const t = this.feedTime;
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b1626');
    bg.addColorStop(1, '#050a12');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    // Home's clock: the date and time at home, as received.
    const now = new Date(this.departed.getTime() + t * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    c.fillStyle = '#e8f0ff';
    c.font = "700 30px ui-monospace, Consolas, monospace";
    c.textAlign = 'center';
    c.fillText(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, W / 2, 86);
    c.font = "13px ui-monospace, Consolas, monospace";
    c.fillStyle = '#9fb3d4';
    c.fillText(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} · home`, W / 2, 106);
    c.fillText(`T+ ${formatElapsed(t)}`, W / 2, 124);

    // A live waveform, its phase set by home's clock.
    if (!lost) {
      c.strokeStyle = 'rgba(120, 220, 170, 0.8)';
      c.lineWidth = 1.5;
      c.beginPath();
      for (let x = 0; x <= W; x += 3) {
        const u = x / W;
        const y = 158 + 10 * Math.sin(2 * Math.PI * (1.1 * t + 3 * u)) * Math.sin(Math.PI * u) + 4 * Math.sin(2 * Math.PI * (2.7 * t + 9 * u));
        if (x === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.stroke();
    }

    // The latest message, typed out as it arrives (in home time).
    let k = 0;
    while (k + 1 < MESSAGES.length && MESSAGES[k + 1][0] <= t) k++;
    const [sent, text] = MESSAGES[k];
    const shown = text.slice(0, Math.floor((t - sent) * 25));
    c.fillStyle = '#ffe2b0';
    c.font = "italic 14px Georgia, 'Times New Roman', serif";
    c.fillText(shown, W / 2, 196);
  }

  private drawStatic() {
    const c = this.ctx;
    const { width: W, height: H } = this.canvas;
    const img = c.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = Math.random() * 90;
      d[i] = d[i] * 0.25 + n;
      d[i + 1] = d[i + 1] * 0.25 + n;
      d[i + 2] = d[i + 2] * 0.25 + n;
    }
    c.putImageData(img, 0, 0);
  }

  private drawOverlay(rate: number, g: number | null, lost: boolean) {
    const c = this.ctx;
    const { width: W } = this.canvas;
    // A dark strip, so the labels read over any picture.
    c.fillStyle = 'rgba(0, 0, 0, 0.55)';
    c.fillRect(0, 0, W, 26);
    c.textAlign = 'left';
    c.font = "700 11px ui-monospace, Consolas, monospace";
    c.fillStyle = lost ? '#ff8a5a' : '#ff5a5a';
    c.fillText(lost ? '■ NO SIGNAL' : '● HOME · LIVE', 10, 18);
    c.textAlign = 'right';
    c.fillStyle = '#c9d4e8';
    if (!lost && g !== null) c.fillText(`×${fmt(g)} vs your clock`, W - 10, 18);
    // Under the panel: the plain-language reading.
    this.status.textContent = lost
      ? "No signal from home reaches you here."
      : `Playing at ×${fmt(rate)} real time${this.video && (rate < MIN_RATE || rate > MAX_RATE) ? ' (too fast or slow to play: showing frames, muted)' : ''}`;
  }
}

function fmt(v: number) {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(v >= 1 ? 2 : 3);
}

function formatElapsed(s: number) {
  const day = 86400;
  const year = 365.25 * day;
  if (s >= year) return `${(s / year).toFixed(2)} years`;
  if (s >= day) return `${(s / day).toFixed(1)} days`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
