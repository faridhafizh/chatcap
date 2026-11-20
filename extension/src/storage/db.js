// IndexedDB storage — replaces storage.py's atomic whole-file rewrites.
// Both the offscreen poller and the side panel use this same database.

const DB_NAME = "chatcap";
const VERSION = 1;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("messages")) {
        const store = db.createObjectStore("messages", { keyPath: ["sessionId", "key"] });
        store.createIndex("sessionId", "sessionId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function createSession(meta) {
  const db = await openDb();
  const session = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    count: 0,
    status: "running",
    ...meta,
  };
  await request(db.transaction("sessions", "readwrite").objectStore("sessions").put(session));
  return session;
}

export async function updateSession(id, patch) {
  const db = await openDb();
  const current = await request(db.transaction("sessions", "readonly").objectStore("sessions").get(id));
  if (!current) return null;
  const next = { ...current, ...patch };
  await request(db.transaction("sessions", "readwrite").objectStore("sessions").put(next));
  return next;
}

export async function appendMessages(sessionId, messages, startSeq = 0) {
  if (!messages.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    messages.forEach((msg, i) => {
      const seq = startSeq + i;
      store.put({ ...msg, sessionId, key: msg.message_id || `${sessionId}-${seq}`, seq });
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSession(id) {
  const db = await openDb();
  return (await request(db.transaction("sessions", "readonly").objectStore("sessions").get(id))) || null;
}

export async function listSessions() {
  const db = await openDb();
  const all = await request(db.transaction("sessions", "readonly").objectStore("sessions").getAll());
  return all.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export async function getMessages(sessionId) {
  const db = await openDb();
  const index = db.transaction("messages", "readonly").objectStore("messages").index("sessionId");
  const rows = await request(index.getAll(sessionId));
  return rows.sort((a, b) => a.seq - b.seq)
    .map(({ sessionId: _s, key: _k, seq: _q, ...msg }) => msg);
}

export async function deleteSession(id) {
  const db = await openDb();
  // Read keys in their own transaction: an IDB transaction closes as soon as
  // its last request completes, so writes must happen in a fresh one.
  const index = db.transaction("messages", "readonly").objectStore("messages").index("sessionId");
  const keys = await request(index.getAllKeys(id));
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["sessions", "messages"], "readwrite");
    tx.objectStore("sessions").delete(id);
    const store = tx.objectStore("messages");
    keys.forEach((key) => store.delete(key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
