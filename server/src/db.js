const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'chiya.db');

// 确保 data 目录存在
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// 开启 WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==================== 建表 ====================
db.exec(`
  -- 用户表
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL DEFAULT '读者',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 书籍表
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT DEFAULT '',
    file_path TEXT,           -- 上传文件路径
    file_ext TEXT,            -- pdf/epub/mobi/txt
    cover_data TEXT,          -- base64 封面图片
    status TEXT NOT NULL DEFAULT 'uploaded',  -- uploaded | parsing | parsed | failed
    parse_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- 核心理论表
  CREATE TABLE IF NOT EXISTS theories (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    name TEXT NOT NULL,
    sub TEXT DEFAULT '',
    def TEXT NOT NULL,
    eval_impact TEXT DEFAULT '',
    eval_debate TEXT DEFAULT '',
    src TEXT DEFAULT '',
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  -- 关联理论表
  CREATE TABLE IF NOT EXISTS related_theories (
    id TEXT PRIMARY KEY,
    theory_id TEXT NOT NULL,
    name TEXT NOT NULL,
    meta TEXT DEFAULT '',
    link TEXT DEFAULT '',
    def TEXT DEFAULT '',
    source TEXT NOT NULL DEFAULT 'book',  -- book | ai
    pos TEXT DEFAULT '',
    year INTEGER,
    FOREIGN KEY (theory_id) REFERENCES theories(id) ON DELETE CASCADE
  );

  -- 逻辑链表
  CREATE TABLE IF NOT EXISTS logic_chains (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    theory_id TEXT NOT NULL,
    title TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (theory_id) REFERENCES theories(id) ON DELETE CASCADE
  );

  -- 逻辑链步骤表
  CREATE TABLE IF NOT EXISTS logic_steps (
    id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    label TEXT NOT NULL,       -- 实验/观察/推理/结论
    content TEXT NOT NULL,
    source TEXT DEFAULT '',
    FOREIGN KEY (chain_id) REFERENCES logic_chains(id) ON DELETE CASCADE
  );

  -- 案例表
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    theory_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    title TEXT NOT NULL,
    scene TEXT NOT NULL,
    result TEXT NOT NULL,
    why TEXT NOT NULL,
    steps TEXT NOT NULL,       -- JSON 数组
    use_text TEXT NOT NULL,
    src_type TEXT NOT NULL DEFAULT 'book',  -- book | study | ai
    src_text TEXT DEFAULT '',
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (theory_id) REFERENCES theories(id) ON DELETE CASCADE
  );

  -- 评测结果表
  CREATE TABLE IF NOT EXISTS quiz_results (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    theory_id TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',  -- pending | mastered | partial | failed
    fail_count INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'round1',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (theory_id) REFERENCES theories(id) ON DELETE CASCADE,
    UNIQUE(user_id, book_id, theory_id)
  );

  -- 书架表
  CREATE TABLE IF NOT EXISTS shelf (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    finished INTEGER NOT NULL DEFAULT 0,
    mastery TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    UNIQUE(user_id, book_id)
  );
`);

module.exports = db;