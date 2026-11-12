import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  approvalCard,
  approvalText,
  elicitationText,
  fullAccessCard,
  fullAccessText,
  questionCard,
  questionText,
} from './cards.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;

function truncatePreview(value, max = 700) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function pickAnswer(question, raw) {
  const options = Array.isArray(question.options) ? question.options : [];
  const tokens = String(raw)
    .split(/[,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!tokens.length) tokens.push(String(raw).trim());
  const answers = [];
  for (const token of tokens) {
    const index = Number(token);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      answers.push(options[index - 1].label);
      continue;
    }
    const match = options.find(
      (option) => String(option.label).toLowerCase() === token.toLowerCase(),
    );
    answers.push(match ? match.label : token);
  }
  return question.multiSelect ? answers.join(', ') : answers[0];
}

export function parseQuestionAnswers(questions, text) {
  if (questions.length === 1) {
    const cleaned = String(text).replace(/^(?:Q)?1\s*[:=：]\s*/i, '').trim();
    return { [questions[0].question]: pickAnswer(questions[0], cleaned || text) };
  }

  const answers = {};
  const pairPattern = /(?:Q)?(\d+)\s*[:=：]\s*([^;；\n]+)/gi;
  let match;
  while ((match = pairPattern.exec(text))) {
    const question = questions[Number(match[1]) - 1];
    if (question) answers[question.question] = pickAnswer(question, match[2].trim());
  }
  if (Object.keys(answers).length === questions.length) return answers;

  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === questions.length) {
    for (const [index, question] of questions.entries()) {
      answers[question.question] = pickAnswer(question, lines[index]);
    }
    return answers;
  }
  return undefined;
}

export function createInteractionBroker({
  accountId,
  stateDir,
  sendText,
  sendCard,
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  const pending = new Map();
  const activeQueries = new Map();
  let sequence = 0;

  function audit(event) {
    try {
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(
        join(stateDir, 'audit.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), accountId, ...event })}\n`,
        'utf8',
      );
    } catch {
      // audit must never break the bot
    }
  }

  async function safeSend(chatId, text) {
    try {
      await sendText(chatId, text);
    } catch (error) {
      logger.error?.('[interaction] send text failed', error?.message || error);
    }
  }

  async function safeCard(chatId, card, fallbackText) {
    if (sendCard) {
      try {
        await sendCard(chatId, card);
        return;
      } catch (error) {
        logger.error?.('[interaction] send card failed', error?.message || error);
      }
    }
    await safeSend(chatId, fallbackText);
  }

  function settle(entry, action, payload, outcome) {
    if (pending.get(entry.chatId) !== entry) return false;
    pending.delete(entry.chatId);
    clearTimeout(entry.timer);
    audit({
      chatId: entry.chatId,
      userId: entry.userId,
      kind: entry.kind,
      action,
      ...entry.meta,
    });
    try {
      if (outcome === 'resolve') entry.onResolve(payload);
      else entry.onReject(payload);
    } catch (error) {
      logger.error?.('[interaction] settle failed', error?.message || error);
    }
    return true;
  }

  function createEntry({ chatId, userId, kind, timeout, meta, onResolve, onReject, onTimeout }) {
    const entry = {
      id: `ix_${Date.now()}_${(sequence += 1)}`,
      chatId,
      userId,
      kind,
      meta,
      onResolve,
      onReject,
      onTimeout,
      createdAt: now(),
    };
    entry.timer = setTimeout(() => {
      if (pending.get(chatId) !== entry) return;
      pending.delete(chatId);
      clearTimeout(entry.timer);
      audit({ chatId, userId, kind, action: 'timeout', ...meta });
      try {
        onTimeout();
      } catch {
        // ignore
      }
      void safeSend(chatId, '交互已超时，已自动取消。');
    }, timeout);
    pending.set(chatId, entry);
    return entry;
  }

  function askQuestions({ chatId, userId, input, questions, options }) {
    return new Promise((resolve) => {
      const entry = createEntry({
        chatId,
        userId,
        kind: 'question',
        timeout: timeoutMs,
        meta: { toolName: 'AskUserQuestion', questions: questions.map((q) => q.question) },
        onResolve: (answers) =>
          resolve({
            behavior: 'allow',
            updatedInput: { ...input, answers },
            toolUseID: options.toolUseID,
          }),
        onReject: (message) =>
          resolve({
            behavior: 'deny',
            message: message || '用户未回答问题。',
            toolUseID: options.toolUseID,
          }),
        onTimeout: () =>
          resolve({
            behavior: 'deny',
            message: '提问超时，用户未回答。',
            toolUseID: options.toolUseID,
          }),
      });
      entry.questions = questions;
      entry.answers = {};
      void safeCard(
        chatId,
        questionCard({ id: entry.id, questions, timeoutSeconds: Math.round(timeoutMs / 1000) }),
        questionText({ questions }),
      );
    });
  }

  function approveTool({ chatId, userId, toolName, input, options }) {
    const title = options.title || options.displayName || '';
    const description = options.description || '';
    const inputPreview = truncatePreview(JSON.stringify(input, null, 2));
    return new Promise((resolve) => {
      const entry = createEntry({
        chatId,
        userId,
        kind: 'approval',
        timeout: timeoutMs,
        meta: { toolName, title },
        onResolve: (decision) =>
          resolve({
            behavior: 'allow',
            permissionScope: decision === 'allow_session' ? 'session' : 'once',
            toolUseID: options.toolUseID,
          }),
        onReject: (message) =>
          resolve({
            behavior: 'deny',
            message: message || '用户在飞书中拒绝了该操作。',
            toolUseID: options.toolUseID,
          }),
        onTimeout: () =>
          resolve({ behavior: 'deny', message: '审批超时，已拒绝。', toolUseID: options.toolUseID }),
      });
      void safeCard(
        chatId,
        approvalCard({
          id: entry.id,
          toolName,
          title,
          description,
          inputPreview,
          timeoutSeconds: Math.round(timeoutMs / 1000),
        }),
        approvalText({ toolName, title, description, inputPreview }),
      );
    });
  }

  function canUseTool({ chatId, userId }) {
    return async (toolName, input, options = {}) => {
      if (pending.has(chatId)) {
        return { behavior: 'deny', message: '当前会话已有待处理的审批或提问，请先完成它。' };
      }
      if (toolName === 'AskUserQuestion') {
        const questions = options?.details?.questions || input?.questions || [];
        if (!Array.isArray(questions) || !questions.length) {
          return { behavior: 'allow', updatedInput: input };
        }
        return askQuestions({ chatId, userId, input, questions, options });
      }
      return approveTool({ chatId, userId, toolName, input, options });
    };
  }

  function onElicitation({ chatId, userId }) {
    return async (request) =>
      new Promise((resolve) => {
        if (pending.has(chatId)) {
          resolve({ action: 'cancel' });
          return;
        }
        createEntry({
          chatId,
          userId,
          kind: 'elicitation',
          timeout: timeoutMs,
          meta: { serverName: request.serverName },
          onResolve: (content) => resolve({ action: 'accept', content }),
          onReject: () => resolve({ action: 'cancel' }),
          onTimeout: () => resolve({ action: 'cancel' }),
        });
        void safeSend(chatId, elicitationText({ request }));
      });
  }

  function requestFullAccess({ chatId, userId, ttlMinutes = 30 }) {
    return new Promise((resolve) => {
      if (pending.has(chatId)) {
        void safeSend(chatId, '当前已有待处理交互，请先完成它。');
        resolve(false);
        return;
      }
      const entry = createEntry({
        chatId,
        userId,
        kind: 'full_access',
        timeout: timeoutMs,
        meta: { ttlMinutes },
        onResolve: () => resolve(true),
        onReject: () => resolve(false),
        onTimeout: () => resolve(false),
      });
      void safeCard(
        chatId,
        fullAccessCard({ id: entry.id, ttlMinutes }),
        fullAccessText({ ttlMinutes }),
      );
    });
  }

  function handleText({ chatId, userId, text }) {
    const entry = pending.get(chatId);
    if (!entry) return false;
    if (entry.userId && userId && entry.userId !== userId) {
      void safeSend(chatId, '只有发起人可以处理这个审批/问题。');
      return true;
    }
    const normalized = String(text || '').trim();

    if (entry.kind === 'approval') {
      if (/^(1|allow|允许|同意|yes|y)$/i.test(normalized)) {
        settle(entry, 'allow_once', 'allow_once', 'resolve');
        void safeSend(chatId, '已允许一次。');
      } else if (/^(2|session|本会话|总是|always)$/i.test(normalized)) {
        settle(entry, 'allow_session', 'allow_session', 'resolve');
        void safeSend(chatId, '已允许（本会话）。');
      } else if (/^(3|deny|拒绝|取消|no|n)$/i.test(normalized)) {
        settle(entry, 'deny', '用户在飞书中拒绝了该操作。', 'reject');
        void safeSend(chatId, '已拒绝。');
      } else {
        void safeSend(chatId, '请回复 1 允许一次 / 2 本会话允许 / 3 拒绝。');
      }
      return true;
    }

    if (entry.kind === 'question') {
      const answers = parseQuestionAnswers(entry.questions, normalized);
      if (!answers) {
        void safeSend(chatId, '未能解析答案。多个问题请按 “1=A; 2=B” 的格式回复。');
        return true;
      }
      settle(entry, 'answer', answers, 'resolve');
      void safeSend(
        chatId,
        `已收到答案：${Object.entries(answers)
          .map(([question, answer]) => `${question}=${answer}`)
          .join('；')}`,
      );
      return true;
    }

    if (entry.kind === 'full_access') {
      if (/^(1|确认|yes|y|confirm)$/i.test(normalized)) {
        settle(entry, 'confirm', undefined, 'resolve');
        void safeSend(chatId, '已确认。');
      } else if (/^(2|取消|no|n|cancel)$/i.test(normalized)) {
        settle(entry, 'cancel', undefined, 'reject');
        void safeSend(chatId, '已取消。');
      } else {
        void safeSend(chatId, '请回复 1 确认 / 2 取消。');
      }
      return true;
    }

    if (entry.kind === 'elicitation') {
      let content;
      try {
        content = JSON.parse(normalized);
      } catch {
        content = { response: normalized };
      }
      settle(entry, 'accept', content, 'resolve');
      void safeSend(chatId, '已提交输入。');
      return true;
    }

    return false;
  }

  function handleCardAction({ chatId, userId, value }) {
    if (!chatId || !value?.id) return { ok: false };
    const entry = pending.get(chatId);
    if (!entry || entry.id !== value.id) return { ok: false, toast: '该操作已失效' };
    if (entry.userId && userId && entry.userId !== userId) {
      void safeSend(chatId, '只有发起人可以操作。');
      return { ok: false, toast: '仅发起人可操作' };
    }

    if (value.kind === 'approval') {
      if (value.decision === 'deny') {
        settle(entry, 'deny', '用户在飞书中拒绝了该操作。', 'reject');
        void safeSend(chatId, '已拒绝。');
      } else if (value.decision === 'allow_session') {
        settle(entry, 'allow_session', 'allow_session', 'resolve');
        void safeSend(chatId, '已允许（本会话）。');
      } else {
        settle(entry, 'allow_once', 'allow_once', 'resolve');
        void safeSend(chatId, '已允许一次。');
      }
      return { ok: true, toast: '已处理' };
    }

    if (value.kind === 'question') {
      const question = entry.questions?.[value.questionIndex];
      if (!question) return { ok: false, toast: '问题已失效' };
      if (question.multiSelect) {
        void safeSend(chatId, '该问题需要多选，请直接回复编号，用逗号分隔。');
        return { ok: false, toast: '请回复文本' };
      }
      entry.answers[question.question] = value.answer;
      const remaining = entry.questions.filter((item) => !(item.question in entry.answers));
      if (remaining.length) {
        void safeSend(
          chatId,
          `已记录。还需回答：${remaining
            .map((item, index) => `${index + 1}. ${item.question}`)
            .join(' ')}`,
        );
        return { ok: true, toast: '已记录' };
      }
      settle(entry, 'answer', { ...entry.answers }, 'resolve');
      void safeSend(
        chatId,
        `已收到答案：${Object.entries(entry.answers)
          .map(([questionText, answer]) => `${questionText}=${answer}`)
          .join('；')}`,
      );
      return { ok: true, toast: '已提交' };
    }

    if (value.kind === 'full_access') {
      if (value.decision === 'confirm') {
        settle(entry, 'confirm', undefined, 'resolve');
        void safeSend(chatId, '已确认开启完全访问。');
      } else {
        settle(entry, 'cancel', undefined, 'reject');
        void safeSend(chatId, '已取消。');
      }
      return { ok: true, toast: '已处理' };
    }

    return { ok: false };
  }

  async function interrupt(chatId) {
    const q = activeQueries.get(chatId);
    if (!q) return false;
    try {
      await q.interrupt();
      return true;
    } catch {
      return false;
    }
  }

  function setActiveQuery(chatId, q) {
    activeQueries.set(chatId, q);
  }

  function clearActiveQuery(chatId) {
    activeQueries.delete(chatId);
  }

  function cancelPending(chatId, message = '任务已结束。') {
    const entry = pending.get(chatId);
    if (!entry) return false;
    return settle(entry, 'cancel', message, 'reject');
  }

  async function cancelChat(chatId) {
    const canceled = cancelPending(chatId, '用户中断了任务。');
    const interrupted = await interrupt(chatId);
    return canceled || interrupted;
  }

  function cancelAll() {
    for (const entry of [...pending.values()]) {
      settle(entry, 'cancel', '会话已停止。', 'reject');
    }
    for (const q of activeQueries.values()) {
      try {
        void q.interrupt();
      } catch {
        // ignore
      }
    }
    activeQueries.clear();
  }

  return {
    canUseTool,
    onElicitation,
    requestFullAccess,
    handleText,
    handleCardAction,
    interrupt,
    cancelChat,
    cancelPending,
    setActiveQuery,
    clearActiveQuery,
    cancelAll,
    pendingCount: () => pending.size,
    record: audit,
  };
}
