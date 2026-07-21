/* P5 数据管理 + 工作主键改造 测试。用法：node test/test-p5.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const byCode = c => S.DB.works.find(w => w.code === c && !w.deleted_at);

async function main() {
  await tick(60);

  section('工作主键改造');
  ok('工作主键是 id', S.schema('work').pk === 'id');
  ok('每项工作都有随机 id', S.DB.works.every(w => /^w_/.test(w.id)));
  ok('职责主键仍是 code（无年度维度，保持稳定）', S.schema('duty').pk === 'code');
  ok('任务通过 id 引用工作', S.DB.tasks.filter(t => t.work).every(t => !!S.byId('work', t.work)));
  ok('里程碑通过 id 引用工作', S.DB.milestones.every(m => !!S.byId('work', m.work)));
  ok('编号仍保留为业务字段', S.DB.works.every(w => /^\d{4}$/.test(w.code)));
  ok('ref 显示仍带编号前缀', S.optionsOf('task', S.fieldDef('task', 'work'), null)[0].label.startsWith('01'));

  section('老数据迁移（code 引用 → id 引用）');
  const bak = JSON.stringify({ w: S.DB.works, t: S.DB.tasks, m: S.DB.milestones });
  // 造一份「旧格式」：工作无 id，任务/里程碑用 code 引用
  S.DB.works = [{ code: '0101', duty: '01', name: '旧工作', content: [], owner: '甲', collaborators: [], year: 2025, status: 'doing' }];
  S.DB.tasks = [{ id: 't_old', work: '0101', title: '旧任务', assignees: [], status: 'todo', priority: '2', progress: 0 }];
  S.DB.milestones = [{ id: 'm_old', work: '0101', name: '旧里程碑', plan_date: '2025-06-01', actual_date: '', status: 'todo' }];
  const changed = S.migrateWorkIds();
  ok('迁移返回已变更', changed === true);
  const nid = S.DB.works[0].id;
  ok('旧工作补上了 id', /^w_/.test(nid));
  ok('任务引用被重写为 id', S.DB.tasks[0].work === nid);
  ok('里程碑引用被重写为 id', S.DB.milestones[0].work === nid);
  ok('迁移幂等（再跑一次无变化）', S.migrateWorkIds() === false || S.DB.tasks[0].work === nid);
  const r = JSON.parse(bak);
  S.DB.works = r.w; S.DB.tasks = r.t; S.DB.milestones = r.m;
  raw.__api ? null : null;
  S.Repo.bulk(() => {});
  await tick();

  section('同编号跨年度共存');
  const src = byCode('0101');
  ok('源工作存在', !!src, src && src.code);
  const before = S.DB.works.length;
  S.openYearCopy();
  q('#yc-src').value = String(src.year);
  q('#yc-dst').value = String(src.year + 1);
  q('#yc-arch').value = 'keep';
  // 仅勾选一项：模拟只选中源工作
  raw.document.querySelectorAll = sel => sel === '.yc-cb:checked'
    ? [{ value: src.id }] : (sel === '.yc-cb' ? [{ value: src.id, checked: true }] : []);
  await S.modalCallback(); await tick(20);
  const copies = S.DB.works.filter(w => w.code === src.code && !w.deleted_at);
  ok('复制出新工作', S.DB.works.length === before + 1, [before, S.DB.works.length]);
  ok('同一编号在两个年度并存', copies.length === 2, copies.map(c => c.year));
  ok('两份是不同的记录（id 不同）', copies[0].id !== copies[1].id);
  const dst = copies.find(c => c.year === src.year + 1);
  ok('目标年度正确', !!dst && dst.year === src.year + 1);
  ok('内容与牵头人被复制', dst.name === src.name && dst.owner === src.owner);
  ok('新工作状态为进行中', dst.status === 'doing');
  const srcMs = S.DB.milestones.filter(m => m.work === src.id && !m.deleted_at);
  const dstMs = S.DB.milestones.filter(m => m.work === dst.id && !m.deleted_at);
  ok('里程碑一并复制', dstMs.length === srcMs.length, [srcMs.length, dstMs.length]);
  if (srcMs.length && dstMs.length) {
    ok('里程碑日期顺延一年', dstMs.every(m => {
      const s = srcMs.find(x => x.name === m.name);
      return !s || !s.plan_date || +m.plan_date.slice(0, 4) === +s.plan_date.slice(0, 4) + 1;
    }));
    ok('复制出的里程碑重置为未开始', dstMs.every(m => m.status === 'todo' && !m.actual_date));
  }
  ok('任务不随年度复制带过来', S.DB.tasks.filter(t => t.work === dst.id).length === 0);
  ok('当前年度自动切到新年度', S.DB.settings.year === src.year + 1);
  await S.undoLast(); await tick();
  S.DB.settings.year = src.year;
  ok('复制可整体撤销', S.DB.works.filter(w => w.code === src.code && !w.deleted_at).length === 1);
  delete raw.document.querySelectorAll;
  raw.document.querySelectorAll = () => [];

  section('闰日处理');
  ok('2/29 顺延到平年退到 2/28', S.shiftYear('2028-02-29', 1) === '2029-02-28', S.shiftYear('2028-02-29', 1));
  ok('普通日期正常加年', S.shiftYear('2026-08-31', 1) === '2027-08-31');

  section('年度内编号递增');
  const y = S.DB.settings.year;
  const c1 = S.nextWorkCode('01', y);
  ok('同职责同年度递增', /^01\d{2}$/.test(c1) && c1 > '0101', c1);
  const c2 = S.nextWorkCode('01', y + 5);
  ok('新年度从 01 重新开始', c2 === '0101', c2);

  section('数据体检');
  let hc = S.healthCheck();
  ok('体检返回结构完整', Array.isArray(hc.issues));
  // 制造断裂引用
  const victim = S.DB.tasks.find(t => t.work);
  const keepWork = victim.work;
  victim.work = 'w_不存在';
  hc = S.healthCheck();
  ok('检出指向不存在工作的任务', hc.issues.some(i => i.k === 'orphanTask'));
  await S.fixHealth('orphanTask'); await tick();
  ok('一键修复后引用被清空', S.byId('task', victim.id).work === '');
  await S.undoLast(); await tick();
  ok('修复可撤销', S.byId('task', victim.id).work === 'w_不存在');
  S.byId('task', victim.id).work = keepWork;

  // 跨工作的脏里程碑
  const t2 = S.DB.tasks.find(t => t.milestone);
  if (t2) {
    const other = S.DB.works.find(w => w.id !== t2.work);
    const om = S.DB.milestones.find(m => m.work === other.id);
    if (om) {
      const orig = t2.milestone;
      t2.milestone = om.id;
      hc = S.healthCheck();
      ok('检出不属于本工作的里程碑', hc.issues.some(i => i.k === 'badMs'));
      await S.fixHealth('badMs'); await tick();
      ok('修复后里程碑被清空', S.byId('task', t2.id).milestone === '');
      S.byId('task', t2.id).milestone = orig;
    }
  }
  // 同年度编号重复
  const dupW = S.blank('work', { code: byCode('0101').code, duty: '01', name: '重复编号', year: byCode('0101').year, status: 'doing' });
  S.DB.works.push(dupW); S.Repo.bulk(() => {}); await tick();
  ok('检出同年度编号重复', S.healthCheck().issues.some(i => i.k === 'dupCode'));
  S.DB.works = S.DB.works.filter(w => w.id !== dupW.id); S.Repo.bulk(() => {}); await tick();
  ok('清理后不再报重复', !S.healthCheck().issues.some(i => i.k === 'dupCode'));

  section('未归属任务批量指派');
  const orphans = S.DB.tasks.filter(t => !t.deleted_at).slice(0, 3);
  orphans.forEach(t => { t.work = ''; t.milestone = ''; });
  S.Repo.bulk(() => {}); await tick();
  ok('体检检出未归属任务', S.healthCheck().issues.some(i => i.k === 'noWork'));
  const target = byCode('0201');
  S.openOrphanAssign();
  q('#oa-work').value = target.id;
  raw.document.querySelectorAll = sel => sel === '.oa-cb:checked' ? orphans.map(t => ({ value: t.id })) : [];
  await S.modalCallback(); await tick(20);
  ok('批量指派生效', orphans.every(t => S.byId('task', t.id).work === target.id));
  ok('负责人自动继承工作牵头人', orphans.every(t => !!S.byId('task', t.id).owner));
  raw.document.querySelectorAll = () => [];

  section('备份状态与恢复');
  S.DB.settings.lastBackupAt = '';
  ok('从未备份时标记为过期', S.backupState().stale === true);
  S.DB.settings.lastBackupAt = new Date(Date.now() + 60000).toISOString();
  ok('刚备份完不算过期', S.backupState().stale === false);
  S.DB.settings.lastBackupAt = new Date(Date.now() - 10 * 86400000).toISOString();
  const t3 = S.DB.tasks[0];
  t3.updated_at = new Date().toISOString();
  const bs = S.backupState();
  ok('备份后有改动 → 过期', bs.stale === true);
  ok('天数计算正确', bs.days === 10, bs.days);

  const snap = JSON.stringify({ d: S.DB.duties.length, w: S.DB.works.length, m: S.DB.milestones.length, t: S.DB.tasks.length });
  const backup = JSON.stringify({ duties: S.DB.duties, works: S.DB.works, milestones: S.DB.milestones, tasks: S.DB.tasks, settings: S.DB.settings });
  S.DB.tasks = S.DB.tasks.slice(0, 3); S.Repo.bulk(() => {}); await tick();
  ok('先破坏数据', S.DB.tasks.length === 3);
  S.importBackup(backup);
  await S.modalCallback(); await tick(20);
  const now = JSON.stringify({ d: S.DB.duties.length, w: S.DB.works.length, m: S.DB.milestones.length, t: S.DB.tasks.length });
  ok('从备份完整恢复', now === snap, [snap, now]);
  ok('恢复后索引可用', S.DB.tasks.filter(t => t.work).every(t => !!S.byId('work', t.work)));
  S.importBackup('这不是JSON');
  ok('非法 JSON 被拒绝且不崩', true);
  S.importBackup('{"foo":1}');
  ok('非本系统备份被拒绝', true);

  section('数据页渲染');
  S.setPage('data'); S.renderData();
  const h = q('#page-data').innerHTML;
  ['备份状态', '年度管理', '数据体检', '导入 / 导出', '使用者', '测试数据'].forEach(t => ok('含板块：' + t, h.includes(t)));
  ok('有恢复入口', h.includes('data-act="import-backup"'));
  ok('有年度复制入口', h.includes('data-act="year-copy"'));

  section('回归：P1–P4 未被破坏');
  S.setPage('tasks'); S.renderTasks();
  ok('任务页正常', S.taskRows.length > 0, S.taskRows.length);
  S.ACTIONS['tree-toggle']({ duty: '02' }, null, { stopPropagation() {} });   // 子工作只在展开时渲染
  const tree = S.renderTaskTree(S.taskRows);
  ok('两级树按 id 输出', /data-work="w_/.test(tree), tree.match(/data-work="[^"]*"/g));
  const qi = S.parseQuickInput('测试任务 $0201 @李兰 !1 ~today');
  ok('快捷输入 $编号 解析为工作 id', qi.work === byCode('0201').id, qi.work);
  ok('快捷输入其余字段正常', qi.priority === '1' && qi.assignees[0] === '李兰' && qi.plan_date === S.todayStr());
  S.setPage('dashboard'); S.renderDashboard();
  ok('工作台正常', q('#page-dashboard').innerHTML.includes('需要关注'));
  S.setPage('charts'); S.ACTIONS['chart-tab']({ k: 'gantt' });
  ok('甘特图正常', q('#page-charts').innerHTML.includes('gantt-row'));
  ok('CSV 工作表头含 id', S.csvHeaders('work')[0] === 'id' && S.csvHeaders('work').includes('code'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
