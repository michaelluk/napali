// ============================================================================
//  Powerboat race (index.html?mode=race)
// ============================================================================
// Four offshore powerboats race laps of a buoyed course along the cliffs. The scene is the same ray-marched world; the
// boats, pylons, wakes and spray are rasterised into its HDR buffer afterwards and depth-tested against the ray march's
// hit distance (a second render target), so waves, sea stacks and headlands hide them correctly. The hulls ride the real
// FFT ocean: a probe pass runs the water shader's own oceanH() under every hull and pylon each frame (read back async).
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
    { name: '你 YOU', hull: [.62, .03, .025], trim: [.82, .82, .8], css: '#ff4a36' },
    { name: 'Kalalau', hull: [.02, .07, .38], trim: [.9, .55, .02], css: '#4d82ff' },
    { name: 'Hanakāpīʻai', hull: [.85, .5, .02], trim: [.03, .03, .03], css: '#ffc21f' },
    { name: 'Nuʻalolo', hull: [.8, .8, .78], trim: [.02, .35, .12], css: '#35d07f' },
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
    return FS_RENDER.slice(0, i) + '\nlayout(location=0) out vec4 o; layout(location=1) out vec4 oDep;\n' + FS_RENDER.slice(i + a.length, j) +
      'oDep=vec4(tt>0.?tt:1e6,0.,0.,1.);\n  ' + FS_RENDER.slice(j);
  }

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

  // ---------------------------------------------------------------- meshes (local: x right, y up, z forward)
  function MB() {
    const a = [], o = {
      a,
      tri(p, q, r, m) { a.push(p[0], p[1], p[2], m, q[0], q[1], q[2], m, r[0], r[1], r[2], m); return o; },
      quad(p, q, r, s, m) { o.tri(p, q, r, m); o.tri(p, r, s, m); return o; },
      box(x0, y0, z0, x1, y1, z1, m) {
        const P = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
        o.quad(P(0), P(1), P(3), P(2), m); o.quad(P(4), P(5), P(7), P(6), m);
        o.quad(P(0), P(1), P(5), P(4), m); o.quad(P(2), P(3), P(7), P(6), m);
        o.quad(P(0), P(2), P(6), P(4), m); o.quad(P(1), P(3), P(7), P(5), m);
        return o;
      },
      lathe(rings, seg) {   // rings [[radius, y, material of the band above], ...] bottom to top
        const p = (r, y, t) => [r * Math.cos(t), y, r * Math.sin(t)];
        for (let k = 0; k + 1 < rings.length; k++) for (let i = 0; i < seg; i++) {
          const t0 = i / seg * 2 * Math.PI, t1 = (i + 1) / seg * 2 * Math.PI, [r0, y0, m] = rings[k], [r1, y1] = rings[k + 1];
          o.quad(p(r0, y0, t0), p(r0, y0, t1), p(r1, y1, t1), p(r1, y1, t0), m);
        }
        return o;
      },
    };
    return o;
  }
  // materials: 0 hull, 1 trim, 2 bottom, 3 deck, 5 glass, 6 engine, 7 pylon, 8 pylon band, 9 checker, 10 pole, 11 beam, 12 shadow
  function boatMesh() {
    const B = MB(), NS = 18, st = [];
    for (let i = 0; i <= NS; i++) {
      const u = i / NS, w = 1.32 * (u < 0.45 ? 1 : Math.sqrt(Math.max(0, 1 - ((u - 0.45) / 0.55) ** 2)));
      st.push({ u, z: -4.5 + 9.2 * u, w, hs: 0.78 + 0.32 * u * u, hc: -0.1 + 0.5 * smoothstep(0.5, 1, u), hk: -0.48 + 0.9 * smoothstep(0.55, 1, u) ** 1.5 });
    }
    const pt = (s, sd, k) => k === 0 ? [sd * s.w, s.hs, s.z] : k === 1 ? [sd * s.w * 0.995, s.hs - 0.2, s.z] : k === 2 ? [sd * s.w * 0.95, s.hc, s.z] : k === 3 ? [0, s.hk, s.z] : [0, s.hs + 0.1, s.z];
    for (let i = 0; i < NS; i++) {
      const a = st[i], b = st[i + 1];
      for (const sd of [-1, 1]) {
        B.quad(pt(a, sd, 0), pt(b, sd, 0), pt(b, sd, 1), pt(a, sd, 1), 1);
        B.quad(pt(a, sd, 1), pt(b, sd, 1), pt(b, sd, 2), pt(a, sd, 2), 0);
        B.quad(pt(a, sd, 2), pt(b, sd, 2), pt(b, sd, 3), pt(a, sd, 3), 2);
        B.quad(pt(a, sd, 0), pt(b, sd, 0), pt(b, sd, 4), pt(a, sd, 4), a.u > 0.62 ? 0 : 3);
      }
    }
    const s0 = st[0], c = [0, (s0.hs + s0.hk) / 2, s0.z];
    const ring = [pt(s0, 1, 4), pt(s0, 1, 0), pt(s0, 1, 1), pt(s0, 1, 2), pt(s0, 1, 3), pt(s0, -1, 2), pt(s0, -1, 1), pt(s0, -1, 0), pt(s0, -1, 4)];
    for (let k = 0; k + 1 < ring.length; k++) B.tri(c, ring[k], ring[k + 1], 0);
    // canopy: sloped glass front and sides, hull-coloured roof
    const bz0 = -3.0, bz1 = -0.2, tz0 = -2.6, tz1 = -1.25, by = 0.8, ty = 1.42, bw = 0.86, tw = 0.56;
    const b00 = [-bw, by, bz0], b10 = [bw, by, bz0], b01 = [-bw, by, bz1], b11 = [bw, by, bz1];
    const t00 = [-tw, ty, tz0], t10 = [tw, ty, tz0], t01 = [-tw, ty, tz1], t11 = [tw, ty, tz1];
    B.quad(b01, b11, t11, t01, 5).quad(b00, b01, t01, t00, 5).quad(b10, b11, t11, t10, 5).quad(t00, t10, t11, t01, 0).quad(b00, b10, t10, t00, 0);
    // twin outboards and a stern wing
    for (const sx of [-0.55, 0.55]) {
      B.box(sx - 0.3, 0.35, -5.2, sx + 0.3, 1.25, -4.4, 6).box(sx - 0.31, 0.95, -5.21, sx + 0.31, 1.06, -4.39, 1).box(sx - 0.1, -0.65, -5.0, sx + 0.1, 0.4, -4.6, 6);
      B.box(sx * 1.6 - 0.04, 0.9, -4.15, sx * 1.6 + 0.04, 1.4, -3.9, 6);
    }
    B.box(-1.15, 1.38, -4.35, 1.15, 1.46, -3.7, 1);
    return new Float32Array(B.a);
  }
  const pylonMesh = () => new Float32Array(MB().lathe([[1.25, -0.8, 7], [1.3, 0.2, 7], [1.05, 0.55, 7], [0.78, 2.2, 8], [0.66, 2.75, 7], [0.12, 4.4, 7], [0, 4.5, 7]], 14).a);
  const beamMesh = () => new Float32Array(MB().lathe([[0.9, 0, 11], [0.9, 70, 11]], 10).a);
  const shadowMesh = () => new Float32Array(MB().quad([-1.6, 0, -5], [1.6, 0, -5], [1.6, 0, 5], [-1.6, 0, 5], 12).a);
  function bannerMesh(g) {   // start / finish: two poles and a chequered banner, in the gate's frame
    const B = MB();
    B.box(-g.hl - 0.12, -0.5, -0.12, -g.hl + 0.12, 8.6, 0.12, 10).box(g.hr - 0.12, -0.5, -0.12, g.hr + 0.12, 8.6, 0.12, 10);
    B.quad([-g.hl, 6.6, 0], [g.hr, 6.6, 0], [g.hr, 8.4, 0], [-g.hl, 8.4, 0], 9);
    return new Float32Array(B.a);
  }

  // ---------------------------------------------------------------- GL
  const VS_OBJ = `#version 300 es
layout(location=0) in vec3 aP; layout(location=1) in float aM;
uniform mat4 uVP, uM; out vec3 vW, vL; flat out float vM;
void main(){ vec4 w=uM*vec4(aP,1.); vW=w.xyz; vL=aP; vM=aM; gl_Position=uVP*w; }`;
  const FS_OBJ = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uDep; uniform vec3 uCamP, uSun, uC0, uC1; uniform float uBias, uGlow;
in vec3 vW, vL; flat in float vM; out vec4 o;
void main(){
  float d=length(vW-uCamP);
  if(texelFetch(uDep,ivec2(gl_FragCoord.xy),0).r<d-(uBias+.003*d)) discard;   // behind the ray-marched water / land
  int m=int(vM+.5);
  if(m==11){ float k=clamp(vL.y/70.,0.,1.); o=vec4(vec3(1.,.72,.22)*(1.-k)*(1.-k)*uGlow*.3,0.); return; }
  if(m==12){ float r=length(vL.xz/vec2(1.6,5.)); o=vec4(0.,0.,0.,.3*smoothstep(1.,.4,r)); return; }
  vec3 V=normalize(uCamP-vW), n=normalize(cross(dFdx(vW),dFdy(vW))); if(dot(n,V)<0.) n=-n;
  vec3 alb=vec3(.8); float ks=.04, sp=60.;
  if(m==0){ alb=uC0; ks=.08; sp=120.; }
  else if(m==1){ alb=uC1; ks=.08; sp=120.; }
  else if(m==2){ alb=uC0*.35+.015; ks=.03; sp=30.; }
  else if(m==3){ alb=vec3(.78,.78,.76); ks=.05; sp=80.; }
  else if(m==5){ alb=vec3(.012,.016,.024); ks=1.; sp=500.; }
  else if(m==6){ alb=vec3(.022); ks=.15; sp=150.; }
  else if(m==7){ alb=uC0; ks=.05; sp=40.; }
  else if(m==8){ alb=vec3(.85); ks=.05; sp=40.; }
  else if(m==9){ alb=vec3(mod(floor(vL.x*.85)+floor(vL.y*1.1),2.)*.84+.02); ks=.02; sp=10.; }
  else if(m==10){ alb=vec3(.35,.36,.38); ks=.3; sp=60.; }
  vec3 SUNC=vec3(1.,.93,.8)*4.4;
  float ndl=max(dot(n,uSun),0.);
  vec3 sky=vec3(.32,.5,.85)*(.6+.4*n.y)*.9+vec3(.04,.12,.16)*max(-n.y,0.);
  vec3 H=normalize(uSun+V); float fr=.04+.96*pow(1.-max(dot(n,V),0.),5.);
  vec3 env=mix(vec3(.12,.25,.38),vec3(.55,.75,1.1),clamp(reflect(-V,n).y*2.+.5,0.,1.));
  vec3 col=alb*(SUNC*ndl+sky)+ks*(SUNC*pow(max(dot(n,H),0.),sp)*(sp+8.)/25.*ndl+env*fr*1.5);
  if(m==7||m==8) col+=alb*uGlow*.7;
  col=mix(col,vec3(.62,.75,.92)*1.3,1.-exp(-d*.00012));
  o=vec4(col,1.);
}`;
  const VS_WAKE = `#version 300 es
layout(location=0) in vec3 aP; layout(location=1) in vec4 aW; layout(location=2) in float aD;
uniform mat4 uVP; out vec3 vW; out vec4 vA; out float vD;
void main(){ vW=aP; vA=aW; vD=aD; gl_Position=uVP*vec4(aP,1.); }`;
  const NOISE = `
float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }`;
  const FS_WAKE = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uDep; uniform vec3 uCamP; uniform float uT;
in vec3 vW; in vec4 vA; in float vD; out vec4 o;` + NOISE + `
void main(){
  float d=length(vW-uCamP);
  if(texelFetch(uDep,ivec2(gl_FragCoord.xy),0).r<d-(2.+.01*d)) discard;
  float x=vA.x*vA.w, age=vA.y, I=vA.z, w=vA.w;   // x: metres across the wake, w: its half width
  float n=vn(vec2(x*.8,vD*.18)+3.7)*.6+vn(vW.xz*.7+vec2(uT*.15,0.))*.4;   // streaks along the wake + slow churn
  float qa=(abs(x)-w*.88)/(.4+.06*w), qw=x/(.9+4.*age);
  float arms=exp(-qa*qa)*smoothstep(.015,.1,age)*pow(1.-age,2.)*.6;   // the Kelvin arms separate from the wash behind the stern
  float wash=exp(-qw*qw)*pow(1.-age,1.5);
  float foam=clamp(arms*smoothstep(.45,.8,n)+wash*smoothstep(.55,.85,n)*.7,0.,1.)*I;
  float aer=wash*.5*I*(1.-foam);   // turquoise aerated water between the foam streaks
  o=vec4(vec3(.88,.94,.97)*1.8*foam+vec3(.08,.34,.38)*aer,foam+aer);
}`;
  const VS_PART = `#version 300 es
layout(location=0) in vec3 aP; layout(location=1) in vec2 aS;
uniform mat4 uVP; uniform vec3 uCamP; uniform float uPix, uPmax; out float vA; out vec3 vW;
void main(){ float d=length(aP-uCamP); vW=aP; vA=aS.y*smoothstep(4.,12.,d); gl_Position=uVP*vec4(aP,1.); gl_PointSize=clamp(aS.x*uPix/max(d,.5),1.,uPmax); }`;
  const FS_PART = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uDep; uniform vec3 uCamP;
in float vA; in vec3 vW; out vec4 o;
void main(){
  float d=length(vW-uCamP);
  if(texelFetch(uDep,ivec2(gl_FragCoord.xy),0).r<d-(.6+.004*d)) discard;
  float r=length(gl_PointCoord-.5)*2., a=smoothstep(1.,.25,r)*vA;
  o=vec4(vec3(.92,.96,1.)*2.4*a,a);
}`;
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
  // column-major view-projection matching the ray march's camera (rd = r*x*tan + u*y*tan + f)
  function viewProj(cam, aspect, near = 0.4, far = 9000) {
    const t = Math.tan(cam.vfov / 2), sx = 1 / (t * aspect), sy = 1 / t, A = (far + near) / (far - near), Bn = -2 * far * near / (far - near);
    const { r, u, f, pos: p } = cam, dr = v3.dot(r, p), du = v3.dot(u, p), df = v3.dot(f, p);
    return new Float32Array([sx * r[0], sy * u[0], A * f[0], f[0], sx * r[1], sy * u[1], A * f[1], f[1], sx * r[2], sy * u[2], A * f[2], f[2], -sx * dr, -sy * du, -A * df + Bn, -df]);
  }
  const modelMat = (r, u, f, p, s = 1) => new Float32Array([r[0], r[1], r[2], 0, u[0] * s, u[1] * s, u[2] * s, 0, f[0], f[1], f[2], 0, p[0], p[1], p[2], 1]);
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
  function probeIssue(cam, time, pts) {
    if (!PRB.p) return;
    const k = PRB.slot.findIndex((s) => !s); if (k < 0) return;
    const n = Math.min(pts.length, PRB.N);
    for (let i = 0; i < n; i++) { PRB.u[i * 4] = pts[i].x; PRB.u[i * 4 + 1] = pts[i].z; PRB.u[i * 4 + 2] = 1.5; }
    renderSample(cam, time, [0, 0], true, PRB.p, (P) => {
      gl.uniform4fv(P.u.uPrb, PRB.u);
      gl.bindFramebuffer(gl.FRAMEBUFFER, PRB.f); gl.viewport(0, 0, PRB.N, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, PRB.pbo[k]); gl.readPixels(0, 0, PRB.N, 1, gl.RGBA, gl.FLOAT, 0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    });
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
      s.pts.forEach((p, i) => { const h = PRB.buf[i * 4]; if (isFinite(h) && Math.abs(h) < 20) p.o.h[p.k] = h; });
    }
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
    for (let i = 0; i < Math.min(60, v * 4); i++) spawn(b.x + (Math.random() - 0.5) * 4, b.y + 0.3, b.z + (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 8, 3 + Math.random() * 7, (Math.random() - 0.5) * 8, 0.8 + Math.random() * 0.6, 1 + Math.random() * 1.5);
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
    const hm = (b.h[0] + b.h[1] + b.h[2]) / 3, plane = 0.28 * smoothstep(8, 26, sp);
    const ty = hm + plane;
    const k = b.y > ty ? 22 : 75;
    b.vy += (k * (ty - b.y) - 8 * b.vy) * dt; b.y += b.vy * dt;
    const tp = Math.atan2(b.h[0] - (b.h[1] + b.h[2]) / 2, 7) + 0.07 * smoothstep(3, 14, sp) * (1 - 0.6 * smoothstep(18, 45, sp)) + b.thr * 0.015 + (b.y - ty) * 0.03;
    const tr = -Math.atan2(b.h[2] - b.h[1], 2.8) * 0.8 + clamp(b.yawRate * sp * 0.011, -0.32, 0.32);
    b.vp += (55 * (tp - b.pitch) - 9 * b.vp) * dt; b.pitch += b.vp * dt;
    b.vr += (45 * (tr - b.roll) - 7 * b.vr) * dt; b.roll += b.vr * dt;
  }
  function spawn(x, y, z, vx, vy, vz, life, size) { if (G.parts.length < 2500) G.parts.push({ x, y, z, vx, vy, vz, t: 0, life, size, y0: y - 0.6 }); }
  function emitSpray(b, dt) {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), rx = fz, rz = -fx, sp = Math.hypot(b.vx, b.vz);
    const rate = 50 * smoothstep(6, 32, sp) * (b.boosting ? 1.5 : 1) + 90 * Math.abs(b.yawRate) * smoothstep(10, 30, sp) + 30 * smoothstep(1.5, 4, Math.abs(b.vy));
    b.emit += rate * dt;
    while (b.emit >= 1) {
      b.emit--;
      const q = Math.random();
      if (q < 0.6) {   // rooster tail behind the props
        spawn(b.x - fx * 5.1 + (Math.random() - 0.5) * 0.8 * rx, b.y - 0.2, b.z - fz * 5.1 + (Math.random() - 0.5) * 0.8 * rz,
          b.vx * 0.7 + (Math.random() - 0.5) * 2.5 * rx, 4 + Math.random() * 6 * smoothstep(10, 40, sp), b.vz * 0.7 + (Math.random() - 0.5) * 2.5 * rz,
          0.5 + Math.random() * 0.5, 0.3 + Math.random() * 0.5);
      } else {        // bow / chine spray, mostly on the outside of a turn
        const sd = Math.random() < 0.5 + clamp(b.yawRate, -0.4, 0.4) * -1.1 ? 1 : -1, px = b.x + fx * (1.5 + Math.random() * 2) + rx * sd * 1.3, pz = b.z + fz * (1.5 + Math.random() * 2) + rz * sd * 1.3;
        spawn(px, b.y - 0.1, pz, b.vx * 0.75 + rx * sd * (3 + Math.random() * 4), 1.5 + Math.random() * 3.5, b.vz * 0.75 + rz * sd * (3 + Math.random() * 4), 0.4 + Math.random() * 0.4, 0.25 + Math.random() * 0.4);
      }
    }
    // wake: a ribbon of stern positions
    const W = b.wake, last = W[0], wx = b.x - fx * 4.6, wz = b.z - fz * 4.6;
    b.odo += sp * dt;
    if (!last || Math.hypot(wx - last.x, wz - last.z) > 1.6) W.unshift({ x: wx, z: wz, y: b.y + 0.18, rx, rz, t: S.t, v: sp, d: b.odo });
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
  function frameCam(dt) {
    const P = BOATS[0];
    if (S.phase === 'title') { const g = GATES[0]; return orbitCam(g.cx + g.tx * 15, g.cz + g.tz * 15, 36, 15, S.t * 0.12 + 2.2, -2); }
    if (S.phase === 'done') return orbitCam(P.x, P.z, 22, P.y + 5, S.t * 0.25, P.y + 1);
    const ch = chaseCam(dt);
    if (S.phase === 'countdown' && S.cd > 0.6) {   // swing from the orbit into the chase position
      const g = GATES[0], k = smoothstep(3.2, 0.8, S.cd), o = orbitCam(g.cx + g.tx * 15, g.cz + g.tz * 15, 36, 15, S.t * 0.12 + 2.2, -2);
      return lookCam(v3.mix(o.pos, ch.pos, k), v3.add(v3.mix(o.pos, ch.pos, k), v3.norm(v3.mix(o.f, ch.f, k))), 0, 55 + (G.fov - 55) * k);
    }
    return ch;
  }

  // ---------------------------------------------------------------- drawing
  function initGL() {
    G.pObj = progVF(VS_OBJ, FS_OBJ); G.pWake = progVF(VS_WAKE, FS_WAKE); G.pPart = progVF(VS_PART, FS_PART);
    const L = [[0, 3], [1, 1]];
    G.mBoat = makeVAO(boatMesh(), L); G.mPylon = makeVAO(pylonMesh(), L); G.mBeam = makeVAO(beamMesh(), L); G.mShadow = makeVAO(shadowMesh(), L);
    G.mBanner = makeVAO(bannerMesh(GATES[0]), L);
    G.wakeBuf = new Float32Array(200 * 2 * 8); G.mWake = BOATS.map(() => makeVAO(G.wakeBuf, [[0, 3], [1, 4], [2, 1]], gl.DYNAMIC_DRAW));
    G.partBuf = new Float32Array(2500 * 5); G.mPart = makeVAO(G.partBuf, [[0, 3], [1, 2]], gl.DYNAMIC_DRAW);
    G.pmax = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
  }
  function ensureTarget() {
    if (G.tR === R) return;
    G.tR = R;
    if (G.rb) gl.deleteRenderbuffer(G.rb);
    G.rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, G.rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, R.w, R.h);
    G.fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, G.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, R.acc, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, G.rb);
  }
  function drawObjects(cam) {
    ensureTarget();
    const VP = viewProj(cam, R.w / R.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.fb); gl.viewport(0, 0, R.w, R.h);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.colorMask(true, true, true, false);
    const P = G.pObj, U = P.u;
    gl.useProgram(P.p); gl.uniformMatrix4fv(U.uVP, false, VP); bindTex(0, R.dep); gl.uniform1i(U.uDep, 0);
    gl.uniform3fv(U.uCamP, cam.pos); gl.uniform3fv(U.uSun, sunDir); gl.uniform1f(U.uBias, 0.15); gl.uniform1f(U.uGlow, 0);
    const draw = (m, M, c0, c1, glow = 0) => {
      gl.uniformMatrix4fv(U.uM, false, M); if (c0) gl.uniform3fv(U.uC0, c0); if (c1) gl.uniform3fv(U.uC1, c1); gl.uniform1f(U.uGlow, glow);
      gl.bindVertexArray(m.va); gl.drawArrays(gl.TRIANGLES, 0, m.count);
    };
    for (const b of BOATS) { const B = boatBasis(b); draw(G.mBoat, modelMat(B.r, B.u, B.f, [b.x, b.y, b.z]), b.crew.hull, b.crew.trim); }
    const nextG = S.phase === 'race' || S.phase === 'countdown' ? BOATS[0].next : -1, pulse = 0.5 + 0.5 * Math.sin(S.t * 6);
    for (const g of GATES) {
      const st = g.k === 0, col = st ? [.75, .75, .72] : [.95, .2, .02], glow = g.k === nextG ? 0.4 + 0.8 * pulse : 0;
      for (const bu of g.buoys) draw(G.mPylon, modelMat([1, 0, 0], [0, 1, 0], [0, 0, 1], [bu.x, bu.h[0], bu.z], st ? 1.5 : 1), col, null, glow);
    }
    const g0 = GATES[0];
    draw(G.mBanner, modelMat([g0.rx, 0, g0.rz], [0, 1, 0], [g0.tx, 0, g0.tz], [g0.cx, (g0.buoys[0].h[0] + g0.buoys[1].h[0]) / 2, g0.cz]));
    // transparent: shadows, light beams, wakes, spray
    gl.depthMask(false); gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE); gl.uniform1f(U.uBias, 1.5);
    const sx = -sunDir[0] / sunDir[1], sz = -sunDir[2] / sunDir[1];
    for (const b of BOATS) {
      const hm = (b.h[0] + b.h[1] + b.h[2]) / 3, lift = Math.max(0, b.y - hm) + 0.9;
      draw(G.mShadow, modelMat([Math.cos(b.yaw), 0, -Math.sin(b.yaw)], [0, 1, 0], [Math.sin(b.yaw), 0, Math.cos(b.yaw)], [b.x + sx * lift, hm + 0.25, b.z + sz * lift]));
    }
    if (nextG >= 0) {
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); gl.uniform1f(U.uBias, 0.5);
      for (const bu of GATES[nextG].buoys) draw(G.mBeam, modelMat([1, 0, 0], [0, 1, 0], [0, 0, 1], [bu.x, bu.h[0] + 3, bu.z]), null, null, 0.6 + 0.4 * pulse);
    }
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    const W = G.pWake;
    gl.useProgram(W.p); gl.uniformMatrix4fv(W.u.uVP, false, VP); gl.uniform1i(W.u.uDep, 0); gl.uniform3fv(W.u.uCamP, cam.pos); gl.uniform1f(W.u.uT, S.t);
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
    if (G.parts.length) {
      const a = G.partBuf; let n = 0;
      for (const p of G.parts) { const k = p.t / p.life; a[n++] = p.x; a[n++] = p.y; a[n++] = p.z; a[n++] = p.size * (1 + k * 1.5); a[n++] = 0.4 * (1 - k) * (1 - k); }
      const Pp = G.pPart; gl.useProgram(Pp.p); gl.uniformMatrix4fv(Pp.u.uVP, false, VP); gl.uniform1i(Pp.u.uDep, 0); gl.uniform3fv(Pp.u.uCamP, cam.pos);
      gl.uniform1f(Pp.u.uPix, R.h / (2 * Math.tan(cam.vfov / 2))); gl.uniform1f(Pp.u.uPmax, Math.min(G.pmax, R.h * 0.08));
      gl.bindVertexArray(G.mPart.va); gl.bindBuffer(gl.ARRAY_BUFFER, G.mPart.b); gl.bufferSubData(gl.ARRAY_BUFFER, 0, a, 0, n);
      gl.drawArrays(gl.POINTS, 0, n / 5);
    }
    gl.disable(gl.BLEND); gl.depthMask(true); gl.disable(gl.DEPTH_TEST); gl.colorMask(true, true, true, true);
    gl.bindVertexArray(vao);
  }

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
<span><kbd>C</kbd> 鏡頭 camera</span><span><kbd>R</kbd> 返回檢查點 reset</span><span><kbd>P</kbd><kbd>Esc</kbd> 暫停 pause</span><span><kbd>M</kbd> 靜音 mute</span></div>`;
  function buildUI() {
    const d = document.createElement('div'); d.id = 'race-ui';
    d.innerHTML = `<div class="tl"><div id="r-pos"></div><div id="r-lap"></div><div id="r-time"></div><div id="r-best"></div></div>
<canvas id="r-map" width="440" height="440"></canvas><div id="r-board"></div><div id="r-arrow"></div><div id="r-dist"></div>
<div id="r-spd"><b id="r-spdv">0</b><span>km/h</span><div id="r-boost"><i></i></div></div><div id="r-msg"></div><div id="r-warn"></div><div id="r-panel"></div>`;
    document.body.appendChild(d);
    const $ = (id) => document.getElementById(id);
    ui = { root: d, pos: $('r-pos'), lap: $('r-lap'), time: $('r-time'), best: $('r-best'), map: $('r-map'), board: $('r-board'), arrow: $('r-arrow'), dist: $('r-dist'),
      spd: d.querySelector('#r-spd b'), boost: d.querySelector('#r-boost i'), msg: $('r-msg'), warn: $('r-warn'), panel: $('r-panel'), cache: {} };
    buildMap();
  }
  const setT = (el, s) => { if (ui.cache[el.id] !== s) { ui.cache[el.id] = s; el.innerHTML = s; } };
  function flash(s, dur = 1.6) { S.msg = s; S.msgT = dur; }
  function showPanel(html, low = false) { ui.panel.innerHTML = html; ui.panel.style.display = html ? 'block' : 'none'; ui.panel.classList.toggle('low', low); }
  function titlePanel() {
    showPanel(`<h1>納帕利海岸賽艇</h1><h2>NA PALI POWERBOAT GRAND PRIX · ${RACE.laps} 圈 laps · 4 艇 boats</h2>${KEYS_HTML}<div class="go">撳 Enter 開始 · press Enter</div>`, true);
  }
  function showResults() {
    const rows = standings().map((b, i) => `<tr class="${b.ai ? '' : 'me'}"><td>${i + 1}</td><td><span style="color:${b.crew.css}">●</span> ${b.crew.name}</td><td class="n">${b.finish != null ? fmtT(b.finish) : '—'}</td><td class="n">${b.laps.length ? fmtT(Math.min(...b.laps)) : ''}</td></tr>`).join('');
    const me = standings().indexOf(BOATS[0]) + 1;
    showPanel(`<h1>${me === 1 ? '冠軍! 🏆' : `第 ${me} 名`}</h1><h2>${me === 1 ? 'YOU WIN' : `YOU FINISHED ${ORD[me]}`} · ${fmtT(BOATS[0].finish)}</h2>
<table><tr><td></td><td></td><td class="n">總時間 time</td><td class="n">最快圈 best lap</td></tr>${rows}</table><div class="go">撳 Enter 再嚟一次 · press Enter to race again</div>`);
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
    } else if (code === 'KeyC') S.camMode = (S.camMode + 1) % 3;
    else if (code === 'KeyR' && S.phase === 'race' && !S.paused) { respawn(BOATS[0]); flash('返回檢查點 RESET', 0.8); }
    else if ((code === 'KeyP' || code === 'Escape') && (S.phase === 'race' || S.phase === 'countdown')) {
      S.paused = !S.paused; showPanel(S.paused ? `<h1>暫停 PAUSED</h1>${KEYS_HTML}<div class="go">撳 P / Enter 繼續 · resume</div>` : '');
    } else if (code === 'KeyM') setMute(AUD.on);
    else if (code === 'KeyF') (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  }

  // ---------------------------------------------------------------- main loop
  function probePoints() {
    const pts = [], lat = G.lat;
    for (const b of BOATS) {
      const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), rx = fz, rz = -fx, x = b.x + b.vx * lat, z = b.z + b.vz * lat;
      pts.push({ x: x + fx * 4, z: z + fz * 4, o: b, k: 0 }, { x: x - fx * 3 - rx * 1.4, z: z - fz * 3 - rz * 1.4, o: b, k: 1 }, { x: x - fx * 3 + rx * 1.4, z: z - fz * 3 + rz * 1.4, o: b, k: 2 });
    }
    for (const g of GATES) for (const bu of g.buoys) pts.push({ x: bu.x, z: bu.z, o: bu, k: 0 });
    pts.push({ x: G.cam.pos[0], z: G.cam.pos[2], o: G.camW, k: 0 });
    return pts;
  }
  function start() {
    T = buildTrack(RACE.keys); GATES = buildGates(T);
    resetRace();
    G.cam = { pos: [0, 10, 0] }; G.camW = { h: [0] }; G.cyaw = BOATS[0].yaw; G.fov = 58; G.lat = 0.05;
    G.autopilot = Q2('autopilot') === '1';
    initGL(); probeInit(G.src);
    buildUI(); titlePanel();
    addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat) onKey(e.code);
      keys.add(e.code);
    });
    addEventListener('keyup', (e) => keys.delete(e.code));
    addEventListener('blur', () => keys.clear());
    addEventListener('resize', () => { cv.width = innerWidth; cv.height = innerHeight; });
    if (Q2('autostart') === '1') onKey('Enter');
    // debug / test hooks: fast-forward the simulation without rendering
    window.__race = { S: () => S, boats: () => BOATS, coast: coastAt, gates: () => GATES, track: () => T, sim: (sec, dt = 1 / 60) => { for (let t = 0; t < sec; t += dt) { step(dt, readInput()); updateParts(dt); for (const b of BOATS) emitSpray(b, dt); frameCam(dt); } }, key: onKey };
    if (Q.has('nodraw')) { window.__ready = true; return; }
    let last = performance.now(), rs = num('rs', 0.5), slow = 0, fast = 0, time = 3;
    const loop = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1); last = now;
      if (dt > 0.05) { slow++; fast = 0; } else if (dt < 0.03) { fast++; slow = 0; }
      if (slow > 6) { rs = Math.max(0.25, rs - 0.05); slow = 0; } if (fast > 40) { rs = Math.min(1, rs + 0.05); fast = 0; }
      const inp = readInput();
      if (!S.paused) {
        const n = Math.ceil(dt / (1 / 120));
        for (let i = 0; i < n; i++) step(dt / n, inp);
        updateParts(dt); for (const b of BOATS) emitSpray(b, dt);
        time += dt;
      }
      const P = BOATS[0];
      audioEngine(Math.hypot(P.vx, P.vz), S.phase === 'race' ? (G.autopilot ? 0.8 : Math.max(inp.thr, 0)) : 0, P.boosting ? 1 : 0);
      probePoll();
      const cam = frameCam(S.paused ? 0 : dt);
      resize(Math.round(cv.width * rs), Math.round(cv.height * rs));
      oceanUpdate(time);
      probeIssue(cam, time, probePoints());
      G.lat = 0.7 * G.lat + 0.3 * Math.min(0.25, dt * 1.5);
      clearAcc(); renderSample(cam, time, [0, 0], true);
      drawObjects(cam);
      LOOK.lens = 0; LOOK.ca = 0; LOOK.grain = 0.004;
      present(false);
      updateUI(cam, S.paused ? 0 : dt);
      window.__frames = (window.__frames || 0) + 1;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  if (MODE === 'race') {
    document.title = 'Na Pali Powerboat Race';
    const l = document.getElementById('load');
    if (l) l.insertAdjacentHTML('afterbegin', `<div class="race-title">納帕利海岸賽艇</div><div class="race-sub">NA PALI POWERBOAT GRAND PRIX</div>`);
    const st = document.createElement('style'); st.textContent = CSS.replace(/(\d*\.?\d+)px/g, (m, n) => +(n / 16).toFixed(4) + 'rem'); document.head.appendChild(st);
    const fit = () => { document.documentElement.style.fontSize = clamp(Math.min(innerHeight / 1080, innerWidth / 1700) * 16, 7, 26).toFixed(2) + 'px'; };
    fit(); addEventListener('resize', fit);
  }
  return { renderSrc: () => (G.src = renderSrc()), start };
})();
