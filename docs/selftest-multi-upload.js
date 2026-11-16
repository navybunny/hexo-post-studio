// 验证多图上传：用 DataTransfer 构造 3 个 File，塞进 input 并触发 change
// 需要：Chrome 以 --remote-debugging-port=9222 启动，客户端跑在 APP_PORT 上，
//       IMG_DIR 里放 multi-1.jpg ~ multi-3.jpg 三张测试图
const fs = require('fs');
const os = require('os');
const path = require('path');

const IMG_DIR = process.env.IMG_DIR || path.join(os.tmpdir(), 'hps-img');

const PORT = process.env.CDP_PORT || 9222;
const OUT = process.env.OUT_JSON || path.join(os.tmpdir(), 'hps-multi.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 读现成的 3 张测试图（用 Pillow 生成，绕开 sharp 的 create 接口）
  const b64 = [];
  for (let i = 1; i <= 3; i += 1) {
    const p = path.join(IMG_DIR, `multi-${i}.jpg`);
    b64.push(fs.readFileSync(p).toString('base64'));
  }

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

  const appPort = process.env.APP_PORT || 4321;
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/#post=${encodeURIComponent(process.env.POST_ID || 'a.md')}` });
  await sleep(2500);

  const script = `(async function(){
    var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var input = document.getElementById('fileInput');
    if (!input) return JSON.stringify({ error: '找不到 fileInput' });

    var b64 = ${JSON.stringify(b64)};
    var dt = new DataTransfer();
    b64.forEach(function(s, i){
      var bin = atob(s);
      var arr = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      dt.items.add(new File([arr], 'multi-' + (i+1) + '.jpg', { type: 'image/jpeg' }));
    });
    input.files = dt.files;

    var ta = document.getElementById('bodyInput');
    ta.value = '';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // 等上传完成（3 张，限并发 3）
    for (var w = 0; w < 40; w++) {
      await sleep(500);
      if ((ta.value.match(/!\\[/g) || []).length >= 3) break;
    }
    var imgs = await (await fetch('/api/images')).json();
    return JSON.stringify({
      markdownLines: (ta.value.match(/!\\[/g) || []).length,
      bodyPreview: ta.value.slice(0, 400),
      imagesInDir: imgs.length,
      imageNames: imgs.map(function(x){ return x.name; })
    });
  })()`;

  const r = await send('Runtime.evaluate', {
    expression: script,
    awaitPromise: true,
    returnByValue: true
  });
  const inner = r && r.result;
  const payload = inner && inner.value !== undefined
    ? inner.value
    : JSON.stringify({ exception: inner && inner.exceptionDetails }, null, 2);
  fs.writeFileSync(OUT, payload, 'utf8');
  ws.close();
  console.log('DONE');
}

main().catch((e) => {
  fs.writeFileSync(OUT, JSON.stringify({ error: e.message }), 'utf8');
  process.exit(1);
});
