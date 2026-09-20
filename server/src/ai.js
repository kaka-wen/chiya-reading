/**
 * AI 解析模块
 * 调用大模型 API 从书籍文本中提炼核心理论、逻辑链、案例
 * 
 * 当前支持：OpenAI 兼容接口（可配置为混元/文心/DeepSeek 等）
 * 环境变量：
 *   LLM_API_KEY    - API key
 *   LLM_BASE_URL   - API 地址，默认 https://api.openai.com/v1
 *   LLM_MODEL      - 模型名，默认 gpt-4o-mini
 */

const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

/**
 * 调用大模型 API
 */
async function callLLM(messages, options = {}) {
  if (!LLM_API_KEY) {
    throw new Error('未配置 LLM_API_KEY 环境变量');
  }

  const url = `${LLM_BASE_URL}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: options.model || LLM_MODEL,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens || 4096
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM API 错误 (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

/**
 * 从书籍文本中解析核心理论
 * 返回结构化数据
 */
async function parseTheories(bookTitle, text) {
  const prompt = `你是一位专业的书籍分析助手。请从以下书籍内容中提炼核心理论。

书籍：《${bookTitle}》

要求：
1. 找出书中 3-6 个最核心的理论/概念
2. 每个理论包含：名称、一句话定位、详细定义、学术影响评价、学术争议
3. 每个理论列出 1-3 个关联理论（书中提及的或学术界认可的），标注来源是"书中提及"还是"AI补充"
4. 返回严格的 JSON 格式

输出格式：
{
  "theories": [
    {
      "name": "理论名称",
      "sub": "一句话定位",
      "def": "详细定义（200字左右）",
      "eval_impact": "学术影响评价",
      "eval_debate": "学术争议",
      "src": "书中章节出处",
      "related": [
        {
          "name": "关联理论名称",
          "meta": "提出者",
          "link": "关联关系说明",
          "def": "简要定义",
          "source": "book 或 ai",
          "pos": "书中位置（source为book时必填）",
          "year": 年份
        }
      ]
    }
  ]
}

请只返回 JSON，不要包含其他文字。`;

  const result = await callLLM([
    { role: 'system', content: '你是一个严格输出 JSON 的书籍分析助手。' },
    { role: 'user', content: prompt }
  ]);

  // 尝试解析 JSON（AI 可能返回 markdown 包裹）
  const jsonStr = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(jsonStr);
}

/**
 * 从书籍文本中解析逻辑链
 */
async function parseLogicChains(bookTitle, theories, text) {
  const theoryNames = theories.map(t => t.name).join('、');
  const prompt = `请为《${bookTitle}》中的以下核心理论构建验证逻辑链：${theoryNames}

每个逻辑链包含 4 个步骤：实验/现象 → 观察 → 推理 → 结论
每个步骤需要：标签、内容描述、出处（原文章节或文献）

输出格式：
{
  "chains": [
    {
      "theory_name": "理论名称",
      "title": "逻辑链标题",
      "steps": [
        {"label": "实验", "content": "描述", "source": "出处"},
        {"label": "观察", "content": "描述", "source": "出处"},
        {"label": "推理", "content": "描述", "source": ""},
        {"label": "结论", "content": "描述", "source": ""}
      ]
    }
  ]
}

请只返回 JSON。`;

  const result = await callLLM([
    { role: 'system', content: '你是一个严格输出 JSON 的书籍分析助手。' },
    { role: 'user', content: prompt }
  ]);

  const jsonStr = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(jsonStr);
}

/**
 * 从书籍文本中解析案例
 */
async function parseCases(bookTitle, theories, text) {
  const theoryNames = theories.map(t => `"${t.name}"`).join('、');
  const prompt = `请为《${bookTitle}》中的核心理论（${theoryNames}）各提供 1-2 个案例。

每个案例需要：
- tag: 所属理论名称
- title: 案例标题
- scene: 场景描述
- result: 结果（要有数字、反直觉）
- why: 为什么会这样（一句话）
- steps: 机制拆解（2-3 步，数组）
- use_text: 怎么用在你身上（可执行动作）
- src_type: 来源类型（book=原书案例, study=真实研究, ai=AI推演）
- src_text: 来源说明

输出格式：
{
  "cases": [
    {
      "tag": "理论名称",
      "title": "案例标题",
      "scene": "场景描述",
      "result": "结果",
      "why": "一句话解释",
      "steps": ["步骤1", "步骤2"],
      "use_text": "怎么用",
      "src_type": "book/study/ai",
      "src_text": "来源说明"
    }
  ]
}

请只返回 JSON。`;

  const result = await callLLM([
    { role: 'system', content: '你是一个严格输出 JSON 的书籍分析助手。' },
    { role: 'user', content: prompt }
  ]);

  const jsonStr = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(jsonStr);
}

/**
 * 完整解析一本书
 */
async function parseBook(bookTitle, text, onProgress) {
  if (onProgress) onProgress('正在提炼核心理论...');
  const theoryData = await parseTheories(bookTitle, text);

  if (onProgress) onProgress('正在构建验证逻辑链...');
  const logicData = await parseLogicChains(bookTitle, theoryData.theories, text);

  if (onProgress) onProgress('正在生成案例...');
  const caseData = await parseCases(bookTitle, theoryData.theories, text);

  return {
    theories: theoryData.theories,
    chains: logicData.chains,
    cases: caseData.cases
  };
}

module.exports = { parseBook, callLLM };