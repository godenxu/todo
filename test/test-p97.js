/* P97：第八轮排查——两处"基线记的东西跟文件里不一样"

   这一轮的主线是写入竞争（P95），但顺着"基线不许撒谎"这条线往下查，又挖出两处同病根的：

   ① 合并结果的类型规整是【就地改】的
      合并结果里的记录有一大半就是"从文件里读出来的那个对象本身"（本机没改过这条时，
      合并直接沿用远端那份，不复制）。就地规整会把它一起改掉，紧接着 buildSyncBase(cur.remote)
      拍下来的就是【规整之后】的值，而共享文件里躺着的还是那个坏值。
      后果：下一轮合并认为"本机跟文件一模一样"，规整好的值永远推不回去——代码注释里
      承诺的"顺带自动修复"根本不会发生；而且基线跟文件对不上本身就是这一轮在修的那个病根。

   ② "重新连接共享文件夹"这条路径漏了两道工序
      它跟定时同步/保存走的是同一种合并，却没有跟着补上「合并结果类型规整」和
      「合并之后重算派生字段」。这条路一点也不冷门：文件读写授权不跨页面存活，
      每次刷新之后点一下"恢复共享连接"走的就是这里。
   用法：node test/test-p97.js */
const { sandbox: S, raw } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
// 一条被人用记事本改坏了的任务：参与人写成了一整串，进度写成了字符串
const 坏任务 = () => ({ id: 'T97', work: '', code: '', title: 'P97 任务', owner: '甲',
  assignees: '李四,王五、赵六', status: 'doing', priority: '2', plan_date: '2026-09-20',
  progress: '80', actual_date: '', source: '', custom: '',
  rev: 3, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z', updated_by: '甲' });

async function main() {
  await tick(60);

  section('一、规整必须返回副本，不能就地改');
  {
    const r = 坏任务();
    const c = S.normalizeRecordCopy('task', r);
    ok('★★返回的是另一个对象', c !== r);
    ok('★★原对象一个字段都没被改动（它可能就是"文件里读出来的那份"）',
      r.assignees === '李四,王五、赵六' && r.progress === '80');
    ok('★副本里参与人按逗号/顿号切开了', Array.isArray(c.assignees) && c.assignees.join(',') === '李四,王五,赵六', c.assignees);
    ok('★副本里进度变成了数字', c.progress === 80 && typeof c.progress === 'number');

    const good = S.blank('task', { id: 'T98', title: '本来就干净' });
    ok('★本来就干净的记录原样返回同一个对象（不白白换一批新对象，也不制造假的"本机改动"）',
      S.normalizeRecordCopy('task', good) === good);
  }
  {
    const bad = 坏任务();
    const p = Object.assign(EMPTY(), { tasks: [bad] });
    S.normalizeMergedRecords(p);
    ok('★列表里换成了规整好的副本', p.tasks[0] !== bad && Array.isArray(p.tasks[0].assignees));
    ok('★★传进来的那条原记录仍然是坏的（证明没有就地改）', bad.assignees === '李四,王五、赵六');
  }

  section('二、★所以规整好的值真的能推回共享文件（原来推不回去）');
  {
    // 文件里躺着一条坏记录；本机跟它对完账（基线 = 文件原样）
    const remote = Object.assign(EMPTY(), { tasks: [坏任务()] });
    const base = S.buildSyncBase(remote);
    ok('★基线记的是"文件里原样"——参与人还是那一整串',
      base.task.T97.assignees === '李四,王五、赵六', base.task.T97.assignees);

    // 本机合并 + 规整之后
    const merged = S.normalizeMergedRecords(S.mergeSyncPayload(EMPTY(), cp(remote), null));
    ok('★合并结果里已经是规整好的', Array.isArray(merged.tasks[0].assignees));
    ok('★★本机据此判定"有东西要推"，坏值会被真正修回文件里（原来这里判成没差别，永远修不掉）',
      S.hasUnpushedFieldChange('task', merged.tasks, base.task) === true);
  }

  section('三、"重新连接共享文件夹"这条路径');
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
    const fn = src.slice(src.indexOf('async function connectSharedFile'),
      src.indexOf('async function connectSharedFile') + 6000);
    ok('★合并结果过了类型规整', /const merged = normalizeMergedRecords\(mergeSyncPayload\(localPayload, remote, DB\.syncBase\)\)/.test(fn));
    ok('★合并之后重算了派生字段', /reconcileDerivedAfterMerge\(merged\);/.test(fn));
    ok('★这条路径也查"上次写有没有被人盖掉"', /noteClobberedWrite\(remote, DB\);/.test(fn));
    ok('★首次连接（整份采用文件内容）同样过规整', /normalizeMergedRecords\(DB\);\s*\/\/ 那份文件谁都能用记事本改/.test(fn));
    ok('★★首次连接不跟 remote 共用同一个数组——共用的话规整会把 remote 一起改掉，基线又要撒谎',
      /DB\.tasks = \(remote\.tasks \|\| \[\]\)\.slice\(\);/.test(fn));
    ok('★基线仍然对齐到"文件里那一份"', /DB\.syncBase = buildSyncBase\(remote\);/.test(fn));
  }

  section('四、★整机验证：刷新之后点"恢复共享连接"，文件里的坏记录不能让页面崩掉');
  {
    const bakTasks = cp(S.DB.tasks), bakMe = S.DB.settings.me, bakBase = cp(S.DB.syncBase);
    S.DB.tasks = []; S.DB.milestones = []; S.DB.duties = []; S.DB.works = [];
    S.DB.syncBase = null; S.rebuildIndex();

    // 模拟这条路径的核心三步（连接动作本身要真实文件句柄，这里只跑合并那一段）
    const remote = Object.assign(EMPTY(), { tasks: [坏任务()] });
    const merged = S.normalizeMergedRecords(S.mergeSyncPayload(S.syncPayload(S.DB), cp(remote), S.DB.syncBase));
    S.reconcileDerivedAfterMerge(merged);
    Object.assign(S.DB, merged);
    S.DB.syncBase = S.buildSyncBase(remote);
    S.DB.settings.me = '甲';
    S.rebuildIndex();
    ok('★参与人已经是数组了（不是数组的话任务页一渲染就抛异常）', Array.isArray(S.DB.tasks[0].assignees));
    let crashed = '';
    try { S.setPage('tasks'); S.renderPage(); S.setPage('charts'); S.renderPage(); S.renderDashboard(); }
    catch (e) { crashed = e.message; }
    ok('★任务页 / 图表页 / 工作台都渲染得出来', !crashed, crashed);
    ok('★基线记的仍然是文件里那个坏值（这样修好的值才会被推回去）',
      S.DB.syncBase.task.T97.assignees === '李四,王五、赵六');

    S.DB.tasks = bakTasks; S.DB.settings.me = bakMe; S.DB.syncBase = bakBase; S.rebuildIndex();
  }

  section('五、"本机数据整批换掉"的动作，必须把基线和写入链标记一起清干净');
  {
    S.DB.syncBase = { task: {}, duty: {}, work: {}, milestone: {} };
    S.DB.settings.lastWriteId = 'w_old'; S.DB.settings.lastWriteIdAt = new Date().toISOString();
    S.setLastWriteId('w_old'); S.setPreWriteBase({ task: {} });
    S.clearSyncBaseline(S.DB);
    ok('★基线清了', S.DB.syncBase === null);
    ok('★★写入链标记也清了——只清基线的话，下一次同步会拿一个跟现在这份数据毫无关系的旧标记'
      + '去问"我那次写还在链上吗"，必然答不在，白报一次"你的保存被覆盖了"',
      !S.DB.settings.lastWriteId && !S.DB.settings.lastWriteIdAt && !S.lastWriteId && !S.preWriteBase);
    ok('★清完之后检测一定不会误报', S.detectClobberedWrite({ writeIds: ['a', 'b'] }, S.DB) === false);

    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
    const n = (src.match(/clearSyncBaseline\(DB\);/g) || []).length;
    ok('★三个"整批换掉数据"的入口都改成走这一个收口函数（从备份恢复 / 以共享文件为准重置 / 播种演示数据）',
      n === 3, n);
    ok('★★没有地方再单独写 DB.syncBase = null（漏一处就是一处误报）', !/DB\.syncBase = null;/.test(src));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
