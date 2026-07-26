const DATABASE_NAME = "tfvision-agent-media";
const DATABASE_VERSION = 1;
const STORE_NAME = "images";

type StoredAgentMedia = {
  id: string;
  blob: Blob;
  updatedAt: number;
};

type AgentMediaEntry = {
  id: string;
  source: Blob | string;
};

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开 Agent 媒体存储"));
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Agent 媒体存储操作失败"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Agent 媒体存储事务失败"));
    transaction.onabort = () => reject(transaction.error || new Error("Agent 媒体存储事务已取消"));
  });
}

export async function persistAgentMedia(entries: AgentMediaEntry[]) {
  if (!entries.length || typeof window === "undefined" || !window.indexedDB) return;
  const uniqueEntries = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
  const prepared = await Promise.all(
    uniqueEntries.map(async (entry): Promise<StoredAgentMedia> => ({
      id: entry.id,
      blob:
        entry.source instanceof Blob
          ? entry.source
          : await fetch(entry.source).then((response) => {
              if (!response.ok) throw new Error(`无法读取媒体（HTTP ${response.status}）`);
              return response.blob();
            }),
      updatedAt: Date.now(),
    })),
  );
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  for (const item of prepared) store.put(item);
  await transactionDone(transaction);
}

export async function loadAgentMedia(ids: string[]) {
  const result = new Map<string, Blob>();
  if (!ids.length || typeof window === "undefined" || !window.indexedDB) return result;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const uniqueIds = [...new Set(ids)];
  const values = await Promise.all(
    uniqueIds.map((id) => requestResult(store.get(id) as IDBRequest<StoredAgentMedia | undefined>)),
  );
  values.forEach((value) => {
    if (value?.blob) result.set(value.id, value.blob);
  });
  return result;
}

export async function deleteAgentMedia(ids: string[]) {
  if (!ids.length || typeof window === "undefined" || !window.indexedDB) return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  for (const id of new Set(ids)) store.delete(id);
  await transactionDone(transaction);
}
