const FOOTER_START = '\n—\n';

export function escapeText(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildFooter({ trace, hop = 0, kind = 'task', taskId, deadline }) {
  const parts = [`trace: ${trace}`, `hop: ${hop}`, `kind: ${kind}`];
  if (taskId) parts.push(`task: ${taskId}`);
  if (deadline) parts.push(`deadline: ${deadline}`);
  return parts.join(' · ');
}

const FOOTER_KEYS = new Set(['trace', 'hop', 'kind', 'task', 'taskId', 'deadline']);

export function parseFooter(text) {
  const source = String(text ?? '');
  const index = source.lastIndexOf(FOOTER_START);
  if (index < 0) return { clean: source.trim(), envelope: undefined };
  const footer = source.slice(index + FOOTER_START.length).trim();
  const fields = {};
  for (const part of footer.split('·')) {
    const match = /^\s*([A-Za-z][\w-]*)\s*:\s*(.+?)\s*$/.exec(part);
    if (!match) continue;
    const key = match[1];
    if (!FOOTER_KEYS.has(key)) continue;
    fields[key === 'taskId' ? 'task' : key] = match[2];
  }
  if (!fields.trace || !fields.kind) return { clean: source.trim(), envelope: undefined };
  return {
    clean: source.slice(0, index).trim(),
    envelope: {
      trace: fields.trace,
      hop: Number(fields.hop || 0),
      kind: fields.kind,
      taskId: fields.task,
      deadline: fields.deadline,
    },
  };
}

export function renderTaskBody({
  toName,
  taskId,
  step,
  goal,
  input,
  deliverable,
  constraints,
  upstream,
  footer,
}) {
  const lines = [];
  lines.push(`@${toName}`);
  lines.push(`【任务 ${taskId}${step ? ` / 步骤 ${step}` : ''}】`);
  lines.push(`目标：${goal}`);
  if (input) lines.push(`输入：${input}`);
  if (deliverable) lines.push(`交付：${deliverable}`);
  if (constraints) lines.push(`约束：${constraints}`);
  if (upstream) lines.push(`上游：${upstream}`);
  lines.push('—');
  lines.push(footer);
  return lines.join('\n');
}

export function renderResultBody({
  toName,
  taskId,
  status,
  summary,
  artifacts,
  footer,
}) {
  const lines = [];
  if (toName) lines.push(`@${toName}`);
  lines.push(`【交付 ${taskId}】`);
  lines.push(`状态：${status}`);
  lines.push(summary);
  if (artifacts?.length) lines.push(`产物：${artifacts.join('、')}`);
  lines.push('—');
  lines.push(footer);
  return lines.join('\n');
}

export function renderPost({ title = '', segments }) {
  const content = segments.map((segment) => {
    if (segment.type === 'at') {
      return { tag: 'at', user_id: segment.openId, user_name: segment.name || '' };
    }
    if (segment.type === 'link') {
      return { tag: 'a', text: segment.text, href: segment.href };
    }
    return { tag: 'text', text: segment.text ?? '' };
  });
  return JSON.stringify({
    zh_cn: {
      title,
      content: [content],
    },
  });
}

/** Build a post payload that starts with a real Feishu @ mention. */
export function renderMentionPost({ openId, name, text, title }) {
  return renderPost({
    title,
    segments: [
      { type: 'at', openId, name },
      { type: 'text', text },
    ],
  });
}

export function flattenPost(content) {
  let parsed;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const candidates = [
    parsed.zh_cn,
    parsed.en_us,
    parsed.ja_jp,
    parsed,
    ...Object.values(parsed),
  ];
  const locale = candidates.find((value) => value && typeof value === 'object' && Array.isArray(value.content));
  if (!locale) return '';
  const parts = [];
  if (locale.title) parts.push(String(locale.title));
  for (const row of locale.content || []) {
    const line = (Array.isArray(row) ? row : [row])
      .map((element) => {
        if (!element || typeof element !== 'object') return '';
        switch (element.tag) {
          case 'text':
            return element.text || '';
          case 'at':
            return `@${element.user_name || element.user_id || ''}`;
          case 'a':
            return element.text || element.href || '';
          case 'img':
            return '[图片]';
          case 'media':
            return '[媒体]';
          case 'emotion':
            return '[表情]';
          case 'code_block':
            return `\n\`\`\`\n${element.text || ''}\n\`\`\`\n`;
          case 'hr':
            return '\n---\n';
          default:
            return element.text || '';
        }
      })
      .join('');
    parts.push(line);
  }
  return parts.join('\n').trim();
}

export function extractMessageText(message) {
  const raw = message?.content;
  if (!raw) return '';
  if (message.message_type === 'post') return flattenPost(raw);
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof parsed?.text === 'string') return parsed.text;
    if (parsed?.content) return flattenPost(parsed);
    return '';
  } catch {
    return String(raw);
  }
}

export function splitText(text, maxChars) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  if (source.length <= maxChars) return [source];
  const chunks = [];
  let rest = source;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.6)) {
      cut = rest.lastIndexOf('。', maxChars);
      if (cut >= 0) cut += 1;
    }
    if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.map((chunk, index) => (chunks.length > 1 ? `(${index + 1}/${chunks.length}) ${chunk}` : chunk));
}

export function stripOwnMention(text, self) {
  const source = String(text ?? '').trim();
  if (!self?.name) return source;
  const prefix = `@${self.name}`;
  return source.startsWith(prefix) ? source.slice(prefix.length).trim() : source;
}
