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
const crypto = require('crypto');
const { decodeBMP } = require('./bmp');

// 可上传 / 可识别的位图格式。
// sharp 原生支持 tiff，但**不支持 bmp**，所以 bmp 走自己写的解码器（见 bmp.js）。
const IMG_RE = /\.(jpe?g|png|webp|gif|avif|tiff?|bmp)$/i;
// 网页最终只该出现这几种
const WEB_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

function isBmp(ext) {
  return ext === '.bmp';
}

/** 造一个 sharp 实例（BMP 需要先解码成 raw） */
function makePipeline(buffer, ext) {
  if (isBmp(ext)) {
    const bmp = decodeBMP(buffer);
    return {
      img: sharp(bmp.data, {
        raw: { width: bmp.width, height: bmp.height, channels: 4 }
      }),
      width: bmp.width,
      height: bmp.height,
      hasAlpha: false
    };
  }
  const img = sharp(buffer, { failOn: 'none' }).rotate(); // 按 EXIF 方向摆正
  return { img, width: 0, height: 0, hasAlpha: false, deferred: true };
}

function walk(dir, base, out) {
  const acc = out || [];
  if (!dir || !fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, base + '/' + ent.name, acc);
    } else if (IMG_RE.test(ent.name)) {
      acc.push({ full, rel: base + '/' + ent.name });
    }
  }
  return acc;
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
  const ext = path.extname(full).toLowerCase();
  try {
    if (isBmp(ext)) {
      const bmp = decodeBMP(fs.readFileSync(full));
      return { width: bmp.width, height: bmp.height };
    }
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

  // 新博客通常还没有 source/images，这里按需创建，不要让用户第一次上传就失败
  if (!site.imagesDir) throw new Error('找不到博客的 source 目录，无法确定图片放哪里');
  if (!fs.existsSync(site.imagesDir)) fs.mkdirSync(site.imagesDir, { recursive: true });

  const srcExt = (path.extname(originalName) || '.jpg').toLowerCase();
  if (!IMG_RE.test('x' + srcExt)) {
    throw new Error(
      '不支持的图片格式：' + srcExt + '（支持 jpg / png / webp / gif / avif / tif / tiff / bmp）'
    );
  }

  // 先保存原图（可选），再压缩
  if (keepOriginal) {
    const origDir = path.join(site.blogDir, originalDirName);
    if (!fs.existsSync(origDir)) fs.mkdirSync(origDir, { recursive: true });
    const origName = uniqueName(origDir, path.basename(originalName));
    fs.writeFileSync(path.join(origDir, origName), buffer);
  }

  const pipe = makePipeline(buffer, srcExt);
  let img = pipe.img;
  let srcW = pipe.width;
  let srcH = pipe.height;
  let hasAlpha = pipe.hasAlpha;

  if (pipe.deferred) {
    const meta = await img.metadata();
    srcW = meta.width || 0;
    srcH = meta.height || 0;
    hasAlpha = !!meta.hasAlpha;

    // 动图（GIF/WebP/AVIF 多帧）不做转换，否则会被压成只剩第一帧
    if (meta.pages && meta.pages > 1) {
      const fileName = uniqueName(site.imagesDir, path.basename(originalName));
      fs.writeFileSync(path.join(site.imagesDir, fileName), buffer);
      return {
        fileName,
        url: '/images/' + fileName,
        before: buffer.length,
        after: buffer.length,
        width: srcW,
        height: srcH,
        format: srcExt.replace('.', ''),
        note: '动图，已原样保留（未压缩）'
      };
    }
  }

  const longEdge = Math.max(srcW, srcH);
  if (maxEdge > 0 && longEdge > maxEdge) {
    const scale = maxEdge / longEdge;
    img = img.resize(Math.round(srcW * scale), Math.round(srcH * scale), {
      fit: 'inside',
      withoutEnlargement: true
    });
  }

  // 输出格式：只留网页能用的。
  // bmp / tiff 一律转 JPEG —— 它们动辄几十 MB，网页必须转。
  let outExt = '.jpg';
  if (srcExt === '.png' && hasAlpha) outExt = '.png';
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

  // 文件名要能安全地写进 Markdown 的 ![](...) 里。
  // 空格会让 Markdown 认为地址到此为止，括号会提前闭合，两者都会导致图片显示不出来，
  // 所以统一清洗：空格换连字符，去掉括号等 URL/Markdown 里有歧义的符号。
  const baseName = safeImageName(path.basename(originalName, path.extname(originalName))) || 'image';
  const fileName = uniqueName(site.imagesDir, baseName + outExt);

  // 内容去重：如果目录里已经有完全相同的图，直接复用，不再生成 -1 -2 副本
  const outHash = sha1(outBuf);
  const dup = findSameContent(site.imagesDir, outHash, outBuf.length);
  if (dup) {
    return {
      fileName: dup,
      url: '/images/' + dup,
      before: buffer.length,
      after: outBuf.length,
      width: info.width,
      height: info.height,
      format: outExt.replace('.', ''),
      reused: true,
      note: '这张图博客里已经有了，直接复用 ' + dup
    };
  }

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

/** 文件名清洗：保留中文和字母数字，去掉会破坏 Markdown/URL 的字符 */
function safeImageName(name) {
  return String(name || '')
    .replace(/[\s\u3000]+/g, '-') // 空白（含全角空格）→ 连字符
    .replace(/[()（）\[\]{}#?%&+=,'"`<>|\\/:*]/g, '') // 会干扰 Markdown 或文件系统的符号
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** 在图片目录里找内容完全相同的文件。
 *  先用体积筛一遍（体积不同内容必然不同，省掉大量读盘），只对体积相同的才算哈希。 */
function findSameContent(dir, hash, size) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return '';
  }
  for (const n of names) {
    if (!IMG_RE.test(n)) continue;
    const full = path.join(dir, n);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!st.isFile() || st.size !== size) continue;
    try {
      if (sha1(fs.readFileSync(full)) === hash) return n;
    } catch (e) {
      /* 读不了就跳过 */
    }
  }
  return '';
}

module.exports = { listImages, unusedImages, saveUploaded, usedImagePaths, IMG_RE };
