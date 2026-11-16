'use strict';

/**
 * 发布：在博客目录里跑 hexo 命令，并把输出实时吐给前端。
 *
 * 只调 hexo，不做任何 git 操作。
 * 完整的「发布到线上」= hexo clean → hexo generate --deploy
 * 如果只想本地生成不部署，用 generateOnly。
 */

const { spawn } = require('child_process');

function run(cwd, args, onLine) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('npx', ['hexo'].concat(args), {
        cwd,
        shell: process.platform === 'win32',
        windowsHide: true,
        env: process.env
      });
    } catch (e) {
      onLine('无法启动 npx：' + e.message);
      resolve(1);
      return;
    }

    const feed = (buf) => {
      String(buf)
        .replace(/\u001b\[[0-9;]*m/g, '') // 去掉颜色控制符
        .split(/\r?\n/)
        .forEach((line) => {
          if (line.trim()) onLine(line);
        });
    };

    if (child.stdout) child.stdout.on('data', feed);
    if (child.stderr) child.stderr.on('data', feed);

    child.on('error', (e) => {
      onLine('执行失败：' + e.message);
      resolve(1);
    });
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

/**
 * @param site  站点信息（需要 blogDir）
 * @param opts  { deploy: boolean }
 * @param emit  ({ type, line?, code? }) => void
 */
async function publish(site, opts, emit) {
  const deploy = opts.deploy !== false;
  const cwd = site.blogDir;

  emit({ type: 'start', text: deploy ? '开始清理并发布…' : '开始生成…' });

  emit({ type: 'step', text: 'npx hexo clean' });
  let code = await run(cwd, ['clean'], (line) => emit({ type: 'line', text: line }));
  if (code !== 0) {
    emit({ type: 'error', text: 'hexo clean 失败（退出码 ' + code + '）' });
    emit({ type: 'done', ok: false, code });
    return { ok: false, code };
  }

  const args = deploy ? ['generate', '--deploy'] : ['generate'];
  emit({ type: 'step', text: 'npx hexo ' + args.join(' ') });
  code = await run(cwd, args, (line) => emit({ type: 'line', text: line }));

  if (code === 0) {
    emit({ type: 'done', ok: true, code: 0 });
    return { ok: true, code: 0 };
  }
  emit({ type: 'error', text: '生成/部署失败（退出码 ' + code + '）' });
  emit({ type: 'done', ok: false, code });
  return { ok: false, code };
}

module.exports = { publish };
