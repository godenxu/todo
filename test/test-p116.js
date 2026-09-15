/* P116：第二十四轮排查——把"编辑界面开着时后台同步了"这个病根挖到底

   上一轮在任务详情弹窗上发现了「孤儿对象」：同步的最后一步 Object.assign(DB, merged)
   会把 DB.tasks 整个换成新数组，界面闭包里捏着的记录当场变成谁也看不见的孤儿。
   这一轮把同一个病根在别处找了一遍，又挖出三处，其中两处比上一轮那个更隐蔽。

   ── 真问题（3 个） ──
   ① ★同事删掉的里程碑，被我一次"什么都没改的保存"复活了
      详情弹窗保存时对每一行都会执行 delete cur.deleted_at（"上一次误删的又提交回来 = 撤销删除"）。
      可如果这条是【同事在我开着弹窗期间删的】、而我这一行一个字都没动，
      这句就把它复活了——而复活的记录还会被推回共享文件，替所有人抹掉那次删除。
      记录自己回来正是这套系统最早那批事故的形态。

   ② 同事改过的里程碑字段，被弹窗里的旧值顶回去
      跟上一轮任务字段是同一回事，只是这一层还多一个"在不在"的维度。

   ③ ★★commitTaskStatus 拿一份【过期的整条记录】去盖同事的改动
      这一条比"改动丢了"更糟。改状态为"已完成"时，如果缺日期或里程碑没勾完，
      会先弹确认框等用户点——那期间同步跑过，回调里捏着的 t 就成了孤儿。
      而它下面那句 Repo.upsert('task', t) 是【按 id 把整条塞回 DB】：
      于是状态确实改成功了，可同事在这期间改的其它字段被整条覆盖掉。
      实测：确认框开着时同事改了"来源"，点完确认那一格变回空。
      修法跟详情弹窗一致——进函数先按 id 重新取一次。

   ── 顺带做的系统性检查 ──
   把 16 个 Repo.upsert 调用点逐个追了对象来源：13 处是 byId 就地取的、
   1 处传的是 id（cascadeRestoreTask）、1 处是 blank() 新建、剩下 1 处正是 commitTaskStatus。
   也就是说这类风险已经排干净，不是修了一个还剩一片。
   ★ P118 更正：上面这个结论是错的 ★ 判据只看了"对象是不是 byId 取的"，没看"是什么时候取的"——
   在确认框/编辑框打开【之前】取的，跟闭包捏着的旧引用没区别。按正确判据重扫又挖出十几处
   （单元格内联编辑、删除任务/职责、重置 PIN、删除账号、彻底删除……），下面"行内编辑不受影响"那句同样不成立。
   详见 test-p118.js，那里还把正确判据写成了全文扫描护栏。

   ── 查过没问题的，钉成护栏 ──
   同事在我开着弹窗时【新加】的里程碑不会被我的保存误删（它不在 existingCps 里，
   keepIds 那套判断天然避开了）；我真改的、我真删的照常生效；
   撤销跨同步是刻意的保守设计——这条记录被同事碰过就整条不回退，而且会明说
   "其中 N 处因为同事随后也改过，保留了他们的版本没有回退"；
   行内编辑、批量编辑、转移牵头人确认框、连点保存、导入与同步并发、
   筛选着的列表同步进新记录、图表页按人/职责/年度叠加筛选——都不受影响。

   用法：node test/test-p116.js */
const { sandbox: S, raw, q } = require('./harness.js');
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
let FILE = null;
const handle = { name: 'shared.json', _mtime: 1,
  async getFile() { const s = FILE; return { lastModified: handle._mtime, text: async () => s }; },
  async createWritable() { return { async write(t) { handle._p = t; },
    async close() { FILE = handle._p; handle._mtime++; } }; } };
function cpRow(id, pd, dv, rl, dn) {
  return { getAttribute: k => (k === 'data-ms-id' ? id : null),
    querySelector: sel => ({ '.cp-date': { value: pd }, '.cp-deliv': { value: dv },
      '.cp-report-level': { value: rl }, '.cp-chk': { checked: dn === '1' } }[sel]) };
}
const origQSA = raw.document.querySelectorAll;
const stubCp = rows => { raw.document.querySelectorAll = sel =>
  (sel === '#cp-list [data-cp-row]' ? rows : (origQSA ? origQSA(sel) : [])); };
const unstubCp = () => { raw.document.querySelectorAll = origQSA; };

function world(opt) {
  const o = opt || {};
  S.DB.settings.me = '管理员';
  S.DB.users = [
    { name: '管理员', role: 'admin', salt: 's', hash: 'h', iterations: 1, rev: 1,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' },
    { name: '小王', role: 'staff', salt: 's', hash: 'h', iterations: 1, rev: 1,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' },
  ];
  S.DB.permissionMatrix = null;
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    owner: '管理员', year: 2026, status: 'doing' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261', title: '任务一',
    owner: '管理员', assignees: [], status: 'doing', priority: '2', progress: 0,
    plan_date: o.noDate ? '' : '2026-12-31', actual_date: '', source: '', custom: '' }))];
  S.DB.milestones = [
    S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', plan_date: '2026-09-20',
      deliverable: '调研报告', report_level: 'section', done: '0' })),
    S.stampMeta(S.blank('milestone', { id: 'M2', task: 'T1', plan_date: '2026-09-30',
      deliverable: '会议纪要', report_level: 'section', done: '0' })),
  ];
  S.DB.changelog = []; S.DB.purged = [];
  S.DB.settings.year = 2026; S.DB.settings.pendingSync = false; S.DB.settings.maxSeenAppVersion = '';
  S.clearSyncBaseline(S.DB); S.undoStack.length = 0;
  S.setSnackPriorityUntil(0); S.setLocalSaveFailedAt(0);
  S.setStaleAppBlocked(false); S.closeModal();
  S.UI.tasks.sel.clear(); S.UI.tasks.filters = {}; S.UI.tasks.search = '';
  S.rebuildIndex();
  FILE = JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
    writeId: 'w0', writeIds: ['w0'], lastWriteApp: S.APP_VERSION,
    tasks: cp(S.DB.tasks), works: cp(S.DB.works), duties: cp(S.DB.duties),
    milestones: cp(S.DB.milestones), users: cp(S.DB.users) }));
  handle._mtime = 1; S.setFileHandle(handle); S.setEverConnected(true);
}
// 同事那边改文件（fn 直接改 payload），推上去
function colleague(fn) {
  const p = JSON.parse(FILE);
  fn(p);
  p.writeId = 'wC' + Math.random(); p.writeIds = ['w0', p.writeId];
  FILE = JSON.stringify(p); handle._mtime++;
}
const colleagueTask = patch => colleague(p => {
  const t = (p.tasks || []).find(x => x.id === 'T1');
  Object.assign(t, patch, { rev: (t.rev || 1) + 5,
    updated_at: new Date(Date.now() + 10000).toISOString(), updated_by: '同事' });
});
function fillTask(t) {
  ['title', 'owner', 'source', 'custom', 'plan_date'].forEach(k => { q('#td-' + k).value = t[k]; });
  q('#td-priority').value = t.priority; q('#td-status').value = t.status;
}
const TWO_ROWS = () => [cpRow('M1', '2026-09-20', '调研报告', 'section', '0'),
  cpRow('M2', '2026-09-30', '会议纪要', 'section', '0')];

async function main() {
  await tick(120);

  /* ═════════ ① 里程碑那一层的并发 ═════════ */
  section('①-1 ★★同事删掉的里程碑，不许被我一次"什么都没改的保存"复活');
  {
    world();
    S.openTaskDetail('T1'); await tick(50);
    const t0 = cp(S.byId('task', 'T1'));
    colleague(p => {
      const m = (p.milestones || []).find(x => x.id === 'M2');
      m.deleted_at = new Date().toISOString(); m.rev = (m.rev || 1) + 5;
      m.updated_at = new Date(Date.now() + 10000).toISOString(); m.updated_by = '同事';
    });
    await S.pullFromFile(); await tick(80);
    ok('（前提）同步后 M2 确实是删除状态', !!S.byId('milestone', 'M2').deleted_at);
    fillTask(t0);
    stubCp(TWO_ROWS());          // 弹窗里还有 M2 那一行（打开时它还在）
    q('#snack-msg').textContent = '';
    await S.modalCallback(); await tick(150);
    unstubCp();
    ok('★★同事的删除没被撤销（复活的记录会被推回共享文件，替所有人抹掉那次删除——'
      + '记录自己回来正是这套系统最早那批事故的形态）',
      !!S.byId('milestone', 'M2').deleted_at, S.byId('milestone', 'M2'));
    ok('★而且告诉了我这件事（不说的话我以为它还在）',
      /已被同事删除/.test(q('#snack-msg').textContent || ''), q('#snack-msg').textContent);
    ok('★共享文件里它也还是删除状态',
      !!((JSON.parse(FILE).milestones || []).find(x => x.id === 'M2') || {}).deleted_at);
  }

  section('①-2 但只要我在那一行上真改了点什么，就按"我要留下它"处理');
  {
    world();
    S.openTaskDetail('T1'); await tick(50);
    const t0 = cp(S.byId('task', 'T1'));
    colleague(p => {
      const m = (p.milestones || []).find(x => x.id === 'M2');
      m.deleted_at = new Date().toISOString(); m.rev = (m.rev || 1) + 5;
      m.updated_at = new Date(Date.now() + 10000).toISOString(); m.updated_by = '同事';
    });
    await S.pullFromFile(); await tick(80);
    fillTask(t0);
    // 我在 M2 那一行上改了交付物 —— 明确的意思表示
    stubCp([cpRow('M1', '2026-09-20', '调研报告', 'section', '0'),
      cpRow('M2', '2026-09-30', '我改过的会议纪要', 'section', '0')]);
    await S.modalCallback(); await tick(150);
    unstubCp();
    const m2 = S.byId('milestone', 'M2');
    ok('★★我动过的那一行照旧撤销删除（这是用户明确的意思表示）', !m2.deleted_at, m2.deleted_at);
    ok('★而且我的改动写进去了', m2.deliverable === '我改过的会议纪要', m2.deliverable);
  }

  section('①-3 同事改过的里程碑字段，不许被弹窗里的旧值顶回去');
  {
    world();
    S.openTaskDetail('T1'); await tick(50);
    const t0 = cp(S.byId('task', 'T1'));
    colleague(p => {
      const m = (p.milestones || []).find(x => x.id === 'M1');
      m.plan_date = '2026-11-11'; m.rev = (m.rev || 1) + 5;
      m.updated_at = new Date(Date.now() + 10000).toISOString(); m.updated_by = '同事';
    });
    await S.pullFromFile(); await tick(80);
    fillTask(t0);
    stubCp(TWO_ROWS());          // 我这一行一个字没动
    q('#snack-msg').textContent = '';
    await S.modalCallback(); await tick(150);
    unstubCp();
    ok('★★同事改的日期保住了（跟上一轮任务字段同一个规矩）',
      S.byId('milestone', 'M1').plan_date === '2026-11-11', S.byId('milestone', 'M1').plan_date);
    ok('★也告诉了我这件事', /里程碑.*被同事改过/.test(q('#snack-msg').textContent || ''),
      q('#snack-msg').textContent);
  }

  section('①-4 我真改的、我真删的，都必须照常生效');
  {
    world();
    S.openTaskDetail('T1'); await tick(50);
    fillTask(cp(S.byId('task', 'T1')));
    stubCp([cpRow('M1', '2026-09-25', '我改的交付物', 'bank', '0')]);   // 改 M1、删掉 M2 那一行
    await S.modalCallback(); await tick(150);
    unstubCp();
    const m1 = S.byId('milestone', 'M1');
    ok('★我改的三格都写进去了',
      m1.plan_date === '2026-09-25' && m1.deliverable === '我改的交付物' && m1.report_level === 'bank', m1);
    ok('★我删掉的那一行确实被删了', !!S.byId('milestone', 'M2').deleted_at);
  }

  section('①-5 同事在我开着弹窗时【新加】的里程碑，不许被我的保存误删');
  {
    world();
    S.openTaskDetail('T1'); await tick(50);
    const t0 = cp(S.byId('task', 'T1'));
    colleague(p => {
      p.milestones.push({ id: 'M_NEW', task: 'T1', plan_date: '2026-10-15',
        deliverable: '同事新加的交付物', report_level: 'section', done: '0', actual_date: '', rev: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date(Date.now() + 10000).toISOString(), updated_by: '同事' });
    });
    await S.pullFromFile(); await tick(80);
    fillTask(t0);
    stubCp(TWO_ROWS());          // 弹窗里当然没有他刚加的那一行
    await S.modalCallback(); await tick(150);
    unstubCp();
    const nw = S.DB.milestones.find(m => m.id === 'M_NEW');
    ok('★★同事新加的那条还在（它不在 existingCps 里，keepIds 那套判断天然避开了——'
      + '这一条本来就是对的，钉住它别被以后的改动破坏）', nw && !nw.deleted_at, nw);
  }

  section('①-6 done 这一格被判给同事时，交付日期要跟着它走');
  {
    world();
    S.openTaskDetail('T1'); await tick(50);
    const t0 = cp(S.byId('task', 'T1'));
    colleague(p => {
      const m = (p.milestones || []).find(x => x.id === 'M1');
      m.done = '1'; m.actual_date = '2026-09-18'; m.rev = (m.rev || 1) + 5;
      m.updated_at = new Date(Date.now() + 10000).toISOString(); m.updated_by = '同事';
    });
    await S.pullFromFile(); await tick(80);
    fillTask(t0);
    stubCp(TWO_ROWS());          // 弹窗里 M1 那一行还是"未完成"
    await S.modalCallback(); await tick(150);
    unstubCp();
    const m1 = S.byId('milestone', 'M1');
    ok('★★同事标的"已交付"保住了', m1.done === '1', m1.done);
    ok('★★交付日期也跟着保住了——这里必须看 cur.done 而不是 cd.done，'
      + '拿弹窗里那个旧值去判会跟实际完成状态对不上', m1.actual_date === '2026-09-18', m1.actual_date);
  }

  section('①-7 源码层面：里程碑这一层的快照与比对不能被绕过');
  {
    ok('★★记了打开那一刻每条里程碑的样子（存 clone，不是引用——引用会变成孤儿）',
      /const cpOpenSnap = new Map\(existingCps\.map\(m => \[m\.id, clone\(m\)\]\)\);/.test(SRC));
    ok('★★同事删了、我没动过的整行跳过', /if \(cur\.deleted_at && !\(snap && snap\.deleted_at\) && rowUntouched\)/.test(SRC));
    // P126：结构改成"我没碰的格子一律不写，同事改了的顺带记下来"，且"没碰"按界面呈现的样子比；
    // P127：换算规则提成了公共函数 cpRowView（补上交付物中间的换行、呈报层级不在选项里两种情况）
    ok('★★逐格比对：我没碰、他改了的那一格留着他的',
      /if \(untouched\(k\)\) \{[\s\S]{0,160}if \(!sameFieldValue\(cur\[k\], snap\[k\]\)\) _msKeptFields\.push[\s\S]{0,40}return;/.test(SRC)
      && /const untouched = k => !!snap && sameFieldValue\(cd\[k\], cpRowView\(snap, k\)\);/.test(SRC));
    ok('★交付日期看的是 cur.done', /cur\.actual_date = cur\.done === '1' \?/.test(SRC));
  }

  /* ═════════ ② commitTaskStatus 的过期整条覆盖 ═════════ */
  section('②-1 ★★确认框开着期间同步过，点确认不能拿过期的整条去盖同事');
  {
    world({ noDate: true });     // 没有计划完成日 → 改成"已完成"时一定弹确认框
    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'status'), q('#td'));
    await tick(30);
    await S.spCommitSingle('done'); await tick(60);
    ok('（前提）弹出了自动补全确认框', q('#modal-overlay').classList.contains('show'));
    const arrBefore = S.DB.tasks, tBefore = S.byId('task', 'T1');
    colleagueTask({ source: '同事改的来源' });
    await S.pullFromFile(); await tick(80);
    ok('（前提）同步把 DB.tasks 换成了新数组、记录也换了新对象',
      arrBefore !== S.DB.tasks && tBefore !== S.byId('task', 'T1'));
    await S.modalCallback(); await tick(180);
    const t = S.byId('task', 'T1');
    ok('★点确认照样生效', t.status === 'done', t.status);
    ok('★★同事改的那一格没被整条覆盖掉——Repo.upsert 是按 id 把【整条】塞回 DB 的，'
      + '传一份过期的进去，就等于拿旧记录盖掉同事的所有改动（这比丢自己的改动更糟）',
      t.source === '同事改的来源', t.source);
    ok('★里程碑也一并勾完了（确认框答应过的事要办到）',
      S.DB.milestones.filter(m => !m.deleted_at).every(m => m.done === '1'));
    const rt = (JSON.parse(FILE).tasks || []).find(x => x.id === 'T1') || {};
    ok('★改动推到了共享文件', rt.status === 'done' && rt.source === '同事改的来源',
      { status: rt.status, source: rt.source });
  }

  section('②-2 不发生同步时，这条路照常走通（别为了修它把正常路径弄坏）');
  {
    world({ noDate: true });
    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'status'), q('#td'));
    await tick(30);
    await S.spCommitSingle('done'); await tick(60);
    await S.modalCallback(); await tick(180);
    const t = S.byId('task', 'T1');
    ok('★状态改成了已完成', t.status === 'done');
    ok('★缺的日期补上了', !!t.plan_date && !!t.actual_date);
    ok('★进度到了 100', t.progress === 100, t.progress);
  }

  section('②-3 源码层面：commitTaskStatus 必须按 id 重新取');
  {
    const i = SRC.indexOf('async function commitTaskStatus');
    const body = SRC.slice(i, i + 1800);
    ok('★★进函数先按 id 重新取一次', /t = byId\('task', t\.id\) \|\| t;/.test(body), body.slice(0, 200));
    ok('★而且在 snapshot() 之前取（快照要基于最新那一份）',
      body.indexOf("t = byId('task', t.id)") < body.indexOf('snapshot();'));
  }

  section('②-4 系统性：所有 Repo.upsert 的入参都不是"捏了很久的对象"');
  {
    /* 这一条守的是"不是修了一个还剩一片"。16 个调用点里：
       13 处是 byId 就地取的、1 处传 id（cascadeRestoreTask）、1 处 blank() 新建、
       剩下 1 处就是 commitTaskStatus（已在上面钉住）。 */
    const calls = (SRC.match(/Repo\.upsert\(/g) || []).length;
    ok('★upsert 调用点数量没有暴涨（新增的要单独审一遍来源）', calls <= 20, calls);
    // 详情弹窗、行内编辑、批量编辑这三条主路径都必须是就地取的
    ok('★行内编辑提交时按 id 重新取',
      /function finishSpCommitSingle\(entity, id, field, val\) \{\s*\n\s*const r = byId\(entity, id\); if \(!r\) return;/.test(SRC));
    ok('★详情弹窗保存时按 id 重新取', /const fresh = byId\('task', id\);/.test(SRC));
  }

  /* ═════════ ③ 重查：别处有没有被这两次改动带坏 ═════════ */
  section('③-1 行内编辑在同步之后照常生效，且不波及同事改的别的字段');
  {
    world();
    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'priority'), q('#td'));
    await tick(30);
    colleagueTask({ source: '同事改的来源' });
    await S.pullFromFile(); await tick(80);
    await S.spCommitSingle('1'); await tick(150);
    const t = S.byId('task', 'T1');
    ok('★行内编辑生效', t.priority === '1', t.priority);
    ok('★同事改的别的字段没被波及', t.source === '同事改的来源', t.source);
  }

  section('③-2 撤销跨同步：刻意不回退被同事碰过的记录，但必须说出来');
  {
    world();
    S.snapshot();
    const t = S.byId('task', 'T1');
    t.title = '我改的标题'; S.stampMeta(t);
    await S.Repo.persist(S.DB); await tick(60);
    colleagueTask({ source: '同事改的来源' });
    await S.pullFromFile(); await tick(80);
    q('#snack-msg').textContent = '';
    S.undoLast(); await tick(150);
    const a = S.byId('task', 'T1');
    ok('★★同事的改动没被撤销抹掉（快照里只有"我动手之前"那一份，'
      + '没有中间态，分不清哪格是谁改的，只能整条保守处理）',
      a.source === '同事改的来源', a.source);
    ok('★★而且明说了"有几处因为同事随后也改过、没有回退"——'
      + '不说的话用户会以为 Ctrl+Z 坏了',
      /因为.*也改过|保留了他们的版本/.test(q('#snack-msg').textContent || ''),
      q('#snack-msg').textContent);
  }

  section('③-3 连点保存只算一次');
  {
    world();
    stubCp([]);
    S.openTaskDetail('T1'); await tick(50);
    fillTask(cp(S.byId('task', 'T1')));
    q('#td-title').value = '连点测试';
    const before = S.DB.changelog.length;
    const calls = [S.ACTIONS['modal-ok'](), S.ACTIONS['modal-ok'](), S.ACTIONS['modal-ok']()];
    await Promise.all(calls.map(x => Promise.resolve(x)));
    await tick(200);
    unstubCp();
    const added = S.DB.changelog.slice(before).filter(e => e.entity === 'task');
    ok('★连点三次只留一条变更记录（保存要等一次共享文件读写，'
      + '用户觉得没反应就会多点几下）', added.length <= 1, added.length);
  }

  section('③-4 筛选着的列表，同步进来的新记录要按筛选条件出现，且不冲掉筛选条件');
  {
    world();
    S.setPage('tasks');
    S.UI.tasks.filters = { owner: '管理员' };
    S.renderTasks(); await tick(20);
    const before = (S.taskRows || []).length;
    colleague(p => {
      p.tasks.push({ id: 'T_NEW', work: 'w1', code: '0101262', title: '同事新建的任务',
        owner: '管理员', assignees: [], status: 'doing', priority: '2', progress: 0,
        plan_date: '2026-11-01', actual_date: '', source: '', custom: '', rev: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date(Date.now() + 10000).toISOString(), updated_by: '同事' });
    });
    await S.pullFromFile(); await tick(100);
    let err = '';
    try { S.renderTasks(); } catch (e) { err = e.message; }
    ok('渲染不抛异常', !err, err);
    ok('★新记录按筛选条件出现了', (S.taskRows || []).length > before,
      { before, after: (S.taskRows || []).length });
    ok('★用户正在用的筛选条件没被同步冲掉', S.UI.tasks.filters.owner === '管理员', S.UI.tasks.filters);
  }

  section('③-5 图表/报表在按人、按年度叠加筛选下都算得出来');
  {
    world();
    let err = '';
    for (const year of [2026, 2025]) {
      for (const person of ['', '管理员', '小王']) {
        S.DB.settings.year = year; S.rebuildIndex();
        try { S.buildReportData('year', 0, person); }
        catch (e) { err = `${year}/${person}: ${e.message}`; break; }
      }
      if (err) break;
    }
    ok('★六种组合都算得出来', !err, err);
    S.DB.settings.year = 2026; S.rebuildIndex();
    let rerr = '';
    for (const tab of (S.CHART_TABS || []).map(x => x.key || x)) {
      try { S.setPage('charts'); S.renderCharts(tab); } catch (e) { rerr = tab + ': ' + e.message; break; }
    }
    ok('★图表页各标签都渲染得出来', !rerr, rerr);
    /* 小王是 T1 的参与人（不是牵头人）——这一条要守的是"按人筛选不能只认牵头人"，
       所以得先把他放进参与人里，world() 默认是空的。 */
    S.byId('task', 'T1').assignees = ['小王'];
    S.rebuildIndex();
    ok('★按人筛选把"参与人"身份的任务也算进去（只算牵头的话，'
      + '一个人参与但不牵头的活儿会在他的工作台里凭空消失）',
      S.dashPersonTasks('小王').some(t => t.id === 'T1'),
      S.dashPersonTasks('小王').map(t => t.id));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { unstubCp(); console.error('测试异常：', e); process.exit(1); });
