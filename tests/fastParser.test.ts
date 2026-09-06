import { describe, expect, it } from 'vitest';
import { parseEmail, parseFast, parseMonths, parsePhone, parseService } from '../src/parser/fast';

describe('fast parser L2 (RED: zero Gemini — deterministic only)', () => {
  it('detects phone numbers with >=7 digits', () => {
    expect(parsePhone('+58 412 123 4567')).toEqual({
      kind: 'phone',
      value: '584121234567',
      raw: '+584121234567',
    });
    expect(parsePhone('llámame al 0412-000-1111 porfa')).toMatchObject({ kind: 'phone' });
  });

  it('guards phone-vs-months: short digit strings are NOT phones', () => {
    expect(parsePhone('2')).toBeNull();
    expect(parsePhone('12')).toBeNull();
    expect(parsePhone('hola')).toBeNull();
    const months = parseFast('2');
    expect(months.kind).not.toBe('phone');
  });

  it('detects email addresses', () => {
    expect(parseEmail('escribe a GABRIEL@example.com hoy')).toEqual({
      kind: 'email',
      value: 'gabriel@example.com',
    });
    expect(parseEmail('sin correo aquí')).toBeNull();
  });

  it('detects month corrections deterministically (1 mes / 2 meses)', () => {
    expect(parseMonths('2 meses')).toEqual({ kind: 'months', months: 2 });
    expect(parseMonths('1 mes')).toEqual({ kind: 'months', months: 1 });
  });

  it('detects control commands without Gemini', () => {
    for (const [text, command] of [
      ['confirmar', 'confirmar'],
      ['Cancelar', 'cancelar'],
      ['volver', 'volver'],
      ['código de instalación', 'codigo'],
      ['tasa del día', 'tasa'],
      ['precio netflix', 'precio'],
    ] as const) {
      expect(parseFast(text)).toEqual({ kind: 'command', command });
    }
  });

  it('returns none for free natural language (L3 fallback owns it)', () => {
    expect(parseFast('quiero buscar un cliente')).toEqual({ kind: 'none' });
    expect(parseFast('mejor hazlo 2 meses')).toEqual({ kind: 'months', months: 2 });
  });

  it('recognizes Netflix + FlujoTV service names (any case/spacing)', () => {
    expect(parseService('netflix')).toEqual({ kind: 'service', value: 'netflix' });
    expect(parseService('Netflix')).toEqual({ kind: 'service', value: 'netflix' });
    expect(parseService('busca cuentas NETFLIX vencidas')).toEqual({
      kind: 'service',
      value: 'netflix',
    });
    expect(parseService('flujotv')).toEqual({ kind: 'service', value: 'flujotv' });
    expect(parseService('FlujoTV')).toEqual({ kind: 'service', value: 'flujotv' });
    expect(parseService('flujo tv')).toEqual({ kind: 'service', value: 'flujotv' });
    expect(parseService('cuentas de Flujo TV')).toEqual({
      kind: 'service',
      value: 'flujotv',
    });
    expect(parseService('hola')).toBeNull();
  });

  it('routes bare service names to L2 service (zero Gemini) without stealing specifics', () => {
    expect(parseFast('netflix')).toEqual({ kind: 'service', value: 'netflix' });
    expect(parseFast('flujo tv')).toEqual({ kind: 'service', value: 'flujotv' });
    // More specific kinds keep priority over service recognition.
    expect(parseFast('precio netflix')).toEqual({ kind: 'command', command: 'precio' });
    expect(parseFast('netflix 2 meses')).toEqual({ kind: 'months', months: 2 });
  });
});
