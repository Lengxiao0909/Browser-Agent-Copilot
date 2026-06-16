import { Injectable } from '@nestjs/common';
import type { LlmRuntimeConfig } from '@bac/shared';

interface DeepseekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DeepseekStreamChoice {
  delta?: {
    content?: string;
    reasoning_content?: string;
  };
  message?: {
    content?: string;
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
    return '模型认证失败，请检查 API Key 是否有效。';
  }

  try {
    const parsed = JSON.parse(body) as DeepseekStreamChunk;
    if (parsed.error) {
      return `模型请求失败：${status}`;
    }
  } catch {
    return `模型请求失败：${status}`;
  }
  return `模型请求失败：${status}`;
}

export interface DeepseekChatInput {
  messages: DeepseekMessage[];
  temperature?: number;
  llmConfig?: LlmRuntimeConfig;
}

interface ResolvedLlmConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

@Injectable()
export class DeepseekService {
  private readonly apiKey = process.env.DEEPSEEK_API_KEY;
  private readonly baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  private readonly model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

  private resolveConfig(config?: LlmRuntimeConfig): ResolvedLlmConfig {
    const baseUrl = config?.baseUrl?.trim() || this.baseUrl;
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error('模型服务 URL 需要以 http:// 或 https:// 开头。');
    }

    return {
      apiKey: config?.apiKey?.trim() || this.apiKey,
      baseUrl,
      model: config?.model?.trim() || this.model
    };
  }

  private createChatUrl(baseUrl: string) {
    return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  }

  async *streamChat(input: DeepseekChatInput): AsyncGenerator<string> {
    const config = this.resolveConfig(input.llmConfig);
    if (!config.apiKey) {
      throw new Error('当前模型缺少 API Key，请先完成模型配置。');
    }

    const response = await fetch(this.createChatUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
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

  async completeChat(input: DeepseekChatInput & { maxTokens?: number }) {
    const config = this.resolveConfig(input.llmConfig);
    if (!config.apiKey) {
      throw new Error('当前模型缺少 API Key，请先完成模型配置。');
    }

    const response = await fetch(this.createChatUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.1,
        max_tokens: input.maxTokens ?? 600,
        stream: false
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(parseDeepseekError(response.status, body));
    }

    const payload = (await response.json().catch(() => undefined)) as DeepseekStreamChunk | undefined;
    if (payload?.error) {
      throw new Error('模型响应暂时不可用，请稍后重试。');
    }

    return payload?.choices?.[0]?.message?.content?.trim() || '';
  }

  async testConfig(config: LlmRuntimeConfig) {
    const resolved = this.resolveConfig(config);
    if (!resolved.apiKey) {
      throw new Error('请填写 API Key。');
    }

    const response = await fetch(this.createChatUrl(resolved.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: resolved.model,
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 8,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error('模型连接测试失败，请检查 URL、API Key 和模型名称。');
    }

    return { ok: true };
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

      let chunk: DeepseekStreamChunk;
      try {
        chunk = JSON.parse(payload) as DeepseekStreamChunk;
      } catch {
        throw new Error('模型响应格式异常，请稍后重试。');
      }

      if (chunk.error) {
        throw new Error('模型响应暂时不可用，请稍后重试。');
      }

      const delta = chunk.choices?.[0]?.delta;
      emit(delta?.content || '');
    }

    return rest;
  }
}
