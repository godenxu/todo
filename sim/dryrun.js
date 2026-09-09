/* 上线预演：拿真实生产数据，用新版本走一遍"首次连接 → 合并 → 写回"，检查有没有任何数据损失 */
const { sandbox: S } = require('C:/Users/Administrator/Documents/Claude/Todo/test/harness.js');
const fs = require('fs');
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const cp = o => JSON.parse(JSON.stringify(o));
const PROD = process.env.PROD || 'C:/Users/Administrator/Documents/Claude/Todo/科技规划处工作管理.json';

async function main() {
  await tick(60);
  const prod = JSON.parse(fs.readFileSync(PROD, 'utf8'));
  const before = {
    duties: (prod.duties || []).length, works: (prod.works || []).length,
    tasks: (prod.tasks || []).length, milestones: (prod.milestones || []).length,
    changelog: (prod.changelog || []).length, users: (prod.users || []).length,
    purged: (prod.purged || []).length,
  };
  console.log('生产数据（升级前）:', JSON.stringify(before));
  console.log('文件里的 schemaVersion:', prod.schemaVersion, ' 最后写入版本:', prod.lastWriteApp || '(无)');

  // 一台"刚换上新版、本机缓存就是这份生产数据"的机器
  const db = Object.assign({}, cp(prod), { dashboardConfig: null, syncBase: null,
    settings: { me: (prod.users || [])[0] ? prod.users[0].name : '管理员', year: 2026 } });
  const file = { payload: cp(prod) };

  // ① 第一次同步（无基线，退回老规则）
  let local = S.syncPayload(db);
  let merged = S.normalizeMergedRecords(S.mergeSyncPayload(local, file.payload, db.syncBase));
  Object.assign(db, merged);
  const contributed = S.hasLocalContribution(local, file.payload, db.syncBase);
  if (contributed) { file.payload = cp(merged); db.syncBase = S.buildSyncBase(merged); }
  else db.syncBase = S.buildSyncBase(file.payload);

  const after = {
    duties: (db.duties || []).length, works: (db.works || []).length,
    tasks: (db.tasks || []).length, milestones: (db.milestones || []).length,
    changelog: (db.changelog || []).length, users: (db.users || []).length,
    purged: (db.purged || []).length,
  };
  console.log('\n① 首次同步后:', JSON.stringify(after));
  const lost = Object.keys(before).filter(k => after[k] < before[k]);
  console.log('  条数变少的类别:', lost.length ? lost.map(k => k + ' ' + before[k] + '→' + after[k]).join(', ') : '无 ✅');
  console.log('  这次需要写文件吗:', contributed);

  // ② 逐条比对内容有没有被改动（除了规整可能修正的类型）
  const idx = l => new Map((l || []).map(r => [r.id || r.code, r]));
  let changedFields = [];
  [['tasks', 'id'], ['works', 'id'], ['milestones', 'id'], ['duties', 'code']].forEach(([k, pk]) => {
    const b = idx(prod[k]), a = idx(db[k]);
    b.forEach((rec, key) => {
      const now = a.get(key);
      if (!now) { changedFields.push(k + ' 整条不见了: ' + key); return; }
      Object.keys(rec).forEach(f => {
        if (JSON.stringify(rec[f]) !== JSON.stringify(now[f])) changedFields.push(`${k}/${key}/${f}: ${JSON.stringify(rec[f])} → ${JSON.stringify(now[f])}`);
      });
    });
  });
  console.log('\n② 逐字段比对（升级前 vs 升级后）:');
  console.log('  有变化的字段数:', changedFields.length);
  changedFields.slice(0, 10).forEach(c => console.log('   ·', c));

  // ③ 再同步两轮，确认稳定（不会反复写）
  let writes = 0;
  for (let i = 0; i < 3; i++) {
    local = S.syncPayload(db);
    const m2 = S.normalizeMergedRecords(S.mergeSyncPayload(local, file.payload, db.syncBase));
    Object.assign(db, m2);
    if (S.hasLocalContribution(local, file.payload, db.syncBase)) { file.payload = cp(m2); db.syncBase = S.buildSyncBase(m2); writes++; }
    else db.syncBase = S.buildSyncBase(file.payload);
  }
  console.log('\n③ 之后连续同步 3 轮，写文件次数:', writes, writes === 0 ? '✅ 已稳定，不会空转重写' : '⚠ 还在反复写');

  // ④ 体检：升级后数据健康度
  S.DB.duties = cp(db.duties); S.DB.works = cp(db.works);
  S.DB.tasks = cp(db.tasks); S.DB.milestones = cp(db.milestones);
  S.DB.purged = cp(db.purged || []); S.rebuildIndex();
  const h = S.healthCheck();
  console.log('\n④ 升级后数据体检:');
  (h.issues || []).forEach(i => console.log(`   [${i.level}] ${i.msg}`));
  if (!(h.issues || []).length) console.log('   没有发现问题 ✅');

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
