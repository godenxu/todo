/* 第三十五轮（P127）：多台电脑 × 真程序 × 同一份共享文件，随机长跑，专盯"删掉的里程碑没留恢复日志就复活"。

   为什么要有这一支：处里报上来"删掉的里程碑过一阵自己回来了"，截图是生产环境的，仓库里是测试数据，对不上号，
   拿不到事故现场。只能反过来——把尽量接近真实办公室的情形随机造几百遍，让程序自己把事故撞出来。

   跟 sim8～sim15 的根本区别：那几支要么只有一个真程序实例、同事用"直接改文件"模拟，要么照着 syncToFileInner
   另抄一份同步逻辑（等于测自己抄得对不对）。这里每台电脑、每个标签页都是一份完整的 index.html（见 multi-app.js），
   各自的内存、各自的本机缓存、各自的时钟，走真实的界面入口：
     任务详情里删行/勾选/改字/改日期/加行/改标题（打开详情时可能恰有一轮同步在路上）、删除任务、恢复任务、
     Ctrl+Z、定时同步、切回标签页拉取、刷新页面（授权失效，第一次点击才恢复，而且跟那次点击并发）、断网、
     同一台电脑开第二个标签页（storage 事件互相顶掉）、被顶掉的标签页点"接管"。
   几台之间真实并发，共享文件的每次读写都带随机延迟，写入竞争会自然发生。

   就地检查（每一次写共享文件都查，不等最后——被复活的记录在后续几十轮里很可能又被别的动作覆盖，只看终态会假绿）：
   ① ★无痕复活：写进去的这份里有里程碑从"已删除"变成"没删"，文件里却找不到删除之后针对它（或它所属任务）的恢复/撤销日志；
      写入链断开的（覆盖了别人的上一版）单独记成"覆盖造成的复活"——那是写入竞争，由被覆盖的那台事后发现并补推
   ② ★恢复任务捎带复活：所属任务是恢复回来的，但这条里程碑早在任务被删之前就单独删掉了
   静止收敛之后（全体上线、关弹窗、恢复授权、一直同步到整整一轮没人再写）：
   ③ ★复活没被纠正：文件里最近一次复活是无痕的，收敛之后仍然活着（写入竞争造成的也算——说明补推没生效）
   ④ ★删除丢了：在界面上删掉并保存成功的里程碑，文件里仍然活着，而且之后没有有日志的恢复
   ⑤ 不收敛：还在用的标签页跟文件对不上（被旧版停写门禁挡住的不算）

   ★ 这一支第一次跑出来的东西，写在这里 ★
   · 同样的长跑拿 git 里最后提交的版本（当时生产上很可能还在跑）对照：每个种子都有"无痕复活且没被纠正"，
     来路绝大多数是 Ctrl+Z（旧版在输入框里打字按 Ctrl+Z 会撤销上一次保存、且不写日志），
     其次是同一台电脑两个标签页互相覆盖、写入竞争后的回滚补推；当前版本不再出现（P121/P124/P126 修过）。
   · 当前版本撞出来的：恢复任务捎带救回单独删掉的里程碑；「恢复任务」先恢复后拍快照（Ctrl+Z 会抹掉恢复日志）；
     两台同时第一次落数据集指纹、各抽一个随机值，一台被永久挡在门外；告警没留时钟容差。见 test-p127。
   · 仿真器自己踩过的坑（都不是产品问题，别再误判）：
     - 新标签页还在 boot（读缓存、设"待授权"）时就在它上面点保存——真实浏览器做不到，要等 booting 结束；
     - 初始文件不带数据集指纹，会先撞出上面那条指纹竞争，把别的问题全淹没（生产文件早就有指纹了），默认带上，NO_DSID=1 可复现；
     - 离线删完紧接着 Ctrl+Z：删除本来就不该留下，撤销后本机又活着的要从"删除意图"里拿掉；
     - 步间隔太短时写入竞争比真实办公室频繁几十倍，会把别的信号淹没，PACE 默认 40ms；
     - 收敛只同步固定两轮不够：最后一轮里某台的补推前面几台看不到，要同步到整整一轮没人再写为止。

   用法：
     ROUNDS=500 SEED=1 node sim/sim16.js
     带上很久没开的电脑（拿旧缓存重新连）：DORMANT=1
     有人还开着旧版本 html（第三台电脑用它）：git show HEAD:index.html > old.html，然后 HTML2=old.html
     整体拿旧版本跑（对照事故版本）：HTML=old.html
     排除 Ctrl+Z：NO_UNDO=1；打印全过程：VERBOSE=1；多列几条发现：SHOW=20 */
const { mkApp, REPO } = require('./multi-app.js');
const HTML = process.env.HTML || REPO + '/index.html';
const HTML2 = process.env.HTML2 || '';          // 给某台电脑用另一个版本（混版本期间）
const ROUNDS = Number(process.env.ROUNDS) || 300;
const SEED = Number(process.env.SEED) || 1;
const NO_UNDO = !!process.env.NO_UNDO;
const VERBOSE = !!process.env.VERBOSE;

let _s = SEED;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = a => a[Math.floor(rnd() * a.length)];
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------------- 共享文件（网盘） ---------------- */
const FNAME = '科技规划处工作管理.json';
const FS = { text: '', mtime: 1000, writes: 0 };
const findings = [];
const trace = [];
let step = 0;
const note = s => { trace.push(`#${step} ${s}`); if (trace.length > 60) trace.shift(); if (VERBOSE) console.log(`#${step} ${s}`); };

function mkHandles(machine, tabRef) {
  const lat = async () => { await tick(ri(0, 6)); };
  const guard = () => {
    if (tabRef.dead) throw new Error('页面已关闭');
    if (machine.offline) throw new Error('网络路径不可用');
  };
  const fileHandle = {
    kind: 'file', name: FNAME,
    async getFile() {
      await lat(); guard();
      const t = FS.text, m = FS.mtime;
      return { lastModified: m, text: async () => { await lat(); return t; } };
    },
    async createWritable() {
      await lat(); guard();
      let buf = '';
      return {
        async write(t) { await lat(); buf += t; },
        async close() { await lat(); guard(); const prev = FS.text; FS.text = buf; FS.mtime += 1000; FS.writes++; onWrite(prev, buf, tabRef); },
      };
    },
    async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; },
  };
  const dirHandle = {
    kind: 'directory', name: '共享',
    async getFileHandle() { await lat(); guard(); return fileHandle; },
    async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; },
  };
  return { fileHandle, dirHandle };
}

/* ---------------- 就地检查：每次写文件 ---------------- */
const revivedLog = [];
const allRevivals = [];   // 每一次文件里的复活（不论有没有日志），带上是否写入竞争；revivedLog 只记有日志的（合法恢复），给"删除丢了"那条判据用
function onWrite(prevText, newText, tab) {
  let P, N;
  try { P = JSON.parse(prevText); N = JSON.parse(newText); } catch (e) { findings.push({ kind: '文件写坏', step, tab: tab.name }); return; }
  const pm = new Map((P.milestones || []).map(m => [m.id, m]));
  const pt = new Map((P.tasks || []).map(t => [t.id, t]));
  const prevLog = new Set((P.changelog || []).map(e => e.id));
  const newLogs = (N.changelog || []).filter(e => e && !prevLog.has(e.id));
  // 这次写是不是基于过期内容：新文件的写入链里没有上一版的 writeId → 写之前没读到上一版（覆盖）
  const clobber = !!P.writeId && !((N.writeIds || []).includes(P.writeId));
  if (clobber) note(`⚠ ${tab.name} 的写入覆盖了 ${P.lastWriteBy} 的上一版`);
  (N.milestones || []).forEach(m => {
    const o = pm.get(m.id);
    if (!o || !o.deleted_at || m.deleted_at) return;
    // 文件里有删除时间之后（留 5 分钟时钟误差）针对它或它所属任务的恢复/撤销日志 → 有来路
    const since = new Date(new Date(o.deleted_at).getTime() - 300000).toISOString();
    const restoreLogs = (N.changelog || []).filter(e => e && (e.at || '') >= since && /恢复|撤销/.test(e.summary || ''));
    const own = restoreLogs.filter(e => e.refId === m.id);
    const parentRestored = restoreLogs.some(e => e.refId === m.task);
    // ★恢复任务捎带复活（P127 抓到的那条）：所属任务是恢复回来的，但这条里程碑早在任务被删之前就单独删掉了
    const pTask = pt.get(m.task);
    if (parentRestored && !own.length && pTask && pTask.deleted_at && o.deleted_at < pTask.deleted_at) {
      findings.push({ kind: '★恢复任务捎带复活', step, ms: m.id, deliverable: m.deliverable, tab: tab.name, action: tab.cur, trace: trace.slice(-25) });
    }
    allRevivals.push({ id: m.id, step, tab: tab.name, clobber, logged: !!(own.length || parentRestored), action: tab.cur });
    if (own.length || parentRestored) { revivedLog.push({ id: m.id, step }); return; }
    findings.push({ kind: clobber ? '覆盖造成的复活' : '★无痕复活', step, ms: m.id, deliverable: m.deliverable, tab: tab.name, action: tab.cur,
      writer: N.lastWriteBy, newLogs: newLogs.map(e => (e.refId || '') + ' ' + (e.summary || '').slice(0, 40)),
      trace: trace.slice(-25) });
  });
}

/* ---------------- 电脑和标签页 ---------------- */
const USERS = ['徐捷', '小王', '老李'].concat(process.env.DORMANT ? ['小张'] : []);
const machines = USERS.map((u, i) => ({ user: u, store: new Map(), skewMs: [0, 70000, -45000, 20000][i], offline: false, tabs: [], dormantUntil: 0,
  html: (HTML2 && i === 2) ? HTML2 : HTML }));
let tabSeq = 0;
function liveTabs(m) { return m.tabs.filter(t => !t.dead); }

async function openTab(machine, fresh) {
  const tabRef = { name: machine.user + '#' + (++tabSeq), machine, dead: false, busy: null, booting: true, modal: null, cur: '', needRestore: false };
  const app = mkApp({
    html: machine.html, store: machine.store, skewMs: machine.skewMs,
    isDead: () => tabRef.dead,
    onSet: (k, v, old) => {
      // 同一台电脑上别的标签页收到 storage 事件（浏览器里是异步派发的）
      liveTabs(machine).forEach(o => { if (o !== tabRef) setTimeout(() => { if (!o.dead) o.raw.window.fire('storage', { key: k, newValue: v, oldValue: old }); }, 0); });
    },
  });
  Object.assign(tabRef, { S: app.sandbox, raw: app.raw, q: app.q, T: app.T }, mkHandles(machine, tabRef));
  machine.tabs.push(tabRef);
  await tick(60);   // 等 boot 跑完读缓存、身份检查（这期间不许在这个标签页上点任何东西）
  const S = tabRef.S;
  // 记下每次保存/同步的结果，排查时看得到
  const origPersist = S.Repo.persist.bind(S.Repo);
  S.Repo.persist = async db => { const w0 = FS.writes; const r = await origPersist(db); note(`  ${tabRef.name} persist→${r} 写文件${FS.writes - w0}次 pending=${!!db.settings.pendingSync} handle=${!!S.fileHandle}${tabRef.dead ? ' (已关闭)' : ''}`); return r; };
  if (fresh) {
    // 第一次连共享文件夹的电脑：本机什么都没有，直接从文件拉
    S.DB.settings.me = machine.user;
    S.DB.users = JSON.parse(FS.text).users;
    ['duties', 'works', 'milestones', 'tasks', 'changelog', 'purged'].forEach(k => { S.DB[k] = []; });
    S.clearSyncBaseline(S.DB);
    S.DB.settings.year = 2026; S.DB.settings.lastBackupAt = new Date().toISOString();
    S.rebuildIndex();
    S.setDirHandle(tabRef.dirHandle); S.setFileHandle(tabRef.fileHandle); S.setEverConnected(true);
    await S.pullFromFile();
    S.saveLocalCache(S.DB);
  } else {
    // 刷新 / 新开标签页：浏览器的读写授权不跨页面，要等用户第一次点击才恢复
    S.setEverConnected(true);
    S.setNeedPermissionRestore(true);
    tabRef.needRestore = true;
  }
  note(`${tabRef.name} 打开（${fresh ? '首次连接' : '读本机缓存，待授权'}）`);
  tabRef.booting = false;
  return tabRef;
}
function closeTab(tab) { tab.dead = true; tab.T.dispose(); note(`${tab.name} 关闭`); }

// 模拟 doRestoreSharePermission（用户第一次点页面时顺势触发，跟那次点击并发）
async function restorePerm(tab) {
  if (!tab.needRestore || tab.dead) return;
  tab.needRestore = false;
  const S = tab.S;
  S.setDirHandle(tab.dirHandle); S.setFileHandle(tab.fileHandle);
  S.setOfflineMode(false); S.setNeedPermissionRestore(false);
  note(`${tab.name} 恢复授权并同步`);
  try { await S.Repo.persist(S.DB); } catch (e) { note(`${tab.name} 恢复同步异常 ${e.message}`); }
}

/* ---------------- 界面动作 ---------------- */
const modalOpen = tab => tab.raw && tab.q('#modal-overlay').classList.contains('show');
const inactive = tab => tab.q('#login-gate').classList.contains('show');
const msSort = (a, b) => (a.plan_date || '9999-99-99').localeCompare(b.plan_date || '9999-99-99');
const deleteIntents = [];

function rowStub(r) {
  return { getAttribute: k => (k === 'data-ms-id' ? r.id : null),
    querySelector: sel => ({ '.cp-date': { value: r.plan_date }, '.cp-deliv': { value: String(r.deliverable || '').replace(/[\r\n]/g, '') },
      '.cp-report-level': { value: r.report_level || 'section' }, '.cp-chk': { checked: r.done === '1' } }[sel]) };
}

async function actOpenDetail(tab) {
  const S = tab.S;
  const tasks = S.DB.tasks.filter(t => !t.deleted_at);
  if (!tasks.length) return;
  const t = pick(tasks);
  let bg = null;
  if (rnd() < 0.35 && S.fileHandle) { bg = S.pullFromFile().catch(() => {}); note(`${tab.name} 打开详情时恰有一轮同步在路上`); }
  S.openTaskDetail(t.id);
  if (!modalOpen(tab)) return;
  const cps = S.DB.milestones.filter(m => m.task === t.id && !m.deleted_at).sort(msSort);
  tab.modal = { taskId: t.id, cb: S.modalCallback, openedAt: step,
    form: clone(t), rows: cps.map(m => ({ id: m.id, plan_date: m.plan_date, deliverable: m.deliverable, report_level: m.report_level, done: m.done === '1' ? '1' : '0' })) };
  note(`${tab.name} 打开任务 ${t.id} 详情（${cps.map(m => m.id).join(',')}）`);
  if (bg) await bg;
}

async function actSaveDetail(tab) {
  const S = tab.S, md = tab.modal;
  tab.modal = null;
  if (!modalOpen(tab) || S.modalCallback !== md.cb) { note(`${tab.name} 弹窗已不在`); return; }
  const rows = md.rows.map(r => Object.assign({}, r));
  const kind = pick(['del', 'del', 'del', 'done', 'done', 'deliv', 'date', 'add', 'none', 'none', 'title']);
  let delId = '';
  const i = rows.length ? ri(0, rows.length - 1) : -1;
  if (kind === 'del' && rows.length > 1) { delId = rows[i].id; rows.splice(i, 1); }
  else if (kind === 'done' && i >= 0) rows[i].done = rows[i].done === '1' ? '0' : '1';
  else if (kind === 'deliv' && i >= 0) rows[i].deliverable = String(rows[i].deliverable).trim() + '·改' + step;
  else if (kind === 'date' && i >= 0) rows[i].plan_date = '2026-1' + ri(0, 1) + '-' + String(ri(10, 28));
  else if (kind === 'add') rows.push({ id: '', plan_date: '2026-12-' + String(ri(10, 28)), deliverable: '新增' + step + tab.name, report_level: 'section', done: '0' });
  const form = Object.assign({}, md.form);
  if (kind === 'title') form.title = String(form.title).trim() + '·' + step;
  S.schema('task').fields.filter(f => !f.virtual).forEach(f => {
    const v = form[f.key];
    tab.q('#td-' + f.key).value = Array.isArray(v) ? v.join(f.type === 'lines' ? '\n' : '、') : String(v == null ? '' : v);
  });
  const stubs = rows.map(rowStub);
  const orig = tab.raw.document.querySelectorAll;
  tab.raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? stubs : []);
  note(`${tab.name} 保存任务 ${md.taskId} 详情：${kind}${delId ? ' 删 ' + delId : ''}`);
  tab.cur = `保存详情 ${md.taskId} ${kind}${delId ? ' 删 ' + delId : ''}`;
  try {
    let cb = S.modalCallback, n = 0;
    while (typeof cb === 'function' && n++ < 4) {
      const p = cb();
      tab.raw.document.querySelectorAll = orig;   // 界面行只在保存回调同步读取那一刻有效
      await p; await tick(5);
      if (!modalOpen(tab) || S.modalCallback === cb) break;
      cb = S.modalCallback;
    }
    if (modalOpen(tab)) S.closeModal();
  } finally { tab.raw.document.querySelectorAll = orig; }
  if (delId) {
    const m = S.byId('milestone', delId);
    if (m && m.deleted_at) deleteIntents.push({ id: delId, step, tab: tab.name, deliverable: m.deliverable });
  }
}

async function actCancelDetail(tab) { tab.modal = null; if (modalOpen(tab)) tab.S.closeModal(); note(`${tab.name} 取消详情`); try { await tab.S.syncCatchUp(); } catch (e) {} }

async function actTimer(tab) {
  const S = tab.S;
  if (!S.fileHandle || S.syncBlocked()) return;
  note(`${tab.name} 定时同步`);
  tab.cur = '定时同步';
  await S.withSyncGate(S.syncNowAndRender);
}
async function actWake(tab) { note(`${tab.name} 切回标签页`); tab.cur = '切回拉取'; await tab.S.pullOnWake(true); }
async function actUndo(tab) {
  const S = tab.S;
  if (NO_UNDO || !S.undoStack.length || modalOpen(tab)) return;
  note(`${tab.name} Ctrl+Z`);
  tab.cur = 'Ctrl+Z';
  await S.undoLast();
  // 撤销掉的删除不再算"用户要删"：本机又活着的，从删除意图里拿掉
  for (let k = deleteIntents.length - 1; k >= 0; k--) {
    const d = deleteIntents[k], m = S.byId('milestone', d.id);
    if (d.tab === tab.name && m && !m.deleted_at) deleteIntents.splice(k, 1);
  }
}
async function actDelTask(tab) {
  const S = tab.S;
  const tasks = S.DB.tasks.filter(t => !t.deleted_at);
  if (tasks.length < 3) return;
  const t = pick(tasks);
  S.ACTIONS['task-del']({ id: t.id });
  if (!modalOpen(tab)) return;
  note(`${tab.name} 删除任务 ${t.id}`);
  tab.cur = '删除任务 ' + t.id;
  await S.modalCallback();
  if (modalOpen(tab)) S.closeModal();
}
async function actRestoreTask(tab) {
  const S = tab.S;
  const tasks = S.DB.tasks.filter(t => t.deleted_at);
  if (!tasks.length) return;
  const t = pick(tasks);
  note(`${tab.name} 恢复任务 ${t.id}`);
  tab.cur = '恢复任务 ' + t.id;
  await S.ACTIONS['task-restore']({ id: t.id });
}
async function actReload(tab) {
  if (modalOpen(tab)) return;
  const m = tab.machine;
  closeTab(tab);
  await openTab(m, false);
}
async function actSecondTab(tab) {
  const m = tab.machine;
  if (liveTabs(m).length >= 2) return;
  await openTab(m, false);
}

async function runAction(tab) {
  if (tab.dead) return;
  // 第一次点击顺势恢复授权（跟这次点击并发）
  let restoring = null;
  if (tab.needRestore && rnd() < 0.85) restoring = restorePerm(tab);
  if (inactive(tab)) {
    note(`${tab.name} 门禁：${String(tab.q('#login-body').innerHTML).replace(/<[^>]+>/g, '').trim().slice(0, 50)} stale=${tab.S.staleAppBlocked}`);
    // 被新标签页顶掉的旧标签页：用户要么关掉，要么点"就在这个标签页继续"（= 重新加载）
    if (rnd() < 0.5) { closeTab(tab); } else { note(`${tab.name} 点了接管`); const m = tab.machine; closeTab(tab); await openTab(m, false); }
    return;
  }
  if (tab.modal) {
    if (step - tab.modal.openedAt < 1) { await tick(3); return; }
    if (rnd() < 0.8) await actSaveDetail(tab); else await actCancelDetail(tab);
  } else {
    const r = rnd();
    if (r < 0.34) await actOpenDetail(tab);
    else if (r < 0.54) await actTimer(tab);
    else if (r < 0.66) await actWake(tab);
    else if (r < 0.72) await actUndo(tab);
    else if (r < 0.76) await actDelTask(tab);
    else if (r < 0.80) await actRestoreTask(tab);
    else if (r < 0.84) await actReload(tab);
    else if (r < 0.86) await actSecondTab(tab);
    else if (r < 0.90) { const m = tab.machine; m.offline = !m.offline; note(`${m.user} ${m.offline ? '断网' : '恢复网络'}`); }
    // 其余：用户在看页面，什么都没点
  }
  if (restoring) await restoring;
  tab.cur = '';
}

/* ---------------- 静止收敛 + 检查 ---------------- */
async function quiesce(label) {
  const all = () => machines.flatMap(liveTabs);
  for (let g = 0; g < 30; g++) {
    await Promise.all(all().map(t => t.busy).filter(Boolean));
    while (all().some(t => t.booting)) await tick(20);
    if (!all().some(t => t.busy || t.booting)) break;
  }
  machines.forEach(m => { m.offline = false; });
  for (const t of all()) { if (t.modal) await actCancelDetail(t); }
  // 被顶掉的旧标签页直接关掉
  all().forEach(t => { if (inactive(t)) closeTab(t); });
  for (const t of all()) await restorePerm(t);
  // 一直同步到整整一轮都没人再写文件为止（最多 6 轮），免得最后一轮里某台的补推没被前面几台看到
  for (let k = 0; k < 6; k++) {
    const w0 = FS.writes;
    for (const t of all()) {
      if (t.dead || inactive(t)) continue;
      try { await t.S.Repo.persist(t.S.DB); } catch (e) { note(`${t.name} 收敛同步异常 ${e.message}`); }
    }
    if (k >= 1 && FS.writes === w0) break;
    if (k === 5) findings.push({ kind: '同步停不下来', step, label, writes: FS.writes - w0 });
  }
  const F = JSON.parse(FS.text);
  const fm = new Map(F.milestones.map(m => [m.id, m]));
  for (const t of all()) {
    if (t.dead || inactive(t) || t.S.staleAppBlocked) continue;   // 旧版被停写的，本来就不跟文件对账
    const bad = t.S.DB.milestones.filter(m => { const f = fm.get(m.id); return f && !!f.deleted_at !== !!m.deleted_at; });
    if (bad.length) findings.push({ kind: '不收敛', step, tab: t.name, ids: bad.map(m => m.id), label });
  }
  // ★复活没被纠正：文件里最近一次"已删→没删"是无痕的（覆盖或别的），静止收敛之后仍然活着
  F.milestones.forEach(m => {
    if (m.deleted_at) return;
    const last = allRevivals.filter(r => r.id === m.id).pop();
    if (!last || last.logged || last.reported) return;
    last.reported = true;
    findings.push({ kind: '★复活没被纠正', step, ms: m.id, deliverable: m.deliverable, revival: last });
  });
  // 删除丢了：删除成功保存过，文件里还活着，而且之后没有有日志的复活
  deleteIntents.splice(0).forEach(d => {
    const owner = machines.flatMap(m => m.tabs).find(t => t.name === d.tab);
    if (owner && owner.S.staleAppBlocked) return;   // 旧版 html 上做的删除，被停写门禁挡住了，界面上有整屏提示
    const f = fm.get(d.id);
    if (!f || f.deleted_at) return;
    if (revivedLog.some(r => r.id === d.id && r.step >= d.step)) return;
    // 所属任务被恢复/撤销连带回来的也算合法
    findings.push({ kind: '★删除丢了', step, ms: d.id, revivals: allRevivals.filter(r => r.id === d.id && r.step >= d.step), deliverable: d.deliverable, deletedBy: d.tab, deletedAt: d.step, trace: trace.slice(-30) });
  });
}

/* ---------------- 初始数据 ---------------- */
async function main() {
  const boot = mkApp({ html: HTML, store: new Map() });
  await tick(60);
  const S = boot.sandbox;
  S.DB.settings.me = '徐捷';
  const U = name => ({ name, role: 'admin', salt: '', hash: '', iterations: 0, rev: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '徐捷' });
  const duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  const works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '处室运转', owner: '徐捷', year: 2026, status: 'doing' }))];
  const tasks = [], milestones = [];
  const DELIVS = ['组织召开处室周例会，并组织形成《处室例会纪要》。', '季度工作总结 ', '年度计划\n', '调研报告', '专题汇报材料', '督办清单'];
  for (let k = 1; k <= 4; k++) {
    tasks.push(S.stampMeta(S.blank('task', { id: 'T' + k, work: 'w1', code: '01011' + k, title: '任务' + k, owner: USERS[k % 3], assignees: [USERS[(k + 1) % 3]],
      status: 'doing', priority: '2', progress: 0, plan_date: '2026-12-31', actual_date: '', source: '', custom: '' })));
    for (let j = 1; j <= 4; j++) {
      milestones.push(S.stampMeta(S.blank('milestone', { id: `M${k}${j}`, task: 'T' + k, plan_date: `2026-0${5 + j}-1${j}`,
        deliverable: DELIVS[(k + j) % DELIVS.length] + (j === 4 ? '' : ''), report_level: 'section', done: j === 1 ? '1' : '0', actual_date: j === 1 ? '2026-06-11' : '' })));
    }
  }
  tasks.forEach(t => { const ms = milestones.filter(m => m.task === t.id); t.progress = Math.round(ms.filter(m => m.done === '1').length / ms.length * 100); });
  FS.text = JSON.stringify({ schemaVersion: S.DATA_SCHEMA_VERSION, datasetId: process.env.NO_DSID ? undefined : 'ds_prod', writeId: 'w0', writeIds: ['w0'], lastWriteApp: S.APP_VERSION, lastWriteBy: '徐捷',
    duties, works, milestones, tasks, changelog: [], users: USERS.map(U), purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
  boot.T.dispose();

  for (const m of machines) await openTab(m, true);
  // 长期不开的电脑：连上之后离线改几下（没推上去），然后关机，到后半程才拿着旧缓存重新打开
  const dm = machines.find(m => m.user === '小张');
  if (dm) {
    const t = dm.tabs[0];
    dm.offline = true;
    for (let k = 0; k < 3; k++) { step = -k; await actOpenDetail(t); if (t.modal) { t.modal.openedAt = -99; await actSaveDetail(t); } }
    dm.offline = false;
    deleteIntents.splice(0);   // 离线时的删除还没推出去，不算"删除丢了"的判据（重新上线后才推）
    closeTab(t);
    dm.dormantUntil = Math.floor(ROUNDS * 0.6);
    note('小张 的电脑关机，要到第 ' + dm.dormantUntil + ' 轮才再打开');
  }

  for (step = 1; step <= ROUNDS; step++) {
    const idle = machines.flatMap(liveTabs).filter(t => !t.busy && !t.booting);
    if (idle.length) {
      const tab = pick(idle);
      tab.busy = runAction(tab).catch(e => { findings.push({ kind: '动作异常', step, tab: tab.name, err: String(e && e.stack || e).slice(0, 400) }); })
        .finally(() => { tab.busy = null; });
    }
    await tick(ri(0, Number(process.env.PACE) || 40));
    if (step % 50 === 0) await quiesce('第' + step + '轮');
    // 保证每台电脑至少有一个标签页
    for (const m of machines) if (!liveTabs(m).length && step >= m.dormantUntil) await openTab(m, false);
  }
  await quiesce('结束');

  const F = JSON.parse(FS.text);
  console.log(`\n版本 ${S.APP_VERSION}  SEED=${SEED} ROUNDS=${ROUNDS}  写文件 ${FS.writes} 次  已删里程碑 ${F.milestones.filter(m => m.deleted_at).length}/${F.milestones.length}  有日志的复活 ${revivedLog.length}`);
  const byKind = {};
  findings.forEach(f => { byKind[f.kind] = (byKind[f.kind] || 0) + 1; });
  console.log('发现：', JSON.stringify(byKind));
  findings.slice(0, Number(process.env.SHOW) || 3).forEach(f => console.log(JSON.stringify(f, null, 1)));
  machines.flatMap(m => m.tabs).forEach(t => { t.dead = true; t.T.dispose(); });
  process.exit(findings.some(f => f.kind.startsWith('★') || f.kind === '不收敛') ? 1 : 0);
}
main().catch(e => { console.error('仿真异常', e); process.exit(2); });
