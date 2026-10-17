(() => {
  const config = window.NOUR_SUPABASE_CONFIG || {};
  const baseUrl = String(config.url || '').replace(/\/+$/, '');
  const publishableKey = String(config.publishableKey || '').trim();
  const configured = Boolean(baseUrl && publishableKey);
  const AUTH_STORAGE_KEY = 'nour_erp_cloud_session';
  let session = null;
  let profile = null;
  let workspaceId = null;
  let version = null;
  let saveQueue = Promise.resolve();

  function getStoredSession() {
    try {
      return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || 'null');
    } catch (error) {
      console.error('Could not read the cloud session:', error);
      return null;
    }
  }

  function storeSession(value) {
    session = value;
    if (value) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  }

  function toAuthEmail(username) {
    const normalized = String(username || '').trim().toLowerCase();
    const bytes = new TextEncoder().encode(normalized);
    return crypto.subtle.digest('SHA-256', bytes).then(buffer => {
      const hash = [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
      return `u${hash.slice(0, 32)}@users.nourgroup.app`;
    });
  }

  function ensureConfigured() {
    if (!configured) throw new Error('أضف رابط Supabase والمفتاح العام في ملف supabase-config.js أولًا.');
  }

  async function request(path, { method = 'GET', body, token, prefer, retry = true } = {}) {
    ensureConfigured();
    const requestToken = token || session?.access_token || publishableKey;
    const headers = {
      apikey: publishableKey,
      Authorization: `Bearer ${requestToken}`
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 401 && retry && requestToken !== publishableKey && session?.refresh_token) {
      await refreshSession();
      if (!session?.access_token) throw new Error('انتهت جلسة الدخول. سجّل الدخول من جديد.');
      return request(path, { method, body, token: session.access_token, prefer, retry: false });
    }
    const result = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const message = result?.msg || result?.message || result?.error_description || result?.error || `HTTP ${response.status}`;
      throw new Error(String(message));
    }
    return result;
  }

  async function authRequest(path, body, token) {
    return request(`/auth/v1/${path}`, { method: 'POST', body, token });
  }

  async function rpc(name, args = {}) {
    return request(`/rest/v1/rpc/${name}`, { method: 'POST', body: args });
  }

  async function getProfile() {
    if (!session?.user?.id) return null;
    const rows = await request(`/rest/v1/erp_workspace_members?select=user_id,workspace_id,username,role,permissions,image&user_id=eq.${encodeURIComponent(session.user.id)}&limit=1`);
    profile = Array.isArray(rows) ? rows[0] || null : null;
    workspaceId = profile?.workspace_id || null;
    if (!profile) {
      const requests = await request(`/rest/v1/erp_access_requests?select=id&user_id=eq.${encodeURIComponent(session.user.id)}&limit=1`);
      if (Array.isArray(requests) && requests.length) {
        throw new Error('طلبك قيد مراجعة المدير. ستتمكن من الدخول بعد الموافقة على حسابك.');
      }
      throw new Error('هذا الحساب غير مرتبط بمساحة عمل. تواصل مع مدير النظام.');
    }
    const members = await request(`/rest/v1/erp_workspace_members?select=user_id,workspace_id,username,role,permissions,image&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=created_at.asc`);
    const accounts = (Array.isArray(members) ? members : []).map(member => ({
      ...member,
      id: member.user_id
    }));
    localStorage.setItem('nour_erp_user_accounts', JSON.stringify(accounts.filter(account => account.role !== 'admin')));
    return profile;
  }

  async function acceptAuthResult(result) {
    if (!result?.access_token || !result?.refresh_token || !result?.user) {
      throw new Error('لم ينشئ Supabase جلسة دخول. عطّل تأكيد البريد الإلكتروني لهذا المشروع ثم أعد المحاولة.');
    }
    storeSession({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600),
      user: result.user
    });
    await getProfile();
    return profile;
  }

  async function refreshSession() {
    if (!session?.refresh_token) return null;
    const result = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token }, publishableKey);
    if (!result?.access_token || !result?.refresh_token) {
      storeSession(null);
      return null;
    }
    storeSession({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600),
      user: result.user
    });
    return session;
  }

  async function restoreSession() {
    if (!configured) return null;
    session = getStoredSession();
    if (!session?.access_token || !session?.user?.id) return null;
    if (Number(session.expires_at || 0) < Math.floor(Date.now() / 1000) + 30) {
      try {
        await refreshSession();
      } catch (error) {
        console.error('Cloud session refresh failed:', error);
        storeSession(null);
        return null;
      }
    }
    if (!session) return null;
    try {
      await getProfile();
      return profile;
    } catch (error) {
      console.error('Cloud profile load failed:', error);
      storeSession(null);
      profile = null;
      workspaceId = null;
      return null;
    }
  }

  async function signIn(username, password) {
    try {
      const email = await toAuthEmail(username);
      const result = await authRequest('token?grant_type=password', { email, password }, publishableKey);
      return await acceptAuthResult(result);
    } catch (error) {
      if (session) storeSession(null);
      profile = null;
      workspaceId = null;
      throw error;
    }
  }

  async function requestAccountAccess(username, password) {
    if (!await workspaceExists()) throw new Error('لم يتم إعداد الشركة بعد. يجب إنشاء حساب المدير أولًا.');
    const email = await toAuthEmail(username);
    const result = await authRequest('signup', {
      email,
      password,
      data: { username: String(username).trim() }
    }, publishableKey);
    if (!result?.access_token || !result?.refresh_token || !result?.user) {
      throw new Error('تعذر إنشاء جلسة الطلب. تأكد من إيقاف تأكيد البريد الإلكتروني في إعدادات Supabase.');
    }
    storeSession({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600),
      user: result.user
    });
    try {
      await manageUser({ action: 'request', username: String(username).trim() });
    } catch (error) {
      storeSession(null);
      profile = null;
      workspaceId = null;
      throw error;
    }
    storeSession(null);
    profile = null;
    workspaceId = null;
    version = null;
  }

  function cleanSnapshot(snapshot) {
    const clean = JSON.parse(JSON.stringify(snapshot || {}));
    if (clean.settings) {
      const { password, ...safeLogin } = clean.settings.login || {};
      if (Object.keys(safeLogin).length) clean.settings.login = safeLogin;
      else delete clean.settings.login;
      delete clean.settings.accounts;
    }
    return clean;
  }

  async function bootstrap(username, password, snapshot) {
    if (await workspaceExists()) throw new Error('تم إعداد مساحة عمل بالفعل. سجّل الدخول بحساب المدير.');
    const email = await toAuthEmail(username);
    const authResult = await authRequest('signup', {
      email,
      password,
      data: { username: String(username).trim() }
    }, publishableKey);
    if (!authResult?.access_token) {
      throw new Error('تعذر إنشاء جلسة المدير. يجب إيقاف تأكيد البريد الإلكتروني في إعدادات Supabase.');
    }
    storeSession({
      access_token: authResult.access_token,
      refresh_token: authResult.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + Number(authResult.expires_in || 3600),
      user: authResult.user
    });
    let createdProfile;
    try {
      createdProfile = await rpc('bootstrap_erp_workspace', {
        p_username: String(username).trim(),
        p_permissions: ['dashboard', 'pos', 'inventory', 'stock-transfers', 'inventory-movements', 'products', 'product-merges', 'invoices', 'reports', 'money-expenses', 'customers', 'suppliers', 'receipts', 'returns', 'inventory-sheet', 'daily-stocktake', 'locations', 'ai-forecast', 'settings'],
        p_image: '',
        p_data: cleanSnapshot(snapshot)
      });
    } catch (error) {
      await signOut();
      throw error;
    }
    profile = createdProfile;
    workspaceId = createdProfile.workspace_id;
    version = 1;
    const legacyAccounts = Array.isArray(snapshot?.settings?.accounts) ? snapshot.settings.accounts : [];
    const skippedAccounts = [];
    for (const account of legacyAccounts) {
      if (!account?.username || !account?.role || String(account.password || '').length < 8) {
        if (account?.username) skippedAccounts.push(String(account.username));
        continue;
      }
      try {
        await createAccount({
          username: account.username,
          password: account.password,
          role: account.role,
          permissions: Array.isArray(account.permissions) ? account.permissions : [],
          image: String(account.image || '')
        });
      } catch (error) {
        console.error(`Could not migrate account "${account.username}":`, error);
        skippedAccounts.push(String(account.username));
      }
    }
    await getProfile();
    if (skippedAccounts.length) {
      localStorage.setItem('nour_erp_cloud_migration_warnings', JSON.stringify(skippedAccounts));
    }
    return profile;
  }

  async function workspaceExists() {
    return Boolean(await rpc('erp_workspace_exists'));
  }

  async function loadAppData() {
    if (!configured || !session) return null;
    if (!profile) await getProfile();
    const result = await rpc('load_erp_workspace');
    if (!result || typeof result !== 'object') return null;
    workspaceId = result.workspace_id;
    version = Number(result.version);
    if (!Number.isInteger(version) || version < 1) throw new Error('إصدار بيانات الشركة غير صالح على الخادم.');
    return result.data || null;
  }

  function saveAppData(snapshot) {
    if (!configured || !session) return Promise.resolve(false);
    const operation = saveQueue.then(async () => {
      if (!profile) await getProfile();
      if (!Number.isInteger(version)) {
        await loadAppData();
        if (!Number.isInteger(version)) throw new Error('تعذر معرفة إصدار بيانات الشركة على الخادم.');
      }
      const nextVersion = await rpc('save_erp_workspace', {
        p_data: cleanSnapshot(snapshot),
        p_expected_version: version
      });
      const savedVersion = Number(nextVersion);
      if (!Number.isInteger(savedVersion) || savedVersion <= version) {
        throw new Error('لم يؤكد الخادم حفظ أحدث نسخة من بيانات الشركة.');
      }
      version = savedVersion;
      return true;
    });
    saveQueue = operation.catch(() => {});
    return operation;
  }

  async function signOut() {
    try {
      if (session?.access_token) {
        await request('/auth/v1/logout', { method: 'POST', token: session.access_token });
      }
    } finally {
      storeSession(null);
      profile = null;
      workspaceId = null;
      version = null;
    }
  }

  async function updatePassword(password) {
    if (!session?.access_token) throw new Error('يجب تسجيل الدخول أولًا.');
    await request('/auth/v1/user', {
      method: 'PUT',
      body: { password },
      token: session.access_token
    });
  }

  async function verifyPassword(username, password) {
    if (!session?.user?.id) throw new Error('يجب تسجيل الدخول أولًا.');
    const email = await toAuthEmail(username);
    let result;
    try {
      result = await authRequest('token?grant_type=password', { email, password }, publishableKey);
    } catch (error) {
      if (/invalid login credentials/i.test(error.message)) {
        throw new Error('كلمة المرور الحالية غير صحيحة.');
      }
      throw error;
    }
    if (!result?.user?.id || result.user.id !== session.user.id) {
      throw new Error('كلمة المرور الحالية غير صحيحة.');
    }
    storeSession({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600),
      user: result.user
    });
  }

  async function manageUser(payload) {
    if (!session?.access_token) throw new Error('يجب تسجيل الدخول أولًا.');
    return request('/functions/v1/manage-workspace-user', {
      method: 'POST',
      body: payload,
      token: session.access_token
    });
  }

  async function createAccount(account) {
    const result = await manageUser({ action: 'create', ...account });
    return { ...result.member, id: result.member.user_id };
  }

  async function deleteAccount(userId) {
    await manageUser({ action: 'delete', userId });
    await getProfile();
  }

  async function listAccessRequests() {
    if (!profile || profile.role !== 'admin') throw new Error('صلاحية المدير مطلوبة.');
    return request(`/rest/v1/erp_access_requests?select=id,username,created_at&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=created_at.asc`);
  }

  async function approveAccessRequest(requestId, role, permissions) {
    await manageUser({ action: 'approve', requestId, role, permissions });
    await getProfile();
  }

  async function rejectAccessRequest(requestId) {
    await manageUser({ action: 'reject', requestId });
  }

  if (!window.nourMail) {
    window.nourMail = {
      loadAppData,
      saveAppData,
      flushAppData: data => { void saveAppData(data).catch(error => console.error('Cloud flush failed:', error)); }
    };
  }

  window.nourCloud = {
    configured,
    restoreSession,
    signIn,
    signOut,
    bootstrap,
    requestAccountAccess,
    workspaceExists,
    loadAppData,
    saveAppData,
    flushAppData: data => { void saveAppData(data).catch(error => console.error('Cloud flush failed:', error)); },
    updatePassword,
    verifyPassword,
    createAccount,
    deleteAccount,
    listAccessRequests,
    approveAccessRequest,
    rejectAccessRequest,
    getProfile: () => profile,
    isAdministrator: () => profile?.role === 'admin'
  };
})();
