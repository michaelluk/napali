// Assemble index.html from the v2 template + data blocks + flight module.
const fs = require('fs');
const dir = __dirname;
let t = fs.readFileSync(dir + '/v2_template.html', 'utf8');
const put = (tag, file) => { const s = fs.readFileSync(dir + '/' + file, 'utf8'); if (!t.includes(tag)) throw new Error('missing ' + tag); t = t.replace(tag, () => s.trimEnd()); };
put('//@@COAST@@', 'v2_coast.txt');
put('//@@BUILD@@', 'v2_build.txt');
put('//@@COASTSDF@@', 'v2_coastsdf.txt');
put('//@@FLIGHT@@', 'v2_flight.js');
put('//@@RACE@@', 'race.js');
fs.writeFileSync(dir + '/../index.html', t);
console.log('built index.html', t.length, 'bytes');
