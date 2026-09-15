/* P124：第三十二轮排查——键盘和中文输入法

   实测复现过，修复前的版本会红。

   ① ★在输入框里打字时按 Ctrl+Z：全局快捷键不管焦点在哪都做"撤销上一次数据操作"——
      本想撤销刚打错的几个字，结果把上一次保存的改动撤掉了，而且撤销还会顺手关掉弹窗，正在填的内容一起丢。
      现在焦点在输入框/文本框/下拉框里时，Ctrl+Z 交还给浏览器撤销文字
   ② ★中文输入法组词时按回车/Esc（回车是上屏、Esc 是取消候选词）：
      · 单元格编辑框：组词时回车直接保存，半截拼音字母被存成了内容；
      · 人员/标签下拉里的输入框：组词时回车，半截拼音被当成一个新人名加进去；
      · 全局 Esc：想取消候选词，整个任务详情弹窗被关掉，填了一半的内容全丢。
      这套系统的使用者全都用中文输入法。现在组词中的按键一律交给输入法（isComposing / keyCode 229）
   ③ 上一轮的更正里暴露的缺口："9999-12-31" 这种格式合法但年份离谱的日期，甘特图不画、体检也不列，
      在哪都看不见。现在数据体检一并列出（早于 2000 年或比今年晚 10 年以上），只列不改；生产数据里没有这类日期

   另外修了一个偶发失败的老测试（test-p57）：前面几次编排保存没有被真正等完，
   本机没连共享文件夹时保存完会弹"改动只存在本机"的优先提示（20 秒节流），全量回归跑得慢、跨过 20 秒时
   这条提示恰好压住了断言要看的"为了防止误操作"——只在全量跑时偶发，单独跑永远是绿的。
   测试脚手架顺带补上了 document 级监听器的记录（原来是空实现，全局快捷键测不到）。

   用法：node test/test-p124.js */
const { sandbox: S, raw, q } = require('./harness.js');
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));
const LATER = () => new Date(Date.now() + 60000).toISOString();

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
let FILE = null;
const handle = { name: 'shared.json', _mtime: 1,
  async getFile() { const s = FILE; return { lastModified: handle._mtime, text: async () => s }; },
  async createWritable() { return { async write(t) { handle._p = t; },
    async close() { FILE = handle._p; handle._mtime++; } }; } };

const USER = (name, role) => ({ name, role, salt: 's', hash: 'h', iterations: 1, rev: 1,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' });
const OLD = new Date(Date.now() - 200 * 86400000).toISOString();

function world(opt) {
  const o = opt || {};
  S.closeModal();
  S.DB.settings.me = '管理员';
  S.DB.users = [USER('管理员', 'admin'), USER('小王', 'staff')].concat(o.users || []);
  S.DB.permissionMatrix = null;
  S.DB.duties = [
    S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' })),
    S.stampMeta(S.blank('duty', { code: '02', category: '一、前瞻研判', name: '职责二' })),
  ];
  S.DB.works = [
    S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一', owner: '管理员', year: 2026, status: 'doing' })),
    S.stampMeta(S.blank('work', { id: 'w2', code: '0102', duty: '01', name: '工作二', owner: '管理员', year: 2026, status: 'doing' })),
  ];
  const T = (id, extra) => S.stampMeta(S.blank('task', Object.assign({ id, work: 'w1', code: '01012' + id, title: '任务' + id,
    owner: '管理员', assignees: [], status: 'doing', priority: '2', progress: 0,
    plan_date: '2026-12-31', actual_date: '', source: '', custom: '' }, extra)));
  S.DB.tasks = [T('T1'), T('T2')].concat((o.tasks || []).map(x => T(x.id, x)));
  S.DB.milestones = [S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', plan_date: '2026-09-20',
    deliverable: '调研报告', report_level: 'section', done: '0' }))].concat(o.milestones || []);
  S.DB.changelog = []; S.DB.purged = [];
  S.DB.settings.year = 2026; S.DB.settings.pendingSync = false; S.DB.settings.maxSeenAppVersion = '';
  S.DB.settings.lastBackupAt = new Date().toISOString();
  S.clearSyncBaseline(S.DB); S.undoStack.length = 0;
  S.setSnackPriorityUntil(0); S.setLocalSaveFailedAt(0); S.setStaleAppBlocked(false);
  S.UI.tasks.sel.clear(); S.UI.tasks.filters = {}; S.UI.tasks.search = '';
  S.rebuildIndex();
  const filePart = o.file ? o.file(cp(S.DB)) : cp(S.DB);
  FILE = JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
    writeId: 'w0', writeIds: ['w0'], lastWriteApp: S.APP_VERSION,
    tasks: filePart.tasks, works: filePart.works, duties: filePart.duties,
    milestones: filePart.milestones, users: filePart.users }));
  handle._mtime = 1; S.setFileHandle(handle); S.setEverConnected(true);
}
// 同事改文件：fn 拿到 payload 直接改；被改的记录自己负责抬 rev / updated_at
function colleague(fn) {
  const p = JSON.parse(FILE);
  fn(p);
  p.writeId = 'wC' + Math.random(); p.writeIds = ['w0', p.writeId];
  FILE = JSON.stringify(p); handle._mtime++;
}
const bump = r => Object.assign(r, { rev: (r.rev || 1) + 5, updated_at: LATER(), updated_by: '同事' });
const F = () => JSON.parse(FILE);
const fRec = (ent, key, id) => (F()[ent] || []).find(x => x[key] === id);
// 模拟"打开之前就发出去的那一轮同步，在确认框/编辑框开着时落地"
async function landSync(fn) { colleague(fn); await S.pullFromFile(); await tick(60); }
async function confirmNow() {
  const cb = S.modalCallback;
  if (typeof cb === 'function') { await cb(); await tick(200); }
  return typeof cb === 'function';
}

const keyEv = (key, extra) => Object.assign({ key, ctrlKey: false, isComposing: false, keyCode: 0, preventDefault() { this.prevented = true; }, stopPropagation() {} }, extra);
const docKeydown = ev => (raw.document._on.keydown || []).forEach(fn => fn(ev));

async function main() {
  await tick(150);

  section('① ★在输入框里打字时按 Ctrl+Z：撤销文字，不许撤销上一次数据操作');
  {
    world();
    const t = S.byId('task', 'T1');
    S.snapshot(); t.title = '改过的标题'; S.stampMeta(t); await S.Repo.persist(S.DB); await tick(40);
    ok('前提：撤销栈里有一次操作', S.undoStack.length > 0);
    S.openTaskDetail('T1'); await tick(20);
    const prevActive = raw.document.activeElement;
    raw.document.activeElement = { tagName: 'INPUT', blur() {} };
    const ev = keyEv('z', { ctrlKey: true });
    docKeydown(ev); await tick(60);
    raw.document.activeElement = prevActive;
    ok('★数据没有被撤销（原来标题被改回、弹窗被关掉）', S.byId('task', 'T1').title === '改过的标题', S.byId('task', 'T1').title);
    ok('★弹窗还开着，正在填的内容没丢', q('#modal-overlay').classList.contains('show'));
    ok('没有拦截浏览器自己的撤销文字', !ev.prevented);
    S.closeModal();
    const ev2 = keyEv('z', { ctrlKey: true });
    docKeydown(ev2); await tick(80);
    ok('焦点不在输入框时，Ctrl+Z 照常撤销数据操作', S.byId('task', 'T1').title !== '改过的标题' && ev2.prevented, S.byId('task', 'T1').title);
  }

  section('② ★中文输入法组词时按回车/Esc：交给输入法，不许保存、不许加人名、不许关弹窗');
  {
    world();
    // 单元格编辑框
    let lastInput = null;
    const _ce = raw.document.createElement;
    raw.document.createElement = function (tg) { const e = _ce.call(this, tg); if (String(tg) === 'input') lastInput = e; return e; };
    S.openEditor('task', 'T1', 'title', q('#td'));
    raw.document.createElement = _ce;
    lastInput.value = 'renwu';
    lastInput._on.keydown.forEach(fn => fn(keyEv('Enter', { isComposing: true, keyCode: 229 })));
    await tick(150);
    ok('★组词时回车没有把半截拼音保存进标题', S.byId('task', 'T1').title !== 'renwu', S.byId('task', 'T1').title);
    lastInput.value = '任务新标题';
    lastInput._on.keydown.forEach(fn => fn(keyEv('Enter')));
    await tick(150);
    ok('组词结束后回车照常保存', S.byId('task', 'T1').title === '任务新标题', S.byId('task', 'T1').title);

    // 人员下拉里的输入框
    S.openSelectPopup('task', 'T1', S.fieldDef('task', 'assignees'), q('#td')); await tick(60);
    const inp = q('#sp-manual-input');
    inp.value = 'zhangsan';
    (inp._on.keydown || []).forEach(fn => fn(keyEv('Enter', { isComposing: true, keyCode: 229 })));
    await tick(150);
    ok('★组词时回车没有把半截拼音当成新人名加进去', !(S.byId('task', 'T1').assignees || []).includes('zhangsan'), S.byId('task', 'T1').assignees);
    S.closeSelectPopup();

    // 全局 Esc
    S.openTaskDetail('T1'); await tick(20);
    docKeydown(keyEv('Escape', { isComposing: true, keyCode: 229 })); await tick(20);
    ok('★组词时按 Esc（取消候选词）没有关掉任务详情弹窗', q('#modal-overlay').classList.contains('show'));
    docKeydown(keyEv('Escape')); await tick(20);
    ok('不在组词时按 Esc 照常关弹窗', !q('#modal-overlay').classList.contains('show'));
  }

  section('③ 数据体检：格式合法但年份明显不对的日期也要列出来');
  {
    world();
    S.DB.milestones.push(S.stampMeta(S.blank('milestone', { id: 'MF', task: 'T1', plan_date: '9999-12-31', deliverable: '手滑的日期', done: '0' })));
    S.byId('task', 'T2').plan_date = '1026-05-01';
    S.rebuildIndex();
    const it = S.healthCheck().issues.find(i => i.k === 'badDate');
    const labels = it ? it.items.map(x => x.label).join('\n') : '';
    ok('★9999 年的里程碑日期被列出（甘特图不画它，原来在哪都看不见）', /9999-12-31/.test(labels), labels);
    ok('★1026 年的任务日期被列出', /1026-05-01/.test(labels), labels);
    ok('正常日期不列', !/2026-09-20/.test(labels));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
