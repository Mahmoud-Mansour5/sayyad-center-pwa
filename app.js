/**
 * app.js
 * -------------------------------------------------------------
 * Core application logic for مركز الأستاذ محمود الصياد للتطوير التعليمي
 *
 *  - PIN authentication (role-based: secretary / master)
 *  - Secretary view: search, quick attendance, grades/notes, offline save
 *  - Master view: stats + combined pending-approvals queue
 *  - Offline-first queue in IndexedDB (via db.js)
 *  - Auto background sync to a Google Apps Script endpoint when online
 * -------------------------------------------------------------
 */

(() => {
  'use strict';

  /* =====================================================================
     CONFIG
     ===================================================================== */

  const CONFIG = {
    // Replace with your deployed Google Apps Script Web App URL.
    API_ENDPOINT: 'https://script.google.com/macros/s/REPLACE_WITH_YOUR_DEPLOYMENT_ID/exec',

    PIN_LENGTH: 4,

    // PIN -> user profile map. In production, consider hashing these
    // and/or fetching from a remote config once online.
    USERS: {
      '1234': { role: 'secretary', name: 'سكرتارية الاستقبال', id: 'sec-1' },
      '1111': { role: 'secretary', name: 'سكرتارية الفرع الثاني', id: 'sec-2' },
      '9999': { role: 'master', name: 'الأستاذ محمود الصياد', id: 'master-1' },
    },

    SYNC_RETRY_INTERVAL_MS: 30000,
    TOAST_DURATION_MS: 3200,
  };

  // Seed roster used the first time the app runs (offline-ready demo data).
  const SEED_STUDENTS = [
    { id: '501', name: 'أحمد محمد السيد', group: 'الصف الأول الثانوي - أ' },
    { id: '502', name: 'مريم علي حسن', group: 'الصف الأول الثانوي - أ' },
    { id: '503', name: 'يوسف كريم عبد الله', group: 'الصف الأول الثانوي - ب' },
    { id: '504', name: 'سارة إبراهيم فتحي', group: 'الصف الأول الثانوي - ب' },
    { id: '505', name: 'محمود جمال الصياد', group: 'الصف الثاني الثانوي - أ' },
    { id: '506', name: 'نور الدين حسام', group: 'الصف الثاني الثانوي - أ' },
    { id: '507', name: 'ياسمين طارق سعيد', group: 'الصف الثاني الثانوي - ب' },
    { id: '508', name: 'عمر خالد منصور', group: 'الصف الثاني الثانوي - ب' },
    { id: '509', name: 'هنا وليد عادل', group: 'الصف الثالث الثانوي - أ' },
    { id: '510', name: 'كريم عصام فؤاد', group: 'الصف الثالث الثانوي - أ' },
    { id: '511', name: 'ملك رامي شوقي', group: 'الصف الثالث الثانوي - ب' },
    { id: '512', name: 'زياد أشرف نبيل', group: 'الصف الثالث الثانوي - ب' },
  ];

  /* =====================================================================
     STATE
     ===================================================================== */

  const state = {
    currentUser: null, // { role, name, id }
    students: [],
    records: [],       // all local records (pending + approved cache)
    searchQuery: '',
    activeGroup: 'all',
    isSyncing: false,
    editingRecordId: null,
    pendingConfirmAction: null,
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

  /* =====================================================================
     INIT
     ===================================================================== */

  document.addEventListener('DOMContentLoaded', async () => {
    cacheDom();
    bindStaticEvents();
    registerServiceWorker();

    await db.init();
    await db.seedStudentsIfEmpty(SEED_STUDENTS);

    state.students = await db.getAllStudents();
    state.records = await db.getAllRecords();

    setupConnectivityWatchers();
    hideSplash();

    // Try to restore a previous session (role only, not sensitive).
    const savedUser = sessionStorage.getItem('sayyad_session_user');
    if (savedUser) {
      try {
        state.currentUser = JSON.parse(savedUser);
        enterApp();
      } catch (_) {
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

    els.toastContainer = $('#toastContainer');
  }

  function hideSplash() {
    setTimeout(() => {
      els.splashScreen.classList.add('fade-out');
    }, 450);
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
  }

  function attemptLogin(pin) {
    const user = CONFIG.USERS[pin];
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
    sessionStorage.setItem('sayyad_session_user', JSON.stringify(state.currentUser));
    els.pinError.classList.add('hidden');
    enterApp();
  }

  function handleLogout() {
    openConfirm(
      'تسجيل الخروج',
      'هل تريد بالفعل تسجيل الخروج من النظام؟',
      () => {
        state.currentUser = null;
        sessionStorage.removeItem('sayyad_session_user');
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
      renderMasterView();
    } else {
      els.masterView.classList.add('hidden');
      els.secretaryView.classList.remove('hidden');
      buildGroupChips();
      renderStudentsList();
      updatePendingBadgeSecretary();
    }

    updateSyncBadge();
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
    if (state.isSyncing) {
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
   * Push all "approved" (and any previously "failed") records to the
   * Google Apps Script endpoint. Records that succeed are marked "synced".
   * This never blocks the UI — it runs silently in the background.
   */
  async function triggerSync() {
    if (state.isSyncing || !navigator.onLine) return;

    const toSync = state.records.filter((r) => r.status === 'approved' || r.status === 'failed');
    if (toSync.length === 0) return;

    state.isSyncing = true;
    updateSyncBadge();

    let successCount = 0;
    let failCount = 0;

    for (const record of toSync) {
      try {
        const ok = await pushRecordToApi(record);
        if (ok) {
          record.status = 'synced';
          record.syncedAt = Date.now();
          await db.upsertRecord(record);
          successCount++;
        } else {
          record.status = 'failed';
          await db.upsertRecord(record);
          failCount++;
        }
      } catch (err) {
        record.status = 'failed';
        await db.upsertRecord(record);
        failCount++;
      }
    }

    state.records = await db.getAllRecords();
    state.isSyncing = false;
    updateSyncBadge();

    if (successCount > 0) {
      showToast(`تمت مزامنة ${successCount} سجل بنجاح`, 'success');
    }
    if (failCount > 0) {
      showToast(`تعذّرت مزامنة ${failCount} سجل، سيُعاد المحاولة تلقائيًا`, 'error');
    }

    if (state.currentUser?.role === 'master') renderMasterView();
  }

  async function pushRecordToApi(record) {
    if (!CONFIG.API_ENDPOINT || CONFIG.API_ENDPOINT.includes('REPLACE_WITH_YOUR_DEPLOYMENT_ID')) {
      // No real endpoint configured yet — treat as a successful "local-only"
      // sync so the demo remains fully functional offline/without setup.
      console.info('[Sync] لا يوجد رابط Google Apps Script مضبوط — تم تجاوز الإرسال الفعلي.', record);
      return true;
    }

    try {
      const res = await fetch(CONFIG.API_ENDPOINT, {
        method: 'POST',
        // Apps Script web apps generally expect text/plain to avoid
        // CORS preflight issues; the script parses JSON from the body.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
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
    const groups = Array.from(new Set(state.students.map((s) => s.group))).sort();
    els.groupChips.innerHTML = '<button class="chip active" data-group="all">الكل</button>' +
      groups.map((g) => `<button class="chip" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('');
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
        s.id.toLowerCase().includes(q)
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
    const student = state.students.find((s) => s.id === studentId);
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
