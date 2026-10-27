// Race mode hooks (tools/race.js): a hit-distance render target next to the HDR accumulator, a program / draw override
// for renderSample (the race's wave-probe pass shares its uniforms), and the mode switch in main().
module.exports = (rep) => {
  rep('  if (R && R.w === w && R.h === h) return;\n',
    "  if (R && R.w === w && R.h === h) return;\n  if (R && MODE === 'race') { [R.acc, R.dep, ...R.b].forEach((t) => t && gl.deleteTexture(t)); [R.f, ...R.bf].forEach((f) => gl.deleteFramebuffer(f)); }\n");
  rep('R.f = fbo(R.acc); R.n = 0;',
    "R.dep = MODE === 'race' ? tex(w, h, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST) : null; R.f = fbo(R.acc, R.dep); R.n = 0;");
  rep('function renderSample(cam, time, jit, oceanReady) {', 'function renderSample(cam, time, jit, oceanReady, P0 = null, drawFn = null) {');
  rep('gl.useProgram(pr.p);\n  const u = pr.u;', 'const PR = P0 || pr; gl.useProgram(PR.p);\n  const u = PR.u;');
  rep('  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);\n  const bands', '  if (drawFn) { drawFn(PR); return; }\n  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);\n  const bands');
  rep('Math.ceil(R.w * R.h / (num("bandpx", 15000)))', 'Math.ceil(R.w * R.h / (R.bandpx || num("bandpx", 15000)))');
  rep('//@@FLIGHT@@', '//@@FLIGHT@@\n//@@RACE@@');
  rep('pr = prog(FS_RENDER);', "pr = prog(MODE === 'race' ? RaceMode.renderSrc() : FS_RENDER);");
  rep('await readGround();\n    startDrone();', "await readGround();\n    if (MODE === 'race') RaceMode.start(); else startDrone();");
};
