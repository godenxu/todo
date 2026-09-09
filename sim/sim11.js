/* 第十二轮：动作级端到端体检。

   前几轮查的都是"同步这一层对不对"。这一轮换成从界面动作那一端往下查，
   而且只用一条【不需要逐个动作写期望值】的通用判据：

     一台机器、没有任何同事并发写入的情况下，做完任何一个会改数据的动作之后，
     本机内存里的数据和共享文件里的数据必须【一模一样】。

   不一样只有两种可能，两种都是 bug：
     · 这个动作压根没落盘 / 没触发同步 → 改动只在本机，同事看不见；
     · 落盘了，但合并把它吃掉了 → 改动写出去又被自己的合并规则抹了。
   区分方法：发现不一致之后再显式同步一次，能补上就是前者，补不上就是后者。

   用法：node scratchpad/sim11.js
*/
const REPO = 'C:/Users/Administrator/Documents/Claude/Todo';
const { sandbox: S, q } = require(REPO + '/test/harness.js');
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 700) : '')); }
};

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });

function mkHandle(text) {
  const h = {
    name: 'shared.json', _text: text, _mtime: 1000, _writes: 0,
    async getFile() { const snap = h._text; return { lastModified: h._mtime, text: async () => snap }; },
    async createWritable() {
      return { async write(t) { h._pending = t; }, async close() { h._writes++; h._text = h._pending; h._mtime += 1; } };
    },
  };
  return h;
}
const fileOf = h => JSON.parse(h._text);

const LISTS = [['duty', 'code', 'duties'], ['work', 'id', 'works'],
  ['milestone', 'id', 'milestones'], ['task', 'id', 'tasks'], ['user', 'name', 'users']];
const OBJS = ['permissionMatrix', 'shareConfig', 'reportConfig', 'dashboardConfig'];

// 本机 vs 共享文件，逐条逐字段对账
function diffDbVsFile(F) {
  const out = [];
  LISTS.forEach(([e, pk, k]) => {
    const fm = new Map((F[k] || []).map(r => [r[pk], r]));
    (S.DB[k] || []).forEach(r => {
      const o = fm.get(r[pk]);
      if (!o) { out.push(k + ' ' + r[pk] + '：文件里没有'); return; }
      if (JSON.stringify(r) !== JSON.stringify(o)) {
        const keys = new Set([...Object.keys(r), ...Object.keys(o)]);
        const bad = [...keys].filter(x => JSON.stringify(r[x]) !== JSON.stringify(o[x]));
        out.push(k + ' ' + r[pk] + '：字段不一致 ' + bad.join(',')
          + ' 本机=' + JSON.stringify(bad.map(x => r[x])) + ' 文件=' + JSON.stringify(bad.map(x => o[x])));
      }
    });
    (F[k] || []).forEach(r => {
      if (!(S.DB[k] || []).some(x => x[pk] === r[pk])) out.push(k + ' ' + r[pk] + '：本机没有（文件里有）');
    });
  });
  OBJS.forEach(k => {
    if (JSON.stringify(S.DB[k] || null) !== JSON.stringify(F[k] || null)) out.push(k + '：不一致');
  });
  const fl = new Set((F.changelog || []).map(e => e.id));
  (S.DB.changelog || []).forEach(e => { if (!fl.has(e.id)) out.push('changelog ' + (e.text || e.id) + '：没推上去'); });
  const pf = new Set((F.purged || []).map(p => p.entity + ' ' + p.id + ' ' + p.at + ' ' + (p.undone ? 'U' : 'D')));
  (S.DB.purged || []).forEach(p => {
    if (!pf.has(p.entity + ' ' + p.id + ' ' + p.at + ' ' + (p.undone ? 'U' : 'D'))) out.push('purged ' + p.entity + ' ' + p.id + '：没推上去');
  });
  return out;
}

/* ---------------- 起始数据 ---------------- */
function seed() {
  S.DB.duties = []; S.DB.works = []; S.DB.milestones = []; S.DB.tasks = [];
  S.DB.changelog = []; S.DB.purged = [];
  S.DB.permissionMatrix = null; S.DB.reportConfig = null; S.DB.dashboardConfig = null; S.DB.shareConfig = null;
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.undoStack.length = 0;
  S.setSnackPriorityUntil(0);

  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '规划', name: '职责甲' })),
    S.stampMeta(S.blank('duty', { code: '02', category: '运维', name: '职责乙' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w_0101', code: '0101', duty: '01', name: '工作一', owner: '测试管理员', year: 2026 })),
    S.stampMeta(S.blank('work', { id: 'w_0201', code: '0201', duty: '02', name: '工作二', owner: '测试管理员', year: 2026 }))];
  S.DB.tasks = [];
  for (let i = 1; i <= 4; i++) {
    S.DB.tasks.push(S.stampMeta(S.blank('task', {
      id: 'T' + i, work: i <= 2 ? 'w_0101' : 'w_0201', code: '0101260' + i,
      title: '任务' + i, owner: '测试管理员', status: i === 4 ? 'done' : 'todo',
      plan_date: '2026-10-0' + i, priority: '2',
    })));
  }
  S.DB.milestones = [S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', deliverable: '交付物一', plan_date: '2026-10-05' })),
    S.stampMeta(S.blank('milestone', { id: 'M2', task: 'T1', deliverable: '交付物二', plan_date: '2026-10-06' }))];
  S.DB.users = [{ name: '测试管理员', role: 'admin', salt: '', hash: '', iterations: 0,
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', updated_by: '测试管理员', rev: 1 },
    { name: '同事乙', role: 'staff', salt: '', hash: '', iterations: 0,
      created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', updated_by: '测试管理员', rev: 1 }];
  S.DB.settings.me = '测试管理员';
  S.rebuildIndex();
}

/* 弹窗：动作弹了确认框就替用户点"确定" */
async function confirmIfAny() {
  for (let i = 0; i < 3; i++) {
    if (!q('#modal-overlay').classList.contains('show')) break;
    const cb = S.modalCallback;
    if (typeof cb !== 'function') break;
    await cb();
    await tick(15);
  }
}

/* 跑一个动作，然后对账。
   ★ 必须先确认"这个动作真的改了东西" ★ 否则一个因为权限/参数不对而当场 return 的动作
   会毫不费力地通过对账，整张表就成了绿色的橡皮图章——第十轮已经栽过一次同样的跟头。 */
async function step(h, name, run) {
  const beforeDb = JSON.stringify([S.DB.duties, S.DB.works, S.DB.milestones, S.DB.tasks,
    S.DB.users, S.DB.purged, S.DB.permissionMatrix, S.DB.shareConfig, S.DB.reportConfig, S.DB.dashboardConfig]);
  let err = '';
  try { await run(); await confirmIfAny(); await tick(25); }
  catch (e) { err = (e && e.message) || String(e); }
  if (err) { ok(name + '（动作本身不该抛异常）', false, err); return; }

  const afterDb = JSON.stringify([S.DB.duties, S.DB.works, S.DB.milestones, S.DB.tasks,
    S.DB.users, S.DB.purged, S.DB.permissionMatrix, S.DB.shareConfig, S.DB.reportConfig, S.DB.dashboardConfig]);
  if (beforeDb === afterDb) { ok(name + '（这个动作压根没改到数据，用例本身失效）', false); return; }

  let diff = diffDbVsFile(fileOf(h));
  if (!diff.length) { ok(name, true); return; }
  // 不一致：再显式同步一次，看是"没落盘"还是"落盘了被合并吃掉"
  await S.Repo.persist(S.DB);
  await tick(15);
  const diff2 = diffDbVsFile(fileOf(h));
  const kind = diff2.length ? '★落盘了也补不回来（合并把它吃掉了）' : '★这个动作没触发同步（改动只留在本机，同事看不见）';
  ok(name + ' → ' + kind, false, (diff2.length ? diff2 : diff).slice(0, 4));
}

async function main() {
  await tick(120);
  seed();
  const h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION })));
  S.setFileHandle(h);
  S.setEverConnected(true);
  await S.Repo.persist(S.DB);
  await tick(20);
  ok('起始数据已经完整推上共享文件', diffDbVsFile(fileOf(h)).length === 0, diffDbVsFile(fileOf(h)).slice(0, 4));

  console.log('\n■ 一、任务 / 工作 / 职责的增删改');
  await step(h, 'task-del 删除任务', () => S.ACTIONS['task-del']({ id: 'T2' }));
  await step(h, 'task-restore 恢复任务', () => S.ACTIONS['task-restore']({ id: 'T2' }));
  await step(h, 'task-detail 详情弹窗改标题并保存', async () => {
    // 挑一条名下没有里程碑的任务：沙盒里 querySelectorAll 恒返回空数组，
    // 有里程碑的话保存逻辑会以为"这些行被人删光了"，那是桩的问题不是程序的问题
    S.ACTIONS['task-detail']({ id: 'T2' });
    await tick(10);
    const el = q('#td-title'); if (el) el.value = '任务2（详情弹窗改过）';
  });
  await step(h, 'task-purge 彻底删除任务', () => S.ACTIONS['task-purge']({ id: 'T3' }));
  await step(h, 'undo 撤销上一步', () => S.ACTIONS['undo']());
  await step(h, 'work-del 停用工作', () => S.ACTIONS['work-del']({ id: 'w_0201' }));
  await step(h, 'work-restore 恢复工作', () => S.ACTIONS['work-restore']({ id: 'w_0201' }));
  await step(h, 'duty-del 删除职责', () => S.ACTIONS['duty-del']({ code: '02' }));
  await step(h, 'duty-restore 恢复职责', () => S.ACTIONS['duty-restore']({ code: '02' }));

  console.log('\n■ 二、单元格 / 里程碑 / 进度');
  await step(h, 'sp-pick 下拉改状态', async () => {
    S.ACTIONS['edit']({ entity: 'task', id: 'T1', field: 'status' }, q('#x'));
    await tick(10);
    await S.spCommitSingle('doing');
  });
  await step(h, 'dp-pick 日期选择器改计划日期', async () => {
    S.ACTIONS['edit']({ entity: 'task', id: 'T1', field: 'plan_date' }, q('#x'));
    await tick(10);
    await S.dpCommit('2026-11-11');
  });
  await step(h, 'sp-commit 多选改参与人', async () => {
    S.ACTIONS['edit']({ entity: 'task', id: 'T1', field: 'assignees' }, q('#x'));
    await tick(10);
    if (S.sp) S.sp.sel = ['同事乙'];
    await S.spCommitMulti();
  });
  await step(h, 'health-fix 体检一键修复（进度与状态对不上）', async () => {
    const t = S.byId('task', 'T4');
    if (t) { t.status = 'todo'; t.progress = 60; S.stampMeta(t); }
    await S.Repo.persist(S.DB); await tick(10);
    S.ACTIONS['health-fix']({ k: 'progressMismatch' });
  });

  console.log('\n■ 三、账号与权限');
  await step(h, 'admin-new-user 新建账号', async () => {
    q('#adm-new-name').value = '新同事丙';
    q('#adm-new-role').value = 'staff';
    await S.ACTIONS['admin-new-user']();
  });
  await step(h, 'account-role-change 改角色', () => {
    const el = q('#role-同事乙'); el.value = 'comanager';
    return S.ACTIONS['account-role-change']({ name: '同事乙' }, el);
  });
  await step(h, 'perm-toggle 改权限矩阵', () => {
    const el = q('#perm-x'); el.checked = true;
    return S.ACTIONS['perm-toggle']({ role: 'staff', key: 'bulk_ops' }, el);
  });
  await step(h, 'admin-delete-user 停用账号', () => S.ACTIONS['admin-delete-user']({ name: '同事乙' }));

  console.log('\n■ 四、共享文件夹配置（随文件同步的那几项）');
  await step(h, 'backup-toggle 自动备份开关', () => {
    const el = q('#bk-enable'); el.checked = true;
    return S.ACTIONS['backup-toggle'](null, el);
  });
  await step(h, 'backup-interval-change 备份间隔', () => {
    const el = q('#bk-hours'); el.value = '6';
    return S.ACTIONS['backup-interval-change'](null, el);
  });
  await step(h, 'recycle-keep-change 回收站保留期', () => {
    const el = q('#recycle-keep'); el.value = '180';
    return S.ACTIONS['recycle-keep-change'](null, el);
  });

  console.log('\n■ 五、报告页 / 工作台编排（都写着"随共享文件同步"）');
  await step(h, 'report-preset-new 新建报告预设', async () => {
    S.ACTIONS['report-preset-new']();
    await tick(10);
    const inp = q('#prompt-input'); if (inp) inp.value = '周会精简版';
  });
  await step(h, 'report-sec-add 新增报告区域', async () => {
    S.ACTIONS['report-sec-add']();
    await tick(10);
    const inp = q('#prompt-input'); if (inp) inp.value = '新区域';
  });
  await step(h, 'report-config-reset 恢复默认编排', () => S.ACTIONS['report-config-reset']());
  await step(h, 'dash-preset-new 新建工作台预设', async () => {
    S.ACTIONS['dash-preset-new']();
    await tick(10);
    const inp = q('#prompt-input'); if (inp) inp.value = '领导视角';
  });
  await step(h, 'dash-sec-add 新增工作台区域', async () => {
    S.ACTIONS['dash-sec-add']();
    await tick(10);
    const inp = q('#prompt-input'); if (inp) inp.value = '新区域';
  });
  await step(h, 'dash-config-reset 恢复默认编排', () => S.ACTIONS['dash-config-reset']());

  console.log('\n■ 六、批量与体检类');
  await step(h, 'batch-delete 批量删除任务', async () => {
    S.setPage('tasks');
    S.ACTIONS['sel-row']({ id: 'T1' }, { checked: true });
    await tick(5);
    await S.ACTIONS['batch-delete']();
  });
  await step(h, 'orphan-assign 批量指派未归属任务', async () => {
    const t = S.byId('task', 'T4'); if (t) { t.owner = ''; S.stampMeta(t); }
    await S.Repo.persist(S.DB); await tick(10);
    S.ACTIONS['orphan-assign']();
    await tick(10);
    const el = q('#oa-owner'); if (el) el.value = '测试管理员';
  });
  await step(h, 'clear-test 清除测试任务', async () => {
    const t = S.byId('task', 'T4'); if (t) { t.custom = '测试'; S.stampMeta(t); }
    await S.Repo.persist(S.DB); await tick(10);
    S.ACTIONS['clear-test']();
  });

  console.log('\n■ 七、收尾：整机一致性');
  {
    const F = fileOf(h);
    ok('★最终本机与共享文件完全一致', diffDbVsFile(F).length === 0, diffDbVsFile(F).slice(0, 5));
    ok('★没有"改动还没同步出去"的积压', !S.DB.settings.pendingSync);
    const alive = new Set(F.tasks.filter(t => !t.deleted_at).map(t => t.id));
    ok('★没有无主里程碑', !(F.milestones || []).some(m => !m.deleted_at && m.task && !F.tasks.some(t => t.id === m.task)));
    let crash = '';
    try { ['tasks', 'works', 'charts', 'data', 'logs'].forEach(p => { S.setPage(p); S.renderPage(); }); S.renderDashboard(); }
    catch (e) { crash = e.message; }
    ok('★每一页都还渲染得出来', !crash, crash);
  }

  console.log('\n' + '='.repeat(56));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('异常：', e); process.exit(1); });
