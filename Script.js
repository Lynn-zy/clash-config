/**
 * Clash Verge 全局精细化规则分流装配脚本 (Global Script)
 *
 * @param {Object} config - 内核完整配置对象
 * @param {string} profileName - 当前订阅名称
 * @returns {Object} 处理后的配置对象
 */
function main(config, profileName) {
  if (!config) config = {};

  // 防御性清除可能残留在 Merge.yaml 中的自定义置顶字段，避免向内核传递未知根属性
  delete config["prepend-rules"];

  // 1. 提取当前订阅中的策略组信息
  const groups = (config["proxy-groups"] || []).map((group) => group.name);
  const groupSet = new Set(groups);

  // 识别当前订阅的主力代理策略组（优先匹配常见命名）
  const defaultProxyGroup =
    ["Proxies", "PROXY", "节点选择", "Proxy", "Auto", "Final", "FINAL"].find(
      (name) => groupSet.has(name),
    ) ||
    groups[0] ||
    "DIRECT";

  // 识别全局兜底策略组（优先保留订阅中的 Final 组，若无则使用主力代理组）
  const finalGroup =
    ["Final", "FINAL", "漏网之鱼", "兜底分流"].find((name) =>
      groupSet.has(name),
    ) || defaultProxyGroup;

  // 辅助函数：根据关键字匹配订阅内对应的策略组（忽略大小写）
  const matchGroup = (keyword, fallback) => {
    const lowerKeyword = keyword.toLowerCase();
    for (const groupName of groups) {
      if (groupName.toLowerCase().includes(lowerKeyword)) {
        return groupName;
      }
    }
    return fallback;
  };

  // 辅助函数：规范化策略组目标
  // DIRECT/REJECT 与订阅中真实存在的策略组放行；无效或未指定时返回空串，
  // 保证各分支能够回退到各自自然的默认语义（如广告集回退 REJECT、直连集回退 DIRECT），避免误伤
  const normalizeTarget = (rawTarget) => {
    const t = String(rawTarget || "").trim();
    if (!t) return "";
    return t === "DIRECT" || t === "REJECT" || groupSet.has(t) ? t : "";
  };

  // 辅助函数：将规则集名称拆分为单词语义词元（支持驼峰命名及各类分隔符）
  const getTokens = (name) => {
    return name
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  };

  // 辅助函数：统一判定规则集是否属于“广谱外网被墙代理”（如 gfw, proxy, proxies, tld-not-cn 等）
  // 确保清洗阶段与分类阶段共用同一套判据，彻底根除分叉判定隐患
  const isBroadProxyName = (name) => {
    const lower = name.toLowerCase();
    const tokens = getTokens(name);
    const isNotCn =
      lower.includes("not-cn") ||
      lower.includes("notcn") ||
      (tokens.includes("not") && tokens.includes("cn"));
    return (
      isNotCn ||
      tokens.some((t) =>
        ["gfw", "proxy", "proxies", "foreign", "greatfire"].includes(t),
      )
    );
  };

  const providers = config["rule-providers"] || {};

  // 2. 清洗原订阅规则并识别已由订阅挂载的合法 RULE-SET
  // 剔除原生的 MATCH、国内/LAN GEOIP 以及指向未定义集合的孤儿 RULE-SET；保留合法的海外 GEOIP（如 GEOIP,JP）
  const originalRules = config.rules || [];
  const handledProviders = new Set();
  const cleanedOriginalRules = [];

  for (const rule of originalRules) {
    const raw = (rule || "").trim();
    const normalized = raw.toLowerCase().replace(/\s+/g, "");

    // 剔除原生的 MATCH 兜底规则，由全局统一收口
    if (normalized.startsWith("match")) {
      continue;
    }

    // 仅清洗原订阅的国内与局域网 GEOIP（消除空格干扰），保留原订阅的海外区域 GEOIP（如 GEOIP,JP）
    if (
      normalized.startsWith("geoip,cn") ||
      normalized.startsWith("geoip,lan")
    ) {
      continue;
    }

    if (normalized.startsWith("rule-set")) {
      const parts = raw.split(",").map((s) => s.trim());
      const providerName = parts[1];
      if (!providerName || !providers[providerName]) {
        // 孤儿 RULE-SET（未定义的 provider）安全剔除，避免内核解析报错
        continue;
      }

      // 广谱代理类集合（使用共享函数判定）：从顶层抽离并交由后续 broadProxyRules 统一沉底处理；
      // 若原订阅指定了有效策略组则予以继承，并借助 normalizeTarget 校验（保留 DIRECT/REJECT 或合法组名）
      if (isBroadProxyName(providerName)) {
        if (
          parts[2] &&
          providers[providerName] &&
          !providers[providerName].target
        ) {
          const inherited = normalizeTarget(parts[2]);
          if (inherited) {
            providers[providerName].target = inherited;
          }
        }
        continue;
      }

      // 其他合法且特化的规则集（如自带的流媒体专用集合），保留在原订阅层级中优先命中
      // 同时防御性校验其目标策略组，若原指定策略组不存在则平滑回退至 defaultProxyGroup，杜绝内核报错
      handledProviders.add(providerName);
      if (parts[2]) {
        const validTarget = normalizeTarget(parts[2]) || defaultProxyGroup;
        const rest = parts.length > 3 ? "," + parts.slice(3).join(",") : "";
        cleanedOriginalRules.push(
          `RULE-SET,${providerName},${validTarget}${rest}`,
        );
      } else {
        cleanedOriginalRules.push(rule);
      }
      continue;
    }

    cleanedOriginalRules.push(rule);
  }

  // 3. 动态扫描所有注册的 rule-providers 并按层级（Tier）解耦分类
  const highPriorityRules = []; // 拦截与内网局域网（最高优先级置顶）
  const specificServiceRules = []; // 特化服务规则集（Apple, Google, Telegram, Netflix 等）
  const domesticDirectRules = []; // 国内域名直连规则集（精准捕获百度、阿里等）
  const broadProxyRules = []; // 广谱外网被墙代理（gfw, proxy, tld-not-cn 等，后置兜底）
  const ipCidrRules = []; // IP-CIDR 规则集（带 no-resolve）

  for (const [name, info] of Object.entries(providers)) {
    // 提前提取并立即清理自定义 target 字段（覆盖 null、空串等假值情况），防止在 continue 早退路径下发生泄漏
    // 规范化 target：DIRECT/REJECT 与真实存在的策略组放行，其余视为未指定（返回空串）以保留各分支自身默认语义
    let target = "";
    if (info && "target" in info) {
      target = normalizeTarget(info.target);
      delete info.target;
    }

    // 若原订阅已经显式包含了该 provider 的规则，则不重复生成覆盖
    if (handledProviders.has(name)) continue;

    const lower = name.toLowerCase();
    const tokens = getTokens(name);

    // 严格以 behavior 为准；仅当 behavior 缺失时，才以名称后缀作为启发式兜底（避免将 classical 误判为 ipcidr）
    const isIp =
      info && info.behavior
        ? info.behavior === "ipcidr"
        : lower.includes("cidr");

    // A. 判定是否为广告/拦截类规则（精准分词匹配，尊重用户显式指定的 target）
    const isReject =
      target === "REJECT" ||
      tokens.some((t) =>
        ["reject", "ad", "ads", "adblock", "adguard", "block"].includes(t),
      );

    if (isReject) {
      highPriorityRules.push(
        `RULE-SET,${name},${target || "REJECT"}${isIp ? ",no-resolve" : ""}`,
      );
      continue;
    }

    // B. 判定是否为局域网/内网/本地应用直连（尊重用户显式指定的 target）
    const isLocal = tokens.some((t) =>
      ["private", "lan", "local", "application", "applications"].includes(t),
    );

    if (isLocal) {
      highPriorityRules.push(
        `RULE-SET,${name},${target || "DIRECT"}${isIp ? ",no-resolve" : ""}`,
      );
      continue;
    }

    // C. 判定是否为 IP-CIDR 类规则
    if (isIp) {
      let ipTarget = target;
      if (!ipTarget) {
        if (
          tokens.some((t) => ["cn", "lan", "direct"].includes(t)) ||
          lower.startsWith("cn") ||
          lower.includes("china") ||
          lower.includes("lancidr")
        ) {
          ipTarget = "DIRECT";
        } else if (lower.includes("telegram")) {
          ipTarget = matchGroup("telegram", defaultProxyGroup);
        } else {
          ipTarget = defaultProxyGroup;
        }
      }
      ipCidrRules.push(`RULE-SET,${name},${ipTarget},no-resolve`);
      continue;
    }

    // D. 判定是否为非大陆或被墙广谱代理集（使用统一共享函数判定）
    const isBroadProxy = isBroadProxyName(name);

    if (isBroadProxy) {
      broadProxyRules.push(`RULE-SET,${name},${target || defaultProxyGroup}`);
      continue;
    }

    // E. 判定是否为国内直连域名集合（显式排除 broadProxy，尊重用户显式指定的 target）
    const isDomestic =
      !isBroadProxy &&
      (target === "DIRECT" ||
        tokens.some((t) =>
          ["direct", "cn", "china", "domestic", "icloud"].includes(t),
        ) ||
        lower.startsWith("cn-") ||
        lower.endsWith("-cn"));

    if (isDomestic) {
      domesticDirectRules.push(`RULE-SET,${name},${target || "DIRECT"}`);
      continue;
    }

    // F. 特化商业/媒体服务集合（Apple, Google, Telegram, Netflix, OpenAI 等）
    let serviceTarget = target;
    if (!serviceTarget) {
      if (tokens.includes("apple"))
        serviceTarget = matchGroup("apple", "DIRECT");
      else if (tokens.includes("google"))
        serviceTarget = matchGroup("google", defaultProxyGroup);
      else if (tokens.includes("telegram"))
        serviceTarget = matchGroup("telegram", defaultProxyGroup);
      else if (tokens.includes("netflix"))
        serviceTarget = matchGroup("netflix", defaultProxyGroup);
      else if (tokens.includes("spotify"))
        serviceTarget = matchGroup("spotify", defaultProxyGroup);
      else if (tokens.includes("steam"))
        serviceTarget = matchGroup("steam", "DIRECT");
      else if (tokens.includes("bilibili"))
        serviceTarget = matchGroup("bilibili", "DIRECT");
      else if (tokens.includes("openai"))
        serviceTarget = matchGroup("openai", defaultProxyGroup);
      else serviceTarget = matchGroup(name, defaultProxyGroup);
    }

    specificServiceRules.push(`RULE-SET,${name},${serviceTarget}`);
  }

  // 4. 按照科学严谨的优先级金字塔重新拼装全量规则
  //
  // 【层级 1】广告拦截与内网本地直连（RULE-SET,reject/applications/private）
  // 【层级 2】订阅与客户端自定义规则（保留客户端手动配置的置顶规则及原订阅 OpenAI、YouTube、Netflix 等原生专属分组）
  // 【层级 3】专精商业服务规则集（补充原订阅未涵盖的服务）
  // 【层级 4】国内主流域名直连（RULE-SET,direct,DIRECT，精准直连百度、腾讯等）
  // 【层级 5】广谱外网被墙代理（RULE-SET,gfw/proxy/tld-not-cn，后置兜底漏网外网）
  // 【层级 6】IP-CIDR 类规则（RULE-SET,cncidr/lancidr/telegramcidr，带 no-resolve）
  // 【层级 7】全局 GEOIP 直连（带 no-resolve 避免 fake-ip DNS 泄漏）
  // 【层级 8】全局最终保底（MATCH,Final）
  const assembledRules = [
    ...highPriorityRules,
    ...cleanedOriginalRules,
    ...specificServiceRules,
    ...domesticDirectRules,
    ...broadProxyRules,
    ...ipCidrRules,
    "GEOIP,LAN,DIRECT,no-resolve",
    "GEOIP,CN,DIRECT,no-resolve",
    `MATCH,${finalGroup}`,
  ];

  // 5. 最终去重保护
  const seenRules = new Set();
  config.rules = assembledRules.filter((rule) => {
    if (seenRules.has(rule)) return false;
    seenRules.add(rule);
    return true;
  });

  // 6. 动态增强 fake-ip 豁免：以订阅原生 fake-ip-filter 为基底，补齐通用兜底项
  //    前提：dns_config.yaml 不声明 fake-ip-filter，订阅的值才能透传到这里
  const dns = config.dns || {};
  if (dns["enhanced-mode"] === "fake-ip") {
    const baseFilter = Array.isArray(dns["fake-ip-filter"])
      ? dns["fake-ip-filter"]
      : [];
    // 兜底项：仅在订阅未提供 fake-ip-filter 时才有实际作用，按失效场景分组维护
    const fallbackFilter = [
      // 保留域与内网：缺失会导致局域网设备发现（mDNS/LLMNR）失效
      "*.arpa",
      "*.home.arpa",
      "*.lan",
      "*.local",
      "*.localdomain",
      "*.localhost",
      "*.example",
      "*.invalid",
      "*.test",
      // 时间同步：被 fake-ip 接管会导致 NTP 校时失败
      "time.*.com",
      "ntp.*.com",
      "+.pool.ntp.org",
      // 主动测量：性能与内网穿透探测
      "speedtest.cros.wr.pvp.net",
      // STUN 打洞：WebRTC 通话、游戏联机依赖真实 IP
      "stun.*.*",
      "stun.*.*.*",
      "*.*.stun.playstation.net",
      // Windows 连通性探测：缺失会误报“无 Internet”
      "*.msftconnecttest.com",
      "*.msftncsi.com",
      "www.msftconnecttest.com",
      // Apple 系统服务：系统更新与推送
      "swscan.apple.com",
      "mesu.apple.com",
      // 游戏主机与平台联机：NAT 类型检测需真实 IP
      "xbox.*.*.microsoft.com",
      "*.*.xboxlive.com",
      "*.ipv6.microsoft.com",
      "teredo.*.*",
      "teredo.*.*.*",
      "*.*.*.srv.nintendo.net",
      // 设备厂商服务
      "+.market.xiaomi.com",
      // 网游加速器链路
      "+.jjvip8.com",
      "+.wotgame.cn",
      "+.wggames.cn",
      "+.wowsgame.cn",
      "+.wargaming.net",
      // 国内音视频与直播：保证 CDN 就近与版权校验
      "localhost.ptlogin2.qq.com",
      "music.163.com",
      "*.music.163.com",
      "*.126.net",
      "musicapi.taihe.com",
      "music.taihe.com",
      "songsearch.kugou.com",
      "trackercdn.kugou.com",
      "*.kuwo.cn",
      "api.joox.com",
      "api-jooxtt.sanook.com",
      "y.qq.com",
      "*.y.qq.com",
      "streamoc.music.tc.qq.com",
      "mobileoc.music.tc.qq.com",
      "isure.stream.qqmusic.qq.com",
      "dl.stream.qqmusic.qq.com",
      "aqqmusic.tc.qq.com",
      "amobile.music.tc.qq.com",
      "*.xiami.com",
      "*.music.migu.cn",
      "music.migu.cn",
      "www.douyu.com",
      "activityapi.huya.com",
      "activityapi.huya.com.w.cdngslb.com",
      "www.bilibili.com",
      "api.bilibili.com",
      "a.w.bilicdn1.com",
    ];
    dns["fake-ip-filter"] = [...new Set([...baseFilter, ...fallbackFilter])];
    config.dns = dns;
  }

  return config;
}
