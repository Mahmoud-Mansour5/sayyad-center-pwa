/**
 * db.js
 * -------------------------------------------------------------
 * IndexedDB wrapper for the Al-Sayyad Educational Center PWA.
 * Handles:
 *   - "students"  store: master roster (seeded once, cached offline)
 *   - "records"   store: attendance/grades/notes entries created by
 *                 secretaries, each with a sync `status`:
 *                     "pending"  -> saved offline, not yet approved
 *                     "approved" -> approved by master & sent to API
 *                     "failed"   -> approved but API push failed (retry)
 *
 * Falls back to an in-memory + localStorage shim automatically if
 * IndexedDB is unavailable (e.g. private browsing edge cases), so the
 * rest of the app never has to know which storage engine is active.
 * -------------------------------------------------------------
 */

const DB_NAME = 'sayyad_center_db';
const DB_VERSION = 1;
const STORE_STUDENTS = 'students';
const STORE_RECORDS = 'records';
const STORE_META = 'meta';

class SayyadDB {
  constructor() {
    this._db = null;
    this._ready = null;
    this._useFallback = false;
    this._fallbackData = { students: [], records: [], meta: {} };
  }

  /* ------------------------------------------------------------ */
  /* Initialization                                                */
  /* ------------------------------------------------------------ */

  init() {
    if (this._ready) return this._ready;

    this._ready = new Promise((resolve) => {
      if (!('indexedDB' in window)) {
        console.warn('[SayyadDB] IndexedDB غير متاح، سيتم استخدام التخزين المحلي البديل.');
        this._useFallback = true;
        this._loadFallbackFromLocalStorage();
        resolve();
        return;
      }

      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        console.warn('[SayyadDB] فشل فتح IndexedDB، التحويل للتخزين البديل.', err);
        this._useFallback = true;
        this._loadFallbackFromLocalStorage();
        resolve();
        return;
      }

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORE_STUDENTS)) {
          const studentsStore = db.createObjectStore(STORE_STUDENTS, { keyPath: 'id' });
          studentsStore.createIndex('name', 'name', { unique: false });
          studentsStore.createIndex('group', 'group', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          const recordsStore = db.createObjectStore(STORE_RECORDS, { keyPath: 'recordId' });
          recordsStore.createIndex('studentId', 'studentId', { unique: false });
          recordsStore.createIndex('status', 'status', { unique: false });
          recordsStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        resolve();
      };

      request.onerror = (event) => {
        console.warn('[SayyadDB] خطأ في IndexedDB، التحويل للتخزين البديل.', event.target.error);
        this._useFallback = true;
        this._loadFallbackFromLocalStorage();
        resolve();
      };
    });

    return this._ready;
  }

  /* ------------------------------------------------------------ */
  /* Fallback (localStorage) helpers                               */
  /* ------------------------------------------------------------ */

  _loadFallbackFromLocalStorage() {
    try {
      const raw = localStorage.getItem('sayyad_fallback_db');
      if (raw) this._fallbackData = JSON.parse(raw);
    } catch (err) {
      console.warn('[SayyadDB] تعذّرت قراءة التخزين البديل', err);
    }
  }

  _persistFallback() {
    try {
      localStorage.setItem('sayyad_fallback_db', JSON.stringify(this._fallbackData));
    } catch (err) {
      console.warn('[SayyadDB] تعذّر حفظ التخزين البديل', err);
    }
  }

  /* ------------------------------------------------------------ */
  /* Low-level transaction helper (IndexedDB path)                 */
  /* ------------------------------------------------------------ */

  _tx(storeName, mode = 'readonly') {
    return this._db.transaction(storeName, mode).objectStore(storeName);
  }

  /* ================================================================
     STUDENTS
     ================================================================ */

  async seedStudentsIfEmpty(seedList) {
    await this.init();
    const existing = await this.getAllStudents();
    if (existing.length > 0) return existing;

    if (this._useFallback) {
      this._fallbackData.students = seedList;
      this._persistFallback();
      return seedList;
    }

    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS, 'readwrite');
      seedList.forEach((s) => store.put(s));
      const tx = store.transaction;
      tx.oncomplete = () => resolve(seedList);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllStudents() {
    await this.init();
    if (this._useFallback) return [...this._fallbackData.students];

    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getStudent(id) {
    await this.init();
    if (this._useFallback) {
      return this._fallbackData.students.find((s) => s.id === id) || null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /* ================================================================
     RECORDS (offline queue / attendance+grades entries)
     ================================================================ */

  /**
   * Create or overwrite a record. Used when the secretary hits "save".
   * Each save for a given student on the same day overwrites the
   * previous pending record for that student/day, so re-saving updates
   * rather than duplicating.
   */
  async upsertRecord(record) {
    await this.init();
    if (this._useFallback) {
      const idx = this._fallbackData.records.findIndex((r) => r.recordId === record.recordId);
      if (idx >= 0) this._fallbackData.records[idx] = record;
      else this._fallbackData.records.push(record);
      this._persistFallback();
      return record;
    }

    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS, 'readwrite');
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = () => reject(req.error);
    });
  }

  async getAllRecords() {
    await this.init();
    if (this._useFallback) return [...this._fallbackData.records];

    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getRecordsByStatus(status) {
    const all = await this.getAllRecords();
    return all.filter((r) => r.status === status);
  }

  async getRecordByStudentToday(studentId, dateStr) {
    const all = await this.getAllRecords();
    return all.find((r) => r.studentId === studentId && r.dateKey === dateStr && r.status !== 'approved') || null;
  }

  async getRecord(recordId) {
    await this.init();
    if (this._useFallback) {
      return this._fallbackData.records.find((r) => r.recordId === recordId) || null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS);
      const req = store.get(recordId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteRecord(recordId) {
    await this.init();
    if (this._useFallback) {
      this._fallbackData.records = this._fallbackData.records.filter((r) => r.recordId !== recordId);
      this._persistFallback();
      return true;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS, 'readwrite');
      const req = store.delete(recordId);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async updateRecordStatus(recordId, status, extra = {}) {
    const record = await this.getRecord(recordId);
    if (!record) return null;
    const updated = { ...record, status, ...extra, updatedAt: Date.now() };
    return this.upsertRecord(updated);
  }

  /* ================================================================
     META (small key/value settings, e.g. last sync time)
     ================================================================ */

  async setMeta(key, value) {
    await this.init();
    if (this._useFallback) {
      this._fallbackData.meta[key] = value;
      this._persistFallback();
      return value;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_META, 'readwrite');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    });
  }

  async getMeta(key) {
    await this.init();
    if (this._useFallback) {
      return this._fallbackData.meta[key] ?? null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_META);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }
}

// Singleton instance used across the app.
const db = new SayyadDB();
