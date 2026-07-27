/* P12：改角色的两个安全网——(1) 改自己的角色要二次确认，不能一点就生效
   (2) 系统里最后一个管理员不能被降级，避免谁都进不了权限页的死锁。
   用法：node test/test-p12.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);
  const bakUsers = JSON.parse(JSON.stringify(S.DB.users));
  const bakMe = S.DB.settings.me;
  const restore = () => { S.DB.users = JSON.parse(JSON.stringify(bakUsers)); S.DB.settings.me = bakMe; };

  section('最后一个管理员保护：此时只有"测试管理员"一个 admin');
  ok('目前系统里确实只有一个管理员', S.DB.users.filter(u => u.role === 'admin').length === 1);
  S.DB.settings.me = '测试管理员';
  const selfEl = { value: 'staff' };
  await S.ACTIONS['account-role-change']({ name: '测试管理员' }, selfEl);
  ok('唯一管理员降级自己被硬挡，角色没变', S.DB.users.find(u => u.name === '测试管理员').role === 'admin');
  ok('下拉框视觉也被复位回 admin', selfEl.value === 'admin');
  ok('提示了"只剩这一个管理员"', q('#snack-msg').textContent.includes('只剩这一个管理员'), q('#snack-msg').textContent);
  ok('没有弹出确认框（是硬挡，不是二次确认）', !S.modalCallback);

  section('最后一个管理员保护：换一个管理员来降别人，同样挡住');
  S.DB.users.push({ name: '另一个管理员', role: 'admin', salt: '', hash: '', iterations: 0 });
  // 现在有两个 admin 了，先确认降级"测试管理员"是允许的（不是最后一个）
  const el2 = { value: 'staff' };
  await S.ACTIONS['account-role-change']({ name: '测试管理员' }, el2);
  ok('还有别的管理员在，降级不是最后一个 admin，会走二次确认（不是硬挡）', typeof S.modalCallback === 'function');
  ok('确认前角色还没变', S.DB.users.find(u => u.name === '测试管理员').role === 'admin');
  await S.modalCallback();
  ok('确认后，测试管理员真的降级了', S.DB.users.find(u => u.name === '测试管理员').role === 'staff');
  restore();

  section('自己改自己的角色：必须二次确认，确认前不生效（这是本次用户报告的 bug）');
  S.DB.users.push({ name: '备用管理员', role: 'admin', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试管理员';
  const selfEl2 = { value: 'staff' };
  await S.ACTIONS['account-role-change']({ name: '测试管理员' }, selfEl2);
  ok('点了改成员工之后，没有立即生效', S.myRole() === 'admin', S.myRole());
  ok('下拉框先被复位回原值，等确认后再正式改', selfEl2.value === 'admin');
  ok('弹出了确认框', typeof S.modalCallback === 'function');
  ok('确认框文案提到了角色变化', q('#modal-body').innerHTML.includes('员工') && q('#modal-body').innerHTML.includes('管理员'));
  await S.modalCallback();
  ok('确认后才真的改成员工了', S.myRole() === 'staff');
  ok('权限页因此立刻从导航栏消失', !q('#nav').innerHTML.includes('data-page="permissions"'));
  restore();

  section('改别人的角色：不涉及自己，不需要二次确认，直接生效（不应受这次修复影响）');
  S.DB.users.push({ name: '被改的路人', role: 'staff', salt: '', hash: '', iterations: 0 });
  S.DB.settings.me = '测试管理员';
  const otherEl = { value: 'comanager' };
  await S.ACTIONS['account-role-change']({ name: '被改的路人' }, otherEl);
  ok('改别人的角色没有弹确认框，直接生效', !S.modalCallback && S.DB.users.find(u => u.name === '被改的路人').role === 'comanager');
  restore();

  section('选了跟当前一样的角色：什么都不做，不弹确认框也不提示');
  S.DB.settings.me = '测试管理员';
  const sameEl = { value: 'admin' };
  await S.ACTIONS['account-role-change']({ name: '测试管理员' }, sameEl);
  ok('值没变就直接返回，不触发任何流程', !S.modalCallback);
  restore();

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
