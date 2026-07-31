import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto'; // jsdom has no real IndexedDB — this is a genuine in-memory implementation, not a shallow mock, so src/lib/offline-db.ts's actual queries run for real in tests.
