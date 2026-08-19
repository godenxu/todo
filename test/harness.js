/* 最小 DOM 桩：让 index.html 的脚本能在 Node 里跑起来，用于验证纯逻辑。
   用法：node test/test-p2.js  （默认读取同级目录的 index.html）
   之所以不用浏览器：单文件应用没有构建步骤，用 Node 跑逻辑最快也最可复现。 */
const fs = require('fs');
const vm = require('vm');
const { webcrypto } = require('crypto');
const path = process.argv[2] || require('path').join(__dirname, '..', 'index.html');

const html = fs.readFileSync(path, 'utf8');
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* canvas 2D 上下文的最小桩：报告页"导出图片"整段逻辑（exportReportImage）之前完全没被沙盒
   真的跑过——document.createElement 原来不认 tag，canvas.getContext('2d') 在沙盒里是
   undefined，一调用就抛 TypeError，又恰好被 exportReportImage 自己的 try/catch 吞掉，
   于是"调用不抛异常"这种回归测试其实从没真的走到过内部排版逻辑，只是在测"try/catch 本身
   没坏"。补一个会记录调用轨迹的桩，让画布相关代码能真的跑起来、抛出的真实错误也能被测试
   抓到，同时把每次调用记进 _calls，方便用例断言"面板边框画了几次""是否真的同行画了两列"
   这类只看生成的 HTML 源码文本猜不出来的运行时行为。 */
function mkCanvasCtx() {
  const calls = [];
  const rec = (op, args) => calls.push({ op, args });
  return {
    _calls: calls,
    fillStyle: '', strokeStyle: '', font: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic',
    save() { rec('save', []); }, restore() { rec('restore', []); },
    translate(x, y) { rec('translate', [x, y]); },
    rotate(a) { rec('rotate', [a]); },
    scale(x, y) { rec('scale', [x, y]); },
    beginPath() { rec('beginPath', []); }, closePath() { rec('closePath', []); },
    moveTo(x, y) { rec('moveTo', [x, y]); }, lineTo(x, y) { rec('lineTo', [x, y]); },
    arc(x, y, r, a0, a1) { rec('arc', [x, y, r, a0, a1]); },
    arcTo(x1, y1, x2, y2, r) { rec('arcTo', [x1, y1, x2, y2, r]); },
    roundRect(x, y, w, h, r) { rec('roundRect', [x, y, w, h, r]); },
    stroke() { rec('stroke', [this.strokeStyle, this.lineWidth]); },
    fill() { rec('fill', [this.fillStyle]); },
    fillRect(x, y, w, h) { rec('fillRect', [x, y, w, h, this.fillStyle]); },
    strokeRect(x, y, w, h) { rec('strokeRect', [x, y, w, h, this.strokeStyle]); },
    clearRect(x, y, w, h) { rec('clearRect', [x, y, w, h]); },
    fillText(text, x, y) { rec('fillText', [text, x, y, this.fillStyle, this.font, this.textAlign]); },
    measureText(text) { return { width: String(text == null ? '' : text).length * 6.5 }; },
  };
}
const elCache = new Map();
function mkEl(sel) {
  const el = {
    _sel: sel, innerHTML: '', textContent: '', value: '', checked: false,
    width: 0, height: 0,
    style: {}, dataset: {}, offsetHeight: 0, clientHeight: 600, clientWidth: 0, scrollTop: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c); else on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    /* 事件监听改成真的记下来，并给一个 fire() 手动触发 —— 输入法合成（compositionstart /
       compositionend）这类行为只能靠模拟事件来测：不记监听器的话，测试连"合成期间到底有没有
       触发筛选"都问不出来，而那正是中文输入抢跑那个 bug 的要害。 */
    _on: {},
    addEventListener(type, fn) { (this._on[type] = this._on[type] || []).push(fn); },
    removeEventListener(type, fn) { this._on[type] = (this._on[type] || []).filter(f => f !== fn); },
    fire(type, ev) { (this._on[type] || []).forEach(f => f.call(this, ev || { type })); },
    appendChild() {}, removeChild() {},
    focus() {}, select() {}, click() {},
    // 真实 DOM 里 querySelector('svg') 拿到的元素总有 getAttribute；这里的元素是按选择器
    // 现造的桩，并不真的解析 innerHTML，但既然桩造出来了就该有这个方法，不然像
    // fitFlexBarChart() 这种"量完真实宽度、按需要重画"的代码一读 svg 的 width 属性就炸——
    // 沙盒本来就测不出真实布局宽度（见调用处注释），返回 null 就是「没量到」，够用了
    getAttribute: () => null, setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }),
    closest() { return null; },
    querySelector(s) { return mkEl(sel + ' ' + s); },
    querySelectorAll() { return []; },
    getContext(type) { if (!this._ctx) this._ctx = mkCanvasCtx(); return this._ctx; },
    toBlob(cb) { cb({ size: 1, type: 'image/png' }); },
  };
  return el;
}
function q(sel) {
  if (!elCache.has(sel)) elCache.set(sel, mkEl(sel));
  return elCache.get(sel);
}

let lastCreatedCanvas = null;
const store = new Map();
const sandbox = {
  console,
  document: {
    querySelector: q,
    querySelectorAll: () => [],
    createElement(tag) {
      const el = mkEl('created:' + (tag || ''));
      if (String(tag).toLowerCase() === 'canvas') lastCreatedCanvas = el;
      return el;
    },
    get _lastCanvas() { return lastCreatedCanvas; },
    addEventListener() {}, removeEventListener() {},
    documentElement: { scrollWidth: 1280 },
    activeElement: { tagName: 'BODY', blur() {} },
    body: mkEl('body'),
    // "导出季度考核目标"复制按钮的兼容降级用得到——默认模拟"能成功"，
    // 测复制失败的用例自己把这个换成 () => false
    execCommand: () => true,
  },
  // 默认模拟"安全上下文、clipboard API 能用"；测非安全上下文兜底逻辑的用例
  // 自己把 navigator.clipboard 整个删掉或者把 writeText 换成会 reject 的版本
  navigator: { clipboard: { writeText: async () => {} } },
  window: {
    _on: {},
    addEventListener(type, fn) { (this._on[type] = this._on[type] || []).push(fn); },
    removeEventListener(type, fn) { this._on[type] = (this._on[type] || []).filter(f => f !== fn); },
    fire(type, ev) { (this._on[type] || []).slice().forEach(f => f.call(this, ev || { type })); },
    innerWidth: 1280, innerHeight: 720, print() {},
  },
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
  visibleTasks, visibleWorks, allPeople, todayStr, localDay, offsetDate, parseDue, parseCSVDate, defaultTaskView, fmtDate,
  renderTaskTree, renderTasks, renderTaskRow, renderBatchBar, renderSidebar, renderPage, renderShell,
  renderDashboard, renderWorks, renderDuties, daysFromToday, relTime, workName,
  // P80：工作台改版——按周期回看个人进展 + 处室/部门领导切人查看
  get dashPeriod(){return dashPeriod}, setDashPeriod(v){ dashPeriod = v; },
  get dashOffset(){return dashOffset}, setDashOffset(v){ dashOffset = v; },
  get dashViewAsPerson(){return dashViewAsPerson}, setDashViewAsPerson(v){ dashViewAsPerson = v; },
  dashViewedPerson, dashPersonTasks, nextMilestoneMap,
  renderCharts, get chartTab(){return chartTab}, chartTableView, CHART_TABS,
  statsByPerson, statsByDuty, statsByWork, statsByCategory, dueBuckets, tally, bucketOf,
  lineChart, barChart, groupedBarChart, hBarList, msTreeGroups, milestoneTreeHTML, CATEGORIES, WORK_STATUS, PRIORITIES,
  get msDutyExpanded(){return msDutyExpanded}, get msWorkExpanded(){return msWorkExpanded},
  get dashMsDutyExpanded(){return dashMsDutyExpanded}, get dashMsWorkExpanded(){return dashMsWorkExpanded},
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
  // P62：可达性修复——恢复入口的任务/工作/职责池、级联软删除与恢复
  taskPoolFor, workPoolFor, dutyPoolFor, stoppedWorks, deletedDuties,
  cascadeSoftDeleteTask, cascadeRestoreTask, cascadeRemoveHardTask, undelete,
  // P63：回收站
  recycleBin, recycleTotals, recycleKeepDays, recycleCutoff, purgeRecycleBin,
  recycleBinPanelHTML, DEFAULT_RECYCLE_KEEP_DAYS, RECYCLE_ENTITIES,
  // P64：体检分级 + 干跑预览
  HEALTH_META, HEALTH_LEVELS, healthMeta, fixHealthPreview, HEALTH_PREVIEW_LIMIT,
  // P65：备份跨标签页锁 / 输入法合成 / 撤销按钮 / 换版本首次同步不误报
  claimBackupSlot, markBackupSlotUsed, BACKUP_LOCK_KEY, maybeAutoBackup, backupDue,
  // 备份锁存在 localStorage 里；用例要模拟"上次备份是很久以前"就得能改它，所以把存储本身放出来
  get storage(){return localStorage},
  bindComposableSearch, bindLogsTextSearch, bindToolbarInputs, SNACK_UNDO_WINDOW_MS,
  get skipDamageAlertOnce(){return _skipDamageAlertOnce}, setSkipDamageAlertOnce(v){ _skipDamageAlertOnce = v; },
  get lastSnapshotAt(){return _lastSnapshotAt}, setLastSnapshotAt(v){ _lastSnapshotAt = v; },
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
  checkBackupPermOnBoot, armBackupPermAutoRestore,
  get backupPermLapsed(){return _backupPermLapsed}, setBackupPermLapsed(v){ _backupPermLapsed = v; },
  get needPermissionRestore(){return _needPermissionRestore}, setNeedPermissionRestore(v){ _needPermissionRestore = v; },
  get loginPending(){return !!_loginResolve},
  fmtLocalDateTime,
  canManageAccount, assignableRoles, accountsPanelHTML,
  exportAccounts, importAccounts, parseAccountsFile, accountsExportPayload, ACCOUNTS_EXPORT_KIND,
  applyWideImport, wideImportHeaders, reportLevelFromLabel, openWideImportModal, REPORT_LEVELS,
  get wideImportMode(){return _wideImportMode},
  spCommitSingle, ownerChangeNeedsWarning, renderPermissions, goto,
  hasIncompleteCheckpoints, commitTaskStatus, doneAutoFillNeeded, openDoneAutoFillModal,
  hasPermission, requirePermission, getPermissionMatrix, PERMISSIONS, DEFAULT_PERMISSION_MATRIX,
  mergePermissionMatrix, permissionMatrixPanelHTML, canSeePage, PAGES,
  buildReportData, renderReport, buildReportText, personalReminderMsg, startOfWeek, endOfWeek,
  periodRange, REPORT_PERIODS, exportReportImage, reportExportTitle, dutyTreeRowsHTML, statCard, hBar,
  fracStr, visibleDutyCount, taskStatusBreakdown, msStatusBreakdown,
  periodScopeCardsHTML, periodPlanCardsHTML, periodStatusCardsHTML,
  get reportPeriod(){return reportPeriod}, setReportPeriod(p){ reportPeriod = p; },
  get reportOffset(){return reportOffset}, setReportOffset(v){ reportOffset = v; },
  periodLabelFor,
  get reportExpanded(){return reportExpanded},
  PRIORITY_CYCLE_NEXT, taskItem,
  get healthExpanded(){return _healthExpanded}, setHealthExpanded(s){ _healthExpanded = s; },
  startAutoBackupTimer, backupTick, get backupTimer(){return _backupTimer}, get backupInFlight(){return _backupInFlight},
  setBackupTimer(v){ _backupTimer = v; },
  get lastBackupAuthWarnAt(){return _lastBackupAuthWarnAt}, setLastBackupAuthWarnAt(v){ _lastBackupAuthWarnAt = v; },
  // P55：报告页区域+模块编排
  REPORT_MODULES, REPORT_MODULE_MAP, REPORT_GROUPS, DEFAULT_REPORT_SECTIONS, reportPresets, activeReportPreset,
  reportSections, saveReportConfig, reportConfigPanelHTML, reportPresetIn,
  get reportConfigOpen(){return reportConfigOpen}, setReportConfigOpen(v){ reportConfigOpen = v; },
  promptModal,
  // P80 第二版：工作台也改成区域+模块编排（跟报告页那套共用同一个 REPORT_MODULES 注册表，
  // 独立存一份 DB.dashboardConfig），加了 personAware/personScope 这个"按人/按整体"的维度
  DEFAULT_DASHBOARD_SECTIONS, DASHBOARD_DEFAULT_PRESET_NAME, dashboardPresets, activeDashboardPreset, dashboardSections,
  saveDashboardConfig, dashboardPresetIn, dashNormalizePersonScope, dashboardConfigPanelHTML,
  get dashConfigOpen(){return dashConfigOpen}, setDashConfigOpen(v){ dashConfigOpen = v; },
  /* showSnack 有个"优先级提示 1.5 秒内压住普通提示"的机制（见 _snackPriorityUntil）。
     整个测试文件跑完往往还不到 1.5 秒，于是前面某个用例触发过一次优先级提示之后，
     后面所有验证普通提示文案的断言都会读到空字符串——排查起来非常费劲。
     导出一个复位口子，用例在断言提示文案之前先把这个窗口清掉。 */
  setSnackPriorityUntil(v){ _snackPriorityUntil = v; },
  // P55：合并熔断的新鲜度基准线 + 体检彻底删除
  mergeDamageSince, MERGE_DAMAGE_MAX_WINDOW_MS, MERGE_DAMAGE_LIMIT, purgeHealth, PURGED_LIMIT, recordPurge,
  // P57：模块分类 / 同行排列 / 最近连接心跳
  REPORT_GROUPS, reportChartWidth,
  get reportMsDutyExpanded(){return reportMsDutyExpanded}, get reportMsWorkExpanded(){return reportMsWorkExpanded},
  touchPresence, markUserSeen, PRESENCE_MIN_GAP_MS,
  get lastPresenceAt(){return _lastPresenceAt}, setLastPresenceAt(v){ _lastPresenceAt = v; },
  // P59：报告模块"看数据表"+ 到期分布字体缩放修复
  dataTable, svgScroll, reportIsTable, reportModHead, fitFlexBarChart, fitFlexChart, ganttDataTable, ganttTableRows,
  // P66：里程碑清单带牵头人 / 当期口径含推进中任务 / 报告模块点击下钻 / 到期-优先级-来源改全量 /
  // 状态饼图并入当期进度 / 交付物层级统计新模块 / 甘特轴裁剪 2 个月前
  msReportLevelStatsOf, twoMonthsAgoOffset, taskViewAttrs, taskFilterAttrs, workFilterAttrs, dutyFilterAttrs,
  reportMsRows, reportTaskRows,
  // P67：交付物层级分布模块口径调整 / 交付物层级统计模块补清单 / 图表页新增"人员工作矩阵"
  personDutyWorkHeat, matrixHeatCellHTML, personMatrixHTML,
  get chartMatrixDutyExpanded(){return chartMatrixDutyExpanded},
  // P69：矩阵布局用 colgroup 修正 / 矩阵并入报告"人员"分类 / 报告模块宽度倍数
  get reportMatrixDutyExpanded(){return reportMatrixDutyExpanded},
  // P72：备份文件夹授权自动恢复 / 本期已交付里程碑按呈报层级排序+可点选筛选 / 矩阵打印列被截掉
  DELIVERED_MS_LEVEL_ORDER,
  get reportDeliveredMsLevelFilter(){return reportDeliveredMsLevelFilter}, setReportDeliveredMsLevelFilter(v){ reportDeliveredMsLevelFilter = v; },
  // P77：导出图片排版跟导出 PDF 对齐——图片里清单截断条数改用跟页面/PDF 同一个上限
  REPORT_LIST_LIMIT,
  // 工作台"导出季度考核目标"：按工作把牵头/参与内容转换成指标草稿（名称/详细描述/当前目标/年度目标）
  buildAssessmentGoalsText, assessmentExtractGoalLines, assessmentIndicatorRole, assessmentIndicatorDesc,
  copyAssessmentGoalsText, dashIsLeadTask,
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
