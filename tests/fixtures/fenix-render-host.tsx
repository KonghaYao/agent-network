/**
 * Test-only browser entry for the vendored Fenix memory UI.
 *
 * `scripts/verify-memory-fenix-vendor.ts` builds this page next to the lazy host
 * so `tests/e2e/memory-fenix-vendor.spec.ts` can render the real vendor bundle
 * and assert that the default/compact detail branches mask credentials.
 *
 * The panel is loaded through the same dynamic import as the lazy host; the
 * fixture must not turn the vendor into a static import of the test entry.
 * Not part of the SPA entry; nothing here ships to production.
 */

import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { loadFenixMemoryVendor } from './fenix-lazy-host';

const Fixture = lazy(async () => {
  const module = await loadFenixMemoryVendor();
  const ApiContext = module.FenixMemoryApiContext;
  const MemoryDetailPanel = module.MemoryDetailPanel;
  // The fixture deliberately supplies an adapter that rejects every call: the
  // panel's row-summary branch still renders the masked text without network.
  const failing = (method: string) => () => Promise.reject(new Error(`fixture ${method}`));
  const api = {
    getStatus: failing('getStatus'),
    getGraph: failing('getGraph'),
    getBankStats: failing('getBankStats'),
    getMemory: failing('getMemory'),
    listEntities: failing('listEntities'),
    getEntity: failing('getEntity'),
    getEntityGraph: failing('getEntityGraph'),
  };

  function Panels() {
    return (
      <ApiContext.Provider value={api}>
        <div className="fenix-memory-root">
          <div data-testid="fenix-default-panel">
            <MemoryDetailPanel memory={MEMORY} onClose={() => undefined} />
          </div>
          <div data-testid="fenix-compact-panel">
            <MemoryDetailPanel memory={MEMORY} onClose={() => undefined} compact />
          </div>
        </div>
      </ApiContext.Provider>
    );
  }

  return { default: Panels };
});

const SECRET_TEXT =
  'fixture: ?token=e2e-query-secret&mode=1, Bearer e2e-bearer-secret, password=e2e-password';

const MEMORY = {
  id: 'mem-fenix-render-fixture',
  text: SECRET_TEXT,
  context: 'render fixture',
  occurred_start: null,
  occurred_end: null,
  mentioned_at: null,
  tags: ['fixture'],
  entities: ['fixture'],
  fact_type: 'world',
};

const rootElement = document.getElementById('fenix-render-root');

if (rootElement) {
  createRoot(rootElement).render(
    <Suspense fallback={<div data-testid="fenix-render-loading">loading</div>}>
      <Fixture />
    </Suspense>,
  );
}
