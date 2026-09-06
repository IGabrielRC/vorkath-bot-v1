import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAlertText } from '../src/alerts/alerts';
import { formatAccountCard } from '../src/mock/accounts';
import { formatCustomerCard } from '../src/mock/customers';
import type { MockAccount } from '../src/mock/excelLoader';
import { HttpTelegramClient } from '../src/telegram/client';
import { operatorLabel, withOperator } from '../src/telegram/keyboards';
import {
  TELEGRAM_PARSE_MODE,
  accountSlotLine,
  emptyState,
  esc,
  expiredRow,
  field,
  formatDate,
  inventoryRow,
  notFound,
  renderAccountCard,
  renderAccountChoices,
  renderAccountNotFound,
  renderActivitySummary,
  renderAlert,
  renderCustomerCard,
  renderCustomerList,
  renderDraftCreated,
  renderDraftOpened,
  renderDraftResumed,
  renderDraftUpdated,
  renderDias,
  renderExpired,
  renderFreeSlot,
  renderInventory,
  renderLegacyDetail,
  renderLegacyList,
  renderLegacyNotFound,
  renderOwnershipWarning,
  renderPhoneNotFound,
  renderStatus,
  section,
  slotLine,
  subtitle,
  title,
  unesc,
} from '../src/telegram/render';
import { parseOperatorLabel } from '../src/telegram/webhook';

/** Pinned operational clock, mirroring the slice tests. */
const PINNED_NOW = new Date('2026-09-06T12:00:00Z');

/**
 * Telegram HTML validity: the design system emits ONLY `<b>` tags, so
 * after removing them no raw `<`/`>` may remain (dynamic content is
 * escaped to `&lt;`/`&gt;`/`&amp;`). A stray bracket would break the
 * central HTML parse_mode delivery.
 */
function expectValidHtml(text: string): void {
  const stripped = text.replace(/<\/?b>/g, '');
  expect(stripped).not.toContain('<');
  expect(stripped).not.toContain('>');
}

function hostileCustomer() {
  return {
    nombre: '<b>Ana & Cía</b>',
    phones: ['4145000000<script>'],
    subscriptions: [
      {
        servicio: 'FlujoTV',
        perfil: '1 PERFIL <img>',
        fechaFin: '2026-09-07',
        estatus: 'Por vencer',
        dias: 1,
        paisCuenta: 'VE & CO',
      },
    ],
  };
}

function hostileAccount() {
  return {
    servicio: 'Netflix',
    identifier: 'evil<b>@example.com & co',
    slots: [
      {
        perfil: '1 PERFIL (1)',
        cliente: 'Hacker <script>alert(1)</script>',
        fechaFin: '2026-09-27',
        estatus: 'Vigente',
        dias: 21,
        paisCuenta: 'BR',
      },
    ],
  };
}

describe('render: primitives', () => {
  it('escapes the HTML surface (&, <, >) and round-trips through unesc', () => {
    expect(esc('<b>A & B</b>')).toBe('&lt;b&gt;A &amp; B&lt;/b&gt;');
    expect(unesc('&lt;b&gt;A &amp; B&lt;/b&gt;')).toBe('<b>A & B</b>');
    // Literal entity-looking input round-trips instead of collapsing.
    expect(unesc(esc('&lt;'))).toBe('&lt;');
  });

  it('title/subtitle/field/section/empty-state/not-found compose escaped markup', () => {
    expect(title('📺 Netflix')).toBe('<b>📺 Netflix</b>');
    expect(title('<b>x</b>')).toBe('<b>&lt;b&gt;x&lt;/b&gt;</b>');
    expect(subtitle('a&b')).toBe('a&amp;b');
    expect(field('País', 'VE & CO')).toBe('País: VE &amp; CO');
    expect(section('T', ['a', 'b'])).toBe('<b>T</b>\n\na\nb');
    expect(emptyState('⏰ Vencidos MOCK', 'Sin vencidos.')).toBe(
      '<b>⏰ Vencidos MOCK</b>\n\nSin vencidos.',
    );
    expect(notFound('🔎 NO ENCONTRADO', 'Cuerpo.', 'Reintenta.')).toBe(
      '<b>🔎 NO ENCONTRADO</b>\n\nCuerpo.\n\nReintenta.',
    );
  });
});

describe('render: dates', () => {
  it('formats one human es-419 date in UTC, deterministic for the same input', () => {
    expect(formatDate('2026-09-07')).toBe('7 sep 2026');
    expect(formatDate('2026-09-27')).toBe('27 sep 2026');
    expect(formatDate('2026-01-05')).toBe('5 ene 2026');
    expect(formatDate('2026-12-25')).toBe('25 dic 2026');
    expect(formatDate('2026-09-07')).toBe(formatDate('2026-09-07'));
  });

  it('renders unknown expiry as sin fecha and never breaks markup on garbage', () => {
    expect(formatDate(null)).toBe('sin fecha');
    expect(formatDate(undefined)).toBe('sin fecha');
    expect(formatDate('')).toBe('sin fecha');
    expect(formatDate('<b>mañana</b>')).toBe('&lt;b&gt;mañana&lt;/b&gt;');
    expect(formatDate('2026-13-99')).toBe('2026-13-99');
    expectValidHtml(formatDate('<script>'));
  });
});

describe('render: statuses', () => {
  it('renders the three domain statuses with their dots', () => {
    expect(renderStatus('Vigente')).toBe('🟢 Vigente');
    expect(renderStatus('Por vencer')).toBe('🟡 Por vencer');
    expect(renderStatus('Vencido')).toBe('🔴 Vencido');
    expect(renderStatus('Sin dato')).toBe('Sin dato');
  });

  it('vencido NEVER renders as Libre — no status path emits Libre', () => {
    for (const estatus of ['Vigente', 'Por vencer', 'Vencido', 'Sin dato']) {
      const rendered = renderStatus(estatus);
      expect(rendered).not.toContain('Libre');
      expect(rendered).not.toContain('⚪');
    }
    expect(renderStatus('Vencido')).toContain('Vencido');
  });

  it('⚪ Libre exists only via the explicit free-slot renderer', () => {
    expect(renderFreeSlot()).toBe('⚪ Libre');
  });

  it('renders the day-count suffix exactly like the legacy cards', () => {
    expect(renderDias(null)).toBe('');
    expect(renderDias(1)).toBe(' (1 día)');
    expect(renderDias(21)).toBe(' (21 días)');
    expect(renderDias(-4)).toBe(' (-4 días)');
  });
});

describe('render: single client card', () => {
  it('is entity-first with bold title, phone line and blank separators', () => {
    const card = renderCustomerCard({
      nombre: 'Anny Tovar',
      phones: ['4145460657'],
      subscriptions: [
        {
          servicio: 'FlujoTV',
          perfil: '1 PERFIL',
          fechaFin: '2026-09-07',
          estatus: 'Por vencer',
          dias: 1,
          paisCuenta: 'VE',
        },
      ],
    });
    expect(card).toBe(
      '<b>👤 Anny Tovar</b>\n📞 4145460657\n\n• FlujoTV — 1 PERFIL — vence 7 sep 2026 — 🟡 Por vencer (1 día) — País: VE',
    );
    expectValidHtml(card);
  });

  it('never repeats the client name on subscription lines', () => {
    const card = renderCustomerCard({
      nombre: 'Rafael minnesota',
      phones: ['16124418159'],
      subscriptions: [
        {
          servicio: 'FlujoTV',
          perfil: '1 PERFIL',
          fechaFin: '2026-10-01',
          estatus: 'Vigente',
          dias: 25,
          paisCuenta: 'VE',
        },
        {
          servicio: 'Netflix',
          perfil: '1 PERFIL (1)',
          fechaFin: '2026-10-01',
          estatus: 'Vigente',
          dias: 25,
          paisCuenta: 'US',
        },
      ],
    });
    expect(card.match(/Rafael minnesota/g)).toHaveLength(1);
    expectValidHtml(card);
  });

  it('formatCustomerCard delegates with derived status and human dates', () => {
    const card = formatCustomerCard(
      {
        id: 'anny tovar',
        nombre: 'Anny Tovar',
        phones: ['4145460657'],
        subscriptions: [
          {
            servicio: 'flujotv',
            perfil: '1 PERFIL',
            fechaFin: '2026-09-07',
            paisCuenta: 'VE',
            estatusLegacy: 'VIGENTE',
            numeroRaw: '4145460657',
          },
        ],
      },
      PINNED_NOW,
    );
    expect(card).toContain('<b>👤 Anny Tovar</b>');
    expect(card).toContain('vence 7 sep 2026 — 🟡 Por vencer (1 día) — País: VE');
    expectValidHtml(card);
  });
});

describe('render: multi-client list', () => {
  it('stays compact — names and phones only, details after selection', () => {
    const list = renderCustomerList(
      2,
      [
        { nombre: 'Stefania Marmai (Gian)', phones: ['4141294973'] },
        { nombre: 'Iliana Rodriguez', phones: ['4141294973'] },
      ],
      0,
    );
    expect(list).toContain('<b>🔎 2 clientes comparten ese número</b>');
    expect(list).toMatch(/elige uno/i);
    expect(list).toContain('1. Stefania Marmai (Gian) — 4141294973');
    expect(list).toContain('2. Iliana Rodriguez — 4141294973');
    expect(list).not.toContain('vence');
    expect(list).not.toContain('País:');
    expectValidHtml(list);
  });

  it('numbers follow the page offset', () => {
    const list = renderCustomerList(7, [{ nombre: 'X', phones: [] }], 5);
    expect(list).toContain('6. X — —');
  });
});

describe('render: not-found states', () => {
  it('phone not-found uses 🔎 NO ENCONTRADO and never offers Crear cliente', () => {
    const text = renderPhoneNotFound();
    expect(text).toContain('<b>🔎 NO ENCONTRADO</b>');
    expect(text).toContain('No encontramos ningún cliente asociado a ese número.');
    expect(text).toContain('Escribe otro número para reintentar o pulsa Volver.');
    expect(text).not.toMatch(/crear cliente/i);
    expectValidHtml(text);
  });

  it('account not-found uses 🔎 CUENTA NO ENCONTRADA and never offers creation', () => {
    const text = renderAccountNotFound();
    expect(text).toContain('<b>🔎 CUENTA NO ENCONTRADA</b>');
    expect(text).toContain('No encontramos esa cuenta.');
    expect(text).toContain('Escribe otra cuenta para reintentar o pulsa Volver.');
    expect(text).not.toMatch(/crear cliente/i);
    expectValidHtml(text);
  });

  it('legacy browse not-found escapes the query', () => {
    const text = renderLegacyNotFound('<b>netflix</b> & co');
    expect(text).toContain('“&lt;b&gt;netflix&lt;/b&gt; &amp; co” no coincide.');
    expectValidHtml(text);
  });
});

describe('render: account cards', () => {
  it('Netflix card groups profiles under one bold title with human dates', () => {
    const card = renderAccountCard({
      servicio: 'Netflix',
      identifier: 'dasdsadasda@gmail.com',
      slots: [
        {
          perfil: '1 PERFIL (1)',
          cliente: 'Daniel pares',
          fechaFin: '2026-09-27',
          estatus: 'Vigente',
          dias: 21,
          paisCuenta: 'BR',
        },
        {
          perfil: '1 PERFIL (2)',
          cliente: 'Yuyu',
          fechaFin: '2027-01-20',
          estatus: 'Vigente',
          dias: 136,
          paisCuenta: 'VE',
        },
      ],
    });
    const lines = card.split('\n');
    expect(lines[0]).toBe('<b>📺 Netflix · dasdsadasda@gmail.com</b>');
    expect(card).toContain('• 1 PERFIL (1) — Daniel pares — vence 27 sep 2026 — 🟢 Vigente (21 días) — País: BR');
    expect(card).toContain('País: VE');
    expectValidHtml(card);
  });

  it('FlujoTV card keeps its own model — no Netflix profile numbering', () => {
    const card = renderAccountCard({
      servicio: 'FlujoTV',
      identifier: 'cmaxnet001',
      slots: ['Anny Tovar', 'Neisis Zambrano', 'Roman Morales'].map((cliente) => ({
        perfil: '1 PERFIL',
        cliente,
        fechaFin: '2026-09-07',
        estatus: 'Por vencer',
        dias: 1,
        paisCuenta: 'VE',
      })),
    });
    expect(card).toContain('<b>📺 FlujoTV · cmaxnet001</b>');
    expect(card.match(/1 PERFIL(?! \()/g)).toHaveLength(3);
    expectValidHtml(card);
  });

  it('formatAccountCard delegates with derived status and human dates', () => {
    const card = formatAccountCard(
      {
        id: 'flujotv:maxnet050',
        servicio: 'flujotv',
        identifier: 'maxnet050',
        slots: [
          {
            perfil: 'CUENTA COMPLETA',
            cliente: 'Jackson Amaya',
            fechaFin: '2026-09-07',
            paisCuenta: 'VE',
            estatusLegacy: 'VIGENTE',
            numeroRaw: '4000000000',
          },
        ],
      },
      PINNED_NOW,
    );
    expect(card).toBe(
      '<b>📺 FlujoTV · maxnet050</b>\n\n• CUENTA COMPLETA — Jackson Amaya — vence 7 sep 2026 — 🟡 Por vencer (1 día) — País: VE',
    );
    expectValidHtml(card);
  });

  it('a vencido slot stays assigned and never reads as Libre', () => {
    const card = renderAccountCard({
      servicio: 'FlujoTV',
      identifier: 'maxnet001',
      slots: [
        {
          perfil: '1 PERFIL',
          cliente: 'Jesus Galvis',
          fechaFin: '2026-09-02',
          estatus: 'Vencido',
          dias: -4,
          paisCuenta: 'VE',
        },
      ],
    });
    expect(card).toContain('Jesus Galvis');
    expect(card).toContain('🔴 Vencido (-4 días)');
    expect(card).not.toMatch(/libre|disponible/i);
    expect(card).not.toContain('⚪');
  });
});

describe('render: hostile input can never break markup nor inject it', () => {
  it('escapes hostile names, phones, perfiles and countries in the customer card', () => {
    const card = renderCustomerCard(hostileCustomer());
    expect(card).toContain('&lt;b&gt;Ana &amp; Cía&lt;/b&gt;');
    expect(card).toContain('4145000000&lt;script&gt;');
    expect(card).toContain('1 PERFIL &lt;img&gt;');
    expect(card).toContain('VE &amp; CO');
    expect(card).not.toContain('<script>');
    expect(card).not.toContain('<img>');
    expectValidHtml(card);
  });

  it('escapes hostile identifiers and client names in the account card', () => {
    const card = renderAccountCard(hostileAccount());
    expect(card).toContain('evil&lt;b&gt;@example.com &amp; co');
    expect(card).toContain('Hacker &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(card).not.toContain('<script>');
    expectValidHtml(card);
  });

  it('escapes hostile names in the operator label and round-trips them', () => {
    const hostile = '<b>Gabriel</b> & co';
    const labeled = withOperator('Hola', hostile);
    expect(labeled).toContain('👤 Operador: &lt;b&gt;Gabriel&lt;/b&gt; &amp; co');
    expect(parseOperatorLabel(labeled)).toBe(hostile);
    expectValidHtml(labeled);
    expect(operatorLabel(undefined)).toBe('👤 Operador: Operador');
  });

  it('escapes hostile owners, queries, alerts and activity names', () => {
    expect(renderOwnershipWarning('<b>Jefe</b>')).toBe(
      '⚠️ Esta operación pertenece a &lt;b&gt;Jefe&lt;/b&gt;.',
    );
    expect(renderCustomerList(1, [{ nombre: '<i>X</i>', phones: ['1&2'] }], 0)).toContain(
      '&lt;i&gt;X&lt;/i&gt; — 1&amp;2',
    );
    expect(renderLegacyList(1, [{ nombre: 'A<script>', perfil: 'p', pais: 'VE', estatus: 'VIGENTE' }], 0)).toContain(
      'A&lt;script&gt;',
    );
    expect(
      renderLegacyDetail({ nombre: 'A&B', perfil: 'p', servicio: 's', pais: 'VE', estatus: 'e' }, 0, 1),
    ).toContain('Nombre: A&amp;B');
    const alert = renderAlert({
      title: '<b>CAÍDA</b>',
      summary: 'Todo & nada <script>',
      actorName: 'Gabi & Cía',
      timestamp: '2026-09-06T12:00:00.000Z',
    });
    expect(alert).toContain('&lt;b&gt;CAÍDA&lt;/b&gt;');
    expect(alert).toContain('Todo &amp; nada &lt;script&gt;');
    expect(alert).toContain('👤 Operador: Gabi &amp; Cía');
    expectValidHtml(alert);
    const activity = renderActivitySummary('Jefe <b>', 2);
    expect(activity).toContain('Jefe &lt;b&gt;');
    expectValidHtml(activity);
    expectValidHtml(expiredRow({ nombre: '<x>', perfil: 'p', pais: 'VE', estatus: 'e' }));
    expectValidHtml(inventoryRow({ servicio: '<x>', total: 3 }));
    expectValidHtml(slotLine({ servicio: '<x>', perfil: 'p', fechaFin: null, estatus: 'Sin dato', dias: null, paisCuenta: '' }));
    expectValidHtml(accountSlotLine({ perfil: 'p', cliente: '<x>', fechaFin: null, estatus: 'Sin dato', dias: null, paisCuenta: '' }));
  });
});

describe('render: no passwords or PINs in any rendered output', () => {
  const SECRET = 's3cr3t-p4ssw0rd-9999';

  it('sweeps every renderer with secret-bearing source rows', async () => {
    // Secrets live in credential source fields (contrasena); the domain
    // seam strips them before anything reaches a renderer — the full
    // pipeline must stay secret-free, exactly like slice test (29).
    const { groupRowsIntoCustomers } = await import('../src/mock/customers');
    const { groupRowsIntoAccounts } = await import('../src/mock/accounts');
    const rows: MockAccount[] = [
      {
        servicio: 'flujotv',
        correo: 'cmaxnet001',
        contrasena: SECRET,
        perfil: '1 PERFIL',
        fechaInicio: '2026-08-20',
        fechaFin: '2026-09-07',
        dias: null,
        estatus: 'VIGENTE',
        nombre: 'Anny Tovar',
        monto: null,
        estado: '',
        numero: '4145460657',
        pais: 'VE',
      },
      {
        servicio: 'netflix',
        correo: 'dasdsadasda@gmail.com',
        contrasena: SECRET,
        perfil: '1 PERFIL (1)',
        fechaInicio: '2026-08-20',
        fechaFin: '2026-09-27',
        dias: null,
        estatus: 'VIGENTE',
        nombre: 'Daniel pares',
        monto: null,
        estado: '',
        numero: '4121461745',
        pais: 'BR',
      },
    ];
    const [customer] = groupRowsIntoCustomers(rows.filter((row) => row.nombre === 'Anny Tovar'));
    const [account] = groupRowsIntoAccounts(rows.filter((row) => row.nombre === 'Daniel pares'));
    const outputs = [
      formatCustomerCard(customer!, PINNED_NOW),
      formatAccountCard(account!, PINNED_NOW),
      renderCustomerCard({ nombre: 'Anny Tovar', phones: ['4145460657'], subscriptions: [] }),
      renderCustomerList(1, [{ nombre: 'Anny Tovar', phones: ['4145460657'] }], 0),
      renderAccountChoices(2),
      renderPhoneNotFound(),
      renderAccountNotFound(),
      renderLegacyNotFound('cmaxnet001'),
      renderLegacyList(
        1,
        [{ nombre: 'Anny Tovar', perfil: '1 PERFIL', pais: 'VE', estatus: 'VIGENTE' }],
        0,
      ),
      renderLegacyDetail(
        { nombre: 'Anny Tovar', perfil: '1 PERFIL', servicio: 'flujotv', pais: 'VE', estatus: 'VIGENTE' },
        0,
        1,
      ),
      renderExpired([{ nombre: 'Anny Tovar', perfil: '1 PERFIL', pais: 'VE', estatus: 'VENCIDO' }]),
      renderInventory([{ servicio: 'flujotv', total: 1 }]),
      renderDraftOpened(),
      renderDraftResumed(2),
      renderDraftCreated(2),
      renderDraftUpdated(2),
      renderOwnershipWarning('Gabriel'),
      renderActivitySummary('Gabriel', 2),
      renderAlert({ title: 'T', summary: 'S', actorName: 'Gabriel', timestamp: '2026-09-06' }),
      buildAlertText({ type: 'test', title: 'T', summary: 'S' }),
    ];
    for (const text of outputs) {
      expect(text).not.toContain(SECRET);
      expectValidHtml(text);
    }
    const joined = outputs.join('\n');
    expect(joined).not.toMatch(/contrasena|CONTRASEÑA|contraseña/i);
    expect(joined).not.toMatch(/\bPIN\b/);
  });
});

describe('render: drafts, alerts and placeholders', () => {
  it('draft summaries carry 📝 OPERACIÓN PENDIENTE plus the same data', () => {
    expect(renderDraftOpened()).toContain('<b>📝 OPERACIÓN PENDIENTE</b>');
    expect(renderDraftOpened()).toContain('Borrador MOCK abierto (paso 1 de 2)');
    expect(renderDraftResumed(2)).toContain('Borrador retomado: 2 mes(es) (paso 2 de 2)');
    expect(renderDraftCreated(3)).toContain('Borrador MOCK: 3 mes(es)');
    expect(renderDraftUpdated(3)).toContain('Borrador actualizado: 3 mes(es) (paso 2 de 2)');
    for (const text of [renderDraftOpened(), renderDraftResumed(1), renderDraftCreated(1), renderDraftUpdated(1)]) {
      expectValidHtml(text);
    }
  });

  it('critical alerts carry ⭐ ALERTA plus title, summary, operator and time', () => {
    const text = buildAlertText({
      type: 'test',
      title: 'ALERTA DE PRUEBA',
      summary: 'Vorkath puede enviar alertas correctamente.',
      actorName: 'Gabriel',
      timestamp: '2026-09-06T12:00:00.000Z',
    });
    expect(text).toContain('<b>⭐ ALERTA</b>');
    expect(text).toContain('ALERTA DE PRUEBA');
    expect(text).toContain('Vorkath puede enviar alertas correctamente.');
    expect(text).toContain('👤 Operador: Gabriel');
    expect(text).toContain('🕒 2026-09-06T12:00:00.000Z');
    expectValidHtml(text);
  });

  it('placeholders keep their tokens with blank-line structure', () => {
    expect(renderExpired([])).toContain('Vencidos MOCK');
    expect(renderExpired([])).toContain('Sin vencidos.');
    const full = renderExpired([
      { nombre: 'A', perfil: '1 PERFIL', pais: 'VE', estatus: 'VENCIDO' },
      { nombre: 'B', perfil: '1 PERFIL', pais: 'VE', estatus: 'VENCIDO' },
    ]);
    expect(full).toContain('⏰ Vencidos MOCK (2)');
    expect(renderInventory([])).toContain('Inventario MOCK');
    const inv = renderInventory([
      { servicio: 'flujotv', total: 3 },
      { servicio: 'netflix', total: 2 },
    ]);
    expect(inv).toContain('• flujotv: 3');
    expect(inv).toContain('• netflix: 2');
    expectValidHtml(full);
    expectValidHtml(inv);
  });

  it('activity summaries stay secrets-free with name and months', () => {
    expect(renderActivitySummary('Gabriel', 2)).toBe('✅ Operación confirmada — Gabriel (2 mes(es)).');
    expect(renderActivitySummary('Gabriel')).toBe('✅ Operación confirmada — Gabriel.');
  });
});

describe('render: determinism', () => {
  it('same entity renders byte-identical text twice', () => {
    const customer = hostileCustomer();
    expect(renderCustomerCard(customer)).toBe(renderCustomerCard(structuredClone(customer)));
    const account = hostileAccount();
    expect(renderAccountCard(account)).toBe(renderAccountCard(structuredClone(account)));
    expect(renderCustomerCard({ nombre: 'A', phones: [], subscriptions: [] })).toBe(
      renderCustomerCard({ nombre: 'A', phones: [], subscriptions: [] }),
    );
    const alert = { title: 'T', summary: 'S', actorName: 'G', timestamp: '2026-09-06' };
    expect(renderAlert(alert)).toBe(renderAlert({ ...alert }));
    expect(renderDraftUpdated(2)).toBe(renderDraftUpdated(2));
    expect(renderPhoneNotFound()).toBe(renderPhoneNotFound());
    expect(renderAccountNotFound()).toBe(renderAccountNotFound());
  });
});

describe('render: central delivery', () => {
  it('uses ONE HTML parse_mode on every send and edit', async () => {
    expect(TELEGRAM_PARSE_MODE).toBe('HTML');
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const stubFetch = (async (url: unknown, init?: unknown) => {
      const body = JSON.parse(String((init as { body: string }).body)) as Record<string, unknown>;
      seen.push({ url: String(url), body });
      return { json: async () => ({ ok: true }) };
    }) as typeof globalThis.fetch;
    const client = new HttpTelegramClient('token-test-secret', stubFetch);
    await client.sendMessage({ chatId: 1, text: '<b>Hola</b>' });
    await client.editMessageText({ chatId: 1, messageId: 7, text: '<b>Hola</b>' });
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.body['parse_mode']).toBe('HTML');
      expect(call.body['text']).toBe('<b>Hola</b>');
    }
    expect(seen[0]?.url).toContain('/sendMessage');
    expect(seen[1]?.url).toContain('/editMessageText');
  });

  it('every message-building module renders through the central renderer', () => {
    const root = process.cwd();
    const refs: Array<[string, string[]]> = [
      ['src/telegram/webhook.ts', ['./render']],
      ['src/mock/customers.ts', ['../telegram/render']],
      ['src/mock/accounts.ts', ['../telegram/render']],
      ['src/alerts/alerts.ts', ['../telegram/render']],
      ['src/telegram/keyboards.ts', ['./render']],
      ['src/telegram/topics.ts', ['./render']],
    ];
    for (const [file, needles] of refs) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(
        needles.some((needle) => source.includes(needle)),
        `${file} must import the central renderer`,
      ).toBe(true);
    }
    // Representative messages carry the shared markup (used sparingly).
    expect(formatCustomerCard({ id: 'a', nombre: 'A', phones: [], subscriptions: [] })).toContain('<b>');
    expect(formatAccountCard({ id: 'a', servicio: 's', identifier: 'i', slots: [] })).toContain('<b>');
    expect(renderPhoneNotFound()).toContain('<b>🔎 NO ENCONTRADO</b>');
    expect(renderAccountNotFound()).toContain('<b>🔎 CUENTA NO ENCONTRADA</b>');
    expect(renderDraftOpened()).toContain('<b>📝 OPERACIÓN PENDIENTE</b>');
  });
});
