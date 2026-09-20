# owlette 2.0 - architecture decisions

This document outlines key architectural decisions for owlette 2.0.

---

## repository structure

### recommended: monorepo with clear separation

We'll use a **monorepo** structure with clear directories for each component:

```
owlette/
├── agent/                      # Python Windows Service
│   ├── src/
│   │   ├── owlette_service.py
│   │   ├── firebase_client.py
│   │   ├── shared_utils.py
│   │   └── ...
│   ├── config/
│   │   ├── config.json
│   │   └── firebase-credentials.json (ignored)
│   ├── logs/
│   ├── requirements.txt
│   ├── build.bat
│   ├── install.bat
│   ├── owlette_service.spec
│   └── README.md
│
├── web/                     # Next.js Web Dashboard
│   ├── app/
│   │   ├── (auth)/
│   │   ├── (dashboard)/
│   │   └── api/
│   ├── components/
│   ├── lib/
│   │   └── firebase.ts
│   ├── public/
│   ├── package.json
│   ├── next.config.js
│   ├── tsconfig.json
│   └── README.md
│
├── docs/                       # Shared Documentation
│   ├── architecture-decisions.md
│   ├── firebase-setup.md
│   ├── phase2-web-portal.md
│   └── deployment.md
│
├── firebase/                   # Firebase Configuration (optional)
│   ├── firestore.rules
│   └── firestore.indexes.json
│
├── .gitignore
├── README.md                   # Main project README
└── LICENSE
```

### why monorepo?

**Advantages:**
- ✅ Single source of truth for the entire product
- ✅ Easy to keep agent and portal versions in sync
- ✅ Shared documentation and issue tracking
- ✅ Simpler CI/CD pipeline
- ✅ Clear separation of concerns with directories
- ✅ Perfect for solo developer

**Each component remains independent:**
- Agent can be built/deployed separately (`agent/build.bat`)
- Portal can be deployed separately (`cd portal && npm run build`)
- Clear boundaries prevent cross-contamination

**Alternative considered:**
- Separate repos (owlette-agent, owlette-web) - rejected because it adds complexity for solo development and version management

---

## site id management

### what is a site id?

A **site_id** is a unique identifier for a physical location or logical grouping of machines. Examples:
- `nyc_office_001`
- `london_studio`
- `client_acme_venue_a`

### development vs production

#### development (phase 1 - current)
**Manual Configuration:**
1. You manually set `site_id` in `config/config.json`:
   ```json
   "firebase": {
     "enabled": true,
     "site_id": "dev_test_site"
   }
   ```
2. The agent reads this on startup and registers to that site
3. This is fine for testing and development

#### production (phase 4 - machine onboarding)
**Automated from Web Portal:**

1. **Admin creates site in web dashboard:**
   - Navigate to "Sites" → "Add New Site"
   - Enter site name: "NYC Office"
   - System generates unique `site_id`: `site_abc123xyz`

2. **Admin generates installer:**
   - Click "Generate Installer" for that site
   - Downloads `owlette-installer-nyc-office.exe`
   - **Installer contains embedded `site_id` and Firebase credentials**

3. **Technician installs on machines:**
   - Run `owlette-installer-nyc-office.exe` on any machine
   - Agent automatically registers to `site_abc123xyz`
   - Machine appears in web dashboard under "NYC Office" immediately
   - **No manual configuration needed**

### site id generation strategy

**Format:** `site_` + 8-character alphanumeric hash

**Why?**
- Short and readable
- URL-safe
- Globally unique
- Sortable by creation time (if using timestamp-based hash)

**Implementation (in web dashboard):**
```typescript
function generateSiteId(): string {
  const timestamp = Date.now().toString(36); // Base36 timestamp
  const random = Math.random().toString(36).substring(2, 7); // Random string
  return `site_${timestamp}${random}`;
}
```

Example: `site_l8xk9p2qr4`

### site hierarchy in firestore

```
sites/
  site_abc123xyz/
    name: "NYC Office"
    createdAt: timestamp
    createdBy: user_id
    machines/
      MACHINE-001/
        presence/
        status/
        commands/
      MACHINE-002/
        presence/
        status/
        commands/

config/
  site_abc123xyz/
    machines/
      MACHINE-001/
        version: "2.0.0"
        processes: [...]
      MACHINE-002/
        version: "2.0.0"
        processes: [...]

users/
  user_xyz/
    email: "admin@example.com"
    role: "superadmin"         # or "admin" for site-scoped ops, "member" for read-only
    sites: ["site_abc123xyz", "site_def456uvw"]
```

### site assignment flow

```
Web Portal                    Firestore                    Agent
─────────────────────────────────────────────────────────────────────

1. Create Site
   "NYC Office"
   ──────────>
              sites/site_abc123xyz created

2. Generate Installer
   (with site_abc123xyz)
   <──────────

3. Download installer

4.                                                  Install on machine
                                                    Agent starts
                                                    ────────────>

                                                    Register with
                                                    site_abc123xyz
              sites/site_abc123xyz/
              machines/HOSTNAME created
              <────────────

5. View Dashboard
   ──────────>
              Fetch machines for
              site_abc123xyz
              <──────────

   See machine appear!
```

---

## migration path

### current state (phase 1)
- Manual `site_id` in config.json
- For development and testing

### phase 2-3 (web portal + config management)
- Web portal exists
- Can create sites manually
- Still manual config.json editing on machines

### phase 4 (machine onboarding)
- **Full automation**
- Generate installers from portal
- Zero manual configuration
- Production-ready deployment

### phase 5 (software distribution) ✅
- Remote software installation across multiple machines
- Deployment templates and verification
- Real-time installation tracking

### phase 6 (project file distribution) ✅
- Distribute project files (ZIPs, .toe files, media assets)
- URL-based architecture (zero infrastructure cost)
- Automatic extraction and file verification
- Support for multi-GB TouchDesigner projects

### phase 7+ (future)
- Version management and rollback
- Git integration for project files
- Full SaaS product features

---

## file locations

### firebase credentials

**Location:** `config/firebase-credentials.json`

**Why in config/?**
- Logical grouping with other configuration
- Easy to find for administrators
- Keeps root directory clean
- Already gitignored

**Security:**
- Never commit to git (in .gitignore)
- Permissions: Only SYSTEM and Administrators should have access
- In production installers: Embedded in a protected location

### config files

```
config/
├── config.json                      # Main configuration (migrated to Firestore)
├── firebase-credentials.json        # Service account key (never commit)
└── firebase_cache.json              # Cached Firestore config (for offline mode)
```

---

## development workflow

### for agent development

```bash
cd agent/src
python owlette_runner.py --debug
```

### for portal development

```bash
cd portal
npm install
npm run dev
```

### for full stack testing

**Terminal 1 (Agent):**
```bash
cd agent/src
python owlette_runner.py --debug
```

**Terminal 2 (Portal):**
```bash
cd portal
npm run dev
# Visit http://localhost:3000
```

---

## deployment strategy

### agent deployment
- Build: `agent/build.bat`
- Output: `agent/dist/owlette_service.exe`
- Installer: `agent/installer/owlette_setup.exe`
- Distribution: Downloaded from web dashboard (Phase 4)

### portal deployment
- Build: `cd portal && npm run build`
- Deploy to: Vercel (recommended) or Firebase Hosting
- URL: `https://owlette.your-domain.com`

### firebase deployment
- Rules: `firebase deploy --only firestore:rules`
- Indexes: Automatically created or use `firebase/firestore.indexes.json`

---

## summary

**Site ID:**
- Development: Manually set in config.json (current)
- Production: Auto-embedded in installers (Phase 4)

**Repo Structure:**
- Monorepo with `agent/` and `web/` directories
- Clear separation, easy management
- Perfect for solo developer building a product

**Next Steps:**
1. Phase 1: Test Firebase integration ✅
2. Phase 2: Build web dashboard (Next.js)
3. Phase 3: Config management from web
4. Phase 4: Auto-installer generation with embedded site_id
5. Phase 5: Software distribution
