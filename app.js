/**
 * app.js
 * -------------------------------------------------------------
 * Core application logic for مركز الأستاذ محمود الصياد للتطوير التعليمي
 *
 * Change #1 — Single Admin User & Static PIN:
 *   No secretaries store; PIN is hardcoded to ADMIN_PIN ('1234').
 *   Session persisted in localStorage (not secretaryId).
 *
 * Change #2 — Smart Student ID Generation by Branch + Year (Dynamic Ranges):
 *   Each branch (سنتر) owns a dedicated 200-number range, sub-divided
 *   internally per school stage/year. See BRANCH_YEAR_RANGES below.
 *   The system looks up the highest ID actually used inside the matching
 *   branch+year sub-range and hands the new student the next number.
 *   Branch/year combos with no configured range fall back to the legacy
 *   stage-based ranges (ابتدائي 1000s / إعدادي 2000s / ثانوي 3000s).
 *
 * Change #3 — Two-Step Quick Attendance (no غائب):
 *   Step 1: Click "حاضر" → instant DB draft, green banner, unlock send btn.
 *   Step 2: Click "إرسال للاعتماد" → reads grades/notes, upgrades draft→pending.
 *
 * Change #4 — Drill-Down Approval Filters:
 *   Three cascading selects: Year → Day → Time.
 *   Populated from pending records only; "Approve All" only approves filtered set.
 *
 * Change #5 — No Absent Frontend State:
 *   All absent logic removed. Only 'present' records are created/sent.
 * -------------------------------------------------------------
 */

(() => {
  'use strict';

  /* ===================================================================
     CONFIG
     =================================================================== */

  const CONFIG = {
    API_ENDPOINT: 'https://script.google.com/macros/s/AKfycbwVV5tIHS-hI_v8ppRuIYgKOEu0pTccTQaieSADBBRfAPngNeCE31ky7Um6CfYzu3Wo/exec',

    // Change #1: hardcoded admin PIN
    ADMIN_PIN: '1234',
    PIN_LENGTH: 4,

    // Change #2 (legacy fallback): ID range bases per school stage,
    // used only when a branch+year combo has no custom range defined below.
    ID_BASE_PRIMARY:     1000,  // ابتدائي
    ID_BASE_PREPARATORY: 2000,  // إعدادي
    ID_BASE_SECONDARY:   3000,  // ثانوي

    SYNC_RETRY_INTERVAL_MS: 30000,
    TOAST_DURATION_MS:      3200,

    DEFAULT_HOMEWORK_MAX: 20,
    DEFAULT_EXAM_MAX:     20,

    THEME_STORAGE_KEY:   'sayyad_theme',
    SESSION_STORAGE_KEY: 'sayyad_session_active',
  };

  // Fallback option lists if settings store is empty (first offline install).
  const FALLBACK_SETTINGS = {
    branches: ['الفرع الرئيسي', 'سنتر السرايا'],
    years: [
      'الصف الأول الابتدائي',  'الصف الثاني الابتدائي',  'الصف الثالث الابتدائي',
      'الصف الرابع الابتدائي', 'الصف الخامس الابتدائي', 'الصف السادس الابتدائي',
      'الصف الأول الإعدادي',   'الصف الثاني الإعدادي',  'الصف الثالث الإعدادي',
      'الصف الأول الثانوي',    'الصف الثاني الثانوي',   'الصف الثالث الثانوي',
    ],
    days:  ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'],
    times: ['04:00 م', '06:00 م', '08:00 م'],
  };

  /**
   * Change #2 — Custom ID ranges per branch (سنتر) and stage (مرحلة).
   * -------------------------------------------------------------
   * Each branch is allotted a block of 200 numbers, split internally
   * per year/stage. Add or edit branches/years here as new centers open.
   *
   * Example (as specified): سنتر السرايا owns 200–400, split as:
   *   الصف الأول الإعدادي  → 200–269
   *   الصف الثاني الإعدادي → 270–329
   *   الصف الثالث الإعدادي → 330–400
   *
   * Any branch/year combination NOT listed here automatically falls back
   * to the legacy stage-based ranges (getIdBaseForYear) so nothing breaks
   * for branches/years that haven't been configured yet.
   */
 

  /* ===================================================================
     STATE
     =================================================================== */

  const state = {
    isLoggedIn:          false,
    students:            [],
    records:             [],
    settings:            {},
    searchQuery:         '',
    activeGroup:         'all',
    activeTab:           'attendance',   // 'attendance' | 'approvals'
    isSyncing:           false,
    isFetchingInitialData: false,
    editingRecordId:     null,
    pendingConfirmAction: null,

    // Change #4: current approval filter values
    approvalFilterYear: '',
    approvalFilterDay:  '',
    approvalFilterTime: '',
  };

  /* ===================================================================
     DOM HELPERS
     =================================================================== */

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  const els = {};

  /* ===================================================================
     UTILITIES
     =================================================================== */

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function nowTimeLabel() {
    return new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
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

  function formatPhoneDisplay(phone) {
    if (!phone) return '';
    // 01012345678 → 010 123 45678 (light grouping for readability)
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length === 11) {
      return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    }
    return digits;
  }

  function buildGroupLabel(year, branch) {
    if (!year && !branch) return '';
    if (year && branch) return `${year} - ${branch}`;
    return year || branch;
  }

  /* ===================================================================
     INIT
     =================================================================== */

  document.addEventListener('DOMContentLoaded', async () => {
    cacheDom();
    bindStaticEvents();
    registerServiceWorker();
    applySavedTheme();

    await db.init();

    state.students = await db.getAllStudents();
    state.records  = await db.getAllRecords();
    state.settings = await db.getAllSettings();

    setupConnectivityWatchers();
    hideSplash();

    // First-run: populate fallback settings if store is empty.
    if (!state.settings || Object.keys(state.settings).length === 0) {
      for (const key of Object.keys(FALLBACK_SETTINGS)) {
        await db.setSetting(key, FALLBACK_SETTINGS[key]);
      }
      state.settings = await db.getAllSettings();
    }

    // Fetch fresh data from server if online.
    if (navigator.onLine) {
      fetchInitialData();
    }

    // Change #1: restore session via a simple flag in localStorage
    const sessionActive = localStorage.getItem(CONFIG.SESSION_STORAGE_KEY);
    if (sessionActive === 'true') {
      state.isLoggedIn = true;
      enterApp();
    } else {
      showLogin();
    }
  });

  function cacheDom() {
    els.splashScreen   = $('#splashScreen');
    els.loginModal     = $('#loginModal');
    els.pinDisplay     = $('#pinDisplay');
    els.pinDots        = $$('.pin-dot', document);
    els.pinError       = $('#pinError');
    els.pinPad         = $('#pinPad');

    els.app            = $('#app');
    els.syncBadge      = $('#syncBadge');
    els.syncBadgeText  = $('#syncBadgeText');
    els.themeToggleBtn = $('#themeToggleBtn');
    els.logoutBtn      = $('#logoutBtn');
    els.addStudentBtn  = $('#addStudentBtn');

    els.tabAttendance  = $('#tabAttendance');
    els.tabApprovals   = $('#tabApprovals');
    els.pendingTabBadge = $('#pendingTabBadge');

    els.attendanceView = $('#attendanceView');
    els.approvalsView  = $('#approvalsView');

    els.studentSearch    = $('#studentSearch');
    els.clearSearchBtn   = $('#clearSearchBtn');
    els.groupChips       = $('#groupChips');
    els.studentsList     = $('#studentsList');
    els.noResults        = $('#noResults');
    els.pendingCountDisplay = $('#pendingCountDisplay');
    els.localQueueSummary   = $('#localQueueSummary');

    els.statTotalStudents   = $('#statTotalStudents');
    els.statActiveGroups    = $('#statActiveGroups');
    els.statPendingApprovals = $('#statPendingApprovals');
    els.statApprovedToday   = $('#statApprovedToday');
    els.approvalsList       = $('#approvalsList');
    els.noApprovals         = $('#noApprovals');
    els.approveAllBtn       = $('#approveAllBtn');
    els.exportExcelBtn      = $('#exportExcelBtn');

    // Change #4: drill-down filter dropdowns
    els.filterYear = $('#filterYear');
    els.filterDay  = $('#filterDay');
    els.filterTime = $('#filterTime');

    els.studentCardTemplate  = $('#studentCardTemplate');
    els.approvalCardTemplate = $('#approvalCardTemplate');

    // Edit modal
    els.editModal          = $('#editModal');
    els.editModalClose     = $('#editModalClose');
    els.editStudentName    = $('#editStudentName');
    els.editHomeworkGrade  = $('#editHomeworkGrade');
    els.editHomeworkMax    = $('#editHomeworkMax');
    els.editExamGrade      = $('#editExamGrade');
    els.editExamMax        = $('#editExamMax');
    els.editNotes          = $('#editNotes');
    els.saveEditBtn        = $('#saveEditBtn');
    els.deleteRecordBtn    = $('#deleteRecordBtn');

    // Confirm modal
    els.confirmModal     = $('#confirmModal');
    els.confirmTitle     = $('#confirmTitle');
    els.confirmMessage   = $('#confirmMessage');
    els.confirmCancelBtn = $('#confirmCancelBtn');
    els.confirmOkBtn     = $('#confirmOkBtn');

    // Add student modal
    els.addStudentModal     = $('#addStudentModal');
    els.addStudentModalClose = $('#addStudentModalClose');
    els.newStudentName      = $('#newStudentName');
    els.newStudentPhone     = $('#newStudentPhone');
    els.newStudentYear      = $('#newStudentYear');
    els.newStudentBranch    = $('#newStudentBranch');
    els.newStudentDay       = $('#newStudentDay');
    els.newStudentTime      = $('#newStudentTime');
    els.cancelAddStudentBtn = $('#cancelAddStudentBtn');
    els.saveNewStudentBtn   = $('#saveNewStudentBtn');
    els.idPreviewValue      = $('#idPreviewValue');

    els.toastContainer = $('#toastContainer');
  }

  function hideSplash() {
    setTimeout(() => {
      els.splashScreen.classList.add('fade-out');
    }, 450);
  }

  /* ===================================================================
     THEME TOGGLE
     =================================================================== */

  function applySavedTheme() {
    let saved = null;
    try { saved = localStorage.getItem(CONFIG.THEME_STORAGE_KEY); } catch (_) { /* noop */ }
    const isLight = saved ? saved === 'light' : true;
    document.body.classList.toggle('light-theme', isLight);
  }

  function toggleTheme() {
    const isNowLight = !document.body.classList.contains('light-theme');
    document.body.classList.toggle('light-theme', isNowLight);
    try { localStorage.setItem(CONFIG.THEME_STORAGE_KEY, isNowLight ? 'light' : 'dark'); } catch (_) { /* noop */ }
    vibrate(10);
  }

  /* ===================================================================
     TAB NAVIGATION
     =================================================================== */

  function switchTab(tab) {
    state.activeTab = tab;

    els.tabAttendance.classList.toggle('active', tab === 'attendance');
    els.tabApprovals.classList.toggle('active',  tab === 'approvals');

    els.attendanceView.classList.toggle('hidden', tab !== 'attendance');
    els.approvalsView.classList.toggle('hidden',  tab !== 'approvals');

    if (tab === 'approvals') {
      renderApprovalsView();
    }
  }

  /* ===================================================================
     API — INITIAL DATA FETCH
     =================================================================== */

  async function fetchInitialData() {
    if (state.isFetchingInitialData || !navigator.onLine) return;
    state.isFetchingInitialData = true;
    updateSyncBadge();

    try {
      if (!isApiConfigured()) {
        console.info('[Init] No API endpoint configured; running on cached data.');
        return;
      }

      const res  = await fetch(`${CONFIG.API_ENDPOINT}?action=bootstrap&t=${Date.now()}`, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (Array.isArray(data.students)) {
        state.students = await db.replaceAllStudents(data.students);
      }
      if (data.settings && typeof data.settings === 'object') {
        for (const key of Object.keys(data.settings)) {
          await db.setSetting(key, data.settings[key]);
        }
        state.settings = await db.getAllSettings();
      }

      await db.setMeta('lastFetchAt', Date.now());
      console.info('[Init] Remote data refreshed.');
    } catch (err) {
      console.warn('[Init] Could not fetch remote data.', err);
    } finally {
      state.isFetchingInitialData = false;
      updateSyncBadge();
      if (state.isLoggedIn) {
        buildGroupChips();
        renderStudentsList();
        updatePendingBadge();
      }
    }
  }

  /* ===================================================================
     CHANGE #1 — STATIC PIN AUTHENTICATION
     =================================================================== */

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
      if (digit == null || pinBuffer.length >= CONFIG.PIN_LENGTH) return;
      pinBuffer += digit;
      renderPinDots();
      if (pinBuffer.length === CONFIG.PIN_LENGTH) {
        setTimeout(() => attemptLogin(pinBuffer), 120);
      }
    });

    // Physical keyboard PIN support
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
    els.themeToggleBtn.addEventListener('click', toggleTheme);
    els.addStudentBtn.addEventListener('click', openAddStudentModal);

    // Tab switching
    els.tabAttendance.addEventListener('click', () => switchTab('attendance'));
    els.tabApprovals.addEventListener('click',  () => switchTab('approvals'));

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

    // Group chips (delegated)
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
    els.exportExcelBtn.addEventListener('click', exportTodayToExcel);

    // Change #4: filter dropdowns — cascading repopulation + re-render
    els.filterYear.addEventListener('change', () => {
      state.approvalFilterYear = els.filterYear.value;
      state.approvalFilterDay  = '';
      state.approvalFilterTime = '';
      populateApprovalFilters();
      renderApprovalsList();
    });
    els.filterDay.addEventListener('change', () => {
      state.approvalFilterDay  = els.filterDay.value;
      state.approvalFilterTime = '';
      populateDayFilter();
      populateTimeFilter();
      renderApprovalsList();
    });
    els.filterTime.addEventListener('change', () => {
      state.approvalFilterTime = els.filterTime.value;
      renderApprovalsList();
    });

    // Edit modal
    els.editModalClose.addEventListener('click', closeEditModal);
    els.editModal.addEventListener('click', (e) => { if (e.target === els.editModal) closeEditModal(); });
    els.saveEditBtn.addEventListener('click', saveEditModal);
    els.deleteRecordBtn.addEventListener('click', confirmDeleteFromEdit);

    // Confirm modal
    els.confirmCancelBtn.addEventListener('click', closeConfirmModal);
    els.confirmModal.addEventListener('click', (e) => { if (e.target === els.confirmModal) closeConfirmModal(); });
    els.confirmOkBtn.addEventListener('click', () => {
      if (typeof state.pendingConfirmAction === 'function') state.pendingConfirmAction();
      closeConfirmModal();
    });

    // Add student modal
    els.addStudentModalClose.addEventListener('click', closeAddStudentModal);
    els.cancelAddStudentBtn.addEventListener('click', closeAddStudentModal);
    els.addStudentModal.addEventListener('click', (e) => { if (e.target === els.addStudentModal) closeAddStudentModal(); });
    els.saveNewStudentBtn.addEventListener('click', saveNewStudent);

    // Change #2: update ID preview live when year changes
    els.newStudentYear.addEventListener('change', updateIdPreview);
    els.newStudentBranch.addEventListener('change', updateIdPreview); // Change #2: react to branch too
  }

  /**
   * Change #1: compares against hardcoded ADMIN_PIN only.
   */
  function attemptLogin(pin) {
    if (pin !== CONFIG.ADMIN_PIN) {
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

    state.isLoggedIn = true;
    try { localStorage.setItem(CONFIG.SESSION_STORAGE_KEY, 'true'); } catch (_) { /* noop */ }
    els.pinError.classList.add('hidden');
    enterApp();
  }

  function handleLogout() {
    openConfirm(
      'تسجيل الخروج',
      'هل تريد بالفعل تسجيل الخروج من النظام؟',
      () => {
        state.isLoggedIn = false;
        try { localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY); } catch (_) { /* noop */ }
        els.app.classList.add('hidden');
        showLogin();
      }
    );
  }

  function enterApp() {
    els.loginModal.classList.add('hidden');
    els.loginModal.setAttribute('aria-hidden', 'true');
    els.app.classList.remove('hidden');

    // Default to attendance view on login
    switchTab('attendance');
    buildGroupChips();
    renderStudentsList();
    updatePendingBadge();
    updateSyncBadge();

    if (navigator.onLine) {
      fetchInitialData();
    }
  }

  /* ===================================================================
     CONNECTIVITY / SYNC ENGINE
     =================================================================== */

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
   * Pushes approved records and pending-creation students to the API.
   * Change #5: payload only ever contains present records; absent field is gone.
   */
  async function triggerSync() {
    if (state.isSyncing || !navigator.onLine) return;

    const pendingStudents = await db.getStudentsPendingCreation();
    // Only push approved/failed records — pending records wait for admin approval.
    const toSyncRecords   = state.records.filter((r) => r.status === 'approved' || r.status === 'failed');

    if (pendingStudents.length === 0 && toSyncRecords.length === 0) return;

    state.isSyncing = true;
    updateSyncBadge();

    // Push new students
    for (const student of pendingStudents) {
      try {
        const ok = await pushStudentToApi(student);
        if (ok) {
          await db.upsertStudent({ ...student, syncStatus: 'synced' });
        }
      } catch (err) { /* keep trying next time */ }
    }

    // Push approved records
    let recSuccess = 0, recFail = 0;
    for (const record of toSyncRecords) {
      try {
        const ok = await pushRecordToApi(record);
        if (ok) {
          record.status   = 'synced';
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
    state.records  = await db.getAllRecords();
    state.isSyncing = false;
    updateSyncBadge();

    if (recSuccess > 0) showToast(`تمت مزامنة ${recSuccess} سجل بنجاح`, 'success');
    if (recFail    > 0) showToast(`تعذّرت مزامنة ${recFail} سجل، سيُعاد المحاولة تلقائيًا`, 'error');

    updatePendingBadge();
    if (state.activeTab === 'approvals') renderApprovalsView();
  }

  /**
   * Change #5: no attendance field for absent; all records are implicitly present.
   * The payload sends the captured checkin timestamp so the backend knows when
   * the student walked in.
   */
  async function pushRecordToApi(record) {
    if (!isApiConfigured()) {
      console.info('[Sync] No API endpoint — simulating push.', record);
      return true;
    }
    try {
      const res = await fetch(CONFIG.API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          type:          'record',
          recordId:      record.recordId,
          studentId:     record.studentId,
          studentName:   record.studentName,
          group:         record.group,
          year:          record.year,
          day:           record.day,
          time:          record.time,
          // Change #5: attendance is always 'present' — field kept for API
          // compatibility but value is always present.
          attendance:    'present',
          checkinAt:     record.checkinAt,
          homeworkGrade: record.homeworkGrade,
          homeworkMax:   record.homeworkMax,
          examGrade:     record.examGrade,
          examMax:       record.examMax,
          notes:         record.notes,
          approvedBy:    record.approvedBy,
          dateKey:       record.dateKey,
          createdAt:     record.createdAt,
          approvedAt:    record.approvedAt,
        }),
      });
      return res.ok;
    } catch (err) {
      console.warn('[Sync] Record push failed', record.recordId, err);
      return false;
    }
  }

  async function pushStudentToApi(student) {
    if (!isApiConfigured()) {
      console.info('[Sync] No API endpoint — simulating student push.', student);
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
      console.warn('[Sync] Student push failed', student.id, err);
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
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (nw) nw.addEventListener('statechange', () => {
            if (nw.state === 'activated') console.info('[SW] Cache updated.');
          });
        });
      }).catch((err) => console.warn('[SW] Registration failed', err));

      navigator.serviceWorker.ready.then((reg) => {
        if ('sync' in reg) reg.sync.register('sayyad-sync-queue').catch(() => {});
      }).catch(() => {});

      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'SAYYAD_TRIGGER_SYNC') triggerSync();
      });
    });
  }

  /* ===================================================================
     ATTENDANCE VIEW — RENDERING
     =================================================================== */

  function buildGroupChips() {
    const groups = Array.from(new Set(state.students.map((s) => s.group).filter(Boolean))).sort();
    els.groupChips.innerHTML = '<button class="chip active" data-group="all">الكل</button>' +
      groups.map((g) => `<button class="chip" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('');
    // Re-activate the current group chip
    $$('.chip', els.groupChips).forEach((c) => {
      c.classList.toggle('active', c.dataset.group === state.activeGroup);
    });
  }

  function getFilteredStudents() {
    let list = state.students;
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

  function getTodayActiveRecordForStudent(studentId) {
    const today = todayKey();
    const candidates = state.records.filter(
      (r) => r.studentId === studentId &&
             r.dateKey   === today     &&
             r.status    !== 'approved' &&
             r.status    !== 'synced'
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
    list.forEach((student) => frag.appendChild(buildStudentCard(student)));
    els.studentsList.appendChild(frag);
  }

  function buildStudentCard(student) {
    const node = els.studentCardTemplate.content.cloneNode(true);
    const card = node.querySelector('.student-card');
    card.dataset.id = student.id;

    node.querySelector('.student-avatar').textContent = initials(student.name);
    node.querySelector('.student-name').textContent   = student.name;
    node.querySelector('.student-id').textContent     = student.id;
    node.querySelector('.tag-group').textContent      = student.group || '—';

    // اسم السنتر ورقم هاتف ولي الأمر تحت اسم الطالب مباشرة
    const branchEl = node.querySelector('[data-role="studentBranch"]');
    const phoneEl  = node.querySelector('[data-role="studentPhone"]');
    const subSep   = node.querySelector('[data-role="subSep"]');
    const hasBranch = !!student.branch;
    const hasPhone  = !!student.phone;
    branchEl.textContent = hasBranch ? student.branch : '';
    phoneEl.textContent  = hasPhone ? formatPhoneDisplay(student.phone) : '';
    subSep.classList.toggle('hidden', !(hasBranch && hasPhone));

    if (student.syncStatus === 'pending_creation') {
      const tags = node.querySelector('.student-tags');
      const pendingTag = document.createElement('span');
      pendingTag.className = 'tag tag-id';
      pendingTag.textContent = '🆕 بانتظار المزامنة';
      tags.appendChild(pendingTag);
    }

    // Default max grades
    const hwMaxInput   = node.querySelector('[data-field="homeworkMax"]');
    const examMaxInput = node.querySelector('[data-field="examMax"]');
    if (hwMaxInput)   hwMaxInput.value   = CONFIG.DEFAULT_HOMEWORK_MAX;
    if (examMaxInput) examMaxInput.value = CONFIG.DEFAULT_EXAM_MAX;

    const existingRecord = getTodayActiveRecordForStudent(student.id);
    const statusPill     = node.querySelector('[data-role="statusPill"]');
    const draftConfirm   = node.querySelector('[data-role="draftConfirm"]');
    const draftTime      = node.querySelector('[data-role="draftTime"]');
    const presentBtn     = node.querySelector('[data-action="present"]');
    const saveBtn        = node.querySelector('[data-action="save"]');

    if (existingRecord) {
      // Fill in saved grades/notes
      const hw   = node.querySelector('[data-field="homeworkGrade"]');
      const hwM  = node.querySelector('[data-field="homeworkMax"]');
      const ex   = node.querySelector('[data-field="examGrade"]');
      const exM  = node.querySelector('[data-field="examMax"]');
      const notes = node.querySelector('[data-field="notes"]');
      if (existingRecord.homeworkGrade != null) hw.value   = existingRecord.homeworkGrade;
      if (existingRecord.homeworkMax   != null) hwM.value  = existingRecord.homeworkMax;
      if (existingRecord.examGrade     != null) ex.value   = existingRecord.examGrade;
      if (existingRecord.examMax       != null) exM.value  = existingRecord.examMax;
      if (existingRecord.notes)                 notes.value = existingRecord.notes;

      if (existingRecord.status === 'draft') {
        // Step 1 complete — show draft confirmation banner
        card.classList.add('draft-active');
        presentBtn.classList.add('active');
        draftConfirm.classList.remove('hidden');
        if (existingRecord.checkinAt) {
          draftTime.textContent = `في ${new Date(existingRecord.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
        }
        saveBtn.disabled = false;
        updateStatusPill(statusPill, 'draft');
      } else if (existingRecord.status === 'pending' || existingRecord.status === 'failed') {
        // Both steps done
        card.classList.add('draft-active');
        presentBtn.classList.add('active');
        draftConfirm.classList.remove('hidden');
        if (existingRecord.checkinAt) {
          draftTime.textContent = `في ${new Date(existingRecord.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
        }
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<span>📤</span> تم الإرسال للاعتماد';
        saveBtn.disabled = true; // Already sent for approval
        updateStatusPill(statusPill, 'pending');
      }
    } else {
      // No record yet — save button stays disabled until حاضر is pressed
      saveBtn.disabled = true;
      updateStatusPill(statusPill, null);
    }

    return node;
  }

  function updateStatusPill(pillEl, status) {
    pillEl.classList.remove('status-none', 'status-draft', 'status-pending', 'status-approved');
    if (status === 'draft') {
      pillEl.classList.add('status-draft');
      pillEl.textContent = 'تم تسجيل الدخول';
    } else if (status === 'pending' || status === 'failed') {
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

  function handleStudentListClick(e) {
    const card = e.target.closest('.student-card');
    if (!card) return;
    const studentId = card.dataset.id;

    // Change #3: Step 1 — "حاضر" button click
    if (e.target.closest('[data-action="present"]')) {
      handlePresentClick(card, studentId);
      return;
    }

    // Change #3: Step 2 — "إرسال للاعتماد" button click
    if (e.target.closest('[data-action="save"]')) {
      handleSendForApproval(card, studentId);
    }
  }

  /**
   * Change #3 — Step 1:
   * Immediately create a `draft` record with the precise checkin timestamp.
   * Visually: green border + banner. Unlocks the "إرسال للاعتماد" button.
   */
  async function handlePresentClick(card, studentId) {
    const student = state.students.find((s) => String(s.id) === String(studentId));
    if (!student) return;

    const presentBtn   = card.querySelector('[data-action="present"]');
    const saveBtn      = card.querySelector('[data-action="save"]');
    const draftConfirm = card.querySelector('[data-role="draftConfirm"]');
    const draftTime    = card.querySelector('[data-role="draftTime"]');
    const statusPill   = card.querySelector('[data-role="statusPill"]');

    // Prevent double-tap re-creating if already in draft/pending
    const existing = getTodayActiveRecordForStudent(studentId);
    if (existing && (existing.status === 'pending' || existing.status === 'failed')) {
      showToast(`${student.name} تم إرساله للاعتماد مسبقًا`, 'info');
      return;
    }

    const now = Date.now();

    const record = {
      recordId:      existing ? existing.recordId : uid('rec'),
      studentId:     student.id,
      studentName:   student.name,
      group:         student.group || '',
      year:          student.year  || '',
      day:           student.day   || '',
      time:          student.time  || '',
      checkinAt:     existing ? existing.checkinAt : now,
      homeworkGrade: null,
      homeworkMax:   CONFIG.DEFAULT_HOMEWORK_MAX,
      examGrade:     null,
      examMax:       CONFIG.DEFAULT_EXAM_MAX,
      notes:         '',
      status:        'draft',
      dateKey:       todayKey(),
      createdAt:     existing ? existing.createdAt : now,
      updatedAt:     now,
    };

    await db.upsertRecord(record);
    state.records = await db.getAllRecords();

    // Visual feedback
    card.classList.add('draft-active');
    presentBtn.classList.add('active');
    draftConfirm.classList.remove('hidden');
    const timeLabel = new Date(record.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    draftTime.textContent = `في ${timeLabel}`;
    saveBtn.disabled = false;
    updateStatusPill(statusPill, 'draft');

    vibrate([15, 10, 15]);
    updatePendingBadge();
  }

  /**
   * Change #3 — Step 2:
   * Read grades/notes from the card, upgrade the draft record to `pending`.
   * Change #5: no absent field written anywhere.
   */
  async function handleSendForApproval(card, studentId) {
    const student = state.students.find((s) => String(s.id) === String(studentId));
    if (!student) return;

    const saveBtn    = card.querySelector('[data-action="save"]');
    const statusPill = card.querySelector('[data-role="statusPill"]');

    // Must have a draft record first (step 1)
    const existing = getTodayActiveRecordForStudent(studentId);
    if (!existing || existing.status !== 'draft') {
      showToast('من فضلك سجّل الحضور أولاً (اضغط حاضر)', 'error');
      return;
    }

    const homeworkGrade = card.querySelector('[data-field="homeworkGrade"]').value;
    const homeworkMax   = card.querySelector('[data-field="homeworkMax"]').value;
    const examGrade     = card.querySelector('[data-field="examGrade"]').value;
    const examMax       = card.querySelector('[data-field="examMax"]').value;
    const notes         = card.querySelector('[data-field="notes"]').value.trim();

    const updated = {
      ...existing,
      homeworkGrade: homeworkGrade === '' ? null : Number(homeworkGrade),
      homeworkMax:   homeworkMax   === '' ? CONFIG.DEFAULT_HOMEWORK_MAX : Number(homeworkMax),
      examGrade:     examGrade     === '' ? null : Number(examGrade),
      examMax:       examMax       === '' ? CONFIG.DEFAULT_EXAM_MAX : Number(examMax),
      notes,
      status:    'pending',
      updatedAt: Date.now(),
    };

    await db.upsertRecord(updated);
    state.records = await db.getAllRecords();

    // Lock the button and confirm
    saveBtn.innerHTML = '<span>📤</span> تم الإرسال للاعتماد';
    saveBtn.disabled  = true;
    card.classList.add('saved-flash');
    vibrate([20, 30, 20]);

    setTimeout(() => card.classList.remove('saved-flash'), 900);
    updateStatusPill(statusPill, 'pending');
    updatePendingBadge();
    showToast(`تم إرسال ${student.name} للاعتماد بنجاح`, 'success');
  }

  function updatePendingBadge() {
    const pendingCount = state.records.filter(
      (r) => r.status === 'pending' || r.status === 'failed' || r.status === 'draft'
    ).length;

    els.pendingCountDisplay.textContent = pendingCount;
    els.localQueueSummary.classList.toggle('hidden', pendingCount === 0);

    // Tab badge: only show pending (not draft) in the approvals tab counter
    const approvalCount = state.records.filter((r) => r.status === 'pending' || r.status === 'failed').length;
    els.pendingTabBadge.textContent = approvalCount;
    els.pendingTabBadge.classList.toggle('hidden', approvalCount === 0);

    if (els.statPendingApprovals) els.statPendingApprovals.textContent = approvalCount;
  }

  /* ===================================================================
     CHANGE #2 — SMART STUDENT ID GENERATION
     =================================================================== */

  /**
   * Returns the ID base for a year string based on the school stage keyword.
   *   "ابتدائي"  → 1000
   *   "إعدادي"   → 2000
   *   "ثانوي"    → 3000
   *   (fallback) → 1000
   */
  function getIdBaseForYear(year) {
    if (!year) return CONFIG.ID_BASE_PRIMARY;
    if (year.includes('ابتدائي')) return CONFIG.ID_BASE_PRIMARY;
    if (year.includes('إعدادي'))  return CONFIG.ID_BASE_PREPARATORY;
    if (year.includes('ثانوي'))   return CONFIG.ID_BASE_SECONDARY;
    return CONFIG.ID_BASE_PRIMARY;
  }

  /**
   * Looks up a custom {start, end} range for a given branch + year, if one
   * has been configured in BRANCH_YEAR_RANGES. Returns null otherwise so
   * the caller can fall back to the legacy stage-based range.
   */
  /**
   * Change #2 — Smart Dynamic ID Generation
   * يولد النطاقات ديناميكياً بناءً على ترتيب الفروع والمراحل في الإعدادات
   */
  /**
   * Change #2 — Smart Dynamic ID Generation
   * يولد النطاقات ديناميكياً بناءً على ترتيب الفروع والمراحل في الإعدادات
   */
  function buildDynamicRanges() {
    const ranges = {};
    // استخدام الصيغة الآمنة بدلاً منعلامة الاستفهام
    const branches = (state.settings && state.settings.branches) ? state.settings.branches : FALLBACK_SETTINGS.branches;
    const years = (state.settings && state.settings.years) ? state.settings.years : FALLBACK_SETTINGS.years;
    
    const RANGE_SIZE_PER_BRANCH = 200; // 200 رقم لكل فرع
    const BASE_START_ID = 200; // أول فرع يبدأ من رقم 200

    if (!branches || !years || years.length === 0) return ranges;

    // حساب عدد الأرقام لكل مرحلة داخل الفرع الواحد
    const sizePerYear = Math.floor(RANGE_SIZE_PER_BRANCH / years.length);

    branches.forEach((branch, branchIndex) => {
      ranges[branch] = {};
      const branchStart = BASE_START_ID + (branchIndex * RANGE_SIZE_PER_BRANCH);
      
      years.forEach((year, yearIndex) => {
        const yearStart = branchStart + (yearIndex * sizePerYear);
        // المرحلة الأخيرة تأخذ ما تبقى من النطاق لضمان تغطية الـ 200 رقم بالكامل
        const yearEnd = (yearIndex === years.length - 1) 
                        ? (branchStart + RANGE_SIZE_PER_BRANCH - 1) 
                        : (yearStart + sizePerYear - 1);
        
        ranges[branch][year] = { start: yearStart, end: yearEnd };
      });
    });

    return ranges;
  }
  /**
   * يبحث عن النطاق المخصص للفرع والمرحلة باستخدام الدالة الديناميكية.
   */
  function getCustomRange(branch, year) {
    const dynamicRanges = buildDynamicRanges();
    const branchRanges = dynamicRanges[branch];
    if (!branchRanges) return null;
    return branchRanges[year] || null;
  }

 function generateNextStudentId(branch, year) {
    const customRange = getCustomRange(branch, year);

    let start, end;
    if (customRange) {
      // تم العثور على النطاق الديناميكي المخصص
      start = customRange.start;
      end   = customRange.end;
    } else {
      // Fallback: legacy stage-based range (لا يوجد فرع أو مرحلة مسجلة)
      start = getIdBaseForYear(year);
      end   = start + 999;
    }

    let maxId = start - 1;
    state.students.forEach((s) => {
      const numId = parseInt(s.id, 10);
      if (!isNaN(numId) && numId >= start && numId <= end && numId > maxId) {
        maxId = numId;
      }
    });

    const nextId = maxId + 1;
    return nextId > end ? null : String(nextId); // null = range exhausted
  }



  function updateIdPreview() {
    const branch = els.newStudentBranch.value;
    const year   = els.newStudentYear.value;

    if (!branch || !year) {
      els.idPreviewValue.textContent = '—';
      return;
    }

    const nextId = generateNextStudentId(branch, year);
    if (nextId === null) {
      els.idPreviewValue.textContent = 'انتهى النطاق المخصص!';
    } else {
      els.idPreviewValue.textContent = nextId;
    }
  }

  /* ===================================================================
     ADD NEW STUDENT (Offline-First)
     =================================================================== */

  function populateSelect(selectEl, options, placeholder) {
    const current = selectEl.value;
    selectEl.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
      (options || []).map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('');
    if (options && options.includes(current)) selectEl.value = current;
  }

  async function openAddStudentModal() {
    state.settings = await db.getAllSettings();
    const settings = (state.settings && Object.keys(state.settings).length > 0)
      ? state.settings : FALLBACK_SETTINGS;

    populateSelect(els.newStudentYear,   settings.years    || FALLBACK_SETTINGS.years,    'اختر الصف');
    populateSelect(els.newStudentBranch, settings.branches || FALLBACK_SETTINGS.branches, 'اختر الفرع');
    populateSelect(els.newStudentDay,    settings.days     || FALLBACK_SETTINGS.days,     'اختر اليوم');
    populateSelect(els.newStudentTime,   settings.times    || FALLBACK_SETTINGS.times,    'اختر الموعد');

    els.newStudentName.value   = '';
    els.newStudentPhone.value  = '';
    els.idPreviewValue.textContent = '—';

    els.addStudentModal.classList.remove('hidden');
    els.addStudentModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => els.newStudentName.focus(), 100);
  }

  function closeAddStudentModal() {
    els.addStudentModal.classList.add('hidden');
    els.addStudentModal.setAttribute('aria-hidden', 'true');
  }

  async function saveNewStudent() {
    const name   = els.newStudentName.value.trim();
    const phone  = els.newStudentPhone.value.trim();
    const year   = els.newStudentYear.value;
    const branch = els.newStudentBranch.value;
    const day    = els.newStudentDay.value;
    const time   = els.newStudentTime.value;

    if (!name) {
      showToast('⚠️ من فضلك اكتب اسم الطالب', 'error');
      els.newStudentName.focus();
      return;
    }
    if (!year || !branch || !day || !time) {
      showToast('⚠️ يجب اختيار جميع بيانات المجموعة (الصف / الفرع / اليوم / الموعد)', 'error');
      return;
    }
    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 11) {
      showToast('⚠️ رقم هاتف ولي الأمر غير صحيح — يجب ألا يقل عن 11 رقمًا', 'error');
      els.newStudentPhone.focus();
      return;
    }

    const group  = buildGroupLabel(year, branch);
    const nextId = generateNextStudentId(branch, year); // Change #2

    if (nextId === null) {
      showToast('⚠️ انتهى النطاق المخصص لهذا السنتر/المرحلة، برجاء مراجعة الإدارة', 'error');
      return;
    }

    const newStudent = {
      id:          nextId,
      name,
      phone:       phoneDigits,
      year,
      branch,
      day,
      time,
      group,
      syncStatus:  'pending_creation',
      createdAt:   Date.now(),
    };

    await db.upsertStudent(newStudent);
    state.students = await db.getAllStudents();

    closeAddStudentModal();
    buildGroupChips();
    renderStudentsList();

    showToast(`✅ تم الحفظ! كود الطالب الجديد: [ ${nextId} ]`, 'success');
    vibrate([20, 30, 20]);

    if (navigator.onLine) triggerSync();
  }

  /* ===================================================================
     CHANGE #4 — DRILL-DOWN APPROVALS VIEW
     =================================================================== */

  /**
   * Renders the full approvals view: stats + cascading filters + list.
   */
  function renderApprovalsView() {
    // Stats
    const totalStudents  = state.students.length;
    const activeGroups   = new Set(state.students.map((s) => s.group)).size;
    const pendingAll     = state.records.filter((r) => r.status === 'pending' || r.status === 'failed');
    const today          = todayKey();
    const approvedToday  = state.records.filter(
      (r) => (r.status === 'approved' || r.status === 'synced') && r.dateKey === today
    );

    els.statTotalStudents.textContent    = totalStudents;
    els.statActiveGroups.textContent     = activeGroups;
    els.statPendingApprovals.textContent = pendingAll.length;
    els.statApprovedToday.textContent    = approvedToday.length;

    // Populate filter dropdowns from live pending records
    populateApprovalFilters();

    // Render the filtered list
    renderApprovalsList();
  }

  /**
   * Change #4: Populates all three filter dropdowns from the current set of
   * pending records. Each dropdown only shows values that exist in the data.
   */
  function populateApprovalFilters() {
    const pending = state.records.filter((r) => r.status === 'pending' || r.status === 'failed');

    // Year filter: all unique years in pending
    const years = Array.from(new Set(pending.map((r) => r.year).filter(Boolean))).sort();
    const savedYear = state.approvalFilterYear;
    els.filterYear.innerHTML = '<option value="">— كل الصفوف —</option>' +
      years.map((y) => `<option value="${escapeHtml(y)}" ${y === savedYear ? 'selected' : ''}>${escapeHtml(y)}</option>`).join('');
    state.approvalFilterYear = els.filterYear.value; // may reset if saved value is gone

    populateDayFilter();
    populateTimeFilter();
  }

  /**
   * Populate the Day dropdown based on the currently selected Year filter.
   */
  function populateDayFilter() {
    const pending = getYearFilteredPending();
    const days    = Array.from(new Set(pending.map((r) => r.day).filter(Boolean))).sort();
    const savedDay = state.approvalFilterDay;

    els.filterDay.innerHTML = '<option value="">— كل الأيام —</option>' +
      days.map((d) => `<option value="${escapeHtml(d)}" ${d === savedDay ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('');
    state.approvalFilterDay = els.filterDay.value;

    populateTimeFilter();
  }

  /**
   * Populate the Time dropdown based on Year + Day filters.
   */
  function populateTimeFilter() {
    const pending   = getDayFilteredPending();
    const times     = Array.from(new Set(pending.map((r) => r.time).filter(Boolean))).sort();
    const savedTime = state.approvalFilterTime;

    els.filterTime.innerHTML = '<option value="">— كل المواعيد —</option>' +
      times.map((t) => `<option value="${escapeHtml(t)}" ${t === savedTime ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
    state.approvalFilterTime = els.filterTime.value;
  }

  function getYearFilteredPending() {
    const all = state.records.filter((r) => r.status === 'pending' || r.status === 'failed');
    if (!state.approvalFilterYear) return all;
    return all.filter((r) => r.year === state.approvalFilterYear);
  }

  function getDayFilteredPending() {
    const yearFiltered = getYearFilteredPending();
    if (!state.approvalFilterDay) return yearFiltered;
    return yearFiltered.filter((r) => r.day === state.approvalFilterDay);
  }

  /**
   * Returns the final filtered set respecting all three cascading filters.
   */
  function getFullyFilteredPending() {
    let list = state.records.filter((r) => r.status === 'pending' || r.status === 'failed');
    if (state.approvalFilterYear) list = list.filter((r) => r.year === state.approvalFilterYear);
    if (state.approvalFilterDay)  list = list.filter((r) => r.day  === state.approvalFilterDay);
    if (state.approvalFilterTime) list = list.filter((r) => r.time === state.approvalFilterTime);
    return list;
  }

  /**
   * Renders only the filtered pending records. "Approve All" acts on this filtered set.
   */
  function renderApprovalsList() {
    const filtered = getFullyFilteredPending();
    els.approvalsList.innerHTML = '';

    if (filtered.length === 0) {
      els.noApprovals.classList.remove('hidden');
      els.approveAllBtn.classList.add('hidden');
      return;
    }

    els.noApprovals.classList.add('hidden');
    els.approveAllBtn.classList.remove('hidden');

    const sorted = [...filtered].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    const frag   = document.createDocumentFragment();
    sorted.forEach((record) => frag.appendChild(buildApprovalCard(record)));
    els.approvalsList.appendChild(frag);
  }

  function buildApprovalCard(record) {
    const node = els.approvalCardTemplate.content.cloneNode(true);
    const card = node.querySelector('.approval-card');
    card.dataset.id = record.recordId;

    node.querySelector('.student-avatar').textContent = initials(record.studentName);
    node.querySelector('.student-name').textContent   = record.studentName;
    node.querySelector('.student-id').textContent     = record.studentId;
    node.querySelector('.tag-group').textContent      = record.group || '—';

    const timeEl = node.querySelector('[data-role="time"]');
    if (record.status === 'failed') {
      timeEl.textContent = '⚠️ فشلت المزامنة سابقًا';
    } else {
      timeEl.textContent = formatRelativeTime(record.updatedAt || record.createdAt);
    }

    // Change #5: attendance pill is always "حاضر" — no غائب pill needed
    const attendancePill = node.querySelector('[data-role="attendancePill"]');
    attendancePill.textContent = '✅ حاضر';
    attendancePill.classList.add('present-pill');

    // Checkin time if captured
    if (record.checkinAt) {
      const checkinLabel = new Date(record.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      attendancePill.textContent = `✅ حاضر — ${checkinLabel}`;
    }

    const hwMax   = record.homeworkMax != null ? record.homeworkMax : CONFIG.DEFAULT_HOMEWORK_MAX;
    const examMax = record.examMax     != null ? record.examMax     : CONFIG.DEFAULT_EXAM_MAX;

    node.querySelector('[data-role="homeworkPill"]').textContent =
      record.homeworkGrade != null ? `واجب: ${record.homeworkGrade} / ${hwMax}` : 'واجب: —';
    node.querySelector('[data-role="examPill"]').textContent =
      record.examGrade != null ? `امتحان: ${record.examGrade} / ${examMax}` : 'امتحان: —';

    node.querySelector('[data-role="notesText"]').textContent = record.notes || '';

    // Build meta line: year, day, time
    const metaParts = [record.year, record.day, record.time].filter(Boolean);
    node.querySelector('[data-role="metaText"]').textContent = metaParts.join(' — ') || '—';

    return node;
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const diffMs  = Date.now() - timestamp;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1)  return 'الآن';
    if (diffMin < 60) return `منذ ${diffMin} دقيقة`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24)  return `منذ ${diffHr} ساعة`;
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
      approvedAt: Date.now(),
    });

    state.records = await db.getAllRecords();
    renderApprovalsView();
    updatePendingBadge();
    showToast(`تم اعتماد سجل ${record.studentName} وسيتم إرساله تلقائيًا`, 'success');
    vibrate([15, 20, 15]);
    triggerSync();
  }

  /**
   * Change #4: "Approve All" approves ONLY the currently filtered visible set.
   */
  /**
   * Change #4 & #5: "Approve All" approves ONLY the currently filtered visible set.
   * After syncing the present records, it triggers the backend to calculate absentees.
   */
  /**
   * "Approve All" approves ONLY the currently filtered visible set.
   * After syncing the present records, it triggers the backend to calculate absentees
   * accurately based on (Year + Group (which includes Branch) + Day + Time).
   */
  async function handleApproveAll() {
    const filtered = getFullyFilteredPending();
    if (filtered.length === 0) return;

    // Build a description of the active filter for the confirm message
    const filterDesc = [
      state.approvalFilterYear && `الصف: ${state.approvalFilterYear}`,
      state.approvalFilterDay  && `اليوم: ${state.approvalFilterDay}`,
      state.approvalFilterTime && `الموعد: ${state.approvalFilterTime}`,
    ].filter(Boolean).join(' / ') || 'جميع الفلاتر';

    openConfirm(
      'اعتماد السجلات المرشّحة',
      `سيتم اعتماد ${filtered.length} سجل (${filterDesc}) وإرسالها دفعة واحدة. هل تريد المتابعة؟`,
      async () => {
        // 1. Gather exact sessions to finalize (Year + Group + Day + Time)
        const sessionsToFinalize = {};

        for (const record of filtered) {
          // الملاحظة هنا: record.group متخزن فيها (الصف + الفرع) مع بعض
          if (record.year && record.day && record.time && record.dateKey) {
            const key = `${record.year}|${record.group}|${record.day}|${record.time}|${record.dateKey}`;
            sessionsToFinalize[key] = {
              year: record.year,
              group: record.group,
              day: record.day,
              time: record.time,
              dateKey: record.dateKey
            };
          }
          await db.updateRecordStatus(record.recordId, 'approved', { approvedAt: Date.now() });
        }
        
        state.records = await db.getAllRecords();
        renderApprovalsView();
        updatePendingBadge();
        showToast(`تم اعتماد ${filtered.length} سجل بنجاح، جاري الرفع...`, 'success');
        
        // 2. Wait for the sync to push these records to the "Logs" sheet
        await triggerSync();

        // 3. Send the exact session details to the backend to calculate absentees accurately
        if (isApiConfigured()) {
          for (const key in sessionsToFinalize) {
            const session = sessionsToFinalize[key];
            try {
              await fetch(CONFIG.API_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                  type: 'finalize_group',
                  year: session.year,
                  group: session.group,
                  day: session.day,
                  time: session.time,
                  dateKey: session.dateKey
                })
              });
            } catch (err) {
              console.warn('[Sync] Failed to trigger finalize_group for:', session, err);
            }
          }
        }
      }
    );
  }
  /* ===================================================================
     EDIT MODAL (from approvals queue)
     =================================================================== */

  async function openEditModal(recordId) {
    const record = await db.getRecord(recordId);
    if (!record) return;

    state.editingRecordId = recordId;
    els.editStudentName.textContent = `${record.studentName} — #${record.studentId} — ${record.group || ''}`;

    // Change #5: no attendance toggle in edit modal; record is always present
    els.editHomeworkGrade.value = record.homeworkGrade != null ? record.homeworkGrade : '';
    els.editHomeworkMax.value   = record.homeworkMax   != null ? record.homeworkMax   : CONFIG.DEFAULT_HOMEWORK_MAX;
    els.editExamGrade.value     = record.examGrade     != null ? record.examGrade     : '';
    els.editExamMax.value       = record.examMax       != null ? record.examMax       : CONFIG.DEFAULT_EXAM_MAX;
    els.editNotes.value         = record.notes || '';

    els.editModal.classList.remove('hidden');
    els.editModal.setAttribute('aria-hidden', 'false');
  }

  function closeEditModal() {
    state.editingRecordId = null;
    els.editModal.classList.add('hidden');
    els.editModal.setAttribute('aria-hidden', 'true');
  }

  async function saveEditModal() {
    if (!state.editingRecordId) return;
    const record = await db.getRecord(state.editingRecordId);
    if (!record) return;

    const homeworkGrade = els.editHomeworkGrade.value;
    const homeworkMax   = els.editHomeworkMax.value;
    const examGrade     = els.editExamGrade.value;
    const examMax       = els.editExamMax.value;
    const notes         = els.editNotes.value.trim();

    const updated = {
      ...record,
      homeworkGrade: homeworkGrade === '' ? null : Number(homeworkGrade),
      homeworkMax:   homeworkMax   === '' ? CONFIG.DEFAULT_HOMEWORK_MAX : Number(homeworkMax),
      examGrade:     examGrade     === '' ? null : Number(examGrade),
      examMax:       examMax       === '' ? CONFIG.DEFAULT_EXAM_MAX : Number(examMax),
      notes,
      status:    'pending', // edits reset back to pending for re-approval
      updatedAt: Date.now(),
    };

    await db.upsertRecord(updated);
    state.records = await db.getAllRecords();
    closeEditModal();
    renderApprovalsView();
    updatePendingBadge();
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
        renderApprovalsView();
        updatePendingBadge();
        showToast('تم حذف السجل بنجاح', 'success');
      }
    );
  }

  /* ===================================================================
     EXCEL EXPORT
     =================================================================== */

  function csvEscape(value) {
    const str = value == null ? '' : String(value);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  function exportTodayToExcel() {
    const today       = todayKey();
    // Change #5: only export present records; no absent entries exist
    const todayRecords = state.records.filter((r) => r.dateKey === today && r.status !== 'draft');

    if (todayRecords.length === 0) {
      showToast('لا توجد سجلات اليوم لتصديرها', 'error');
      return;
    }

    const headers = [
      'كود الطالب', 'اسم الطالب', 'المجموعة', 'الصف', 'اليوم', 'الموعد',
      'وقت تسجيل الدخول', 'درجة الواجب', 'من (واجب)',
      'درجة الامتحان', 'من (امتحان)', 'ملاحظات', 'اعتمدها', 'الحالة', 'التاريخ',
    ];

    const rows = todayRecords.map((r) => [
      r.studentId,
      r.studentName,
      r.group,
      r.year   || '',
      r.day    || '',
      r.time   || '',
      r.checkinAt ? new Date(r.checkinAt).toLocaleTimeString('ar-EG') : '',
      r.homeworkGrade != null ? r.homeworkGrade : '',
      r.homeworkMax   != null ? r.homeworkMax   : '',
      r.examGrade     != null ? r.examGrade     : '',
      r.examMax       != null ? r.examMax       : '',
      r.notes  || '',
      r.approvedBy || '',
      translateStatus(r.status),
      r.dateKey,
    ]);

    // \uFEFF UTF-8 BOM ensures Excel opens Arabic text correctly
    const csvContent = '\uFEFF' +
      headers.map(csvEscape).join(',') + '\r\n' +
      rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href     = url;
    link.download = `report_${today}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast(`تم تصدير ${todayRecords.length} سجل بنجاح`, 'success');
  }

  function translateStatus(status) {
    switch (status) {
      case 'draft':    return 'تم تسجيل الدخول';
      case 'pending':  return 'بانتظار الاعتماد';
      case 'approved': return 'معتمد (بانتظار الإرسال)';
      case 'synced':   return 'معتمد ومُرسَل';
      case 'failed':   return 'فشلت المزامنة';
      default:         return status || '—';
    }
  }

  /* ===================================================================
     CONFIRM DIALOG
     =================================================================== */

  function openConfirm(title, message, onConfirm) {
    els.confirmTitle.textContent   = title;
    els.confirmMessage.textContent = message;
    state.pendingConfirmAction     = onConfirm;
    els.confirmModal.classList.remove('hidden');
    els.confirmModal.setAttribute('aria-hidden', 'false');
  }

  function closeConfirmModal() {
    state.pendingConfirmAction = null;
    els.confirmModal.classList.add('hidden');
    els.confirmModal.setAttribute('aria-hidden', 'true');
  }

})();