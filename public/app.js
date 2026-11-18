/* hexo-post-studio — 前端逻辑（不依赖任何框架） */
(function () {
  'use strict';

  var BOOT = null;
  var POSTS = [];
  var PAGES = [];
  var VIEW = 'posts'; // posts | pages
  var CURRENT = null; // { kind:'post'|'page', key, data, body }
  var DIRTY = false;
  var MODE = 'write';
  var statusTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n > 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    var p = function (x) { return x < 10 ? '0' + x : x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  async function api(path, opts) {
    var opt = opts || {};
    var res = await fetch(path, {
      method: opt.method || 'GET',
      headers: opt.raw ? {} : { 'Content-Type': 'application/json' },
      body: opt.body ? (opt.raw ? opt.body : JSON.stringify(opt.body)) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error((data && data.error) || ('请求失败 ' + res.status));
    return data;
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    BOOT = await api('/api/bootstrap');
    $('versionBadge').textContent = 'v' + BOOT.version;
    renderCompressUI();

    if (!BOOT.site) {
      $('openModal').classList.add('show');
      $('dirInput').value = BOOT.config.blogDir || '';
      $('dirInput').focus();
      return;
    }
    afterOpen();
  }

  function afterOpen() {
    $('openModal').classList.remove('show');
    $('siteTitle').textContent = BOOT.site.title || 'Hexo 博客';
    $('dirLabel').textContent = BOOT.site.blogDir;
    $('origDirName').textContent = (BOOT.config.originalDir || '原图') + '/';
    loadPosts();
    loadPages();
    refreshStatus();
    refreshImageStats();
    clearPublishPanel();
    openFromHash();
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatus, 20000);
  }

  async function openDir() {
    var dir = $('dirInput').value.trim();
    if (!dir) return;
    $('dirErr').textContent = '';
    try {
      BOOT = await api('/api/open', { method: 'POST', body: { blogDir: dir } });
      afterOpen();
      toast('已打开：' + BOOT.site.title);
    } catch (e) {
      $('dirErr').textContent = e.message;
    }
  }

  /* ---------------- 文章列表 ---------------- */

  async function loadPosts() {
    POSTS = await api('/api/posts');
    renderPosts();
    if (CURRENT && CURRENT.kind === 'post') {
      var still = POSTS.some(function (p) { return p.id === CURRENT.key; });
      if (!still) { CURRENT = null; renderEditor(); }
    }
  }

  async function loadPages() {
    PAGES = await api('/api/pages');
    renderPosts();
  }

  function renderPosts() {
    var q = ($('searchInput').value || '').trim().toLowerCase();

    if (VIEW === 'pages') {
      var pl = PAGES.filter(function (p) {
        return !q || (p.title + ' ' + p.rel).toLowerCase().indexOf(q) >= 0;
      });
      $('postList').innerHTML = pl.map(function (p) {
        return '<div class="post-item' + (CURRENT && CURRENT.kind === 'page' && CURRENT.key === p.rel ? ' active' : '') +
          '" data-rel="' + esc(p.rel) + '">' +
          '<div class="t">' + esc(p.title) + '</div>' +
          '<div class="m"><span>' + esc(p.rel) + '</span></div>' +
          '</div>';
      }).join('');
      $('listFoot').textContent = '共 ' + PAGES.length + ' 个页面';
      return;
    }

    var list = POSTS.filter(function (p) {
      if (!q) return true;
      return (p.title + ' ' + p.tags.join(' ')).toLowerCase().indexOf(q) >= 0;
    });
    $('postList').innerHTML = list.map(function (p) {
      return '<div class="post-item' + (CURRENT && CURRENT.kind === 'post' && CURRENT.key === p.id ? ' active' : '') +
        '" data-id="' + esc(p.id) + '">' +
        '<div class="t">' + esc(p.title) + '</div>' +
        '<div class="m"><span>' + esc(p.date || '无日期') + '</span>' +
        (p.imageCount ? '<span class="imgs">' + p.imageCount + ' 图</span>' : '') +
        '</div></div>';
    }).join('');
    $('listFoot').textContent = '共 ' + POSTS.length + ' 篇' + (q ? '（筛选出 ' + list.length + '）' : '');
  }

  function switchView(view) {
    if (DIRTY && !confirm('当前内容有未保存的修改，确定切换？')) return;
    VIEW = view;
    Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    $('newPostBtn').hidden = view !== 'posts';
    $('searchInput').placeholder = view === 'pages' ? '搜索页面' : '搜索标题 / 标签';
    renderPosts();
  }

  async function selectPost(id) {
    if (DIRTY && !confirm('当前文章有未保存的修改，确定切换？')) return;
    clearPublishPanel();
    var data = await api('/api/posts/' + encodeURIComponent(id));
    CURRENT = { kind: 'post', key: id, data: data.data, body: data.body };
    DIRTY = false;
    location.hash = 'post=' + encodeURIComponent(id);
    renderEditor();
    renderPosts();
    updateDirtyFlag();
    refreshPreview();
  }

  async function selectPage(rel) {
    if (DIRTY && !confirm('当前内容有未保存的修改，确定切换？')) return;
    clearPublishPanel();
    var data = await api('/api/page?rel=' + encodeURIComponent(rel));
    CURRENT = { kind: 'page', key: rel, data: data.data, body: data.body };
    DIRTY = false;
    location.hash = 'page=' + encodeURIComponent(rel);
    renderEditor();
    renderPosts();
    updateDirtyFlag();
    refreshPreview();
  }

  /** 支持 #post=xxx.md / #page=about/index.md 这种深链接 */
  async function openFromHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return false;
    var i = h.indexOf('=');
    if (i < 0) return false;
    var kind = h.slice(0, i);
    var key = decodeURIComponent(h.slice(i + 1));
    try {
      if (kind === 'page') {
        switchView('pages');
        await selectPage(key);
        return true;
      }
      if (kind === 'post') {
        switchView('posts');
        await selectPost(key);
        return true;
      }
    } catch (e) {
      toast('链接指向的内容已不存在');
    }
    return false;
  }

  /* ---------------- 编辑器 ---------------- */

  function renderEditor() {
    var empty = !CURRENT;
    $('editorEmpty').hidden = !empty;
    $('editorWrap').hidden = empty;
    if (empty) return;

    var isPage = CURRENT.kind === 'page';
    $('fTitle').value = CURRENT.data.title || '';
    $('fDate').value = CURRENT.data.date || '';
    $('fLayout').value = CURRENT.data.layout || '';
    $('fTags').value = (CURRENT.data.tags || []).join(', ');
    var cats = CURRENT.data.categories;
    $('fCats').value = Array.isArray(cats) ? cats.join(', ') : (cats || '');

    // 页面没有日期/标签/分类，但有 layout
    $('fieldDate').hidden = isPage;
    $('fieldTags').hidden = isPage;
    $('fieldCats').hidden = isPage;
    $('fieldLayout').hidden = !isPage;
    $('delBtn').hidden = isPage;

    $('bodyInput').value = CURRENT.body || '';
    updateWordCount();
  }

  function splitList(v) {
    return String(v || '')
      .split(/[,，]/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function collectEditor() {
    var data = Object.assign({}, CURRENT.data);
    data.title = $('fTitle').value.trim();

    if (CURRENT.kind === 'page') {
      var layout = $('fLayout').value.trim();
      if (layout) data.layout = layout;
      else delete data.layout;
    } else {
      if ($('fDate').value.trim()) data.date = $('fDate').value.trim();
      var tags = splitList($('fTags').value);
      if (tags.length) data.tags = tags;
      else delete data.tags;
      var cats = splitList($('fCats').value);
      if (cats.length) data.categories = cats.length === 1 ? cats[0] : cats;
      else delete data.categories;
    }
    return { data: data, body: $('bodyInput').value };
  }

  async function savePost() {
    if (!CURRENT) return;
    var payload = collectEditor();
    if (CURRENT.kind === 'page') {
      await api('/api/page?rel=' + encodeURIComponent(CURRENT.key), { method: 'PUT', body: payload });
    } else {
      await api('/api/posts/' + encodeURIComponent(CURRENT.key), { method: 'PUT', body: payload });
    }
    CURRENT.data = payload.data;
    CURRENT.body = payload.body;
    DIRTY = false;
    updateDirtyFlag();
    if (CURRENT.kind === 'post') await loadPosts();
    else await loadPages();
    refreshStatus();
    toast('已保存');
  }

  async function newPost() {
    if (DIRTY && !confirm('当前文章有未保存的修改，确定新建？')) return;
    var title = prompt('新文章标题：', '未命名');
    if (title === null) return;
    var r = await api('/api/posts', { method: 'POST', body: { title: title || '未命名' } });
    await loadPosts();
    await selectPost(r.id);
    $('fTitle').focus();
    toast('已创建，记得写完保存');
  }

  async function deletePost() {
    if (!CURRENT || CURRENT.kind !== 'post') return;
    if (!confirm('确定把这篇文章移到回收目录？（不会真删除，可在博客根目录 .post-studio-trash 找回）')) return;
    await api('/api/posts/' + encodeURIComponent(CURRENT.key), { method: 'DELETE' });
    CURRENT = null;
    DIRTY = false;
    renderEditor();
    await loadPosts();
    toast('已移入回收目录');
  }

  function setDirty(v) {
    if (DIRTY === v) return;
    DIRTY = v;
    updateDirtyFlag();
  }

  function updateDirtyFlag() {
    var el = $('dirtyFlag');
    el.textContent = DIRTY ? '● 未保存' : (CURRENT ? '已保存' : '');
    el.className = DIRTY ? 'dirty' : '';
  }

  function updateWordCount() {
    var t = $('bodyInput').value || '';
    var imgs = (t.match(/!\[[^\]]*\]\(/g) || []).length;
    $('wordCount').textContent = t.length + ' 字符' + (imgs ? ' · ' + imgs + ' 张图' : '');
  }

  function setMode(mode) {
    MODE = mode;
    $('editorBody').className = 'editor-body mode-' + mode;
    ['tabWrite', 'tabPreview', 'tabSplit'].forEach(function (id) {
      $(id).classList.toggle('active',
        (id === 'tabWrite' && mode === 'write') ||
        (id === 'tabPreview' && mode === 'preview') ||
        (id === 'tabSplit' && mode === 'split'));
    });
    if (mode !== 'write') refreshPreview();
  }

  /* ---------------- 预览 ---------------- */

  async function refreshPreview() {
    if (MODE === 'write') return;
    var body = $('bodyInput').value || '';
    try {
      var r = await api('/api/preview', { method: 'POST', body: { body: body } });
      var css = (BOOT.themeCss || []).map(function (u) {
        return '<link rel="stylesheet" href="' + u + '">';
      }).join('');
      var doc = '<!doctype html><html data-theme="light"><head><meta charset="utf-8">' + css +
        '<style>body{margin:0;padding:24px;background:#fff;color:#111;font-family:system-ui}' +
        '.post-content{max-width:780px;margin:0 auto;line-height:1.8}' +
        '.post-content img{max-width:100%;height:auto;border-radius:8px;display:block;margin:16px auto}' +
        // 照片墙 / 视频 / 徽章的预览样式（选择器比上面那条更具体，能盖住它）
        '.post-content .photo-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}' +
        '.post-content .photo-grid img{width:100%;height:100%;margin:0;aspect-ratio:3/2;object-fit:cover}' +
        '.post-content .photo-grid.natural img{aspect-ratio:auto;height:auto;object-fit:contain}' +
        '.post-content .video-embed{position:relative;aspect-ratio:16/9;margin:16px 0;background:#000;border-radius:8px;overflow:hidden}' +
        '.post-content .video-embed iframe{position:absolute;inset:0;width:100%;height:100%;border:0}' +
        '.post-content .video-link{text-align:center;font-size:.9em;color:#888}' +
        '.post-content .badge-row{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}' +
        '.post-content .badge{display:inline-block;padding:4px 12px;margin:0;border-radius:999px;border:2px solid #39C5BB;background:rgba(57,197,187,.12);color:#2aa79f;font-size:.86em;font-weight:600}' +
        'table{border-collapse:collapse;width:100%}td,th{padding:6px;border:1px solid #ddd}' +
        'pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto}' +
        'code{background:#f2f4f7;padding:1px 4px;border-radius:3px}' +
        '</style></head><body><div class="post-content">' + r.html + '</div></body></html>';
      $('previewFrame').srcdoc = doc;
    } catch (e) {
      $('previewFrame').srcdoc = '<!doctype html><body style="font-family:sans-serif;padding:20px;color:#b00">预览失败：' + esc(e.message) + '</body>';
    }
  }

  /* ---------------- 图片上传 ---------------- */

  function compressParams() {
    var c = BOOT.config.compress || {};
    return {
      maxEdge: c.maxEdge,
      quality: c.quality,
      keepOriginal: BOOT.config.keepOriginal ? '1' : '0',
      originalDir: BOOT.config.originalDir || '原图'
    };
  }

  async function uploadFiles(fileList) {
    // 必须立刻快照成数组：FileList 是「活的」，调用方随后清空 input 会让它变空
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    // 过滤掉非图片
    files = files.filter(function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|avif|tiff?|bmp)$/i.test(f.name);
    });
    if (!files.length) {
      toast('没有可上传的图片');
      return;
    }

    var p = compressParams();
    var total = files.length;
    var done = 0;
    var results = new Array(total);

    toast('正在压缩 ' + total + ' 张…');

    // 并发 3 个，既快又不会把 CPU/磁盘打满；结果按原顺序收集
    async function worker(slot) {
      for (var i = slot; i < total; i += 3) {
        var f = files[i];
        try {
          var q = new URLSearchParams({
            name: f.name,
            maxEdge: String(p.maxEdge),
            quality: String(p.quality),
            keepOriginal: p.keepOriginal,
            originalDir: p.originalDir
          });
          var res = await api('/api/upload?' + q.toString(), {
            method: 'POST',
            raw: true,
            body: f
          });
          var alt = f.name.replace(/\.[^.]+$/, '');
          results[i] = {
            md: '![' + alt + '](' + res.url + ')',
            msg: f.name + '：' + fmtBytes(res.before) + ' → ' + fmtBytes(res.after)
          };
        } catch (e) {
          results[i] = { err: f.name + '：' + e.message };
        }
        done += 1;
        if (done < total) toast('已完成 ' + done + '/' + total);
      }
    }

    await Promise.all([worker(0), worker(1), worker(2)]);

    var ok = results.filter(function (r) { return r && r.md; });
    var bad = results.filter(function (r) { return r && r.err; });

    if (ok.length) {
      insertAtCursor(ok.map(function (r) { return r.md; }).join('\n'));
      refreshImageStats();
      refreshStatus();
    }
    if (bad.length) {
      toast('有 ' + bad.length + ' 张失败：' + bad[0].err);
    } else if (ok.length === 1) {
      toast(ok[0].msg);
    } else if (ok.length > 1) {
      toast('已插入 ' + ok.length + ' 张图片');
    }
  }

  function insertAtCursor(text) {
    var ta = $('bodyInput');
    var start = ta.selectionStart || 0;
    var end = ta.selectionEnd || 0;
    var val = ta.value;
    var before = val.slice(0, start);
    var after = val.slice(end);
    var glue = before && !/\n\s*$/.test(before) ? '\n' : '';
    ta.value = before + glue + text + '\n' + after;
    var pos = (before + glue + text + '\n').length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    setDirty(true);
    updateWordCount();
    refreshPreview();
  }

  /* ---------------- 状态 ---------------- */

  async function refreshStatus() {
    if (!BOOT || !BOOT.site) return;
    try {
      var s = await api('/api/status');
      var g = s.git;
      var gitPill = $('gitPill');
      if (!g.isRepo) {
        gitPill.textContent = '非 Git 仓库';
        gitPill.className = 'pill';
      } else {
        var parts = [g.branch || '?'];
        if (g.dirtyCount) parts.push(g.dirtyCount + ' 处改动');
        if (g.ahead) parts.push(g.ahead + ' 未推送');
        if (g.behind) parts.push(g.behind + ' 落后');
        gitPill.textContent = parts.join(' · ');
        gitPill.className = 'pill ' + (g.dirtyCount || g.ahead ? 'dirty' : 'ok');
        gitPill.title = g.dirty
          ? g.dirty.slice(0, 12).map(function (d) { return d.status + ' ' + d.file; }).join('\n')
          : '工作区干净';
      }

      var depPill = $('deployPill');
      if (s.deploy.needsDeploy) {
        depPill.textContent = '有改动未发布';
        depPill.className = 'pill warn';
        depPill.title = '源码最近修改：' + fmtTime(s.deploy.newestSourceAt) +
          '\n上次发布：' + fmtTime(s.deploy.lastDeployedAt);
      } else {
        depPill.textContent = '已是最新';
        depPill.className = 'pill ok';
        depPill.title = '上次发布：' + fmtTime(s.deploy.lastDeployedAt);
      }

      var kv = [
        ['分支', g.branch || '—'],
        ['未提交', g.dirtyCount + ' 处'],
        ['未推送', g.ahead + ' 个提交'],
        ['上次提交', g.lastCommit ? g.lastCommit.hash + ' ' + fmtTime(g.lastCommit.time) : '—'],
        ['上次发布', fmtTime(s.deploy.lastDeployedAt)],
        ['源码修改', fmtTime(s.deploy.newestSourceAt)]
      ];
      $('statusKv').innerHTML = kv.map(function (row) {
        return '<div><dt>' + row[0] + '</dt><dd>' + esc(row[1]) + '</dd></div>';
      }).join('');
    } catch (e) {
      $('gitPill').textContent = '状态读取失败';
    }
  }

  async function refreshImageStats() {
    if (!BOOT || !BOOT.site) return;
    try {
      var imgs = await api('/api/images');
      var total = imgs.reduce(function (a, b) { return a + b.size; }, 0);
      var big = imgs.filter(function (i) { return i.size > 2 * 1024 * 1024; }).length;
      $('imageStats').innerHTML =
        imgs.length + ' 张，共 <b>' + fmtBytes(total) + '</b>' +
        (big ? '<br>其中 ' + big + ' 张超过 2 MB' : '') +
        '<br><button class="btn small" id="unusedBtn" style="margin-top:8px">检查未引用的图片</button>';
      var ub = $('unusedBtn');
      if (ub) ub.addEventListener('click', showUnused);
    } catch (e) {
      $('imageStats').textContent = '读取失败';
    }
  }

  async function showUnused() {
    try {
      var list = await api('/api/images/unused');
      if (!list.length) { toast('没有未引用的图片，很干净'); return; }
      var msg = '这 ' + list.length + ' 张图没被任何文章引用，共 ' +
        fmtBytes(list.reduce(function (a, b) { return a + b.size; }, 0)) + '：\n\n' +
        list.slice(0, 15).map(function (x) { return '· ' + x.rel + '  (' + fmtBytes(x.size) + ')'; }).join('\n') +
        (list.length > 15 ? '\n…还有 ' + (list.length - 15) + ' 张' : '') +
        '\n\n（本工具不会自动删，需要你自己去源目录处理）';
      alert(msg);
    } catch (e) {
      toast('检查失败：' + e.message);
    }
  }

  /* ---------------- 压缩设置 ---------------- */

  function renderCompressUI() {
    var c = BOOT.config.compress || {};
    var presets = BOOT.presets || {};
    $('presetRow').innerHTML = Object.keys(presets).map(function (k) {
      var p = presets[k];
      return '<button class="preset' + (c.preset === k ? ' active' : '') + '" data-k="' + k + '">' +
        esc(p.label.split(' · ')[0]) + '<br><small>' + esc(p.label.split(' · ')[1] || '') + '</small></button>';
    }).join('');
    Array.prototype.forEach.call($('presetRow').children, function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.getAttribute('data-k');
        var p = presets[k];
        saveCompress({ preset: k, maxEdge: p.maxEdge, quality: p.quality });
      });
    });
    $('edgeRange').value = c.maxEdge;
    $('edgeVal').textContent = c.maxEdge === 0 ? '不缩放' : c.maxEdge;
    $('qualityRange').value = c.quality;
    $('qualityVal').textContent = c.quality;
    $('keepOriginal').checked = !!BOOT.config.keepOriginal;
  }

  async function saveCompress(patch) {
    var body = {};
    if (patch) {
      body.compress = Object.assign({}, BOOT.config.compress, patch);
      if (!patch.preset) body.compress.preset = 'custom';
    } else {
      body.compress = {
        preset: 'custom',
        maxEdge: Number($('edgeRange').value),
        quality: Number($('qualityRange').value)
      };
    }
    var r = await api('/api/config', { method: 'POST', body: body });
    BOOT.config = r.config;
    renderCompressUI();
    toast('压缩设置已保存');
  }

  /* ---------------- 发布 ---------------- */

  /** 清空发布面板：切换文章、换页签、刷新页面时都要调用，避免上次的「✓ 完成」赖着不走 */
  function clearPublishPanel() {
    $('publishLog').textContent = '';
    $('publishLogBar').hidden = true;
    var n = $('publishNotice');
    n.hidden = true;
    n.textContent = '';
    n.className = 'publish-notice';
  }

  function showPublishNotice(html, isFail) {
    var n = $('publishNotice');
    n.innerHTML = html;
    n.className = 'publish-notice' + (isFail ? ' fail' : '');
    n.hidden = false;
  }

  async function doPublish(deploy) {
    if (!BOOT || !BOOT.site) return;
    var btns = [$('publishBtn'), $('generateBtn')];
    btns.forEach(function (b) { b.disabled = true; });

    var logEl = $('publishLog');
    logEl.textContent = '';
    $('publishNotice').hidden = true;
    $('publishLogBar').hidden = false;
    $('publishLogTitle').textContent = deploy ? '正在清理并发布…' : '正在生成…';

    var lineCount = 0;
    var addLine = function (text, cls) {
      // 输出可能很多，只留最近 400 行，避免面板越拖越长
      if (lineCount > 400) {
        if (logEl.firstChild) logEl.removeChild(logEl.firstChild);
      } else {
        lineCount += 1;
      }
      var span = document.createElement('div');
      if (cls) span.className = cls;
      span.textContent = text;
      logEl.appendChild(span);
      logEl.scrollTop = logEl.scrollHeight;
    };

    var failed = false;
    try {
      var res = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploy: !!deploy })
      });
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        var lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(function (line) {
          if (!line.trim()) return;
          var obj;
          try { obj = JSON.parse(line); } catch (e) { return; }
          if (obj.type === 'line') addLine(obj.text);
          else if (obj.type === 'step') addLine('▸ ' + obj.text);
          else if (obj.type === 'start') addLine(obj.text);
          else if (obj.type === 'error') { addLine('✗ ' + obj.text, 'err'); failed = true; }
          else if (obj.type === 'done') {
            addLine(obj.ok ? '✓ 完成' : '✗ 失败', obj.ok ? 'ok' : 'err');
            if (!obj.ok) failed = true;
          }
        });
      }

      $('publishLogTitle').textContent = '输出';

      if (failed) {
        showPublishNotice(
          '<b>✗ 发布失败</b><br>下面是完整输出，往上翻看是哪一步报的错。',
          true
        );
      } else if (deploy) {
        showPublishNotice(
          '<b>✓ 已发布</b><br>' +
          'GitHub Pages 需要 <b>1~2 分钟</b>构建，现在刷新博客还看不到新内容，稍等一下再刷新。'
        );
      } else {
        showPublishNotice(
          '<b>✓ 已在本地生成</b><br>' +
          '这次<b>没有推送</b>到线上，只是把文件生成到了 public/。要上线请点「生成并发布」。'
        );
      }
      refreshStatus();
    } catch (e) {
      $('publishLogTitle').textContent = '输出';
      addLine('发布失败：' + e.message, 'err');
      showPublishNotice('<b>✗ 发布失败</b><br>' + esc(e.message), true);
    } finally {
      btns.forEach(function (b) { b.disabled = false; });
    }
  }

  /** 撤回修改：恢复到此文件上次提交（git HEAD）的版本 */
  async function revertCurrent() {
    if (!CURRENT) return;
    var kindName = CURRENT.kind === 'page' ? '这个页面' : '这篇文章';
    var ok = confirm(
      '把' + kindName + '恢复到「上次提交（git）」的版本？\n\n' +
      '你现在的内容会先备份到博客根目录的 .post-studio-trash 里，不会丢。'
    );
    if (!ok) return;

    try {
      var r = await api('/api/revert', {
        method: 'POST',
        body: { kind: CURRENT.kind, key: CURRENT.key }
      });
      if (r.unchanged) {
        toast(r.message);
        return;
      }
      DIRTY = false;
      if (CURRENT.kind === 'page') await selectPage(CURRENT.key);
      else await selectPost(CURRENT.key);
      refreshStatus();
      toast('已撤回修改，旧内容备份在 .post-studio-trash');
    } catch (e) {
      toast('撤回失败：' + e.message);
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    $('dirOpenBtn').addEventListener('click', openDir);
    $('dirInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') openDir(); });
    $('changeDirBtn').addEventListener('click', function () {
      $('dirInput').value = (BOOT.config && BOOT.config.blogDir) || '';
      $('openModal').classList.add('show');
      $('dirInput').focus();
    });

    $('searchInput').addEventListener('input', renderPosts);

    Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
      b.addEventListener('click', function () { switchView(b.getAttribute('data-view')); });
    });

    $('postList').addEventListener('click', function (e) {
      var item = e.target.closest('.post-item');
      if (!item) return;
      if (item.hasAttribute('data-rel')) selectPage(item.getAttribute('data-rel'));
      else selectPost(item.getAttribute('data-id'));
    });

    $('newPostBtn').addEventListener('click', newPost);
    $('saveBtn').addEventListener('click', savePost);
    $('delBtn').addEventListener('click', deletePost);
    $('revertBtn').addEventListener('click', revertCurrent);
    $('clearLogBtn').addEventListener('click', clearPublishPanel);

    ['fTitle', 'fDate', 'fTags', 'fCats', 'fLayout'].forEach(function (id) {
      $(id).addEventListener('input', function () { setDirty(true); });
    });

    $('bodyInput').addEventListener('input', function () {
      setDirty(true);
      updateWordCount();
      refreshPreview();
    });

    $('tabWrite').addEventListener('click', function () { setMode('write'); });
    $('tabPreview').addEventListener('click', function () { setMode('preview'); });
    $('tabSplit').addEventListener('click', function () { setMode('split'); });

    $('pickImageBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      // 先快照再清空：FileList 是实时的，直接清空会让异步上传只看到第一张
      var picked = Array.prototype.slice.call(e.target.files || []);
      e.target.value = ''; // 清空后才能再次选择同一个文件
      uploadFiles(picked);
    });

    // 拖拽图片进编辑器
    var ta = $('bodyInput');
    ta.addEventListener('dragover', function (e) { e.preventDefault(); ta.style.background = 'rgba(57,197,187,.06)'; });
    ta.addEventListener('dragleave', function () { ta.style.background = ''; });
    ta.addEventListener('drop', function (e) {
      e.preventDefault();
      ta.style.background = '';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        uploadFiles(e.dataTransfer.files);
      }
    });

    // 粘贴图片
    ta.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      var files = [];
      for (var i = 0; i < e.clipboardData.items.length; i += 1) {
        var it = e.clipboardData.items[i];
        if (it.kind === 'file') {
          var f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        uploadFiles(files);
      }
    });

    $('edgeRange').addEventListener('input', function () {
      var v = Number(this.value);
      $('edgeVal').textContent = v === 0 ? '不缩放' : v;
    });
    $('edgeRange').addEventListener('change', function () { saveCompress(); });
    $('qualityRange').addEventListener('input', function () { $('qualityVal').textContent = this.value; });
    $('qualityRange').addEventListener('change', function () { saveCompress(); });
    $('keepOriginal').addEventListener('change', async function () {
      var r = await api('/api/config', { method: 'POST', body: { keepOriginal: this.checked } });
      BOOT.config = r.config;
      toast(this.checked ? '会在 原图/ 留一份原图' : '不再保留原图');
    });

    $('refreshStatusBtn').addEventListener('click', function () { refreshStatus(); refreshImageStats(); });
    $('publishBtn').addEventListener('click', function () { doPublish(true); });
    $('generateBtn').addEventListener('click', function () { doPublish(false); });

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (CURRENT) savePost();
      }
    });

    window.addEventListener('beforeunload', function (e) {
      if (DIRTY) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  bind();
  init().catch(function (e) {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:16px;background:#5c1a22;color:#fff">初始化失败：' + esc(e.message) + '</div>');
  });
})();
