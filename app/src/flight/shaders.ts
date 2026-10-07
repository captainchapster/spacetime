/**
 * GLSL for the flight view. The ray tracer mirrors src/physics/kerrRays.ts line for line
 * (Kerr–Schild Hamiltonian, analytic derivatives, RK4); test/kerr.test.ts validates that
 * code against exact shadow edges, so changes here must be made there too.
 */

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const RAYTRACE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uRes;
uniform vec4 uCam;                    // camera event (t is 0: the metric is stationary)
uniform vec4 uE0, uE1, uE2, uE3;      // camera frame: e0 = 4-velocity, e1 right, e2 up, e3 forward
uniform float uTanFov;                // tan(vertical half-angle)
uniform float uPixelAngle;            // angular size of one pixel (radians)
uniform float uA, uRh, uEscape;
uniform float uRCapture;              // just inside the innermost photon orbit (see kerrRays.ts)
uniform bool uInside;
uniform int uMaxSteps;
uniform float uStepScale;
uniform bool uDiskOn;
uniform float uDiskIn, uDiskOut;
uniform float uTime;                  // coordinate time (M) for the disk's rotating texture
uniform float uTurbulence;
uniform sampler2D uTables;            // row 0: log2 blackbody RGB vs log2 T;  row 1: disk T(r)
uniform float uLog2TMin, uLog2TMax;
uniform float uDiskGain, uStarGain, uGalaxyGain;
uniform bool uShifts;                 // false: drop Doppler/gravitational shifts (Interstellar look)
uniform int uSkyMode;                 // 0: procedural stars, 1: lensing grid, 2: the real sky

// The real sky (as seen from Earth): NASA's Milky Way map in galactic coordinates
// (gamma-encoded), plus Hipparcos stars binned on a cube-face grid (see physics/sky.ts).
uniform sampler2D uMilkyWay;
uniform float uSkyGamma;
uniform float uSkyWidth;
uniform mat3 uSkyMatrix;              // simulation direction → galactic direction
uniform sampler2D uStarIndex;         // per grid cell: (first entry, count)
uniform sampler2D uStarList;          // star indices, sorted by cell
uniform sampler2D uStarData;          // per star, 2 texels: (gx, gy, gz, flux), (T, -, -, -)
uniform float uStarSigmaMax;          // largest star blur we allow (radians): keeps stars in one cell
const int STAR_GRID = 128;
const int INDEX_W = 512;
const int LIST_W = 4096;
const int DATA_W = 4096;

// Beacons: glowing spheres on recorded worldlines. Per beacon, 3 rows of uBodies:
// (x, y, z, valid), (u^t, u^x, u^y, u^z), (τ, -, -, -), sampled uniformly in coordinate time
// from uBodyT0 (relative to now) every uBodyDt.
const int MAX_BODIES = 8;
const int BODY_N = 256;
uniform sampler2D uBodies;
uniform int uBodyCount;
uniform float uBodyT0[MAX_BODIES];
uniform float uBodyDt[MAX_BODIES];
uniform float uBodyR[MAX_BODIES];
uniform float uBodyTemp[MAX_BODIES];
uniform float uBodyPulse[MAX_BODIES];
uniform vec4 uBodyBound[MAX_BODIES];  // sphere enclosing the whole sampled worldline
uniform float uBodyGain;

out vec4 outColor;

const int TABLE_N = 256;

// ---------------------------------------------------------------- Kerr–Schild geometry

float kerrR(vec3 q) {
  float a2 = uA * uA;
  float b = dot(q, q) - a2;
  float s = sqrt(0.25 * b * b + a2 * q.z * q.z);
  float r2 = b >= 0.0 ? 0.5 * b + s : (a2 * q.z * q.z) / (s - 0.5 * b);
  return sqrt(max(r2, 1e-12));
}

// g_μν k^ν
vec4 lowerK(vec4 x, vec4 k) {
  float a = uA;
  float r = kerrR(x.yzw);
  float r2 = r * r;
  float ra = r2 + a * a;
  float f = 2.0 * r2 * r / (r2 * r2 + a * a * x.w * x.w);
  float lx = (r * x.y + a * x.z) / ra;
  float ly = (r * x.z - a * x.y) / ra;
  float lz = x.w / r;
  float lk = k.x + lx * k.y + ly * k.z + lz * k.w;
  return vec4(-k.x + f * lk, k.y + f * lk * lx, k.z + f * lk * ly, k.w + f * lk * lz);
}

// H = ½ g^μν p_μ p_ν, zero for light.
float hamiltonianAt(vec4 x, vec4 p) {
  float a = uA;
  float r = kerrR(x.yzw);
  float r2 = r * r;
  float ra = r2 + a * a;
  float f = 2.0 * r2 * r / (r2 * r2 + a * a * x.w * x.w);
  float L = -p.x + ((r * x.y + a * x.z) / ra) * p.y + ((r * x.z - a * x.y) / ra) * p.z + (x.w / r) * p.w;
  return 0.5 * (-p.x * p.x + dot(p.yzw, p.yzw)) - 0.5 * f * L * L;
}

// Hamilton's equations for H = ½ η p p − ½ f (l·p)².
void derivs(vec4 x, vec4 p, out vec4 dx, out vec4 dp) {
  float a = uA;
  float X = x.y, Y = x.z, Z = x.w;
  float r = kerrR(x.yzw);
  float r2 = r * r;
  float ra = r2 + a * a;
  float S = r2 * r2 + a * a * Z * Z;
  float f = 2.0 * r2 * r / S;
  float lx = (r * X + a * Y) / ra;
  float ly = (r * Y - a * X) / ra;
  float lz = Z / r;
  float L = -p.x + lx * p.y + ly * p.z + lz * p.w;
  dx = vec4(-p.x + f * L, p.y - f * L * lx, p.z - f * L * ly, p.w - f * L * lz);

  vec3 dr = vec3(r2 * r * X, r2 * r * Y, r * Z * ra) / S;
  float dfdr = (2.0 * r2 / S) * ((3.0 * S - 4.0 * r2 * r2) / S);
  vec3 df = dfdr * dr;
  df.z -= (4.0 * r2 * r * a * a * Z / S) / S;
  float ra2 = ra * ra;
  vec3 dlx = ((dr * X + vec3(r, a, 0.0)) * ra - (r * X + a * Y) * 2.0 * r * dr) / ra2;
  vec3 dly = ((dr * Y + vec3(-a, r, 0.0)) * ra - (r * Y - a * X) * 2.0 * r * dr) / ra2;
  vec3 dlz = (vec3(0.0, 0.0, r) - Z * dr) / r2;
  vec3 dL = dlx * p.y + dly * p.z + dlz * p.w;
  dp = vec4(0.0, 0.5 * df * L * L + f * L * dL);
}

// ---------------------------------------------------------------- colour tables

// Linear-sRGB radiance of a blackbody at temperature T (log-interpolated table).
vec3 blackbody(float T) {
  float u = (log2(max(T, 1.0)) - uLog2TMin) / (uLog2TMax - uLog2TMin) * float(TABLE_N - 1);
  u = clamp(u, 0.0, float(TABLE_N - 1) - 0.001);
  int i = int(u);
  vec3 a = texelFetch(uTables, ivec2(i, 0), 0).rgb;
  vec3 b = texelFetch(uTables, ivec2(i + 1, 0), 0).rgb;
  return exp2(mix(a, b, u - float(i)));
}

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Disk gas temperature at radius r; samples are spaced as r = rIn + (rOut − rIn)·s².
float diskTemperature(float r) {
  float s = sqrt(clamp((r - uDiskIn) / (uDiskOut - uDiskIn), 0.0, 1.0)) * float(TABLE_N - 1);
  s = min(s, float(TABLE_N - 1) - 0.001);
  int i = int(s);
  return mix(texelFetch(uTables, ivec2(i, 1), 0).r, texelFetch(uTables, ivec2(i + 1, 1), 0).r, s - float(i));
}

// ---------------------------------------------------------------- noise

uvec3 pcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 hash3(vec3 p) { return vec3(pcg3(uvec3(ivec3(floor(p)) + 65536))) / 4294967295.0; }

float valueNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash3(i).x, n100 = hash3(i + vec3(1, 0, 0)).x;
  float n010 = hash3(i + vec3(0, 1, 0)).x, n110 = hash3(i + vec3(1, 1, 0)).x;
  float n001 = hash3(i + vec3(0, 0, 1)).x, n101 = hash3(i + vec3(1, 0, 1)).x;
  float n011 = hash3(i + vec3(0, 1, 1)).x, n111 = hash3(i + vec3(1, 1, 1)).x;
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float s = 0.0, w = 0.5;
  for (int i = 0; i < 5; i++) { s += w * valueNoise(p); p = p * 2.03 + 11.7; w *= 0.5; }
  return s;
}

// ---------------------------------------------------------------- the sky

// Direction of a cube-face point (face 0..5, uv in [−1, 1]²).
vec3 faceDir(int face, vec2 uv) {
  if (face == 0) return normalize(vec3(1.0, uv.x, uv.y));
  if (face == 1) return normalize(vec3(-1.0, uv.x, uv.y));
  if (face == 2) return normalize(vec3(uv.x, 1.0, uv.y));
  if (face == 3) return normalize(vec3(uv.x, -1.0, uv.y));
  if (face == 4) return normalize(vec3(uv.x, uv.y, 1.0));
  return normalize(vec3(uv.x, uv.y, -1.0));
}

// Stars: one candidate per cube-face cell, each a blackbody of random temperature. Their
// light arrives shifted by g, so they're drawn as a blackbody at g·T, scaled by g⁴.
vec3 starLayer(vec3 dir, float cells, float density, float bright, float g, int layer) {
  vec3 ad = abs(dir);
  int face; vec2 uv;
  if (ad.x >= ad.y && ad.x >= ad.z) { face = dir.x > 0.0 ? 0 : 1; uv = dir.yz / ad.x; }
  else if (ad.y >= ad.z) { face = dir.y > 0.0 ? 2 : 3; uv = dir.xz / ad.y; }
  else { face = dir.z > 0.0 ? 4 : 5; uv = dir.xy / ad.z; }
  vec2 gpos = (uv * 0.5 + 0.5) * cells;
  vec2 cell = floor(gpos);
  vec3 sum = vec3(0.0);
  float sigma = max(uPixelAngle * 0.75, 2e-4);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(i, j);
    vec3 h = hash3(vec3(c, float(face * 16 + layer)));
    if (h.z > density) continue;
    vec2 suv = ((c + 0.2 + 0.6 * h.xy) / cells) * 2.0 - 1.0;
    vec3 sd = faceDir(face, suv);
    float ang = length(dir - sd);
    float w = exp(-0.5 * ang * ang / (sigma * sigma));
    if (w < 1e-3) continue;
    vec3 h2 = hash3(vec3(c * 1.37 + 5.1, float(face * 16 + layer + 7)));
    // Mostly Sun-like and cooler stars, a few hot blue ones; a steep brightness distribution.
    float T = h2.x < 0.92 ? 3200.0 + 4500.0 * h2.x : 9000.0 + 20000.0 * (h2.x - 0.92) / 0.08;
    float mag = bright * pow(h2.y, 12.0) / (sigma * sigma * 4e6);
    vec3 bb = blackbody(T * g) / luminance(blackbody(T));
    sum += mag * w * bb;
  }
  return sum;
}

// A latitude/longitude grid on the sky (10° spacing), to show how lensing distorts it.
vec3 gridSky(vec3 dir) {
  float lat = asin(clamp(dir.z, -1.0, 1.0));
  float lon = atan(dir.y, dir.x);
  float step = radians(10.0);
  vec2 cell = vec2(lon, lat) / step;
  vec2 dist = abs(fract(cell + 0.5) - 0.5) * step;
  float w = 1.5 * uPixelAngle;
  float line = max(smoothstep(w, 0.0, dist.x * cos(lat)), smoothstep(w, 0.0, dist.y));
  bool checker = mod(floor(cell.x) + floor(cell.y), 2.0) < 1.0;
  vec3 base = checker ? vec3(0.10, 0.12, 0.16) : vec3(0.16, 0.14, 0.12);
  return mix(base, vec3(0.9), line);
}

// Mirrors skyCell() in physics/sky.ts.
int skyCell(vec3 d) {
  vec3 a = abs(d);
  int face;
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) { face = d.x > 0.0 ? 0 : 1; uv = d.yz / a.x; }
  else if (a.y >= a.z) { face = d.y > 0.0 ? 2 : 3; uv = d.xz / a.y; }
  else { face = d.z > 0.0 ? 4 : 5; uv = d.xy / a.z; }
  ivec2 ij = min(ivec2(floor((uv * 0.5 + 0.5) * float(STAR_GRID))), ivec2(STAR_GRID - 1));
  return (face * STAR_GRID + ij.y) * STAR_GRID + ij.x;
}

/**
 * The real sky in simulation direction dir, with frequency ratio g, where one pixel covers
 * foot radians of sky. Stars are exact points: each is drawn as a Gaussian about one
 * pixel wide *on the sky*, normalised over solid angle, so wherever lensing magnifies or
 * squeezes the sky, its total brightness on screen scales by exactly the magnification.
 */
vec3 realSky(vec3 dir, float g, float foot) {
  vec3 d = normalize(uSkyMatrix * dir);
  // Diffuse Milky Way, filtered to the pixel's footprint. Its colour shift treats the light
  // as ~4500 K starlight (an approximation; the map has no spectra).
  vec2 uv = vec2(0.5 - atan(d.y, d.x) / 6.2831853, 0.5 - asin(clamp(d.z, -1.0, 1.0)) / 3.1415927);
  float lod = log2(max(foot * uSkyWidth / 6.2831853, 1e-6));
  vec3 mw = pow(textureLod(uMilkyWay, uv, lod).rgb, vec3(uSkyGamma));
  vec3 col = uGalaxyGain * mw * (blackbody(4500.0 * g) / blackbody(4500.0));

  // Catalogue stars sharing this direction's grid cell.
  int c = skyCell(d);
  vec4 cell = texelFetch(uStarIndex, ivec2(c % INDEX_W, c / INDEX_W), 0);
  int first = int(cell.x);
  int count = min(int(cell.y), 64);
  float sigma = clamp(0.6 * foot, 2e-5, uStarSigmaMax);
  float norm = 1.0 / (6.2831853 * sigma * sigma);
  for (int k = 0; k < 64; k++) {
    if (k >= count) break;
    int e = first + k;
    int s = int(texelFetch(uStarList, ivec2(e % LIST_W, e / LIST_W), 0).x);
    vec4 a = texelFetch(uStarData, ivec2((2 * s) % DATA_W, (2 * s) / DATA_W), 0);
    vec3 off = d - a.xyz;
    float q = dot(off, off) / (sigma * sigma);
    if (q > 18.0) continue;
    float T = texelFetch(uStarData, ivec2((2 * s + 1) % DATA_W, (2 * s + 1) / DATA_W), 0).x;
    col += uStarGain * a.w * norm * exp(-0.5 * q) * blackbody(T * g) / luminance(blackbody(T));
  }
  return col;
}

vec3 sky(vec3 dir, float g, float foot) {
  if (uSkyMode == 2) return realSky(dir, g, foot);
  if (uSkyMode == 1) return gridSky(dir);
  vec3 col = vec3(0.0);
  col += starLayer(dir, 50.0, 0.5, 6.0, g, 0);
  col += starLayer(dir, 160.0, 0.3, 0.7, g, 1);
  col += starLayer(dir, 450.0, 0.2, 0.12, g, 2);
  col *= uStarGain;

  // A galaxy band: starlight (≈4500 K) with dust lanes, along a great circle.
  vec3 n = normalize(vec3(0.25, -0.45, 0.86));
  float lat = dot(dir, n);
  float band = exp(-lat * lat / 0.018);
  float clouds = fbm(dir * 3.5);
  float dust = smoothstep(0.45, 0.75, fbm(dir * 7.0 + 3.0)) * exp(-lat * lat / 0.002);
  float glow = band * (0.35 + 1.3 * clouds * clouds) * (1.0 - 0.85 * dust);
  glow += 0.05 * exp(-lat * lat / 0.15);
  vec3 bb = blackbody(4500.0 * g) / luminance(blackbody(4500.0));
  col += uGalaxyGain * glow * bb * 0.02;
  return col;
}

// ---------------------------------------------------------------- the disk

// Emission (rgb) and opacity (a) where a ray crosses the disk. The disk is opaque except
// toward its outer rim, where it thins out and lets background light through.
vec4 shadeDisk(vec4 hit, vec4 p, float r) {
  // Gas on a prograde circular orbit: Ω = 1/(r^{3/2} + a), u ∝ (1, −Ωy, Ωx, 0).
  float om = 1.0 / (r * sqrt(r) + uA);
  vec4 w = vec4(1.0, -om * hit.z, om * hit.y, 0.0);
  vec4 wl = lowerK(hit, w);
  float ut = 1.0 / sqrt(max(-dot(wl, w), 1e-9));
  float pu = ut * (p.x + p.y * w.y + p.z * w.z);
  float g = uShifts ? 1.0 / pu : 1.0;      // received / emitted frequency
  float T = diskTemperature(r) * g;
  vec3 rad = blackbody(T) * uDiskGain;

  // Turbulent brightness pattern, carried around at the local orbital speed and seen as
  // it was when the light left it (hit.x is the emission time relative to now).
  float phi = atan(hit.z, hit.y) - om * (uTime + hit.x);
  vec2 q = 2.0 * vec2(cos(phi), sin(phi));
  float lr = log(r);
  float tex = fbm(vec3(q * 2.2, lr * 7.0)) * 0.8 + 0.6 * fbm(vec3(q * 7.0, lr * 22.0));
  float rings = 0.9 + 0.1 * sin(lr * 45.0 + 6.0 * fbm(vec3(q * 3.0, lr * 3.0)));
  float pattern = mix(1.0, tex * rings * 1.6, uTurbulence);
  // Emission fades at the ISCO by itself (zero torque); the outer rim thins out.
  float alpha = smoothstep(uDiskOut, uDiskOut * 0.6, r);
  return vec4(rad * pattern * alpha, alpha);
}

// ---------------------------------------------------------------- beacons

bool bodyAt(int i, float t, out vec3 pos, out vec4 u, out float tau) {
  float f = (t - uBodyT0[i]) / uBodyDt[i];
  if (f < 0.0 || f > float(BODY_N - 1)) return false;
  int k = min(int(f), BODY_N - 2);
  float w = f - float(k);
  vec4 a = texelFetch(uBodies, ivec2(k, 3 * i), 0);
  vec4 b = texelFetch(uBodies, ivec2(k + 1, 3 * i), 0);
  if (a.w < 0.5 || b.w < 0.5) return false;
  pos = mix(a.xyz, b.xyz, w);
  u = mix(texelFetch(uBodies, ivec2(k, 3 * i + 1), 0), texelFetch(uBodies, ivec2(k + 1, 3 * i + 1), 0), w);
  tau = mix(texelFetch(uBodies, ivec2(k, 3 * i + 2), 0).x, texelFetch(uBodies, ivec2(k + 1, 3 * i + 2), 0).x, w);
  return true;
}

// Mirrors bodyHit() in kerrRays.ts: the body is placed where it was when the light passed.
bool bodyHit(int i, vec4 x, vec4 xn, out float sEntry, out vec4 u, out float tau) {
  vec3 A = x.yzw;
  vec3 d = xn.yzw - A;
  float dd = max(dot(d, d), 1e-12);
  vec4 bound = uBodyBound[i];
  vec3 cb = A + clamp(dot(bound.xyz - A, d) / dd, 0.0, 1.0) * d - bound.xyz;
  if (dot(cb, cb) > bound.w * bound.w) return false;      // cheap reject
  vec3 pos;
  if (!bodyAt(i, 0.5 * (x.x + xn.x), pos, u, tau)) return false;
  vec3 w = pos - A;
  float s = clamp(dot(w, d) / dd, 0.0, 1.0);
  vec3 m = w - s * d;
  float R = uBodyR[i];
  float miss2 = dot(m, m);
  if (miss2 > R * R) return false;
  sEntry = max(0.0, s - sqrt((R * R - miss2) / dd));
  return true;
}

// ---------------------------------------------------------------- main

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y);
  vec3 d = normalize(vec3(uv * uTanFov, 1.0));
  // Past-directed null ray: k = −e0 + d (so that k·u_camera = 1).
  vec4 k = -uE0 + d.x * uE1 + d.y * uE2 + d.z * uE3;
  vec4 x = uCam;
  vec4 p = lowerK(x, k);

  vec3 col = vec3(0.0);
  float trans = 1.0;                    // how much light from further along still gets through
  bool done = false;
  // Where the ray left for the sky (shaded after the loop, where pixel derivatives work).
  vec3 skyDir = d;
  float skyG = 1.0;
  float skyWeight = 0.0;
  for (int n = 0; n < 4000; n++) {
    if (n >= uMaxSteps) break;
    float r = kerrR(x.yzw);
    if (uInside && r < 0.05) { done = true; break; }
    vec4 k1x, k1p;
    derivs(x, p, k1x, k1p);
    // Inside every photon orbit and heading in: captured (mirrors traceRay). That includes
    // rays hugging the horizon; from a camera a hair above it, outward rays still go on.
    bool inward = r * r * (x.y * k1x.y + x.z * k1x.z) + (r * r + uA * uA) * x.w * k1x.w < 0.0;
    if (!uInside && inward && (r < uRCapture || r < uRh * 1.01)) { done = true; break; }
    float spatial = length(k1x.yzw);
    if (r > uEscape && dot(x.yzw, k1x.yzw) > 0.0) {
      // Only trust rays that are still null (mirrors rayIsNull in kerrRays.ts).
      if (abs(hamiltonianAt(x, p)) < 1e-3 * dot(p, p)) {
        skyDir = k1x.yzw / spatial;
        skyG = 1.0 / p.x;
        skyWeight = trans;
      }
      done = true;
      break;
    }
    // Light can stand still in these coordinates at the ergosphere's surface (g_tt = 0), so
    // its motion through time bounds the step too (mirrors kerrRays.ts).
    float speed = max(spatial, 0.5 * abs(k1x.x));
    // Shorter steps near the horizon, longer far out (mirrors kerrRays.ts).
    float rInner = 2.0 - uRh;           // r₋ (M = 1); 0 without spin
    float nearness = clamp(min(abs(r - uRh), abs(r - rInner)) / uRh, 0.08, 1.0);
    float far = clamp(r / 30.0, 1.0, 8.0);
    float h = uStepScale * r * nearness * far / speed;

    vec4 k2x, k2p, k3x, k3p, k4x, k4p;
    derivs(x + 0.5 * h * k1x, p + 0.5 * h * k1p, k2x, k2p);
    derivs(x + 0.5 * h * k2x, p + 0.5 * h * k2p, k3x, k3p);
    derivs(x + h * k3x, p + h * k3p, k4x, k4p);
    vec4 xn = x + (h / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
    vec4 pn = p + (h / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);

    // A beacon in the way? Its light arrives shifted by g = 1/(p·u) and blinks with its own clock.
    bool hitBody = false;
    for (int i = 0; i < MAX_BODIES; i++) {
      if (i >= uBodyCount) break;
      float sb, tb;
      vec4 ub;
      if (bodyHit(i, x, xn, sb, ub, tb)) {
        float g = 1.0 / dot(mix(p, pn, sb), ub);
        float pulse = uBodyPulse[i] > 0.0 ? 0.25 + 2.5 * exp(-10.0 * fract(tb / uBodyPulse[i])) : 1.0;
        col += trans * blackbody(uBodyTemp[i] * g) * uBodyGain * pulse;
        hitBody = true;
        break;
      }
    }
    if (hitBody) { done = true; break; }

    if (uDiskOn && x.w * xn.w < 0.0) {
      float s = x.w / (x.w - xn.w);
      vec4 hit = mix(x, xn, s);
      float rh = kerrR(vec3(hit.yz, 0.0));
      if (rh >= uDiskIn && rh <= uDiskOut) {
        vec4 e = shadeDisk(hit, mix(p, pn, s), rh);
        col += trans * e.rgb;
        trans *= 1.0 - e.a;
        if (trans < 0.01) { done = true; break; }
      }
    }
    x = xn;
    p = pn;
  }
  // Out of steps: far from the hole that's just a slow escape, so show the sky that way.
  if (!done && kerrR(x.yzw) > 4.0 * uRh) {
    vec4 dx, dp;
    derivs(x, p, dx, dp);
    skyDir = normalize(dx.yzw);
    skyG = 1.0 / p.x;
    skyWeight = trans;
  }
  // How much sky this pixel spans (radians), from neighbouring pixels' escape directions.
  // Every pixel reaches this line, so the derivatives are well defined.
  float foot = max(length(dFdx(skyDir)), length(dFdy(skyDir)));
  foot = min(max(foot, uPixelAngle * 0.25), 0.05);
  if (skyWeight > 0.0) col += skyWeight * sky(skyDir, skyG, foot);
  outColor = vec4(col, 1.0);
}`;

/** Bright-pass + 2×2 downsample. */
export const DOWNSAMPLE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = 0.25 * (texture(uSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture(uSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
                 + texture(uSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture(uSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  outColor = vec4(c * max(l - uThreshold, 0.0) / max(l, 1e-6), 1.0);
}`;

/** Separable 9-tap Gaussian. */
export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uStep;
in vec2 vUv;
out vec4 outColor;
void main() {
  float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 c = texture(uSrc, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    c += texture(uSrc, vUv + uStep * float(i)).rgb * w[i];
    c += texture(uSrc, vUv - uStep * float(i)).rgb * w[i];
  }
  outColor = vec4(c, 1.0);
}`;

/** HDR + bloom → exposure → ACES filmic curve → sRGB. */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uHdr, uBloomA, uBloomB;
uniform float uExposure, uBloom;
uniform float uGrain, uVignette, uSeed;   // camera artistry (off by default)
uniform float uContrast, uSaturation;     // colour grade (artistic; 1 = none)
uniform vec3 uTint;                       // white balance gains (artistic; 1 = none)
in vec2 vUv;
out vec4 outColor;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 srgb(vec3 c) {
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec3 c = texture(uHdr, vUv).rgb;
  c += uBloom * (texture(uBloomA, vUv).rgb + texture(uBloomB, vUv).rgb);
  vec3 o = srgb(aces(c * uExposure * uTint));
  // Colour grade, in display space: saturation about the luma, contrast about mid-grey.
  o = mix(vec3(dot(o, vec3(0.2126, 0.7152, 0.0722))), o, uSaturation);
  o = clamp((o - 0.5) * uContrast + 0.5, 0.0, 1.0);
  // Vignette: darken toward the corners.
  vec2 q = vUv - 0.5;
  o *= mix(1.0, smoothstep(0.85, 0.2, length(q * vec2(1.25, 1.0))), uVignette);
  // Film grain: fresh noise every frame.
  float n = fract(sin(dot(gl_FragCoord.xy + uSeed, vec2(12.9898, 78.233))) * 43758.5453);
  o += (n - 0.5) * 0.09 * uGrain;
  outColor = vec4(o, 1.0);
}`;
