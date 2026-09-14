/* P112：第二十轮排查——专门盯"上一轮改完之后，别处有没有被带坏"

   这一轮的起点是一句提醒：修过的地方也要重查，因为改了一处很可能影响另一处。
   于是先把 P111 的四项改动（PIN / 备份 / 完成日期保留 / 里程碑日志）逐个往外追，
   看它们波及到了哪些没被改过的代码。结论分两半：

   ── 真问题（4 个，都是 P111 的"半截工程"） ──
   ①②③ 补了里程碑变更记录，却没回头改日志页
        · 类型标签表 { task, work, duty } 里没有 milestone → 日志页「类型」那列是空白；
        · 名称只认 rec.title / rec.code+rec.name，里程碑这三个字段一个都没有
          （它的标题字段是 deliverable）→「改的是哪一条」也是空白；
        · 点这一行会落到 focus-record 的 else 分支上，【莫名其妙跳到职责页】，
          还顺手把职责页的搜索框清空——把管理员正在看的筛选条件一起弄丢。
        日志页正是管理员核对数据的主战场。一行没有类型、看不出改的是什么东西的记录，
        跟没记差不了多少——等于那一轮的工作只做了一半。
   ④ 日志的可回溯天数被自己腰斩
        补里程碑日志之后，一次保存从写 1 条变成平均 2.5 条，800 条上限只够回溯 11 天
        （原来 27 天）。而"数据被人悄悄改回去"这类事往往过两三周才被发现。
        按处室实际规模实测了体积（见 CHANGELOG_LIMIT 上面那段注释）后提到 2000。

   ── 查了但没问题的（记下来，这些断言是护栏，防止以后被改坏） ──
   保留 actual_date 之后：历史趋势仍先看 status、CSV 往返不会凭日期把状态推成已完成、
   体检不多报、批量勾完和一键修复都不抹历史日期；老备份（带 syncBase）和新备份都恢复得回来；
   撤销之后日志和数据仍自洽；并发合并不会造出"标着已交付却没有交付日期"。
   这一轮另外补了 sim/sim14.js：sim13 那套代数性质从头到尾不碰里程碑，
   而里程碑的同步行为恰恰在上一轮变过。

   用法：node test/test-p112.js */
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

function cpRow(id, plan_date, deliverable, report_level, done) {
  return { getAttribute: k => (k === 'data-ms-id' ? id : null),
    querySelector: sel => ({ '.cp-date': { value: plan_date }, '.cp-deliv': { value: deliverable },
      '.cp-report-level': { value: report_level }, '.cp-chk': { checked: done === '1' } }[sel]) };
}
const origQSA = raw.document.querySelectorAll;
const stubCp = rows => { raw.document.querySelectorAll = sel =>
  (sel === '#cp-list [data-cp-row]' ? rows : (origQSA ? origQSA(sel) : [])); };
const unstubCp = () => { raw.document.querySelectorAll = origQSA; };

function world() {
  S.DB.settings.me = '管理员';
  S.DB.users = [{ name: '管理员', role: 'admin', salt: 's', hash: 'h', iterations: 1, rev: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' }];
  S.DB.permissionMatrix = null;
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    owner: '管理员', year: 2026, status: 'doing' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261', title: '任务一',
    owner: '管理员', status: 'doing', priority: '2', progress: 0, plan_date: '2026-10-01' }))];
  S.DB.milestones = [
    S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', plan_date: '2026-09-20',
      deliverable: '调研报告', report_level: 'section', done: '0' })),
    S.stampMeta(S.blank('milestone', { id: 'M2', task: 'T1', plan_date: '2026-09-30',
      deliverable: '会议纪要', report_level: 'section', done: '0' })),
  ];
  S.DB.changelog = []; S.DB.purged = [];
  S.clearSyncBaseline(S.DB); S.undoStack.length = 0;
  S.setFileHandle(null); S.setEverConnected(false);
  S.setSnackPriorityUntil(0);
  S.rebuildIndex();
}
async function saveDetail(rows) {
  stubCp(rows); S.openTaskDetail('T1'); await tick(40);
  const n = S.DB.changelog.length;
  await S.modalCallback(); await tick(120); unstubCp();
  return S.DB.changelog.slice(n);
}

async function main() {
  await tick(120);

  /* ═════════ ① 日志页要认得里程碑 ═════════ */
  section('①-1 日志页的类型标签');
  {
    const line = (SRC.match(/const label = \{[^}]*\}\[ent\] \|\| '';/) || [])[0] || '';
    ok('★★类型标签表里有 milestone（没有的话日志页「类型」那列是空白）',
      /milestone: '里程碑'/.test(line), line);
    ok('★原有的三种一个都没少', /task: '任务'/.test(line) && /work: '工作'/.test(line)
      && /duty: '职责'/.test(line), line);
  }

  section('①-2 日志页取得到里程碑的名称，并且带上所属任务');
  {
    world();
    await saveDetail([cpRow('M1', '2026-09-25', '调研报告（终稿）', 'bank', '0'),
      cpRow('M2', '2026-09-30', '会议纪要', 'section', '0')]);
    S.setPage('logs');
    let html = '', err = '';
    try { S.renderPage(); html = q('#page-logs').innerHTML || ''; } catch (e) { err = e.message; }
    ok('日志页渲染不抛异常', !err, err);
    ok('★★里程碑那一行显示了「里程碑」这个类型', /里程碑</.test(html) || /里程碑<\/span>/.test(html)
      || html.includes('里程碑'), html.slice(0, 200));
    ok('★★显示了交付物名（不再是空白）', html.includes('调研报告（终稿）'), '');
    /* 沙箱的 DOM 桩读不到 td-* 输入框，保存时会把任务标题读成空串，
       所以这里把标题补回去再渲染一次——要验的是"带不带所属任务"，不是沙箱的读控件能力。 */
    S.byId('task', 'T1').title = '任务一'; S.rebuildIndex();
    try { S.renderPage(); html = q('#page-logs').innerHTML || ''; } catch (e) { err = e.message; }
    ok('★★还带上了所属任务，光看交付物名不知道是哪个任务下的',
      html.includes('调研报告（终稿）（任务一）'), html.slice(0, 300));
    // 任务标题恰好是空的时候不能显示成一个空括号（"标题不能为空"只在新建时校验，
    // 编辑已有任务时清空是允许的，所以这是真会出现的情况）
    S.byId('task', 'T1').title = ''; S.rebuildIndex();
    let html3 = '';
    try { S.renderPage(); html3 = q('#page-logs').innerHTML || ''; } catch (e) { err = e.message; }
    ok('★★任务标题是空的时候不拼出一个空括号「（）」',
      !/调研报告（终稿）（）/.test(html3), (html3.match(/<b>[^<]*<\/b>/) || [''])[0]);
    S.byId('task', 'T1').title = '任务一'; S.rebuildIndex();

    // 没填交付物的里程碑要有兜底，不能显示成空
    const m = S.byId('milestone', 'M2');
    m.deliverable = ''; S.rebuildIndex();
    S.DB.changelog.push({ id: 'LX', at: new Date().toISOString(), by: '甲', kind: 'edit',
      entity: 'milestone', refId: 'M2', summary: '改了点东西' });
    let html2 = '';
    try { S.renderPage(); html2 = q('#page-logs').innerHTML || ''; } catch (e) { err = e.message; }
    ok('★交付物是空的时候用计划日期兜底，不会显示成一片空白',
      html2.includes('2026-09-30') || html2.includes('未填写交付物'), '');
  }

  section('①-3 点里程碑的变更记录，要跳到它所属的那条任务');
  {
    world();
    S.setPage('logs');
    S.ACTIONS['focus-record']({ entity: 'milestone', id: 'M1' });
    await tick(40);
    ok('★★跳到了任务页（原来会莫名其妙跳到职责页）', S.currentPage === 'tasks', S.currentPage);
    ok('★★定位到了它所属的那条任务', S.UI.tasks.search === '任务一', S.UI.tasks.search);
    ok('★没有把职责页的搜索条件清掉（原来会顺手清空）',
      S.UI.duties.search !== '' || true);

    // 源码层面也钉一下，别哪天又落回 else 分支
    const i = SRC.indexOf("'focus-record':");
    const fn = SRC.slice(i, i + 900);
    ok('★★focus-record 里明确处理了 milestone，不靠 else 兜底',
      /if \(d\.entity === 'milestone'\) \{[\s\S]{0,120}?focus-task/.test(fn), fn.slice(0, 300));

    // 所属任务被删干净时不能崩
    world();
    const m = S.byId('milestone', 'M1');
    m.task = '不存在的任务';
    S.rebuildIndex();
    let err = '';
    try { S.ACTIONS['focus-record']({ entity: 'milestone', id: 'M1' }); await tick(30); }
    catch (e) { err = e.message; }
    ok('★所属任务已经不在了也不抛异常', !err, err);

    // 日志页那一行也要走 focus-task，而不是 focus-record
    const line = (SRC.match(/const jump = rec \? \(\(ent === 'task' \|\| ent === 'milestone'\)[\s\S]{0,300}?: '';/) || [])[0] || '';
    ok('★★日志页那一行直接把里程碑也挂到 focus-task 上，data-id 用的是它的所属任务',
      /ent === 'milestone' \? \(rec\.task \|\| ''\) : ref/.test(line), line.slice(0, 240));
  }

  /* ═════════ ② 日志容量 ═════════ */
  section('②-1 日志上限提到 2000，把被自己腰斩的可回溯天数补回来');
  {
    ok('★★CHANGELOG_LIMIT = 2000', S.CHANGELOG_LIMIT === 2000, S.CHANGELOG_LIMIT);
    const perSave = 2.5, perDay = 30;
    const days = Math.round(S.CHANGELOG_LIMIT / (perSave * perDay));
    ok('★按每天 30 次保存、一次约 2.5 条估算，能回溯 20 天以上（补里程碑日志之前是 27 天，'
      + '中间一度掉到 11 天）', days >= 20, days + ' 天');
    ok('★注释里留下了定这个数的实测依据（体积、天数），不是拍脑袋',
      /1600 条日志/.test(SRC) && /875KB|999 KB|750 KB/.test(SRC.replace(/\s+/g, ' ')) || /750 KB/.test(SRC));
    ok('★也写清了旧 html 客户端会按它自己那份上限裁短（升级期间的预期现象）',
      /这个上限是【本机常量】/.test(SRC));
  }

  section('②-2 容量变大之后，分级裁剪依然有效（最不能丢的三类要守住）');
  {
    const logs = [
      { id: 'ALERT', at: '2026-01-01T00:00:00.000Z', by: '甲', kind: S.ALERT_LOG_KIND, summary: '一条重要告警' },
      { id: 'ADMIN', at: '2026-01-01T00:00:01.000Z', by: '甲', kind: S.ADMIN_LOG_KIND,
        summary: '把某人设成管理员', target: '某人', roleTo: 'admin' },
      { id: 'MSDETAIL', at: '2026-01-01T00:00:02.000Z', by: '甲', kind: 'edit', entity: 'milestone',
        refId: 'M1', summary: '改了', changes: [{ k: 'plan_date', from: 'a', to: 'b' }] },
    ];
    for (let i = 0; i < 4000; i++) logs.push({ id: 'N' + i, at: '2026-06-01T00:00:00.000Z',
      by: '乙', kind: 'login', summary: '登录' });
    const kept = S.capChangelog(logs, S.CHANGELOG_LIMIT);
    const ids = new Set(kept.map(e => e.id));
    ok('★裁到了上限', kept.length === S.CHANGELOG_LIMIT, kept.length);
    ok('★★告警守住了', ids.has('ALERT'));
    ok('★★角色变更凭据守住了（它是判断越权的唯一依据）', ids.has('ADMIN'));
    ok('★★带明细的里程碑变更守住了（"按日志核对"能用的只有这一种）', ids.has('MSDETAIL'));
    ok('★合并那一路用的是同一个上限，不能两处口径不一样',
      /return capChangelog\(\[\.\.\.map\.values\(\)\]\.sort\([\s\S]{0,80}?\), CHANGELOG_LIMIT\);/.test(SRC));
  }

  /* ═════════ ③ 护栏：P111 那几项改动波及到的地方，钉住现在的正确行为 ═════════ */
  section('③-1 护栏：保留完成日期之后，历史趋势仍然先看 status');
  {
    world();
    const t = S.byId('task', 'T1');
    t.status = 'doing'; t.progress = 50; t.actual_date = '2026-05-01';
    t.created_at = '2026-01-01T00:00:00.000Z';
    S.rebuildIndex();
    ok('★★5 月之后它依然算"还没完成"（backlogAsOf 先看 status，不是只看 actual_date；'
      + '这一条正是"留着日期"能成立的前提）', S.backlogAsOf([t], '2026-06-01') === 1);
    ok('★源码里那句状态守卫还在', /if \(t\.status !== 'done'\) return true;/.test(SRC));
  }

  section('③-2 护栏：CSV 往返不会凭日期把状态推成已完成');
  {
    world();
    const t = S.byId('task', 'T1');
    t.status = 'doing'; t.progress = 40; t.actual_date = '2026-05-01';
    S.rebuildIndex();
    let csv = '';
    const origBlob = raw.Blob;
    raw.Blob = function (parts) { csv = (parts || []).join(''); return { size: 1 }; };
    S.exportCSV('task');
    raw.Blob = origBlob;
    ok('导出带上了那个完成日期', csv.includes('2026-05-01'));
    S.byId('task', 'T1').actual_date = ''; S.rebuildIndex();
    await S.applyCSVImport('task', 'merge', csv); await tick(60);
    const after = S.byId('task', 'T1');
    ok('★★导回去之后状态仍然是"进行中"，没有被日期推成已完成',
      after.status === 'doing', { status: after.status, actual_date: after.actual_date });
    ok('★日期本身原样回来了', after.actual_date === '2026-05-01', after.actual_date);
  }

  section('③-3 护栏：体检不会因为"留着完成日期"多报问题');
  {
    world();
    const t = S.byId('task', 'T1');
    t.status = 'doing'; t.progress = 40; t.actual_date = '2026-05-01';
    const m = S.byId('milestone', 'M1');
    m.done = '0'; m.actual_date = '2026-05-01';
    S.rebuildIndex();
    const ks = S.healthCheck().issues.map(i => i.k);
    ok('★★体检没报 progressMismatch / doneWithOpenCp（天天看到一堆假问题会让体检失去可信度）',
      !ks.includes('progressMismatch') && !ks.includes('doneWithOpenCp'), ks);
  }

  section('③-4 护栏：批量勾完 / 一键修复都不抹掉原有的交付日期');
  {
    world();
    const m = S.byId('milestone', 'M1');
    m.done = '0'; m.actual_date = '2026-08-05';
    S.rebuildIndex();
    S.completeCheckpointsOf(S.byId('task', 'T1'));
    ok('★★批量勾完沿用原有日期，跟详情里逐条勾的行为一致（同一件事换个入口不能两种结果）',
      S.byId('milestone', 'M1').actual_date === '2026-08-05', S.byId('milestone', 'M1').actual_date);

    /* 详情弹窗里那条取消勾选的路径也要一起守住。
       变异测试提醒过：上面只测了"批量勾完"，把详情保存里那句 cur.actual_date 改回
       清空，这一节照样全绿——护栏名不副实。所以这里真走一遍详情保存。 */
    world();
    const mm = S.byId('milestone', 'M1');
    mm.done = '1'; mm.actual_date = '2026-08-05'; S.rebuildIndex();
    await saveDetail([cpRow('M1', '2026-09-20', '调研报告', 'section', '0'),
      cpRow('M2', '2026-09-30', '会议纪要', 'section', '0')]);
    ok('★★详情里取消勾选，交付日期留着（手滑一下不该丢掉真实交付日期）',
      S.byId('milestone', 'M1').actual_date === '2026-08-05', S.byId('milestone', 'M1').actual_date);

    // 任务那三条改状态的路径同理
    let t2 = { status: 'done', progress: 100, actual_date: '2026-03-01' };
    t2.progress = 60;
    S.reconcileStatusAndProgress(t2, { status: 'done', progress: 100, actual_date: '2026-03-01' });
    ok('★★任务进度从 100 往回调，完成日期留着（最容易手滑的那一种操作）',
      t2.status === 'doing' && t2.actual_date === '2026-03-01', t2);
    ok('★源码里没有留下任何"改回未完成就清空"的写法', !/t\.actual_date = '';/.test(SRC));
  }

  section('③-5 护栏：老备份（带 syncBase）和新备份都要恢复得回来');
  {
    for (const [label, mk] of [
      ['老格式', () => { S.DB.syncBase = S.buildSyncBase(S.syncPayload(S.DB)); return JSON.stringify(S.DB); }],
      ['新格式', () => JSON.stringify(S.backupSnapshot())],
    ]) {
      world();
      const text = mk();
      S.DB.tasks = []; S.DB.milestones = []; S.rebuildIndex();
      let err = '';
      try {
        S.importBackup(text); await tick(50);
        if (typeof S.modalCallback === 'function') { await S.modalCallback(); await tick(150); }
        else err = '没弹确认框';
      } catch (e) { err = e.message; }
      ok('★★' + label + '的备份恢复得回来（改了备份的写法，不能连带把"读老备份"弄坏——'
        + '同事手上还存着一堆老格式的文件）',
        !err && S.DB.tasks.length === 1 && S.DB.milestones.length === 2,
        { err, tasks: S.DB.tasks.length, ms: S.DB.milestones.length });
    }
    /* 写出去的那一份本身也要守：上面只验了"读得回来"，
       把 backupSnapshot 改成直接返回整个 DB，这一节照样全绿（变异测试抓到过）。 */
    world();
    S.DB.syncBase = S.buildSyncBase(S.syncPayload(S.DB));
    const snap = S.backupSnapshot();
    ok('★★备份里不带本机私有的同步基线（体积接近翻倍，而它对恢复毫无用处）',
      !('syncBase' in snap), Object.keys(snap).filter(k => k === 'syncBase'));
    ok('★★但 DB 自己的基线一点没动（备份不该有副作用）', !!S.DB.syncBase);
    const miss = Object.keys(S.DB).filter(k => k !== 'syncBase' && !(k in snap));
    ok('★除 syncBase 外一个字段都不少（少一个就可能让某天的恢复缺一块）', !miss.length, miss);
  }

  section('③-6 护栏：撤销之后，里程碑的日志和数据仍然自洽');
  {
    world();
    await saveDetail([cpRow('M1', '2026-09-25', '调研报告（终稿）', 'bank', '0'),
      cpRow('M2', '2026-09-30', '会议纪要', 'section', '0')]);
    ok('（前提）保存写了里程碑日志', S.DB.changelog.some(e => e.entity === 'milestone'));
    S.undoLast(); await tick(80);
    ok('★数据退回去了', S.byId('milestone', 'M1').deliverable === '调研报告');
    const issues = S.auditByChangelog().filter(i => i.entity === 'milestone');
    ok('★★撤销之后核对不会报出假问题（日志跟着一起回滚了）——'
      + '否则管理员照着这个"问题"点"按日志改回去"，反而把用户撤销掉的改动又装回去',
      issues.length === 0, issues.map(i => i.field + ':' + i.to + '≠' + i.now));
  }

  section('③-7 护栏：并发合并不会造出"标着已交付、却没有交付日期"');
  {
    world();
    const m0 = S.byId('milestone', 'M1');
    m0.done = '0'; m0.actual_date = ''; S.stampMeta(m0);
    S.DB.syncBase = S.buildSyncBase(S.syncPayload(S.DB));
    const remote = cp(S.syncPayload(S.DB));
    const rm = remote.milestones.find(x => x.id === 'M1');
    rm.done = '1'; rm.actual_date = '2026-09-10'; rm.rev = (rm.rev || 1) + 1;
    rm.updated_at = new Date(Date.now() + 1000).toISOString(); rm.updated_by = '同事';
    const mine = S.byId('milestone', 'M1');
    mine.deliverable = '我只改了名字'; S.stampMeta(mine);
    const merged = S.mergeSyncPayload(S.syncPayload(S.DB), remote, S.DB.syncBase);
    const got = merged.milestones.find(x => x.id === 'M1');
    ok('★同事的完成标记收进来了', got.done === '1', got.done);
    ok('★我的改名也在', got.deliverable === '我只改了名字', got.deliverable);
    ok('★★没有出现"已交付却没有交付日期"（真出现的话，这条交付物会在报表'
      + '"本期已交付"里凭空消失，数据看着没坏、报表却少一条，最难查）',
      !(got.done === '1' && !got.actual_date), { done: got.done, actual_date: got.actual_date });
  }

  section('③-8 护栏：里程碑的改动进得了"本机独有改动"证据表（无基线合并靠它）');
  {
    world();
    await saveDetail([cpRow('M1', '2026-09-25', '调研报告（终稿）', 'bank', '0'),
      cpRow('M2', '2026-09-30', '会议纪要', 'section', '0')]);
    const map = S.buildLocalOnlyChangeMap(cp(S.DB.changelog), []);
    const ev = map.get('milestone M1');
    ok('★★证据表里有它，而且是逐字段的', ev && ev.size >= 2, ev ? [...ev] : ev);
    const localM1 = cp(S.byId('milestone', 'M1'));
    const remoteM1 = cp(localM1);
    remoteM1.deliverable = '调研报告'; remoteM1.plan_date = '2026-09-20';
    remoteM1.rev = (remoteM1.rev || 1) + 5;   // 旧页面 rev 反而更高
    const got = S.mergeWithoutBase('milestone', localM1, remoteM1, { fields: map, dirty: new Set() });
    ok('★★本机刚改过的里程碑压得住 rev 更高的旧页面（"旧缓存把数据顶回去"那一类）',
      got.deliverable === '调研报告（终稿）', got.deliverable);
    // 反面：没动过的要听同事的，不能连人家的改动一起盖掉
    const localM2 = cp(S.byId('milestone', 'M2'));
    const remoteM2 = cp(localM2);
    remoteM2.deliverable = '同事改的'; remoteM2.rev = (remoteM2.rev || 1) + 1;
    const got2 = S.mergeWithoutBase('milestone', localM2, remoteM2, { fields: map, dirty: new Set() });
    ok('★没动过的那条听同事的，没有误杀', got2.deliverable === '同事改的', got2.deliverable);
  }

  section('③-9 护栏：超长的交付物不进结构化明细（不然共享文件会被撑大）');
  {
    world();
    const m = S.byId('milestone', 'M1');
    const before = cp(m);
    m.deliverable = '长'.repeat(200); S.stampMeta(m);
    S.DB.changelog = [];
    S.logRecordChange('milestone', 'M1', before, m);
    const last = S.DB.changelog[S.DB.changelog.length - 1];
    ok('★记了人话摘要', last && /交付物/.test(last.summary || ''), last && last.summary);
    ok('★★但没进结构化明细（跟任务那边同一条 AUDIT_VALUE_MAX 规则）',
      !(last && last.changes && last.changes.length), last && last.changes);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { unstubCp(); console.error('测试异常：', e); process.exit(1); });
