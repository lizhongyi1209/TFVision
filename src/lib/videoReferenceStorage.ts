// Browser-side storage for video-node reference files. The node keeps only a
// lightweight key and a temporary object URL; the original Blob stays local
// until the user actually submits a generation request.

const DB_NAME = "tfvision-video-references";
const STORE_NAME = "blobs";
const DB_VERSION = 1;

const runtimeBlobs = new Map<string, Blob>();
let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地素材存储初始化失败"));
  });
  return databasePromise;
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地素材存储操作失败"));
  });
}

export async function rememberVideoReferenceBlob(key: string, blob: Blob): Promise<void> {
  runtimeBlobs.set(key, blob);
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  await runRequest(transaction.objectStore(STORE_NAME).put(blob, key));
}

export async function readVideoReferenceBlob(key: string): Promise<Blob | null> {
  const runtimeBlob = runtimeBlobs.get(key);
  if (runtimeBlob) return runtimeBlob;
  if (typeof indexedDB === "undefined") return null;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const blob = await runRequest(transaction.objectStore(STORE_NAME).get(key));
  if (!(blob instanceof Blob)) return null;
  runtimeBlobs.set(key, blob);
  return blob;
}

export async function forgetVideoReferenceBlob(key: string): Promise<void> {
  runtimeBlobs.delete(key);
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  await runRequest(transaction.objectStore(STORE_NAME).delete(key));
}
