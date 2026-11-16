'use strict';

/**
 * 只读的 Git 状态 + 「源码 vs 线上产物」是否同步的判断。
 * 本工具不做任何 git 写操作（提交 / 推送都留给用户自己），
 * 只把状态展示出来，解决「不知道现在到底发没发布」的问题。
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir].concat(args), { windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim());
    });
  });
}

async function status(site) {
  if (!site.isGitRepo) {
    return { isRepo: false, branch: '', upstream: '', ahead: 0, behind: 0, dirty: [], dirtyCount: 0, lastCommit: null };
  }

  const [branch, porcelain, upstream] = await Promise.all([
    git(site.blogDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(site.blogDir, ['status', '--porcelain=v1']),
    git(site.blogDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  ]);

  const dirty = (porcelain || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim(), file: line.slice(3) }));

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const [a, b] = await Promise.all([
      git(site.blogDir, ['rev-list', '--count', '@{u}..HEAD']),
      git(site.blogDir, ['rev-list', '--count', 'HEAD..@{u}'])
    ]);
    ahead = parseInt(a || '0', 10) || 0;
    behind = parseInt(b || '0', 10) || 0;
  }

  const lastLine = await git(site.blogDir, ['log', '-1', '--format=%h\t%ct\t%s']);
  let lastCommit = null;
  if (lastLine) {
    const [hash, ts, subject] = lastLine.split('\t');
    lastCommit = { hash, time: Number(ts) * 1000, subject };
  }

  return {
    isRepo: true,
    branch: branch || '',
    upstream: upstream || '',
    ahead,
    behind,
    dirty: dirty.slice(0, 200),
    dirtyCount: dirty.length,
    lastCommit
  };
}

/** 源码目录里最新的修改时间 */
function newestSourceTime(site) {
  let newest = 0;
  const roots = [
    site.postsDir,
    site.imagesDir,
    path.join(site.blogDir, site.sourceDir || 'source'),
    site.themeDir
  ].filter(Boolean);

  const seen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root) || seen.has(root)) continue;
    seen.add(root);
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const ent of entries) {
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'public') continue;
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
        } else {
          try {
            const t = fs.statSync(full).mtimeMs;
            if (t > newest) newest = t;
          } catch (e) {
            /* 忽略 */
          }
        }
      }
    }
  }
  return newest;
}

/** 上次部署（.deploy_git 最后一次提交）的时间 */
async function lastDeployTime(site) {
  const deployDir = path.join(site.blogDir, '.deploy_git');
  if (!fs.existsSync(deployDir)) return 0;
  const ts = await git(deployDir, ['log', '-1', '--format=%ct']);
  return ts ? Number(ts) * 1000 : 0;
}

/**
 * 判断「源码改过但还没发布」——这是他原来最想要、但 web-hexo-editor 给不了的信息。
 *
 * 只看 mtime 会误报：`git checkout` 恢复文件、或只 touch 了一下，
 * mtime 变新但内容和上次发布的一样。所以还要看 git：
 *   - 工作区有未提交改动 → 需要发布
 *   - 有新提交但那个提交还没发布过 → 需要发布
 *   - 工作区干净、且最后提交早于上次发布 → 线上已是最新
 */
async function deployState(site) {
  const [deployedAt, newest] = await Promise.all([lastDeployTime(site), newestSourceTime(site)]);

  let dirtyCount = 0;
  let lastCommitAt = 0;
  if (site.isGitRepo) {
    const [porcelain, commitTs] = await Promise.all([
      git(site.blogDir, ['status', '--porcelain=v1']),
      git(site.blogDir, ['log', '-1', '--format=%ct'])
    ]);
    dirtyCount = (porcelain || '').split('\n').filter(Boolean).length;
    lastCommitAt = commitTs ? Number(commitTs) * 1000 : 0;
  }

  const sourceNewer = newest > deployedAt + 1000;
  const gitHasUnpublished = dirtyCount > 0 || lastCommitAt > deployedAt + 1000;
  const needsDeploy =
    deployedAt === 0 ? newest > 0 : sourceNewer && gitHasUnpublished;

  return {
    lastDeployedAt: deployedAt,
    newestSourceAt: newest,
    lastCommitAt,
    dirtyCount,
    needsDeploy
  };
}

module.exports = { status, deployState, newestSourceTime };
