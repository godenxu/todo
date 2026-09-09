/* P101：第十二轮排查——"批量 / 导入"这一整类动作全都不留痕

   这一轮换的切法：不再从同步层往上查，改成从【界面动作】那一端往下查，
   而且用一条不需要逐个动作写期望值的通用判据——
   "一台机器、没有同事并发写入时，做完任何一个改数据的动作，本机和共享文件必须一模一样"。
   照着这条判据把 30 多个动作点了一遍（scratchpad/sim11.js），再让机器随机点几百轮
   （sim12.js，含离线分叉和写入竞争），同步这一层没查出问题。

   真正查出来的是另一类：★ 这些动作改完之后，变更日志里一个字都没有 ★

     · 批量删除任务          · 批量彻底删除任务
     · 批量指派未归属任务    · 复制到新年度
     · CSV 导入（覆盖模式会整条覆盖已有记录）
     · 任务+里程碑宽表导入（覆盖模式会把任务现有的里程碑全部替换）
     · 工作的「主要工作内容」（唯一一个走多行文本编辑器的字段）

   为什么这属于"数据同步"要管的事，而不只是"日志不全"：

   1) 单条删除早就在记了，而且代码注释里把道理写死了——不记的话"看不出是谁删的、
      什么时候删的，在按时间倒序的日志里根本翻不到"。批量删除是同一件事的放大版，
      一次少掉几十条，反而不记。
   2) 「合并熔断」发现一次同步删掉一大片时会弹告警，让人"到日志页确认，不对可以一键回滚"。
      如果那批删除来自批量删除或导入，日志页是空的，这句提示就成了空话。
   3) 「按日志核对数据」是同事排查"我改的东西怎么又变回去了"唯一的工具，它只认带
      逐字段明细的记录。工作的「主要工作内容」是内容最长、被旧页面顶回去损失最大的字段，
      却恰好是唯一一个连明细都不记的编辑入口——实测连着改几十次，日志里一条都没有。

   用法：node test/test-p101.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 500) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 12) => new Promise(r => setTimeout(r, ms));

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });

function mkHandle(text) {
  const h = {
    name: 'shared.json', _text: text, _mtime: 1, _writes: 0,
    async getFile() { const snap = h._text; return { lastModified: h._mtime, text: async () => snap }; },
    async createWritable() {
      return { async write(t) { h._p = t; }, async close() { h._writes++; h._text = h._p; h._mtime++; } };
    },
  };
  return h;
}
const fileOf = h => JSON.parse(h._text);

let _h = null;
function reset() {
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '规划', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一', owner: '测试管理员', year: 2026 }))];
  S.DB.tasks = []; S.DB.milestones = []; S.DB.changelog = []; S.DB.purged = [];
  for (let i = 1; i <= 5; i++) {
    S.DB.tasks.push(S.stampMeta(S.blank('task', { id: 'T' + i, work: 'w1', code: '010126' + i,
      title: '任务' + i, owner: '测试管理员', status: 'todo', plan_date: '2026-10-0' + i, priority: '2' })));
  }
  S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', deliverable: '交付物一', plan_date: '2026-10-09' })));
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.DB.settings.me = '测试管理员';
  S.undoStack.length = 0;
  S.setSnackPriorityUntil(0);
  S.rebuildIndex();
  _h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'] })));
  S.setFileHandle(_h);
  S.setEverConnected(true);
}
async function confirmIfAny() {
  for (let i = 0; i < 3; i++) {
    if (!q('#modal-overlay').classList.contains('show')) break;
    const cb = S.modalCallback;
    if (typeof cb !== 'function') break;
    await cb();
    await tick(8);
  }
  if (q('#modal-overlay').classList.contains('show')) S.closeModal();
}
// 这次动作往日志里新添的条目
const logsSince = n => (S.DB.changelog || []).slice(n);
const textOf = e => String(e && (e.summary || e.text || ''));
const hit = (list, kw) => list.filter(e => textOf(e).indexOf(kw) !== -1);

async function main() {
  await tick(120);

  section('一、批量删除任务');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(15);
    const n0 = S.DB.changelog.length;
    S.setPage('tasks');
    ['T1', 'T2', 'T3'].forEach(id => S.ACTIONS['sel-row']({ id }, { checked: true }));
    await tick(8);
    S.ACTIONS['batch-delete']();
    await confirmIfAny();
    await tick(20);
    const added = logsSince(n0);
    const m = hit(added, '批量删除');
    ok('★★批量删除留下了一条查得到的日志（原来一条都没有）', m.length === 1, added.map(textOf));
    ok('★日志里写明了条数', m.length === 1 && /批量删除了 3 条任务/.test(textOf(m[0])), m.map(textOf));
    ok('★日志里点了名，事后翻得出删的是哪几条', m.length === 1 && textOf(m[0]).indexOf('「任务1」') !== -1);
    ok('★★这条日志真的推进了共享文件（只留在本机等于没有）',
      (fileOf(_h).changelog || []).some(e => textOf(e).indexOf('批量删除了 3 条任务') !== -1));
    ok('回归：任务确实被删了', ['T1', 'T2', 'T3'].every(id => (S.byId('task', id) || {}).deleted_at));
  }

  section('二、批量彻底删除任务');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(15);
    const n0 = S.DB.changelog.length;
    S.setPage('tasks');
    ['T4', 'T5'].forEach(id => S.ACTIONS['sel-row']({ id }, { checked: true }));
    await tick(8);
    S.ACTIONS['batch-purge']();
    await confirmIfAny();
    await tick(20);
    const m = hit(logsSince(n0), '批量彻底删除');
    ok('★★批量彻底删除留下了日志', m.length === 1, logsSince(n0).map(textOf));
    ok('★写明了条数并点了名', m.length === 1 && /批量彻底删除了 2 条任务/.test(textOf(m[0])) && textOf(m[0]).indexOf('「任务4」') !== -1);
    ok('★推进了共享文件', (fileOf(_h).changelog || []).some(e => textOf(e).indexOf('批量彻底删除了 2 条任务') !== -1));
    ok('回归：记录确实没了，而且留了墓碑', !S.byId('task', 'T4') && S.DB.purged.some(p => p.id === 'T4' && !S.purgeIsUndone(p)));
  }

  section('三、批量指派未归属任务');
  {
    reset();
    S.DB.tasks.forEach(t => { t.work = ''; S.stampMeta(t); });
    S.rebuildIndex();
    await S.Repo.persist(S.DB); await tick(15);
    const n0 = S.DB.changelog.length;
    S.ACTIONS['orphan-assign']();
    await tick(10);
    q('#oa-work').value = 'w1';
    // 弹窗里那批复选框是真实 DOM 才有的，沙盒里得自己伪造出来
    raw.document.querySelectorAll = sel => sel === '.oa-cb:checked'
      ? S.DB.tasks.map(t => ({ value: t.id })) : [];
    await confirmIfAny();
    raw.document.querySelectorAll = () => [];
    await tick(20);
    const m = hit(logsSince(n0), '批量把');
    ok('★★批量指派留下了日志', m.length === 1, logsSince(n0).map(textOf));
    ok('★写明了指派到哪项工作（编号会跟着重生成，不记的话事后查不出编号是怎么变的）',
      m.length === 1 && textOf(m[0]).indexOf('0101 工作一') !== -1, m.map(textOf));
    ok('★推进了共享文件', (fileOf(_h).changelog || []).some(e => textOf(e).indexOf('批量把') !== -1));
  }

  section('四、复制到新年度');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(15);
    const n0 = S.DB.changelog.length;
    S.ACTIONS['year-copy']();
    await tick(10);
    q('#yc-src').value = '2026';
    q('#yc-dst').value = '2027';
    q('#yc-arch').value = 'keep';
    raw.document.querySelectorAll = sel => sel === '.yc-cb:checked'
      ? S.DB.works.filter(w => !w.deleted_at).map(w => ({ value: w.id })) : [];
    await confirmIfAny();
    raw.document.querySelectorAll = () => [];
    await tick(20);
    const m = hit(logsSince(n0), '年度复制了') .concat(hit(logsSince(n0), '复制了'));
    ok('★★复制到新年度留下了日志', m.length >= 1, logsSince(n0).map(textOf));
    ok('★写明了源年度和目标年度', m.length >= 1 && /2026 年度复制了 \d+ 项工作到 2027 年度/.test(textOf(m[0])), m.map(textOf));
    ok('★推进了共享文件', (fileOf(_h).changelog || []).some(e => /复制了 \d+ 项工作到 2027 年度/.test(textOf(e))));
  }

  section('五、CSV 导入（覆盖模式会整条覆盖已有记录）');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(15);
    const n0 = S.DB.changelog.length;
    const head = S.schema('task').fields.filter(f => !f.virtual).map(f => f.key);
    const row = head.map(k => k === 'id' ? 'T1' : k === 'title' ? '任务1被导入覆盖了' : k === 'work' ? 'w1' : k === 'code' ? '0101261' : '');
    const csv = head.join(',') + '\n' + row.join(',') + '\n';
    await S.applyCSVImport('task', 'merge', csv);
    await tick(20);
    const m = hit(logsSince(n0), 'CSV 导入');
    ok('★★CSV 导入留下了日志', m.length === 1, logsSince(n0).map(textOf));
    ok('★写明了模式和新增/覆盖条数', m.length === 1 && /（覆盖模式）：新增 \d+ 条、覆盖 \d+ 条/.test(textOf(m[0])), m.map(textOf));
    ok('★推进了共享文件', (fileOf(_h).changelog || []).some(e => textOf(e).indexOf('CSV 导入') !== -1));
    ok('回归：导入本身生效了', (S.byId('task', 'T1') || {}).title === '任务1被导入覆盖了');
  }

  section('六、任务+里程碑宽表导入（覆盖模式会替换任务现有的全部里程碑）');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(15);
    const n0 = S.DB.changelog.length;
    const hs = S.wideImportHeaders();
    const cell = k => {
      if (k === '所属工作项') return '工作一';
      if (k === '任务项编号') return '0101261';
      if (k === '任务项名称') return '任务1';
      if (k === '里程碑时间1') return '2026-11-11';
      if (k === '里程碑交付物1') return '导入进来的交付物';
      return '';
    };
    const csv = hs.join(',') + '\n' + hs.map(cell).join(',') + '\n';
    await S.applyWideImport('merge', csv);
    await tick(20);
    const m = hit(logsSince(n0), '宽表导入');
    ok('★★宽表导入留下了日志', m.length === 1, logsSince(n0).map(textOf));
    ok('★写明了模式和写入条数', m.length === 1 && /（覆盖模式）：写入任务 \d+ 条、里程碑 \d+ 个/.test(textOf(m[0])), m.map(textOf));
    ok('★推进了共享文件', (fileOf(_h).changelog || []).some(e => textOf(e).indexOf('宽表导入') !== -1));
  }

  section('七、★工作「主要工作内容」——唯一一个连逐字段明细都不记的编辑入口');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(15);
    const n0 = S.DB.changelog.length;
    S.ACTIONS['edit']({ entity: 'work', id: 'w1', field: 'content' }, q('#x'));
    await tick(10);
    q('#lines-ta').value = '第一条内容\n第二条内容';
    await confirmIfAny();
    await tick(20);
    const added = logsSince(n0);
    ok('★★改完之后日志里有记录了（原来是 0 条）', added.length >= 1, added.map(textOf));
    const withDetail = added.filter(e => Array.isArray(e.changes) && e.changes.some(c => c && c.k === 'content'));
    ok('★★而且带「字段/改前/改后」明细——「按日志核对数据」只认这种记录',
      withDetail.length === 1, added.map(e => [textOf(e), e.changes && e.changes.map(c => c.k)]));
    ok('★明细里的"改后"就是真正存下去的值',
      withDetail.length === 1 && JSON.stringify(withDetail[0].changes.find(c => c.k === 'content').to)
        === JSON.stringify(S.byId('work', 'w1').content), withDetail.map(e => e.changes));
    ok('★推进了共享文件', (fileOf(_h).changelog || []).some(e => Array.isArray(e.changes) && e.changes.some(c => c.k === 'content')));

    // 端到端：把值改坏（模拟被旧页面顶回去），「按日志核对」现在查得出来了
    const w = S.byId('work', 'w1');
    w.content = ['被顶回去的旧内容'];
    S.rebuildIndex();
    const issues = S.auditByChangelog().filter(x => x.entity === 'work' && x.field === 'content');
    ok('★★★「按日志核对数据」现在能查出这个字段被覆盖了（原来对它永远失效）',
      issues.length === 1, S.auditByChangelog().map(x => x.entity + '.' + x.field));
  }

  section('八、源码接线自检');
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
    const slice = (key, len) => { const i = src.indexOf(key); return i === -1 ? '' : src.slice(i, i + len); };
    ok('批量删除里有 pushChangeLog', /pushChangeLog\('task', '', `批量删除了/.test(slice("'batch-delete'", 2200)));
    ok('批量彻底删除里有 pushChangeLog', /pushChangeLog\('task', '', `批量彻底删除了/.test(slice("'batch-purge'", 1600)));
    ok('批量指派里有 pushChangeLog', /pushChangeLog\('task', '', `批量把/.test(slice('function openOrphanAssign', 3000)));
    ok('年度复制里有 pushChangeLog', /pushChangeLog\('work', '', `从 \$\{srcY\} 年度复制了/.test(slice('function openYearCopy', 4200)));
    ok('CSV 导入里有 pushChangeLog', /pushChangeLog\(entity, '', `\$\{schema\(entity\)\.label\} CSV 导入/.test(slice('async function applyCSVImport', 5000)));
    ok('宽表导入里有 pushChangeLog', /pushChangeLog\('task', '', `任务\+里程碑宽表导入/.test(slice('async function applyWideImport', 12000)));
    ok('多行文本编辑器里有 logRecordChange', /logRecordChange\(entity, id, before, r, \[fieldKey\]\);/.test(slice('function openLinesEditor', 1800)));
    /* 自检的自检：上面几条是"源码里有没有这句"，函数被改名/挪走之后很容易变成永远为真的空断言，
       所以顺手确认这几个名字确实都还在。 */
    ["'batch-delete'", "'batch-purge'", 'function openOrphanAssign', 'function openYearCopy',
      'async function applyCSVImport', 'async function applyWideImport', 'function openLinesEditor']
      .forEach(n => ok('存在：' + n, src.indexOf(n) !== -1));
  }

  S.setFileHandle(null);
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
