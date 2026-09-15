/* 跑全部回归测试并汇总（不依赖 grep -P，避免 locale 问题）

   ★ P118 修过这里 ★
   原来只认「通过 N 项，失败 M 项」这一种结果行，而 test-p102～p110 打的是「结果：N 通过 / M 失败」。
   后果有三个，都很隐蔽：
   ① 那九个文件的断言数根本没进合计（显示 4091，实际 4584）；
   ② 它们被当成"没有结果行"列进「有问题的文件」，还把「不抛异常」这种绿色断言当成异常打出来，
      看的人久了会习惯性忽略这一段——真出问题时也就一起被忽略了；
   ③ 最要命：这些文件里如果真有断言失败，失败数同样不会进合计，而且脚本不论如何都返回 0。
   现在两种格式都认；认不出结果行、进程非零退出、失败数大于 0 都算失败，并以非零退出码结束。 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Administrator/Documents/Claude/Todo/test';
const files = fs.readdirSync(dir).filter(f => /^test-p\d+\.js$/.test(f))
  .sort((a, b) => (parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)));
let pass = 0, fail = 0; const bad = [];
files.forEach(f => {
  let out = '', code = 0;
  try { out = execFileSync('node', [path.join(dir, f)], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, timeout: 300000 }); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status == null ? 1 : e.status; }
  // 两种结果行格式都要认，见文件头
  const m = out.match(/通过 (\d+) 项，失败 (\d+) 项/) || out.match(/结果：(\d+) 通过 \/ (\d+) 失败/);
  if (m) { pass += +m[1]; fail += +m[2]; }
  else fail++;   // 连结果行都没有 = 脚本中途崩了，必须算失败
  if (code !== 0 || !m || +m[2] > 0) {
    bad.push({ f, code, noResult: !m,
      // 只挑真正的失败行，别把「不抛异常」这种通过的断言也捞进来
      tail: out.split('\n').filter(l => l.includes('❌') || /Error|at .*:\d+:\d+/.test(l)).slice(0, 6) });
  }
});
console.log(`TOTAL pass=${pass} fail=${fail}  文件数=${files.length}`);
if (bad.length) {
  console.log('有问题的文件：');
  bad.forEach(b => {
    console.log(' - ' + b.f + ' (exit ' + b.code + (b.noResult ? '，没有结果行' : '') + ')');
    b.tail.forEach(t => console.log('     ' + t.trim()));
  });
  process.exit(1);
}
console.log('全部通过');
