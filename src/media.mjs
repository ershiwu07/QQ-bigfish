/**
 * 把 QQ 消息里的图片变成 DSH 能吃的图片块（SdkEncodedImageBlock）。
 *
 * 为什么要自己下载：QQ 消息里的图片只是一个 CQ 段（带 url / file），
 * 而 DSH 的 SDK 协议要求把图片以 base64 直接内联进 prompt。
 *
 * 两个现实约束（都在代码里兜住了，失败只会「这张图看不到」，不会让消息处理挂掉）：
 *  1. 只接受 png / jpeg / webp / gif —— 协议只认这四种，靠文件头判断，不信后缀名。
 *  2. DeepSeek 适配器对单张请求图片有体积上限（默认 2 MiB），所以这里默认卡 4 MiB 再留一层余量，
 *     真被上游拒绝时 service.mjs 会去掉图片重试一次。
 */
import fs from 'node:fs';

const SUPPORTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** 靠文件头判断真实格式（后缀名不可信）。 */
export function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

/** 从 http(s) 地址或本地路径把图片字节读出来。 */
async function loadBytes({ url = '', file = '' }, { timeoutMs, maxBytes }) {
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) throw new Error(`图片太大（${mb(declared)} > 上限 ${mb(maxBytes)}）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`图片太大（${mb(buf.length)} > 上限 ${mb(maxBytes)}）`);
    return buf;
  }
  // 本地路径：NapCat 在某些配置下给的是本地文件而不是 http 地址
  for (const cand of [url, file]) {
    if (!cand || typeof cand !== 'string') continue;
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        const size = fs.statSync(cand).size;
        if (size > maxBytes) throw new Error(`图片太大（${mb(size)} > 上限 ${mb(maxBytes)}）`);
        return fs.readFileSync(cand);
      }
    } catch (err) {
      if (String(err.message).includes('太大')) throw err;
      /* 换个候选继续试 */
    }
  }
  throw new Error('拿不到图片内容（既不是可访问的 http 地址，也不是本地文件）');
}

/**
 * 取一张图片并转成 DSH 的图片块。
 *
 * 两级兜底（这是「别人发图它却读不出来」的修复）：
 *   ① 直接用消息里带的 url / 本地路径取；
 *   ② 取不到就问 NapCat 要地址（OneBot 的 get_image 接口）再取一次。
 *      NapCat 默认 enableLocalFile2Url=false，图片段里可能没有可用 url，
 *      file 又只是个文件名 —— 只有第 ② 条路能救。
 *
 * @returns {Promise<{block:{type:'image',data:string,mimeType:string},bytes:number,mime:string}|null>}
 *          返回 null 表示这张图用不了（已记警告），调用方直接忽略即可。
 */
export async function fetchImageBlock(
  src,
  { timeoutMs = 15000, maxBytes = 4 * 1048576, logger, resolveImageUrl, retry = 0 } = {},
) {
  const brief = (s) => String(s ?? '').slice(0, 120);

  const tryLoad = async (candidate) => {
    const buf = await loadBytes(candidate || {}, { timeoutMs, maxBytes });
    const mime = sniffMime(buf);
    if (!mime || !SUPPORTED.includes(mime)) {
      throw new Error('不是支持的图片格式（只支持 png / jpeg / webp / gif）');
    }
    return { block: { type: 'image', data: buf.toString('base64'), mimeType: mime }, bytes: buf.length, mime };
  };

  // 一次尝试：先直连；直连不行就问 NapCat 换地址再试
  const attempt = async () => {
    try {
      return await tryLoad(src);
    } catch (firstErr) {
      if (resolveImageUrl && src && src.file) {
        try {
          const url = await resolveImageUrl(src.file);
          if (url) {
            logger?.debug?.(`图片直连失败（${firstErr.message}），已用 get_image 换到地址，重试`);
            return await tryLoad({ url });
          }
          logger?.debug?.('get_image 没有返回可用地址');
        } catch (err2) {
          logger?.debug?.(`get_image 换地址失败：${err2.message}`);
        }
      }
      throw firstErr;
    }
  };

  // 腾讯 CDN 偶发抽风（超时、502）很常见，重试一次基本就好了 —— 不重试就会
  // 让「有的图能看、有的图看不到」，也就是用户感受到的"识图不稳定"。
  const attempts = 1 + Math.max(0, Math.min(3, Number(retry) || 0));
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        logger?.debug?.(`取图失败（第 ${i + 1} 次，${err.message}），稍后重试`);
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
  }

  logger?.warn(
    `跳过一张图片：${lastErr ? lastErr.message : '未知原因'}（已试 ${attempts} 次）｜原始字段 url="${brief(
      src && src.url,
    )}" file="${brief(src && src.file)}"`,
  );
  return null;
}

/**
 * 按配置收集一条消息里的图片块。
 * @returns {Promise<{blocks:Array, ok:number, failed:number, skipped:number, detected:number}>}
 */
export async function collectImageBlocks(msg, cfg, logger, { resolveImageUrl } = {}) {
  const list = Array.isArray(msg?.imageUrls) ? msg.imageUrls.filter((x) => x && (x.url || x.file)) : [];
  const detected = Number(msg?.images) || list.length;
  const result = { blocks: [], ok: 0, failed: 0, skipped: Math.max(0, detected - list.length), detected };
  if (!cfg || cfg.enabled !== true || detected === 0) return result;
  if (list.length === 0) {
    // 图片段里既没 url 也没 file —— 这种以前是静默跳过的，最难查，现在明确记一笔
    logger?.warn(`这条消息有 ${detected} 张图片，但图片段里没有任何可用地址（url/file 都是空的）`);
    return result;
  }

  const max = Number(cfg.maxPerMessage) > 0 ? Number(cfg.maxPerMessage) : 2;
  const picked = list.slice(0, max);
  result.skipped += Math.max(0, list.length - picked.length);

  const fetched = await Promise.all(
    picked.map((src) =>
      fetchImageBlock(src, {
        timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 15000,
        maxBytes: Number(cfg.maxBytes) > 0 ? Number(cfg.maxBytes) : 4 * 1048576,
        logger,
        resolveImageUrl,
        retry: Number(cfg.retry) >= 0 ? Number(cfg.retry) : 1,
      }),
    ),
  );
  for (const f of fetched) {
    if (f) {
      result.blocks.push(f.block);
      result.ok += 1;
    } else {
      result.failed += 1;
    }
  }
  return result;
}
