import { deriveExpiryStatus, serviceLabel } from './customers';
import type { MockAccount } from './excelLoader';
import { renderAccountCard } from '../telegram/render';

/**
 * Account domain (MOCK): ACCOUNT_IDENTIFIER is neutral — an email, a
 * bare username or a code like `maxnet050` (never email=Netflix).
 * Search runs deterministically across BOTH repositories without
 * asking the service first; the returned `servicio` always comes
 * from the data row itself.
 *
 * Rows are slots/profiles, not accounts: one account owns several
 * rows (Netflix `dasdsadasda@gmail.com` ×4 profiles, FlujoTV
 * `cmaxnet001` ×3 clients). Dedup (rows → accounts) lives HERE —
 * the domain/repository layer — never in Telegram handlers.
 *
 * GROUPING LIMIT (documented): the MOCK groups by exact normalized
 * correo (`correo.trim().toLowerCase()`) scoped per service, so
 * `maxnet001` never bleeds into `cmaxnet001` and no domain is ever
 * appended (`cmaxnet001@gmail.com` matches nothing). Two rows sharing
 * a normalized correo within one service merge even when their
 * per-row PERFIL/PAIS spellings differ (legacy splits stay as
 * separate slot lines). Real persistence must replace this with
 * account ids — see the phoneRaw/phoneE164 note in `./phone` and the
 * grouping note in `./customers`.
 *
 * PER-SERVICE SHAPE (documented):
 * - Netflix accounts group their profiles 1..5 (commercial 1–4,
 *   emergency 5 — BR-NFX-001/002) with real availability semantics:
 *   `VENCIDO` is derived time (BR-EXP-005/006), never availability —
 *   an expired slot stays assigned (BR-SLOT-005) and the card never
 *   invents `DISPONIBLE`.
 * - FlujoTV accounts keep their OWN model (`1 PERFIL` ×N clients on a
 *   shared account, or a single `CUENTA COMPLETA` exclusive slot) —
 *   the Netflix 5-profile shape is never forced onto them.
 */

export interface AccountSlot {
  /** PERFIL as stored (`1 PERFIL (1)`, `1 PERFIL`, `CUENTA COMPLETA`, …). */
  perfil: string;
  /** NOMBRE: the client holding this slot. */
  cliente: string;
  /** `FECHA QUE ACABA` as stored (`YYYY-MM-DD` or null). */
  fechaFin: string | null;
  /** PAIS_CUENTA: the SERVICE account country — never phone country. */
  paisCuenta: string;
  /** Legacy sheet value, informational only — never governs status. */
  estatusLegacy: string;
  /** Raw NUMERO cell as stored (multi-number cells kept verbatim). */
  numeroRaw: string;
}

export interface ServiceAccount {
  /** MOCK-stable id: `${servicio}:${normalized identifier}`. */
  id: string;
  /** Service from the data row itself — never assumed. */
  servicio: string;
  /** CORREO as stored (trimmed): email, username or code. */
  identifier: string;
  slots: AccountSlot[];
}

/** Groups account rows into one account per (service, identifier). */
export function groupRowsIntoAccounts(rows: MockAccount[]): ServiceAccount[] {
  const byAccount = new Map<string, ServiceAccount>();
  for (const row of rows) {
    const normalized = row.correo.trim().toLowerCase();
    const key = `${row.servicio}:${normalized}`;
    let account = byAccount.get(key);
    if (account === undefined) {
      account = {
        id: key,
        servicio: row.servicio,
        identifier: row.correo.trim(),
        slots: [],
      };
      byAccount.set(key, account);
    }
    account.slots.push({
      perfil: row.perfil,
      cliente: row.nombre,
      fechaFin: row.fechaFin,
      paisCuenta: row.pais,
      estatusLegacy: row.estatus,
      numeroRaw: row.numero,
    });
  }
  return [...byAccount.values()];
}

/**
 * Read-only account card: service, identifier, PAIS_CUENTA per slot
 * line (never a phone-derived country), clients with derived
 * expiry/status. NEVER credentials: built from safe fields only
 * (no CORREO-adjacent secrets — no CONTRASEÑA/PIN). Layout lives in the
 * central Telegram renderer (`renderAccountCard`); the domain work here
 * is only deriving each slot status (BR-EXP-003/004/005). `now` is
 * injectable (tests pin the clock); see `deriveExpiryStatus` for the
 * BR-EXP-003/004/005 rule and the BR-EXP-008 timezone note.
 */
export function formatAccountCard(
  account: ServiceAccount,
  now: Date | string = new Date(),
): string {
  return renderAccountCard({
    servicio: serviceLabel(account.servicio),
    identifier: account.identifier,
    slots: account.slots.map((slot) => {
      const derived = deriveExpiryStatus(slot.fechaFin, now);
      return {
        perfil: slot.perfil,
        cliente: slot.cliente,
        fechaFin: slot.fechaFin,
        estatus: derived.estatus,
        dias: derived.dias,
        paisCuenta: slot.paisCuenta,
      };
    }),
  });
}

export interface SelectedAccount {
  id: string;
  servicio: string;
  identifier: string;
  updatedAt: string;
}

/**
 * Last-selected account per actor (`chatId:userId`), mirroring
 * `CustomerSelectionStore` for future conversational references
 * ("esa cuenta" — no consumer yet; reads stay served from the
 * actor's own entry only, never a peer's).
 */
export class AccountSelectionStore {
  private readonly selections = new Map<string, SelectedAccount>();

  private static key(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }

  select(chatId: number, userId: number, account: ServiceAccount): SelectedAccount {
    const selection: SelectedAccount = {
      id: account.id,
      servicio: account.servicio,
      identifier: account.identifier,
      updatedAt: new Date().toISOString(),
    };
    this.selections.set(AccountSelectionStore.key(chatId, userId), selection);
    return selection;
  }

  lastSelected(chatId: number, userId: number): SelectedAccount | undefined {
    return this.selections.get(AccountSelectionStore.key(chatId, userId));
  }
}
