import { describe, expect, it } from 'vitest';
import { StubIntentInterpreter } from '../src/ai/intentInterpreter';
import { route } from '../src/router/hybrid';
import { callbackData } from '../src/telegram/keyboards';

describe('hybrid router cascade (RED: L1/L2 must not call Gemini)', () => {
  it('routes L1 exact callbacks with zero Gemini calls', async () => {
    const stub = new StubIntentInterpreter();
    const decision = await route({ userId: 111, callbackData: callbackData('buscar') }, stub);
    expect(decision).toEqual({ layer: 'L1', action: 'buscar' });
    expect(stub.calls).toBe(0);
  });

  it('routes /start text to Home with zero Gemini calls', async () => {
    const stub = new StubIntentInterpreter();
    const decision = await route({ userId: 111, text: '/start' }, stub);
    expect(decision).toEqual({ layer: 'L1', action: 'home' });
    expect(stub.calls).toBe(0);
  });

  it('routes L2 phone/email/commands with zero Gemini calls', async () => {
    const stub = new StubIntentInterpreter();
    const phone = await route({ userId: 111, text: '+58 412 123 4567' }, stub);
    expect(phone.layer).toBe('L2');
    const command = await route({ userId: 111, text: 'cancelar' }, stub);
    expect(command.layer).toBe('L2');
    expect(stub.calls).toBe(0);
  });

  it('falls through to L3 Gemini for natural language (exactly one call)', async () => {
    const stub = new StubIntentInterpreter();
    const decision = await route({ userId: 111, text: 'quiero buscar un cliente' }, stub);
    expect(decision.layer).toBe('L3');
    expect(stub.calls).toBe(1);
  });

  it('treats stale/unknown callbacks as a safe no-op (zero Gemini calls)', async () => {
    const stub = new StubIntentInterpreter();
    const decision = await route({ userId: 111, callbackData: 'v1:gone-stale' }, stub);
    expect(decision).toEqual({ layer: 'noop', reason: 'stale-callback' });
    expect(stub.calls).toBe(0);
  });
});
