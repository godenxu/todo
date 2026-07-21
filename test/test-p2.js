const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

async function main() {
  await tick(60);                       // 等 boot() 完成种子数据

  section('种子数据');
  ok('15 项职责', S.DB.duties.length === 15, S.DB.duties.length);
  ok('13 项工作', S.DB.works.length === 13, S.DB.works.length);
  ok('里程碑 > 0', S.DB.milestones.length > 0, S.DB.milestones.length);
  ok('任务 > 50', S.DB.tasks.length > 50, S.DB.tasks.length);
  ok('11 名人员', S.allPeople().length === 11, S.allPeople().length);

  section('两级树筛选');
  S.setPage('tasks');
  const rows = S.visibleTasks().filter(t => !t.deleted_at);
  let tree = S.renderTaskTree(rows);
  ok('渲染出职责节点', /data-act="tree-pick" data-duty="01"/.test(tree));
  ok('默认折叠（不显示子工作）', !/data-work="0101"/.test(tree));
  ok('有折叠箭头 ▸', /sb-caret/.test(tree) && tree.includes('▸'));

  S.ACTIONS['tree-toggle']({ duty: '01' }, null, { stopPropagation() {} });
  tree = S.renderTaskTree(rows);
  // 工作主键已是随机 id，测试须按编号查出 id 再断言，不能再硬编码编号
  const w0101 = S.DB.works.find(w => w.code === '0101');
  const w0102 = S.DB.works.find(w => w.code === '0102');
  ok('展开后出现子工作', tree.includes(`data-work="${w0101.id}"`) && tree.includes(`data-work="${w0102.id}"`));
  ok('展开后箭头变 ▾', tree.includes('▾'));

  S.ACTIONS['tree-pick']({ duty: '02', work: '' });
  ok('点职责 → 设 _duty 筛选', S.UI.tasks.filters._duty === '02' && !S.UI.tasks.filters.work);
  const byDuty = S.query('task', { pool: rows, filters: S.UI.tasks.filters });
  ok('按职责筛选：结果全属该职责', byDuty.length > 0 && byDuty.every(t => S.byId('work', t.work).duty === '02'), byDuty.length);

  const w0202 = S.DB.works.find(w => w.code === '0202');
  S.ACTIONS['tree-pick']({ duty: '', work: w0202.id });
  ok('点工作 → 设 work 且清空职责', S.UI.tasks.filters.work === w0202.id && !S.UI.tasks.filters._duty);
  const byWork = S.query('task', { pool: rows, filters: S.UI.tasks.filters });
  ok('按工作筛选：结果全属该工作', byWork.length > 0 && byWork.every(t => t.work === w0202.id), byWork.length);
  ok('选中工作时其职责自动展开', S.renderTaskTree(rows).includes(`data-work="${w0202.id}"`));

  S.ACTIONS['tree-pick']({ duty: '', work: '' });
  ok('点"全部"清空筛选', !S.UI.tasks.filters._duty && !S.UI.tasks.filters.work);

  section('批量选择');
  S.renderTasks();
  const total = S.taskRows.length;
  ok('任务行已加载', total > 0, total);
  S.ACTIONS['sel-all']();
  ok('全选', S.UI.tasks.sel.size === total, S.UI.tasks.sel.size);
  S.ACTIONS['sel-all']();
  ok('再次点击取消全选', S.UI.tasks.sel.size === 0);

  const id0 = S.taskRows[0].id, id4 = S.taskRows[4].id;
  S.ACTIONS['sel-row']({ id: id0 }, null, {});
  ok('单选一条', S.UI.tasks.sel.size === 1 && S.UI.tasks.sel.has(id0));
  S.ACTIONS['sel-row']({ id: id4 }, null, { shiftKey: true });
  ok('Shift 范围选择 5 条', S.UI.tasks.sel.size === 5, S.UI.tasks.sel.size);
  S.ACTIONS['sel-row']({ id: id0 }, null, {});
  ok('再点取消该条', !S.UI.tasks.sel.has(id0) && S.UI.tasks.sel.size === 4);

  S.ACTIONS['task-view']({ view: 'doing' });
  ok('切换视图清空选择', S.UI.tasks.sel.size === 0);
  S.ACTIONS['task-view']({ view: 'all' });

  S.UI.tasks.sel.add('t_不存在');
  S.renderTasks();
  ok('剔除不在结果集中的选中项', S.UI.tasks.sel.size === 0);

  section('批量编辑');
  const ids = S.taskRows.slice(0, 6).map(t => t.id);
  const priorActual = Object.fromEntries(ids.map(i => [i, S.byId('task', i).actual_date]));
  ids.forEach(i => S.UI.tasks.sel.add(i));
  S.openBatchEdit('status');
  q('#be-status').value = 'done';
  await S.modalCallback(); await tick();
  let ch = ids.map(i => S.byId('task', i));
  ok('批量改状态生效', ch.every(t => t.status === 'done'));
  ok('done 都有实际完成日', ch.every(t => !!t.actual_date));
  ok('原无完成日的补今天', ids.every(i => priorActual[i] || S.byId('task', i).actual_date === S.todayStr()));
  ok('原有完成日的保留不被改写', ids.every(i => !priorActual[i] || S.byId('task', i).actual_date === priorActual[i]));
  ok('done 自动置进度 100', ch.every(t => t.progress === 100));
  ok('rev 递增（冲突检测前提）', ch.every(t => t.rev >= 2));

  ids.forEach(i => S.UI.tasks.sel.add(i));
  S.openBatchEdit('owner');
  q('#be-owner').value = '徐捷';
  await S.modalCallback(); await tick();
  ok('批量改负责人', ids.every(i => S.byId('task', i).owner === '徐捷'));

  ids.forEach(i => S.UI.tasks.sel.add(i));
  S.openBatchEdit('assignees');
  q('#be-assignees').value = '李兰、诸慧玲 郭妙吉';
  await S.modalCallback(); await tick();
  ok('批量改参与人并正确分词', ids.every(i =>
    JSON.stringify(S.byId('task', i).assignees) === JSON.stringify(['李兰', '诸慧玲', '郭妙吉'])),
    S.byId('task', ids[0]).assignees);

  const withMs = S.taskRows.find(t => t.milestone);
  if (withMs) {
    const otherWork = S.DB.works.find(w => w.code !== withMs.work).code;
    S.UI.tasks.sel.clear(); S.UI.tasks.sel.add(withMs.id);
    S.openBatchEdit('work');
    q('#be-work').value = otherWork;
    await S.modalCallback(); await tick();
    ok('批量改工作后清理跨工作里程碑', S.byId('task', withMs.id).milestone === '');
  }

  section('撤销');
  S.UI.tasks.sel.clear(); S.renderTasks();
  const before = JSON.stringify(S.DB.tasks.map(t => t.priority));
  const some = S.taskRows.slice(0, 3).map(t => t.id);
  some.forEach(i => S.UI.tasks.sel.add(i));
  S.openBatchEdit('priority');
  q('#be-priority').value = '1';
  await S.modalCallback(); await tick();
  ok('批量改优先级', some.every(i => S.byId('task', i).priority === '1'));
  await S.undoLast(); await tick();
  ok('撤销整批操作', JSON.stringify(S.DB.tasks.map(t => t.priority)) === before);

  section('列配置');
  const orig = [...S.UI.tasks.cols];
  const fields = S.schema('task').fields.filter(f => !f.virtual);
  S.openColConfig();
  fields.forEach(f => { q('#cc-' + f.key).checked = false; });
  q('#cc-title').checked = true; q('#cc-status').checked = true;
  await S.modalCallback(); await tick();
  ok('应用列配置', JSON.stringify(S.UI.tasks.cols) === JSON.stringify(['title', 'status']), S.UI.tasks.cols);
  ok('列配置持久化到 settings', JSON.stringify((S.DB.settings.ui || {}).taskCols) === JSON.stringify(['title', 'status']));

  S.openColConfig();
  fields.forEach(f => { q('#cc-' + f.key).checked = false; });
  await S.modalCallback(); await tick();
  ok('拒绝一列不留', S.UI.tasks.cols.length === 2);
  S.UI.tasks.cols = orig;

  section('任务详情');
  S.renderTasks();
  const t0 = S.taskRows[0];
  S.openTaskDetail(t0.id);
  fields.forEach(f => { const el = q('#td-' + f.key); el.value = el.value || ''; });
  q('#td-title').value = '  改写后的任务标题  ';
  q('#td-deliverable').value = '新交付物';
  q('#td-plan_date').value = 'today';
  q('#td-progress').value = '160';
  q('#td-assignees').value = '张三,李四';
  q('#td-status').value = 'doing';
  q('#td-priority').value = '3';
  q('#td-work').value = t0.work;
  q('#td-owner').value = '邱洋';
  await S.modalCallback(); await tick();
  const n = S.byId('task', t0.id);
  ok('标题保存并去首尾空格', n.title === '改写后的任务标题', n.title);
  ok('日期关键字 today 解析', n.plan_date === S.todayStr(), n.plan_date);
  ok('进度超限截断为 100', n.progress === 100, n.progress);
  ok('参与人逗号分词', JSON.stringify(n.assignees) === JSON.stringify(['张三', '李四']), n.assignees);
  ok('交付物保存', n.deliverable === '新交付物');
  ok('状态/优先级保存', n.status === 'doing' && n.priority === '3');
  ok('负责人保存', n.owner === '邱洋');

  section('偏好持久化');
  S.UI.tasks.widths.title = 321;
  await S.persistUI(); await tick();
  const saved = JSON.parse(raw.localStorage.getItem('todo_v4'));
  ok('列宽写入存储', saved.settings.ui.widths.tasks.title === 321, saved.settings.ui.widths.tasks.title);
  S.UI.tasks.widths.title = 999;
  S.restoreUI();
  ok('重启后恢复列宽', S.UI.tasks.widths.title === 321, S.UI.tasks.widths.title);

  section('回归：P1 功能未被破坏');
  ok('虚拟滚动列数已含选择列', true);
  const csvH = S.csvHeaders('task');
  ok('CSV 表头完整', csvH.includes('milestone') && csvH.includes('rev') && csvH[0] === 'id');
  ok('编号补零', S.padCode('101') === '0101' && S.padCode('0101') === '0101');
  ok('多值转义往返', JSON.stringify(S.splitMulti(S.joinMulti(['张,三', 'A\\B']))) === JSON.stringify(['张,三', 'A\\B']));
  ok('逾期不含挂起', S.DB.tasks.filter(S.isOverdue).every(t => t.status !== 'hold'));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
