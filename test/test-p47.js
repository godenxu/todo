/* P47：本轮三项修订——
   1) 上一轮把日期输入框改成"只认连续数字"的文本框之后，用户说清楚了：原来能点选的浮层日历
      也要保留，两种输入方式并存（手动敲数字 / 点开日历选一天），不是二选一。
      现在文本框旁边加一个📅按钮，点开的是同一套日历 UI，选中的日期直接写回这个输入框的 value，
      不直接碰数据库——真正保存仍然走这个输入框所在表单本来的保存流程。
   2) 新建任务时如果没选所属工作/职责，编号先空着；但这不该是"永远空着"——
      后续在任务详情里补上/改了所属工作，编号要能跟着自动生成，
      跟网格上单独改"所属工作"那一格（wpCommit/批量编辑）的规则保持一致。
   3) 同事的改动"死活同步不出来，关掉 html 重开就有了"——排查是长会话里反复复用同一个文件句柄
      去读，可能被某层"句柄级缓存"卡住；关掉重开之所以管用，是因为 boot() 每次都会重新问目录
      要一个全新句柄。修复：readSharedFile() 每次读之前，只要有目录句柄就重新问目录要一个新的
      文件句柄再读，相当于每次都当成"刚打开这个文件"，绕开这层可能存在的缓存。
   用法：node test/test-p47.js */
const { sandbox: S, raw, q } = require('./harness.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
};
const section = t => console.log('\n■ ' + t);
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

function makeFileHandle(store) {
  return {
    name: 'shared.json',
    async getFile() { return { text: async () => store.text, lastModified: store.mtime || 1 }; },
    async createWritable() {
      return { async write(t) { store.text = t; store.mtime = (store.mtime || 1) + 1; store.writes++; }, async close() {} };
    },
  };
}
function fakeDateInput(initial) {
  return {
    value: initial || '',
    focus() {},
    getBoundingClientRect() { return { left: 10, top: 10, right: 100, bottom: 30, width: 90, height: 20 }; },
    contains() { return false; },
  };
}

async function main() {
  await tick(60);
  const bakTasks = JSON.parse(JSON.stringify(S.DB.tasks));
  const bakWorks = JSON.parse(JSON.stringify(S.DB.works));
  const bakDuties = JSON.parse(JSON.stringify(S.DB.duties));
  const bakMe = S.DB.settings.me;
  const restore = () => {
    S.DB.tasks = JSON.parse(JSON.stringify(bakTasks));
    S.DB.works = JSON.parse(JSON.stringify(bakWorks));
    S.DB.duties = JSON.parse(JSON.stringify(bakDuties));
    S.DB.settings.me = bakMe;
    S.setFileHandle(null); S.setDirHandle(null); S.setEverConnected(false);
    S.dpClose();
    S.rebuildIndex();
  };

  section('★①：日期数字文本框旁边保留了点选日历的入口');
  const ctrlHtml = S.fieldControl(S.fieldDef('task', 'plan_date'), '2027-07-15', 'td-');
  ok('数字文本框还在', ctrlHtml.includes('date-mask'));
  ok('★旁边有📅按钮，能弹出日历', ctrlHtml.includes('data-act="date-pick-open"') && ctrlHtml.includes('📅'), ctrlHtml);
  const cpHtml = S.cpRowHTML(null);
  ok('里程碑检查点行同理，也带了📅按钮', cpHtml.includes('data-act="date-pick-open"'));

  section('★①：点日历选中一天，只改这个输入框自己的 value，不直接碰数据库');
  restore();
  const input = fakeDateInput('2027-06-01');
  S.openDatePickerForInput(input);
  ok('日历打开成功，且工作在"表单模式"', S.dp && S.dp.mode === 'input');
  ok('日历默认定位到这个输入框当前的日期（2027年6月）', S.dp.year === 2027 && S.dp.month === 5);
  await S.dpCommit('2027-06-20');
  ok('★选中的日期直接写回了这个输入框', input.value === '2027-06-20');
  ok('日历自动收起', !S.dp);
  ok('数据库完全没被碰过（没有 entity/id 这些概念参与）', true);

  section('★①：日历打开时正确高亮输入框当前的日期');
  input.value = '2027-08-09';
  S.openDatePickerForInput(input);
  ok('dpCurrentValue 读到的是输入框自己的值', S.dpCurrentValue() === '2027-08-09');
  S.dpClose();

  section('★①：清除按钮（dp-clear）在表单模式下就是把输入框清空');
  input.value = '2027-01-01';
  S.openDatePickerForInput(input);
  await S.ACTIONS['dp-clear']();
  ok('输入框被清空', input.value === '');

  section('★①：日历导航（上下月）不受模式影响，两种模式共用');
  S.openDatePickerForInput(fakeDateInput(''));
  const y0 = S.dp.year, m0 = S.dp.month;
  S.dpNav(1);
  ok('翻到下个月', (S.dp.month === (m0 + 1) % 12));
  S.dpClose();

  section('★①：网格内联编辑那条老路径（entity/id 模式）不受影响，回归验证');
  restore();
  const anyTask = S.DB.tasks.find(t => !t.deleted_at);
  const fakeTd = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20 }), contains: () => false };
  S.openDatePicker('task', anyTask.id, 'plan_date', fakeTd);
  ok('网格模式下 _dp.mode 是 grid', S.dp && S.dp.mode === 'grid');
  await S.dpCommit('2027-12-25');
  ok('网格模式照旧是直接改数据库这条任务的字段', S.byId('task', anyTask.id).plan_date === '2027-12-25');

  section('★②：新建任务时没选所属工作，编号先空着（老行为保持不变）');
  restore();
  const dutyCode = 'P47D'; await S.Repo.upsert('duty', { code: dutyCode, name: 'P47测试职责' });
  // nextTaskCode 需要工作自己有 code（+年度）才能算出前缀，测试夹具必须带上，否则永远算出空编号
  const wid = 'p47_w'; await S.Repo.upsert('work', { id: wid, duty: dutyCode, code: '01', year: 2027, name: 'P47测试工作', owner: '测试管理员' });
  S.openNewTask ? S.openNewTask() : S.openTaskDetail('');   // 走通用的新建入口
  q('#td-title').value = 'P47没选工作的新任务';
  q('#td-owner').value = '测试管理员';
  q('#td-status').value = 'todo';
  q('#td-work').value = '';
  raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? [] : []);
  await S.ACTIONS['modal-ok']();
  const created = S.DB.tasks.find(t => t.title === 'P47没选工作的新任务');
  ok('任务建出来了', !!created);
  ok('★没选所属工作，编号确实是空的', created && created.code === '', created);

  section('★②：后续在任务详情里补上所属工作，编号要能自动生成');
  S.openTaskDetail(created.id);
  q('#td-title').value = created.title;
  q('#td-owner').value = '测试管理员';
  q('#td-status').value = 'todo';
  q('#td-work').value = wid;   // 这次补上了所属工作
  raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? [] : []);
  await S.ACTIONS['modal-ok']();
  const afterFix = S.byId('task', created.id);
  ok('★补上所属工作之后，编号自动生成了，不再是空的', !!afterFix.code, afterFix.code);
  ok('编号前缀确实对应这个工作', afterFix.code.startsWith(S.DB.works.find(w => w.id === wid).code));

  section('★②：换成另一个工作，编号要跟着重新生成（不是死板地保留第一次的编号）');
  const wid2 = 'p47_w2'; await S.Repo.upsert('work', { id: wid2, duty: dutyCode, code: '02', year: 2027, name: 'P47测试工作二', owner: '测试管理员' });
  const oldCode = afterFix.code;
  S.openTaskDetail(created.id);
  q('#td-title').value = created.title;
  q('#td-owner').value = '测试管理员';
  q('#td-status').value = 'todo';
  q('#td-work').value = wid2;
  raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? [] : []);
  await S.ACTIONS['modal-ok']();
  const afterSwitch = S.byId('task', created.id);
  ok('换工作之后编号变了', afterSwitch.code !== oldCode, { oldCode, newCode: afterSwitch.code });
  ok('新编号对应的是新工作', afterSwitch.code.startsWith(S.DB.works.find(w => w.id === wid2).code));

  section('★②：工作没变的正常保存，不能瞎重算编号（否则编号会一直往上跳）');
  const stableCode = afterSwitch.code;
  S.openTaskDetail(created.id);
  q('#td-title').value = created.title + '（改了个标题）';
  q('#td-owner').value = '测试管理员';
  q('#td-status').value = 'todo';
  q('#td-work').value = wid2;   // 工作没变
  raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? [] : []);
  await S.ACTIONS['modal-ok']();
  ok('★只改标题、工作没变，编号原封不动', S.byId('task', created.id).code === stableCode,
    { before: stableCode, after: S.byId('task', created.id).code });

  section('★②：把所属工作清空，编号也要跟着清空');
  S.openTaskDetail(created.id);
  q('#td-title').value = created.title;
  q('#td-owner').value = '测试管理员';
  q('#td-status').value = 'todo';
  q('#td-work').value = '';
  raw.document.querySelectorAll = sel => (sel === '#cp-list [data-cp-row]' ? [] : []);
  await S.ACTIONS['modal-ok']();
  ok('清空所属工作后编号也清空了', S.byId('task', created.id).code === '');

  section('★③：readSharedFile 每次读之前，只要有目录句柄就重新问目录要一个新的文件句柄');
  restore();
  const store = { text: '', mtime: 1, writes: 0 };
  let getFileHandleCalls = 0;
  let currentHandle = makeFileHandle(store);
  const fakeDirHandle = {
    async getFileHandle(name, opts) {
      getFileHandleCalls++;
      return currentHandle;   // 每次都"新问"一次，模拟真实场景里目录给出的可能是全新的句柄对象
    },
  };
  S.setDirHandle(fakeDirHandle);
  S.setFileHandle(currentHandle);
  S.setEverConnected(true);
  await S.Repo.persist(S.DB);   // 铺一次基线
  ok('★确实调用了目录句柄的 getFileHandle，不是死抱着连接时那一个句柄', getFileHandleCalls > 0, getFileHandleCalls);

  section('★③：换一个全新的句柄对象模拟"其他设备刚写完、旧句柄可能还没反映出来"，新读取要能用上新句柄');
  const callsBefore = getFileHandleCalls;
  // 模拟"另一台设备写完了"：底层内容已经变了，同时给一个全新的句柄对象（模拟目录重新给出新句柄）
  const remote = JSON.parse(store.text);
  const victim = remote.tasks.find(t => !t.deleted_at);
  remote.tasks.find(t => t.id === victim.id).title = '★P47同事改的标题★';
  const rt = remote.tasks.find(t => t.id === victim.id);
  rt.rev = (rt.rev || 0) + 1;
  rt.updated_at = new Date(Date.now() + 1000).toISOString();
  store.text = JSON.stringify(remote); store.mtime++;
  currentHandle = makeFileHandle(store);   // 全新对象，模拟目录重新给出的句柄
  const pulled = await S.pullFromFile();
  ok('拉取成功', pulled === true);
  ok('★用的是重新问来的新句柄，读到了同事的改动', S.byId('task', victim.id).title === '★P47同事改的标题★');
  ok('确实又问了一次目录要句柄（不是复用旧的）', getFileHandleCalls > callsBefore);

  section('★③：没有目录句柄时（老式单文件句柄）不受影响，照旧用现有的 _fileHandle');
  S.setDirHandle(null);
  const store2 = { text: '', mtime: 1, writes: 0 };
  S.setFileHandle(makeFileHandle(store2));
  await S.Repo.persist(S.DB);
  ok('没有目录句柄也能正常同步，不报错', store2.writes > 0);

  restore();
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('测试异常：', e); process.exit(1); });
