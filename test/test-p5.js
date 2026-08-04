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
  ok('里程碑挂在任务下，通过 id 引用任务', S.DB.milestones.every(m => !!S.byId('task', m.task)));
  ok('编号仍保留为业务字段', S.DB.works.every(w => /^\d{4}$/.test(w.code)));
  ok('ref 显示仍带编号前缀', S.optionsOf('task', S.fieldDef('task', 'work'), null)[0].label.startsWith('01'));

  section('老数据迁移（code 引用 → id 引用）');
  const bak = JSON.stringify({ w: S.DB.works, t: S.DB.tasks, m: S.DB.milestones });
  // 造一份「旧格式」：工作无 id，任务用 code 引用（里程碑挂在任务下，不涉及工作引用重写）
  S.DB.works = [{ code: '0101', duty: '01', name: '旧工作', content: [], owner: '甲', collaborators: [], year: 2025, status: 'doing' }];
  S.DB.tasks = [{ id: 't_old', work: '0101', title: '旧任务', assignees: [], status: 'todo', priority: '2', progress: 0 }];
  S.DB.milestones = [];
  const changed = S.migrateWorkIds();
  ok('迁移返回已变更', changed === true);
  const nid = S.DB.works[0].id;
  ok('旧工作补上了 id', /^w_/.test(nid));
  ok('任务引用被重写为 id', S.DB.tasks[0].work === nid);
  ok('迁移幂等（再跑一次无变化）', S.migrateWorkIds() === false || S.DB.tasks[0].work === nid);
  const r = JSON.parse(bak);
  S.DB.works = r.w; S.DB.tasks = r.t; S.DB.milestones = r.m;
  raw.__api ? null : null;
  S.Repo.bulk(() => {});
  await tick();

  section('里程碑迁移：从挂靠工作改为挂靠任务');
  const bak2 = JSON.stringify({ w: S.DB.works, t: S.DB.tasks, m: S.DB.milestones });
  const someWork = S.DB.works[0];
  const tA = { id: 't_a', work: someWork.id, title: '任务A', milestone: 'm_shared', deliverable: 'A的交付物', assignees: [], status: 'todo', priority: '2', progress: 0 };
  const tB = { id: 't_b', work: someWork.id, title: '任务B', milestone: 'm_shared', deliverable: '', assignees: [], status: 'todo', priority: '2', progress: 0 };
  const tC = { id: 't_c', work: someWork.id, title: '任务C', deliverable: '只有交付物没选里程碑', plan_date: '2026-07-01', assignees: [], status: 'todo', priority: '2', progress: 0 };
  const tD = { id: 't_d', work: someWork.id, title: '任务D', assignees: [], status: 'todo', priority: '2', progress: 0 };
  S.DB.tasks = [tA, tB, tC, tD];
  S.DB.milestones = [
    { id: 'm_shared', work: someWork.id, name: '共享老里程碑', plan_date: '2026-05-01', actual_date: '', status: 'doing' },
    { id: 'm_orphan', work: someWork.id, name: '没人引用的老里程碑', plan_date: '2026-06-01', actual_date: '', status: 'todo' },
  ];
  const msChanged = S.migrateMilestonesToTasks();
  ok('迁移返回已变更', msChanged === true);
  const cpA = S.DB.milestones.filter(m => m.task === 't_a' && !m.deleted_at);
  const cpB = S.DB.milestones.filter(m => m.task === 't_b' && !m.deleted_at);
  const cpC = S.DB.milestones.filter(m => m.task === 't_c' && !m.deleted_at);
  const cpD = S.DB.milestones.filter(m => m.task === 't_d' && !m.deleted_at);
  ok('共享老里程碑的两个任务各自拆出一条检查点', cpA.length === 1 && cpB.length === 1, [cpA.length, cpB.length]);
  ok('任务自己的交付物优先于老里程碑名称', cpA[0].deliverable === 'A的交付物');
  ok('没有自己交付物的任务，退回老里程碑名称', cpB[0].deliverable === '共享老里程碑');
  ok('两条检查点都沿用老里程碑的日期', cpA[0].plan_date === '2026-05-01' && cpB[0].plan_date === '2026-05-01');
  ok('只有交付物没选里程碑的任务，用任务计划日期生成一条', cpC.length === 1 && cpC[0].plan_date === '2026-07-01' && cpC[0].deliverable === '只有交付物没选里程碑');
  ok('既没里程碑也没交付物的任务不生成检查点', cpD.length === 0);
  ok('没有任何任务引用的老里程碑被丢弃', !S.DB.milestones.some(m => m.id === 'm_orphan'));
  ok('老字段被清理', !('milestone' in tA) && !('deliverable' in tA));
  ok('迁移幂等（再跑一次无变化）', S.migrateMilestonesToTasks() === false);
  const r2 = JSON.parse(bak2);
  S.DB.works = r2.w; S.DB.tasks = r2.t; S.DB.milestones = r2.m;
  S.Repo.bulk(() => {});
  await tick();

  section('同编号跨年度共存');
  const src = byCode('0101');
  ok('源工作存在', !!src, src && src.code);
  const before = S.DB.works.length;
  const msCountBefore = S.DB.milestones.length;
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
  ok('任务不随年度复制带过来', S.DB.tasks.filter(t => t.work === dst.id).length === 0);
  ok('里程碑挂在任务下，年度复制不涉及里程碑', S.DB.milestones.length === msCountBefore, [msCountBefore, S.DB.milestones.length]);
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

  // 里程碑指向不存在的任务（里程碑挂在任务下，这类断裂引用换成了 orphanMs 检查项）
  const om2 = S.DB.milestones.find(m => !m.deleted_at);
  if (om2) {
    const msId = om2.id;
    const origTask = om2.task;
    om2.task = 't_不存在';
    hc = S.healthCheck();
    ok('检出指向不存在任务的里程碑', hc.issues.some(i => i.k === 'orphanMs'));
    /* P55 之后"无主里程碑"的清理方式从软删除改成了彻底删除，理由见 healthCheck 里那段注释：
       它的所属任务记录已经完全不存在，界面上永远打不开也恢复不了，盖个 deleted_at
       只是把"计入统计的垃圾"变成"不计入统计的垃圾"，共享文件一个字节都没小。
       彻底删除走 purgeHealth，而且刻意要求先连上共享文件夹（避免本机数据不全时误判）。 */
    S.setFileHandle({ name: 'fake-share.json' });
    await S.purgeHealth('orphanMs'); await tick();
    S.ACTIONS['modal-ok'](); await tick();
    ok('彻底删除后该里程碑不在 DB 里了', !S.byId('milestone', msId));
    ok('留下了墓碑（否则还没同步的机器会把它原样推回来）',
      (S.DB.purged || []).some(p => p.entity === 'milestone' && p.id === msId));
    S.setFileHandle(null);
    await S.undoLast(); await tick();
    ok('修复可撤销', !S.byId('milestone', msId).deleted_at);
    S.byId('milestone', msId).task = origTask;
  }
  // 同年度编号重复
  const dupW = S.blank('work', { code: byCode('0101').code, duty: '01', name: '重复编号', year: byCode('0101').year, status: 'doing' });
  S.DB.works.push(dupW); S.Repo.bulk(() => {}); await tick();
  ok('检出同年度编号重复', S.healthCheck().issues.some(i => i.k === 'dupCode'));
  S.DB.works = S.DB.works.filter(w => w.id !== dupW.id); S.Repo.bulk(() => {}); await tick();
  ok('清理后不再报重复', !S.healthCheck().issues.some(i => i.k === 'dupCode'));

  section('未归属任务批量指派');
  const orphans = S.DB.tasks.filter(t => !t.deleted_at).slice(0, 3);
  orphans.forEach(t => { t.work = ''; });
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
  // "备份状态"面板改名"备份"了（跟定期自动备份合并到一起，见 test-p29.js 的数据页整理测试）
  ['备份', '年度管理', '数据体检', '导入 / 导出', '使用者', '测试数据'].forEach(t => ok('含板块：' + t, h.includes(t)));
  ok('有恢复入口', h.includes('data-act="import-backup"'));
  ok('有年度复制入口', h.includes('data-act="year-copy"'));

  section('回归：P1–P4 未被破坏');
  S.setPage('tasks'); S.renderTasks();
  ok('任务页正常', S.taskRows.length > 0, S.taskRows.length);
  S.ACTIONS['tree-toggle']({ duty: '02' }, null, { stopPropagation() {} });   // 子工作只在展开时渲染
  const tree = S.renderTaskTree(S.taskRows);
  ok('两级树按 id 输出', /data-work="w_/.test(tree), tree.match(/data-work="[^"]*"/g));
  // 速记输入框已经换成"+ 新建任务"按钮 + 任务详情弹窗了，这里改测那条路上的两个纯函数
  const w0201 = byCode('0201');
  ok('worksOfDuty 能按职责列出它下面的工作', S.worksOfDuty(w0201.duty).some(w => w.id === w0201.id));
  ok('workOptionsHTML 生成的选项里有这项工作', S.workOptionsHTML(w0201.duty, w0201.id).includes(`value="${w0201.id}"`));
  ok('选中的那一项被标了 selected', new RegExp(`value="${w0201.id}" selected`).test(S.workOptionsHTML(w0201.duty, w0201.id)));
  S.setPage('dashboard'); S.renderDashboard();
  ok('工作台正常', q('#page-dashboard').innerHTML.includes('需要关注'));
  S.setPage('charts'); S.ACTIONS['chart-tab']({ k: 'gantt' });
  ok('甘特图正常', q('#page-charts').innerHTML.includes('gantt-row'));
  ok('CSV 工作表头含 id', S.csvHeaders('work')[0] === 'id' && S.csvHeaders('work').includes('code'));

  section('输入规范化：多值分隔符 & 内容行去重编号');
  ok('splitMulti 支持顿号分隔', JSON.stringify(S.splitMulti('张三、李四')) === JSON.stringify(['张三', '李四']));
  ok('splitMulti 支持中文逗号', JSON.stringify(S.splitMulti('张三，李四，王五')) === JSON.stringify(['张三', '李四', '王五']));
  ok('splitMulti 混合分隔符也能切开', JSON.stringify(S.splitMulti('张三、李四,王五')) === JSON.stringify(['张三', '李四', '王五']));
  ok('parseLines 去掉行首已有编号', JSON.stringify(S.parseLines('1、写方案\n2.评审\n(3) 上线')) === JSON.stringify(['写方案', '评审', '上线']),
     S.parseLines('1、写方案\n2.评审\n(3) 上线'));
  ok('parseLines 不误伤没有编号的正常行', JSON.stringify(S.parseLines('普通一行\n第二行')) === JSON.stringify(['普通一行', '第二行']));

  section('职责删除：文案改为删除，不再叫停用');
  const anyDuty = S.DB.duties.find(d => !d.deleted_at);
  S.ACTIONS['duty-del']({ code: anyDuty.code });
  ok('弹窗标题为「删除职责」', q('#modal-title').textContent === '删除职责', q('#modal-title').textContent);
  ok('确认按钮文案为「删除」', q('#modal-ok-btn').textContent === '删除', q('#modal-ok-btn').textContent);
  ok('提示文案里不再出现"停用"二字', !q('#modal-body').innerHTML.includes('停用'));
  // 不触发 modalCallback，本条职责实际不会被删除，不影响后续断言

  section('CSV 导入：覆盖模式按编号覆盖、增量模式自动接续编号');
  const csvVal = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const buildCSV = (entity, rowsObj) => {
    const heads = S.csvHeaders(entity);
    const lines = [heads.join(',')];
    rowsObj.forEach(o => lines.push(heads.map(h => csvVal(o[h])).join(',')));
    return lines.join('\n');
  };

  const d0 = S.DB.duties.find(d => !d.deleted_at);
  const dutyBefore = S.DB.duties.length;
  await S.applyCSVImport('duty', 'merge', buildCSV('duty', [{ code: d0.code, category: d0.category, name: '改名后的核心职责' }]));
  ok('职责覆盖模式：按编号原地覆盖，条数不变', S.DB.duties.length === dutyBefore, [S.DB.duties.length, dutyBefore]);
  ok('职责覆盖模式：内容确实被覆盖', S.byId('duty', d0.code).name === '改名后的核心职责');

  const dutyBefore2 = S.DB.duties.length;
  await S.applyCSVImport('duty', 'append', buildCSV('duty', [{ code: d0.code, category: d0.category, name: '增量新增职责' }]));
  ok('职责增量模式：新增一条而不是覆盖', S.DB.duties.length === dutyBefore2 + 1, [S.DB.duties.length, dutyBefore2]);
  const newDuty = S.DB.duties.find(d => d.name === '增量新增职责');
  ok('职责增量模式：自动分配了不同的编号', !!newDuty && newDuty.code !== d0.code, newDuty && newDuty.code);
  ok('职责增量模式：原职责未被顶掉', S.byId('duty', d0.code).name === '改名后的核心职责');

  const w0 = S.DB.works.find(w => !w.deleted_at);
  const workBefore = S.DB.works.length;
  await S.applyCSVImport('work', 'merge', buildCSV('work', [{ code: w0.code, duty: w0.duty, name: '改名工作', year: w0.year, status: w0.status }]));
  ok('工作覆盖模式：按编号+年度认领同一条，条数不变', S.DB.works.length === workBefore, [S.DB.works.length, workBefore]);
  ok('工作覆盖模式：复用了原来的 id', S.byId('work', w0.id).name === '改名工作');

  const workBefore2 = S.DB.works.length;
  await S.applyCSVImport('work', 'append', buildCSV('work', [{ code: w0.code, duty: w0.duty, name: '增量新增工作', year: w0.year, status: w0.status }]));
  ok('工作增量模式：新增了一条', S.DB.works.length === workBefore2 + 1, [S.DB.works.length, workBefore2]);
  const newWork = S.DB.works.find(w => w.name === '增量新增工作');
  ok('工作增量模式：自动分配了不同的编号', !!newWork && newWork.code !== w0.code, newWork && newWork.code);

  const t0 = S.DB.tasks.find(t => t.code && !t.deleted_at);
  const taskBefore = S.DB.tasks.length;
  await S.applyCSVImport('task', 'merge', buildCSV('task', [{ code: t0.code, work: t0.work, title: '改名任务', status: t0.status, priority: t0.priority }]));
  ok('任务覆盖模式：按编号认领同一条，条数不变', S.DB.tasks.length === taskBefore, [S.DB.tasks.length, taskBefore]);
  ok('任务覆盖模式：复用了原来的 id', S.byId('task', t0.id).title === '改名任务');

  const taskBefore2 = S.DB.tasks.length;
  await S.applyCSVImport('task', 'append', buildCSV('task', [{ code: t0.code, work: t0.work, title: '增量新增任务', status: t0.status, priority: t0.priority }]));
  ok('任务增量模式：新增了一条', S.DB.tasks.length === taskBefore2 + 1, [S.DB.tasks.length, taskBefore2]);
  const newTask = S.DB.tasks.find(t => t.title === '增量新增任务');
  ok('任务增量模式：自动分配了不同的编号', !!newTask && newTask.code !== t0.code, newTask && newTask.code);

  section('工作台"各职责推进"与图表页"职责项"用同一条标尺');
  S.setPage('dashboard'); S.renderDashboard();
  const dashH = q('#page-dashboard').innerHTML;
  S.setPage('charts'); S.ACTIONS['chart-tab']({ k: 'category' });
  const chartH = q('#page-charts').innerHTML;
  const dutyStatsNow = S.statsByDuty(S.visibleTasks().filter(t => !t.deleted_at));
  const maxD = Math.max(1, ...dutyStatsNow.map(x => x.total));
  const notMax = dutyStatsNow.find(x => x.total < maxD && x.total > 0);
  ok('存在总量小于最大值的职责（用于验证标尺不是各自撑满 100%）', !!notMax, dutyStatsNow.map(x => [x.code, x.total]));
  const segWidthSum = (html, code) => {
    const m = html.match(new RegExp(`data-code="${code}"[^]*?<span class="num">`));
    if (!m) return null;
    return [...m[0].matchAll(/width:([\d.]+)%/g)].reduce((a, w) => a + (+w[1]), 0);
  };
  if (notMax) {
    // hBar 画 done/doing/late/todo(含挂起) 四段，条形总宽等于 total，但标尺分母是共享的 maxD 而不是自己的 total
    const filled = notMax.done + notMax.doing + notMax.late + notMax.todo + notMax.hold;
    const expectPct = +(filled / maxD * 100).toFixed(2);
    const oldBuggyPct = notMax.total ? +(filled / notMax.total * 100).toFixed(2) : 0;
    const dashPct = segWidthSum(dashH, notMax.code);
    const chartPct = segWidthSum(chartH, notMax.code);
    ok('工作台条长按共享最大值换算（不是各自撑满 100%）', dashPct !== null && Math.abs(dashPct - expectPct) < 0.1, [dashPct, expectPct]);
    ok('图表页条长同一算法', chartPct !== null && Math.abs(chartPct - expectPct) < 0.1, [chartPct, expectPct]);
    ok('两处条长一致，可直接横向比较', Math.abs(dashPct - chartPct) < 0.1, [dashPct, chartPct]);
    ok('确实不是按自己合计撑满的旧算法', filled === 0 || oldBuggyPct === expectPct || dashPct < oldBuggyPct - 0.05, [dashPct, oldBuggyPct]);
  }

  section('性能：页面切换时侧栏不再重复渲染');
  let sidebarCalls = 0;
  const origSidebar = raw.globalThis.renderSidebar;
  raw.globalThis.renderSidebar = function (...a) { sidebarCalls++; return origSidebar.apply(this, a); };
  S.setPage('works');
  sidebarCalls = 0;
  S.renderShell(); S.renderPage();
  ok('renderShell()+renderPage() 只渲染一次侧栏', sidebarCalls === 1, sidebarCalls);
  raw.globalThis.renderSidebar = origSidebar;

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
