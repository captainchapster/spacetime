import { innerPhotonOrbit } from '../physics/kerrRays';
import { DATA_W, INDEX_W, LIST_W, type RealSkyData, STAR_MARGIN } from './realSky';
import { BLUR_FS, COMPOSITE_FS, DOWNSAMPLE_FS, FULLSCREEN_VS, RAYTRACE_FS } from './shaders';

export const TABLE_N = 256;
export const MAX_BODIES = 8;
export const BODY_N = 256;
const METER_W = 48;
const METER_H = 27;

/** Everything the ray tracer needs for one frame. Lengths and times in units of M. */
export interface FrameParams {
  /** Camera position (x, y, z). */
  position: [number, number, number];
  /** Camera frame, contravariant 4-vectors: 4-velocity, right, up, forward. */
  frame: [number[], number[], number[], number[]];
  fovY: number;
  spin: number;
  horizon: number;
  inside: boolean;
  diskOn: boolean;
  diskIn: number;
  diskOut: number;
  time: number;
  turbulence: number;
  maxSteps: number;
  stepScale: number;
  diskGain: number;
  /** Apply Doppler and gravitational frequency shifts to the disk (false = unphysical). */
  shifts: boolean;
  /** 0: procedural stars, 1: lensing grid, 2: the real sky (needs setRealSky). */
  skyMode: 0 | 1 | 2;
  /** Simulation → galactic rotation (column-major mat3), for the real sky. */
  skyMatrix: Float32Array;
  starGain: number;
  galaxyGain: number;
  exposure: number;
  bloom: number;
  /** Film grain and vignette strength, 0..1 (artistic). */
  grain?: number;
  vignette?: number;
  /** Colour grade (artistic): contrast and saturation (1 = none), white-balance gains. */
  grade?: { contrast: number; saturation: number; tint: [number, number, number] };
  bodies: BodyFrame[];
  bodyGain: number;
  /** Ray-trace in tiles (slower overall, but no single GPU call runs long). */
  tiled?: boolean;
}

/** One beacon's sampled worldline, times relative to the camera's "now". */
export interface BodyFrame {
  /** BODY_N samples each of (x, y, z), (u^t, u^x, u^y, u^z) and τ. */
  pos: Float32Array;
  u: Float32Array;
  tau: Float32Array;
  t0: number;
  dt: number;
  radius: number;
  temperature: number;
  /** Proper time between flashes (0 = steady). */
  pulse: number;
  bound: [number, number, number, number];
}

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

/**
 * WebGL2 pipeline: ray-trace into an HDR buffer at `renderScale` of the canvas, bright-pass
 * and blur it at ¼ and ⅛ size for bloom, then expose, tone-map (ACES) and write sRGB.
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private ray: WebGLProgram;
  private down: WebGLProgram;
  private blur: WebGLProgram;
  private comp: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private tables: WebGLTexture;
  private bodyTex: WebGLTexture;
  private bodyData = new Float32Array(BODY_N * MAX_BODIES * 3 * 4);
  private sky: { gamma: number; width: number; tex: WebGLTexture[] } | null = null;
  private hdr!: Target;
  private bloom: Target[] = [];
  private meter!: Target;
  private meterPixels = new Float32Array(METER_W * METER_H * 4);
  private meterBuffer: WebGLBuffer | null = null;
  private meterFence: WebGLSync | null = null;
  private meterReading = NaN;
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private log2TRange: [number, number] = [0, 1];
  renderScale = 0.6;
  /** While a photo is being developed, the canvas belongs to it: resizes wait. */
  private capturing = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU cannot render to float buffers.');
    this.gl = gl;
    this.ray = this.program(RAYTRACE_FS);
    this.down = this.program(DOWNSAMPLE_FS);
    this.blur = this.program(BLUR_FS);
    this.comp = this.program(COMPOSITE_FS);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.tables = gl.createTexture()!;
    this.bodyTex = gl.createTexture()!;
    this.resize();
  }

  /**
   * Row 0: log2 linear-sRGB blackbody radiance at temperatures log-spaced over `log2T`.
   * Row 1: disk temperature at r = rIn + (rOut − rIn)·s².
   */
  setTables(blackbodyLog2: Float32Array, log2T: [number, number], diskT: Float32Array) {
    const gl = this.gl;
    const data = new Float32Array(TABLE_N * 2 * 4);
    for (let i = 0; i < TABLE_N; i++) {
      data.set(blackbodyLog2.subarray(i * 3, i * 3 + 3), i * 4);
      data[(TABLE_N + i) * 4] = diskT[i];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tables);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TABLE_N, 2, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.log2TRange = log2T;
  }

  resize() {
    if (this.capturing) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    this.allocate(w, h, this.renderScale);
  }

  /** The largest image (width, height) this GPU can render in one piece. */
  maxPhotoSize() {
    const gl = this.gl;
    const tex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const [vw, vh] = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    return [Math.min(tex, vw, 16384), Math.min(tex, vh, 16384)];
  }

  private allocate(w: number, h: number, scale: number) {
    this.canvas.width = w;
    this.canvas.height = h;
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));
    if (this.hdr?.w === sw && this.hdr?.h === sh) return;
    for (const t of [this.hdr, ...this.bloom]) if (t) this.free(t);
    this.hdr = this.target(sw, sh);
    const qw = Math.max(1, sw >> 2);
    const qh = Math.max(1, sh >> 2);
    this.bloom = [this.target(qw, qh), this.target(qw, qh), this.target(qw >> 1, qh >> 1), this.target(qw >> 1, qh >> 1)];
    this.meter ??= this.target(METER_W, METER_H);
  }

  render(f: FrameParams) {
    const gl = this.gl;
    this.setupTrace(f);
    if (f.tiled) {
      // Many short draws instead of one long one, so the GPU watchdog never trips.
      const T = 192;
      gl.enable(gl.SCISSOR_TEST);
      for (let y = 0; y < this.hdr.h; y += T) {
        for (let x = 0; x < this.hdr.w; x += T) {
          gl.scissor(x, y, T, T);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.finish();
        }
      }
      gl.disable(gl.SCISSOR_TEST);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    this.post(f);
  }

  /**
   * Develop a photo: ray-trace a w × h image in tiles, handing control back to the browser
   * between batches (so the page stays responsive and can show progress), then composite it
   * onto the canvas, which is left at that size for the caller to read. Call resize() after.
   */
  async renderPhoto(f: FrameParams, w: number, h: number, progress?: (done: number) => void) {
    const gl = this.gl;
    this.capturing = true;
    try {
      this.allocate(w, h, 1);
      const T = 256;
      const tiles: [number, number][] = [];
      for (let y = 0; y < h; y += T) for (let x = 0; x < w; x += T) tiles.push([x, y]);
      let yielded = performance.now();
      this.setupTrace(f);
      for (let i = 0; i < tiles.length; i++) {
        if (performance.now() - yielded > 60) {
          progress?.(i / tiles.length);
          await new Promise((r) => setTimeout(r, 0));
          yielded = performance.now();
          this.setupTrace(f); // nothing else draws meanwhile, but be safe
        }
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(tiles[i][0], tiles[i][1], T, T);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.disable(gl.SCISSOR_TEST);
        gl.finish();
      }
      progress?.(1);
      this.post(f);
    } finally {
      this.capturing = false;
    }
  }

  /** Bind the ray tracer, its target and all its inputs. */
  private setupTrace(f: FrameParams) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    this.bindTarget(this.hdr);
    gl.useProgram(this.ray);
    const u = (n: string) => this.loc(this.ray, n);
    gl.uniform2f(u('uRes'), this.hdr.w, this.hdr.h);
    gl.uniform4f(u('uCam'), 0, ...f.position);
    (['uE0', 'uE1', 'uE2', 'uE3'] as const).forEach((n, i) => gl.uniform4fv(u(n), f.frame[i]));
    const tanFov = Math.tan(f.fovY / 2);
    gl.uniform1f(u('uTanFov'), tanFov);
    gl.uniform1f(u('uPixelAngle'), (2 * tanFov) / this.hdr.h);
    gl.uniform1f(u('uA'), f.spin);
    gl.uniform1f(u('uRh'), f.horizon);
    gl.uniform1f(u('uRCapture'), innerPhotonOrbit(Math.abs(f.spin)) * 0.995);
    gl.uniform1f(u('uEscape'), Math.max(2000, 2 * Math.hypot(...f.position)));
    gl.uniform1i(u('uInside'), f.inside ? 1 : 0);
    gl.uniform1i(u('uMaxSteps'), f.maxSteps);
    gl.uniform1f(u('uStepScale'), f.stepScale);
    gl.uniform1i(u('uDiskOn'), f.diskOn ? 1 : 0);
    gl.uniform1f(u('uDiskIn'), f.diskIn);
    gl.uniform1f(u('uDiskOut'), f.diskOut);
    gl.uniform1f(u('uTime'), f.time);
    gl.uniform1f(u('uTurbulence'), f.turbulence);
    gl.uniform1f(u('uLog2TMin'), this.log2TRange[0]);
    gl.uniform1f(u('uLog2TMax'), this.log2TRange[1]);
    gl.uniform1f(u('uDiskGain'), f.diskGain);
    gl.uniform1i(u('uShifts'), f.shifts ? 1 : 0);
    gl.uniform1i(u('uSkyMode'), f.skyMode === 2 && !this.sky ? 0 : f.skyMode);
    if (this.sky) {
      const units = ['uMilkyWay', 'uStarIndex', 'uStarList', 'uStarData'];
      this.sky.tex.forEach((t, i) => this.bindTex(4 + i, t, u(units[i])));
      gl.uniform1f(u('uSkyGamma'), this.sky.gamma);
      gl.uniform1f(u('uSkyWidth'), this.sky.width);
      gl.uniform1f(u('uStarSigmaMax'), STAR_MARGIN / 4.5);
      gl.uniformMatrix3fv(u('uSkyMatrix'), false, f.skyMatrix);
    }
    gl.uniform1f(u('uStarGain'), f.starGain);
    gl.uniform1f(u('uGalaxyGain'), f.galaxyGain);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tables);
    gl.uniform1i(u('uTables'), 0);
    this.uploadBodies(f, u);
  }

  /** Bloom and compositing onto the canvas. */
  private post(f: FrameParams) {
    const gl = this.gl;
    // 2. Bloom: bright-pass down to ¼, blur; down again to ⅛, blur. The glow's size is a
    // fixed fraction of the image (as tuned at 648 rows), so a 4K photo glows like the
    // preview: larger images get more, gentler blur passes (variances add).
    const spread = Math.max(0.5, this.hdr.h / 648);
    const passes = Math.min(36, Math.max(1, Math.ceil(spread * spread)));
    const step = spread / Math.sqrt(passes);
    const [qa, qb, ea, eb] = this.bloom;
    const blur = (a: Target, b: Target) => {
      for (let i = 0; i < passes; i++) {
        this.pass(this.blur, b, a.tex, { uStep: [step / a.w, 0] });
        this.pass(this.blur, a, b.tex, { uStep: [0, step / a.h] });
      }
    };
    this.pass(this.down, qa, this.hdr.tex, { uTexel: [1 / this.hdr.w, 1 / this.hdr.h], uThreshold: 1.0 / f.exposure });
    blur(qa, qb);
    this.pass(this.down, ea, qa.tex, { uTexel: [1 / qa.w, 1 / qa.h], uThreshold: 0 });
    blur(ea, eb);

    // 3. Composite to the screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.comp);
    this.bindTex(0, this.hdr.tex, this.loc(this.comp, 'uHdr'));
    this.bindTex(1, qa.tex, this.loc(this.comp, 'uBloomA'));
    this.bindTex(2, ea.tex, this.loc(this.comp, 'uBloomB'));
    gl.uniform1f(this.loc(this.comp, 'uExposure'), f.exposure);
    gl.uniform1f(this.loc(this.comp, 'uBloom'), f.bloom);
    gl.uniform1f(this.loc(this.comp, 'uGrain'), f.grain ?? 0);
    gl.uniform1f(this.loc(this.comp, 'uVignette'), f.vignette ?? 0);
    gl.uniform1f(this.loc(this.comp, 'uSeed'), Math.random() * 1000);
    const grade = f.grade ?? { contrast: 1, saturation: 1, tint: [1, 1, 1] };
    gl.uniform1f(this.loc(this.comp, 'uContrast'), grade.contrast);
    gl.uniform1f(this.loc(this.comp, 'uSaturation'), grade.saturation);
    gl.uniform3fv(this.loc(this.comp, 'uTint'), grade.tint);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Light meter for auto-exposure: the luminance that the brightest few percent of the
   * (blurred, downsampled) frame exceeds. Non-blocking: each call collects the previous
   * reading if the GPU has finished it (returning NaN until the first one arrives) and
   * starts the next, so the CPU never waits for the GPU.
   */
  meterLuminance(fraction = 0.03) {
    const gl = this.gl;
    if (this.meterFence) {
      if (gl.clientWaitSync(this.meterFence, 0, 0) === gl.TIMEOUT_EXPIRED) return this.meterReading;
      gl.deleteSync(this.meterFence);
      this.meterFence = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.meterBuffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.meterPixels);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const lum: number[] = [];
      for (let i = 0; i < METER_W * METER_H; i++) {
        const o = i * 4;
        lum.push(0.2126 * this.meterPixels[o] + 0.7152 * this.meterPixels[o + 1] + 0.0722 * this.meterPixels[o + 2]);
      }
      lum.sort((a, b) => b - a);
      this.meterReading = lum[Math.floor(fraction * lum.length)];
    }
    // Start the next reading: downsample the HDR frame and copy it into a buffer on the GPU.
    this.pass(this.down, this.meter, this.hdr.tex, { uTexel: [1 / this.hdr.w, 1 / this.hdr.h], uThreshold: 0 });
    if (!this.meterBuffer) {
      this.meterBuffer = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.meterBuffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.meterPixels.byteLength, gl.STREAM_READ);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.meterBuffer);
    gl.readPixels(0, 0, METER_W, METER_H, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.meterFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return this.meterReading;
  }

  /** Upload the real sky: the Milky Way map (mipmapped) and the star lookup textures. */
  setRealSky(sky: RealSkyData) {
    const gl = this.gl;
    const mw = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, mw);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, sky.image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const dataTex = (w: number, h: number, internal: number, format: number, data: Float32Array) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    this.sky = {
      gamma: sky.gamma,
      width: sky.width,
      tex: [
        mw,
        dataTex(INDEX_W, sky.indexRows, gl.RGBA32F, gl.RGBA, sky.index),
        dataTex(LIST_W, sky.listRows, gl.R32F, gl.RED, sky.list),
        dataTex(DATA_W, sky.dataRows, gl.RGBA32F, gl.RGBA, sky.data),
      ],
    };
  }

  private uploadBodies(f: FrameParams, u: (n: string) => WebGLUniformLocation | null) {
    const gl = this.gl;
    const n = Math.min(f.bodies.length, MAX_BODIES);
    const d = this.bodyData;
    const t0 = new Float32Array(MAX_BODIES);
    const dt = new Float32Array(MAX_BODIES).fill(1);
    const rad = new Float32Array(MAX_BODIES);
    const temp = new Float32Array(MAX_BODIES);
    const pulse = new Float32Array(MAX_BODIES);
    const bound = new Float32Array(MAX_BODIES * 4);
    for (let i = 0; i < n; i++) {
      const b = f.bodies[i];
      for (let k = 0; k < BODY_N; k++) {
        const row = (r: number) => ((3 * i + r) * BODY_N + k) * 4;
        d.set([b.pos[3 * k], b.pos[3 * k + 1], b.pos[3 * k + 2], 1], row(0));
        d.set(b.u.subarray(4 * k, 4 * k + 4), row(1));
        d[row(2)] = b.tau[k];
      }
      t0[i] = b.t0;
      dt[i] = b.dt;
      rad[i] = b.radius;
      temp[i] = b.temperature;
      pulse[i] = b.pulse;
      bound.set(b.bound, 4 * i);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.bodyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, BODY_N, 3 * MAX_BODIES, 0, gl.RGBA, gl.FLOAT, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(u('uBodies'), 3);
    gl.uniform1i(u('uBodyCount'), n);
    gl.uniform1fv(u('uBodyT0'), t0);
    gl.uniform1fv(u('uBodyDt'), dt);
    gl.uniform1fv(u('uBodyR'), rad);
    gl.uniform1fv(u('uBodyTemp'), temp);
    gl.uniform1fv(u('uBodyPulse'), pulse);
    gl.uniform4fv(u('uBodyBound'), bound);
    gl.uniform1f(u('uBodyGain'), f.bodyGain);
  }

  private pass(prog: WebGLProgram, out: Target, src: WebGLTexture, uni: Record<string, number | number[]>) {
    const gl = this.gl;
    this.bindTarget(out);
    gl.useProgram(prog);
    this.bindTex(0, src, this.loc(prog, 'uSrc'));
    for (const [k, v] of Object.entries(uni)) {
      if (typeof v === 'number') gl.uniform1f(this.loc(prog, k), v);
      else gl.uniform2f(this.loc(prog, k), v[0], v[1]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  private bindTarget(t: Target) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, t.fb);
    this.gl.viewport(0, 0, t.w, t.h);
  }

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, w, h };
  }

  private free(t: Target) {
    this.gl.deleteFramebuffer(t.fb);
    this.gl.deleteTexture(t.tex);
  }

  private loc(prog: WebGLProgram, name: string) {
    let m = this.uniforms.get(prog);
    if (!m) this.uniforms.set(prog, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name));
    return m.get(name)!;
  }

  private program(fs: string) {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, FULLSCREEN_VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Link error: ${gl.getProgramInfoLog(p)}`);
    return p;
  }
}
