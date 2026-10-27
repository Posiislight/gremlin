#!/usr/bin/env node
// Validates the Gremlin plugin shape (spec section 4). Usage: node validate.mjs [pluginDir]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
const errors = [];
const err = (m) => errors.push(m);

function readJson(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return err(`missing ${rel}`);
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    err(`${rel}: invalid JSON (${e.message})`);
  }
}

const manifest = readJson('.cursor-plugin/plugin.json');
if (manifest) {
  for (const k of ['name', 'displayName', 'version', 'description', 'homepage', 'repository', 'license', 'category']) {
    if (typeof manifest[k] !== 'string' || !manifest[k].trim()) err(`plugin.json: "${k}" must be a non-empty string`);
  }
  if (manifest.author == null || (typeof manifest.author !== 'object' && typeof manifest.author !== 'string')) {
    err('plugin.json: "author" is required');
  }
  if (typeof manifest.name === 'string' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name)) {
    err('plugin.json: name must be kebab-case');
  }
  if (typeof manifest.version === 'string' && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    err('plugin.json: version must be semver');
  }
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
    err('plugin.json: keywords must be a non-empty array');
  }
  if (manifest.mcpServers !== './mcp.json') err('plugin.json: mcpServers must be "./mcp.json"');
  if (manifest.skills !== './skills/') err('plugin.json: skills must be "./skills/"');
}

const mcp = readJson('mcp.json');
if (mcp) {
  const servers = mcp.mcpServers;
  if (!servers || typeof servers !== 'object' || Object.keys(servers).length === 0) {
    err('mcp.json: mcpServers must be a non-empty object');
  }
  for (const [name, s] of Object.entries(servers ?? {})) {
    if (s.type !== 'http') err(`mcp.json: ${name}: type must be "http" (remote servers only, no stdio)`);
    if ('command' in s || 'args' in s) err(`mcp.json: ${name}: stdio fields not allowed`);
    if (typeof s.url !== 'string') {
      err(`mcp.json: ${name}: url required`);
    } else {
      if (!/^https:\/\//.test(s.url) && !/^\$\{[A-Z0-9_]+\}/.test(s.url)) {
        err(`mcp.json: ${name}: url must be https or start with an env placeholder`);
      }
      if (!s.url.endsWith('/mcp')) err(`mcp.json: ${name}: url must end with /mcp`);
      const concrete = s.url.replace(/\$\{[A-Z0-9_]+\}/g, 'https://x.example.com');
      try {
        new URL(concrete.startsWith('https://') ? concrete : `https://${concrete}`);
      } catch {
        err(`mcp.json: ${name}: url is not a valid URL`);
      }
    }
    const auth = s.headers?.Authorization;
    if (typeof auth !== 'string' || !/\$\{[A-Z0-9_]+\}/.test(auth)) {
      err(`mcp.json: ${name}: headers.Authorization must use an env placeholder`);
    }
    for (const [h, v] of Object.entries(s.headers ?? {})) {
      if (typeof v === 'string' && /grm_[A-Za-z0-9]{8,}/.test(v)) err(`mcp.json: ${name}: header ${h} contains a literal API key`);
    }
  }
}

const skillsDir = join(root, 'skills');
if (!existsSync(skillsDir)) {
  err('missing skills/');
} else {
  const dirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
  for (const required of ['gremlin-qa', 'gremlin-fix']) {
    if (!dirs.includes(required)) err(`skills/${required} missing`);
  }
  for (const d of dirs) {
    const f = join(skillsDir, d, 'SKILL.md');
    if (!existsSync(f)) {
      err(`skills/${d}/SKILL.md missing`);
      continue;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(readFileSync(f, 'utf8'));
    if (!m) {
      err(`skills/${d}/SKILL.md: missing YAML frontmatter`);
      continue;
    }
    const fm = Object.fromEntries(
      m[1]
        .split(/\r?\n/)
        .map((l) => /^([A-Za-z_-]+):\s*(.*)$/.exec(l))
        .filter(Boolean)
        .map((x) => [x[1], x[2].trim()]),
    );
    if (fm.name !== d) err(`skills/${d}/SKILL.md: frontmatter name "${fm.name}" must equal directory name`);
    if (!fm.description || fm.description.length < 20) {
      err(`skills/${d}/SKILL.md: description must say when to use the skill (>= 20 chars)`);
    }
    if (!m[2].trim()) err(`skills/${d}/SKILL.md: empty body`);
    if (d === 'gremlin-qa' && !/get_playbook/.test(m[2])) err('gremlin-qa must instruct calling get_playbook first');
    if (d === 'gremlin-fix' && !/verify_fix/.test(m[2])) err('gremlin-fix must reference verify_fix');
  }
}

if (!existsSync(join(root, 'README.md'))) err('missing README.md');

if (errors.length) {
  console.error(`gremlin plugin: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('gremlin plugin: OK');
