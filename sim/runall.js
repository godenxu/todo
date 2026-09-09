/* 跑全部回归测试并汇总（不依赖 grep -P，避免 locale 问题） */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Administrator/Documents/Claude/Todo/test';
const files = fs.readdirSync(dir).filter(f => /^test-p\d+\.js$/.test(f))
  .sort((a, b) => (parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)));
let pass = 0, fail = 0; const bad = [];
files.forEach(f => {
  let out = '', code = 0;
  try { out = execFileSync('node', [path.join(dir, f)], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status == null ? 1 : e.status; }
  const m = out.match(/通过 (\d+) 项，失败 (\d+) 项/);
  if (m) { pass += +m[1]; fail += +m[2]; }
  if (code !== 0 || !m || +m[2] > 0) bad.push({ f, code, tail: out.split('\n').filter(l => l.includes('❌') || l.includes('异常')).slice(0, 6) });
});
console.log(`TOTAL pass=${pass} fail=${fail}  文件数=${files.length}`);
if (bad.length) { console.log('有问题的文件：'); bad.forEach(b => { console.log(' - ' + b.f + ' (exit ' + b.code + ')'); b.tail.forEach(t => console.log('     ' + t.trim())); }); }
else console.log('全部通过');
