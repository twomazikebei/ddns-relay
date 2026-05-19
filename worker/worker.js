// Cloudflare Worker DDNS 中继 v1.0
// 通过 DOMAIN_MAP 把多个域名映射到对应 zone_id,集中管理 DDNS 更新
//
// 环境变量:
//   CF_API_TOKEN   (Secret)    - Cloudflare API Token,需有目标 zone 的 DNS Edit 权限
//   SHARED_SECRET  (Secret)    - 客户端与 Worker 之间的共享 secret
//   DOMAIN_MAP     (Plaintext) - JSON 字符串,key=完整域名,value=zone_id
//
// 调用方式:
//   POST /  Header: X-DDNS-Secret: <secret>
//   可选 query: ?name=xxx.example.com  ?ip=1.2.3.4

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

    // ② 解析域名映射表
    let domainMap;
    try {
      domainMap = JSON.parse(env.DOMAIN_MAP);
    } catch (e) {
      return json(
        { ok: false, error: 'server misconfigured: DOMAIN_MAP invalid JSON' },
        500
      );
    }

    // ③ 确定目标域名:?name= 优先,否则取 map 第一个 key
    const recordName =
      url.searchParams.get('name') ||
      Object.keys(domainMap)[0];

    if (!recordName) {
      return json(
        { ok: false, error: 'no record name provided and DOMAIN_MAP empty' },
        400
      );
    }

    // ④ 白名单校验
    const zoneId = domainMap[recordName];
    if (!zoneId) {
      return json(
        {
          ok: false,
          error: `domain not allowed: ${recordName}`,
          hint: 'add it to DOMAIN_MAP env var',
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

    // ⑦ 调用 CF API
    const apiBase = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
    const headers = {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // 查询现有记录
    const listResp = await fetch(
      `${apiBase}?type=${recordType}&name=${encodeURIComponent(recordName)}`,
      { headers }
    );
    const listData = await listResp.json();
    if (!listData.success) {
      return json(
        { ok: false, error: 'list failed', detail: listData.errors },
        502
      );
    }

    const record = listData.result[0];
    const body = {
      type: recordType,
      name: recordName,
      content: clientIP,
      ttl: 60,
      proxied: false,
    };

    // ⑧ 决策分支
    if (!record) {
      // 不存在 → 创建
      const createResp = await fetch(apiBase, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const createData = await createResp.json();
      if (!createData.success) {
        return json(
          { ok: false, error: 'create failed', detail: createData.errors },
          502
        );
      }
      return json({
        ok: true,
        action: 'created',
        name: recordName,
        type: recordType,
        ip: clientIP,
      });
    }

    if (record.content === clientIP) {
      // 已是最新值 → 跳过
      return json({
        ok: true,
        action: 'unchanged',
        name: recordName,
        type: recordType,
        ip: clientIP,
      });
    }

    // IP 变更 → 更新
    const updateResp = await fetch(`${apiBase}/${record.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    const updateData = await updateResp.json();
    if (!updateData.success) {
      return json(
        { ok: false, error: 'update failed', detail: updateData.errors },
        502
      );
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

function detectRecordType(ip) {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.every((p) => p >= 0 && p <= 255)) return 'A';
    return null;
  }
  // IPv6:含冒号且仅含 hex / 冒号
  if (ip.includes(':') && /^[0-9a-fA-F:]+$/.test(ip)) {
    return 'AAAA';
  }
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
