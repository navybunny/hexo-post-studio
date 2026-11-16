'use strict';

/**
 * 文章读写：解析 / 序列化 front-matter，列出文章，新建与删除。
 *
 * 关键点：写回时**保留原有字段顺序和未知字段**，且不会把 date 改写成 UTC ISO
 * （Hexo 站点通常配置了 timezone，改格式会导致时间偏移）。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const TRASH_DIR = '.post-studio-trash';

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return (
    dt.getFullYear() +
    '-' + pad(dt.getMonth() + 1) +
    '-' + pad(dt.getDate()) +
    ' ' + pad(dt.getHours()) +
    ':' + pad(dt.getMinutes()) +
    ':' + pad(dt.getSeconds())
  );
}

/** 把 front-matter 里的 Date 转成 Hexo 习惯的字符串，避免时区被改写 */
function normalizeForDump(data) {
  const out = {};
  Object.keys(data).forEach((k) => {
    const v = data[k];
    out[k] = v instanceof Date ? formatDate(v) : v;
  });
  return out;
}

function parse(raw) {
  const m = FM_RE.exec(raw);
  if (!m) return { data: {}, body: raw };
  let data = {};
  try {
    // 用 JSON_SCHEMA：不把 `2026-04-10 12:00:00` 解析成 Date。
    // 否则 js-yaml 会按 UTC 解析、再按本地时区输出，导致日期整体偏移。
    // 保持字符串原样，写回时就能一字不差。
    data = yaml.load(m[1], { schema: yaml.JSON_SCHEMA }) || {};
  } catch (e) {
    data = {};
  }
  return { data, body: m[2] };
}

function serialize(data, body) {
  const dump = yaml.dump(normalizeForDump(data), {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"'
  });
  return '---\n' + dump + '---\n\n' + String(body || '').replace(/^\n+/, '');
}

function listFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(md|markdown)$/i.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      const raw = fs.readFileSync(full, 'utf8');
      const { data, body } = parse(raw);
      const imgs = (body.match(/!\[[^\]]*\]\(([^)]+)\)/g) || []).length;
      const plain = body
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/[#>*`\-|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        id: f,
        title: data.title ? String(data.title) : f.replace(/\.md$/i, ''),
        date: data.date ? formatDate(data.date) : '',
        tags: Array.isArray(data.tags) ? data.tags.map(String) : data.tags ? [String(data.tags)] : [],
        categories: Array.isArray(data.categories)
          ? data.categories.map(String)
          : data.categories
          ? [String(data.categories)]
          : [],
        mtime: st.mtimeMs,
        size: st.size,
        imageCount: imgs,
        excerpt: plain.slice(0, 80),
        isDraft: /(^|\/)_drafts\//.test(full)
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.mtime - a.mtime));
}

function list(site) {
  return listFiles(site.postsDir);
}

function safeJoin(dir, id) {
  const full = path.resolve(dir, id);
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error('非法文件名');
  }
  return full;
}

function read(site, id) {
  const full = safeJoin(site.postsDir, id);
  if (!fs.existsSync(full)) throw new Error('文章不存在：' + id);
  const raw = fs.readFileSync(full, 'utf8');
  const { data, body } = parse(raw);
  const normalized = normalizeForDump(data);
  return { id, data: normalized, body, raw };
}

function save(site, id, payload) {
  const full = safeJoin(site.postsDir, id);
  if (!fs.existsSync(full)) throw new Error('文章不存在：' + id);
  const content = serialize(payload.data || {}, payload.body || '');
  fs.writeFileSync(full, content, 'utf8');
  return { id, size: Buffer.byteLength(content) };
}

function slugify(title) {
  const s = String(title)
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'untitled-' + Date.now();
}

/**
 * 按博客自己的 new_post_name 生成文件名（Hexo 的 :year / :month / :title 这些占位符）。
 * 尊重别人的博客约定，而不是一律 :title.md。
 */
function renderNewPostName(pattern, title, date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const map = {
    ':post_title': String(title || '').trim() || 'untitled',
    ':title': slugify(title || ''),
    ':year': String(d.getFullYear()),
    ':month': pad(d.getMonth() + 1),
    ':day': pad(d.getDate()),
    ':hour': pad(d.getHours()),
    ':minute': pad(d.getMinutes()),
    ':second': pad(d.getSeconds()),
    ':i_month': String(d.getMonth() + 1),
    ':i_day': String(d.getDate())
  };

  let out = String(pattern || ':title');
  // 长的占位符先替换，避免 :title 被 :i_title 之类误伤
  Object.keys(map)
    .sort((a, b) => b.length - a.length)
    .forEach((k) => {
      out = out.split(k).join(map[k]);
    });

  // 文件名安全处理：去掉非法字符和路径分隔符
  out = out.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-');
  out = out.replace(/^-+|-+$/g, '');
  if (!/\.md$/i.test(out)) out += '.md';
  return out || 'untitled-' + Date.now() + '.md';
}

function create(site, payload) {
  if (!site.postsDir) throw new Error('找不到 _posts 目录');
  if (!fs.existsSync(site.postsDir)) fs.mkdirSync(site.postsDir, { recursive: true });

  const title = payload.title || '未命名';
  const when = payload.date ? new Date(payload.date) : new Date();
  const pattern = site.newPostName || ':title.md';

  let id = renderNewPostName(pattern, title, when);
  const stem = id.replace(/\.md$/i, '');
  let i = 2;
  while (fs.existsSync(path.join(site.postsDir, id))) {
    id = stem + '-' + i + '.md';
    i += 1;
  }

  const data = {
    title,
    date: formatDate(when),
    tags: payload.tags || [],
    categories: payload.categories || ''
  };
  if (!data.categories) delete data.categories;

  fs.writeFileSync(path.join(site.postsDir, id), serialize(data, payload.body || ''), 'utf8');
  return { id };
}

/** 删除 = 移到博客下的 .post-studio-trash/，不做真删除 */
function remove(site, id) {
  const full = safeJoin(site.postsDir, id);
  if (!fs.existsSync(full)) throw new Error('文章不存在：' + id);
  const trash = path.join(site.blogDir, TRASH_DIR);
  if (!fs.existsSync(trash)) fs.mkdirSync(trash, { recursive: true });
  const stamp = formatDate(new Date()).replace(/[-: ]/g, '');
  const target = path.join(trash, stamp + '-' + path.basename(full));
  fs.renameSync(full, target);
  return { movedTo: target };
}

/* ---------------- 页面（关于页、搜索页、404 等） ---------------- */

const PAGE_SKIP_DIRS = new Set(['_posts', '_drafts', 'images', 'node_modules']);

function safePagePath(site, rel) {
  if (!site.sourcePath) throw new Error('找不到 source 目录');
  const full = path.resolve(site.sourcePath, String(rel || ''));
  if (!full.startsWith(path.resolve(site.sourcePath) + path.sep)) {
    throw new Error('非法路径');
  }
  if (!/\.(md|markdown)$/i.test(full)) throw new Error('只支持 .md 文件');
  return full;
}

/** 列出 source 下的所有页面（排除 _posts / _drafts / images） */
function listPages(site) {
  const out = [];
  if (!site.sourcePath || !fs.existsSync(site.sourcePath)) return out;

  const walk = (dir, relBase) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (PAGE_SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const rel = relBase ? relBase + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (/\.(md|markdown)$/i.test(ent.name)) {
        // 跳过 source 根目录下的 README（它通常是给仓库首页看的，不是博客页面）
        if (!relBase && /^readme\.(md|markdown)$/i.test(ent.name)) continue;
        // 下划线开头的文件 Hexo 不渲染
        if (ent.name.indexOf('_') === 0) continue;
        const st = fs.statSync(full);
        let data = {};
        try {
          data = parse(fs.readFileSync(full, 'utf8')).data;
        } catch (e) {
          data = {};
        }
        out.push({
          rel,
          title: data.title ? String(data.title) : rel.replace(/\.md$/i, ''),
          layout: data.layout ? String(data.layout) : '',
          mtime: st.mtimeMs,
          size: st.size
        });
      }
    }
  };

  walk(site.sourcePath, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function readPage(site, rel) {
  const full = safePagePath(site, rel);
  if (!fs.existsSync(full)) throw new Error('页面不存在：' + rel);
  const raw = fs.readFileSync(full, 'utf8');
  const parsed = parse(raw);
  return { rel, data: normalizeForDump(parsed.data), body: parsed.body, raw };
}

function savePage(site, rel, payload) {
  const full = safePagePath(site, rel);
  if (!fs.existsSync(full)) throw new Error('页面不存在：' + rel);
  const content = serialize(payload.data || {}, payload.body || '');
  fs.writeFileSync(full, content, 'utf8');
  return { rel, size: Buffer.byteLength(content) };
}

/* ---------------- 撤回修改：恢复到此文件上次提交的版本 ---------------- */

const { spawn } = require('child_process');

/** 读 git HEAD 里的某个文件；不存在或没提交过返回 null */
function gitShowHead(blogDir, relPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['show', 'HEAD:' + relPath], { cwd: blogDir });
    } catch (e) {
      resolve(null);
      return;
    }
    const chunks = [];
    const errs = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => errs.push(d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null);
    });
  });
}

/**
 * 把某个文件恢复成上次提交（git HEAD）的内容。
 * 当前内容会先备份到博客根目录的 .post-studio-trash/，不会凭空消失。
 */
async function revertToHead(site, kind, key) {
  let full;
  if (kind === 'page') full = safePagePath(site, key);
  else full = safeJoin(site.postsDir, key);

  if (!fs.existsSync(full)) throw new Error('文件不存在：' + key);

  const relPath = path.relative(site.blogDir, full).split(path.sep).join('/');
  const head = await gitShowHead(site.blogDir, relPath);

  if (head == null) {
    throw new Error('这个文件还没有提交过，没有可撤回的版本');
  }

  const current = fs.readFileSync(full, 'utf8');
  if (current === head) {
    return { restored: false, unchanged: true, message: '内容和上次提交的版本一样，不用撤回' };
  }

  // 先备份当前内容
  const trash = path.join(site.blogDir, TRASH_DIR);
  if (!fs.existsSync(trash)) fs.mkdirSync(trash, { recursive: true });
  const stamp = formatDate(new Date()).replace(/[-: ]/g, '');
  const backup = path.join(trash, stamp + '-撤回前-' + path.basename(full));
  fs.writeFileSync(backup, current, 'utf8');

  fs.writeFileSync(full, head, 'utf8');
  return { restored: true, backup, message: '已恢复到上次提交的版本' };
}

module.exports = {
  list,
  read,
  save,
  create,
  remove,
  listPages,
  readPage,
  savePage,
  revertToHead,
  parse,
  serialize,
  formatDate,
  TRASH_DIR
};
