import { describe, expect, it } from 'vitest';
import { isValidModel, getModelTargetFormat, getModelSupportedFormats } from '../../open-sse/config/providerModels.js';
import { getCapabilitiesForModel } from '../../open-sse/providers/capabilities.js';
import { getPricingForModel, calculateCostFromTokens } from '../../open-sse/providers/pricing.js';
import { applyThinking } from '../../open-sse/translator/concerns/thinkingUnified.js';
import { normalizeClaudePassthrough } from '../../open-sse/translator/formats/claude.js';

describe('Claude Haiku 5.5', () => {
  it('registers direct Claude and the Go messages endpoint', () => {
    for (const provider of ['cc', 'anthropic', 'opencode-go']) expect(isValidModel(provider, 'claude-haiku-5-5')).toBe(true);
    expect(getModelTargetFormat('opencode-go', 'claude-haiku-5-5')).toBe('claude');
    expect(getModelSupportedFormats('opencode-go', 'claude-haiku-5-5')).toEqual(['claude']);
  });
  it('preserves adaptive thinking through native and translated requests', () => {
    expect(getCapabilitiesForModel('claude', 'claude-haiku-5-5')).toMatchObject({vision:true,thinkingFormat:'claude-adaptive',contextWindow:1000000,maxOutput:128000});
    const body={messages:[{role:'user',content:'hello'}],reasoning_effort:'low'};
    applyThinking('claude','claude-haiku-5-5',body,'claude');
    expect(body.thinking).toEqual({type:'adaptive'});
    expect(body.output_config).toEqual({effort:'low'});
    normalizeClaudePassthrough(body,'claude-haiku-5-5');
    expect(body.thinking).toEqual({type:'adaptive'});
    expect(body.output_config).toEqual({effort:'low'});
    const old={thinking:{type:'adaptive'},output_config:{effort:'low'}};
    normalizeClaudePassthrough(old,'claude-haiku-4-5-20251001');
    expect(old.thinking.type).toBe('enabled');
    expect(old.output_config).toBeUndefined();
  });
  it('uses the published price tier at the 100K boundary including cache tokens', () => {
    const price=getPricingForModel('opencode-go','claude-haiku-5-5');
    expect(calculateCostFromTokens({prompt_tokens:100000,completion_tokens:1000},price)).toBeCloseTo(0.0105);
    expect(calculateCostFromTokens({prompt_tokens:100001,completion_tokens:1000},price)).toBeCloseTo(0.0525005);
    expect(calculateCostFromTokens({prompt_tokens:100001,cached_tokens:100000,completion_tokens:1000},price)).toBeCloseTo(0.0075005);
  });
});
