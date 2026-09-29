/* 赤牙 · AI阅读 服务端端到端测试
 *
 * 为什么需要它：前端的 jsdom 测试只能验证「拿到数据后怎么渲染」，
 * 拿不到「服务端到底有没有把正文存下来」这件事。而本轮改动的核心恰恰在服务端。
 * 历史上 PDF 提取「假成功」、数据库被部署清空这类问题，都只能靠真起服务才能发现。
 *
 * 做法：真起一个 server 进程（临时 DATA_DIR / UPLOAD_DIR），
 * 真上传文件，真调接口，最后断言磁盘上的数据库与接口返回。
 *
 * 运行：
 *   node tests/server.js
 * 需要 server/node_modules 已安装（npm --prefix server install）。
 *
 * ⚠️ AI 解析这一步被故意指向一个连不通的地址：本测试要验证的是
 *    「AI 解析失败时正文依然保存并能读」，而不是 AI 本身。
 *    同时也避免消耗真实 API 额度。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3971);
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_TEXT_CHARS = 2000;   // 故意调小，让「超长截断」这条路径可被便宜地测到

let fails = 0, total = 0;
function ok(name, cond, extra) {
  total++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) { process.exitCode = 1; fails++; }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiya-test-'));
const DATA_DIR = path.join(tmpDir, 'data');
const UPLOAD_DIR = path.join(tmpDir, 'uploads');
let server = null;
let serverLog = '';

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR,
        UPLOAD_DIR,
        MAX_TEXT_CHARS: String(MAX_TEXT_CHARS),
        // 非空即可（空的会被 server/.env 覆盖），指向一个连不通的地址让 AI 立刻失败
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
        try {
          const r = await fetch(BASE + '/api/health');
          if (r.ok) return resolve();
        } catch (_) { /* 还没起来 */ }
      }
      reject(new Error('服务在 30 秒内未启动。日志：\n' + serverLog));
    })();
  });
}

function stopServer() {
  if (server && !server.killed) { try { server.kill('SIGKILL'); } catch (_) {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

async function upload(filename, content) {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/plain' }), filename);
  fd.append('user_id', 'default');
  const r = await fetch(BASE + '/api/upload', { method: 'POST', body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function waitSettled(id, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await wait(400);
    const r = await fetch(`${BASE}/api/upload/${id}/status`);
    last = await r.json().catch(() => ({}));
    if (last.status === 'parsed' || last.status === 'failed') return last;
  }
  return last || {};
}

const BOOK_TEXT = ('第一章 系统一与系统二\n\n人的思考分为两套系统。系统1快速、自动、无意识、几乎不费力；'
  + '系统2缓慢、理性、需要集中注意力。日常判断大多由系统1主导，这也是许多认知偏差的来源。\n\n'
  + '第二章 锚定效应\n\n人们在估计不确定数值时，会不自觉地依赖一个初始值进行调整，即使这个锚点是随机的，'
  + '也会显著影响最终判断。这在价格谈判与司法量刑中都能观察到。\n').repeat(2);

(async () => {
  try {
    await startServer();
    ok('服务已启动', true);

    const health = await (await fetch(BASE + '/api/health')).json();
    ok('健康检查返回 ok', health.status === 'ok', JSON.stringify(health));
    ok('数据目录来自环境变量（等价于挂了持久化卷）', health.persistence === 'volume', health.persistence);

    // 启动日志应打出实际路径，便于部署后核对是否挂上了卷
    ok('启动日志打印了数据目录', /\[db\] 数据库文件/.test(serverLog) && serverLog.includes(DATA_DIR));

    // ==================== 1. AI 解析失败，但正文必须可读 ====================
    const up = await upload('测试书.txt', BOOK_TEXT);
    ok('上传返回 200', up.status === 200, up.status + ' ' + JSON.stringify(up.body));
    ok('上传返回书籍 id', !!up.body.id, up.body.id);
    const bookId = up.body.id;

    const settled = await waitSettled(bookId);
    ok('AI 不可达时解析诚实失败（不谎报成功）', settled.status === 'failed', settled.status + ' / ' + settled.parse_error);
    ok('失败原因可读', typeof settled.parse_error === 'string' && settled.parse_error.length > 4, settled.parse_error);

    // ★ 本轮的核心：正文在交给 AI 之前就已落库，所以解析失败不影响「读原文」
    ok('正文已落库（日志为证）', /正文已保存：\d+ 字/.test(serverLog), (serverLog.match(/正文已保存：[^\n]*/) || ['(无)'])[0]);

    const detail = await (await fetch(`${BASE}/api/books/${bookId}`)).json();
    ok('详情标明有正文', detail.has_text === true, detail.has_text);
    ok('详情给出正文字数', detail.char_count === BOOK_TEXT.length, detail.char_count + ' vs ' + BOOK_TEXT.length);
    ok('未超长的正文不标记截断', detail.text_truncated === false, detail.text_truncated);
    ok('详情不夹带正文本体（列表/详情保持轻量）', JSON.stringify(detail).length < BOOK_TEXT.length + 4000, JSON.stringify(detail).length);

    const txt = await (await fetch(`${BASE}/api/books/${bookId}/text`)).json();
    ok('正文接口返回全文', txt.text === BOOK_TEXT, '长度 ' + String(txt.text || '').length);
    ok('正文接口返回字数', txt.char_count === BOOK_TEXT.length, txt.char_count);
    ok('正文接口返回书名', txt.title === '测试书', txt.title);
    // 中文文件名必须正确还原：multer/busboy 按 latin1 解码 multipart 文件名，
    // 不处理的话书名会变成「æµè¯ä¹¦」。同时要确认没把正确的纯 ASCII 名字弄坏。
    ok('中文文件名不出现乱码', !/[\u00C0-\u00FF]{2}/.test(txt.title), txt.title);
    const ascii = await upload('plain-name.txt', BOOK_TEXT);
    await waitSettled(ascii.body.id);
    const aDetail = await (await fetch(`${BASE}/api/books/${ascii.body.id}`)).json();
    ok('纯 ASCII 文件名保持原样', aDetail.title === 'plain-name', aDetail.title);

    // ==================== 2. 超长正文按上限截断，并如实标记 ====================
    const longText = BOOK_TEXT.repeat(6);   // 远超 MAX_TEXT_CHARS
    ok('（前置）测试文本确实超长', longText.length > MAX_TEXT_CHARS, longText.length + ' > ' + MAX_TEXT_CHARS);
    const up2 = await upload('超长书.txt', longText);
    await waitSettled(up2.body.id);
    const d2 = await (await fetch(`${BASE}/api/books/${up2.body.id}`)).json();
    ok('超长正文按上限截断', d2.char_count === MAX_TEXT_CHARS, d2.char_count);
    ok('超长正文如实标记 truncated', d2.text_truncated === true, d2.text_truncated);
    const t2 = await (await fetch(`${BASE}/api/books/${up2.body.id}/text`)).json();
    ok('截断后的正文是原文前缀（不是乱码/占位串）', longText.startsWith(t2.text) && t2.text.length === MAX_TEXT_CHARS, t2.text.length);
    ok('截断后仍如实告知', t2.truncated === true, t2.truncated);

    // ==================== 3. 提取阶段就被拒绝的文件：不该留下正文 ====================
    const short = await upload('太短.txt', '太短了');
    const sSettled = await waitSettled(short.body.id);
    ok('内容过短的文件明确失败', sSettled.status === 'failed', sSettled.parse_error);
    ok('失败原因指明内容过短', /过短/.test(sSettled.parse_error || ''), sSettled.parse_error);
    const sText = await fetch(`${BASE}/api/books/${short.body.id}/text`);
    ok('没有正文本体时返回 404（而不是空字符串冒充成功）', sText.status === 404, sText.status);

    // ==================== 4. 删除书籍应级联删掉正文 ====================
    const del = await fetch(`${BASE}/api/books/${bookId}`, { method: 'DELETE' });
    ok('删除书籍返回成功', del.status === 200, del.status);
    const afterDel = await fetch(`${BASE}/api/books/${bookId}/text`);
    ok('删除后正文一并消失（级联生效）', afterDel.status === 404, afterDel.status);

    // ==================== 5. 边界 ====================
    const noBook = await fetch(`${BASE}/api/books/not-exist/text`);
    ok('不存在的书返回 404', noBook.status === 404, noBook.status);
    const list = await (await fetch(`${BASE}/api/books`)).json();
    ok('列表接口正常', Array.isArray(list), Array.isArray(list) ? list.length + ' 本' : typeof list);
    ok('列表不夹带正文本体', !JSON.stringify(list).includes(BOOK_TEXT.slice(0, 60)));

    console.log('\n' + (fails === 0 ? `✅ 全部通过（共 ${total} 条断言）` : `❌ 失败 ${fails} / ${total} 条`));
    if (fails) { console.log('\n--- 服务端日志（末尾 2000 字）---\n' + serverLog.slice(-2000)); }
  } catch (e) {
    console.error('测试异常:', e && e.stack || e);
    console.log('\n--- 服务端日志（末尾 3000 字）---\n' + serverLog.slice(-3000));
    process.exitCode = 1;
  } finally {
    stopServer();
  }
})();
