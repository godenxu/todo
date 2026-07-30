/* P25：本轮改动测试——权限管理架构整改（防止本机自建管理员/测试数据混入共享文件）
   1) BOOTSTRAP_ADMINS 名单：系统里一个账号都没有时，只有名单里的人能创建第一个（管理员）账号
   2) hasEverConnectedShare()：查询这台设备是否连过共享文件夹，出错时优雅降级为"没连过"
   3) 顶栏"测试数据"徽章：没连上共享文件夹、还看着演示数据时显著标出来
   4) isValidShareData()：连接时校验共享文件内容像不像本应用的数据格式，防止选错文件夹
   5) connectSharedFile()：这台设备第一次真正连上共享文件夹时，本机演示数据/自建账号直接被共享文件内容
      取代（不合并），避免污染大家的真实数据；第二次及以后的连接仍然走正常的合并逻辑
   6) ACTIONS['reset-all']：已连接共享文件夹时拒绝重置为演示数据
   用法：node test/test-p25.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// 内存版 IndexedDB 假实现，只覆盖 idbOpen/idbGetHandle/idbSetHandle/idbClearHandle 用到的这几个接口
function makeFakeIndexedDB() {
  const store = new Map();
  function makeTx() {
    const tx = { onerror: null };
    tx.objectStore = () => ({
      get(key) {
        const req = {};
        setTimeout(() => { req.result = store.get(key); if (req.onsuccess) req.onsuccess(); }, 0);
        return req;
      },
      put(val, key) { store.set(key, val); },
      delete(key) { store.delete(key); },
    });
    let _oncomplete = null;
    Object.defineProperty(tx, 'oncomplete', {
      get() { return _oncomplete; },
      set(fn) { _oncomplete = fn; setTimeout(() => fn && fn(), 0); },
    });
    return tx;
  }
  return {
    open() {
      const req = {};
      const db = { transaction: () => makeTx(), createObjectStore() {} };
      setTimeout(() => { req.result = db; if (req.onupgradeneeded) req.onupgradeneeded(); if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
  };
}
// 假的文件夹句柄：requestPermission 直接给权限，getFileHandle 返回一个假文件句柄（能读也能"写"，
// 配合 Repo.persist 内部会顺带调一次 syncToFile 的既有行为，否则连接这一步会在写入阶段报错）
function makeFakeDirHandle(name, getContent) {
  return {
    name,
    async requestPermission() { return 'granted'; },
    async getFileHandle(fileName) {
      return {
        name: fileName,
        async getFile() { return { text: async () => getContent(), lastModified: Date.now() }; },
        async createWritable() { return { async write() {}, async close() {} }; },
      };
    },
  };
}

async function main() {
  await tick(60);
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const bakDuties = JSON.parse(JSON.stringify(S.DB.duties));
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.DB.duties = JSON.parse(JSON.stringify(bakDuties));
    S.DB.settings.me = bakMe;
    S.setFileHandle(null); S.setOfflineMode(false);
    delete raw.window.showDirectoryPicker; delete raw.indexedDB;
    if (S.loginPending) S.hideLoginGate();
  };

  section('测试环境本身不支持文件系统访问（跟真实 Firefox 一样），新流程天然不介入，老测试套件不受影响');
  ok('沙盒 window 里没有 showDirectoryPicker', !('showDirectoryPicker' in raw.window));

  section('BOOTSTRAP_ADMINS 名单存在，且包含徐捷');
  ok('BOOTSTRAP_ADMINS 是个数组', Array.isArray(S.BOOTSTRAP_ADMINS));
  ok('名单里有徐捷', S.BOOTSTRAP_ADMINS.includes('徐捷'));

  section('hasEverConnectedShare()：测试环境没有 indexedDB，应该优雅降级返回 false 而不是抛异常');
  let threw = false, everConnected;
  try { everConnected = await S.hasEverConnectedShare(); } catch (e) { threw = true; }
  ok('不抛异常', !threw);
  ok('返回 false（没连过）', everConnected === false);

  section('login-create：系统里一个账号都没有时（真·bootstrap），名字不在 BOOTSTRAP_ADMINS 里会被拒绝');
  S.DB.users = [];
  S.DB.settings.me = '';
  q('#login-new-name').value = '不认识的人';
  q('#login-new-pin').value = '123456';
  q('#login-new-pin2').value = '123456';
  await S.ACTIONS['login-create']();
  ok('账号没有被创建', !S.DB.users.some(u => u.name === '不认识的人'));
  ok('提示里说明了不在管理员名单里', q('#login-body').innerHTML.includes('管理员名单'), q('#login-body').innerHTML);

  section('login-create：真·bootstrap 场景下，名字在 BOOTSTRAP_ADMINS 里就能正常创建为管理员');
  q('#login-new-name').value = '徐捷';
  q('#login-new-pin').value = '123456';
  q('#login-new-pin2').value = '123456';
  await S.ACTIONS['login-create']();
  const xujie = S.DB.users.find(u => u.name === '徐捷');
  ok('徐捷创建成功', !!xujie);
  ok('自动成为管理员', xujie && xujie.role === 'admin', xujie && xujie.role);

  section('login-create：只要系统里还有别的账号（哪怕没有管理员），就不算真·bootstrap，不受名单限制');
  S.DB.users = S.DB.users.filter(u => u.role !== 'admin');   // 模拟"管理员被删没了，但员工账号还在"
  S.DB.users.push({ name: '还在的员工', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '';
  q('#login-new-name').value = '不在名单里的人';
  q('#login-new-pin').value = '123456';
  q('#login-new-pin2').value = '123456';
  await S.ACTIONS['login-create']();
  const selfHeal = S.DB.users.find(u => u.name === '不在名单里的人');
  ok('不受 BOOTSTRAP_ADMINS 限制，正常创建（自愈路径不受影响）', !!selfHeal);
  ok('因为当时没有管理员，自动成为管理员', selfHeal && selfHeal.role === 'admin', selfHeal && selfHeal.role);
  restore();

  section('isValidShareData()：校验共享文件内容像不像本应用的数据格式');
  ok('duties/tasks 都是数组 → 合法', S.isValidShareData({ duties: [], tasks: [], works: [], users: [] }));
  ok('null → 不合法', !S.isValidShareData(null));
  ok('数组本身（比如不小心选到别的列表型 json）→ 不合法', !S.isValidShareData([1, 2, 3]));
  ok('缺 tasks 字段的普通对象 → 不合法', !S.isValidShareData({ duties: [] }));
  ok('duties 不是数组（字段名凑巧对上但类型不对）→ 不合法', !S.isValidShareData({ duties: 'x', tasks: [] }));

  section('顶栏"测试数据"徽章：没连上共享文件夹、当前还是演示数据时才显示');
  S.setFileHandle(null);
  ok('种子数据里确实有测试任务，可以拿来测这个徽章', S.DB.tasks.some(t => t.custom === '测试'));
  S.renderShell();
  ok('未连接 + 有测试任务 → 显示徽章', q('#demo-data-badge').innerHTML.includes('测试数据'));
  S.setFileHandle({ fake: true });
  S.renderShell();
  ok('已连接时不显示（哪怕本地还有测试任务残留）', !q('#demo-data-badge').innerHTML.includes('测试数据'));
  S.setFileHandle(null);
  const bak2 = JSON.parse(JSON.stringify(S.DB.tasks));
  S.DB.tasks = S.DB.tasks.filter(t => t.custom !== '测试');
  S.renderShell();
  ok('未连接但没有测试任务了 → 不显示', !q('#demo-data-badge').innerHTML.includes('测试数据'));
  S.DB.tasks = bak2;

  section('connectSharedFile()：文件内容不合法（选错文件夹）时，连接失败，不采信、不记为"连过"');
  raw.indexedDB = makeFakeIndexedDB();
  raw.window.showDirectoryPicker = async () => makeFakeDirHandle('别的文件夹', () => '{"这不是":"本应用的数据格式"}');
  await S.connectSharedFile();
  ok('没有设置 _fileHandle', !S.fileHandle);
  ok('提示说明了原因', q('#snack-msg').textContent.includes('不是本应用的数据格式'), q('#snack-msg').textContent);
  ok('没有被记为"连过"（下次还是当全新设备处理）', !(await S.hasEverConnectedShare()));

  section('connectSharedFile()：第一次真正连接成功——本机演示数据/自建账号被共享文件内容取代，不是合并');
  S.DB.tasks.push({ ...S.DB.tasks[0], id: 'p25_local_demo_task', custom: '测试', title: 'P25本机演示任务' });
  S.DB.users = [{ name: '本机自建管理员', role: 'admin', salt: '', hash: '', iterations: 0 }];
  S.DB.settings.me = '本机自建管理员';
  const remotePayload = { duties: [{ code: 'P25R', name: 'P25远端职责' }], works: [], milestones: [],
    tasks: [{ id: 'p25_remote_task', work: '', title: 'P25远端任务', status: 'todo', priority: '2', assignees: [] }],
    changelog: [], users: [{ name: '真实徐捷', role: 'admin', salt: '', hash: '', iterations: 0 }],
    permissionMatrix: null, shareConfig: null };
  raw.window.showDirectoryPicker = async () => makeFakeDirHandle('真共享文件夹', () => JSON.stringify(remotePayload));
  const connectPromise = S.connectSharedFile();
  // 假 IndexedDB 是好几层链式 setTimeout(...,0) 模拟出来的异步，比真实浏览器慢一些，多等一会儿再看门禁状态
  await tick(300);
  ok('本机身份（本机自建管理员）不在新用户名单里，被清空，重新弹出登录门禁', S.loginPending);
  S.hideLoginGate();   // 模拟这台设备接下来用共享文件里的真实账号重新登录
  await connectPromise;
  ok('连接成功', !!S.fileHandle);
  ok('本机演示任务被替换掉了，不是保留合并', !S.DB.tasks.some(t => t.id === 'p25_local_demo_task'));
  ok('远端任务采用了', S.DB.tasks.some(t => t.id === 'p25_remote_task'));
  ok('远端职责采用了', S.DB.duties.some(d => d.code === 'P25R'));
  ok('本机自建的管理员账号被替换掉了', !S.DB.users.some(u => u.name === '本机自建管理员'));
  ok('远端的真实账号采用了', S.DB.users.some(u => u.name === '真实徐捷'));
  ok('这下真的记为"连过"了', await S.hasEverConnectedShare());

  section('connectSharedFile()：不是这台设备第一次连接了，走正常合并逻辑，本机改动不会被覆盖丢弃');
  S.DB.settings.me = '真实徐捷';   // 用远端已存在的身份，避免又触发身份重置
  S.DB.tasks.push({ ...S.DB.tasks[0], id: 'p25_local_after_connect', title: 'P25连接后本机新增', custom: '' });
  const remotePayload2 = { ...remotePayload, tasks: [...remotePayload.tasks,
    { id: 'p25_remote_second_task', work: '', title: 'P25第二次远端新增', status: 'todo', priority: '2', assignees: [] }] };
  raw.window.showDirectoryPicker = async () => makeFakeDirHandle('真共享文件夹', () => JSON.stringify(remotePayload2));
  await S.connectSharedFile();
  ok('本机在连接后新增的任务被保留下来（合并而不是整体覆盖）', S.DB.tasks.some(t => t.id === 'p25_local_after_connect'));
  ok('远端这次新增的任务也合并进来了', S.DB.tasks.some(t => t.id === 'p25_remote_second_task'));

  section('ACTIONS["reset-all"]：已连接共享文件夹时拒绝清空数据');
  S.DB.settings.me = '测试管理员';
  S.DB.users.push({ name: '测试管理员', role: 'admin', salt: '', hash: '', iterations: 0 });
  S.setFileHandle({ fake: true });
  const dutiesBefore = S.DB.duties.length;
  S.ACTIONS['reset-all']();
  ok('数据没有被清空（职责数量不变）', S.DB.duties.length === dutiesBefore);
  ok('提示说明了原因', q('#snack-msg').textContent.includes('已连接共享文件夹'), q('#snack-msg').textContent);
  S.setFileHandle(null);
  S.ACTIONS['reset-all']();
  ok('没有连接共享文件夹时，管理员仍然能正常触发清空确认弹窗', typeof S.modalCallback === 'function');
  if (typeof S.modalCallback === 'function') await S.modalCallback();
  ok('确认之后是清空成空系统，而不是灌一批演示数据进来', S.DB.duties.length === 0 && S.DB.tasks.length === 0,
    [S.DB.duties.length, S.DB.tasks.length]);
  ok('账号不受影响（清的是业务数据，不是人）', S.DB.users.length > 0);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
