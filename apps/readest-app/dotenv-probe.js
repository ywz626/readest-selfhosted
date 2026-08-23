// 探针：验证 dotenv 是否把 .env.tauri.local 的值导出给子进程
const out = {
  base: process.env.NEXT_PUBLIC_API_BASE_URL,
  opts: process.env.NODE_OPTIONS,
  path: process.env.NODE_PATH || null,
};
require('fs').writeFileSync(__dirname + '/dotenv-probe-result.json', JSON.stringify(out, null, 2));
