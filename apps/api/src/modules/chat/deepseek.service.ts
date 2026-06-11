import { Injectable } from '@nestjs/common';

interface DeepseekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DeepseekStreamChoice {
  delta?: {
    content?: string;
    reasoning_content?: string;
  };
  finish_reason?: string | null;
}

interface DeepseekStreamChunk {
  choices?: DeepseekStreamChoice[];
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

function parseDeepseekError(status: number, body: string) {
  if (status === 401 || /api key|authentication|unauthorized/i.test(body)) {
    return 'DeepSeek 认证失败，请检查 DEEPSEEK_API_KEY 是否有效。';
  }

  try {
    const parsed = JSON.parse(body) as DeepseekStreamChunk;
    return parsed.error?.message || `DeepSeek 请求失败：${status}`;
  } catch {
    return `DeepSeek 请求失败：${status} ${body.slice(0, 160)}`;
  }
}

export interface DeepseekChatInput {
  messages: DeepseekMessage[];
  temperature?: number;
}

@Injectable()
export class DeepseekService {
  private readonly apiKey = process.env.DEEPSEEK_API_KEY;
  private readonly baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  private readonly model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

  async *streamChat(input: DeepseekChatInput): AsyncGenerator<string> {
    if (!this.apiKey) {
      throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中配置 DeepSeek API key。');
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.3,
        stream: true
      })
    });

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw new Error(parseDeepseekError(response.status, body));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    const pending: string[] = [];

    while (!done) {
      const result = await reader.read();
      done = result.done;
      buffer += decoder.decode(result.value, { stream: !done });
      buffer = this.consumeSseFrames(buffer, (content) => {
        if (content) {
          pending.push(content);
        }
      });

      while (pending.length) {
        yield pending.shift() as string;
      }
    }

    if (buffer.trim()) {
      this.consumeSseFrames(`${buffer}\n\n`, (content) => {
        if (content) {
          pending.push(content);
        }
      });
    }

    while (pending.length) {
      yield pending.shift() as string;
    }
  }

  private consumeSseFrames(buffer: string, emit: (content: string) => void) {
    const frames = buffer.replace(/\r\n/g, '\n').split('\n\n');
    const rest = frames.pop() ?? '';

    for (const frame of frames) {
      const payload = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.replace(/^data:\s?/, ''))
        .join('\n')
        .trim();

      if (!payload || payload === '[DONE]') continue;

      const chunk = JSON.parse(payload) as DeepseekStreamChunk;
      if (chunk.error) {
        throw new Error(chunk.error.message || chunk.error.code || 'DeepSeek 流式响应返回错误。');
      }

      const delta = chunk.choices?.[0]?.delta;
      emit(delta?.content || '');
    }

    return rest;
  }
}
