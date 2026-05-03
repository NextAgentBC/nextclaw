/**
 * Deterministic taxonomy classifier for ingest.
 *
 * Multi-label: a single chunk can belong to several categories (e.g. "今天
 * 去医院花了 500 块买药" → medical + finance). Per-category keyword
 * dictionaries (CN + EN) drive matching. Each match contributes weight; the
 * category fires when total weight crosses MIN_WEIGHT.
 *
 * 0 LLM tokens, 0 RTT. Lives in Stage 0 deterministic alongside event /
 * metric / preference extraction. Output is consumed by:
 *
 *   1. multi-key index — `kind='category'` rows on `semantic.chunk_indexes`
 *      so categorical queries ("最近的健康记忆") fan out via concept_tag
 *      route's structured short-circuit.
 *   2. ingest policy — `health` / `medical` chunks elevate to
 *      retentionClass='pinned' and importance=max(0.7, given) automatically
 *      so the user's standing privacy preference is honored deterministically.
 *   3. dashboard — recent feed groups by category; health/medical excerpts
 *      can render redacted by default.
 *
 * Categories are intentionally coarse (6+1). Sub-classification can layer on
 * top via concept_tag co-occurrence rather than expanding the taxonomy.
 */

export type Category =
  | "health"   // 锻炼 / 睡眠 / 饮食营养 / 体重
  | "medical"  // 医院 / 检查 / 用药 / 症状 / 诊断
  | "tech"     // 代码 / 工具 / 部署 / 编程
  | "life"     // 餐饮 / 朋友家人 / 娱乐 / 旅行 / 居家
  | "work"     // 会议 / 客户 / 邮件 / 公司事务（非技术）
  | "finance"  // 钱 / 价格 / 投资 / 账单
  | "other";   // catchall — 没命中其它任一类时使用

export type CategoryHit = {
  category: Category;
  weight: number;        // 累积命中权重
  evidence: string[];    // 命中的 keyword 样本（去重，最多 5 条）
};

type Rule = {
  /** Compiled pattern. `u` flag for CJK; `i` for case-insensitive latin. */
  re: RegExp;
  /** Per-hit weight contribution. */
  w: number;
};

/**
 * Each category's rule set. Weights:
 *   2.0 — strong signal (rarely false-positives, e.g. "胰岛素" / "PR #1234")
 *   1.0 — normal
 *   0.5 — weak hint (only matters if multiple co-occur, e.g. "钱" alone)
 *
 * Rules are conservative: prefer false negatives over false positives. The
 * `other` bucket catches under-matched chunks; we'd rather miss a category
 * than mislabel a tech commit as medical.
 */
const RULES: Record<Exclude<Category, "other">, Rule[]> = {
  health: [
    // CN — 运动 / 饮食 / 睡眠 / 体重
    { re: /(?:跑步|跑了|慢跑|快跑|快走|散步|遛弯|健身|瑜伽|游泳|骑车|骑行|徒步|爬山|举铁|拉伸|hiit|crossfit|马拉松|半马|全马)/iu, w: 2.0 },
    { re: /(?:卡路里|千卡|大卡|kcal|cal|蛋白质|碳水|脂肪|纤维|维生素|维他命)/iu, w: 2.0 },
    { re: /(?:睡眠|睡了|失眠|熬夜|早睡|早起|午睡|小睡|nap|sleep[- ]?cycle|deep[- ]?sleep|rem)/iu, w: 1.5 },
    { re: /(?:体重|减肥|增肌|减脂|bmi|体脂率|腰围|臂围)/iu, w: 1.5 },
    // Direct category-shaped queries — these alone are enough to fire health.
    { re: /(?:健康|养生|锻炼|运动)/iu, w: 1.5 },
    { re: /(?:营养|身体|身材|减重|戒糖|戒酒|戒烟|轻断食|断食)/iu, w: 1.0 },
    { re: /(?:走了\s*\d+\s*步|走\s*\d+\s*km|跑\s*\d+\s*km|\d+\s*km\s*跑)/iu, w: 1.5 },
    // EN
    { re: /\b(?:exercise|workout|cardio|hiit|run|running|jog|gym|fitness|yoga|stretch|pilates|swim|cycling|hiking|squat|deadlift|bench)\b/i, w: 2.0 },
    { re: /\b(?:calories?|kcal|protein|carbs?|carbohydrates?|fat|fiber|nutrition|vitamin|macros)\b/i, w: 1.5 },
    { re: /\b(?:sleep|slept|insomnia|nap|rest|recovery|fatigue|tired|energy[- ]level)\b/i, w: 1.0 },
    { re: /\b(?:weight|bmi|body[- ]fat|waist|measurement)\b/i, w: 1.0 },
  ],

  medical: [
    // CN — 医院 / 用药 / 症状 / 诊断
    { re: /(?:医院|诊所|科室|急诊|住院|门诊|挂号|候诊|医保|社保|体检|预约医生|约医生|看医生|看病|就诊)/u, w: 2.0 },
    // Medical practitioners. 主任/主治 alone are too generic (系主任 = dept
    // chair); require 医师/医院 context, anchored by surrounding 医-prefix.
    { re: /(?:医生|大夫|护士|药师|医师|主治医生|主治医师)/u, w: 1.0 },
    // Pure CJK lab/exam terms — no boundary issues here.
    { re: /(?:血压|血糖|心率|血脂|胆固醇|尿酸|甘油三酯|肝功|肾功|血常规|尿常规|心电|超声|x光|彩超)/u, w: 2.0 },
    // Short EN abbreviations (ct/mri/ekg/...) MUST have word boundaries —
    // without \b, "ct" matches inside "pgve(ct)or", "ml" inside "html", etc.
    { re: /\b(?:ct[- ]?scan|mri|ekg|ecg|a1c|hba1c|x[- ]ray|ultrasound|biopsy)\b/i, w: 2.0 },
    // Drugs/treatment. 药/片 alone are too generic (照片 has 片, 药水 vs
    // 唱片 etc). Require compound forms: 吃药 服药 用药 中药 处方药 抗生素 ...
    { re: /(?:吃药|服药|用药|开药|拿药|买药|中药|处方药|药丸|药水|胶囊|注射|输液|打针|疫苗|抗生素|消炎药|止痛药|安眠药|降压药|降糖药|胰岛素|阿莫西林|布洛芬|对乙酰氨基酚|泰诺|阿司匹林)/u, w: 2.0 },
    { re: /(?:头痛|头晕|发烧|发热|咳嗽|咳血|咳痰|腹痛|腹泻|呕吐|恶心|过敏|皮疹|湿疹|过敏性|过敏原|气喘|哮喘|心悸|胸闷|失眠症)/u, w: 2.0 },
    { re: /(?:糖尿病|高血压|高血脂|心脏病|冠心病|肺炎|哮喘|抑郁|焦虑|失眠症|偏头痛|甲亢|甲减|肝炎|胃炎|肠胃炎|关节炎|骨质疏松)/u, w: 2.0 },
    // EN
    { re: /\b(?:hospital|clinic|emergency[- ]room|er|icu|ward|appointment|checkup|physical|insurance|medicare|medicaid)\b/i, w: 2.0 },
    { re: /\b(?:doctor|physician|nurse|pharmacist|specialist|gp|dentist|surgeon)\b/i, w: 1.0 },
    { re: /\b(?:blood[- ]pressure|blood[- ]sugar|heart[- ]rate|cholesterol|hemoglobin|a1c|hba1c|ekg|ecg|mri|ct[- ]scan|x[- ]ray|ultrasound)\b/i, w: 2.0 },
    { re: /\b(?:medication|prescription|prescribe[ds]?|antibiotic|painkiller|insulin|metformin|ibuprofen|acetaminophen|paracetamol|tylenol|advil)\b/i, w: 2.0 },
    { re: /\b(?:headache|migraine|fever|cough|nausea|diarrhea|vomit|allergic|allergy|rash|asthma|chest[- ]pain|shortness[- ]of[- ]breath)\b/i, w: 2.0 },
    { re: /\b(?:diabetes|hypertension|cardiac|coronary|pneumonia|asthma|depression|anxiety|insomnia|arthritis|osteoporosis|hepatitis|gastritis)\b/i, w: 2.0 },
  ],

  tech: [
    // CN — 工程 / 工具 / 部署
    { re: /(?:代码|编程|程序|脚本|函数|变量|算法|架构|框架|库|包|依赖|编译|构建|打包|发布|部署|上线|回滚|灰度|测试用例|单测|集成测试|压测)/u, w: 2.0 },
    { re: /(?:服务器|主机|端口|防火墙|网络|路由|tcp|udp|http|https|websocket|ssl|tls|证书|cors|cdn|nginx|caddy)/iu, w: 2.0 },
    { re: /(?:数据库|表|索引|查询|sql|nosql|事务|锁|主从|分库|分表|缓存|分布式)/iu, w: 1.5 },
    { re: /(?:容器|镜像|docker|compose|k8s|kubernetes|pod|helm|terraform|ansible)/iu, w: 2.0 },
    // EN — code / repo / DevOps
    { re: /\b(?:code|coding|program|programming|script|function|variable|algorithm|architecture|framework|library|package|dependency|compile|build|deploy|deployment|release|rollback)\b/i, w: 2.0 },
    { re: /\b(?:repo|repository|commit|branch|merge|rebase|fork|clone|pull[- ]request|pr|push|stash|cherry[- ]pick|squash)\b/i, w: 2.0 },
    { re: /\b(?:server|host|port|firewall|tcp|udp|http[s]?|websocket|api|endpoint|sdk|cli)\b/i, w: 1.5 },
    { re: /\b(?:database|sql|nosql|index|query|transaction|postgres|postgresql|mysql|sqlite|redis|mongo|mongodb|pgvector|hnsw)\b/i, w: 2.0 },
    { re: /\b(?:docker|container|image|kubernetes|k8s|helm|terraform|ansible|nginx|caddy|systemd)\b/i, w: 2.0 },
    { re: /\b(?:typescript|javascript|python|rust|golang|ts|js|py|node|deno|bun|pnpm|npm|cargo)\b/i, w: 1.5 },
    { re: /\b(?:embedding|llm|ml|model|inference|fine[- ]?tune|tokenizer|prompt|context[- ]window|rag|vector|hnsw|cosine|tsvector)\b/i, w: 2.0 },
    { re: /\b(?:bug|issue|fix|patch|hotfix|regression|stack[- ]?trace|exception|error[- ]code|panic|crash|timeout|leak|memory[- ]leak)\b/i, w: 1.5 },
    // Hyphenated and namespaced identifiers — strong tech signal.
    { re: /[a-z][a-z0-9]+(?:-[a-z][a-z0-9]+){2,}/i, w: 1.0 },
    { re: /[a-z][a-zA-Z0-9]*\/[a-z][a-zA-Z0-9.-]*/i, w: 0.5 }, // foo/bar.ts paths
  ],

  life: [
    // CN — 餐饮 / 家庭 / 娱乐 / 旅行 / 居家
    { re: /(?:早餐|午餐|晚餐|午饭|晚饭|早饭|宵夜|下午茶|奶茶|咖啡|茶|喝水|外卖|做饭|做菜|烧菜|出去吃|聚餐)/u, w: 1.5 },
    { re: /(?:朋友|家人|亲戚|父母|妈|爸|爷爷|奶奶|姥姥|姥爷|兄弟|姐妹|老公|老婆|男友|女友|对象|孩子|宝宝|娃|猫|狗|宠物)/u, w: 1.5 },
    { re: /(?:电影|电视剧|剧集|综艺|游戏|玩|周末|放假|度假|旅行|旅游|出门|逛街|购物|逛|约|散步|遛狗|遛猫)/u, w: 1.5 },
    { re: /(?:家|搬家|租房|买房|装修|家具|沙发|床|厨房|浴室|阳台|衣服|鞋|穿)/u, w: 1.0 },
    // EN
    { re: /\b(?:breakfast|brunch|lunch|dinner|snack|coffee|tea|beer|wine|cooking|takeout|delivery)\b/i, w: 1.5 },
    { re: /\b(?:friend|family|parents|mom|dad|brother|sister|spouse|wife|husband|kid|child|baby|pet|cat|dog)\b/i, w: 1.5 },
    { re: /\b(?:movie|show|tv|series|game|gaming|weekend|holiday|vacation|trip|travel|shopping|park|walk|hike)\b/i, w: 1.5 },
    { re: /\b(?:home|house|apartment|rent|move|furniture|kitchen|bathroom|balcony|clothes|outfit)\b/i, w: 1.0 },
  ],

  work: [
    // CN — 公司 / 会议 / 客户 / 项目（非技术维度）
    { re: /(?:开会|会议|例会|站会|周会|月会|季度|年会|约时间|预约|改时间|改期|延期)/u, w: 2.0 },
    { re: /(?:客户|甲方|乙方|供应商|合作方|合作伙伴|partner|vendor)/iu, w: 1.5 },
    { re: /(?:合同|签|签字|盖章|发票|报销|预算|报价|招标|投标|验收|交付|deadline)/iu, w: 2.0 },
    { re: /(?:邮件|发邮件|回邮件|cc|抄送|密送|工作邮箱|公司邮箱|outlook)/iu, w: 1.5 },
    { re: /(?:老板|领导|总监|经理|主管|hr|同事|下属|实习生|入职|离职|晋升|升职|加薪|绩效|review)/iu, w: 1.5 },
    { re: /(?:报告|汇报|周报|月报|季报|演示|ppt|文档|提案|方案)/u, w: 1.5 },
    // EN
    { re: /\b(?:meeting|standup|sync|all[- ]hands|1on1|1:1|kickoff|retro|retrospective)\b/i, w: 2.0 },
    { re: /\b(?:client|customer|vendor|supplier|partner|prospect|lead|sales[- ]call)\b/i, w: 1.5 },
    { re: /\b(?:contract|nda|invoice|expense|budget|quote|rfp|deliverable|deadline|sla)\b/i, w: 2.0 },
    { re: /\b(?:email|reply|forward|cc|bcc|inbox|outlook|gmail)\b/i, w: 1.0 },
    { re: /\b(?:boss|manager|director|vp|hr|colleague|teammate|intern|onboard|offboard|promotion|raise|review|kpi|okr)\b/i, w: 1.5 },
    { re: /\b(?:report|presentation|slides|deck|proposal|memo|spec)\b/i, w: 1.0 },
  ],

  finance: [
    // CN — 钱 / 价格 / 投资 / 账单
    { re: /(?:工资|薪水|奖金|分红|股权|期权|税|个税|公积金|社保|医保)/u, w: 2.0 },
    { re: /(?:股票|基金|债券|期货|期权|加密货币|btc|eth|比特币|以太坊|defi)/iu, w: 2.0 },
    { re: /(?:房贷|车贷|信用卡|花呗|借呗|分期|利息|利率|首付|月供)/u, w: 2.0 },
    { re: /(?:支付|付款|转账|汇款|收款|发红包|aa|刷卡|扫码|微信支付|支付宝|alipay|paypal|stripe|venmo)/iu, w: 1.5 },
    // CJK currency suffix: \b doesn't fire at CJK boundaries, use lookahead.
    { re: /(?:￥|¥)\s*\d+|\d+\s*(?:元|块钱|块|人民币|RMB|美元|美刀|刀|加币|cad|usd)(?![A-Za-z0-9])/iu, w: 2.0 },
    { re: /\$\s*\d+|\d+\s*(?:bucks?|dollars?|cents?)\b/i, w: 2.0 },
    // EN
    { re: /\b(?:salary|wage|bonus|stock|equity|option[s]?|tax|taxes|401k|ira|pension)\b/i, w: 2.0 },
    { re: /\b(?:stock|bond|fund|etf|mutual[- ]fund|crypto|btc|eth|bitcoin|ethereum|defi|nft)\b/i, w: 2.0 },
    { re: /\b(?:mortgage|loan|credit[- ]card|debit[- ]card|interest|apr|down[- ]payment|installment)\b/i, w: 2.0 },
    { re: /\b(?:payment|transfer|wire|paypal|venmo|stripe|alipay|wechat[- ]pay)\b/i, w: 1.5 },
    { re: /\b(?:invest|investment|portfolio|asset|liability|net[- ]worth|profit|loss|cashflow|revenue|expense)\b/i, w: 1.5 },
  ],
};

// Categories below this total weight are dropped before emit. Tuned so a
// single weak signal alone (e.g. one stray "钱") doesn't mislabel a chunk.
const MIN_WEIGHT = 1.5;
// Hard cap evidence list to avoid bloating chunk_indexes with debug strings
// (the stored value is the category name, evidence stays in audit only).
const MAX_EVIDENCE = 5;

export function categorize(text: string): CategoryHit[] {
  if (!text || text.trim().length === 0) {return [];}
  const hits = new Map<Category, { weight: number; evidence: string[] }>();
  for (const cat of Object.keys(RULES) as Array<keyof typeof RULES>) {
    for (const rule of RULES[cat]) {
      const matches = text.match(rule.re);
      if (!matches) {continue;}
      const cur = hits.get(cat) ?? { weight: 0, evidence: [] };
      cur.weight += rule.w;
      if (cur.evidence.length < MAX_EVIDENCE && !cur.evidence.includes(matches[0])) {
        cur.evidence.push(matches[0]);
      }
      hits.set(cat, cur);
    }
  }
  const out: CategoryHit[] = [];
  for (const [cat, agg] of hits) {
    if (agg.weight >= MIN_WEIGHT) {
      out.push({ category: cat, weight: agg.weight, evidence: agg.evidence });
    }
  }
  // Sort by descending weight so the dominant category leads.
  out.sort((a, b) => b.weight - a.weight);
  // If nothing matched strongly enough, emit "other" so every chunk has at
  // least one category index row — makes downstream "show me all chunks of
  // category X" queries simpler (no NULL handling).
  if (out.length === 0) {
    out.push({ category: "other", weight: 0, evidence: [] });
  }
  return out;
}

/**
 * Privacy policy: per the user's standing preference, health + medical
 * content is auto-pinned and elevated in importance (so it's never silently
 * GC'd) and rendered redacted on the public dashboard. Other categories
 * follow the caller's explicit `retentionClass` / `importance`.
 */
export function applyCategoryPolicy(
  hits: CategoryHit[],
  current: { importance?: number; retentionClass?: "ephemeral" | "standard" | "pinned" },
): { importance?: number; retentionClass?: "ephemeral" | "standard" | "pinned" } {
  const isSensitive = hits.some((h) => h.category === "health" || h.category === "medical");
  if (!isSensitive) {return current;}
  return {
    importance: Math.max(current.importance ?? 0, 0.7),
    // Don't downgrade an already-pinned chunk; only elevate from
    // 'standard' / 'ephemeral' / undefined.
    retentionClass: current.retentionClass === "pinned" ? "pinned" : "pinned",
  };
}

export const _internal = { RULES, MIN_WEIGHT };
