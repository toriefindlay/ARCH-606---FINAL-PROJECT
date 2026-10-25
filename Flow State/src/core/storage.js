// Browser storage (IndexedDB). Stores:
//   osm       download cache for map data
//   sites     saved-site metadata (small, listed on the start screen)
//   siteData  saved map data, kept apart so listing sites doesn't load megabytes
//   models    imported .3dm bytes for a saved site

export const CACHE_TTL = 7 * 24 * 3600 * 1000;

let dbPromise = null;
function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const rq = indexedDB.open("flow-state", 3);
    rq.onupgradeneeded = () => {
      for (const name of ["osm", "sites", "siteData", "models"]) {
        if (!rq.result.objectStoreNames.contains(name)) rq.result.createObjectStore(name);
      }
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => {
      dbPromise = null;
      reject(rq.error);
    };
  });
  return dbPromise;
}

const request = (rq) =>
  new Promise((resolve, reject) => {
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });

const complete = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

// The download cache is an optimisation only: any failure just means a normal fetch.
export async function cacheGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const rq = db.transaction("osm").objectStore("osm").get(key);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cachePut(key, value) {
  try {
    const db = await openDB();
    db.transaction("osm", "readwrite").objectStore("osm").put(value, key);
  } catch { /* ignore */ }
}

// ---- saved sites

// meta: small record shown in the list; data: raw map data; modelRec: { name, buffer } or null.
export async function putSite(meta, data, modelRec) {
  const db = await openDB();
  const tx = db.transaction(["sites", "siteData", "models"], "readwrite");
  tx.objectStore("sites").put(meta, meta.id);
  tx.objectStore("siteData").put(data, meta.id);
  if (modelRec) tx.objectStore("models").put(modelRec, meta.id);
  else tx.objectStore("models").delete(meta.id);
  await complete(tx);
}

export async function getSite(id) {
  const db = await openDB();
  const [meta, data, mdl] = await Promise.all([
    request(db.transaction("sites").objectStore("sites").get(id)),
    request(db.transaction("siteData").objectStore("siteData").get(id)),
    request(db.transaction("models").objectStore("models").get(id)),
  ]);
  if (!meta || !data) throw new Error("That saved site is missing its data.");
  return { ...meta, data, modelBuffer: mdl?.buffer ?? null };
}

export async function listSites() {
  const db = await openDB();
  const sites = await request(db.transaction("sites").objectStore("sites").getAll());
  return sites.sort((a, b) => b.savedAt - a.savedAt);
}

export async function removeSite(id) {
  const db = await openDB();
  const tx = db.transaction(["sites", "siteData", "models"], "readwrite");
  for (const store of ["sites", "siteData", "models"]) tx.objectStore(store).delete(id);
  await complete(tx).catch(() => {});
}
