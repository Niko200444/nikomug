
// === db.js (IndexedDB wrapper) ===
// Lightweight promise-based IndexedDB helpers for the quiz app.
// Stores:
// - kv: generic key/value
// - answers: key = questionId (number), value = { index, value, updatedAt }
// - flags: key = questionId, value = true
// - notes: key = questionId, value = { text, updatedAt }
// - meta: key = string, value = any

(function(){
  const DB_NAME = 'quizdb';
  const DB_VERSION = 1;
  let _dbPromise = null;

  function openDB(){
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
        if (!db.objectStoreNames.contains('answers')) {
          db.createObjectStore('answers'); // key: questionId (string/number)
        }
        if (!db.objectStoreNames.contains('flags')) {
          db.createObjectStore('flags');
        }
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(db, store, mode='readonly'){
    return db.transaction(store, mode).objectStore(store);
  }

  async function get(store, key){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = tx(db, store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async function set(store, key, val){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = tx(db, store, 'readwrite').put(val, key);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
  }

  async function del(store, key){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = tx(db, store, 'readwrite').delete(key);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
  }

  async function clear(store){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = tx(db, store, 'readwrite').clear();
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
  }

  async function entries(store){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const res = [];
      const cursorReq = tx(db, store).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          res.push([cursor.key, cursor.value]);
          cursor.continue();
        } else resolve(res);
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  // Expose globally
  window.IDB = { openDB, get, set, del, clear, entries };
})();
