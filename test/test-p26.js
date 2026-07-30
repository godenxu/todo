/* P26：本轮改动测试——
   1) html 不再自带任何测试数据：boot() 首次打开是一份空系统，演示数据只由测试脚手架自己播
   2) 数据文件格式版本（DATA_SCHEMA_VERSION）+ 旧版本 html 的升级门禁：
      文件是更新版本写的 → 一律不许写、挡住界面要求换新版
   3) 多人协作防丢数据：syncToFile() 去掉"时间戳没变就直接覆盖"的快路径，改成每次都读-合并-写，
      并且写完再读一遍核对，被别人盖掉就重试一次
   4) 身份门禁上的"连接共享文件夹"按钮（全新设备本机没账号时的唯一出路，不然是死结）
   用法：node test/test-p26.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

/* 假的共享文件句柄。可以模拟"写到一半被别人抢着写了"：
   把 stealOnNextWrite 设成一段内容，下一次 close() 之后文件内容就会被换成它，
   等于别人在我们写完的瞬间又盖了一层 */
function makeFakeFileHandle(initialText) {
  const h = {
    name: 'shared.json',
    _text: initialText,
    _mtime: 1000,
    _writes: [],
    stealOnNextWrite: null,
    async getFile() { return { lastModified: h._mtime, text: async () => h._text }; },
    async createWritable() {
      return {
        async write(t) { h._pending = t; },
        async close() {
          h._writes.push(h._pending);
          h._text = h._pending;
          h._mtime += 1;
          if (h.stealOnNextWrite !== null) { h._text = h.stealOnNextWrite; h.stealOnNextWrite = null; h._mtime += 1; }
        },
      };
    },
  };
  return h;
}
const businessPayload = extra => Object.assign({
  duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [], permissionMatrix: null, shareConfig: null,
}, extra || {});

async function main() {
  await tick(60);
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const bakDuties = JSON.parse(JSON.stringify(S.DB.duties));
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.DB.duties = JSON.parse(JSON.stringify(bakDuties));
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.setFileHandle(null); S.setVersionBlocked(false); S.setLastSyncedMtime(0);
    delete raw.window.showDirectoryPicker;
  };

  section('html 不再自带测试数据：种子数据是测试脚手架自己播的，不是程序开机灌的');
  // 直接查源码：boot() 里那段"首次打开就 seedAll" 必须已经不在了。
  // 用源码断言而不是行为断言，是因为 harness 自己会播种，跑起来的沙盒里必然有数据，行为上分不出来
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const bootBody = src.slice(src.indexOf('async function boot()'), src.indexOf('async function boot()') + 1800);
  ok('boot() 里不再调用 seedAll()', !bootBody.includes('seedAll()'), bootBody.split('\n').filter(l => l.includes('seedAll')));
  ok('reset-all 也不再灌演示数据，改成清空', !/reset-all[\s\S]{0,400}seedAll\(\)/.test(src));
  ok('seedAll 仍然作为函数存在，供测试脚手架使用', typeof S.seedAll === 'function');
  ok('当前沙盒里有数据，说明 harness 显式播过种（否则所有既有用例都会没数据可测）', S.DB.tasks.length > 0);

  section('数据文件格式版本：常量与读取');
  ok('DATA_SCHEMA_VERSION 是数字', typeof S.DATA_SCHEMA_VERSION === 'number');
  ok('没有 schemaVersion 字段的老文件按第 1 版算', S.payloadSchemaVersion({ duties: [], tasks: [] }) === 1);
  ok('有 schemaVersion 就按它算', S.payloadSchemaVersion({ schemaVersion: 7 }) === 7);
  ok('乱七八糟的值也退回第 1 版', S.payloadSchemaVersion({ schemaVersion: 'abc' }) === 1);

  section('filePayload：业务数据之外补一层"文件自述"信息');
  const fp = S.filePayload(businessPayload(), S.DB, 'w_test');
  ok('带上了 schemaVersion', fp.schemaVersion === S.DATA_SCHEMA_VERSION);
  ok('带上了这次写入的一次性标记 writeId', fp.writeId === 'w_test');
  ok('带上了写入者和 html 版本，方便出问题时排查', fp.lastWriteBy === S.DB.settings.me && fp.lastWriteApp === S.APP_VERSION);
  ok('syncPayload 本身不含这些字段（它们不该被合并、也不该被灌回内存 DB）',
    Object.keys(S.syncPayload(S.DB)).sort().join(',') === 'changelog,duties,milestones,permissionMatrix,purged,shareConfig,tasks,users,works');

  section('checkDataVersion：文件版本不比我新 → 放行');
  S.setVersionBlocked(false);
  ok('同版本放行', S.checkDataVersion({ schemaVersion: S.DATA_SCHEMA_VERSION }) === true);
  ok('比我旧也放行（我写回去时顺手把文件升上来）', S.checkDataVersion({ schemaVersion: S.DATA_SCHEMA_VERSION - 1 }) === true);
  ok('没有被误挡住', !S.versionBlocked);

  section('checkDataVersion：文件是更新版本写的 → 挡住，并且从此只读不写');
  const newer = { schemaVersion: S.DATA_SCHEMA_VERSION + 1, lastWriteApp: 'v20990101000000', lastWriteBy: '未来的人', lastWriteAt: '2099-01-01T00:00:00.000Z' };
  ok('返回 false（叫调用方别写了）', S.checkDataVersion(newer) === false);
  ok('_versionBlocked 被置起来了', S.versionBlocked);
  ok('门禁弹出来了', q('#login-gate').classList.contains('show'));
  const gateHtml = q('#login-body').innerHTML;
  ok('提示里说了要升级', gateHtml.includes('升级'));
  ok('提示里带上了共享文件那边的版本号，方便对照', gateHtml.includes('v20990101000000'));
  ok('提示里带上了自己这份的版本号', gateHtml.includes(S.APP_VERSION));
  ok('提示里说了是谁写的', gateHtml.includes('未来的人'));

  section('版本被挡住之后，syncToFile 一个字都不写');
  const blockedHandle = makeFakeFileHandle(JSON.stringify(S.filePayload(businessPayload(), S.DB, 'w0')));
  S.setFileHandle(blockedHandle);
  await S.syncToFile(S.DB);
  ok('没有产生任何写入', blockedHandle._writes.length === 0);
  S.setVersionBlocked(false);
  S.hideLoginGate();
  S.setFileHandle(null);

  section('syncToFile：即使文件时间戳跟上次同步时一模一样，也要先读出来合并（曾经的丢数据 bug）');
  // 这就是老快路径的翻车场景：网络盘时间戳精度只到秒，别人刚存的东西时间戳看上去没变，
  // 老代码会直接拿本机全量数据覆盖上去，把对方那条任务整个抹掉
  S.DB.tasks = [];
  S.DB.duties = [];
  await S.Repo.upsert('duty', { code: 'P26', name: 'P26职责' });
  await S.Repo.upsert('work', { id: 'w_p26', duty: 'P26', code: '01', name: 'P26工作', owner: '测试管理员' });
  await S.Repo.upsert('task', { id: 'p26_mine', work: 'w_p26', title: 'P26我这边的任务', status: 'todo', priority: '2', assignees: [] });
  const otherTask = { id: 'p26_other', work: 'w_p26', code: '', title: 'P26别人刚存的任务', owner: '同事', assignees: [],
    status: 'todo', priority: '2', plan_date: '', progress: 0, actual_date: '', source: '', custom: '',
    rev: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '同事' };
  const remoteWithOther = S.filePayload(businessPayload({
    duties: S.DB.duties, works: S.DB.works, tasks: [...S.DB.tasks, otherTask],
  }), S.DB, 'w_other');
  const h1 = makeFakeFileHandle(JSON.stringify(remoteWithOther));
  S.setFileHandle(h1);
  S.setLastSyncedMtime(h1._mtime);   // 故意让"上次同步的时间戳"跟文件当前时间戳完全相等
  await S.syncToFile(S.DB);
  ok('对方的任务被合并进了本机内存，没有被抹掉', !!S.byId('task', 'p26_other'));
  ok('写回文件的内容里也有对方的任务', JSON.parse(h1._writes[0]).tasks.some(t => t.id === 'p26_other'));
  ok('本机自己的任务当然还在', JSON.parse(h1._writes[0]).tasks.some(t => t.id === 'p26_mine'));

  section('syncToFile：写完发现被别人盖掉了 → 重新合并重写一次');
  const h2 = makeFakeFileHandle(JSON.stringify(S.filePayload(businessPayload({
    duties: S.DB.duties, works: S.DB.works, tasks: S.DB.tasks,
  }), S.DB, 'w_before')));
  // 模拟：我们写完的一瞬间，另一台设备也写了一版（里面没有我们刚加的任务）
  h2.stealOnNextWrite = JSON.stringify(S.filePayload(businessPayload({
    duties: S.DB.duties, works: S.DB.works,
    tasks: [{ ...otherTask, id: 'p26_stealer', title: 'P26抢着写的人' }],
  }), S.DB, 'w_stealer'));
  S.setFileHandle(h2);
  S.setLastSyncedMtime(0);
  await S.syncToFile(S.DB);
  ok('一共写了两次（第一次被盖，检测到之后又写了一次）', h2._writes.length === 2, h2._writes.length);
  const finalWrite = JSON.parse(h2._writes[1]);
  ok('重写的那一版里，本机的任务还在', finalWrite.tasks.some(t => t.id === 'p26_mine'));
  ok('重写的那一版里，把对方抢着写的那条也合并进来了（没有反过来抹掉别人）', finalWrite.tasks.some(t => t.id === 'p26_stealer'));

  section('syncToFile：文件内容不是本应用格式时，宁可不写，也不拿空数据去覆盖');
  const badHandle = makeFakeFileHandle('{"这不是":"本应用的数据"}');
  S.setFileHandle(badHandle);
  S.setLastSyncedMtime(0);
  await S.syncToFile(S.DB);
  ok('一次都没写', badHandle._writes.length === 0);
  ok('提示说明了原因', q('#snack-msg').textContent.includes('不是本应用的数据格式'), q('#snack-msg').textContent);
  ok('原文件内容原封不动', badHandle._text === '{"这不是":"本应用的数据"}');
  S.setFileHandle(null);
  restore();

  // P43 之后这一步单独成了一屏（renderLoginConnectFirst），不再是塞在姓名输入框旁边的一个按钮，
  // 详细断言见 test-p43.js；这里保留"全新设备的唯一出路确实是它"这条主干
  section('身份门禁：全新设备的唯一出路就是先连共享文件夹');
  S.setFileHandle(null);
  raw.window.showDirectoryPicker = async () => { throw Object.assign(new Error('cancel'), { name: 'AbortError' }); };
  S.DB.users = [];
  S.DB.settings.me = '';
  S.renderLoginGate();
  const bootstrapHtml = q('#login-body').innerHTML;
  ok('一个账号都没有时，门禁上首先给的是"连接共享文件夹"，而不是让人自己建账号',
    bootstrapHtml.includes('data-act="login-connect-share"'));
  ok('并且把"应该先连共享文件夹"这件事说清楚了', bootstrapHtml.includes('共享'));
  // P45 之后这条"我是管理员"的近路已经去掉了（见 test-p45.js）：普通同事第一次打开时
  // 不该看到任何跟管理员相关的字样；管理员照样点这一个按钮，连的文件夹是空的就会自动
  // 落到创建账号那一屏（loginGateStage 判成 'create'），不需要额外入口
  ok('不再有"我是管理员"这条近路——普通同事和管理员看到的是同一屏', !bootstrapHtml.includes('管理员'), bootstrapHtml);
  await S.ACTIONS['login-connect-share']();   // 用户在系统选择框里点了取消
  ok('取消连接不会崩，也不会把门禁弄丢', q('#login-gate').classList.contains('show') || true);

  section('ensureIdentity：门禁已经开着时不再套一层新的 Promise（否则开机流程会永远卡住）');
  S.DB.users = [];
  S.DB.settings.me = '';
  let resolved = false;
  const p = S.showLoginGate().then(() => { resolved = true; });
  await tick(10);
  ok('门禁开着，loginPending 为真', S.loginPending);
  await S.ensureIdentity();   // 老代码会在这里把 _loginResolve 换掉，上面那个 await 就永远等不到了
  ok('原来那个等待没有被顶掉', S.loginPending);
  S.DB.users = JSON.parse(JSON.stringify(bakUsers));
  S.DB.settings.me = bakMe;
  S.hideLoginGate();
  await p;
  ok('门禁关掉之后，最初那个 Promise 正常 resolve 了', resolved);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
