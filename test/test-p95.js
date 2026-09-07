/* P95：第八轮排查——写入竞争里"写后校验挡不住的那一半"

   写完读回来核对（写后校验）只挡住了竞争的一半：别人在【我写完之后、我校验之前】插一脚。
   另一半它天生看不见——别人在【我写之前】就把文件读走了，等我写完、校验完，他才写：

     乙 读文件（拿到 v0），开始在本机合并……
     甲 读 v0 → 合并 → 写 v1 → 校验读回 v1，是自己的，一切正常，基线对齐到 v1
     乙 这时才写：手里那份是 v0，把甲那次改动整个盖掉 → 文件变成 v2

   两边的校验都通过，两边都毫无察觉。而且甲的基线现在在撒谎（"文件里有我这个值"），
   下一轮合并会逐字段判定"这个字段我没改过、是对方改的"，把甲自己的值主动改回旧值，
   而且不会自己恢复——这正是处里那次"同事明明改了状态、日志里也查得到，过一阵又变回去"的形态。

   本轮的两层处理：
     ① 写之前再读一次确认文件没被抢先（把最长的解析+合并+序列化挪出危险区间）
     ② 文件里维护一条写入链（writeIds）；事后发现自己那次写不在链上，就把基线回滚到
        那次写之前那份，让被盖掉的改动重新变成"待推送"，下一轮自动补推
   用法：node test/test-p95.js */
const { sandbox: S, raw } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

/* 假共享文件句柄。readsBeforeWrite 用来数"写一次到底读了几遍文件"；
   stealBeforeWrite 模拟"在我确认之后、真正落盘之前，别人抢先写了一次" */
function mkHandle(text) {
  const h = {
    name: 'shared.json', _text: text, _mtime: 1000, _writes: [], _reads: 0,
    // 读完第 n 次之后，别人抢先写了一份进去（n 从布置的那一刻起算）。
    // 用来把"抢先"精确地放在【第一次读之后、写之前确认那次读之前】——正好是新增那道确认要挡的位置
    stealAfterRead: null, _stealCountdown: 0,
    async getFile() {
      h._reads++;
      const f = { lastModified: h._mtime, text: async () => h._text };
      if (h.stealAfterRead !== null && --h._stealCountdown <= 0) {
        h._text = h.stealAfterRead; h.stealAfterRead = null; h._mtime += 1;
      }
      return f;
    },
    arm(n, text) { h.stealAfterRead = text; h._stealCountdown = n; },
    async createWritable() {
      return {
        async write(t) { h._pending = t; },
        async close() { h._writes.push(h._pending); h._text = h._pending; h._mtime += 1; },
      };
    },
  };
  return h;
}
const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
const T0 = () => ({ id: 'T95', work: '', code: '', title: 'P95 演示任务', owner: '甲', assignees: [],
  status: 'todo', priority: '2', plan_date: '2026-09-20', progress: 0, actual_date: '',
  source: '', custom: '', rev: 5, created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-05T01:00:00.000Z', updated_by: '原作者' });

async function main() {
  await tick(60);
  const bak = { tasks: cp(S.DB.tasks), users: cp(S.DB.users), me: S.DB.settings.me,
    base: cp(S.DB.syncBase), log: cp(S.DB.changelog) };
  const reset = () => {
    S.DB.tasks = []; S.DB.users = []; S.DB.changelog = [];
    S.DB.duties = []; S.DB.works = []; S.DB.milestones = []; S.DB.purged = [];
    S.DB.permissionMatrix = null; S.DB.shareConfig = null; S.DB.reportConfig = null; S.DB.dashboardConfig = null;
    S.DB.syncBase = null; S.DB.settings.me = '甲';
    S.DB.settings.lastWriteId = ''; S.DB.settings.lastWriteIdAt = '';
    S.setLastWriteId(''); S.setPreWriteBase(null);
    S.setFileHandle(null); S.setVersionBlocked(false); S.setStaleAppBlocked(false); S.setLastSyncedMtime(0);
    S.setSnackPriorityUntil(0);
    S.rebuildIndex();
  };

  section('一、写入链（writeIds）：格式与哨兵');
  ok('接在读到那份的链后面', JSON.stringify(S.buildWriteIdRing({ writeIds: ['a', 'b'] }, 'c')) === '["a","b","c"]');
  ok('★ 文件里没有链（老版本 html 写的 / 全新文件）时插哨兵，表示"这条链判断不了"',
    JSON.stringify(S.buildWriteIdRing({}, 'c')) === `["${S.WRITE_RING_RESET}","c"]`);
  ok('链有长度上限，不会无限涨',
    S.buildWriteIdRing({ writeIds: Array.from({ length: S.WRITE_ID_RING + 50 }, (_, i) => 'x' + i) }, 'z').length === S.WRITE_ID_RING);
  ok('超长时挤掉的是最老的，自己这次一定在最后',
    S.buildWriteIdRing({ writeIds: Array.from({ length: S.WRITE_ID_RING + 50 }, (_, i) => 'x' + i) }, 'z').slice(-1)[0] === 'z');
  ok('链里混进非字符串（有人手工改过 JSON）不会把它带进来',
    S.buildWriteIdRing({ writeIds: ['a', null, 5, { x: 1 }, 'b'] }, 'c').join(',') === 'a,b,c');
  ok('filePayload 把链写进文件', Array.isArray(S.filePayload(EMPTY(), S.DB, 'w1', { writeIds: ['w0'] }).writeIds));

  section('二、检测：我那次写还在不在链上');
  reset();
  const armed = (ring, id, minutesAgo) => {
    S.setLastWriteId(id);
    S.DB.settings.lastWriteId = id;
    S.DB.settings.lastWriteIdAt = new Date(Date.now() - (minutesAgo || 0) * 60000).toISOString();
    return S.detectClobberedWrite({ writeIds: ring }, S.DB);
  };
  ok('★我那次写在链上 → 正常，不报', armed(['w0', 'w1', 'w2'], 'w1') === false);
  ok('★★我那次写不在链上 → 判定被人用过期内容盖掉了', armed(['w0', 'w2', 'w3'], 'w1') === true);
  ok('★链里有哨兵（中间被旧版 html 截断过）→ 一律不报，宁可漏报也不误报',
    armed([S.WRITE_RING_RESET, 'w2'], 'w1') === false);
  ok('★文件里根本没有链（旧版本写的）→ 不报', S.detectClobberedWrite({}, S.DB) === false);
  ok('★链是空数组 → 不报', S.detectClobberedWrite({ writeIds: [] }, S.DB) === false);
  ok('★本机从没写过（没有 lastWriteId）→ 不报',
    (S.setLastWriteId(''), S.DB.settings.lastWriteId = '', S.detectClobberedWrite({ writeIds: ['w9'] }, S.DB)) === false);
  ok('★那次写已经是很久以前（超出窗口）→ 不报：标记本来就该被挤出链外，再报就是误报',
    armed(['w0', 'w2'], 'w1', S.CLOBBER_WINDOW_MS / 60000 + 5) === false);

  section('三、发现之后：回滚基线 + 记告警');
  reset();
  S.DB.tasks = [Object.assign(T0(), { status: 'done', rev: 6, updated_by: '甲' })];
  S.rebuildIndex();
  const fakeBase = { task: { T95: Object.assign(T0(), { status: 'todo' }) }, duty: {}, work: {}, milestone: {} };
  S.setPreWriteBase(cp(fakeBase));
  S.DB.syncBase = { task: { T95: Object.assign(T0(), { status: 'done', rev: 6 }) }, duty: {}, work: {}, milestone: {} };
  S.setLastWriteId('w1'); S.DB.settings.lastWriteId = 'w1'; S.DB.settings.lastWriteIdAt = new Date().toISOString();
  const logsBefore = S.DB.changelog.length;
  const fired = S.noteClobberedWrite({ writeIds: ['w0', 'w2'], lastWriteBy: '乙' }, S.DB);
  ok('★报告发现了', fired === true);
  ok('★★基线回滚到了"那次写之前"那份——被盖掉的改动因此重新变成"本机改动还没推上去"',
    S.DB.syncBase.task.T95.status === 'todo', S.DB.syncBase.task.T95.status);
  ok('★记了一条告警日志（这种事必须让人看得见）',
    S.DB.changelog.length === logsBefore + 1 && S.DB.changelog.slice(-1)[0].kind === S.ALERT_LOG_KIND);
  ok('★告警里点了名是谁盖的', (S.DB.changelog.slice(-1)[0].summary || '').includes('乙'));
  ok('★只报一次：标记清掉了，不会每 5 分钟一轮同步就刷一条',
    S.noteClobberedWrite({ writeIds: ['w0', 'w2'], lastWriteBy: '乙' }, S.DB) === false);
  reset();
  S.setPreWriteBase(null);   // 刷新过页面：内存里那份基线没了
  S.DB.syncBase = { task: {}, duty: {}, work: {}, milestone: {} };
  S.setLastWriteId('w1'); S.DB.settings.lastWriteId = 'w1'; S.DB.settings.lastWriteIdAt = new Date().toISOString();
  ok('★刷新过页面（回滚不了）时照样报警，只是文案改成"没法自动补推"',
    S.noteClobberedWrite({ writeIds: ['w0', 'w2'], lastWriteBy: '乙' }, S.DB) === true
    && (S.DB.changelog.slice(-1)[0].summary || '').includes('没法自动补推'));

  section('三·补、★回滚必须逐条判，不能整份倒回去★');
  /* 这是仿真里抓到的一个"修着修着修出新问题"的坑，必须钉死：
     那次写里除了自己改的东西，还捎带着从文件里【吸收】进来的别人的改动。基线整份倒回去之后，
     这些"只是路过"的值也被重新当成本机改动；而这中间别人可能已经就同一个字段写了更新的一版，
     一补推就把人家刚写的顶掉了。护栏：文件里那条记录的版本号超过了我写进去的那一版，就不回滚它。 */
  {
    const mk = (id, over) => Object.assign({ id, title: '任务' + id, status: 'todo', rev: 4 }, over || {});
    const pre = { task: { A: mk('A', { rev: 3, status: 'done' }), B: mk('B', { rev: 3, status: 'done' }) },
      duty: {}, work: {}, milestone: {} };
    const cur = { task: { A: mk('A', { rev: 4, status: 'todo' }), B: mk('B', { rev: 4, status: 'todo' }) },
      duty: {}, work: {}, milestone: {} };
    const db = { syncBase: JSON.parse(JSON.stringify(cur)) };
    S.setPreWriteBase(JSON.parse(JSON.stringify(pre)));
    // A：文件里还是 rev4（没人在我之后改过）→ 回滚，我那次写的改动重新变成"待推送"
    // B：文件里已经 rev5（我写完之后有人正经改过）→ 不回滚，别拿旧的去顶人家新的
    S.rollbackBaseForClobber(db, { tasks: [mk('A', { rev: 4 }), mk('B', { rev: 5 })], duties: [], works: [], milestones: [] });
    ok('★★没人在我之后改过的记录 → 基线回滚到那次写之前', db.syncBase.task.A.rev === 3, db.syncBase.task.A.rev);
    ok('★★我写完之后又被人正经改过的记录 → 不回滚（否则会拿旧值顶掉别人更新的编辑）',
      db.syncBase.task.B.rev === 4, db.syncBase.task.B.rev);
    S.setPreWriteBase(null);
    ok('★没有"写之前那份基线"（页面刷新过）时不回滚，安全返回 false',
      S.rollbackBaseForClobber({ syncBase: cur }, { tasks: [] }) === false);
    // 那次写把某条彻底删掉了：新基线里没有它，旧基线里有 → 沿用旧的，不能凭空丢参照
    S.setPreWriteBase({ task: { C: mk('C', { rev: 2 }) }, duty: {}, work: {}, milestone: {} });
    const db2 = { syncBase: { task: {}, duty: {}, work: {}, milestone: {} } };
    S.rollbackBaseForClobber(db2, { tasks: [], duties: [], works: [], milestones: [] });
    ok('★写完之后基线里没有、写之前有的记录，沿用旧基线', !!db2.syncBase.task.C);
    S.setPreWriteBase(null);
  }

  section('四、写之前再确认一次文件没被抢先');
  ok('两次读到同一个 writeId → 同一份', S.sameFileVersion({ remote: { writeId: 'a' }, mtime: 1 }, { remote: { writeId: 'a' }, mtime: 2 }));
  ok('writeId 变了 → 不是同一份', !S.sameFileVersion({ remote: { writeId: 'a' } }, { remote: { writeId: 'b' } }));
  ok('★老文件没有 writeId → 退回比"最后写入时间"',
    S.sameFileVersion({ remote: { lastWriteAt: 't1' } }, { remote: { lastWriteAt: 't1' } })
    && !S.sameFileVersion({ remote: { lastWriteAt: 't1' } }, { remote: { lastWriteAt: 't2' } }));
  ok('★两样都没有 → 兜底比文件修改时间',
    S.sameFileVersion({ remote: {}, mtime: 5 }, { remote: {}, mtime: 5 })
    && !S.sameFileVersion({ remote: {}, mtime: 5 }, { remote: {}, mtime: 6 }));

  reset();
  {
    // 端到端：确认之后、真正落盘之前被人抢先 → 这次不写，重来一轮，两边的改动都要在
    const v0 = S.filePayload(Object.assign(EMPTY(), { tasks: [T0()] }), S.DB, 'w0', { writeIds: ['w0prev'] });
    const h = mkHandle(JSON.stringify(v0));
    S.setFileHandle(h);
    await S.pullFromFile();                                  // 甲把 v0 读进来，基线对齐
    const t = S.DB.tasks.find(x => x.id === 'T95');
    t.status = 'done'; t.rev = 6; t.updated_at = new Date().toISOString(); t.updated_by = '甲';
    // 乙抢先写了一份（只改优先级），甲这次的确认会发现文件变了
    const 乙 = S.filePayload(Object.assign(EMPTY(), {
      tasks: [Object.assign(T0(), { priority: '1', rev: 6, updated_at: new Date().toISOString(), updated_by: '乙' })],
    }), S.DB, 'w_乙', { writeIds: ['w0prev', 'w0'] });
    // 把"乙抢先写"精确地放在甲读完、还没写的那段时间里——正是新增那道确认要挡的位置
    h.arm(1, JSON.stringify(乙));
    await S.syncToFile(S.DB);
    const final = JSON.parse(h._text);
    const ft = final.tasks.find(x => x.id === 'T95');
    ok('★★抢先写在落盘前被发现了，重来一轮之后甲的「已完成」还在', ft.status === 'done', ft.status);
    ok('★★乙那次只改优先级的改动也没被甲盖掉（这正是原来会丢的那一半）', ft.priority === '1', ft.priority);
    ok('★甲这次写的标记进了链，而且乙那次的也还在',
      final.writeIds.indexOf('w_乙') !== -1 && final.writeIds.slice(-1)[0] === final.writeId, final.writeIds);
    ok('★确实是"重来一轮"而不是直接覆盖：这次同步真的写了两遍以上的读', h._reads >= 3, h._reads);
  }

  section('五、★★端到端复现原事故，并验证能自愈★★');
  reset();
  {
    const v0 = S.filePayload(Object.assign(EMPTY(), { tasks: [T0()] }), S.DB, 'w0', { writeIds: ['w0prev'] });
    const h = mkHandle(JSON.stringify(v0));
    S.setFileHandle(h);
    await S.pullFromFile();                                  // 甲读到 v0
    const 乙读到的 = JSON.parse(h._text);                     // ① 乙也读走了 v0，但还没写

    const t = S.DB.tasks.find(x => x.id === 'T95');           // ② 甲改状态并同步成功
    t.status = 'done'; t.progress = 100; t.rev = 6;
    t.updated_at = new Date().toISOString(); t.updated_by = '甲';
    await S.syncToFile(S.DB);
    ok('② 甲写成功，文件里是「已完成」', JSON.parse(h._text).tasks[0].status === 'done');
    const 甲的标记 = JSON.parse(h._text).writeId;

    // ③ 乙这时才写，手里那份是 v0 —— 甲那次改动被整个盖掉，两边的校验都通过
    const 乙写的 = S.filePayload(Object.assign(EMPTY(), {
      tasks: [Object.assign(T0(), { priority: '1', rev: 6, updated_at: new Date().toISOString(), updated_by: '乙' })],
    }), S.DB, 'w_乙', 乙读到的);
    h._text = JSON.stringify(乙写的); h._mtime += 1;
    ok('③ 文件里甲的「已完成」确实被盖掉了（事故已经发生）', JSON.parse(h._text).tasks[0].status === 'todo');
    ok('③ 甲那次写的标记确实不在新链上（这就是检测依据）',
      JSON.parse(h._text).writeIds.indexOf(甲的标记) === -1);

    // ④ 甲下一轮同步：必须发现、必须把自己的改动补推回去，而且不能反过来吃掉乙的
    const alertsBefore = S.DB.changelog.filter(e => e.kind === S.ALERT_LOG_KIND).length;
    await S.syncToFile(S.DB);
    const ft = JSON.parse(h._text).tasks[0];
    ok('④★★甲的「已完成」被自动补推回文件了（原来是永久丢失）', ft.status === 'done', ft.status);
    ok('④★★乙那次改的优先级也保住了，没有被反向吃掉', ft.priority === '1', ft.priority);
    ok('④ 甲本机看到的也是「已完成」', S.DB.tasks.find(x => x.id === 'T95').status === 'done');
    ok('④★记了告警，管理员在日志页能看到这次覆盖',
      S.DB.changelog.filter(e => e.kind === S.ALERT_LOG_KIND).length === alertsBefore + 1);

    // ⑤ 再同步几轮，结果必须稳定（不能来回翻烧饼）
    const before = JSON.stringify(JSON.parse(h._text).tasks[0]);
    await S.syncToFile(S.DB); await S.pullFromFile(); await S.syncToFile(S.DB);
    ok('⑤ 再同步几轮结果稳定，不会来回翻', JSON.stringify(JSON.parse(h._text).tasks[0]) === before);
  }

  section('六、不能误伤正常情况');
  reset();
  {
    // 正常独占：只有我一个人写，链一路接下去，永远不该报"被覆盖"
    const v0 = S.filePayload(Object.assign(EMPTY(), { tasks: [T0()] }), S.DB, 'w0', { writeIds: ['w0prev'] });
    const h = mkHandle(JSON.stringify(v0));
    S.setFileHandle(h);
    await S.pullFromFile();
    const alertsBefore = S.DB.changelog.filter(e => e.kind === S.ALERT_LOG_KIND).length;
    for (let i = 0; i < 5; i++) {
      const t = S.DB.tasks.find(x => x.id === 'T95');
      t.priority = String(1 + (i % 3)); t.rev = (t.rev || 0) + 1;
      t.updated_at = new Date().toISOString(); t.updated_by = '甲';
      await S.syncToFile(S.DB);
    }
    ok('★连着自己写 5 轮，一条误报都没有',
      S.DB.changelog.filter(e => e.kind === S.ALERT_LOG_KIND).length === alertsBefore);
    // 初始链 2 个（w0prev + w0）+ 自己写的 5 次 = 7
    ok('★链一路接了下来，长度对得上', JSON.parse(h._text).writeIds.length === 7, JSON.parse(h._text).writeIds.length);

    // 混版本：旧版 html 写了一次（把链抹掉），新版本必须跳过检测、不报警
    const 旧版写的 = Object.assign(EMPTY(), {
      tasks: [Object.assign(T0(), { title: '旧版改的', rev: 9, updated_at: new Date().toISOString(), updated_by: '丙' })],
      schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w_old', lastWriteBy: '丙',
      lastWriteApp: S.APP_VERSION, lastWriteAt: new Date().toISOString(),
    });   // 刻意不带 writeIds：旧版 html 不认识这个字段
    h._text = JSON.stringify(旧版写的); h._mtime += 1;
    const a2 = S.DB.changelog.filter(e => e.kind === S.ALERT_LOG_KIND).length;
    await S.pullFromFile();
    ok('★★旧版 html 写过之后（链断了），新版本不报"被覆盖"——换版本那几天不能满屏误报',
      S.DB.changelog.filter(e => e.kind === S.ALERT_LOG_KIND).length === a2);
    // 本机得真有点改动，syncToFile 才会写（没东西可推时它刻意不写，见 hasLocalContribution）
    const t2 = S.DB.tasks.find(x => x.id === 'T95');
    t2.title = '新版接着改'; t2.rev = (t2.rev || 0) + 1;
    t2.updated_at = new Date().toISOString(); t2.updated_by = '甲';
    await S.syncToFile(S.DB);
    ok('★新版本接着写时会重建链，并插上哨兵表示"这段判断不了"',
      (JSON.parse(h._text).writeIds || []).indexOf(S.WRITE_RING_RESET) !== -1, JSON.parse(h._text).writeIds);
  }

  section('七、源码接线');
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
    ok('★写回文件那条路径在合并【之前】做检测（晚一步基线就已经被当成参照用掉了）',
      /noteClobberedWrite\(cur\.remote, db\);[\s\S]{0,400}?const merged = normalizeMergedRecords/.test(src));
    ok('★只读拉取那条路径也做检测（定时软同步比保存频繁得多，漏在这里等于白修）',
      /noteClobberedWrite\(cur\.remote, DB\);/.test(src));
    ok('★写之前再确认一次文件没被抢先', /const fresh = await readSharedFile\(\);\s*\n\s*if \(fresh && !sameFileVersion\(fresh, cur\)\) continue;/.test(src));
    ok('★写入时把读到那份的链带上', /filePayload\(merged, db, writeId, cur\.remote\)/.test(src));
    ok('★校验通过之后才记"我这次写的标记"', /_lastWriteId = writeId;[\s\S]{0,200}_preWriteBase = preBase;/.test(src));
    ok('★回滚走的是带版本号护栏的逐条回滚，不是整份赋值',
      /const rolled = rollbackBaseForClobber\(db, remote\);/.test(src) && !/db\.syncBase = _preWriteBase;/.test(src));
    ok('★基线深拷贝拖到"确定要写"之后才做（绝大多数同步轮次根本不写，白拷几百 KB 不划算）',
      /if \(fresh && !sameFileVersion\(fresh, cur\)\) continue;[\s\S]{0,400}const preBase = db\.syncBase \?/.test(src));
    ok('★重试次数留够（多了一道确认，不能占掉唯一那次重试）', /attempt < 3/.test(src));
  }

  // 还原沙盒，免得影响同进程里别的断言
  S.DB.tasks = bak.tasks; S.DB.users = bak.users; S.DB.settings.me = bak.me;
  S.DB.syncBase = bak.base; S.DB.changelog = bak.log;
  S.setFileHandle(null); S.setLastWriteId(''); S.setPreWriteBase(null);
  S.rebuildIndex();

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
