/**
 * LLM Provider - Unified interface for cloud and local LLMs
 * 
 * This module provides a unified interface that can use either:
 * 1. OpenAI (requires internet, API key)
 * 2. Local Ollama instance (fully offline, free)
 * 
 * Automatically falls back between cloud and local based on availability
 */

import { logger } from './logger.js';
import {
  getLocalLLMConfig,
  checkLocalLLMAvailability,
  generateLocalCompletion,
  streamLocalCompletion,
  type LLMMessage,
  type LLMResponse,
} from './localLlm.js';

export interface CompletionOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

interface ProviderStatus {
  type: 'openai' | 'local' | 'none';
  available: boolean;
  message: string;
}

let cachedProviderStatus: ProviderStatus | null = null;
let statusCacheTime = 0;
const STATUS_CACHE_DURATION = 30000; // Cache for 30 seconds

/**
 * Get the current LLM provider status
 * Checks availability and caches result for performance
 */
export async function getProviderStatus(): Promise<ProviderStatus> {
  const now = Date.now();

  // Return cached status if still valid
  if (cachedProviderStatus && now - statusCacheTime < STATUS_CACHE_DURATION) {
    return cachedProviderStatus;
  }

  // Check if cloud OpenAI is available
  if (process.env.OPENAI_API_KEY) {
    cachedProviderStatus = {
      type: 'openai',
      available: true,
      message: 'Using OpenAI (cloud)',
    };
    statusCacheTime = now;
    return cachedProviderStatus;
  }

  // Check if local LLM is configured and available
  const localConfig = getLocalLLMConfig();
  if (localConfig.enabled) {
    const isAvailable = await checkLocalLLMAvailability(localConfig.baseUrl);

    if (isAvailable) {
      cachedProviderStatus = {
        type: 'local',
        available: true,
        message: `Using local LLM: ${localConfig.model}`,
      };
      logger.info(cachedProviderStatus, 'Local LLM provider is available');
    } else {
      cachedProviderStatus = {
        type: 'local',
        available: false,
        message: `Local LLM configured but not available at ${localConfig.baseUrl}`,
      };
      logger.warn(cachedProviderStatus, 'Local LLM not reachable');
    }
  } else {
    cachedProviderStatus = {
      type: 'none',
      available: false,
      message: 'No LLM provider configured. Set OPENAI_API_KEY or LOCAL_LLM_ENABLED=true',
    };
    logger.warn(cachedProviderStatus, 'No LLM provider available');
  }

  statusCacheTime = now;
  return cachedProviderStatus;
}

/**
 * Generate a completion using the available provider
 * Falls back gracefully if provider is unavailable
 */
export async function generateCompletion(
  messages: LLMMessage[],
  options: CompletionOptions = {}
): Promise<LLMResponse> {
  const status = await getProviderStatus();

  if (!status.available) {
    throw new Error(`No LLM provider available: ${status.message}`);
  }

  if (status.type === 'local') {
    const localConfig = getLocalLLMConfig();
    try {
      return await generateLocalCompletion(messages, localConfig, options.systemPrompt);
    } catch (err) {
      logger.error({ err }, 'Local LLM completion failed');

      // Try fallback to OpenAI if available
      if (process.env.OPENAI_API_KEY) {
        logger.info('Falling back to OpenAI due to local LLM failure');
        return generateOpenAICompletion(messages, options);
      }

      throw new Error(`Local LLM failed and no fallback available: ${err}`);
    }
  }

  if (status.type === 'openai') {
    return generateOpenAICompletion(messages, options);
  }

  throw new Error(status.message);
}

/**
 * Stream completion from available provider
 */
export async function* streamCompletion(
  messages: LLMMessage[],
  options: CompletionOptions = {}
): AsyncGenerator<string> {
  const status = await getProviderStatus();

  if (!status.available) {
    throw new Error(`No LLM provider available: ${status.message}`);
  }

  if (status.type === 'local') {
    const localConfig = getLocalLLMConfig();
    try {
      yield* streamLocalCompletion(messages, localConfig, options.systemPrompt);
      return;
    } catch (err) {
      logger.error({ err }, 'Local LLM streaming failed');

      if (process.env.OPENAI_API_KEY) {
        logger.info('Falling back to OpenAI due to local LLM failure');
        yield* streamOpenAICompletion(messages, options);
        return;
      }

      throw new Error(`Local LLM failed and no fallback available: ${err}`);
    }
  }

  if (status.type === 'openai') {
    yield* streamOpenAICompletion(messages, options);
    return;
  }

  throw new Error(status.message);
}

/**
 * OpenAI completion (cloud-based)
 */
async function generateOpenAICompletion(
  messages: LLMMessage[],
  options: CompletionOptions
): Promise<LLMResponse> {
  try {
    const { openai } = await import('@workspace/integrations-openai-ai-server');

    if (!openai) {
      throw new Error('OpenAI client not initialized');
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages as Parameters<typeof openai.chat.completions.create>[0]['messages'],
      system: options.systemPrompt,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens,
    });

    return {
      content: response.choices[0]?.message?.content || '',
      model: response.model,
      tokensUsed: response.usage?.total_tokens || 0,
      isLocal: false,
    };
  } catch (err) {
    logger.error({ err }, 'OpenAI completion failed');
    throw new Error(`OpenAI API call failed: ${err}`);
  }
}

/**
 * OpenAI streaming (cloud-based)
 */
async function* streamOpenAICompletion(
  messages: LLMMessage[],
  options: CompletionOptions
): AsyncGenerator<string> {
  try {
    const { openai } = await import('@workspace/integrations-openai-ai-server');

    if (!openai) {
      throw new Error('OpenAI client not initialized');
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages as Parameters<typeof openai.chat.completions.create>[0]['messages'],
      system: options.systemPrompt,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens,
      stream: true,
    });

    for await (const chunk of response) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  } catch (err) {
    logger.error({ err }, 'OpenAI streaming failed');
    throw new Error(`OpenAI streaming failed: ${err}`);
  }
}

/**
 * Get recommended configuration help text
 */
export function getSetupHelp(): string {
  return `
# LLM Provider Setup Guide

## Option 1: Cloud (OpenAI) - Recommended for production
1. Get API key from https://platform.openai.com/api-keys
2. Set environment variable: OPENAI_API_KEY=your-key-here
3. Restart the application
4. AI features will use cloud OpenAI (requires internet)

## Option 2: Local (Ollama) - Fully offline, free
1. Install Ollama: https://ollama.ai
2. Run: ollama serve (starts local server on port 11434)
3. Download a model: ollama pull mistral
4. Set environment variables:
   - LOCAL_LLM_ENABLED=true
   - LOCAL_LLM_BASE_URL=http://localhost:11434
   - LOCAL_LLM_MODEL=mistral
5. Restart the application
6. AI features will use local model (no internet needed)

## Recommended Models (by RAM usage)
- mistral (4GB) - Fast, good quality
- neural-chat (4GB) - Fast, good quality
- llama2 (7GB) - Better quality, slower
- nous-hermes (4GB) - Excellent quality, medium speed

## Fallback Behavior
- If configured for local but it's unavailable, system tries OpenAI
- If both unavailable, AI features return error
- Provider status is cached for 30 seconds to avoid repeated checks
`;
}
