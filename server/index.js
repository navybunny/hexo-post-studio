'use strict';

/**
 * hexo-post-studio 服务端
 *
 * 全部是本地接口，只监听 127.0.0.1，不做任何鉴权（单机工具）。
 * 不提供 git 写操作；发布只调用 hexo 命令。
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { marked } = require('marked');

const configStore = require('./config');
const { loadSite } = require('./site');
const posts = require('./posts');
const imagesStore = require('./images');
const git = require('./git');
const publisher = require('./publish');

const VERSION = require('../package.json').version;

function createApp() {
  const app = express();
  const state = { site: null };

  app.use(express.json({ limit: '20mb' }));

  // 预览时把文章里的 /images/xxx 映射到真实文件，这样预览能看到图
  app.use('/blog-images', (req, res, next) => {
    if (!state.site || !state.site.imagesDir) return next();
    let rel;
    try {
      rel = decodeURIComponent(req.path).replace(/^\/+/, '');
    } catch (e) {
      return next();
    }
    const full = path.join(state.site.imagesDir, rel);
    if (!path.resolve(full).startsWith(path.resolve(state.site.imagesDir))) return next();
    if (!fs.existsSync(full)) return next();
    res.sendFile(full, (err) => {
      if (err) next();
    });
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // ---------- 基础信息 ----------
  function bootstrapPayload() {
    const cfg = configStore.read();
    let themeCss = [];
    if (state.site && state.site.themeCssDir) {
      themeCss = fs
        .readdirSync(state.site.themeCssDir)
        .filter((f) => f.endsWith('.css'))
        .map((f) => '/theme-css/' + f);
    }
    return {
      version: VERSION,
      config: cfg,
      presets: configStore.PRESETS,
      configPath: configStore.CONFIG_PATH,
      site: state.site
        ? {
            blogDir: state.site.blogDir,
            title: state.site.title,
            url: state.site.url,
            author: state.site.author,
            theme: state.site.theme,
            sourceDir: state.site.sourceDir,
            postsDir: state.site.postsDir,
            imagesDir: state.site.imagesDir,
            isGitRepo: state.site.isGitRepo,
            deployRepo: state.site.deployRepo,
            deployBranch: state.site.deployBranch
          }
        : null,
      themeCss
    };
  }

  app.get('/api/bootstrap', (req, res) => {
    res.json(bootstrapPayload());
  });

  app.post('/api/open', (req, res) => {
    try {
      const dir = String((req.body && req.body.blogDir) || '').trim();
      if (!dir) throw new Error('请填写博客目录');
      state.site = loadSite(dir);
      configStore.write({ blogDir: state.site.blogDir });
      res.json(bootstrapPayload());
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 保存偏好（压缩等级等）
  app.post('/api/config', (req, res) => {
    try {
      const next = configStore.write(req.body || {});
      res.json({ config: next, presets: configStore.PRESETS });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ---------- 主题 CSS（给预览用，尽量还原真实外观） ----------
  app.get('/theme-css/:file', (req, res) => {
    if (!state.site || !state.site.themeCssDir) return res.status(404).end();
    const file = path.basename(req.params.file);
    const full = path.join(state.site.themeCssDir, file);
    if (!fs.existsSync(full)) return res.status(404).end();
    res.type('text/css').sendFile(full);
  });

  // ---------- 文章 ----------
  function needSite(res) {
    if (!state.site) {
      res.status(400).json({ error: '还没有打开博客目录' });
      return false;
    }
    return true;
  }

  app.get('/api/posts', (req, res) => {
    if (!needSite(res)) return;
    try {
      res.json(posts.list(state.site));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/posts/:id', (req, res) => {
    if (!needSite(res)) return;
    try {
      res.json(posts.read(state.site, req.params.id));
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.put('/api/posts/:id', (req, res) => {
    if (!needSite(res)) return;
    try {
      const r = posts.save(state.site, req.params.id, req.body || {});
      configStore.write({ lastPost: r.id });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/posts', (req, res) => {
    if (!needSite(res)) return;
    try {
      const r = posts.create(state.site, req.body || {});
      configStore.write({ lastPost: r.id });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/posts/:id', (req, res) => {
    if (!needSite(res)) return;
    try {
      res.json(posts.remove(state.site, req.params.id));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 页面（关于页 / 搜索页 / 404 …） ----------
  app.get('/api/pages', (req, res) => {
    if (!needSite(res)) return;
    try {
      res.json(posts.listPages(state.site));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/page', (req, res) => {
    if (!needSite(res)) return;
    try {
      res.json(posts.readPage(state.site, req.query.rel));
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.put('/api/page', (req, res) => {
    if (!needSite(res)) return;
    try {
      res.json(posts.savePage(state.site, req.query.rel, req.body || {}));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 撤回修改：恢复到该文件上次提交的版本（当前内容自动备份到 .post-studio-trash）
  app.post('/api/revert', async (req, res) => {
    if (!needSite(res)) return;
    const { kind, key } = req.body || {};
    if (!key) return res.status(400).json({ error: '缺少 key' });
    try {
      res.json(await posts.revertToHead(state.site, kind === 'page' ? 'page' : 'post', key));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ---------- Markdown 预览 ----------
  app.post('/api/preview', (req, res) => {
    try {
      const body = String((req.body && req.body.body) || '');
      let html = marked.parse(body, { breaks: true, gfm: true });

      // ::: photo-grid 容器：把段落里那串图片提出来装进网格 div
      // （规则与博客的 scripts/image-viewer.js 保持一致，否则预览和实际不一致）
      const wrapGrid = (natural, inner) => {
        const imgs = inner.match(/<img\b[^>]*>/gi) || [];
        if (!imgs.length) return null;
        const cls = 'photo-grid' + (natural ? ' natural' : '');
        return '<div class="' + cls + '">\n' + imgs.join('\n') + '\n</div>';
      };
      html = html.replace(
        /<p>\s*:::\s*photo-grid\s*(natural)?\s*<\/p>([\s\S]*?)<p>\s*:::\s*<\/p>/gi,
        (whole, natural, inner) => wrapGrid(natural, inner) || whole
      );
      html = html.replace(
        /<p>\s*:::\s*photo-grid\s*(natural)?(?:\s|<br\s*\/?>)+([\s\S]*?):::\s*<\/p>/gi,
        (whole, natural, inner) => wrapGrid(natural, inner) || whole
      );

      // 把文章里的 /images/ 指到预览路由，否则预览里的图全是裂的
      html = html.replace(/(["'(])\/images\//g, '$1/blog-images/');
      res.json({ html });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 图片 ----------
  app.get('/api/images', async (req, res) => {
    if (!needSite(res)) return;
    try {
      res.json(await imagesStore.listImages(state.site));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/images/unused', (req, res) => {
    if (!needSite(res)) return;
    try {
      res.json(imagesStore.unusedImages(state.site));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 上传：请求体就是原始二进制，参数放 query（避免引入 multipart 依赖）
  // type 用函数恒真：有些系统/浏览器上传时 Content-Type 为空，也要能收
  app.post(
    '/api/upload',
    express.raw({ type: () => true, limit: '200mb' }),
    async (req, res) => {
      if (!needSite(res)) return;
      try {
        const name = String(req.query.name || 'image.jpg');
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('没有收到图片数据');
        const result = await imagesStore.saveUploaded(state.site, buf, name, {
          maxEdge: req.query.maxEdge,
          quality: req.query.quality,
          keepOriginal: req.query.keepOriginal === '1',
          originalDir: (req.query.originalDir || configStore.read().originalDir)
        });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  // ---------- 状态 ----------
  app.get('/api/status', async (req, res) => {
    if (!needSite(res)) return;
    try {
      const [gs, ds] = await Promise.all([git.status(state.site), git.deployState(state.site)]);
      res.json({ git: gs, deploy: ds });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 发布（流式输出） ----------
  app.post('/api/publish', async (req, res) => {
    if (!needSite(res)) return;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (obj) => {
      try {
        res.write(JSON.stringify(obj) + '\n');
      } catch (e) {
        /* 连接已断 */
      }
    };

    try {
      await publisher.publish(
        state.site,
        { deploy: !(req.body && req.body.deploy === false) },
        send
      );
    } catch (e) {
      send({ type: 'error', text: e.message });
      send({ type: 'done', ok: false });
    } finally {
      res.end();
    }
  });

  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });

  return { app, state };
}

module.exports = { createApp };
