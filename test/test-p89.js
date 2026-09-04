/* P89：又一轮全量排查发现的两个同步问题
   ① 工作台编排（DB.dashboardConfig）根本没进同步载荷——配置面板上却白纸黑字写着
      "编排随共享文件同步，改完全处看到的工作台都会变"。管理员辛苦编排完，同事那边纹丝不动，
      而且谁都不知道问题出在哪。saveDashboardConfig 明明已经给它带上了 rev/updated_at
      （那两个字段只有参与合并时才有用），说明当初就是打算同步的，只是漏了最后一步。
   ② 按实体的 CSV 导入（applyCSVImport）不盖 stampMeta，rev 直接取 CSV 里那一列、没有就写死 1。
      线下整理的 Excel 基本不带 rev 列 → 导进来的每条都是 rev 1 → 合并时打不过共享文件里的
      旧版本 → 整批导入被悄悄回退。表象跟这次事故一模一样（"导进去了，过一会儿又变回去"），
      成因却完全不同。
   用法：node test/test-p89.js */
const { sandbox: S } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));
function emptyPayload() {
  return { duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [], purged: [],
    permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null };
}

async function main() {
  await tick(60);
  const bakMe = S.DB.settings.me;
  S.DB.settings.me = '测试管理员';

  section('①：★工作台编排必须进共享文件（原来整个漏了）');
  const keys = Object.keys(S.syncPayload(S.DB));
  ok('★syncPayload 里有 dashboardConfig', keys.indexOf('dashboardConfig') !== -1, keys);
  ok('报告页编排一直都在（作为对照）', keys.indexOf('reportConfig') !== -1);
  ok('★本机私有的东西仍然不进共享文件', keys.indexOf('settings') === -1 && keys.indexOf('syncBase') === -1);

  section('①：★管理员改完编排，同事那边要收得到');
  const cfgNew = { presets: [{ id: 'p1', name: '管理员编排的', sections: [] }], activeId: 'p1',
    rev: 3, updated_at: '2026-09-04T02:00:00.000Z', updated_by: '管理员' };
  const 管理员 = Object.assign(emptyPayload(), { dashboardConfig: cfgNew });
  const 同事 = emptyPayload();                       // 同事那边还没有任何编排
  const merged = S.mergeSyncPayload(同事, 管理员, null);
  ok('★同事合并之后拿到了管理员那套编排', merged.dashboardConfig && merged.dashboardConfig.activeId === 'p1', merged.dashboardConfig);
  ok('★带着版本号一起过来（下次比较才有依据）', merged.dashboardConfig.rev === 3);

  section('①：版本号大的赢，跟报告页编排同一套规则');
  const 旧 = Object.assign(emptyPayload(), { dashboardConfig: { activeId: '旧', rev: 2, updated_at: '2026-09-01T00:00:00.000Z' } });
  const 新 = Object.assign(emptyPayload(), { dashboardConfig: { activeId: '新', rev: 5, updated_at: '2026-09-02T00:00:00.000Z' } });
  ok('★文件里版本更新 → 采用文件的', S.mergeSyncPayload(旧, 新, null).dashboardConfig.activeId === '新');
  ok('★本机版本更新 → 保留本机的', S.mergeSyncPayload(新, 旧, null).dashboardConfig.activeId === '新');

  section('①：★只改了工作台编排时，也必须判定为"有东西要推"，否则根本不会写文件');
  const 只改了编排 = Object.assign(emptyPayload(), { dashboardConfig: cfgNew });
  ok('★hasLocalContribution 认得出来', S.hasLocalContribution(只改了编排, emptyPayload()) === true);
  ok('两边一样时不写（不制造无谓的网盘写入）',
    S.hasLocalContribution(只改了编排, Object.assign(emptyPayload(), { dashboardConfig: cfgNew })) === false);

  section('①：老文件里没有这个字段时不能出错（旧版本写出来的共享文件照样能用）');
  const 老文件 = emptyPayload();
  delete 老文件.dashboardConfig;
  const m老 = S.mergeSyncPayload(Object.assign(emptyPayload(), { dashboardConfig: cfgNew }), 老文件, null);
  ok('★不报错，并且保留了本机那套编排', m老.dashboardConfig && m老.dashboardConfig.activeId === 'p1');
  const m老2 = S.mergeSyncPayload(老文件, 老文件, null);
  ok('★两边都没有时结果是 null，不会凭空造一个', m老2.dashboardConfig === null || m老2.dashboardConfig === undefined, m老2.dashboardConfig);

  section('①：saveDashboardConfig 存出来的东西形状要能被合并规则认');
  await S.saveDashboardConfig(cfg => { cfg.presets[0].title = '改过'; });
  const saved = S.DB.dashboardConfig;
  ok('★带版本号', typeof saved.rev === 'number' && saved.rev > 0, saved.rev);
  ok('★带修改时间和修改人', !!saved.updated_at && !!saved.updated_by, { at: saved.updated_at, by: saved.updated_by });
  ok('★再存一次版本号会递增（否则同事那边永远判不出哪份更新）', (await S.saveDashboardConfig(() => {}), S.DB.dashboardConfig.rev) > saved.rev);

  section('②：★CSV 导入必须当成"我现在改的"，否则整批导入会被同步悄悄回退');
  S.DB.duties.length = 0; S.DB.works.length = 0; S.DB.tasks.length = 0; S.DB.milestones.length = 0;
  await S.Repo.upsert('duty', { code: 'P89', name: 'P89职责' });
  S.rebuildIndex();
  // 先把这条职责改上好几版，模拟共享文件里它已经是高版本
  for (let i = 0; i < 6; i++) { const d = S.byId('duty', 'P89'); d.name = 'P89职责v' + i; await S.Repo.upsert('duty', d); }
  const revBefore = S.byId('duty', 'P89').rev;
  ok('前置：现有记录版本号已经比较高', revBefore >= 7, revBefore);
  // 线下整理的表格：只有业务列，没有 rev 列（这正是现实中最常见的情况）
  const csv = '﻿code,category,name\nP89,一、前瞻研判,导入改的名字\n';
  await S.applyCSVImport('duty', 'merge', csv);
  const after = S.byId('duty', 'P89');
  ok('★导入的内容生效了', after.name === '导入改的名字', after.name);
  ok('★★版本号压过了原来那条（否则合并时会被文件里的旧值顶回去）', after.rev > revBefore, { 导入前: revBefore, 导入后: after.rev });
  ok('★修改人记成执行导入的人', after.updated_by === '测试管理员', after.updated_by);
  ok('★修改时间是现在，不是 CSV 里抄来的', (after.updated_at || '') >= '2026-01-01', after.updated_at);

  section('②：★端到端——导入之后同步一轮，内容不能被回退');
  // 模拟：文件里是导入前那份（rev 高），本机是导入后那份
  const 文件里 = Object.assign(emptyPayload(), { duties: [Object.assign(cp(after), { name: '文件里的旧名字', rev: revBefore, updated_at: '2026-09-01T00:00:00.000Z' })] });
  const 本机 = Object.assign(emptyPayload(), { duties: [cp(after)] });
  const m2 = S.mergeSyncPayload(本机, 文件里, null);   // 故意不给基线，走最保守的老规则
  ok('★就算没有基线（首次升级/清过缓存），导入的内容照样保住', m2.duties[0].name === '导入改的名字', m2.duties[0].name);

  section('②：CSV 里带了 rev 列时也不能倒退');
  await S.applyCSVImport('duty', 'merge', '﻿code,name,rev\nP89,再导一次,2\n');
  const after2 = S.byId('duty', 'P89');
  ok('★CSV 里写着 rev=2，但结果仍然高于本机现有版本', after2.rev > after.rev, { csv: 2, 本机原有: after.rev, 结果: after2.rev });

  section('②：created_at 属于数据本身，仍然照 CSV 走');
  await S.applyCSVImport('duty', 'merge', '﻿code,name,created_at\nP89,第三次导入,2020-01-01T00:00:00.000Z\n');
  ok('★创建时间保留了 CSV 里的历史值', S.byId('duty', 'P89').created_at === '2020-01-01T00:00:00.000Z', S.byId('duty', 'P89').created_at);

  section('②：新建（增量模式）的记录同样要有正常的版本号和修改人');
  await S.applyCSVImport('duty', 'append', '﻿category,name\n一、前瞻研判,增量导入的新职责\n');
  const added = S.DB.duties.find(d => d.name === '增量导入的新职责');
  ok('★新记录建出来了', !!added);
  ok('★有版本号', added && added.rev >= 1, added && added.rev);
  ok('★有修改人和修改时间（否则合并时会被当成"空记录"处理）', !!(added && added.updated_by && added.updated_at));

  S.DB.settings.me = bakMe;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
