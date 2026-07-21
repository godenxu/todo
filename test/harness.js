/* 最小 DOM 桩：让 index.html 的脚本能在 Node 里跑起来，用于验证纯逻辑。
   用法：node test/test-p2.js  （默认读取同级目录的 index.html）
   之所以不用浏览器：单文件应用没有构建步骤，用 Node 跑逻辑最快也最可复现。 */
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || require('path').join(__dirname, '..', 'index.html');

const html = fs.readFileSync(path, 'utf8');
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

const elCache = new Map();
function mkEl(sel) {
  const el = {
    _sel: sel, innerHTML: '', textContent: '', value: '', checked: false,
    style: {}, dataset: {}, offsetHeight: 0, clientHeight: 600, scrollTop: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c); else on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    focus() {}, select() {}, click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }),
    closest() { return null; },
    querySelector(s) { return mkEl(sel + ' ' + s); },
    querySelectorAll() { return []; },
  };
  return el;
}
function q(sel) {
  if (!elCache.has(sel)) elCache.set(sel, mkEl(sel));
  return elCache.get(sel);
}

const store = new Map();
const sandbox = {
  console,
  document: {
    querySelector: q,
    querySelectorAll: () => [],
    createElement: () => mkEl('created'),
    addEventListener() {}, removeEventListener() {},
    documentElement: { scrollWidth: 1280 },
    activeElement: { tagName: 'BODY', blur() {} },
    body: mkEl('body'),
  },
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 720 },
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
  },
  location: { hash: '', href: 'file:///index.html' },
  getComputedStyle: () => ({ getPropertyValue: () => '36px' }),
  requestAnimationFrame: fn => fn(),
  setTimeout, clearTimeout, setInterval, clearInterval,
  CSS: { escape: s => String(s).replace(/[^\w-]/g, c => '\\' + c) },
  Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
  FileReader: function () {},
  Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error, Promise, isNaN, parseInt, parseFloat,
};
sandbox.globalThis = sandbox;
sandbox.window.location = sandbox.location;

// top-level let/const 不会成为 globalThis 属性，需在同一段脚本内导出引用
const exportTail = `
;globalThis.__api = {
  get DB(){return DB}, get UI(){return UI}, get taskRows(){return _taskRows},
  get modalCallback(){return modalCallback}, get currentPage(){return currentPage},
  setPage(p){ currentPage = p; },
  ACTIONS, SCHEMAS, schema, fieldDef, byId, coll, query, facet, optionsOf,
  visibleTasks, visibleWorks, allPeople, todayStr, offsetDate, parseDue,
  renderTaskTree, renderTasks, renderBatchBar, renderSidebar, renderPage, renderShell,
  renderDashboard, renderWorks, renderDuties, daysFromToday, relTime, workName,
  get dashFocus(){return dashFocus},
  renderCharts, get chartTab(){return chartTab}, chartTableView, CHART_TABS,
  statsByPerson, statsByDuty, statsByCategory, monthlySeries, dueBuckets, tally, bucketOf,
  lineChart, barChart, ganttPanel, CATEGORIES,
  openBatchEdit, openColConfig, openTaskDetail, persistUI, restoreUI,
  undoLast, snapshot, seedAll, isOverdue, isOpen, isMine, Repo, blank, uid,
  splitMulti, joinMulti, parseCSV, csvHeaders, csvCell, padCode, normalize,
  openYearCopy, openOrphanAssign, healthCheck, fixHealth, backupState, lastChangeAt,
  importBackup, shiftYear, migrateWorkIds, nextWorkCode, exportJSON, parseQuickInput,
  renderData, optionsOf, stampMeta, softDelete,
  openEditor, openSelectPopup, closeSelectPopup, openWorkPicker, wpCommit, closeWorkSub,
  get sp(){return _sp}, renderCellValue, fieldControl, readControl,
  nextTaskCode, migrateTaskCodes, pieChart, pieLegend, dueSummary,
  TASK_VIEWS, TASK_VIEW_MAP, openOrphanAssign,
};`;

vm.createContext(sandbox);
vm.runInContext(code + exportTail, sandbox, { filename: 'app.js' });
module.exports = { sandbox: sandbox.__api, raw: sandbox, q, elCache, store };
