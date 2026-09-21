const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/* 数据目录必须可被环境变量覆盖 —— 否则无法挂载持久化卷。
   默认路径在容器文件系统内，而 Railway 容器是临时的：每次重新部署都会连同
   SQLite 文件和已上传的电子书一起清空（表现为「上传的书部署后就没了」）。
   线上应在 Railway 挂一个 Volume（如挂到 /data），并设置 DATA_DIR=/data。 */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'chiya.db');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// 供 /api/health 暴露：用于部署后一眼确认「是否真的挂上了持久化卷」。
// 没挂卷时 dataDirSource 为 'default'，数据会在每次重新部署时清空。
const DATA_DIR_SOURCE = process.env.DATA_DIR ? 'env' : 'default';

// 开启 WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log(`[db] 数据库文件: ${DB_PATH}`);
console.log(`[db] 数据目录来源: ${process.env.DATA_DIR ? '环境变量 DATA_DIR' : '默认路径（容器临时盘，重新部署会清空！）'}`);

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

db.DATA_DIR = DATA_DIR;
db.DATA_DIR_SOURCE = DATA_DIR_SOURCE;

module.exports = db;