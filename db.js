/**
 * db.js
 * -------------------------------------------------------------
 * IndexedDB wrapper for مركز الأستاذ محمود الصياد للتطوير التعليمي
 *
 * Stores:
 *   - "students"   master roster, cached from API. Offline-created students
 *                  carry syncStatus:'pending_creation' until pushed.
 *   - "records"    attendance + grades entries. Status lifecycle:
 *                      "draft"    → Present clicked; timestamp captured.
 *                      "pending"  → إرسال للاعتماد clicked; grades attached.
 *                      "approved" → approved by admin; queued for API push.
 *                      "synced"   → successfully pushed to API.
 *                      "failed"   → approved but API push failed; will retry.
 *   - "settings"   dropdown option lists (branches, years, days, times).
 *   - "meta"       small key/value operational data (last sync time).
 *
 * NOTE: "secretaries" store has been REMOVED (Change #1 — single admin user).
 *       PIN authentication is now handled via a hardcoded value; no DB store needed.
 *
 * Falls back to an in-memory + localStorage shim if IndexedDB is unavailable.
 * -------------------------------------------------------------
 */

const DB_NAME    = 'sayyad_center_db';
const DB_VERSION = 3;               // bumped from 2 to trigger onupgradeneeded

const STORE_STUDENTS = 'students';
const STORE_RECORDS  = 'records';
const STORE_META     = 'meta';
const STORE_SETTINGS = 'settings';

class SayyadDB {
  constructor() {
    this._db          = null;
    this._ready       = null;
    this._useFallback = false;
    this._fallbackData = {
      students: [],
      records:  [],
      meta:     {},
      settings: [],
    };
  }

  /* ------------------------------------------------------------ */
  /* Initialization                                                */
  /* ------------------------------------------------------------ */

  init() {
    if (this._ready) return this._ready;

    this._ready = new Promise((resolve) => {
      if (!('indexedDB' in window)) {
        console.warn('[SayyadDB] IndexedDB غير متاح — تفعيل التخزين البديل.');
        this._useFallback = true;
        this._loadFallbackFromLocalStorage();
        resolve();
        return;
      }

      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        console.warn('[SayyadDB] فشل فتح IndexedDB.', err);
        this._useFallback = true;
        this._loadFallbackFromLocalStorage();
        resolve();
        return;
      }

      request.onupgradeneeded = (event) => {
        const db      = event.target.result;
        const oldVer  = event.oldVersion;

        /* Students store */
        if (!db.objectStoreNames.contains(STORE_STUDENTS)) {
          const ss = db.createObjectStore(STORE_STUDENTS, { keyPath: 'id' });
          ss.createIndex('name',  'name',  { unique: false });
          ss.createIndex('group', 'group', { unique: false });
          ss.createIndex('year',  'year',  { unique: false });
        }

        /* Records store */
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          const rs = db.createObjectStore(STORE_RECORDS, { keyPath: 'recordId' });
          rs.createIndex('studentId', 'studentId', { unique: false });
          rs.createIndex('status',    'status',    { unique: false });
          rs.createIndex('createdAt', 'createdAt', { unique: false });
          rs.createIndex('dateKey',   'dateKey',   { unique: false });
        }

        /* Meta store */
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }

        /* Settings store */
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }

        /* ── REMOVED: secretaries store (Change #1) ──
         * If upgrading from v2, drop the old store to keep things clean. */
        if (oldVer < 3 && db.objectStoreNames.contains('secretaries')) {
          db.deleteObjectStore('secretaries');
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        resolve();
      };

      request.onerror = (event) => {
        console.warn('[SayyadDB] خطأ IndexedDB — تفعيل التخزين البديل.', event.target.error);
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
      if (raw) this._fallbackData = { ...this._fallbackData, ...JSON.parse(raw) };
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
  /* Low-level transaction helper                                  */
  /* ------------------------------------------------------------ */

  _tx(storeName, mode = 'readonly') {
    return this._db.transaction(storeName, mode).objectStore(storeName);
  }

  /* ================================================================
     STUDENTS
     ================================================================ */

  /**
   * Replace the full local roster with a fresh server copy.
   * Locally-created students still pending creation are preserved.
   */
  async replaceAllStudents(freshList) {
    await this.init();
    const existing    = await this.getAllStudents();
    const stillPending = existing.filter((s) => s.syncStatus === 'pending_creation');
    const merged      = [...freshList, ...stillPending];

    if (this._useFallback) {
      this._fallbackData.students = merged;
      this._persistFallback();
      return merged;
    }

    return new Promise((resolve, reject) => {
      const store    = this._tx(STORE_STUDENTS, 'readwrite');
      const clearReq = store.clear();
      clearReq.onsuccess = () => { merged.forEach((s) => store.put(s)); };
      const tx = store.transaction;
      tx.oncomplete = () => resolve(merged);
      tx.onerror    = () => reject(tx.error);
    });
  }

  async upsertStudent(student) {
    await this.init();
    if (this._useFallback) {
      const idx = this._fallbackData.students.findIndex((s) => s.id === student.id);
      if (idx >= 0) this._fallbackData.students[idx] = student;
      else          this._fallbackData.students.push(student);
      this._persistFallback();
      return student;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS, 'readwrite');
      const req   = store.put(student);
      req.onsuccess = () => resolve(student);
      req.onerror   = () => reject(req.error);
    });
  }

  async getAllStudents() {
    await this.init();
    if (this._useFallback) return [...this._fallbackData.students];
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS);
      const req   = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  async getStudent(id) {
    await this.init();
    if (this._useFallback) {
      return this._fallbackData.students.find((s) => s.id === id) || null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS);
      const req   = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  async getStudentsPendingCreation() {
    const all = await this.getAllStudents();
    return all.filter((s) => s.syncStatus === 'pending_creation');
  }

  /* ================================================================
     RECORDS
     ================================================================ */

  async upsertRecord(record) {
    await this.init();
    if (this._useFallback) {
      const idx = this._fallbackData.records.findIndex((r) => r.recordId === record.recordId);
      if (idx >= 0) this._fallbackData.records[idx] = record;
      else          this._fallbackData.records.push(record);
      this._persistFallback();
      return record;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS, 'readwrite');
      const req   = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror   = () => reject(req.error);
    });
  }

  async getAllRecords() {
    await this.init();
    if (this._useFallback) return [...this._fallbackData.records];
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS);
      const req   = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  async getRecordsByStatus(status) {
    const all = await this.getAllRecords();
    return all.filter((r) => r.status === status);
  }

  /**
   * Returns today's record for a student that is NOT yet fully approved/synced.
   * Includes 'draft' and 'pending' so the two-step flow can continue from where
   * the user left off.
   */
  async getRecordByStudentToday(studentId, dateStr) {
    const all = await this.getAllRecords();
    return all.find(
      (r) => r.studentId === studentId &&
             r.dateKey   === dateStr   &&
             r.status    !== 'approved' &&
             r.status    !== 'synced'
    ) || null;
  }

  async getRecord(recordId) {
    await this.init();
    if (this._useFallback) {
      return this._fallbackData.records.find((r) => r.recordId === recordId) || null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS);
      const req   = store.get(recordId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
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
      const req   = store.delete(recordId);
      req.onsuccess = () => resolve(true);
      req.onerror   = () => reject(req.error);
    });
  }

  async updateRecordStatus(recordId, status, extra = {}) {
    const record = await this.getRecord(recordId);
    if (!record) return null;
    const updated = { ...record, status, ...extra, updatedAt: Date.now() };
    return this.upsertRecord(updated);
  }

  /* ================================================================
     SETTINGS (branches, years, days, times)
     ================================================================ */

  async setSetting(key, value) {
    await this.init();
    if (this._useFallback) {
      const idx   = this._fallbackData.settings.findIndex((s) => s.key === key);
      const entry = { key, value };
      if (idx >= 0) this._fallbackData.settings[idx] = entry;
      else          this._fallbackData.settings.push(entry);
      this._persistFallback();
      return value;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SETTINGS, 'readwrite');
      const req   = store.put({ key, value });
      req.onsuccess = () => resolve(value);
      req.onerror   = () => reject(req.error);
    });
  }

  async getSetting(key) {
    await this.init();
    if (this._useFallback) {
      const found = this._fallbackData.settings.find((s) => s.key === key);
      return found ? found.value : null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SETTINGS);
      const req   = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror   = () => reject(req.error);
    });
  }

  async getAllSettings() {
    await this.init();
    if (this._useFallback) {
      const obj = {};
      this._fallbackData.settings.forEach((s) => { obj[s.key] = s.value; });
      return obj;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SETTINGS);
      const req   = store.getAll();
      req.onsuccess = () => {
        const obj = {};
        (req.result || []).forEach((s) => { obj[s.key] = s.value; });
        resolve(obj);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /* ================================================================
     META
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
      const req   = store.put({ key, value });
      req.onsuccess = () => resolve(value);
      req.onerror   = () => reject(req.error);
    });
  }

  async getMeta(key) {
    await this.init();
    if (this._useFallback) {
      return this._fallbackData.meta[key] ?? null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_META);
      const req   = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror   = () => reject(req.error);
    });
  }
}

// Singleton instance used across the app.
const db = new SayyadDB();