/* P109：第十七轮——换两个全新的切法再查一遍同步

   前面几轮都是"构造一个场景看结果对不对"。这轮换成：

   切法①【代数性质】把合并当成数学对象，先写下"任何正确的合并都必须满足"的性质，
     再让机器随机造几百种交错去撞（sim/sim13.js）：
       · 串行写入不许丢：每次改完立刻同步到底，最终每个字段必须等于最后那次写；
       · 收敛：任意交错之后同步到静止，所有设备和共享文件必须完全一致；
       · 不凭空造值：最终每个值都得是某台设备真写过的；
       · 幂等：静止之后再同步，内容不变、也不该反复写文件。
     四条都成立。

   切法②【外部条件攻击】不再假设"文件是我们自己的、时钟是准的、同步一次只跑一轮"，
     直接去撞这些前提（scratchpad/probe-attack.js）。查出来两个真漏洞，这个文件把它们钉住：

     ★① 共享文件被换成【另一个处室】的数据文件 → 两套数据被合成一份，
        而且【我们的数据被写进了别人的文件】。双向污染，越同步混得越深。
        根因：系统里从来没有"这份文件是不是我们这套数据"的判据——isValidShareData
        只看"有没有 duties/tasks 两个数组"，任何一份格式合法的本应用文件都算自己人。
        真实触发一点不难：重新连接时文件夹选错、网盘上正好有个同名文件、
        或者把程序拷给别的处室用之后指错了地方。
        修法：给数据集加一串指纹（datasetId），谁第一次把数据写进空文件谁落下它，
        之后所有设备从文件里读到并记在本机；每次读文件都对一次，对不上就只读不写并摆门禁。

     ★② 「写之前再确认一次文件没被抢先」那道闸对【不是本程序写的改动】完全隐形。
        sameFileVersion 原来是逐级 return：两边有 writeId 就只比 writeId，
        后面的 lastWriteAt 和 mtime 根本不看。而有人直接用记事本改共享文件时
        writeId 不会变（这件事代码里早就承认过拦不住），于是那次改动被我们照原样盖掉。
        修法：改成"所有拿得到的信号都一致才算同一份"，任何一项对不上就重新合并一轮。

   用法：node test/test-p109.js */
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

function ours() {
  S.DB.settings.me = '本处管理员';
  S.DB.settings.datasetId = '';
  S.DB.users = [{ name: '本处管理员', role: 'admin', salt: '', hash: '', iterations: 0,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '本处管理员', rev: 1 }];
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '本处职责' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '本处工作',
    owner: '本处管理员', year: 2026, status: 'doing' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261', title: '本处任务',
    owner: '本处甲', status: 'doing', priority: '2', plan_date: '2026-10-01', progress: 30 }))];
  S.DB.milestones = []; S.DB.changelog = []; S.DB.purged = [];
  S.DB.permissionMatrix = null; S.DB.reportConfig = null; S.DB.dashboardConfig = null; S.DB.shareConfig = null;
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.undoStack.length = 0; S.setSnackPriorityUntil(0);
  S.setForeignFileBlocked(false);
  q('#snack-msg').textContent = ''; q('#login-body').innerHTML = '';
  q('#login-gate').classList.remove('show');
  S.rebuildIndex();
  _h = mkHandle(JSON.stringify(Object.assign(EMPTY(), {
    schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'] })));
  S.setFileHandle(_h); S.setEverConnected(true);
}
// 另一个处室的数据文件：格式完全合法，只是内容毫不相干
function foreignFile(withId) {
  const p = Object.assign(EMPTY(), {
    schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'wF', writeIds: ['wF'],
    lastWriteApp: S.APP_VERSION, lastWriteBy: '别处管理员', lastWriteAt: new Date().toISOString(),
    duties: [{ code: '09', category: '四、其它工作', name: '别处职责', rev: 3,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '别处管理员' }],
    works: [{ id: 'wX', code: '0901', duty: '09', name: '别处工作', content: [], owner: '别处乙',
      collaborators: [], year: 2026, status: 'doing', rev: 3,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '别处管理员' }],
    tasks: [{ id: 'TX', work: 'wX', code: '0901261', title: '别处任务', owner: '别处乙', assignees: [],
      status: 'doing', priority: '2', plan_date: '2026-10-01', progress: 0, actual_date: '',
      source: '', custom: '', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z', updated_by: '别处管理员', rev: 3 }],
    users: [{ name: '别处管理员', role: 'admin', salt: 'x', hash: 'y', iterations: 1000,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '别处管理员', rev: 1 }],
  });
  if (withId) p.datasetId = 'ds_别处那一套';
  return JSON.stringify(p);
}

async function main() {
  await tick(150);

  section('一、★★★共享文件被换成另一个处室的文件：两套数据绝不能合成一份');
  {
    ours();
    await S.Repo.persist(S.DB); await tick(30);
    ok('前置：第一次写进空文件时，落下了本处的数据集指纹', !!S.DB.settings.datasetId, S.DB.settings.datasetId);
    ok('前置：指纹写进文件里了', !!fileOf(_h).datasetId, fileOf(_h).datasetId);
    const mine = S.DB.settings.datasetId;

    const before = foreignFile(true);
    _h._text = before; _h._mtime++;          // 管理员点了"重新连接"，选到了别处的文件夹
    await S.Repo.persist(S.DB); await tick(40);

    ok('★★★本机没有被灌进别处的数据', S.DB.tasks.length === 1 && S.DB.duties.length === 1,
      { tasks: S.DB.tasks.map(t => t.id), duties: S.DB.duties.map(d => d.code) });
    ok('★★★别处的文件也没有被我们写脏（这是最要命的那一半）',
      _h._text === before, `文件里现在有 ${(fileOf(_h).tasks || []).length} 条任务`);
    ok('★本机指纹没被对方的顶掉', S.DB.settings.datasetId === mine, S.DB.settings.datasetId);
    ok('★★进入了"只读不写"状态', S.foreignFileBlocked === true);
    ok('★★摆出了门禁，把话说清楚了', /不是本处的数据/.test(q('#login-body').innerHTML));
    ok('★门禁里指出了最可能的原因（文件夹选错）', /选错/.test(q('#login-body').innerHTML));
    ok('★门禁里说明了本机数据没动', /一条都没动/.test(q('#login-body').innerHTML));
    ok('★门禁里给了退路（重新连接 / 重置缓存 / 找管理员）',
      /重新连接共享文件夹/.test(q('#login-body').innerHTML)
      && /重置本机缓存/.test(q('#login-body').innerHTML));
  }

  section('一之二、★老文件没有指纹时，用"记录主键有没有交集"兜底');
  {
    ours();
    await S.Repo.persist(S.DB); await tick(30);
    const before = foreignFile(false);        // 别处的老文件，连指纹都没有
    _h._text = before; _h._mtime++;
    await S.Repo.persist(S.DB); await tick(40);
    ok('★★没有指纹也拦住了（两边记录一条都不沾边）',
      S.DB.tasks.length === 1 && _h._text === before,
      { 本机任务: S.DB.tasks.map(t => t.id), 文件任务: (fileOf(_h).tasks || []).map(t => t.id) });
    ok('★同样进入只读状态并摆门禁', S.foreignFileBlocked === true
      && /不是本处的数据/.test(q('#login-body').innerHTML));
  }

  section('二、★不能误伤正常情况');
  {
    // ㈠ 同一套数据的另一台设备：文件里有指纹、本机还没有 → 认领，不是冲突
    ours();
    S.DB.settings.datasetId = '';
    const f = JSON.parse(_h._text);
    f.datasetId = 'ds_本处那一套';
    f.tasks = [{ id: 'T1', work: 'w1', code: '0101261', title: '文件里的本处任务', owner: '本处乙',
      assignees: [], status: 'doing', priority: '2', plan_date: '2026-10-01', progress: 0, actual_date: '',
      source: '', custom: '', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z', updated_by: '本处乙', rev: 5 }];
    _h._text = JSON.stringify(f); _h._mtime++;
    await S.Repo.persist(S.DB); await tick(40);
    ok('★★文件里有指纹、本机没有 → 认领它，不拦', S.foreignFileBlocked === false
      && S.DB.settings.datasetId === 'ds_本处那一套', S.DB.settings.datasetId);

    // ㈡ 空文件（刚建的共享文件）→ 没有指纹很正常，写进去时顺手落一个
    ours();
    await S.Repo.persist(S.DB); await tick(30);
    ok('★空文件不拦，而且写完文件里就有指纹了',
      S.foreignFileBlocked === false && !!fileOf(_h).datasetId, fileOf(_h).datasetId);

    // ㈢ 本机是空的（新同事第一次连）→ 不拦
    ours();
    S.DB.duties = []; S.DB.works = []; S.DB.tasks = []; S.DB.milestones = [];
    S.DB.settings.datasetId = '';
    S.rebuildIndex();
    _h._text = foreignFile(true); _h._mtime++;
    await S.pullFromFile(); await tick(40);
    ok('★★本机一条数据都没有时不拦（新同事第一次连，本来就该整份接过来）',
      S.foreignFileBlocked === false, S.foreignFileBlocked);

    // ㈣ 老文件没指纹、但记录对得上 → 同一套，不拦
    ours();
    await S.Repo.persist(S.DB); await tick(30);
    const f2 = JSON.parse(_h._text);
    delete f2.datasetId;                       // 模拟"上一版程序写的老文件"
    f2.tasks[0].title = '同事改的标题';
    f2.tasks[0].rev = (f2.tasks[0].rev || 1) + 1;
    _h._text = JSON.stringify(f2); _h._mtime++;
    S.setForeignFileBlocked(false);
    await S.Repo.persist(S.DB); await tick(40);
    ok('★★老文件没指纹、但记录对得上 → 认成同一套，正常同步',
      S.foreignFileBlocked === false && S.byId('task', 'T1').title === '同事改的标题',
      S.byId('task', 'T1').title);
  }

  section('二之三、★只读拉取这条路径也必须认指纹（不能只在写文件时才认）');
  {
    // ㈠ 别处的文件 + 只读拉取 → 绝不能把别处的数据合进本机
    ours();
    await S.Repo.persist(S.DB); await tick(30);
    _h._text = foreignFile(true); _h._mtime++;
    await S.pullFromFile(); await tick(35);
    ok('★★只读拉取也拦住了，本机没被灌进别处的数据',
      S.DB.tasks.length === 1 && !S.byId('task', 'TX') && S.DB.duties.length === 1,
      { tasks: S.DB.tasks.map(t => t.id), duties: S.DB.duties.map(d => d.code) });
    ok('★只读拉取也会进入只读状态并摆门禁',
      S.foreignFileBlocked === true && /不是本处的数据/.test(q('#login-body').innerHTML));

    // ㈡ 同一套数据的新设备：只读拉取时就该认领文件里的指纹，不该拖到写文件才认
    ours();
    await S.Repo.persist(S.DB); await tick(30);
    const f = JSON.parse(_h._text);
    f.datasetId = 'ds_本处那一套';
    f.tasks[0].title = '同事改的标题';
    f.tasks[0].rev = (f.tasks[0].rev || 1) + 1;
    _h._text = JSON.stringify(f); _h._mtime++;
    S.DB.settings.datasetId = '';               // 本机还没有指纹
    S.setForeignFileBlocked(false);
    await S.pullFromFile(); await tick(35);
    ok('★★只读拉取就把指纹认领下来了（不该等到写文件那一步）',
      S.DB.settings.datasetId === 'ds_本处那一套', S.DB.settings.datasetId);
    ok('★而且没被误判成别处的文件', S.foreignFileBlocked === false);
    ok('★内容正常拉回来了', S.byId('task', 'T1').title === '同事改的标题', S.byId('task', 'T1').title);
  }

  section('三、★"写前确认"必须能发现不是本程序写的改动（有人用记事本改了文件）');
  {
    ours();
    await S.Repo.persist(S.DB); await tick(30);
    const t = S.byId('task', 'T1');
    const b = JSON.parse(JSON.stringify(t));
    t.title = '我要写的';
    S.logRecordChange('task', 'T1', b, t, ['title']);
    S.stampMeta(t);
    // 在"读—合并—写"中间插一次改动，而且【不动 writeId】（记事本改文件就是这样）
    let injected = false;
    const orig = _h.getFile;
    _h.getFile = async function () {
      const r = await orig.call(_h);
      if (!injected) {
        injected = true;
        const f = JSON.parse(_h._text);
        const x = f.tasks.find(y => y.id === 'T1');
        x.owner = '别人插进来改的'; x.rev = (x.rev || 1) + 5;
        x.updated_at = new Date(Date.now() + 2000).toISOString(); x.updated_by = '同事丙';
        _h._text = JSON.stringify(f); _h._mtime++;   // writeId 没变，只有 mtime 变了
      }
      return r;
    };
    await S.Repo.persist(S.DB); await tick(50);
    _h.getFile = orig;
    await S.Repo.persist(S.DB); await tick(30);
    const fx = fileOf(_h).tasks.find(y => y.id === 'T1') || {};
    ok('★我的改动推上去了', fx.title === '我要写的', fx.title);
    ok('★★★别人那次"不带 writeId"的改动没被我盖掉（原来会被盖掉）',
      fx.owner === '别人插进来改的', fx.owner);
  }

  section('三之二、★sameFileVersion 的口径：任何一项对不上就算变过');
  {
    const A = { remote: { writeId: 'w1', lastWriteAt: 't1' }, mtime: 100 };
    ok('三项全一样 → 同一份', S.sameFileVersion(A, { remote: { writeId: 'w1', lastWriteAt: 't1' }, mtime: 100 }));
    ok('★writeId 一样但 mtime 变了 → 算变过（记事本改文件就是这样）',
      !S.sameFileVersion(A, { remote: { writeId: 'w1', lastWriteAt: 't1' }, mtime: 200 }));
    ok('★writeId 一样但 lastWriteAt 变了 → 算变过',
      !S.sameFileVersion(A, { remote: { writeId: 'w1', lastWriteAt: 't2' }, mtime: 100 }));
    ok('writeId 不一样 → 算变过',
      !S.sameFileVersion(A, { remote: { writeId: 'w2', lastWriteAt: 't1' }, mtime: 100 }));
    ok('两边都没有 writeId 时退回比 mtime',
      !S.sameFileVersion({ remote: {}, mtime: 1 }, { remote: {}, mtime: 2 })
      && S.sameFileVersion({ remote: {}, mtime: 1 }, { remote: {}, mtime: 1 }));
    ok('传空不抛异常', S.sameFileVersion(null, A) === false && S.sameFileVersion(A, null) === false);
  }

  section('四、★指纹判据本身的口径');
  {
    ours();
    const P = o => Object.assign(EMPTY(), o);
    ok('两份都有记录、一条都不沾边 → 不是同一套',
      !S.sharesAnyRecord(P({ tasks: [{ id: 'A' }] }), P({ tasks: [{ id: 'B' }] })));
    ok('有一条对得上 → 算同一套',
      S.sharesAnyRecord(P({ tasks: [{ id: 'A' }, { id: 'B' }] }), P({ tasks: [{ id: 'B' }] })));
    ok('职责按编号算', S.sharesAnyRecord(P({ duties: [{ code: '01' }] }), P({ duties: [{ code: '01' }] })));
    ok('★有一边是空的就谈不上"不沾边"，不算冲突',
      S.sharesAnyRecord(P({}), P({ tasks: [{ id: 'A' }] })));
    ok('payloadHasData 认得出空载荷', !S.payloadHasData(P({})) && S.payloadHasData(P({ tasks: [{ id: 'A' }] })));
    ok('★新指纹每次都不一样', S.newDatasetId() !== S.newDatasetId());
  }

  section('五、★回归：正常的多轮同步不受这两道闸影响');
  {
    ours();
    await S.Repo.persist(S.DB); await tick(30);
    for (let i = 1; i <= 4; i++) {
      const t = S.byId('task', 'T1');
      const b = JSON.parse(JSON.stringify(t));
      t.title = '第' + i + '次改';
      S.logRecordChange('task', 'T1', b, t, ['title']);
      S.stampMeta(t);
      await S.Repo.persist(S.DB); await tick(25);
      await S.pullFromFile(); await tick(20);
    }
    ok('★连改四轮，内容正确', S.byId('task', 'T1').title === '第4次改', S.byId('task', 'T1').title);
    ok('★共享文件一致', (fileOf(_h).tasks.find(x => x.id === 'T1') || {}).title === '第4次改');
    ok('★没有被误判成"别处的文件"', S.foreignFileBlocked === false);
    ok('★指纹一路稳定不变', fileOf(_h).datasetId === S.DB.settings.datasetId, {
      文件: fileOf(_h).datasetId, 本机: S.DB.settings.datasetId });
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
