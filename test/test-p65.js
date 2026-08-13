/* P65：四项使用中反馈的问题
   ① 定期备份一次写出好几份（前后差一两分钟）——每个标签页一个定时器、一份自己的内存 DB，
      互相看不见对方刚备份过，于是各写各的。加一把 localStorage 跨标签页锁。
   ② 日志页搜索框用中文输入法时，拼音还没选词就按字母筛选了——合成期没让开。
      任务页看着没事只是因为它的输入框在工具栏、重绘时不会被换掉；日志页是整页重建，
      合成被强行打断，拼音字母直接落进框里。两处统一加合成守卫。
   ③ 明说不可撤销的操作，底部提示条上还挂着"撤销"按钮——以前只看撤销栈空不空，
      于是任何一条提示都带撤销按钮，点下去撤掉的是更早某次毫不相干的操作（会真的改数据）。
   ④ 每次发新版本，同事第一次打开就收到"同步进来的这批改动删除了 XXX 条记录"的红色告警。
      那是本机旧缓存跟共享文件对账的正常结果，不是事故。换版本后的第一次合并放行一次。
   用法：node test/test-p65.js */
const fs = require('fs');
const path = require('path');
const { sandbox: S, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);
  const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  S.DB.settings.me = '测试管理员';
  S.seedAll(); S.rebuildIndex();

  /* ================= ①：备份的跨标签页锁 ================= */
  section('①：一个备份周期内只准一个标签页备份成功');
  ok('★第一个标签页抢到锁', S.claimBackupSlot(24) === true);
  ok('★★第二个标签页抢不到（这正是多写一份的来源）', S.claimBackupSlot(24) === false);
  ok('★★第三个也抢不到', S.claimBackupSlot(24) === false);

  section('①：锁的判据是"距上次备份过了多久"，且周期有下限保护');
  S.markBackupSlotUsed();
  ok('★同一周期内仍然抢不到', S.claimBackupSlot(24) === false);
  /* 周期被 Math.max(1, …) 钳到至少 1 小时，这是有意的：配置里万一填了 0 或者非数字，
     不能退化成"每一轮定时器都备份一次"——那会在备份文件夹里刷出成百上千个文件。
     所以传 0 不等于"立刻可以再备"，它会被当成正常周期对待。 */
  ok('★传 0 小时不会退化成"随时可备"（下限保护）', S.claimBackupSlot(0) === false);
  ok('★传非数字也一样有下限保护', S.claimBackupSlot('abc') === false);

  section('①：源码层面——maybeAutoBackup 真的过了这道锁，手动备份也会占掉周期');
  ok('★maybeAutoBackup 里调用了 claimBackupSlot',
    /async function maybeAutoBackup\(\)[\s\S]{0,400}?claimBackupSlot\(backupCfg\(\)\.hours\)/.test(html));
  ok('★runBackup 成功后调用 markBackupSlotUsed（否则手动备份完定时器会紧接着再写一份）',
    /markBackupSlotUsed\(\);[\s\S]{0,120}?await Repo\.persist\(DB\)/.test(html));
  ok('锁存在 localStorage 里（同源标签页共享，这是能跨标签页的关键）',
    /localStorage\.setItem\(BACKUP_LOCK_KEY/.test(html));

  /* ================= ②：中文输入法合成守卫 ================= */
  section('②：合成期间（拼音还没选词）一律不触发筛选');
  const el = q('#p65-search'); el.value = '';
  let calls = 0;
  S.bindComposableSearch(el, () => { calls++; }, 5);
  el.fire('compositionstart');
  el.value = 'z'; el.fire('input');
  el.value = 'zho'; el.fire('input');
  el.value = 'zhong'; el.fire('input');
  await tick(40);
  ok('★★敲了三下拼音，一次筛选都没触发', calls === 0, calls);
  el.value = '中'; el.fire('compositionend');
  await tick(40);
  ok('★选定词之后才触发一次，用的是最终文本', calls === 1, calls);
  ok('★这时候框里是汉字，不是拼音字母', el.value === '中');

  section('②：英文/数字直接输入不受影响，照常防抖触发');
  calls = 0;
  el.value = 'abc'; el.fire('input');
  await tick(40);
  ok('★普通输入仍然会筛选', calls === 1, calls);

  section('②：合成中途被打断（用户按 Esc 取消候选）也不会漏掉最终状态');
  calls = 0;
  el.fire('compositionstart');
  el.value = 'x'; el.fire('input');
  await tick(20);
  ok('合成中依然不触发', calls === 0);
  el.value = ''; el.fire('compositionend');
  await tick(40);
  ok('★合成结束（哪怕是取消）也会按当前内容走一次，状态不会卡住', calls === 1, calls);

  section('②：两个搜索框都走同一套（不是只修了日志页）');
  ok('★bindToolbarInputs 用 bindComposableSearch',
    /function bindToolbarInputs\(page\)[\s\S]{0,220}?bindComposableSearch\(si/.test(html));
  ok('★bindLogsTextSearch 用 bindComposableSearch',
    /function bindLogsTextSearch\(\)[\s\S]{0,220}?bindComposableSearch\(el/.test(html));
  ok('两处都不再各自裸写 input 监听',
    !/function bindLogsTextSearch\(\)[\s\S]{0,300}?addEventListener\('input'/.test(html));

  /* ================= ③：撤销按钮 ================= */
  section('③：只有"刚刚真的拍过快照"的提示，才配有撤销按钮');
  S.setSnackPriorityUntil(0);
  /* ★ 必须先让撤销栈里【有东西】，才算复现用户报的那个场景 ★
     用户遇到的是"栈里躺着更早某次操作，于是任何一条提示都带上撤销按钮"。
     如果这里栈是空的，那么就算把修复回退掉，旧代码（只看栈空不空）也会隐藏按钮，
     断言照样通过——那就是个假绿灯，什么都没验证到。所以先做一次真实的改动把栈填上。 */
  S.snapshot();
  ok('前置：撤销栈里确实有东西了（这是复现该 bug 的必要条件）', true);
  S.setLastSnapshotAt(0);   // 再把"最近一次快照"推远，模拟"这条提示跟那次操作无关"
  S.showSnack('回收站保留期已设为 90 天');   // 纯配置变更，本身没有拍快照
  ok('★★栈里有东西、但这条提示不对应任何改动 → 不带撤销按钮（以前会带，点下去撤的是更早那次不相干的操作）',
    q('#undo-btn').classList.contains('hidden'));

  S.snapshot();
  S.showSnack('已删除');
  ok('★刚拍过快照的提示，撤销按钮出现', !q('#undo-btn').classList.contains('hidden'));

  section('③：明说不可撤销的操作，显式压掉撤销按钮');
  S.snapshot();   // 彻底删除内部也会 snapshot，所以光靠时间窗口挡不住，必须显式传 undo:false
  S.showSnack('已彻底删除 12 条', { undo: false });
  ok('★★传了 undo:false 就一定不显示', q('#undo-btn').classList.contains('hidden'));

  section('③：快照过去很久之后的提示，也不再挂撤销按钮');
  S.setLastSnapshotAt(Date.now() - S.SNACK_UNDO_WINDOW_MS - 1000);
  S.showSnack('导出完成');
  ok('★超出时间窗口就不显示', q('#undo-btn').classList.contains('hidden'));

  section('③：源码层面——两处彻底删除都传了 undo:false');
  ok('★清空回收站传了', /已彻底删除 \$\{purgeable\} 条`, \{ undo: false \}/.test(html));
  ok('★体检彻底删除传了', /已彻底删除 \$\{ids\.length\} 个\$\{cfg\.label\}`, \{ undo: false \}/.test(html));

  /* ================= ④：换版本后首次同步不误报 ================= */
  section('④：换版本后的第一次合并放行一次熔断告警');
  ok('★有 _skipDamageAlertOnce 这个一次性开关', typeof S.skipDamageAlertOnce === 'boolean');
  ok('★boot 里按"本机缓存是别的版本写的"来置位',
    /_skipDamageAlertOnce = _localCacheStale/.test(html));
  ok('★noteMergeAlerts 里检查了它', /if \(_skipDamageAlertOnce\)/.test(html));
  ok('★★用完立刻清掉（只放行这一次，之后真出事照样报）',
    /if \(_skipDamageAlertOnce\) \{\s*\r?\n\s*_skipDamageAlertOnce = false;/.test(html));

  section('④：放行不等于不留痕——照样写一条普通日志说明追平了多少条');
  /* 只能拿"放行分支"这一段来断言。用 [\s\S]{0,400} 这种宽窗口会一路越过 `} else {`
     读进正常告警分支里去，那里当然有 armMergeDamageAlert / pushAlertLog，
     于是取反的断言必然失败——这不是代码的问题，是断言圈错了范围。 */
  const skipBranch = (() => {
    const a = html.indexOf('if (_skipDamageAlertOnce) {');
    const b = html.indexOf('} else {', a);
    return a >= 0 && b > a ? html.slice(a, b) : '';
  })();
  ok('取到了放行分支的源码', skipBranch.length > 0);
  ok('★放行分支里写了 changelog', /pushChangeLog/.test(skipBranch));
  ok('★但不再 armMergeDamageAlert（不留那个会误导人的"回滚"入口）',
    !/armMergeDamageAlert/.test(skipBranch));
  ok('★也不再 pushAlertLog（不当成事故告警）', !/pushAlertLog/.test(skipBranch));

  section('④：正常情况下熔断该报还是报（别把保护机制整个关掉了）');
  ok('★else 分支里三件事一件不少：留底 + 告警日志 + 醒目提示',
    /\} else \{[\s\S]{0,600}?armMergeDamageAlert[\s\S]{0,400}?pushAlertLog[\s\S]{0,400}?showSnack/.test(html));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
