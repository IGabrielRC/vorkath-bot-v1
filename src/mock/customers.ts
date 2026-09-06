import type { MockAccount } from './excelLoader';
import { renderCustomerCard } from '../telegram/render';
import { splitStoredNumbers } from './phone';

/**
 * Customer domain (MOCK): CLIENTE ≠ TELÉFONO (BR-CUS-001).
 *
 * Rows are subscriptions/slots, not customers: one client owns several
 * rows (multi-service, e.g. Rafael minnesota ×4) and one phone can be
 * shared by several clients (e.g. `4141294973` → Stefania + Iliana).
 * Dedup (rows → customers) lives HERE — the domain/repository layer —
 * never in Telegram handlers.
 *
 * GROUPING LIMIT (documented): the MOCK groups by exact normalized
 * name (`nombre.trim().toLowerCase()`). Two different people sharing a
 * written name would merge; name variants (`Rosina Colabuono` vs
 * `Enzo Colaubo`) stay split. Real persistence must replace this with
 * customer ids + a CustomerPhone link table (many-to-many with
 * principal/secundario labels per the domain model) — see the
 * phoneRaw/phoneE164/CC/nationalNumber/region note in `./phone`.
 */

export interface CustomerSubscription {
  servicio: string;
  perfil: string;
  /** `FECHA QUE ACABA` as stored (`YYYY-MM-DD` or null). */
  fechaFin: string | null;
  /** PAIS_CUENTA: the SERVICE account country — never phone country. */
  paisCuenta: string;
  /** Legacy sheet value, informational only — never governs status. */
  estatusLegacy: string;
  /** Raw NUMERO cell as stored (multi-number cells kept verbatim). */
  numeroRaw: string;
}

export interface Customer {
  /** MOCK-stable id: the normalized grouping name (see limit above). */
  id: string;
  nombre: string;
  /** Individual numbers across every owned row/cell, stable order. */
  phones: string[];
  subscriptions: CustomerSubscription[];
}

export type DerivedStatus = 'Vigente' | 'Por vencer' | 'Vencido' | 'Sin dato';

export interface ExpiryDerivation {
  /** Calendar days from `now` to `fechaFin` (null when unknown). */
  dias: number | null;
  estatus: DerivedStatus;
}

const MS_PER_DAY = 86_400_000;

function toUtcMidnight(value: Date | string): number | null {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Status DERIVED from expiry (BR-EXP-003/004/005), never from legacy
 * DIAS/ESTATUS columns: DIAS>2 → Vigente, 1–2 → Por vencer, <=0 →
 * Vencido. `now` is injectable (tests pin the clock); production
 * passes the operational date. Timezone is the pending BR-EXP-008
 * decision — UTC-midnight comparison until then. An expired
 * subscription stays assigned (no liberation — BR-SLOT-005).
 */
export function deriveExpiryStatus(
  fechaFin: string | null,
  now: Date | string = new Date(),
): ExpiryDerivation {
  const fin = typeof fechaFin === 'string' ? toUtcMidnight(`${fechaFin}T00:00:00Z`) : null;
  const today = toUtcMidnight(now);
  if (fin === null || today === null) {
    return { dias: null, estatus: 'Sin dato' };
  }
  const dias = Math.round((fin - today) / MS_PER_DAY);
  if (dias > 2) {
    return { dias, estatus: 'Vigente' };
  }
  if (dias >= 1) {
    return { dias, estatus: 'Por vencer' };
  }
  return { dias, estatus: 'Vencido' };
}

/** Groups account rows into customers by normalized name (see limit above). */
export function groupRowsIntoCustomers(rows: MockAccount[]): Customer[] {
  const byName = new Map<string, Customer>();
  for (const row of rows) {
    const key = row.nombre.trim().toLowerCase();
    let customer = byName.get(key);
    if (customer === undefined) {
      customer = { id: key, nombre: row.nombre.trim(), phones: [], subscriptions: [] };
      byName.set(key, customer);
    }
    for (const phone of splitStoredNumbers(row.numero)) {
      if (!customer.phones.includes(phone)) {
        customer.phones.push(phone);
      }
    }
    customer.subscriptions.push({
      servicio: row.servicio,
      perfil: row.perfil,
      fechaFin: row.fechaFin,
      paisCuenta: row.pais,
      estatusLegacy: row.estatus,
      numeroRaw: row.numero,
    });
  }
  return [...byName.values()];
}

export function serviceLabel(servicio: string): string {
  const compact = servicio.replace(/\s+/g, '').toLowerCase();
  if (compact === 'flujotv') {
    return 'FlujoTV';
  }
  if (compact === 'netflix') {
    return 'Netflix';
  }
  return servicio;
}

/**
 * Read-only summary card: name, phone(s), services, expiry, derived
 * status. PAIS shown is always PAIS_CUENTA (per subscription line) —
 * never a phone-derived country. NEVER credentials: built from safe
 * fields only (no CORREO/CONTRASEÑA/PIN). Layout lives in the central
 * Telegram renderer (`renderCustomerCard`); the domain work here is only
 * deriving each subscription status (BR-EXP-003/004/005).
 */
export function formatCustomerCard(customer: Customer, now: Date | string = new Date()): string {
  return renderCustomerCard({
    nombre: customer.nombre,
    phones: customer.phones,
    subscriptions: customer.subscriptions.map((sub) => {
      const derived = deriveExpiryStatus(sub.fechaFin, now);
      return {
        servicio: serviceLabel(sub.servicio),
        perfil: sub.perfil,
        fechaFin: sub.fechaFin,
        estatus: derived.estatus,
        dias: derived.dias,
        paisCuenta: sub.paisCuenta,
      };
    }),
  });
}

export interface SelectedCustomer {
  id: string;
  nombre: string;
  updatedAt: string;
}

/**
 * Last-selected customer per actor (`chatId:userId`), for future
 * conversational references ("ese cliente" — no consumer yet; reads
 * stay served from the actor's own entry only, never a peer's).
 */
export class CustomerSelectionStore {
  private readonly selections = new Map<string, SelectedCustomer>();

  private static key(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }

  select(chatId: number, userId: number, customer: Customer): SelectedCustomer {
    const selection: SelectedCustomer = {
      id: customer.id,
      nombre: customer.nombre,
      updatedAt: new Date().toISOString(),
    };
    this.selections.set(CustomerSelectionStore.key(chatId, userId), selection);
    return selection;
  }

  lastSelected(chatId: number, userId: number): SelectedCustomer | undefined {
    return this.selections.get(CustomerSelectionStore.key(chatId, userId));
  }
}
