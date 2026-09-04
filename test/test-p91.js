/* P91：第四轮排查——碰共享文件的动作没有全部串行化
   原来只有"定时器 / 切回标签页 / 手动点立即同步"这三条路走 withSyncGate 排队，
   而【用户每一次保存】走的 Repo.persist → syncToFile 压根不排队。于是保存和后台同步
   会同时读写同一个文件句柄——withSyncGate 自己的注释早就说过这种并发"行为没有保证"，
   只是当时漏掉了保存这条路。
   加上三方合并之后更要紧：基线（DB.syncBase）的含义是"文件里现在是什么"，两个
   读—合并—写的循环交错跑，就会出现"基线记的是我这次合并的结果、文件里躺的却是别人写的那份"，
   下一次合并把谁的改动算成谁的就全乱了。
   修法：串行化下沉到真正碰文件的 syncToFile / pullFromFile 两个函数上（互不调用，不会死锁），
   withSyncGate 退化成"忙就别再排"的前置判断——用户保存一定排队、一定执行，不会被跳过。
   用法：node test/test-p91.js */
const { sandbox: S } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);

  section('①：★runSyncSerial——重叠调用必须一个跑完再跑下一个，不能交错');
  const trace = [];
  const job = (name, ms) => S.runSyncSerial(async () => {
    trace.push(name + '进');
    await sleep(ms);          // 模拟读文件/写文件这段真实的等待
    trace.push(name + '出');
    return name;
  });
  // 同时丢三个进去（模拟：用户保存 + 定时器同步 + 切回标签页拉取 撞在一起）
  const results = await Promise.all([job('保存', 30), job('定时', 5), job('拉取', 5)]);
  ok('★三个都执行了，一个都没被丢掉', results.join(',') === '保存,定时,拉取', results);
  ok('★★执行过程没有交错（每个都是"进"紧接着自己的"出"）',
    trace.join(',') === '保存进,保存出,定时进,定时出,拉取进,拉取出', trace);

  section('①：先排队的先跑，顺序不会乱');
  const order = [];
  await Promise.all([1, 2, 3, 4].map(i => S.runSyncSerial(async () => { await sleep(4 - i); order.push(i); })));
  ok('★严格按入队顺序执行', order.join(',') === '1,2,3,4', order);

  section('①：★一次失败不能把整条队列卡死（网盘抖一下就再也不同步了，那是灾难）');
  const after = [];
  const failed = S.runSyncSerial(async () => { throw new Error('模拟网盘抖动'); });
  let caught = null;
  await failed.catch(e => { caught = e.message; });
  await S.runSyncSerial(async () => { after.push('后续任务跑了'); });
  ok('★失败会如实抛给调用方（不吞异常）', caught === '模拟网盘抖动', caught);
  ok('★★但后面的任务照常执行，队列没断', after.length === 1, after);

  section('①：跑完之后忙标记要清掉，否则定时器会以为永远在忙、再也不同步');
  ok('★空闲时 _syncBusy 是 false', S.syncBusy === false, S.syncBusy);
  let busyDuring = null;
  await S.runSyncSerial(async () => { busyDuring = S.syncBusy; });
  ok('★任务执行期间是 true（定时器据此跳过）', busyDuring === true, busyDuring);
  ok('★任务结束后回到 false', S.syncBusy === false, S.syncBusy);
  await S.runSyncSerial(async () => { throw new Error('x'); }).catch(() => {});
  ok('★就算任务抛异常，忙标记也要清掉（否则同步永久停摆）', S.syncBusy === false, S.syncBusy);

  section('②：★withSyncGate——"可以错过"的路径忙就跳过，但不影响必须执行的保存');
  let ran = 0;
  const gated = S.runSyncSerial(async () => { await sleep(20); });   // 占住队列
  await tick(2);
  const skipped = await S.withSyncGate(async () => { ran++; return 'ran'; });
  ok('★队列忙的时候，定时器这类调用直接跳过（返回 false，不排队堆积）', skipped === false && ran === 0, { skipped, ran });
  await gated;
  const done = await S.withSyncGate(async () => { ran++; return 'ran'; });
  ok('★空闲时正常执行', done === 'ran' && ran === 1, { done, ran });

  section('③：★源码接线——两个碰文件的函数都必须走队列，withSyncGate 不再自己占标记');
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('★syncToFile 走 runSyncSerial（用户保存正是走它）',
    /async function syncToFile\(db\)[\s\S]{0,300}?runSyncSerial\(\(\) => syncToFileInner\(db\)\)/.test(src));
  ok('★pullFromFile 走 runSyncSerial',
    /async function pullFromFile\(\)[\s\S]{0,300}?runSyncSerial\(pullFromFileInner\)/.test(src));
  ok('★withSyncGate 只做"忙就跳过"，不再自己设忙标记（否则会跟队列打架）',
    /async function withSyncGate\(fn\) \{\s*\n\s*if \(_syncBusy\) return false;\s*\n\s*return await fn\(\);/.test(src));
  ok('★Repo.persist 里那次同步现在会经过队列（它调的就是 syncToFile）',
    /async persist\(db\)[\s\S]{0,2000}?await syncToFile\(db\)/.test(src));

  section('③：不会死锁——排队的两个函数互不调用');
  // 取一个函数体：从声明处到下一个顶格的 function/const 声明为止（这份源码里顶层声明都不缩进）
  const bodyOf = decl => {
    const from = src.indexOf(decl);
    if (from < 0) return '';
    const rest = src.slice(from + decl.length);
    const end = rest.search(/\n(?:async function |function |const |let )/);
    return end < 0 ? rest : rest.slice(0, end);
  };
  const inner = bodyOf('async function syncToFileInner');
  ok('★syncToFileInner 内部不会再去调 pullFromFile 或 syncToFile（否则就是自己排队等自己）',
    !!inner && !/\bpullFromFile\(|\bsyncToFile\(/.test(inner));
  const pullInner = bodyOf('async function pullFromFileInner');
  ok('★pullFromFileInner 内部也不会反过来调 syncToFile', !!pullInner && !/\bsyncToFile\(/.test(pullInner));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
