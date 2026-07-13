use serde::{Deserialize, Serialize};

/**
 * 默认每页记录数
 */
const DEFAULT_PER_PAGE: u32 = 20;

/**
 * 最大允许的每页记录数
 * 防止客户端请求过多数据导致内存溢出
 */
const MAX_PER_PAGE: u32 = 100;

/**
 * 分页查询参数
 *
 * 用于所有列表API的分页控制
 * 通过URL查询参数传递
 */
#[derive(Debug, Deserialize, Clone)]
pub struct PaginationQuery {
    /**
     * 页码，从1开始
     * 默认值: 1
     */
    pub page: Option<u32>,

    /**
     * 每页记录数
     * 默认值: 20, 最大值: 100
     */
    pub per_page: Option<u32>,
}

impl PaginationQuery {
    /**
     * 获取当前页码（从1开始）
     * @return 当前页码，最小为1
     */
    pub fn page(&self) -> u32 {
        self.page.unwrap_or(1).max(1)
    }

    /**
     * 获取每页记录数（已限制在合理范围内）
     * @return 每页记录数，范围 [1, MAX_PER_PAGE]
     */
    pub fn per_page(&self) -> u32 {
        self.per_page
            .unwrap_or(DEFAULT_PER_PAGE)
            .clamp(1, MAX_PER_PAGE)
    }

    /**
     * 计算数据库查询的OFFSET值
     * @return SQL OFFSET 参数
     */
    pub fn offset(&self) -> u32 {
        (self.page() - 1) * self.per_page()
    }
}

/**
 * 分页响应元数据
 * 包含分页信息，帮助前端构建分页控件
 */
#[derive(Debug, Clone, Serialize)]
pub struct PaginationMeta {
    /// 当前页码
    pub page: u32,
    /// 每页记录数
    pub per_page: u32,
    /// 总记录数
    pub total: u64,
    /// 总页数
    pub total_pages: u32,
    /// 是否有下一页
    pub has_next: bool,
    /// 是否有上一页
    pub has_prev: bool,
}

impl PaginationMeta {
    /**
     * 根据总记录数和分页参数生成分页元数据
     *
     * @param total 总记录数
     * @param pagination 分页查询参数
     * @return 完整的分页元数据
     */
    pub fn new(total: u64, pagination: &PaginationQuery) -> Self {
        let per_page = pagination.per_page() as u64;
        let total_pages = if total == 0 {
            0
        } else {
            ((total + per_page - 1) / per_page) as u32
        };

        let current_page = pagination.page();

        PaginationMeta {
            page: current_page,
            per_page: pagination.per_page(),
            total,
            total_pages,
            has_next: current_page < total_pages,
            has_prev: current_page > 1,
        }
    }
}

/**
 * 通用的分页响应包装器
 * 统一返回格式：{ data: [...], meta: {...} }
 */
#[derive(Debug, Clone, Serialize)]
pub struct PaginatedResponse<T: Serialize> {
    /// 数据列表
    pub data: Vec<T>,
    /// 分页元数据
    #[serde(rename = "meta")]
    pub pagination: PaginationMeta,
}
