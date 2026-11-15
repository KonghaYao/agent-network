/**
 * Test-only lazy-load host for the vendored Fenix memory UI.
 *
 * This file is not part of the SPA entry. `scripts/verify-memory-fenix-vendor.ts`
 * builds it in isolation to prove that `src/web/features/memory/fenix/` lands in a
 * separate dynamic chunk and that its scoped Tailwind CSS is emitted without
 * preflight.
 */

import { lazy } from 'react';

export const loadFenixMemoryVendor = () => import('../../src/web/features/memory/fenix');

export const FenixMemoryVendor = lazy(async () => {
  const module = await loadFenixMemoryVendor();
  return { default: module.MemoriesPage };
});
