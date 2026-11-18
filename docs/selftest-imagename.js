// 验证：文件名清洗 + 内容去重
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.env.APP_PORT || 4490;
const FX = process.env.FIXTURE_DIR || path.join(require('os').tmpdir(), 'hps-imgname');

function build() {
  fs.rmSync(FX, { recursive: true, force: true });
  fs.mkdirSync(path.join(FX, 'source', '_posts'), { recursive: true });
  fs.mkdirSync(path.join(FX, 'source', 'images'), { recursive: true });
  fs.writeFileSync(path.join(FX, '_config.yml'), 'title: img test\nsource_dir: source\ntheme: x\n', 'utf8');
  fs.writeFileSync(path.join(FX, 'source', '_posts', 'a.md'), '---\ntitle: a\ndate: 2026-01-01 00:00:00\n---\n\nx\n', 'utf8');
}

async function upload(name, buf) {
  const q = new URLSearchParams({ name, maxEdge: '2560', quality: '88', keepOriginal: '0' });
  const r = await fetch('http://127.0.0.1:' + PORT + '/api/upload?' + q, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

(async () => {
  if (process.argv.includes('--setup')) {
    build();
    console.log('夹具已建好:', FX);
    return;
  }

  const sharp = require('F:/hexoblog/hexo-post-studio/node_modules/sharp');
  const img = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 30, g: 120, b: 180 } } })
    .jpeg({ quality: 90 })
    .toBuffer();

  console.log('=== 文件名清洗 ===');
  const names = ['20240201-0001 (2).jpg', 'my photo (1).jpg', '照片 副本（2）.png'];
  for (const n of names) {
    try {
      const r = await upload(n, img);
      console.log('  ' + n.padEnd(26) + ' -> ' + r.fileName + (r.reused ? '  [复用]' : ''));
    } catch (e) {
      console.log('  ' + n.padEnd(26) + ' FAIL ' + e.message);
    }
  }

  console.log('');
  console.log('=== 内容去重（同一张图再传一次）===');
  const r2 = await upload('完全不同的名字.jpg', img);
  console.log('  第二次上传同一张图 -> ' + r2.fileName);
  console.log('  是否复用已有文件    : ' + (r2.reused ? '是 ✅（没有生成 -1 副本）' : '否 ❌'));
  console.log('  提示信息            : ' + (r2.note || '(无)'));

  console.log('');
  console.log('=== 目录里实际有哪些文件 ===');
  fs.readdirSync(path.join(FX, 'source', 'images')).forEach((f) => console.log('  ' + f));
})();
