// ===== IndexedDB =====
const DB_NAME = 'TradingSimDB';
const DB_VER  = 3;
var db = null;

function openDB() {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('trades')) {
        const ts = d.createObjectStore('trades', { keyPath: 'id', autoIncrement: true });
        ts.createIndex('sessionId', 'sessionId');
        ts.createIndex('closeTime', 'closeTime');
      }
      if (!d.objectStoreNames.contains('sessions')) {
        const ss = d.createObjectStore('sessions', { keyPath: 'id' });
        ss.createIndex('startDate', 'startDate');
      }
      if (!d.objectStoreNames.contains('dataCache')) {
        d.createObjectStore('dataCache', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = e => { console.error('DB error:', e.target.error); resolve(null); };
    req.onblocked = () => { console.warn('DB blocked'); resolve(null); };
  });
}

function dbPut(store, data) {
  if (!db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

function dbAdd(store, data) {
  if (!db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).add(data);
    req.onsuccess = () => resolve(req.result);
    tx.onerror = e => reject(e.target.error);
  });
}

function saveDrawings() {
  if (!db) return;
  const tx = db.transaction('sessions', 'readwrite');
  const store = tx.objectStore('sessions');
  const req = store.get(sessionId);
  req.onsuccess = () => {
    const s = req.result;
    if (s) {
      s.drawings = {
        fibo: fiboSaved.map(f => ({ p1:f.p1, p2:f.p2, t1:f.t1, t2:f.t2 })),
        hline: hlineSaved.map(h => ({ price:h.price })),
        tline: tlineSaved.map(f => ({ p1:f.p1, p2:f.p2, t1:f.t1, t2:f.t2 }))
      };
      store.put(s);
    }
  };
}
