// 验证：1) 发布完成提示  2) 切换文章后日志/提示被清空  3) 撤回按钮存在
const fs = require('fs');
const PORT = process.env.CDP_PORT || 9441;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 1;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = id++;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:4321/' });
  await sleep(2500);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
  };

  console.log('撤回按钮存在 :', await ev(`!!document.getElementById('revertBtn')`));
  console.log('撤回按钮文字 :', await ev(`document.getElementById('revertBtn').textContent`));

  // 打开第一篇文章
  await ev(`document.querySelector('.post-item[data-id]').click()`);
  await sleep(1200);
  console.log('\n打开文章后，日志长度 :', await ev(`document.getElementById('publishLog').textContent.length`));
  console.log('完成提示是否隐藏      :', await ev(`document.getElementById('publishNotice').hidden`));

  // 造一段假的完成状态，模拟"发布完成后"
  console.log('\n--- 模拟一次「仅生成」 ---');
  await ev(`document.getElementById('generateBtn').click()`);
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    const hidden = await ev(`document.getElementById('publishNotice').hidden`);
    if (!hidden) break;
  }
  const noticeText = await ev(`document.getElementById('publishNotice').innerText`);
  const logLen = await ev(`document.getElementById('publishLog').textContent.length`);
  console.log('日志长度        :', logLen);
  console.log('日志栏是否显示  :', await ev(`!document.getElementById('publishLogBar').hidden`));
  console.log('完成提示内容    :\n  ' + String(noticeText).replace(/\n/g, '\n  '));

  // 切到另一篇文章，日志应被清空
  console.log('\n--- 切换到另一篇文章 ---');
  await ev(`
    (function(){
      var items = document.querySelectorAll('.post-item[data-id]');
      for (var i = 0; i < items.length; i++) {
        if (!items[i].classList.contains('active')) { items[i].click(); return true; }
      }
      return false;
    })()
  `);
  await sleep(1500);
  console.log('切换后日志长度     :', await ev(`document.getElementById('publishLog').textContent.length`), '（应为 0）');
  console.log('切换后提示是否隐藏 :', await ev(`document.getElementById('publishNotice').hidden`), '（应为 true）');
  console.log('切换后日志栏隐藏   :', await ev(`document.getElementById('publishLogBar').hidden`), '（应为 true）');

  ws.close();
  console.log('\nDONE');
}
main().catch((e) => {
  console.error('测试出错:', e.message);
  process.exit(1);
});
