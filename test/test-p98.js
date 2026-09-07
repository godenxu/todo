/* P98：第九轮排查——基线之外那几类东西

   前八轮的注意力几乎都在职责/工作/任务/里程碑上，因为三方合并的基线（DB.syncBase）只覆盖它们。
   而【账号、权限矩阵、报告页编排、工作台编排、共享文件夹配置、变更日志、墓碑】都不在基线里，
   各有各的合并规则，一直是盲区。这一轮专打这一块，抓到五个问题：

   ① 共享文件夹配置的版本号永远是 1
      updateShareConfig 用 Object.assign(effectiveShareCfg(), patch) 拼新对象，而 effectiveShareCfg()
      只返回四个业务字段、不带 rev/updated_at。于是 stampMeta 每次都从 0 加到 1。
      这几个配置是整份 LWW 同步的：rev 打平就退到比 updated_at——那是各自电脑的本地时钟。
      后果：表慢的那台机器改了推不上去，而且"再改一次把版本号顶上去"这条自救路也没了，
      表现成"我改的备份间隔/回收站保留期过一阵又变回去，而且这台机器上永远改不动"。

   ② 整体配置对象被整份覆盖时，一声不吭
      逐条业务记录撞车了还会写一条冲突日志；这四个整体对象输的一方整份改动直接消失，
      界面上、日志里都没有任何痕迹。"编排改好了第二天又变回去"过去只能靠猜。

   ③ "比对方最旧那条还老就别推了"这条过滤是无条件的
      它只在对方那份【已经顶到上限】时才成立。没满时会真丢东西：共享文件里的墓碑本来就不多，
      某台机器表慢十来分钟，它新记的墓碑时间戳就比文件里最老的还早，于是这次彻底删除永远推不出去，
      那条记录会从别人机器上飘回来。日志同理，"按日志核对"也就查不到那次改动。

   ④ Repo.persist 把"没抛异常"当成了"同步成功"
      syncToFile 有好几条不抛异常但确实没写进去的路（格式门禁、旧版停写、文件读不出、
      连着几轮被抢先）。原来一律把 pendingSync 撤掉，顶栏那个"改动还没同步出去"的红色提示当场消失，
      用户以为存好了，实际共享文件里一个字都没有——这正是当初加 pendingSync 要防的事，只是漏了这几条路。

   ⑤ 共享 JSON 的"结构"被改坏时，全处同步一起瘫痪
      normalizeMergedRecords 防的是【值】被改坏，防不住【结构】：changelog 被改成 {}、
      tasks 里留个 null，合并第一步就抛 forEach is not a function，而 isValidShareData 只看 duties/tasks。
      后果是所有人每次保存都掉进 catch，弹一句看不懂的 JS 报错。

   ⑥（第六节）记录的是一次【失败的修复】：想用 rev 判断"文件是不是被旧内容盖过了"。
      手工场景过了，多设备长跑仿真直接证伪——rev 是每条记录、每台设备独立递增的计数，
      不是文件级版本号，rev 小 ≠ 内容旧。已撤回，测试留着防止它被再写回来。
   用法：node test/test-p98.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });

// 假共享文件句柄，可以让"读"直接失败（模拟网盘抽风/文件被别的程序占着）
function mkHandle(text) {
  const h = {
    name: 'shared.json', _text: text, _mtime: 1000, _writes: [], failRead: false,
    async getFile() {
      if (h.failRead) return { lastModified: h._mtime, text: async () => '这不是 JSON' };
      return { lastModified: h._mtime, text: async () => h._text };
    },
    async createWritable() {
      return { async write(t) { h._pending = t; },
        async close() { h._writes.push(h._pending); h._text = h._pending; h._mtime += 1; } };
    },
  };
  return h;
}

async function main() {
  await tick(60);

  section('一、共享文件夹配置：版本号必须真的在涨');
  {
    S.DB.shareConfig = null;
    const revs = [];
    S.updateShareConfig({ fileName: 'a.json' });        revs.push(S.DB.shareConfig.rev);
    S.updateShareConfig({ autoBackupHours: 12 });       revs.push(S.DB.shareConfig.rev);
    S.updateShareConfig({ recycleKeepDays: 30 });       revs.push(S.DB.shareConfig.rev);
    ok('★★连改三次，rev 是 1→2→3（原来永远是 1，等于把版本号这条线整个废掉，只剩时钟能定胜负）',
      revs.join(',') === '1,2,3', revs);
    ok('★"当时没提到"的字段不会被冲掉（这是这个函数原本就要保证的）',
      S.DB.shareConfig.fileName === 'a.json' && S.DB.shareConfig.autoBackupHours === 12);
    ok('★创建时间保留着，不是每次改都重新盖一个',
      !!S.DB.shareConfig.created_at);

    // ★ 真正的价值：表慢的那台机器被顶掉之后，再改一次必须能翻盘
    const 基础 = { fileName: 'x.json', autoBackupEnabled: false, autoBackupHours: 24, recycleKeepDays: 60,
      rev: 5, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-06T10:00:00.000Z', updated_by: '原来的人' };
    const 甲 = (() => { S.DB.shareConfig = cp(基础); S.updateShareConfig({ recycleKeepDays: 90 });
      const c = S.DB.shareConfig; c.updated_at = '2026-09-06T11:00:00.000Z'; c.updated_by = '甲'; return cp(c); })();
    let 乙 = (() => { S.DB.shareConfig = cp(基础); S.updateShareConfig({ autoBackupHours: 6 });
      // 乙其实比甲后动手，但它的表慢 10 分钟，盖出来的戳反而更早
      const c = S.DB.shareConfig; c.updated_at = '2026-09-06T10:55:00.000Z'; c.updated_by = '乙'; return cp(c); })();
    ok('两边从同一版各改一次 → rev 打平，只能靠时钟，表慢的那台输掉（整体对象的固有取舍）',
      S.mergePermissionMatrix(乙, 甲, '共享文件夹配置').updated_by === '甲');
    // 乙不服气，再改一次
    S.DB.shareConfig = cp(S.mergePermissionMatrix(乙, 甲, '共享文件夹配置'));
    S.updateShareConfig({ autoBackupHours: 6 });
    乙 = cp(S.DB.shareConfig); 乙.updated_at = '2026-09-06T10:58:00.000Z'; 乙.updated_by = '乙';   // 表还是慢的
    ok('★★但它再改一次就能翻盘——rev 涨到比对方高，时钟不再有发言权（原来 rev 卡死在 1，永远翻不了身）',
      S.mergePermissionMatrix(乙, 甲, '共享文件夹配置').updated_by === '乙',
      { 乙rev: 乙.rev, 甲rev: 甲.rev });
    S.DB.shareConfig = null;
  }

  section('二、整体配置对象被整份覆盖时，必须留下痕迹');
  {
    const mk = (rev, by, name) => ({ presets: [{ id: 'p1', name: name || '默认' }], activeId: 'p1',
      rev, updated_at: by === '甲' ? '2026-09-06T11:00:00.000Z' : '2026-09-06T10:00:00.000Z', updated_by: by });
    const run = (local, remote) => {
      S.setObjConflicts([]);
      S.mergeSyncPayload(Object.assign(EMPTY(), { reportConfig: local }),
        Object.assign(EMPTY(), { reportConfig: remote }), null);
      return S.objConflicts;
    };
    ok('★★两边 rev 一样、内容不同 → 判定为并发修改，记下来',
      run(mk(2, '乙', '乙的编排'), mk(2, '甲', '甲的编排')).length === 1);
    const c = run(mk(2, '乙', '乙的编排'), mk(2, '甲', '甲的编排'))[0];
    ok('★记清楚了是谁跟谁、这次采用了哪一份',
      c.label === '报告页编排' && c.mine === '乙' && c.theirs === '甲' && c.taken === 'theirs', c);
    ok('★对方 rev 更高 → 是"他在我这版基础上改的"，我根本没改过，不算冲突，不记',
      run(mk(2, '乙', '乙的编排'), mk(5, '甲', '甲的编排')).length === 0);
    ok('★我 rev 更高 → 同理不记', run(mk(5, '乙', '乙的编排'), mk(2, '甲', '甲的编排')).length === 0);
    ok('★rev 一样但内容也一样 → 本来就没冲突，不记', run(mk(2, '乙'), mk(2, '甲')).length === 0);
    ok('★只有元信息（谁改的、什么时候）不同不算内容不同',
      S.sameWholeObject({ a: 1, rev: 2, updated_at: 't1', updated_by: '甲', created_at: 'c' },
        { a: 1, rev: 9, updated_at: 't2', updated_by: '乙', created_at: 'd' }) === true);
    ok('★一方是空的（对方刚配上）→ 不是冲突', run(null, mk(2, '甲')).length === 0);

    // 冲突要真的写进日志——只记在内存里等于没记
    S.setObjConflicts([{ label: '工作台编排', taken: 'theirs', mine: '乙', theirs: '甲', at: '' }]);
    const before = S.DB.changelog.length;
    S.setSnackPriorityUntil(0);
    S.noteFieldConflicts();
    ok('★★写了一条告警日志（这种事必须让人查得到，不能只弹个提示就过去了）',
      S.DB.changelog.length === before + 1 && S.DB.changelog.slice(-1)[0].kind === S.ALERT_LOG_KIND);
    ok('★日志里点明了是哪份配置、被谁覆盖了',
      (S.DB.changelog.slice(-1)[0].summary || '').includes('工作台编排')
      && (S.DB.changelog.slice(-1)[0].summary || '').includes('甲'));
    ok('★没有冲突时不写日志（不刷屏）',
      (S.setObjConflicts([]), S.noteFieldConflicts(), S.DB.changelog.length) === before + 1);
  }

  section('三、"太老就别推了"这条过滤，只有对方那份满了才成立');
  {
    const now = Date.now(), iso = m => new Date(now + m * 60000).toISOString();
    const fullLog = () => Array.from({ length: S.CHANGELOG_LIMIT }, (_, i) => ({ id: 'f' + i, at: iso(-1) }));
    const fullPurge = () => Array.from({ length: S.PURGED_LIMIT }, (_, i) => ({ entity: 'task', id: 'g' + i, at: iso(-1) }));

    ok('★★对方日志没满 → 我这条再老也必须推（原来会判成"不用推"，这条变更记录永久丢失）',
      S.hasLocalContribution(
        Object.assign(EMPTY(), { changelog: [{ id: 'r1', at: iso(-2) }, { id: 'mine', at: iso(-12) }] }),
        Object.assign(EMPTY(), { changelog: [{ id: 'r1', at: iso(-2) }] }), null) === true);
    ok('★★对方墓碑没满 → 同理必须推（否则这次"彻底删除"推不出去，记录会从别人机器上飘回来）',
      S.hasLocalContribution(
        Object.assign(EMPTY(), { purged: [{ entity: 'task', id: 'g1', at: iso(-2) }, { entity: 'task', id: 'g2', at: iso(-12) }] }),
        Object.assign(EMPTY(), { purged: [{ entity: 'task', id: 'g1', at: iso(-2) }] }), null) === true);
    ok('★对方日志已满 + 我这条确实太老 → 推上去也会立刻被裁掉，这才该判"不用推"',
      S.hasLocalContribution(
        Object.assign(EMPTY(), { changelog: fullLog().concat([{ id: 'old', at: iso(-99999) }]) }),
        Object.assign(EMPTY(), { changelog: fullLog() }), null) === false);
    ok('★对方日志已满 + 我这条是新的 → 照样要推',
      S.hasLocalContribution(
        Object.assign(EMPTY(), { changelog: fullLog().concat([{ id: 'new', at: iso(5) }]) }),
        Object.assign(EMPTY(), { changelog: fullLog() }), null) === true);
    ok('★对方墓碑已满 + 我这条太老 → 不用推',
      S.hasLocalContribution(
        Object.assign(EMPTY(), { purged: fullPurge().concat([{ entity: 'task', id: 'old', at: iso(-99999) }]) }),
        Object.assign(EMPTY(), { purged: fullPurge() }), null) === false);
  }

  section('四、同步没成功就不许撤掉"改动还没同步出去"的提示');
  {
    const bak = { tasks: cp(S.DB.tasks), me: S.DB.settings.me, base: cp(S.DB.syncBase) };
    const reset = () => {
      S.setVersionBlocked(false); S.setStaleAppBlocked(false); S.setEverConnected(true);
      S.DB.settings.pendingSync = false; S.setSnackPriorityUntil(0);
      S.setLastWriteId(''); S.setPreWriteBase(null);
      S.DB.settings.lastWriteId = ''; S.DB.settings.lastWriteIdAt = '';
    };

    // 门禁挡住（这份 html 是旧版，只准读不准写）
    reset();
    S.setFileHandle(mkHandle(JSON.stringify(S.filePayload(EMPTY(), S.DB, 'w0', { writeIds: ['w0'] }))));
    S.setStaleAppBlocked(true);
    ok('★被"旧版停写"门禁挡住时，syncToFile 报 blocked', await S.syncToFile(S.DB) === 'blocked');
    await S.Repo.persist(S.DB);
    ok('★★这时 pendingSync 必须是 true——改动确实没推出去，红色提示不能撤（原来会当场撤掉，用户以为存好了）',
      S.DB.settings.pendingSync === true);

    // 文件读出来不是本应用的格式
    reset();
    const h2 = mkHandle(JSON.stringify(S.filePayload(EMPTY(), S.DB, 'w0', { writeIds: ['w0'] })));
    h2.failRead = true;
    S.setFileHandle(h2);
    /* 单独一个 badfile：这条路自己已经弹过"共享文件夹可能选错了"，
       调用方不该再补一句泛泛的"这次没能写进共享文件"把它盖掉（两条都是 priority，后来的赢） */
    ok('★文件读不出合法内容时报 badfile（跟"被人抢先"的 failed 分开）',
      await S.syncToFile(S.DB) === 'badfile');
    await S.Repo.persist(S.DB);
    ok('★★同样必须保住 pendingSync', S.DB.settings.pendingSync === true);

    // 正常写入
    reset();
    S.DB.settings.pendingSync = true;   // 假装之前积压着
    S.setFileHandle(mkHandle(JSON.stringify(S.filePayload(EMPTY(), S.DB, 'w0', { writeIds: ['w0'] }))));
    const r = await S.syncToFile(S.DB);
    ok('★真写进去了报 written；本机跟文件已经一致时报 nochange', r === 'written' || r === 'nochange', r);
    await S.Repo.persist(S.DB);
    ok('★真同步上了才把积压标记撤掉', S.DB.settings.pendingSync === false);

    // 没连上共享文件夹
    reset();
    S.setFileHandle(null);
    ok('★根本没连上时报 blocked', await S.syncToFile(S.DB) === 'blocked');

    S.setFileHandle(null); S.setStaleAppBlocked(false);
    S.DB.tasks = bak.tasks; S.DB.settings.me = bak.me; S.DB.syncBase = bak.base;
    S.DB.settings.pendingSync = false;
    S.rebuildIndex();
  }

  section('五、共享文件的"结构"被改坏时，不能让全处的同步一起瘫痪');
  {
    /* normalizeMergedRecords 防的是【值】被改坏（参与人写成一整串、进度写成字符串）。
       防不住【结构】：changelog 被改成 {}、users 被改成对象、tasks 里留个 null——
       合并第一步就抛 "(remote || []).forEach is not a function"，
       而 isValidShareData 只看 duties/tasks，这种文件在它眼里完全合法。
       后果不是某条数据不对，是所有人每次保存都掉进 catch，弹一句看不懂的 JS 报错。 */
    const bads = {
      'changelog 被改成对象': { changelog: {} },
      'users 被改成对象': { users: {} },
      'milestones 被改成字符串': { milestones: 'abc' },
      'purged 被改成字符串': { purged: 'abc' },
      'tasks 里混进 null': { tasks: [null, null] },
      'duties 里混进字符串': { duties: ['x'] },
    };
    Object.keys(bads).forEach(k => {
      const bad = Object.assign(EMPTY(), bads[k]);
      S.sanitizeRemotePayload(bad);
      let crashed = '';
      try { S.normalizeMergedRecords(S.mergeSyncPayload(EMPTY(), bad, null)); }
      catch (e) { crashed = e.message; }
      ok(`★★${k} → 治好之后合并不再抛异常`, !crashed, crashed);
    });
    ok('★报告了都坏在哪儿（要让人知道文件被动过）',
      S.sanitizeRemotePayload(Object.assign(EMPTY(), { changelog: {}, tasks: [null] })).length === 2);
    ok('★字段压根没有是正常的（老版本写的文件就没有 purged），不算坏',
      S.sanitizeRemotePayload({ duties: [], tasks: [] }).length === 0);
    ok('★好好的文件一个字都不动',
      S.sanitizeRemotePayload(Object.assign(EMPTY(), { tasks: [{ id: 'T' }] })).length === 0);
    {
      const good = Object.assign(EMPTY(), { tasks: [{ id: 'T1' }, { id: 'T2' }] });
      const ref = good.tasks;
      S.sanitizeRemotePayload(good);
      ok('★没坏的时候连数组对象都不换（避免制造无谓的"内容变了"）', good.tasks === ref);
    }
    // 坏掉这件事必须留痕
    S.setBrokenFileWarned(false);
    S.setSnackPriorityUntil(0);
    const before = S.DB.changelog.length;
    S.noteBrokenSharedFile(['changelog 不是列表']);
    ok('★★记了一条告警日志', S.DB.changelog.length === before + 1
      && S.DB.changelog.slice(-1)[0].kind === S.ALERT_LOG_KIND);
    ok('★一轮同步会读好几次文件，但只报一次，不刷屏',
      (S.noteBrokenSharedFile(['changelog 不是列表']), S.DB.changelog.length) === before + 1);
    ok('★没坏就不报', (S.setBrokenFileWarned(false), S.noteBrokenSharedFile([]), S.DB.changelog.length) === before + 1);
    S.setBrokenFileWarned(false);
  }

  section('六、★不许拿 rev 判断"文件是不是被旧内容盖过了"★');
  {
    /* ★ 这一节记录的是一次【失败的修复】，测试是用来防止它被再次写回来的 ★

       本轮一度加过这样一条兜底：既然基线是"上次对账时文件里那份"，那么 remote.rev < base.rev
       就说明文件退回去了，保留本机那份即可。手工构造的场景确实过了，多设备长跑仿真直接证伪：
       一台离线很久的设备恢复联网后改了任务的牵头人，那次改动被这条规则整个丢掉。

       前提错在哪：rev 是【每条记录各自的、每台设备独立 +1】的计数，不是文件级的版本号。
       两台设备对同一条记录各改一次，都从 5 加到 6；合并过的会变成 max+1；
       离线久的那台手里基数低，它的合法新编辑 rev 天生就比别人小。rev 小 ≠ 内容旧。

       判断"文件被旧内容盖过"必须用真正的文件级因果，也就是写入链（writeIds，见 noteClobberedWrite），
       跟每条记录的 rev 无关。 */
    const T = (rev, owner, extra) => Object.assign({ id: 'T', work: 'W', code: '', title: '任务', owner,
      assignees: [], status: 'doing', priority: '2', plan_date: '2026-09-20', progress: 0, actual_date: '',
      source: '', custom: '', rev, created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-06T10:00:00.000Z', updated_by: owner }, extra || {});
    // 离线很久的那台：手里基数低，它刚改的牵头人 rev 就是比别人小，但那是【真实的新改动】
    const r = S.mergeRecordThreeWay('task',
      T(3, '李兰'),                 // 本机（旧页面刚改的）
      T(8, '徐捷'),                 // 文件里那条（别人改过好几轮，rev 高但这个字段没动）
      T(2, '徐捷'));                // 基线（本机很久以前对账时看到的）
    ok('★★rev 低的一方改的字段必须保住——它只是基数低，不是内容旧',
      r.rec.owner === '李兰', r.rec.owner);

    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
    ok('★★源码里不许再出现"remote.rev < base.rev 就整条保留 local"这类判断',
      !/\(remote\.rev \|\| 0\) < \(base\.rev \|\| 0\)/.test(src));
    ok('★注释里留下了为什么不能这么做（免得以后有人又想到同一个"好主意"）',
      /别想着用 rev 判断"文件是不是被旧内容盖过了"/.test(src));
  }

  section('七、源码接线');
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
    ok('★updateShareConfig 先铺一层现有配置，保住 rev',
      /const cfg = Object\.assign\(\{\}, DB\.shareConfig \|\| \{\}, effectiveShareCfg\(\), patch\);/.test(src));
    ok('★四个整体对象合并时都带上了名字（不带名字就不记冲突）',
      (src.match(/mergePermissionMatrix\(local\.\w+, remote\.\w+, '[^']+'\)/g) || []).length === 4);
    ok('★日志/墓碑的"太老"判据挂了"对方满了没"的前提',
      /const theirLogFull = \(remote\.changelog \|\| \[\]\)\.length >= CHANGELOG_LIMIT;/.test(src)
      && /const theirPurgedFull = \(remote\.purged \|\| \[\]\)\.length >= PURGED_LIMIT;/.test(src));
    ok('★persist 看的是同步结果，不是"没抛异常"',
      /const res = await syncToFile\(db\);\s*\n\s*if \(res === 'written' \|\| res === 'nochange'\)/.test(src));
    ok('★没同步上就把积压标记置回去', /\} else \{\s*\n\s*db\.settings\.pendingSync = true; flush\(\);/.test(src));
    ok('★"重新连接共享文件夹"那条路也治结构损坏（它自己解析文件，不走 readSharedFile）',
      (src.match(/noteBrokenSharedFile\(sanitizeRemotePayload\(parsed\)\);/g) || []).length === 2);
    ok('★连接那条路的空载荷跟同步路径共用同一份定义，不再各抄一份',
      /let remote = emptyRemotePayload\(\);/.test(src));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
