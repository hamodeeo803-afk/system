import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function authEmail(username: string) {
  const normalized = username.trim().toLowerCase()
  const bytes = new TextEncoder().encode(normalized)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  return `u${hash.slice(0, 32)}@users.nourgroup.app`
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) {
    console.error('Missing Supabase function secrets')
    return response({ error: 'Server configuration is incomplete' }, 500)
  }

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return response({ error: 'Authentication required' }, 401)

  try {
    const callerClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: authData, error: authError } = await callerClient.auth.getUser()
    if (authError || !authData.user) return response({ error: 'Invalid session' }, 401)

    const adminClient = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const payload = await request.json()
    if (payload?.action === 'request') {
      const username = String(payload.username || '').trim()
      if (!/^[\p{L}\p{N}._ -]{3,40}$/u.test(username) || await authEmail(username) !== authData.user.email) {
        return response({ error: 'Username does not match the authenticated account' }, 400)
      }
      const { data: accessRequest, error: requestError } = await callerClient.rpc('submit_erp_access_request', {
        p_username: username,
      })
      if (requestError || !accessRequest) {
        return response({ error: requestError?.message || 'Could not submit the access request' }, 409)
      }
      return response({ success: true, requestId: accessRequest.id }, 201)
    }

    const { data: caller, error: callerError } = await adminClient
      .from('erp_workspace_members')
      .select('workspace_id, role')
      .eq('user_id', authData.user.id)
      .single()
    if (callerError || caller?.role !== 'admin') return response({ error: 'Administrator access required' }, 403)

    if (payload?.action === 'create') {
      const username = String(payload.username || '').trim()
      const password = String(payload.password || '')
      const role = String(payload.role || '')
      const permissions = payload.permissions
      if (!/^[\p{L}\p{N}._ -]{3,40}$/u.test(username) || password.length < 8) {
        return response({ error: 'Username or password does not meet the requirements' }, 400)
      }
      if (!['receipts', 'cashier', 'inventory', 'custom'].includes(role)) {
        return response({ error: 'Invalid account role' }, 400)
      }
      if (!Array.isArray(permissions) || permissions.length === 0 || permissions.some(item => typeof item !== 'string')) {
        return response({ error: 'At least one valid permission is required' }, 400)
      }

      const email = await authEmail(username)
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username },
      })
      if (createError || !created.user) {
        return response({ error: createError?.message || 'Could not create the account' }, 409)
      }

      const { data: member, error: memberError } = await adminClient
        .from('erp_workspace_members')
        .insert({
          user_id: created.user.id,
          workspace_id: caller.workspace_id,
          username,
          username_key: username.toLowerCase(),
          role,
          permissions,
          image: String(payload.image || ''),
        })
        .select('user_id, workspace_id, username, role, permissions, image')
        .single()

      if (memberError) {
        await adminClient.auth.admin.deleteUser(created.user.id)
        return response({ error: memberError.message }, 409)
      }
      return response({ member })
    }

    if (payload?.action === 'delete') {
      const userId = String(payload.userId || '')
      if (!userId || userId === authData.user.id) return response({ error: 'Cannot delete this account' }, 400)

      const { data: target, error: targetError } = await adminClient
        .from('erp_workspace_members')
        .select('user_id, workspace_id, role')
        .eq('user_id', userId)
        .eq('workspace_id', caller.workspace_id)
        .single()
      if (targetError || !target || target.role === 'admin') {
        return response({ error: 'Account not found or cannot be deleted' }, 404)
      }
      const { error: deleteError } = await adminClient.auth.admin.deleteUser(target.user_id)
      if (deleteError) return response({ error: deleteError.message }, 500)
      return response({ success: true })
    }

    if (payload?.action === 'approve') {
      const requestId = String(payload.requestId || '')
      const role = String(payload.role || '')
      const permissions = payload.permissions
      if (!requestId || !['receipts', 'cashier', 'inventory', 'custom'].includes(role)) {
        return response({ error: 'Invalid access request or role' }, 400)
      }
      if (!Array.isArray(permissions) || permissions.length === 0 || permissions.some(item => typeof item !== 'string')) {
        return response({ error: 'At least one valid permission is required' }, 400)
      }
      const { data: member, error: approvalError } = await adminClient.rpc('approve_erp_access_request', {
        p_workspace_id: caller.workspace_id,
        p_request_id: requestId,
        p_role: role,
        p_permissions: permissions,
      })
      if (approvalError || !member) return response({ error: approvalError?.message || 'Could not approve the request' }, 409)
      return response({ member })
    }

    if (payload?.action === 'reject') {
      const requestId = String(payload.requestId || '')
      const { data: pending, error: pendingError } = await adminClient
        .from('erp_access_requests')
        .select('user_id')
        .eq('id', requestId)
        .eq('workspace_id', caller.workspace_id)
        .single()
      if (pendingError || !pending) return response({ error: 'Access request not found' }, 404)
      const { error: rejectError } = await adminClient.auth.admin.deleteUser(pending.user_id)
      if (rejectError) return response({ error: rejectError.message }, 500)
      return response({ success: true })
    }

    return response({ error: 'Unsupported action' }, 400)
  } catch (error) {
    console.error('Workspace account operation failed:', error)
    return response({ error: 'Workspace account operation failed' }, 500)
  }
})
