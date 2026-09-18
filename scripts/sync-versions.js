#!/usr/bin/env node
/**
 * Sync every component version to the product version.
 *
 *   node scripts/sync-versions.js         # show current versions
 *   node scripts/sync-versions.js 2.1.0   # bump all to 2.1.0
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const VERSION_FILES = {
  product: path.join(ROOT, 'VERSION'),
  agent: path.join(ROOT, 'agent', 'VERSION'),
  web: path.join(ROOT, 'web', 'package.json'),
  desktopPkg: path.join(ROOT, 'desktop', 'package.json'),
  tauriConf: path.join(ROOT, 'desktop', 'src-tauri', 'tauri.conf.json'),
};

// Own reader/writer: TOML, and only the [package] version may change —
// dependency `version = "..."` keys must not match. All three Rust crates carry
// the product version: Tauri stamps the desktop app's into its bundle, and
// agent/host/build.rs and agent/swoop/build.rs stamp theirs into the exe's
// VERSIONINFO resource. The host crate was missing from this list until 3.3.2
// and sat at 3.0.0 for six releases — harmless while the binary carried no
// version resource, wrong the moment it did. The swoop streamer also refuses
// to run when its version differs from the agent's, so a stale number there
// strands the feature on the machine.
const CARGO_TOMLS = {
  desktop: path.join(ROOT, 'desktop', 'src-tauri', 'Cargo.toml'),
  host: path.join(ROOT, 'agent', 'host', 'Cargo.toml'),
  swoop: path.join(ROOT, 'agent', 'swoop', 'Cargo.toml'),
};

const CARGO_VERSION_PATTERN = /^(version = ")(\d+\.\d+\.\d+)(")/m;

function readCargoVersion(cargoToml) {
  const match = fs.readFileSync(cargoToml, 'utf8').match(CARGO_VERSION_PATTERN);
  return match ? match[2] : '(no [package] version)';
}

function writeCargoVersion(cargoToml, version) {
  const content = fs.readFileSync(cargoToml, 'utf8');
  const updated = content.replace(CARGO_VERSION_PATTERN, `$1${version}$3`);
  fs.writeFileSync(cargoToml, updated, 'utf8');
}

const DOC_FILES = {
  readme: path.join(ROOT, 'README.md'),
  claudemd: path.join(ROOT, '.claude', 'CLAUDE.md'),
  versionMgmt: path.join(ROOT, 'docs', 'internal', 'version-management.md'),
};

// YYYY-MM-DD, for "Last Updated" fields.
function todayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function readVersion(file) {
  if (file.endsWith('.json')) {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return pkg.version;
  }
  return fs.readFileSync(file, 'utf8').trim();
}

function writeVersion(file, version) {
  if (file.endsWith('.json')) {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.version = version;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  } else {
    fs.writeFileSync(file, version + '\n', 'utf8');
  }
}

// `oldVersion` targets lines like "**Current:** X.Y.Z" precisely, so independent
// versions (firestore rules) are left alone.
function updateDocVersion(file, version, oldVersion) {
  let content = fs.readFileSync(file, 'utf8');
  let updated = false;

  if (file === DOC_FILES.readme) {
    // shields.io badge: version-X.Y.Z-blue
    const badgePattern = /(img\.shields\.io\/badge\/version-)\d+\.\d+\.\d+(-[a-z]+\))/;
    if (badgePattern.test(content)) {
      content = content.replace(badgePattern, `$1${version}$2`);
      updated = true;
    }

    // Legacy **Version X.Y.Z** format.
    const readmePattern = /\*\*Version \d+\.\d+\.\d+\*\*/;
    if (readmePattern.test(content)) {
      content = content.replace(readmePattern, `**Version ${version}**`);
      updated = true;
    }
  } else if (file === DOC_FILES.versionMgmt) {
    // Only lines matching the PREVIOUS product version, so the independent
    // firestore-rules "**Current:**" line is left alone.
    const escapedPrev = oldVersion.replace(/\./g, '\\.');
    const currentPattern = new RegExp(`\\*\\*Current:\\*\\* ${escapedPrev}`, 'g');
    if (currentPattern.test(content)) {
      content = content.replace(currentPattern, `**Current:** ${version}`);
      updated = true;
    }

    // Supports **Last Updated:** and **Last Updated**:.
    const lastUpdatedPattern = /\*\*Last Updated:?\*\*:? \d{4}-\d{2}-\d{2}/;
    if (lastUpdatedPattern.test(content)) {
      content = content.replace(lastUpdatedPattern, `**Last Updated:** ${todayISO()}`);
      updated = true;
    }
  } else if (file === DOC_FILES.claudemd) {
    const headerPattern = /\*\*Version\*\*: \d+\.\d+\.\d+/;
    if (headerPattern.test(content)) {
      content = content.replace(headerPattern, `**Version**: ${version}`);
      updated = true;
    }

    // The three-line version-files list.
    const versionFilesPattern = /- `\/VERSION` - Product release version \(\d+\.\d+\.\d+\)\n- `agent\/VERSION` - Agent binary version \(\d+\.\d+\.\d+\)\n- `web\/package\.json` - Web app version \(\d+\.\d+\.\d+\)/;
    if (versionFilesPattern.test(content)) {
      const replacement = `- \`/VERSION\` - Product release version (${version})\n- \`agent/VERSION\` - Agent binary version (${version})\n- \`web/package.json\` - Web app version (${version})`;
      content = content.replace(versionFilesPattern, replacement);
      updated = true;
    }

    const lastUpdatedPattern = /\*\*Last Updated\*\*: \d{4}-\d{2}-\d{2}/;
    if (lastUpdatedPattern.test(content)) {
      content = content.replace(lastUpdatedPattern, `**Last Updated**: ${todayISO()}`);
      updated = true;
    }

    // **Current Version**: X.Y.Z (Month D, YYYY)
    const currentVersionPattern = /\*\*Current Version\*\*: \d+\.\d+\.\d+/;
    if (currentVersionPattern.test(content)) {
      const now = new Date();
      const monthNames = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
      const dateStr = `${monthNames[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

      content = content.replace(
        /\*\*Current Version\*\*: \d+\.\d+\.\d+ \([^)]+\)/,
        `**Current Version**: ${version} (${dateStr})`
      );
      updated = true;
    }
  }

  if (updated) {
    fs.writeFileSync(file, content, 'utf8');
  }

  return updated;
}

function showVersions() {
  console.log('\n📦 Current Versions:\n');
  console.log(`  Product:  ${readVersion(VERSION_FILES.product)}`);
  console.log(`  Agent:    ${readVersion(VERSION_FILES.agent)}`);
  console.log(`  Web:      ${readVersion(VERSION_FILES.web)}`);
  console.log(`  Desktop:  ${readVersion(VERSION_FILES.desktopPkg)} (package.json) / ${readCargoVersion(CARGO_TOMLS.desktop)} (Cargo.toml)`);
  console.log(`  Host:     ${readCargoVersion(CARGO_TOMLS.host)} (agent/host/Cargo.toml)`);
  console.log(`  Swoop:    ${readCargoVersion(CARGO_TOMLS.swoop)} (agent/swoop/Cargo.toml)`);
  console.log('\n  Note: Firestore rules version is independent (tracks schema changes)\n');
}

function syncVersions(newVersion) {
  if (!newVersion.match(/^\d+\.\d+\.\d+$/)) {
    console.error(`❌ Invalid version format: ${newVersion}`);
    console.error('   Expected format: X.Y.Z (e.g., 2.1.0)');
    process.exit(1);
  }

  const oldVersion = readVersion(VERSION_FILES.product);

  console.log(`\n🔄 Syncing all versions to ${newVersion} (was ${oldVersion})...\n`);

  writeVersion(VERSION_FILES.product, newVersion);
  console.log(`  ✅ Updated /VERSION → ${newVersion}`);

  writeVersion(VERSION_FILES.agent, newVersion);
  console.log(`  ✅ Updated agent/VERSION → ${newVersion}`);

  writeVersion(VERSION_FILES.web, newVersion);
  console.log(`  ✅ Updated web/package.json → ${newVersion}`);

  writeVersion(VERSION_FILES.desktopPkg, newVersion);
  console.log(`  ✅ Updated desktop/package.json → ${newVersion}`);

  writeVersion(VERSION_FILES.tauriConf, newVersion);
  console.log(`  ✅ Updated desktop/src-tauri/tauri.conf.json → ${newVersion}`);

  writeCargoVersion(CARGO_TOMLS.desktop, newVersion);
  console.log(`  ✅ Updated desktop/src-tauri/Cargo.toml → ${newVersion}`);

  writeCargoVersion(CARGO_TOMLS.host, newVersion);
  console.log(`  ✅ Updated agent/host/Cargo.toml → ${newVersion}`);

  writeCargoVersion(CARGO_TOMLS.swoop, newVersion);
  console.log(`  ✅ Updated agent/swoop/Cargo.toml → ${newVersion}`);
  console.log('     (Cargo.lock and package-lock.json follow on the next build/install)');

  if (updateDocVersion(DOC_FILES.readme, newVersion, oldVersion)) {
    console.log(`  ✅ Updated README.md → ${newVersion}`);
  }

  if (updateDocVersion(DOC_FILES.claudemd, newVersion, oldVersion)) {
    console.log(`  ✅ Updated .claude/CLAUDE.md → ${newVersion}`);
  }

  if (updateDocVersion(DOC_FILES.versionMgmt, newVersion, oldVersion)) {
    console.log(`  ✅ Updated docs/internal/version-management.md → ${newVersion}`);
  }

  console.log('\n✨ All versions synced!\n');
  console.log('⚠️  Remember to:');
  console.log('   1. Update docs/changelog.md with release notes');
  console.log('   2. Commit changes: git commit -am "chore: Bump version to ' + newVersion + '"');
  console.log('   3. Create tag: git tag v' + newVersion);
  console.log('   4. Push with tags: git push origin main --tags\n');
  // Printed, not run: a bump has no installer to photograph yet, and this
  // script edits version files and nothing else.
  console.log('   After building the installer: cd web && npm run screenshots:desktop');
  console.log('   (refreshes the agent docs screenshots from the shipping desktop app)\n');
}

const args = process.argv.slice(2);

if (args.length === 0) {
  showVersions();
} else if (args.length === 1) {
  syncVersions(args[0]);
} else {
  console.error('Usage: node scripts/sync-versions.js [new-version]');
  process.exit(1);
}
