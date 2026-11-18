'use strict';

/**
 * 自包含的自动化测试：自己造一个临时 Hexo 博客 → 起服务 → 打接口 → 收尾。
 *
 * 用法：node test/ci.js
 * 退出码 0 = 全部通过，非 0 = 有失败（供 GitHub Actions 判断）
 *
 * 不依赖任何外部服务、不读写你真实的博客目录，可以放心在 CI 里跑。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const results = [];

function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra || '' });
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  —  ' + extra : ''));
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function makeFixture(dir) {
  fs.mkdirSync(path.join(dir, 'source', '_posts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'source', 'images'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'source', 'about'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '_config.yml'),
    [
      'title: CI Test Blog',
      'author: CI',
      'source_dir: source',
      'theme: none',
      'new_post_name: :year-:month-:day-:title.md',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'source', '_posts', 'hello.md'),
    '---\ntitle: 中文标题测试\ndate: "2025-01-02 03:04:05"\ntags:\n  - 测试\n---\n\n正文内容。\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'source', 'about', 'index.md'),
    '---\ntitle: 关于\nlayout: about\n---\n\n关于页内容。\n',
    'utf8'
  );
}

async function waitReady(base, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(base + '/api/bootstrap');
      if (r.ok) return true;
    } catch (e) {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function j(base, urlPath, opts) {
  const o = opts || {};
  const res = await fetch(base + urlPath, {
    method: o.method || (o.body ? 'POST' : 'GET'),
    headers: o.body ? { 'Content-Type': 'application/json' } : {},
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

(async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hps-ci-'));
  makeFixture(fixture);

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  console.log('夹具: ' + fixture);
  console.log('端口: ' + port);
  console.log('');

  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'cli.js'), '--dir', fixture, '--no-open', '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));

  const cleanup = () => {
    try {
      child.kill();
    } catch (e) {
      /* ignore */
    }
    try {
      fs.rmSync(fixture, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  };

  try {
    const ready = await waitReady(base, 30000);
    ok('服务能启动并响应 /api/bootstrap', ready);
    if (!ready) {
      console.log('\n服务日志:\n' + serverLog.slice(-2000));
      cleanup();
      process.exit(1);
    }

    // ---- 基础读取 ----
    const boot = await j(base, '/api/bootstrap');
    ok('识别站点标题', boot.data.site && boot.data.site.title === 'CI Test Blog', boot.data.site && boot.data.site.title);
    ok('识别 source_dir', boot.data.site && boot.data.site.sourceDir === 'source');

    const posts = await j(base, '/api/posts');
    ok('列出文章', posts.ok && posts.data.length === 1, (posts.data || []).length + ' 篇');
    ok('中文标题解析正确', posts.data[0] && posts.data[0].title === '中文标题测试', posts.data[0] && posts.data[0].title);
    ok('日期解析正确', posts.data[0] && posts.data[0].date === '2025-01-02 03:04:05', posts.data[0] && posts.data[0].date);

    const pages = await j(base, '/api/pages');
    ok('列出页面', pages.ok && pages.data.some((p) => p.rel === 'about/index.md'));

    // ---- 读写往返 ----
    const read = await j(base, '/api/posts/' + encodeURIComponent('hello.md'));
    ok('读取文章正文', read.ok && read.data.body.indexOf('正文内容') >= 0);

    const body = '改过的正文\n\n- 项目一\n- 项目二\n';
    const save = await j(base, '/api/posts/' + encodeURIComponent('hello.md'), {
      method: 'PUT',
      body: { data: { title: '改过的标题', date: '2025-01-02 03:04:05', tags: ['新标签'] }, body }
    });
    ok('保存文章', save.ok);

    const back = await j(base, '/api/posts/' + encodeURIComponent('hello.md'));
    ok('保存后标题正确', back.data.data.title === '改过的标题');
    ok('保存后正文正确', back.data.body.trim() === body.trim());
    ok('保存后 front-matter 只有一份', (back.data.raw.match(/^---$/gm) || []).length === 2);

    // ---- 新建文件名遵循 new_post_name ----
    const created = await j(base, '/api/posts', { body: { title: 'My New Post' } });
    ok('新建文章', created.ok, created.data.id);
    ok(
      '新建文件名遵循 new_post_name',
      created.ok && /^\d{4}-\d{2}-\d{2}-My-New-Post\.md$/.test(created.data.id),
      created.data.id
    );

    // ---- 预览转换 ----
    const pv = await j(base, '/api/preview', {
      body: { body: '::: photo-grid\n![](/images/a.jpg)\n![](/images/b.jpg)\n:::' }
    });
    ok('预览把 ::: photo-grid 转成网格', pv.ok && pv.data.html.indexOf('class="photo-grid"') >= 0);

    // ---- 图片上传：文件名清洗 + 内容去重 ----
    const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));
    const imgBuf = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 40, g: 90, b: 140 } }
    })
      .jpeg({ quality: 88 })
      .toBuffer();

    const up1 = await fetch(base + '/api/upload?name=' + encodeURIComponent('_DSC0001 (2).jpg') + '&maxEdge=2560&quality=88&keepOriginal=0', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: imgBuf
    }).then((r) => r.json());
    ok('上传成功', !!up1.url, up1.url);
    ok('文件名去掉了下划线和空格括号', up1.fileName === 'DSC0001-2.jpg', up1.fileName);

    const up2 = await fetch(base + '/api/upload?name=' + encodeURIComponent('another-name.jpg') + '&maxEdge=2560&quality=88&keepOriginal=0', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: imgBuf
    }).then((r) => r.json());
    ok('重复内容被复用而非新建副本', up2.reused === true && up2.fileName === 'DSC0001-2.jpg', up2.fileName);

    const imgs = await j(base, '/api/images');
    ok('目录里只有一张图', imgs.ok && imgs.data.length === 1, (imgs.data || []).length + ' 张');

    // ---- 非 git 仓库的友好降级 ----
    const st = await j(base, '/api/status');
    ok('非 git 仓库状态接口不崩', st.ok && st.data.git.isRepo === false);
    const rv = await j(base, '/api/revert', { body: { kind: 'post', key: 'hello.md' } });
    ok('非 git 仓库撤回给出明确错误', !rv.ok && /提交/.test(rv.data.error || ''), rv.data.error);
  } catch (e) {
    ok('测试过程中没有异常', false, e.message);
  } finally {
    cleanup();
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log('────────────────────────────────');
  console.log('  通过 ' + passed + ' / ' + results.length);
  console.log('────────────────────────────────');

  // 在 GitHub Actions 里，把失败项打成注解，方便直接看到是哪条断言挂了
  // （Actions 的完整日志需要鉴权才能下载，注解是公开可读的）
  if (failed.length && process.env.GITHUB_ACTIONS) {
    for (const f of failed) {
      const msg = (f.name + (f.extra ? ' — ' + f.extra : '')).replace(/\r?\n/g, ' ⏎ ');
      console.log('::error title=测试失败::' + msg.slice(0, 400));
    }
    if (serverLog) {
      const tail = serverLog.slice(-800).replace(/\r?\n/g, ' ⏎ ').replace(/%/g, '%25');
      console.log('::error title=服务端日志::' + tail.slice(0, 800));
    }
  }

  process.exit(passed === results.length ? 0 : 1);
})();
