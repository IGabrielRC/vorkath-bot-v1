import type { ServiceAccount } from './accounts';
import { groupRowsIntoAccounts } from './accounts';
import type { Customer } from './customers';
import { groupRowsIntoCustomers } from './customers';
import type { MockAccount, MockService } from './excelLoader';
import type { MockStore } from './mockStore';

/**
 * Repository seam for the MOCK plane.
 *
 * `MockRepositories` is the interface every consumer (webhook, tools)
 * programs against; `MockAccountRepositories` is the MOCK implementation
 * backed by `MockStore`. A future `PostgresRepositories` can satisfy the
 * same interface without touching consumers — tools consume repos,
 * never spreadsheet columns.
 *
 * Every read returns `SafeAccount`: NOMBRE/PERFIL/SERVICIO/PAIS/ESTATUS
 * only. CORREO/CONTRASEÑA never leave the store through this seam, so
 * chat replies and logs stay secret-free by construction.
 */

export interface SafeAccount {
  nombre: string;
  perfil: string;
  servicio: MockService;
  pais: string;
  estatus: string;
}

export interface InventorySummary {
  servicio: string;
  total: number;
}

export interface MockRepositories {
  searchAccounts(query: string): Promise<SafeAccount[]>;
  /**
   * Read-only phone search: phone-identity row matching
   * (`MockStore.searchByPhone`) grouped into customers HERE (domain
   * layer — CLIENTE ≠ TELÉFONO). Safe by construction: customers carry
   * no CORREO/CONTRASEÑA/PIN.
   */
  searchCustomersByPhone(query: string): Promise<Customer[]>;
  searchServiceAccounts(identifier: string): Promise<ServiceAccount[]>;
  getExpiredAccounts(): Promise<SafeAccount[]>;
  getInventorySummary(): Promise<InventorySummary[]>;
}

/** Strips CORREO/CONTRASEÑA — the only sanctioned path to chat/log output. */
export function toSafeAccount(account: MockAccount): SafeAccount {
  return {
    nombre: account.nombre,
    perfil: account.perfil,
    servicio: account.servicio,
    pais: account.pais,
    estatus: account.estatus,
  };
}

export class MockAccountRepositories implements MockRepositories {
  constructor(private readonly store: MockStore) {}

  async searchAccounts(query: string): Promise<SafeAccount[]> {
    return this.store.search(query).map(toSafeAccount);
  }

  async searchCustomersByPhone(query: string): Promise<Customer[]> {
    return groupRowsIntoCustomers(this.store.searchByPhone(query));
  }

  /**
   * Read-only neutral account search: exact-identifier row matching
   * (`MockStore.searchByAccountIdentifier`, both services, no service
   * question) grouped into accounts HERE (domain layer — one account
   * per service+identifier, rows = profiles/slots). Safe by
   * construction: accounts carry derived status + PAIS_CUENTA only,
   * no CORREO-adjacent secrets (no CONTRASEÑA/PIN).
   */
  async searchServiceAccounts(identifier: string): Promise<ServiceAccount[]> {
    return groupRowsIntoAccounts(this.store.searchByAccountIdentifier(identifier));
  }

  async getExpiredAccounts(): Promise<SafeAccount[]> {
    return this.store.getExpired().map(toSafeAccount);
  }

  async getInventorySummary(): Promise<InventorySummary[]> {
    return this.store.countByService();
  }
}
