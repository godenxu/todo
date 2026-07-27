/* 最小 DOM 桩：让 index.html 的脚本能在 Node 里跑起来，用于验证纯逻辑。
   用法：node test/test-p2.js  （默认读取同级目录的 index.html）
   之所以不用浏览器：单文件应用没有构建步骤，用 Node 跑逻辑最快也最可复现。 */
const fs = require('fs');
const vm = require('vm');
const { webcrypto } = require('crypto');
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
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 720, print() {} },
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
  crypto: webcrypto, TextEncoder, TextDecoder,
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
  visibleTasks, visibleWorks, allPeople, todayStr, offsetDate, parseDue, parseCSVDate, defaultTaskView,
  renderTaskTree, renderTasks, renderTaskRow, renderBatchBar, renderSidebar, renderPage, renderShell,
  renderDashboard, renderWorks, renderDuties, daysFromToday, relTime, workName,
  get dashFocus(){return dashFocus},
  renderCharts, get chartTab(){return chartTab}, chartTableView, CHART_TABS,
  statsByPerson, statsByDuty, statsByWork, statsByCategory, dueBuckets, tally, bucketOf,
  lineChart, barChart, groupedBarChart, hBarList, msTreeGroups, milestoneTreeHTML, CATEGORIES, WORK_STATUS, PRIORITIES,
  get msDutyExpanded(){return msDutyExpanded}, get msWorkExpanded(){return msWorkExpanded},
  get dashMsDutyExpanded(){return dashMsDutyExpanded}, get dashMsWorkExpanded(){return dashMsWorkExpanded},
  get dashMsMineOnly(){return dashMsMineOnly},
  worksByYear, worksByDutyCount, taskFieldBars, computeSPI, msCompletionPie, msReportLevelStats,
  backlogSeries, backlogAsOf, get trendGranularity(){return trendGranularity}, planDueSeries,
  get chartDutyExpanded(){return chartDutyExpanded},
  openBatchEdit, openColConfig, openTaskDetail, persistUI, restoreUI,
  undoLast, snapshot, seedAll, isOverdue, isOpen, isMine, Repo, blank, uid,
  splitMulti, joinMulti, parseCSV, csvHeaders, csvCell, padCode, normalize,
  openYearCopy, openOrphanAssign, healthCheck, fixHealth, backupState, lastChangeAt,
  importBackup, shiftYear, migrateWorkIds, nextWorkCode, exportJSON, parseQuickInput,
  renderData, optionsOf, stampMeta, softDelete, undelete, removeHard,
  openEditor, openSelectPopup, closeSelectPopup, openWorkPicker, wpCommit, closeWorkSub,
  get sp(){return _sp}, renderCellValue, fieldControl, readControl,
  nextTaskCode, migrateTaskCodes, pieChart, pieLegend, dueSummary,
  TASK_VIEWS, TASK_VIEW_MAP, openOrphanAssign, reorderCols, boot,
  migrateMilestonesToTasks, cpRowHTML, recalcProgress, hasCheckpoints, migrateViewDataDefault,
  updateCpProgressPreview, findCpOrderIssue,
  pushLog, diffTask, dpCommit, ganttDataTable, ganttTableRows, get ganttSort(){return ganttSort},
  parseLines, stripLineNumber, applyCSVImport, openImportModal,
  get importEntity(){return _importEntity}, get importMode(){return _importMode},
  spCommitMulti, spAddFromInput, spFlushManualInput, splitNames, matchFilters,
  facetBlock, personFacet, personFacetBlock, personUnion, renderToolbar,
  mergeEntityList, mergeChangelog, syncPayload, mergeSyncPayload, syncToFile, mergeByPk,
  connectSharedFile, disconnectSharedFile, tryReconnectSharedFile, newerRecord,
  get fileHandle(){return _fileHandle}, setFileHandle(h){ _fileHandle = h; },
  get dirHandle(){return _dirHandle}, setDirHandle(h){ _dirHandle = h; },
  get lastSyncedMtime(){return _lastSyncedMtime}, setLastSyncedMtime(v){ _lastSyncedMtime = v; },
  computeSharePath, DEFAULT_SHARE_FILE_NAME, maybeAutoConnectSharedFolder, sharePathHintText, confirmConnectWithHint,
  ROLES, ROLE_RANK, myUser, myRole, roleAtLeast, isRecordOwnerOrParticipant, canEditRecord, requireRole,
  hashPin, verifyPin, ensureIdentity, showLoginGate, hideLoginGate,
  renderLoginPick, renderLoginVerify, renderLoginCreate,
  get loginPending(){return !!_loginResolve},
  canManageAccount, assignableRoles, accountsPanelHTML,
  applyWideImport, wideImportHeaders, reportLevelFromLabel, openWideImportModal, REPORT_LEVELS,
  get wideImportMode(){return _wideImportMode},
  spCommitSingle, ownerChangeNeedsWarning, renderPermissions, goto,
  hasIncompleteCheckpoints, commitTaskStatus, confirmCompleteCheckpointsThenStatus,
  hasPermission, requirePermission, getPermissionMatrix, PERMISSIONS, DEFAULT_PERMISSION_MATRIX,
  mergePermissionMatrix, permissionMatrixPanelHTML, canSeePage, PAGES,
  buildReportData, renderReport, buildReportText, personalReminderMsg, startOfWeek, endOfWeek,
  periodRange, REPORT_PERIODS, exportReportImage, dutyTreeRowsHTML, statCard, hBar,
  get reportPeriod(){return reportPeriod}, setReportPeriod(p){ reportPeriod = p; },
  get reportExpanded(){return reportExpanded},
  get dashExpanded(){return dashExpanded},
};`;

vm.createContext(sandbox);
vm.runInContext(code + exportTail, sandbox, { filename: 'app.js' });
const api = sandbox.__api;
// 测试沙盒默认已"登录"成管理员，省得每个既有用例都要先处理身份门禁；
// 专门测身份/权限系统的用例可以在自己的 tick() 之后再改 DB.users / DB.settings.me。
// 必须在 boot() 的异步续体跑到 ensureIdentity() 之前完成——vm.runInContext 同步执行到 boot() 的第一个
// await 为止就把控制权交回这里，这段代码又是纯同步的，能保证抢在 ensureIdentity() 检查之前把身份灌好。
api.DB.settings.me = '测试管理员';
api.DB.users.push({
  name: '测试管理员', role: 'admin', salt: '', hash: '', iterations: 0,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: '测试管理员', rev: 1,
});
module.exports = { sandbox: api, raw: sandbox, q, elCache, store };
