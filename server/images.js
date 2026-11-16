'use strict';

/**
 * 图片处理：
 *  - 列出 source/images 下的图片（含体积、尺寸）
 *  - 接收上传的原图 → 按设置的等级压缩 → 写入 source/images
 *  - 扫描「没被任何文章引用的图片」，方便清理
 *
 * 安全约定：
 *  - 只把「上传进来的原图」压一次，绝不二次压缩已有文件（会明显掉画质）
 *  - 文件名冲突自动加序号，不覆盖已有图片
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const IMG_RE = /\.(jpe?g|png|webp|gif|avif)$/i;

function walk(dir, base, out) {
  if (!dir || !fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, base + '/' + ent.name, out);
    } else if (IMG_RE.test(ent.name)) {
      out.push({ full, rel: base + '/' + ent.name });
    }
  }
  return out;
}

async function withPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function dimensions(full) {
  try {
    const m = await sharp(full).metadata();
    return { width: m.width, height: m.height };
  } catch (e) {
    return { width: 0, height: 0 };
  }
}

async function listImages(site) {
  if (!site.imagesDir) return [];
  const files = walk(site.imagesDir, '');
  const dims = await withPool(files, 8, (f) => dimensions(f.full));
  return files.map((f, i) => {
    const st = fs.statSync(f.full);
    return {
      name: path.basename(f.full),
      rel: f.rel.replace(/^\//, ''),
      url: '/images' + f.rel,
      size: st.size,
      mtime: st.mtimeMs,
      width: dims[i] ? dims[i].width : 0,
      height: dims[i] ? dims[i].height : 0
    };
  }).sort((a, b) => b.size - a.size);
}

/** 扫描所有 .md 与页面，收集被引用过的图片路径 */
function usedImagePaths(site) {
  const used = new Set();
  const roots = [site.postsDir, site.sourcePath].filter(Boolean);
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'images' || ent.name === 'node_modules') continue;
          stack.push(full);
        } else if (/\.(md|markdown|html)$/i.test(ent.name)) {
          files.push(full);
        }
      }
    }
  }
  const re = /\/images\/([^\s)"'>]+)/g;
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(txt))) {
      used.add(decodeURIComponent(m[1]));
    }
  }
  return used;
}

function unusedImages(site) {
  const used = usedImagePaths(site);
  const files = walk(site.imagesDir, '');
  return files
    .map((f) => {
      const rel = f.rel.replace(/^\//, '');
      return { rel, name: path.basename(f.full), size: fs.statSync(f.full).size, used: used.has(rel) };
    })
    .filter((x) => !x.used)
    .sort((a, b) => b.size - a.size);
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = stem + '-' + i + ext;
    i += 1;
  }
  return candidate;
}

/**
 * 压缩一张上传的图片。
 * 返回 { fileName, url, before, after, width, height, format }
 */
async function saveUploaded(site, buffer, originalName, options) {
  const maxEdge = Number(options.maxEdge) || 0;
  const quality = Math.min(99, Math.max(40, Number(options.quality) || 88));
  const keepOriginal = !!options.keepOriginal;
  const originalDirName = options.originalDir || '原图';

  if (!site.imagesDir) throw new Error('找不到 source/images 目录');
  if (!fs.existsSync(site.imagesDir)) fs.mkdirSync(site.imagesDir, { recursive: true });

  const srcExt = (path.extname(originalName) || '.jpg').toLowerCase();
  if (!IMG_RE.test('x' + srcExt)) throw new Error('不支持的图片格式：' + srcExt);

  // 先保存原图（可选），再压缩
  if (keepOriginal) {
    const origDir = path.join(site.blogDir, originalDirName);
    if (!fs.existsSync(origDir)) fs.mkdirSync(origDir, { recursive: true });
    const origName = uniqueName(origDir, path.basename(originalName));
    fs.writeFileSync(path.join(origDir, origName), buffer);
  }

  let img = sharp(buffer, { failOn: 'none' }).rotate(); // 按 EXIF 方向自动摆正
  const meta = await img.metadata();
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  if (maxEdge > 0 && longEdge > maxEdge) {
    const scale = maxEdge / longEdge;
    img = img.resize(Math.round((meta.width || 0) * scale), Math.round((meta.height || 0) * scale), {
      fit: 'inside',
      withoutEnlargement: true
    });
  }

  // PNG 带透明通道就保持 PNG，其余统一转 JPEG 以减小体积
  let outExt = '.jpg';
  if (srcExt === '.png' && meta.hasAlpha) outExt = '.png';
  else if (srcExt === '.webp') outExt = '.webp';

  let outBuf;
  let info;
  if (outExt === '.png') {
    const r = await img.png({ compressionLevel: 9, palette: true }).toBuffer({ resolveWithObject: true });
    outBuf = r.data;
    info = r.info;
  } else if (outExt === '.webp') {
    const r = await img.webp({ quality }).toBuffer({ resolveWithObject: true });
    outBuf = r.data;
    info = r.info;
  } else {
    const r = await img
      .jpeg({ quality, progressive: true, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    outBuf = r.data;
    info = r.info;
  }

  const baseName = path.basename(originalName, path.extname(originalName)) || 'image';
  const fileName = uniqueName(site.imagesDir, baseName + outExt);
  fs.writeFileSync(path.join(site.imagesDir, fileName), outBuf);

  return {
    fileName,
    url: '/images/' + fileName,
    before: buffer.length,
    after: outBuf.length,
    width: info.width,
    height: info.height,
    format: outExt.replace('.', '')
  };
}

module.exports = { listImages, unusedImages, saveUploaded, usedImagePaths, IMG_RE };
