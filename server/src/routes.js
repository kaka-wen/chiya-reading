const express = require('express');
const router = express.Router();
const db = require('./db');
const { v4: uuidv4 } = require('uuid');

// ==================== 用户 ====================

// 获取或创建用户
router.post('/users', (req, res) => {
  const { nickname } = req.body;
  const id = uuidv4();
  try {
    db.prepare('INSERT INTO users (id, nickname) VALUES (?, ?)').run(id, nickname || '读者');
    res.json({ id, nickname: nickname || '读者' });
  } catch (e) {
    // 可能已存在，查询
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    res.json(user);
  }
});

// 获取用户信息
router.get('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(user);
});

// ==================== 书籍 ====================

// 获取书籍列表（书架）
router.get('/books', (req, res) => {
  const { user_id } = req.query;
  let books;
  if (user_id) {
    books = db.prepare(`
      SELECT b.*, s.finished, s.mastery
      FROM books b
      LEFT JOIN shelf s ON s.book_id = b.id AND s.user_id = ?
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC
    `).all(user_id, user_id);
  } else {
    books = db.prepare('SELECT * FROM books ORDER BY created_at DESC').all();
  }
  res.json(books);
});

// 获取单本书籍详情（含解析结果）
router.get('/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: '书籍不存在' });

  const theories = db.prepare('SELECT * FROM theories WHERE book_id = ? ORDER BY idx').all(book.id);
  
  // 为每个理论加载关联理论
  const theoriesWithRelated = theories.map(t => {
    const related = db.prepare('SELECT * FROM related_theories WHERE theory_id = ?').all(t.id);
    return { ...t, related };
  });

  const chains = db.prepare(`
    SELECT lc.*, ls.id as step_id, ls.idx as step_idx, ls.label as step_label, 
           ls.content as step_content, ls.source as step_source
    FROM logic_chains lc
    LEFT JOIN logic_steps ls ON ls.chain_id = lc.id
    WHERE lc.book_id = ?
    ORDER BY lc.id, ls.idx
  `).all(book.id);

  // 整理逻辑链结构
  const chainMap = {};
  chains.forEach(row => {
    if (!chainMap[row.id]) {
      chainMap[row.id] = {
        id: row.id, theory_id: row.theory_id, title: row.title, steps: []
      };
    }
    if (row.step_id) {
      chainMap[row.id].steps.push({
        id: row.step_id, idx: row.step_idx, label: row.step_label,
        content: row.step_content, source: row.step_source
      });
    }
  });

  const cases = db.prepare('SELECT * FROM cases WHERE book_id = ?').all(book.id);

  res.json({
    ...book,
    theories: theoriesWithRelated,
    chains: Object.values(chainMap),
    cases
  });
});

// 删除书籍
router.delete('/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: '书籍不存在' });
  
  db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==================== 书架 ====================

// 获取书架
router.get('/shelf', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: '需要 user_id' });

  const items = db.prepare(`
    SELECT s.*, b.title, b.author, b.file_ext, b.cover_data
    FROM shelf s
    JOIN books b ON b.id = s.book_id
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `).all(user_id);

  res.json(items);
});

// 放入书架
router.post('/shelf', (req, res) => {
  const { user_id, book_id, finished, mastery } = req.body;
  if (!user_id || !book_id) return res.status(400).json({ error: '缺少参数' });

  const id = uuidv4();
  try {
    db.prepare(`
      INSERT INTO shelf (id, user_id, book_id, finished, mastery)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, user_id, book_id, finished ? 1 : 0, mastery || '');
    res.json({ id, success: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      // 已存在，更新
      db.prepare(`
        UPDATE shelf SET finished = ?, mastery = ?, created_at = datetime('now')
        WHERE user_id = ? AND book_id = ?
      `).run(finished ? 1 : 0, mastery || '', user_id, book_id);
      res.json({ success: true, updated: true });
    } else {
      throw e;
    }
  }
});

// 从书架移除
router.delete('/shelf', (req, res) => {
  const { user_id, book_id } = req.query;
  if (!user_id || !book_id) return res.status(400).json({ error: '缺少参数' });

  db.prepare('DELETE FROM shelf WHERE user_id = ? AND book_id = ?').run(user_id, book_id);
  res.json({ success: true });
});

// ==================== 评测 ====================

// 提交评测答案
router.post('/quiz', (req, res) => {
  const { user_id, book_id, theory_id, score, state, phase } = req.body;
  if (!user_id || !book_id || !theory_id) return res.status(400).json({ error: '缺少参数' });

  // 确保用户存在
  const existingUser = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!existingUser) {
    db.prepare('INSERT INTO users (id, nickname) VALUES (?, ?)').run(user_id, '读者');
  }

  const existing = db.prepare(
    'SELECT * FROM quiz_results WHERE user_id = ? AND book_id = ? AND theory_id = ?'
  ).get(user_id, book_id, theory_id);

  if (existing) {
    const failCount = state === 'failed' ? existing.fail_count + 1 : existing.fail_count;
    db.prepare(`
      UPDATE quiz_results SET score = ?, state = ?, fail_count = ?, phase = ?,
             updated_at = datetime('now')
      WHERE user_id = ? AND book_id = ? AND theory_id = ?
    `).run(score, state, failCount, phase, user_id, book_id, theory_id);
  } else {
    db.prepare(`
      INSERT INTO quiz_results (id, user_id, book_id, theory_id, score, state, fail_count, phase)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), user_id, book_id, theory_id, score, state, state === 'failed' ? 1 : 0, phase);
  }

  res.json({ success: true });
});

// 获取评测结果
router.get('/quiz', (req, res) => {
  const { user_id, book_id } = req.query;
  if (!user_id || !book_id) return res.status(400).json({ error: '缺少参数' });

  const results = db.prepare(
    'SELECT * FROM quiz_results WHERE user_id = ? AND book_id = ?'
  ).all(user_id, book_id);

  res.json(results);
});

module.exports = router;