// 只用 api.github.com 把本地仓库发布到 GitHub —— 绕开时通时断的 github.com。
//
// 为什么需要它：本机 github.com（网页/OAuth）经常超时，而 api.github.com 稳定。
// 建仓库、传文件、建提交、设 topics 都可以走 REST API，不需要 git push，也不需要浏览器。
//
// 用法：
//   GH_TOKEN=<你的 PAT> node tools/publish-to-github.mjs            # 真发布
//   GH_TOKEN=<你的 PAT> node tools/publish-to-github.mjs --dry-run  # 只打印将要发生的事
//
// PAT 需要 repo 与 workflow 两个 scope（仓库里有 .github/workflows/verify.yml，
// 没有 workflow scope 时 GitHub 会拒绝写入 workflow 文件）。
// 先把仓库里所有文件读成 blob、建 tree、建一个 commit，再把 main 指过去；
// 已存在的仓库不会重复创建，只在 main 上追加一次提交。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OWNER = 'QIN-SMART';
const REPO = 'dsh-session-md';
const DESCRIPTION = 'DeepSeek Harness plugin: export a session as human-readable Markdown or a self-contained HTML page — full / handoff / readable / audit presets, one-click download';
const TOPICS = ['deepseek-harness', 'dsh', 'dsh-plugin', 'markdown', 'export', 'session', 'html'];
const DRY = process.argv.includes('--dry-run');
// --release[=vX.Y.Z]：顺带打 tag 并建 GitHub Release（默认取 package.json 的 version）
const releaseArg = process.argv.find((a) => a === '--release' || a.startsWith('--release='));
const FORCE_TAG = process.argv.includes('--force-tag');
const RELEASE_TAG = releaseArg && releaseArg.includes('=')
  ? releaseArg.split('=')[1]
  : (releaseArg ? `v${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}` : null);
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

const SKIP = new Set(['.git', '.tmp', 'node_modules', '.DS_Store', 'exports']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    if (name.startsWith('.') && name !== '.github' && name !== '.gitignore') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'user-agent': 'dsh-session-md-publish',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const hint = res.status === 403
      ? '  ← 多半是 PAT 少了 workflow scope（仓库含 .github/workflows/verify.yml）'
      : '';
    const err = new Error(`${method} ${path} -> ${res.status} ${typeof json === 'object' ? JSON.stringify(json).slice(0, 300) : String(json).slice(0, 300)}${hint}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const files = walk(ROOT).sort();
console.log(`仓库根: ${ROOT}`);
console.log(`将发布 ${files.length} 个文件到 ${OWNER}/${REPO}`);
if (DRY) {
  for (const f of files) console.log('  ', f);
  console.log('\n--dry-run：未做任何网络写操作');
  process.exit(0);
}
if (!TOKEN) {
  console.error('缺少 GH_TOKEN：请用 GH_TOKEN=<PAT> 运行（PAT 需 repo + workflow scope）');
  process.exit(2);
}

const me = await api('GET', '/user');
console.log(`已认证为 ${me.login}`);

// 1) 建仓库（已存在则复用）
let repo;
try {
  repo = await api('POST', '/user/repos', {
    name: REPO,
    description: DESCRIPTION,
    homepage: `https://github.com/${OWNER}/${REPO}`,
    private: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false
  });
  console.log(`✓ 已创建仓库 ${repo.full_name}`);
} catch (err) {
  if (err.status !== 422) throw err;
  repo = await api('GET', `/repos/${OWNER}/${REPO}`);
  console.log(`· 仓库已存在，复用 ${repo.full_name}`);
}

// 2) 读现有分支头。空仓库要先“引导”：Git Data API 在空仓库上会返回 409
//    （{"message":"Git Repository is empty."}），必须先用 Contents API 落一个文件。
const branch = repo.default_branch || 'main';
let parentSha = null;
let baseTree = null;

async function readHead() {
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${branch}`);
    parentSha = ref.object.sha;
    const commit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
    baseTree = commit.tree.sha;
    return true;
  } catch (err) {
    if (err.status === 404 || err.status === 409) return false;
    throw err;
  }
}

if (await readHead()) {
  console.log(`· ${branch} 当前指向 ${parentSha.slice(0, 7)}`);
} else {
  console.log(`· 仓库还是空的：先用 Contents API 引导 ${branch}（空仓库不允许直接建 blob）`);
  const seedPath = 'README.md';
  await api('PUT', `/repos/${OWNER}/${REPO}/contents/${seedPath}`, {
    message: 'chore: initialize repository',
    content: readFileSync(join(ROOT, seedPath)).toString('base64')
  });
  if (!(await readHead())) throw new Error(`引导之后仍然读不到 ${branch}`);
  console.log(`· 引导提交 ${parentSha.slice(0, 7)} 已建立`);
}

// 3) 每个文件一个 blob
const tree = [];
for (const file of files) {
  const content = readFileSync(join(ROOT, file));
  const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64'
  });
  tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  ↑ ${file}`);
}

// 4) tree + commit + 移动 main
const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
  ...(baseTree ? { base_tree: baseTree } : {}),
  tree
});
const message = [
  'feat: export DSH sessions as Markdown or self-contained HTML',
  '',
  'Published from the local repository via the GitHub REST API.',
  '',
  '- export_session_md tool: current session, a named one, or every session',
  '- presets full / handoff / readable / audit / both, explicit options override them',
  '- Session Header menu with one-click downloads through GET|HEAD /api/session.export-md',
  '- format html: zero-dependency self-contained page, prints to PDF without losing collapsed sections',
  '- content cannot break the document: tags escaped, unbalanced fences neutralized, GFM-valid tables',
  '- Windows-safe file names (reserved device names, trailing dot/space, forbidden characters)',
  '- zero @deepseek-ai dependencies and no peerDependencies, so the compatibility gate passes',
  '- CI on ubuntu/windows/macos x Node 22/24'
].join('\n');
const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message,
  tree: newTree.sha,
  ...(parentSha ? { parents: [parentSha] } : {})
});
await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
console.log(`✓ ${branch} 已更新到 ${commit.sha.slice(0, 7)}`);

// 5) topics（市场的发现靠这个 + 描述关键词）
await api('PUT', `/repos/${OWNER}/${REPO}/topics`, { names: TOPICS });
console.log(`✓ topics: ${TOPICS.join(', ')}`);

// 6) 可选：tag + Release（Release 正文取 CHANGELOG 里对应版本那一段）
if (RELEASE_TAG) {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const version = RELEASE_TAG.replace(/^v/, '');
  const start = changelog.indexOf(`## ${version}`);
  const body = start === -1
    ? changelog.slice(0, 1500)
    : changelog.slice(start, (() => { const next = changelog.indexOf('\n## ', start + 1); return next === -1 ? undefined : next; })()).trim();

  // 轻量 tag 指向本次提交
  let tagRef = null;
  try {
    tagRef = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/tags/${RELEASE_TAG}`);
  } catch (err) {
    if (err.status !== 404 && err.status !== 409) throw err;
  }
  if (!tagRef) {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/tags/${RELEASE_TAG}`, sha: commit.sha });
    console.log(`✓ 已打 tag ${RELEASE_TAG} -> ${commit.sha.slice(0, 7)}`);
  } else if (tagRef.object.sha === commit.sha) {
    console.log(`· tag ${RELEASE_TAG} 已指向本次提交，跳过`);
  } else if (FORCE_TAG) {
    await api('DELETE', `/repos/${OWNER}/${REPO}/git/refs/tags/${RELEASE_TAG}`);
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/tags/${RELEASE_TAG}`, sha: commit.sha });
    console.log(`✓ tag ${RELEASE_TAG} 已从 ${tagRef.object.sha.slice(0, 7)} 移到 ${commit.sha.slice(0, 7)}（Release 跟着走）`);
  } else {
    console.log(`! tag ${RELEASE_TAG} 现指向 ${tagRef.object.sha.slice(0, 7)}，本次提交是 ${commit.sha.slice(0, 7)}；` +
      '要把它挪过来就加 --force-tag');
  }
  try {
    const rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: RELEASE_TAG,
      name: RELEASE_TAG,
      body,
      draft: false,
      prerelease: false
    });
    console.log(`✓ 已发布 Release ${rel.tag_name}: ${rel.html_url}`);
  } catch (err) {
    if (err.status !== 422) throw err;
    console.log(`· Release ${RELEASE_TAG} 已存在，跳过`);
  }
}

console.log(`\n完成：https://github.com/${OWNER}/${REPO}`);
console.log(`别人安装：dsh plugin --profile web add github:${OWNER}/${REPO}`);
if (!RELEASE_TAG) console.log('提示：加 --release 可以顺带打 tag 并建 Release');
