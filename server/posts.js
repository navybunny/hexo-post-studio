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

function create(site, payload) {
  if (!site.postsDir) throw new Error('找不到 _posts 目录');
  if (!fs.existsSync(site.postsDir)) fs.mkdirSync(site.postsDir, { recursive: true });

  let id = slugify(payload.title || '未命名') + '.md';
  let i = 2;
  while (fs.existsSync(path.join(site.postsDir, id))) {
    id = slugify(payload.title || '未命名') + '-' + i + '.md';
    i += 1;
  }

  const data = {
    title: payload.title || '未命名',
    date: formatDate(payload.date ? new Date(payload.date) : new Date()),
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

module.exports = {
  list,
  read,
  save,
  create,
  remove,
  listPages,
  readPage,
  savePage,
  parse,
  serialize,
  formatDate,
  TRASH_DIR
};
