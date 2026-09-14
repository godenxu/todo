/* P114：第二十二轮排查——三个没正面查过的面 + 重查前一轮改动的波及

   ── 真问题（1 个，但它已经在生产数据里留下了一批坏数据） ──
   「复制到新年度」不查重，同一批工作可以被复制第二遍。
   核心循环原来是这样的：勾中哪些就 blank('work', { code: w.code, …, year: dst }) 建一份，
   完全不看目标年度是不是已经有同编号的工作。

   这不是假设出来的风险，是从真实数据里挖出来的：
     · 2026 年初管理员已经把当年的工作建好了；
     · 2026-07-21 又有人做了一次「2025 → 2026」的复制（那一批 id 前缀相同、
       updated_by 多为"未署名"，明显是一次批量动作）；
     · 于是 12 个工作编号撞车，其中 6 组是【同年度】真撞（同名、同编号、同年度）；
     · 再顺着「任务编号 = 工作编号 + 年份 + 序号」往下传，112 条任务的编号也跟着撞，
       数据体检里 dupTaskCode 报到 57 条，还是 error 级。
   为什么这条定成 error：宽表导入的「覆盖模式」按任务编号认领记录，编号一撞就会认领到
   错的那一条，把这个人的数据改到另一个人头上——错误会继续放大，而且很难发现。

   ── 查了没问题的三个新面（断言留作护栏） ──
   ① 报告图片导出的【排版】：以前只验过"不抛异常"，这次验的是画出来的东西——
      真实数据（226 任务 / 263 里程碑）下画布 2580×8040、697 段文字、零越界；
      清单超长会截断并写明"还有 180 条…"，模块标题上的总数仍是准确的 200；
      超长标题被 truncate 掉，不会横着跑出画布；空数据时有明确说明，不是一张白图。
   ② 本机偏好（DB.settings.ui，跟着整份 DB 落盘，不是独立的 key）：
      17 种脏数据——整个 ui 是字符串/数组/数字/true、taskCols 是字符串/全是废字段/混着废字段/
      空数组/含 null、widths 是字符串/数组、列宽为负/NaN/天文数字/字符串、旧版列数对不上、
      塞了不认识的键——restoreUI 和三个列表页都扛住了，脏列宽也没污染到行内样式。
   ③ 权限矩阵的极端配置：18 项权限全关掉之后管理员的 system_admin 仍然在（不会把自己锁死，
      权限页还打得开）；给员工开 system_admin 不会让他变成 admin 角色（权限和角色没混成一套）；
      未知权限键 / 不存在的角色 / 矩阵被写成字符串、数组、数字、布尔、嵌套错位，都不崩。

   ── 重查 P113 改动的波及（也留作护栏） ──
   预案并集每次都返回新对象，本来最怕它破坏"没变就别写文件"——实测静止之后不再写文件，
   并集结果也确实推回了共享文件（同事和换机器都看得到），两个方向合并结果一致（收敛得了）；
   里程碑日志填了 taskId 之后最近动态没有刷屏；本机缓存写失败时 persist 不会假装成功，
   存储恢复之后标志会自己清掉。

   用法：node test/test-p114.js */
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

const EMPTY = () => ({ duties: [], works: [], milestones: [], tasks: [], changelog: [], users: [],
  purged: [], permissionMatrix: null, shareConfig: null, reportConfig: null, dashboardConfig: null });

function world() {
  S.DB.settings.me = '管理员';
  S.DB.users = [{ name: '管理员', role: 'admin', salt: 's', hash: 'h', iterations: 1, rev: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' }];
  S.DB.permissionMatrix = null;
  S.DB.duties = [S.stampMeta(S.blank('duty', { code: '01', category: '一、前瞻研判', name: '职责一' }))];
  S.DB.works = [
    S.stampMeta(S.blank('work', { id: 'w2025a', code: '0101', duty: '01', name: 'IDC规划',
      owner: '甲', year: 2025, status: 'done' })),
    S.stampMeta(S.blank('work', { id: 'w2025b', code: '0102', duty: '01', name: '境外分行',
      owner: '乙', year: 2025, status: 'done' })),
  ];
  S.DB.tasks = []; S.DB.milestones = []; S.DB.changelog = []; S.DB.purged = [];
  S.DB.reportConfig = null; S.DB.dashboardConfig = null; S.DB.shareConfig = null;
  S.DB.settings.year = 2025;
  delete S.DB.settings.ui;
  S.clearSyncBaseline(S.DB); S.undoStack.length = 0;
  S.setFileHandle(null); S.setEverConnected(false);
  S.setSnackPriorityUntil(0); S.setLocalSaveFailedAt(0);
  S.rebuildIndex();
}
/* 走真实的年度复制路径。沙箱的 DOM 桩不解析 HTML，所以勾选框要现造：
   '.yc-cb:checked' 这个选择器返回哪些，就等于用户勾了哪些。 */
async function doCopy(dst, pickIds) {
  S.openYearCopy(); await tick(50);
  q('#yc-dst').value = String(dst);
  q('#yc-src').value = '2025';
  const o = raw.document.querySelectorAll;
  raw.document.querySelectorAll = sel => (sel === '.yc-cb:checked'
    ? (pickIds || S.DB.works.filter(w => !w.deleted_at && w.year === 2025).map(w => w.id)).map(id => ({ value: id }))
    : (o ? o(sel) : []));
  await S.modalCallback(); await tick(120);
  raw.document.querySelectorAll = o;
}
const y = n => S.DB.works.filter(w => !w.deleted_at && Number(w.year) === n);

async function main() {
  await tick(120);

  /* ═════════ ① 年度复制不许再建重复编号 ═════════ */
  section('①-1 第一次复制：正常建起来');
  {
    world();
    await doCopy(2026);
    const w26 = y(2026);
    ok('★2026 年度建了 2 项', w26.length === 2, w26.map(w => w.code + ' ' + w.name));
    ok('★编号沿用源年度（同一编号可以跨年度并存，年度复制就靠这条）',
      w26.map(w => w.code).sort().join(',') === '0101,0102', w26.map(w => w.code));
    ok('★只带工作本身，不带任务和里程碑', !S.DB.tasks.length && !S.DB.milestones.length);
  }

  section('①-2 ★★再复制一次——生产数据里发生过的正是这一幕');
  {
    S.DB.settings.year = 2025;
    q('#snack-msg').textContent = ''; S.setSnackPriorityUntil(0);
    await doCopy(2026);
    const w26 = y(2026);
    const codes = w26.map(w => w.code);
    ok('★★还是 2 项，没有被复制第二遍', w26.length === 2, w26.map(w => w.code + ' ' + w.name));
    ok('★★一个撞车的编号都没有（原来这里会闷头再建一批，'
      + '12 个工作编号撞车、112 条任务编号跟着撞、体检报 error 级 dupTaskCode 57 条）',
      new Set(codes).size === codes.length, codes);
    ok('★★而且明确告诉了用户为什么没复制，不是静默什么都不做',
      /已经有这些工作了/.test(q('#snack-msg').textContent || ''), q('#snack-msg').textContent);
    ok('★全都跳过时不写变更日志（什么都没发生，不该在日志里占一条）',
      !S.DB.changelog.some(e => /复制了 0 项/.test(e.summary || '')),
      S.DB.changelog.map(e => e.summary));
  }

  section('①-3 部分重复：该跳的跳、该来的来');
  {
    world();
    // 2026 已经有 0101 了，再从 2025 复制两项
    S.DB.works.push(S.stampMeta(S.blank('work', { id: 'w2026x', code: '0101', duty: '01',
      name: 'IDC规划', owner: '甲', year: 2026, status: 'doing' })));
    S.rebuildIndex();
    S.DB.settings.year = 2025;
    q('#snack-msg').textContent = ''; S.setSnackPriorityUntil(0);
    await doCopy(2026);
    const w26 = y(2026);
    const codes = w26.map(w => w.code).sort();
    ok('★★0102 复制过来了，0101 跳过了', codes.join(',') === '0101,0102', codes);
    ok('★没有重复编号', new Set(codes).size === codes.length, codes);
    const msg = q('#snack-msg').textContent || '';
    ok('★★提示里说清了复制几项、跳过几项', /已复制 1 项/.test(msg) && /跳过 1 项/.test(msg), msg);
    const log = S.DB.changelog.filter(e => /复制/.test(e.summary || '')).pop();
    ok('★★变更日志里也如实记了跳过的那些——事后有人问"我勾了 2 项怎么只来了 1 项"，查得到',
      log && /因为 2026 年度已经有同编号的工作而跳过/.test(log.summary)
      && /0101 IDC规划/.test(log.summary), log && log.summary);
    ok('★日志里源年度是对的，不是 0', log && /从 2025 年度/.test(log.summary), log && log.summary);

    /* 源年度下拉框读不到值时要退回默认源年度。
       不兜底的话日志里会留下一句"从 0 年度复制了 N 项工作到 2026 年度"——
       这条记录是事后追查"这批工作哪来的"的唯一线索，写着 0 年度等于没写。
       （变异测试提醒：上面那条断言里 yc-src 是有值的，测不到兜底。） */
    world();
    S.DB.settings.year = 2025;
    S.openYearCopy(); await tick(50);
    q('#yc-dst').value = '2027';
    q('#yc-src').value = '';          // 读不到
    const o2 = raw.document.querySelectorAll;
    raw.document.querySelectorAll = sel => (sel === '.yc-cb:checked'
      ? S.DB.works.filter(w => !w.deleted_at && w.year === 2025).map(w => ({ value: w.id }))
      : (o2 ? o2(sel) : []));
    await S.modalCallback(); await tick(120);
    raw.document.querySelectorAll = o2;
    const log2 = S.DB.changelog.filter(e => /复制/.test(e.summary || '')).pop();
    ok('★★源年度读不到时退回默认年度，日志里不会出现"从 0 年度"',
      log2 && !/从 0 年度/.test(log2.summary) && /从 2025 年度/.test(log2.summary),
      log2 && log2.summary);
  }

  section('①-4 目标年度那条已经被删掉了，应当允许重建（墓碑不挡路）');
  {
    world();
    const del = S.stampMeta(S.blank('work', { id: 'w2026d', code: '0101', duty: '01',
      name: 'IDC规划', owner: '甲', year: 2026, status: 'doing' }));
    del.deleted_at = new Date().toISOString();
    S.DB.works.push(del);
    S.rebuildIndex();
    S.DB.settings.year = 2025;
    await doCopy(2026);
    const codes = y(2026).map(w => w.code).sort();
    ok('★★删掉的那条不算数，0101 重建得起来', codes.join(',') === '0101,0102', codes);
  }

  section('①-5 判重只看"同年度 + 同编号"，不看名字');
  {
    world();
    // 2026 有一条同编号但改了名字的
    S.DB.works.push(S.stampMeta(S.blank('work', { id: 'w2026y', code: '0101', duty: '01',
      name: '改过名字的IDC规划', owner: '甲', year: 2026, status: 'doing' })));
    S.rebuildIndex();
    S.DB.settings.year = 2025;
    await doCopy(2026);
    const codes = y(2026).map(w => w.code);
    ok('★★名字不一样也照样算已存在（编号才是业务主键，名字可能被人改过）',
      new Set(codes).size === codes.length, y(2026).map(w => w.code + ' ' + w.name));
  }

  section('①-6 复制到一个全新的年度，一项都不该被拦');
  {
    world();
    S.DB.settings.year = 2025;
    await doCopy(2030);
    ok('★2030 年度两项都建起来了', y(2030).length === 2, y(2030).map(w => w.code));
    ok('★2025 年度原样不动', y(2025).length === 2);
  }

  section('①-7 源码层面：防重这段不能被绕过');
  {
    const i = SRC.indexOf('function openYearCopy');
    const body = SRC.slice(i, i + 6000);
    ok('★★按"同年度 + 同编号"建了一张已存在表', /const existing = new Set\(DB\.works\.filter\(w => !w\.deleted_at && Number\(w\.year\) === dst\)/.test(body));
    ok('★★已存在的被过滤掉，而不是照建不误', /const todo = ids\.filter\(id => \{/.test(body)
      && /if \(existing\.has\(String\(w\.code \|\| ''\)\)\) \{ _ycSkipped\.push/.test(body));
    ok('★★真正建记录的循环用的是过滤后的 todo，不是原来的 ids', /todo\.forEach\(id => \{/.test(body)
      && !/\n\s*ids\.forEach\(id => \{\s*\n\s*const w = byId\('work', id\);\s*\n\s*if \(!w\) return;\s*\n\s*const copy/.test(body));
    ok('★软删除的不计入已存在（!w.deleted_at）', /!w\.deleted_at && Number\(w\.year\) === dst/.test(body));
  }

  section('①-8 撞了编号之后，体检要给得出足以做决定的明细');
  {
    /* 这一项是 error 级、又【没有一键修复】——两边可能都有人在用，
       系统不知道该留哪个，只能由人决定"把谁的任务挪到谁名下、再删哪一条"。
       正因为要人来判断，明细就必须够用。原来只有一行
       `0101 IDC基础设施专项规划（2026）`：看不出撞的是哪两条、各自何时建、谁建的、
       名下多少任务——管理员对着这行根本无从下手，这一项等于报了白报。 */
    world();
    S.DB.works = [
      S.stampMeta(S.blank('work', { id: 'wA', code: '0101', duty: '01', name: 'IDC规划',
        owner: '甲', year: 2026, status: 'doing', created_at: '2026-02-17T00:00:00.000Z' })),
      S.stampMeta(S.blank('work', { id: 'wB', code: '0101', duty: '01', name: 'IDC规划',
        owner: '乙', year: 2026, status: 'doing', created_at: '2026-07-20T00:00:00.000Z' })),
    ];
    S.DB.works[0].created_at = '2026-02-17T00:00:00.000Z'; S.DB.works[0].updated_by = '卞一茗';
    S.DB.works[1].created_at = '2026-07-20T00:00:00.000Z'; S.DB.works[1].updated_by = '徐捷';
    S.DB.tasks = [];
    for (let i = 0; i < 8; i++) S.DB.tasks.push(S.stampMeta(S.blank('task',
      { id: 'ta' + i, work: 'wA', code: '01012' + i, title: 'A任务' + i, owner: '甲', status: 'doing', priority: '2' })));
    for (let i = 0; i < 9; i++) S.DB.tasks.push(S.stampMeta(S.blank('task',
      { id: 'tb' + i, work: 'wB', code: '01013' + i, title: 'B任务' + i, owner: '乙', status: 'doing', priority: '2' })));
    S.DB.settings.year = 2026;
    S.rebuildIndex();
    const item = S.healthCheck().issues.find(i => i.k === 'dupCode');
    ok('★体检确实报了这一项', !!item && item.n === 1, item && item.n);
    const labels = (item.items || []).map(x => x.label);
    ok('★★撞车的两条都摆出来了，不是只列一条', labels.length === 2, labels);
    ok('★★各自名下有多少任务写清楚了（这是判断"哪条在用"的关键）',
      labels.some(l => /名下 8 条任务/.test(l)) && labels.some(l => /名下 9 条任务/.test(l)), labels);
    ok('★★谁建的、什么时候建的也写了', labels.some(l => /卞一茗/.test(l)) && labels.some(l => /徐捷/.test(l)), labels);
    /* 先建 / 后建的标注必须是真的。这一段原来没有按创建时间排序，
       seen 里留下的只是"数组里恰好靠前的那条"，于是把 7 月建的标成了"先建"、
       2 月建的标成"后建"——标反了比不标更糟，管理员会照着删错那一条。 */
    const first = labels.find(l => /先建于/.test(l)) || '';
    const later = labels.find(l => /后建于/.test(l)) || '';
    /* 不写死具体日期：localDay 按本地时区折算，UTC 午夜的时间戳在不同时区会落到前一天，
       测试不该被运行环境的时区绑住。真正要守的契约是"先建的那条日期确实更早"。 */
    const dFirst = (first.match(/先建于 (\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    const dLater = (later.match(/后建于 (\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    ok('★★"先建/后建"标的是真的（原来这段没按创建时间排序，'
      + '把 7 月建的那条标成了"先建"——标反了比不标更糟，管理员会照着删错那一条）',
      !!dFirst && !!dLater && dFirst < dLater, { 先建: dFirst, 后建: dLater });
    ok('★名下任务数跟各自那一条对得上（8 条的是先建的、9 条的是后建的）',
      /名下 8 条任务/.test(first) && /名下 9 条任务/.test(later), { first, later });
    ok('★每一行都能点进去看那条工作', (item.items || []).every(x => x.act === 'focus-record' && x.entity === 'work'));
    ok('★★说明里讲清了危害（任务编号跟着撞 → 宽表导入按编号认领会认错人）',
      /任务编号/.test(item.msg) && /覆盖模式|认领/.test(item.msg), String(item.msg).slice(0, 80));
    ok('★也讲清了为什么不给一键修复', /不提供一键修复|由你决定/.test(item.msg));
    ok('★这一项仍然没有一键修复（系统不该替人决定删哪条）', !item.fix);
    let err = '';
    try { S.setPage('data'); S.renderPage(); } catch (e) { err = e.message; }
    ok('★数据页画得出来', !err, err);
  }

  /* ═════════ ② 报告图片的排版（新面，留作护栏） ═════════ */
  section('②-1 报告图片：真的画出了内容，而不只是"没抛异常"');
  {
    world();
    const T = S.todayStr();
    // world() 为了测年度复制把当前年度设成了 2025，而报告是按当前年度取数的——
    // 不切回来的话后面那些任务/工作根本不在视野里，模块标题会显示成"（0）"
    S.DB.settings.year = new Date().getFullYear();
    S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
      owner: '管理员', year: new Date().getFullYear(), status: 'doing' }))];
    S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'T1', work: 'w1', code: '0101261',
      title: '本周完成的任务XYZ', owner: '管理员', status: 'done', priority: '2',
      progress: 100, plan_date: T, actual_date: T }))];
    S.DB.milestones = [S.stampMeta(S.blank('milestone', { id: 'M1', task: 'T1', plan_date: T,
      deliverable: '本周交付的材料ABC', report_level: 'bank', done: '1', actual_date: T }))];
    // 把两个清单模块显式放进编排（默认编排里没有它们）
    S.DB.reportConfig = S.stampMeta({ activeId: 'p1', presets: [{ id: 'p1', name: '清单',
      sections: [{ id: 's1', title: '本期成果', modules: ['doneTasks', 'deliveredMs'] }] }] });
    S.rebuildIndex();
    let err = '';
    try { await S.exportReportImage(); await tick(120); } catch (e) { err = e.message; }
    const cv = raw.document._lastCanvas;
    const calls = (cv && cv._ctx && cv._ctx._calls) || [];
    const texts = calls.filter(c => c.op === 'fillText').map(c => String(c.args[0]));
    ok('导出不抛异常', !err, err);
    ok('★★确实画了东西（"不抛异常"完全看不出图是不是白的）', texts.length > 0, texts.length);
    ok('★★图里有本期完成的任务标题', texts.some(t => /本周完成的任务XYZ/.test(t)));
    ok('★★图里有本期交付的里程碑', texts.some(t => /本周交付的材料ABC/.test(t)));
    ok('★图里有统计周期抬头', texts.some(t => /统计周期/.test(t)));
  }

  section('②-2 报告图片：文字和面板都不许画到画布外面');
  {
    const cv = raw.document._lastCanvas;
    const calls = (cv && cv._ctx && cv._ctx._calls) || [];
    const W = Number(cv.width) || 0, H = Number(cv.height) || 0;
    // 字宽按 harness 的 measureText 桩（字符数 × 6.5）估
    const over = calls.filter(c => c.op === 'fillText').filter(c => {
      const x = Number(c.args[1]) || 0, y0 = Number(c.args[2]) || 0;
      return x < 0 || y0 < 0 || y0 > H || (x + String(c.args[0] || '').length * 6.5) > W + 2;
    });
    ok('★★没有文字越界', over.length === 0,
      over.slice(0, 3).map(c => String(c.args[0]).slice(0, 20) + '@x' + c.args[1]));
    const rects = calls.filter(c => ['fillRect', 'strokeRect', 'roundRect'].includes(c.op));
    const badRect = rects.filter(c => {
      const x = Number(c.args[0]) || 0, y0 = Number(c.args[1]) || 0;
      const w = Number(c.args[2]) || 0, h = Number(c.args[3]) || 0;
      return x < 0 || y0 < 0 || x + w > W + 2 || y0 + h > H + 2;
    });
    ok('★面板框也都在画布内', badRect.length === 0, badRect.length);
  }

  section('②-3 报告图片：清单太长要截断，但总数不能说谎');
  {
    world();
    const T = S.todayStr();
    // world() 为了测年度复制把当前年度设成了 2025，而报告是按当前年度取数的——
    // 不切回来的话后面那些任务/工作根本不在视野里，模块标题会显示成"（0）"
    S.DB.settings.year = new Date().getFullYear();
    S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
      owner: '管理员', year: new Date().getFullYear(), status: 'doing' }))];
    S.DB.tasks = []; S.DB.milestones = [];
    for (let i = 1; i <= 200; i++) {
      S.DB.tasks.push(S.stampMeta(S.blank('task', { id: 'T' + i, work: 'w1',
        code: '0101' + String(i).padStart(3, '0'), title: '任务标题' + i, owner: '管理员',
        status: 'done', priority: '2', progress: 100, plan_date: T, actual_date: T })));
    }
    S.DB.reportConfig = S.stampMeta({ activeId: 'p1', presets: [{ id: 'p1', name: '清单',
      sections: [{ id: 's1', title: '本期成果', modules: ['doneTasks'] }] }] });
    S.rebuildIndex();
    await S.exportReportImage(); await tick(150);
    const cv = raw.document._lastCanvas;
    const texts = ((cv && cv._ctx && cv._ctx._calls) || []).filter(c => c.op === 'fillText')
      .map(c => String(c.args[0]));
    const drawn = texts.filter(t => /^任务标题\d+$/.test(t)).length;
    ok('★确实截断了（没把 200 条全画上去）', drawn > 0 && drawn < 200, drawn);
    ok('★★模块标题上的总数仍然是真实的 200（截断的是显示，不是统计）',
      texts.some(t => /本期已完成任务（200）/.test(t)), texts.filter(t => /本期已完成/.test(t)));
    ok('★★而且明说了"还有多少条没显示"——不说的话，管理员会以为报告就这些内容',
      texts.some(t => /还有 \d+ 条/.test(t)), texts.filter(t => /还有/.test(t)));
    const W = Number(cv.width), H = Number(cv.height);
    ok('★★画布尺寸在浏览器的安全范围内（超过约 32767 会整张变全黑，'
      + '而且不报错——用户看到"导出成功"，打开却是废图）', W < 32767 && H < 32767, { W, H });
  }

  section('②-4 报告图片：超长标题要截断，空数据要说明');
  {
    world();
    const T = S.todayStr();
    // world() 为了测年度复制把当前年度设成了 2025，而报告是按当前年度取数的——
    // 不切回来的话后面那些任务/工作根本不在视野里，模块标题会显示成"（0）"
    S.DB.settings.year = new Date().getFullYear();
    S.DB.works = [S.stampMeta(S.blank('work', { id: 'w1', code: '0101', duty: '01', name: '工作一',
      owner: '管理员', year: new Date().getFullYear(), status: 'doing' }))];
    S.DB.tasks = [S.stampMeta(S.blank('task', { id: 'TL', work: 'w1', code: '0101999',
      title: '这是一条特别特别长的任务标题'.repeat(20), owner: '管理员', status: 'done',
      priority: '2', progress: 100, plan_date: T, actual_date: T }))];
    S.DB.milestones = [];
    S.DB.reportConfig = S.stampMeta({ activeId: 'p1', presets: [{ id: 'p1', name: '清单',
      sections: [{ id: 's1', title: '本期成果', modules: ['doneTasks'] }] }] });
    S.rebuildIndex();
    await S.exportReportImage(); await tick(100);
    let cv = raw.document._lastCanvas;
    let calls = (cv && cv._ctx && cv._ctx._calls) || [];
    const W1 = Number(cv.width);
    const over = calls.filter(c => c.op === 'fillText')
      .filter(c => (Number(c.args[1]) || 0) + String(c.args[0] || '').length * 6.5 > W1 + 2);
    ok('★★超长标题被截断，不会横着跑出画布', over.length === 0,
      over.slice(0, 2).map(c => String(c.args[0]).slice(0, 24)));

    // 空数据
    S.DB.tasks = []; S.DB.milestones = []; S.DB.reportConfig = null;
    S.rebuildIndex();
    let err = '';
    try { await S.exportReportImage(); await tick(100); } catch (e) { err = e.message; }
    cv = raw.document._lastCanvas;
    const texts = ((cv && cv._ctx && cv._ctx._calls) || []).filter(c => c.op === 'fillText')
      .map(c => String(c.args[0]));
    ok('空数据导出不抛异常', !err, err);
    ok('★★空数据时不是一张纯白图，有话说', texts.length > 0 && texts.some(t => /无|没有|空|—/.test(t)),
      texts.slice(0, 5));
  }

  /* ═════════ ③ 本机偏好的健壮性（新面，留作护栏） ═════════ */
  section('③ 本机偏好（DB.settings.ui）存着脏东西时不许把页面搞坏');
  {
    /* 注意这份偏好存在 DB.settings.ui 里、跟着整份 DB 落盘，不是一个独立的 localStorage key。
       第一版探针把它当成了独立 key（todo_v4_ui）去写脏数据，restoreUI 根本读不到，
       七个用例全绿是假绿——这一节是重做的。 */
    const cases = [
      ['整个 ui 是字符串', '坏了'],
      ['整个 ui 是数组', [1, 2, 3]],
      ['整个 ui 是数字', 42],
      ['整个 ui 是 true', true],
      ['taskCols 是字符串', { taskCols: 'title,owner' }],
      ['taskCols 全是上一版才有的废字段', { taskCols: ['这列早删了', '那列也没了'] }],
      ['taskCols 混着有效和无效', { taskCols: ['title', '早删了', 'owner'] }],
      ['taskCols 是空数组', { taskCols: [] }],
      ['taskCols 里有 null / 数字', { taskCols: [null, 3, 'title'] }],
      ['widths 是字符串', { widths: '坏了' }],
      ['widths.tasks 是数组', { widths: { tasks: [1, 2] } }],
      ['列宽是负数', { widths: { tasks: { title: -500 } } }],
      ['列宽是 NaN', { widths: { tasks: { title: NaN } } }],
      ['列宽大到离谱', { widths: { tasks: { title: 99999999 } } }],
      ['列宽是字符串', { widths: { tasks: { title: '很宽' } } }],
      ['workCols 只剩一半（旧版列数对不上）', { workCols: ['code'] }],
      ['塞了一堆不认识的键', { 未来版本的字段: 1, taskCols: ['title'] }],
    ];
    let bad0 = 0;
    for (const [name, ui] of cases) {
      world();
      S.DB.settings.ui = ui;
      let err = '', rerr = '';
      try { S.restoreUI(); } catch (e) { err = e.message; }
      try {
        S.setPage('tasks'); S.renderPage();
        S.setPage('works'); S.renderPage();
        S.setPage('duties'); S.renderPage();
        S.renderDashboard();
      } catch (e) { rerr = e.message; }
      if (err || rerr) { bad0++; console.log('    ❌ ' + name + '：' + (err || rerr)); }
    }
    ok('★★17 种脏偏好，restoreUI 和三个列表页全都扛住了（这份偏好跨版本留在浏览器里，'
      + '换新版 html 之后必然遇到对不上的字段，一抛异常整个页面就打不开，'
      + '而用户根本不知道该去清哪里）', bad0 === 0, bad0 + ' 种出问题');

    // 脏列宽不能污染到行内样式
    world();
    S.DB.settings.ui = { widths: { tasks: { title: -500, owner: NaN, code: '很宽' } } };
    S.restoreUI();
    let html = '';
    try { S.setPage('tasks'); S.renderPage(); html = q('#page-tasks').innerHTML || ''; }
    catch (e) { html = '异常'; }
    ok('★★负数/NaN 的列宽没有被原样写进行内样式（写进去表格会塌掉或整列看不见）',
      !/width:\s*-\d/.test(html) && !/width:\s*NaN/.test(html));
  }

  /* ═════════ ④ 权限矩阵的极端配置（新面，留作护栏） ═════════ */
  section('④-1 把 18 项权限全关掉，不能把管理员自己锁死');
  {
    world();
    const allPerms = (S.PERMISSIONS || []).map(p => p.key);
    const m = {};
    ['staff', 'comanager', 'director', 'gm', 'admin'].forEach(r => {
      m[r] = {}; allPerms.forEach(k => { m[r][k] = false; });
    });
    S.DB.permissionMatrix = S.stampMeta(m);
    S.rebuildIndex();
    ok('★★管理员的系统管理权限关不掉（关得掉的话权限页从此打不开，'
      + '谁也改不回来，只能手工去改共享文件里的 JSON 才能救）', S.hasPermission('system_admin'));
    ok('★管理员的其它权限也都还在（hasPermission 对 admin 有兜底）',
      allPerms.every(k => S.hasPermission(k)), allPerms.filter(k => !S.hasPermission(k)));
    let err = '';
    try { S.setPage('tasks'); S.renderPage(); S.setPage('data'); S.renderPage(); S.renderDashboard(); }
    catch (e) { err = e.message; }
    ok('★权限全关之后页面照样渲染得出来', !err, err);
  }

  section('④-2 给员工开 system_admin，不等于把他变成管理员');
  {
    world();
    S.DB.settings.me = '小员工';
    S.DB.users.push({ name: '小员工', role: 'staff', salt: 's', hash: 'h', iterations: 1, rev: 1,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', updated_by: '管理员' });
    S.DB.permissionMatrix = S.stampMeta({ staff: { system_admin: true } });
    S.rebuildIndex();
    ok('权限确实开了', S.hasPermission('system_admin'));
    ok('★★但角色还是员工——权限归权限、角色归角色，没混成一套'
      + '（混了的话，那些按角色把关的动作 requireRole(admin) 会跟着一起放行）',
      !S.roleAtLeast('admin'), S.myRole());
  }

  section('④-3 矩阵被写坏时不许把页面带崩（那份 JSON 谁都能用记事本改）');
  {
    const cases = [['字符串', '坏了'], ['数组', [1, 2]], ['数字', 42], ['布尔', true],
      ['嵌套错位', { staff: '不是对象' }],
      ['未知权限键和不存在的角色', { staff: { 这个权限不存在: true, view_data: true },
        不存在的角色: { system_admin: true } }]];
    let bad0 = 0;
    for (const [name, v] of cases) {
      world();
      S.DB.permissionMatrix = v;
      S.rebuildIndex();
      let err = '';
      try {
        S.hasPermission('view_data'); S.myRole();
        S.setPage('tasks'); S.renderPage();
        S.setPage('data'); S.renderPage();
        S.renderDashboard();
      } catch (e) { err = e.message; }
      if (err) { bad0++; console.log('    ❌ 矩阵是' + name + '：' + err); }
    }
    ok('★★六种写坏的矩阵都不会把页面带崩，权限页还打得开（它是改回来的唯一入口）',
      bad0 === 0, bad0 + ' 种出问题');
  }

  /* ═════════ ⑤ 重查 P113 改动的波及（护栏） ═════════ */
  section('⑤-1 预案并集没有破坏"没变就别写文件"');
  {
    world();
    let FILE = null;
    const handle = { name: 'shared.json', _mtime: 1, _writes: 0,
      async getFile() { const s = FILE; return { lastModified: handle._mtime, text: async () => s }; },
      async createWritable() { return { async write(t) { handle._p = t; },
        async close() { FILE = handle._p; handle._mtime++; handle._writes++; } }; } };
    S.DB.reportConfig = { rev: 3, created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z', updated_by: '管理员', activeId: 'p_mine',
      presets: [{ id: 'p_mine', name: '我的', blocks: ['a'] }] };
    FILE = JSON.stringify(Object.assign(EMPTY(), { schemaVersion: S.DATA_SCHEMA_VERSION,
      writeId: 'w0', writeIds: ['w0'],
      reportConfig: { rev: 9, created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-09-02T00:00:00.000Z', updated_by: '同事', activeId: 'p_his',
        presets: [{ id: 'p_his', name: '他的', blocks: ['x'] }] },
      tasks: cp(S.DB.tasks), works: cp(S.DB.works), duties: cp(S.DB.duties),
      milestones: cp(S.DB.milestones), users: cp(S.DB.users) }));
    S.setFileHandle(handle); S.setEverConnected(true);
    for (let i = 0; i < 6; i++) { await S.Repo.persist(S.DB); await tick(40); }
    const w1 = handle._writes;
    for (let i = 0; i < 5; i++) { await S.Repo.persist(S.DB); await tick(30); }
    ok('★★静止之后不再反复写文件（并集每次都返回新对象，'
      + '判不好就会变成两台机器你推我、我推你地无休止写）', handle._writes === w1,
      { 之前: w1, 之后: handle._writes });
    const inFile = ((JSON.parse(FILE).reportConfig || {}).presets || []).map(p => p.name);
    ok('★★并集的结果确实推回了共享文件（只在本机保住等于没保住——'
      + '同事看不到，换台机器或清了缓存就真没了）', inFile.includes('我的') && inFile.includes('他的'), inFile);
    S.setFileHandle(null); S.setEverConnected(false);
  }

  section('⑤-2 两个方向合并结果一致（收敛得了）');
  {
    const A = { rev: 5, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-09-03T00:00:00.000Z',
      updated_by: 'A', activeId: 'p_keep',
      presets: [{ id: 'p_keep', name: '留着的' }, { id: 'p_del', name: '另一套' }] };
    const B = { rev: 6, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-09-04T00:00:00.000Z',
      updated_by: 'B', activeId: 'p_keep', presets: [{ id: 'p_keep', name: '留着的' }] };
    const m1 = S.mergePermissionMatrix(cp(A), cp(B), '报告页编排');
    const m2 = S.mergePermissionMatrix(cp(B), cp(A), '报告页编排');
    ok('★★两个方向合出来的预案集合一致（不一致的话两台机器永远收敛不了）',
      (m1.presets || []).length === (m2.presets || []).length
      && (m1.presets || []).map(p => p.id).sort().join(',') === (m2.presets || []).map(p => p.id).sort().join(','),
      { a: (m1.presets || []).map(p => p.id), b: (m2.presets || []).map(p => p.id) });

    /* 合并不许就地改传进来的那两份。远端那份很可能就是刚从文件里读出来的对象，
       改了它，紧接着 buildSyncBase 拍下来的基线就跟文件里躺着的不是一回事了——
       这个坑 P97 专门踩过。上面只测了幂等（写文件次数），测不出就地改，
       因为改的是本机那份、下一轮比较时两边反而一致了（变异测试抓到过）。 */
    const L = { rev: 4, updated_at: '2026-09-13T12:00:00.000Z', activeId: 'p1',
      presets: [{ id: 'p1', name: '我的' }] };
    const R = { rev: 9, updated_at: '2026-09-13T14:00:00.000Z', activeId: 'p2',
      presets: [{ id: 'p2', name: '他的' }] };
    const Lb = JSON.stringify(L), Rb = JSON.stringify(R);
    S.mergePermissionMatrix(L, R, '报告页编排');
    ok('★★没有就地改掉远端那份（它可能就是文件里读出来的对象，改了基线就会跟文件对不上）',
      JSON.stringify(R) === Rb, R.presets);
    ok('★★也没有就地改掉本机那份', JSON.stringify(L) === Lb, L.presets);
  }

  section('⑤-3 本机缓存写失败时 persist 不假装成功，恢复后标志自己清掉');
  {
    world();
    const store = S.storage, orig = store.setItem;
    let blockN = 2;
    store.setItem = function (k, v) {
      if (k === S.STORAGE_KEY && blockN-- > 0) { const e = new Error('Quota'); e.name = 'QuotaExceededError'; throw e; }
      return orig.call(store, k, v);
    };
    S.setLocalSaveFailedAt(0);
    const r1 = await S.Repo.persist(S.DB); await tick(40);
    const midBroken = S.localCacheBroken();
    await S.Repo.persist(S.DB); await tick(40);
    const r3 = await S.Repo.persist(S.DB); await tick(40);
    store.setItem = orig;
    ok('★写失败时 persist 返回 false，没有假装成功', r1 === false);
    ok('★失败期间记了标志', midBroken);
    ok('★★存储恢复之后标志自己清掉了（清不掉的话，数据页会一直挂着警告，'
      + '几次之后就没人再信它了）', !S.localCacheBroken() && r3 === true, S.localSaveFailedAt);
    S.setLocalSaveFailedAt(0);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
