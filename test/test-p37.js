/* P37：本轮改动测试——
   "请确认你的身份"这一步，用户第一次登录不该看到一个下拉框把全公司账号名单摆出来给人挑，
   谁都能翻着别人的名字去试 PIN。改成手动输入姓名：输对了名字才能往下走，输错了只说
   "查无此人"，不会在页面源码里暴露具体有哪些账号存在。
   用法：node test/test-p37.js */
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
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    if (S.loginPending) S.hideLoginGate();
  };

  S.DB.users = [
    { name: '张三', role: 'staff', salt: 's', hash: 'h', iterations: 1 },
    { name: '李四', role: 'admin' },   // 还没设过 PIN
  ];
  S.DB.settings.me = '';

  section('★ "请确认你的身份"是手动输入姓名，不是下拉框');
  S.renderLoginPick();
  const body = q('#login-body').innerHTML;
  ok('有姓名输入框', body.includes('id="login-pick"'));
  ok('不是下拉选择框', !body.includes('<select'));
  ok('页面源码里不会把"张三""李四"这些账号名字摆出来给人挑', !body.includes('张三') && !body.includes('李四'));

  section('★ 输入不存在的姓名：只说查无此人，不暴露真实名单');
  q('#login-pick').value = '不存在的人';
  S.ACTIONS['login-pick-next']();
  const errBody = q('#login-body').innerHTML;
  ok('提示查无此人', errBody.includes('查无此人'));
  ok('还是手动输入框，不会退化成下拉框帮忙挑', errBody.includes('id="login-pick"') && !errBody.includes('<select'));

  section('★ 姓名留空：提示输入姓名，不会报别的错');
  q('#login-pick').value = '   ';
  S.ACTIONS['login-pick-next']();
  ok('提示请输入姓名', q('#login-body').innerHTML.includes('请输入姓名'));

  section('★ 输对姓名、账号还没设过 PIN：进入首次设置 PIN 那一步');
  q('#login-pick').value = '李四';
  S.ACTIONS['login-pick-next']();
  ok('走的是"首次登录，设置你的 PIN"', q('#login-body').innerHTML.includes('id="login-new-pin"'));

  section('★ 输对姓名、账号已经设过 PIN：进入验证 PIN 那一步');
  S.renderLoginPick();
  q('#login-pick').value = '张三';
  S.ACTIONS['login-pick-next']();
  ok('走的是"输入 PIN 码"', q('#login-body').innerHTML.includes('id="login-pin"'));

  section('回归：姓名前后带空格也能匹配上（去空格再比对）');
  S.renderLoginPick();
  q('#login-pick').value = '  张三  ';
  S.ACTIONS['login-pick-next']();
  ok('带空格也认得出来', q('#login-body').innerHTML.includes('id="login-pin"'));

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
