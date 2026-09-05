import { describe, expect, it } from 'vitest';
import {
  GenaiIntentInterpreter,
  StubIntentInterpreter,
  intentSchema,
} from '../src/ai/intentInterpreter';

describe('IntentInterpreter (RED: stub + zod + timeout fallback)', () => {
  it('validates the intent JSON contract via zod', () => {
    const parsed = intentSchema.safeParse({ name: 'OPEN_SEARCH', params: {} });
    expect(parsed.success).toBe(true);
    expect(intentSchema.safeParse({ name: 'HACK_THE_PLANET', params: {} }).success).toBe(false);
  });

  it('stub maps Buscar NL to OPEN_SEARCH and counts calls', async () => {
    const stub = new StubIntentInterpreter();
    const intent = await stub.interpret('quiero buscar un cliente', { userId: 111 });
    expect(intent.name).toBe('OPEN_SEARCH');
    expect(stub.calls).toBe(1);
  });

  it('stub maps "mejor hazlo 2 meses" to a correction with months=2', async () => {
    const stub = new StubIntentInterpreter();
    const intent = await stub.interpret('mejor hazlo 2 meses', { userId: 111 });
    expect(intent.name).toBe('CORRECTION');
    expect(intent.params).toMatchObject({ months: 2 });
  });

  it('falls back to UNKNOWN on invalid model JSON instead of throwing', async () => {
    const interpreter = new GenaiIntentInterpreter({
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      generate: async () => 'not-json{{{',
    });
    const intent = await interpreter.interpret('hola', { userId: 111 });
    expect(intent.name).toBe('UNKNOWN');
  });

  it('falls back to UNKNOWN on model timeout instead of hanging', async () => {
    const interpreter = new GenaiIntentInterpreter({
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      timeoutMs: 20,
      generate: () => new Promise<string>(() => {}),
    });
    const intent = await interpreter.interpret('hola', { userId: 111 });
    expect(intent.name).toBe('UNKNOWN');
  });
});
