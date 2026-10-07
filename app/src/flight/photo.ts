import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import GUI from 'lil-gui';
import type { FrameParams, Renderer } from './renderer';
import { tip } from './tooltip';

type Grade = NonNullable<FrameParams['grade']>;
type Quality = 'draft' | 'high' | 'ultra';

/** Frame shapes: width / height (0: the screen's own). */
const ASPECTS: Record<string, number> = {
  Screen: 0,
  '16:9 widescreen': 16 / 9,
  '1.85:1 flat': 1.85,
  '2.39:1 anamorphic': 2.39,
  '2.76:1 ultra wide': 2.76,
  '3:2 film': 3 / 2,
  '1:1 square': 1,
  '4:5 portrait': 4 / 5,
  '9:16 vertical': 9 / 16,
};

/** Still size: pixels along the long edge. */
const SIZES: Record<string, number> = { 'HD (1920)': 1920, '4K (3840)': 3840, '8K (7680)': 7680 };

/** Colour looks (artistic). Tint is a white balance applied before tone mapping. */
const LOOKS: Record<string, Grade> = {
  Natural: { contrast: 1, saturation: 1, tint: [1, 1, 1] },
  'Warm film': { contrast: 1.06, saturation: 0.92, tint: [1.08, 1, 0.86] },
  Cool: { contrast: 1.04, saturation: 0.95, tint: [0.9, 0.98, 1.1] },
  Punchy: { contrast: 1.22, saturation: 1.15, tint: [1, 1, 1] },
  Faded: { contrast: 0.84, saturation: 0.78, tint: [1.02, 1, 0.97] },
  Mono: { contrast: 1.12, saturation: 0, tint: [1, 1, 1] },
};

/** Most pixels we'll ray-trace for one still (supersampling switches off beyond this). */
const MAX_PIXELS = 36e6;
/** A letterboxed picture sits in a 16:9 frame, like a film on a TV. */
const LETTERBOX_FRAME = 16 / 9;

/** The camera settings photo mode shares with the rest of the game. */
export interface PhotoSettings {
  fov: number;
  exposureEV: number;
  autoExposure: boolean;
  bloom: number;
  vignette: number;
  grain: number;
  paused: boolean;
  cinematic: boolean;
  logWarp: number;
}

export interface PhotoHost {
  renderer: Renderer;
  canvas: HTMLCanvasElement;
  settings: PhotoSettings;
  mainGui: GUI;
  /** Frame parameters at the given ray quality (default: top). */
  frameParams(quality?: Quality): FrameParams;
  /** Advance the simulation by this many seconds of real time, at the current time warp. */
  simulate(dtReal: number): void;
  /** Time-warp choices (label → log₁₀ of the rate). */
  warps: Record<string, number>;
  /** Called when entering or leaving, so the rest of the page can update. */
  changed(): void;
  setCinematic(on: boolean): void;
}

/** Where things go: the whole frame, and the picture inside it (smaller when letterboxed). */
interface Layout {
  /** Frame aspect (width / height) and picture aspect. */
  frame: number;
  picture: number;
}

/**
 * Photo mode: time stops, the instruments go, and a guide shows exactly what will be
 * captured. Stills are ray-traced again at the chosen size (optionally supersampled) at top
 * quality, developed with the same exposure, bloom and grade as the preview, and downloaded
 * as PNGs. Clips run time forward frame by frame, each frame traced offline, so the
 * animation is smooth however slow the tracing, and are saved as looping GIFs.
 */
export class PhotoMode {
  active = false;
  /** True while a photo is being developed: the main loop must leave the canvas alone. */
  busy = false;
  readonly opts = {
    aspect: 0,
    letterbox: false,
    size: 3840,
    supersample: true,
    roll: 0,
    look: 'Natural',
    thirds: true,
  };
  readonly clip = {
    seconds: 3,
    fps: 15,
    width: 640,
    quality: 'high' as Quality,
    /** Camera pan, degrees per second (a slow turn about the camera's up axis). */
    pan: 0,
  };
  /** Camera pan angle during a clip, radians. */
  private panAngle = 0;
  private gui: GUI;
  private guide = document.createElement('div');
  private picture = document.createElement('div');
  private status = document.createElement('div');
  private saved: { paused: boolean; cinematic: boolean } | null = null;

  constructor(private host: PhotoHost) {
    const s = host.settings;
    const gui = new GUI({ title: 'Photo mode', width: 300 });
    gui.domElement.classList.add('photo-gui');
    const relayout = () => this.layout();

    const fFrame = gui.addFolder('Frame');
    tip(fFrame.add(this.opts, 'aspect', ASPECTS).name('Shape').onChange(relayout), 'Shape of the picture. The guide shows exactly what will be captured.');
    tip(
      fFrame
        .add(this.opts, 'letterbox')
        .name('Cinematic letterbox')
        .onChange((on: boolean) => {
          // A letterbox needs a picture wider than its 16:9 frame: default to anamorphic.
          if (on && !(this.opts.aspect > LETTERBOX_FRAME)) this.opts.aspect = 2.39;
          this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
          relayout();
        }),
      'Black bands above and below a widescreen picture, in a 16:9 frame, like a film. Pick the picture shape above (2.39:1 is the classic widescreen).',
    );
    tip(fFrame.add(this.opts, 'thirds').name('Thirds grid').onChange(relayout), 'Show rule-of-thirds lines in the guide (never in the photo).');

    const fCam = gui.addFolder('Camera');
    tip(fCam.add(s, 'fov', 10, 120, 1).name('Field of view'), 'Zoom: the vertical field of view of the screen, in degrees.');
    tip(fCam.add(this.opts, 'roll', -45, 45, 0.5).name('Camera roll'), 'Tilt the camera for a Dutch angle. Only the camera turns, not the ship.');
    tip(fCam.add(s, 'autoExposure').name('Auto exposure'), 'Let the camera set the brightness, or set it yourself below. Clips hold the exposure fixed.');
    tip(fCam.add(s, 'exposureEV', -6, 6, 0.1).name('Exposure'), 'Brightness adjustment in photographic stops (EV).');
    tip(fCam.add(s, 'bloom', 0, 1, 0.01).name('Bloom'), 'Glow around bright light (a camera-lens effect).');
    tip(fCam.add(this.opts, 'look', Object.keys(LOOKS)).name('Look'), 'Artistic colour grade. Natural shows the physically computed colours.');
    tip(fCam.add(s, 'vignette', 0, 1, 0.01).name('Vignette'), 'Artistic: darken the corners, like a lens.');
    tip(fCam.add(s, 'grain', 0, 1, 0.01).name('Film grain'), 'Artistic: photographic grain.');

    const fStill = gui.addFolder('Still');
    tip(fStill.add(this.opts, 'size', SIZES).name('Size'), 'Pixels along the long edge of the photo. 8K takes a while.');
    tip(
      fStill.add(this.opts, 'supersample').name('Supersample 2×'),
      'Trace four rays per pixel and average them: smoother stars and disk edges, four times the work.',
    );
    tip(fStill.add({ capture: () => void this.capture() }, 'capture').name('📷  Capture still (Space)'), 'Develop the photo and download it as a PNG.');

    const fClip = gui.addFolder('Clip (GIF)').close();
    tip(fClip.add(this.clip, 'seconds', 1, 8, 0.5).name('Length (s)'), 'How long the clip plays for.');
    tip(fClip.add(this.clip, 'fps', [10, 12, 15, 20, 25]).name('Frames / s'), 'Smoother clips take longer to render and make bigger files.');
    tip(fClip.add(this.clip, 'width', [320, 480, 640, 800, 960]).name('Width (px)'), 'GIFs get large quickly: 640 is a good size to share.');
    tip(
      fClip.add(s, 'logWarp', host.warps).name('Time warp'),
      'How fast time runs during the clip. Everything moves: the disk turns, you fall, beacons drift.',
    );
    tip(fClip.add(this.clip, 'pan', -20, 20, 0.5).name('Camera pan (°/s)'), 'Turn the camera slowly while recording. Only the camera turns, not the ship.');
    tip(fClip.add(this.clip, 'quality', ['draft', 'high', 'ultra']).name('Ray quality'), 'Higher is more accurate near the hole but slower to record.');
    tip(
      fClip.add({ record: () => void this.record() }, 'record').name('🎞  Record clip (G)'),
      'Run time forward and save a looping GIF. Time keeps the progress: you come back where the clip ended.',
    );

    tip(gui.add({ exit: () => this.toggle(false) }, 'exit').name('Leave photo mode (K / Esc)'), 'Back to flying. Time starts again where it stopped.');
    gui.hide();
    this.gui = gui;

    this.guide.id = 'photo-guide';
    this.picture.className = 'picture';
    this.guide.append(this.picture);
    this.status.id = 'photo-status';
    document.body.append(this.guide, this.status);
    window.addEventListener('resize', relayout);
  }

  /** The colour grade: the chosen look in photo mode (so the preview matches), else none. */
  grade(): Grade {
    return (this.active && LOOKS[this.opts.look]) || LOOKS.Natural;
  }

  /** Camera roll and pan (radians), while in photo mode. */
  roll() {
    return this.active ? (this.opts.roll * Math.PI) / 180 : 0;
  }
  pan() {
    return this.active ? this.panAngle : 0;
  }

  toggle(on = !this.active) {
    if (on === this.active || this.busy) return;
    const s = this.host.settings;
    this.active = on;
    document.body.classList.toggle('photo', on);
    if (on) {
      this.saved = { paused: s.paused, cinematic: s.cinematic };
      if (s.cinematic) this.host.setCinematic(false);
      s.paused = true;
      this.host.mainGui.hide();
      this.gui.show();
      this.layout();
    } else {
      this.gui.hide();
      this.host.mainGui.show();
      if (this.saved) {
        s.paused = this.saved.paused;
        if (this.saved.cinematic) this.host.setCinematic(true);
      }
      this.saved = null;
    }
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.host.changed();
  }

  private shapes(): Layout {
    const screen = this.host.canvas.clientWidth / this.host.canvas.clientHeight;
    const picture = this.opts.aspect || screen;
    if (this.opts.letterbox && picture > LETTERBOX_FRAME) return { frame: LETTERBOX_FRAME, picture };
    return { frame: picture, picture };
  }

  /** The guide on screen (CSS pixels): the frame, and the picture's height inside it. */
  private onScreen() {
    const W = this.host.canvas.clientWidth;
    const H = this.host.canvas.clientHeight;
    const { frame, picture } = this.shapes();
    const [w, h] = frame > W / H ? [W, W / frame] : [H * frame, H];
    return { x: (W - w) / 2, y: (H - h) / 2, w, h, pictureH: w / picture, H };
  }

  private layout() {
    const g = this.onScreen();
    Object.assign(this.guide.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
    this.guide.classList.toggle('letterboxed', g.pictureH < g.h - 0.5);
    this.picture.style.top = `${(g.h - g.pictureH) / 2}px`;
    this.picture.style.height = `${g.pictureH}px`;
    this.picture.classList.toggle('thirds', this.opts.thirds);
  }

  /**
   * Trace the framed view into a w × h image (frame size), with black bands if letterboxed.
   * `ss`: supersampling factor.
   */
  private async develop(params: FrameParams, w: number, h: number, ss: number, progress?: (p: number) => void) {
    const { renderer, canvas } = this.host;
    const { picture } = this.shapes();
    const g = this.onScreen();
    const ph = Math.min(h, Math.round(w / picture));
    // Same view as the guide: the field of view spans the picture's height, not the screen's.
    params.fovY = 2 * Math.atan(Math.tan(params.fovY / 2) * (g.pictureH / g.H));
    // Grain averages away when four pixels become one: compensate.
    params.grain = (params.grain ?? 0) * ss;
    await renderer.renderPhoto(params, w * ss, ph * ss, progress);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const c = out.getContext('2d', { willReadFrequently: true })!;
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(canvas, 0, 0, w * ss, ph * ss, 0, Math.round((h - ph) / 2), w, ph);
    return out;
  }

  /** Frame size in pixels for a long edge (or width) of `size`, within what the GPU can do. */
  private pixels(size: number, byWidth = false) {
    const { frame } = this.shapes();
    let w = byWidth || frame >= 1 ? size : Math.round(size * frame);
    let h = Math.round(w / frame);
    const [maxW, maxH] = this.host.renderer.maxPhotoSize();
    const fit = Math.min(1, maxW / w, maxH / h);
    w = Math.floor(w * fit);
    h = Math.floor(h * fit);
    return { w, h, maxW, maxH };
  }

  private async run(job: () => Promise<string>) {
    if (!this.active || this.busy) return;
    this.busy = true;
    this.status.classList.add('show');
    try {
      this.status.textContent = await job();
      this.guide.classList.remove('flash');
      void this.guide.offsetWidth; // restart the animation
      this.guide.classList.add('flash');
    } catch (err) {
      this.status.textContent = `Couldn't develop it: ${(err as Error).message}`;
    } finally {
      this.busy = false;
      this.panAngle = 0;
      this.host.renderer.resize();
      setTimeout(() => this.status.classList.remove('show'), 2500);
    }
  }

  /** Render the framed view at full size and download it as a PNG. */
  capture() {
    return this.run(async () => {
      const { w, h, maxW, maxH } = this.pixels(this.opts.size);
      const ss = this.opts.supersample && 4 * w * h <= MAX_PIXELS && 2 * w <= maxW && 2 * h <= maxH ? 2 : 1;
      const show = (p: number) =>
        (this.status.textContent = `Developing ${w}×${h}${ss > 1 ? ' (supersampled)' : ''}… ${Math.round(p * 100)}%`);
      show(0);
      await pause(30); // let the status paint
      const out = await this.develop(this.host.frameParams(), w, h, ss, show);
      const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
      if (blob) download(blob, `black-hole-${stamp()}-${w}x${h}.png`);
      return `Saved ${w}×${h}`;
    });
  }

  /** Run time forward, tracing each frame, and download the result as a looping GIF. */
  record() {
    return this.run(async () => {
      const { seconds, fps, quality, pan } = this.clip;
      const n = Math.max(2, Math.round(seconds * fps));
      const { w, h } = this.pixels(this.clip.width, true);
      const frames: Uint8ClampedArray[] = [];
      for (let i = 0; i < n; i++) {
        this.status.textContent = `Recording ${w}×${h}: frame ${i + 1} of ${n}`;
        await pause(0);
        if (i > 0) this.host.simulate(1 / fps);
        this.panAngle = ((pan * Math.PI) / 180) * (i / fps);
        const out = await this.develop(this.host.frameParams(quality), w, h, 1);
        frames.push(out.getContext('2d')!.getImageData(0, 0, w, h).data);
      }
      this.status.textContent = `Encoding ${n} frames…`;
      await pause(30);
      const blob = encodeGif(frames, w, h, 1000 / fps);
      download(blob, `black-hole-${stamp()}-${w}x${h}.gif`);
      return `Saved a ${seconds} s clip (${(blob.size / 1e6).toFixed(1)} MB)`;
    });
  }
}

/**
 * Encode frames as a looping GIF. One palette for the whole clip (sampled from several
 * frames) so colours don't flicker, and an ordered dither, which hides the banding a
 * 256-colour palette gives the disk's smooth glow without shimmering from frame to frame.
 */
function encodeGif(frames: Uint8ClampedArray[], w: number, h: number, delayMs: number): Blob {
  const picks = [0, Math.floor(frames.length / 3), Math.floor((2 * frames.length) / 3), frames.length - 1];
  const step = 4 * Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  const sample: number[] = [];
  for (const k of picks) for (let o = 0; o < frames[k].length; o += step) sample.push(frames[k][o], frames[k][o + 1], frames[k][o + 2], 255);
  const palette = quantize(new Uint8Array(sample), 256);
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const gif = GIFEncoder();
  const buf = new Uint8ClampedArray(w * h * 4);
  for (const f of frames) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const d = (bayer[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 10;
        buf[o] = f[o] + d;
        buf[o + 1] = f[o + 1] + d;
        buf[o + 2] = f[o + 2] + d;
        buf[o + 3] = 255;
      }
    }
    gif.writeFrame(applyPalette(buf, palette), w, h, { palette, delay: delayMs, repeat: 0 });
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

function pause(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
