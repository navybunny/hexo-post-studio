// 通用性测试：造一个和「海军兔的博客」毫无共同点的 Hexo 博客，看工具还能不能用
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FX = process.env.FIXTURE_DIR || path.join(require('os').tmpdir(), 'hps-alien');
const PORT = process.env.APP_PORT || 4477;
const BASE = 'http://127.0.0.1:' + PORT;

function build() {
  fs.rmSync(FX, { recursive: true, force: true });
  // 1) 源目录不叫 source，叫 src
  // 2) 主题名是个根本不存在的主题
  // 3) 全是英文文章，文件名 ASCII
  // 4) 不是 git 仓库
  // 5) images 目录存在但里面是空的
  fs.mkdirSync(path.join(FX, 'src', '_posts'), { recursive: true });
  fs.mkdirSync(path.join(FX, 'src', 'images'), { recursive: true });
  fs.mkdirSync(path.join(FX, 'src', 'contact'), { recursive: true });
  fs.mkdirSync(path.join(FX, 'themes', 'ghost-theme'), { recursive: true });

  fs.writeFileSync(
    path.join(FX, '_config.yml'),
    `# A completely different blog
title: Another Blog
subtitle: 'just testing'
description: 'A blog that is not the author of this tool.'
author: Somebody Else
language: en
timezone: 'UTC'
url: https://example.com
root: /
permalink: :year/:month/:day/:title/
source_dir: src
public_dir: out
theme: ghost-theme
new_post_name: :year-:month-:day-:title.md
deploy:
  type: ''
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(FX, 'src', '_posts', 'hello-world.md'),
    `---
title: Hello World
date: 2025-06-01 09:30:00
tags:
  - intro
categories: Notes
---

This is a plain English post with **bold** text.

![a picture](/images/sample.jpg)
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(FX, 'src', 'contact', 'index.md'),
    `---
title: Contact
layout: page
---

Reach me at someone@example.com
`,
    'utf8'
  );

  // 一张 ASCII 名字的图
  const sharp = require('F:/hexoblog/hexo-post-studio/node_modules/sharp');
  return sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 120, b: 160 } }
  })
    .jpeg()
    .toFile(path.join(FX, 'src', 'images', 'sample.jpg'));
}

async function j(urlPath, body, method) {
  const m = method || (body ? 'POST' : 'GET');
  const res = await fetch(BASE + urlPath, {
    method: m,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

(async () => {
  if (process.argv.includes('--setup')) {
    await build();
    console.log('已创建「外星博客」:', FX);
    return;
  }

  const results = [];
  const check = (name, pass, extra) => {
    results.push({ name, pass });
    console.log((pass ? '  ✅ ' : '  ❌ ') + name + (extra ? '  ' + extra : ''));
  };

  console.log('=== 1. 识别博客（source_dir=src / 不存在的主题 / 非 git）===');
  const b = await j('/api/bootstrap');
  if (!b.ok) {
    check('打开博客目录', false, JSON.stringify(b.data));
    return finish();
  }
  check('打开博客目录', true);
  console.log('      标题     : ' + b.data.site.title);
  console.log('      作者     : ' + b.data.site.author);
  console.log('      源目录   : ' + b.data.site.sourceDir);
  console.log('      主题     : ' + b.data.site.theme + '（themeDir=' + (b.data.site.themeDir || '空') + '）');
  console.log('      是 git   : ' + b.data.site.isGitRepo);
  console.log('      主题 CSS : ' + (b.data.themeCss.length ? b.data.themeCss.join(', ') : '无（预览将不套样式）'));
  check('source_dir 不是 source 也能认', b.data.site.sourceDir === 'src');
  check('主题不存在时不崩', true);
  check('非 git 仓库不崩', b.data.site.isGitRepo === false);

  console.log('\n=== 2. 文章读取 ===');
  const posts = await j('/api/posts');
  check('列出文章', posts.ok && posts.data.length === 1, '共 ' + (posts.data || []).length + ' 篇');
  if (posts.data && posts.data[0]) console.log('      ' + posts.data[0].title + ' | ' + posts.data[0].date);
  const one = await j('/api/posts/' + encodeURIComponent('hello-world.md'));
  check('读取单篇', one.ok && one.data.body.includes('plain English'));

  console.log('\n=== 3. 新建 / 保存（英文标题 → 文件名）===');
  const created = await j('/api/posts', { title: 'My Second Post', tags: ['test'], categories: 'Notes' });
  check('新建文章', created.ok, created.data.id || JSON.stringify(created.data));
  if (created.ok) {
    const saved = await j('/api/posts/' + encodeURIComponent(created.data.id), {
      data: { title: 'My Second Post', date: '2025-06-02 10:00:00', tags: ['test', 'two'], categories: 'Notes' },
      body: 'Body written by the tool.\n\nSecond paragraph.'
    }, 'PUT');
    check('保存文章', saved.ok);
    const back = await j('/api/posts/' + encodeURIComponent(created.data.id));
    check('保存后内容一致', back.ok && back.data.body.includes('Second paragraph'));
  }

  console.log('\n=== 4. 页面（contact/index.md）===');
  const pages = await j('/api/pages');
  check('列出页面', pages.ok && (pages.data || []).some((p) => p.rel === 'contact/index.md'),
    (pages.data || []).map((p) => p.rel).join(', '));
  const pg = await j('/api/page?rel=' + encodeURIComponent('contact/index.md'));
  check('读取页面', pg.ok && pg.data.body.includes('someone@example.com'));
  check('页面 layout 读到了', pg.ok && pg.data.data.layout === 'page');

  console.log('\n=== 5. 图片 ===');
  const imgs = await j('/api/images');
  check('列出图片', imgs.ok && (imgs.data || []).length === 1,
    (imgs.data || []).map((x) => x.name + ' ' + x.width + 'x' + x.height).join(', '));

  const buf = fs.readFileSync(path.join(FX, 'src', 'images', 'sample.jpg'));
  const up = await fetch(BASE + '/api/upload?name=uploaded.jpg&maxEdge=400&quality=80&keepOriginal=0', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf
  }).then((r) => r.json());
  check('上传压缩', up.url === '/images/uploaded.jpg', up.width + 'x' + up.height + ' ' + Math.round(up.after / 1024) + 'KB');

  console.log('\n=== 6. 状态（非 git 仓库）===');
  const st = await j('/api/status');
  check('状态接口不崩', st.ok && st.data.git.isRepo === false);

  console.log('\n=== 7. 撤回（非 git 仓库，应给出明确错误）===');
  const rv = await j('/api/revert', { kind: 'post', key: 'hello-world.md' });
  check('撤回给出友好错误', !rv.ok && /提交/.test(rv.data.error || ''), rv.data.error);

  finish();

  function finish() {
    const passed = results.filter((r) => r.pass).length;
    console.log('\n────────────────────────────');
    console.log('  通过 ' + passed + ' / ' + results.length);
    console.log('────────────────────────────');
  }
})().catch((e) => {
  console.error('测试异常:', e.message);
  process.exit(1);
});
