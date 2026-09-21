# Clash Verge 配置增强方案

本项目包含针对 Clash Verge（及兼容客户端）深度定制的配置增强套件，包含精细化 DNS 解析配置、Merge 规则集扩展模板以及全局规则分流装配脚本。

---

## 文件结构与功能说明

### 1. `dns_config.yaml`
- **定位**：DNS 模块独立配置。
- **特性**：
  - 启用 `fake-ip` 增强模式，配合全面的黑名单过滤策略（避免 NTP、游戏联机、国内流媒体及局域网服务等受到污染）。
  - 分离上游 DNS：主查询采用国内高可用 DNS（腾讯云、阿里 DNS），海外加密解析结合 DoH。
  - 针对直连与代理服务实施严格的 DNS 策略隔离。

### 2. `Merge.yaml`
- **定位**：Clash Verge Profile Enhancement Merge 模板。
- **特性**：
  - 配置 GeoData 模式与自动定时更新（采用 Loyalsoldier 高质量规则数据）。
  - 预挂载全量常用的 `rule-providers`（广告拦截、iCloud、Apple、Google、GFW、直连、国内外各类 CIDR 等）。

### 3. `Script.js`
- **定位**：全局扩展脚本（Global Script）。
- **特性**：
  - **策略组智能识别**：自动探测订阅自带的策略组名称（如 Proxies、Auto、Final 等）及专属服务组（Apple、Google、Telegram 等）。
  - **规则清洗与去重**：清除失效孤儿规则、国内/局域网冗余规则及原订阅的 MATCH 兜底。
  - **优先级金字塔重装**：按照「拦截与内网 -> 客户端自定义/原订阅特化 -> 商业服务 -> 国内直连 -> 广谱被墙代理 -> IP-CIDR -> 全局 GEOIP -> 兜底 MATCH」严谨组装。
  - **Fake-IP 动态兜底**：动态扩展 fake-ip 豁免列表，保障联机与系统连通性。

---

## 使用方法（Clash Verge）

1. **Merge 配置**：
   - 在 Clash Verge 的「订阅 / 配置」页面中，为目标订阅挂载或合并 `Merge.yaml`。
2. **全局脚本配置**：
   - 打开 Clash Verge「配置」->「脚本」，将 `Script.js` 的完整内容粘贴至全局扩展脚本中并启用。
3. **DNS 配置**：
   - 可在 Verge 设置或配置合并中引入 `dns_config.yaml` 对应配置。
