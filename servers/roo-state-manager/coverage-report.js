const cov = require('./coverage/coverage-final.json');
const files = Object.keys(cov).filter(f =>
  f.indexOf('src') > 0 &&
  f.indexOf('__tests__') < 0 &&
  f.indexOf('tests') < 0 &&
  f.indexOf('node_modules') < 0
);
const results = files.map(f => {
  const s = cov[f].s;
  const total = Object.keys(s).length;
  const hit = Object.values(s).filter(v => v > 0).length;
  const pct = total ? Math.round(hit / total * 100) : 100;
  const idx = Math.max(f.lastIndexOf('src/'), f.lastIndexOf('src\\'));
  const short = f.slice(idx).replace(/\\/g, '/');
  return { short, pct };
}).filter(r => r.pct < 70);
results.sort((a, b) => a.pct - b.pct).slice(0, 25).forEach(r =>
  console.log(r.pct + '%\t' + r.short)
);
