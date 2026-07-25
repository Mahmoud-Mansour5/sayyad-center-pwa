/**
 * db.js
 * -------------------------------------------------------------
 * IndexedDB wrapper for the Al-Sayyad Educational Center PWA.
 * Handles:
 *   - "students"    store: master roster, fetched from the API and
 *                   cached offline. New students created offline by a
 *                   secretary are stored with syncStatus:'pending_creation'
 *                   until pushed to the server.
 *   - "records"     store: attendance/grades/notes entries created by
 *                   secretaries, each with a sync `status`:
 *                       "pending"  -> saved offline, not yet approved
 *                       "approved" -> approved by master & sent to API
 *                       "failed"   -> approved but API push failed (retry)
 *   - "settings"    store: dropdown option lists (Branches, Years, Days,
 *                   Times, Groups...) fetched from the API and cached.
 *   - "secretaries" store: role-based accounts (id, name, pin, role,
 *                   allowedGroups) fetched from the API and cached.
 *                   Login authenticates against this store. Any local
 *                   edits (e.g. master updating allowedGroups, or adding
 *                   a new account) are flagged with pendingSync:true for
 *                   the sync engine.
 *   - "meta"        store: small key/value operational data (last sync).
 *
 * Falls back to an in-memory + localStorage shim automatically if
 * IndexedDB is unavailable (e.g. private browsing edge cases), so the
 * rest of the app never has to know which storage engine is active.
 * -------------------------------------------------------------
 */

const DB_NAME = 'sayyad_center_db';
const DB_VERSION = 2;
const STORE_STUDENTS = 'students';
const STORE_RECORDS = 'records';
const STORE_META = 'meta';
const STORE_SETTINGS = 'settings';
const STORE_SECRETARIES = 'secretaries';

class SayyadDB {
  constructor() {
    this._db = null;
    this._ready = null;
    this._useFallback = false;
    this._fallbackData = {
      students: [],
      records: [],
      meta: {},
      settings: [],
      secretaries: [],
    };
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

        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          // keyPath 'key' e.g. 'branches' | 'years' | 'days' | 'times' | 'groups'
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains(STORE_SECRETARIES)) {
          const secStore = db.createObjectStore(STORE_SECRETARIES, { keyPath: 'id' });
          secStore.createIndex('pin', 'pin', { unique: false });
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
  /* Low-level transaction helper (IndexedDB path)                 */
  /* ------------------------------------------------------------ */

  _tx(storeName, mode = 'readonly') {
    return this._db.transaction(storeName, mode).objectStore(storeName);
  }

  /* ================================================================
     STUDENTS
     ================================================================ */

  /**
   * Replace the entire local roster with a fresh copy from the API.
   * Students that were created locally and are still pending creation
   * (not yet acknowledged by the server) are preserved so they aren't
   * wiped out by a refresh that raced ahead of the sync.
   */
  async replaceAllStudents(freshList) {
    await this.init();
    const existing = await this.getAllStudents();
    const stillPending = existing.filter((s) => s.syncStatus === 'pending_creation');

    const merged = [...freshList, ...stillPending];

    if (this._useFallback) {
      this._fallbackData.students = merged;
      this._persistFallback();
      return merged;
    }

    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS, 'readwrite');
      const clearReq = store.clear();
      clearReq.onsuccess = () => {
        merged.forEach((s) => store.put(s));
      };
      const tx = store.transaction;
      tx.oncomplete = () => resolve(merged);
      tx.onerror = () => reject(tx.error);
    });
  }

  async upsertStudent(student) {
    await this.init();
    if (this._useFallback) {
      const idx = this._fallbackData.students.findIndex((s) => s.id === student.id);
      if (idx >= 0) this._fallbackData.students[idx] = student;
      else this._fallbackData.students.push(student);
      this._persistFallback();
      return student;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS, 'readwrite');
      const req = store.put(student);
      req.onsuccess = () => resolve(student);
      req.onerror = () => reject(req.error);
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

  async getStudentsPendingCreation() {
    const all = await this.getAllStudents();
    return all.filter((s) => s.syncStatus === 'pending_creation');
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
     SETTINGS (dropdown option lists: branches, years, days, times, groups)
     ================================================================ */

  async setSetting(key, value) {
    await this.init();
    if (this._useFallback) {
      const idx = this._fallbackData.settings.findIndex((s) => s.key === key);
      const entry = { key, value };
      if (idx >= 0) this._fallbackData.settings[idx] = entry;
      else this._fallbackData.settings.push(entry);
      this._persistFallback();
      return value;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SETTINGS, 'readwrite');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
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
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
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
      const req = store.getAll();
      req.onsuccess = () => {
        const obj = {};
        (req.result || []).forEach((s) => { obj[s.key] = s.value; });
        resolve(obj);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /* ================================================================
     SECRETARIES (role-based accounts used for PIN login)
     ================================================================ */

  async replaceAllSecretaries(freshList) {
    await this.init();
    if (this._useFallback) {
      this._fallbackData.secretaries = freshList;
      this._persistFallback();
      return freshList;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SECRETARIES, 'readwrite');
      const clearReq = store.clear();
      clearReq.onsuccess = () => {
        freshList.forEach((s) => store.put(s));
      };
      const tx = store.transaction;
      tx.oncomplete = () => resolve(freshList);
      tx.onerror = () => reject(tx.error);
    });
  }

  async upsertSecretary(secretary) {
    await this.init();
    if (this._useFallback) {
      const idx = this._fallbackData.secretaries.findIndex((s) => s.id === secretary.id);
      if (idx >= 0) this._fallbackData.secretaries[idx] = secretary;
      else this._fallbackData.secretaries.push(secretary);
      this._persistFallback();
      return secretary;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SECRETARIES, 'readwrite');
      const req = store.put(secretary);
      req.onsuccess = () => resolve(secretary);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteSecretary(secretaryId) {
    await this.init();
    if (this._useFallback) {
      this._fallbackData.secretaries = this._fallbackData.secretaries.filter((s) => s.id !== secretaryId);
      this._persistFallback();
      return true;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SECRETARIES, 'readwrite');
      const req = store.delete(secretaryId);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async getAllSecretaries() {
    await this.init();
    if (this._useFallback) return [...this._fallbackData.secretaries];
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SECRETARIES);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getSecretaryByPin(pin) {
    const all = await this.getAllSecretaries();
    return all.find((s) => String(s.pin) === String(pin)) || null;
  }

  async getSecretaryById(id) {
    await this.init();
    if (this._useFallback) {
      return this._fallbackData.secretaries.find((s) => s.id === id) || null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SECRETARIES);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
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
