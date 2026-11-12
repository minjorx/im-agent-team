#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export function resolveQoderBin() {
  if (process.env.QODER_BIN) return { command: process.env.QODER_BIN, shell: false };
  const dir = join(homedir(), '.qoder', 'bin', 'qodercli');
  if (existsSync(dir)) {
    const exe = readdirSync(dir)
      .filter((name) => /^qodercli-.+\.exe$/i.test(name))
      .sort()
      .pop();
    if (exe) return { command: join(dir, exe), shell: false };
  }
  const cmd = join(homedir(), '.qoder', 'entry', 'qoder.cmd');
  if (existsSync(cmd)) return { command: cmd, shell: true };
  return { command: process.platform === 'win32' ? 'qoder.cmd' : 'qoder', shell: true };
}

export function parseQoderOutput(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && 'result' in parsed) {
        return {
          text: String(parsed.result ?? ''),
          sessionId: parsed.session_id || parsed.sessionId,
          error: parsed.is_error === true || parsed.subtype === 'error',
          raw: parsed,
        };
      }
    } catch {
      // keep looking for a JSON result line
    }
  }
  return { text: String(stdout || '').trim(), sessionId: undefined, error: false, raw: undefined };
}

export async function runQoderCli({
  prompt,
  cwd,
  sessionId,
  model,
  permissionMode = 'plan',
  maxTurns = 8,
  timeoutMs = 180_000,
}) {
  if (process.env.QODER_MOCK === '1') {
    return {
      text: `[mock] ${prompt.slice(-160)}`,
      sessionId: sessionId || 'mock-session',
      error: false,
    };
  }

  const { command, shell } = resolveQoderBin();
  const args = ['-p', '--output-format', 'json', '--cwd', cwd, '--max-turns', String(maxTurns)];
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({ text: '', sessionId, error: true, errorMessage: `qoder timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({ text: '', sessionId, error: true, errorMessage: error.message });
    });
    child.on('close', (code) => {
      const parsed = parseQoderOutput(stdout);
      if (code !== 0 && !parsed.text) {
        finish({
          text: '',
          sessionId,
          error: true,
          errorMessage: (stderr || stdout || `qoder exited ${code}`).slice(-800),
        });
        return;
      }
      finish({
        ...parsed,
        error: parsed.error || code !== 0,
        errorMessage: parsed.error ? stderr.slice(-800) : undefined,
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
