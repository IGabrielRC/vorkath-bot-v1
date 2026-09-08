/**
 * ONE generic ListView: the three legacy disambiguation builders stay
 * byte-compatible (they delegate here). Pins numerals, view0–4 actions,
 * next/prev pagination, stable interaction-bound keys, and the 5-option
 * cap exactly where current behavior lives.
 */

import { describe, expect, it } from 'vitest';
import {
  accountDisambiguationKeyboard,
  callbackDataFor,
  credentialDisambiguationKeyboard,
  listView,
  searchResultsKeyboard,
} from '../src/telegram/keyboards';

describe('listView (ONE generic disambiguation/list view)', () => {
  it('searchResultsKeyboard delegates byte-identical to listView', () => {
    const viaWrapper = searchResultsKeyboard(3, {
      interactionId: 'abc12345',
      hasNext: true,
      hasPrev: true,
    });
    const viaGeneric = listView(['Ver cliente', 'Ver cliente', 'Ver cliente'], {
      interactionId: 'abc12345',
      hasNext: true,
      hasPrev: true,
    });
    expect(viaWrapper).toEqual(viaGeneric);
    expect(viaWrapper).toEqual({
      inline_keyboard: [
        [
          { text: '1️⃣ Ver cliente', callback_data: callbackDataFor('view0', 'abc12345') },
          { text: '2️⃣ Ver cliente', callback_data: callbackDataFor('view1', 'abc12345') },
        ],
        [{ text: '3️⃣ Ver cliente', callback_data: callbackDataFor('view2', 'abc12345') }],
        [
          { text: '←Anterior', callback_data: callbackDataFor('prev', 'abc12345') },
          { text: 'Siguiente→', callback_data: callbackDataFor('next', 'abc12345') },
        ],
        [{ text: '←Volver', callback_data: callbackDataFor('back', 'abc12345') }],
      ],
    });
  });

  it('accountDisambiguationKeyboard keeps service + identifier labels with stable keys', () => {
    const markup = accountDisambiguationKeyboard(
      [
        { servicio: 'netflix', identifier: 'cuenta@gmail.com' },
        { servicio: 'flujotv', identifier: 'FLJ-001' },
      ],
      { interactionId: 'abc12345' },
    );
    expect(markup).toEqual(
      listView(['Netflix · cuenta@gmail.com', 'FlujoTV · FLJ-001'], {
        interactionId: 'abc12345',
      }),
    );
    const flat = markup.inline_keyboard.flat();
    expect(flat.map((button) => button.text)).toEqual([
      '1️⃣ Netflix · cuenta@gmail.com',
      '2️⃣ FlujoTV · FLJ-001',
      '←Volver',
    ]);
  });

  it('truncates over-long button identifiers but keeps the full value on the card path', () => {
    const long = 'esta-es-una-cuenta-muy-larga-12345';
    const markup = accountDisambiguationKeyboard(
      [{ servicio: 'netflix', identifier: long }],
      { interactionId: 'abc12345' },
    );
    const label = markup.inline_keyboard.flat()[0]?.text ?? '';
    expect(label.length).toBeLessThan(long.length + 10);
    expect(label).toContain('…');
    expect(label).toContain('Netflix');
  });

  it('credentialDisambiguationKeyboard delegates byte-identical to listView', () => {
    const labels = ['Netflix · 1 PERFIL (2)', 'FlujoTV · 1 PERFIL'];
    expect(credentialDisambiguationKeyboard(labels, { interactionId: 'abc12345' })).toEqual(
      listView(labels, { interactionId: 'abc12345' }),
    );
  });

  it('caps options at the five view actions and keeps Volver last', () => {
    const markup = listView(['a', 'b', 'c', 'd', 'e', 'f', 'g'], {
      interactionId: 'abc12345',
    });
    const flat = markup.inline_keyboard.flat();
    expect(flat.filter((button) => button.text !== '←Volver')).toHaveLength(5);
    expect(flat.at(-1)?.text).toBe('←Volver');
  });

  it('omits pagination rows unless requested', () => {
    const plain = searchResultsKeyboard(1, { interactionId: 'abc12345' });
    expect(plain.inline_keyboard.flat().map((button) => button.text)).toEqual([
      '1️⃣ Ver cliente',
      '←Volver',
    ]);
  });
});
