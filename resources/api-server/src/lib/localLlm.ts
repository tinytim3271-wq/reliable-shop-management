/**
 * Local LLM Provider
 * Supports running AI features offline using Ollama or other local LLM servers
 * Ollama: https://ollama.ai (recommended for Windows/Mac/Linux)
 * 
 * Setup:
 * 1. Install Ollama from https://ollama.ai
 * 2. Run: ollama pull mistral (or other model like llama2, neural-chat)
 * 3. Start Ollama: ollama serve (or it runs as a service)
 * 4. Set environment variables:
 *    - LOCAL_LLM_ENABLED=true
 *    - LOCAL_LLM_BASE_URL=http://localhost:11434
 *    - LOCAL_LLM_MODEL=mistral (or your chosen model)
 */

import { logger } from './logger.js';

export interface LocalLLMConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  timeout: number;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  tokensUsed: number;
  isLocal: boolean;
}

export interface LLMToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Get local LLM configuration from environment
 */
export function getLocalLLMConfig(): LocalLLMConfig {
  return {
    enabled: process.env.LOCAL_LLM_ENABLED === 'true',
    baseUrl: process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434',
    model: process.env.LOCAL_LLM_MODEL || 'mistral',
    timeout: parseInt(process.env.LOCAL_LLM_TIMEOUT || '300000', 10), // 5 min default
  };
}

/**
 * Check if local LLM server is available
 */
export async function checkLocalLLMAvailability(
  baseUrl: string,
  timeoutMs: number = 5000
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), baseUrl },
      'Local LLM server not available'
    );
    return false;
  }
}

/**
 * Generate a completion using local LLM (Ollama-compatible API)
 */
export async function generateLocalCompletion(
  messages: LLMMessage[],
  config: LocalLLMConfig,
  systemPrompt?: string
): Promise<LLMResponse> {
  const url = `${config.baseUrl}/api/chat`;

  // Prepend system prompt if provided
  const allMessages: LLMMessage[] = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: allMessages,
        stream: false,
        // Local models often benefit from these settings
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Local LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    return {
      content: data.message?.content || '',
      model: config.model,
      tokensUsed: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      isLocal: true,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Local LLM request timeout (>${config.timeout}ms)`);
    }
    throw err;
  }
}

/**
 * Stream completion from local LLM
 * Yields response chunks as they arrive
 */
export async function* streamLocalCompletion(
  messages: LLMMessage[],
  config: LocalLLMConfig,
  systemPrompt?: string
): AsyncGenerator<string> {
  const url = `${config.baseUrl}/api/chat`;

  const allMessages: LLMMessage[] = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: allMessages,
        stream: true,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Local LLM API error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body from local LLM');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const json = JSON.parse(line);
            if (json.message?.content) {
              yield json.message.content;
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const json = JSON.parse(buffer);
        if (json.message?.content) {
          yield json.message.content;
        }
      } catch {
        // Ignore
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Local LLM streaming timeout (>${config.timeout}ms)`);
    }
    throw err;
  }
}

/**
 * Extract JSON from LLM response
 * Useful for parsing structured outputs like tool calls
 */
export function extractJSON<T = unknown>(text: string): T | null {
  // Try to find JSON block in markdown code fence
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      // Fall through to direct parse
    }
  }

  // Try direct JSON parse
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse tool calls from LLM response (formatted as JSON)
 */
export function parseToolCalls(text: string): LLMToolCall[] {
  const jsonContent = extractJSON<unknown>(text);

  if (!jsonContent) {
    return [];
  }

  // Handle both array and object responses
  const calls = Array.isArray(jsonContent) ? jsonContent : [jsonContent];

  return calls
    .filter((call): call is LLMToolCall => {
      return (
        typeof call === 'object' &&
        call !== null &&
        'id' in call &&
        'function' in call &&
        typeof call.function === 'object' &&
        call.function !== null &&
        'name' in call.function &&
        'arguments' in call.function
      );
    });
}

/**
 * Recommended models for offline use
 * Model sizes and requirements for reference
 */
export const RECOMMENDED_MODELS = {
  // Fast, lightweight, good for basic tasks (4GB RAM)
  mistral: {
    name: 'Mistral 7B',
    ramRequired: 8, // GB
    speed: 'fast',
    quality: 'good',
    pullCommand: 'ollama pull mistral',
  },
  // Balanced, good for general tasks (7GB RAM)
  'neural-chat': {
    name: 'Neural Chat 7B',
    ramRequired: 8,
    speed: 'fast',
    quality: 'good',
    pullCommand: 'ollama pull neural-chat',
  },
  // More capable but slower (13GB RAM)
  llama2: {
    name: 'Llama 2 13B',
    ramRequired: 16,
    speed: 'medium',
    quality: 'very-good',
    pullCommand: 'ollama pull llama2',
  },
  // Most capable but slowest (7GB+)
  'nous-hermes': {
    name: 'Nous Hermes 2 7B',
    ramRequired: 8,
    speed: 'medium',
    quality: 'excellent',
    pullCommand: 'ollama pull nous-hermes',
  },
} as const;
