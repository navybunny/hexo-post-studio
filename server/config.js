'use strict';

/**
 * 用户级配置，存在 ~/.hexo-post-studio.json
 * 只记「上次打开的博客目录」和「图片压缩参数」这类偏好，不碰博客本身。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.hexo-post-studio.json');

const DEFAULTS = {
  blogDir: '',
  lastPost: '',
  compress: {
    preset: 'standard',
    maxEdge: 2560,
    quality: 88
  },
  keepOriginal: true,
  originalDir: '原图'
};

// 预设：给用户一个不用思考的选择
const PRESETS = {
  web: { maxEdge: 1600, quality: 85, label: '网页版 · 长边 1600 · 省流量' },
  standard: { maxEdge: 2560, quality: 88, label: '标准 · 长边 2560 · 推荐' },
  high: { maxEdge: 3200, quality: 90, label: '高质量 · 长边 3200' },
  none: { maxEdge: 0, quality: 95, label: '不缩放 · 只重新编码' }
};

function read() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    cfg = {};
  }
  return {
    ...DEFAULTS,
    ...cfg,
    compress: { ...DEFAULTS.compress, ...(cfg.compress || {}) }
  };
}

function write(patch) {
  const next = { ...read(), ...patch };
  if (patch && patch.compress) {
    next.compress = { ...read().compress, ...patch.compress };
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { read, write, CONFIG_PATH, DEFAULTS, PRESETS };
