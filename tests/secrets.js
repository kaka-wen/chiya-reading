/* 密钥扫描：确保被 git 跟踪的文件里没有真实密钥
 *
 * 为什么需要它：本项目真的出过事 —— `server/.env.example` 里填的不是占位符，
 * 而是真实的 DeepSeek key，且仓库是 public，暴露了 9 天才发现。
 * `.env` 本身在 .gitignore 里是对的，**偏偏是那个"给人看的示例文件"泄露的**。
 *
 * 意义：把"记得检查"变成"不通过就失败"。承诺会忘，测试不会。
 *
 * 运行：
 *   node tests/secrets.js      （已接入 npm test）
 * 返回码 0 = 干净；1 = 发现疑似密钥（并打印文件与行号）
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 常见服务商的密钥形状。宁可多报，也不要漏报 ——
// 误报的代价只是写个白名单，漏报的代价是别人的钱。
const PATTERNS = [
  { name: 'OpenAI / DeepSeek 等 sk- 密钥', re: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: 'GitHub 个人令牌', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'GitHub 细粒度令牌', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'AWS Access Key ID', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'Google API Key', re: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: 'Slack Token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: '私钥文件内容', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }
];

// 明显是占位符/示例的写法，允许存在
const PLACEHOLDERS = [
  /sk-your-own-key-here/i,
  /sk-xxx+/i,
  /sk-\.\.\./i,
  /your[-_]?key/i,
  /placeholder/i,
  /<[^>]*key[^>]*>/i,
  /example|sample|dummy|test[-_]?key/i
];

const isPlaceholder = v => PLACEHOLDERS.some(p => p.test(v));

function trackedFiles() {
  const out = execSync('git ls-files -z', { cwd: ROOT, encoding: 'utf-8' });
  return out.split('\0').filter(Boolean);
}

const findings = [];
let scanned = 0;

for (const rel of trackedFiles()) {
  const abs = path.join(ROOT, rel);
  let buf;
  try { buf = fs.readFileSync(abs); } catch (_) { continue; }
  if (buf.length > 2 * 1024 * 1024) continue;         // 跳过超大文件
  if (buf.includes(0)) continue;                      // 跳过二进制
  scanned++;

  const text = buf.toString('utf-8');
  text.split('\n').forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      const m = line.match(re);
      if (!m) continue;
      if (m.every(isPlaceholder)) continue;           // 整行命中都是占位符 → 放过
      findings.push({ file: rel, line: i + 1, kind: name, sample: m[0].slice(0, 12) + '…' });
    }
  });
}

if (findings.length) {
  console.error('❌ 被 git 跟踪的文件里发现疑似真实密钥：\n');
  for (const f of findings) {
    console.error(`   ${f.file}:${f.line}   ${f.kind}   ${f.sample}`);
  }
  console.error('\n这些文件会被推到远端仓库 —— 请改成占位符，真实值只放在：'
    + '\n  · 本地 server/.env（已在 .gitignore 中）'
    + '\n  · 部署平台的 Variables 里'
    + '\n\n若已推送过，仅删除无效，必须去服务商控制台吊销并新建密钥。\n');
  process.exit(1);
}

console.log(`✅ 密钥扫描通过（检查了 ${scanned} 个被跟踪的文件，无真实密钥）`);
