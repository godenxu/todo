/* ============================================================================
   演示数据混入盘点（只读，不改任何东西）
   ----------------------------------------------------------------------------
   为什么需要它：演示数据和真实数据混到一起过一次。原因是浏览器的本机缓存——
   一台平时连生产共享文件夹的电脑，localStorage 里存着真实数据；它直接去连演示文件夹，
   程序会把两边【合并】（这正是它该做的），于是假数据就进了真实数据里。
   demo/README.md 第一节写的"先断开、清空本机数据，再连测试文件夹"就是为了避免这个。

   麻烦的地方在于：演示数据不只造了虚构的工作，也给【处里真实的那 13 项工作】造了任务。
   光看工作归属分不出来，所以这里用三层判据，并且把把握程度分开报：

     ① 确定是演示的：挂在虚构工作下，或者标签是 重点/攻坚/常规
        （标签这条判据来自实测：处里真实数据的标签一直是"测试"或空，从没用过这三个）
     ② 高度疑似：标题正好套用了生成器那 12 个模板之一（"编制…实施方案""…季度汇报"…）
     ③ 其余：按真实处理

   如果同目录下有更早的 `工作管理备份_*.json`，脚本会自动拿它当锚点：
   凡是备份里就有的记录，一律算真实，不管标签像不像——这是最硬的证据。

   识别特征跟 gen-demo-data.js 共用同一份定义（EXTRA_WORKS / FAKE_PEOPLE / TASK_TPL / TAGS），
   演示数据以后改了，这里自动跟上。

   用法：
     node tools/audit-demo-mix.js                          # 盘点仓库根目录那个共享数据文件
     node tools/audit-demo-mix.js  D:/某目录/x.json        # 盘点指定文件
     node tools/audit-demo-mix.js  x.json  基准备份.json   # 指定用哪份备份当锚点

   看完之后要不要清理、怎么清理，由人来定。脚本刻意不提供"一键删除"：
   删的是共享文件里全处的数据，不该由一个命令行脚本代劳。
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const D = require(path.join(__dirname, 'gen-demo-data.js'));

const ROOT = path.join(__dirname, '..');
const FILE = process.argv[2] || path.join(ROOT, '科技规划处工作管理.json');
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

/* 一份备份能不能当"哪些是真实数据"的锚点，取决于它自己干不干净。
   ★ 这一步不能省 ★ 演示数据混进来之后导出的备份，里面同样带着假数据；
   拿它当锚点会把所有污染都认成真实的，盘出来一片"没问题"——最开始就踩了这个坑。
   判据用最硬的两条：有没有虚构人员的账号、有没有虚构工作的编号。 */
function looksPolluted(d) {
  if (!d) return true;
  const fakeNames = new Set(D.FAKE_PEOPLE.concat([D.RETIRED_ACCOUNT[0]]));
  const extraCodes = new Set(D.EXTRA_WORK_CODES);
  if ((d.users || []).some(u => u && fakeNames.has(u.name))) return true;
  if ((d.works || []).some(w => w && extraCodes.has(w.code))) return true;
  return false;
}
// 没指定基准备份就在同目录里从新到旧找，挑第一份【自己是干净的】
function findRef() {
  if (process.argv[3]) return { path: process.argv[3], forced: true };
  try {
    const dir = path.dirname(FILE);
    const cands = fs.readdirSync(dir).filter(f => /^工作管理备份_.*\.json$/.test(f)).sort().reverse();
    const skipped = [];
    for (const f of cands) {
      const p = path.join(dir, f);
      if (looksPolluted(readJSON(p))) { skipped.push(f); continue; }
      return { path: p, skipped };
    }
    return { path: '', skipped };
  } catch (e) { return { path: '', skipped: [] }; }
}

function main() {
  if (!fs.existsSync(FILE)) { console.error('找不到文件：' + FILE); process.exit(1); }
  const j = readJSON(FILE);
  if (!j || !Array.isArray(j.duties) || !Array.isArray(j.tasks)) {
    console.error('不是本应用的共享数据格式：' + FILE); process.exit(1);
  }
  const refInfo = findRef();
  const refPath = refInfo.path;
  const ref = refPath ? readJSON(refPath) : null;
  const refTaskIds = new Set(ref && Array.isArray(ref.tasks) ? ref.tasks.map(t => t.id) : []);
  const refWorkIds = new Set(ref && Array.isArray(ref.works) ? ref.works.map(w => w.id) : []);

  const works = j.works || [], tasks = j.tasks || [], ms = j.milestones || [], users = j.users || [];
  const thisYear = new Date().getFullYear();
  const fakeNames = new Set(D.FAKE_PEOPLE.concat([D.RETIRED_ACCOUNT[0]]));
  const extraCodes = new Set(D.EXTRA_WORK_CODES);
  const extraNames = new Set(D.EXTRA_WORKS.map(w => w[2]));
  const demoTags = new Set(D.TAGS.filter(Boolean));      // 重点 / 攻坚 / 常规（空标签不能当判据）
  // 生成器的标题模板："编制{n}实施方案" → 前后缀，用来认出套模板生成的标题
  const tplParts = D.TASK_TPL.map(t => t[0].split('{n}'));
  const looksTemplated = title => tplParts.some(([pre, suf]) =>
    String(title || '').startsWith(pre) && String(title || '').endsWith(suf) && (pre || suf));

  /* ---- 工作 ---- */
  const fakeWorks = works.filter(w => !refWorkIds.has(w.id)
    && (extraCodes.has(w.code) || extraNames.has(w.name)
      || (w.year === thisYear - 1 && D.LAST_YEAR_WORKS.includes(w.code))
      || (w.code === D.DELETED_WORK[0] && w.name === D.DELETED_WORK[2])));
  const fakeWorkIds = new Set(fakeWorks.map(w => w.id));

  /* ---- 任务：三档 ---- */
  const sure = [], likely = [];
  tasks.forEach(t => {
    if (refTaskIds.has(t.id)) return;                    // 备份里就有 → 铁定是真实的
    if (fakeWorkIds.has(t.work)) { sure.push(t); return; }
    if (demoTags.has(t.custom)) { sure.push(t); return; }
    if (looksTemplated(t.title)) { likely.push(t); return; }
  });
  const sureIds = new Set(sure.map(t => t.id));
  const likelyIds = new Set(likely.map(t => t.id));
  const fakeMs = ms.filter(m => sureIds.has(m.task));
  const likelyMs = ms.filter(m => likelyIds.has(m.task));

  /* ---- 账号 / 职责 ---- */
  const fakeUsers = users.filter(u => fakeNames.has(u.name));
  const fakeDuty = (j.duties || []).filter(d => d.code === D.DELETED_DUTY[0] && d.name === D.DELETED_DUTY[2]);
  // 真实工作下、真实任务上被填成虚构人员的（这类任务本身是真的，改人名就行，别删）
  const fakeOnRealTasks = tasks.filter(t => !sureIds.has(t.id) && !likelyIds.has(t.id)
    && (fakeNames.has(t.owner) || (t.assignees || []).some(a => fakeNames.has(a))));

  /* ---- 输出 ---- */
  console.log('盘点文件：' + FILE);
  console.log('文件规模：职责 ' + (j.duties || []).length + '、工作 ' + works.length
    + '、任务 ' + tasks.length + '、里程碑 ' + ms.length + '、账号 ' + users.length);
  console.log('最后写入：' + (j.lastWriteBy || '(未知)') + ' / ' + (j.lastWriteApp || '(未知)') + ' / ' + (j.lastWriteAt || ''));
  if (ref) {
    console.log('对照备份：' + path.basename(refPath) + '（任务 ' + refTaskIds.size + ' 条，里面有的一律算真实）');
  } else {
    console.log('对照备份：没有可用的干净备份，只能靠特征判断（把握会低一些）');
  }
  if ((refInfo.skipped || []).length) {
    console.log('  跳过了这些备份——它们自己就带着演示数据，不能当基准：' + refInfo.skipped.join('、'));
  }
  console.log('─'.repeat(70));

  const total = fakeWorks.length + sure.length + fakeUsers.length + fakeDuty.length;
  if (!total && !likely.length) {
    console.log('✅ 没有发现演示数据的痕迹，这份文件是干净的。');
    process.exit(0);
  }

  console.log('⚠ 这份文件里【混有演示数据】。\n');
  console.log('【一】确定是造出来的');
  if (fakeDuty.length) console.log('  职责    ' + fakeDuty.map(d => d.code + ' ' + d.name).join('、'));
  if (fakeWorks.length) {
    console.log('  工作    ' + fakeWorks.length + ' 项：');
    fakeWorks.forEach(w => console.log('      ' + (w.code || '(无编号)') + '  ' + w.name
      + '  ' + (w.year || '') + '年  牵头人=' + (w.owner || '') + (w.deleted_at ? '  【已删除】' : '')));
  }
  if (sure.length) {
    const byWhy = { 挂在虚构工作下: 0, 标签是重点攻坚常规: 0 };
    sure.forEach(t => { if (fakeWorkIds.has(t.work)) byWhy.挂在虚构工作下++; else byWhy.标签是重点攻坚常规++; });
    console.log('  任务    ' + sure.length + ' 条（其中挂在虚构工作下 ' + byWhy.挂在虚构工作下
      + ' 条、挂在真实工作下但标签是"重点/攻坚/常规" ' + byWhy.标签是重点攻坚常规 + ' 条）');
  }
  if (fakeMs.length) console.log('  里程碑  ' + fakeMs.length + ' 个（挂在上述任务下）');
  if (fakeUsers.length) console.log('  账号    ' + fakeUsers.map(u => u.name + '(' + u.role
    + (u.deleted_at ? '·已停用' : '') + ')').join('、'));

  if (likely.length) {
    console.log('\n【二】高度疑似（标题正好套用了生成器的模板，但标签为空、也不在虚构工作下——请人工过一眼）');
    console.log('  任务 ' + likely.length + ' 条、里程碑 ' + likelyMs.length + ' 个：');
    likely.slice(0, 15).forEach(t => console.log('      ' + (t.code || '') + '  ' + (t.title || '')
      + '  牵头人=' + (t.owner || '') + '  建于 ' + String(t.created_at || '').slice(0, 10)));
    if (likely.length > 15) console.log('      …… 其余 ' + (likely.length - 15) + ' 条略');
  }

  if (fakeOnRealTasks.length) {
    console.log('\n【三】真实任务被填上了虚构人员（任务本身是真的，把人名改回来就行，别整条删）');
    console.log('  共 ' + fakeOnRealTasks.length + ' 条：');
    fakeOnRealTasks.slice(0, 15).forEach(t => console.log('      ' + (t.code || '') + '  ' + (t.title || '')
      + '  牵头人=' + (t.owner || '(空)') + '  参与人=' + ((t.assignees || []).join('/') || '(空)')));
    if (fakeOnRealTasks.length > 15) console.log('      …… 其余 ' + (fakeOnRealTasks.length - 15) + ' 条略');
  }

  console.log('\n' + '─'.repeat(70));
  console.log('真实数据这一面：');
  const realWorkCodes = D.REAL_WORK_CODES.filter(c => works.some(w => w.code === c && w.year === thisYear && !w.deleted_at));
  console.log('  处里原有的 ' + D.REAL_WORK_CODES.length + ' 项工作，本年度在用的 ' + realWorkCodes.length + ' 项'
    + (realWorkCodes.length === D.REAL_WORK_CODES.length ? '，一项不缺 ✅'
      : '，缺 ' + D.REAL_WORK_CODES.filter(c => !realWorkCodes.includes(c)).join('、')));
  if (ref) {
    const gone = (ref.tasks || []).filter(rt => !tasks.some(t => t.id === rt.id));
    const purgedIds = new Set((j.purged || []).filter(p => p && p.entity === 'task').map(p => p.id));
    const withTomb = gone.filter(t => purgedIds.has(t.id));      // 有墓碑 = 有人在页面上正经彻底删的
    const noTomb = gone.filter(t => !purgedIds.has(t.id));       // 没墓碑 = 来路不明，值得追一下
    console.log('  对照备份里的 ' + refTaskIds.size + ' 条任务，当前文件里还在 ' + (refTaskIds.size - gone.length) + ' 条'
      + (gone.length ? '，不见了 ' + gone.length + ' 条' : ' ✅'));
    if (withTomb.length) {
      console.log('    · 其中 ' + withTomb.length + ' 条留有"彻底删除"的墓碑，是有人在页面上正经删掉的：'
        + withTomb.map(t => (t.code || t.id) + ' ' + (t.title || '')).join('；'));
    }
    if (noTomb.length) {
      console.log('    · ⚠ 另有 ' + noTomb.length + ' 条【连墓碑都没有】就消失了，来路不明，建议追一下：');
      noTomb.slice(0, 10).forEach(t => console.log('        ' + (t.code || t.id) + '  ' + (t.title || '')));
    }
    const goneMs = (ref.milestones || []).filter(rm => !ms.some(m => m.id === rm.id));
    if (goneMs.length) console.log('  对照备份里的里程碑不见了 ' + goneMs.length + ' 个');
  }
  const realish = tasks.length - sure.length - likely.length;
  console.log('  按上面口径算，真实任务约 ' + realish + ' 条');

  console.log('\n' + '─'.repeat(70));
  console.log('要清理的话，建议顺序（都在页面里操作，别手工改 JSON）：');
  console.log('  1. 先在「数据」页导出一份完整备份；');
  console.log('  2. 工作页把【一】里列出的虚构工作逐项「停用」——会连带删掉名下任务和里程碑；');
  console.log('  3. 任务页按「标签」筛出 重点/攻坚/常规 三类，批量删除（真实数据从没用过这三个标签）；');
  console.log('  4. 权限页删掉虚构人员的账号；职责页删掉那条"（已撤销）临时性专项支援工作"；');
  console.log('  5. 【二】那批人工过一眼，确认是演示的再删；');
  console.log('  6. 【三】那批把牵头人/参与人改回来；');
  console.log('  7. 最后到「数据」页跑一次数据体检，确认没留下无主里程碑。');
  console.log('  另一条路：如果这段时间的真实改动不多，直接从演示数据混入之前的备份恢复更省事。');
  process.exit(0);
}
main();
