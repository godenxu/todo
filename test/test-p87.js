/* P87：结构化变更日志 + 「按日志核对/修复数据」+ 机器时钟偏差检测
   配套 P86（同步合并的根因修复）：合并机制修好了，但已经被覆盖掉的历史数据要能查出来、
   能按日志改回去；另外时钟不同步是判错胜负的另一半原因，至少要能发现。
   用法：node test/test-p87.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);
  const bakMe = S.DB.settings.me;
  S.DB.settings.me = '测试管理员';
  S.DB.changelog.length = 0;

  await S.Repo.upsert('duty', { code: 'P87D', name: 'P87职责' });
  await S.Repo.upsert('work', { id: 'p87_w', duty: 'P87D', code: '8701', name: 'P87工作', owner: '测试管理员' });
  await S.Repo.upsert('task', { id: 'p87_t', work: 'p87_w', title: 'P87任务', status: 'todo', priority: '2',
    owner: '测试管理员', assignees: [], plan_date: '2026-12-01' });
  S.rebuildIndex();

  section('①：★变更日志开始带「机器可读」的字段明细');
  const t = S.byId('task', 'p87_t');
  let before = JSON.parse(JSON.stringify(t));
  t.status = 'done';
  S.logRecordChange('task', 'p87_t', before, t, ['status']);
  const last = S.DB.changelog[S.DB.changelog.length - 1];
  ok('★人话摘要照旧（不影响现有日志页显示）', last.summary === '状态：未开始→已完成', last.summary);
  ok('★同时带上了结构化明细', Array.isArray(last.changes) && last.changes.length === 1, last.changes);
  ok('★明细里是原始值，不是显示文字——修复时要拿它写回记录',
    last.changes[0].k === 'status' && last.changes[0].from === 'todo' && last.changes[0].to === 'done', last.changes[0]);

  section('①：明细的两个上限——别把共享文件撑大');
  const longVal = 'x'.repeat(300);
  const c1 = S.diffRecordChanges('task', { title: '短' }, { title: longVal }, ['title']);
  ok('★超长的值不进结构化明细（人话摘要里仍然有）', c1.length === 0, c1);
  ok('虚拟字段不进明细', S.diffRecordChanges('task', { checkpoints: 'a' }, { checkpoints: 'b' }, ['checkpoints']).length === 0);
  ok('值没变就不记', S.diffRecordChanges('task', { status: 'todo' }, { status: 'todo' }, ['status']).length === 0);

  section('②：★核对——日志说改成了 A、现在却是 B，要能查出来（就是这次事故的场景）');
  t.status = 'todo';    // 模拟被开着旧页面的同事顶回去（不写日志）
  const issues = S.auditByChangelog();
  ok('★查出了 1 处对不上', issues.length === 1, issues.length);
  const it = issues[0];
  ok('★指明了是哪条记录、哪个字段', it.id === 'p87_t' && it.field === 'status' && it.title === 'P87任务', it);
  ok('★写清楚了"日志说应该是什么"和"现在实际是什么"', it.to === 'done' && it.now === 'todo', { to: it.to, now: it.now });
  ok('★带上了日志记录人和时间，便于追查', !!it.by && !!it.at, { by: it.by, at: it.at });

  section('②：核对的边界——不能乱报');
  t.status = 'done';    // 改回去
  ok('★对得上就不报', S.auditByChangelog().length === 0);
  t.status = 'todo';
  t.deleted_at = new Date().toISOString();
  ok('★已删除的记录不参与核对', S.auditByChangelog().length === 0);
  delete t.deleted_at;
  const bakLog = S.DB.changelog.slice();
  S.DB.changelog.length = 0;
  S.DB.changelog.push({ id: 'old1', at: '2026-01-01T00:00:00.000Z', by: '老王', kind: 'edit',
    entity: 'task', refId: 'p87_t', taskId: 'p87_t', summary: '状态：未开始→已完成' });   // 老日志，没有 changes
  ok('★老日志（只有文字描述、没有明细）不参与核对，也不报错', S.auditByChangelog().length === 0);
  S.DB.changelog.length = 0;
  bakLog.forEach(e => S.DB.changelog.push(e));

  section('②：同一字段有多条日志时，以最后一条为准');
  let b2 = JSON.parse(JSON.stringify(t));
  t.status = 'doing';
  S.logRecordChange('task', 'p87_t', b2, t, ['status']);   // 最新一条说应该是 doing
  t.status = 'hold';                                       // 实际却是 hold
  const issues2 = S.auditByChangelog();
  ok('★按最新那条日志判定', issues2.length === 1 && issues2[0].to === 'doing', issues2[0]);

  section('③：★按日志修复——改回去、留痕、可撤销、能同步出去');
  const revBefore = S.byId('task', 'p87_t').rev;
  const logCountBefore = S.DB.changelog.length;
  // P102 起返回的不再是条数，而是一份交代：{ok 真正改好了几处, stuck 写进去又被改回的, skipped 改不动的}
  const n = await S.repairByChangelog(S.auditByChangelog());
  const after = S.byId('task', 'p87_t');
  ok('★修了 1 处', n.ok === 1 && n.stuck.length === 0, n);
  ok('★值按日志改回去了', after.status === 'doing', after.status);
  ok('★版本号抬高了——这样才推得到共享文件、同事那边才收得到', after.rev > revBefore, { before: revBefore, after: after.rev });
  ok('★修复动作本身也写进了日志（不能悄悄改数据）', S.DB.changelog.length > logCountBefore);
  const fixLog = S.DB.changelog[S.DB.changelog.length - 1];
  ok('★日志里说明了修复依据', fixLog.summary.includes('按日志修复'), fixLog.summary);
  ok('★修完再核对就干净了', S.auditByChangelog().length === 0);

  section('③：修复的幂等性与安全边界');
  ok('★没有要修的时候返回 0，不乱动数据', (await S.repairByChangelog([])).ok === 0);
  const ghost = [{ entity: 'task', id: '不存在的任务', field: 'status', to: 'done', at: '', by: '' }];
  const gr = await S.repairByChangelog(ghost);
  ok('★记录已经不在了也不会抛异常', gr.ok === 0 && gr.stuck.length === 0, gr);

  section('④：核对面板的渲染');
  S.setAuditIssues([]); S.setAuditShown(true);
  ok('★没问题时给的是"全部对得上"', S.auditPanelHTML().includes('全部对得上'));
  t.status = 'todo';
  S.setAuditIssues(S.auditByChangelog());
  const html = S.auditPanelHTML();
  ok('★有问题时列出了表格', html.includes('<table') && html.includes('P87任务'));
  ok('★同时说明了"对不上不等于一定出错"，避免管理员误修', html.includes('不等于一定出错'));
  ok('★管理员能看到修复按钮', html.includes('data-act="logs-audit-fix"'));

  section('④：没有批量操作权限的人只能看，不能修');
  S.DB.users.push({ name: 'P87员工', role: 'staff', salt: 's', hash: 'h', iterations: 1 });
  S.DB.permissionMatrix = { staff: Object.assign({}, S.DEFAULT_PERMISSION_MATRIX.staff, { bulk_ops: false, view_logs: true }),
    comanager: S.DEFAULT_PERMISSION_MATRIX.comanager, director: S.DEFAULT_PERMISSION_MATRIX.director };
  const bakMe2 = S.DB.settings.me;
  S.DB.settings.me = 'P87员工';
  const staffHtml = S.auditPanelHTML();
  ok('★员工看不到修复按钮', !staffHtml.includes('data-act="logs-audit-fix"'));
  ok('★并且明确告诉他找管理员', staffHtml.includes('找管理员'));
  S.setSnackPriorityUntil(0);
  S.ACTIONS['logs-audit-fix']();
  ok('★就算直接触发这个动作也会被权限拦下', q('#snack-msg').textContent.includes('权限'), q('#snack-msg').textContent);
  S.DB.settings.me = bakMe2;
  S.DB.permissionMatrix = null;

  section('⑤：★机器时钟偏差检测');
  S.setClockSkewWarned(false);
  S.setSnackPriorityUntil(0);
  const logN = S.DB.changelog.length;
  S.checkClockSkew({ lastWriteAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), lastWriteBy: '同事甲' });
  ok('★文件里的写入时间比本机"现在"晚半小时 → 报出来', S.DB.changelog.length === logN + 1);
  const skewLog = S.DB.changelog[S.DB.changelog.length - 1];
  ok('★是告警类型', skewLog.kind === 'alert');
  ok('★说清楚了差多少、是谁那台机器、以及为什么要紧',
    skewLog.summary.includes('分钟') && skewLog.summary.includes('同事甲') && skewLog.summary.includes('判错'), skewLog.summary);
  const logN2 = S.DB.changelog.length;
  S.checkClockSkew({ lastWriteAt: new Date(Date.now() + 40 * 60 * 1000).toISOString(), lastWriteBy: '同事乙' });
  ok('★一次会话只提醒一次，不刷屏', S.DB.changelog.length === logN2);
  S.setClockSkewWarned(false);
  const logN3 = S.DB.changelog.length;
  S.checkClockSkew({ lastWriteAt: new Date(Date.now() + 60 * 1000).toISOString(), lastWriteBy: '同事丙' });
  ok('★1 分钟的正常漂移不报（阈值 5 分钟）', S.DB.changelog.length === logN3);
  S.checkClockSkew({});
  S.checkClockSkew({ lastWriteAt: '不是时间' });
  ok('★缺字段/格式不对时安静跳过，不抛异常', S.DB.changelog.length === logN3);

  S.DB.settings.me = bakMe;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
