/* ============================================================================
   演示 / 测试数据生成器
   ----------------------------------------------------------------------------
   用途：在【非生产环境】里造一份完整的共享数据文件，把系统的每个功能都覆盖到，
         用来做功能验收、培训演示、以及复现问题时的干净起点。

   为什么单独写一个脚本、而不是在页面里加个"生成演示数据"按钮：
     生产环境跑着全处几个月的真实数据，页面里多一个能一键清空重建的入口，
     误点一次就是事故。放在命令行里，只有拿到代码仓库的人才碰得到。

   实现方式：直接复用 index.html 自己的那套函数（blank/stampMeta/normalize/
     nextTaskCode/recalcProgress/syncPayload/filePayload），通过 test/harness.js
     的 Node 沙盒加载。好处是生成出来的记录跟程序自己写出来的一模一样——
     字段名、默认值、编号规则、载荷结构都不会跟真实代码走偏。

   用法：
     node tools/gen-demo-data.js                     # 输出到 demo/科技规划处工作管理.json
     node tools/gen-demo-data.js  D:/某目录/x.json   # 输出到指定路径

   注意：数据里的"逾期/今日到期/本周到期/本期已交付"这些是【按生成当天】算出来的相对日期。
         隔一段时间再用，重新跑一遍这个脚本即可，日期会自动跟着挪。
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const { sandbox: S } = require(path.join(__dirname, '..', 'test', 'harness.js'));

const OUT = process.argv[2] || path.join(__dirname, '..', 'demo', '科技规划处工作管理.json');
const DEMO_PIN = '123456';                    // 演示账号统一 PIN，README 里写明
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

/* ---------- 可重现的伪随机：同一份代码每次生成的数据形状一致，方便比对 ---------- */
let _seed = 20260906;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const chance = p => rnd() < p;
const pickN = (a, n) => {                     // 不重复地取 n 个
  const c = a.slice(), out = [];
  while (out.length < n && c.length) out.push(c.splice(Math.floor(rnd() * c.length), 1)[0]);
  return out;
};

const DB = S.DB;

/* 时间戳：相对今天偏移若干天的某个时刻（ISO 串，跟程序写出来的格式一致） */
function iso(dayOffset, hour) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour === undefined ? 9 + Math.floor(rnd() * 9) : hour, Math.floor(rnd() * 60), Math.floor(rnd() * 60), 0);
  return d.toISOString();
}
/* 盖元信息：走程序自己的 stampMeta（保证字段齐全），再把时间改成我们要的那个点。
   updated_by 靠临时改 DB.settings.me 来指定——stampMeta 就是这么取值的。 */
function stamp(rec, by, createdOffset, updatedOffset) {
  DB.settings.me = by || '徐捷';
  S.stampMeta(rec);
  if (createdOffset !== undefined) rec.created_at = iso(createdOffset);
  if (updatedOffset !== undefined) rec.updated_at = iso(updatedOffset);
  if (rec.created_at > rec.updated_at) rec.updated_at = rec.created_at;
  rec.rev = 1 + Math.floor(rnd() * 4);        // 让版本号有真实的分布，不是清一色 1
  return rec;
}

/* ============================================================================
   一、人员
   ========================================================================== */
// 处里现有的同事（沿用真实姓名，方便他们对号入座地试）
const REAL_PEOPLE = ['凌象政', '卞一茗', '孙宇颉', '徐捷', '朱轶杰', '李兰',
  '梁怡飞', '蒋双樑', '诸慧玲', '邱洋', '郭妙吉'];
// 为了把"人多起来之后"的分组、矩阵、负荷这些视图撑满，另外虚构 5 个人
const FAKE_PEOPLE = ['赵启明', '钱思远', '周雨桐', '吴敬轩', '何昀'];
const PEOPLE = REAL_PEOPLE.concat(FAKE_PEOPLE);

/* 账号：五种角色都要有真人能登进去试，另外留两个"待首次登录自己设 PIN"的，
   还有一个已停用（软删除）的，覆盖账号页的三种状态。 */
const ACCOUNTS = [
  ['徐捷',   'admin',     true],
  ['邱洋',   'director',  true],
  ['孙宇颉', 'gm',        true],
  ['卞一茗', 'comanager', true],
  ['赵启明', 'comanager', true],
  ['朱轶杰', 'staff',     true],
  ['蒋双樑', 'staff',     true],
  ['凌象政', 'staff',     true],
  ['李兰',   'staff',     true],
  ['梁怡飞', 'staff',     true],
  ['诸慧玲', 'staff',     true],
  ['郭妙吉', 'staff',     true],
  ['周雨桐', 'staff',     true],
  ['何昀',   'staff',     true],
  ['钱思远', 'staff',     false],   // 还没设过 PIN，登录时走"首次设置"流程
  ['吴敬轩', 'staff',     false],
];
const RETIRED_ACCOUNT = ['韩梅', 'staff'];   // 已停用账号

/* ============================================================================
   二、职责（15 条真实职责 + 1 条已删除）
   ========================================================================== */
const DUTIES = [
  ['01', '二、集团治理', '企业级科技发展规划'],
  ['02', '一、前瞻研判', '前沿新技术专题研究'],
  ['03', '一、前瞻研判', 'Gartner资讯服务'],
  ['04', '三、价值共创', '全行数智化转型与数字金融，配合绿色金融大文章工作'],
  ['05', '二、集团治理', '集团科技治理'],
  ['06', '三、价值共创', '专利和计算机软件著作权的申报与管理'],
  ['07', '三、价值共创', '重要科技成果的申报'],
  ['08', '二、集团治理', '科技资源数智化精细管理'],
  ['09', '二、集团治理', '信创建设'],
  ['10', '四、其它工作', '总控PMO工作'],
  ['11', '四、其它工作', '信息科技管理委员会办公室、全行数字化转型领导小组办公室、安全可靠能力建设推进领导小组办公室等日常工作'],
  ['12', '二、集团治理', '技术标准管理体系'],
  ['13', '二、集团治理', '软件正版化管理'],
  ['14', '一、前瞻研判', '外部生态协同'],
  ['15', '四、其它工作', '其它领导交办的工作'],
];
const DELETED_DUTY = ['16', '四、其它工作', '（已撤销）临时性专项支援工作'];

/* ============================================================================
   三、工作
   前 13 条沿用处里真实的工作（内容照抄），后面 13 条是为了让 06—15 号职责
   底下也有工作、让虚构的同事也有活干而补的，内容按同类工作的口吻写。
   [编号, 职责, 名称, 主要内容(数组), 牵头人, 参与人, 状态]
   ========================================================================== */
const PLAN_CYCLE = '建成"规划-执行-督办-评估-优化"全周期闭环管理机制，实现科技规划执行全程可追溯、成效可量化、问题可预警、改进可持续。';
const REAL_WORKS = [
  ['0101', '01', 'IDC基础设施专项规划', ['完成IDC基础设施专项规划的编制和发布。', PLAN_CYCLE], '卞一茗', ['李兰', '诸慧玲'], 'doing'],
  ['0102', '01', '境外分行专项规划', ['完成境外分行专项规划的编制和发布。', PLAN_CYCLE], '孙宇颉', ['郭妙吉'], 'doing'],
  ['0201', '02', '前沿新技术专题研究', [], '徐捷', ['朱轶杰', '蒋双樑'], 'doing'],
  ['0202', '02', '行业信息技术动态汇编月报', [
    '行业信息技术动态汇编。每月汇总Gartner、信通院等外部渠道技术动态进行的常态化技术报告汇编，报送行领导并于数字浦发发布。',
    '热点技术趋势专题报告撰写。为紧跟前沿科技发展态势，根据时下热点技术与发布（如Gartner十大技术趋势等）进行专题报告撰写。',
    '根据需要，组织开展专题技术讲座。'], '朱轶杰', ['周雨桐'], 'doing'],
  ['0203', '02', '研究课题管理', ['根据浦银研究院通知要求，组织牵头总行科技发展部内部研究工作征集、初稿审批、进度跟踪等。'], '朱轶杰', [], 'hold'],
  ['0301', '03', 'Gartner服务账号的采购与管理', ['Gartner服务账号的采购与管理。'], '蒋双樑', [], 'doing'],
  ['0302', '03', 'Gartner每年全球峰会和重要大型会议的组织参与', ['Gartner每年全球峰会和重要大型会议的组织参与。'], '蒋双樑', ['何昀'], 'done'],
  ['0303', '03', 'Gartner银行业资讯周报', ['根据各单位需求，邀约Gartner分析师进行沟通交流。'], '蒋双樑', [], 'doing'],
  ['0401', '04', '数字化转型指标体系', ['根据行领导和部门领导要求，结合人行关于数字化智能化转型通知、数字化评估指引和我行各项战略规划，重新梳理全行数字化转型指标体系，并开展常态化跟踪和报送。'], '邱洋', ['梁怡飞', '凌象政'], 'doing'],
  ['0402', '04', '数字化转型领导小组办公室及数字化转型相关的其它任务', [
    '有效推进全行数字化转型领导小组办公室日常运作。', '编制数字化规划和数字化总结。',
    '细化分解任务并定期跟踪监测。', '落实各类"数字化转型"相关工作。'], '邱洋', ['梁怡飞', '凌象政'], 'doing'],
  ['0403', '04', '数字金融', [
    '监管报表报送：S74数字领域相关情况统计表（金融统计监管报送系统）、数字经济贷款汇总指标数据（人行金融基础数据报送系统）。',
    '人行数字金融服务质效通报工作。',
    '"数字金融"相关的其它任务（对外披露信息反馈、数字金融专家委员会征集、支持分行数字金融情况材料报送等）。'], '蒋双樑', [], 'doing'],
  ['0404', '04', '绿金委和ESG相关工作', ['配合公司业务部牵头的绿金委工作。', '配合浦银研究院牵头的ESG工作。'], '凌象政', [], 'done'],
  ['0501', '05', '全面实现系统压降工作目标（分行系统集成压降）', [
    '严控新建系统，参与分行及子公司新建系统的立项与审批流程，杜绝系统重复建设。',
    '制定分行及子公司每年的系统压降计划，构建可量化的系统压降里程碑视图。',
    '负责建立系统压降工作的常态化跟踪督办机制，定期检查执行进度，协调解决推进过程中的问题，确保年度压降任务按期完成。'], '孙宇颉', ['诸慧玲', '卞一茗'], 'doing'],

];
/* ★ 以下是【纯属虚构】的工作，为了让 06—15 号职责底下也有内容、让虚构的同事也有活干而补的。
   单独一个数组、不跟上面处里真实的 13 项混在一起——这样"哪些是造出来的"在代码里一眼可见。
   万一演示数据不小心混进了真实数据（这事真发生过一次：本机缓存着真实数据的浏览器直接连了演示文件夹），
   tools/audit-demo-mix.js 能照着这份名单把假数据盘出来。 */
const EXTRA_WORKS = [
  ['0502', '05', '集团子公司科技治理评估', [
    '按季度组织子公司科技治理成熟度自评。', '汇总形成集团科技治理评估报告并报部门领导。'], '诸慧玲', ['赵启明'], 'doing'],
  ['0601', '06', '专利与软件著作权申报管理', [
    '组织全处专利挖掘与申报，跟踪授权进度。', '软件著作权登记的材料准备与报送。'], '周雨桐', ['赵启明'], 'doing'],
  ['0602', '06', '知识产权年度盘点与激励', ['开展知识产权年度盘点，形成台账。', '拟定科技创新激励方案建议。'], '赵启明', ['何昀'], 'doing'],
  ['0701', '07', '重要科技成果申报', [
    '梳理年度可申报的科技成果清单。', '组织银行业科技发展奖等重点奖项的材料撰写与报送。'], '钱思远', ['李兰'], 'doing'],
  ['0801', '08', '科技资源数智化台账建设', [
    '建立科技人力、资金、系统三类资源的统一台账。', '按月更新并向部门领导报送资源使用情况。'], '梁怡飞', ['吴敬轩'], 'doing'],
  ['0802', '08', '科技投入产出分析', ['开展科技投入产出年度分析。', '形成分析报告并提出优化建议。'], '吴敬轩', [], 'doing'],
  ['0901', '09', '信创终端与办公系统替代推进', [
    '制定年度信创终端替代计划并按月跟踪。', '协调解决替代过程中的适配问题。'], '郭妙吉', ['何昀', '周雨桐'], 'doing'],
  ['0902', '09', '信创基础软件适配验证', ['组织数据库、中间件的信创适配验证。', '形成适配验证报告与推广建议。'], '何昀', [], 'doing'],
  ['1001', '10', '总控PMO例会与督办', [
    '组织总控PMO周例会，形成会议纪要。', '对重点项目里程碑进行常态化督办。'], '诸慧玲', ['钱思远'], 'doing'],
  ['1101', '11', '信息科技管理委员会办公室日常工作', [
    '承办信息科技管理委员会会议的议题征集、材料汇总与会议组织。', '跟踪委员会决议事项的落实情况。'], '李兰', ['凌象政'], 'doing'],
  ['1201', '12', '技术标准管理体系建设', [
    '梳理现行技术标准清单，识别缺口。', '组织新增技术标准的编制与评审发布。'], '赵启明', ['孙宇颉'], 'doing'],
  ['1301', '13', '软件正版化年度核查', ['开展全行软件正版化年度核查。', '形成核查报告并推动问题整改。'], '吴敬轩', [], 'doing'],
  ['1401', '14', '外部生态协同与联合创新', [
    '对接高校与科技企业，推进联合创新课题。', '组织外部技术交流与生态合作洽谈。'], '周雨桐', ['朱轶杰'], 'doing'],
  ['1501', '15', '领导交办的临时事项', ['承接行领导、部门领导临时交办的各类事项。'], '徐捷', ['钱思远'], 'doing'],
];
const WORKS = REAL_WORKS.concat(EXTRA_WORKS);

// 去年（用于测试"年度筛选"和"复制到新年度"：目标年度里已经有一批干完的工作）
const LAST_YEAR_WORKS = ['0101', '0201', '0202', '0301', '0401', '0501'];
// 已停用（软删除）的工作，用于测试回收站与数据体检
const DELETED_WORK = ['0503', '05', '（已停用）科技治理试点专项', ['试点范围调整，本项工作已停用。'], '孙宇颉', [], 'doing'];

/* ============================================================================
   四、任务模板与"覆盖用例"
   每条任务按一个用例生成，用例列表保证每种边界情况都至少出现好几次。
   ========================================================================== */
const TASK_TPL = [
  ['编制{n}实施方案', '实施方案'], ['{n}内部评审', '评审纪要'], ['{n}数据收集与整理', '数据台账'],
  ['{n}材料报送', '报送回执'], ['{n}方案定稿与发布', '正式文本'], ['{n}进度跟踪与督办', '跟踪表'],
  ['{n}季度汇报', '汇报材料'], ['与相关部门沟通{n}事项', '会议纪要'], ['{n}问题整改', '整改清单'],
  ['{n}年度总结', '总结报告'], ['{n}调研与需求梳理', '调研报告'], ['{n}培训与宣贯', '培训材料'],
];
const DELIV_NAMES = ['初稿文档', '评审纪要', '数据台账', '报送回执', '正式文本', '跟踪表', '汇报材料', '会议纪要', '整改清单', '总结报告'];
const SOURCES = ['领导交办', '例行工作', '监管要求', '内部发起', ''];
const TAGS = ['重点', '攻坚', '常规', ''];

/* 用例表：[标签, 状态, 计划日期偏移(null=不填), 进度, 实际完成日期偏移, 优先级, 特殊标记]
   偏移量都是相对"生成当天"的天数。 */
const CASES = [
  ['已完成·本周内完成',   'done',  -3,   100, -3,   '2', ''],
  ['已完成·本月内完成',   'done',  -18,  100, -16,  '2', ''],
  ['已完成·上季度完成',   'done',  -96,  100, -94,  '3', ''],
  ['已完成·提前完成',     'done',  -8,   100, -12,  '1', ''],
  ['进行中·今日到期',     'doing', 0,    60,  '',   '1', ''],
  ['进行中·本周到期',     'doing', 3,    45,  '',   '2', ''],
  ['进行中·下周到期',     'doing', 9,    30,  '',   '2', ''],
  ['进行中·下月到期',     'doing', 34,   15,  '',   '3', ''],
  ['进行中·已逾期',       'doing', -6,   70,  '',   '1', ''],
  ['进行中·严重逾期',     'doing', -41,  35,  '',   '1', ''],
  ['进行中·刚开始',       'doing', 20,   5,   '',   '2', ''],
  ['未开始·无计划日期',   'todo',  null, 0,   '',   '2', ''],
  ['未开始·有计划日期',   'todo',  17,   0,   '',   '3', ''],
  ['未开始·下期开始',     'todo',  12,   0,   '',   '2', ''],
  ['已挂起·历史遗留',     'hold',  -12,  20,  '',   '3', ''],
  ['已挂起·待条件成熟',   'hold',  26,   0,   '',   '3', ''],
  ['未归属·没有牵头人',   'todo',  14,   0,   '',   '2', 'noowner'],
  ['进行中·无人参与',     'doing', 7,    50,  '',   '2', 'noassignee'],
];

/* ============================================================================
   生成
   ========================================================================== */
async function main() {
  await tick();                       // 等 harness 里的 boot() 跑完，避免它回头覆盖我们写的数据

  /* ---- 0. 把脚手架自动播的种子数据整个清掉，从空白开始 ---- */
  DB.duties.length = 0; DB.works.length = 0; DB.milestones.length = 0;
  DB.tasks.length = 0; DB.changelog.length = 0; DB.users.length = 0;
  DB.purged = []; DB.syncBase = null;
  DB.reportConfig = null; DB.dashboardConfig = null; DB.shareConfig = null; DB.permissionMatrix = null;
  const YEAR = new Date().getFullYear();
  DB.settings.year = YEAR;
  S.rebuildIndex();

  /* ---- 1. 账号 ---- */
  for (const [name, role, hasPin] of ACCOUNTS) {
    const u = { name, role };
    if (hasPin) Object.assign(u, await S.hashPin(DEMO_PIN));
    else Object.assign(u, { salt: '', hash: '', iterations: 0 });
    stamp(u, '徐捷', -220, -(1 + Math.floor(rnd() * 30)));
    // 最近连接时间：大部分人这几天连过，两个人很久没连——权限页"最近连接"列才有得看
    if (name === '郭妙吉' || name === '何昀') u.lastSeenAt = iso(-46);
    else u.lastSeenAt = iso(-Math.floor(rnd() * 4));
    u.lastAppVersion = S.APP_VERSION;
    DB.users.push(u);
  }
  {   // 已停用账号
    const u = { name: RETIRED_ACCOUNT[0], role: RETIRED_ACCOUNT[1], salt: '', hash: '', iterations: 0 };
    stamp(u, '徐捷', -200, -60);
    u.deleted_at = iso(-60);
    DB.users.push(u);
  }

  /* ---- 2. 职责 ---- */
  DUTIES.forEach(([code, category, name]) => {
    DB.duties.push(stamp(S.blank('duty', { code, category, name }), '徐捷', -230, -(20 + Math.floor(rnd() * 120))));
  });
  {
    const d = stamp(S.blank('duty', { code: DELETED_DUTY[0], category: DELETED_DUTY[1], name: DELETED_DUTY[2] }), '徐捷', -180, -25);
    d.deleted_at = iso(-25);
    DB.duties.push(d);
  }
  S.rebuildIndex();

  /* ---- 3. 工作 ---- */
  const workRecs = [];
  WORKS.forEach(([code, duty, name, content, owner, collaborators, status]) => {
    const w = stamp(S.blank('work', { code, duty, name, content, owner, collaborators, year: YEAR, status }),
      owner, -(150 + Math.floor(rnd() * 60)), -(1 + Math.floor(rnd() * 40)));
    DB.works.push(w); workRecs.push(w);
  });
  // 去年的一批（状态一律已完成，用来试年度筛选、跨年度复制）
  LAST_YEAR_WORKS.forEach(code => {
    const src = WORKS.find(w => w[0] === code);
    const w = stamp(S.blank('work', { code, duty: src[1], name: src[2], content: src[3], owner: src[4],
      collaborators: src[5], year: YEAR - 1, status: 'done' }), src[4], -420, -300);
    DB.works.push(w); workRecs.push(w);
  });
  {   // 已停用的工作
    const [code, duty, name, content, owner, collaborators, status] = DELETED_WORK;
    const w = stamp(S.blank('work', { code, duty, name, content, owner, collaborators, year: YEAR, status }), owner, -120, -30);
    w.deleted_at = iso(-30);
    DB.works.push(w);
  }
  S.rebuildIndex();

  /* ---- 4. 任务 ---- */
  const shortName = n => (n.length > 12 ? n.slice(0, 10) + '…' : n);
  let caseCursor = 0;
  const thisYearWorks = DB.works.filter(w => !w.deleted_at && w.year === YEAR);
  const lastYearWorks = DB.works.filter(w => !w.deleted_at && w.year === YEAR - 1);

  function makeTask(w, cs) {
    const [, status, planOff, progress, actualOff, pri, flag] = cs;
    const tpl = TASK_TPL[caseCursor % TASK_TPL.length];
    const pool = [w.owner].concat(w.collaborators || []).filter(Boolean);
    const owner = flag === 'noowner' ? '' : (chance(0.75) ? w.owner : pick(PEOPLE));
    const others = PEOPLE.filter(p => p !== owner);
    let assignees = [];
    if (flag !== 'noassignee') {
      const n = chance(0.35) ? 0 : (chance(0.7) ? 1 : 2);
      assignees = pickN((w.collaborators || []).length && chance(0.6) ? w.collaborators : others, n);
    }
    const t = S.blank('task', {
      work: w.id,
      code: S.nextTaskCode(w.id),
      title: tpl[0].replace('{n}', shortName(w.name)),
      owner, assignees,
      status, priority: pri,
      plan_date: planOff === null ? '' : S.offsetDate(planOff),
      actual_date: actualOff === '' ? '' : S.offsetDate(actualOff),
      progress,
      source: pick(SOURCES),
      custom: pick(TAGS),
    });
    // 创建时间铺开到过去大半年，"待办总量趋势"才有真实形状
    const createdOff = -(20 + Math.floor(rnd() * 260));
    stamp(t, owner || w.owner, createdOff, Math.max(createdOff, -(1 + Math.floor(rnd() * 20))));
    DB.tasks.push(t);
    caseCursor++;
    return { t, tpl, cs };
  }

  const made = [];
  thisYearWorks.forEach(w => {
    const n = 4 + Math.floor(rnd() * 3);       // 每项工作 4—6 条任务
    for (let i = 0; i < n; i++) made.push(makeTask(w, CASES[caseCursor % CASES.length]));
  });
  lastYearWorks.forEach(w => {
    for (let i = 0; i < 3; i++) {
      const t = S.blank('task', {
        work: w.id, code: S.nextTaskCode(w.id),
        title: TASK_TPL[i % TASK_TPL.length][0].replace('{n}', shortName(w.name)),
        owner: w.owner, assignees: (w.collaborators || []).slice(0, 1),
        status: 'done', priority: '2',
        plan_date: S.offsetDate(-(320 + i * 20)), actual_date: S.offsetDate(-(318 + i * 20)),
        progress: 100, source: '例行工作', custom: '常规',
      });
      stamp(t, w.owner, -(400 + i * 10), -(310 + i * 20));
      DB.tasks.push(t);
    }
  });
  S.rebuildIndex();

  /* ---- 5. 里程碑 ---- */
  const LEVELS = ['section', 'department', 'bank'];
  const DELIVS = DELIV_NAMES;
  let levelCursor = 0;
  function addMs(task, planOff, done, level, deliverable, actualOff) {
    const m = S.blank('milestone', {
      task: task.id,
      plan_date: S.offsetDate(planOff),
      deliverable,
      report_level: level,
      done: done ? '1' : '0',
      actual_date: done ? S.offsetDate(actualOff === undefined ? planOff : actualOff) : '',
    });
    stamp(m, task.owner || '徐捷', Math.min(planOff - 20, -5), done ? (actualOff === undefined ? planOff : actualOff) : -(1 + Math.floor(rnd() * 15)));
    DB.milestones.push(m);
    return m;
  }

  made.forEach(({ t, tpl, cs }, i) => {
    if (!chance(0.62)) return;                  // 约六成任务挂里程碑
    // 没填计划完成时间的任务不挂里程碑：那种组合本身就是数据体检要报的问题（noDateHasMs），
    // 随机撒出来的话体检页会被这类噪音刷屏，反而看不出刻意留的那几个样本
    if (!t.plan_date) return;
    const planOff = Math.round((new Date(t.plan_date) - new Date(S.todayStr())) / 86400000);
    const n = 1 + Math.floor(rnd() * 3);
    const delivs = [tpl[1]].concat(pickN(DELIVS, 3));
    for (let k = 0; k < n; k++) {
      const level = LEVELS[levelCursor++ % LEVELS.length];
      // 里程碑分布在任务计划日期之前，最后一个正好落在任务计划日期上
      const off = k === n - 1 ? planOff : planOff - (n - 1 - k) * (6 + Math.floor(rnd() * 10));
      const done = t.status === 'done' || (off < 0 && chance(0.65));
      addMs(t, off, done, level, delivs[k], done ? Math.min(off, -1) : undefined);
    }
    S.recalcProgress(t);
  });

  /* ★ "本期已交付"和"下期计划"这两个模块的日期不能靠拍脑袋的偏移量 ★
     报告页/工作台的"本期""下期"是按 periodRange 算的真实区间。要是写死 -1…-5 天，
     碰上脚本在周一跑，这些"本期交付"就整批落到上一周去了，模块打开来是空的。
     所以直接问程序要区间，再往区间里放，哪天跑都对。 */
  const todayD = S.todayStr();
  const offOf = ds => Math.round((new Date(ds) - new Date(todayD)) / 86400000);
  // 在 [start, end] 区间里挑第 i 个日期（超出区间就绕回来）
  function offIn(start, end, i) {
    const a = offOf(start), b = offOf(end);
    return a + (i % Math.max(1, b - a + 1));
  }
  const wk = S.periodRange('week', 0), wkNext = S.periodRange('week', 1);
  const mo = S.periodRange('month', 0), moNext = S.periodRange('month', 1);

  const openTasks = made.filter(m => m.t.status === 'doing').map(m => m.t);
  /* 本周内已交付（周报要用） */
  for (let i = 0; i < 9 && i < openTasks.length; i++) {
    const t = openTasks[i];
    const off = offIn(wk.start, todayD, i);
    addMs(t, off, true, LEVELS[i % 3], `本周交付：${DELIVS[i % DELIVS.length]}`, off);
    S.recalcProgress(t);
  }
  /* 本月内、本周之前已交付（月报要用；月初跑脚本时没有这个区间，就跳过） */
  if (offOf(mo.start) < offOf(wk.start)) {
    for (let i = 0; i < 6 && i < openTasks.length; i++) {
      const t = openTasks[(i + 3) % openTasks.length];
      const off = offIn(mo.start, S.offsetDate(offOf(wk.start) - 1), i * 3);
      addMs(t, off, true, LEVELS[(i + 2) % 3], `本月交付：${DELIVS[(i + 2) % DELIVS.length]}`, off);
      S.recalcProgress(t);
    }
  }
  /* 下周有节点（周报的"下期计划"） */
  for (let i = 0; i < 9 && i < openTasks.length; i++) {
    const t = openTasks[openTasks.length - 1 - i];
    addMs(t, offIn(wkNext.start, wkNext.end, i), false, LEVELS[i % 3], `下周节点：${DELIVS[(i + 3) % DELIVS.length]}`);
    S.recalcProgress(t);
  }
  /* 下月有节点（月报的"下期计划"） */
  for (let i = 0; i < 6 && i < openTasks.length; i++) {
    const t = openTasks[(openTasks.length - 2 - i * 2 + openTasks.length) % openTasks.length];
    addMs(t, offIn(moNext.start, moNext.end, i * 4), false, LEVELS[(i + 1) % 3], `下月节点：${DELIVS[(i + 6) % DELIVS.length]}`);
    S.recalcProgress(t);
  }
  /* 逾期未完成的里程碑（"逾期里程碑"模块） */
  for (let i = 0; i < 6 && i < openTasks.length; i++) {
    const t = openTasks[i * 2 % openTasks.length];
    addMs(t, -(4 + i * 3), false, LEVELS[(i + 1) % 3], `逾期未交付：${DELIVS[(i + 5) % DELIVS.length]}`);
    S.recalcProgress(t);
  }
  S.rebuildIndex();

  /* ---- 5.5 整理成"自洽"的数据 ----
     生成过程里进度是按里程碑重算的、里程碑日期是按偏移量撒的，两件事都可能跟任务本身
     对不上。不整理的话数据体检一打开就是几十条"进度和状态对不上""里程碑晚于任务期限"，
     全是生成器造成的噪音，反而把下面刻意留的那几个样本淹掉了。 */
  DB.tasks.filter(t => !t.deleted_at).forEach(t => {
    const ms = DB.milestones.filter(m => m.task === t.id && !m.deleted_at);
    if (ms.length) {
      S.recalcProgress(t);
      // 任务的计划完成时间不能早于它最晚的那个里程碑
      const last = ms.map(m => m.plan_date).filter(Boolean).sort().pop();
      if (t.plan_date && last && last > t.plan_date) t.plan_date = last;
    }
    if (t.status === 'hold') return;                    // 挂起是人主动选的，不去动它
    const p = Number(t.progress) || 0;
    if (t.status === 'done') {
      if (p < 100) t.progress = 100;
      if (!t.actual_date) t.actual_date = t.plan_date || S.offsetDate(-2);
    } else {
      if (p >= 100) t.progress = 95;                    // 没标完成就别顶到 100%
      if (p > 0 && t.status === 'todo') t.status = 'doing';
    }
  });
  S.rebuildIndex();

  /* ---- 5.6 保证"本期完成的任务"在任何一天跑脚本都有 ----
     跟里程碑同一个道理：用例表里写的是固定偏移（-3 天算"本周完成"），
     脚本挪到周一跑就掉到上一周去了。这里按真实区间把几条已完成任务的实际完成日期钉进去。 */
  {
    const doneTasks = DB.tasks.filter(t => !t.deleted_at && t.status === 'done');
    for (let i = 0; i < 5 && i < doneTasks.length; i++) {
      const t = doneTasks[i];
      t.actual_date = S.offsetDate(offIn(wk.start, todayD, i));
      if (!t.plan_date || t.plan_date > t.actual_date) t.plan_date = t.actual_date;
    }
    if (offOf(mo.start) < offOf(wk.start)) {
      for (let i = 5; i < 11 && i < doneTasks.length; i++) {
        const t = doneTasks[i];
        t.actual_date = S.offsetDate(offIn(mo.start, S.offsetDate(offOf(wk.start) - 1), (i - 5) * 3));
        if (!t.plan_date || t.plan_date > t.actual_date) t.plan_date = t.actual_date;
      }
    }
  }
  S.rebuildIndex();

  /* ---- 6. 回收站里的东西（软删除，可恢复） ---- */
  const alive = DB.tasks.filter(t => !t.deleted_at);
  const toDelete = pickN(alive, 4);
  toDelete.forEach((t, i) => {
    // 其中一条删除时间很久远，用来试"回收站保留期过期清理"
    t.deleted_at = iso(i === 0 ? -200 : -(3 + i * 4));
    DB.milestones.filter(m => m.task === t.id).forEach(m => { m.deleted_at = t.deleted_at; });
  });
  {   // 两个单独删掉的里程碑（任务还在）
    const cand = DB.milestones.filter(m => !m.deleted_at);
    pickN(cand, 2).forEach(m => { m.deleted_at = iso(-6); });
  }
  S.rebuildIndex();

  /* ---- 7. 彻底删除留下的墓碑 ---- */
  DB.purged = [
    { entity: 'task', id: 't_demo_purged_1', at: iso(-40), by: '徐捷' },
    { entity: 'task', id: 't_demo_purged_2', at: iso(-33), by: '邱洋' },
    { entity: 'milestone', id: 'm_demo_purged_1', at: iso(-33), by: '邱洋' },
    { entity: 'work', id: 'w_demo_purged_1', at: iso(-15), by: '徐捷' },
  ];

  /* ---- 8. 故意留下的"数据体检"样本 ----
     数据体检本身也是要测的功能，所以刻意埋 4 类问题，README 里逐条写明。
     它们都能被体检页的"一键修复"处理掉。 */
  const healthNotes = [];
  {
    // ① 同名任务（dupTask）
    const src = DB.tasks.find(t => !t.deleted_at && t.status === 'doing');
    const dup = S.blank('task', Object.assign({}, {
      work: src.work, code: S.nextTaskCode(src.work), title: src.title,
      owner: src.owner, assignees: [], status: 'todo', priority: '2',
      plan_date: S.offsetDate(21), progress: 0, source: '内部发起', custom: '',
    }));
    stamp(dup, src.owner, -30, -10);
    DB.tasks.push(dup);
    healthNotes.push(`同名任务：「${src.title}」有两条（${src.code} / ${dup.code}）`);

    // ② 任务编号重复（dupTaskCode）
    const c2 = DB.tasks.find(t => !t.deleted_at && t.id !== src.id && t.work === src.work && t.code);
    const clash = S.blank('task', {
      work: src.work, code: c2.code, title: '（编号与他人重复）' + src.title.slice(0, 8) + '专项',
      owner: pick(PEOPLE), assignees: [], status: 'todo', priority: '3',
      plan_date: S.offsetDate(28), progress: 0, source: '', custom: '',
    });
    stamp(clash, '徐捷', -25, -9);
    DB.tasks.push(clash);
    healthNotes.push(`任务编号重复：${c2.code} 被两条任务同时占用`);

    S.rebuildIndex();

    // ③ 里程碑计划日期晚于任务计划完成日期（msLateThanTask）
    const t3 = DB.tasks.find(t => !t.deleted_at && t.plan_date && DB.milestones.some(m => m.task === t.id && !m.deleted_at));
    addMs(t3, Math.round((new Date(t3.plan_date) - new Date(S.todayStr())) / 86400000) + 25, false, 'section', '（超出任务期限的）补充材料');
    healthNotes.push(`里程碑晚于任务计划完成日期：任务「${t3.title}」`);

    // ④ 进度和状态对不上（progressMismatch）：推进过半了，状态还挂在"未开始"
    const t4 = DB.tasks.find(t => !t.deleted_at && t.id !== t3.id && t.status === 'doing' && Number(t.progress) > 0);
    t4.status = 'todo';
    healthNotes.push(`进度与状态对不上：任务「${t4.title}」进度 ${t4.progress}%，状态却是"未开始"`);

    // ⑤ 没填计划完成时间、底下却已经有里程碑（noDateHasMs）
    const t5 = DB.tasks.find(t => !t.deleted_at && t.id !== t3.id && t.id !== t4.id && t.plan_date
      && DB.milestones.some(m => m.task === t.id && !m.deleted_at));
    t5.plan_date = '';
    healthNotes.push(`有里程碑却没填计划完成时间：任务「${t5.title}」`);
  }
  S.rebuildIndex();

  /* ---- 9. 变更日志 ----
     四类都要有：edit（带结构化明细，"按日志核对"要用）、edit（老式只有文字）、
     login、admin（账号与角色，同时充当角色提升的授权凭证）、alert（安全告警）。 */
  const logs = [];
  const logId = (() => { let i = 0; return () => 'log_demo_' + (++i).toString().padStart(4, '0'); })();
  const STATUS_LABEL = { todo: '未开始', doing: '进行中', done: '已完成', hold: '已挂起' };
  const PRI_LABEL = { '1': '高', '2': '中', '3': '低' };

  // 9.1 账号与角色（提权凭证：签字人是管理员徐捷，roleUpgradeAuthorized 才认）
  ACCOUNTS.forEach(([name, role], i) => {
    logs.push({ id: logId(), at: iso(-(215 - i)), by: '徐捷', kind: 'admin', taskId: '',
      summary: `新建账号 ${name}，角色「${S.roleLabel(role)}」`, target: name, roleTo: role });
  });
  logs.push({ id: logId(), at: iso(-58), by: '徐捷', kind: 'admin', taskId: '',
    summary: `把 邱洋 的角色从「员工」改为「处室领导」`, target: '邱洋', roleFrom: 'staff', roleTo: 'director' });
  logs.push({ id: logId(), at: iso(-60), by: '徐捷', kind: 'admin', taskId: '',
    summary: `停用了账号 ${RETIRED_ACCOUNT[0]}`, target: RETIRED_ACCOUNT[0] });
  logs.push({ id: logId(), at: iso(-12), by: '徐捷', kind: 'admin', taskId: '',
    summary: '调整了权限矩阵：处室领导可查看日志页' });

  // 9.2 登录
  for (let i = 0; i < 45; i++) {
    const who = pick(ACCOUNTS.filter(a => a[2]).map(a => a[0]));
    logs.push({ id: logId(), at: iso(-Math.floor(rnd() * 30), 8 + Math.floor(rnd() * 2)), by: who, kind: 'login', taskId: '', summary: '登录' });
  }

  // 9.3 变更（带结构化明细）
  const logTargets = DB.tasks.filter(t => !t.deleted_at && t.code);
  for (let i = 0; i < 80; i++) {
    const t = pick(logTargets);
    const who = t.owner || pick(PEOPLE);
    const at = iso(-Math.floor(rnd() * 45));
    const r = rnd();
    if (r < 0.3) {
      // 状态：写成"改成它现在的值"，核对时对得上
      const from = t.status === 'todo' ? 'todo' : (t.status === 'done' ? 'doing' : 'todo');
      if (from === t.status) continue;
      logs.push({ id: logId(), at, by: who, kind: 'edit', entity: 'task', refId: t.id, taskId: t.id,
        summary: `状态：${STATUS_LABEL[from]}→${STATUS_LABEL[t.status]}`,
        changes: [{ k: 'status', from, to: t.status }] });
    } else if (r < 0.5) {
      logs.push({ id: logId(), at, by: who, kind: 'edit', entity: 'task', refId: t.id, taskId: t.id,
        summary: `进度：${Math.max(0, t.progress - 20)}%→${t.progress}%`,
        changes: [{ k: 'progress', from: Math.max(0, t.progress - 20), to: t.progress }] });
    } else if (r < 0.65) {
      const oldPri = t.priority === '1' ? '2' : '3';
      logs.push({ id: logId(), at, by: who, kind: 'edit', entity: 'task', refId: t.id, taskId: t.id,
        summary: `优先级：${PRI_LABEL[oldPri]}→${PRI_LABEL[t.priority]}`,
        changes: [{ k: 'priority', from: oldPri, to: t.priority }] });
    } else if (r < 0.78 && t.plan_date) {
      logs.push({ id: logId(), at, by: who, kind: 'edit', entity: 'task', refId: t.id, taskId: t.id,
        summary: `计划完成：${S.offsetDate(-7)}→${t.plan_date}`,
        changes: [{ k: 'plan_date', from: S.offsetDate(-7), to: t.plan_date }] });
    } else if (r < 0.9) {
      // 老式日志：只有一句话，没有结构化明细（核对时会如实说明"无法自动核对"）
      logs.push({ id: logId(), at, by: who, kind: 'edit', entity: 'task', refId: t.id, taskId: t.id,
        summary: `完成了里程碑交付「${pick(DELIVS)}」` });
    } else {
      logs.push({ id: logId(), at, by: who, kind: 'edit', entity: 'task', refId: t.id, taskId: t.id, summary: '新建了任务' });
    }
  }

  // 9.4 ★ 两条"日志说改成 A、现在却是 B"的记录 ★
  //     专门用来演示"按日志核对数据"能把被顶回去的改动找出来
  const auditDemo = pickN(DB.tasks.filter(t => !t.deleted_at && t.status !== 'done'), 2);
  auditDemo.forEach((t, i) => {
    const at = iso(-(2 + i));
    logs.push({ id: logId(), at, by: t.owner || '邱洋', kind: 'edit', entity: 'task', refId: t.id, taskId: t.id,
      summary: `状态：${STATUS_LABEL[t.status]}→已完成`,
      changes: [{ k: 'status', from: t.status, to: 'done' }, { k: 'progress', from: t.progress, to: 100 }] });
    // 记录本身"最后修改时间"晚于这条日志 —— 正是"被别人的旧页面顶回去"的特征
    t.updated_at = iso(-(1 + i));
    t.updated_by = pick(PEOPLE);
  });
  healthNotes.push(`按日志核对样本：${auditDemo.map(t => '「' + t.title + '」').join('、')} 两条任务，日志里记着改成了"已完成"，但当前值不是`);

  // 9.5 安全告警
  logs.push({ id: logId(), at: iso(-21), by: '系统', kind: 'alert', taskId: '',
    summary: '合并时挡下一次未经授权的角色提升：钱思远 员工→管理员', target: '钱思远', roleTo: 'admin' });

  logs.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  DB.changelog.push(...logs);

  /* ---- 10. 权限矩阵（改一处，证明它确实随文件同步） ---- */
  const pm = JSON.parse(JSON.stringify(S.DEFAULT_PERMISSION_MATRIX));
  pm.director.view_logs = true;             // 处室领导可以看日志页
  pm.director.view_data = true;             // 也可以看数据页
  pm.comanager.config_dashboard = true;     // 组长可以配置工作台编排
  stamp(pm, '徐捷', -12, -12);
  DB.permissionMatrix = pm;

  /* ---- 11. 报告页 / 工作台编排：默认预设之外再存一套精简版 ---- */
  const rSections = JSON.parse(JSON.stringify(S.DEFAULT_REPORT_SECTIONS));
  DB.reportConfig = {
    presets: [
      { id: 'preset_default', name: '默认编排', sections: rSections },
      { id: 'preset_week', name: '周会精简版', sections: [
        { id: 'sec_state', title: '一、本期工作进展', modules: ['periodStatus', 'dutyTree'] },
        { id: 'sec_focus', title: '二、需要关注', modules: ['highPriority', 'overdueTasks', 'overdueMs'] },
      ] },
    ],
    activeId: 'preset_default', rev: 2, updated_at: iso(-9), updated_by: '徐捷',
  };
  const dSections = JSON.parse(JSON.stringify(S.DEFAULT_DASHBOARD_SECTIONS));
  DB.dashboardConfig = {
    presets: [
      { id: 'dashpreset_default', name: '默认编排', sections: dSections },
      { id: 'dashpreset_lead', name: '领导视角', sections: [
        { id: 'sec_overview', title: '处室概览',
          modules: ['periodOverallScope', 'periodOverallStatus', 'periodOverallPlan', 'dutyTree', 'personBars', 'recentActivity'],
          inline: [], personScope: { periodOverallScope: 'all', periodOverallStatus: 'all', periodOverallPlan: 'all', dutyTree: 'all', personBars: 'all', recentActivity: 'all' } },
      ] },
    ],
    activeId: 'dashpreset_default', rev: 2, updated_at: iso(-9), updated_by: '徐捷',
  };

  /* ---- 12. 共享文件夹配置 ---- */
  const sc = { fileName: '科技规划处工作管理.json', autoBackupEnabled: true, autoBackupHours: 24, recycleKeepDays: 60 };
  stamp(sc, '徐捷', -100, -30);
  DB.shareConfig = sc;

  /* ---- 13. 落盘 ---- */
  DB.settings.me = '徐捷';
  S.rebuildIndex();
  /* 第四个参数是"我这次写所基于的那份文件"，filePayload 要拿它接写入链（writeIds，
     用来事后发现"我那次写被人用过期内容盖掉了"，见 index.html 里 noteClobberedWrite）。
     演示文件是凭空造出来的，没有"上一份"，这里给它一条完好的初始链——
     传空会让 filePayload 插一个"这条链判断不了"的哨兵，那样一上来检测就是关着的。 */
  const seedWriteId = 'demo_' + Date.now().toString(36);
  const payload = S.filePayload(S.syncPayload(DB), DB, seedWriteId, { writeIds: ['demo_seed'] });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');

  /* ---- 14. 自检并打印一份"这份数据里都有什么"的清单 ---- */
  const alive2 = DB.tasks.filter(t => !t.deleted_at);
  const msAlive = DB.milestones.filter(m => !m.deleted_at);
  const today = S.todayStr();
  const cnt = (arr, fn) => arr.filter(fn).length;
  const size = (fs.statSync(OUT).size / 1024).toFixed(0);

  console.log('\n已生成：' + OUT + `（${size} KB）`);
  console.log('─'.repeat(64));
  console.log(`职责    ${DB.duties.length} 条（其中已删除 ${cnt(DB.duties, d => d.deleted_at)}）`);
  console.log(`工作    ${DB.works.length} 条（${new Date().getFullYear()} 年 ${cnt(DB.works, w => !w.deleted_at && w.year === new Date().getFullYear())}、`
    + `上年度 ${cnt(DB.works, w => !w.deleted_at && w.year === new Date().getFullYear() - 1)}、已停用 ${cnt(DB.works, w => w.deleted_at)}）`);
  console.log(`任务    ${DB.tasks.length} 条（有效 ${alive2.length}、回收站 ${cnt(DB.tasks, t => t.deleted_at)}）`);
  console.log(`  状态： 未开始 ${cnt(alive2, t => t.status === 'todo')}｜进行中 ${cnt(alive2, t => t.status === 'doing')}`
    + `｜已完成 ${cnt(alive2, t => t.status === 'done')}｜已挂起 ${cnt(alive2, t => t.status === 'hold')}`);
  console.log(`  优先级：高 ${cnt(alive2, t => t.priority === '1')}｜中 ${cnt(alive2, t => t.priority === '2')}｜低 ${cnt(alive2, t => t.priority === '3')}`);
  console.log(`  逾期未完成 ${cnt(alive2, t => t.plan_date && t.plan_date < today && t.status !== 'done')}`
    + `｜今日到期 ${cnt(alive2, t => t.plan_date === today)}`
    + `｜无计划日期 ${cnt(alive2, t => !t.plan_date)}`
    + `｜无牵头人 ${cnt(alive2, t => !t.owner)}`);
  console.log(`里程碑  ${DB.milestones.length} 个（有效 ${msAlive.length}、回收站 ${cnt(DB.milestones, m => m.deleted_at)}）`);
  console.log(`  呈报层级：处室领导 ${cnt(msAlive, m => m.report_level === 'section')}`
    + `｜部门领导 ${cnt(msAlive, m => m.report_level === 'department')}`
    + `｜行领导 ${cnt(msAlive, m => m.report_level === 'bank')}`);
  console.log(`  已交付 ${cnt(msAlive, m => m.done === '1')}｜未交付 ${cnt(msAlive, m => m.done !== '1')}`
    + `｜逾期未交付 ${cnt(msAlive, m => m.done !== '1' && m.plan_date && m.plan_date < today)}`);
  console.log(`账号    ${DB.users.length} 个（`
    + S.ROLES.map(r => `${r.label} ${cnt(DB.users, u => !u.deleted_at && u.role === r.v)}`).join('、')
    + `、已停用 ${cnt(DB.users, u => u.deleted_at)}）`);
  console.log(`日志    ${DB.changelog.length} 条（变更 ${cnt(DB.changelog, e => S.logKind(e) === 'edit')}`
    + `｜登录 ${cnt(DB.changelog, e => e.kind === 'login')}`
    + `｜账号权限 ${cnt(DB.changelog, e => e.kind === 'admin')}`
    + `｜告警 ${cnt(DB.changelog, e => e.kind === 'alert')}`
    + `｜其中带字段明细 ${cnt(DB.changelog, e => Array.isArray(e.changes) && e.changes.length)}）`);
  console.log(`墓碑    ${DB.purged.length} 条`);
  console.log('─'.repeat(64));

  const issues = S.healthCheck().issues || [];
  console.log('数据体检（刻意保留的样本，供测试"体检+一键修复"）：');
  issues.forEach(i => console.log(`  · [${i.k}] ${i.msg}`));
  console.log('刻意埋的问题清单：');
  healthNotes.forEach(n => console.log('  · ' + n));

  const audit = S.auditByChangelog();
  console.log(`按日志核对：能查出 ${audit.length} 处"日志与当前值不一致"`);
  audit.slice(0, 6).forEach(a => console.log(`  · 「${a.title}」${a.field}：日志说 ${S.auditValueText(a.entity, a.field, a.to)}，现在是 ${S.auditValueText(a.entity, a.field, a.now)}`));
  console.log(`\n所有已设 PIN 的演示账号，PIN 统一为：${DEMO_PIN}`);
  console.log('（钱思远、吴敬轩两个账号未设 PIN，用来试"首次登录自己设 PIN"的流程）\n');
  process.exit(0);
}

/* 被别的脚本 require 时不生成数据，只把"哪些是造出来的"这份名单交出去，
   供 tools/audit-demo-mix.js 盘点用——两边共用同一份定义，演示数据改了盘点脚本自动跟上 */
module.exports = {
  REAL_PEOPLE, FAKE_PEOPLE, RETIRED_ACCOUNT,
  REAL_WORKS, EXTRA_WORKS, LAST_YEAR_WORKS, DELETED_WORK, DELETED_DUTY,
  EXTRA_WORK_CODES: EXTRA_WORKS.map(w => w[0]),
  REAL_WORK_CODES: REAL_WORKS.map(w => w[0]),
  TASK_TPL, SOURCES, TAGS, DELIVS_PREFIX: ['本周交付：', '本月交付：', '下周节点：', '下月节点：', '逾期未交付：'],
};
if (require.main === module) main().catch(e => { console.error('生成失败：', e); process.exit(1); });
