const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// 加载 .env 文件
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3001;

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 静态文件：前端原型
// 演示阶段前端改得频繁，禁掉缓存 —— 否则「明明改了、刷新却没变」会反复浪费排查时间。
// 关掉 etag/lastModified 后不再返回 304，每次都是 200 全量（单文件 200KB 量级，代价可忽略）。
app.use(express.static(path.join(__dirname, '..', '..', 'prototype'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// API 路由
const routes = require('./routes');
const uploadRoutes = require('./upload');

app.use('/api', routes);
app.use('/api', uploadRoutes);

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`赤牙·AI阅读 后端服务已启动: http://localhost:${PORT}`);
  console.log(`前端页面: http://localhost:${PORT}`);
  console.log(`API 健康检查: http://localhost:${PORT}/api/health`);
});