'use strict';

/**
 * 识别一个目录是不是 Hexo 博客，并读出它配置里的关键信息：
 * 源目录、文章目录、图片目录、主题及其 CSS 位置、部署配置。
 *
 * 不假设任何固定路径，所以别人的博客（换主题、改 source_dir）也能直接用。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function loadSite(blogDir) {
  const dir = path.resolve(blogDir);
  const cfgPath = path.join(dir, '_config.yml');

  if (!exists(cfgPath)) {
    throw new Error('这个目录不是 Hexo 博客（找不到 _config.yml）：' + dir);
  }

  let cfg = {};
  try {
    cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
  } catch (e) {
    throw new Error('_config.yml 解析失败：' + e.message);
  }

  const sourceDir = cfg.source_dir || 'source';
  const sourcePath = path.join(dir, sourceDir);
  const postsDir = path.join(sourcePath, '_posts');
  // 注意：images 目录可能还不存在（刚 hexo init 的新博客就没有），
  // 但只要 source 目录在，就把目标路径记下来，上传时按需创建。
  const imagesDir = path.join(sourcePath, 'images');
  const themeName = cfg.theme || '';
  const themeDir = themeName ? path.join(dir, 'themes', themeName) : '';

  // 主题 CSS 目录：用于「预览时套用真实样式」
  const themeCssCandidates = themeDir
    ? [path.join(themeDir, 'source', 'css'), path.join(themeDir, 'source-css')]
    : [];
  const themeCssDir = themeCssCandidates.find((p) => exists(p)) || '';

  // 部署目标（只读展示用，本工具不直接操作它）
  const deploy = cfg.deploy || {};
  const deployTarget = Array.isArray(deploy)
    ? deploy[0] || {}
    : deploy;
  const deployRepo = deployTarget.repo || deployTarget.repository || '';
  const deployBranch = deployTarget.branch || '';

  return {
    blogDir: dir,
    title: cfg.title || '',
    subtitle: cfg.subtitle || '',
    description: cfg.description || '',
    url: cfg.url || '',
    author: cfg.author || '',
    theme: themeName,
    themeDir: exists(themeDir) ? themeDir : '',
    themeCssDir,
    sourceDir,
    sourcePath: exists(sourcePath) ? sourcePath : '',
    postsDir: exists(postsDir) ? postsDir : '',
    // 目录可以还不存在（新博客），上传时会自动创建
    imagesDir: exists(sourcePath) ? imagesDir : '',
    isGitRepo: exists(path.join(dir, '.git')),
    deployRepo,
    deployBranch,
    permalink: cfg.permalink || '',
    newPostName: cfg.new_post_name || ':title.md'
  };
}

module.exports = { loadSite, exists };
