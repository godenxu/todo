/* P45：同事说"已保存"，管理员却看不到数据更新——排查与修复

   现场：共享文件的时间戳确实更新了（证明有人真的写过文件），但同事编辑的里程碑内容
   没有出现在管理员这边。同事自己屏幕上明明显示"已保存"。

   排查出两个叠加的真问题：
   ① 提示语被自己人盖掉了。Repo.persist 内部如果发现这次实际上没有真正同步出去
      （共享文件同步失败、或者干脆没连上只能记"待同步"），会自己先 showSnack 一句警告；
      但几乎所有编辑动作的写法都是 `await Repo.upsert(...); ...; showSnack('已保存');`——
      persist 内部那句警告一返回，外层紧跟着的"已保存"立刻把它冲掉。同事实际看到的
      永远是"已保存"三个字，根本不知道这次改动其实没有真正推给共享文件，也就不会想到
      去点顶栏那个"恢复共享连接"。
   ② 刷新页面后授权失效是这种情况最常见的成因，而且很难自己发现：授权恢复必须发生在
      一次真实的用户手势里，以前只有"点顶栏红色按钮"和"点页面任意位置的一次性监听"两条路，
      如果同事刷新完页面第一个动作就是打开任务详情改点东西然后点保存，在这之前完全没有
      "随便点别处"的机会，授权就一直没恢复，这次保存也就注定进"待同步"。

   修复：
   ① showSnack 加一个 priority 标记，持久化层的警告用 priority:true 显示，
      占用一段"不许被顶掉"的窗口，窗口内的普通 showSnack 调用直接放弃——不用去改遍布
      全文件的几十处"已保存"调用点，这一处改完，所有调用点自动都对。
   ② Repo.persist 一开始，如果发现没连上但本该连上（_needPermissionRestore），
      就地借着"保存"这个真实的用户手势尝试把授权要回来（ensureFileHandleFresh），
      成功了这次保存就能如实同步出去，失败了也没有任何损失。
   外加一个顺手修的小问题：任务详情保存时，"最近动态"的那条记录（pushLog）以前是在
   Repo.bulk 已经同步完之后才追加的，不会跟着这次保存一起推上去，要等下一次不相关的
   保存才会捎带上——挪到 Repo.bulk 回调里，确保跟任务/里程碑数据同一批持久化。
   用法：node test/test-p45.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

function makeFileHandle(store, opts) {
  const perm = (opts && opts.perm) || 'granted';
  return {
    name: 'shared.json',
    kind: 'file',
    async getFile() { return { text: async () => store.text, lastModified: store.mtime || 1 }; },
    async createWritable() {
      return {
        async write(t) { store.text = t; store.mtime = (store.mtime || 1) + 1; store.writes++; },
        async close() {},
      };
    },
    async requestPermission() { return perm; },
    // ensureFileHandleFresh 走的是"手动恢复授权"那条路（requestPermission），
    // 但它内部接着调用 tryReconnectSharedFile()，那边真正判断"接回来了没有"用的是 queryPermission
    // ——两个方法都得配，少一个就会在 tryReconnectSharedFile 里被 try/catch 悄悄吞掉，看着像没恢复
    async queryPermission() { return perm; },
  };
}

async function main() {
  await tick(60);
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const bakMs = JSON.parse(JSON.stringify(S.DB.milestones));
  const bakLog = JSON.parse(JSON.stringify(S.DB.changelog));
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.DB.milestones = JSON.parse(JSON.stringify(bakMs));
    S.DB.changelog = JSON.parse(JSON.stringify(bakLog));
    S.DB.settings.pendingSync = false;
    S.setFileHandle(null); S.setEverConnected(false); S.setNeedPermissionRestore(false);
    S.setSnackPriorityUntil(0);
    raw.idbGetHandle = undefined;
    S.rebuildIndex();
  };

  section('★①：Repo.persist 的警告不能被外层紧跟着的"已保存"盖掉');
  restore();
  S.setEverConnected(true);
  S.setFileHandle(null);   // 授权失效/没连上，但连过——落进"改动只在本机"这条分支
  const t = S.DB.tasks.find(x => !x.deleted_at);
  await S.Repo.upsert('task', Object.assign({}, t, { title: t.title + '（同事改的）' }));
  S.showSnack('已保存');   // 几乎所有编辑动作最后都是这么调的
  ok('★最终看到的是"改动没同步"的警告，不是"已保存"',
    q('#snack-msg').textContent.includes('还没同步给大家'), q('#snack-msg').textContent);
  ok('内部状态也确实是 pendingSync', S.DB.settings.pendingSync === true);

  section('★①：优先窗口过去之后，后续正常的提示不受影响');
  await tick(1600);   // 超过 1.5 秒的优先窗口
  S.showSnack('这是一条正常提示');
  ok('窗口过了之后，普通提示能正常显示', q('#snack-msg').textContent === '这是一条正常提示');

  section('★①：真的同步成功时，"已保存"不该被误伤');
  restore();
  const store = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeFileHandle(store));
  S.setEverConnected(true);
  await S.Repo.persist(S.DB);
  S.showSnack('已保存');
  ok('同步顺利时，"已保存"正常显示，没有被不存在的警告顶掉', q('#snack-msg').textContent === '已保存');

  section('★②：保存本身是一次真实的用户手势，要顺手用它把授权要回来');
  restore();
  S.setEverConnected(true);
  S.setNeedPermissionRestore(true);   // 句柄还在，只是授权失效了（刷新页面后最常见的状态）
  const store2 = { text: '', mtime: 1, writes: 0 };
  const handle2 = makeFileHandle(store2);
  raw.idbGetHandle = async () => handle2;
  // 还没保存之前，_fileHandle 确实是 null
  ok('保存前 fileHandle 是空的', !S.fileHandle);
  await S.ensureFileHandleFresh();
  ok('★这次保存的用户手势成功把授权要回来了，fileHandle 恢复了', !!S.fileHandle);
  ok('needPermissionRestore 标记也清掉了', S.needPermissionRestore === false);

  section('★②：授权确实要不回来时，不影响正常走"待同步"这条路，也不报错');
  restore();
  S.setEverConnected(true);
  S.setNeedPermissionRestore(true);
  const handle3 = makeFileHandle({ text: '', mtime: 1, writes: 0 }, { perm: 'denied' });
  raw.idbGetHandle = async () => handle3;
  let threw = false;
  try { await S.ensureFileHandleFresh(); } catch (e) { threw = true; }
  ok('不抛异常', threw === false);
  ok('要不到授权时，fileHandle 仍然是空的', !S.fileHandle);
  ok('needPermissionRestore 保持原状，下次还能再试', S.needPermissionRestore === true);

  section('★②：跟 armPermissionAutoRestore 共用同一把锁，不会同时各发一次请求');
  restore();
  S.setEverConnected(true);
  S.setNeedPermissionRestore(true);
  let calls = 0;
  const slowHandle = {
    name: 'x',
    async getFile() { return { text: async () => '', lastModified: 1 }; },
    async createWritable() { return { async write() {}, async close() {} }; },
    async requestPermission() { calls++; await tick(20); return 'granted'; },
    async queryPermission() { return 'granted'; },
  };
  raw.idbGetHandle = async () => slowHandle;
  const p1 = S.ensureFileHandleFresh();
  const p2 = S.ensureFileHandleFresh();   // 几乎同时又来一次（比如同一次点击触发了两条路径）
  await Promise.all([p1, p2]);
  ok('★同一时刻两次调用，只真正请求了一次授权（另一次看到锁被占用就直接放弃）', calls === 1, calls);

  section('★顺手修：任务详情保存时，「最近动态」要跟数据同一批推上去，不能等下一次保存才捎带');
  restore();
  const store3 = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeFileHandle(store3));
  S.setEverConnected(true);
  const dutyCode = 'P45D'; await S.Repo.upsert('duty', { code: dutyCode, name: 'P45测试职责' });
  const wid = 'p45_w'; await S.Repo.upsert('work', { id: wid, duty: dutyCode, name: 'P45测试工作', owner: '测试管理员' });
  const tid = 'p45_task';
  await S.Repo.upsert('task', { id: tid, work: wid, title: 'P45任务', status: 'doing', plan_date: S.offsetDate(30), owner: '测试管理员', assignees: [] });
  const writesBefore = store3.writes;
  S.openTaskDetail(tid);
  q('#td-title').value = 'P45任务（改过标题）';
  q('#td-owner').value = '测试管理员';
  raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? [] : []);
  await S.ACTIONS['modal-ok']();
  ok('保存确实推了一次共享文件', store3.writes > writesBefore);
  // 把"刚写进共享文件里的那份内容"解析出来，检查这次写入的 payload 本身有没有带上这条动态——
  // 而不是只看内存里的 DB.changelog（那个当然有，问题是有没有跟着这次写入一起出去）
  const written = JSON.parse(store3.text);
  ok('★这次写进共享文件的内容里，已经包含了这条"最近动态"记录，不用等下一次保存',
    written.changelog.some(e => e.taskId === tid && (e.summary || '').includes('P45任务（改过标题）')),
    written.changelog.filter(e => e.taskId === tid));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
