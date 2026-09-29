/* 赤牙 · AI阅读 前端端到端回归测试（jsdom）
 *
 * 为什么放在仓库里而不是 /tmp：这套测试曾抓出 6 个真 bug（TDZ、补丁替换错位置、
 * switchSub 不重渲染、animate 作用域、书架不同步、上传进度谎报），但一直放在 /tmp，
 * 被系统清理后一度出现「四套全绿」的假阳性（文件不存在却被判通过）。
 * 放进仓库才能长期复跑。
 *
 * 运行：
 *   node tests/e2e.js
 * jsdom 通常装在项目 devDependencies；若没有（本机 jsdom 在 WorkBuddy 隔离工作区），
 * 可用 JSDOM_PATH 指定目录，或直接 npm i -D jsdom。
 *
 * 约定：每个场景用一个新的 JSDOM 实例，用完必须 dom.window.close()，
 * 否则多个 218KB HTML 实例会 OOM（进程被 SIGKILL，退出码 137）。
 */
const fs = require('fs');
const path = require('path');

function loadJsdom() {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.JSDOM_PATH,
    'jsdom',
    home && path.join(home, '.workbuddy/binaries/node/workspace/node_modules/jsdom')
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c).JSDOM; } catch (_) { /* 试下一个 */ }
  }
  console.error('未找到 jsdom。请执行 npm i -D jsdom，或设置 JSDOM_PATH 指向其所在目录。');
  process.exit(2);
}
const JSDOM = loadJsdom();

const HTML = fs.readFileSync(path.join(__dirname, '..', 'prototype', 'index.html'), 'utf-8');

let errors = [];
let fails = 0;
let total = 0;
function ok(name, cond, extra) {
  total++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) { process.exitCode = 1; fails++; }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

function newDom(opts = {}) {
  errors = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost:3001/',
    beforeParse(window) {
      // jsdom 不实现 canvas：用一个能 measureText 的 stub 顶替（导图排版依赖它）
      window.HTMLCanvasElement.prototype.getContext = function () {
        const self = this;
        return {
          font: '14px sans-serif',
          measureText(t) {
            const m = /(\d+(?:\.\d+)?)px/.exec(self.font || '14px');
            const px = m ? parseFloat(m[1]) : 14;
            let w = 0;
            for (const ch of String(t)) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? px : px * 0.55;
            return { width: w };
          },
          clearRect(){}, fillRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){},
          fill(){}, save(){}, restore(){}, translate(){}, scale(){}, arc(){}, closePath(){}, setTransform(){}
        };
      };
      window.scrollTo = () => {};
      window.alert = m => errors.push('alert: ' + m);
      window.confirm = () => true;
      window.onerror = m => errors.push('onerror: ' + m);
      // 浏览器一定有 fetch；jsdom 没有。
      // 必须区分两种 URL：`/api/books?user_id=x`（列表，返回数组）与
      // `/api/books/<id>`（单本详情，返回对象）——混在一起会让详情拿到数组，
      // 表现为「打开上传的书却显示解析未完成」，是测试脚手架的问题而非产品 bug。
      window.fetch = function (url) {
        const u = String(url);
        if (/\/api\/books\/[^?]+$/.test(u)) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opts.book || {}) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opts.books || []) });
      };
    }
  });
  return dom;
}
const close = dom => { try { dom.window.close(); } catch (_) {} };
const click = (w, el) => { if (!el) throw new Error('click on null'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
const vis = (d, id) => !d.getElementById(id).classList.contains('hidden');
const sheetOf = d => [...d.querySelectorAll('style')].map(e => e.textContent).join('\n');

(async () => {
  // ==================== 1. 初始化完整性 ====================
  {
    const dom = newDom();
    const w = dom.window, d = w.document;
    await wait(500);
    ok('初始化无 JS 报错', errors.length === 0, errors.join(' | '));
    ['view-welcome','view-shelf','view-store','view-study','view-notes','view-note','view-book','view-finished']
      .forEach(id => ok('存在视图 #' + id, !!d.getElementById(id)));
    ok('默认正在精读《道德经》', w.eval('currentReadingBook') === '道德经', w.eval('currentReadingBook'));

    // 审计：CSS 变量、重复 id、onclick 函数齐备
    const sheet = sheetOf(d);
    const defined = new Set([...sheet.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(m => m[1]));
    const used = new Set([...HTML.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map(m => m[1]));
    const undef = [...used].filter(v => !defined.has(v));
    ok('无「用了但未定义」的 CSS 变量', undef.length === 0, undef.join(','));
    const ids = [...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    ok('无重复 id', new Set(ids).size === ids.length);
    const calls = new Set([...HTML.matchAll(/on(?:click|input|change)="([a-zA-Z_$][\w$]*)\s*\(/g)].map(m => m[1]));
    const inline = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
    const fns = new Set([...inline.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)].map(m => m[1]));
    const missing = [...calls].filter(c => !fns.has(c));
    ok('onclick 引用的函数都已定义', missing.length === 0, missing.join(','));

    close(dom);
  }

  // ==================== 2. 精读页已移除「掌握度」模块 ====================
  {
    const dom = newDom();
    const w = dom.window, d = w.document;
    await wait(500);
    w.eval('openBook()');
    await wait(200);
    ok('已进入精读页', vis(d, 'view-book'));
    // 该模块曾是纯静态、永远显示 62% 的假数字，常驻最显眼处造成被考核的压迫感
    ok('精读页无掌握度圆环模块', d.querySelectorAll('#view-book .mastery-section').length === 0);
    ok('精读页不再出现「综合掌握度」', !d.getElementById('view-book').textContent.includes('综合掌握度'));
    ok('精读页不再出现「3 个理论已评测」', !d.getElementById('view-book').textContent.includes('3 个理论已评测'));
    ok('样式表已无 .mastery-section', !sheetOf(d).includes('.mastery-section'));
    // 掌握度仍应能在「提问评测」处看到（那是真实评测结果，位置合理）
    ok('提问·掌握度评测 Tab 仍保留', !!d.querySelector('.subtab[data-sub="quiz"]'));
    // 书头与 Tab 之间衔接正常
    ok('移除后书头仍在', !!d.querySelector('#view-book .book-head h2'));
    ok('页面级三栏（读原文/AI精读/互动讨论）', d.querySelectorAll('#view-book .tab-bar .tab').length === 3, d.querySelectorAll('#view-book .tab-bar .tab').length);
    ok('无 JS 报错', errors.length === 0, errors.join(' | '));
    close(dom);
  }

  // ==================== 3. 精读页主流程（解析内容可切换） ====================
  {
    const dom = newDom();
    const w = dom.window, d = w.document;
    await wait(500);
    w.eval('openBook()');
    await wait(150);
    w.eval("switchSub('theory')");
    await wait(100);
    ok('① 核心理论渲染出 4 张卡', d.querySelectorAll('#theoryList .theory-card').length === 4, d.querySelectorAll('#theoryList .theory-card').length);
    ok('① 理论为《道德经》的（道 / 无为 / 柔弱 / 反者道之动）',
       /道\b|无为/.test(d.getElementById('theoryList').textContent) && d.getElementById('theoryList').textContent.includes('反者道之动'));
    ok('① 不再出现另一本书的理论', !/双系统|前景理论|锚定效应/.test(d.getElementById('theoryList').textContent));

    // 内容尚未重写的三块必须是「诚实占位」，不能留空、也不能串到别的书
    w.eval("switchSub('logic')");
    await wait(100);
    ok('② 逻辑链给出诚实占位', d.getElementById('logicContainer').textContent.includes('暂无可展示'), d.getElementById('logicContainer').textContent.slice(0, 40));
    w.eval("switchSub('case')");
    await wait(100);
    ok('③ 案例给出诚实占位', d.getElementById('caseContainer').textContent.includes('正在整理'), d.getElementById('caseContainer').textContent.slice(0, 40));
    w.eval("switchSub('selfcheck')");
    await wait(100);
    ok('④ 自测说明本书没有原书测试题', d.getElementById('qzContainer').textContent.includes('没有'), d.getElementById('qzContainer').textContent.slice(0, 40));
    w.eval("switchSub('overview')");
    await wait(100);
    ok('概况页为《道德经》版', d.getElementById('ovRoot').textContent.includes('老子') && d.getElementById('ovRoot').textContent.includes('战国'));
    ok('概况页不出现另一本书', !/卡尼曼|行为经济学/.test(d.getElementById('ovRoot').textContent));
    ok('概况页说明了「不适合谁」', d.getElementById('ovRoot').textContent.includes('不适合谁'));
    ok('无 JS 报错', errors.length === 0, errors.join(' | '));
    close(dom);
  }

  // ==================== 4. 赤牙书屋 + 读书笔记三层结构 ====================
  {
    const dom = newDom();
    const w = dom.window, d = w.document;
    await wait(500);
    click(w, d.getElementById('navStudy'));
    ok('进入赤牙书屋', vis(d, 'view-study'));
    ok('浏览区不再铺笔记列表', d.querySelector('#view-study .note-list') === null);
    const entry = d.querySelector('.note-entry');
    ok('有「读书笔记」入口模块', !!entry);
    const rule = /\.note-entry\{[^}]*\}/.exec(sheetOf(d));
    ok('入口模块不限制宽度（与书卡对齐）', !!rule && !/max-width/.test(rule[0]));

    click(w, entry);
    ok('进入笔记网格页', vis(d, 'view-notes'));
    ok('有「新建笔记」卡', !!d.querySelector('#notesGrid .note-card.new'));

    click(w, d.querySelector('#notesGrid .note-card.new'));
    ok('进入整页书写区', vis(d, 'view-note'));
    d.getElementById('editorArea').value = '系统 1 与系统 2 的分工是全书骨架。';
    w.eval('updateEditorMeta()');
    ok('书写区实时字数', /共 \d+ 字/.test(d.getElementById('editorMeta').textContent), d.getElementById('editorMeta').textContent);
    click(w, d.querySelector('.editor-btn.primary'));
    ok('保存后回到网格页', vis(d, 'view-notes'));
    ok('网格出现 1 张笔记卡', d.querySelectorAll('#notesGrid .note-card:not(.new)').length === 1);
    ok('笔记已落 localStorage', JSON.parse(w.localStorage.getItem('chiya_notes')).length === 1);

    click(w, d.querySelector('#view-notes .back-link'));
    ok('网格页可返回书屋', vis(d, 'view-study'));
    ok('入口模块计数已更新', d.getElementById('noteCount').textContent === '1 条', d.getElementById('noteCount').textContent);

    // 入架 → 空态；取回 → 恢复
    w.eval('shelveCurrentBook()');
    click(w, d.getElementById('navStudy'));
    ok('入架后书屋显示空态', vis(d, 'studyEmpty') && !vis(d, 'studyMain'));
    click(w, d.getElementById('navShelf'));
    click(w, d.querySelector('#shelfGrid .btn-unshelve'));
    ok('书架取回后恢复正在精读', w.eval('currentReadingBook') === '道德经');
    ok('无 JS 报错', errors.length === 0, errors.join(' | '));
    close(dom);
  }

  // ==================== 5. 电子书集市 ====================
  {
    const dom = newDom();
    const w = dom.window, d = w.document;
    await wait(500);
    click(w, d.getElementById('navStore'));
    ok('进入电子书集市', vis(d, 'view-store'));
    ok('集市渲染书籍', d.querySelectorAll('#storeGrid .store-card').length > 0, d.querySelectorAll('#storeGrid .store-card').length);
    ok('文案使用「集市」而非「商城」', d.getElementById('view-store').textContent.includes('集市') && !HTML.includes('电子书商城'));
    ok('无 JS 报错', errors.length === 0, errors.join(' | '));
    close(dom);
  }

  // ==================== 6. 上传书籍：同步书架 → 打开真实内容 ====================
  {
    const BOOK = {
      id: 'srv-1', title: '狱中札记', file_ext: 'pdf', status: 'parsed', parse_error: null,
      created_at: '2026-09-21 08:29:36',
      theories: [
        { id: 'th1', name: '文化霸权', sub: '核心概念', def: '统治阶级不只靠暴力，也靠文化上的同意。',
          eval_impact: '影响后殖民研究。', eval_debate: '测量方式有争议。', src: '第 1 章',
          related: [{ id: 'r1', name: '意识形态国家机器', meta: 'Louis Althusser', link: '同源概念',
                      def: '国家通过教育与媒体再生产意识形态。', source: 'ai' }] },
        { id: 'th2', name: '阵地战', sub: '策略', def: '在市民社会中长期争夺文化领导权。',
          eval_impact: '提供非暴力路径。', eval_debate: '难以验证。', src: '第 2 章', related: [] }
      ],
      chains: [{ id: 'c1', theory_id: 'th1', title: '文化霸权 · 验证逻辑链',
                 steps: [{ id: 's1', idx: 1, label: '现象', content: '未如预期爆发革命。', source: '第 1 章' }] }],
      cases: [{ id: 'k1', theory_id: 'th1', tag: '文化霸权', title: '教科书里的历史叙事',
                scene: '把殖民描述为文明开化。', result: '两代人接受了这套叙事。', why: '文化同意降低统治成本。',
                steps: JSON.stringify(['教育系统持续再生产叙事。']), use_text: '看到理所当然的说法先问是谁在生产。',
                src_type: 'ai', src_text: 'AI 依据理论推演' }]
    };
    const dom = newDom({ books: [BOOK], book: BOOK });
    const w = dom.window, d = w.document;
    await wait(600);

    ok('服务端书籍已同步到书架', d.querySelectorAll('#shelfGrid .book-card').length === 1, d.querySelectorAll('#shelfGrid .book-card').length);
    const card = d.querySelector('#shelfGrid .book-card');
    ok('卡片记录服务端 id', card.dataset.serverId === 'srv-1', card.dataset.serverId);
    ok('卡片状态为「解析完成」', /解析完成/.test(card.textContent));
    ok('状态类不是 .read（避免被当成已读完）', !card.querySelector('.status').classList.contains('read'));

    await w.eval("openShelfBook('狱中札记')");
    await wait(400);
    ok('进入了书籍详情页', vis(d, 'view-book'));
    ok('标题为上传的书', d.querySelector('.book-head-info h2').textContent === '狱中札记');
    ok('概况为上传版', !!d.querySelector('#ovRoot .up-ov-hero'));
    ok('概况不再出现演示书作者', !d.getElementById('ovRoot').textContent.includes('卡尼曼'));
    ok('概况列出本书理论', d.querySelectorAll('#ovRoot .up-ov-theory').length === 2);
    ok('概况诚实说明未提供项', d.getElementById('ovRoot').textContent.includes('暂不提供'));
    w.eval("switchSub('theory')"); await wait(100);
    ok('① 渲染本书理论', d.getElementById('theoryList').textContent.includes('文化霸权'));
    ok('理论 id 生成为 up-t1', !!d.getElementById('tc-up-t1'));
    w.eval("switchSub('logic')"); await wait(100);
    ok('② 渲染本书逻辑链', d.getElementById('logicContainer').textContent.includes('未如预期爆发革命'));
    ok('② 不含演示书内容', !/亚洲疾病问题|琳达问题/.test(d.getElementById('logicContainer').textContent));
    w.eval("switchSub('case')"); await wait(100);
    ok('③ 渲染本书案例', d.getElementById('caseContainer').textContent.includes('教科书里的历史叙事'));
    ok('③ 案例步骤已解析为列表', d.getElementById('caseContainer').textContent.includes('教育系统持续再生产'));
    ok('AI 精读里已无思维导图入口', d.querySelector('#main-analysis .subtab[data-sub="map"]') === null);
    ok('书中自测入口被禁用', d.querySelector('.subtab[data-sub="selfcheck"]').classList.contains('disabled'));
    ok('互动讨论入口被禁用', d.querySelector('.tab[data-main="discuss"]').classList.contains('disabled'));

    await w.eval('openBook()');                 // 默认打开演示书
    await wait(250);
    ok('切回演示书后不再显示上传书内容', !d.getElementById('theoryList').textContent.includes('文化霸权'));
    ok('切回后概况恢复演示书版', !d.querySelector('#ovRoot .up-ov-hero'));
    ok('无 JS 报错', errors.length === 0, errors.join(' | '));
    close(dom);
  }

  // ==================== 7. 解析失败的书：诚实反馈 ====================
  {
    const bad = { id: 'srv-bad', title: '坏书', file_ext: 'pdf', status: 'failed',
                  parse_error: '该 PDF 提取不到文字（很可能是扫描版）', theories: [], chains: [], cases: [] };
    const dom = newDom({ books: [bad], book: bad });
    const w = dom.window, d = w.document;
    await wait(600);
    const card = d.querySelector('#shelfGrid .book-card');
    ok('失败的书仍进书架（状态可见）', !!card && /解析失败/.test(card.textContent));
    await w.eval("openShelfBook('坏书')");
    await wait(400);
    ok('打开时说明失败原因', d.getElementById('ovRoot').textContent.includes('扫描版'));
    ok('不用演示书内容冒充', !/卡尼曼|双系统/.test(d.getElementById('ovRoot').textContent));
    ok('无 JS 报错', errors.length === 0, errors.join(' | '));
    close(dom);
  }

  // ==================== 8. 两级结构：读原文 / AI 精读 ====================
  {
    const dom = newDom();
    const w = dom.window, d = w.document;
    await wait(500);
    w.eval('openBook()');
    await wait(250);

    // —— 页面级三栏 ——
    const tabs = [...d.querySelectorAll('#view-book .tab-bar .tab')].map(t => t.dataset.main);
    ok('三栏为 read/analysis/discuss', tabs.join(',') === 'read,analysis,discuss', tabs.join(','));
    ok('默认停在「读原文」', d.querySelector('.tab[data-main="read"]').classList.contains('active'));

    // —— 读原文：翻页阅读器 ——
    ok('阅读器可见', vis(d, 'reader') || !d.getElementById('reader').classList.contains('hidden'));
    ok('空态未显示', d.getElementById('readerEmpty').classList.contains('hidden'));
    ok('书名显示《道德经》', d.getElementById('readerBookName').textContent === '道德经', d.getElementById('readerBookName').textContent);
    ok('总页数 = 81 章', d.getElementById('readerTotal').textContent === '81', d.getElementById('readerTotal').textContent);
    ok('首页章名为「道经 · 第一章」', d.getElementById('readerChapName').textContent === '道经 · 第一章', d.getElementById('readerChapName').textContent);
    ok('首章正文为「道可道」', d.getElementById('readerText').textContent.includes('道可道，非常道'), d.getElementById('readerText').textContent.slice(0, 20));
    ok('第 1 页「上一页」禁用', d.getElementById('readerPrev').disabled);
    ok('第 1 页「下一页」可用', !d.getElementById('readerNext').disabled);

    // 页码与进度
    ok('页码显示 1', d.getElementById('readerPage').textContent === '1');
    const fill1 = parseFloat(d.getElementById('readerFill').style.width) || 0;
    ok('进度条 ≈ 1/81', Math.abs(fill1 - 100 / 81) < 1, fill1);

    // 翻到第 2 页
    w.eval('readerGo(1)');
    await wait(60);
    ok('翻页后页码变 2', d.getElementById('readerPage').textContent === '2');
    ok('第 2 章为「天下皆知美之为美」', d.getElementById('readerText').textContent.includes('天下皆知美之为美'), d.getElementById('readerText').textContent.slice(0, 20));
    ok('第 2 页「上一页」可用', !d.getElementById('readerPrev').disabled);

    // 跳到末页：下一页应禁用
    w.eval('readerGo(1000)');
    await wait(60);
    ok('跳到末页为「信言不美」', d.getElementById('readerText').textContent.includes('信言不美'), d.getElementById('readerText').textContent.slice(0, 20));
    ok('末页「下一页」禁用', d.getElementById('readerNext').disabled);
    ok('末页页码 = 81', d.getElementById('readerPage').textContent === '81');
    w.eval('readerGo(1)');
    ok('末页再翻不会越界', d.getElementById('readerPage').textContent === '81');

    // 回到第 5 页，用于验证「切走再切回位置不丢」
    w.eval('readerGo(-76)');
    await wait(60);
    ok('回到第 5 页（道经 · 第五章）', d.getElementById('readerChapName').textContent === '道经 · 第五章', d.getElementById('readerChapName').textContent);

    // 字号调节 + 记忆
    const f0 = parseFloat(d.getElementById('readerText').style.fontSize);
    w.eval('readerFont(1)');
    await wait(40);
    const f1 = parseFloat(d.getElementById('readerText').style.fontSize);
    ok('放大字号生效', f1 > f0, f0 + ' → ' + f1);
    w.eval('readerFont(-1)');
    await wait(40);
    ok('缩小字号生效', parseFloat(d.getElementById('readerText').style.fontSize) === f0);
    ok('字号已写入 localStorage', !!w.localStorage.getItem('chiya_reader_font'));
    ok('阅读位置已写入 localStorage', w.localStorage.getItem('chiya_reader_pos:demo:道德经') !== null, w.localStorage.getItem('chiya_reader_pos:demo:道德经'));

    // —— 切到 AI 精读 ——
    w.eval("switchMain('analysis')");
    await wait(150);
    ok('AI 精读可见', vis(d, 'main-analysis'));
    ok('读原文已隐藏', !vis(d, 'main-read'));
    const subs = [...d.querySelectorAll('#main-analysis .subtab')].map(t => t.dataset.sub);
    ok('AI 精读含概况 + ①②③④（5 项）', subs.join(',') === 'overview,theory,logic,case,selfcheck', subs.join(','));
    ok('AI 精读里没有思维导图', !subs.includes('map'));

    // —— 切回读原文应在同一页 ——
    w.eval("switchMain('read')");
    await wait(150);
    ok('切走再切回，阅读位置不丢（第 5 页）', d.getElementById('readerPage').textContent === '5', d.getElementById('readerPage').textContent);
    ok('无 JS 报错', errors.length === 0, errors.join(' | '));
    close(dom);
  }

  // ==================== 9. 上传的书：读不到正文时诚实反馈 ====================
  {
    const BOOK = { id: 'srv-9', title: '某本上传的书', file_ext: 'pdf', status: 'parsed', parse_error: null,
                   created_at: '2026-09-29 10:00:00', theories: [{ id: 't1', name: 'X 理论', sub: '', def: 'D',
                   eval_impact: '', eval_debate: '', src: '', related: [] }], chains: [], cases: [] };
    const dom = newDom({ books: [BOOK], book: BOOK });
    const w = dom.window, d = w.document;
    await wait(600);
    // 默认 mock 的 /text 请求会走到「列表」分支返回数组 → 视为读取失败，应给诚实空态
    await w.eval("openShelfBook('某本上传的书')");
    await wait(400);
    w.eval("switchMain('read')");
    await wait(300);
    ok('读不到正文时不显示空白阅读器', d.getElementById('reader').classList.contains('hidden'));
    ok('给出可读的失败说明', d.getElementById('readerEmpty').textContent.trim().length > 10, d.getElementById('readerEmpty').textContent.slice(0, 60));
    ok('不用演示书正文冒充', !d.getElementById('readerEmpty').textContent.includes('道可道'));
    ok('无 JS 报错', errors.length === 0, errors.join(' | '));
    close(dom);
  }

  // ==================== 汇总 ====================
  console.log('\n' + (fails === 0 ? `✅ 全部通过（共 ${total} 条断言）` : `❌ 失败 ${fails} / ${total} 条`));
  process.exit(process.exitCode || 0);
})();
