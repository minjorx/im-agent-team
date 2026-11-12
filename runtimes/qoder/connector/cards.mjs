const MAX_PREVIEW = 900;

function textContent(value, max = MAX_PREVIEW) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function plain(value) {
  return { tag: 'plain_text', content: textContent(value) };
}

function div(value) {
  return { tag: 'div', text: plain(value) };
}

function note(value) {
  return { tag: 'note', elements: [plain(value)] };
}

function button(label, value, type = 'default') {
  return { tag: 'button', text: plain(label), type, value };
}

function questionLine(question, index) {
  const lines = [];
  const prefix = `Q${index + 1}.${question.header ? ` [${question.header}]` : ''}`;
  lines.push(`${prefix} ${question.question}`);
  const options = Array.isArray(question.options) ? question.options : [];
  for (const [optionIndex, option] of options.entries()) {
    const description = option.description ? ` — ${option.description}` : '';
    lines.push(`  ${optionIndex + 1}. ${option.label}${description}`);
  }
  if (question.multiSelect) lines.push('  （可多选，回复编号用逗号分隔）');
  return lines.join('\n');
}

export function approvalCard({ id, toolName, title, description, inputPreview, timeoutSeconds = 120 }) {
  const elements = [
    div(`工具：${toolName}`),
    div(title || description || 'Qoder Agent 请求执行该工具。'),
  ];
  if (inputPreview) elements.push(div(`输入预览：\n${inputPreview}`));
  elements.push({
    tag: 'action',
    actions: [
      button('允许一次', { kind: 'approval', id, decision: 'allow_once' }, 'primary'),
      button('本会话允许', { kind: 'approval', id, decision: 'allow_session' }),
      button('拒绝', { kind: 'approval', id, decision: 'deny' }, 'danger'),
    ],
  });
  elements.push(note(`只有发起人可以操作；${Math.round(timeoutSeconds / 60)} 分钟内未处理将自动拒绝。`));
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: plain(`工具审批：${toolName}`) },
    elements,
  };
}

export function approvalText({ toolName, title, description, inputPreview }) {
  const lines = [
    `工具审批：${toolName}`,
    title || description || 'Qoder Agent 请求执行该工具。',
  ];
  if (inputPreview) lines.push(`输入预览：\n${inputPreview}`);
  lines.push('', '回复：1 允许一次 / 2 本会话允许 / 3 拒绝');
  return lines.join('\n');
}

export function questionCard({ id, questions, timeoutSeconds = 120 }) {
  const elements = [];
  for (const [index, question] of questions.entries()) {
    elements.push(div(questionLine(question, index)));
    const options = Array.isArray(question.options) ? question.options : [];
    if (!question.multiSelect && options.length) {
      elements.push({
        tag: 'action',
        actions: options.map((option) =>
          button(option.label, {
            kind: 'question',
            id,
            questionIndex: index,
            answer: option.label,
          }),
        ),
      });
    }
  }
  elements.push(note(`只有发起人可以回答；自定义答案可直接回复文本。${Math.round(timeoutSeconds / 60)} 分钟内未处理将自动取消。`));
  return {
    config: { wide_screen_mode: true },
    header: { template: 'turquoise', title: plain('需要你确认') },
    elements,
  };
}

export function questionText({ questions }) {
  const lines = ['请回答以下问题：'];
  for (const [index, question] of questions.entries()) {
    lines.push('', questionLine(question, index));
  }
  if (questions.length > 1) {
    lines.push('', '多个问题请按 “1=A; 2=B” 的格式回复；也可以只回复第一个问题的答案。');
  } else {
    lines.push('', '回复选项编号或直接回复自定义文本。');
  }
  return lines.join('\n');
}

export function fullAccessCard({ id, ttlMinutes = 30 }) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'red', title: plain('开启完全访问') },
    elements: [
      div(
        [
          '完全访问（bypassPermissions）会让 Qoder Agent 跳过审批，直接执行命令、修改文件。',
          `本次开启 ${ttlMinutes} 分钟后自动回退到 plan 模式。`,
          '只建议在你信任当前群和当前任务时开启。',
        ].join('\n'),
      ),
      {
        tag: 'action',
        actions: [
          button('确认开启', { kind: 'full_access', id, decision: 'confirm' }, 'danger'),
          button('取消', { kind: 'full_access', id, decision: 'cancel' }),
        ],
      },
      note('只有发起人可以操作；超时自动取消。'),
    ],
  };
}

export function fullAccessText({ ttlMinutes = 30 }) {
  return [
    '确认开启完全访问（bypassPermissions）？',
    `Agent 将跳过审批，直接执行命令、修改文件；${ttlMinutes} 分钟后自动回退到 plan。`,
    '回复：1 确认 / 2 取消',
  ].join('\n');
}

export function elicitationText({ request }) {
  const lines = [
    `MCP 服务「${request.serverName || 'unknown'}」请求输入：`,
    request.message || '',
  ];
  if (request.url) lines.push('', `链接：${request.url}`);
  if (request.requestedSchema) {
    lines.push('', '期望字段：', textContent(JSON.stringify(request.requestedSchema, null, 2)));
  }
  lines.push('', '直接回复文本即可；如需结构化输入，请回复 JSON。');
  return lines.filter(Boolean).join('\n');
}
