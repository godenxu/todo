/* 多实例加载器（P127，给 sim16.js 用）：同一个 Node 进程里起好几份【互相独立】的 index.html
   （各自的 vm 上下文、各自的内存、可以共用或不共用 localStorage、各自的时钟），
   用来模拟"几台电脑 + 同一台电脑上的几个标签页"同时连同一份共享文件。
   做法：读 test/harness.js 的源码，替换几处（html 路径、localStorage 存储、定时器、时钟、不自动播种），
   再当成函数执行，每调用一次就得到一份全新的沙盒。harness.js 本身一个字不改——
   它的 DOM 桩、导出表跟回归测试保持同一份，不会出现"仿真测的跟测试测的不是同一套程序"。
   也能加载旧版本的 html（生产上可能还在跑的版本）：旧版本里没有的导出名会补一个空的 var。 */
const fs = require('fs');
const REPO = 'C:/Users/Administrator/Documents/Claude/Todo';
const HARNESS_SRC = fs.readFileSync(REPO + '/test/harness.js', 'utf8');

// 旧版本 html 里可能没有 harness 导出表里的某些函数：没声明的一律补一个 var，免得整个导出表抛 ReferenceError
function fixTail(code, tail) {
  const skip = new Set(['get', 'return', 'true', 'false', 'null', 'undefined', 'this', 'globalThis', 'v', 'p', 's', 'h', 'ver']);
  const names = new Set();
  const re = /(?:^|[,{\s(])([A-Za-z_$][\w$]*)\s*(?=[,}\n;)])/g;
  let m;
  while ((m = re.exec(tail))) names.add(m[1]);
  const missing = [...names].filter(n => !skip.has(n)
    && !new RegExp('(^|[^\\w$.])' + n.replace(/\$/g, '\\$') + '(?![\\w$])').test(code));   // 代码里压根没出现过这个名字才补
  return '\n;' + missing.map(n => 'var ' + n + ';').join('') + tail;
}

function mkTimers() {
  const live = new Set();
  return {
    setTimeout(fn, ms, ...a) { const id = setTimeout(() => { live.delete(id); fn(...a); }, ms); live.add(id); return id; },
    clearTimeout(id) { live.delete(id); clearTimeout(id); },
    setInterval(fn, ms, ...a) { const id = setInterval(fn, ms, ...a); live.add(id); return id; },
    clearInterval(id) { live.delete(id); clearInterval(id); },
    dispose() { live.forEach(id => { clearTimeout(id); clearInterval(id); }); live.clear(); },
  };
}
function mkDate(skewMs) {
  const RD = Date;
  class D extends RD {
    constructor(...a) { if (a.length === 0) super(RD.now() + skewMs); else super(...a); }
    static now() { return RD.now() + skewMs; }
  }
  return D;
}

/* opts: { html, store(Map), skewMs, onSet(k,v,old), isDead() } */
function mkApp(opts) {
  let src = HARNESS_SRC;
  const rep = (a, b) => { if (!src.includes(a)) throw new Error('加载器找不到要替换的片段：' + a); src = src.replace(a, b); };
  rep("const path = process.argv[2] || require('path').join(__dirname, '..', 'index.html');", 'const path = __OPTS.html;');
  rep('const store = new Map();', 'const store = __OPTS.store;');
  rep('  setTimeout, clearTimeout, setInterval, clearInterval,',
    '  setTimeout: __OPTS.T.setTimeout, clearTimeout: __OPTS.T.clearTimeout, setInterval: __OPTS.T.setInterval, clearInterval: __OPTS.T.clearInterval,');
  rep('  Date, Math,', '  Date: __OPTS.Date, Math,');
  rep('    setItem: (k, v) => store.set(k, v),',
    "    setItem: (k, v) => { if (__OPTS.isDead()) throw new Error('页面已关闭'); const o = store.has(k) ? store.get(k) : null; store.set(k, String(v)); __OPTS.onSet(k, String(v), o); },");
  rep('vm.runInContext(code + exportTail,', 'vm.runInContext(code + __fixTail(code, exportTail),');
  rep('api.seedAll();', '');
  src = src.replace(/module\.exports = (\{[^\n]*\});\s*$/, 'return $1;');
  const T = mkTimers();
  const o = Object.assign({ T, Date: mkDate(opts.skewMs || 0), onSet() {}, isDead: () => false }, opts);
  const fn = new Function('__OPTS', '__fixTail', 'require', '__dirname', src);
  const out = fn(o, fixTail, require, REPO + '/test');
  out.T = T;
  return out;
}
module.exports = { mkApp, REPO };
