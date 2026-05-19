//
// 环境变量:
//   CF_API_TOKEN   (Secret)    - Cloudflare API Token,需有目标 zone 的 DNS Edit 权限
//   SHARED_SECRET  (Secret)    - 客户端与 Worker 之间的共享 secret
//   ALLOWED_DOMAINS     (array) - 信任的域名列表，必须是当前账号名下 ["home.example.com","nas.example.com"]
//
// 调用方式:
//   POST /  Header: X-DDNS-Secret: <secret>
//   可选 query: ?name=xxx.example.com  ?ip=1.2.3.4


// 进程内 zone_id 缓存(zone_id 几乎不变,缓存到 isolate 重启即可)
const zoneIdCache = new Map();

export default {
  async fetch(request, env) {
     // 只接受 POST 和 GET
    if (request.method !== 'POST' && request.method !== 'GET') {
      return json({ ok: false, error: 'method not allowed' }, 405);
    }

    const url = new URL(request.url);

     // ① 校验共享 secret(Header 优先,query 兜底)
    const secret =
      request.headers.get('X-DDNS-Secret') ||
      url.searchParams.get('secret');
    if (!secret || secret !== env.SHARED_SECRET) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }

    // ② 解析允许列表(JSON 数组)
    let allowedDomains;
    try {
      allowedDomains = JSON.parse(env.ALLOWED_DOMAINS);
      if (!Array.isArray(allowedDomains)) throw new Error('not array');
    } catch (e) {
      return json(
        { ok: false, error: 'server misconfigured: ALLOWED_DOMAINS must be JSON array' },
        500
      );
    }

    // ③ 确定目标域名
    const recordName =
      url.searchParams.get('name') ||
      allowedDomains[0];
    if (!recordName) {
      return json({ ok: false, error: 'no record name and ALLOWED_DOMAINS empty' }, 400);
    }

    // ④ 白名单校验(精确匹配)
    if (!allowedDomains.includes(recordName)) {
      return json(
        {
          ok: false,
          error: `domain not allowed: ${recordName}`,
          hint: 'add it to ALLOWED_DOMAINS env var',
        },
        403
      );
    }

    // ⑤ 确定 IP:?ip= 优先,否则用 CF-Connecting-IP
    const explicitIP = url.searchParams.get('ip');
    const clientIP = explicitIP || request.headers.get('CF-Connecting-IP');
    if (!clientIP) {
      return json({ ok: false, error: 'cannot determine IP' }, 400);
    }
    // ⑥ 判断记录类型
    const recordType = detectRecordType(clientIP);
    if (!recordType) {
      return json({ ok: false, error: 'invalid IP: ' + clientIP }, 400);
    }

    // ⑥ 自动解析 zone_id(带缓存)
    const apiHeaders = {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    };
    let zoneId;
    try {
      zoneId = await resolveZoneId(recordName, apiHeaders);
    } catch (e) {
      return json(
        { ok: false, error: 'resolve zone failed: ' + e.message },
        502
      );
    }

    // ⑦ 调用 CF DNS API
    const apiBase = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;

    const listResp = await fetch(
      `${apiBase}?type=${recordType}&name=${encodeURIComponent(recordName)}`,
      { headers: apiHeaders }
    );
    const listData = await listResp.json();
    if (!listData.success) {
      return json({ ok: false, error: 'list failed', detail: listData.errors }, 502);
    }

    const record = listData.result[0];
    const body = {
      type: recordType,
      name: recordName,
      content: clientIP,
      ttl: 60,
      proxied: false,
    };

    // ⑧ 决策
    if (!record) {
      const createResp = await fetch(apiBase, {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify(body),
      });
      const createData = await createResp.json();
      if (!createData.success) {
        return json({ ok: false, error: 'create failed', detail: createData.errors }, 502);
      }
      return json({ ok: true, action: 'created', name: recordName, type: recordType, ip: clientIP, zone_id: zoneId });
    }

    if (record.content === clientIP) {
      return json({ ok: true, action: 'unchanged', name: recordName, type: recordType, ip: clientIP });
    }

    const updateResp = await fetch(`${apiBase}/${record.id}`, {
      method: 'PUT',
      headers: apiHeaders,
      body: JSON.stringify(body),
    });
    const updateData = await updateResp.json();
    if (!updateData.success) {
      return json({ ok: false, error: 'update failed', detail: updateData.errors }, 502);
    }
    return json({
      ok: true,
      action: 'updated',
      name: recordName,
      type: recordType,
      ip: clientIP,
      previous_ip: record.content,
    });
  },
};

// 从完整域名逐级猜测根域名,反查 zone_id
async function resolveZoneId(fqdn, apiHeaders) {
  // 先查缓存
  for (const [zoneName, id] of zoneIdCache.entries()) {
    if (fqdn === zoneName || fqdn.endsWith('.' + zoneName)) {
      return id;
    }
  }

  // 逐级剥离子域名尝试匹配
  // a1.home.example.com → ['a1.home.example.com', 'home.example.com', 'example.com', 'com']
  const parts = fqdn.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(candidate)}`,
      { headers: apiHeaders }
    );
    const data = await resp.json();
    if (!data.success) {
      throw new Error(JSON.stringify(data.errors));
    }
    if (data.result && data.result.length > 0) {
      const zoneId = data.result[0].id;
      const zoneName = data.result[0].name;
      zoneIdCache.set(zoneName, zoneId);   // 缓存
      return zoneId;
    }
  }
  throw new Error(`no zone found for ${fqdn}`);
}

function detectRecordType(ip) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    return parts.every(p => p >= 0 && p <= 255) ? 'A' : null;
  }
  if (ip.includes(':') && /^[0-9a-fA-F:]+$/.test(ip)) return 'AAAA';
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}