/* P20：本轮改动测试——
   1) 工作台"人员负荷"统计里区分"未开始"：以前 todo/doing 混在一个"在办"桶里，现在拆成两段，
      todo 用新的 --c-todo 颜色单独渲染，legend/tooltip 同步更新
   2) 共享文件夹手动连接时，先弹一个小提示框讲清楚要选处里共享的那个文件夹（工号/路径模板那套已经
      废弃——身份认证改回姓名+PIN，见后续批次），确认后才真的弹系统选择框
   用法：node test/test-p20.js */
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
  const bakShareConfig = S.DB.shareConfig;
  const restore = () => {
    S.DB.users = JSON.parse(JSON.stringify(bakUsers));
    S.DB.settings.me = bakMe;
    S.DB.shareConfig = bakShareConfig;
    S.setFileHandle(null);
  };

  // 工作台"人员负荷"模块（dashPeopleLoad，用的就是这里说的 seg-todo/tooltip/图例）P82 这轮
  // 下线了——跟"各人任务量与完成率"（personBars）内容重复，见 REPORT_MODULES 里 dashPeopleLoad
  // 那段注释。这里验证的"未开始独立统计、不跟进行中混"这个数据层概念（todo/doing 分开计数）
  // 还在，只是不再有 dashPeopleLoad 这份专属渲染去展示它了，这个小节不再适用，整体去掉

  section('confirmConnectWithHint：先弹提示框讲清楚要选哪个文件夹，确认后才执行');
  S.DB.settings.me = '测试管理员';
  S.DB.shareConfig = { fileName: 'a.json' };
  let called2 = false;
  S.confirmConnectWithHint(() => { called2 = true; });
  ok('弹出了提示框', typeof S.modalCallback === 'function');
  ok('还没确认之前，回调没有被执行', called2 === false);
  ok('提示框内容里带了同步用的文件名', q('#modal-body').innerHTML.includes('a.json'));
  await S.modalCallback();
  ok('点了"继续连接"之后，回调才真正执行', called2 === true);

  section('回归：connect-shared 也经过这道"讲清楚该选哪个文件夹"的提示');
  S.DB.settings.me = '测试管理员';
  S.ACTIONS['connect-shared']();
  ok('管理员点"连接共享文件夹"，先弹出了提示框（不是直接弹系统选择框）', typeof S.modalCallback === 'function');

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
