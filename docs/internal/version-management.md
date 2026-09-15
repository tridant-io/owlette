# version management guide

## overview

owlette uses **independent component versioning** for flexibility while maintaining a unified product version.

## version files

| file | purpose | scope |
|------|---------|-------|
| `/VERSION` | Product release version | User-facing releases |
| `agent/VERSION` | Agent binary version | Windows service |
| `web/package.json` | Web app version | Dashboard |
| `firestore.rules` | Security schema version | Database rules |

## version philosophy

### product version (`/VERSION`)

**Current:** 3.3.4

**Tracks:** User-visible releases that bundle all components together.

**Bump when:**
- Any component has user-facing changes
- Creating a release tag
- Updating installers or documentation

### component versions

#### agent version (`agent/VERSION`)

**Current:** 3.3.4

**Tracks:** Windows service agent code.

**Bump when:**
- Agent code changes
- Bug fixes in process monitoring
- New agent features
- Windows compatibility updates

**Read by:** `agent/src/shared_utils.py` → `get_app_version()`

#### web version (`web/package.json`)

**Current:** 3.3.4

**Tracks:** Next.js web dashboard code.

**Bump when:**
- Dashboard code changes
- UI/UX updates
- API changes
- Bug fixes

**Standard:** Follows npm semantic versioning

#### firestore rules version (`firestore.rules`)

**Current:** 2.2.0

**Tracks:** Breaking changes to security rules or data schema.

**Bump when:**
- Security rule changes
- Data structure changes
- Collection schema updates
- Authentication model changes

**Independent:** Does NOT follow product version

**History:**
- 2.0.0 - Initial OAuth rules
- 2.1.0 - Agent custom tokens
- 2.2.0 - Multi-user site access control

## semantic versioning

All versions follow semantic versioning: `MAJOR.MINOR.PATCH`

- **MAJOR:** Breaking changes (2.0.0 → 3.0.0)
- **MINOR:** New features, backward compatible (2.0.0 → 2.1.0)
- **PATCH:** Bug fixes, backward compatible (2.0.0 → 2.0.1)

## syncing versions

### option 1: sync script (recommended)

Sync product, agent, and web versions together:

```bash
# Check current versions
node scripts/sync-versions.js

# Bump all to 2.1.0
node scripts/sync-versions.js 2.1.0
```

> `sync-versions.js` is the only version-sync script. (A legacy
> `sync_versions.py` that wrote just 3 of the 9 surfaces was removed in the
> 2026-09 repo cleanup — if instructions elsewhere mention it, use the .js.)

### option 2: manual update (discouraged — see the file list sync-versions.js maintains)

Update each file individually:

**1. Update product version:**
```bash
echo "2.1.0" > VERSION
```

**2. Update agent version:**
```bash
echo "2.1.0" > agent/VERSION
```

**3. Update web version:**
```bash
# Edit web/package.json
"version": "2.1.0"
```

**4. Update Firestore rules (if schema changed):**
```bash
# Edit firestore.rules header
// Version: 2.3.0 - Description of Change
// Last Updated: YYYY-MM-DD
```

## release workflow

### 1. before release

- [ ] All tests passing
- [ ] Changelog updated
- [ ] Version numbers decided

### 2. bump versions

```bash
# Sync product + components
node scripts/sync-versions.js 2.1.0

# Manually bump Firestore rules if needed
# (Only if schema/security rules changed)
```

### 3. update changelog

```bash
# Edit docs/changelog.md
## [2.1.0] - 2025-MM-DD

### Added
- Feature description

### Changed
- Change description

### Fixed
- Bug fix description
```

### 4. commit and tag

```bash
# Commit version bump
git add VERSION agent/VERSION web/package.json docs/changelog.md
git commit -m "chore: Bump version to 2.1.0"

# Create release tag
git tag v2.1.0

# Push with tags
git push origin main --tags
```

### 5. build release artifacts

```bash
# Build agent installer
cd agent
build.bat

# Build web dashboard
cd web
npm run build
```

### 6. deploy

- **Agent:** Upload installer to Firebase Storage (via Admin Panel)
- **Web:** Auto-deploys via Railway on tag push

## version in code

### reading versions

**Agent (Python):**
```python
from shared_utils import APP_VERSION
print(f"Agent version: {APP_VERSION}")  # Reads from agent/VERSION
```

**Web (TypeScript):**
```typescript
import packageJson from './package.json';
const version = packageJson.version;  // Reads from package.json
```

**Firestore Rules:**
```javascript
// Check in rule comments only (not programmatically accessible)
// Version: 2.2.0
```

### displaying versions

**In UI:**
- Agent GUI: Shows in title bar
- Web Dashboard: Shows in footer or settings
- Installer: Shows in version info

**In Logs:**
- Agent logs version on startup
- Web logs version in browser console (dev mode)

## faq

### why separate firestore rules version?

Firestore rules track **security schema**, not features. A UI update (2.0.0 → 2.1.0) doesn't require new security rules.

**Example:**
- Product: 2.1.0 (new dashboard feature)
- Agent: 2.1.0 (new feature)
- Web: 2.1.0 (new feature)
- **Firestore: 2.2.0** (no change - still multi-user access)

### should i bump all versions together?

**Yes, for releases:**
- Product, agent, and web stay in sync
- Makes releases easier to track
- Users see consistent version numbers

**No, for Firestore:**
- Only bump when security model changes
- Independent evolution

### what about pre-releases?

Use semantic versioning pre-release tags:

```bash
# Alpha release
node scripts/sync-versions.js 2.1.0-alpha.1

# Beta release
node scripts/sync-versions.js 2.1.0-beta.1

# Release candidate
node scripts/sync-versions.js 2.1.0-rc.1

# Final release
node scripts/sync-versions.js 2.1.0
```

### can i version components independently?

**Yes**, but not recommended for typical releases:

**Use case for independent versioning:**
- Hotfix agent bug without web changes
- Emergency security fix
- Platform-specific updates

**How:**
```bash
# Just update agent
echo "2.0.5" > agent/VERSION
git commit -am "fix(agent): Emergency Windows 11 compatibility fix"
git tag v2.0.5-agent
```

## best practices

1. **Sync regularly:** Use sync script for normal releases
2. **Update changelog:** Document all version changes
3. **Tag releases:** Use `v2.1.0` format
4. **Test before bump:** All tests must pass
5. **Firestore independence:** Only bump rules for schema changes
6. **Semantic versioning:** Follow MAJOR.MINOR.PATCH strictly
7. **Document changes:** Update docs when versions change

## migration from old system

**Before (inconsistent):**
- Hardcoded versions in multiple files
- Docs out of sync with code
- No single source of truth

**After (unified):**
- VERSION files are source of truth
- Sync script keeps components aligned
- Firestore rules independently versioned
- Clear upgrade path

## related documentation

- [changelog](../changelog.md) - Release history
- Development guide: root `.claude/CLAUDE.md`
- [firestore security rules](../../web/content/docs/setup/firestore-rules.mdx) - Security rules

---

**Last Updated:** 2026-09-12
