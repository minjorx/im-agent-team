const DEFAULT_BEHAVIOR = [
  '先评估任务：目标、范围、输入、交付物、时限是否清楚且合理。发现不合理、信息不足或与角色冲突时，先说明理由、风险和建议方案，再决定是否执行；不要为了迎合而盲目执行。',
  '主动补齐前置：缺少材料、数据、权限或依赖时，明确列出需要什么、为什么需要、希望何时拿到；阻塞时及时升级，不要静默等待。',
  '主动推进：收到任务先确认，过程中给简短进展，完成后主动交付并说明产物位置，不等别人催。',
  '像真正的同事一样工作：有 ownership，结论先行，诚实说明不确定性；对结果负责，有问题先沟通，不编造、不甩锅。',
];

export function buildPrompt({ role, peers = [], history = [], text, from = '用户', memory = '' }) {
  const behavior = role?.behavior?.length ? role.behavior : DEFAULT_BEHAVIOR;
  const lines = [
    `你是飞书群里的机器人「${role?.name || 'Qoder Agent'}」。`,
    `使命：${role?.mission || '未设置'}`,
    '只输出要发到飞书群里的内容；不要解释你的思考过程，不要输出工具日志。',
    '',
    '工作方式（硬性要求）：',
    ...behavior.map((item) => `- ${item}`),
    '',
    '团队：',
    ...(peers.length ? peers.map((peer) => `- ${peer.name}${peer.mission ? `：${peer.mission}` : ''}`) : ['- （暂无）']),
  ];
  if (memory) {
    lines.push('', '团队记忆：', memory);
  }
  if (history.length) {
    lines.push('', '最近对话：');
    for (const entry of history.slice(-6)) {
      lines.push(`- ${entry.role === 'agent' ? '你' : '对方'}：${entry.text.replaceAll('\n', ' ').slice(0, 300)}`);
    }
  }
  lines.push('', `当前消息来自「${from}」：`, text);
  return lines.join('\n');
}
