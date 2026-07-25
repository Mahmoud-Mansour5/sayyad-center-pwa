/**
 * app.js
 * -------------------------------------------------------------
 * Core application logic for مركز الأستاذ محمود الصياد للتطوير التعليمي
 *
 *  - PIN authentication against secretaries cached in IndexedDB
 *  - Dynamic data: students / settings / secretaries fetched from API
 *  - Secretary view: search, quick attendance, grades/notes, offline save
 *  - Add-Student (offline-first, pending_creation flow)
 *  - Role-Based Access Control: secretaries only see their allowedGroups
 *  - Master view: stats + combined pending-approvals queue + secretary mgmt
 *  - Offline-first queue in IndexedDB (via db.js)
 *  - Auto background sync to an API endpoint when online
 * -------------------------------------------------------------
 */

(() => {
  'use strict';

  /* =====================================================================
     CONFIG
     ===================================================================== */

  const CONFIG = {
    // Replace with your real backend endpoint (REST API / Apps Script / etc).
    API_ENDPOINT: 'https://script.google.com/macros/s/AKfycbwrBXqCM3POhflij36kfPMLMi22CV9U1lUywb0Kv_ADWssxvNWW-YPEw7-UzC54Jyiz/exec',

    PIN_LENGTH: 4,

    SYNC_RETRY_INTERVAL_MS: 30000,
    TOAST_DURATION_MS: 3200,
  };

  // Local fallback lists used only if the settings store has nothing
  // cached yet (e.g. very first offline install with no prior sync).
  const FALLBACK_SETTINGS = {
    branches: ['الفرع الرئيسي'],
    years: ['الصف الأول الثانوي', 'الصف الثاني الثانوي', 'الصف الثالث الثانوي'],
    days: ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'],
    times: ['04:00 م', '06:00 م', '08:00 م'],
  };

  /* =====================================================================
     STATE
     ===================================================================== */

  const state = {
    currentUser: null,   // secretary/master profile loaded from IndexedDB
    students: [],
    records: [],         // all local records (pending + approved cache)
    settings: {},         // { branches:[], years:[], days:[], times:[] }
    secretaries: [],
    searchQuery: '',
    activeGroup: 'all',
    isSyncing: false,
    isFetchingInitialData: false,
    editingRecordId: null,
    pendingConfirmAction: null,
    activeSecretaryIdForPerms: null,
  };

  /* =====================================================================
     DOM SHORTCUTS
     ===================================================================== */

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  const els = {}; // populated on DOMContentLoaded

  /* =====================================================================
     UTILITIES
     ===================================================================== */

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function nowTimeLabel() {
    const d = new Date();
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  }

  function uid(prefix = 'rec') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function initials(name) {
    if (!name) return '؟';
    const parts = name.trim().split(/\s+/);
    return parts[0] ? parts[0][0] : '؟';
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️';
    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    els.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 250);
    }, CONFIG.TOAST_DURATION_MS);
  }

  function vibrate(pattern) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(pattern); } catch (_) { /* noop */ }
    }
  }

  function buildGroupLabel(year, branch) {
    if (!year && !branch) return '';
    if (year && branch) return `${year} - ${branch}`;
    return year || branch;
  }

  /* =====================================================================
     INIT
     ===================================================================== */

  document.addEventListener('DOMContentLoaded', async () => {
    cacheDom();
    bindStaticEvents();
    registerServiceWorker();

    await db.init();

    state.students = await db.getAllStudents();
    state.records = await db.getAllRecords();
    state.settings = await db.getAllSettings();
    state.secretaries = await db.getAllSecretaries();

    setupConnectivityWatchers();
    hideSplash();

    // If we're online and local caches look empty (first run), fetch now.
    if (navigator.onLine && (state.students.length === 0 || state.secretaries.length === 0)) {
      await fetchInitialData();
    }

    // Try to restore a previous session (role only, not sensitive).
    const savedUserId = sessionStorage.getItem('sayyad_session_user_id');
    if (savedUserId) {
      const restored = await db.getSecretaryById(savedUserId);
      if (restored) {
        state.currentUser = restored;
        enterApp();
      } else {
        showLogin();
      }
    } else {
      showLogin();
    }
  });

  function cacheDom() {
    els.splashScreen = $('#splashScreen');
    els.loginModal = $('#loginModal');
    els.pinDisplay = $('#pinDisplay');
    els.pinDots = $$('.pin-dot', els.pinDisplay);
    els.pinError = $('#pinError');
    els.pinPad = $('#pinPad');

    els.app = $('#app');
    els.syncBadge = $('#syncBadge');
    els.syncBadgeText = $('#syncBadgeText');
    els.logoutBtn = $('#logoutBtn');
    els.addStudentBtn = $('#addStudentBtn');
    els.manageSecretariesBtn = $('#manageSecretariesBtn');
    els.userRoleBadge = $('#userRoleBadge');
    els.userNameLabel = $('#userNameLabel');

    els.secretaryView = $('#secretaryView');
    els.masterView = $('#masterView');

    els.studentSearch = $('#studentSearch');
    els.clearSearchBtn = $('#clearSearchBtn');
    els.groupChips = $('#groupChips');
    els.studentsList = $('#studentsList');
    els.noResults = $('#noResults');
    els.pendingCountSecretary = $('#pendingCountSecretary');
    els.localQueueSummary = $('#localQueueSummary');

    els.statTotalStudents = $('#statTotalStudents');
    els.statActiveGroups = $('#statActiveGroups');
    els.statPendingApprovals = $('#statPendingApprovals');
    els.statApprovedToday = $('#statApprovedToday');
    els.approvalsList = $('#approvalsList');
    els.noApprovals = $('#noApprovals');
    els.approveAllBtn = $('#approveAllBtn');

    els.studentCardTemplate = $('#studentCardTemplate');
    els.approvalCardTemplate = $('#approvalCardTemplate');
    els.secretaryCardTemplate = $('#secretaryCardTemplate');

    els.editModal = $('#editModal');
    els.editModalClose = $('#editModalClose');
    els.editStudentName = $('#editStudentName');
    els.editPresentBtn = $('#editPresentBtn');
    els.editAbsentBtn = $('#editAbsentBtn');
    els.editHomeworkGrade = $('#editHomeworkGrade');
    els.editExamGrade = $('#editExamGrade');
    els.editNotes = $('#editNotes');
    els.saveEditBtn = $('#saveEditBtn');
    els.deleteRecordBtn = $('#deleteRecordBtn');

    els.confirmModal = $('#confirmModal');
    els.confirmTitle = $('#confirmTitle');
    els.confirmMessage = $('#confirmMessage');
    els.confirmCancelBtn = $('#confirmCancelBtn');
    els.confirmOkBtn = $('#confirmOkBtn');

    // Add student modal
    els.addStudentModal = $('#addStudentModal');
    els.addStudentModalClose = $('#addStudentModalClose');
    els.newStudentName = $('#newStudentName');
    els.newStudentPhone = $('#newStudentPhone');
    els.newStudentYear = $('#newStudentYear');
    els.newStudentBranch = $('#newStudentBranch');
    els.newStudentDay = $('#newStudentDay');
    els.newStudentTime = $('#newStudentTime');
    els.cancelAddStudentBtn = $('#cancelAddStudentBtn');
    els.saveNewStudentBtn = $('#saveNewStudentBtn');

    // Manage secretaries modal
    els.manageSecretariesModal = $('#manageSecretariesModal');
    els.manageSecretariesModalClose = $('#manageSecretariesModalClose');
    els.secretariesList = $('#secretariesList');
    els.noSecretaries = $('#noSecretaries');

    // Secretary permissions modal
    els.secretaryPermsModal = $('#secretaryPermsModal');
    els.secretaryPermsModalClose = $('#secretaryPermsModalClose');
    els.secretaryPermsName = $('#secretaryPermsName');
    els.secretaryGroupsChecklist = $('#secretaryGroupsChecklist');
    els.noGroupsForPerms = $('#noGroupsForPerms');
    els.cancelSecretaryPermsBtn = $('#cancelSecretaryPermsBtn');
    els.saveSecretaryPermsBtn = $('#saveSecretaryPermsBtn');

    els.toastContainer = $('#toastContainer');
  }

  function hideSplash() {
    setTimeout(() => {
      els.splashScreen.classList.add('fade-out');
    }, 450);
  }

  /* =====================================================================
     API — INITIAL DATA FETCH
     ===================================================================== */

  /**
   * Fetches students / settings / secretaries from CONFIG.API_ENDPOINT and
   * caches everything in IndexedDB. Safe to call multiple times — it's the
   * single source of truth refresh routine, called on load (if online) and
   * can be re-triggered manually (e.g. pull-to-refresh) in the future.
   *
   * If no real endpoint is configured yet, it fails gracefully and the app
   * keeps working from whatever is already cached locally (or empty state).
   */
  async function fetchInitialData() {
    if (state.isFetchingInitialData) return;
    if (!navigator.onLine) return;

    state.isFetchingInitialData = true;
    updateSyncBadge();

    try {
      if (!CONFIG.API_ENDPOINT || CONFIG.API_ENDPOINT.includes('REPLACE_WITH_YOUR_DEPLOYMENT_ID')) {
        console.info('[Init] لا يوجد رابط API مضبوط — سيعمل التطبيق بالبيانات المخزنة محليًا فقط (إن وجدت).');
        // Ensure settings has at least a usable fallback so dropdowns work.
        if (!state.settings || Object.keys(state.settings).length === 0) {
          for (const key of Object.keys(FALLBACK_SETTINGS)) {
            await db.setSetting(key, FALLBACK_SETTINGS[key]);
          }
          state.settings = await db.getAllSettings();
        }
        return;
      }

      const res = await fetch(`${CONFIG.API_ENDPOINT}?action=bootstrap`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Expected shape:
      // { students: [{id,name,group,year,branch,day,time,phone}],
      //   settings: { branches:[], years:[], days:[], times:[] },
      //   secretaries: [{id,name,pin,role,allowedGroups:[]}] }

      if (Array.isArray(data.students)) {
        state.students = await db.replaceAllStudents(data.students);
      }

      if (data.settings && typeof data.settings === 'object') {
        for (const key of Object.keys(data.settings)) {
          await db.setSetting(key, data.settings[key]);
        }
        state.settings = await db.getAllSettings();
      }

      if (Array.isArray(data.secretaries)) {
        state.secretaries = await db.replaceAllSecretaries(data.secretaries);
      }

      await db.setMeta('lastFetchAt', Date.now());
      console.info('[Init] تم تحديث البيانات من الخادم بنجاح.');
    } catch (err) {
      console.warn('[Init] تعذّر جلب البيانات الأولية من الخادم.', err);
      // Fall back to local settings so dropdowns aren't empty on first run.
      if (!state.settings || Object.keys(state.settings).length === 0) {
        for (const key of Object.keys(FALLBACK_SETTINGS)) {
          await db.setSetting(key, FALLBACK_SETTINGS[key]);
        }
        state.settings = await db.getAllSettings();
      }
    } finally {
      state.isFetchingInitialData = false;
      updateSyncBadge();
    }
  }

  /* =====================================================================
     PIN AUTHENTICATION
     ===================================================================== */

  let pinBuffer = '';

  function showLogin() {
    pinBuffer = '';
    renderPinDots();
    els.pinError.classList.add('hidden');
    els.loginModal.classList.remove('hidden');
    els.loginModal.setAttribute('aria-hidden', 'false');
    els.app.classList.add('hidden');
  }

  function renderPinDots() {
    els.pinDots.forEach((dot, i) => {
      dot.classList.toggle('filled', i < pinBuffer.length);
      dot.classList.remove('shake-error');
    });
  }

  function bindStaticEvents() {
    // PIN pad
    els.pinPad.addEventListener('click', (e) => {
      const keyBtn = e.target.closest('.pin-key');
      if (!keyBtn) return;

      if (keyBtn.id === 'pinClear') {
        pinBuffer = '';
        els.pinError.classList.add('hidden');
        renderPinDots();
        return;
      }

      if (keyBtn.id === 'pinBackspace') {
        pinBuffer = pinBuffer.slice(0, -1);
        renderPinDots();
        return;
      }

      const digit = keyBtn.dataset.key;
      if (digit == null) return;
      if (pinBuffer.length >= CONFIG.PIN_LENGTH) return;

      pinBuffer += digit;
      renderPinDots();

      if (pinBuffer.length === CONFIG.PIN_LENGTH) {
        setTimeout(() => attemptLogin(pinBuffer), 120);
      }
    });

    // Physical keyboard support for PIN
    document.addEventListener('keydown', (e) => {
      if (els.loginModal.classList.contains('hidden')) return;
      if (/^[0-9]$/.test(e.key) && pinBuffer.length < CONFIG.PIN_LENGTH) {
        pinBuffer += e.key;
        renderPinDots();
        if (pinBuffer.length === CONFIG.PIN_LENGTH) {
          setTimeout(() => attemptLogin(pinBuffer), 120);
        }
      } else if (e.key === 'Backspace') {
        pinBuffer = pinBuffer.slice(0, -1);
        renderPinDots();
      }
    });

    els.logoutBtn.addEventListener('click', handleLogout);
    els.addStudentBtn.addEventListener('click', openAddStudentModal);
    els.manageSecretariesBtn.addEventListener('click', openManageSecretariesModal);

    // Search
    els.studentSearch.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim();
      els.clearSearchBtn.classList.toggle('hidden', state.searchQuery.length === 0);
      renderStudentsList();
    });
    els.clearSearchBtn.addEventListener('click', () => {
      els.studentSearch.value = '';
      state.searchQuery = '';
      els.clearSearchBtn.classList.add('hidden');
      renderStudentsList();
      els.studentSearch.focus();
    });

    // Group chips (delegated, since built dynamically)
    els.groupChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.activeGroup = chip.dataset.group;
      $$('.chip', els.groupChips).forEach((c) => c.classList.toggle('active', c === chip));
      renderStudentsList();
    });

    // Students list (delegated)
    els.studentsList.addEventListener('click', handleStudentListClick);

    // Approvals list (delegated)
    els.approvalsList.addEventListener('click', handleApprovalsListClick);
    els.approveAllBtn.addEventListener('click', handleApproveAll);

    // Edit modal
    els.editModalClose.addEventListener('click', closeEditModal);
    els.editModal.addEventListener('click', (e) => {
      if (e.target === els.editModal) closeEditModal();
    });
    els.editPresentBtn.addEventListener('click', () => setEditAttendance('present'));
    els.editAbsentBtn.addEventListener('click', () => setEditAttendance('absent'));
    els.saveEditBtn.addEventListener('click', saveEditModal);
    els.deleteRecordBtn.addEventListener('click', confirmDeleteFromEdit);

    // Confirm modal
    els.confirmCancelBtn.addEventListener('click', closeConfirmModal);
    els.confirmModal.addEventListener('click', (e) => {
      if (e.target === els.confirmModal) closeConfirmModal();
    });
    els.confirmOkBtn.addEventListener('click', () => {
      if (typeof state.pendingConfirmAction === 'function') {
        state.pendingConfirmAction();
      }
      closeConfirmModal();
    });

    // Add student modal
    els.addStudentModalClose.addEventListener('click', closeAddStudentModal);
    els.cancelAddStudentBtn.addEventListener('click', closeAddStudentModal);
    els.addStudentModal.addEventListener('click', (e) => {
      if (e.target === els.addStudentModal) closeAddStudentModal();
    });
    els.saveNewStudentBtn.addEventListener('click', saveNewStudent);

    // Manage secretaries modal
    els.manageSecretariesModalClose.addEventListener('click', closeManageSecretariesModal);
    els.manageSecretariesModal.addEventListener('click', (e) => {
      if (e.target === els.manageSecretariesModal) closeManageSecretariesModal();
    });
    els.secretariesList.addEventListener('click', handleSecretariesListClick);

    // Secretary permissions modal
    els.secretaryPermsModalClose.addEventListener('click', closeSecretaryPermsModal);
    els.cancelSecretaryPermsBtn.addEventListener('click', closeSecretaryPermsModal);
    els.secretaryPermsModal.addEventListener('click', (e) => {
      if (e.target === els.secretaryPermsModal) closeSecretaryPermsModal();
    });
    els.secretaryGroupsChecklist.addEventListener('click', handleGroupsChecklistClick);
    els.saveSecretaryPermsBtn.addEventListener('click', saveSecretaryPerms);
  }

  async function attemptLogin(pin) {
    // Refresh from IndexedDB in case another session synced new accounts.
    state.secretaries = await db.getAllSecretaries();
    const user = await db.getSecretaryByPin(pin);

    if (!user) {
      els.pinError.classList.remove('hidden');
      els.pinDots.forEach((d) => d.classList.add('shake-error'));
      els.pinDisplay.classList.add('shake');
      vibrate([60, 40, 60]);
      setTimeout(() => {
        els.pinDisplay.classList.remove('shake');
        pinBuffer = '';
        renderPinDots();
      }, 420);
      return;
    }

    state.currentUser = { ...user };
    sessionStorage.setItem('sayyad_session_user_id', state.currentUser.id);
    els.pinError.classList.add('hidden');
    enterApp();
  }

  function handleLogout() {
    openConfirm(
      'تسجيل الخروج',
      'هل تريد بالفعل تسجيل الخروج من النظام؟',
      () => {
        state.currentUser = null;
        sessionStorage.removeItem('sayyad_session_user_id');
        els.app.classList.add('hidden');
        showLogin();
      }
    );
  }

  function enterApp() {
    els.loginModal.classList.add('hidden');
    els.loginModal.setAttribute('aria-hidden', 'true');
    els.app.classList.remove('hidden');

    els.userNameLabel.textContent = state.currentUser.name;
    els.userRoleBadge.textContent = state.currentUser.role === 'master' ? 'مدير المركز' : 'سكرتارية';

    if (state.currentUser.role === 'master') {
      els.secretaryView.classList.add('hidden');
      els.masterView.classList.remove('hidden');
      els.addStudentBtn.classList.add('hidden');
      els.manageSecretariesBtn.classList.remove('hidden');
      renderMasterView();
    } else {
      els.masterView.classList.add('hidden');
      els.secretaryView.classList.remove('hidden');
      els.addStudentBtn.classList.remove('hidden');
      els.manageSecretariesBtn.classList.add('hidden');
      buildGroupChips();
      renderStudentsList();
      updatePendingBadgeSecretary();
    }

    updateSyncBadge();

    // Kick off a background refresh so data stays current without
    // blocking the UI the user is already looking at.
    if (navigator.onLine) fetchInitialData().then(() => {
      if (state.currentUser?.role === 'secretary') {
        buildGroupChips();
        renderStudentsList();
      } else if (state.currentUser?.role === 'master') {
        renderMasterView();
      }
    });
  }

  /* =====================================================================
     CONNECTIVITY / SYNC ENGINE
     ===================================================================== */

  function setupConnectivityWatchers() {
    window.addEventListener('online', () => {
      updateSyncBadge();
      showToast('تم استعادة الاتصال بالإنترنت، جاري المزامنة...', 'info');
      triggerSync();
    });
    window.addEventListener('offline', () => {
      updateSyncBadge();
      showToast('انقطع الاتصال بالإنترنت — سيتم الحفظ محليًا', 'error');
    });

    // Periodic retry loop in case fetches fail silently
    setInterval(() => {
      if (navigator.onLine && !state.isSyncing) triggerSync();
    }, CONFIG.SYNC_RETRY_INTERVAL_MS);
  }

  function updateSyncBadge() {
    els.syncBadge.classList.remove('online', 'offline', 'syncing');
    if (state.isSyncing || state.isFetchingInitialData) {
      els.syncBadge.classList.add('syncing');
      els.syncBadgeText.textContent = 'جاري المزامنة';
    } else if (navigator.onLine) {
      els.syncBadge.classList.add('online');
      els.syncBadgeText.textContent = 'متصل';
    } else {
      els.syncBadge.classList.add('offline');
      els.syncBadgeText.textContent = 'غير متصل';
    }
  }

  /**
   * Pushes to the API, in order:
   *   1. Students pending creation (offline-added students)
   *   2. Secretaries pending sync (permission changes from master)
   *   3. Approved / failed attendance records
   * This never blocks the UI — it runs silently in the background.
   */
  async function triggerSync() {
    if (state.isSyncing || !navigator.onLine) return;

    const pendingStudents = await db.getStudentsPendingCreation();
    const pendingSecretaries = state.secretaries.filter((s) => s.pendingSync);
    const toSyncRecords = state.records.filter((r) => r.status === 'approved' || r.status === 'failed');

    if (pendingStudents.length === 0 && pendingSecretaries.length === 0 && toSyncRecords.length === 0) return;

    state.isSyncing = true;
    updateSyncBadge();

    let studentSuccess = 0, studentFail = 0;
    for (const student of pendingStudents) {
      try {
        const ok = await pushStudentToApi(student);
        if (ok) {
          const updated = { ...student, syncStatus: 'synced' };
          await db.upsertStudent(updated);
          studentSuccess++;
        } else {
          studentFail++;
        }
      } catch (err) {
        studentFail++;
      }
    }

    let secSuccess = 0, secFail = 0;
    for (const secretary of pendingSecretaries) {
      try {
        const ok = await pushSecretaryToApi(secretary);
        if (ok) {
          const updated = { ...secretary, pendingSync: false };
          await db.upsertSecretary(updated);
          secSuccess++;
        } else {
          secFail++;
        }
      } catch (err) {
        secFail++;
      }
    }

    let recSuccess = 0, recFail = 0;
    for (const record of toSyncRecords) {
      try {
        const ok = await pushRecordToApi(record);
        if (ok) {
          record.status = 'synced';
          record.syncedAt = Date.now();
          await db.upsertRecord(record);
          recSuccess++;
        } else {
          record.status = 'failed';
          await db.upsertRecord(record);
          recFail++;
        }
      } catch (err) {
        record.status = 'failed';
        await db.upsertRecord(record);
        recFail++;
      }
    }

    state.students = await db.getAllStudents();
    state.secretaries = await db.getAllSecretaries();
    state.records = await db.getAllRecords();
    state.isSyncing = false;
    updateSyncBadge();

    const totalSuccess = studentSuccess + secSuccess + recSuccess;
    const totalFail = studentFail + secFail + recFail;

    if (totalSuccess > 0) {
      showToast(`تمت مزامنة ${totalSuccess} عنصر بنجاح`, 'success');
    }
    if (totalFail > 0) {
      showToast(`تعذّرت مزامنة ${totalFail} عنصر، سيُعاد المحاولة تلقائيًا`, 'error');
    }

    if (state.currentUser?.role === 'master') renderMasterView();
    if (state.currentUser?.role === 'secretary') updatePendingBadgeSecretary();
  }

  async function pushRecordToApi(record) {
    if (!isApiConfigured()) {
      console.info('[Sync] لا يوجد رابط API مضبوط — تم تجاوز الإرسال الفعلي (سجل).', record);
      return true;
    }
    try {
      const res = await fetch(CONFIG.API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          type: 'record',
          recordId: record.recordId,
          studentId: record.studentId,
          studentName: record.studentName,
          group: record.group,
          attendance: record.attendance,
          homeworkGrade: record.homeworkGrade,
          examGrade: record.examGrade,
          notes: record.notes,
          secretaryName: record.secretaryName,
          approvedBy: record.approvedBy,
          dateKey: record.dateKey,
          createdAt: record.createdAt,
          approvedAt: record.approvedAt,
        }),
      });
      return res.ok;
    } catch (err) {
      console.warn('[Sync] فشل إرسال السجل', record.recordId, err);
      return false;
    }
  }

  async function pushStudentToApi(student) {
    if (!isApiConfigured()) {
      console.info('[Sync] لا يوجد رابط API مضبوط — تم تجاوز الإرسال الفعلي (طالب جديد).', student);
      return true;
    }
    try {
      const res = await fetch(CONFIG.API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ type: 'new_student', student }),
      });
      return res.ok;
    } catch (err) {
      console.warn('[Sync] فشل إرسال الطالب الجديد', student.id, err);
      return false;
    }
  }

  async function pushSecretaryToApi(secretary) {
    if (!isApiConfigured()) {
      console.info('[Sync] لا يوجد رابط API مضبوط — تم تجاوز الإرسال الفعلي (سكرتارية).', secretary);
      return true;
    }
    try {
      const res = await fetch(CONFIG.API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ type: 'secretary_update', secretary }),
      });
      return res.ok;
    } catch (err) {
      console.warn('[Sync] فشل إرسال تحديث السكرتارية', secretary.id, err);
      return false;
    }
  }

  function isApiConfigured() {
    return !!CONFIG.API_ENDPOINT && !CONFIG.API_ENDPOINT.includes('REPLACE_WITH_YOUR_DEPLOYMENT_ID');
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        // Listen for updates and refresh caches silently.
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'activated') {
              console.info('[SW] تم تحديث الملفات المخزنة مؤقتًا.');
            }
          });
        });
      }).catch((err) => {
        console.warn('[SW] فشل تسجيل Service Worker', err);
      });

      // Also try to register background sync if supported, purely as an
      // enhancement — the interval-based triggerSync() above is the
      // reliable cross-browser fallback.
      navigator.serviceWorker.ready.then((reg) => {
        if ('sync' in reg) {
          reg.sync.register('sayyad-sync-queue').catch(() => {});
        }
      }).catch(() => {});

      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'SAYYAD_TRIGGER_SYNC') {
          triggerSync();
        }
      });
    });
  }

  /* =====================================================================
     SECRETARY VIEW — RENDERING
     ===================================================================== */

  function buildGroupChips() {
    const groups = Array.from(new Set(getVisibleStudentsForCurrentUser().map((s) => s.group))).sort();
    els.groupChips.innerHTML = '<button class="chip active" data-group="all">الكل</button>' +
      groups.map((g) => `<button class="chip" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('');
  }

  /**
   * Returns the student roster this logged-in user is allowed to see.
   * - master: sees everyone.
   * - secretary: sees only students whose `group` is in their allowedGroups.
   *   If allowedGroups is missing/empty, we treat it as "no restriction"
   *   for backward compatibility with accounts that predate RBAC.
   */
  function getVisibleStudentsForCurrentUser() {
    if (!state.currentUser) return [];
    if (state.currentUser.role === 'master') return state.students;

    const allowed = state.currentUser.allowedGroups;
    if (!Array.isArray(allowed) || allowed.length === 0) return state.students;

    return state.students.filter((s) => allowed.includes(s.group));
  }

  function getFilteredStudents() {
    let list = getVisibleStudentsForCurrentUser();

    if (state.activeGroup !== 'all') {
      list = list.filter((s) => s.group === state.activeGroup);
    }

    const q = state.searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        String(s.id).toLowerCase().includes(q)
      );
    }

    return list;
  }

  function getTodayRecordForStudent(studentId) {
    const today = todayKey();
    // Prefer the most recent non-approved-cleared record for today.
    const candidates = state.records.filter(
      (r) => r.studentId === studentId && r.dateKey === today
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    return candidates[0];
  }

  function renderStudentsList() {
    const list = getFilteredStudents();
    els.studentsList.innerHTML = '';

    if (list.length === 0) {
      els.noResults.classList.remove('hidden');
      return;
    }
    els.noResults.classList.add('hidden');

    const frag = document.createDocumentFragment();
    list.forEach((student) => {
      frag.appendChild(buildStudentCard(student));
    });
    els.studentsList.appendChild(frag);
  }

  function buildStudentCard(student) {
    const node = els.studentCardTemplate.content.cloneNode(true);
    const card = node.querySelector('.student-card');
    card.dataset.id = student.id;

    node.querySelector('.student-avatar').textContent = initials(student.name);
    node.querySelector('.student-name').textContent = student.name;
    node.querySelector('.student-id').textContent = student.id;
    node.querySelector('.tag-group').textContent = student.group;

    if (student.syncStatus === 'pending_creation') {
      const tags = node.querySelector('.student-tags');
      const pendingTag = document.createElement('span');
      pendingTag.className = 'tag tag-id';
      pendingTag.textContent = '🆕 بانتظار المزامنة';
      tags.appendChild(pendingTag);
    }

    const existingRecord = getTodayRecordForStudent(student.id);
    const statusPill = node.querySelector('[data-role="statusPill"]');

    if (existingRecord) {
      applyRecordToCard(card, existingRecord);
      updateStatusPill(statusPill, existingRecord.status);
    } else {
      updateStatusPill(statusPill, null);
    }

    return node;
  }

  function updateStatusPill(pillEl, status) {
    pillEl.classList.remove('status-none', 'status-pending', 'status-approved');
    if (status === 'pending' || status === 'failed') {
      pillEl.classList.add('status-pending');
      pillEl.textContent = 'بانتظار الاعتماد';
    } else if (status === 'approved' || status === 'synced') {
      pillEl.classList.add('status-approved');
      pillEl.textContent = 'تم الاعتماد';
    } else {
      pillEl.classList.add('status-none');
      pillEl.textContent = 'لم يُسجَّل بعد';
    }
  }

  function applyRecordToCard(card, record) {
    const presentBtn = card.querySelector('.attend-present');
    const absentBtn = card.querySelector('.attend-absent');
    presentBtn.classList.toggle('active', record.attendance === 'present');
    absentBtn.classList.toggle('active', record.attendance === 'absent');

    const hwInput = card.querySelector('[data-field="homeworkGrade"]');
    const examInput = card.querySelector('[data-field="examGrade"]');
    const notesInput = card.querySelector('[data-field="notes"]');
    if (record.homeworkGrade != null) hwInput.value = record.homeworkGrade;
    if (record.examGrade != null) examInput.value = record.examGrade;
    if (record.notes) notesInput.value = record.notes;
  }

  function handleStudentListClick(e) {
    const card = e.target.closest('.student-card');
    if (!card) return;
    const studentId = card.dataset.id;

    const attendBtn = e.target.closest('[data-action="present"], [data-action="absent"]');
    if (attendBtn) {
      const type = attendBtn.dataset.action;
      const presentBtn = card.querySelector('.attend-present');
      const absentBtn = card.querySelector('.attend-absent');
      presentBtn.classList.toggle('active', type === 'present');
      absentBtn.classList.toggle('active', type === 'absent');
      vibrate(15);
      return;
    }

    const saveBtn = e.target.closest('[data-action="save"]');
    if (saveBtn) {
      saveStudentCard(card, studentId);
    }
  }

  async function saveStudentCard(card, studentId) {
    const student = state.students.find((s) => String(s.id) === String(studentId));
    if (!student) return;

    const attendance = card.querySelector('.attend-present').classList.contains('active')
      ? 'present'
      : card.querySelector('.attend-absent').classList.contains('active')
        ? 'absent'
        : null;

    if (!attendance) {
      showToast('من فضلك اختر الحضور أو الغياب أولاً', 'error');
      return;
    }

    const homeworkGrade = card.querySelector('[data-field="homeworkGrade"]').value;
    const examGrade = card.querySelector('[data-field="examGrade"]').value;
    const notes = card.querySelector('[data-field="notes"]').value.trim();

    const today = todayKey();
    const existing = await db.getRecordByStudentToday(studentId, today);

    const record = {
      recordId: existing ? existing.recordId : uid('rec'),
      studentId: student.id,
      studentName: student.name,
      group: student.group,
      attendance,
      homeworkGrade: homeworkGrade === '' ? null : Number(homeworkGrade),
      examGrade: examGrade === '' ? null : Number(examGrade),
      notes,
      status: 'pending',
      secretaryName: state.currentUser.name,
      secretaryId: state.currentUser.id,
      dateKey: today,
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
    };

    await db.upsertRecord(record);
    state.records = await db.getAllRecords();

    const saveBtn = card.querySelector('[data-action="save"]');
    const originalHtml = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span>✅</span> تم الحفظ أوفلاين';
    card.classList.add('saved-flash');
    vibrate([20, 30, 20]);

    setTimeout(() => {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalHtml;
      card.classList.remove('saved-flash');
    }, 1400);

    const statusPill = card.querySelector('[data-role="statusPill"]');
    updateStatusPill(statusPill, 'pending');

    updatePendingBadgeSecretary();
    showToast(`تم حفظ بيانات ${student.name} محليًا بنجاح`, 'success');
  }

  function updatePendingBadgeSecretary() {
    const pendingCount = state.records.filter((r) => r.status === 'pending' || r.status === 'failed').length;
    els.pendingCountSecretary.textContent = pendingCount;
    els.localQueueSummary.classList.toggle('hidden', pendingCount === 0);
  }

  /* =====================================================================
     ADD NEW STUDENT (Offline-First)
     ===================================================================== */

  function populateSelect(selectEl, options, placeholder) {
    const current = selectEl.value;
    selectEl.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
      (options || []).map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('');
    if (options && options.includes(current)) selectEl.value = current;
  }

  async function openAddStudentModal() {
    // Always populate from the freshest cached settings.
    state.settings = await db.getAllSettings();
    const settings = (state.settings && Object.keys(state.settings).length > 0) ? state.settings : FALLBACK_SETTINGS;

    populateSelect(els.newStudentYear, settings.years || FALLBACK_SETTINGS.years, 'اختر الصف');
    populateSelect(els.newStudentBranch, settings.branches || FALLBACK_SETTINGS.branches, 'اختر الفرع');
    populateSelect(els.newStudentDay, settings.days || FALLBACK_SETTINGS.days, 'اختر اليوم');
    populateSelect(els.newStudentTime, settings.times || FALLBACK_SETTINGS.times, 'اختر الموعد');

    els.newStudentName.value = '';
    els.newStudentPhone.value = '';

    els.addStudentModal.classList.remove('hidden');
    els.addStudentModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => els.newStudentName.focus(), 100);
  }

  function closeAddStudentModal() {
    els.addStudentModal.classList.add('hidden');
    els.addStudentModal.setAttribute('aria-hidden', 'true');
  }

  async function saveNewStudent() {
    const name = els.newStudentName.value.trim();
    const phone = els.newStudentPhone.value.trim();
    const year = els.newStudentYear.value;
    const branch = els.newStudentBranch.value;
    const day = els.newStudentDay.value;
    const time = els.newStudentTime.value;

    if (!name) {
      showToast('من فضلك اكتب اسم الطالب', 'error');
      els.newStudentName.focus();
      return;
    }
    if (!year || !branch || !day || !time) {
      showToast('من فضلك اختر جميع بيانات المجموعة (الصف/الفرع/اليوم/الموعد)', 'error');
      return;
    }

    const group = buildGroupLabel(year, branch);

    const newStudent = {
      id: uid('NEW'),
      name,
      phone: phone || null,
      year,
      branch,
      day,
      time,
      group,
      syncStatus: 'pending_creation',
      createdAt: Date.now(),
      createdBy: state.currentUser ? state.currentUser.name : null,
    };

    await db.upsertStudent(newStudent);
    state.students = await db.getAllStudents();

    closeAddStudentModal();
    buildGroupChips();
    renderStudentsList();

    showToast(`تم إضافة ${name} محليًا، يمكنك تسجيل حضوره الآن`, 'success');
    vibrate([20, 30, 20]);

    // Try to push immediately if online; otherwise it queues for later.
    if (navigator.onLine) triggerSync();
  }

  /* =====================================================================
     MASTER / TEACHER DASHBOARD — RENDERING
     ===================================================================== */

  function renderMasterView() {
    const totalStudents = state.students.length;
    const activeGroups = new Set(state.students.map((s) => s.group)).size;
    const pending = state.records.filter((r) => r.status === 'pending' || r.status === 'failed');
    const today = todayKey();
    const approvedToday = state.records.filter(
      (r) => (r.status === 'approved' || r.status === 'synced') && r.dateKey === today
    );

    els.statTotalStudents.textContent = totalStudents;
    els.statActiveGroups.textContent = activeGroups;
    els.statPendingApprovals.textContent = pending.length;
    els.statApprovedToday.textContent = approvedToday.length;

    renderApprovalsList(pending);
  }

  function renderApprovalsList(pendingRecords) {
    els.approvalsList.innerHTML = '';

    if (pendingRecords.length === 0) {
      els.noApprovals.classList.remove('hidden');
      els.approveAllBtn.classList.add('hidden');
      return;
    }
    els.noApprovals.classList.add('hidden');
    els.approveAllBtn.classList.remove('hidden');

    const sorted = [...pendingRecords].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

    const frag = document.createDocumentFragment();
    sorted.forEach((record) => {
      frag.appendChild(buildApprovalCard(record));
    });
    els.approvalsList.appendChild(frag);
  }

  function buildApprovalCard(record) {
    const node = els.approvalCardTemplate.content.cloneNode(true);
    const card = node.querySelector('.approval-card');
    card.dataset.id = record.recordId;

    node.querySelector('.student-avatar').textContent = initials(record.studentName);
    node.querySelector('.student-name').textContent = record.studentName;
    node.querySelector('.student-id').textContent = record.studentId;
    node.querySelector('.tag-group').textContent = record.group;
    node.querySelector('[data-role="time"]').textContent = formatRelativeTime(record.updatedAt || record.createdAt);

    const attendancePill = node.querySelector('[data-role="attendancePill"]');
    if (record.attendance === 'present') {
      attendancePill.textContent = '✅ حاضر';
      attendancePill.classList.add('present-pill');
    } else if (record.attendance === 'absent') {
      attendancePill.textContent = '❌ غائب';
      attendancePill.classList.add('absent-pill');
    } else {
      attendancePill.textContent = '— لم يُسجَّل';
    }

    node.querySelector('[data-role="homeworkPill"]').textContent =
      `واجب: ${record.homeworkGrade != null ? record.homeworkGrade : '—'}`;
    node.querySelector('[data-role="examPill"]').textContent =
      `امتحان: ${record.examGrade != null ? record.examGrade : '—'}`;

    const notesEl = node.querySelector('[data-role="notesText"]');
    notesEl.textContent = record.notes || '';

    node.querySelector('[data-role="secretaryName"]').textContent = record.secretaryName || '—';

    if (record.status === 'failed') {
      const timeEl = node.querySelector('[data-role="time"]');
      timeEl.textContent = '⚠️ فشلت المزامنة سابقًا';
    }

    return node;
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const diffMs = Date.now() - timestamp;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'الآن';
    if (diffMin < 60) return `منذ ${diffMin} دقيقة`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `منذ ${diffHr} ساعة`;
    return new Date(timestamp).toLocaleDateString('ar-EG');
  }

  function handleApprovalsListClick(e) {
    const card = e.target.closest('.approval-card');
    if (!card) return;
    const recordId = card.dataset.id;

    if (e.target.closest('[data-action="approve"]')) {
      approveRecord(recordId);
    } else if (e.target.closest('[data-action="edit"]')) {
      openEditModal(recordId);
    }
  }

  async function approveRecord(recordId) {
    const record = await db.getRecord(recordId);
    if (!record) return;

    await db.updateRecordStatus(recordId, 'approved', {
      approvedBy: state.currentUser.name,
      approvedAt: Date.now(),
    });

    state.records = await db.getAllRecords();
    renderMasterView();
    showToast(`تم اعتماد سجل ${record.studentName} وسيتم إرساله تلقائيًا`, 'success');
    vibrate([15, 20, 15]);

    triggerSync();
  }

  async function handleApproveAll() {
    const pending = state.records.filter((r) => r.status === 'pending' || r.status === 'failed');
    if (pending.length === 0) return;

    openConfirm(
      'اعتماد جميع السجلات',
      `سيتم اعتماد ${pending.length} سجل وإرسالها دفعة واحدة. هل تريد المتابعة؟`,
      async () => {
        for (const record of pending) {
          await db.updateRecordStatus(record.recordId, 'approved', {
            approvedBy: state.currentUser.name,
            approvedAt: Date.now(),
          });
        }
        state.records = await db.getAllRecords();
        renderMasterView();
        showToast(`تم اعتماد ${pending.length} سجل بنجاح`, 'success');
        triggerSync();
      }
    );
  }

  /* =====================================================================
     EDIT MODAL (used from both master approvals queue)
     ===================================================================== */

  async function openEditModal(recordId) {
    const record = await db.getRecord(recordId);
    if (!record) return;

    state.editingRecordId = recordId;
    els.editStudentName.textContent = `${record.studentName} — #${record.studentId} — ${record.group}`;

    els.editPresentBtn.classList.toggle('active', record.attendance === 'present');
    els.editAbsentBtn.classList.toggle('active', record.attendance === 'absent');

    els.editHomeworkGrade.value = record.homeworkGrade != null ? record.homeworkGrade : '';
    els.editExamGrade.value = record.examGrade != null ? record.examGrade : '';
    els.editNotes.value = record.notes || '';

    els.editModal.classList.remove('hidden');
    els.editModal.setAttribute('aria-hidden', 'false');
  }

  function closeEditModal() {
    state.editingRecordId = null;
    els.editModal.classList.add('hidden');
    els.editModal.setAttribute('aria-hidden', 'true');
  }

  function setEditAttendance(type) {
    els.editPresentBtn.classList.toggle('active', type === 'present');
    els.editAbsentBtn.classList.toggle('active', type === 'absent');
  }

  async function saveEditModal() {
    if (!state.editingRecordId) return;
    const record = await db.getRecord(state.editingRecordId);
    if (!record) return;

    const attendance = els.editPresentBtn.classList.contains('active')
      ? 'present'
      : els.editAbsentBtn.classList.contains('active')
        ? 'absent'
        : record.attendance;

    const homeworkGrade = els.editHomeworkGrade.value;
    const examGrade = els.editExamGrade.value;
    const notes = els.editNotes.value.trim();

    const updated = {
      ...record,
      attendance,
      homeworkGrade: homeworkGrade === '' ? null : Number(homeworkGrade),
      examGrade: examGrade === '' ? null : Number(examGrade),
      notes,
      status: 'pending', // edits reset to pending for re-approval
      updatedAt: Date.now(),
    };

    await db.upsertRecord(updated);
    state.records = await db.getAllRecords();
    closeEditModal();
    renderMasterView();
    showToast('تم حفظ التعديلات، السجل بانتظار الاعتماد مجددًا', 'success');
  }

  function confirmDeleteFromEdit() {
    if (!state.editingRecordId) return;
    const recordId = state.editingRecordId;

    openConfirm(
      'حذف السجل',
      'سيتم حذف هذا السجل نهائيًا من قائمة الاعتماد. هل أنت متأكد؟',
      async () => {
        await db.deleteRecord(recordId);
        state.records = await db.getAllRecords();
        closeEditModal();
        renderMasterView();
        showToast('تم حذف السجل بنجاح', 'success');
      }
    );
  }

  /* =====================================================================
     MANAGE SECRETARIES (Master only) — RBAC administration
     ===================================================================== */

  async function openManageSecretariesModal() {
    state.secretaries = await db.getAllSecretaries();
    renderSecretariesList();
    els.manageSecretariesModal.classList.remove('hidden');
    els.manageSecretariesModal.setAttribute('aria-hidden', 'false');
  }

  function closeManageSecretariesModal() {
    els.manageSecretariesModal.classList.add('hidden');
    els.manageSecretariesModal.setAttribute('aria-hidden', 'true');
  }

  function renderSecretariesList() {
    els.secretariesList.innerHTML = '';

    // Master usually doesn't need to manage other masters — but show
    // everyone except the currently logged-in master account for clarity.
    const list = state.secretaries.filter((s) => s.role !== 'master');

    if (list.length === 0) {
      els.noSecretaries.classList.remove('hidden');
      return;
    }
    els.noSecretaries.classList.add('hidden');

    const frag = document.createDocumentFragment();
    list.forEach((secretary) => {
      frag.appendChild(buildSecretaryCard(secretary));
    });
    els.secretariesList.appendChild(frag);
  }

  function buildSecretaryCard(secretary) {
    const node = els.secretaryCardTemplate.content.cloneNode(true);
    const card = node.querySelector('.secretary-card');
    card.dataset.id = secretary.id;

    node.querySelector('.student-avatar').textContent = initials(secretary.name);
    node.querySelector('[data-role="secName"]').textContent = secretary.name;
    node.querySelector('[data-role="secRole"]').textContent = 'سكرتارية';

    const groupsCount = Array.isArray(secretary.allowedGroups) ? secretary.allowedGroups.length : 0;
    node.querySelector('[data-role="secGroupsCount"]').textContent =
      groupsCount === 0 ? 'كل المجموعات' : `${groupsCount} مجموعة مسموحة`;

    const syncBadge = node.querySelector('[data-role="secSyncBadge"]');
    if (secretary.pendingSync) {
      syncBadge.textContent = '⏳ بانتظار المزامنة';
      syncBadge.classList.add('pending');
    } else {
      syncBadge.textContent = '✅ متزامن';
    }

    return node;
  }

  function handleSecretariesListClick(e) {
    const card = e.target.closest('.secretary-card');
    if (!card) return;
    const secretaryId = card.dataset.id;

    if (e.target.closest('[data-action="edit-perms"]')) {
      openSecretaryPermsModal(secretaryId);
    }
  }

  async function openSecretaryPermsModal(secretaryId) {
    const secretary = await db.getSecretaryById(secretaryId);
    if (!secretary) return;

    state.activeSecretaryIdForPerms = secretaryId;
    els.secretaryPermsName.textContent = `${secretary.name} — تحديد المجموعات المسموح بمتابعتها`;

    state.settings = await db.getAllSettings();
    const allGroups = getAllKnownGroups();

    els.secretaryGroupsChecklist.innerHTML = '';

    if (allGroups.length === 0) {
      els.noGroupsForPerms.classList.remove('hidden');
    } else {
      els.noGroupsForPerms.classList.add('hidden');
      const allowed = Array.isArray(secretary.allowedGroups) ? secretary.allowedGroups : [];

      const frag = document.createDocumentFragment();
      allGroups.forEach((group) => {
        const item = document.createElement('label');
        item.className = 'group-check-item';
        item.dataset.group = group;
        const isChecked = allowed.includes(group);
        item.classList.toggle('checked', isChecked);
        item.innerHTML = `
          <input type="checkbox" ${isChecked ? 'checked' : ''} data-group="${escapeHtml(group)}">
          <span>${escapeHtml(group)}</span>
        `;
        frag.appendChild(item);
      });
      els.secretaryGroupsChecklist.appendChild(frag);
    }

    els.secretaryPermsModal.classList.remove('hidden');
    els.secretaryPermsModal.setAttribute('aria-hidden', 'false');
  }

  function closeSecretaryPermsModal() {
    state.activeSecretaryIdForPerms = null;
    els.secretaryPermsModal.classList.add('hidden');
    els.secretaryPermsModal.setAttribute('aria-hidden', 'true');
  }

  /**
   * Combines groups from cached settings (if the API exposes a "groups"
   * list directly) with groups derived from the actual student roster,
   * so master always sees every real group even if settings.groups is
   * missing or stale.
   */
  function getAllKnownGroups() {
    const fromSettings = Array.isArray(state.settings.groups) ? state.settings.groups : [];
    const fromStudents = state.students.map((s) => s.group).filter(Boolean);
    return Array.from(new Set([...fromSettings, ...fromStudents])).sort();
  }

  function handleGroupsChecklistClick(e) {
    const item = e.target.closest('.group-check-item');
    if (!item) return;

    // Let the native checkbox toggle happen, then sync the visual state.
    const checkbox = item.querySelector('input[type="checkbox"]');
    if (e.target !== checkbox) {
      checkbox.checked = !checkbox.checked;
    }
    item.classList.toggle('checked', checkbox.checked);
  }

  async function saveSecretaryPerms() {
    if (!state.activeSecretaryIdForPerms) return;
    const secretary = await db.getSecretaryById(state.activeSecretaryIdForPerms);
    if (!secretary) return;

    const checkedBoxes = $$('input[type="checkbox"]', els.secretaryGroupsChecklist).filter((cb) => cb.checked);
    const allowedGroups = checkedBoxes.map((cb) => cb.dataset.group);

    const updated = {
      ...secretary,
      allowedGroups,
      pendingSync: true,
      updatedAt: Date.now(),
    };

    await db.upsertSecretary(updated);
    state.secretaries = await db.getAllSecretaries();

    closeSecretaryPermsModal();
    renderSecretariesList();
    showToast(`تم تحديث صلاحيات ${secretary.name} وسيتم مزامنتها تلقائيًا`, 'success');

    if (navigator.onLine) triggerSync();
  }

  /* =====================================================================
     CONFIRM DIALOG HELPER
     ===================================================================== */

  function openConfirm(title, message, onConfirm) {
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    state.pendingConfirmAction = onConfirm;
    els.confirmModal.classList.remove('hidden');
    els.confirmModal.setAttribute('aria-hidden', 'false');
  }

  function closeConfirmModal() {
    state.pendingConfirmAction = null;
    els.confirmModal.classList.add('hidden');
    els.confirmModal.setAttribute('aria-hidden', 'true');
  }
})();
