/* 赤牙 · AI阅读 前后端联调测试（真实服务端）
 *
 * 为什么需要这一层：tests/e2e.js 用的是手写的 fetch mock，
 * 一旦 mock 的字段名和真实接口不一致，测试照样全绿（本轮就踩过：
 * 前端读 text_char_count，我在夹具里写成 char_count，5 条断言假通过）。
 * 这里让 jsdom 里的前端**直接请求真实服务端**，字段名对不上就立刻暴露。
 *
 * 覆盖链路：真上传文件 → 服务端提取并保存正文 → 前端同步书架 → 打开书 → 读原文。
 *
 * 运行：
 *   node tests/integration.js
 *
 * ⚠️ AI 解析被指向一个连不通的地址（本测试要验的是「AI 失败但正文可读」这条链路，
 *    同时避免消耗真实 API 额度）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
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

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf-8');
const PORT = Number(process.env.TEST_PORT || 3972);
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0, total = 0;
function ok(name, cond, extra) {
  total++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) { process.exitCode = 1; fails++; }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiya-int-'));
let server = null, serverLog = '';

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: path.join(tmpDir, 'data'),
        UPLOAD_DIR: path.join(tmpDir, 'uploads'),
        LLM_API_KEY: 'dummy-key-for-test',
        LLM_BASE_URL: 'http://127.0.0.1:9/v1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const collect = d => { serverLog += d.toString(); };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
    server.on('error', reject);
    const deadline = Date.now() + 30000;
    (async () => {
      while (Date.now() < deadline) {
        await wait(300);
        try { if ((await fetch(BASE + '/api/health')).ok) return resolve(); } catch (_) {}
      }
      reject(new Error('服务未启动：\n' + serverLog));
    })();
  });
}
function stopAll() {
  if (server && !server.killed) { try { server.kill('SIGKILL'); } catch (_) {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// 书的内容：既要有中文书名（验证 filename 解码），又要足够长到能分成多页
const TITLE = '夜航西飞手记';
const PARAS = [
  '第一章 起飞', '',
  '飞机离地的那一刻，地面的一切都被重新排序：路变成线，人变成点，原本清晰的方向感也随之失效。',
  '', '第二章 夜航', '',
  '夜间飞行靠的不是眼睛，而是仪表与训练形成的直觉。当窗外只剩一片黑，人必须学会信任读数而不是感觉。',
  '', '第三章 降落', '',
  '降落是整段航程里最需要精确判断的时刻：速度、角度、风向，任何一项判断失准都会被放大成事故。'
];
const BOOK_TEXT = Array.from({ length: 24 }, () => PARAS.join('\n')).join('\n');

(async () => {
  let dom = null;
  try {
    await startServer();
    ok('服务已启动', true);

    // ---- 真上传（中文文件名）----
    const fd = new FormData();
    fd.append('file', new Blob([BOOK_TEXT], { type: 'text/plain' }), TITLE + '.txt');
    fd.append('user_id', 'default');
    const up = await (await fetch(BASE + '/api/upload', { method: 'POST', body: fd })).json();
    ok('上传成功', !!up.id, JSON.stringify(up));
    ok('中文文件名未乱码', up.title === TITLE, up.title);

    // 等解析结束（AI 不可达 → failed，但正文应已保存）
    let settled = {};
    for (let i = 0; i < 40; i++) {
      await wait(500);
      settled = await (await fetch(`${BASE}/api/upload/${up.id}/status`)).json();
      if (settled.status === 'failed' || settled.status === 'parsed') break;
    }
    ok('AI 不可达时解析诚实失败', settled.status === 'failed', settled.status);

    // ---- 前端挂到这个真实服务端上 ----
    const jsErrors = [];
    dom = new JSDOM(HTML, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: BASE + '/',
      beforeParse(window) {
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
        window.alert = m => jsErrors.push('alert: ' + m);
        window.onerror = m => jsErrors.push('onerror: ' + m);
        // 关键：不做 mock，直接打到真实服务端（相对路径按 BASE 补全）
        window.fetch = (url, init) => {
          const u = String(url);
          return fetch(u.startsWith('http') ? u : BASE + u, init);
        };
      }
    });
    const w = dom.window, d = w.document;
    await wait(1500);   // 等 syncUploadedBooks 异步完成

    const card = d.querySelector('#shelfGrid .book-card');
    ok('真实服务端的书已同步到书架', !!card, d.querySelectorAll('#shelfGrid .book-card').length + ' 张卡');
    ok('卡片带服务端 id', !!card && card.dataset.serverId === up.id, card && card.dataset.serverId);
    ok('卡片如实说明「AI 精读未完成 · 原文可读」', !!card && /原文可读/.test(card.textContent), card ? card.textContent.slice(-40) : '');
    ok('卡片书名正确（未乱码）', !!card && card.textContent.includes(TITLE), card ? card.textContent.slice(0, 30) : '');

    // ---- 打开它：应直接进「读原文」，且读到真实正文 ----
    await w.eval(`openShelfBook('${TITLE}')`);
    await wait(1200);
    ok('打开后进入书籍详情页', !d.getElementById('view-book').classList.contains('hidden'));
    ok('默认停在「读原文」', d.querySelector('.tab[data-main="read"]').classList.contains('active'));
    ok('阅读器已显示（不是空态）', !d.getElementById('reader').classList.contains('hidden'));
    ok('读到的是上传文件里的真实正文',
       d.getElementById('readerText').textContent.includes('飞机离地的那一刻'),
       d.getElementById('readerText').textContent.slice(0, 30));
    ok('没有串到演示书正文', !/道可道|道德经/.test(d.getElementById('readerText').textContent));
    const totalPages = Number(d.getElementById('readerTotal').textContent);
    ok('正文按字数分页（多页）', totalPages > 1, totalPages + ' 页（正文 ' + BOOK_TEXT.length + ' 字）');
    // 分页不得丢字：把所有页拼起来应覆盖原文的每一段
    const allPages = w.eval('readerPages.map(p => p.text).join("\\n")');
    const missing = PARAS.filter(p => p && !allPages.includes(p));
    ok('分页没有丢内容', missing.length === 0, missing.length ? missing[0].slice(0, 20) : '');
    ok('书名显示为上传的书名', d.getElementById('readerBookName').textContent === TITLE, d.getElementById('readerBookName').textContent);
    ok('说明了正文来自自动提取', d.getElementById('readerNote').textContent.includes('自动提取'), d.getElementById('readerNote').textContent.slice(0, 40));

    // 翻一页
    w.eval('readerGo(1)');
    await wait(100);
    ok('可以翻页', d.getElementById('readerPage').textContent === '2', d.getElementById('readerPage').textContent);

    ok('AI 精读入口在这本书上被禁用', d.querySelector('.tab[data-main="analysis"]').classList.contains('disabled'));
    ok('全程无 JS 报错', jsErrors.length === 0, jsErrors.join(' | '));

    console.log('\n' + (fails === 0 ? `✅ 全部通过（共 ${total} 条断言）` : `❌ 失败 ${fails} / ${total} 条`));
  } catch (e) {
    console.error('测试异常:', e && e.stack || e);
    console.log('\n--- 服务端日志（末尾 2000 字）---\n' + serverLog.slice(-2000));
    process.exitCode = 1;
  } finally {
    if (dom) { try { dom.window.close(); } catch (_) {} }
    stopAll();
  }
})();
