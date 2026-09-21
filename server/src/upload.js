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
          chain.steps.forEach((s, si) => {
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
    return fs.readFileSync(filePath, 'utf-8');
  }

  if (ext === '.pdf') {
    // 使用 pdf.js 提取文本（需要 pdfjs-dist 包）
    try {
      const pdfjs = require('pdfjs-dist');
      const data = fs.readFileSync(filePath);
      const doc = await pdfjs.getDocument({ data }).promise;
      let text = '';
      for (let i = 1; i <= Math.min(doc.numPages, 50); i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(item => item.str).join(' ') + '\n';
      }
      return text;
    } catch (e) {
      console.warn('PDF 提取失败，尝试备用方法:', e.message);
      return `[PDF 文件: ${path.basename(filePath)}]`;
    }
  }

  if (ext === '.epub') {
    // EPUB 本质是 zip，尝试解压后提取
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(filePath);
      const entries = zip.getEntries();
      let text = '';
      for (const entry of entries) {
        if (entry.entryName.endsWith('.xhtml') || entry.entryName.endsWith('.html') || entry.entryName.endsWith('.htm')) {
          const content = entry.getData().toString('utf-8');
          // 简单去除 HTML 标签
          text += content.replace(/<[^>]*>/g, '') + '\n';
        }
      }
      return text || `[EPUB 文件: ${path.basename(filePath)}]`;
    } catch (e) {
      console.warn('EPUB 提取失败:', e.message);
      return `[EPUB 文件: ${path.basename(filePath)}]`;
    }
  }

  return `[${ext.toUpperCase()} 文件: ${path.basename(filePath)}]`;
}

module.exports = router;