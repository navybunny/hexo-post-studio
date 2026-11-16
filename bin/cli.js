#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const { createApp } = require('../server');
const { loadSite } = require('../server/site');
const configStore = require('../server/config');

function parseArgs(argv) {
  const out = { dir: '', port: 4321, open: true };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir' || a === '-d') out.dir = argv[++i] || '';
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || 4321;
    else if (a === '--no-open') out.open = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    /* 打不开就算了，用户手动点链接 */
  }
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') reject(err);
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(
      [
        '',
        '  hexo-post-studio — 本地运行的 Hexo 图文发布工作台',
        '',
        '  用法:',
        '    npx hexo-post-studio                 # 用上次打开的博客目录',
        '    npx hexo-post-studio --dir ./myblog  # 指定博客目录',
        '    npx hexo-post-studio --port 5000     # 指定端口',
        '    npx hexo-post-studio --no-open       # 不自动打开浏览器',
        ''
      ].join('\n')
    );
    return;
  }

  // 目录优先级：命令行 > 配置文件
  const cfg = configStore.read();
  const dir = args.dir || cfg.blogDir;

  const { app, state } = createApp();

  if (dir) {
    try {
      state.site = loadSite(dir);
      configStore.write({ blogDir: state.site.blogDir });
      console.log('  博客目录: ' + state.site.blogDir);
      console.log('  站点名称: ' + (state.site.title || '(未设置)'));
    } catch (e) {
      console.warn('  ⚠ ' + e.message);
      console.warn('  → 启动后请在页面上手动选择博客目录');
      // 记住的目录已经失效（被删或改名），就别一直留着它
      if (!args.dir) {
        try {
          configStore.write({ blogDir: '' });
        } catch (e2) {
          /* 忽略 */
        }
      }
    }
  } else {
    console.log('  还没有指定博客目录，启动后在页面上选一次即可（会记住）');
  }

  let port = args.port;
  let server = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      server = await listen(app, port);
      break;
    } catch (e) {
      port += 1;
    }
  }
  if (!server) {
    console.error('  找不到可用端口，试试 --port 指定一个');
    process.exit(1);
  }

  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('  hexo-post-studio 已启动');
  console.log('  ' + url);
  console.log('  按 Ctrl+C 退出');
  console.log('');

  if (args.open) openBrowser(url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
