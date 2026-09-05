import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

function captureLogs(emit: (log: pino.Logger) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    sink.on('finish', () => resolve(output));
    sink.on('error', reject);
    const log = pino(
      {
        level: 'info',
        redact: {
          paths: [
            'token',
            'secret',
            'apiKey',
            'TELEGRAM_BOT_TOKEN',
            'TELEGRAM_WEBHOOK_SECRET',
            'GEMINI_API_KEY',
            'correo',
            'contraseña',
            'CORREO',
            'CONTRASEÑA',
          ],
          censor: '[Redacted]',
        },
      },
      sink,
    );
    emit(log);
    sink.end();
  });
}

describe('logger redaction', () => {
  it('never leaks secrets or Spanish PII columns', async () => {
    const output = await captureLogs((log) => {
      log.info({
        TELEGRAM_BOT_TOKEN: 'tok-super-secret',
        TELEGRAM_WEBHOOK_SECRET: 'wh-super-secret',
        GEMINI_API_KEY: 'key-super-secret',
        correo: 'cliente@example.com',
        'contraseña': 'clave-super-secreta',
      });
    });

    expect(output).toContain('[Redacted]');
    expect(output).not.toContain('tok-super-secret');
    expect(output).not.toContain('wh-super-secret');
    expect(output).not.toContain('key-super-secret');
    expect(output).not.toContain('cliente@example.com');
    expect(output).not.toContain('clave-super-secreta');
  });
});
