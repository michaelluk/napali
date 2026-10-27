// ============================================================================
//  Powerboat race (index.html?mode=race)
// ============================================================================
// Four offshore powerboats race laps of a buoyed course along the cliffs. The scene is the same ray-marched world; the
// boats, pylons, wakes and spray are rasterised into its HDR buffer before the post chain, depth-tested against the ray
// march's hit distance (a second render target) so waves, sea stacks and headlands hide them, and shaded with the scene
// shader's own sun, sky, reflections, terrain shadows and haze; a sun shadow map adds their shadows on deck and water.
// The hulls ride the real FFT ocean: a probe pass runs the water shader's oceanH() under every hull and pylon.
const RaceMode = (() => {
  const Q2 = (k) => Q.get(k);
  const RACE = {
    laps: Math.max(1, Math.round(num('laps', 2))),
    skill: num('ai', 0.96),
    // closed Catmull-Rom course (world x, z): west under the cliffs, round the sea stacks, back offshore
    keys: [[420, 360], [200, 450], [30, 450], [-150, 600], [-350, 715], [-570, 840], [-750, 1060], [-910, 1230],
      [-1030, 1190], [-950, 980], [-740, 800], [-480, 600], [-200, 420], [60, 310], [330, 270], [520, 300]],
    nGates: 14, gateHW: 26, ds: 2,
  };
  const BOAT = { acc: 13, drag: 0.004, lin: 0.08, grip: 2.2, turn: 1.2 };
  const CREW = [
    { name: '你 YOU', hull: [.55, .025, .02], trim: [.82, .82, .8], css: '#ff4a36', num: 7 },
    { name: 'Kalalau', hull: [.015, .05, .3], trim: [.85, .5, .02], css: '#4d82ff', num: 22 },
    { name: 'Hanakāpīʻai', hull: [.8, .45, .015], trim: [.025, .025, .025], css: '#ffc21f', num: 41 },
    { name: 'Nuʻalolo', hull: [.78, .78, .76], trim: [.015, .3, .1], css: '#35d07f', num: 88 },
  ];
  const AI_SKILL = [1, 0.985, 0.965, 0.95];
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const damp = (k, dt) => 1 - Math.exp(-k * dt);
  const fmtT = (t) => { if (t == null || !isFinite(t)) return '–:––.––'; const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`; };
  const ORD = ['', '1st', '2nd', '3rd', '4th'];

  // ---------------------------------------------------------------- render shader with a hit-distance output
  // URL racelite=1 (debugging only): a trivial sky / sine-wave sea in place of the ray march, same outputs and oceanH()
  const LITE = `#version 300 es
precision highp float; precision highp sampler2D;
uniform vec3 uRo; uniform mat3 uCam; uniform float uTan, uTime; uniform vec2 uRes; uniform sampler2D uCoast; uniform vec4 uCR;
layout(location=0) out vec4 o; layout(location=1) out vec4 oDep;
uniform vec3 uSun;
const vec3 SUN=vec3(1.,.94,.84)*3.6, SUNL=vec3(1.,.93,.8)*4.4;
float shadowH(vec3 p, vec3 L){ return 1.; }
vec3 skyFill(vec3 N, float v){ return N.y>0.?mix(vec3(.19,.18,.165),vec3(.22,.37,.52),N.y):vec3(.05); }
vec3 skyIrr(vec3 N){ return N.y>0.?mix(vec3(.36,.45,.58),vec3(.17,.29,.58),N.y):vec3(.06); }
vec3 skyRefl(vec3 rd, float r){ return mix(vec3(.62,.71,.83),vec3(.27,.43,.74),clamp(rd.y*3.,0.,1.))*.84; }
vec3 fogApply(vec3 c, vec3 ro, vec3 rd, float t){ return c; }
float oceanH(vec2 p, float pix){ return .35*sin(dot(p,vec2(.06,.03))+uTime*1.1)+.25*sin(dot(p,vec2(-.02,.08))+uTime*1.7)+.08*sin(dot(p,vec2(.2,.13))+uTime*3.); }
void main(){
  vec2 uv=(2.*gl_FragCoord.xy-uRes)/uRes.y; vec3 rd=normalize(uCam*vec3(uv*uTan,1.)), ro=uRo;
  vec3 sky=mix(vec3(.55,.7,.9),vec3(.15,.3,.65),clamp(rd.y*2.,0.,1.))*1.3, col=sky; float tt=-1.;
  if(rd.y<0.){ float t=ro.y/-rd.y; for(int i=0;i<4;i++){ vec3 p=ro+rd*t; t=(ro.y-oceanH(p.xz,1.))/-rd.y; }
    vec3 p=ro+rd*t; float c=texture(uCoast,(p.xz-uCR.xy)*uCR.w).r;
    col=c>0.?vec3(.1,.22,.07):mix(vec3(.02,.09,.16),sky,.15+.5*pow(1.+rd.y,8.))*(1.+.4*(oceanH(p.xz,1.)+.5)); tt=t; }
  o=vec4(col,0.); oDep=vec4(tt>0.?tt:1e6,0.,0.,1.);
}`;
  function renderSrc() {
    if (Q2('racelite') === '1') return LITE;
    const a ='\nout vec4 o;\n', i = FS_RENDER.indexOf(a), j = FS_RENDER.lastIndexOf('o=vec4(col,uAOut');
    if (i < 0 || j < 0) throw new Error('race: render shader hooks not found');
    const m = 'if(tmin<far) hitT=march(ro,rd,tmin,far,tT,inf);';
    if (!FS_RENDER.includes(m)) throw new Error('race: march call not found');
    // a ray that has sunk below y = -4 is under every possible water surface (waterHit's bound), so the water was hit
    // first: stop the terrain march there instead of stepping along the seabed (same picture, far fewer steps at sea level)
    return (FS_RENDER.slice(0, i) + '\nlayout(location=0) out vec4 o; layout(location=1) out vec4 oDep;\n' + FS_RENDER.slice(i + a.length, j) +
      'oDep=vec4(tt>0.?tt:1e6,0.,0.,1.);\n  ' + FS_RENDER.slice(j))
      .replace(m, 'float farT=rd.y<0.?min(far,(ro.y+4.)/-rd.y):far; if(tmin<farT) hitT=march(ro,rd,tmin,farT,tT,inf);')
      // real time: the sky (volumetric cumulus, ~40 % of a sea-level frame) comes from a panorama cache (see skyCacheUpdate)
      .replace(need('else { col=skyView(rd); tt=-1.; }'), 'else { col=uRSkyOn>0.?rSkyCache(rd):skyView(rd); tt=-1.; }')
      .replace(need('void main(){\n  vec2 fc=gl_FragCoord.xy+uJit;'), SKY_LOOKUP + 'void main(){\n  vec2 fc=gl_FragCoord.xy+uJit;');
  }
  function need(s) { if (!FS_RENDER.includes(s)) throw new Error('race: render shader hook not found: ' + s.slice(0, 40)); return s; }
  const SKY_W = 2048, SKY_H = 512, SKY_SLICES = 128;
  const SKY_MAP = `
const float RSKY_EL0=-.05;   // panorama rows: elevation -.05 .. pi/2, squared spacing (finer near the horizon)
vec3 rSkyDir(vec2 uv){ float az=(uv.x-.5)*6.2831853, el=RSKY_EL0+(1.5707963-RSKY_EL0)*uv.y*uv.y; return vec3(cos(el)*sin(az),sin(el),cos(el)*cos(az)); }
`;
  const SKY_LOOKUP = SKY_MAP + `uniform sampler2D uRSky; uniform float uRSkyOn;
vec3 rSkyCache(vec3 rd){
  float el=asin(clamp(rd.y,-1.,1.)), v=sqrt(clamp((el-RSKY_EL0)/(1.5707963-RSKY_EL0),0.,1.));
  return textureLod(uRSky,vec2(atan(rd.x,rd.z)/6.2831853+.5,v),0.).rgb;
}
`;

  // ---------------------------------------------------------------- course
  function buildTrack(keys) {
    const m = keys.length, dense = [];
    for (let k = 0; k < m; k++) {
      const p0 = keys[(k + m - 1) % m], p1 = keys[k], p2 = keys[(k + 1) % m], p3 = keys[(k + 2) % m];
      for (let i = 0; i < 64; i++) {
        const t = i / 64, t2 = t * t, t3 = t2 * t;
        dense.push([0, 1].map((c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3)));
      }
    }
    const cum = [0];
    for (let i = 1; i <= dense.length; i++) { const a = dense[i - 1], b = dense[i % dense.length]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    const len = cum[dense.length], n = Math.round(len / RACE.ds), ds = len / n;
    const T = { n, ds, len, x: new Float32Array(n), z: new Float32Array(n), tx: new Float32Array(n), tz: new Float32Array(n), k: new Float32Array(n) };
    for (let i = 0, j = 0; i < n; i++) {
      const s = i * ds; while (cum[j + 1] < s) j++;
      const a = dense[j], b = dense[(j + 1) % dense.length], f = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
      T.x[i] = a[0] + (b[0] - a[0]) * f; T.z[i] = a[1] + (b[1] - a[1]) * f;
    }
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n, b = (i + 1) % n, dx = T.x[b] - T.x[a], dz = T.z[b] - T.z[a], l = Math.hypot(dx, dz) || 1;
      T.tx[i] = dx / l; T.tz[i] = dz / l;
    }
    for (let i = 0; i < n; i++) {
      const a = (i + n - 2) % n, b = (i + 2) % n;
      T.k[i] = wrapA(Math.atan2(T.tx[b], T.tz[b]) - Math.atan2(T.tx[a], T.tz[a])) / (4 * ds);   // signed curvature, + = right turn
    }
    return T;
  }
  function nearest(T, px, pz, hint) {
    let best = 0, bd = 1e18;
    const scan = (k0, k1) => { for (let k = k0; k <= k1; k++) { const i = ((k % T.n) + T.n) % T.n, dx = T.x[i] - px, dz = T.z[i] - pz, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = i; } } };
    if (hint >= 0) scan(hint - 60, hint + 60);
    if (hint < 0 || bd > 150 * 150) { bd = 1e18; scan(0, T.n - 1); }
    return best;
  }
  // coast signed distance (m, > 0 on land) from the generator's CPU field
  function coastAt(x, z) {
    const N = CRES, d = world.coastCPU, u = (x - RECT[0]) / RECT[2] * N - 0.5, v = (z - RECT[1]) / RECT[2] * N - 0.5;
    const i = clamp(Math.floor(u), 0, N - 2), j = clamp(Math.floor(v), 0, N - 2), fu = clamp(u - i, 0, 1), fv = clamp(v - j, 0, 1);
    const a = d[j * N + i], b = d[j * N + i + 1], c = d[(j + 1) * N + i], e = d[(j + 1) * N + i + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + e * fu) * fv;
  }
  function buildGates(T) {
    const G = [];
    for (let k = 0; k < RACE.nGates; k++) {
      const ti = Math.round(k * T.n / RACE.nGates) % T.n, cx = T.x[ti], cz = T.z[ti], tx = T.tx[ti], tz = T.tz[ti], rx = tz, rz = -tx;
      const side = (sg) => { let w = RACE.gateHW; while (w > 12 && coastAt(cx + rx * w * sg, cz + rz * w * sg) > -14) w -= 2; return w; };
      const hl = side(-1), hr = side(1);
      G.push({ k, ti, cx, cz, tx, tz, rx, rz, hl, hr, buoys: [{ x: cx - rx * hl, z: cz - rz * hl, h: [0] }, { x: cx + rx * hr, z: cz + rz * hr, h: [0] }] });
    }
    return G;
  }

  // ---------------------------------------------------------------- meshes (local: x right, y up, z forward), smooth normals
  // vertex: position, normal, material id. Every surface is a parametric patch P(u, v); its normals come from P's
  // derivatives, oriented away from an interior point, so curved hulls shade smoothly and creases stay crisp.
  function MB() {
    const a = [], o = {
      a,
      patch(P, nu, nv, m, inside) {
        const N = (u, v) => {
          for (const k of [0, 0.01, 0.03]) {
            const uu = clamp(u, k, 1 - k), vv = clamp(v, k, 1 - k), e = 1e-3;
            const n = v3.cross(v3.sub(P(Math.min(uu + e, 1), vv), P(Math.max(uu - e, 0), vv)), v3.sub(P(uu, Math.min(vv + e, 1)), P(uu, Math.max(vv - e, 0))));
            const l = v3.len(n); if (l > 1e-10) return v3.mul(n, 1 / l);
          }
          return [0, 1, 0];
        };
        const sg = v3.dot(N(0.5, 0.5), v3.sub(P(0.5, 0.5), inside)) < 0 ? -1 : 1;
        const V = [];
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) V.push([P(i / nu, j / nv), v3.mul(N(i / nu, j / nv), sg)]);
        const put = (k) => { const [p, n] = V[k]; a.push(p[0], p[1], p[2], n[0], n[1], n[2], m); };
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
          const k = j * (nu + 1) + i;
          put(k); put(k + 1); put(k + nu + 2); put(k); put(k + nu + 2); put(k + nu + 1);
        }
        return o;
      },
      // superellipsoid (rounded box / capsule shapes): e = squareness (small = boxy)
      blob(c, r, e1, e2, m, nu = 24, nv = 14) {
        const sp = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
        return o.patch((u, v) => {
          const th = (v - 0.5) * Math.PI, ph = u * 2 * Math.PI, ct = sp(Math.cos(th), e1);
          return [c[0] + r[0] * ct * sp(Math.cos(ph), e2), c[1] + r[1] * sp(Math.sin(th), e1), c[2] + r[2] * ct * sp(Math.sin(ph), e2)];
        }, nu, nv, m, c);
      },
      // surface of revolution from a profile [[radius, y], ...] (bottom to top), one patch per band
      lathe(prof, m, seg = 28) {
        for (let k = 0; k + 1 < prof.length; k++) {
          const [r0, y0] = prof[k], [r1, y1] = prof[k + 1], mm = typeof m === 'function' ? m(k) : m;
          o.patch((u, v) => { const r = r0 + (r1 - r0) * v, t = u * 2 * Math.PI; return [r * Math.cos(t), y0 + (y1 - y0) * v, r * Math.sin(t)]; }, seg, 2, mm, [0, (y0 + y1) / 2, 0]);
        }
        return o;
      },
    };
    return o;
  }
  // materials: 0 topsides, 1 trim, 2 bottom, 3 deck, 4 rub rail, 5 glass, 6 engine, 7 pylon, 8 pylon band, 9 banner, 10 pole, 11 beam
  // A 9.4 m offshore V-bottom racer: fine entry, rising sheer, deep-vee bottom, bubble canopy, twin outboards, stern wing.
  function boatMesh() {
    const B = MB(), Z = (u) => -4.6 + 9.4 * u;
    const beam = (u) => 1.3 * (u < 0.36 ? 1 : Math.pow(Math.max(0, 1 - Math.pow((u - 0.36) / 0.64, 2.3)), 0.55));
    const sheer = (u) => 0.72 + 0.4 * Math.pow(u, 2.4);
    const chine = (u) => -0.14 + 0.62 * smoothstep(0.45, 1, u);
    const keel = (u) => -0.52 + 1.02 * Math.pow(smoothstep(0.5, 1, u), 1.35);
    const crown = 0.12, mid = (u) => [0, 0.2 + 0.2 * u, Z(u)];
    for (const s of [-1, 1]) {
      const inside = [0, 0.25, 0];
      B.patch((u, v) => [s * beam(u) * (1 - 0.04 * v), sheer(u) + (chine(u) - sheer(u)) * v, Z(u)], 56, 6, 0, inside);                                    // topsides
      B.patch((u, v) => [s * beam(u) * 0.96 * (1 - v), chine(u) - 0.02 + (keel(u) - chine(u) + 0.02) * v - 0.05 * Math.sin(Math.PI * v) * (1 - u), Z(u)], 56, 8, 2, inside);   // vee bottom
      B.patch((u, v) => [s * beam(u) * (1 - v), sheer(u) + crown * (1 - (1 - v) * (1 - v)), Z(u)], 56, 6, 3, [0, -1, 0]);                                // deck
      B.patch((u, v) => { const t = v * 2 * Math.PI, w = beam(Math.min(u, 0.985)); return [s * (w + 0.03 + 0.045 * Math.cos(t)), sheer(u) - 0.03 + 0.045 * Math.sin(t), Z(u)]; }, 56, 6, 4, [0, 0.2, 0]);   // rub rail
    }
    // transom
    const b0 = beam(0), top = (x) => sheer(0) + crown * (1 - (x / b0) ** 2), bot = (x) => Math.abs(x) < 0.96 * b0 ? keel(0) + (chine(0) - 0.02 - keel(0)) * Math.abs(x) / (0.96 * b0) : chine(0);
    B.patch((u, v) => { const x = (2 * u - 1) * b0 * 0.999; return [x, bot(x) + (top(x) - bot(x)) * v, Z(0)]; }, 24, 4, 0, [0, 0.2, 0]);
    // bubble canopy (teardrop dome), glass with a hull-coloured frame
    B.patch((u, v) => {
      const ph = u * 2 * Math.PI, th = v * Math.PI / 2, rh = Math.pow(Math.cos(th), 0.75), sp = Math.sin(ph);
      return [0.84 * Math.cos(ph) * rh, 0.8 + 0.62 * Math.pow(Math.sin(th), 0.85), -1.45 + (sp > 0 ? 1.75 : 1.05) * sp * rh];
    }, 40, 12, 5, [0, 0.6, -1.45]);
    // twin outboards: cowl, bracket, leg, cavitation plate, and a stern wing on two struts
    for (const x of [-0.56, 0.56]) {
      B.blob([x, 0.98, -5.12], [0.3, 0.46, 0.43], 0.32, 0.38, 6).blob([x, 0.42, -4.8], [0.17, 0.24, 0.22], 0.3, 0.3, 6);
      B.blob([x, 0.02, -5.02], [0.085, 0.62, 0.22], 0.5, 0.42, 6).blob([x, -0.32, -5.0], [0.2, 0.025, 0.3], 0.3, 0.4, 6, 18, 6);
      B.blob([x * 1.62, 1.2, -4.05], [0.035, 0.32, 0.12], 0.4, 0.4, 6, 12, 8);
    }
    B.blob([0, 1.53, -4.05], [1.18, 0.045, 0.3], 0.25, 0.3, 1, 28, 8);
    return new Float32Array(B.a);
  }
  // inflatable racing pylon: a fat base collar, a long cone, a white band
  const pylonMesh = (sc = 1) => new Float32Array(MB().lathe([[1.15, -0.8], [1.3, -0.1], [1.32, 0.15], [1.2, 0.45], [0.98, 0.75], [0.8, 2.1], [0.72, 2.75], [0.38, 3.9], [0.16, 4.4], [0.0, 4.55]].map(([r, y]) => [r, y * sc]), (k) => (k === 5 ? 8 : 7)).a);
  const beamMesh = () => new Float32Array(MB().lathe([[0.9, 0], [0.9, 70]], 11, 12).a);
  function bannerMesh(g) {   // start / finish: two poles and a chequered banner, in the gate's frame
    const B = MB();
    for (const x of [-g.hl, g.hr]) B.blob([x, 4.1, 0], [0.11, 4.6, 0.11], 1, 1, 10, 12, 4);
    B.patch((u, v) => [-g.hl + (g.hl + g.hr) * u, 6.6 + 1.8 * v + 0.12 * Math.sin(u * Math.PI), 0.15 * Math.sin(u * Math.PI)], 40, 2, 9, [0, 7.5, -10]);
    return new Float32Array(B.a);
  }

  // ---------------------------------------------------------------- GL
  // The object, wake and spray shaders are compiled on top of the scene shader (G.prefix = the render source without its
  // main), so they use its sun (SUN / SUNL), sky fill, sky reflections, terrain shadows (shadowH) and haze (fogApply):
  // the boats are lit by the same light as the cliffs and the sea. renderSample(..., P0, drawFn) sets all its uniforms.
  const VS_OBJ = `#version 300 es
layout(location=0) in vec3 aP; layout(location=1) in vec3 aN; layout(location=2) in float aM;
uniform mat4 uRVP, uRM; out vec3 vW, vN, vL; flat out float vM;
void main(){ vec4 w=uRM*vec4(aP,1.); vW=w.xyz; vN=mat3(uRM)*aN; vL=aP; vM=aM; gl_Position=uRVP*w; }`;
  const VS_SHADOW = `#version 300 es
layout(location=0) in vec3 aP;
uniform mat4 uRLVP, uRM;
void main(){ gl_Position=uRLVP*(uRM*vec4(aP,1.)); }`;
  const FS_SHADOW = `#version 300 es
precision highp float; void main(){}`;
  const RSHADOW = `
uniform sampler2D uRShad; uniform mat4 uRLVP;
float rShadow(vec3 p){   // boats / pylons shadow map, 3x3 PCF
  vec4 q=uRLVP*vec4(p,1.); vec3 s=q.xyz*.5+.5;
  if(s.x<0.||s.y<0.||s.x>1.||s.y>1.||s.z>1.) return 1.;
  vec2 ts=1.4/vec2(textureSize(uRShad,0)); float r=0.;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++) r+=step(s.z-.0006,texture(uRShad,s.xy+vec2(i,j)*ts).r);
  return r/9.;
}
float rH21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float rVn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(rH21(i),rH21(i+vec2(1,0)),f.x),mix(rH21(i+vec2(0,1)),rH21(i+vec2(1,1)),f.x),f.y); }
`;
  const FS_OBJ_MAIN = RSHADOW + `
uniform sampler2D uRDep; uniform vec3 uRC0, uRC1; uniform float uRGlow, uRBias, uRNum, uRWl;
in vec3 vW, vN, vL; flat in float vM;
float rSeg(vec2 p, vec2 a, vec2 b){ vec2 pa=p-a, ba=b-a; return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.)); }
float rDigit(vec2 p, int d){   // 7-segment digit, p in [-.5,.5] x [-1,1]: distance to the lit segments
  int m=d==0?63:d==1?6:d==2?91:d==3?79:d==4?102:d==5?109:d==6?125:d==7?7:d==8?127:111;
  float r=1e3;
  if((m&1)!=0) r=min(r,rSeg(p,vec2(-.38,.9),vec2(.38,.9)));
  if((m&2)!=0) r=min(r,rSeg(p,vec2(.4,.88),vec2(.4,.02)));
  if((m&4)!=0) r=min(r,rSeg(p,vec2(.4,-.02),vec2(.4,-.88)));
  if((m&8)!=0) r=min(r,rSeg(p,vec2(-.38,-.9),vec2(.38,-.9)));
  if((m&16)!=0) r=min(r,rSeg(p,vec2(-.4,-.02),vec2(-.4,-.88)));
  if((m&32)!=0) r=min(r,rSeg(p,vec2(-.4,.88),vec2(-.4,.02)));
  if((m&64)!=0) r=min(r,rSeg(p,vec2(-.38,0.),vec2(.38,0.)));
  return r;
}
float rGGX(vec3 N, vec3 V, vec3 L, float a){
  vec3 H=normalize(V+L); float nh=max(dot(N,H),0.), a2=a*a, dd=nh*nh*(a2-1.)+1.;
  float k=a*.5, nv=max(dot(N,V),1e-3), nl=max(dot(N,L),1e-3);
  return a2/(3.14159*dd*dd)*nv/(nv*(1.-k)+k)*nl/(nl*(1.-k)+k)/(4.*nv*nl);
}
void main(){
  float d=length(vW-uRo), gap=texelFetch(uRDep,ivec2(gl_FragCoord.xy),0).r-d;
  if(gap<-(uRBias+.003*d)) discard;   // behind the ray-marched water / land
  int m=int(vM+.5);
  vec3 V=normalize(uRo-vW), rd=-V, L=vL;
  if(m==11){ float k=clamp(L.y/70.,0.,1.); o=vec4(vec3(1.,.72,.22)*(1.-k)*(1.-k)*uRGlow*.25,0.); return; }
  vec3 N=normalize(vN); if(m==9&&dot(N,V)<0.) N=-N;
  vec3 alb=vec3(.8); float rough=.1, f0=.04, coat=1., metal=0.;
  if(m==0){   // topsides: hull colour, a trim stripe sweeping down aft, a pinstripe, the race number in a white roundel
    alb=uRC0; rough=.07;
    float sw=L.y-(.6-.06*L.z), band=smoothstep(.012,0.,abs(sw)-.075), pin=smoothstep(.01,0.,abs(sw+.14)-.014);
    alb=mix(alb,uRC1,band); alb=mix(alb,vec3(.86),pin*(1.-band));
    vec2 q=vec2((L.z-1.15)*sign(L.x),L.y-.3)/.27;
    float rr=length(q);
    if(rr<1.&&abs(L.x)>.3){
      alb=mix(alb,vec3(.86),smoothstep(1.,.96,rr));
      int n=int(uRNum+.5); float dg=n<10?rDigit(q/.52,n):min(rDigit(vec2(q.x+.31,q.y)/.52,n/10),rDigit(vec2(q.x-.31,q.y)/.52,n-n/10*10));
      alb=mix(alb,vec3(.02),smoothstep(.15,.11,dg)*step(rr,.95));
    }
  }
  else if(m==1){ alb=uRC1; rough=.07; }
  else if(m==2){ alb=uRC0*.35+.03; rough=.3; coat=.5; }
  else if(m==3){   // deck: white, hull-coloured foredeck behind a trim line, a grey non-skid panel aft
    alb=vec3(.82,.82,.8); rough=.09;
    float fd=smoothstep(1.35,1.4,L.z); alb=mix(alb,uRC0,fd); alb=mix(alb,uRC1,smoothstep(.03,0.,abs(L.z-1.33)-.03));
    if(L.z<-2.95&&L.z>-4.45&&abs(L.x)<.95){ alb=vec3(.2,.21,.22); rough=.6; coat=.2; }
  }
  else if(m==4){ alb=vec3(.025); rough=.25; }
  else if(m==5){   // canopy: smoked glass in a hull-coloured frame
    alb=vec3(.006,.008,.012); rough=.02; f0=.05;
    if(L.y<.9||abs(L.x)<.07&&L.z>-1.9){ alb=uRC0; rough=.07; f0=.04; }
  }
  else if(m==6){ alb=vec3(.018); rough=.09; if(abs(L.y-1.15)<.05) alb=uRC1; }
  else if(m==7){ alb=uRC0; rough=.38; coat=.35; }
  else if(m==8){ alb=vec3(.86); rough=.38; coat=.35; }
  else if(m==9){ alb=vec3(mod(floor((L.x+60.)*.9)+floor((L.y-6.6)*1.1),2.)*.84+.03); rough=.8; coat=0.; }
  else if(m==10){ alb=vec3(.75,.76,.78); rough=.22; metal=1.; }
  float ao=mix(.5,1.,smoothstep(-.5,.9,L.y))*(.75+.25*N.y*N.y);
  // waterline: wet and foamy just above the probed sea level (below it the ray-marched water hides the hull)
  float wl=m<9&&m!=5?smoothstep(.45,.0,vW.y-uRWl)*(.6+.4*smoothstep(.6,0.,gap)):0.;
  float fn=rVn(vW.xz*2.3+vec2(uTime*1.7,0.))*.6+rVn(vW.xz*7.-uTime*.9)*.4;
  alb*=1.-.35*wl;
  float sh=min(shadowH(vW+N*.3,uSun),rShadow(vW+N*.05));
  float ndl=max(dot(N,uSun),0.);
  vec3 F0=mix(vec3(f0),alb,metal), H=normalize(V+uSun);
  vec3 Fv=F0+(1.-F0)*pow(1.-max(dot(N,V),0.),5.), Fh=F0+(1.-F0)*pow(1.-max(dot(H,V),0.),5.);
  vec3 R=reflect(rd,N);
  vec3 env=R.y>.0?skyRefl(R,rough):mix(vec3(.012,.04,.065),skyRefl(normalize(vec3(R.x,.02,R.z)),rough),.3);   // below the horizon: the sea
  vec3 col=alb*(1.-metal)*(1.-Fv*coat)*(SUNL*ndl*sh+skyFill(N,0.)*3.2*ao)
          +coat*(Fv*env*mix(.6,1.,ao)+SUNL*rGGX(N,V,uSun,max(rough,.025))*Fh*ndl*sh);
  if(m==7||m==8) col+=alb*uRGlow*.6;
  vec3 foamC=(SUN*((max(dot(N,uSun),0.)+.35)/1.35)*sh+skyIrr(N)*1.05)*vec3(.585,.665,.765);
  col=mix(col,foamC,wl*smoothstep(.45,.75,fn)*.85);
  o=vec4(fogApply(col,uRo,rd,d),1.);
}`;
  const VS_WAKE = `#version 300 es
layout(location=0) in vec3 aP; layout(location=1) in vec4 aW; layout(location=2) in float aD;
uniform mat4 uRVP; out vec3 vW; out vec4 vA; out float vD;
void main(){ vW=aP; vA=aW; vD=aD; gl_Position=uRVP*vec4(aP,1.); }`;
  const FS_WAKE_MAIN = RSHADOW + `
uniform sampler2D uRDep;
in vec3 vW; in vec4 vA; in float vD;
void main(){
  float d=length(vW-uRo), gap=texelFetch(uRDep,ivec2(gl_FragCoord.xy),0).r-d;
  if(gap<-.5) discard;   // under a wave crest
  float x=vA.x*vA.w, age=vA.y, I=vA.z, w=vA.w;   // x: metres across the wake, w: its half width
  float n=rVn(vec2(x*.9,vD*.35)+3.7)*.5+rVn(vW.xz*.8+vec2(uTime*.15,0.))*.3+rVn(vW.xz*2.6)*.2;   // streaks along the wake + churn
  float n2=rVn(vec2(x*3.1,vD*1.4)+1.3)*.6+rVn(vW.xz*6.)*.4;
  float qa=(abs(x)-w*.76)/(.4+.06*w), qw=x/(1.3+5.*age), edge=smoothstep(1.,.86,abs(x)/w);   // nothing reaches the ribbon's border
  float arms=exp(-qa*qa)*smoothstep(.015,.1,age)*pow(1.-age,2.)*.65;   // the Kelvin arms separate from the wash behind the stern
  float wash=exp(-qw*qw)*pow(1.-age,1.5);
  float foam=clamp(arms*smoothstep(.42,.8,n)*(.6+.4*n2)+wash*smoothstep(.25+.45*age,.75,n)*(.6+.4*n2)*(1.-.4*age),0.,1.)*I*edge*smoothstep(-.5,.1,gap);   // white churn behind the stern breaking into streaks
  float aer=wash*.32*I*(1.-foam)*smoothstep(-.5,.1,gap);   // turquoise aerated water between the foam streaks
  float sh=rShadow(vW);
  vec3 foamC=(SUN*((max(uSun.y,0.)+.35)/1.35)*mix(.3,1.,sh)+skyIrr(vec3(0,1,0))*1.05)*vec3(.585,.665,.765);
  vec3 aerC=vec3(.05,.27,.3)*(SUN.g*max(uSun.y,0.)*.25*mix(.4,1.,sh)+.35);
  float a=foam+aer; if(a<.002) discard;
  vec3 c=(foamC*foam+aerC*aer)/a;
  o=vec4(fogApply(c,uRo,normalize(vW-uRo),d)*a,a);
}`;
  const VS_PART = `#version 300 es
layout(location=0) in vec3 aP; layout(location=1) in vec2 aS;
uniform mat4 uRVP; uniform vec3 uRCam; uniform float uRPix, uRPmax; out float vA; out vec3 vW;
void main(){ float d=length(aP-uRCam); vW=aP; vA=aS.y*smoothstep(3.,9.,d); gl_Position=uRVP*vec4(aP,1.); gl_PointSize=clamp(aS.x*uRPix/max(d,.5),1.,uRPmax); }`;
  const FS_PART_MAIN = RSHADOW + `
uniform sampler2D uRDep;
in float vA; in vec3 vW;
void main(){
  vec2 pc=gl_PointCoord*2.-1.; float r=dot(pc,pc); if(r>1.) discard;
  float d=length(vW-uRo), soft=clamp((texelFetch(uRDep,ivec2(gl_FragCoord.xy),0).r-d)/1.2,0.,1.);
  float a=vA*pow(1.-r,1.6)*soft*(.65+.35*rH21(gl_PointCoord*7.+vW.xz)); if(a<.002) discard;
  vec3 rd=normalize(vW-uRo); float mu=max(dot(rd,uSun),0.);
  vec3 c=SUN*(.3+1.6*pow(mu,8.))*mix(.35,1.,rShadow(vW))*vec3(.82,.87,.92)+skyIrr(vec3(0,1,0))*1.1;   // droplets: bright toward the sun
  o=vec4(fogApply(c,uRo,rd,d)*a,a);
}`;
  // the boats' shadows on the ray-marched scene (water, rocks): darken where the shadow map sees a hull
  const FS_WSHADOW = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uRDep; uniform vec3 uRCam; uniform mat3 uRB; uniform float uRTan; uniform vec2 uRRes, uRJit;
out vec4 o;` + RSHADOW + `
void main(){
  float t=texelFetch(uRDep,ivec2(gl_FragCoord.xy),0).r; if(t>300.) discard;
  vec2 uv=(2.*(gl_FragCoord.xy+uRJit)-uRRes)/uRRes.y; vec3 rd=normalize(uRB*vec3(uv*uRTan,1.));
  float s=rShadow(uRCam+rd*t); if(s>.995) discard;
  o=vec4(vec3(mix(.42,1.,s)),1.);
}`;
  const FS_COPY = `#version 300 es
precision highp float; uniform sampler2D uRSrc; out vec4 o;
void main(){ o=texelFetch(uRSrc,ivec2(gl_FragCoord.xy),0); }`;
  function progVF(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  function makeVAO(data, layout, usage = gl.STATIC_DRAW) {
    const va = gl.createVertexArray(); gl.bindVertexArray(va);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    const nf = layout.reduce((s, l) => s + l[1], 0); let off = 0;
    for (const [loc, k] of layout) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, k, gl.FLOAT, false, nf * 4, off); off += k * 4; }
    gl.bindVertexArray(vao);
    return { va, b, nf, count: data.length / nf };
  }
  // column-major view-projection matching the ray march's camera (rd = r*x*tan + u*y*tan + f), with its sub-pixel jitter
  function viewProj(cam, aspect, jit = [0, 0], near = 0.3, far = 9000) {
    const t = Math.tan(cam.vfov / 2), sx = 1 / (t * aspect), sy = 1 / t, A = (far + near) / (far - near), Bn = -2 * far * near / (far - near);
    const { r, u, f, pos: p } = cam, dr = v3.dot(r, p), du = v3.dot(u, p), df = v3.dot(f, p);
    const jx = -2 * jit[0] / R.w, jy = -2 * jit[1] / R.h;   // the ray of pixel c goes through c + jit
    const M = [sx * r[0], sy * u[0], A * f[0], f[0], sx * r[1], sy * u[1], A * f[1], f[1], sx * r[2], sy * u[2], A * f[2], f[2], -sx * dr, -sy * du, -A * df + Bn, -df];
    for (let c = 0; c < 4; c++) { M[c * 4] += jx * M[c * 4 + 3]; M[c * 4 + 1] += jy * M[c * 4 + 3]; }
    return new Float32Array(M);
  }
  // orthographic sun view around c (shadow map)
  function lightMat(c, E = 70, D = 160) {
    const f = v3.mul(sunDir, -1), r = v3.norm(v3.cross([0, 1, 0], f)), u = v3.cross(f, r);
    const row = (a, s) => [a[0] / s, a[1] / s, a[2] / s, -v3.dot(a, c) / s];
    const X = row(r, E), Y = row(u, E), Zr = row(f, D);
    return new Float32Array([X[0], Y[0], Zr[0], 0, X[1], Y[1], Zr[1], 0, X[2], Y[2], Zr[2], 0, X[3], Y[3], Zr[3], 1]);
  }
  const modelMat = (r, u, f, p) => new Float32Array([r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, f[0], f[1], f[2], 0, p[0], p[1], p[2], 1]);
  function boatBasis(b) {
    const sy = Math.sin(b.yaw), cy = Math.cos(b.yaw), cp = Math.cos(b.pitch), sp = Math.sin(b.pitch), cr = Math.cos(b.roll), sr = Math.sin(b.roll);
    const f0 = [sy, 0, cy], r0 = [cy, 0, -sy], u0 = [0, 1, 0];
    const f = v3.add(v3.mul(f0, cp), v3.mul(u0, sp)), u1 = v3.sub(v3.mul(u0, cp), v3.mul(f0, sp));
    const r = v3.sub(v3.mul(r0, cr), v3.mul(u1, sr)), u = v3.add(v3.mul(u1, cr), v3.mul(r0, sr));
    return { r, u, f };
  }

  // ---------------------------------------------------------------- wave probe: the water shader's oceanH() under hulls / pylons
  const PRB = { N: 64, seq: 0 };
  function probeInit(src) {
    try { PRB.p = prog(src.slice(0, src.lastIndexOf('void main(){')) + `uniform vec4 uPrb[${PRB.N}];\nvoid main(){ vec4 q=uPrb[int(gl_FragCoord.x)]; o=vec4(oceanH(q.xy,q.z),0.,0.,1.); }\n`); }
    catch (e) { console.warn('race: wave probe unavailable:', e.message); return; }
    PRB.t = tex(PRB.N, 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST); PRB.f = fbo(PRB.t);
    PRB.pbo = [0, 1, 2].map(() => { const b = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b); gl.bufferData(gl.PIXEL_PACK_BUFFER, PRB.N * 16, gl.STREAM_READ); return b; });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    PRB.slot = [0, 1, 2].map(() => null); PRB.buf = new Float32Array(PRB.N * 4); PRB.u = new Float32Array(PRB.N * 4);
  }
  function probeDraw(cam, time, pts, after) {
    const n = Math.min(pts.length, PRB.N);
    for (let i = 0; i < n; i++) { PRB.u[i * 4] = pts[i].x; PRB.u[i * 4 + 1] = pts[i].z; PRB.u[i * 4 + 2] = pts[i].pix || 1.5; }
    renderSample(cam, time, [0, 0], true, PRB.p, (P) => {
      gl.uniform4fv(P.u.uPrb, PRB.u);
      gl.bindFramebuffer(gl.FRAMEBUFFER, PRB.f); gl.viewport(0, 0, PRB.N, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
      after();
    });
    return n;
  }
  const probeApply = (pts, n) => { for (let i = 0; i < n; i++) { const h = PRB.buf[i * 4]; if (isFinite(h) && Math.abs(h) < 20) pts[i].o.h[pts[i].k] = h; } };
  function probeIssue(cam, time, pts) {   // async (PBO + fence): read back a frame or two later
    if (!PRB.p) return;
    const k = PRB.slot.findIndex((s) => !s); if (k < 0) return;
    const n = probeDraw(cam, time, pts, () => { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, PRB.pbo[k]); gl.readPixels(0, 0, PRB.N, 1, gl.RGBA, gl.FLOAT, 0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); });
    PRB.slot[k] = { fence: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), pts: pts.slice(0, n), seq: PRB.seq++ };
  }
  function probePoll() {
    if (!PRB.p) return;
    const ready = [];
    PRB.slot.forEach((s, k) => { if (s && gl.getSyncParameter(s.fence, gl.SYNC_STATUS) === gl.SIGNALED) ready.push(k); });
    ready.sort((a, b) => PRB.slot[a].seq - PRB.slot[b].seq);
    for (const k of ready) {
      const s = PRB.slot[k]; gl.deleteSync(s.fence); PRB.slot[k] = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, PRB.pbo[k]); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, PRB.buf); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      probeApply(s.pts, s.pts.length);
    }
  }
  function probeSync(cam, time, pts) {   // blocking (offline renders)
    if (!PRB.p) return;
    const n = probeDraw(cam, time, pts, () => gl.readPixels(0, 0, PRB.N, 1, gl.RGBA, gl.FLOAT, PRB.buf));
    probeApply(pts, n);
  }

  // ---------------------------------------------------------------- audio (synthesised)
  const AUD = { on: Q2('mute') !== '1' };
  function audioInit() {
    if (AUD.ctx || !AUD.on) return;
    try {
      const C = AUD.ctx = new (window.AudioContext || window.webkitAudioContext)();
      AUD.master = C.createGain(); AUD.master.gain.value = 0.7; AUD.master.connect(C.destination);
      AUD.lp = C.createBiquadFilter(); AUD.lp.type = 'lowpass'; AUD.lp.frequency.value = 400; AUD.lp.Q.value = 2;
      AUD.eg = C.createGain(); AUD.eg.gain.value = 0; AUD.lp.connect(AUD.eg); AUD.eg.connect(AUD.master);
      AUD.o1 = C.createOscillator(); AUD.o1.type = 'sawtooth'; AUD.o2 = C.createOscillator(); AUD.o2.type = 'square';
      AUD.o1.connect(AUD.lp); AUD.o2.connect(AUD.lp); AUD.o1.start(); AUD.o2.start();
      const nb = C.createBuffer(1, C.sampleRate * 2, C.sampleRate), d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      AUD.noise = nb;
      const ns = C.createBufferSource(); ns.buffer = nb; ns.loop = true;
      AUD.bp = C.createBiquadFilter(); AUD.bp.type = 'bandpass'; AUD.bp.frequency.value = 900; AUD.bp.Q.value = 0.6;
      AUD.wg = C.createGain(); AUD.wg.gain.value = 0; ns.connect(AUD.bp); AUD.bp.connect(AUD.wg); AUD.wg.connect(AUD.master); ns.start();
    } catch (e) { AUD.ctx = null; }
  }
  function audioEngine(v, thr, boost) {
    if (!AUD.ctx) return;
    const t = AUD.ctx.currentTime, f = 42 + v * 2.3 + Math.max(thr, 0) * 14 + boost * 18;
    AUD.o1.frequency.setTargetAtTime(f, t, 0.06); AUD.o2.frequency.setTargetAtTime(f * 0.501, t, 0.06);
    AUD.lp.frequency.setTargetAtTime(260 + Math.max(thr, 0) * 900 + v * 18 + boost * 600, t, 0.08);
    AUD.eg.gain.setTargetAtTime(0.035 + 0.06 * Math.max(thr, 0) + 0.03 * boost, t, 0.08);
    AUD.wg.gain.setTargetAtTime(Math.min(0.22, v / 170), t, 0.1);
  }
  function beep(f, dur = 0.18, vol = 0.18) {
    if (!AUD.ctx) return;
    const C = AUD.ctx, o = C.createOscillator(), g = C.createGain(), t = C.currentTime;
    o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(AUD.master); o.start(t); o.stop(t + dur + 0.02);
  }
  function thud(vol) {
    if (!AUD.ctx) return;
    const C = AUD.ctx, s = C.createBufferSource(), f = C.createBiquadFilter(), g = C.createGain(), t = C.currentTime;
    s.buffer = AUD.noise; f.type = 'lowpass'; f.frequency.value = 500; g.gain.setValueAtTime(Math.min(0.6, vol), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    s.connect(f); f.connect(g); g.connect(AUD.master); s.start(t); s.stop(t + 0.55);
  }
  function setMute(m) { AUD.on = !m; if (AUD.master) AUD.master.gain.value = m ? 0 : 0.7; if (!m) audioInit(); }

  // ---------------------------------------------------------------- state
  let T, GATES, BOATS, S, ui, G = {};
  function makeBoat(i) {
    return { i, crew: CREW[i], ai: i > 0, skill: AI_SKILL[i] * (i > 0 ? RACE.skill : 1), x: 0, z: 0, yaw: 0, vx: 0, vz: 0, yawRate: 0, steer: 0, thr: 0,
      boost: 1, boosting: false, y: 0, vy: 0, pitch: 0, vp: 0, roll: 0, vr: 0, h: [0, 0, 0], ti: -1, lap: 1, next: 1, gates: 0, lapStart: 0,
      laps: [], finish: null, wake: [], odo: 0, lane: 0, laneT: 0, stuck: 0, wrong: 0, missed: false, hit: 0, power: 1, emit: 0 };
  }
  function placeOnGrid(b, slot) {
    const ti = (Math.round((slot < 2 ? 22 : 8) / T.ds)) % T.n, side = slot % 2 ? 1 : -1;
    const tx = T.tx[ti], tz = T.tz[ti];
    b.x = T.x[ti] + tz * 8 * side; b.z = T.z[ti] - tx * 8 * side; b.yaw = Math.atan2(tx, tz); b.ti = ti;
    b.vx = b.vz = b.yawRate = b.steer = 0; b.wake.length = 0; b.px = b.x; b.pz = b.z;
  }
  function resetRace() {
    BOATS = CREW.map((c, i) => makeBoat(i));
    [2, 1, 3, 0].forEach((slot, i) => placeOnGrid(BOATS[i], slot));   // the player starts at the back
    S = { phase: 'title', t: 0, raceT: 0, cd: 0, paused: false, msg: '', msgT: 0, finishT: null, camMode: S ? S.camMode : 0, beeped: -1 };
    G.parts = [];
    for (const g of GATES) for (const bu of g.buoys) bu.h[0] = 0;
  }

  // ---------------------------------------------------------------- simulation
  function progress(b) {
    if (b.finish != null) return 1e9 - b.finish;
    const gap = T.len / RACE.nGates, last = GATES[(b.next + RACE.nGates - 1) % RACE.nGates];
    const along = ((b.ti - last.ti + T.n) % T.n) * T.ds;
    return b.gates * gap + Math.min(along < T.len / 2 ? along : 0, gap);
  }
  function standings() { return BOATS.slice().sort((a, b) => progress(b) - progress(a)); }
  function passGate(b) {
    const g = GATES[b.next];
    b.gates++; b.missed = false;
    if (b.next === 0) {
      b.laps.push(S.raceT - b.lapStart); b.lapStart = S.raceT; b.lap++;
      if (b.lap > RACE.laps && b.finish == null) {
        b.finish = S.raceT;
        if (!b.ai) { S.phase = 'done'; S.finishT = S.t; beep(988, 0.5, 0.2); }
      } else if (!b.ai) { flash(b.lap === RACE.laps ? '最後一圈!  FINAL LAP' : `第 ${b.lap} 圈  LAP ${b.lap}`); beep(880, 0.25); }
    } else if (!b.ai) beep(1320, 0.07, 0.08);
    b.next = (b.next + 1) % RACE.nGates;
    return g;
  }
  function checkGates(b) {
    const g = GATES[b.next], d0 = (b.px - g.cx) * g.tx + (b.pz - g.cz) * g.tz, d1 = (b.x - g.cx) * g.tx + (b.z - g.cz) * g.tz;
    const lat = (b.x - g.cx) * g.rx + (b.z - g.cz) * g.rz;
    if (d0 < 0 && d1 >= 0 && lat > -g.hl - 6 && lat < g.hr + 6) { passGate(b); return; }
    const ahead = ((b.ti - g.ti + T.n) % T.n) * T.ds;
    if (ahead > 0 && ahead < T.len / 2) {
      if (b.ai && ahead < 90) passGate(b);
      else if (!b.ai && ahead > 45 && !b.missed) { b.missed = true; flash('錯過檢查點!  MISSED GATE — 按 R 返回'); beep(220, 0.3); }
    }
  }
  function aiInput(b) {
    const v = b.vx * Math.sin(b.yaw) + b.vz * Math.cos(b.yaw);
    if (S.t > b.laneT) { b.laneT = S.t + 3 + Math.random() * 4; b.lane = (Math.random() * 2 - 1) * 9; }
    let off = b.lane;
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    for (const o of BOATS) {
      if (o === b) continue;
      const dx = o.x - b.x, dz = o.z - b.z, ah = dx * fx + dz * fz, lt = dx * fz - dz * fx;
      if (ah > -4 && ah < 35 && Math.abs(lt) < 7) off += (lt > 0 ? -1 : 1) * (7 - Math.abs(lt)) * 1.4;
    }
    off = clamp(off, -14, 14);
    const look = 16 + Math.max(v, 0) * 0.7, k = (b.ti + Math.round(look / T.ds)) % T.n;
    const tx = T.x[k] + T.tz[k] * off, tz = T.z[k] - T.tx[k] * off;
    const err = wrapA(Math.atan2(tx - b.x, tz - b.z) - b.yaw);
    let km = 0; const span = Math.round((40 + Math.max(v, 0) * 2.4) / T.ds);
    for (let j = 0; j < span; j += 3) km = Math.max(km, Math.abs(T.k[(b.ti + j) % T.n]));
    const kk = Math.max(km, 1e-4), vc = (-kk + Math.sqrt(kk * kk + 4 * (kk / 45) * 0.9 * BOAT.turn)) / (2 * kk / 45);
    const vmax = Math.sqrt((BOAT.acc * b.power - BOAT.lin * 40) / BOAT.drag);
    const vt = Math.min(vmax, vc);
    return { steer: clamp(err * 2.6 - b.yawRate * 0.3, -1, 1), thr: clamp((vt - v) * 0.4 + 0.2, -1, 1), boost: km < 0.004 && b.boost > 0.35 && v > 20 && (b.i * 7 + Math.floor(S.t / 5)) % 3 === 0 };
  }
  function driveBoat(b, inp, dt) {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), rx = fz, rz = -fx;
    let vf = b.vx * fx + b.vz * fz, vl = b.vx * rx + b.vz * rz;
    b.steer += clamp(inp.steer - b.steer, -dt * 4.5, dt * 4.5);
    b.thr = inp.thr;
    b.boosting = !!inp.boost && b.boost > 0.01 && vf > 5 && inp.thr > 0;
    b.boost = b.boosting ? Math.max(0, b.boost - dt / 3.2) : Math.min(1, b.boost + dt / 15);
    let a = inp.thr >= 0 ? inp.thr * BOAT.acc * b.power * (b.boosting ? 1.6 : 1) : vf > 1 ? inp.thr * 14 : inp.thr * 5;
    a -= BOAT.drag * vf * Math.abs(vf) + BOAT.lin * vf + Math.abs(b.yawRate) * vf * 0.22;
    vf += a * dt;
    if (inp.thr < 0) vf = Math.max(vf, -8);
    vl *= Math.exp(-BOAT.grip * dt);
    const sp = Math.abs(vf), turn = BOAT.turn * Math.min(1, sp / 9) / (1 + sp / 45);
    b.yawRate += (b.steer * turn * (vf < -0.5 ? -1 : 1) - b.yawRate) * Math.min(1, dt * 6);
    b.yaw = wrapA(b.yaw + b.yawRate * dt);
    b.vx = fx * vf + rx * vl; b.vz = fz * vf + rz * vl;
    b.px = b.x; b.pz = b.z;
    b.x += b.vx * dt; b.z += b.vz * dt;
    // the shore: push out along the coast-distance gradient, bounce, lose speed
    const R0 = 5.5, pen = coastAt(b.x, b.z) + R0;
    if (pen > 0) {
      const e = 1.5, gx = coastAt(b.x + e, b.z) - coastAt(b.x - e, b.z), gz = coastAt(b.x, b.z + e) - coastAt(b.x, b.z - e), gl_ = Math.hypot(gx, gz) || 1;
      const nx = gx / gl_, nz = gz / gl_, vn = b.vx * nx + b.vz * nz;
      b.x -= nx * pen; b.z -= nz * pen;
      if (vn > 0) { b.vx -= nx * vn * 1.35; b.vz -= nz * vn * 1.35; b.vx *= 0.8; b.vz *= 0.8; impact(b, vn); }
    }
    // the world's edge (the terrain domain)
    const lim = [RECT[0] + 150, RECT[1] + 150, RECT[0] + RECT[2] - 150, RECT[1] + RECT[2] - 150];
    if (b.x < lim[0]) { b.x = lim[0]; b.vx = Math.abs(b.vx) * 0.3; } if (b.z < lim[1]) { b.z = lim[1]; b.vz = Math.abs(b.vz) * 0.3; }
    if (b.x > lim[2]) { b.x = lim[2]; b.vx = -Math.abs(b.vx) * 0.3; } if (b.z > lim[3]) { b.z = lim[3]; b.vz = -Math.abs(b.vz) * 0.3; }
  }
  function impact(b, v) {
    if (v < 2) return;
    b.hit = Math.max(b.hit, Math.min(1, v / 15));
    for (let i = 0; i < Math.min(160, v * 10); i++) spawn(b.x + (Math.random() - 0.5) * 4, b.y + 0.3, b.z + (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 8, 3 + Math.random() * 8, (Math.random() - 0.5) * 8, 0.8 + Math.random() * 0.7, 0.15 + Math.random() * 0.5, 0.5);
    if (!b.ai) thud(v / 15); else if (Math.hypot(b.x - G.cam.pos[0], b.z - G.cam.pos[2]) < 60) thud(v / 40);
  }
  function collideBoats() {
    const C = (b, s) => [b.x + Math.sin(b.yaw) * 2.3 * s, b.z + Math.cos(b.yaw) * 2.3 * s];
    for (let i = 0; i < BOATS.length; i++) for (let j = i + 1; j < BOATS.length; j++) {
      const a = BOATS[i], b = BOATS[j];
      if (Math.abs(a.x - b.x) > 12 || Math.abs(a.z - b.z) > 12) continue;
      for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
        const pa = C(a, sa), pb = C(b, sb), dx = pb[0] - pa[0], dz = pb[1] - pa[1], d = Math.hypot(dx, dz), m = 3.4;
        if (d >= m || d < 1e-4) continue;
        const nx = dx / d, nz = dz / d, push = (m - d) / 2;
        a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
        const vr = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
        if (vr < 0) {
          const J = -1.4 * vr / 2;
          a.vx -= nx * J; a.vz -= nz * J; b.vx += nx * J; b.vz += nz * J;
          a.yawRate += (Math.random() - 0.5) * J * 0.06; b.yawRate += (Math.random() - 0.5) * J * 0.06;
          if (-vr > 3) { impact(a, -vr * 0.6); impact(b, -vr * 0.6); }
        }
      }
    }
  }
  // hull height / pitch / roll: springs toward the probed wave surface (bow, port and starboard quarters)
  function rideWaves(b, dt) {
    const vf = b.vx * Math.sin(b.yaw) + b.vz * Math.cos(b.yaw), sp = Math.abs(vf);
    const hm = (b.h[0] + b.h[1] + b.h[2]) / 3, plane = 0.12 * smoothstep(8, 26, sp);
    const ty = hm + plane;
    const k = b.y > ty ? 90 : 170;   // a 9 m planing hull stays on the surface: brief air off the crests, no long flights
    b.vy += (k * (ty - b.y) - 1.8 * Math.sqrt(k) * b.vy - 260 * Math.max(0, b.y - ty - 0.25)) * dt; b.y += b.vy * dt;   // air above ~25 cm is pulled down hard
    const tp = Math.atan2(b.h[0] - (b.h[1] + b.h[2]) / 2, 7) + 0.06 * smoothstep(3, 14, sp) * (1 - 0.65 * smoothstep(18, 45, sp)) + b.thr * 0.015 + (b.y - ty) * 0.03;
    const tr = -Math.atan2(b.h[2] - b.h[1], 2.8) * 0.8 + clamp(b.yawRate * sp * 0.011, -0.32, 0.32);
    b.vp += (90 * (tp - b.pitch) - 15 * b.vp) * dt; b.pitch += b.vp * dt;
    b.vr += (70 * (tr - b.roll) - 13 * b.vr) * dt; b.roll += b.vr * dt;
  }
  function spawn(x, y, z, vx, vy, vz, life, size, a = 0.45) { if (G.parts.length < 3000) G.parts.push({ x, y, z, vx, vy, vz, t: 0, life, size, a, y0: y - 0.8 }); }
  function emitSpray(b, dt) {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), rx = fz, rz = -fx, sp = Math.hypot(b.vx, b.vz);
    const R2 = Math.random, hm = (b.h[0] + b.h[1] + b.h[2]) / 3;
    // rooster tail: thrown up and back from each propeller (a few mist puffs in it)
    b.emit += (150 * smoothstep(8, 35, sp) * (b.boosting ? 1.4 : 1) + 60 * smoothstep(1.5, 4, Math.abs(b.vy))) * dt;
    for (; b.emit >= 1; b.emit--) {
      const ox = (R2() < 0.5 ? -0.56 : 0.56) + (R2() - 0.5) * 0.2, mist = R2() < 0.15, up = 3 + R2() * 7 * smoothstep(10, 45, sp);
      spawn(b.x - fx * 5.25 + rx * ox, b.y - 0.25, b.z - fz * 5.25 + rz * ox,
        b.vx * 0.72 - fx * (1 + R2() * 3) + (R2() - 0.5) * 2 * rx, up, b.vz * 0.72 - fz * (1 + R2() * 3) + (R2() - 0.5) * 2 * rz,
        mist ? 1 + R2() * 0.7 : 0.45 + R2() * 0.6, mist ? 0.9 + R2() * 1.2 : 0.1 + R2() * 0.25, mist ? 0.1 : 0.55);
    }
    // spray curtains peeling off both chines where the planing hull meets the water, heavier on the outside of a turn
    b.emitC = (b.emitC || 0) + 420 * smoothstep(10, 35, sp) * dt;
    for (; b.emitC >= 1; b.emitC--) {
      const sd = R2() < 0.5 + clamp(b.yawRate, -0.4, 0.4) * -1.1 ? 1 : -1, al = -1.8 + R2() * 4, out = 2.5 + R2() * 4.5;
      spawn(b.x + fx * al + rx * sd * 1.35, hm + 0.05, b.z + fz * al + rz * sd * 1.35,
        b.vx * 0.85 + rx * sd * out - fx * (1 + R2() * 2), 1.5 + R2() * 4, b.vz * 0.85 + rz * sd * out - fz * (1 + R2() * 2),
        0.35 + R2() * 0.5, 0.15 + R2() * 0.4, 0.6);
    }
    // wake: a ribbon of stern positions
    const W = b.wake, last = W[0], wx = b.x - fx * 4.6, wz = b.z - fz * 4.6;
    b.odo += sp * dt;
    if (!last || Math.hypot(wx - last.x, wz - last.z) > 1.6) W.unshift({ x: wx, z: wz, y: (b.h[0] + b.h[1] + b.h[2]) / 3 + 0.08, rx, rz, t: S.t, v: sp, d: b.odo });
    while (W.length && S.t - W[W.length - 1].t > 6) W.pop();
    if (W.length > 200) W.length = 200;
  }
  function updateParts(dt) {
    const P = G.parts;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i]; p.t += dt; p.vy -= 9.81 * dt; const dr = Math.exp(-0.9 * dt); p.vx *= dr; p.vz *= dr;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.t > p.life || p.y < p.y0) { P[i] = P[P.length - 1]; P.pop(); }
    }
  }
  function respawn(b) {
    const g = GATES[(b.next + RACE.nGates - 1) % RACE.nGates];
    b.x = g.cx - g.tx * 6; b.z = g.cz - g.tz * 6; b.yaw = Math.atan2(g.tx, g.tz); b.vx = b.vz = b.yawRate = 0; b.ti = g.ti; b.px = b.x; b.pz = b.z;
    b.wake.length = 0; b.missed = false; b.stuck = 0;
  }
  function step(dt, inputP) {
    S.t += dt; S.msgT -= dt;
    const racing = S.phase === 'race' || S.phase === 'done';
    if (S.phase === 'countdown') {
      S.cd -= dt;
      const n = Math.ceil(S.cd);
      if (n !== S.beeped && n >= 1 && n <= 3) { S.beeped = n; beep(440, 0.2); flash(String(n), 0.9); }
      if (S.cd <= 0) { S.phase = 'race'; S.raceT = 0; beep(880, 0.45); flash('出發!  GO!', 1.2); for (const b of BOATS) b.lapStart = 0; }
    }
    if (racing) S.raceT += dt;
    for (const b of BOATS) {
      let inp = { steer: 0, thr: 0, boost: false };
      if (racing) {
        if (b.ai || G.autopilot || b.finish != null) { inp = aiInput(b); if (b.finish != null) { inp.thr = Math.min(inp.thr, 0.45); inp.boost = false; } }
        else inp = inputP;
      }
      driveBoat(b, inp, dt);
      b.ti = nearest(T, b.x, b.z, b.ti);
      if (racing && b.finish == null) checkGates(b);
      // stuck AI (pinned on a rock or a rival): put it back on the course
      if (racing && (b.ai || G.autopilot) && Math.hypot(b.vx, b.vz) < 2) { b.stuck += dt; if (b.stuck > 3) respawn(b); } else b.stuck = 0;
      if (!b.ai) {
        const v = b.vx * T.tx[b.ti] + b.vz * T.tz[b.ti];
        b.wrong = racing && v < -3 ? b.wrong + dt : 0;
      }
      b.hit = Math.max(0, b.hit - dt * 2);
      rideWaves(b, dt);
    }
    collideBoats();
    // rubber band: a little help for the back markers, a little drag for runaway leaders
    if (racing) {
      const pp = progress(BOATS[0]);
      for (const b of BOATS) if (b.ai) b.power = b.skill * (1 + clamp((pp - progress(b)) / 900, -0.05, 0.07));
    }
    if (S.phase === 'done' && S.t - S.finishT > 1.5) {   // the table fills in as the rivals cross the line
      const key = BOATS.map((b) => b.finish).join();
      if (S.shown !== key) { S.shown = key; showResults(); }
    }
  }

  // ---------------------------------------------------------------- camera
  function chaseCam(dt) {
    const P = BOATS[0], cam = G.cam, sp = Math.hypot(P.vx, P.vz);
    G.cyaw += wrapA(P.yaw - G.cyaw) * damp(3.5, dt);
    const fx = Math.sin(G.cyaw), fz = Math.cos(G.cyaw);
    let pos, look, roll = 0;
    if (S.camMode === 2) {   // bow cam above the canopy
      const B = boatBasis(P);
      pos = v3.add([P.x, P.y, P.z], v3.add(v3.mul(B.u, 1.9), v3.mul(B.f, -0.4)));
      look = v3.add(pos, v3.add(B.f, v3.mul(B.u, -0.04)));
      roll = P.roll * 0.9;
      cam.pos = pos;
    } else if (S.camMode === 3) {   // TV camera: a helicopter pacing the boat off its quarter
      const rx = Math.cos(G.cyaw), rz = -Math.sin(G.cyaw);
      pos = [P.x + rx * 15 - fx * 7, P.y + 7.5, P.z + rz * 15 - fz * 7];
      cam.pos = v3.mix(cam.pos, pos, damp(6, dt));
      look = [P.x + fx * 2.5, P.y + 0.6, P.z + fz * 2.5];
    } else {
      const dist = S.camMode ? 24 : 12.5, hgt = S.camMode ? 8.5 : 3.9;
      pos = [P.x - fx * dist, P.y + hgt, P.z - fz * dist];
      cam.pos = v3.mix(cam.pos, pos, damp(9, dt));
      cam.pos[1] += (pos[1] - cam.pos[1]) * damp(4, dt);
      look = [P.x + fx * 20, P.y + 1.4, P.z + fz * 20];
      roll = P.roll * 0.25;
    }
    // stay above the waves and the land
    cam.pos[1] = Math.max(cam.pos[1], G.camW.h[0] + 1.3);
    if (coastAt(cam.pos[0], cam.pos[2]) > -3) cam.pos[1] = Math.max(cam.pos[1], groundAt(cam.pos[0], cam.pos[2]) + 3);
    const sh = P.hit * 0.25 + 0.012 * smoothstep(25, 50, sp);
    const p = v3.add(cam.pos, [Math.sin(S.t * 41) * sh, Math.sin(S.t * 37 + 1) * sh, Math.sin(S.t * 29 + 2) * sh]);
    const fov = 58 + 10 * smoothstep(10, 50, sp) + (P.boosting ? 6 : 0);
    G.fov += (fov - G.fov) * damp(3, dt);
    return lookCam(p, look, roll, G.fov);
  }
  function lookCam(pos, look, roll, fovDeg) {
    let f = v3.norm(v3.sub(look, pos)), r = v3.norm(v3.cross([0, 1, 0], f)), u = v3.cross(f, r);
    if (roll) { const c = Math.cos(roll), s = Math.sin(roll); const r2 = v3.sub(v3.mul(r, c), v3.mul(u, s)); u = v3.add(v3.mul(u, c), v3.mul(r, s)); r = r2; }
    return { pos, r, u, f, mat: basisMatrix(r, u, f), vfov: fovDeg * DEG };
  }
  function orbitCam(cx, cz, rad, h, ang, ly) { return lookCam([cx + Math.sin(ang) * rad, h, cz + Math.cos(ang) * rad], [cx, ly, cz], 0, 55); }
  function titleCam() {   // hovering ahead of the grid, looking back at the boats under the start banner, drifting side to side
    const g = GATES[0], s = Math.sin(S.t * 0.15), d = 46 + 6 * Math.sin(S.t * 0.11);
    return lookCam([g.cx + g.tx * d + g.rx * 22 * s, 7.5 + 1.5 * Math.sin(S.t * 0.13), g.cz + g.tz * d + g.rz * 22 * s], [g.cx + g.tx * 10, 1.5, g.cz + g.tz * 10], 0, 50);
  }
  function frameCam(dt) {
    const P = BOATS[0];
    if (S.phase === 'title') return titleCam();
    if (S.phase === 'done') return orbitCam(P.x, P.z, 22, P.y + 5, S.t * 0.25, P.y + 1);
    const ch = chaseCam(dt);
    if (S.phase === 'countdown' && S.cd > 0.6) {   // swing from the orbit into the chase position
      const k = smoothstep(3.2, 0.8, S.cd), o = titleCam();
      return lookCam(v3.mix(o.pos, ch.pos, k), v3.add(v3.mix(o.pos, ch.pos, k), v3.norm(v3.mix(o.f, ch.f, k))), 0, 50 + (G.fov - 50) * k);
    }
    return ch;
  }

  // ---------------------------------------------------------------- sky cache
  // The scene's own skyView() rendered into a 2048 x 512 HDR panorama; real-time frames look the sky up there instead
  // of ray marching the cumulus for every sky pixel. One of 128 vertical strips is refreshed per frame (the clouds drift
  // a few m/s at 1+ km: a strip-per-frame refresh is invisible). Photo mode and shoot() use the exact skyView().
  function skyInit() {
    if (Q2('racelite') === '1') return;
    const pre = G.src.slice(0, G.src.lastIndexOf('void main(){'));
    try { G.pSky = prog(pre + `void main(){ o=vec4(skyView(rSkyDir(gl_FragCoord.xy/vec2(${SKY_W}.,${SKY_H}.))),1.); }\n`); }
    catch (e) { console.warn('race: sky cache unavailable:', e.message); return; }
    G.skyTex = tex(SKY_W, SKY_H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR, null, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    G.skyFb = fbo(G.skyTex); G.skyN = 0;
  }
  const skyReady = () => G.pSky && G.skyN >= SKY_SLICES;
  function skyCacheUpdate(cam, time, slices) {
    if (!G.pSky) return;
    const w = SKY_W / SKY_SLICES;
    renderSample(cam, time, [0, 0], true, G.pSky, () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, G.skyFb); gl.viewport(0, 0, SKY_W, SKY_H); gl.enable(gl.SCISSOR_TEST);
      for (let k = 0; k < slices; k++, G.skyN++) { gl.scissor((G.skyN % SKY_SLICES) * w, 0, w, SKY_H); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      gl.disable(gl.SCISSOR_TEST);
    });
  }

  // ---------------------------------------------------------------- drawing
  function initGL() {
    const pre = G.src.slice(0, G.src.lastIndexOf('void main(){'));
    G.pObj = progVF(VS_OBJ, pre + FS_OBJ_MAIN); G.pWake = progVF(VS_WAKE, pre + FS_WAKE_MAIN); G.pPart = progVF(VS_PART, pre + FS_PART_MAIN);
    G.pSh = progVF(VS_SHADOW, FS_SHADOW); G.pWSh = prog(FS_WSHADOW); G.pCopy = prog(FS_COPY);
    const L = [[0, 3], [1, 3], [2, 1]];
    G.mBoat = makeVAO(boatMesh(), L); G.mPylon = makeVAO(pylonMesh(), L); G.mPylon0 = makeVAO(pylonMesh(1.5), L); G.mBeam = makeVAO(beamMesh(), L);
    G.mBanner = makeVAO(bannerMesh(GATES[0]), L);
    G.wakeBuf = new Float32Array(200 * 2 * 8); G.mWake = BOATS.map(() => makeVAO(G.wakeBuf, [[0, 3], [1, 4], [2, 1]], gl.DYNAMIC_DRAW));
    G.partBuf = new Float32Array(3000 * 5); G.mPart = makeVAO(G.partBuf, [[0, 3], [1, 2]], gl.DYNAMIC_DRAW);
    G.pmax = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    const SM = 2048;
    G.shTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, G.shTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SM, SM, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    G.shFb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, G.shFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, G.shTex, 0); gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    G.SM = SM;
  }
  function ensureTarget() {
    if (G.tR === R) return;
    G.tR = R;
    if (G.rb) { gl.deleteRenderbuffer(G.rb); gl.deleteFramebuffer(G.fb); gl.deleteTexture(G.A); gl.deleteFramebuffer(G.Af); }
    G.rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, G.rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, R.w, R.h);
    G.fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, G.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, R.acc, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, G.rb);
    G.A = tex(R.w, R.h, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST); G.Af = fbo(G.A); G.An = 0;   // multi-sample accumulation
  }
  // everything drawn with the scene's shading: the opaque list is reused by the shadow-map pass
  function objectList() {
    const L = [], nextG = S.phase === 'race' || S.phase === 'countdown' ? BOATS[0].next : -1, pulse = 0.5 + 0.5 * Math.sin(S.t * 6);
    for (const b of BOATS) { const B = boatBasis(b); L.push({ m: G.mBoat, M: modelMat(B.r, B.u, B.f, [b.x, b.y, b.z]), c0: b.crew.hull, c1: b.crew.trim, num: b.crew.num, glow: 0, wl: (b.h[0] + b.h[1] + b.h[2]) / 3 }); }
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (const g of GATES) for (const bu of g.buoys) L.push({ m: g.k ? G.mPylon : G.mPylon0, M: modelMat(...I, [bu.x, bu.h[0], bu.z]), c0: g.k ? [.9, .2, .02] : [.8, .8, .78], glow: g.k === nextG ? 0.3 + 0.7 * pulse : 0, wl: bu.h[0] });
    const g0 = GATES[0];
    L.push({ m: G.mBanner, M: modelMat([g0.rx, 0, g0.rz], [0, 1, 0], [g0.tx, 0, g0.tz], [g0.cx, (g0.buoys[0].h[0] + g0.buoys[1].h[0]) / 2, g0.cz]), glow: 0 });
    return { L, nextG, pulse };
  }
  function drawObjects(cam, time, jit) {
    ensureTarget();
    const VP = viewProj(cam, R.w / R.h, jit), P0 = BOATS[0];
    const c = S.phase === 'title' ? [GATES[0].cx, 0, GATES[0].cz] : [P0.x + Math.sin(P0.yaw) * 25, 0, P0.z + Math.cos(P0.yaw) * 25];
    const LVP = lightMat(c), { L, nextG, pulse } = objectList();
    // 1. sun shadow map of the boats and pylons
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.shFb); gl.viewport(0, 0, G.SM, G.SM); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.useProgram(G.pSh.p); gl.uniformMatrix4fv(G.pSh.u.uRLVP, false, LVP);
    for (const o of L) { gl.uniformMatrix4fv(G.pSh.u.uRM, false, o.M); gl.bindVertexArray(o.m.va); gl.drawArrays(gl.TRIANGLES, 0, o.m.count); }
    // 2. their shadows on the ray-marched water and rocks
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.fb); gl.viewport(0, 0, R.w, R.h); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ZERO, gl.SRC_COLOR, gl.ZERO, gl.ONE);
    const W = G.pWSh; gl.useProgram(W.p); gl.bindVertexArray(vao);
    bindTex(14, R.dep); gl.uniform1i(W.u.uRDep, 14); bindTex(15, G.shTex); gl.uniform1i(W.u.uRShad, 15); gl.uniformMatrix4fv(W.u.uRLVP, false, LVP);
    gl.uniform3fv(W.u.uRCam, cam.pos); gl.uniformMatrix3fv(W.u.uRB, false, cam.mat); gl.uniform1f(W.u.uRTan, Math.tan(cam.vfov / 2));
    gl.uniform2f(W.u.uRRes, R.w, R.h); gl.uniform2f(W.u.uRJit, jit[0], jit[1]); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    const common = (U) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, G.fb); gl.viewport(0, 0, R.w, R.h);
      gl.uniformMatrix4fv(U.uRVP, false, VP); gl.uniformMatrix4fv(U.uRLVP, false, LVP);
      bindTex(14, R.dep); gl.uniform1i(U.uRDep, 14); bindTex(15, G.shTex); gl.uniform1i(U.uRShad, 15);
    };
    // 3. boats, pylons, banner (opaque), then the light beams over the next gate (additive)
    gl.enable(gl.DEPTH_TEST); gl.colorMask(true, true, true, false);
    renderSample(cam, time, jit, true, G.pObj, (P) => {
      const U = P.u; common(U); gl.uniform1f(U.uRBias, 0.15);
      const draw = (o) => {
        gl.uniformMatrix4fv(U.uRM, false, o.M); if (o.c0) gl.uniform3fv(U.uRC0, o.c0); if (o.c1) gl.uniform3fv(U.uRC1, o.c1);
        gl.uniform1f(U.uRNum, o.num || 0); gl.uniform1f(U.uRGlow, o.glow || 0); gl.uniform1f(U.uRWl, o.wl == null ? -99 : o.wl);
        gl.bindVertexArray(o.m.va); gl.drawArrays(gl.TRIANGLES, 0, o.m.count);
      };
      L.forEach(draw);
      if (nextG >= 0) {
        gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); gl.uniform1f(U.uRBias, 0.5);
        for (const bu of GATES[nextG].buoys) draw({ m: G.mBeam, M: modelMat([1, 0, 0], [0, 1, 0], [0, 0, 1], [bu.x, bu.h[0] + 4.4, bu.z]), glow: 0.6 + 0.4 * pulse });
      }
    });
    // 4. wakes and 5. spray: premultiplied alpha over the water, depth-tested against the hulls
    gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    renderSample(cam, time, jit, true, G.pWake, (P) => {
      common(P.u);
      BOATS.forEach((b, i) => {
        const pts = b.wake; if (pts.length < 2) return;
        const a = G.wakeBuf; let n = 0;
        for (const p of pts) {
          const age = clamp((S.t - p.t) / 6, 0, 1), w = Math.min(1.3 + (S.t - p.t) * 0.3 * p.v, 30), I = smoothstep(2, 18, p.v);
          for (const s of [-1, 1]) { a[n++] = p.x + p.rx * w * s; a[n++] = p.y; a[n++] = p.z + p.rz * w * s; a[n++] = s; a[n++] = age; a[n++] = I; a[n++] = w; a[n++] = p.d; }
        }
        const m = G.mWake[i]; gl.bindVertexArray(m.va); gl.bindBuffer(gl.ARRAY_BUFFER, m.b); gl.bufferSubData(gl.ARRAY_BUFFER, 0, a, 0, n);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, n / 8);
      });
    });
    if (G.parts.length) renderSample(cam, time, jit, true, G.pPart, (P) => {
      const U = P.u; common(U);
      const a = G.partBuf; let n = 0;
      for (const p of G.parts) { const k = p.t / p.life; a[n++] = p.x; a[n++] = p.y; a[n++] = p.z; a[n++] = p.size * (1 + k * 1.6); a[n++] = p.a * (1 - k) * (1 - k); }
      gl.uniform3fv(U.uRCam, cam.pos); gl.uniform1f(U.uRPix, R.h / (2 * Math.tan(cam.vfov / 2))); gl.uniform1f(U.uRPmax, Math.min(G.pmax, R.h * 0.1));
      gl.bindVertexArray(G.mPart.va); gl.bindBuffer(gl.ARRAY_BUFFER, G.mPart.b); gl.bufferSubData(gl.ARRAY_BUFFER, 0, a, 0, n);
      gl.drawArrays(gl.POINTS, 0, n / 5);
    });
    gl.disable(gl.BLEND); gl.depthMask(true); gl.disable(gl.DEPTH_TEST); gl.colorMask(true, true, true, true);
    gl.bindVertexArray(vao);
  }
  // one full sample of the frame (scene + objects) into R.acc
  function renderOne(cam, time, jit, live = false) {
    const sky = live && skyReady();
    gl.useProgram(pr.p); gl.uniform1f(pr.u.uRSkyOn, sky ? 1 : 0);
    if (sky) { bindTex(14, G.skyTex); gl.uniform1i(pr.u.uRSky, 14); }
    R.bandpx = live ? 1e9 : 0;   // live frames in one go; slow full-resolution samples keep the driver-friendly bands
    clearAcc(); renderSample(cam, time, jit, true); drawObjects(cam, time, jit);
  }
  function accClear() { ensureTarget(); gl.bindFramebuffer(gl.FRAMEBUFFER, G.Af); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); G.An = 0; }
  function accAdd() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.Af); gl.viewport(0, 0, R.w, R.h); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(G.pCopy.p); bindTex(0, R.acc); gl.uniform1i(G.pCopy.u.uRSrc, 0); gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND); G.An++;
  }
  function presentAcc() { const Rs = R; R = Object.assign({}, Rs, { acc: G.A, n: G.An }); present(false); R = Rs; }

  // ---------------------------------------------------------------- UI
  const CSS = `
#race-ui{position:fixed;inset:0;pointer-events:none;color:#fff;font-family:system-ui,'PingFang HK','Microsoft JhengHei','Noto Sans TC',sans-serif;text-shadow:0 2px 6px rgba(0,0,0,.55);user-select:none}
#race-ui .tl{position:absolute;left:24px;top:18px;line-height:1.15}
#r-pos{font:italic 900 64px/1 system-ui,sans-serif;letter-spacing:-.02em}#r-pos small{font-size:26px;opacity:.75;margin-left:4px}
#r-lap{font-weight:800;font-size:22px;margin-top:6px}#r-time{font:700 22px ui-monospace,Consolas,monospace;margin-top:2px}#r-best{font:600 14px ui-monospace,Consolas,monospace;opacity:.8}
#r-board{position:absolute;right:24px;top:252px;font-size:15px;font-weight:700;min-width:200px}
#r-board div{display:flex;gap:8px;align-items:center;padding:3px 10px;margin-bottom:3px;background:rgba(5,20,35,.45);border-radius:4px}
#r-board div.me{background:rgba(255,255,255,.22)}#r-board i{width:10px;height:10px;border-radius:50%;display:inline-block}
#r-map{position:absolute;left:auto;bottom:auto;right:24px;top:18px;width:220px;height:220px;border-radius:10px;background:rgba(5,20,35,.35)}
#r-spd{position:absolute;right:28px;bottom:24px;text-align:right}#r-spd b{font:italic 900 72px/1 system-ui,sans-serif}#r-spd span{font-weight:700;font-size:18px;margin-left:6px;opacity:.85}
#r-boost{width:220px;height:9px;background:rgba(255,255,255,.18);border-radius:5px;overflow:hidden;margin:8px 0 0 auto}#r-boost i{display:block;height:100%;background:linear-gradient(90deg,#ffb300,#ff5a1f);width:100%}
#r-msg{position:absolute;left:0;right:0;top:30%;text-align:center;font:italic 900 64px/1.1 system-ui,'PingFang HK','Microsoft JhengHei',sans-serif;transition:opacity .25s}
#r-warn{position:absolute;left:0;right:0;top:44%;text-align:center;font-weight:900;font-size:34px;color:#ffdd57}
#r-arrow{position:absolute;left:50%;top:22px;width:0;height:0;margin-left:-14px;border-left:14px solid transparent;border-right:14px solid transparent;border-bottom:30px solid #ffcf3a;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));transform-origin:50% 66%}
#r-dist{position:absolute;left:0;right:0;top:56px;text-align:center;font-weight:700;font-size:14px}
#r-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:min(560px,92vw);padding:28px 34px;background:rgba(4,16,30,.72);backdrop-filter:blur(6px);border-radius:14px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4)}
#r-panel.low{top:auto;bottom:4%;transform:translateX(-50%)}
#r-panel h1{margin:0 0 4px;font:italic 900 46px/1.05 system-ui,'PingFang HK','Microsoft JhengHei',sans-serif}#r-panel h2{margin:0 0 18px;font-weight:600;font-size:17px;opacity:.85}
#r-panel table{margin:10px auto 14px;border-collapse:collapse;font-size:17px}#r-panel td{padding:5px 14px;text-align:left}#r-panel td.n{font:600 16px ui-monospace,Consolas,monospace;text-align:right}
#r-panel tr.me td{color:#ffdd57}#r-panel .keys{display:grid;grid-template-columns:auto auto;gap:4px 18px;justify-content:center;font-size:15px;margin:14px 0 6px;text-align:left}
#r-panel kbd{display:inline-block;min-width:22px;padding:1px 7px;border-radius:4px;background:rgba(255,255,255,.16);font:600 13px ui-monospace,Consolas,monospace;text-align:center;margin-right:3px}
#r-panel .go{margin-top:16px;font-weight:800;font-size:22px;animation:rblink 1.2s infinite}@keyframes rblink{50%{opacity:.35}}
#load .race-title{font:italic 900 40px/1.1 system-ui,'PingFang HK','Microsoft JhengHei',sans-serif;letter-spacing:.02em;text-transform:none;color:#fff;margin-bottom:6px}
#load .race-sub{text-transform:none;letter-spacing:.04em;opacity:.8;margin-bottom:16px}`;
  const KEYS_HTML = `<div class="keys"><span><kbd>W</kbd><kbd>↑</kbd> 油門 throttle</span><span><kbd>S</kbd><kbd>↓</kbd> 剎車 / 倒後 brake</span>
<span><kbd>A</kbd><kbd>D</kbd><kbd>←</kbd><kbd>→</kbd> 轉向 steer</span><span><kbd>Shift</kbd><kbd>Space</kbd> 加速 boost</span>
<span><kbd>C</kbd> 鏡頭 camera (4)</span><span><kbd>R</kbd> 返回檢查點 reset</span><span><kbd>P</kbd><kbd>Esc</kbd> 暫停 / 影相 pause, photo</span><span><kbd>M</kbd> 靜音 mute · <kbd>H</kbd> HUD</span></div>`;
  function buildUI() {
    const d = document.createElement('div'); d.id = 'race-ui';
    d.innerHTML = `<div class="tl"><div id="r-pos"></div><div id="r-lap"></div><div id="r-time"></div><div id="r-best"></div></div>
<canvas id="r-map" width="440" height="440"></canvas><div id="r-board"></div><div id="r-arrow"></div><div id="r-dist"></div>
<div id="r-spd"><b id="r-spdv">0</b><span>km/h</span><div id="r-boost"><i></i></div></div><div id="r-msg"></div><div id="r-warn"></div><div id="r-panel"></div>`;
    document.body.appendChild(d);
    if (Q2('hud') === '0') d.style.display = 'none';
    const $ = (id) => document.getElementById(id);
    ui = { root: d, pos: $('r-pos'), lap: $('r-lap'), time: $('r-time'), best: $('r-best'), map: $('r-map'), board: $('r-board'), arrow: $('r-arrow'), dist: $('r-dist'),
      spd: d.querySelector('#r-spd b'), boost: d.querySelector('#r-boost i'), msg: $('r-msg'), warn: $('r-warn'), panel: $('r-panel'), cache: {} };
    buildMap();
  }
  const setT = (el, s) => { if (ui.cache[el.id] !== s) { ui.cache[el.id] = s; el.innerHTML = s; } };
  function flash(s, dur = 1.6) { S.msg = s; S.msgT = dur; }
  function showPanel(html, low = false) { ui.panel.innerHTML = html; ui.panel.style.display = html ? 'block' : 'none'; ui.panel.classList.toggle('low', low); }
  function titlePanel() {
    showPanel(`<h1>納帕利海岸賽艇</h1><h2>NA PALI POWERBOAT GRAND PRIX · ${RACE.laps} 圈 laps · 4 艇 boats</h2>${KEYS_HTML}<div class="go">撳 Enter 或者 click 開始 · press Enter or click</div>`, true);
  }
  function showResults() {
    const rows = standings().map((b, i) => `<tr class="${b.ai ? '' : 'me'}"><td>${i + 1}</td><td><span style="color:${b.crew.css}">●</span> ${b.crew.name}</td><td class="n">${b.finish != null ? fmtT(b.finish) : '—'}</td><td class="n">${b.laps.length ? fmtT(Math.min(...b.laps)) : ''}</td></tr>`).join('');
    const me = standings().indexOf(BOATS[0]) + 1;
    showPanel(`<h1>${me === 1 ? '冠軍! 🏆' : `第 ${me} 名`}</h1><h2>${me === 1 ? 'YOU WIN' : `YOU FINISHED ${ORD[me]}`} · ${fmtT(BOATS[0].finish)}</h2>
<table><tr><td></td><td></td><td class="n">總時間 time</td><td class="n">最快圈 best lap</td></tr>${rows}</table><div class="go">撳 Enter 或者 click 再嚟一次 · Enter or click to race again</div>`);
    if (S.resT == null) S.resT = S.t;
  }
  function buildMap() {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let i = 0; i < T.n; i++) { x0 = Math.min(x0, T.x[i]); x1 = Math.max(x1, T.x[i]); z0 = Math.min(z0, T.z[i]); z1 = Math.max(z1, T.z[i]); }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, half = Math.max(x1 - x0, z1 - z0) / 2 + 110, N = 440;
    G.map = { cx, cz, half, N, toPx: (x, z) => [(x - cx + half) / (2 * half) * N, (cz - z + half) / (2 * half) * N] };
    const c = document.createElement('canvas'); c.width = c.height = N; const cx2 = c.getContext('2d'), img = cx2.createImageData(N, N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = cx - half + (i + 0.5) / N * 2 * half, z = cz + half - (j + 0.5) / N * 2 * half, d = coastAt(x, z), k = (j * N + i) * 4;
      if (d > 0) { img.data[k] = 46; img.data[k + 1] = 78; img.data[k + 2] = 52; img.data[k + 3] = 235; }
      else if (d > -6) { img.data[k] = 210; img.data[k + 1] = 230; img.data[k + 2] = 240; img.data[k + 3] = 200; }
    }
    cx2.putImageData(img, 0, 0);
    cx2.strokeStyle = 'rgba(255,255,255,.55)'; cx2.lineWidth = 3; cx2.beginPath();
    for (let i = 0; i <= T.n; i += 4) { const p = G.map.toPx(T.x[i % T.n], T.z[i % T.n]); i ? cx2.lineTo(p[0], p[1]) : cx2.moveTo(p[0], p[1]); }
    cx2.closePath(); cx2.stroke();
    for (const g of GATES) { const a = G.map.toPx(g.buoys[0].x, g.buoys[0].z), b = G.map.toPx(g.buoys[1].x, g.buoys[1].z); cx2.strokeStyle = g.k ? 'rgba(255,120,40,.9)' : '#fff'; cx2.lineWidth = g.k ? 3 : 5; cx2.beginPath(); cx2.moveTo(a[0], a[1]); cx2.lineTo(b[0], b[1]); cx2.stroke(); }
    G.mapBg = c;
  }
  function drawMap() {
    const c = ui.map.getContext('2d'); c.clearRect(0, 0, 440, 440); c.drawImage(G.mapBg, 0, 0);
    const nx = BOATS[0].next, g = GATES[nx];
    if (S.phase === 'race') { const a = G.map.toPx(g.buoys[0].x, g.buoys[0].z), b = G.map.toPx(g.buoys[1].x, g.buoys[1].z); c.strokeStyle = '#ffdd57'; c.lineWidth = 6; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
    for (let i = BOATS.length - 1; i >= 0; i--) {
      const b = BOATS[i], p = G.map.toPx(b.x, b.z), s = b.ai ? 9 : 13;
      c.save(); c.translate(p[0], p[1]); c.rotate(b.yaw); c.fillStyle = b.crew.css; c.strokeStyle = '#000'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(0, -s); c.lineTo(s * 0.7, s * 0.8); c.lineTo(-s * 0.7, s * 0.8); c.closePath(); c.fill(); c.stroke(); c.restore();
    }
  }
  function updateUI(cam, dt) {
    const P = BOATS[0], racing = S.phase === 'race' || S.phase === 'countdown', show = S.phase !== 'title';
    ui.root.querySelectorAll('.tl,#r-map,#r-board,#r-spd').forEach((e) => (e.style.display = show ? '' : 'none'));
    const rank = standings(), me = rank.indexOf(P) + 1;
    setT(ui.pos, `${me}<small>/${BOATS.length}</small>`);
    setT(ui.lap, `圈 LAP ${Math.min(P.lap, RACE.laps)}/${RACE.laps}`);
    setT(ui.time, fmtT(P.finish != null ? P.finish : S.raceT));
    setT(ui.best, P.laps.length ? `最快 BEST ${fmtT(Math.min(...P.laps))}` : '');
    setT(ui.board, rank.map((b, i) => `<div class="${b.ai ? '' : 'me'}"><span>${i + 1}</span><i style="background:${b.crew.css}"></i>${b.crew.name}${b.finish != null ? ' 🏁' : ''}</div>`).join(''));
    const vf = Math.hypot(P.vx, P.vz);
    setT(ui.spd, String(Math.round(vf * 3.6)));
    ui.boost.style.width = (P.boost * 100).toFixed(1) + '%';
    const msgOn = S.msgT > 0 && ui.panel.style.display === 'none';
    ui.msg.style.opacity = msgOn ? 1 : 0; if (msgOn) setT(ui.msg, S.msg);
    setT(ui.warn, S.phase === 'race' && P.wrong > 0.8 ? '逆線!  WRONG WAY' : S.phase === 'race' && P.missed ? '錯過檢查點 — 按 R 返回  MISSED GATE (R)' : S.paused ? '暫停 PAUSED' : '');
    // arrow to the next gate, relative to the camera heading
    if (S.phase === 'race') {
      const g = GATES[P.next], dx = g.cx - cam.pos[0], dz = g.cz - cam.pos[2];
      const ang = Math.atan2(dx * cam.r[0] + dz * cam.r[2], dx * cam.f[0] + dz * cam.f[2]);
      ui.arrow.style.display = ''; ui.arrow.style.transform = `rotate(${ang.toFixed(3)}rad)`;
      setT(ui.dist, `${g.k === 0 ? (P.lap === RACE.laps ? '終點 FINISH' : '起點線 LAP LINE') : `檢查點 GATE ${g.k}/${RACE.nGates - 1}`} · ${Math.round(Math.hypot(g.cx - P.x, g.cz - P.z))} m`);
    } else { ui.arrow.style.display = 'none'; setT(ui.dist, ''); }
    if (show) drawMap();
  }

  // ---------------------------------------------------------------- input
  const keys = new Set();
  function readInput() {
    const k = (...c) => c.some((x) => keys.has(x));
    let thr = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0), steer = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0), boost = k('ShiftLeft', 'ShiftRight', 'Space');
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] || 0; if (Math.abs(ax) > 0.12) steer = clamp(ax * 1.15, -1, 1);
      const rt = p.buttons[7] ? p.buttons[7].value : 0, lt = p.buttons[6] ? p.buttons[6].value : 0;
      if (rt > 0.05 || lt > 0.05) thr = rt - lt;
      if (p.buttons[0] && p.buttons[0].pressed) boost = true;
      if (p.buttons[9] && p.buttons[9].pressed && !G.padStart) { G.padStart = true; onKey('Enter'); } else if (p.buttons[9] && !p.buttons[9].pressed) G.padStart = false;
    }
    return { thr, steer, boost };
  }
  function onKey(code) {
    if (code === 'Enter' || code === 'NumpadEnter') {
      audioInit(); if (AUD.ctx && AUD.ctx.state === 'suspended') AUD.ctx.resume();
      if (S.phase === 'title') { S.phase = 'countdown'; S.cd = 3.6; showPanel(''); G.cyaw = BOATS[0].yaw; G.cam.pos = [BOATS[0].x, 5, BOATS[0].z]; }
      else if (S.phase === 'done' && S.resT != null && S.t - S.resT > 0.8) { resetRace(); S.phase = 'countdown'; S.cd = 3.6; showPanel(''); G.cyaw = BOATS[0].yaw; }
      else if (S.paused) { S.paused = false; showPanel(''); }
    } else if (code === 'KeyC') S.camMode = (S.camMode + 1) % 4;
    else if (code === 'KeyR' && S.phase === 'race' && !S.paused) { respawn(BOATS[0]); flash('返回檢查點 RESET', 0.8); }
    else if ((code === 'KeyP' || code === 'Escape') && (S.phase === 'race' || S.phase === 'countdown')) {
      S.paused = !S.paused; showPanel(S.paused ? `<h1>暫停 PAUSED</h1><h2>畫面會慢慢變清晰 · the frame refines while paused (H hides the HUD)</h2><div class="go">撳 P / Enter 繼續 · resume</div>` : '', true);
    } else if (code === 'KeyM') setMute(AUD.on);
    else if (code === 'KeyH') ui.root.style.display = ui.root.style.display === 'none' ? '' : 'none';
    else if (code === 'KeyF') (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  }

  // ---------------------------------------------------------------- main loop
  function probePoints() {
    const pts = [], lat = G.lat;
    for (const b of BOATS) {
      const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), rx = fz, rz = -fx, x = b.x + b.vx * lat, z = b.z + b.vz * lat;
      pts.push({ x: x + fx * 4, z: z + fz * 4, o: b, k: 0, pix: 4 }, { x: x - fx * 3 - rx * 1.4, z: z - fz * 3 - rz * 1.4, o: b, k: 1, pix: 4 }, { x: x - fx * 3 + rx * 1.4, z: z - fz * 3 + rz * 1.4, o: b, k: 2, pix: 4 });
    }
    for (const g of GATES) for (const bu of g.buoys) pts.push({ x: bu.x, z: bu.z, o: bu, k: 0 });
    pts.push({ x: G.cam.pos[0], z: G.cam.pos[2], o: G.camW, k: 0 });
    return pts;
  }
  const oceanT = () => S.t + 3;   // the sea's clock: frozen while paused
  function advance(dt, inp) {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < n; i++) step(dt / n, inp);
    updateParts(dt); for (const b of BOATS) emitSpray(b, dt);
  }
  // offline render of the current moment at the repo's still / video quality: spp jittered samples spread over the shutter
  // interval (motion blur: the race keeps running between samples), every sample with freshly probed waves
  async function shoot(spp = 16, shutter = 0.5, fps = 30) {
    G.hold = true;
    resize(cv.width, cv.height); accClear();
    const dts = shutter / fps / spp;
    let cam;
    for (let k = 0; k < spp; k++) {
      cam = frameCam(dts);
      const t = oceanT(); oceanUpdate(t); probeSync(cam, t, probePoints());
      renderOne(cam, t, spp > 1 ? jitter(k) : [0, 0]); accAdd();
      await gpuWait();
      advance(dts, readInput());
    }
    LOOK.lens = 0; LOOK.ca = 0; LOOK.grain = 0.003;
    presentAcc(); updateUI(cam, 0); await gpuWait();
    return G.An;
  }
  function start() {
    T = buildTrack(RACE.keys); GATES = buildGates(T);
    resetRace();
    G.cam = { pos: [0, 10, 0] }; G.camW = { h: [0] }; G.cyaw = BOATS[0].yaw; G.fov = 58; G.lat = 0.05;
    G.autopilot = Q2('autopilot') === '1';
    initGL(); probeInit(G.src); skyInit();
    buildUI(); titlePanel();
    addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat) onKey(e.code);
      keys.add(e.code);
    });
    addEventListener('keyup', (e) => keys.delete(e.code));
    addEventListener('pointerdown', () => { window.focus(); if (S.phase === 'title' || S.phase === 'done') onKey('Enter'); });   // a click starts too (and gives an embedded page the keyboard)
    addEventListener('blur', () => keys.clear());
    addEventListener('resize', () => { cv.width = innerWidth; cv.height = innerHeight; });
    if (Q2('autostart') === '1') onKey('Enter');
    // test / render hooks: fast-forward without rendering, let the hulls settle on the probed waves, offline frames
    window.__race = {
      S: () => S, boats: () => BOATS, cam: (m) => { S.camMode = m; },
      // time the passes of a live frame at a render scale (each followed by a 1-pixel read so the GPU work is done)
      prof: (n = 3, rsc = 0.5) => {
        resize(Math.round(cv.width * rsc), Math.round(cv.height * rsc)); const T = {}, px = new Float32Array(4), tick = (k, t0) => { gl.bindFramebuffer(gl.FRAMEBUFFER, R.f); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px); T[k] = (T[k] || 0) + performance.now() - t0; };
        while (!skyReady() && G.pSky) skyCacheUpdate(frameCam(0), oceanT(), 8);
        for (let i = 0; i < n; i++) {
          const cam = frameCam(1 / 60), t = oceanT(); let t0 = performance.now();
          oceanUpdate(t); probeIssue(cam, t, probePoints()); skyCacheUpdate(cam, t, 1); tick('ocean+probe+sky', t0); t0 = performance.now();
          renderOne(cam, t, [0, 0], true); tick('frame', t0); t0 = performance.now();
          present(false); tick('post', t0);
        }
        for (const k in T) T[k] = +(T[k] / n).toFixed(1); T.res = R.w + 'x' + R.h; return T;
      }, coast: coastAt, gates: () => GATES, track: () => T, key: onKey, shoot,
      sim: (sec, dt = 1 / 60) => { for (let t = 0; t < sec; t += dt) { advance(dt, readInput()); frameCam(dt); } },
      settle: (sec, dt = 1 / 60) => { for (let t = 0; t < sec; t += dt) { const cam = frameCam(dt); oceanUpdate(oceanT()); probeSync(cam, oceanT(), probePoints()); advance(dt, readInput()); } },
    };
    if (Q.has('nodraw')) { window.__ready = true; return; }
    let last = performance.now(), rs = num('rs', 0.5), ft = 1 / 30, adaptT = 0;
    const loop = (now) => {
      requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.1); last = now;
      if (G.hold) return;
      const inp = readInput();
      if (!S.paused) advance(dt, inp);
      const P = BOATS[0];
      audioEngine(Math.hypot(P.vx, P.vz), S.phase === 'race' && !S.paused ? (G.autopilot ? 0.8 : Math.max(inp.thr, 0)) : 0, P.boosting && !S.paused ? 1 : 0);
      probePoll();
      const cam = frameCam(S.paused ? 0 : dt);
      if (S.paused) {   // photo mode: the frozen moment refines at full resolution, one jittered sample per frame
        if (!G.still) { G.still = true; resize(cv.width, cv.height); accClear(); }
        if (G.An < 256) { const t = oceanT(); oceanUpdate(t); renderOne(cam, t, jitter(G.An)); accAdd(); }
        LOOK.grain = 0.003; presentAcc();
      } else {
        G.still = false;
        // resolution follows the measured frame time toward ~36 fps (steps of 5 %, so the buffers are not rebuilt every frame)
        ft = ft * 0.85 + dt * 0.15; adaptT += dt;
        if (adaptT > 0.4) {
          adaptT = 0;
          if (ft > 1 / 30) rs = Math.max(0.2, rs * clamp(Math.sqrt(1 / 36 / ft), 0.7, 0.95));
          else if (ft < 1 / 50) rs = Math.min(1, rs * 1.07);
        }
        const rq = Math.round(rs * 20) / 20;
        resize(Math.round(cv.width * rq), Math.round(cv.height * rq));
        const t = oceanT(); oceanUpdate(t);
        skyCacheUpdate(cam, t, skyReady() ? 1 : 8);
        probeIssue(cam, t, probePoints());
        G.lat = 0.7 * G.lat + 0.3 * Math.min(0.25, dt * 1.5);
        renderOne(cam, t, [0, 0], true);
        LOOK.lens = 0; LOOK.ca = 0; LOOK.grain = 0.004;
        present(false);
      }
      updateUI(cam, S.paused ? 0 : dt);
      window.__frames = (window.__frames || 0) + 1;
    };
    requestAnimationFrame(loop);
  }


  if (MODE === 'race') {
    document.title = 'Na Pali Powerboat Race';
    const l = document.getElementById('load');
    if (l) l.insertAdjacentHTML('afterbegin', `<div class="race-title">納帕利海岸賽艇</div><div class="race-sub">NA PALI POWERBOAT GRAND PRIX</div><div class="race-sub">生成地形約需 30–90 秒 · building the coast takes 30–90 s on a desktop GPU</div>`);
    const st = document.createElement('style'); st.textContent = CSS.replace(/(\d*\.?\d+)px/g, (m, n) => +(n / 16).toFixed(4) + 'rem'); document.head.appendChild(st);
    const fit = () => { document.documentElement.style.fontSize = clamp(Math.min(innerHeight / 1080, innerWidth / 1700) * 16, 7, 26).toFixed(2) + 'px'; };
    fit(); addEventListener('resize', fit);
  }
  return { renderSrc: () => (G.src = renderSrc()), start };
})();
