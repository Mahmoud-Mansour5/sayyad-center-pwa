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
 *   internally per school stage/year. See buildDynamicRanges() below.
 *
 * Change #3 — Two-Step Quick Attendance (no غائب):
 *   Step 1: Click "حاضر" → instant DB draft, green banner, unlock send btn.
 *   Step 2: Click "إرسال للاعتماد" → reads grades/notes, upgrades draft→pending.
 *
 * Change #4 — Drill-Down Approval Filters:
 *   Four cascading selects: Branch → Year → Day → Time.
 *   Populated from pending records only; "Approve All" only approves filtered set.
 *   Search bar filters the rendered cards by student name or ID.
 *
 * Change #5 — No Absent Frontend State:
 *   All absent logic removed. Only 'present' records are created/sent.
 *
 * Task 2 & 3 — Reports Tab:
 *   renderReportsView() groups today's approved/synced records by
 *   Branch|Year|Day|Time, calculates total/attended/absent per group,
 *   and renders interactive report cards with mini search + expand modal.
 * -------------------------------------------------------------
 */

(() => {
  'use strict';

  /* ===================================================================
     CONFIG
     =================================================================== */

  const CONFIG = {
    API_ENDPOINT: 'https://script.google.com/macros/s/AKfycby9DPOhphA6-BItkFoxlnF5QaURwHIldCRaqp0Junx-zvFe9le0dhc6N7_XN5myAZuz/exec',

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

    DEFAULT_HOMEWORK_MAX: 10,
    DEFAULT_EXAM_MAX:     10,

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
    activeTab:           'attendance',   // 'attendance' | 'approvals' | 'reports'
    isSyncing:           false,
    isFetchingInitialData: false,
    editingRecordId:     null,
    pendingConfirmAction: null,

    // Change #4: current approval filter values (now includes branch)
    approvalFilterBranch: '',
    approvalFilterYear:   '',
    approvalFilterDay:    '',
    approvalFilterTime:   '',

    // Approvals search query
    approvalsSearchQuery: '',

    // Reports: the group key currently open in the expand modal
    reportExpandGroupKey: null,
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
    els.tabReports     = $('#tabReports');          // Task 3 — new tab
    els.pendingTabBadge = $('#pendingTabBadge');

    els.attendanceView = $('#attendanceView');
    els.approvalsView  = $('#approvalsView');
    els.reportsView    = $('#reportsView');          // Task 3 — new view

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

    // Task 2 — Approvals search
    els.approvalsSearch      = $('#approvalsSearch');
    els.clearApprovalsSearch = $('#clearApprovalsSearchBtn');

    // Change #4 (updated): drill-down filter dropdowns, now includes Branch
    els.filterBranch = $('#filterBranch');
    els.filterYear   = $('#filterYear');
    els.filterDay    = $('#filterDay');
    els.filterTime   = $('#filterTime');

    els.studentCardTemplate  = $('#studentCardTemplate');
    els.approvalCardTemplate = $('#approvalCardTemplate');
    els.reportCardTemplate   = $('#reportCardTemplate');  // Task 3

    // Reports view elements
    els.reportCardsList   = $('#reportCardsList');
    els.noReports         = $('#noReports');
    els.reportsTodayLabel = $('#reportsTodayLabel');

    // Reports expand modal
    els.reportExpandModal   = $('#reportExpandModal');
    els.reportExpandClose   = $('#reportExpandClose');
    els.reportExpandTitle   = $('#reportExpandTitle');
    els.reportExpandSub     = $('#reportExpandSub');
    els.reportExpandSearch  = $('#reportExpandSearch');
    els.reportExpandMetrics = $('#reportExpandMetrics');
    els.reportExpandList    = $('#reportExpandList');

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
     TAB NAVIGATION — Task 3: extended to support 3rd "reports" tab
     =================================================================== */

  function switchTab(tab) {
    state.activeTab = tab;

    // Toggle tab button active states
    els.tabAttendance.classList.toggle('active', tab === 'attendance');
    els.tabApprovals.classList.toggle('active',  tab === 'approvals');
    els.tabReports.classList.toggle('active',    tab === 'reports');

    // Toggle view visibility
    els.attendanceView.classList.toggle('hidden', tab !== 'attendance');
    els.approvalsView.classList.toggle('hidden',  tab !== 'approvals');
    els.reportsView.classList.toggle('hidden',    tab !== 'reports');

    if (tab === 'approvals') {
      renderApprovalsView();
    }

    // Task 3 — render reports on tab click (auto-reset logic lives inside)
    if (tab === 'reports') {
      renderReportsView();
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

    // Tab switching — Task 3: third tab wired up
    els.tabAttendance.addEventListener('click', () => switchTab('attendance'));
    els.tabApprovals.addEventListener('click',  () => switchTab('approvals'));
    els.tabReports.addEventListener('click',    () => switchTab('reports'));

    // Attendance search
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

    // ── Task 2 — Approvals in-view search ──
    els.approvalsSearch.addEventListener('input', (e) => {
      state.approvalsSearchQuery = e.target.value.trim().toLowerCase();
      els.clearApprovalsSearch.classList.toggle('hidden', state.approvalsSearchQuery.length === 0);
      renderApprovalsList();
    });
    els.clearApprovalsSearch.addEventListener('click', () => {
      els.approvalsSearch.value  = '';
      state.approvalsSearchQuery = '';
      els.clearApprovalsSearch.classList.add('hidden');
      renderApprovalsList();
      els.approvalsSearch.focus();
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

    // Change #4 (updated): cascading filter dropdowns, Branch comes first
    els.filterBranch.addEventListener('change', () => {
      state.approvalFilterBranch = els.filterBranch.value;
      state.approvalFilterYear   = '';
      state.approvalFilterDay    = '';
      state.approvalFilterTime   = '';
      populateApprovalFilters();
      renderApprovalsList();
    });
    els.filterYear.addEventListener('change', () => {
      state.approvalFilterYear = els.filterYear.value;
      state.approvalFilterDay  = '';
      state.approvalFilterTime = '';
      populateDayFilter();
      populateTimeFilter();
      renderApprovalsList();
    });
    els.filterDay.addEventListener('change', () => {
      state.approvalFilterDay  = els.filterDay.value;
      state.approvalFilterTime = '';
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

    // Change #2: update ID preview live when year or branch changes
    els.newStudentYear.addEventListener('change', updateIdPreview);
    els.newStudentBranch.addEventListener('change', updateIdPreview);

    // ── Task 3 — Reports expand modal ──
    els.reportExpandClose.addEventListener('click', closeReportExpandModal);
    els.reportExpandModal.addEventListener('click', (e) => {
      if (e.target === els.reportExpandModal) closeReportExpandModal();
    });
    els.reportExpandSearch.addEventListener('input', () => {
      renderExpandModalList(state.reportExpandGroupKey, els.reportExpandSearch.value.trim().toLowerCase());
    });
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

  async function triggerSync() {
    if (state.isSyncing || !navigator.onLine) return;

    const pendingStudents = await db.getStudentsPendingCreation();
    const toSyncRecords   = state.records.filter((r) => r.status === 'approved' || r.status === 'failed');

    if (pendingStudents.length === 0 && toSyncRecords.length === 0) return;

    state.isSyncing = true;
    updateSyncBadge();

    for (const student of pendingStudents) {
      try {
        const ok = await pushStudentToApi(student);
        if (ok) {
          await db.upsertStudent({ ...student, syncStatus: 'synced' });
        }
      } catch (err) { /* keep trying next time */ }
    }

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
    if (state.activeTab === 'reports')   renderReportsView();
  }

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
          branch:        record.branch,
          year:          record.year,
          day:           record.day,
          time:          record.time,
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

    const branchEl = node.querySelector('[data-role="studentBranch"]');
    const phoneEl  = node.querySelector('[data-role="studentPhone"]');
    const subSep   = node.querySelector('[data-role="subSep"]');
    const hasBranch = !!student.branch;
    const hasPhone  = !!student.phone;
    // --- الأكواد الجديدة لإضافة اليوم والموعد ---
    const dayEl = node.querySelector('[data-role="studentDay"]');
    const timeEl = node.querySelector('[data-role="studentTime"]');
    const scheduleRow = node.querySelector('[data-role="scheduleRow"]');

    const hasDay = !!student.day;
    const hasTime = !!student.time;

    // تحويل "م" إلى "PM" و "ص" إلى "AM"
    let timeFormatted = '';
    if (hasTime) {
      timeFormatted = student.time.replace('م', 'PM').replace('ص', 'AM');
    }

    if (dayEl) dayEl.textContent = hasDay ? student.day : '';
    if (timeEl) timeEl.textContent = hasTime ? timeFormatted : '';

    // إخفاء الصف بالكامل إذا لم يكن الطالب مسجلاً في يوم أو موعد
    if (scheduleRow) {
      scheduleRow.classList.toggle('hidden', !(hasDay || hasTime));
    }
    // --------------------------------------------
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
      const hw    = node.querySelector('[data-field="homeworkGrade"]');
      const hwM   = node.querySelector('[data-field="homeworkMax"]');
      const ex    = node.querySelector('[data-field="examGrade"]');
      const exM   = node.querySelector('[data-field="examMax"]');
      const notes = node.querySelector('[data-field="notes"]');
      if (existingRecord.homeworkGrade != null) hw.value    = existingRecord.homeworkGrade;
      if (existingRecord.homeworkMax   != null) hwM.value   = existingRecord.homeworkMax;
      if (existingRecord.examGrade     != null) ex.value    = existingRecord.examGrade;
      if (existingRecord.examMax       != null) exM.value   = existingRecord.examMax;
      if (existingRecord.notes)                 notes.value = existingRecord.notes;

      if (existingRecord.status === 'draft') {
        card.classList.add('draft-active');
        presentBtn.classList.add('active');
        draftConfirm.classList.remove('hidden');
        if (existingRecord.checkinAt) {
          draftTime.textContent = `في ${new Date(existingRecord.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
        }
        saveBtn.disabled = false;
        updateStatusPill(statusPill, 'draft');
      } else if (existingRecord.status === 'pending' || existingRecord.status === 'failed') {
        card.classList.add('draft-active');
        presentBtn.classList.add('active');
        draftConfirm.classList.remove('hidden');
        if (existingRecord.checkinAt) {
          draftTime.textContent = `في ${new Date(existingRecord.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
        }
        saveBtn.innerHTML = '<span>📤</span> تم الإرسال للاعتماد';
        saveBtn.disabled = true;
        updateStatusPill(statusPill, 'pending');
      } else if (existingRecord.status === 'approved' || existingRecord.status === 'synced') {
        card.classList.add('draft-active');
        presentBtn.classList.add('active');
        presentBtn.disabled = true;
        draftConfirm.classList.remove('hidden');
        if (existingRecord.checkinAt) {
          draftTime.textContent = `في ${new Date(existingRecord.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
        }
        hw.disabled = true; hwM.disabled = true;
        ex.disabled = true; exM.disabled = true;
        notes.disabled = true;
        saveBtn.innerHTML = '<span>✅</span> تم الاعتماد';
        saveBtn.disabled = true;
        updateStatusPill(statusPill, existingRecord.status);
      }
    } else {
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

    if (e.target.closest('[data-action="present"]')) {
      handlePresentClick(card, studentId);
      return;
    }
    if (e.target.closest('[data-action="save"]')) {
      handleSendForApproval(card, studentId);
    }
  }

  async function handlePresentClick(card, studentId) {
    const student = state.students.find((s) => String(s.id) === String(studentId));
    if (!student) return;

    const presentBtn   = card.querySelector('[data-action="present"]');
    const saveBtn      = card.querySelector('[data-action="save"]');
    const draftConfirm = card.querySelector('[data-role="draftConfirm"]');
    const draftTime    = card.querySelector('[data-role="draftTime"]');
    const statusPill   = card.querySelector('[data-role="statusPill"]');

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
      group:         student.group  || '',
      branch:        student.branch || '',
      year:          student.year   || '',
      day:           student.day    || '',
      time:          student.time   || '',
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

  async function handleSendForApproval(card, studentId) {
    const student = state.students.find((s) => String(s.id) === String(studentId));
    if (!student) return;

    const saveBtn    = card.querySelector('[data-action="save"]');
    const statusPill = card.querySelector('[data-role="statusPill"]');

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

    const approvalCount = state.records.filter((r) => r.status === 'pending' || r.status === 'failed').length;
    els.pendingTabBadge.textContent = approvalCount;
    els.pendingTabBadge.classList.toggle('hidden', approvalCount === 0);

    if (els.statPendingApprovals) els.statPendingApprovals.textContent = approvalCount;
  }

  /* ===================================================================
     CHANGE #2 — SMART STUDENT ID GENERATION
     =================================================================== */

  function getIdBaseForYear(year) {
    if (!year) return CONFIG.ID_BASE_PRIMARY;
    if (year.includes('ابتدائي')) return CONFIG.ID_BASE_PRIMARY;
    if (year.includes('إعدادي'))  return CONFIG.ID_BASE_PREPARATORY;
    if (year.includes('ثانوي'))   return CONFIG.ID_BASE_SECONDARY;
    return CONFIG.ID_BASE_PRIMARY;
  }

  function buildDynamicRanges() {
    const ranges = {};
    const branches = (state.settings && state.settings.branches) ? state.settings.branches : FALLBACK_SETTINGS.branches;
    const years    = (state.settings && state.settings.years)    ? state.settings.years    : FALLBACK_SETTINGS.years;

    const RANGE_SIZE_PER_BRANCH = 200;
    const BASE_START_ID = 200;

    if (!branches || !years || years.length === 0) return ranges;

    const sizePerYear = Math.floor(RANGE_SIZE_PER_BRANCH / years.length);

    branches.forEach((branch, branchIndex) => {
      ranges[branch] = {};
      const branchStart = BASE_START_ID + (branchIndex * RANGE_SIZE_PER_BRANCH);

      years.forEach((year, yearIndex) => {
        const yearStart = branchStart + (yearIndex * sizePerYear);
        const yearEnd   = (yearIndex === years.length - 1)
                          ? (branchStart + RANGE_SIZE_PER_BRANCH - 1)
                          : (yearStart + sizePerYear - 1);
        ranges[branch][year] = { start: yearStart, end: yearEnd };
      });
    });

    return ranges;
  }

  function getCustomRange(branch, year) {
    const dynamicRanges = buildDynamicRanges();
    const branchRanges  = dynamicRanges[branch];
    if (!branchRanges) return null;
    return branchRanges[year] || null;
  }

  function generateNextStudentId(branch, year) {
    const customRange = getCustomRange(branch, year);

    let start, end;
    if (customRange) {
      start = customRange.start;
      end   = customRange.end;
    } else {
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
    return nextId > end ? null : String(nextId);
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
    const nextId = generateNextStudentId(branch, year);

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
     CHANGE #4 (UPDATED) — DRILL-DOWN APPROVALS VIEW
     Now: Branch → Year → Day → Time
     Plus: search bar within the rendered cards
     =================================================================== */

  function renderApprovalsView() {
    const totalStudents = state.students.length;
    const activeGroups  = new Set(state.students.map((s) => s.group)).size;
    const pendingAll    = state.records.filter((r) => r.status === 'pending' || r.status === 'failed');
    const today         = todayKey();
    const approvedToday = state.records.filter(
      (r) => (r.status === 'approved' || r.status === 'synced') && r.dateKey === today
    );

    els.statTotalStudents.textContent    = totalStudents;
    els.statActiveGroups.textContent     = activeGroups;
    els.statPendingApprovals.textContent = pendingAll.length;
    els.statApprovedToday.textContent    = approvedToday.length;

    populateApprovalFilters();
    renderApprovalsList();
  }

  /**
   * Populates Branch first, then cascades down.
   */
  function populateApprovalFilters() {
    const pending = state.records.filter((r) => r.status === 'pending' || r.status === 'failed');

    // Branch filter
    const branches    = Array.from(new Set(pending.map((r) => r.branch).filter(Boolean))).sort();
    const savedBranch = state.approvalFilterBranch;
    els.filterBranch.innerHTML = '<option value="">— كل السنتر —</option>' +
      branches.map((b) => `<option value="${escapeHtml(b)}" ${b === savedBranch ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('');
    state.approvalFilterBranch = els.filterBranch.value;

    populateYearFilter();
    populateDayFilter();
    populateTimeFilter();
  }

  function populateYearFilter() {
    const pending   = getBranchFilteredPending();
    const years     = Array.from(new Set(pending.map((r) => r.year).filter(Boolean))).sort();
    const savedYear = state.approvalFilterYear;
    els.filterYear.innerHTML = '<option value="">— كل الصفوف —</option>' +
      years.map((y) => `<option value="${escapeHtml(y)}" ${y === savedYear ? 'selected' : ''}>${escapeHtml(y)}</option>`).join('');
    state.approvalFilterYear = els.filterYear.value;
  }

  function populateDayFilter() {
    const pending  = getYearFilteredPending();
    const days     = Array.from(new Set(pending.map((r) => r.day).filter(Boolean))).sort();
    const savedDay = state.approvalFilterDay;
    els.filterDay.innerHTML = '<option value="">— كل الأيام —</option>' +
      days.map((d) => `<option value="${escapeHtml(d)}" ${d === savedDay ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('');
    state.approvalFilterDay = els.filterDay.value;
  }

  function populateTimeFilter() {
    const pending   = getDayFilteredPending();
    const times     = Array.from(new Set(pending.map((r) => r.time).filter(Boolean))).sort();
    const savedTime = state.approvalFilterTime;
    els.filterTime.innerHTML = '<option value="">— كل المواعيد —</option>' +
      times.map((t) => `<option value="${escapeHtml(t)}" ${t === savedTime ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
    state.approvalFilterTime = els.filterTime.value;
  }

  function getBranchFilteredPending() {
    const all = state.records.filter((r) => r.status === 'pending' || r.status === 'failed');
    if (!state.approvalFilterBranch) return all;
    return all.filter((r) => r.branch === state.approvalFilterBranch);
  }

  function getYearFilteredPending() {
    const branchFiltered = getBranchFilteredPending();
    if (!state.approvalFilterYear) return branchFiltered;
    return branchFiltered.filter((r) => r.year === state.approvalFilterYear);
  }

  function getDayFilteredPending() {
    const yearFiltered = getYearFilteredPending();
    if (!state.approvalFilterDay) return yearFiltered;
    return yearFiltered.filter((r) => r.day === state.approvalFilterDay);
  }

  /**
   * Returns the final filtered set respecting all four cascading filters.
   */
  function getFullyFilteredPending() {
    let list = state.records.filter((r) => r.status === 'pending' || r.status === 'failed');
    if (state.approvalFilterBranch) list = list.filter((r) => r.branch === state.approvalFilterBranch);
    if (state.approvalFilterYear)   list = list.filter((r) => r.year   === state.approvalFilterYear);
    if (state.approvalFilterDay)    list = list.filter((r) => r.day    === state.approvalFilterDay);
    if (state.approvalFilterTime)   list = list.filter((r) => r.time   === state.approvalFilterTime);
    return list;
  }

  /**
   * Renders the filtered pending records, further narrowed by the search box.
   */
  function renderApprovalsList() {
    let filtered = getFullyFilteredPending();

    // ── Task 2 — apply in-view search ──
    const q = state.approvalsSearchQuery;
    if (q) {
      filtered = filtered.filter((r) =>
        (r.studentName || '').toLowerCase().includes(q) ||
        String(r.studentId || '').toLowerCase().includes(q)
      );
    }

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

    const attendancePill = node.querySelector('[data-role="attendancePill"]');
    attendancePill.textContent = '✅ حاضر';
    attendancePill.classList.add('present-pill');
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

    // ── Task 2: include branch in meta line ──
    const metaParts = [record.branch, record.year, record.day, record.time].filter(Boolean);
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
   * Task 3 update: "Approve All" now sends branch explicitly in finalize_group payload.
   */
  async function handleApproveAll() {
    const filtered = getFullyFilteredPending();
    if (filtered.length === 0) return;

    const filterDesc = [
      state.approvalFilterBranch && `السنتر: ${state.approvalFilterBranch}`,
      state.approvalFilterYear   && `الصف: ${state.approvalFilterYear}`,
      state.approvalFilterDay    && `اليوم: ${state.approvalFilterDay}`,
      state.approvalFilterTime   && `الموعد: ${state.approvalFilterTime}`,
    ].filter(Boolean).join(' / ') || 'جميع الفلاتر';

    openConfirm(
      'اعتماد السجلات المرشّحة',
      `سيتم اعتماد ${filtered.length} سجل (${filterDesc}) وإرسالها دفعة واحدة. هل تريد المتابعة؟`,
      async () => {
        // 1. Gather exact sessions to finalize (Branch + Year + Group + Day + Time)
        const sessionsToFinalize = {};

        for (const record of filtered) {
          if (record.year && record.day && record.time && record.dateKey) {
            const key = `${record.branch}|${record.year}|${record.group}|${record.day}|${record.time}|${record.dateKey}`;
            sessionsToFinalize[key] = {
              branch:  record.branch  || '',
              year:    record.year,
              group:   record.group,
              day:     record.day,
              time:    record.time,
              dateKey: record.dateKey,
            };
          }
          await db.updateRecordStatus(record.recordId, 'approved', { approvedAt: Date.now() });
        }

        state.records = await db.getAllRecords();
        renderApprovalsView();
        updatePendingBadge();
        showToast(`تم اعتماد ${filtered.length} سجل بنجاح، جاري الرفع...`, 'success');

        // 2. Push approved records to API
        await triggerSync();

        // 3. Send exact session details to backend (includes branch) for absentee calc
        if (isApiConfigured()) {
          for (const key in sessionsToFinalize) {
            const session = sessionsToFinalize[key];
            try {
              await fetch(CONFIG.API_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                  type:    'finalize_group',
                  branch:  session.branch,
                  year:    session.year,
                  group:   session.group,
                  day:     session.day,
                  time:    session.time,
                  dateKey: session.dateKey,
                }),
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
      status:    'pending',
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
     TASK 3 — REPORTS ENGINE (Daily Auto-Reset)
     =================================================================== */

  /**
   * Renders the full reports view.
   *
   * Logic:
   *  1. Filter state.records for approved/synced entries with dateKey === today.
   *     (At midnight the date changes → zero results → auto-reset.)
   *  2. Group by composite key: branch|year|day|time.
   *  3. For each group, compute:
   *     - Attended: count of records in this group.
   *     - Total:    count of students in state.students matching the same
   *                 branch + year + day + time.
   *     - Absent:   Total − Attended (floored at 0).
   *  4. Render one report card per group.
   */
  function renderReportsView() {
    const today = todayKey();

    // Display today's date in the header badge
    if (els.reportsTodayLabel) {
      els.reportsTodayLabel.textContent = new Date().toLocaleDateString('ar-EG', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
    }

    // Only today's finalised records
    const todayRecords = state.records.filter(
      (r) => (r.status === 'approved' || r.status === 'synced') && r.dateKey === today
    );

    if (todayRecords.length === 0) {
      els.reportCardsList.innerHTML = '';
      els.noReports.classList.remove('hidden');
      return;
    }
    els.noReports.classList.add('hidden');

    // Group records by Branch|Year|Day|Time
    const groups = {};
    todayRecords.forEach((r) => {
      const key = `${r.branch || ''}|${r.year || ''}|${r.day || ''}|${r.time || ''}`;
      if (!groups[key]) {
        groups[key] = {
          key,
          branch:  r.branch  || '',
          year:    r.year    || '',
          day:     r.day     || '',
          time:    r.time    || '',
          records: [],
        };
      }
      groups[key].records.push(r);
    });

    // Render cards
    els.reportCardsList.innerHTML = '';
    const frag = document.createDocumentFragment();

    Object.values(groups).forEach((group) => {
      // Total students in this exact slot
      const totalStudents = state.students.filter((s) =>
        (s.branch || '') === group.branch &&
        (s.year   || '') === group.year   &&
        (s.day    || '') === group.day    &&
        (s.time   || '') === group.time
      ).length;

      const attended = group.records.length;
      const absent   = Math.max(0, totalStudents - attended);

      frag.appendChild(buildReportCard(group, totalStudents, attended, absent));
    });

    els.reportCardsList.appendChild(frag);

    // Wire up mini search bars (added to DOM above)
    $$('.report-mini-search-input', els.reportCardsList).forEach((input) => {
      input.addEventListener('input', () => {
        const key        = input.closest('.report-card').dataset.groupKey;
        const listEl     = input.closest('.report-card').querySelector('[data-role="attendeeList"]');
        const q          = input.value.trim().toLowerCase();
        const groupObj   = Object.values(groups).find((g) => g.key === key);
        if (groupObj) renderAttendeeList(listEl, groupObj.records, q);
      });
    });

    // Wire up Expand buttons
    $$('.report-expand-btn', els.reportCardsList).forEach((btn) => {
      btn.addEventListener('click', () => {
        const groupKey = btn.closest('.report-card').dataset.groupKey;
        openReportExpandModal(groupKey, groups);
      });
    });
  }

  /**
   * Builds a single report card DOM element.
   */
  function buildReportCard(group, total, attended, absent) {
    const node = els.reportCardTemplate.content.cloneNode(true);
    const card = node.querySelector('.report-card');
    card.dataset.groupKey = group.key;

    // Title: e.g. "الصف الثاني الإعدادي — سنتر السرايا"
    const titleParts = [group.year, group.branch].filter(Boolean);
    node.querySelector('[data-role="groupTitle"]').textContent = titleParts.join(' — ') || '—';

    // Sub: e.g. "الأحد — 04:00 م"
    const subParts = [group.day, group.time].filter(Boolean);
    node.querySelector('[data-role="groupSub"]').textContent = subParts.join(' — ') || '';

    // Metrics
    node.querySelector('[data-role="metricTotal"]').textContent    = total;
    node.querySelector('[data-role="metricAttended"]').textContent = attended;
    node.querySelector('[data-role="metricAbsent"]').textContent   = absent;

    // Attendee list
    const listEl = node.querySelector('[data-role="attendeeList"]');
    renderAttendeeList(listEl, group.records, '');

    return node;
  }

  /**
   * Renders attendee row items into a container, optionally filtered by query.
   */
  function renderAttendeeList(containerEl, records, query) {
    containerEl.innerHTML = '';

    const filtered = query
      ? records.filter((r) =>
          (r.studentName || '').toLowerCase().includes(query) ||
          String(r.studentId || '').toLowerCase().includes(query)
        )
      : records;

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'report-attendee-empty';
      empty.textContent = query ? 'لا توجد نتائج مطابقة' : 'لا يوجد حاضرون';
      containerEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'report-attendee-item';
      item.innerHTML = `
        <div class="report-attendee-avatar">${escapeHtml(initials(r.studentName))}</div>
        <span class="report-attendee-name">${escapeHtml(r.studentName || '—')}</span>
        <span class="report-attendee-id">#${escapeHtml(String(r.studentId || ''))}</span>
      `;
      frag.appendChild(item);
    });
    containerEl.appendChild(frag);
  }

  /* ── Expand Modal ── */

  function openReportExpandModal(groupKey, groups) {
    const group = Object.values(groups).find((g) => g.key === groupKey);
    if (!group) return;

    state.reportExpandGroupKey = groupKey;

    // Header info
    const titleParts = [group.year, group.branch].filter(Boolean);
    els.reportExpandTitle.textContent = titleParts.join(' — ') || 'التقرير';
    const subParts = [group.day, group.time].filter(Boolean);
    els.reportExpandSub.textContent = subParts.join(' — ') || '';

    // Metrics inside modal
    const totalStudents = state.students.filter((s) =>
      (s.branch || '') === group.branch &&
      (s.year   || '') === group.year   &&
      (s.day    || '') === group.day    &&
      (s.time   || '') === group.time
    ).length;
    const attended = group.records.length;
    const absent   = Math.max(0, totalStudents - attended);

    els.reportExpandMetrics.innerHTML = `
      <div class="report-metric report-metric-total">
        <span class="report-metric-value">${totalStudents}</span>
        <span class="report-metric-label">إجمالي الطلاب</span>
      </div>
      <div class="report-metric report-metric-attended">
        <span class="report-metric-value">${attended}</span>
        <span class="report-metric-label">حاضر</span>
      </div>
      <div class="report-metric report-metric-absent">
        <span class="report-metric-value">${absent}</span>
        <span class="report-metric-label">غائب</span>
      </div>
    `;

    // Store group records for search re-filtering
    els.reportExpandModal.dataset.groupKey = groupKey;
    // Store the records on the modal element so search can reach them
    els.reportExpandModal._currentRecords  = group.records;

    els.reportExpandSearch.value = '';
    renderExpandModalList(groupKey, '');

    els.reportExpandModal.classList.remove('hidden');
    els.reportExpandModal.setAttribute('aria-hidden', 'false');
  }

  function renderExpandModalList(groupKey, query) {
    const records = els.reportExpandModal._currentRecords || [];
    renderAttendeeList(els.reportExpandList, records, query);
  }

  function closeReportExpandModal() {
    state.reportExpandGroupKey = null;
    els.reportExpandModal._currentRecords = [];
    els.reportExpandModal.classList.add('hidden');
    els.reportExpandModal.setAttribute('aria-hidden', 'true');
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