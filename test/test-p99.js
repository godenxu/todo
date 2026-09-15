/* P99：第十轮排查——把"同步的结构性不变量"变成机器检查

   前九轮每一轮都能找到新的同步问题，原因不在于问题特别多，而在于排查方式：
   每轮都是"再想一个角度"，靠灵感。想到了就查得出来，想不到就漏。
   这一轮改成【矩阵穷举】——把同步的三个维度列全，逐格核对：

     矩阵 A：所有会"读文件→合并→写回"的路径 × 每条路径必须做的步骤
     矩阵 B：syncPayload 里每一类数据 × 它的合并规则和保护机制
     矩阵 G：所有会改数据的动作 × 是否真的落盘

   这个文件把矩阵固化成源码扫描。它比行为测试脆（改个变量名就可能挂），但换来的是
   【加新路径、加新字段时会自动挂】——而"新加的那条路忘了做某一步"正是前几轮反复出现的形态：
     · P97：connectSharedFile 漏了 normalizeMergedRecords / reconcileDerivedAfterMerge
     · P99：connectSharedFile 又漏了 cacheRemoteWriteInfo / noteMergeAlerts / noteFieldConflicts
     · P99：updateShareConfig 的四个调用点，漏了一处 Repo.persist
   挂了不一定是 bug，但一定值得看一眼：要么补上那一步，要么在这里写明为什么可以豁免。
   用法：node test/test-p99.js */
const { sandbox: S } = require('./harness.js');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

const SRC = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');

/* 截一个函数的正文：从函数名那一行起，到下一个顶层 function 声明为止。
   不用花括号配平——注释里有的是中文括号和 {n} 这类占位，配平反而不稳。 */
function sliceFn(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  const rest = src.slice(i + decl.length);
  const m = rest.search(/\n(?:async )?function [A-Za-z_$]/);
  return m < 0 ? rest : rest.slice(0, m);
}

async function main() {
  await tick(60);

  /* ================== 矩阵 A ================== */
  section('矩阵 A：每条"读文件→合并→写回"的路径，必须做齐这些步骤');
  /* 三条路径都是"拿文件内容跟本机合并"，少任何一步的后果都在前几轮实测过：
     · checkDataVersion/checkAppVersion  少了会用旧版把新版字段抹掉
     · cacheRemoteWriteInfo              少了查不出机器时钟差、也发现不了还有人用旧版在写
     · noteClobberedWrite                少了发现不了"我那次写被人用过期内容盖掉"
     · normalizeMergedRecords            少了文件被记事本改坏时整页渲染不出来
     · reconcileDerivedAfterMerge        少了任务进度停在合并前的旧值，顺着 SPI 污染报表
     · noteMergeAlerts                   少了合并熔断不生效——一次少掉一大片记录没人知道，也没法回滚
     · noteFieldConflicts                少了冲突信息【永久丢失】（下次合并开头就把它清空了） */
  const PATHS = [
    ['保存并写回（syncToFileInner）', 'async function syncToFileInner'],
    ['只读拉取（pullFromFileInner）', 'async function pullFromFileInner'],
    ['重新连接共享文件夹（connectSharedFile）', 'async function connectSharedFile'],
  ];
  const STEPS = [
    ['数据格式门禁', /checkDataVersion\(/],
    ['旧版 html 门禁', /checkAppVersion\(/],
    ['记录文件最后写入者（含时钟差/旧版写入者检测）', /cacheRemoteWriteInfo\(/],
    ['检测上次写有没有被盖掉', /noteClobberedWrite\(/],
    ['合并结果类型规整', /normalizeMergedRecords\(/],
    ['合并后重算派生字段', /reconcileDerivedAfterMerge\(/],
    ['合并熔断 / 越权告警', /noteMergeAlerts\(/],
    ['字段与配置冲突记录', /noteFieldConflicts\(/],
  ];
  PATHS.forEach(([label, decl]) => {
    const body = sliceFn(SRC, decl);
    ok(`能截到「${label}」的正文`, body.length > 200, body.length);
    const missing = STEPS.filter(([, re]) => !re.test(body)).map(([n]) => n);
    ok(`★「${label}」八个步骤一个不少`, missing.length === 0, { 缺: missing });
  });
  // 三条路径最后都要把基线对齐到【文件里那一份】，不是对齐到合并结果（对齐错了下一轮就会反向覆盖）
  PATHS.forEach(([label, decl]) => {
    const body = sliceFn(SRC, decl);
    ok(`★「${label}」把基线对齐到了文件内容`,
      /syncBase = buildSyncBase\((cur\.remote|remote)\)/.test(body)
      // 写回成功那一条例外：文件里就是我刚写的 merged，对齐到 merged 才是对的
      || /syncBase = buildSyncBase\(merged\)/.test(body));
  });

  /* ================== 矩阵 B ================== */
  section('矩阵 B：syncPayload 里每一类数据，都要有明确的合并规则');
  const payloadKeys = Object.keys(S.syncPayload(S.DB));
  const RULES = {
    duties: /mergeEntityListWithBase\('duty'/, works: /mergeEntityListWithBase\('work'/,
    milestones: /mergeEntityListWithBase\('milestone'/, tasks: /mergeEntityListWithBase\('task'/,
    changelog: /mergeChangelog\(/,
    // P119 起账号改成有基线就逐字段三方合并（mergeUsersWithBase），没基线时它内部再退回 mergeByPk
    users: /mergeUsersWithBase\(local\.users, remote\.users, b\.user\)/,
    permissionMatrix: /mergePermissionMatrix\(local\.permissionMatrix/,
    shareConfig: /mergePermissionMatrix\(local\.shareConfig/,
    reportConfig: /mergePermissionMatrix\(local\.reportConfig/,
    dashboardConfig: /mergePermissionMatrix\(local\.dashboardConfig/,
    purged: /mergePurged\(/,
  };
  const merge = sliceFn(SRC, 'function mergeSyncPayload');
  ok('★syncPayload 的字段跟这里列的规则表一一对应（新增字段必须同时给出合并规则）',
    payloadKeys.every(k => RULES[k]) && Object.keys(RULES).every(k => payloadKeys.includes(k)),
    { 载荷里有规则表没有的: payloadKeys.filter(k => !RULES[k]),
      规则表有载荷里没有的: Object.keys(RULES).filter(k => !payloadKeys.includes(k)) });
  payloadKeys.forEach(k => ok(`  「${k}」的合并规则接在 mergeSyncPayload 里`, RULES[k] && RULES[k].test(merge)));
  // 四个整体对象 + 账号：合并时输的一方整份丢弃，所以必须留痕
  ok('★四个整体配置对象合并时都带了名字（不带名字就不记冲突，等于悄悄覆盖）',
    (merge.match(/mergePermissionMatrix\(local\.\w+, remote\.\w+, '[^']+'\)/g) || []).length === 4);
  ok('★账号的并发覆盖也记（它跟整体对象一样是整条丢弃，一直没人管）',
    /noteUserConflicts\(local\.users, remote\.users, b\.user\)/.test(merge)
      // 有基线的账号，真冲突改在逐字段合并里记（P119）
      && /function mergeUserThreeWay[\s\S]{0,1500}_objConflicts\.push/.test(SRC));

  /* ================== 矩阵 G ================== */
  section('矩阵 G：ACTIONS 里改了数据的动作，必须真的落盘');
  {
    const start = SRC.indexOf('const ACTIONS = {');
    let i = SRC.indexOf('{', start), depth = 0, end = -1;
    for (let k = i; k < SRC.length; k++) {
      if (SRC[k] === '{') depth++;
      else if (SRC[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    const body = SRC.slice(i + 1, end);
    const re = /\n  (?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*)):/g;
    const keys = []; let m;
    while ((m = re.exec(body))) keys.push({ name: m[1] || m[2] || m[3], at: m.index });
    ok('能切出 ACTIONS 的动作清单', keys.length > 100, keys.length);
    // 改数据的迹象
    const MUT = /stampMeta\(|softDelete\(|undelete\(|removeHard\(|cascade(SoftDelete|Restore|RemoveHard)Task\(|\.deleted_at\s*=|DB\.(tasks|works|duties|milestones|users|changelog|purged)\s*(=|\.push|\.splice)|DB\.(permissionMatrix|shareConfig|reportConfig|dashboardConfig)\s*=|recalcProgress\(/;
    // 落盘的迹象（这些函数自己会 persist）
    const SAVE = /Repo\.(persist|bulk|upsert)|updateShareConfig\(|saveReportConfig|saveDashboardConfig|syncNowAndRender|purgeRecycleBin|fixHealth|repairByChangelog|applyCSVImport|applyWideImport|importBackup|openYearCopy|restoreMergeDamage|connectSharedFile|disconnectSharedFile/;
    const suspect = [];
    keys.forEach((k, idx) => {
      const seg = body.slice(k.at, idx + 1 < keys.length ? keys[idx + 1].at : body.length);
      if (MUT.test(seg) && !SAVE.test(seg)) suspect.push(k.name);
    });
    ok(`★★${keys.length} 个动作里，改了数据却看不到落盘的：${suspect.length} 个`
      + '（改动只留在内存 = 刷新就没、别人也看不到，而界面还会提示"已保存"）',
      suspect.length === 0, suspect);

    /* ★ 上面那条断言信任 SAVE 名单里的函数"自己会落盘"，可它从不检查这件事——
       名单一旦跟现实脱节，整条矩阵就变成了摆设。实测过：把 updateShareConfig 里的
       Repo.persist 删掉，上面那条照样全绿，因为调用点里还写着 updateShareConfig(...)。
       所以名单里每个"自带落盘"的函数，都必须在这里被验明正身。 */
    function sliceMethod(src, decl) {
      const i = src.indexOf(decl);
      if (i < 0) return '';
      const rest = src.slice(i + decl.length);
      const m = rest.search(/\n  (?:async )?[a-zA-Z_$][\w$]*\(/);
      return m < 0 ? rest : rest.slice(0, m);
    }
    [['updateShareConfig', sliceFn(SRC, 'async function updateShareConfig')],
      ['saveReportConfig', sliceFn(SRC, 'async function saveReportConfig')],
      ['saveDashboardConfig', sliceFn(SRC, 'async function saveDashboardConfig')],
      ['Repo.upsert', sliceMethod(SRC, '  async upsert(')],
      ['Repo.bulk', sliceMethod(SRC, '  async bulk(')],
    ].forEach(([name, body]) => {
      ok(`★"${name}" 自己真的会落盘（矩阵 G 的白名单靠它成立）`,
        body.length > 20 && /(this|Repo)\.persist\(/.test(body), body.length);
    });
  }

  section('矩阵 G 补充：ACTIONS 之外，改了数据的函数也要能说清楚谁落的盘');
  {
    /* 上面那段只扫了 ACTIONS。改数据的地方还有一大半在普通函数里（任务详情保存、批量编辑、
       体检修复、导入、年度复制……）。这里把它们都揪出来，要么自己落盘，要么在白名单里写明理由。
       新增一个改数据的函数却忘了落盘时，这条会挂。 */
    const lines = SRC.split(/\r?\n/);
    const aStart = lines.findIndex(l => l.startsWith('const ACTIONS = {'));
    let aEnd = lines.length;
    for (let i = aStart + 1; i < lines.length; i++) if (lines[i] === '};') { aEnd = i; break; }
    const MUT2 = /stampMeta\(|\.deleted_at\s*=\s*new Date|DB\.(tasks|works|duties|milestones|users)\.(push|splice)|DB\.(permissionMatrix|shareConfig|reportConfig|dashboardConfig)\s*=/;
    const SAVE2 = /Repo\.(persist|bulk|upsert)|updateShareConfig\(|saveReportConfig|saveDashboardConfig/;
    const fnAt = [];
    lines.forEach((l, i) => {
      const m = l.match(/^(?:async )?function ([A-Za-z_$][\w$]*)/);
      if (m) fnAt.push({ line: i, name: m[1] });
    });
    const ownerOf = i => { let r = null; for (const f of fnAt) { if (f.line <= i) r = f; else break; } return r; };
    const bodyOf = f => {
      const next = fnAt.find(x => x.line > f.line);
      return lines.slice(f.line, next ? next.line : lines.length).join('\n');
    };
    /* 白名单——不自己落盘，但每一条都有明确的理由： */
    const EXEMPT = {
      stampMeta: '只盖元信息的工具函数，落盘是调用方的事',
      softDelete: '给 Repo.bulk(fn) 回调用的同步版本，bulk 最后统一落一次盘（函数上方有注释）',
      undelete: '同 softDelete',
      removeHard: '同 softDelete',
      migrateTaskCodes: '开机迁移，boot 里统一 if (migratedMs || migratedCodes || …) await Repo.persist(DB)',
      migrateViewDataDefault: '同上',
      migrateMilestonesToTasks: '同上',
      migrateWorkIds: '同上',
      seedAll: '正式程序里从不调用（只有测试脚手架播种用），是 dead code',
      // P105：把"勾完名下里程碑"收口成的工具函数，四个调用点（commitTaskStatus、
      // 批量改状态、双击实际完成时间、体检修复）各自负责落盘，跟 softDelete 同一类
      completeCheckpointsOf: '给调用方在 Repo.bulk/upsert 里用的同步工具函数，落盘是调用方的事',
    };
    const bad = [];
    const seen = new Set();
    lines.forEach((l, i) => {
      if (i >= aStart && i <= aEnd) return;
      if (!MUT2.test(l)) return;
      const f = ownerOf(i);
      if (!f || seen.has(f.name)) return;
      seen.add(f.name);
      if (SAVE2.test(bodyOf(f)) || EXEMPT[f.name]) return;
      bad.push(f.name);
    });
    ok(`★★ACTIONS 之外扫到 ${seen.size} 个改数据的函数，既不落盘又不在白名单里的：${bad.length} 个`,
      bad.length === 0, bad);
    // 白名单不许养僵尸：里面的名字必须真的还在源码里
    const stale = Object.keys(EXEMPT).filter(n => !fnAt.some(f => f.name === n));
    ok('★白名单里没有已经不存在的函数（免得它悄悄失效）', stale.length === 0, stale);
    ok('★开机迁移确实由 boot 统一落盘（白名单里那几条迁移函数的依据）',
      /if \(migratedMs \|\| migratedCodes \|\| migrated \|\| migratedPerm\) await Repo\.persist\(DB\);/.test(SRC));
    // 全文应当正好出现 1 次，也就是 `function seedAll() {` 那一行本身；多出来的就是真的调用了
    ok('★seedAll 确实没有被正式程序调用（白名单里那条的依据）',
      (SRC.match(/seedAll\(\)/g) || []).length === 1, (SRC.match(/seedAll\(\)/g) || []).length);
  }

  /* ================== 元信息构造 ================== */
  section('整体对象的保存：不许凭空拼一个新对象，把别的字段拼没了');
  {
    /* 这几个对象随共享文件同步给全处。重新拼一个只含已知字段的新对象，会把
       迁移标记这类元数据、以及更新版本的 html 新加的字段悄悄抹掉——
       本机看不出来，混版本期间等于用旧版把新版的字段清一次。
       权限矩阵那边早就用 {...cur} 保住了，报告页/工作台编排一直没跟上（P99 补齐）。 */
    ok('★报告页编排：先铺一层 cur',
      /const next = Object\.assign\(\{\}, cur, \{\s*\n\s*presets: clone\(reportPresets\(\)\)/.test(SRC));
    ok('★工作台编排：先铺一层 cur',
      /const next = Object\.assign\(\{\}, cur, \{\s*\n\s*presets: clone\(dashboardPresets\(\)\)/.test(SRC));
    ok('★权限矩阵：先展开 cur（这一处本来就对，钉住别被改坏）', /const next = \{\s*\n\s*\.\.\.cur,/.test(SRC));
    ok('★共享文件夹配置：先铺一层 DB.shareConfig（保住 rev，否则版本号永远是 1，见 P98）',
      /Object\.assign\(\{\}, DB\.shareConfig \|\| \{\}, effectiveShareCfg\(\), patch\)/.test(SRC));
  }

  section('账号并发覆盖：行为验证');
  {
    const U = (rev, over) => Object.assign({ name: '李兰', role: 'staff', salt: 'a', hash: 'b', iterations: 1000,
      lastSeenAt: '2026-09-01T00:00:00.000Z', lastAppVersion: 'v1',
      rev, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-09-06T10:00:00.000Z', updated_by: '甲' }, over || {});
    const E = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [], purged: [],
      permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });
    const run = (l, r) => { S.setObjConflicts([]);
      S.mergeSyncPayload(Object.assign(E(), { users: [l] }), Object.assign(E(), { users: [r] }), null);
      return S.objConflicts; };
    ok('★★同一个账号，一边改角色一边重置 PIN → 记一条冲突（原来一方的操作直接消失，一声不吭）',
      run(U(3, { role: 'comanager' }), U(3, { salt: '', hash: '', iterations: 0, updated_by: '乙' })).length === 1);
    ok('★冲突里点明了是哪个账号',
      (run(U(3, { role: 'comanager' }), U(3, { updated_by: '乙', role: 'director' }))[0] || {}).label === '账号「李兰」');
    ok('★对方 rev 更高（我根本没改过）→ 不是冲突', run(U(3), U(7, { role: 'director' })).length === 0);
    ok('★★只有心跳不同 → 绝不能报（心跳不走 stampMeta，天天变而 rev 不动，会刷屏）',
      run(U(3, { lastSeenAt: '2026-09-07T00:00:00.000Z', lastAppVersion: 'v2' }), U(3)).length === 0);
    ok('★完全相同 → 不报', run(U(3), U(3)).length === 0);
    ok('★对方没有这个账号 → 不报',
      (S.setObjConflicts([]), S.mergeSyncPayload(Object.assign(E(), { users: [U(3)] }), E(), null),
        S.objConflicts.length) === 0);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
