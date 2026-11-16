// 验证状态接口 + 发布流（deploy:false 只生成，不动线上）
// 用法：node docs/selftest-publish.js
//   环境变量：BASE_URL（默认 http://127.0.0.1:4321）、BLOG_DIR（要检查的 Hexo 博客目录）
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4321';

const j = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
};

(async () => {
  await j('POST', '/api/open', { blogDir: process.env.BLOG_DIR || process.cwd() });
  console.log('=== 已切到真实博客 ===');

  const st = await j('GET', '/api/status');
  console.log('git.isRepo    :', st.git.isRepo);
  console.log('git.branch    :', st.git.branch);
  console.log('git.upstream  :', st.git.upstream);
  console.log('git.dirty     :', st.git.dirtyCount);
  console.log('git.ahead     :', st.git.ahead, ' behind:', st.git.behind);
  console.log('上次提交       :', st.git.lastCommit && st.git.lastCommit.hash, '·', st.git.lastCommit && st.git.lastCommit.subject);
  console.log('上次发布       :', new Date(st.deploy.lastDeployedAt).toLocaleString());
  console.log('源码最新修改   :', new Date(st.deploy.newestSourceAt).toLocaleString());
  console.log('需要重新发布   :', st.deploy.needsDeploy);

  console.log('\n=== 仅生成（流式日志） ===');
  const res = await fetch(BASE + '/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deploy: false })
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let lines = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const line of parts) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      lines += 1;
      if (o.type === 'done') console.log('  [done]', o.ok ? '成功' : '失败');
      else if (o.type === 'step' || o.type === 'error' || o.type === 'start') console.log('  [' + o.type + ']', o.text);
    }
  }
  console.log('流式事件数:', lines);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
