/* P29：本轮改动测试——
   1) 管理员定期自动备份：间隔/目标文件夹可配，配置只存本机（DB.settings，不进共享文件）
   2) 任务页"新建任务"从速记输入框改成按钮 + 任务详情弹窗；所属职责/所属工作两级联动
   3) 顺带修掉一个真 bug：created_at 存的是 UTC，却拿来跟本地日期比，差一天（localDay）
   用法：node test/test-p29.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// 假备份文件夹：记下写进去的文件名和内容
function makeBackupDir(name) {
  const files = [];
  return {
    name, kind: 'directory', _files: files, _perm: 'granted',
    async queryPermission() { return this._perm; },
    async requestPermission() { this._perm = 'granted'; return 'granted'; },
    async getFileHandle(fileName) {
      const rec = { name: fileName, text: '' };
      files.push(rec);
      return { name: fileName, async createWritable() { return { async write(t) { rec.text = t; }, async close() {} }; } };
    },
  };
}
function installFakeIDB(getStore) {
  raw.indexedDB = { open() {
    const req = {};
    const db = { createObjectStore() {}, transaction: () => ({
      objectStore: () => ({
        get(k) { const r = {}; setTimeout(() => { r.result = getStore()[k]; r.onsuccess && r.onsuccess(); }, 0); return r; },
        put(v, k) { getStore()[k] = v; },
        delete(k) { delete getStore()[k]; },
      }),
      set oncomplete(fn) { setTimeout(() => fn && fn(), 0); },
    }) };
    setTimeout(() => { req.result = db; req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess && req.onsuccess(); }, 0);
    return req;
  } };
}

async function main() {
  await tick(60);
  const bakSettings = JSON.parse(JSON.stringify(S.DB.settings));
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const bakShareConfig = S.DB.shareConfig ? JSON.parse(JSON.stringify(S.DB.shareConfig)) : S.DB.shareConfig;
  const restore = () => {
    Object.assign(S.DB.settings, JSON.parse(JSON.stringify(bakSettings)));
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.DB.shareConfig = bakShareConfig ? JSON.parse(JSON.stringify(bakShareConfig)) : bakShareConfig;
    S.rebuildIndex();
    delete raw.indexedDB; delete raw.window.showDirectoryPicker;
  };

  section('localDay：UTC 时间戳换算成本地日期（曾经拿 UTC 那一天直接跟本地日期比，差一天）');
  const noonToday = new Date(new Date().setHours(12, 0, 0, 0)).toISOString();
  ok('今天本地正午的时间戳，换算回来就是今天', S.localDay(noonToday) === S.todayStr(), [S.localDay(noonToday), S.todayStr()]);
  const lateToday = new Date(new Date().setHours(23, 30, 0, 0)).toISOString();
  ok('今天深夜 23:30 也还是今天（UTC 那边可能已经是明天了）', S.localDay(lateToday) === S.todayStr(), S.localDay(lateToday));
  const earlyToday = new Date(new Date().setHours(0, 30, 0, 0)).toISOString();
  ok('今天凌晨 0:30 也还是今天（UTC 那边可能还是昨天）', S.localDay(earlyToday) === S.todayStr(), S.localDay(earlyToday));
  ok('空值不炸', S.localDay('') === '' && S.localDay(null) === '');

  section('★ 待办总量：今天刚建的任务必须算进今天这个点（就是上面那个差一天导致的漏算）');
  const t = S.blank('task', { title: 'P29刚建的任务', status: 'todo', priority: '2' });
  t.created_at = lateToday;   // 本地今天深夜创建
  S.DB.tasks.push(t);
  S.rebuildIndex();
  const tasksNow = S.visibleTasks().filter(x => !x.deleted_at);
  ok('backlogAsOf(今天) 跟"未完成任务数"对得上',
    S.backlogAsOf(tasksNow, S.todayStr()) === tasksNow.filter(S.isOpen).length,
    [S.backlogAsOf(tasksNow, S.todayStr()), tasksNow.filter(S.isOpen).length]);
  restore();

  section('任务页：速记输入框换成"+ 新建任务"按钮（跟工作页那个同款）');
  S.setPage('tasks');
  S.renderToolbar();
  const tb = q('#toolbar').innerHTML;
  ok('工具栏里有"+ 新建任务"按钮', tb.includes('data-act="task-new"') && tb.includes('新建任务'));
  ok('按钮样式跟工作页的"+ 新建工作"一致（btn primary）', /class="btn primary" data-act="task-new"/.test(tb));
  ok('速记输入框已经没有了', !tb.includes('quick-input'));
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  ok('连样式和解析函数一起清干净了，没留死代码', !src.includes('quick-input') && !src.includes('parseQuickInput'));

  section('worksOfDuty / workOptionsHTML：所属工作的选项按所属职责过滤');
  const anyWork = S.visibleWorks().find(w => w.duty);
  const sameDuty = S.worksOfDuty(anyWork.duty);
  ok('列出来的都属于这个职责', sameDuty.length > 0 && sameDuty.every(w => w.duty === anyWork.duty));
  ok('别的职责下的工作不会混进来', !sameDuty.some(w => w.duty !== anyWork.duty));
  const html = S.workOptionsHTML(anyWork.duty, anyWork.id);
  ok('生成的 option 里有这项工作', html.includes(`value="${anyWork.id}"`));
  ok('当前这项被 selected 标住', new RegExp(`value="${anyWork.id}" selected`).test(html));
  ok('给了"（未归属）"这个选项', html.includes('（未归属）'));
  ok('职责下一项工作都没有时给出明确提示', S.workOptionsHTML('这个职责不存在', '').includes('还没有工作'));

  section('★ 新建任务：点按钮直接开详情弹窗，字段填全了再创建');
  S.DB.settings.me = '测试管理员';
  const nBefore = S.DB.tasks.length;
  S.ACTIONS['task-new']();
  ok('弹窗标题是"新建任务"而不是"任务详情"', q('#modal-title').textContent === '新建任务', q('#modal-title').textContent);
  const body = q('#modal-body').innerHTML;
  ok('所属职责是个下拉框', body.includes('id="td-duty"'));
  ok('所属工作也是个下拉框', body.includes('id="td-work"'));
  ok('标题、状态、优先级、计划完成时间这些字段都在', body.includes('id="td-title"') && body.includes('id="td-status"')
    && body.includes('id="td-priority"') && body.includes('id="td-plan_date"'));
  ok('里程碑区也在（建的时候就能顺手填）', body.includes('id="cp-list"'));
  ok('这时候还没往库里加东西（点了"创建"才落库）', S.DB.tasks.length === nBefore);

  // 填好字段再点"创建"
  q('#td-title').value = 'P29用弹窗新建的任务';
  q('#td-work').value = anyWork.id;
  q('#td-status').value = 'todo';
  q('#td-priority').value = '1';
  q('#td-plan_date').value = S.offsetDate(7);
  await S.modalCallback();
  const created = S.DB.tasks.find(x => x.title === 'P29用弹窗新建的任务');
  ok('任务真的建出来了', !!created);
  ok('落在了选中的那项工作下', created && created.work === anyWork.id);
  ok('优先级、计划完成时间都存下来了', created && created.priority === '1' && created.plan_date === S.offsetDate(7));
  ok('任务编号按所属工作自动生成了', created && !!created.code, created && created.code);
  ok('索引也建好了，byId 查得到', !!S.byId('task', created.id));

  section('新建任务：标题空着不让建');
  const n2 = S.DB.tasks.length;
  S.ACTIONS['task-new']();
  q('#td-title').value = '   ';
  await S.modalCallback();
  ok('没有新增任务', S.DB.tasks.length === n2);
  ok('提示说了标题不能为空', q('#snack-msg').textContent.includes('标题不能为空'), q('#snack-msg').textContent);
  S.ACTIONS['modal-cancel']();
  restore();

  section('定期备份：开关/间隔存在 DB.shareConfig 里，随共享文件同步；备份文件夹句柄留在本机 settings');
  S.DB.shareConfig = null;
  ok('默认是关的', S.backupCfg().enabled === false);
  ok('默认间隔 24 小时', S.backupCfg().hours === 24);
  ok('间隔有下限，填 0 也会被抬到最小值', (() => {
    S.updateShareConfig({ autoBackupHours: 0 });
    return S.backupCfg().hours >= S.BACKUP_MIN_HOURS;
  })());
  ok('开关/间隔确实在同步 payload 里（这样换台电脑、换个管理员看到的是同一份设置）',
    'shareConfig' in S.syncPayload(S.DB) && 'autoBackupEnabled' in S.syncPayload(S.DB).shareConfig);
  ok('目标文件夹这项没法跨设备用，不在同步 payload 里（settings 整个不同步）',
    !('settings' in S.syncPayload(S.DB)));

  section('backupDue：到点了才备份');
  S.updateShareConfig({ autoBackupEnabled: false, autoBackupHours: 24 });
  S.DB.settings.autoBackupAt = '';
  ok('没开启时永远不备份', S.backupDue() === false);
  S.updateShareConfig({ autoBackupEnabled: true });
  ok('开启了但从没备过 → 该备份', S.backupDue() === true);
  S.DB.settings.autoBackupAt = new Date().toISOString();
  ok('刚备过 → 不用再备', S.backupDue() === false);
  S.DB.settings.autoBackupAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  ok('距上次超过间隔 → 又该备了', S.backupDue() === true);
  S.DB.settings.autoBackupAt = new Date(Date.now() - 23 * 3600 * 1000).toISOString();
  ok('还没到间隔 → 先不备', S.backupDue() === false);

  section('★ runBackup：把当前全部数据另存一份到指定文件夹');
  const store = {};
  installFakeIDB(() => store);
  const dir = makeBackupDir('我的备份文件夹');
  await S.idbSetBackupDir(dir);
  S.DB.settings.me = '测试管理员';
  S.DB.settings.autoBackupAt = '';
  const okRun = await S.runBackup(true);
  ok('备份成功', okRun === true);
  ok('往文件夹里写了一个文件', dir._files.length === 1, dir._files.length);
  ok('文件名带时间戳、是 json', /^工作管理备份_\d+\.json$/.test(dir._files[0].name), dir._files[0].name);
  const dumped = JSON.parse(dir._files[0].text);
  ok('备份内容是完整数据（职责/工作/任务/账号都在）',
    Array.isArray(dumped.duties) && Array.isArray(dumped.works) && Array.isArray(dumped.tasks) && Array.isArray(dumped.users));
  ok('备份完记下了时间', !!S.DB.settings.autoBackupAt);
  ok('也顺手消掉了"很久没备份"的提醒', S.DB.settings.lastBackupAt === S.DB.settings.autoBackupAt);

  section('runBackup：只有管理员能做，普通员工不行');
  S.DB.users.push({ name: 'P29员工', role: 'staff' });
  S.DB.settings.me = 'P29员工';
  const before = dir._files.length;
  ok('员工调用直接被拒', (await S.runBackup(true)) === false);
  ok('一个字都没写', dir._files.length === before);
  S.DB.settings.me = '测试管理员';

  section('runBackup：授权失效时，自动备份悄悄跳过，手动备份才去要授权');
  dir._perm = 'prompt';
  const n3 = dir._files.length;
  ok('自动触发时不写（没有用户手势，要不了授权）', (await S.runBackup(false)) === false);
  ok('确实没写', dir._files.length === n3);
  ok('手动触发会重新要授权并写成功', (await S.runBackup(true)) === true);
  ok('这次写进去了', dir._files.length === n3 + 1);

  section('maybeAutoBackup：没到点就什么都不做');
  S.updateShareConfig({ autoBackupEnabled: true });
  S.DB.settings.autoBackupAt = new Date().toISOString();
  const n4 = dir._files.length;
  await S.maybeAutoBackup();
  ok('刚备过，这次不重复备', dir._files.length === n4);
  S.DB.settings.autoBackupAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  await S.maybeAutoBackup();
  ok('隔了两天，自动补了一份', dir._files.length === n4 + 1);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
