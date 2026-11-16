// 用 Node 发 UTF-8 请求，验证中文标题/标签/正文的完整往返
const BASE = 'http://127.0.0.1:4399';
const fs = require('fs');

const j = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
};

(async () => {
  const out = [];

  // 1. 中文标题新建
  const c = await j('POST', '/api/posts', { title: '尼康D4作品集·测试', tags: ['摄影', '测试'] });
  out.push('新建文件名: ' + c.id);

  // 2. 读取保存
  const one = await j('GET', '/api/posts/' + encodeURIComponent(c.id));
  out.push('读出 title: ' + JSON.stringify(one.data.title));
  out.push('读出 tags : ' + JSON.stringify(one.data.tags));

  const body = '# 标题\n\n正文一段。\n\n![照片](/images/DSC_3137.jpg)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
  await j('PUT', '/api/posts/' + encodeURIComponent(c.id), { data: one.data, body });

  // 3. 再读回来，对比
  const two = await j('GET', '/api/posts/' + encodeURIComponent(c.id));
  out.push('正文一致: ' + (two.body.trim() === body.trim()));
  out.push('title 未被改动: ' + (two.data.title === '尼康D4作品集·测试'));
  out.push('tags 未被改动: ' + (JSON.stringify(two.data.tags) === JSON.stringify(['摄影', '测试'])));

  // 4. 原始文件内容
  const raw = fs.readFileSync('F:/hexoblog/_fixture/source/_posts/' + c.id, 'utf8');
  out.push('---- 文件实际内容 ----');
  out.push(raw.split('\n').slice(0, 8).join('\n'));

  // 5. 删除 -> 回收目录
  const del = await j('DELETE', '/api/posts/' + encodeURIComponent(c.id));
  out.push('删除后移到: ' + del.movedTo);
  out.push('原文件已不存在: ' + !fs.existsSync('F:/hexoblog/_fixture/source/_posts/' + c.id));

  console.log(out.join('\n'));
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
