/**
 * "all storage local": remember the last-loaded MIDI file in IndexedDB
 * so it can be restored on the next visit.
 */

const DB_NAME = "midiplayer";
const STORE = "files";
const LAST_KEY = "last-song";

export interface StoredFile {
  name: string;
  data: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB error"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();

  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB error"));
    });
  } finally {
    db.close();
  }
}

export async function saveLastFile(file: StoredFile): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.put(file, LAST_KEY));
  } catch {
    // storage is best-effort (private browsing, quota, ...)
  }
}

export async function loadLastFile(): Promise<StoredFile | null> {
  try {
    const result = await withStore(
      "readonly",
      (store) => store.get(LAST_KEY) as IDBRequest<StoredFile | undefined>,
    );

    return result ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL through the Cache API so large assets (the ~9.7 MB
 * soundfont) download only once.
 */
export async function cachedFetch(
  url: string,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  let cache: Cache | undefined;

  try {
    cache = await caches.open("midiplayer-assets");

    const hit = await cache.match(url);

    if (hit) {
      onProgress?.(1);

      return hit.arrayBuffer();
    }
  } catch {
    // Cache API unavailable (http, private browsing) — plain fetch below
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get("content-length") ?? 0);

  if (!response.body || !total) {
    const data = await response.arrayBuffer();

    await cache?.put(url, new Response(data.slice(0)));

    return data;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded / total);
  }

  const result = new Uint8Array(loaded);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  await cache?.put(url, new Response(result.slice().buffer));

  return result.buffer;
}
