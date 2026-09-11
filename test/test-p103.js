/* P103：第十三轮全面排查——"不是同步 bug，但数据确实丢了"这一整类

   为什么要换判据：第十一、十二轮用的是"本机 == 共享文件"，而上一轮（P102）查出来的
   派生字段重算恰好满足这个判据（两边都被改成同一个错值），所以一直漏着。
   这一轮改成两条更接近用户感受的判据：
     · 我填进去的值，事后还在不在；
     · 记录条数只能按我的意图变化。
   按这两条把"会悄悄改写/删掉数据"的代码点挨个点了一遍（scratchpad/probe13.js、probe13b.js），
   查出来 6 处，全部在这个文件里钉住：

   ① CSV 覆盖导入会把"表头里没出现的列"清空（探针1）★ 最严重、最容易踩
      拿一张只有「编号,状态」两列的表走覆盖模式，这些任务的标题、牵头人、参与人、
      计划完成时间、备注全被清成空白，还会 stampMeta 抬版本号推给全处，
      日志里只留一句"覆盖 N 条"。这种表在实际工作里太常见了。
   ② 宽表覆盖导入把已交付的里程碑打回"未交付"（探针11）★ 同样严重
      一条任务原有 3 个里程碑、2 个已交付并填了实际完成日期；拿一张【计划内容完全一样】
      的宽表导一次，交付状态和实际完成日期全部清零、进度从 67% 归零。
      而宽表恰恰是批量维护计划最常用的入口——改一次计划日期就可能抹掉一年的交付记录。
   ③ 宽表覆盖导入删掉的现有里程碑不点名（探针12）
      删是刻意行为（表里没出现就该清），但不说删了哪几个，等于没法从回收站找回来。
   ④ 登录记录把带明细的变更记录挤掉（探针4）
      800 条上限是登录和变更共用的，十几个人日常登录几天就能灌满，
      带逐字段明细的记录一条不剩——而那是「按日志核对」唯一的证据，上一轮刚修好的工具被废掉。
   ⑤ 认不出来的数字存成 NaN（探针5）
      共享文件被人用记事本改过、或 Excel 里进度填成"八十"时，Number() 得到 NaN，
      JSON.stringify 写出来是 null，之后所有算术（进度条、SPI、按人统计）全是 NaN。
   ⑥ 一整份报告/工作台编排被覆盖掉，一声不响（探针15）
      原来只在"版本号打平"时才报，而 rev 是各机器独立 +1 的计数，不同版本号并不代表
      有先后因果——我刚排好的一整份编排被 rev 更大的那份整份盖掉，日志里一个字都没有。
   ⑦ 我刚加的里程碑因为同事删了所属任务而被级联删掉，一声不响（探针3）
      级联本身是对的（否则留下界面上打不开、却照样进统计的无主里程碑），
      但对我来说就是刚填的交付物凭空不见了，而且级联不写日志（写了会在文件里重复好几条）。

   用法：node test/test-p103.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 400) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
function mkHandle(text) {
  const h = { name: 'shared.json', _text: text, _mtime: 1, _writes: 0,
    async getFile() { const s = h._text; return { lastModified: h._mtime, text: async () => s }; },
    async createWritable() { return { async write(t) { h._p = t; }, async close() { h._writes++; h._text = h._p; h._mtime++; } }; } };
  return h;
}
const fileOf = h => JSON.parse(h._text);
let _h = null;

function reset() {
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、规划', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    content: ['内容一', '内容二'], owner: '张三', collaborators: ['李四'], year: 2026, status: 'active' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261', title: '原标题',
    owner: '张三', assignees: ['李四', '王五'], status: 'doing', priority: '1', plan_date: '2026-10-01',
    progress: 67, actual_date: '', source: '处里自定', custom: '备注内容' }))];
  S.DB.milestones = [
    S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', deliverable: '一季度报告', plan_date: '2026-03-31', done: '1', actual_date: '2026-03-28' })),
    S.stampMeta(S.blank('milestone', { id: 'M2', task: 'T1', deliverable: '二季度报告', plan_date: '2026-06-30', done: '1', actual_date: '2026-06-25' })),
    S.stampMeta(S.blank('milestone', { id: 'M3', task: 'T1', deliverable: '三季度报告', plan_date: '2026-09-30', done: '0', actual_date: '' })),
  ];
  S.DB.changelog = []; S.DB.purged = [];
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.DB.settings.me = '测试管理员';
  S.undoStack.length = 0;
  S.setSnackPriorityUntil(0);
  q('#snack-msg').textContent = '';
  S.rebuildIndex();
  _h = mkHandle(JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'] })));
  S.setFileHandle(_h);
  S.setEverConnected(true);
}
const WIDE_HEAD = '所属工作项,任务项编号,任务项名称,任务项牵头人,任务项参与人,'
  + '里程碑时间1,里程碑交付物1,里程碑交付物最高呈报1,里程碑时间2,里程碑交付物2,里程碑交付物最高呈报2,'
  + '里程碑时间3,里程碑交付物3,里程碑交付物最高呈报3\n';
const liveMs = () => S.DB.milestones.filter(m => m.task === 'T1' && !m.deleted_at);
const logHit = kw => (S.DB.changelog || []).filter(e => String(e.summary).indexOf(kw) !== -1);

async function main() {
  await tick(150);

  section('一、★★CSV 覆盖导入：表头里没出现的列必须保持原值');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const snap = JSON.parse(JSON.stringify(S.byId('task', 'T1')));
    await S.applyCSVImport('task', 'merge', 'code,status\n0101261,done\n');
    await tick(30);
    const t = S.byId('task', 'T1');
    ok('★★标题没被清空', t.title === snap.title, t.title);
    ok('★★牵头人没被清空', t.owner === snap.owner, t.owner);
    ok('★★参与人没被清空（数组字段最容易被悄悄变成空数组）',
      JSON.stringify(t.assignees) === JSON.stringify(snap.assignees), t.assignees);
    ok('★★计划完成时间没被清空', t.plan_date === snap.plan_date, t.plan_date);
    ok('★★备注、来源这些不常出现在表里的字段也保住了',
      t.custom === snap.custom && t.source === snap.source, { custom: t.custom, source: t.source });
    ok('★表里给了的那一列确实被覆盖了（不能因为保护而连该改的都不改）', t.status === 'done', t.status);
    ok('★创建时间没被导入改成今天', t.created_at === snap.created_at, { before: snap.created_at, after: t.created_at });
    ok('★版本号抬高了，改动推得出去', t.rev > snap.rev, { before: snap.rev, after: t.rev });
    ok('★★日志里写明了这次表头里有哪些列（事后排查"谁把牵头人改了"要靠它）',
      logHit('CSV 导入').length === 1 && /本次表头里有的列/.test(logHit('CSV 导入')[0].summary)
        && /状态/.test(logHit('CSV 导入')[0].summary),
      (logHit('CSV 导入')[0] || {}).summary);
  }

  section('一之二、想清空某个字段照样做得到——把那一列放进表头、留空');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    await S.applyCSVImport('task', 'merge', 'code,custom,assignees\n0101261,,\n');
    await tick(30);
    const t = S.byId('task', 'T1');
    ok('★列在表头里、单元格留空 → 字段被清空（这是明确表达过的意图）',
      t.custom === '' && JSON.stringify(t.assignees) === '[]', { custom: t.custom, assignees: t.assignees });
    ok('★同时没出现在表头的字段仍然保住', t.title === '原标题' && t.owner === '张三');
  }

  section('一之二点五、★顺带修掉的一个静默复活：导入不会把回收站里的记录捞回来');
  {
    /* 原来是整条替换：新拼出来的 rec 上根本没有 deleted_at 字段，于是一份
       "带 id 列、但没有 deleted_at 列"的表（人在 Excel 里把那一列删了，很常见）
       导进来，就把回收站里的记录悄悄恢复成活的了——而且抬了版本号，推给全处。
       改成"只覆盖表里有的列"之后，删除状态属于"表里没提到的东西"，原样保留。 */
    reset();
    S.softDelete('task', 'T1');
    await S.Repo.persist(S.DB); await tick(25);
    ok('前置：T1 在回收站里', !!S.byId('task', 'T1').deleted_at);
    await S.applyCSVImport('task', 'merge', 'id,code,work,title,status\nT1,0101261,w1,改过的标题,done\n');
    await tick(30);
    const t = S.byId('task', 'T1');
    ok('★★表里没有 deleted_at 列时，回收站里的记录不会被悄悄复活', !!t.deleted_at);
    ok('★表里给了的列照样生效', t.title === '改过的标题' && t.status === 'done', { title: t.title, status: t.status });
    ok('★没有凭空多出一条重号任务', S.DB.tasks.filter(x => x.code === '0101261').length === 1,
      S.DB.tasks.filter(x => x.code === '0101261').length);
  }

  section('一之三、回归：增量模式和新建行不受影响');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const n0 = S.DB.tasks.length;
    await S.applyCSVImport('task', 'append', 'work,title,owner,status\nw1,新建的任务,赵六,todo\n');
    await tick(30);
    ok('增量模式照样新增一条', S.DB.tasks.length === n0 + 1);
    const nt = S.DB.tasks.find(x => x.title === '新建的任务');
    ok('★新建的行，表里没给的列是空值（不是 undefined，也不该去"保留"谁的原值）',
      nt && nt.custom === '' && JSON.stringify(nt.assignees) === '[]' && nt.plan_date === '',
      nt && { custom: nt.custom, assignees: nt.assignees, plan_date: nt.plan_date });
    ok('★新建的行自动补了编号', nt && !!nt.code, nt && nt.code);
  }

  section('二、★★宽表覆盖导入：已交付的里程碑不能被打回"未交付"');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    // 一张计划内容跟现状完全一样的宽表
    const csv = WIDE_HEAD + '工作一,0101261,任务一,张三,李四,'
      + '2026-03-31,一季度报告,,2026-06-30,二季度报告,,2026-09-30,三季度报告,\n';
    const res = await S.applyWideImport('merge', csv);
    await tick(35);
    const live = liveMs();
    ok('★里程碑还是 3 个，没有被重建成一批新的', live.length === 3, live.length);
    ok('★★已交付的那 2 个仍然是已交付', live.filter(m => m.done === '1').length === 2,
      live.map(m => m.deliverable + ':' + m.done));
    ok('★★实际完成日期一个都没丢', live.filter(m => m.actual_date).length === 2,
      live.map(m => m.deliverable + ':' + m.actual_date));
    ok('★★任务进度没有归零', S.byId('task', 'T1').progress === 67, S.byId('task', 'T1').progress);
    ok('★认领的是原来那几条记录（id 没变，不会白白产生新 id 和一地墓碑）',
      live.map(m => m.id).sort().join(',') === 'M1,M2,M3', live.map(m => m.id));
    ok('★这次没有里程碑被移进回收站', res.msDropped === 0, res);
  }

  section('二之二、★宽表里改了计划日期/呈报层级，该更新的要更新');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const csv = WIDE_HEAD + '工作一,0101261,任务一,张三,李四,'
      + '2026-04-30,一季度报告,,2026-06-30,二季度报告,,2026-09-30,三季度报告,\n';
    await S.applyWideImport('merge', csv);
    await tick(35);
    const m1 = S.byId('milestone', 'M1');
    ok('★计划日期按表里的新值更新了', m1.plan_date === '2026-04-30', m1.plan_date);
    ok('★★但交付状态和实际完成日期原样保留（改计划不等于把交付记录抹掉）',
      m1.done === '1' && m1.actual_date === '2026-03-28', { done: m1.done, actual: m1.actual_date });
  }

  section('三、★宽表覆盖导入删掉的现有里程碑必须点名');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const csv = '所属工作项,任务项编号,任务项名称,任务项牵头人,任务项参与人,里程碑时间1,里程碑交付物1,里程碑交付物最高呈报1\n'
      + '工作一,0101261,任务一,张三,李四,2026-03-31,一季度报告,\n';
    const res = await S.applyWideImport('merge', csv);
    await tick(35);
    ok('表里出现的那个被认领、留下', liveMs().length === 1 && liveMs()[0].id === 'M1', liveMs().map(m => m.id));
    ok('★没出现的 2 个被移进回收站（软删，可恢复，不是彻底删）',
      S.DB.milestones.filter(m => m.task === 'T1' && m.deleted_at).length === 2);
    ok('★返回值里报了条数', res.msDropped === 2, res.msDropped);
    const lg = logHit('宽表导入')[0];
    ok('★★日志里点了名，事后能照着去回收站找回来',
      lg && /二季度报告/.test(lg.summary) && /三季度报告/.test(lg.summary), lg && lg.summary);
    ok('★日志里说了去哪儿恢复', lg && /回收站/.test(lg.summary), lg && lg.summary);
    ok('★这条日志真的推进了共享文件',
      (fileOf(_h).changelog || []).some(e => /宽表导入/.test(String(e.summary)) && /二季度报告/.test(String(e.summary))));
  }

  section('三之二、★★整行的里程碑列都空着时，不许把现有里程碑全扫进回收站');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    // 一份只整理了任务列的表：里程碑列全留空（很常见——只想改牵头人/名称）
    const csv = WIDE_HEAD + '工作一,0101261,任务一,改成赵六,李四,,,,,,,,,\n';
    const res = await S.applyWideImport('merge', csv);
    await tick(35);
    ok('★★三个里程碑一个都没被动（原来会整批扫进回收站）', liveMs().length === 3, liveMs().map(m => m.id));
    ok('★已交付状态也没动', liveMs().filter(m => m.done === '1').length === 2);
    ok('★返回值里没有"被移走"的计数', res.msDropped === 0, res.msDropped);
    ok('★任务本身该改的还是改了', S.byId('task', 'T1').owner === '改成赵六', S.byId('task', 'T1').owner);
    ok('★进度没归零', S.byId('task', 'T1').progress === 67, S.byId('task', 'T1').progress);
  }

  section('四、★★日志裁剪要分等级：登录记录不能把带明细的变更记录挤掉');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    const t = S.byId('task', 'T1');
    const b = JSON.parse(JSON.stringify(t));
    t.progress = 88;
    S.logRecordChange('task', 'T1', b, t, ['progress']);
    const keyId = S.DB.changelog[S.DB.changelog.length - 1].id;
    S.pushAlertLog('一条越权告警');
    const alertId = S.DB.changelog[S.DB.changelog.length - 1].id;
    for (let i = 0; i < S.CHANGELOG_LIMIT + 200; i++) S.pushLoginLog('同事' + (i % 14), '登录');
    ok('总数被压回上限', S.DB.changelog.length === S.CHANGELOG_LIMIT, S.DB.changelog.length);
    ok('★★带逐字段明细的那条变更记录活下来了（按日志核对唯一的证据）',
      S.DB.changelog.some(e => e.id === keyId));
    ok('★★告警记录也活下来了', S.DB.changelog.some(e => e.id === alertId));
    ok('★被丢掉的是登录记录', S.DB.changelog.filter(e => S.logKind(e) === 'login').length < S.CHANGELOG_LIMIT);
    ok('★活下来的仍然按时间顺序排着（没被打乱）',
      S.DB.changelog.every((e, i, a) => i === 0 || String(a[i - 1].at || '') <= String(e.at || '')));
  }

  section('四之二、★capChangelog 的分等级口径');
  {
    const mk = (id, kind, changes) => ({ id, at: '2026-01-' + String(id).padStart(2, '0') + 'T00:00:00.000Z',
      kind, summary: 's' + id, changes });
    const list = [
      mk(1, 'login'), mk(2, 'edit'), mk(3, 'edit', [{ k: 'x' }]),
      mk(4, 'login'), mk(5, S.ALERT_LOG_KIND), mk(6, 'edit', [{ k: 'y' }]),
    ];
    const kept3 = S.capChangelog(list, 3).map(e => e.id);
    ok('★只留 3 条时，留下的是带明细的 edit 和告警', JSON.stringify(kept3) === JSON.stringify([3, 5, 6]), kept3);
    const kept5 = S.capChangelog(list, 5).map(e => e.id);
    ok('★只需丢 1 条时，丢的是最旧的那条登录', JSON.stringify(kept5) === JSON.stringify([2, 3, 4, 5, 6]), kept5);
    ok('不超上限时原样返回', S.capChangelog(list, 10).length === 6);
    ok('空列表不抛异常', S.capChangelog([], 5).length === 0 && S.capChangelog(null, 5).length === 0);
  }

  section('四之三、★合并时也要用同一套裁剪口径（否则同步一次就白保护）');
  {
    reset();
    const keep = { id: 'KEY', at: '2026-05-01T00:00:00.000Z', kind: 'edit', entity: 'task', refId: 'T1',
      summary: '进度：60→88', changes: [{ k: 'progress', from: 60, to: 88 }] };
    const localLogs = [keep];
    const remoteLogs = [];
    for (let i = 0; i < S.CHANGELOG_LIMIT + 100; i++) {
      remoteLogs.push({ id: 'L' + i, at: '2026-06-' + String((i % 28) + 1).padStart(2, '0') + 'T00:00:00.000Z',
        kind: 'login', by: '同事', summary: '登录' });
    }
    const merged = S.mergeChangelog(localLogs, remoteLogs);
    ok('★★合并后总数压回上限', merged.length === S.CHANGELOG_LIMIT, merged.length);
    ok('★★同事灌进来一大批登录记录，也挤不掉我那条带明细的变更记录',
      merged.some(e => e.id === 'KEY'));
  }

  section('五、★认不出来的数字不能存成 NaN');
  {
    reset();
    const r = { id: 'X', work: 'w1', code: '0101299', title: 'x', progress: '八十', status: 'doing' };
    S.normalize('task', r);
    ok('★进度落回 0，不是 NaN', r.progress === 0, String(r.progress));
    ok('★存进 JSON 再读回来还是 0（NaN 会变成 null）',
      JSON.parse(JSON.stringify(r)).progress === 0, JSON.parse(JSON.stringify(r)).progress);
    const w = { id: 'w9', code: '0199', duty: '01', name: 'x', year: '二〇二六', status: 'active' };
    S.normalize('work', w);
    ok('★年度这类非 progress 的数字字段落回空串', w.year === '', String(w.year));
    const good = { id: 'Y', work: 'w1', code: '0101298', title: 'y', progress: '80', status: 'doing' };
    S.normalize('task', good);
    ok('回归：认得出来的数字照常转成数字', good.progress === 80);
    const neg = { id: 'Z', work: 'w1', code: '0101297', title: 'z', progress: Infinity, status: 'doing' };
    S.normalize('task', neg);
    ok('★Infinity 也按"认不出来"处理', neg.progress === 0, String(neg.progress));
  }

  section('六、★一整份编排被覆盖掉必须留痕（版本号不相等时原来一声不响）');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    S.DB.settings.lastSyncAt = new Date(Date.now() - 60000).toISOString();
    // 我在上次对账之后改了报告编排
    S.DB.reportConfig = { sections: [{ k: '我改的版本' }], rev: 5,
      updated_at: new Date().toISOString(), updated_by: '测试管理员' };
    const f = fileOf(_h);
    f.reportConfig = { sections: [{ k: '同事改的版本' }], rev: 9,
      updated_at: new Date(Date.now() + 1000).toISOString(), updated_by: '同事乙' };
    _h._text = JSON.stringify(f); _h._mtime++;
    S.setObjConflicts([]);
    const n0 = S.DB.changelog.length;
    await S.Repo.persist(S.DB); await tick(40);
    const added = S.DB.changelog.slice(n0);
    const alert = added.find(e => S.logKind(e) === S.ALERT_LOG_KIND && /配置/.test(String(e.summary)));
    ok('★★版本号不相等、我那份被整份丢弃时也会留一条告警', !!alert,
      added.map(e => S.logKind(e) + '|' + String(e.summary).slice(0, 60)));
    ok('★告警里点明了是哪一份配置', alert && /报告页编排/.test(alert.summary), alert && alert.summary);
    ok('★告警里说明了是我这边那份被覆盖', alert && /我这边那份改动被覆盖/.test(alert.summary), alert && alert.summary);
    ok('★这条告警推进了共享文件（不能只有我自己知道）',
      (fileOf(_h).changelog || []).some(e => /报告页编排/.test(String(e.summary))));
  }

  section('六之二、★不能反过来变成噪音：我这份根本没动过时不许报');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    // 我这份是很久以前的，上次对账之后我没碰过它
    S.DB.reportConfig = { sections: [{ k: '旧的' }], rev: 2,
      updated_at: '2026-01-01T00:00:00.000Z', updated_by: '测试管理员' };
    S.DB.settings.lastSyncAt = new Date().toISOString();
    const f = fileOf(_h);
    f.reportConfig = { sections: [{ k: '同事的新版本' }], rev: 9,
      updated_at: new Date(Date.now() + 1000).toISOString(), updated_by: '同事乙' };
    _h._text = JSON.stringify(f); _h._mtime++;
    const n0 = S.DB.changelog.length;
    await S.Repo.persist(S.DB); await tick(40);
    const added = S.DB.changelog.slice(n0).filter(e => /配置/.test(String(e.summary)));
    ok('★★我只是落后于文件、并没有改动被丢掉 → 不报（否则每轮同步都来一条噪音）',
      added.length === 0, added.map(e => e.summary));
    ok('回归：还是采用了同事那份新的',
      JSON.stringify(S.DB.reportConfig.sections).indexOf('同事的新版本') !== -1);
  }

  section('七、★我刚加的里程碑被"同事删了任务"连带删掉时要当场说一句');
  {
    reset();
    await S.Repo.persist(S.DB); await tick(25);
    // 同事在共享文件里把任务删进回收站（他手里没有我即将新加的里程碑）
    const f = fileOf(_h);
    const ft = f.tasks.find(x => x.id === 'T1');
    ft.deleted_at = new Date().toISOString(); ft.rev = (ft.rev || 1) + 1;
    ft.updated_at = new Date().toISOString(); ft.updated_by = '同事乙';
    _h._text = JSON.stringify(f); _h._mtime++;
    // 我这边新加一个里程碑
    S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: 'M9', task: 'T1',
      deliverable: '我刚加的交付物', plan_date: '2026-11-01', done: '0' })));
    S.setSnackPriorityUntil(0);
    q('#snack-msg').textContent = '';
    await S.Repo.persist(S.DB); await tick(40);
    const m9 = S.DB.milestones.find(x => x.id === 'M9');
    ok('里程碑确实被级联标记删除了（这一步本身是对的，否则会留下无主里程碑）', !!(m9 && m9.deleted_at));
    const snack = q('#snack-msg').textContent;
    ok('★★当场提示了（原来一声不响）', /进回收站/.test(snack), snack);
    ok('★提示里点了交付物的名字或条数', /我刚加的交付物/.test(snack) || /个里程碑/.test(snack), snack);
    ok('★★提示里说清楚了怎么找回来：恢复任务会带回里程碑', /恢复任务/.test(snack), snack);
    ok('★只提示本机、不往共享日志里写（每台机器都会各自算出同样结果，写了会重复好几条）',
      !(fileOf(_h).changelog || []).some(e => /进回收站/.test(String(e.summary))));
  }

  section('七之二、★不是我加的里程碑被级联删掉，不弹提示（不制造噪音）');
  {
    reset();
    // 这条任务名下原有的那几个里程碑也都改成"别人很久以前建的"，
    // 否则它们本身就满足"我刚建的"，测不出这一条
    S.DB.milestones.forEach(m => {
      m.created_at = '2026-01-01T00:00:00.000Z';
      m.updated_at = '2026-01-01T00:00:00.000Z';
      m.updated_by = '同事丙';
    });
    await S.Repo.persist(S.DB); await tick(25);
    const f = fileOf(_h);
    const ft = f.tasks.find(x => x.id === 'T1');
    ft.deleted_at = new Date().toISOString(); ft.rev = (ft.rev || 1) + 1;
    ft.updated_at = new Date().toISOString(); ft.updated_by = '同事乙';
    _h._text = JSON.stringify(f); _h._mtime++;
    // 这个里程碑是别人很久以前建的
    S.DB.milestones.push({ id: 'M8', task: 'T1', deliverable: '别人很久前建的', plan_date: '2026-02-01',
      done: '0', report_level: '', actual_date: '', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z', updated_by: '同事丙', rev: 1 });
    S.rebuildIndex();
    S.setSnackPriorityUntil(0);
    q('#snack-msg').textContent = '';
    await S.Repo.persist(S.DB); await tick(40);
    ok('★不是我刚加的，就不弹这条提示', q('#snack-msg').textContent.indexOf('进回收站') === -1,
      q('#snack-msg').textContent);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
