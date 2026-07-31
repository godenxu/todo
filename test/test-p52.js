/* P52：共享 JSON 是明文的，同事拿记事本把自己那条 "role":"staff" 改成 "admin" 就成了管理员，
   而且全程没有任何记录。本轮做的是"第一层：审计 + 检测 + 回滚"，外加一道合并熔断。

   要说清楚这里防的是什么、防不了什么：
   · 防不了"改文件"这个动作本身——网盘上每个人都有写权限，没有服务器就阻止不了；
   · 也防不了他改自己那份 index.html 把校验删掉——每人一份拷贝，同样管不着。
   · 能做到的是两件事：篡改的结果在别人机器上不生效（各自独立挡掉，他只能骗自己那台）；
     以及这件事藏不住（进日志、弹告警、导航栏亮红点，而且日志随共享文件同步给所有人）。

   判定依据：一次合法的角色提升一定伴随一条由有权限的人写的变更记录，
   而且这条记录跟角色改动是同一批写进共享文件的（见 pushAdminLog 各调用点）。
   拿记事本改的人不会同时伪造这条记录；照葫芦画瓢补一条的话，记录里也写明了是谁提的谁。

   用法：node test/test-p52.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const clone = o => JSON.parse(JSON.stringify(o));
const iso = ms => new Date(ms).toISOString();

async function main() {
  await tick(60);
  S.seedAll();
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const bakMe = S.DB.settings.me;
  S.DB.users = [
    { name: '李管理', role: 'admin', rev: 1, updated_at: iso(Date.now() - 86400000), updated_by: '李管理' },
    { name: '王处长', role: 'director', rev: 1, updated_at: iso(Date.now() - 86400000), updated_by: '李管理' },
    { name: '张三', role: 'staff', rev: 1, updated_at: iso(Date.now() - 86400000), updated_by: '李管理' },
  ];
  S.DB.settings.me = '李管理';
  S.clearMergeAlert();

  /* ======================================================================
     ① 审计：账号 / 角色 / 权限的每一次变更都要留痕
     ====================================================================== */
  section('①-1 改角色：留下的既是审计记录，也是这次提升的"凭证"');
  S.DB.changelog = [];
  await S.ACTIONS['account-role-change']({ name: '张三' }, { value: 'comanager' });
  // 断言一律写成对 undefined 安全的形式：这样拿改动前的版本回放时，能看到完整的失败清单，
  // 而不是第一条就抛异常把后面全带停
  const e1 = S.DB.changelog.find(e => e.kind === S.ADMIN_LOG_KIND) || {};
  ok('★以前这里一条日志都不记，现在记上了', !!e1.id, S.DB.changelog);
  ok('人话说明写清楚了改前改后', (e1.summary || '').includes('张三') && (e1.summary || '').includes('组长'));
  ok('★结构化字段也在——别人的机器要靠它做校验，光有给人看的文字没用',
    e1.target === '张三' && e1.roleTo === 'comanager', e1);
  ok('记了是谁改的', e1.by === '李管理');

  section('①-2 新建 / 删除账号、权限矩阵，同样留痕');
  S.DB.changelog = [];
  q('#adm-new-name').value = 'P52新人'; q('#adm-new-role').value = 'staff';
  await S.ACTIONS['admin-new-user']();
  const e2 = S.DB.changelog.find(e => e.kind === S.ADMIN_LOG_KIND) || {};
  ok('新建账号有记录，而且带 target/roleTo（新建一个管理员 = 提权，同样要凭证）',
    e2.target === 'P52新人' && e2.roleTo === 'staff', e2);

  S.DB.changelog = [];
  S.ACTIONS['admin-delete-user']({ name: 'P52新人' });
  await S.modalCallback();
  ok('删除账号有记录', S.DB.changelog.some(e => e.kind === S.ADMIN_LOG_KIND && e.summary.includes('删除账号')));

  S.DB.changelog = [];
  await S.ACTIONS['perm-toggle']({ role: 'staff', key: 'bulk_ops' }, { checked: true });
  ok('权限矩阵调整有记录', S.DB.changelog.some(e => e.kind === S.ADMIN_LOG_KIND && e.summary.includes('权限矩阵')));

  section('①-3 日志页认得这两种新类型');
  ok('筛选里有"账号与权限"', S.LOG_KINDS.some(k => k.key === S.ADMIN_LOG_KIND));
  ok('筛选里有"安全告警"', S.LOG_KINDS.some(k => k.key === S.ALERT_LOG_KIND));

  /* ======================================================================
     ② 越权检测
     ====================================================================== */
  section('②-1 roleUpgradeAuthorized：什么样的"条子"才算数');
  const users = [
    { name: '李管理', role: 'admin' }, { name: '王处长', role: 'director' },
    { name: '张三', role: 'staff' }, { name: '赵四', role: 'staff' },
  ];
  const good = [{ kind: S.ADMIN_LOG_KIND, by: '李管理', target: '张三', roleTo: 'admin', at: iso(Date.now()) }];
  ok('管理员签的条子 → 认', S.roleUpgradeAuthorized('张三', 'admin', good, users));
  ok('★自己给自己签的条子 → 不认（这正是要防的那个动作）',
    !S.roleUpgradeAuthorized('张三', 'admin',
      [{ kind: S.ADMIN_LOG_KIND, by: '张三', target: '张三', roleTo: 'admin', at: iso(Date.now()) }], users));
  ok('★普通员工签的条子 → 不认（伪造时随手填个同事名字也没用）',
    !S.roleUpgradeAuthorized('张三', 'admin',
      [{ kind: S.ADMIN_LOG_KIND, by: '赵四', target: '张三', roleTo: 'admin', at: iso(Date.now()) }], users));
  ok('处室领导签的条子 → 认', S.roleUpgradeAuthorized('张三', 'comanager',
    [{ kind: S.ADMIN_LOG_KIND, by: '王处长', target: '张三', roleTo: 'comanager', at: iso(Date.now()) }], users));
  ok('条子上写的角色对不上 → 不认（批的是组长，实际改成了管理员）',
    !S.roleUpgradeAuthorized('张三', 'admin',
      [{ kind: S.ADMIN_LOG_KIND, by: '李管理', target: '张三', roleTo: 'comanager', at: iso(Date.now()) }], users));
  ok('压根没有条子 → 不认', !S.roleUpgradeAuthorized('张三', 'admin', [], users));
  ok('拿普通变更日志冒充凭证 → 不认（kind 对不上）',
    !S.roleUpgradeAuthorized('张三', 'admin',
      [{ kind: 'edit', by: '李管理', target: '张三', roleTo: 'admin', at: iso(Date.now()) }], users));

  section('②-2 guardRoleIntegrity：挡下来的和放行的');
  /* 名单里必须带上签字人本人：校验时要反查"签这条子的人当时是什么角色"，
     查的就是这份合并后的账号名单（真实场景里它当然是全处的完整名单）。
     一开始写测试时漏了这一条，结果"有凭证也放行不了"——正好说明这个反查是真的在起作用 */
  const 本机 = [{ name: '李管理', role: 'admin', rev: 1 }, { name: '张三', role: 'staff', rev: 1 }];
  const 被改过 = [{ name: '李管理', role: 'admin', rev: 1 }, { name: '张三', role: 'admin', rev: 2, updated_by: '张三' }];
  const g1 = S.guardRoleIntegrity(本机, 被改过, []);
  const g1zs = g1.users.find(u => u.name === '张三');
  ok('★无凭证的提权被挡下，本机仍然按原角色对待', g1zs.role === 'staff', g1zs);
  ok('★而且连版本号都保留本机这份，不去顶高——不替别人改写共享文件里的账号数据', g1zs.rev === 1);
  ok('记下了这起告警，谁被提成什么、是谁写的，都在', g1.alerts.length === 1
    && g1.alerts[0].name === '张三' && g1.alerts[0].to === 'admin' && g1.alerts[0].from === 'staff');

  const g2 = S.guardRoleIntegrity(本机, 被改过, good);
  ok('★有正规凭证的提权照常放行',
    g2.users.find(u => u.name === '张三').role === 'admin' && g2.alerts.length === 0, g2.alerts);

  const g3 = S.guardRoleIntegrity([{ name: '张三', role: 'admin', rev: 1 }], [{ name: '张三', role: 'staff', rev: 2 }], []);
  ok('★降级不查（没人拿降级害自己；查了反而会误伤离线久了的设备）',
    g3.users[0].role === 'staff' && g3.alerts.length === 0);

  const g4 = S.guardRoleIntegrity([], [{ name: '新同事', role: 'staff', rev: 1 }], []);
  ok('本机第一次见到的账号照单全收（没有基准可比，硬查只会把新设备锁死）',
    g4.users.length === 1 && g4.alerts.length === 0);

  const g5 = S.guardRoleIntegrity([{ name: '张三', role: 'staff', rev: 1 }], [{ name: '张三', role: 'staff', rev: 3 }], []);
  ok('角色没变的记录不受影响（改了别的字段照样合并进来）', g5.users[0].rev === 3 && g5.alerts.length === 0);

  section('②-3 端到端：同事拿记事本把自己改成管理员，走真实合并路径');
  S.DB.users = [
    { name: '李管理', role: 'admin', rev: 1, updated_at: iso(Date.now() - 86400000), updated_by: '李管理' },
    { name: '张三', role: 'staff', rev: 1, updated_at: iso(Date.now() - 86400000), updated_by: '李管理' },
  ];
  S.DB.changelog = [];
  const 我本地 = clone(S.syncPayload(S.DB));
  // 记事本篡改：只把 role 改了，顺手把版本号顶高（他要是不顶高，连合并这一关都过不了）
  const 被篡改的文件 = clone(我本地);
  const bad = 被篡改的文件.users.find(u => u.name === '张三');
  bad.role = 'admin'; bad.rev = 99; bad.updated_at = iso(Date.now()); bad.updated_by = '张三';
  const 合并结果 = S.mergeSyncPayload(我本地, 被篡改的文件);
  const 我看到的张三 = 合并结果.users.find(u => u.name === '张三');
  ok('★★合并之后，我这边看到的张三仍然是员工——篡改没有生效', 我看到的张三.role === 'staff', 我看到的张三);
  ok('挡下来的这起被记进了告警列表', S.integrityAlerts.length === 1);

  /* ★ 这里必须连 Object.assign 一起走完，不能只调 noteMergeAlerts ★
     真机验证时抓到的一个真 bug：告警是往 DB.changelog 里追加的，而合并完紧接着的
     Object.assign(DB, merged) 会把 DB.changelog 整个换成 merged.changelog——
     刚写进去的告警当场就被丢掉了。表现是"篡改确实挡住了，但日志里一个字没有"，
     等于这套机制最重要的一半（藏不住）静悄悄失效。
     原来的测试只调 noteMergeAlerts，跳过了 assign，所以照样全绿。
     现在把顺序完整走一遍，这个坑再也躲不过去。 */
  Object.assign(S.DB, 合并结果);
  S.rebuildIndex();
  S.noteMergeAlerts(我本地, 合并结果);
  const alertEntry = S.DB.changelog.find(e => e.kind === S.ALERT_LOG_KIND) || {};
  ok('★写进了日志——这条会随共享文件同步给所有人，想瞒也瞒不住', !!alertEntry.id, S.DB.changelog);
  ok('告警文字把来龙去脉说清楚了', (alertEntry.summary || '').includes('张三')
    && (alertEntry.summary || '').includes('管理员') && (alertEntry.summary || '').includes('拒绝采纳'));
  ok('也弹了提示条', q('#snack-msg').textContent.includes('未经授权'), q('#snack-msg').textContent);

  section('②-4 同一起告警不会每次同步都刷一条（5 分钟一轮，不去重会把日志淹掉）');
  const before = S.DB.changelog.filter(e => e.kind === S.ALERT_LOG_KIND).length;
  S.mergeSyncPayload(我本地, 被篡改的文件);
  S.noteMergeAlerts(我本地, 合并结果);
  S.mergeSyncPayload(我本地, 被篡改的文件);
  S.noteMergeAlerts(我本地, 合并结果);
  ok('★又合并了两轮，告警日志还是只有一条', S.DB.changelog.filter(e => e.kind === S.ALERT_LOG_KIND).length === before);

  section('②-5 管理员正常改角色，对方合并时必须认——不能把正经操作也拦了');
  S.DB.users = [
    { name: '李管理', role: 'admin', rev: 1, updated_at: iso(Date.now() - 86400000), updated_by: '李管理' },
    { name: '张三', role: 'staff', rev: 1, updated_at: iso(Date.now() - 86400000), updated_by: '李管理' },
  ];
  S.DB.changelog = [];
  S.DB.settings.me = '李管理';
  const 对方旧数据 = clone(S.syncPayload(S.DB));
  await S.ACTIONS['account-role-change']({ name: '张三' }, { value: 'director' });   // 管理员正规操作
  const 管理员推上去的 = clone(S.syncPayload(S.DB));
  const 对方合并后 = S.mergeSyncPayload(对方旧数据, 管理员推上去的);
  ok('★★正规提升被认可，张三在对方那边确实变成处室领导了',
    对方合并后.users.find(u => u.name === '张三').role === 'director');
  ok('没有产生任何告警', S.integrityAlerts.length === 0);

  /* ======================================================================
     ③ 合并熔断
     ====================================================================== */
  section('③-1 mergeDamageReport：数清楚这次合并要删掉多少条');
  const 前 = { tasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }], milestones: [{ id: 'm1' }],
    works: [{ id: 'w1' }], duties: [{ code: 'D1' }], users: [{ name: 'u1' }] };
  const 后 = { tasks: [{ id: 't1', deleted_at: 'x' }, { id: 't2' }], milestones: [{ id: 'm1', deleted_at: 'x' }],
    works: [{ id: 'w1' }], duties: [{ code: 'D1' }], users: [{ name: 'u1' }] };
  const dmg = S.mergeDamageReport(前, 后);
  ok('被标成已删的算进去了', dmg.tasks === 2, dmg);   // t1 被删、t3 整条消失
  ok('整条消失的也算（不是只看 deleted_at）', dmg.total === 3, dmg);
  ok('本来就已删的不重复计数',
    S.mergeDamageReport({ tasks: [{ id: 't1', deleted_at: 'x' }] }, { tasks: [{ id: 't1', deleted_at: 'x' }] }).total === 0);

  section('③-2 超过阈值：留底 + 告警 + 提示，但不硬阻断同步');
  S.clearMergeAlert();
  S.DB.changelog = [];
  const many前 = { tasks: Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i })), milestones: [], works: [], duties: [], users: [] };
  const many后 = { tasks: many前.tasks.map(t => ({ ...t, deleted_at: 'x' })), milestones: [], works: [], duties: [], users: [] };
  ok('阈值是 15', S.MERGE_DAMAGE_LIMIT === 15);
  S.noteMergeAlerts(many前, many后);
  const ma = S.loadMergeAlert();
  ok('★留底了，而且合并前的数据整份都在（刷新页面也还在，因为落的是 localStorage）',
    !!ma && ma.payload.tasks.length === 30, ma && ma.damage);
  ok('数量记对了', ma.damage.total === 30 && ma.damage.tasks === 30);
  ok('写进了告警日志', S.DB.changelog.some(e => e.kind === S.ALERT_LOG_KIND && e.summary.includes('30')));
  ok('弹了提示条', q('#snack-msg').textContent.includes('留底'), q('#snack-msg').textContent);

  section('③-3 没超阈值就不打扰（正常删几条不该弹告警）');
  S.clearMergeAlert();
  const few前 = { tasks: Array.from({ length: 5 }, (_, i) => ({ id: 'y' + i })), milestones: [], works: [], duties: [], users: [] };
  const few后 = { tasks: few前.tasks.map(t => ({ ...t, deleted_at: 'x' })), milestones: [], works: [], duties: [], users: [] };
  S.noteMergeAlerts(few前, few后);
  ok('★删 5 条不留底、不告警', !S.loadMergeAlert());

  section('③-4 回滚：把被删的记录恢复回来，而且要能同步给别人');
  S.DB.tasks = [
    { id: 'r1', title: '甲', rev: 1, updated_at: iso(Date.now() - 60000), updated_by: '李管理' },
    { id: 'r2', title: '乙', rev: 1, updated_at: iso(Date.now() - 60000), updated_by: '李管理' },
  ];
  S.rebuildIndex();
  const 删之前 = clone(S.syncPayload(S.DB));
  S.DB.tasks.forEach(t => { t.deleted_at = iso(Date.now()); t.rev = 50; });   // 模拟同步进来的批量删除
  S.armMergeDamageAlert(删之前, { total: 2, tasks: 2, milestones: 0, works: 0, duties: 0, users: 0 });
  S.DB.changelog = [];
  await S.restoreMergeDamage();
  const r1 = S.DB.tasks.find(t => t.id === 'r1');
  ok('★记录恢复回来了', !r1.deleted_at, r1);
  ok('★★版本号顶到了对方之上，不然一同步又被删回去（这是 P50 撤销踩过的坑）', (r1.rev || 0) > 50, r1.rev);
  ok('回滚这件事本身也记了一条', S.DB.changelog.some(e => e.kind === S.ADMIN_LOG_KIND && e.summary.includes('回滚')));
  ok('留底清掉了，告警消失', !S.loadMergeAlert());

  section('③-5 "确认无误"可以直接消掉告警');
  S.armMergeDamageAlert(删之前, { total: 20, tasks: 20, milestones: 0, works: 0, duties: 0, users: 0 });
  ok('先确认有告警', !!S.loadMergeAlert());
  S.ACTIONS['merge-damage-dismiss']();
  ok('消掉之后就没有了', !S.loadMergeAlert());

  /* ======================================================================
     ④ 告警的展示与处置
     ====================================================================== */
  section('④-1 未处理告警的判定：处理过就自动消掉，不用额外存"已读"状态');
  S.DB.users = [{ name: '李管理', role: 'admin' }, { name: '张三', role: 'staff' }];
  S.DB.changelog = [
    { id: 'a1', kind: S.ALERT_LOG_KIND, at: iso(Date.now() - 10000), by: '李管理', target: '张三', roleTo: 'admin', summary: '检测到未经授权的角色提升：张三' },
  ];
  ok('★有一条未处理的告警', S.unresolvedRoleAlerts().length === 1);
  S.DB.changelog.push({ id: 'a2', kind: S.ADMIN_LOG_KIND, at: iso(Date.now()), by: '李管理', target: '张三', roleTo: 'staff', summary: '确认角色' });
  ok('★管理员处理过之后（针对同一个人又有了一条正规变更记录），告警自动算已处理',
    S.unresolvedRoleAlerts().length === 0);
  // 只有"告警之后"的记录才算处理：单独用一条干净的告警来验，否则会被上面那条 a2 顺带盖住，测了个寂寞
  S.DB.changelog = [
    { id: 'a3', kind: S.ADMIN_LOG_KIND, at: iso(Date.now() - 99999), by: '李管理', target: '赵四', roleTo: 'staff', summary: '很早以前的一次调整' },
    { id: 'a4', kind: S.ALERT_LOG_KIND, at: iso(Date.now()), by: '李管理', target: '赵四', roleTo: 'admin', summary: '越权告警' },
  ];
  ok('★告警之前的老记录不算处理（只认告警之后发生的）', S.unresolvedRoleAlerts().length === 1);

  section('④-2 告警面板 + 导航栏红点');
  S.DB.changelog = [
    { id: 'b1', kind: S.ALERT_LOG_KIND, at: iso(Date.now()), by: '李管理', target: '张三', roleTo: 'admin', summary: '检测到未经授权的角色提升：张三 被改成了「管理员」' },
  ];
  S.clearMergeAlert();
  const panel = S.securityAlertPanelHTML();
  ok('面板渲染出来了', panel.includes('安全告警') && panel.includes('张三'));
  ok('★给了可以直接点的处置按钮，不是一个只能"知道了"的提示', panel.includes('data-act="seal-role"'));
  ok('告警计数对', S.securityAlertCount() === 1);
  S.DB.settings.me = '李管理';
  S.renderShell();
  ok('★导航栏日志页上亮了红点（告警不能只躺在页面里等人主动去看）', q('#nav').innerHTML.includes('nav-badge'));

  ok('没有告警时面板整个不出现', (() => {
    S.DB.changelog = []; S.clearMergeAlert();
    return S.securityAlertPanelHTML() === '' && S.securityAlertCount() === 0;
  })());
  S.renderShell();
  ok('也就没有红点了', !q('#nav').innerHTML.includes('nav-badge'));

  section('④-3 处置动作 seal-role：把本机认定的角色正式写回去');
  S.DB.users = [{ name: '李管理', role: 'admin' }, { name: '张三', role: 'staff', rev: 2 }];
  S.DB.changelog = [{ id: 'c1', kind: S.ALERT_LOG_KIND, at: iso(Date.now()), by: '李管理', target: '张三', roleTo: 'admin', summary: '越权告警' }];
  S.DB.settings.me = '李管理';
  S.ACTIONS['seal-role']({ name: '张三' });
  ok('先弹确认框', q('#modal-overlay').classList.contains('show'));
  await S.modalCallback();
  const zs = S.DB.users.find(u => u.name === '张三');
  ok('★角色保持本机认定的那份（员工），没被那次篡改带跑', zs.role === 'staff');
  ok('★版本号顶高了，这样才能盖掉共享文件里那份被改过的记录', (zs.rev || 0) > 2, zs.rev);
  ok('★留下了正规的变更记录，于是这条告警自动变成已处理', S.unresolvedRoleAlerts().length === 0);
  ok('这条记录带 target/roleTo，所有人的机器从此认这个角色',
    S.DB.changelog.some(e => e.kind === S.ADMIN_LOG_KIND && e.target === '张三' && e.roleTo === 'staff'));

  section('④-4 两条同步路径都挂了检测（只挂一条就等于留了个后门）');
  // 函数定义那一行也长这个样子，所以全文应该正好出现 3 次：1 处定义 + 2 处调用
  const 出现次数 = (html.match(/noteMergeAlerts\(localPayload, merged\)/g) || []).length;
  ok('★两条路径都调了（定义 1 处 + 调用 2 处 = 3）', 出现次数 === 3, 出现次数);
  /* ★必须在 Object.assign 之后调★——真机验证时踩到的坑：放在之前的话，
     assign 会把 DB.changelog 换成 merged.changelog，刚追加的告警当场蒸发，
     "挡住了但没人知道"。这里直接检查两处调用都排在 assign+rebuildIndex 后面 */
  const 顺序对的次数 = (html.match(/Object\.assign\((?:db|DB), merged\);\s*\r?\n\s*rebuildIndex\(\);[\s\S]{0,900}?noteMergeAlerts\(localPayload, merged\);/g) || []).length;
  ok('★两处都排在 Object.assign 之后（放前面的话告警会被 assign 冲掉）', 顺序对的次数 === 2, 顺序对的次数);

  S.DB.settings.me = bakMe;
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
