//! SSRF 防护模块
//!
//! 提供 URL 安全校验，防止 Server-Side Request Forgery 攻击。
//!
//! ## 安全策略
//!
//! 1. **协议白名单**：只允许 `http` 和 `https`，禁止 `file`/`ftp`/`gopher`/`data` 等
//! 2. **IP 黑名单（始终禁止）**：链路本地 / 组播 / 未指定 / 云元数据 / CGNAT / TEST-NET / 保留地址
//!    - 即使在开发模式下也拒绝，防止误访问云元数据服务
//! 3. **IP 黑名单（仅生产禁止）**：loopback / RFC1918 私网 / IPv6 unique local
//!    - 开发模式下允许，方便连接本地 Ollama (127.0.0.1:11434) 等
//! 4. **URL 解析校验**：使用 `url` crate 解析后再校验，不做字符串匹配
//! 5. **DNS rebinding 防护**：解析后的所有目标 IP 都必须通过黑名单校验
//! 6. **绝对 URL 校验**：`path_override` 等绝对 URL 不能绕过安全校验
//! 7. **开发环境开关**：`WOOHOO_DEV_ALLOW_PRIVATE_ENDPOINTS=true` 时允许 loopback / RFC1918
//!    - 生产环境（`RUST_ENV=production`）下设置该变量将拒绝启动

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use url::Url;

use crate::error::{AppError, AppResult};

/// 开发模式开关环境变量名：允许 loopback / RFC1918 私网 endpoint
const DEV_ALLOW_PRIVATE_ENV: &str = "WOOHOO_DEV_ALLOW_PRIVATE_ENDPOINTS";

/// 生产环境标志环境变量名（与 main.rs 中 CORS / JWT 检查保持一致）
const PROD_ENV_NAME: &str = "RUST_ENV";

/// 生产环境标志值
const PROD_ENV_VALUE: &str = "production";

/**
 * 校验用户提供的 endpoint URL 是否安全（读取环境变量判断模式）。
 *
 * 这是 SSRF 防护的主入口，在以下场景调用：
 *   - `create_endpoint` / `update_endpoint`：校验 `base_url`
 *   - `upsert_endpoint_capability`：校验 `path_override`（当为绝对 URL 时）
 *   - `video_gen` / `image_gen` handler：校验 `path_override` 绝对 URL
 *
 * 等价于 `validate_endpoint_url_with(url, dev_mode_allows_private())`。
 *
 * @param url_str 用户提供的 URL 字符串
 * @returns Ok(()) 表示安全；Err(AppError::Validation) 表示不安全
 */
pub async fn validate_endpoint_url(url_str: &str) -> AppResult<()> {
    validate_endpoint_url_with(url_str, dev_mode_allows_private()).await
}

/**
 * 校验用户提供的 endpoint URL 是否安全（参数化版本，供测试使用）。
 *
 * 校验流程：
 *   1. 用 `url` crate 解析 URL（非字符串匹配）
 *   2. scheme 必须是 `http` 或 `https`
 *   3. host 必须存在
 *   4. 若 host 是 IP 字面量，直接校验 IP
 *   5. 若 host 是域名，DNS 解析后校验所有解析到的 IP（防 DNS rebinding）
 *   6. 开发模式下，loopback / RFC1918 私网通过；云元数据 / 链路本地仍拒绝
 *
 * @param url_str 用户提供的 URL 字符串
 * @param dev_mode 是否为开发模式（允许 loopback / RFC1918）
 * @returns Ok(()) 表示安全；Err(AppError::Validation) 表示不安全
 */
pub async fn validate_endpoint_url_with(url_str: &str, dev_mode: bool) -> AppResult<()> {
    let trimmed = url_str.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("URL 不能为空".into()));
    }

    // 步骤 1：用 url crate 解析（非字符串匹配）
    let parsed = Url::parse(trimmed)
        .map_err(|err| AppError::Validation(format!("URL 格式无效: {}", err)))?;

    // 步骤 2：scheme 白名单
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::Validation(format!(
            "仅允许 http/https 协议，收到: {}",
            scheme
        )));
    }

    // 步骤 3：host 必须存在
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::Validation("URL 缺少 host".into()))?;

    // 步骤 4-5：IP / 域名校验（即使在 dev 模式也校验"始终禁止"的黑名单）
    check_host_ips_with(host, dev_mode).await
}

/**
 * 校验 path_override 字段（读取环境变量判断模式）。
 *
 * - 相对路径（如 `/v1/video/generations`）：安全，与已校验的 base_url 拼接，直接放行
 * - 绝对 URL（如 `http://evil.com/api`）：需独立 SSRF 校验，防绕过 base_url
 *
 * 等价于 `validate_path_override_with(path, dev_mode_allows_private())`。
 *
 * @param path_override 待校验的 path_override 值
 */
pub async fn validate_path_override(path_override: &str) -> AppResult<()> {
    validate_path_override_with(path_override, dev_mode_allows_private()).await
}

/**
 * 校验 path_override 字段（参数化版本，供测试使用）。
 *
 * @param path_override 待校验的 path_override 值
 * @param dev_mode 是否为开发模式
 */
pub async fn validate_path_override_with(path_override: &str, dev_mode: bool) -> AppResult<()> {
    let trimmed = path_override.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    if is_absolute_url(trimmed) {
        // 绝对 URL：必须通过完整 SSRF 校验
        validate_endpoint_url_with(trimmed, dev_mode).await?;
    }

    // 相对路径：放行（与已校验的 base_url 拼接）
    Ok(())
}

/**
 * 校验 host 的所有解析 IP 是否安全（参数化版本）。
 *
 * 如果 host 是 IP 字面量，直接校验。
 * 如果 host 是域名，通过 DNS 解析获取所有 IP 后逐一校验。
 * 任一 IP 在黑名单内即拒绝（防 DNS rebinding：攻击者可能在 DNS 响应中
 * 混入私网 IP）。
 *
 * @param host URL 中的 host 部分（可能是 IP 字面量或域名）
 * @param dev_mode 是否为开发模式
 */
async fn check_host_ips_with(host: &str, dev_mode: bool) -> AppResult<()> {
    // 尝试直接解析为 IP 字面量
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip_with(&ip, dev_mode) {
            return Err(AppError::Validation(format!(
                "目标 IP {} 在禁止访问的地址范围内（始终禁止：链路本地/组播/云元数据；生产禁止：loopback/私网）",
                ip
            )));
        }
        return Ok(());
    }

    // 域名：DNS 解析后校验所有 IP（防 DNS rebinding）
    let host_port = format!("{}:80", host);
    let socket_addrs = match tokio::net::lookup_host(host_port).await {
        Ok(addrs) => addrs.collect::<Vec<_>>(),
        Err(err) => {
            return Err(AppError::Validation(format!("DNS 解析失败: {}", err)));
        }
    };

    if socket_addrs.is_empty() {
        return Err(AppError::Validation(format!(
            "DNS 解析未返回任何 IP: {}",
            host
        )));
    }

    for socket_addr in &socket_addrs {
        let ip = socket_addr.ip();
        if is_blocked_ip_with(&ip, dev_mode) {
            return Err(AppError::Validation(format!(
                "域名 {} 解析到禁止访问的 IP {}（始终禁止：链路本地/组播/云元数据；生产禁止：loopback/私网）",
                host, ip
            )));
        }
    }

    Ok(())
}

/**
 * 判断 IP 地址是否在禁止访问的黑名单内（读取环境变量判断模式）。
 *
 * 等价于 `is_blocked_ip_with(ip, dev_mode_allows_private())`。
 *
 * @param ip 待校验的 IP 地址
 * @returns true 表示在黑名单内（禁止访问）；false 表示安全
 */
#[allow(dead_code)]
pub fn is_blocked_ip(ip: &IpAddr) -> bool {
    is_blocked_ip_with(ip, dev_mode_allows_private())
}

/**
 * 判断 IP 地址是否在禁止访问的黑名单内（参数化版本，供测试使用）。
 *
 * 黑名单分两类：
 *   - **始终禁止**（`is_always_blocked_*`）：即使开发模式也拒绝
 *     - IPv4: 0.0.0.0/8、100.64.0.0/10 (CGNAT，含阿里云元数据)、169.254.0.0/16 (链路本地，含 AWS/GCP 元数据)、
 *              192.0.0.0/24、192.0.2.0/24 (TEST-NET-1)、198.18.0.0/15 (benchmark)、
 *              198.51.100.0/24 (TEST-NET-2)、203.0.113.0/24 (TEST-NET-3)、224.0.0.0/4 (组播)、240.0.0.0/4 (保留)
 *     - IPv6: ::/128 (未指定)、fe80::/10 (链路本地)、ff00::/8 (组播)
 *   - **仅生产禁止**（`is_blocked_in_prod_*`）：开发模式允许
 *     - IPv4: 10.0.0.0/8、127.0.0.0/8、172.16.0.0/12、192.168.0.0/16
 *     - IPv6: ::1/128 (loopback)、fc00::/7 (unique local)
 *   - **IPv4-mapped IPv6**（`::ffff:a.b.c.d`）：递归按内嵌 IPv4 校验
 *
 * @param ip 待校验的 IP 地址
 * @param dev_mode 是否为开发模式
 * @returns true 表示在黑名单内（禁止访问）；false 表示安全
 */
pub fn is_blocked_ip_with(ip: &IpAddr, dev_mode: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4_with(v4, dev_mode),
        IpAddr::V6(v6) => is_blocked_ipv6_with(v6, dev_mode),
    }
}

/**
 * IPv4 黑名单校验（参数化版本）。
 *
 * 先校验"始终禁止"集合，再校验"仅生产禁止"集合。
 */
fn is_blocked_ipv4_with(ip: &Ipv4Addr, dev_mode: bool) -> bool {
    if is_always_blocked_ipv4(ip) {
        return true;
    }
    if !dev_mode && is_blocked_in_prod_ipv4(ip) {
        return true;
    }
    false
}

/**
 * IPv6 黑名单校验（参数化版本）。
 *
 * 先校验"始终禁止"集合，再处理 IPv4-mapped IPv6（递归按 IPv4 校验），
 * 最后校验"仅生产禁止"集合。
 */
fn is_blocked_ipv6_with(ip: &Ipv6Addr, dev_mode: bool) -> bool {
    if is_always_blocked_ipv6(ip) {
        return true;
    }

    let segments = ip.segments();

    // IPv4-mapped IPv6: ::ffff:a.b.c.d
    // 递归按内嵌 IPv4 校验（保持 dev_mode 语义）
    if segments[0] == 0
        && segments[1] == 0
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
        && segments[5] == 0xffff
    {
        let v4 = Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            (segments[6] & 0xff) as u8,
            (segments[7] >> 8) as u8,
            (segments[7] & 0xff) as u8,
        );
        return is_blocked_ipv4_with(&v4, dev_mode);
    }

    if !dev_mode && is_blocked_in_prod_ipv6(ip) {
        return true;
    }
    false
}

/**
 * IPv4 始终禁止黑名单（开发模式也拒绝）。
 *
 * 覆盖：云元数据 / 链路本地 / CGNAT / 未指定 / 组播 / 保留 / TEST-NET / benchmark / IETF special。
 * 使用 octet 范围比较，无需额外依赖（如 ipnet crate）。
 */
fn is_always_blocked_ipv4(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();

    // 0.0.0.0/8 — "this network" / 未指定（0.0.0.0）
    if o[0] == 0 {
        return true;
    }

    // 100.64.0.0/10 — CGNAT 共享地址空间（含阿里云元数据 100.100.100.200）
    if o[0] == 100 && (o[1] & 0xc0) == 64 {
        return true;
    }

    // 169.254.0.0/16 — 链路本地（含 AWS / GCP 元数据 169.254.169.254）
    if o[0] == 169 && o[1] == 254 {
        return true;
    }

    // 192.0.0.0/24 — IETF special
    if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        return true;
    }

    // 192.0.2.0/24 — TEST-NET-1
    if o[0] == 192 && o[1] == 0 && o[2] == 2 {
        return true;
    }

    // 198.18.0.0/15 — benchmark
    if o[0] == 198 && (o[1] & 0xfe) == 18 {
        return true;
    }

    // 198.51.100.0/24 — TEST-NET-2
    if o[0] == 198 && o[1] == 51 && o[2] == 100 {
        return true;
    }

    // 203.0.113.0/24 — TEST-NET-3
    if o[0] == 203 && o[1] == 0 && o[2] == 113 {
        return true;
    }

    // 224.0.0.0/4 — 组播
    if (o[0] & 0xf0) == 224 {
        return true;
    }

    // 240.0.0.0/4 — reserved
    if (o[0] & 0xf0) == 240 {
        return true;
    }

    false
}

/**
 * IPv4 仅生产禁止黑名单（开发模式允许）。
 *
 * 覆盖：loopback / RFC1918 私网。
 */
fn is_blocked_in_prod_ipv4(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();

    // 10.0.0.0/8 — 私网 (RFC 1918)
    if o[0] == 10 {
        return true;
    }

    // 127.0.0.0/8 — loopback
    if o[0] == 127 {
        return true;
    }

    // 172.16.0.0/12 — 私网 (RFC 1918)
    if o[0] == 172 && (o[1] & 0xf0) == 16 {
        return true;
    }

    // 192.168.0.0/16 — 私网 (RFC 1918)
    if o[0] == 192 && o[1] == 168 {
        return true;
    }

    false
}

/**
 * IPv6 始终禁止黑名单（开发模式也拒绝）。
 *
 * 覆盖：未指定 / 链路本地 / 组播。
 */
fn is_always_blocked_ipv6(ip: &Ipv6Addr) -> bool {
    let segments = ip.segments();

    // ::/128 — 未指定
    if *ip == Ipv6Addr::UNSPECIFIED {
        return true;
    }

    // fe80::/10 — 链路本地
    if (segments[0] & 0xffc0) == 0xfe80 {
        return true;
    }

    // ff00::/8 — 组播
    if (segments[0] & 0xff00) == 0xff00 {
        return true;
    }

    false
}

/**
 * IPv6 仅生产禁止黑名单（开发模式允许）。
 *
 * 覆盖：loopback / unique local。
 */
fn is_blocked_in_prod_ipv6(ip: &Ipv6Addr) -> bool {
    let segments = ip.segments();

    // ::1/128 — loopback
    if *ip == Ipv6Addr::LOCALHOST {
        return true;
    }

    // fc00::/7 — unique local
    if (segments[0] & 0xfe00) == 0xfc00 {
        return true;
    }

    false
}

/**
 * 判断当前是否处于开发模式（允许 loopback / RFC1918 私网 endpoint）。
 *
 * 通过环境变量 `WOOHOO_DEV_ALLOW_PRIVATE_ENDPOINTS` 控制：
 *   - `true` / `1` / `yes` → 开发模式
 *   - 其他 / 未设置 → 生产模式
 *
 * **安全提示**：生产环境绝不可设置此环境变量。
 * `assert_dev_mode_safe_at_startup()` 会在启动时拦截此情况。
 */
pub fn dev_mode_allows_private() -> bool {
    match std::env::var(DEV_ALLOW_PRIVATE_ENV) {
        Ok(value) => {
            let lower = value.trim().to_ascii_lowercase();
            lower == "true" || lower == "1" || lower == "yes"
        }
        Err(_) => false,
    }
}

/**
 * 判断当前是否为生产环境。
 *
 * 通过环境变量 `RUST_ENV=production` 判断（与 main.rs 中 CORS / JWT 检查保持一致）。
 * 大小写不敏感，前后空白会被忽略。
 */
pub fn is_production_environment() -> bool {
    std::env::var(PROD_ENV_NAME)
        .map(|value| value.trim().eq_ignore_ascii_case(PROD_ENV_VALUE))
        .unwrap_or(false)
}

/**
 * 启动时校验开发模式开关在生产环境下的安全性。
 *
 * 若 `WOOHOO_DEV_ALLOW_PRIVATE_ENDPOINTS=true` 且处于生产环境（`RUST_ENV=production`），
 * 返回错误信息。调用方（main）应直接 panic 拒绝启动。
 *
 * 这是最严重的 SSRF 防护失效配置：会让任何用户都能配置 endpoint 指向内网/云元数据。
 *
 * 应在 main() 启动早期调用，最好在数据库初始化、AI 客户端创建之前。
 *
 * @returns Ok(()) 安全；Err(String) 不安全（含可读错误信息，供 main 显式 panic）
 */
pub fn assert_dev_mode_safe_at_startup() -> Result<(), String> {
    if dev_mode_allows_private() && is_production_environment() {
        return Err(format!(
            "安全配置冲突: {}=true 不能在生产环境（{}=production）下启用，\
             这将允许 SSRF 攻击访问 loopback / RFC1918 私网。\
             请移除该环境变量，或将 {} 设置为 false / 0 / no。",
            DEV_ALLOW_PRIVATE_ENV, PROD_ENV_NAME, DEV_ALLOW_PRIVATE_ENV
        ));
    }
    Ok(())
}

/**
 * 判断字符串是否为绝对 URL（以 http:// 或 https:// 开头）。
 *
 * 用于 `path_override` 场景：相对路径与 base_url 拼接（已校验），
 * 绝对 URL 需独立校验（防绕过 base_url）。
 *
 * @param value 待判断的字符串
 * @returns true 表示是绝对 URL，需要独立 SSRF 校验
 */
pub fn is_absolute_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // =========================================================================
    // 第一部分：纯逻辑测试（不读取 / 修改环境变量，可全并行）
    // =========================================================================

    /// IPv4 始终禁止黑名单（开发模式下也应拒绝）
    #[test]
    fn always_blocked_ipv4_blocks_cloud_metadata_and_link_local() {
        // AWS / GCP 元数据
        assert!(is_blocked_ip_with(
            &"169.254.169.254".parse().unwrap(),
            false
        ));
        assert!(is_blocked_ip_with(
            &"169.254.169.254".parse().unwrap(),
            true
        ));
        // 链路本地
        assert!(is_blocked_ip_with(&"169.254.0.1".parse().unwrap(), false));
        assert!(is_blocked_ip_with(&"169.254.0.1".parse().unwrap(), true));
        // 阿里云元数据 100.100.100.200（属于 CGNAT 100.64.0.0/10）
        assert!(is_blocked_ip_with(
            &"100.100.100.200".parse().unwrap(),
            false
        ));
        assert!(is_blocked_ip_with(
            &"100.100.100.200".parse().unwrap(),
            true
        ));
        // CGNAT 边界
        assert!(is_blocked_ip_with(&"100.64.0.1".parse().unwrap(), true));
        assert!(is_blocked_ip_with(
            &"100.127.255.255".parse().unwrap(),
            true
        ));
        // 0.0.0.0/8
        assert!(is_blocked_ip_with(&"0.0.0.0".parse().unwrap(), true));
        assert!(is_blocked_ip_with(&"0.1.2.3".parse().unwrap(), true));
        // 组播
        assert!(is_blocked_ip_with(&"224.0.0.1".parse().unwrap(), true));
        assert!(is_blocked_ip_with(
            &"239.255.255.255".parse().unwrap(),
            true
        ));
        // reserved
        assert!(is_blocked_ip_with(&"240.0.0.1".parse().unwrap(), true));
        assert!(is_blocked_ip_with(
            &"255.255.255.255".parse().unwrap(),
            true
        ));
        // TEST-NET
        assert!(is_blocked_ip_with(&"192.0.2.1".parse().unwrap(), true));
        assert!(is_blocked_ip_with(&"198.51.100.1".parse().unwrap(), true));
        assert!(is_blocked_ip_with(&"203.0.113.1".parse().unwrap(), true));
        // benchmark
        assert!(is_blocked_ip_with(&"198.18.0.1".parse().unwrap(), true));
        assert!(is_blocked_ip_with(&"198.19.255.255".parse().unwrap(), true));
        // IETF special
        assert!(is_blocked_ip_with(&"192.0.0.1".parse().unwrap(), true));
    }

    /// IPv4 仅生产禁止黑名单（开发模式下应通过）
    #[test]
    fn prod_only_blocked_ipv4_blocks_loopback_and_rfc1918_in_prod() {
        // 生产模式：拒绝
        assert!(is_blocked_ip_with(&"127.0.0.1".parse().unwrap(), false));
        assert!(is_blocked_ip_with(
            &"127.255.255.255".parse().unwrap(),
            false
        ));
        assert!(is_blocked_ip_with(&"10.0.0.1".parse().unwrap(), false));
        assert!(is_blocked_ip_with(
            &"10.255.255.255".parse().unwrap(),
            false
        ));
        assert!(is_blocked_ip_with(&"172.16.0.1".parse().unwrap(), false));
        assert!(is_blocked_ip_with(
            &"172.31.255.255".parse().unwrap(),
            false
        ));
        assert!(is_blocked_ip_with(&"192.168.0.1".parse().unwrap(), false));
        assert!(is_blocked_ip_with(
            &"192.168.255.255".parse().unwrap(),
            false
        ));

        // 开发模式：允许（保持本地 Ollama / 内网开发场景可用）
        assert!(!is_blocked_ip_with(&"127.0.0.1".parse().unwrap(), true));
        assert!(!is_blocked_ip_with(
            &"127.255.255.255".parse().unwrap(),
            true
        ));
        assert!(!is_blocked_ip_with(&"10.0.0.1".parse().unwrap(), true));
        assert!(!is_blocked_ip_with(&"172.16.0.1".parse().unwrap(), true));
        assert!(!is_blocked_ip_with(&"192.168.1.100".parse().unwrap(), true));
    }

    /// IPv6 始终禁止黑名单（开发模式下也应拒绝）
    #[test]
    fn always_blocked_ipv6_blocks_link_local_multicast_unspecified() {
        // 未指定
        assert!(is_blocked_ip_with(&"::".parse().unwrap(), false));
        assert!(is_blocked_ip_with(&"::".parse().unwrap(), true));
        // 链路本地
        assert!(is_blocked_ip_with(&"fe80::1".parse().unwrap(), false));
        assert!(is_blocked_ip_with(&"fe80::1".parse().unwrap(), true));
        assert!(is_blocked_ip_with(&"febf::1".parse().unwrap(), true));
        // 组播
        assert!(is_blocked_ip_with(&"ff00::1".parse().unwrap(), false));
        assert!(is_blocked_ip_with(&"ff00::1".parse().unwrap(), true));
        assert!(is_blocked_ip_with(&"ff02::1".parse().unwrap(), true));
    }

    /// IPv6 仅生产禁止黑名单（开发模式下应通过）
    #[test]
    fn prod_only_blocked_ipv6_blocks_loopback_and_ula_in_prod() {
        // 生产模式：拒绝
        assert!(is_blocked_ip_with(&"::1".parse().unwrap(), false));
        assert!(is_blocked_ip_with(&"fc00::1".parse().unwrap(), false));
        assert!(is_blocked_ip_with(&"fdff::1".parse().unwrap(), false));

        // 开发模式：允许
        assert!(!is_blocked_ip_with(&"::1".parse().unwrap(), true));
        assert!(!is_blocked_ip_with(&"fc00::1".parse().unwrap(), true));
    }

    /// IPv4-mapped IPv6：递归按内嵌 IPv4 校验，保持 dev_mode 语义
    #[test]
    fn ipv4_mapped_ipv6_recurses_with_dev_mode() {
        // 始终禁止（云元数据 / 链路本地）：dev/prod 都拒绝
        assert!(is_blocked_ip_with(
            &"::ffff:169.254.169.254".parse().unwrap(),
            false
        ));
        assert!(is_blocked_ip_with(
            &"::ffff:169.254.169.254".parse().unwrap(),
            true
        ));
        assert!(is_blocked_ip_with(
            &"::ffff:100.100.100.200".parse().unwrap(),
            true
        ));

        // 仅生产禁止（loopback / RFC1918）：dev 允许
        assert!(is_blocked_ip_with(
            &"::ffff:127.0.0.1".parse().unwrap(),
            false
        ));
        assert!(!is_blocked_ip_with(
            &"::ffff:127.0.0.1".parse().unwrap(),
            true
        ));
        assert!(is_blocked_ip_with(
            &"::ffff:10.0.0.1".parse().unwrap(),
            false
        ));
        assert!(!is_blocked_ip_with(
            &"::ffff:10.0.0.1".parse().unwrap(),
            true
        ));

        // 公网 IPv4-mapped：dev/prod 都通过
        assert!(!is_blocked_ip_with(
            &"::ffff:8.8.8.8".parse().unwrap(),
            false
        ));
        assert!(!is_blocked_ip_with(
            &"::ffff:8.8.8.8".parse().unwrap(),
            true
        ));
    }

    /// 公网 IPv4 地址在任何模式下都通过
    #[test]
    fn public_ipv4_passes_in_both_modes() {
        assert!(!is_blocked_ip_with(&"1.1.1.1".parse().unwrap(), false));
        assert!(!is_blocked_ip_with(&"8.8.8.8".parse().unwrap(), false));
        assert!(!is_blocked_ip_with(&"172.32.0.1".parse().unwrap(), false)); // 172.32 不在 172.16/12
        assert!(!is_blocked_ip_with(&"100.128.0.1".parse().unwrap(), false)); // 100.128 不在 CGNAT
        assert!(!is_blocked_ip_with(&"11.0.0.1".parse().unwrap(), false));
        assert!(!is_blocked_ip_with(&"193.0.0.1".parse().unwrap(), false));

        assert!(!is_blocked_ip_with(&"1.1.1.1".parse().unwrap(), true));
        assert!(!is_blocked_ip_with(&"8.8.8.8".parse().unwrap(), true));
    }

    /// 公网 IPv6 地址在任何模式下都通过
    #[test]
    fn public_ipv6_passes_in_both_modes() {
        // 2001:4860:4860::8888 (Google Public DNS)
        assert!(!is_blocked_ip_with(
            &"2001:4860:4860::8888".parse().unwrap(),
            false
        ));
        assert!(!is_blocked_ip_with(
            &"2001:4860:4860::8888".parse().unwrap(),
            true
        ));
        // 2606:4700:4700::1111 (Cloudflare DNS)
        assert!(!is_blocked_ip_with(
            &"2606:4700:4700::1111".parse().unwrap(),
            false
        ));
        assert!(!is_blocked_ip_with(
            &"2606:4700:4700::1111".parse().unwrap(),
            true
        ));
    }

    /// 生产模式 URL 校验：公网通过
    #[tokio::test]
    async fn validate_url_accepts_public_in_prod() {
        assert!(
            validate_endpoint_url_with("https://api.openai.com/v1", false)
                .await
                .is_ok(),
            "公网 HTTPS 应通过"
        );
        assert!(
            validate_endpoint_url_with("http://api.openai.com/v1", false)
                .await
                .is_ok(),
            "公网 HTTP 应通过"
        );
        assert!(
            validate_endpoint_url_with("https://api.openai.com/v1/chat/completions", false)
                .await
                .is_ok(),
            "公网带路径应通过"
        );
        assert!(
            validate_endpoint_url_with("https://api.openai.com/v1?model=gpt-4", false)
                .await
                .is_ok(),
            "公网带查询参数应通过"
        );
        assert!(
            validate_endpoint_url_with("https://user:pass@api.openai.com/v1", false)
                .await
                .is_ok(),
            "公网带 userinfo 应通过"
        );
    }

    /// 生产模式 URL 校验：loopback / 私网 / 链路本地 / 云元数据全部拒绝
    #[tokio::test]
    async fn validate_url_rejects_internal_in_prod() {
        // loopback
        assert!(validate_endpoint_url_with("http://127.0.0.1:8080/", false)
            .await
            .is_err());
        assert!(validate_endpoint_url_with("http://127.255.255.255/", false)
            .await
            .is_err());
        assert!(validate_endpoint_url_with("http://[::1]:8080/", false)
            .await
            .is_err());

        // 0.0.0.0
        assert!(validate_endpoint_url_with("http://0.0.0.0:8080/", false)
            .await
            .is_err());

        // RFC1918
        assert!(validate_endpoint_url_with("http://10.0.0.1/", false)
            .await
            .is_err());
        assert!(validate_endpoint_url_with("http://172.16.0.1/", false)
            .await
            .is_err());
        assert!(validate_endpoint_url_with("http://172.31.255.255/", false)
            .await
            .is_err());
        assert!(validate_endpoint_url_with("http://192.168.1.1/", false)
            .await
            .is_err());

        // 链路本地 + 云元数据
        assert!(validate_endpoint_url_with("http://169.254.0.1/", false)
            .await
            .is_err());
        assert!(
            validate_endpoint_url_with("http://169.254.169.254/latest/meta-data/", false)
                .await
                .is_err()
        );

        // 阿里云元数据
        assert!(
            validate_endpoint_url_with("http://100.100.100.200/latest/meta-data/", false)
                .await
                .is_err()
        );

        // IPv6 链路本地 / ULA / 组播
        assert!(validate_endpoint_url_with("http://[fe80::1]/", false)
            .await
            .is_err());
        assert!(validate_endpoint_url_with("http://[fc00::1]/", false)
            .await
            .is_err());
        assert!(validate_endpoint_url_with("http://[ff02::1]/", false)
            .await
            .is_err());

        // IPv4 组播
        assert!(validate_endpoint_url_with("http://224.0.0.1/", false)
            .await
            .is_err());

        // 带路径 / 查询 / userinfo 的内网
        assert!(
            validate_endpoint_url_with("http://10.0.0.1/api/v1?token=secret", false)
                .await
                .is_err()
        );
        assert!(
            validate_endpoint_url_with("http://user:pass@127.0.0.1/", false)
                .await
                .is_err()
        );
    }

    /// 生产模式 URL 校验：非 http/https 协议拒绝
    #[tokio::test]
    async fn validate_url_rejects_non_http_scheme_in_prod() {
        assert!(validate_endpoint_url_with("ftp://example.com/", false)
            .await
            .is_err());
        assert!(validate_endpoint_url_with("file:///etc/passwd", false)
            .await
            .is_err());
        assert!(validate_endpoint_url_with("gopher://example.com/", false)
            .await
            .is_err());
    }

    /// 生产模式 URL 校验：非法 / 空 / 缺 host URL 拒绝
    #[tokio::test]
    async fn validate_url_rejects_malformed_in_prod() {
        assert!(validate_endpoint_url_with("not a url at all", false)
            .await
            .is_err());
        assert!(validate_endpoint_url_with("http://", false).await.is_err());
        assert!(validate_endpoint_url_with("", false).await.is_err());
        assert!(validate_endpoint_url_with("   ", false).await.is_err());
    }

    /// 开发模式 URL 校验：loopback / RFC1918 通过（保持本地 Ollama 等场景可用）
    #[tokio::test]
    async fn validate_url_allows_loopback_and_rfc1918_in_dev() {
        // Ollama 默认端口
        assert!(
            validate_endpoint_url_with("http://localhost:11434", true)
                .await
                .is_ok(),
            "开发模式 localhost:11434 (Ollama) 应通过"
        );
        assert!(
            validate_endpoint_url_with("http://127.0.0.1:11434", true)
                .await
                .is_ok(),
            "开发模式 127.0.0.1:11434 (Ollama) 应通过"
        );
        assert!(
            validate_endpoint_url_with("http://[::1]:11434", true)
                .await
                .is_ok(),
            "开发模式 [::1]:11434 (IPv6 Ollama) 应通过"
        );

        // RFC1918 私网
        assert!(
            validate_endpoint_url_with("http://192.168.1.100:8080", true)
                .await
                .is_ok(),
            "开发模式 192.168 应通过"
        );
        assert!(
            validate_endpoint_url_with("http://10.0.0.5:8000", true)
                .await
                .is_ok(),
            "开发模式 10.x 应通过"
        );
        assert!(
            validate_endpoint_url_with("http://172.16.0.1:3000", true)
                .await
                .is_ok(),
            "开发模式 172.16 应通过"
        );
    }

    /// 开发模式 URL 校验：云元数据 / 链路本地 / 组播 / 未指定仍拒绝
    #[tokio::test]
    async fn validate_url_still_blocks_cloud_metadata_in_dev() {
        // AWS / GCP 元数据
        assert!(
            validate_endpoint_url_with("http://169.254.169.254/latest/meta-data/", true)
                .await
                .is_err(),
            "开发模式仍拒绝 AWS/GCP 元数据 169.254.169.254"
        );
        // 链路本地
        assert!(
            validate_endpoint_url_with("http://169.254.0.1/", true)
                .await
                .is_err(),
            "开发模式仍拒绝链路本地 169.254.0.1"
        );
        // 阿里云元数据
        assert!(
            validate_endpoint_url_with("http://100.100.100.200/latest/meta-data/", true)
                .await
                .is_err(),
            "开发模式仍拒绝阿里云元数据 100.100.100.200"
        );
        // IPv6 链路本地
        assert!(
            validate_endpoint_url_with("http://[fe80::1]/", true)
                .await
                .is_err(),
            "开发模式仍拒绝 IPv6 链路本地 [fe80::1]"
        );
        // IPv6 组播
        assert!(
            validate_endpoint_url_with("http://[ff02::1]/", true)
                .await
                .is_err(),
            "开发模式仍拒绝 IPv6 组播 [ff02::1]"
        );
        // IPv4 组播
        assert!(
            validate_endpoint_url_with("http://224.0.0.1/", true)
                .await
                .is_err(),
            "开发模式仍拒绝 IPv4 组播 224.0.0.1"
        );
        // 0.0.0.0 未指定
        assert!(
            validate_endpoint_url_with("http://0.0.0.0:8080/", true)
                .await
                .is_err(),
            "开发模式仍拒绝 0.0.0.0"
        );
        // IPv4-mapped 云元数据
        assert!(
            validate_endpoint_url_with("http://[::ffff:169.254.169.254]/", true)
                .await
                .is_err(),
            "开发模式仍拒绝 IPv4-mapped 云元数据"
        );
    }

    /// 开发模式 URL 校验：非 http/https 协议仍拒绝
    #[tokio::test]
    async fn validate_url_rejects_non_http_scheme_in_dev() {
        assert!(
            validate_endpoint_url_with("ftp://127.0.0.1/", true)
                .await
                .is_err(),
            "开发模式仍拒绝 ftp 协议"
        );
        assert!(
            validate_endpoint_url_with("file:///etc/passwd", true)
                .await
                .is_err(),
            "开发模式仍拒绝 file 协议"
        );
    }

    /// 开发模式 URL 校验：公网地址仍通过
    #[tokio::test]
    async fn validate_url_accepts_public_in_dev() {
        assert!(
            validate_endpoint_url_with("https://api.openai.com/v1", true)
                .await
                .is_ok(),
            "开发模式公网 HTTPS 应通过"
        );
    }

    /// is_absolute_url 正确识别绝对 URL
    #[test]
    fn is_absolute_url_identifies_absolute_urls() {
        assert!(is_absolute_url("http://example.com/"));
        assert!(is_absolute_url("https://api.openai.com/v1"));
        assert!(is_absolute_url("HTTP://EXAMPLE.COM/")); // 大写
        assert!(is_absolute_url("  https://example.com  ")); // 带空白

        assert!(!is_absolute_url("/v1/chat/completions"));
        assert!(!is_absolute_url("v1/chat/completions"));
        assert!(!is_absolute_url("ftp://example.com/"));
        assert!(!is_absolute_url(""));
    }

    /// path_override 相对路径在任何模式下都通过
    #[tokio::test]
    async fn validate_path_override_accepts_relative() {
        assert!(
            validate_path_override_with("/v1/video/generations", false)
                .await
                .is_ok(),
            "相对路径应通过"
        );
        assert!(
            validate_path_override_with("v1/responses", false)
                .await
                .is_ok(),
            "无前导斜杠的相对路径应通过"
        );
        assert!(
            validate_path_override_with("", false).await.is_ok(),
            "空 path_override 应通过"
        );
        assert!(validate_path_override_with("/v1/video/generations", true)
            .await
            .is_ok(),);
    }

    /// path_override 绝对 URL：公网通过，内网按模式校验
    #[tokio::test]
    async fn validate_path_override_checks_absolute_url() {
        // 公网绝对 URL 通过
        assert!(
            validate_path_override_with("https://api.openai.com/v1/video/generations", false)
                .await
                .is_ok(),
            "公网绝对 URL path_override 应通过"
        );

        // 内网绝对 URL 在生产模式拒绝
        assert!(
            validate_path_override_with("http://169.254.169.254/latest/meta-data/", false)
                .await
                .is_err(),
            "云元数据绝对 URL path_override 应被拒绝"
        );
        assert!(
            validate_path_override_with("http://127.0.0.1:8080/api", false)
                .await
                .is_err(),
            "localhost 绝对 URL path_override 应被拒绝"
        );

        // 开发模式：loopback 通过，云元数据仍拒绝
        assert!(
            validate_path_override_with("http://127.0.0.1:8080/api", true)
                .await
                .is_ok(),
            "开发模式 loopback path_override 应通过"
        );
        assert!(
            validate_path_override_with("http://169.254.169.254/latest/meta-data/", true)
                .await
                .is_err(),
            "开发模式云元数据 path_override 仍被拒绝"
        );
    }

    /// DNS rebinding 防护：localhost 解析到 127.0.0.1/::1 应在生产模式拒绝
    #[tokio::test]
    async fn dns_rebinding_localhost_resolution_blocked_in_prod() {
        let result = validate_endpoint_url_with("http://localhost/", false).await;
        assert!(
            result.is_err(),
            "localhost 解析到 127.0.0.1/::1 应被拒绝（DNS rebinding 防护）"
        );
    }

    /// DNS rebinding 防护：localhost 在开发模式应通过
    #[tokio::test]
    async fn dns_rebinding_localhost_allowed_in_dev() {
        let result = validate_endpoint_url_with("http://localhost:11434", true).await;
        assert!(
            result.is_ok(),
            "开发模式 localhost 应通过（Ollama 场景）: {:?}",
            result
        );
    }

    /// GCP 元数据域名 metadata.google.internal 应被拒绝
    /// （DNS 解析到 169.254.169.254；即使 DNS 失败也不应通过）
    #[tokio::test]
    async fn validate_url_rejects_gcp_metadata_domain() {
        let result = validate_endpoint_url_with(
            "http://metadata.google.internal/computeMetadata/v1/",
            false,
        )
        .await;
        assert!(result.is_err(), "GCP 元数据地址应被拒绝: {:?}", result);
    }

    /// IP 字面量同步校验路径（不触发 DNS）
    #[tokio::test]
    async fn check_host_ips_blocks_ip_literal() {
        // (host, dev_mode, should_block)
        // dev_mode=true 表示开发模式（允许 loopback / RFC1918）
        // dev_mode=false 表示生产模式（严格执行黑名单）
        let cases: &[(&str, bool, bool)] = &[
            // 127.0.0.1 loopback — 仅生产禁止
            ("127.0.0.1", true, false), // dev: allowed
            ("127.0.0.1", false, true), // prod: blocked
            // 169.254.169.254 链路本地 / 云元数据 — 始终禁止
            ("169.254.169.254", true, true),  // dev: still blocked
            ("169.254.169.254", false, true), // prod: blocked
            // 10.0.0.1 RFC1918 — 仅生产禁止
            ("10.0.0.1", true, false), // dev: allowed
            ("10.0.0.1", false, true), // prod: blocked
            // 192.168.1.1 RFC1918 — 仅生产禁止
            ("192.168.1.1", true, false), // dev: allowed
            ("192.168.1.1", false, true), // prod: blocked
            // 100.100.100.200 阿里云元数据 — 始终禁止（CGNAT 范围）
            ("100.100.100.200", true, true),  // dev: still blocked
            ("100.100.100.200", false, true), // prod: blocked
            // 8.8.8.8 公网 — 任何模式都通过
            ("8.8.8.8", true, false),
            ("8.8.8.8", false, false),
            // 1.1.1.1 公网 — 任何模式都通过
            ("1.1.1.1", true, false),
            ("1.1.1.1", false, false),
        ];
        for (host, dev_mode, should_block) in cases {
            let result = validate_endpoint_url_with(&format!("http://{}/", host), *dev_mode).await;
            if *should_block {
                assert!(result.is_err(), "{} (dev_mode={}) 应被拒绝", host, dev_mode);
            } else {
                assert!(
                    result.is_ok(),
                    "{} (dev_mode={}) 应通过: {:?}",
                    host,
                    dev_mode,
                    result
                );
            }
        }
    }

    /// 重定向目标 IP 拦截能力：所有常见重定向攻击目标都被 is_blocked_ip_with 识别
    #[test]
    fn redirect_attack_targets_all_blocked() {
        let redirect_targets = [
            ("169.254.169.254", true), // AWS/GCP metadata - always blocked
            ("100.100.100.200", true), // Aliyun metadata - always blocked
            ("127.0.0.1", false),      // loopback - blocked in prod only
            ("10.0.0.1", false),       // RFC1918 - blocked in prod only
            ("172.16.0.1", false),
            ("192.168.1.1", false),
            ("::1", false),     // IPv6 loopback
            ("fe80::1", true),  // IPv6 link-local - always
            ("fc00::1", false), // IPv6 ULA
        ];

        for (target, always_blocked) in &redirect_targets {
            let ip: IpAddr = target.parse().unwrap();
            assert!(
                is_blocked_ip_with(&ip, false),
                "生产模式重定向目标 {} 应被识别为黑名单",
                target
            );
            if *always_blocked {
                assert!(
                    is_blocked_ip_with(&ip, true),
                    "开发模式重定向目标 {} 应被识别为始终禁止黑名单",
                    target
                );
            }
        }
    }

    /// DNS rebinding 模拟：解析结果中包含内网 IP 时应被识别为不安全
    #[test]
    fn dns_rebinding_protection_blocks_private_resolution() {
        let simulated_dns_results: Vec<IpAddr> = vec![
            "8.8.8.8".parse().unwrap(),   // 公网 IP
            "127.0.0.1".parse().unwrap(), // 内网 IP（DNS rebinding 注入）
        ];

        let has_blocked = simulated_dns_results
            .iter()
            .any(|ip| is_blocked_ip_with(ip, false));
        assert!(
            has_blocked,
            "DNS 解析结果中包含内网 IP 时应被识别为不安全（DNS rebinding 防护）"
        );

        // 全部公网 IP 应通过
        let all_public: Vec<IpAddr> = vec!["8.8.8.8".parse().unwrap(), "1.1.1.1".parse().unwrap()];
        let all_safe = all_public.iter().all(|ip| !is_blocked_ip_with(ip, false));
        assert!(all_safe, "全部公网 IP 应通过 DNS rebinding 校验");
    }

    // =========================================================================
    // 第二部分：环境变量读取测试（需串行化，避免并行测试相互污染）
    // =========================================================================

    /// 环境变量测试串行化锁：仅用于 dev_mode_allows_private / is_production_environment
    /// / assert_dev_mode_safe_at_startup 这三类直接读取环境变量的测试。
    /// 其他测试使用 _with(dev_mode) 参数化版本，完全不触碰环境变量。
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// 测试辅助：保存并清理相关环境变量，返回用于恢复的 Guard。
    /// 仅供需要直接操作环境变量的少量测试使用。
    struct EnvGuard {
        old_dev: Option<String>,
        old_prod: Option<String>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn acquire() -> Self {
            let lock = ENV_LOCK.lock().unwrap();
            let old_dev = std::env::var(DEV_ALLOW_PRIVATE_ENV).ok();
            let old_prod = std::env::var(PROD_ENV_NAME).ok();
            std::env::remove_var(DEV_ALLOW_PRIVATE_ENV);
            std::env::remove_var(PROD_ENV_NAME);
            Self {
                old_dev,
                old_prod,
                _lock: lock,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = self.old_dev.as_ref() {
                std::env::set_var(DEV_ALLOW_PRIVATE_ENV, value);
            } else {
                std::env::remove_var(DEV_ALLOW_PRIVATE_ENV);
            }
            if let Some(value) = self.old_prod.as_ref() {
                std::env::set_var(PROD_ENV_NAME, value);
            } else {
                std::env::remove_var(PROD_ENV_NAME);
            }
        }
    }

    /// dev_mode_allows_private: 未设置时返回 false
    #[test]
    fn dev_mode_defaults_to_false() {
        let _guard = EnvGuard::acquire();
        assert!(!dev_mode_allows_private(), "未设置环境变量时应为生产模式");
    }

    /// dev_mode_allows_private: true/1/yes/TRUE 等真值返回 true
    #[test]
    fn dev_mode_recognizes_truthy_values() {
        let _guard = EnvGuard::acquire();
        for value in &["true", "1", "yes", "TRUE", "Yes", "  true  "] {
            std::env::set_var(DEV_ALLOW_PRIVATE_ENV, value);
            assert!(dev_mode_allows_private(), "值 {:?} 应识别为开发模式", value);
        }
    }

    /// dev_mode_allows_private: false/0/no/random 等假值返回 false
    #[test]
    fn dev_mode_recognizes_falsy_values() {
        let _guard = EnvGuard::acquire();
        for value in &["false", "0", "no", "random", ""] {
            std::env::set_var(DEV_ALLOW_PRIVATE_ENV, value);
            assert!(
                !dev_mode_allows_private(),
                "值 {:?} 应识别为生产模式",
                value
            );
        }
    }

    /// is_production_environment: 未设置时返回 false
    #[test]
    fn is_production_defaults_to_false() {
        let _guard = EnvGuard::acquire();
        assert!(
            !is_production_environment(),
            "未设置 RUST_ENV 时不应判断为生产环境"
        );
    }

    /// is_production_environment: production/PRODUCTION 等返回 true
    #[test]
    fn is_production_recognizes_production_value() {
        let _guard = EnvGuard::acquire();
        for value in &["production", "PRODUCTION", "Production", "  production  "] {
            std::env::set_var(PROD_ENV_NAME, value);
            assert!(
                is_production_environment(),
                "RUST_ENV={:?} 应识别为生产环境",
                value
            );
        }
    }

    /// is_production_environment: development/staging 等返回 false
    #[test]
    fn is_production_rejects_non_production_value() {
        let _guard = EnvGuard::acquire();
        for value in &["development", "staging", "dev", "test", ""] {
            std::env::set_var(PROD_ENV_NAME, value);
            assert!(
                !is_production_environment(),
                "RUST_ENV={:?} 不应判断为生产环境",
                value
            );
        }
    }

    /// 启动检查：dev=true + prod → 拒绝启动
    #[test]
    fn startup_check_rejects_dev_mode_in_production() {
        let _guard = EnvGuard::acquire();
        std::env::set_var(DEV_ALLOW_PRIVATE_ENV, "true");
        std::env::set_var(PROD_ENV_NAME, "production");
        let result = assert_dev_mode_safe_at_startup();
        assert!(
            result.is_err(),
            "生产环境启用 dev mode 应拒绝启动: {:?}",
            result
        );
        let err = result.unwrap_err();
        assert!(
            err.contains(DEV_ALLOW_PRIVATE_ENV),
            "错误信息应包含环境变量名"
        );
        assert!(err.contains("production"), "错误信息应包含生产环境提示");
    }

    /// 启动检查：dev=true + 非生产 → 允许启动
    #[test]
    fn startup_check_allows_dev_mode_in_non_production() {
        let _guard = EnvGuard::acquire();
        std::env::set_var(DEV_ALLOW_PRIVATE_ENV, "true");
        std::env::set_var(PROD_ENV_NAME, "development");
        assert!(
            assert_dev_mode_safe_at_startup().is_ok(),
            "开发环境启用 dev mode 应允许启动"
        );
    }

    /// 启动检查：dev=false + prod → 允许启动
    #[test]
    fn startup_check_allows_prod_mode_in_production() {
        let _guard = EnvGuard::acquire();
        std::env::set_var(DEV_ALLOW_PRIVATE_ENV, "false");
        std::env::set_var(PROD_ENV_NAME, "production");
        assert!(
            assert_dev_mode_safe_at_startup().is_ok(),
            "生产环境未启用 dev mode 应允许启动"
        );
    }

    /// 启动检查：dev 未设置 + prod 未设置 → 允许启动
    #[test]
    fn startup_check_allows_default() {
        let _guard = EnvGuard::acquire();
        assert!(
            assert_dev_mode_safe_at_startup().is_ok(),
            "默认配置应允许启动"
        );
    }

    /// 启动检查：dev=true + prod 未设置 → 允许启动（明确开发场景）
    #[test]
    fn startup_check_allows_dev_mode_when_prod_unset() {
        let _guard = EnvGuard::acquire();
        std::env::set_var(DEV_ALLOW_PRIVATE_ENV, "true");
        assert!(
            assert_dev_mode_safe_at_startup().is_ok(),
            "未声明生产环境时启用 dev mode 应允许启动（本地开发场景）"
        );
    }
}
