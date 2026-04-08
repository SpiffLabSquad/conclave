#!/usr/bin/env node

import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createDirLink } from '../setup/lib/fs-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const command = process.argv[2];
const args = process.argv.slice(3);

import { MANAGED_PATHS, isManaged } from './managed-paths.js';

// Files that must never be scaffolded directly (use .template suffix instead).
const EXCLUDED_FILENAMES = ['CLAUDE.md'];

// Files ending in .template are scaffolded with the suffix stripped.
// e.g. .gitignore.template → .gitignore, CLAUDE.md.template → CLAUDE.md
function destPath(templateRelPath) {
  if (templateRelPath.endsWith('.template')) {
    return templateRelPath.slice(0, -'.template'.length);
  }
  return templateRelPath;
}

function templatePath(userPath, templatesDir) {
  const withSuffix = userPath + '.template';
  if (fs.existsSync(path.join(templatesDir, withSuffix))) {
    return withSuffix;
  }
  return userPath;
}

/**
 * Parse upgrade target from CLI arg into an npm install specifier.
 * Examples: undefined → "latest", "@beta" → "beta", "@rc" → "rc", "1.2.72" → "1.2.72"
 */
function parseUpgradeTarget(arg) {
  if (!arg) return 'latest';
  if (arg.startsWith('@')) return arg.slice(1); // @beta → beta, @rc → rc, @latest → latest
  return arg; // bare version like 1.2.72
}

function printUsage() {
  console.log(`
Usage: thepopebot <command>

Commands:
  init                              Scaffold a new thepopebot project
  upgrade|update [@beta|version]    Upgrade thepopebot (install, init, build, commit, push)
  setup                             Run interactive setup wizard
  setup-ssl                         Configure SSL with Let's Encrypt wildcard cert
  setup-telegram                    Reconfigure Telegram webhook
  reset-auth                        Regenerate AUTH_SECRET (invalidates all sessions)
  reset [file]                      Restore a template file (or list available templates)
  reset-all                         Nuclear reset — restore entire project to fresh init state
  audit                             Show project state vs. package templates (modified/missing/unknown)
  diff [file]                       Show differences between project files and package templates
  sync <path>                       Sync local package to a test install (build, pack, Docker)
  sync --fast <path>                Fast sync — copy source into running container, rebuild .next
  set-var <KEY> [VALUE]             Set a GitHub repository variable
  user:password <email>             Change a user's password

Conclave (multi-node fork):
  node add <name> [opts]            Register a remote worker node. Prints token (shown ONCE).
                                    Opts: --runtimes a,b,c  --labels a,b,c  --capacity N  --os <darwin|linux|win32>
  node list                         List all registered nodes
  node revoke <id|name>             Delete a node (revokes its token)
`);
}

// --- conclave node commands ---------------------------------------------

function parseNodeFlags(rest) {
  const out = { runtimes: ['claude-cli'], labels: [], capacity: 1, os: undefined };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i];
    if (a === '--runtimes') out.runtimes = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--labels') out.labels = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--capacity') out.capacity = parseInt(next(), 10) || 1;
    else if (a === '--os') out.os = next();
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

async function nodeCommand(sub, rest) {
  // Defer the import so we don't pay DB init cost on unrelated CLI invocations.
  const { createNode, listNodes, getNodeById, deleteNode } = await import('thepopebot/db/nodes');

  switch (sub) {
    case 'add': {
      const name = rest[0];
      if (!name) {
        console.error('usage: conclave node add <name> [--runtimes a,b] [--labels a,b] [--capacity N] [--os darwin|linux|win32]');
        process.exit(1);
      }
      const opts = parseNodeFlags(rest.slice(1));
      const created = createNode({ name, ...opts });
      console.log('\n  Node registered.\n');
      console.log(`    id:        ${created.id}`);
      console.log(`    name:      ${created.name}`);
      console.log(`    runtimes:  ${opts.runtimes.join(',')}`);
      console.log(`    labels:    ${opts.labels.join(',') || '(none)'}`);
      console.log(`    capacity:  ${opts.capacity}`);
      console.log(`\n  Bearer token (shown ONCE — copy now into ~/.conclave/node.json on the worker):\n`);
      console.log(`    ${created.token}\n`);
      return;
    }

    case 'list': {
      const rows = listNodes();
      if (rows.length === 0) { console.log('  (no nodes registered)'); return; }
      const fmt = (n) => {
        const seen = n.lastSeen ? new Date(n.lastSeen).toISOString() : '-';
        return `  ${n.id}  ${n.name.padEnd(20)} ${n.status.padEnd(8)} runtimes=${(n.runtimes||[]).join(',')} labels=${(n.labels||[]).join(',') || '-'} cap=${n.capacity} lastSeen=${seen}`;
      };
      console.log('');
      for (const r of rows) console.log(fmt(r));
      console.log('');
      return;
    }

    case 'revoke': {
      const target = rest[0];
      if (!target) { console.error('usage: conclave node revoke <id|name>'); process.exit(1); }
      // Accept either an exact id or a name match.
      let id = null;
      if (getNodeById(target)) {
        id = target;
      } else {
        const match = listNodes().find((n) => n.name === target);
        if (match) id = match.id;
      }
      if (!id) { console.error(`  no node found matching: ${target}`); process.exit(1); }
      deleteNode(id);
      console.log(`  revoked ${id}`);
      return;
    }

    default:
      console.error('usage: conclave node <add|list|revoke> ...');
      process.exit(1);
  }
}

/**
 * Collect all template files as relative paths.
 */
function getTemplateFiles(templatesDir) {
  const files = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (!EXCLUDED_FILENAMES.includes(entry.name)) {
        files.push(path.relative(templatesDir, fullPath));
      }
    }
  }
  walk(templatesDir);
  return files;
}

async function init() {
  let cwd = process.cwd();
  const packageDir = path.join(__dirname, '..');
  const templatesDir = path.join(packageDir, 'templates');
  const noManaged = args.includes('--no-managed');
  const noInstall = args.includes('--no-install');

  // Guard: warn if the directory is not empty (unless it's an existing thepopebot project)
  const entries = fs.readdirSync(cwd);
  if (entries.length > 0) {
    const pkgPath = path.join(cwd, 'package.json');
    let isExistingProject = false;
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = pkg.dependencies || {};
        const devDeps = pkg.devDependencies || {};
        if (deps.thepopebot || devDeps.thepopebot) {
          isExistingProject = true;
        }
      } catch {}
    }

    if (!isExistingProject) {
      console.log('\nThis directory is not empty.');
      const { text, isCancel } = await import('@clack/prompts');
      const dirName = await text({
        message: 'Project directory name:',
        defaultValue: 'my-popebot',
      });
      if (isCancel(dirName)) {
        console.log('\nCancelled.\n');
        process.exit(0);
      }
      const newDir = path.resolve(cwd, dirName);
      fs.mkdirSync(newDir, { recursive: true });
      process.chdir(newDir);
      cwd = newDir;
      console.log(`\nCreated ${dirName}/`);
    }
  }

  console.log('\nScaffolding thepopebot project...\n');

  const templateFiles = getTemplateFiles(templatesDir);
  const created = [];
  const skipped = [];
  const changed = [];
  const updated = [];
  const backedUp = [];

  let backupDir = null;
  function getBackupDir() {
    if (!backupDir) {
      const now = new Date();
      const ts = now.getFullYear().toString()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
        + '-'
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');
      backupDir = path.join(cwd, '.backups', ts);
    }
    return backupDir;
  }

  function backupFile(filePath, relPath) {
    const bd = getBackupDir();
    const dest = path.join(bd, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(filePath, dest);
    backedUp.push(relPath);
  }

  for (const relPath of templateFiles) {
    const src = path.join(templatesDir, relPath);
    const outPath = destPath(relPath);
    const dest = path.join(cwd, outPath);

    if (!fs.existsSync(dest)) {
      // File doesn't exist — create it
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      created.push(outPath);
      console.log(`  Created ${outPath}`);
    } else {
      // File exists — check if template has changed
      const srcContent = fs.readFileSync(src);
      const destContent = fs.readFileSync(dest);
      if (srcContent.equals(destContent)) {
        skipped.push(outPath);
      } else if (!noManaged && isManaged(outPath)) {
        // Managed file differs — back up before overwriting
        backupFile(dest, outPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        updated.push(outPath);
        console.log(`  Updated ${outPath}`);
      } else {
        changed.push(outPath);
        console.log(`  Skipped ${outPath} (already exists)`);
      }
    }
  }

  // Delete stale files in managed directories that no longer exist in templates
  if (!noManaged) {
    const deleted = [];
    const managedDirs = MANAGED_PATHS.filter(p => p.endsWith('/'));
    for (const managedDir of managedDirs) {
      const userDir = path.join(cwd, managedDir);
      if (!fs.existsSync(userDir)) continue;

      // Walk the user's managed directory
      function walkUser(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkUser(fullPath);
          } else {
            const relPath = path.relative(cwd, fullPath);
            // Check if a corresponding template exists
            const tmplPath = templatePath(relPath, templatesDir);
            const templateExists = fs.existsSync(path.join(templatesDir, tmplPath));
            if (!templateExists) {
              const bd = getBackupDir();
              const dest = path.join(bd, relPath);
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.renameSync(fullPath, dest);
              backedUp.push(relPath);
              deleted.push(relPath);
              console.log(`  Removed ${relPath} (stale managed file)`);
            }
          }
        }
      }
      walkUser(userDir);

      // Remove empty directories left behind
      function removeEmptyDirs(dir) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            removeEmptyDirs(path.join(dir, entry.name));
          }
        }
        // Re-read after potential child removals
        if (fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
        }
      }
      removeEmptyDirs(userDir);
    }
  }

  // Create package.json if it doesn't exist
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    const dirName = path.basename(cwd);
    const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const thepopebotDep = version.includes('-') ? version : '^1.0.0';
    const pkg = {
      name: dirName,
      private: true,
      type: 'module',
      scripts: {
        setup: 'thepopebot setup',
        'setup-telegram': 'thepopebot setup-telegram',
        'reset-auth': 'thepopebot reset-auth',
      },
      dependencies: {
        thepopebot: thepopebotDep,
      },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('  Created package.json');
  } else {
    // Ensure "type": "module" is set for ESM support
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.type) {
      pkg.type = 'module';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log('  Added "type": "module" to package.json');
    } else {
      console.log('  Skipped package.json (already exists)');
    }
  }

  // Create default skill activation symlinks
  const defaultSkills = [];
  const activeDir = path.join(cwd, 'skills', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  for (const skill of defaultSkills) {
    const symlink = path.join(activeDir, skill);
    if (!fs.existsSync(symlink)) {
      createDirLink(`../library/${skill}`, symlink);
      console.log(`  Created skills/active/${skill} → ../library/${skill}`);
    }
  }

  // Create .pi/skills → ../skills/active symlink
  const piSkillsLink = path.join(cwd, '.pi', 'skills');
  if (!fs.existsSync(piSkillsLink)) {
    fs.mkdirSync(path.dirname(piSkillsLink), { recursive: true });
    createDirLink('../skills/active', piSkillsLink);
    console.log('  Created .pi/skills → ../skills/active');
  }

  // Create .claude/skills → ../skills/active symlink
  const claudeSkillsLink = path.join(cwd, '.claude', 'skills');
  if (!fs.existsSync(claudeSkillsLink)) {
    fs.mkdirSync(path.dirname(claudeSkillsLink), { recursive: true });
    createDirLink('../skills/active', claudeSkillsLink);
    console.log('  Created .claude/skills → ../skills/active');
  }

  // Report backed-up files
  if (backedUp.length > 0) {
    console.log(`\n  Backed up ${backedUp.length} file(s) to ${path.relative(cwd, backupDir)}/`);
  }

  // Report updated managed files
  if (updated.length > 0) {
    console.log('\n  Updated managed files:');
    for (const file of updated) {
      console.log(`    ${file}`);
    }
  }

  // Report changed templates
  if (changed.length > 0) {
    console.log('\n  Updated templates available:');
    console.log('  These files differ from the current package templates.');
    console.log('  This may be from your edits, or from a thepopebot update.\n');
    for (const file of changed) {
      console.log(`    ${file}`);
    }
    console.log('\n  To view differences:  npx thepopebot diff <file>');
    console.log('  To reset to default:  npx thepopebot reset <file>');
  }

  // Run npm install to ensure lock file reflects installed dependencies
  if (!noInstall) {
    console.log('\nInstalling dependencies...\n');
    execSync('npm install', { stdio: 'inherit', cwd });
  }

  // Create or update .env with auto-generated infrastructure values
  const envPath = path.join(cwd, '.env');
  const { randomBytes } = await import('crypto');
  const thepopebotPkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const version = thepopebotPkg.version;

  if (!fs.existsSync(envPath)) {
    // Seed .env for new projects
    const authSecret = randomBytes(32).toString('base64');
    const seedEnv = `# thepopebot Configuration
# Run "npm run setup" to complete configuration

AUTH_SECRET=${authSecret}
AUTH_TRUST_HOST=true
DATABASE_PATH=data/db/thepopebot.sqlite
THEPOPEBOT_VERSION=${version}

# To enable SSL with Let's Encrypt, run: npx thepopebot setup-ssl
# COMPOSE_FILE=docker-compose.custom.yml
`;
    fs.writeFileSync(envPath, seedEnv);
    console.log(`  Created .env (AUTH_SECRET, THEPOPEBOT_VERSION=${version})`);
  } else {
    // Update THEPOPEBOT_VERSION in existing .env
    try {
      let envContent = fs.readFileSync(envPath, 'utf8');
      if (envContent.match(/^THEPOPEBOT_VERSION=.*/m)) {
        envContent = envContent.replace(/^THEPOPEBOT_VERSION=.*/m, `THEPOPEBOT_VERSION=${version}`);
      } else {
        envContent = envContent.trimEnd() + `\nTHEPOPEBOT_VERSION=${version}\n`;
      }
      fs.writeFileSync(envPath, envContent);
      console.log(`  Updated THEPOPEBOT_VERSION to ${version}`);
    } catch {}
  }

  console.log('\nDone! Run: npm run setup\n');
}

/**
 * Create a timestamped backup directory and return { dir, ts }.
 */
function createBackupDir(cwd) {
  const now = new Date();
  const ts = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + '-'
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');
  return { dir: path.join(cwd, '.backups', ts), ts };
}

/**
 * Move a file or symlink to the backup directory.
 */
function backupAndRemove(fullPath, relPath, backupDir) {
  const dest = path.join(backupDir, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.lstatSync(fullPath).isSymbolicLink()) {
    const target = fs.readlinkSync(fullPath);
    fs.symlinkSync(target, dest);
    fs.unlinkSync(fullPath);
  } else {
    fs.renameSync(fullPath, dest);
  }
}

/**
 * List all available template files, or restore a specific one.
 */
function reset(filePath) {
  const packageDir = path.join(__dirname, '..');
  const templatesDir = path.join(packageDir, 'templates');
  const cwd = process.cwd();

  if (!filePath) {
    console.log('\nAvailable template files:\n');
    const files = getTemplateFiles(templatesDir);
    for (const file of files) {
      console.log(`  ${destPath(file)}`);
    }
    console.log('\nUsage: thepopebot reset <file>');
    console.log('Example: thepopebot reset agent-job/SOUL.md\n');
    return;
  }

  const tmplPath = templatePath(filePath, templatesDir);
  const src = path.join(templatesDir, tmplPath);
  const dest = path.join(cwd, filePath);

  if (!fs.existsSync(src)) {
    console.error(`\nTemplate not found: ${filePath}`);
    console.log('Run "thepopebot reset" to see available templates.\n');
    process.exit(1);
  }

  // Back up existing file before overwriting
  if (fs.existsSync(dest)) {
    const { dir, ts } = createBackupDir(cwd);
    if (fs.statSync(src).isDirectory()) {
      // Back up all files in the directory
      function walkBackup(d) {
        const items = fs.readdirSync(d, { withFileTypes: true });
        for (const item of items) {
          const full = path.join(d, item.name);
          const rel = path.relative(cwd, full);
          if (item.isDirectory()) {
            walkBackup(full);
          } else {
            backupAndRemove(full, rel, dir);
          }
        }
      }
      walkBackup(dest);
      console.log(`\n  Backed up to .backups/${ts}/`);
    } else {
      backupAndRemove(dest, filePath, dir);
      console.log(`\n  Backed up to .backups/${ts}/${filePath}`);
    }
  }

  if (fs.statSync(src).isDirectory()) {
    console.log(`\nRestoring ${filePath}/...\n`);
    copyDirSyncForce(src, dest, tmplPath);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`Restored ${filePath}\n`);
  }
}

/**
 * Show the diff between a user's file and the package template.
 */
function diff(filePath) {
  const packageDir = path.join(__dirname, '..');
  const templatesDir = path.join(packageDir, 'templates');
  const cwd = process.cwd();

  if (!filePath) {
    // Show all files that differ
    console.log('\nFiles that differ from package templates:\n');
    const files = getTemplateFiles(templatesDir);
    let anyDiff = false;
    for (const file of files) {
      const src = path.join(templatesDir, file);
      const outPath = destPath(file);
      const dest = path.join(cwd, outPath);
      if (fs.existsSync(dest)) {
        const srcContent = fs.readFileSync(src);
        const destContent = fs.readFileSync(dest);
        if (!srcContent.equals(destContent)) {
          console.log(`  ${outPath}`);
          anyDiff = true;
        }
      } else {
        console.log(`  ${outPath} (missing)`);
        anyDiff = true;
      }
    }
    if (!anyDiff) {
      console.log('  All files match package templates.');
    }
    console.log('\nUsage: thepopebot diff <file>');
    console.log('Example: thepopebot diff agent-job/SOUL.md\n');
    return;
  }

  const tmplPath = templatePath(filePath, templatesDir);
  const src = path.join(templatesDir, tmplPath);
  const dest = path.join(cwd, filePath);

  if (!fs.existsSync(src)) {
    console.error(`\nTemplate not found: ${filePath}`);
    process.exit(1);
  }

  if (!fs.existsSync(dest)) {
    console.log(`\n${filePath} does not exist in your project.`);
    console.log(`Run "thepopebot reset ${filePath}" to create it.\n`);
    return;
  }

  try {
    // Use git diff for nice colored output, fall back to plain diff
    execSync(`git diff --no-index -- "${dest}" "${src}"`, { stdio: 'inherit' });
    console.log('\nFiles are identical.\n');
  } catch (e) {
    // git diff exits with 1 when files differ (output already printed)
    console.log(`\n  To reset: thepopebot reset ${filePath}\n`);
  }
}

/**
 * Audit project state against package templates.
 * Groups all non-protected files into: matching, modified, missing, unknown.
 */
function audit() {
  const packageDir = path.join(__dirname, '..');
  const templatesDir = path.join(packageDir, 'templates');
  const cwd = process.cwd();

  const templateFiles = getTemplateFiles(templatesDir);
  const matching = [];
  const modified = [];
  const missing = [];

  // Check every template file against the project
  for (const relPath of templateFiles) {
    const src = path.join(templatesDir, relPath);
    const outPath = destPath(relPath);
    const dest = path.join(cwd, outPath);

    if (!fs.existsSync(dest)) {
      missing.push(outPath);
    } else {
      const srcContent = fs.readFileSync(src);
      const destContent = fs.readFileSync(dest);
      if (srcContent.equals(destContent)) {
        matching.push(outPath);
      } else {
        modified.push(outPath);
      }
    }
  }

  // Build a set of known template dest paths for lookup
  const templateDestPaths = new Set(templateFiles.map(f => destPath(f)));

  // Walk the project for unknown files (not in templates, not protected)
  const unknown = [];
  function walkProject(dir) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const relPath = path.relative(cwd, fullPath);
      if (isProtected(relPath)) continue;
      if (item.isDirectory() && !item.isSymbolicLink()) {
        walkProject(fullPath);
      } else if (!templateDestPaths.has(relPath)) {
        unknown.push(relPath);
      }
    }
  }
  walkProject(cwd);

  // Report
  console.log('\n  Project audit\n');

  if (modified.length > 0) {
    console.log(`  Modified (${modified.length}) — template exists, your version differs:`);
    for (const f of modified) {
      console.log(`    ${f}`);
    }
    console.log('');
  }

  if (missing.length > 0) {
    console.log(`  Missing (${missing.length}) — template exists, not in your project:`);
    for (const f of missing) {
      console.log(`    ${f}`);
    }
    console.log('');
  }

  if (unknown.length > 0) {
    console.log(`  Unknown (${unknown.length}) — in your project, no template (reset-all would remove):`);
    for (const f of unknown) {
      console.log(`    ${f}`);
    }
    console.log('');
  }

  console.log(`  ${matching.length} file(s) match package templates.`);

  if (modified.length > 0 || missing.length > 0) {
    console.log('\n  To reset a file:     thepopebot reset <file>');
    console.log('  To view a diff:      thepopebot diff <file>');
  }
  if (unknown.length > 0 || modified.length > 0 || missing.length > 0) {
    console.log('  To reset everything: thepopebot reset-all');
  }
  console.log('');
}

function copyDirSyncForce(src, dest, templateRelBase = '') {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_FILENAMES.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const templateRel = templateRelBase
      ? path.join(templateRelBase, entry.name)
      : entry.name;
    const outName = path.basename(destPath(templateRel));
    const destFile = path.join(dest, outName);
    if (entry.isDirectory()) {
      copyDirSyncForce(srcPath, destFile, templateRel);
    } else {
      fs.copyFileSync(srcPath, destFile);
      console.log(`  Restored ${path.relative(process.cwd(), destFile)}`);
    }
  }
}

// Paths that reset-all must never touch (relative to project root).
// Entries ending with '/' are directory prefixes.
const PROTECTED_PATHS = [
  '.env',
  '.env.local',
  'data/',
  'logs/',
  '.git/',
  '.backups/',
  'package-lock.json',
  'package.json',
  'docker-compose.custom.yml',
  '.claude/',
  '.pi/',
  'skills/',
  'node_modules/',
];

function isProtected(relPath) {
  return PROTECTED_PATHS.some(p =>
    p.endsWith('/') ? relPath === p.slice(0, -1) || relPath.startsWith(p) : relPath === p
  );
}

async function resetAll() {
  const cwd = process.cwd();

  // Verify this is a thepopebot project
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error('\n  Not a thepopebot project (no package.json found).\n');
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.thepopebot) {
    console.error('\n  Not a thepopebot project (thepopebot not in dependencies).\n');
    process.exit(1);
  }

  // Dry run — collect all files that would be moved
  const filesToMove = [];
  function collectFiles(dir) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const relPath = path.relative(cwd, fullPath);
      if (isProtected(relPath)) continue;
      if (item.isDirectory() && !item.isSymbolicLink()) {
        collectFiles(fullPath);
      } else {
        filesToMove.push(relPath);
      }
    }
  }
  collectFiles(cwd);

  if (filesToMove.length === 0) {
    console.log('\n  Nothing to reset — no non-protected files found.\n');
    return;
  }

  const { confirm, isCancel } = await import('@clack/prompts');

  console.log('\n  This will reset your entire project to a fresh thepopebot init state.');
  console.log(`  ${filesToMove.length} file(s) will be moved to .backups/:\n`);
  for (const f of filesToMove) {
    console.log(`    ${f}`);
  }
  console.log('\n  Protected (will NOT be touched):');
  for (const p of PROTECTED_PATHS) {
    console.log(`    ${p}`);
  }

  const ok = await confirm({ message: '\nAre you sure? This is the nuclear option.' });
  if (isCancel(ok) || !ok) {
    console.log('\n  Cancelled.\n');
    return;
  }

  // Move all files to backup
  const { dir: backupDir, ts } = createBackupDir(cwd);

  for (const relPath of filesToMove) {
    const fullPath = path.join(cwd, relPath);
    backupAndRemove(fullPath, relPath, backupDir);
  }

  // Remove empty directories left behind
  function removeEmptyDirs(dir) {
    if (!fs.existsSync(dir)) return;
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        removeEmptyDirs(path.join(dir, item.name));
      }
    }
    const relPath = path.relative(cwd, dir);
    if (relPath && !isProtected(relPath) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  }
  removeEmptyDirs(cwd);

  console.log(`\n  Moved ${filesToMove.length} file(s) to .backups/${ts}/`);

  // Run init to rebuild from templates
  console.log('\n  Running init to rebuild project...\n');
  try {
    execSync('npx thepopebot init --no-install', { stdio: 'inherit', cwd });
  } catch {
    console.error('\n  Init failed. Your backup is at .backups/' + ts + '/\n');
    process.exit(1);
  }

  // Run npm install separately
  console.log('\nInstalling dependencies...\n');
  try {
    execSync('npm install', { stdio: 'inherit', cwd });
  } catch {
    console.error('\n  npm install failed. Your backup is at .backups/' + ts + '/\n');
    process.exit(1);
  }

  console.log('\n  Reset complete. Project restored to fresh init state.');
  console.log(`  Backup: .backups/${ts}/\n`);
}

function setup() {
  const setupScript = path.join(__dirname, '..', 'setup', 'setup.mjs');
  try {
    execFileSync(process.execPath, [setupScript], { stdio: 'inherit', cwd: process.cwd() });
  } catch {
    process.exit(1);
  }
}

function setupSsl() {
  const setupScript = path.join(__dirname, '..', 'setup', 'setup-ssl.mjs');
  try {
    execFileSync(process.execPath, [setupScript], { stdio: 'inherit', cwd: process.cwd() });
  } catch {
    process.exit(1);
  }
}

function setupTelegram() {
  const setupScript = path.join(__dirname, '..', 'setup', 'setup-telegram.mjs');
  try {
    execFileSync(process.execPath, [setupScript], { stdio: 'inherit', cwd: process.cwd() });
  } catch {
    process.exit(1);
  }
}

async function resetAuth() {
  const { randomBytes } = await import('crypto');
  const { updateEnvVariable } = await import(path.join(__dirname, '..', 'setup', 'lib', 'auth.mjs'));

  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.error('\n  No .env file found. Run "npm run setup" first.\n');
    process.exit(1);
  }

  const newSecret = randomBytes(32).toString('base64');
  updateEnvVariable('AUTH_SECRET', newSecret);
  console.log('\n  AUTH_SECRET regenerated.');
  console.log('  All existing sessions have been invalidated.');
  console.log('  Restart your server for the change to take effect.\n');
}

async function upgrade() {
  const cwd = process.cwd();
  const tag = parseUpgradeTarget(args[0]);
  const { confirm, isCancel } = await import('@clack/prompts');

  // --- Pre-flight: verify this is a thepopebot project ---
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error('\n  Not a thepopebot project (no package.json found).\n');
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.thepopebot) {
    console.error('\n  Not a thepopebot project (thepopebot not in dependencies).\n');
    process.exit(1);
  }

  // Get current installed version
  let currentVersion;
  try {
    const installedPkg = path.join(cwd, 'node_modules', 'thepopebot', 'package.json');
    currentVersion = JSON.parse(fs.readFileSync(installedPkg, 'utf8')).version;
  } catch {
    currentVersion = 'unknown';
  }

  // Resolve target version
  let targetVersion;
  try {
    targetVersion = execSync(`npm view thepopebot@${tag} version`, { encoding: 'utf8' }).trim();
  } catch {
    console.error(`\n  Could not resolve thepopebot@${tag}. Check the version/tag and try again.\n`);
    process.exit(1);
  }

  console.log(`\n  thepopebot ${currentVersion} → ${targetVersion}`);

  if (currentVersion === targetVersion) {
    console.log('  Already up to date. Nothing to do.\n');
    return;
  }

  // --- Save any local changes ---
  const status = execSync('git status --porcelain', { encoding: 'utf8', cwd }).trim();
  if (status) {
    console.log('\n  You have local changes. Saving them before upgrading...\n');
    try {
      execSync('git add -A && git commit -m "save local changes before thepopebot upgrade"', { stdio: 'inherit', cwd });
    } catch {
      console.error('\n  Could not save your local changes. Please try again.\n');
      return;
    }
  }

  // --- Pull remote changes ---
  console.log('\n  Syncing with remote...\n');
  try {
    execSync('git pull --rebase', { stdio: 'inherit', cwd });
  } catch {
    console.error('\n  Your local changes conflict with changes on GitHub.');
    console.error('  This means someone (or your bot) changed the same files you did.\n');
    console.error('  To fix this:');
    console.error('    1. Open the files listed above and look for <<<<<<< markers');
    console.error('    2. Edit each file to keep the version you want');
    console.error('    3. Run: git add -A && git rebase --continue');
    console.error('    4. Then run the upgrade again\n');
    return;
  }

  // --- Install ---
  console.log(`\n  Installing thepopebot@${targetVersion}...\n`);
  try {
    execSync(`npm install thepopebot@${targetVersion}`, { stdio: 'inherit', cwd });
  } catch {
    console.error('\n  Install failed. Check your internet connection and try again.\n');
    process.exit(1);
  }

  // --- Init (spawn new process to use the NEW version's templates) ---
  console.log('\n  Updating project files...\n');
  try {
    execSync('npx thepopebot init', { stdio: 'inherit', cwd });
  } catch {
    console.error('\n  Failed to update project files. Try running "npx thepopebot init" manually.\n');
    process.exit(1);
  }

  // --- Commit upgrade ---
  const changes = execSync('git status --porcelain', { encoding: 'utf8', cwd }).trim();
  if (changes) {
    try {
      execSync('git add -A', { cwd });
      execSync(`git commit -m "upgrade thepopebot to ${targetVersion}"`, { stdio: 'inherit', cwd });
    } catch {
      console.error('\n  Failed to commit upgrade. Try running manually:');
      console.error(`    git add -A && git commit -m "upgrade thepopebot to ${targetVersion}"\n`);
      process.exit(1);
    }
  }

  // --- Push ---
  console.log('\n  Pushing to GitHub...\n');
  try {
    execSync('git push', { stdio: 'inherit', cwd });
  } catch {
    console.error('\n  Could not push to GitHub. Try running "git push" manually.\n');
    process.exit(1);
  }

  // --- Docker restart (only if compose file exists, docker available, and containers running) ---
  const composeFile = path.join(cwd, 'docker-compose.yml');
  if (fs.existsSync(composeFile)) {
    try {
      const running = execSync('docker compose ps --status running -q', { encoding: 'utf8', cwd }).trim();
      if (running) {
        console.log('  Pulling new image and restarting Docker containers...\n');
        execSync('docker compose pull event-handler && docker compose up -d --force-recreate event-handler', { stdio: 'inherit', cwd });
      }
    } catch {
      // Docker not available or not running — skip
    }
  }

  // --- Summary ---
  console.log(`\n  Upgraded thepopebot ${currentVersion} → ${targetVersion}`);
  console.log('  Done!\n');
}

/**
 * Load GH_OWNER and GH_REPO from .env
 */
function loadRepoInfo() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.error('\n  No .env file found. Run "npm run setup" first.\n');
    process.exit(1);
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) env[match[1].trim()] = match[2].trim();
  }
  if (!env.GH_OWNER || !env.GH_REPO) {
    console.error('\n  GH_OWNER and GH_REPO not found in .env. Run "npm run setup" first.\n');
    process.exit(1);
  }
  return { owner: env.GH_OWNER, repo: env.GH_REPO };
}

/**
 * Read all data from a piped stdin stream.
 * Returns null if stdin is a TTY (interactive terminal).
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trimEnd() || null));
    process.stdin.on('error', reject);
  });
}

/**
 * Prompt for a secret value interactively if not provided as an argument.
 * Supports piped stdin (e.g. echo "val" | thepopebot set-var KEY).
 */
async function promptForValue(key) {
  const stdin = await readStdin();
  if (stdin) return stdin;

  if (!process.stdin.isTTY) {
    console.error(`\n  No value provided for ${key}. Pipe a value or pass it as an argument.\n`);
    process.exit(1);
  }

  const { password, isCancel } = await import('@clack/prompts');
  const value = await password({
    message: `Enter value for ${key}:`,
    validate: (input) => {
      if (!input) return 'Value is required';
    },
  });
  if (isCancel(value)) {
    console.log('\nCancelled.\n');
    process.exit(0);
  }
  return value;
}

async function setVar(key, value) {
  if (!key) {
    console.error('\n  Usage: thepopebot set-var <KEY> [VALUE]\n');
    console.error('  Example: thepopebot set-var LLM_MODEL claude-sonnet-4-5-20250929\n');
    process.exit(1);
  }

  if (!value) value = await promptForValue(key);

  const { owner, repo } = loadRepoInfo();

  const { setVariable } = await import(path.join(__dirname, '..', 'setup', 'lib', 'github.mjs'));

  const result = await setVariable(owner, repo, key, value);
  if (result.success) {
    console.log(`\n  Set GitHub variable: ${key}\n`);
  } else {
    console.error(`\n  Failed to set ${key}: ${result.error}\n`);
    process.exit(1);
  }
}

async function userPassword(email) {
  if (!email) {
    console.error('\n  Usage: thepopebot user:password <email>\n');
    process.exit(1);
  }

  const { password, isCancel } = await import('@clack/prompts');
  const newPassword = await password({
    message: 'New password:',
    validate: (input) => {
      if (!input) return 'Password is required';
      if (input.length < 8) return 'Password must be at least 8 characters';
    },
  });
  if (isCancel(newPassword)) {
    console.log('\nCancelled.\n');
    process.exit(0);
  }

  const { initDatabase } = await import('../lib/db/index.js');
  initDatabase();
  const { updateUserPassword } = await import('../lib/db/users.js');

  const updated = updateUserPassword(email, newPassword);
  if (updated) {
    console.log(`\n  Password updated for ${email}.\n`);
  } else {
    console.error(`\n  No user found with email: ${email}\n`);
    process.exit(1);
  }
}

switch (command) {
  case 'init':
    await init();
    break;
  case 'setup':
    setup();
    break;
  case 'setup-ssl':
    setupSsl();
    break;
  case 'setup-telegram':
    setupTelegram();
    break;
  case 'reset-auth':
    await resetAuth();
    break;
  case 'reset':
    reset(args[0]);
    break;
  case 'reset-all':
    await resetAll();
    break;
  case 'audit':
    audit();
    break;
  case 'diff':
    diff(args[0]);
    break;
  case 'upgrade':
  case 'update':
    await upgrade();
    break;
  case 'sync': {
    const fast = args.includes('--fast');
    const syncArgs = args.filter(a => a !== '--fast');
    if (fast) {
      const { syncFast } = await import('./sync.js');
      await syncFast(syncArgs[0]);
    } else {
      const { sync } = await import('./sync.js');
      await sync(syncArgs[0]);
    }
    break;
  }
  case 'set-var':
    await setVar(args[0], args[1]);
    break;
  case 'user:password':
    await userPassword(args[0]);
    break;
  case 'node':
    await nodeCommand(args[0], args.slice(1));
    break;
  default:
    printUsage();
    process.exit(command ? 1 : 0);
}
