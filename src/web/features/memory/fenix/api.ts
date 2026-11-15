/**
 * Local adapter boundary for the vendored FenixAgent memory UI.
 *
 * Upstream `api/hindsight.ts` talks to Fenix's own `/web/hindsight` HTTP routes.
 * Agent Network must not add those routes in the vendor phase, so this module keeps
 * the exact call shape used by the ported components while delegating to an injected
 * adapter. The default adapter rejects every call: the panel cannot silently read
 * or write memory until a later phase wires it to `network_agent_memory_*`.
 *
 * Not ported from upstream: no network client, no credentials, no fetch.
 */

import type {
  BankStats,
  EntityGraphResponse,
  EntityItem,
  GraphApiData,
  HindsightStatus,
  MemoryDetail,
} from './types';

export class FenixApiError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'FenixApiError';
    this.code = code;
  }
}

export interface GraphQuery {
  type: string;
  q?: string;
  tags?: string[];
  document_id?: string;
  chunk_id?: string;
}

export interface EntityPage {
  items: EntityItem[];
  total: number;
}

export interface FenixMemoryApi {
  getStatus(): Promise<HindsightStatus>;
  getGraph(params: GraphQuery): Promise<GraphApiData>;
  getBankStats(): Promise<BankStats>;
  getMemory(id: string): Promise<MemoryDetail>;
  listEntities(params?: { limit?: number; offset?: number }): Promise<EntityPage>;
  getEntity(id: string): Promise<EntityItem>;
  getEntityGraph(params?: { limit?: number; min_count?: number }): Promise<EntityGraphResponse>;
}

function notWired(method: string): Promise<never> {
  return Promise.reject(
    new FenixApiError(`Fenix memory adapter is not wired yet (${method})`, 'FENIX_NOT_WIRED'),
  );
}

const DEFAULT_API: FenixMemoryApi = {
  getStatus: () => notWired('getStatus'),
  getGraph: () => notWired('getGraph'),
  getBankStats: () => notWired('getBankStats'),
  getMemory: () => notWired('getMemory'),
  listEntities: () => notWired('listEntities'),
  getEntity: () => notWired('getEntity'),
  getEntityGraph: () => notWired('getEntityGraph'),
};

let current: FenixMemoryApi = DEFAULT_API;

/**
 * Injected by the later memory-panel phase (or by tests/fixtures). Pass `null` to
 * restore the rejecting default so a test cannot leak a stub into another suite.
 */
export function configureFenixMemoryApi(api: FenixMemoryApi | null): void {
  current = api ?? DEFAULT_API;
}

/** Stable façade with the same method names the upstream components already call. */
export const hindsightApi: FenixMemoryApi = {
  getStatus: () => current.getStatus(),
  getGraph: (params) => current.getGraph(params),
  getBankStats: () => current.getBankStats(),
  getMemory: (id) => current.getMemory(id),
  listEntities: (params) => current.listEntities(params),
  getEntity: (id) => current.getEntity(id),
  getEntityGraph: (params) => current.getEntityGraph(params),
};
