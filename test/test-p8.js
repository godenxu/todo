/* P8 里程碑呈报层级 + 宽表任务/里程碑一体导入 测试。用法：node test/test-p8.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

const csvVal = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const buildWideCSV = rowsObj => {
  const heads = S.wideImportHeaders();
  const lines = [heads.join(',')];
  rowsObj.forEach(o => lines.push(heads.map(h => csvVal(o[h])).join(',')));
  return lines.join('\n');
};

async function main() {
  await tick(60);

  section('里程碑最高呈报层级：schema 与选项');
  ok('里程碑 schema 里有 report_level 字段', !!S.fieldDef('milestone', 'report_level'));
  ok('三个选项：处室领导/部门领导/行领导',
     S.REPORT_LEVELS.map(r => r.label).join(',') === '处室领导,部门领导,行领导');
  ok('里程碑 CSV 表头包含最高呈报层级', S.csvHeaders('milestone').includes('report_level'));

  section('reportLevelFromLabel：中文标签转回枚举值');
  ok('"处室领导" → section', S.reportLevelFromLabel('处室领导') === 'section');
  ok('"部门领导" → department', S.reportLevelFromLabel('部门领导') === 'department');
  ok('"行领导" → bank', S.reportLevelFromLabel('行领导') === 'bank');
  ok('空文本 → 空字符串（不报错）', S.reportLevelFromLabel('') === '');
  ok('无法识别的文本 → 空字符串（不报错、不瞎猜）', S.reportLevelFromLabel('随便写的') === '');

  section('宽表模板：列头顺序与数量');
  const headers = S.wideImportHeaders();
  ok('一共 23 列（5 个任务字段 + 6 组 × 3 个里程碑字段）', headers.length === 23, headers.length);
  ok('前 5 列是任务字段，且顺序对', headers.slice(0, 5).join(',') ===
     '所属工作项,任务项编号,任务项名称,任务项牵头人,任务项参与人');
  ok('第 1 组里程碑列头正确', headers.slice(5, 8).join(',') === '里程碑时间1,里程碑交付物1,里程碑交付物最高呈报1');
  ok('第 6 组里程碑列头正确', headers.slice(20, 23).join(',') === '里程碑时间6,里程碑交付物6,里程碑交付物最高呈报6');

  section('宽表导入：覆盖模式新建任务 + 多组里程碑');
  const w0 = S.DB.works.find(w => !w.deleted_at);
  const taskCountBefore = S.DB.tasks.length, msCountBefore = S.DB.milestones.length;
  const newCode = '99999999';   // 刻意用一个几乎不可能已存在的任务编号，确保这次是"新建"
  const csv1 = buildWideCSV([{
    所属工作项: w0.name, 任务项编号: newCode, 任务项名称: '宽表导入的任务',
    任务项牵头人: '张三', 任务项参与人: '李四、王五',
    里程碑时间1: '2026-09-01', 里程碑交付物1: '初稿', 里程碑交付物最高呈报1: '处室领导',
    里程碑时间3: '2026-10-01', 里程碑交付物3: '终稿', 里程碑交付物最高呈报3: '行领导',
    // 第 2、4、5、6 组留空，不应该生成里程碑
  }]);
  const res1 = await S.applyWideImport('merge', csv1);
  ok('新增了 1 条任务', S.DB.tasks.length === taskCountBefore + 1, [S.DB.tasks.length, taskCountBefore]);
  ok('返回结果统计任务数正确', res1.taskN === 1, res1);
  const created = S.DB.tasks.find(t => t.code === newCode);
  ok('任务字段正确写入', !!created && created.title === '宽表导入的任务' && created.owner === '张三', created);
  ok('参与人按顿号正确切分成两个人', JSON.stringify(created.assignees) === JSON.stringify(['李四', '王五']));
  ok('所属工作按名称正确匹配', created.work === w0.id);
  const cps1 = S.DB.milestones.filter(m => m.task === created.id && !m.deleted_at);
  ok('只生成了 2 条里程碑（跳过了空的 2/4/5/6 组）', cps1.length === 2, cps1.length);
  ok('里程碑交付物内容正确', cps1.some(m => m.deliverable === '初稿') && cps1.some(m => m.deliverable === '终稿'));
  ok('里程碑最高呈报层级正确映射', cps1.find(m => m.deliverable === '初稿').report_level === 'section' &&
     cps1.find(m => m.deliverable === '终稿').report_level === 'bank');
  ok('返回结果统计里程碑数正确', res1.msN === 2, res1);

  section('宽表导入：覆盖模式对同一任务编号再次导入 → 更新并整体替换里程碑');
  const csv2 = buildWideCSV([{
    所属工作项: w0.name, 任务项编号: newCode, 任务项名称: '宽表导入的任务（改过）',
    任务项牵头人: '张三', 任务项参与人: '李四',
    里程碑时间1: '2026-11-01', 里程碑交付物1: '换了一版的交付物', 里程碑交付物最高呈报1: '部门领导',
  }]);
  const taskCountBefore2 = S.DB.tasks.length;
  const res2 = await S.applyWideImport('merge', csv2);
  ok('第二次导入没有新增任务（按编号认领了同一条）', S.DB.tasks.length === taskCountBefore2, [S.DB.tasks.length, taskCountBefore2]);
  const updated = S.DB.tasks.find(t => t.code === newCode);
  ok('标题被更新', updated.title === '宽表导入的任务（改过）');
  ok('还是原来那条任务（id 不变）', updated.id === created.id);
  const cps2 = S.DB.milestones.filter(m => m.task === updated.id && !m.deleted_at);
  ok('旧的里程碑被整体替换，现在只剩这次导入的 1 条', cps2.length === 1, cps2.length);
  ok('新里程碑内容正确', cps2[0].deliverable === '换了一版的交付物' && cps2[0].report_level === 'department');
  ok('旧的两条里程碑变成软删除状态，不是凭空消失', S.DB.milestones.some(m => m.id === cps1[0].id && m.deleted_at));

  section('宽表导入：找不到所属工作项的行会被跳过并统计');
  const csv3 = buildWideCSV([
    { 所属工作项: '这个工作名字肯定不存在_xyz', 任务项编号: '', 任务项名称: '找不到工作的任务' },
    { 所属工作项: w0.name, 任务项编号: '', 任务项名称: '正常能导入的任务' },
  ]);
  const taskCountBefore3 = S.DB.tasks.length;
  const res3 = await S.applyWideImport('merge', csv3);
  ok('只成功导入了 1 条（另一条因工作项找不到被跳过）', res3.taskN === 1, res3);
  ok('跳过计数是 1', res3.skipped === 1, res3);
  ok('任务确实只增加了 1 条', S.DB.tasks.length === taskCountBefore3 + 1);

  section('宽表导入：增量模式无视编号冲突，总是新增');
  const taskCountBefore4 = S.DB.tasks.length;
  const csv4 = buildWideCSV([{ 所属工作项: w0.name, 任务项编号: newCode, 任务项名称: '增量模式新增的任务' }]);
  const res4 = await S.applyWideImport('append', csv4);
  ok('增量模式新增了一条，而不是覆盖前面那条同编号任务', S.DB.tasks.length === taskCountBefore4 + 1, [S.DB.tasks.length, taskCountBefore4]);
  const appended = S.DB.tasks.find(t => t.title === '增量模式新增的任务');
  ok('新任务的编号是自动生成的，不是照抄 CSV 里的编号', !!appended && appended.code !== newCode, appended && appended.code);
  ok('原来那条编号为 newCode 的任务没有被顶掉', S.DB.tasks.find(t => t.code === newCode).title === '宽表导入的任务（改过）');

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
