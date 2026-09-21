const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const ai = require('./ai');

// 配置文件上传
// 上传目录同样要可覆盖：线上需与数据库放在同一个持久化卷里，
// 否则重新部署后书籍记录还在、但原始文件已丢失。
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
console.log(`[upload] 上传目录: ${UPLOAD_DIR}`);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.epub', '.pdf', '.mobi', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 EPUB / PDF / MOBI / TXT 格式'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// ==================== 上传 ====================

// 上传电子书
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });

    const file = req.file;
    const ext = path.extname(file.originalname).toLowerCase();
    const title = path.basename(file.originalname, ext);
    const userId = req.body.user_id || 'default';

    // 确保用户存在
    const existingUser = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!existingUser) {
      db.prepare('INSERT INTO users (id, nickname) VALUES (?, ?)').run(userId, '读者');
    }

    // 创建书籍记录
    const bookId = uuidv4();
    db.prepare(`
      INSERT INTO books (id, user_id, title, file_path, file_ext, status)
      VALUES (?, ?, ?, ?, ?, 'uploaded')
    `).run(bookId, userId, title, file.path, ext.replace('.', ''));

    // 异步开始解析
    res.json({
      id: bookId,
      title,
      status: 'uploaded',
      message: '文件已上传，开始 AI 解析...'
    });

    // 后台解析（不阻塞响应）
    parseBookAsync(bookId, file.path, title);

  } catch (e) {
    console.error('上传失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// 获取解析状态
router.get('/upload/:id/status', (req, res) => {
  const book = db.prepare('SELECT id, title, status, parse_error FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: '书籍不存在' });
  res.json(book);
});

// ==================== 解析逻辑 ====================

async function parseBookAsync(bookId, filePath, title) {
  try {
    // 更新状态为解析中
    db.prepare("UPDATE books SET status = 'parsing' WHERE id = ?").run(bookId);

    // 提取文本
    const text = await extractText(filePath);
    if (!text || text.length < 20) {
      throw new Error('无法从文件中提取有效文本，请确认文件格式正确');
    }

    // 截取前 50000 字符（控制 token 消耗）
    const truncatedText = text.slice(0, 50000);

    // AI 解析
    const result = await ai.parseBook(title, truncatedText, (msg) => {
      console.log(`[${bookId}] ${msg}`);
    });

    // ⚠️ 校验：提取不到任何理论时绝不能标记为 parsed ——
    //    否则用户会看到「上传成功、解析完成」，点进去却什么都没有，
    //    只能反复重传，比直接报错更糟。宁可诚实地失败并说明原因。
    const theoryCount = Array.isArray(result.theories) ? result.theories.length : 0;
    if (theoryCount === 0) {
      throw new Error('未能从本书内容中提炼出核心理论。可能原因：正文文字过少、内容不是一本书、或文件为扫描版。请换一本试试。');
    }

    // 存入数据库
    const insertTheory = db.prepare(`
      INSERT INTO theories (id, book_id, idx, name, sub, def, eval_impact, eval_debate, src)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRelated = db.prepare(`
      INSERT INTO related_theories (id, theory_id, name, meta, link, def, source, pos, year)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChain = db.prepare(`
      INSERT INTO logic_chains (id, book_id, theory_id, title) VALUES (?, ?, ?, ?)
    `);
    const insertStep = db.prepare(`
      INSERT INTO logic_steps (id, chain_id, idx, label, content, source) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertCase = db.prepare(`
      INSERT INTO cases (id, book_id, theory_id, tag, title, scene, result, why, steps, use_text, src_type, src_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
      // 理论
      result.theories.forEach((t, i) => {
        const tid = uuidv4();
        insertTheory.run(tid, bookId, i + 1, t.name, t.sub || '', t.def,
          t.eval_impact || '', t.eval_debate || '', t.src || '');

        // 关联理论
        (t.related || []).forEach(r => {
          insertRelated.run(uuidv4(), tid, r.name, r.meta || '', r.link || '',
            r.def || '', r.source || 'ai', r.pos || '', r.year || null);
        });

        // 逻辑链
        const chain = (result.chains || []).find(c => c.theory_name === t.name);
        if (chain) {
          const cid = uuidv4();
          insertChain.run(cid, bookId, tid, chain.title || `${t.name} · 验证逻辑链`);
          (chain.steps || []).forEach((s, si) => {
            insertStep.run(uuidv4(), cid, si + 1, s.label, s.content, s.source || '');
          });
        }
      });

      // 案例
      (result.cases || []).forEach(c => {
        const theory = result.theories.find(t => t.name === c.tag);
        if (theory) {
          const theoryRow = db.prepare(
            'SELECT id FROM theories WHERE book_id = ? AND name = ?'
          ).get(bookId, theory.name);
          if (theoryRow) {
            insertCase.run(uuidv4(), bookId, theoryRow.id, c.tag, c.title,
              c.scene, c.result, c.why, JSON.stringify(c.steps || []),
              c.use_text, c.src_type || 'ai', c.src_text || '');
          }
        }
      });

      // 更新状态
      db.prepare("UPDATE books SET status = 'parsed', updated_at = datetime('now') WHERE id = ?").run(bookId);
    });

    transaction();
    console.log(`[${bookId}] 解析完成`);

  } catch (e) {
    console.error(`[${bookId}] 解析失败:`, e);
    db.prepare("UPDATE books SET status = 'failed', parse_error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(e.message, bookId);
  }
}

/**
 * 从文件中提取文本
 */
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.txt') {
    const t = fs.readFileSync(filePath, 'utf-8');
    if (t.trim().length < 100) throw new Error('文本文件内容过短，无法解析');
    return t;
  }

  if (ext === '.pdf') {
    // 用 pdf.js 提取文本。
    // ⚠️ pdf.js v4+ 有两条硬性要求，任何一条不满足都必然失败：
    //   1) data 必须是 Uint8Array —— v6 的 getDataProp() 会**显式拒绝** Node 的 Buffer，
    //      而 fs.readFileSync() 返回的正是 Buffer，所以直接传会抛
    //      「Please provide binary data as `Uint8Array`, rather than `Buffer`」。
    //      另外校验还要求 val.byteLength === val.buffer.byteLength，故用 new Uint8Array(buf) 整体拷贝最稳。
    //   2) Node 环境必须用 legacy 构建 —— 主构建会崩在 `Promise.try is not a function`（Node 22 无此 API）。
    //      用动态 import() 而非 require()，因为 require(ESM) 在 Node < 22.12 不可用。
    // 还有一条：提取失败必须抛错，绝不能返回占位字符串 —— 占位串会通过「有效文本」检查，
    //   让整条流水线误判成功（AI 拿占位串提炼不出理论 → status=parsed 但 theories=[] 的假成功）。
    let text = '';
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const data = new Uint8Array(fs.readFileSync(filePath));
      const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
      const doc = await pdfjs.getDocument({
        data,
        // 不提供标准字体数据时，使用标准字体的 PDF 会提取不到文字（pdf.js 会告警）
        standardFontDataUrl: path.join(pkgDir, 'standard_fonts/')
      }).promise;
      const pages = Math.min(doc.numPages, 50);
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(item => item.str || '').join(' ') + '\n';
      }
      if (text.replace(/\s/g, '').length < 200) {
        throw new Error('该 PDF 提取不到文字（共 ' + doc.numPages + ' 页，很可能是扫描版／图片型 PDF）。请改用带文字层的 PDF，或先做 OCR。');
      }
      console.log(`[pdf] 提取成功：${doc.numPages} 页，${text.replace(/\s/g, '').length} 字`);
      return text;
    } catch (e) {
      // 区分「我们主动抛出的可读原因」与「pdf.js 内部错误」
      if (e.message && e.message.includes('提取不到文字')) throw e;
      throw new Error('PDF 文字提取失败：' + (e.message || '未知错误'));
    }
  }

  if (ext === '.epub') {
    // EPUB 本质是 zip，尝试解压后提取
    let text = '';
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries();
      for (const entry of entries) {
        if (entry.entryName.endsWith('.xhtml') || entry.entryName.endsWith('.html') || entry.entryName.endsWith('.htm')) {
          const content = entry.getData().toString('utf-8');
          // 简单去除 HTML 标签
          text += content.replace(/<[^>]*>/g, '') + '\n';
        }
      }
    } catch (e) {
      throw new Error('EPUB 解析失败：' + (e.message || '未知错误'));
    }
    if (text.replace(/\s/g, '').length < 200) {
      throw new Error('该 EPUB 提取不到文字，请确认文件未损坏');
    }
    return text;
  }

  // MOBI 等暂不支持提取：明确报错，不要返回占位串冒充成功
  throw new Error(`暂不支持从 ${ext.toUpperCase()} 文件中提取文字，请上传 EPUB / PDF / TXT`);
}

module.exports = router;