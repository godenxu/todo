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
  visibleTasks, visibleWorks, allPeople, todayStr, localDay, offsetDate, parseDue, parseCSVDate, defaultTaskView,
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
  openModal, closeModal, confirmModal, get modalBusy(){return _modalBusy},
  undoLast, snapshot, seedAll, isOverdue, isOpen, isMine, hasOverdueMilestone, Repo, blank, uid,
  splitMulti, joinMulti, parseCSV, csvHeaders, csvCell, padCode, normalize,
  openYearCopy, openOrphanAssign, healthCheck, fixHealth, backupState, lastChangeAt,
  importBackup, shiftYear, migrateWorkIds, nextWorkCode, exportJSON, defaultTaskOwner, openNewTask, worksOfDuty, workOptionsHTML, bindDutyWorkCascade,
  renderData, optionsOf, stampMeta, softDelete, undelete, removeHard,
  cascadeSoftDeleteTask, cascadeRestoreTask, cascadeRemoveHardTask, undoRestoreList,
  touchedByOthersSince, UNDO_MAX_AGE_MS, get undoStack(){return undoStack},
  pushLoginLog, logKind, trimChangelog, CHANGELOG_LIMIT,
  logRangeBounds, filterLogs, renderLogs, LOG_PAGE_SIZE, LOG_RANGES, LOG_KINDS,
  pushAdminLog, pushAlertLog, roleLabel, ADMIN_LOG_KIND, ALERT_LOG_KIND,
  roleOfIn, roleUpgradeAuthorized, guardRoleIntegrity, get integrityAlerts(){return _integrityAlerts},
  mergeDamageReport, noteMergeAlerts, armMergeDamageAlert, loadMergeAlert, clearMergeAlert,
  restoreMergeDamage, unresolvedRoleAlerts, securityAlertCount, securityAlertPanelHTML, MERGE_DAMAGE_LIMIT,
  openEditor, openSelectPopup, closeSelectPopup, openWorkPicker, wpCommit, closeWorkSub, commitActiveEdit,
  get sp(){return _sp}, renderCellValue, fieldControl, readControl,
  nextTaskCode, migrateTaskCodes, pieChart, pieLegend, dueSummary,
  TASK_VIEWS, TASK_VIEW_MAP, openOrphanAssign, reorderCols, boot,
  migrateMilestonesToTasks, cpRowHTML, recalcProgress, hasCheckpoints, migrateViewDataDefault,
  updateCpProgressPreview, findCpOrderIssue,
  dateStrToDigits, digitsToDateStr, isValidDateStr, normalizeMaskedDateValue,
  maskDateInputLive, normalizeMaskedDateOnBlur, reconcileStatusAndProgress,
  pushLog, diffTask, dpCommit, ganttDataTable, ganttTableRows, get ganttSort(){return ganttSort},
  pushChangeLog, diffRecord, logEntity, logRefId, finishSpCommitSingle,
  localCachePanelHTML, get localCacheStale(){return _localCacheStale},
  setLocalCacheStale(v, ver){ _localCacheStale = v; _localCacheAppVersion = ver || ''; },
  openDatePicker, openDatePickerForInput, dpCurrentValue, renderDpCalendar, dpNav, dpClose, openDpPopup,
  get dp(){return _dp},
  parseLines, stripLineNumber, applyCSVImport, openImportModal,
  get importEntity(){return _importEntity}, get importMode(){return _importMode},
  spCommitMulti, spAddFromInput, spFlushManualInput, splitNames, matchFilters,
  facetBlock, personFacet, personFacetBlock, personUnion, renderToolbar,
  mergeEntityList, mergeChangelog, syncPayload, mergeSyncPayload, syncToFile, mergeByPk, hasLocalContribution,
  recordPurge, mergePurged, applyPurged, PURGED_LIMIT, rebuildIndex,
  connectSharedFile, disconnectSharedFile, tryReconnectSharedFile, newerRecord, isValidShareData,
  get fileHandle(){return _fileHandle}, setFileHandle(h){ _fileHandle = h; },
  get dirHandle(){return _dirHandle}, setDirHandle(h){ _dirHandle = h; },
  get lastSyncedMtime(){return _lastSyncedMtime}, setLastSyncedMtime(v){ _lastSyncedMtime = v; },
  hasEverConnectedShare,
  renderLoginGate, renderLoginConnectFirst, loginGateStage, ownFolderPath,
  get offlineMode(){return _offlineMode}, setOfflineMode(v){ _offlineMode = v; },
  get everConnected(){return _everConnected}, setEverConnected(v){ _everConnected = v; },
  BOOTSTRAP_ADMINS,
  APP_VERSION, DATA_SCHEMA_VERSION, payloadSchemaVersion, filePayload, emptyRemotePayload,
  readSharedFile, checkDataVersion, showUpgradeGate, stopAutoReload, startAutoReload, cacheRemoteWriteInfo,
  checkAppVersion, noteRemoteAppVersion, isStaleApp, showStaleAppGate, appVersionCellHTML,
  get staleAppBlocked(){return _staleAppBlocked}, setStaleAppBlocked(v){ _staleAppBlocked = v; },
  pullFromFile, pullOnWake, syncCatchUp, syncBlocked, mergeUserPresence,
  get syncBlockedPending(){return _syncBlockedPending}, setSyncBlockedPending(v){ _syncBlockedPending = v; },
  setLastPullAt(v){ _lastPullAt = v; },
  withSyncGate, syncNowAndRender, get syncBusy(){return _syncBusy}, setSyncBusy(v){ _syncBusy = v; },
  get versionBlocked(){return _versionBlocked}, setVersionBlocked(v){ _versionBlocked = v; },
  DEFAULT_SHARE_FILE_NAME, maybeAutoConnectSharedFolder, confirmConnectWithHint,
  ROLES, ROLE_RANK, myUser, myRole, roleAtLeast, isRecordOwnerOrParticipant, canEditRecord, requireRole,
  ensureIdentity, showLoginGate, hideLoginGate, renderLoginPick, renderLoginCreate,
  renderLoginVerify, renderLoginSetPin, hashPin, verifyPin, PIN_ITERATIONS,
  effectiveShareCfg, updateShareConfig, markUserSeen, connectionStatusHTML,
  doRestoreSharePermission, armPermissionAutoRestore, ensureFileHandleFresh, showSnack,
  get snackPriorityUntil(){return _snackPriorityUntil}, setSnackPriorityUntil(v){ _snackPriorityUntil = v; },
  backupCfg, backupDue, runBackup, maybeAutoBackup, idbSetBackupDir, idbGetBackupDir, BACKUP_MIN_HOURS,
  get needPermissionRestore(){return _needPermissionRestore}, setNeedPermissionRestore(v){ _needPermissionRestore = v; },
  get loginPending(){return !!_loginResolve},
  fmtLocalDateTime,
  canManageAccount, assignableRoles, accountsPanelHTML,
  exportAccounts, importAccounts, parseAccountsFile, accountsExportPayload, ACCOUNTS_EXPORT_KIND,
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
// 正式程序不再自带任何演示数据（boot() 首次打开就是一份空系统），但绝大多数用例都需要一批有形状的数据
// 才能验证渲染/统计/筛选，所以由测试脚手架自己显式播一次种。跟身份一样，必须抢在 boot() 的异步续体之前完成。
api.seedAll();
module.exports = { sandbox: api, raw: sandbox, q, elCache, store };
