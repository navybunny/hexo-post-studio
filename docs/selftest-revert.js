// 测试 /api/revert：恢复已提交版本 + 备份 + 未提交文件的报错
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.env.APP_PORT || 4441;
const FX = process.env.FIXTURE_DIR || path.join(require('os').tmpdir(), 'hps-revert-fx');

const ORIGINAL = `---
title: 原始标题
date: 2026-01-01 00:00:00
tags:
  - 原始标签
---

这是**原始正文**，只应该存在于提交版本里。
`;

// --- 造夹具（--setup 模式只建夹具，因为服务需要它先存在）---
function setup() {
fs.rmSync(FX, { recursive: true, force: true });
fs.mkdirSync(path.join(FX, 'source', '_posts'), { recursive: true });
fs.mkdirSync(path.join(FX, 'source', 'about'), { recursive: true });
fs.mkdirSync(path.join(FX, 'source', 'images'), { recursive: true });
fs.writeFileSync(path.join(FX, '_config.yml'), 'title: revert test\nsource_dir: source\ntheme: x\n', 'utf8');

fs.writeFileSync(path.join(FX, 'source', '_posts', 'demo.md'), ORIGINAL, 'utf8');
fs.writeFileSync(path.join(FX, 'source', 'about', 'index.md'), '---\ntitle: 关于\nlayout: about\n---\n\n原始关于页\n', 'utf8');

execSync('git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init', {
  cwd: FX,
  shell: true
});
}

if (process.argv.indexOf('--setup') >= 0) {
  setup();
  console.log('夹具已创建: ' + FX);
  process.exit(0);
}

// --- 调 API ---
async function call(pathname, opts) {
  const r = await fetch('http://127.0.0.1:' + PORT + pathname, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

(async () => {
  console.log('=== 场景 1：文章改过 -> 撤回 ===');
  await call('/api/posts/demo.md', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { title: '被我改坏的标题', date: '2026-01-01 00:00:00' }, body: '乱改的正文' })
  });
  const afterEdit = fs.readFileSync(path.join(FX, 'source', '_posts', 'demo.md'), 'utf8');
  console.log('  改完后标题:', (afterEdit.match(/^title:.*$/m) || [''])[0]);

  const r1 = await call('/api/revert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'post', key: 'demo.md' })
  });
  console.log('  接口返回 :', r1.message);
  console.log('  备份位置 :', r1.backup ? path.basename(r1.backup) : '(无)');
  const afterRevert = fs.readFileSync(path.join(FX, 'source', '_posts', 'demo.md'), 'utf8');
  console.log('  撤回后标题:', (afterRevert.match(/^title:.*$/m) || [''])[0]);
  console.log('  和原始版本完全一致:', afterRevert === ORIGINAL ? '✅' : '❌');
  console.log('  备份文件存在 :', fs.existsSync(r1.backup) ? '✅' : '❌');
  if (fs.existsSync(r1.backup)) {
    const b = fs.readFileSync(r1.backup, 'utf8');
    console.log('  备份里是被改坏的内容:', b.indexOf('被我改坏') >= 0 ? '✅' : '❌');
  }

  console.log('\n=== 场景 2：没改过就撤回（应提示无需撤回）===');
  const r2 = await call('/api/revert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'post', key: 'demo.md' })
  });
  console.log('  接口返回 :', r2.message, '| unchanged =', r2.unchanged);

  console.log('\n=== 场景 3：页面（关于页）撤回 ===');
  fs.writeFileSync(path.join(FX, 'source', 'about', 'index.md'), '---\ntitle: 关于\n---\n\n胡乱改的关于页\n', 'utf8');
  const r3 = await call('/api/revert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'page', key: 'about/index.md' })
  });
  const p = fs.readFileSync(path.join(FX, 'source', 'about', 'index.md'), 'utf8');
  console.log('  接口返回 :', r3.message);
  console.log('  已恢复   :', p.indexOf('原始关于页') >= 0 ? '✅' : '❌');

  console.log('\n=== 场景 4：从没提交过的新文章 ===');
  await call('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '全新未提交的文章', body: 'x' })
  });
  try {
    await call('/api/revert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'post', key: '全新未提交的文章.md' })
    });
    console.log('  ❌ 应该报错但没报');
  } catch (e) {
    console.log('  正确报错 :', e.message);
  }

  console.log('\n=== 场景 5：备份文件都在 .post-studio-trash ===');
  const trash = path.join(FX, '.post-studio-trash');
  if (fs.existsSync(trash)) {
    fs.readdirSync(trash).forEach((f) => console.log('  ' + f));
  } else {
    console.log('  (没有备份目录)');
  }

  console.log('\n完成。夹具保留在 ' + FX);
})().catch((e) => {
  console.error('测试出错:', e.message);
  process.exit(1);
});
