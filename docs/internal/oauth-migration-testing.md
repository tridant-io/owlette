# oauth authentication migration - testing guide

!!! warning "Deprecated"
    This document is from the v2.1.0 OAuth browser flow, which was **replaced in v2.4.1** with the device code pairing flow. The browser-based OAuth, localhost:8765 callback, and Windows Credential Manager references below are no longer accurate.

    **Current auth flow:** See [Agent Installation](../../web/content/docs/agent/installation.mdx#how-pairing-works).

    **Current token storage:** `.tokens.enc` (Fernet-encrypted, machine-bound key), not Windows Credential Manager.

    **Current installer flags:** `/ADD=phrase` for silent pairing, `/SERVER=dev` for dev environment.

    **Removed routes:** the registration-code routes this plan exercises (`/api/agent/generate-installer`, `/api/setup/generate-token` and `/api/agent/auth/exchange`) no longer exist, so its registration-code and token-exchange steps cannot be run.

**Version:** 2.1.0
**Last Updated:** 2025-11-03
**Status:** Archived (replaced by device code pairing in v2.4.1)

---

## overview

This document provides a comprehensive testing plan for the OAuth authentication migration that eliminates service account credentials from the owlette agent.

**Major Changes:**
- ✅ Agent uses OAuth custom tokens (no service accounts)
- ✅ Tokens stored in Windows Credential Manager (encrypted)
- ✅ Automatic token exchange during installation
- ✅ Firestore REST API client (replaces Admin SDK)
- ✅ Updated security rules (machine-level isolation)

---

## pre-testing setup

### 1. deploy firestore security rules

**Firebase Console Method:**
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select project: `owlette-dev-3838a`
3. Navigate to **Firestore Database** → **Rules**
4. Copy contents of `firestore.rules` (version 2.1.0)
5. Paste into editor
6. Click **Validate** → **Publish**

**Firebase CLI Method:**
```bash
cd owlette
firebase deploy --only firestore:rules --project owlette-dev-3838a
```

**Verify Deployment:**
```bash
firebase firestore:rules --project owlette-dev-3838a
```

---

### 2. configure web backend environment variables

**Railway (Development):**

Add these environment variables to your Railway dev service:

```env
# Firebase Admin SDK (server-side)
FIREBASE_PROJECT_ID=owlette-dev-3838a
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@owlette-dev-3838a.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

**How to get these values:**
1. Go to Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key"
3. Extract values from downloaded JSON:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY` (keep \n escape sequences)

---

### 3. rebuild agent installer

**Prerequisites:**
- Inno Setup 6.x installed
- Python 3.9+ installed
- All agent dependencies installed

**Build Steps:**

```bash
cd agent

# Step 1: Install/update dependencies
pip install -r requirements.txt

# Step 2: Run build script
# This creates the installer package in build/installer_package/
build.bat

# Step 3: Compile Inno Setup installer
# This creates Owlette-Installer-v2.0.0.exe in build/installer_output/
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" owlette_installer.iss
```

**Verify Build:**
```bash
# Check installer exists
dir build\installer_output\Owlette-Installer-v2.0.0.exe

# Check new OAuth files are included
dir build\installer_package\agent\src\auth_manager.py
dir build\installer_package\agent\src\secure_storage.py
dir build\installer_package\agent\src\firestore_rest_client.py
```

**Expected Output:**
- `build/installer_output/Owlette-Installer-v2.0.0.exe` (~50-80 MB)
- All new Python files included in package
- `requirements.txt` without `firebase-admin`

---

## testing checklist

### phase 1: fresh installation (oauth flow)

**Test Environment:**
- Clean Windows 10/11 machine (VM recommended)
- No previous owlette installation
- Internet connection required

**Test Steps:**

1. **Run Installer**
   ```bash
   Owlette-Installer-v2.0.0.exe /SERVER=dev
   ```

2. **OAuth Browser Flow**
   - [ ] Browser opens to `dev.owlette.app/setup`
   - [ ] Can log in with test account
   - [ ] Can see/create site list
   - [ ] Can click "Continue" to authorize agent
   - [ ] Browser redirects to success page

3. **Token Exchange**
   - [ ] Installer shows "Exchanging registration code for OAuth tokens..."
   - [ ] No errors in installer output
   - [ ] Config saved to `C:\owlette\agent\config\config.json`

4. **Verify config.json**
   ```json
   {
     "firebase": {
       "enabled": true,
       "site_id": "user@sitename",
       "project_id": "owlette-dev-3838a",
       "api_base": "https://dev.owlette.app/api"
     }
   }
   ```
   - [ ] **No `token` field present** (tokens in Credential Manager, not config)

5. **Verify Windows Credential Manager**
   - Open: Control Panel → Credential Manager → Windows Credentials
   - [ ] Credential named "owlette" exists
   - [ ] Has entries for:
     - `AgentRefreshToken`
     - `AgentSiteId`
     - `AgentAccessToken`
     - `AgentTokenExpiry`

6. **Service Installation**
   - [ ] Installer completes successfully
   - [ ] Service "OwletteService" created
   - [ ] Service status: Running

7. **Verify Service Logs**
   ```bash
   type C:\owlette\agent\logs\owlette_service.log
   ```
   - [ ] "Firebase client initialized for site: user@sitename"
   - [ ] "Connected to Firestore - Site: ..., Machine: ..."
   - [ ] NO errors about missing credentials
   - [ ] NO errors about authentication

8. **Verify Web Dashboard**
   - Go to `https://dev.owlette.app/dashboard`
   - [ ] Machine appears in site list
   - [ ] Machine shows "Online" status (green dot)
   - [ ] Can see CPU, memory, disk metrics
   - [ ] Process list populated

**Expected Results:**
- ✅ Complete OAuth flow with zero manual steps
- ✅ No firebase-credentials.json required
- ✅ Tokens stored encrypted in Credential Manager
- ✅ Agent authenticates and syncs successfully

---

### phase 2: token refresh (long-running test)

**Purpose:** Verify automatic token refresh after access token expires (1 hour).

**Test Steps:**

1. **Install agent** (as in Phase 1)

2. **Wait 1 hour** (access token expires)

3. **Monitor logs** for token refresh:
   ```bash
   type C:\owlette\agent\logs\owlette_service.log | findstr "refresh"
   ```
   - [ ] "Token expires in Xs, refreshing..."
   - [ ] "Token refreshed successfully, expires_in=3600s"
   - [ ] NO authentication errors

4. **Verify continued operation:**
   - [ ] Heartbeat continues every 30s
   - [ ] Metrics upload continues every 60s
   - [ ] Dashboard shows machine still online

**Expected Results:**
- ✅ Automatic token refresh before expiry
- ✅ No service interruption
- ✅ No user intervention required

---

### phase 3: machine removal (token revocation)

**Purpose:** Verify token revocation when machine is removed from dashboard.

**Test Steps:**

1. **Install agent** (as in Phase 1)

2. **Verify agent is syncing:**
   - Dashboard shows machine online
   - Metrics updating

3. **Remove machine from dashboard:**
   - Click machine → 3-dot menu → "Remove Machine"
   - Confirm deletion

4. **Verify Firestore:**
   - Check `agent_refresh_tokens` collection
   - [ ] Refresh token for this machine deleted

5. **Wait for access token to expire** (up to 1 hour)

6. **Monitor agent behavior:**
   ```bash
   type C:\owlette\agent\logs\owlette_service.log | findstr "error"
   ```
   - [ ] "Token refresh failed: Invalid or expired refresh token"
   - [ ] Agent stops trying to sync
   - [ ] Service continues running (offline mode)

7. **Verify dashboard:**
   - [ ] Machine no longer appears in list
   - [ ] No zombie entries

**Expected Results:**
- ✅ Token revoked when machine removed
- ✅ Agent stops syncing after token expires
- ✅ Graceful fallback to offline mode

---

### phase 4: offline mode & reconnection

**Purpose:** Verify agent works offline and reconnects when network restored.

**Test Steps:**

1. **Install agent** (as in Phase 1)

2. **Disconnect network:**
   - Disable Wi-Fi/Ethernet
   - Wait 1 minute

3. **Verify offline mode:**
   ```bash
   type C:\owlette\agent\logs\owlette_service.log
   ```
   - [ ] "Running in OFFLINE MODE - will use cached config only"
   - [ ] Service continues running
   - [ ] Uses cached process list

4. **Reconnect network:**
   - Enable Wi-Fi/Ethernet
   - Wait 2 minutes

5. **Verify reconnection:**
   - [ ] "Connected to Firestore - Site: ..., Machine: ..."
   - [ ] Heartbeat resumes
   - [ ] Dashboard shows machine online again

**Expected Results:**
- ✅ Agent survives network loss
- ✅ Automatic reconnection when network restored
- ✅ No manual intervention required

---

### phase 5: upgrade from old version

**Purpose:** Verify migration from service account auth to OAuth auth.

**Test Steps:**

1. **Install old version** (with service accounts):
   - Use owlette v2.0.0 installer
   - Manually configure firebase-credentials.json
   - Verify agent works

2. **Uninstall old version:**
   ```bash
   C:\owlette\unins000.exe
   ```

3. **Install new version** (with OAuth):
   ```bash
   Owlette-Installer-v2.0.0.exe /SERVER=dev
   ```

4. **Complete OAuth flow:**
   - Same site as before
   - Same machine ID

5. **Verify upgrade:**
   - [ ] Old firebase-credentials.json ignored (if left behind)
   - [ ] OAuth tokens used instead
   - [ ] Machine appears with same ID in dashboard
   - [ ] No duplicate machines

**Expected Results:**
- ✅ Clean upgrade path
- ✅ Same machine ID preserved
- ✅ No leftover service account files used

---

## security audit

### 1. secret scanning

**Scan codebase for leaked secrets:**

```bash
# Install TruffleHog (if not installed)
pip install trufflehog

# Scan repository
cd owlette
trufflehog filesystem ./ --json > security-scan.json

# Check for findings
type security-scan.json | findstr "verified"
```

**Expected Results:**
- ✅ No secrets found in source code
- ✅ No Firebase credentials in commits
- ✅ No tokens in config files

---

### 2. build artifact verification

**Verify installer contains no secrets:**

```bash
# Extract installer contents (using 7-Zip or similar)
"C:\Program Files\7-Zip\7z.exe" x build\installer_output\Owlette-Installer-v2.0.0.exe -obuild\extracted

# Search for Firebase credentials in extracted files
cd build\extracted
findstr /S /I "firebase-credentials.json" *
findstr /S /I "private_key" *.json
findstr /S /I "service_account" *.json
```

**Expected Results:**
- ✅ No firebase-credentials.json in installer
- ✅ No service account keys in any file
- ✅ No hardcoded tokens or secrets

---

### 3. token storage verification

**Verify tokens are encrypted:**

```bash
# Try to read raw credential data
type C:\Users\%USERNAME%\AppData\Local\Microsoft\Credentials\*

# Should be binary/encrypted, not plaintext
```

**Verify Credential Manager:**
- Open Credential Manager (Control Panel)
- Find "owlette" credentials
- [ ] Cannot view password in plaintext (Windows hides it)
- [ ] Credentials tied to current user + machine

**Expected Results:**
- ✅ Tokens encrypted with DPAPI
- ✅ Cannot read tokens without Windows authentication
- ✅ Tokens unusable on different machine/user

---

### 4. firestore security rules testing

**Test rule enforcement via Firebase Console Rules Playground:**

**Test 1: Agent can access own machine**
- Location: `sites/test_site/machines/DESKTOP-001`
- Auth: Custom Claims
  ```json
  {
    "role": "agent",
    "site_id": "test_site",
    "machine_id": "DESKTOP-001"
  }
  ```
- Operation: `get`, `set`
- Expected: ✅ Allowed

**Test 2: Agent CANNOT access other machines**
- Location: `sites/test_site/machines/DESKTOP-002`
- Auth: Custom Claims (same as above)
- Operation: `get`
- Expected: ❌ Denied

**Test 3: OAuth token collections are protected**
- Location: `agent_tokens/test_code_123`
- Auth: Any (authenticated, admin, agent)
- Operation: `get`
- Expected: ❌ Denied (server-side only)

**Expected Results:**
- ✅ Machine-level isolation enforced
- ✅ Cross-machine access blocked
- ✅ Token collections inaccessible from clients

---

## performance testing

### 1. token refresh overhead

**Measure impact of REST API vs Admin SDK:**

```python
# Add to agent logs
import time

start = time.time()
# Firestore operation
elapsed = time.time() - start

logger.debug(f"Firestore operation took {elapsed*1000:.2f}ms")
```

**Expected Results:**
- ✅ Heartbeat: < 500ms
- ✅ Metrics upload: < 1000ms
- ✅ Config fetch: < 500ms
- ✅ Acceptable overhead (+50-100ms vs Admin SDK)

---

### 2. memory usage

**Monitor agent memory consumption:**

```bash
# Check service memory usage
tasklist /FI "IMAGENAME eq python.exe" /FO TABLE

# Compare before (with Admin SDK) vs after (with REST client)
```

**Expected Results:**
- ✅ Memory usage < 100 MB
- ✅ No memory leaks over time
- ✅ Similar to previous version

---

## rollback plan

If critical issues are found:

### quick rollback (emergency)

1. **Revert Firestore Rules:**
   ```bash
   # In Firebase Console: Rules → History → Restore previous version
   ```

2. **Redeploy old installer:**
   ```bash
   # Use backup of v2.0.0 installer with service accounts
   Owlette-Installer-v2.0.0-backup.exe
   ```

3. **Manually configure service accounts:**
   - Download firebase-credentials.json
   - Place in `C:\owlette\agent\config\`
   - Restart service

---

### full rollback (code revert)

```bash
# Revert all OAuth changes
git checkout main
git revert HEAD~N  # N = number of OAuth commits

# Rebuild installer with old code
cd agent
build.bat
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" owlette_installer.iss
```

---

## known issues & workarounds

### issue 1: port 8765 already in use

**Symptom:** OAuth callback server fails to start during installation.

**Workaround:**
1. Close applications using port 8765
2. Run installer again

---

### issue 2: browser doesn't open

**Symptom:** Browser doesn't open automatically during OAuth flow.

**Workaround:**
1. Manually open URL shown in installer
2. Complete OAuth flow
3. Installation continues automatically

---

### issue 3: token refresh fails after 30 days

**Symptom:** Agent stops syncing after 30 days (refresh token expired).

**Workaround:**
1. User must re-authenticate via web dashboard
2. Or reinstall agent to get new tokens

**Future Enhancement:** Implement warning notifications before expiry.

---

## success criteria

**All tests must pass before production deployment:**

- [ ] Fresh installation completes with zero manual steps
- [ ] OAuth flow works on clean Windows machine
- [ ] Tokens stored encrypted in Credential Manager
- [ ] Agent authenticates and syncs successfully
- [ ] Automatic token refresh works (1 hour expiry)
- [ ] Token revocation works ("Remove Machine")
- [ ] Offline mode & reconnection works
- [ ] No secrets leaked in code or installer
- [ ] Firestore security rules enforced correctly
- [ ] Performance acceptable (< 100ms overhead)
- [ ] No memory leaks or crashes

---

## sign-off

**Before deploying to production:**

- [ ] All Phase 1-5 tests passed
- [ ] Security audit completed (no secrets found)
- [ ] Performance testing acceptable
- [ ] Documentation updated
- [ ] Rollback plan tested and ready

**Signed:** ___________________
**Date:** ___________________

---

**Document Version:** 1.0
**Last Updated:** 2025-11-03
**Next Review:** After first production deployment
