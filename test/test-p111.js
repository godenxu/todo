/* P111：第十九轮排查——四个从来没碰过的面，一次全查

   这一轮查的是四块此前从未被正面检查过的区域，每一块都实测出了真问题：

   ① PIN 验证流程本身
      · verifyPin 写死用当前的 PIN_ITERATIONS 常量，账号里存着的 iterations 字段存了却没人读。
        只要哪天为加固把常量调大，全处所有人的 PIN 会在换版本那一刻同时失效，而且没有自助出路
        （重置 PIN 要求先有人以管理员身份登进来）。
      · 「首次设置 PIN」只看【本机内存里】那份用户记录判断"这个账号还没有主人"。
        实测出一条完整的账号劫持：共享文件里张三早就设好了 PIN，但这台机器的缓存还停在
        "张三没设过"那一版（管理员在这台机器上给张三改过几次角色，本机那条 rev 反而更高）。
        任何人选中张三 → 自己设一个 PIN → 当场以张三身份登录，并且把张三真正的 hash 顶掉，
        真张三从此登不进来。
      · 连续试错 12 次别人的 PIN，既不拦也不记，日志里一个字都没有。

   ② 自动备份的可靠性
      · claimBackupSlot 是在调 runBackup【之前】就把锁写进 localStorage 的，写失败没人还锁，
        于是接下来整整一个备份周期（默认 24 小时）每一轮都卡在抢锁这步直接返回，连试都不再试。
        网络盘抖一下就等于一整天没备份，而备份是这套系统最后一条退路。
      · 自动备份写失败是彻底静默的（catch 里只有 if (manual) showSnack）。备份盘掉线一个月，
        管理员一无所知，直到真需要恢复那天才发现最后一份是一个月前的。
      · 备份文件里带着 DB.syncBase——本机私有的同步基线草稿纸，对恢复毫无用处，体积却接近翻倍。

   ③ 报表统计口径
      · 里程碑/任务的「实际完成日期」，只要从"已完成"改回别的状态就被直接清空。
        手滑点掉一下勾再勾回来，8 月 5 日交付的东西就永久变成了今天；而检查点行上
        根本没有这个日期的输入框，用户发现了也改不回去。这条日期是"本期已交付"唯一的归期依据，
        错一次同时错两期：该算进 8 月的少一条，本期凭空多一条。
      · SPI 把挂起中的任务算进分母，按日历一天天扣分——挂起是主动决定暂不推进，
        这么算等于逼着大家不敢用挂起状态。

   ④ 里程碑的独立变更记录
      改里程碑只在【任务】那条记录上留一句给人看的描述（"检查点数：2→3"），
      程序没法从中还原出"M1 的交付日期从 9-20 挪到了 9-25"。于是「按日志核对数据」
      这道最后的防线，对里程碑完全是瞎的——而里程碑正是报表里"本期交出了什么"的唯一来源。

   另外记一笔自己的回归：第一版 hashPin 写成了
     Math.max(1, Number(iters) || 0) || PIN_ITERATIONS
   传 undefined 时算出 1（Math.max(1,0) 是 1，1 是真值就短路了），于是每个【新设】的 PIN
   都只跑 1 轮 PBKDF2。设和验用的是同一个数，所以登录一切正常、测试全绿，强度却已经没了。
   下面 ①-2 那条断言就是专门钉死这个的。

   用法：node test/test-p111.js */
const { sandbox: S, raw, q } = require('./harness.js');
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
function mkHandle(t) {
  const h = { name: 'shared.json', _text: t, _mtime: 1,
    async getFile() { const s = h._text; return { lastModified: h._mtime, text: async () => s }; },
    async createWritable() { return { async write(x) { h._p = x; }, async close() { h._text = h._p; h._mtime++; } }; } };
  return h;
}
// 用指定迭代次数手工算一个 PIN 哈希（模拟"别的版本 / 更早的常量"存下来的账号）
async function manualHash(pin, saltHex, iters) {
  const c = raw.crypto;
  const salt = Uint8Array.from(saltHex.match(/../g).map(x => parseInt(x, 16)));
  const key = await c.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await c.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/* 沙箱的 DOM 桩里 querySelectorAll 一律返回 []，任务详情保存因此读不到任何检查点行。
   按需要造几行出来，让保存路径能真的跑到里程碑那一段。 */
function cpRow(id, plan_date, deliverable, report_level, done) {
  return {
    getAttribute: k => (k === 'data-ms-id' ? id : null),
    querySelector: sel => ({
      '.cp-date': { value: plan_date },
      '.cp-deliv': { value: deliverable },
      '.cp-report-level': { value: report_level },
      '.cp-chk': { checked: done === '1' },
    }[sel]),
  };
}
const origQSA = raw.document.querySelectorAll;
const stubCp = rows => { raw.document.querySelectorAll = sel =>
  (sel === '#cp-list [data-cp-row]' ? rows : (origQSA ? origQSA(sel) : [])); };
const unstubCp = () => { raw.document.querySelectorAll = origQSA; };

function baseWorld() {
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
  S.rebuildIndex();
}
async function saveDetail(rows) {
  stubCp(rows);
  S.openTaskDetail('T1'); await tick(40);
  const before = S.DB.changelog.length;
  await S.modalCallback(); await tick(120);
  unstubCp();
  return S.DB.changelog.slice(before);
}

async function main() {
  await tick(120);

  /* ═══════════════ ① PIN 验证流程 ═══════════════ */
  section('①-1 verifyPin 必须认账号自己存着的 iterations，不能写死用当前常量');
  {
    const salt = 'aabbccddeeff00112233445566778899';
    const old = { name: '老账号', salt, hash: await manualHash('1234', salt, 1000), iterations: 1000 };
    ok('★★按 1000 轮存下来的老账号，验得过（常量怎么调都不会把全处锁在门外）',
      await S.verifyPin('1234', old));
    ok('★老账号输错 PIN 照样不给过', !(await S.verifyPin('9999', old)));

    const cur = await S.hashPin('1234', salt);
    ok('★★不传 iters 时用的是当前常量，不是 1', cur.iterations === S.PIN_ITERATIONS, cur.iterations);
    ok('★返回的 iterations 会被如实存进账号，下次验证才认得出来',
      (await S.verifyPin('1234', { salt, hash: cur.hash, iterations: cur.iterations })) === true);

    // 脏值兜底：老数据里这个字段可能是 0 / 负数 / 字符串
    for (const bad of [0, -5, '', null, undefined, 'abc', NaN]) {
      const r = await S.hashPin('1234', salt, bad);
      if (r.iterations !== S.PIN_ITERATIONS) { fail++; console.log('  ❌ 脏 iterations 没退回常量：' + String(bad)); break; }
    }
    ok('★iterations 是 0 / 负数 / 空 / 脏字符串时，一律退回当前常量（跟历史行为一致）', true);
  }

  section('①-2 pinHashEqual 是定长比较');
  {
    ok('相同的算相等', S.pinHashEqual('abcdef', 'abcdef'));
    ok('长度不同直接不等', !S.pinHashEqual('abcdef', 'abcde'));
    ok('只差最后一位也不等', !S.pinHashEqual('abcdef', 'abcdeg'));
    ok('只差第一位也不等（不能在第一个不同处提前返回）', !S.pinHashEqual('abcdef', 'zbcdef'));
    ok('空值不抛异常', S.pinHashEqual('', '') === true && S.pinHashEqual(null, '') === true);
    /* 只截函数体本身：slice 放宽一点就会捞进紧随其后的 verifyPin，
       它里头那句 if (!user...) return false 会让"有没有提前 return"这个判断假红。 */
    const at = SRC.indexOf('function pinHashEqual');
    const body = SRC.slice(at, SRC.indexOf('\n}', at));
    ok('★循环体只做异或累加，一次都不提前跳出',
      /for \(let i = 0; i < a\.length; i\+\+\) diff \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\);/.test(body), body);
    // 循环体是单语句形式（后面直接跟分号），语法上就不可能藏 return/break——
    // 上一条断言已经把整行钉死了，这里只再确认循环之后只剩一句汇总判断
    ok('★循环跑完才给结论，不在中途下结论', /\n  return diff === 0;/.test(body), body);
  }

  section('①-3 连续试错：限次 + 留痕');
  {
    try { S.storage.removeItem(S.PIN_FAIL_KEY); } catch (e) {}
    ok('干净状态下不锁', S.pinLockRemainMs('张三') === 0 && S.pinLockRemainText('张三') === '');
    let r;
    for (let i = 1; i < S.PIN_FAIL_LIMIT; i++) {
      r = S.notePinFailure('张三');
      if (r.locked) break;
    }
    ok(`★错满 ${S.PIN_FAIL_LIMIT - 1} 次还没锁（留出正常记错的余地）`, !r.locked, r);
    r = S.notePinFailure('张三');
    ok(`★★第 ${S.PIN_FAIL_LIMIT} 次锁上了`, r.locked && r.justLocked, r);
    ok('★锁上之后剩余时间是正的', S.pinLockRemainMs('张三') > 0);
    ok('★剩余时间有人话（分钟/秒）', /分钟|秒/.test(S.pinLockRemainText('张三')), S.pinLockRemainText('张三'));
    const r2 = S.notePinFailure('张三');
    ok('★★锁定期里继续乱点，不会再报 justLocked（否则一串重复告警自己就把日志页淹了，'
      + '而 changelog 是有上限的，等于帮着攻击者把真正的历史挤掉）', !r2.justLocked, r2);
    ok('★别人的账号不受连坐', S.pinLockRemainMs('李四') === 0);
    S.clearPinFailures('张三');
    ok('★验过一次就一笔勾销', S.pinLockRemainMs('张三') === 0);

    // 窗口过期：很久没再错过，之前的次数不该继续累加
    const all = {}; all['王五'] = { n: 99, first: 1, last: Date.now() - S.PIN_FAIL_WINDOW_MS - 1000, until: 0 };
    S.writePinFails(all);
    const r3 = S.notePinFailure('王五');
    ok('★★上次出错已经是很久以前，计数重新从 1 开始（不然错一次、隔一周再错一次也会被锁）',
      r3.n === 1 && !r3.locked, r3);
    S.clearPinFailures('王五');
    ok('计数存在本机 localStorage、不进 DB（这是"这台机器上的人在试"，不该同步给别人）',
      /localStorage\.setItem\(PIN_FAIL_KEY/.test(SRC) && !/DB\.[a-zA-Z]*[Pp]inFail/.test(SRC));
  }

  section('①-4 走完整条登录路径：锁定期不给试，达到阈值写一条随共享文件同步的告警');
  {
    baseWorld();
    try { S.storage.removeItem(S.PIN_FAIL_KEY); } catch (e) {}
    const salt = 'ffeeddccbbaa99887766554433221100';
    const hh = await manualHash('8888', salt, S.PIN_ITERATIONS);
    S.DB.users = [{ name: '李四', role: 'admin', salt, hash: hh, iterations: S.PIN_ITERATIONS, rev: 1,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '李四' }];
    S.DB.changelog = []; S.DB.settings.me = ''; S.rebuildIndex();

    const tryPin = async v => {
      q('#login-body').innerHTML = '<input id="login-pin">';
      q('#login-pin').value = v;
      await S.ACTIONS['login-verify-pin']({ name: '李四' });
      await tick(10);
      return q('#login-body').innerHTML;
    };
    let html = '';
    for (let i = 0; i < S.PIN_FAIL_LIMIT; i++) html = await tryPin('000' + i);
    ok('★★错满阈值后界面明说要等一会儿', /连续输错太多次/.test(html), html.slice(0, 200));
    const alerts = S.DB.changelog.filter(e => /连续 \d+ 次输错/.test(e.summary || ''));
    ok('★★写了一条告警日志——这道闸真正的分量在留痕这一半（本机计数谁都能清掉，告警同步给所有人）',
      alerts.length === 1, S.DB.changelog.map(e => e.summary));
    ok('★告警的 by 不冒充任何人（试错的人是谁本来就不知道）',
      alerts.length === 1 && alerts[0].by === '未署名', alerts[0] && alerts[0].by);
    ok('★告警带上了被试的是谁', alerts.length === 1 && alerts[0].target === '李四');
    ok('★★锁定期里输对了也不放行（不给"多试几次撞上"留口子）',
      /连续输错太多次/.test(await tryPin('8888')) && S.DB.settings.me === '');

    /* 锁到期之后，正确的 PIN 要能进，而且这一串失败次数要被一笔勾销。
       ★ 这里刻意【只把 until 清零】模拟"锁自己过期了"，保留累计的 n ★
         早先这条断言是先调 clearPinFailures 再登录，于是它验的是自己刚清掉的结果，
         代码里那句 clearPinFailures 整个删掉都照样绿——变异测试当场把它抓了出来。
         留着 n 才测得出"登录成功到底有没有清"：不清的话 n 已经到了阈值，
         下一次随便错一下就又被锁，正常用着用着就被自己关在门外。 */
    const fails = S.readPinFails();
    ok('（前提）失败次数确实累到了阈值', fails['李四'] && fails['李四'].n >= S.PIN_FAIL_LIMIT, fails['李四']);
    fails['李四'].until = 0; S.writePinFails(fails);
    await tryPin('8888'); await tick(60);
    ok('★★解锁后用对的 PIN 能正常登录', S.DB.settings.me === '李四');
    ok('★★登录成功把失败计数一笔勾销（不清的话，下次随便错一下就又被锁）',
      !S.readPinFails()['李四'], S.readPinFails()['李四']);
    ok('★所以紧接着错一次也不会立刻被锁', !S.notePinFailure('李四').locked);
    S.clearPinFailures('李四');
    ok('★没有因为前面那串失败就少记登录日志',
      S.DB.changelog.some(e => S.logKind(e) === 'login' && e.by === '李四'));
  }

  section('①-5 「首次设置 PIN」必须回共享文件确认，不能拿本机缓存当真');
  {
    const salt = '11223344556677889900aabbccddeeff';
    const realHash = await manualHash('8888', salt, S.PIN_ITERATIONS);
    const remoteUsers = [
      { name: '管理员', role: 'admin', salt: '', hash: '', iterations: 0, rev: 1,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' },
      { name: '张三', role: 'staff', salt, hash: realHash, iterations: S.PIN_ITERATIONS, rev: 2,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-09-12T00:00:00.000Z', updated_by: '张三' },
    ];
    const h = mkHandle(JSON.stringify(Object.assign(EMPTY(), {
      schemaVersion: S.DATA_SCHEMA_VERSION, users: remoteUsers, writeId: 'w0', writeIds: ['w0'] })));
    /* 本机那份陈旧缓存 rev 反而更高——完全正常：管理员在这台机器上给张三改过几次角色，
       这些改动都抬过 rev，而"张三自己设 PIN"那一笔还没同步进来。
       这正是实测出账号劫持的那个配置。 */
    S.DB.users = [Object.assign({}, remoteUsers[0]),
      { name: '张三', role: 'staff', rev: 7,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', updated_by: '管理员' }];
    S.DB.tasks = []; S.DB.works = []; S.DB.duties = []; S.DB.milestones = [];
    S.DB.changelog = []; S.DB.purged = []; S.DB.settings.me = '';
    S.clearSyncBaseline(S.DB); S.rebuildIndex();
    S.setFileHandle(h); S.setEverConnected(true);

    q('#login-body').innerHTML = '<input id="login-new-pin"><input id="login-new-pin2">';
    q('#login-new-pin').value = '0000'; q('#login-new-pin2').value = '0000';
    await S.ACTIONS['login-set-pin']({ name: '张三' });
    await tick(150);

    const zs = (JSON.parse(h._text).users || []).find(u => u.name === '张三') || {};
    ok('★★共享文件里张三的 PIN 没被顶掉', zs.hash === realHash, zs.hash && zs.hash.slice(0, 12));
    ok('★★冒名者设的 0000 验不过', !(await S.verifyPin('0000', zs)));
    ok('★★真张三用自己的 8888 还能验过（不会被锁在门外）', await S.verifyPin('8888', zs));
    ok('★★冒名者没有登录成功', S.DB.settings.me === '', S.DB.settings.me);
    ok('★界面改走"请输入 PIN"，不是继续让他设', /输入 PIN/.test(q('#login-body').innerHTML));
    ok('★本机那条陈旧记录被就地补成了共享文件里的最新版（下次不用再绕一圈）',
      (S.DB.users.find(u => u.name === '张三') || {}).hash === realHash);
    ok('★★留了一条告警——这是一次未遂的账号劫持，不该无声无息',
      S.DB.changelog.some(e => /试图给已经设过 PIN 的账号/.test(e.summary || '')),
      S.DB.changelog.map(e => e.summary));

    // 反面：共享文件里确实还没设过，就该照常放行（别把真正的首次登录也堵死）
    const h2 = mkHandle(JSON.stringify(Object.assign(EMPTY(), {
      schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'],
      users: [remoteUsers[0], { name: '新人', role: 'staff', rev: 1,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' }] })));
    S.DB.users = [Object.assign({}, remoteUsers[0]),
      { name: '新人', role: 'staff', rev: 1,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' }];
    S.DB.changelog = []; S.DB.settings.me = ''; S.clearSyncBaseline(S.DB); S.rebuildIndex();
    S.setFileHandle(h2);
    q('#login-body').innerHTML = '<input id="login-new-pin"><input id="login-new-pin2">';
    q('#login-new-pin').value = '1357'; q('#login-new-pin2').value = '1357';
    await S.ACTIONS['login-set-pin']({ name: '新人' });
    await tick(150);
    ok('★★真正的首次设置照常放行，没被这道闸误伤', S.DB.settings.me === '新人', S.DB.settings.me);
    ok('★而且设进去的 PIN 是好用的',
      await S.verifyPin('1357', S.DB.users.find(u => u.name === '新人')));

    // 离线/没连共享文件时也不能硬拦（那种情况下本来就没有"别人"）
    ok('★源码里这道闸挂在"连着共享文件"这个前提下，离线单机不受影响',
      /if \(_fileHandle\) \{[\s\S]{0,1600}?readSharedFile\(\)/.test(SRC));
    S.setFileHandle(null); S.setEverConnected(false);
  }

  /* ═══════════════ ② 自动备份 ═══════════════ */
  section('②-1 备份写失败要把锁还回去，别占着一整个周期不让下一轮再试');
  {
    try { S.storage.removeItem(S.BACKUP_LOCK_KEY); } catch (e) {}
    const prev = S.peekBackupSlot();
    ok('一开始没有锁', prev === null);
    ok('抢得到', S.claimBackupSlot(24) === true);
    ok('抢完之后别人抢不到（跨标签页防重复那一层还在）', S.claimBackupSlot(24) === false);
    S.restoreBackupSlot(prev);
    ok('★★还回去之后，下一轮定时器又抢得到了', S.claimBackupSlot(24) === true);

    // 原来有锁的情况：要原样放回去，不能变成"没锁"
    const stamp = S.peekBackupSlot();
    S.restoreBackupSlot(stamp);
    ok('★原来有值就原样放回，不会把别的标签页刚占的槽位抹掉', S.peekBackupSlot() === stamp);
    S.restoreBackupSlot(null);
    ok('★原来是空就清干净', S.peekBackupSlot() === null);

    const fn = SRC.slice(SRC.indexOf('async function maybeAutoBackup'), SRC.indexOf('async function maybeAutoBackup') + 900);
    ok('★★maybeAutoBackup 里真的接上了：抢锁前记原值', /const prevSlot = peekBackupSlot\(\)/.test(fn));
    ok('★★runBackup 返回 false 就还回去', /if \(!written\) restoreBackupSlot\(prevSlot\)/.test(fn));
  }

  section('②-2 自动备份写失败不能再静默');
  {
    const i = SRC.indexOf('async function runBackup');
    const tail = SRC.slice(i, i + 4600);
    const cat = tail.slice(tail.indexOf('  } catch (e) {'));
    ok('★★失败会弹提示（不再是只有 manual 才说话）', /showSnack\('⚠ 定期备份失败了/.test(cat));
    ok('★提示带上了失败原因，管理员才知道该去查什么', /定期备份失败了.*\+ why/.test(cat));
    ok('★★第一次失败会写一条随共享文件同步的告警（备份坏了不该只有开着页面的人知道）',
      /pushAlertLog\(`定期备份写入失败/.test(cat));
    ok('★提示有节流，不刷屏', /_lastBackupFailWarnAt > 1200000/.test(cat));
    ok('★★备份成功会把节流标记清零——下次真出问题时立刻说话，不被上一次的节流压住',
      /_lastBackupFailWarnAt = 0;/.test(tail));
    ok('★手动备份仍然是当场报错、不写告警（有人盯着，不需要异步告警）',
      /if \(manual\) \{ showSnack\('备份失败：' \+ why\); return false; \}/.test(cat));
  }

  section('②-3 备份文件不再夹带本机私有的同步基线');
  {
    baseWorld();
    for (let i = 0; i < 30; i++) S.DB.tasks.push(S.stampMeta(S.blank('task',
      { id: 'BT' + i, work: 'w1', title: '备份体积任务' + i, owner: '管理员', status: 'doing', progress: 10 })));
    S.rebuildIndex();
    S.DB.syncBase = S.buildSyncBase(S.syncPayload(S.DB));
    const snap = S.backupSnapshot();
    ok('★★写出去的那一份不含 syncBase', !('syncBase' in snap));
    ok('★★但 DB 自己的基线一点没动（备份不该有副作用）', !!S.DB.syncBase);
    const missing = Object.keys(S.DB).filter(k => k !== 'syncBase' && !(k in snap));
    ok('★★除 syncBase 外一个字段都不能少——少一个就可能让某天的恢复缺一块', !missing.length, missing);
    ok('★业务数据是同一批对象，没有被复制/改写', snap.tasks === S.DB.tasks && snap.users === S.DB.users);
    const whole = JSON.stringify(S.DB).length, written = JSON.stringify(snap).length;
    ok('★体积确实小了一大截（基线是每条记录一份快照，常年每天写一份不该一半都是草稿纸）',
      written < whole * 0.75, { whole, written });
    ok('★★定期备份和手动导出用的是同一份内容（两个入口的备份文件必须长得一样，'
      + '否则"从备份恢复"要分情况处理，迟早出岔子）',
      /await w\.write\(JSON\.stringify\(backupSnapshot\(\), null, 1\)\)/.test(SRC)
      && /download\(`工作管理备份_\$\{stamp\(\)\}\.json`, JSON\.stringify\(backupSnapshot\(\), null, 1\)/.test(SRC));
    ok('★★没有地方再把整个 DB 当备份写出去', !/JSON\.stringify\(DB, null, 1\)/.test(SRC));
  }

  /* ═══════════════ ③ 实际完成日期不能被手滑抹掉 ═══════════════ */
  section('③-1 里程碑：取消勾选再勾回来，交付日期要原样回来');
  {
    baseWorld();
    S.DB.milestones = [S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', plan_date: '2026-08-10',
      deliverable: '调研报告', report_level: 'section', done: '1', actual_date: '2026-08-05' }))];
    S.rebuildIndex();
    await saveDetail([cpRow('M1', '2026-08-10', '调研报告', 'section', '0')]);
    ok('★★取消勾选后，实际完成日期留着（原来直接清成空串）',
      S.byId('milestone', 'M1').actual_date === '2026-08-05', S.byId('milestone', 'M1').actual_date);
    ok('★但完成标记确实改掉了', S.byId('milestone', 'M1').done === '0');
    await saveDetail([cpRow('M1', '2026-08-10', '调研报告', 'section', '1')]);
    ok('★★勾回来之后还是 8 月 5 日，不是今天', S.byId('milestone', 'M1').actual_date === '2026-08-05',
      S.byId('milestone', 'M1').actual_date);

    // 真·新完成的仍然记今天
    S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: 'M9', task: 'T1', plan_date: '2026-09-01',
      deliverable: '新交付物', report_level: 'section', done: '0', actual_date: '' })));
    S.rebuildIndex();
    await saveDetail([cpRow('M1', '2026-08-10', '调研报告', 'section', '1'),
      cpRow('M9', '2026-09-01', '新交付物', 'section', '1')]);
    ok('★从来没完成过的那条，第一次勾上记的是今天', S.byId('milestone', 'M9').actual_date === S.todayStr());
  }

  section('③-2 任务：三条改状态的路径，都不该抹掉实际完成日期');
  {
    // (a) 自动纠正：进度从 100 往回调
    let t = { status: 'done', progress: 100, actual_date: '2026-03-01' };
    S.reconcileStatusAndProgress(t, Object.assign({}, t, { progress: 100 }));
    t.progress = 60; S.reconcileStatusAndProgress(t, { status: 'done', progress: 100, actual_date: '2026-03-01' });
    ok('★★进度掉下来，状态退回进行中但日期留着', t.status === 'doing' && t.actual_date === '2026-03-01', t);
    // (b) 用户显式改状态
    t = { status: 'done', progress: 100, actual_date: '2026-03-01' };
    const bf = Object.assign({}, t); t.status = 'doing';
    S.reconcileStatusAndProgress(t, bf);
    ok('★★显式改回进行中，日期同样留着（两条路必须同一个规则，'
      + '不然"怎么改回去的"会决定日期还在不在，用户根本预料不到）', t.actual_date === '2026-03-01', t);
    // (c) 改回已完成时沿用旧日期，不改成今天
    t.status = 'done';
    S.reconcileStatusAndProgress(t, { status: 'doing', progress: 100, actual_date: '2026-03-01' });
    ok('★★再改回已完成，沿用 3 月 1 日，不记成今天', t.actual_date === '2026-03-01', t);

    ok('★★源码里没有留下任何"改回未完成就清空"的写法',
      !/t\.actual_date = '';/.test(SRC) && !/cur\.actual_date = cd\.done === '1' \? \(cur\.actual_date \|\| todayStr\(\)\) : '';/.test(SRC));
  }

  section('③-3 留着日期不会让任何统计把它当成"已完成"');
  {
    baseWorld();
    const t = S.byId('task', 'T1');
    t.status = 'doing'; t.progress = 50; t.actual_date = '2026-05-01';   // 曾经完成过，现在退回了
    t.created_at = '2026-01-01T00:00:00.000Z';
    S.rebuildIndex();
    ok('★★历史趋势里它在 5 月之后依然算"还没完成"（backlogAsOf 先看 status，'
      + '不是只看 actual_date——这是留着日期的前提）',
      S.backlogAsOf([t], '2026-06-01') === 1, S.backlogAsOf([t], '2026-06-01'));
    ok('★它现在就是待办', S.isOpen(t));
    const m = S.byId('milestone', 'M1');
    m.done = '0'; m.actual_date = '2026-05-01';
    const pie = S.msCompletionPie([t]);
    ok('★★里程碑图里它不算已完成（先看 done === "1"）',
      (pie.find(x => x.label === '已完成') || {}).n === 0, pie);
    ok('★源码里报表的两条归期口径都带着状态守卫',
      /t\.status === 'done' && t\.actual_date && t\.actual_date >= rangeStart/.test(SRC)
      && /m\.done === '1' && m\.actual_date && m\.actual_date >= rangeStart/.test(SRC));
  }

  section('③-4 编辑态能看见这个日期（看不见就没法发现它填错了）');
  {
    const done = S.cpRowHTML({ id: 'X1', plan_date: '2026-08-10', deliverable: '甲', report_level: 'section',
      done: '1', actual_date: '2026-08-05' });
    ok('★已交付的行上显示交付日期', /交付于 2026-08-05/.test(done), done.slice(0, 60));
    const undone = S.cpRowHTML({ id: 'X2', plan_date: '2026-08-10', deliverable: '乙', report_level: 'section',
      done: '0', actual_date: '2026-08-05' });
    ok('★★退回未完成的行上说明"上次完成"，并提示再勾上会沿用这个日期', /上次完成 2026-08-05/.test(undone));
    ok('★提示文字说清了不会改成今天', /会沿用这个日期，不会改成今天/.test(undone));
    const never = S.cpRowHTML({ id: 'X3', plan_date: '2026-08-10', deliverable: '丙', report_level: 'section', done: '0', actual_date: '' });
    ok('★从没完成过的行上不显示这块（别加无谓的噪音）', !/cp-actual/.test(never));
  }

  /* ═══════════════ ④ 里程碑的独立变更记录 ═══════════════ */
  section('④-1 改里程碑要留下以里程碑为主体的逐字段记录');
  {
    baseWorld();
    const added = await saveDetail([
      cpRow('M1', '2026-09-25', '调研报告（终稿）', 'bureau', '0'),
      cpRow('M2', '2026-09-30', '会议纪要', 'section', '0'),
    ]);
    const ms = added.filter(e => e.entity === 'milestone');
    ok('★★有里程碑自己的那条', ms.length === 1, added.map(e => e.entity + ':' + e.summary));
    ok('★挂在被改的那一条上', ms[0] && ms[0].refId === 'M1');
    ok('★★带了机器可读的逐字段明细（"按日志核对数据"要的就是这个）',
      ms[0] && Array.isArray(ms[0].changes) && ms[0].changes.length === 3, ms[0] && ms[0].changes);
    const byK = {}; (ms[0].changes || []).forEach(c => { byK[c.k] = c; });
    ok('★计划日期记了改前改后', byK.plan_date && byK.plan_date.from === '2026-09-20' && byK.plan_date.to === '2026-09-25', byK.plan_date);
    ok('★交付物记了改前改后', byK.deliverable && byK.deliverable.to === '调研报告（终稿）', byK.deliverable);
    ok('★呈报层级也记了（报表按这个分组，改了没人知道最要命）', !!byK.report_level, byK.report_level);
    ok('★没动的那条不记（不制造噪音）', !added.some(e => e.refId === 'M2'));
    ok('★任务那条附带描述还在（给人看的那一半没丢）',
      added.some(e => e.entity === 'task' && /调研报告（终稿）/.test(e.summary)));
  }

  section('④-2 新增 / 删除里程碑也要留痕');
  {
    baseWorld();
    const added = await saveDetail([
      cpRow('M1', '2026-09-20', '调研报告', 'section', '0'),
      cpRow('', '2026-10-15', '结题材料', 'bureau', '0'),
    ]);
    const ms = added.filter(e => e.entity === 'milestone');
    ok('★★增删各留一条', ms.length === 2, ms.map(e => e.summary));
    ok('★新增那条说清了是什么、计划哪天', ms.some(e => /新增里程碑「结题材料」，计划 2026-10-15/.test(e.summary)));
    ok('★★删除那条说清了删的是什么（同事问"我那条交付物怎么没了"，日志里查得到）',
      ms.some(e => /删除里程碑「会议纪要」（原计划 2026-09-30）/.test(e.summary)));
    ok('★删除那条挂在被删的那个 id 上', ms.some(e => e.refId === 'M2' && /删除/.test(e.summary)));
    /* 增删刻意不带 changes：它们没有"改前的值"可供核对，硬塞一份进去，
       核对时会把它当成"这个字段现在应该是 X"，而一条刚被删掉的记录本来就不参与核对，
       记了也是白记，反而让人以为查得到。 */
    /* P126 改了：删除要带"删除状态"这一格的明细。原来的理由是"被删的记录不参与核对，记了也白记"——
       真实事故正是"删掉的里程碑自己回来了、日志里核对不出来也改不回去"。核对现在认删除状态了，
       删除明细恰恰是修复的依据。新增仍然不带（没有改前的值可核对）。 */
    ok('★★删除带上了删除状态的明细，新增仍不带',
      ms.filter(e => /删除/.test(e.summary)).every(e => Array.isArray(e.changes) && e.changes.some(c => c.k === 'deleted_at' && c.to))
      && ms.filter(e => /新增/.test(e.summary)).every(e => !e.changes),
      ms.map(e => [e.summary, e.changes]));
  }

  section('④-3 一次改太多条就退回一句汇总，不把日志页冲掉');
  {
    // 日期必须两两不同：重复的计划日期会被 findDuplicateCpIssue 当场拦下，保存根本不会发生
    const dd = i => '2026-10-' + String(i + 1).padStart(2, '0');
    const build = n => {
      baseWorld();
      S.DB.milestones = [];
      const rows = [];
      for (let i = 0; i < n; i++) {
        const id = 'MX' + i;
        S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id, task: 'T1', plan_date: dd(i),
          deliverable: '交付物' + i, report_level: 'section', done: '0' })));
        rows.push(cpRow(id, dd(i), '交付物' + i + '改', 'bureau', '0'));   // 每条都改了交付物
      }
      S.rebuildIndex();
      return rows;
    };
    const added = await saveDetail(build(S.MS_LOG_MAX + 3));
    const ms = added.filter(e => e.entity === 'milestone');
    ok('★★超过上限就不逐条记了（changelog 有上限，一次普通编辑不该冲掉十几条历史）',
      ms.length === 0, ms.length);
    ok('★★但也不是一声不吭——挂一条汇总在任务上，说清动了几条',
      added.some(e => /一次调整了 \d+ 条里程碑/.test(e.summary || '')), added.map(e => e.summary));
    ok('★汇总里说明了为什么没有明细', added.some(e => /条数太多，未逐条记录明细/.test(e.summary || '')));

    // 边界：正好等于上限时仍然逐条记，不能差一条
    const added2 = await saveDetail(build(S.MS_LOG_MAX));
    const ms2 = added2.filter(e => e.entity === 'milestone');
    ok('★★正好等于上限时仍然逐条记（边界不能差一条）', ms2.length === S.MS_LOG_MAX, ms2.length);
    ok('★这一批每条都带着自己的逐字段明细', ms2.every(e => e.changes && e.changes.length));
  }

  section('④-4 有了这些记录，"按日志核对数据"终于查得到里程碑被退回');
  {
    baseWorld();
    await saveDetail([
      cpRow('M1', '2026-09-25', '调研报告（终稿）', 'bureau', '0'),
      cpRow('M2', '2026-09-30', '会议纪要', 'section', '0'),
    ]);
    ok('核对当下是干净的', !S.auditByChangelog().some(i => i.entity === 'milestone'));
    // 模拟"开着旧页面的同事把它顶回去了"
    const m = S.byId('milestone', 'M1');
    m.plan_date = '2026-09-20'; m.deliverable = '调研报告'; m.report_level = 'section';
    S.stampMeta(m);
    const issues = S.auditByChangelog().filter(i => i.entity === 'milestone');
    ok('★★三处改动全查出来了（这是这一轮之前完全查不到的一类）', issues.length === 3,
      issues.map(i => i.field));
    ok('★指出了日志说应该是什么', issues.some(i => i.field === 'plan_date' && i.to === '2026-09-25'));
    ok('★也指出了现在实际是什么', issues.some(i => i.field === 'plan_date' && i.now === '2026-09-20'));
    ok('★标题取的是交付物（milestone 的 titleField），不是一串 id',
      issues.every(i => i.title === '调研报告'), issues.map(i => i.title));
    ok('★★点出了"日志之后还有人动过它"——这正是被旧页面顶回去的特征',
      issues.every(i => i.changedAfterLog === true));
    ok('★这些都是能修的（不是派生字段）', S.repairableIssues(issues).length === 3);

    const r = await S.repairByChangelog(issues);
    await tick(60);
    ok('★★按日志修得回去', r.ok === 3 && !r.stuck.length, r);
    ok('★数据真的改回来了', S.byId('milestone', 'M1').plan_date === '2026-09-25'
      && S.byId('milestone', 'M1').deliverable === '调研报告（终稿）');
    ok('★修完之后再核对是干净的', !S.auditByChangelog().some(i => i.entity === 'milestone' && i.id === 'M1'));
  }

  /* ═══════════════ ⑤ SPI 口径 ═══════════════ */
  section('⑤ SPI：挂起和已删除的任务不参与');
  {
    const day = n => S.offsetDate(n);
    const mk = o => S.stampMeta(S.blank('task', Object.assign({ work: 'w1', owner: '管理员',
      status: 'doing', priority: '2' }, o)));
    const hold = mk({ id: 'SH', title: '挂起', progress: 0, status: 'hold',
      plan_date: day(30), created_at: day(-30) + 'T00:00:00.000Z' });
    ok('★★挂起中的任务完全不参与（原来算 0，等于按日历一天天扣分，'
      + '逼着大家不敢用挂起这个状态）', S.computeSPI([hold]) === null, S.computeSPI([hold]));
    const del = Object.assign(mk({ id: 'SD', title: '已删', progress: 0,
      plan_date: day(10), created_at: day(-10) + 'T00:00:00.000Z' }), { deleted_at: new Date().toISOString() });
    ok('★★已删除的不参与（这是要摆到处领导面前的指标，不该把"滤没滤干净"托付给每个调用点）',
      S.computeSPI([del]) === null, S.computeSPI([del]));

    // 正常任务的算法一点没变
    const normal = mk({ id: 'SN', title: '正常', progress: 50,
      plan_date: day(10), created_at: day(-10) + 'T00:00:00.000Z' });
    const v = S.computeSPI([normal]);
    ok('★正常任务照算：过了一半工期、进度 50%，SPI 在 1 附近', v !== null && v > 0.9 && v < 1.1, v);
    ok('★没有计划完成日的还是不参与（老规矩没变）',
      S.computeSPI([mk({ id: 'SX', title: '无计划日', progress: 0, plan_date: '' })]) === null);
    ok('★★挂起的混在一堆正常任务里，只是被跳过，不影响其他任务的算法',
      Math.abs(S.computeSPI([normal, hold]) - v) < 1e-9, [S.computeSPI([normal, hold]), v]);
    ok('★全是挂起时返回 null（界面显示"—"，不是一个吓人的 0）', S.computeSPI([hold, hold]) === null);
    ok('★界面上的口径说明跟着改了（不能让人对着一个说不清的数字）',
      /已挂起的任务也不参与（挂起是主动决定暂不推进，不该按日历一天天扣分）/.test(SRC));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { unstubCp(); console.error('测试异常：', e); process.exit(1); });
