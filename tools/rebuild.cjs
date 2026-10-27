// Rebuild index.html from the clean v2 template + v3 geometry patch + tweaks.
const fs = require('fs');
const d = __dirname;
fs.copyFileSync(d + '/v2_template_backup.html', d + '/v2_template.html');
require('./patch_v3.cjs');
require('./patch_v4.cjs');
let t = fs.readFileSync(d + '/v2_template.html', 'utf8');
const rep = (a, b) => { if (!t.includes(a)) { console.error('MISSING:', a.slice(0, 110)); process.exitCode = 1; return; } t = t.replace(a, b); };
rep("treeDens: num('treeDens', 0.9)", "treeDens: num('treeDens', 1.7)");
rep('world.trees = plants(PARAMS.treeCell, 0, PARAMS.treeDens, 2.6, 6.0);', 'world.trees = plants(PARAMS.treeCell, 0, PARAMS.treeDens, 3.8, 9.7);');
rep("treeCell: num('treeCell', 6)", "treeCell: num('treeCell', 13)");
if (fs.existsSync(d + '/tweaks.cjs')) require('./tweaks.cjs')(t, rep);
require('./patch_race.cjs')(rep);
fs.writeFileSync(d + '/v2_template.html', t);
require('./build_v2.cjs');
