import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  LlmConfigTestResponse,
  LlmRuntimeConfig,
  SavedLlmModelConfig,
  SaveLlmModelConfigRequest
} from '@bac/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { DeepseekService } from '../chat/deepseek.service.js';

type PersistedLlmModel = {
  id: string;
  clientId: string | null;
  displayName: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  createdAt: Date;
  updatedAt: Date;
};

function toIsoString(value: Date) {
  return value.toISOString();
}

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toPublicModel(model: PersistedLlmModel, persisted = true): SavedLlmModelConfig {
  return {
    id: model.id,
    clientId: model.clientId || undefined,
    displayName: model.displayName,
    providerName: model.providerName,
    baseUrl: model.baseUrl,
    model: model.model,
    hasApiKey: Boolean(model.apiKey),
    persisted,
    createdAt: toIsoString(model.createdAt),
    updatedAt: toIsoString(model.updatedAt)
  };
}

function toFallbackModel(input: ReturnType<typeof normalizeInput>, id?: string): SavedLlmModelConfig {
  const now = new Date().toISOString();
  return {
    id: id || createId('llm_local'),
    clientId: input.clientId,
    displayName: input.displayName,
    providerName: input.providerName,
    baseUrl: input.baseUrl,
    model: input.model,
    hasApiKey: Boolean(input.apiKey),
    persisted: false,
    createdAt: now,
    updatedAt: now
  };
}

function assertHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeInput(input: SaveLlmModelConfigRequest, options?: { allowMissingApiKey?: boolean }) {
  const next = {
    clientId: input.clientId?.trim() || undefined,
    displayName: input.displayName?.trim(),
    providerName: input.providerName?.trim(),
    baseUrl: input.baseUrl?.trim(),
    apiKey: input.apiKey?.trim(),
    model: input.model?.trim()
  };

  if (!next.displayName || !next.providerName || !next.baseUrl || !next.model) {
    throw new BadRequestException('请完整填写模型名称、厂商、URL 和模型。');
  }
  if (!options?.allowMissingApiKey && !next.apiKey) {
    throw new BadRequestException('请填写 API Key。');
  }
  if (!assertHttpUrl(next.baseUrl)) {
    throw new BadRequestException('模型服务 URL 需要以 http:// 或 https:// 开头。');
  }

  return next;
}

function isPersistenceUnavailable(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return code.startsWith('P10') || /Can't reach database|Authentication failed|connect/i.test(message);
}

@Injectable()
export class LlmModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deepseekService: DeepseekService
  ) {}

  async listModels(clientId?: string): Promise<SavedLlmModelConfig[]> {
    try {
      const models = await this.prisma.llmModelConfig.findMany({
        where: clientId ? { clientId } : undefined,
        orderBy: { updatedAt: 'desc' }
      });
      return models.map((model) => toPublicModel(model));
    } catch (error) {
      console.warn('[Browser Agent Copilot] LLM model persistence is unavailable; returning empty list.', error);
      return [];
    }
  }

  async createModel(input: SaveLlmModelConfigRequest): Promise<SavedLlmModelConfig> {
    const next = normalizeInput(input);
    try {
      const model = await this.prisma.llmModelConfig.create({
        data: {
          clientId: next.clientId,
          displayName: next.displayName,
          providerName: next.providerName,
          baseUrl: next.baseUrl,
          apiKey: next.apiKey || '',
          model: next.model
        }
      });
      return toPublicModel(model);
    } catch (error) {
      console.warn('[Browser Agent Copilot] LLM model create persistence is unavailable; using local fallback.', error);
      return toFallbackModel(next);
    }
  }

  async updateModel(id: string, input: SaveLlmModelConfigRequest): Promise<SavedLlmModelConfig> {
    const next = normalizeInput(input, { allowMissingApiKey: true });
    try {
      const existing = await this.findModelRecord(id, input.clientId);
      const model = await this.prisma.llmModelConfig.update({
        where: { id: existing.id },
        data: {
          clientId: next.clientId || existing.clientId,
          displayName: next.displayName,
          providerName: next.providerName,
          baseUrl: next.baseUrl,
          apiKey: next.apiKey || existing.apiKey,
          model: next.model
        }
      });
      return toPublicModel(model);
    } catch (error) {
      console.warn('[Browser Agent Copilot] LLM model update persistence is unavailable; using local fallback.', error);
      return toFallbackModel(next, id);
    }
  }

  async deleteModel(id: string, clientId?: string) {
    const existing = await this.findModelRecord(id, clientId);
    await this.prisma.llmModelConfig.delete({ where: { id: existing.id } });
    return { ok: true };
  }

  async resolveRuntimeConfig(id?: string, clientId?: string): Promise<LlmRuntimeConfig | undefined> {
    if (!id) return undefined;
    const model = await this.findModelRecord(id, clientId);
    return {
      displayName: model.displayName,
      providerName: model.providerName,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      model: model.model
    };
  }

  async testSavedModel(id: string, clientId?: string): Promise<LlmConfigTestResponse> {
    try {
      const config = await this.resolveRuntimeConfig(id, clientId);
      await this.deepseekService.testConfig(config || {});
      return { ok: true, message: '连接测试成功。' };
    } catch (error) {
      if (error instanceof NotFoundException) {
        return { ok: false, message: '未找到该模型配置。' };
      }
      return { ok: false, message: '模型连接测试失败，请检查 URL、API Key 和模型名称。' };
    }
  }

  private async findModelRecord(id: string, clientId?: string): Promise<PersistedLlmModel> {
    try {
      const model = await this.prisma.llmModelConfig.findFirst({
        where: {
          id,
          ...(clientId ? { clientId } : {})
        }
      });
      if (!model) {
        throw new NotFoundException('LLM model config not found.');
      }
      return model;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (isPersistenceUnavailable(error)) {
        throw new NotFoundException('LLM model config not found.');
      }
      throw error;
    }
  }
}
