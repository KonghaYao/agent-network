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

const MemoryDetailPanel = lazy(async () => {
  const module = await loadFenixMemoryVendor();
  return { default: module.MemoryDetailPanel };
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

function Panels() {
  return (
    <div className="fenix-memory-root">
      <div data-testid="fenix-default-panel">
        <MemoryDetailPanel memory={MEMORY} onClose={() => undefined} />
      </div>
      <div data-testid="fenix-compact-panel">
        <MemoryDetailPanel memory={MEMORY} onClose={() => undefined} compact />
      </div>
    </div>
  );
}

const rootElement = document.getElementById('fenix-render-root');

if (rootElement) {
  createRoot(rootElement).render(
    <Suspense fallback={<div data-testid="fenix-render-loading">loading</div>}>
      <Panels />
    </Suspense>,
  );
}
