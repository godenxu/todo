/* P113：第二十一轮排查——三个没正面查过的面 + 重查前两轮改动的波及

   ── 真问题（2 个） ──
   ① 本机缓存写失败是【静默】的
      localStorage 写不进去最常见的原因是容量满，而这不是杞人忧天：按处室实际规模实测
      （15 职责 / 40 工作 / 300 任务 / 600 里程碑 / 2000 日志），整份 DB 序列化约 117 万字符，
      localStorage 按 UTF-16 存实际占用约 2.2MB，浏览器给每个来源的限额通常 5MB——
      已经用掉四成多，而上一轮刚把日志上限从 800 提到 2000（日志就占 1.2MB）。
      源码里四个写入点，除 Repo.persist 外全是 try { setItem } catch (e) {}，一声不吭。
      最要命的是 pullFromFile 结尾那一处：刚把同事的改动合并进内存、基线也重算好了，
      这一步写不进去，用户刷新页面就回到旧数据——表现出来正是
      「我明明看到同步过来了，刷新一下又没了」，而这恰恰是这套系统被抱怨最多的症状。
      基线没落盘还有第二层后果：下次三方合并没基线可用，只能退回按 rev 定胜负，
      "旧缓存把数据顶回去"那一类问题会跟着回来。
      现在收口成 saveLocalCache：写失败一定说话（节流 10 分钟），并记下标志。

   ② 编排预案（presets）跟着整份配置一起被覆盖，攒的东西找不回来
      实测：管理员攒了三套报告编排（月度版/季度版/我自己排的），同事在另一台机器上改了一次编排、
      rev 更高先推上去，整份覆盖之后本机那三套【全部消失】，共享文件里也没有了，再也找不回来。
      原有的"配置被整份覆盖"提醒是有的（mergePermissionMatrix 的 label 那套，实测确认在工作），
      但它只能告诉人"你那份被覆盖了"，东西回不来。
      而 presets 是每项都带 id 的数组，跟任务/工作/里程碑是同一种东西，本来就该按 id 合并。

   ③ 里程碑的改动在工作台「最近动态」里完全隐形
      最近动态按 taskId 过滤，而 pushChangeLog 原来只在 entity==='task' 时填 taskId，
      里程碑一律留空（当初是为了不让工作/职责污染面板，里程碑被顺带挡在了外面）。
      于是只改一条里程碑的呈报层级（日期、交付物都不动）时：任务那条日志根本不会写
      （任务字段没变、检查点条数也没变，summary 是空的，logRecordChange 开头就返回了），
      里程碑那条写了却进不了面板——两头一夹，这次改动在最近动态里一个字都看不到。
      而管理员正是靠这个面板看"同事今天动了什么"。
      现在按实体填：任务填自己、里程碑填所属任务、工作/职责仍然留空。

   ── 查了没问题的，一并钉成护栏 ──
   日志上限 800→2000 之后："有没有新东西要推"的判据不受影响（对方那份按旧上限满了也照样推）、
   合并 2000+2000 条 22ms / 裁剪 5ms / 日志页筛选 1ms；回收站清理不误伤活着的记录、有留痕有权限闸。

   用法：node test/test-p113.js */
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
function mkHandle(t) {
  const h = { name: 'shared.json', _text: t, _mtime: 1,
    async getFile() { const s = h._text; return { lastModified: h._mtime, text: async () => s }; },
    async createWritable() { return { async write(x) { h._p = x; }, async close() { h._text = h._p; h._mtime++; } }; } };
  return h;
}
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
  S.DB.reportConfig = null; S.DB.dashboardConfig = null; S.DB.shareConfig = null;
  S.clearSyncBaseline(S.DB); S.undoStack.length = 0;
  S.setFileHandle(null); S.setEverConnected(false);
  S.setSnackPriorityUntil(0); S.setLocalSaveFailedAt(0);
  S.rebuildIndex();
}
// 让 localStorage 对 STORAGE_KEY 的写入一律失败（模拟容量满）
function blockLocalWrites() {
  const store = S.storage, orig = store.setItem;
  store.setItem = function (k, v) {
    if (k === S.STORAGE_KEY) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    return orig.call(store, k, v);
  };
  return () => { store.setItem = orig; };
}

async function main() {
  await tick(120);

  /* ═════════ ① 本机缓存写失败不能再静默 ═════════ */
  section('①-1 saveLocalCache：成功/失败的基本契约');
  {
    world();
    ok('正常情况下写得进去', S.saveLocalCache(S.DB) === true);
    ok('写成功之后不该留着"坏了"的标志', !S.localCacheBroken());

    const restore = blockLocalWrites();
    q('#snack-msg').textContent = '';
    const r = S.saveLocalCache(S.DB);
    const msg = q('#snack-msg').textContent || '';
    restore();
    ok('★★写失败要返回 false（调用方才有机会决定还走不走得下去）', r === false);
    ok('★★而且一定要说话（以前是 try{}catch(e){} 一声不吭）',
      /本机缓存写不进去|存储满/.test(msg), msg);
    ok('★★提示里讲清了后果——不说后果，用户不知道这条提示有多要紧，多半顺手就关了',
      /刷新页面就会回到旧数据|只在内存里/.test(msg), msg);
    ok('★提示还给了下一步该干什么', /导出/.test(msg), msg);
    ok('★★记下了"缓存坏了"这个状态', S.localCacheBroken());
    /* 先坏后好地测一遍"标志会不会自己清掉"。
       只在开头看一眼 localCacheBroken() 是不够的——那时候标志本来就是 0，
       把清零那行整个删掉，断言照样绿（变异测试当场抓到过这个空洞）。
       清不掉的后果：管理员清理完浏览器存储、一切恢复正常之后，
       数据页还一直挂着"缓存写不进去"的警告，几次之后就没人再信它了。 */
    ok('（前提）现在确实是坏的', S.localCacheBroken());
    ok('★★写成功一次之后，"坏了"的标志要自己清掉', S.saveLocalCache(S.DB) === true
      && !S.localCacheBroken(), S.localSaveFailedAt);
    S.setLocalSaveFailedAt(0);
  }

  section('①-2 提示要节流，不能每写一次弹一次');
  {
    world();
    const restore = blockLocalWrites();
    S.saveLocalCache(S.DB);
    q('#snack-msg').textContent = '';
    for (let i = 0; i < 5; i++) S.saveLocalCache(S.DB);
    const msg = q('#snack-msg').textContent || '';
    restore();
    ok('★★连着写 5 次只提示第一次（存储满时每次保存都会撞上，不节流就是刷屏）',
      msg === '', msg);
    ok('★但"坏了"的状态一直留着', S.localCacheBroken());
    S.setLocalSaveFailedAt(0);
  }

  section('①-3 ★最要紧的一处：拉取同步时写不进本机缓存');
  {
    world();
    const h = mkHandle(JSON.stringify(Object.assign(EMPTY(), {
      schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w9', writeIds: ['w9'],
      tasks: [Object.assign(cp(S.DB.tasks[0]), { title: '同事改的标题', rev: 99,
        updated_at: new Date(Date.now() + 10000).toISOString(), updated_by: '同事' })],
      works: cp(S.DB.works), duties: cp(S.DB.duties), milestones: cp(S.DB.milestones) })));
    S.setFileHandle(h); S.setEverConnected(true);
    const restore = blockLocalWrites();
    q('#snack-msg').textContent = '';
    let err = '', r = null;
    try { r = await S.pullFromFile(); await tick(80); } catch (e) { err = e.message; }
    const msg = q('#snack-msg').textContent || '';
    restore();
    ok('★不能抛异常把整条同步链打断', !err, err);
    ok('★同事的改动确实合并进内存了', (S.byId('task', 'T1') || {}).title === '同事改的标题');
    ok('★★但本机缓存没写进去这件事必须说出来——这正是'
      + '「我明明看到同步过来了，刷新一下又没了」的成因', /本机缓存写不进去|存储满/.test(msg), msg);
    S.setLocalSaveFailedAt(0);
    S.setFileHandle(null); S.setEverConnected(false);
  }

  section('①-4 源码层面：不许再有静默吞掉本机缓存写入的地方');
  {
    const silent = (SRC.match(/try \{ localStorage\.setItem\(STORAGE_KEY[^\n]*\} catch \(e\) \{\}/g) || []);
    ok('★★没有任何一处 try{setItem(STORAGE_KEY)}catch{}', silent.length === 0, silent);
    const direct = (SRC.match(/localStorage\.setItem\(STORAGE_KEY/g) || []).length;
    ok('★★只有 saveLocalCache 自己直接写 STORAGE_KEY（唯一出口）', direct === 1, direct);
    const uses = (SRC.match(/saveLocalCache\(/g) || []).length;
    ok('★所有写入路径都接到了这个出口上（定义 1 + 调用若干）', uses >= 8, uses);
    ok('★旧的 flush() 已经没有残留（它是这一轮改名的起点，漏一处就是 ReferenceError）',
      !/\bflush\(\)/.test(SRC));
    /* 置回积压标记的地方一共三处（同步返回非成功、同步抛异常、连过但这会儿没连上），
       每一处都必须跟着落盘。用计数而不是"存不存在"来断言：
       只删其中一处的话，另外两处会让 test 照样通过（变异测试抓到过）。
       漏掉任何一处的后果都一样：刷新一下标记就没了，顶栏那个"改动还没同步出去"的
       红色提醒跟着消失，用户以为存好了。 */
    const pendTrue = (SRC.match(/db\.settings\.pendingSync = true; saveLocalCache\(db\);/g) || []).length;
    ok('★★置回积压标记的三处都落盘了（不是只改内存）', pendTrue === 3, pendTrue);
    ok('★撤销积压标记那一处也落盘',
      /db\.settings\.pendingSync = false; saveLocalCache\(db\); \}/.test(SRC));
  }

  /* ═════════ ② 编排预案不能跟着整份一起丢 ═════════ */
  section('②-1 攒的预案要活下来');
  {
    world();
    S.DB.settings.lastSyncAt = '2026-09-01T00:00:00.000Z';
    S.DB.reportConfig = { rev: 4, created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-09-13T12:00:00.000Z', updated_by: '管理员', activeId: 'p_month',
      presets: [{ id: 'p_month', name: '月度版', blocks: ['a', 'b'] },
        { id: 'p_quarter', name: '季度版', blocks: ['a', 'b', 'c'] },
        { id: 'p_mine', name: '我自己排的', blocks: ['z'] }] };
    const remote = Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
      writeId: 'w0', writeIds: ['w0'],
      reportConfig: { rev: 9, created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-09-13T14:00:00.000Z', updated_by: '同事', activeId: 'p_week',
        presets: [{ id: 'p_week', name: '周报版', blocks: ['x'] }] } });
    const merged = S.mergeSyncPayload(S.syncPayload(S.DB), remote, S.DB.syncBase);
    const c = merged.reportConfig;
    const names = (c.presets || []).map(p => p.name);
    ok('★★我攒的三套一套都没丢（原来整份覆盖之后全部消失，而且再也找不回来）',
      ['月度版', '季度版', '我自己排的'].every(n => names.includes(n)), names);
    ok('★同事那套也在', names.includes('周报版'), names);
    ok('★★"当前用哪套"仍然整份听赢家的（这条行为刻意不改）', c.activeId === 'p_week', c.activeId);
    ok('★★activeId 指得到一套真实存在的预案（指空了报告页会打不开）',
      !!(c.presets || []).find(p => p.id === c.activeId), c.activeId);
    ok('★没有重复 id', new Set((c.presets || []).map(p => p.id)).size === (c.presets || []).length);
  }

  section('②-2 同一个 id 两边都改：用赢家那份，不能变出两条');
  {
    world();
    S.DB.reportConfig = { rev: 4, created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-09-13T12:00:00.000Z', updated_by: '管理员', activeId: 'p1',
      presets: [{ id: 'p1', name: '我改的名字', blocks: ['a'] }] };
    const remote = Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
      writeId: 'w0', writeIds: ['w0'],
      reportConfig: { rev: 9, created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-09-13T14:00:00.000Z', updated_by: '同事', activeId: 'p1',
        presets: [{ id: 'p1', name: '同事改的名字', blocks: ['x'] }] } });
    const c = S.mergeSyncPayload(S.syncPayload(S.DB), remote, S.DB.syncBase).reportConfig;
    ok('★★只有一条（并集是按 id 去重的，不能变出两条同 id）', (c.presets || []).length === 1, c.presets);
    ok('★内容用的是赢家那份', (c.presets[0] || {}).name === '同事改的名字', c.presets[0]);
  }

  section('②-3 工作台编排走同一套规则');
  {
    world();
    S.DB.dashboardConfig = { rev: 2, created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-09-13T12:00:00.000Z', updated_by: '管理员', activeId: 'd1',
      presets: [{ id: 'd1', name: '我的工作台', sections: ['a'] }] };
    const remote = Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
      writeId: 'w0', writeIds: ['w0'],
      dashboardConfig: { rev: 7, created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-09-13T14:00:00.000Z', updated_by: '同事', activeId: 'd2',
        presets: [{ id: 'd2', name: '同事的工作台', sections: ['x'] }] } });
    const c = S.mergeSyncPayload(S.syncPayload(S.DB), remote, S.DB.syncBase).dashboardConfig;
    const names = (c.presets || []).map(p => p.name);
    ok('★★工作台编排的预案同样不丢', names.includes('我的工作台') && names.includes('同事的工作台'), names);
  }

  section('②-4 没有 presets 的配置对象（权限矩阵/共享配置）不能被这段代码弄坏');
  {
    const pm = S.mergePermissionMatrix(
      { rev: 1, staff: { view_data: true }, updated_at: '2026-09-01T00:00:00.000Z' },
      { rev: 5, staff: { view_data: false }, updated_at: '2026-09-02T00:00:00.000Z' }, '权限矩阵');
    ok('★权限矩阵照旧整份取新的那份', pm.staff.view_data === false, pm.staff);
    ok('★没有被塞进一个 presets 字段', !('presets' in pm), Object.keys(pm));
    const sc = S.mergePermissionMatrix(
      { rev: 1, recycleKeepDays: 30, updated_at: '2026-09-01T00:00:00.000Z' },
      { rev: 3, recycleKeepDays: 90, updated_at: '2026-09-02T00:00:00.000Z' }, '共享文件夹配置');
    ok('★共享文件夹配置照旧', Number(sc.recycleKeepDays) === 90, sc);
    // 一方有 presets、另一方没有（升级过渡期会出现）
    const mixed = S.mergePermissionMatrix(
      { rev: 1, activeId: 'a', presets: [{ id: 'a', name: '老的' }], updated_at: '2026-09-01T00:00:00.000Z' },
      { rev: 5, activeId: 'b', updated_at: '2026-09-02T00:00:00.000Z' }, '报告页编排');
    ok('★★一方还没有 presets（升级过渡期）也不抛异常', !!mixed, mixed);
  }

  section('②-5 合并不许就地改动传进来的对象（基线要跟文件对得上）');
  {
    const localCfg = { rev: 4, updated_at: '2026-09-13T12:00:00.000Z', activeId: 'p1',
      presets: [{ id: 'p1', name: '我的' }] };
    const remoteCfg = { rev: 9, updated_at: '2026-09-13T14:00:00.000Z', activeId: 'p2',
      presets: [{ id: 'p2', name: '他的' }] };
    const remoteBefore = JSON.stringify(remoteCfg), localBefore = JSON.stringify(localCfg);
    S.mergePermissionMatrix(localCfg, remoteCfg, '报告页编排');
    ok('★★没有就地改掉远端那份（它可能就是从文件里读出来的那个对象，'
      + '改了会让基线跟文件对不上——这个坑 P97 专门踩过）', JSON.stringify(remoteCfg) === remoteBefore);
    ok('★也没有就地改掉本机那份', JSON.stringify(localCfg) === localBefore);
  }

  section('②-6 配置被整份覆盖时的提醒还在（原有机制，别被这次改动弄坏）');
  {
    world();
    S.DB.settings.lastSyncAt = '2026-09-01T00:00:00.000Z';
    S.DB.reportConfig = { rev: 4, created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-09-13T12:00:00.000Z', updated_by: '管理员', activeId: 'p1',
      presets: [{ id: 'p1', name: '我的' }] };
    const remote = Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
      writeId: 'w0', writeIds: ['w0'],
      reportConfig: { rev: 9, created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-09-13T14:00:00.000Z', updated_by: '同事', activeId: 'p2',
        presets: [{ id: 'p2', name: '他的' }] } });
    S.mergeSyncPayload(S.syncPayload(S.DB), remote, S.DB.syncBase);
    S.noteFieldConflicts();
    await tick(40);
    const alerts = (S.DB.changelog || []).filter(e => /编排/.test(e.summary || ''));
    ok('★★"我这份被对方顶掉了"的提醒照样会报（预案保住了，但当前编排确实被换掉了，'
      + '这件事仍然要让人知道）', alerts.length >= 1, (S.DB.changelog || []).map(e => e.summary));
    ok('★四个配置对象都带着 label 传进合并（不传就不会报）',
      (SRC.match(/mergePermissionMatrix\(local\.\w+, remote\.\w+, '[^']+'\)/g) || []).length === 4);
  }

  /* ═════════ ③ 重查：上一轮把日志上限提到 2000 波及到了什么 ═════════ */
  section('③-1 "有没有新东西要推"的判据不受新上限影响');
  {
    world();
    // 共享文件里是一份按【旧上限 800】裁过的日志（旧版客户端写的，升级期间必然遇到）
    const theirLog = [];
    for (let i = 0; i < 800; i++) theirLog.push({ id: 'r' + i, at: '2026-09-01T00:00:00.000Z',
      by: '同事', kind: 'edit', entity: 'task', refId: 'T1', taskId: 'T1', summary: '改了' });
    const remote = Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
      writeId: 'w0', writeIds: ['w0'], changelog: theirLog,
      tasks: cp(S.DB.tasks), works: cp(S.DB.works), duties: cp(S.DB.duties),
      milestones: cp(S.DB.milestones) });
    S.DB.changelog = [{ id: 'MINE', at: new Date().toISOString(), by: '管理员', kind: 'edit',
      entity: 'milestone', refId: 'M1', summary: '我刚改的',
      changes: [{ k: 'plan_date', from: 'a', to: 'b' }] }];
    ok('★★对方那份按旧上限是满的，本机新记的那条照样判定要推',
      S.hasLocalContribution(S.syncPayload(S.DB), remote) === true);
    ok('★源码里那个判据挂的是"对方那份满没满"，不是无条件按时间卡',
      /const theirLogFull = \(remote\.changelog \|\| \[\]\)\.length >= CHANGELOG_LIMIT;/.test(SRC));
    // 上限本身也钉一下：这一节整段的前提就是"上限已经提到 2000"，退回 800 这些断言就名不副实了
    ok('★★日志上限仍是 2000（退回 800，可回溯天数又会被里程碑日志腰斩到 11 天）',
      S.CHANGELOG_LIMIT === 2000, S.CHANGELOG_LIMIT);
  }

  section('③-2 日志变多之后，合并/裁剪/筛选的耗时还能接受');
  {
    const mk = (p, n) => { const a = []; for (let i = 0; i < n; i++) a.push({ id: p + i,
      at: '2026-09-0' + (i % 9 + 1) + 'T00:00:00.000Z', by: '某人', kind: 'edit', entity: 'milestone',
      refId: 'M1', summary: '计划日期：2026-09-20→2026-09-25；交付物：某材料→某材料（终稿）',
      changes: [{ k: 'plan_date', from: '2026-09-20', to: '2026-09-25' }] }); return a; };
    const a = mk('a', 2000), b = mk('b', 2000);
    let t0 = Date.now(); const merged = S.mergeChangelog(a, b); const dtMerge = Date.now() - t0;
    t0 = Date.now(); S.capChangelog(a.concat(b), S.CHANGELOG_LIMIT); const dtCap = Date.now() - t0;
    t0 = Date.now(); S.filterLogs(merged, { range: 'all', kind: 'all', who: '', text: '', now: Date.now() });
    const dtFilter = Date.now() - t0;
    ok('★合并 2000+2000 条在 400ms 以内（每次同步都要跑一遍，慢了保存就卡）',
      dtMerge < 400, dtMerge + 'ms');
    ok('★裁剪在 400ms 以内', dtCap < 400, dtCap + 'ms');
    ok('★日志页筛选在 400ms 以内', dtFilter < 400, dtFilter + 'ms');
    ok('★合并结果被裁到上限', merged.length === S.CHANGELOG_LIMIT, merged.length);
  }

  section('③-3 ★里程碑的改动要进得了工作台「最近动态」');
  {
    /* 这一条是这一轮从"重查已查过的面"里翻出来的第三个真问题。
       最近动态按 taskId 过滤，而 pushChangeLog 原来只在 entity==='task' 时填 taskId，
       里程碑一律留空（当初是为了不让工作/职责污染面板）。于是：
       只改一条里程碑的呈报层级（日期、交付物都不动）时——
         · 任务那条日志根本不会写（任务字段没变、检查点条数也没变，summary 是空的，
           logRecordChange 开头那句 if (!summary) return 直接返回）；
         · 里程碑那条写了，但 taskId 为空，进不了面板。
       两头一夹，这次改动在最近动态里【完全隐形】，而管理员正是靠这个面板看同事今天动了什么。 */
    world();
    S.DB.changelog = [];
    S.pushChangeLog('milestone', 'M1', '最高呈报层级：处室领导→行领导',
      [{ k: 'report_level', from: 'section', to: 'bank' }]);
    const e = S.DB.changelog[S.DB.changelog.length - 1];
    ok('★★里程碑日志的 taskId 填的是它所属的那条任务', e.taskId === 'T1', e.taskId);
    let err = '', html = '';
    try { S.renderDashboard(); html = q('#page-dashboard').innerHTML || ''; } catch (e2) { err = e2.message; }
    ok('工作台渲染正常', !err, err);
    ok('★★这次改动出现在最近动态里了（原来完全隐形）', /行领导/.test(html), html.slice(0, 200));

    // 软删除的里程碑也要查得到所属任务，否则"删掉一条交付物"同样隐形
    const m2 = S.byId('milestone', 'M2');
    m2.deleted_at = new Date().toISOString();
    S.DB.changelog = [];
    S.pushChangeLog('milestone', 'M2', '删除里程碑「会议纪要」（原计划 2026-09-30）');
    const e2 = S.DB.changelog[S.DB.changelog.length - 1];
    ok('★★软删除之后照样填得出 taskId（索引不剔除已删记录）', e2.taskId === 'T1', e2.taskId);

    // 工作/职责必须仍然留空，否则面板会被污染成一堆"（任务已不存在）"
    S.DB.changelog = [];
    S.pushChangeLog('work', 'w1', '工作名称：工作一→工作甲');
    S.pushChangeLog('duty', '01', '职责名称：职责一→职责甲');
    ok('★★工作的记录仍然不填 taskId（填了面板会拿工作 id 去查任务，'
      + '查不到就显示成"（任务已不存在）"，把最近动态污染成一堆无效条目）',
      S.DB.changelog.every(x => x.taskId === ''), S.DB.changelog.map(x => x.entity + ':' + x.taskId));
    let html2 = '';
    try { S.renderDashboard(); html2 = q('#page-dashboard').innerHTML || ''; } catch (e3) { err = e3.message; }
    ok('★工作/职责的改动没混进最近动态', !/工作甲|职责甲/.test(html2));
    ok('★也没有出现"（任务已不存在）"这种无效条目', !/任务已不存在/.test(html2));

    // 找不到的里程碑不能抛异常
    S.DB.changelog = [];
    let err2 = '';
    try { S.pushChangeLog('milestone', '根本不存在的id', '改了点什么'); } catch (e4) { err2 = e4.message; }
    ok('★里程碑已经被彻底删除时不抛异常，taskId 退回空', !err2
      && S.DB.changelog[0] && S.DB.changelog[0].taskId === '', err2);
  }

  section('③-4 回收站清理：不误伤活着的记录，且有留痕有权限闸');
  {
    world();
    S.DB.shareConfig = { recycleKeepDays: 1, rev: 1, created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' };
    const m1 = S.byId('milestone', 'M1');
    m1.deleted_at = '2026-01-01T00:00:00.000Z';
    S.rebuildIndex();
    let err = '';
    try { await S.purgeRecycleBin(); await tick(60); } catch (e) { err = e.message; }
    ok('清理不抛异常', !err, err);
    ok('★活着的任务没被动', !!S.byId('task', 'T1'));
    ok('★★没删过的里程碑还在（清理只该动过期的墓碑）',
      !!S.byId('milestone', 'M2') && !S.byId('milestone', 'M2').deleted_at);
    const i = SRC.indexOf('function purgeRecycleBin');
    const body = SRC.slice(i, i + 2500);
    ok('★彻底清空（不可撤销）有留痕', /pushChangeLog|pushAdminLog|pushAlertLog/.test(body));
    ok('★有权限闸', /requirePermission|requireRole|roleAtLeast/.test(body));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
