// Render a frame of the race at still quality: node race_shot.mjs out.png "sim=30&cam=0&spp=16&shutter=0.25" [w h]
// The four boats race on autopilot for `sim` seconds (0 = the start grid), the hulls settle on the probed waves, then
// shoot() accumulates `spp` jittered samples spread over the shutter interval (motion blur, like video.mjs).
// cam: 0 chase, 1 far chase, 2 bow, 3 TV. hud=1 keeps the race HUD (page screenshot). extra=... adds page URL params.
import { launch } from './cdp.mjs';
import { startServer } from './server.mjs';
import { writeFileSync } from 'node:fs';
const [out = 'race.png', opts = '', W = '1920', H = '1080'] = process.argv.slice(2);
const o = new URLSearchParams(opts), g = (k, d) => (o.has(k) ? +o.get(k) : d);
const sim = g('sim', 30), hud = o.get('hud') === '1', t0 = Date.now();
const server = await startServer(async () => {});
const b = await launch({ width: +W, height: +H });
try {
  await b.navigate(`http://127.0.0.1:${server.port}/index.html?mode=race&autopilot=1&autostart=${sim > 0 ? 1 : 0}&hud=${hud ? 1 : 0}&${o.get('extra') || ''}`);
  await b.waitFor('window.__frames >= 2', 1800000);
  await b.evaluate(`(window.__race.cam(${g('cam', 0)}), window.__race.sim(${sim}), window.__race.settle(1.5), 1)`, false);
  await b.evaluate(`window.__race.shoot(${g('spp', 16)}, ${g('shutter', 0.25)})`);
  writeFileSync(out, hud ? await b.screenshot() : await b.grabCanvas());
  console.log(`saved ${out} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} finally { await b.close(); server.close(); }
