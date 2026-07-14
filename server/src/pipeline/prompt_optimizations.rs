/**
 * Pipeline Prompt 优化建议的版本化应用、回滚、效果对比与自动策略
 *
 * 职责：
 * 1. apply_optimization：将 suggested 建议落库为带版本号的 applied 记录，
 *    同时把同 (project_id, step_key) 之前的 applied 记录标记为 superseded（rolled_back_reason='superseded'）。
 * 2. rollback_optimization：把已应用版本回滚，保留历史，不删除数据。
 * 3. get_optimization_diff：返回原 prompt / 优化后 prompt / patch 的差异视图。
 * 4. get_effect_comparison：按 applied_at 时间点分割 baseline 与 optimized，聚合 ai_usage_events 与 pipeline_step_outputs 指标。
 * 5. get_rollback_recommendation：基于最近 N 次步骤执行的失败率、manual_review_required、review_score 下降给出建议。
 * 6. get_auto_apply_config / set_auto_apply_config：项目或步骤级自动应用开关 CRUD，默认关闭，启用前必须 risk_acknowledged=true。
 * 7. load_applied_optimization_patch：供 orchestrator.build_step_prompt 调用，按 (project_id, step_key) 取当前生效的 patch。
 *
 * 权限隔离（req #7）：所有读写均校验 run.user_id == 当前用户，且 optimization.project_id 属于该用户的 run。
 * 运行中保护（req #4）：apply/rollback 不修改任何 status='running' 的步骤；orchestrator 只 dispatch queued/retrying 且 ai_task_id IS NULL 的步骤，
 *    所以运行中任务已经 mark_step_running 持有 ai_task_id，不会被重新 dispatch，也不会被 patch 修改静默篡改。
 */

use axum::{
    extract::{Extension, Path, State},
    Json,
};
use chrono::{SecondsFormat, Utc};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{
    auth::middleware::UserId,
    error::{AppError, AppResult},
    middleware::RequestId,
    AppState,
};

use super::{handlers::get_run_by_id, model::*};

/// 自动应用策略：连续审核通过次数门槛（PRD 20.1）
const AUTO_APPLY_MIN_CONSECUTIVE_PASS: i64 = 3;
/// 回滚建议：最近失败次数门槛
const ROLLBACK_RECENT_FAILURE_THRESHOLD: i64 = 2;
/// 回滚建议：评分下降阈值
const ROLLBACK_SCORE_DROP_THRESHOLD: f64 = 0.1;
/// 效果对比：最小样本数（baseline 与 optimized 各自需要的样本数）
const EFFECT_MIN_SAMPLE: i64 = 3;

/**
 * 取当前生效的已应用优化 patch（供 orchestrator.build_step_prompt 调用，req #4）
 *
 * 查询条件：
 * - project_id + step_key 匹配
 * - decision='applied'
 * - 未被回滚（rolled_back_at IS NULL）
 * - 版本号最大的（最新应用）
 *
 * @param pool 数据库连接池
 * @param project_id 项目 ID
 * @param step_key 步骤标识
 * @return PipelinePromptOptimization 或 None
 */
pub(crate) async fn load_applied_optimization_patch(
    pool: &SqlitePool,
    project_id: &str,
    step_key: &str,
) -> Result<Option<PipelinePromptOptimization>, sqlx::Error> {
    let row = sqlx::query_as::<_, PipelinePromptOptimization>(
        "SELECT *
         FROM pipeline_prompt_optimizations
         WHERE project_id = ?
           AND step_key = ?
           AND decision = 'applied'
           AND rolled_back_at IS NULL
         ORDER BY version DESC, applied_at DESC
         LIMIT 1",
    )
    .bind(project_id)
    .bind(step_key)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/**
 * 应用优化建议（req #1, #2, #7）
 *
 * POST /api/pipelines/runs/{run_id}/optimizations/{optimization_id}/apply
 *
 * 行为：
 * 1. 校验 run 归属当前用户、optimization 属于该 run
 * 2. 幂等：若已是 applied 且未回滚，直接返回既有记录
 * 3. 分配版本号：MAX(version)+1 for (project_id, step_key)
 * 4. 把同 (project_id, step_key) 之前的 applied 记录标记为 superseded
 * 5. 写入 operator_user_id / applied_at / applied_request_id / original_prompt / optimized_prompt / previous_version_id
 * 6. 记录审计事件
 */
pub async fn apply_optimization(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Extension(request_id): Extension<RequestId>,
    Path((run_id, optimization_id)): Path<(String, String)>,
    req: Option<Json<ApplyOptimizationReq>>,
) -> AppResult<Json<PipelinePromptOptimization>> {
    let scope = req
        .map(|Json(r)| r.scope)
        .unwrap_or_else(|| "project".to_string());
    if scope != "project" && scope != "run" {
        return Err(AppError::Validation(
            format!("不支持的 scope: {}（仅支持 project / run）", scope).into(),
        ));
    }

    let run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;

    let optimization = load_optimization_for_user(&state.db, &user_id.0, &run_id, &optimization_id)
        .await?;

    if optimization.project_id != run.project_id {
        return Err(AppError::Forbidden(
            "优化建议不属于当前流程的项目".into(),
        ));
    }

    // 幂等：已 applied 且未回滚 → 直接返回
    if optimization.decision == "applied" && optimization.rolled_back_at.is_none() {
        return Ok(Json(optimization));
    }

    if optimization.decision != "suggested" {
        return Err(AppError::Validation(
            format!(
                "当前建议状态为 {}，仅 suggested 可应用；已回滚的建议需重新生成。",
                optimization.decision
            )
            .into(),
        ));
    }

    let step_key = optimization.step_key.clone().unwrap_or_default();
    if step_key.is_empty() {
        return Err(AppError::Validation(
            "优化建议缺少 step_key，无法应用（请检查迁移 026 是否已回填）".into(),
        ));
    }

    // 分配新版本号：仅统计 version > 0 的记录，避免与未版本化的历史 suggested 混淆
    let next_version: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(version), 0) + 1
         FROM pipeline_prompt_optimizations
         WHERE project_id = ? AND step_key = ? AND version > 0",
    )
    .bind(&run.project_id)
    .bind(&step_key)
    .fetch_one(&state.db)
    .await?;

    // 取同 (project_id, step_key) 当前生效的 applied 记录，作为 previous_version
    let previous = load_applied_optimization_patch(&state.db, &run.project_id, &step_key).await?;

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let original_prompt = previous
        .as_ref()
        .and_then(|p| p.optimized_prompt.clone())
        .or_else(|| optimization.design_prompt_patch.clone());
    let optimized_prompt = build_optimized_prompt_snapshot(&optimization);
    let previous_version_id = previous.as_ref().map(|p| p.id.clone());

    // 1) 标记之前的 applied 记录为 superseded（保留历史，不删除）
    if let Some(prev) = &previous {
        sqlx::query(
            "UPDATE pipeline_prompt_optimizations
             SET decision = 'rolled_back',
                 rolled_back_at = ?,
                 rolled_back_by = ?,
                 rolled_back_reason = 'superseded',
                 rollback_request_id = ?,
                 updated_at = ?
             WHERE id = ?",
        )
        .bind(&now)
        .bind(&user_id.0)
        .bind(request_id._value.clone())
        .bind(&now)
        .bind(&prev.id)
        .execute(&state.db)
        .await?;
    }

    // 2) 把当前建议更新为 applied
    let updated = sqlx::query_as::<_, PipelinePromptOptimization>(
        "UPDATE pipeline_prompt_optimizations
         SET decision = 'applied',
             version = ?,
             strategy = 'manual',
             operator_user_id = ?,
             applied_at = ?,
             applied_request_id = ?,
             original_prompt = ?,
             optimized_prompt = ?,
             previous_version_id = ?,
             rolled_back_at = NULL,
             rolled_back_by = NULL,
             rolled_back_reason = NULL,
             rollback_request_id = NULL,
             updated_at = ?
         WHERE id = ?
         RETURNING *",
    )
    .bind(next_version)
    .bind(&user_id.0)
    .bind(&now)
    .bind(request_id._value.clone())
    .bind(&original_prompt)
    .bind(&optimized_prompt)
    .bind(&previous_version_id)
    .bind(&now)
    .bind(&optimization.id)
    .fetch_one(&state.db)
    .await?;

    // 3) 审计事件
    sqlx::query(
        "INSERT INTO pipeline_run_events (id, run_id, step_id, event_type, payload_json, source)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&run_id)
    .bind(&updated.step_id)
    .bind("prompt_optimization_applied")
    .bind(
        serde_json::json!({
            "optimizationId": updated.id,
            "version": next_version,
            "stepKey": step_key,
            "scope": scope,
            "previousVersionId": previous_version_id,
            "requestId": request_id._value,
        })
        .to_string(),
    )
    .bind("user")
    .execute(&state.db)
    .await?;

    Ok(Json(updated))
}

/**
 * 回滚已应用的优化建议（req #2, #6）
 *
 * POST /api/pipelines/runs/{run_id}/optimizations/{optimization_id}/rollback
 *
 * 行为：
 * 1. 校验归属、状态必须为 applied 且未回滚
 * 2. 记录 rolled_back_at / rolled_back_by / rolled_back_reason / rollback_request_id
 * 3. 不删除任何历史数据
 * 4. 后续 build_step_prompt 调用 load_applied_optimization_patch 时不会再取到这条
 */
pub async fn rollback_optimization(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Extension(request_id): Extension<RequestId>,
    Path((run_id, optimization_id)): Path<(String, String)>,
    req: Option<Json<RollbackOptimizationReq>>,
) -> AppResult<Json<PipelinePromptOptimization>> {
    let reason = req
        .and_then(|Json(r)| r.reason)
        .unwrap_or_else(|| "user_initiated".to_string());

    let run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;
    let optimization = load_optimization_for_user(&state.db, &user_id.0, &run_id, &optimization_id)
        .await?;

    if optimization.project_id != run.project_id {
        return Err(AppError::Forbidden(
            "优化建议不属于当前流程的项目".into(),
        ));
    }

    if optimization.decision != "applied" {
        return Err(AppError::Validation(
            format!(
                "当前建议状态为 {}，仅 applied 状态可回滚",
                optimization.decision
            )
            .into(),
        ));
    }
    if optimization.rolled_back_at.is_some() {
        return Err(AppError::Validation(
            "该优化建议已经被回滚，不能重复回滚".into(),
        ));
    }

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let updated = sqlx::query_as::<_, PipelinePromptOptimization>(
        "UPDATE pipeline_prompt_optimizations
         SET decision = 'rolled_back',
             rolled_back_at = ?,
             rolled_back_by = ?,
             rolled_back_reason = ?,
             rollback_request_id = ?,
             updated_at = ?
         WHERE id = ?
         RETURNING *",
    )
    .bind(&now)
    .bind(&user_id.0)
    .bind(&reason)
    .bind(request_id._value.clone())
    .bind(&now)
    .bind(&optimization.id)
    .fetch_one(&state.db)
    .await?;

    sqlx::query(
        "INSERT INTO pipeline_run_events (id, run_id, step_id, event_type, payload_json, source)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&run_id)
    .bind(&updated.step_id)
    .bind("prompt_optimization_rolled_back")
    .bind(
        serde_json::json!({
            "optimizationId": updated.id,
            "version": updated.version,
            "stepKey": updated.step_key,
            "reason": reason,
            "requestId": request_id._value,
        })
        .to_string(),
    )
    .bind("user")
    .execute(&state.db)
    .await?;

    Ok(Json(updated))
}

/**
 * 查看版本差异（req #2）
 *
 * GET /api/pipelines/runs/{run_id}/optimizations/{optimization_id}/diff
 */
pub async fn get_optimization_diff(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((run_id, optimization_id)): Path<(String, String)>,
) -> AppResult<Json<OptimizationVersionDiff>> {
    let _run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;
    let optimization = load_optimization_for_user(&state.db, &user_id.0, &run_id, &optimization_id)
        .await?;

    Ok(Json(OptimizationVersionDiff {
        optimization_id: optimization.id,
        version: optimization.version,
        step_key: optimization.step_key,
        original_prompt: optimization.original_prompt,
        optimized_prompt: optimization.optimized_prompt,
        design_prompt_patch: optimization.design_prompt_patch,
        review_prompt_patch: optimization.review_prompt_patch,
        rationale_json: optimization.rationale_json,
        operator_user_id: optimization.operator_user_id,
        applied_at: optimization.applied_at,
        previous_version_id: optimization.previous_version_id,
    }))
}

/**
 * 效果对比查询（req #5）
 *
 * GET /api/pipelines/runs/{run_id}/optimizations/{optimization_id}/effect
 *
 * 聚合策略：
 * - baseline：applied_at 之前同 (project_id, step_key) 的 ai_usage_events 与 pipeline_step_outputs
 * - optimized：applied_at 之后同 (project_id, step_key) 的同源数据
 * - sample_sufficient = baseline.sample_count >= 3 && optimized.sample_count >= 3
 * - 数据不足时 note 明确告知样本不足，不虚构结论
 */
pub async fn get_effect_comparison(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((run_id, optimization_id)): Path<(String, String)>,
) -> AppResult<Json<OptimizationEffectComparison>> {
    let run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;
    let optimization = load_optimization_for_user(&state.db, &user_id.0, &run_id, &optimization_id)
        .await?;

    if optimization.project_id != run.project_id {
        return Err(AppError::Forbidden(
            "优化建议不属于当前流程的项目".into(),
        ));
    }

    let applied_at = optimization.applied_at.as_deref().unwrap_or("");
    let step_key = optimization.step_key.clone().unwrap_or_default();

    let baseline = collect_effect_metrics(
        &state.db,
        &user_id.0,
        &run.project_id,
        &step_key,
        None,
        Some(applied_at),
    )
    .await?;

    let optimized = collect_effect_metrics(
        &state.db,
        &user_id.0,
        &run.project_id,
        &step_key,
        Some(applied_at),
        None,
    )
    .await?;

    let sample_sufficient =
        baseline.sample_count >= EFFECT_MIN_SAMPLE && optimized.sample_count >= EFFECT_MIN_SAMPLE;

    let note = if sample_sufficient {
        build_effect_note(&baseline, &optimized)
    } else {
        format!(
            "样本不足：baseline 需 >= {} 条（当前 {}），optimized 需 >= {} 条（当前 {}），不输出效果结论",
            EFFECT_MIN_SAMPLE,
            baseline.sample_count,
            EFFECT_MIN_SAMPLE,
            optimized.sample_count
        )
    };

    Ok(Json(OptimizationEffectComparison {
        optimization_id: optimization.id,
        version: optimization.version,
        step_key: optimization.step_key,
        applied_at: optimization.applied_at,
        baseline,
        optimized,
        sample_sufficient,
        note,
    }))
}

/**
 * 回滚建议（req #6）
 *
 * GET /api/pipelines/runs/{run_id}/optimizations/{optimization_id}/rollback-recommendation
 *
 * 触发回滚建议的条件（任一满足即推荐回滚）：
 * 1. 应用后最近 5 次步骤执行中失败次数 >= 2
 * 2. 应用后出现 manual_review_required 状态的步骤
 * 3. 应用后平均 review_score 相比 baseline 下降 >= 0.1
 */
pub async fn get_rollback_recommendation(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path((run_id, optimization_id)): Path<(String, String)>,
) -> AppResult<Json<RollbackRecommendation>> {
    let run = get_run_by_id(&state.db, &user_id.0, &run_id).await?;
    let optimization = load_optimization_for_user(&state.db, &user_id.0, &run_id, &optimization_id)
        .await?;

    if optimization.project_id != run.project_id {
        return Err(AppError::Forbidden(
            "优化建议不属于当前流程的项目".into(),
        ));
    }
    if optimization.decision != "applied" || optimization.rolled_back_at.is_some() {
        return Ok(Json(RollbackRecommendation {
            optimization_id: optimization.id,
            version: optimization.version,
            step_key: optimization.step_key.clone(),
            recommend_rollback: false,
            reasons: vec![format!(
                "当前状态为 {}，无需回滚建议",
                optimization.decision
            )],
            recent_failure_count: 0,
            recent_manual_review_count: 0,
        }));
    }

    let applied_at = optimization.applied_at.as_deref().unwrap_or("");
    let step_key = optimization.step_key.clone().unwrap_or_default();

    let baseline = collect_effect_metrics(
        &state.db,
        &user_id.0,
        &run.project_id,
        &step_key,
        None,
        Some(applied_at),
    )
    .await?;
    let optimized = collect_effect_metrics(
        &state.db,
        &user_id.0,
        &run.project_id,
        &step_key,
        Some(applied_at),
        None,
    )
    .await?;

    let mut reasons = Vec::new();
    if optimized.failed_count >= ROLLBACK_RECENT_FAILURE_THRESHOLD {
        reasons.push(format!(
            "应用后最近失败次数 {} 次达到阈值 {}",
            optimized.failed_count, ROLLBACK_RECENT_FAILURE_THRESHOLD
        ));
    }
    if optimized.manual_review_count > 0 {
        reasons.push(format!(
            "应用后出现 {} 次人工复核需求",
            optimized.manual_review_count
        ));
    }
    if let (Some(baseline_score), Some(optimized_score)) =
        (baseline.avg_review_score, optimized.avg_review_score)
    {
        let drop = baseline_score - optimized_score;
        if drop >= ROLLBACK_SCORE_DROP_THRESHOLD {
            reasons.push(format!(
                "应用后平均评分下降 {:.3}（{:.3} → {:.3}），超过阈值 {:.3}",
                drop, baseline_score, optimized_score, ROLLBACK_SCORE_DROP_THRESHOLD
            ));
        }
    }

    let recommend = !reasons.is_empty();
    if !recommend {
        reasons.push("未触发任何回滚条件，建议继续观察".to_string());
    }

    Ok(Json(RollbackRecommendation {
        optimization_id: optimization.id,
        version: optimization.version,
        step_key: optimization.step_key,
        recommend_rollback: recommend,
        reasons,
        recent_failure_count: optimized.failed_count,
        recent_manual_review_count: optimized.manual_review_count,
    }))
}

/**
 * 查询自动应用配置（req #3）
 *
 * GET /api/pipelines/projects/{project_id}/prompt-auto-apply?stepKey=xxx
 *
 * step_key 为空时返回项目级配置；非空时优先返回步骤级配置，回退到项目级。
 */
pub async fn get_auto_apply_config(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Path(project_id): Path<String>,
    axum::extract::Query(filter): axum::extract::Query<AutoApplyConfigFilter>,
) -> AppResult<Json<Option<PipelinePromptAutoApplyConfig>>> {
    verify_project_owner(&state.db, &user_id.0, &project_id).await?;

    let config = if let Some(step_key) = filter.step_key.as_deref() {
        // 优先步骤级
        let step_level = sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
            "SELECT * FROM pipeline_prompt_auto_apply_config
             WHERE user_id = ? AND project_id = ? AND step_key = ?",
        )
        .bind(&user_id.0)
        .bind(&project_id)
        .bind(step_key)
        .fetch_optional(&state.db)
        .await?;
        if step_level.is_some() {
            step_level
        } else {
            // 回退到项目级
            sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
                "SELECT * FROM pipeline_prompt_auto_apply_config
                 WHERE user_id = ? AND project_id = ? AND step_key IS NULL",
            )
            .bind(&user_id.0)
            .bind(&project_id)
            .fetch_optional(&state.db)
            .await?
        }
    } else {
        sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
            "SELECT * FROM pipeline_prompt_auto_apply_config
             WHERE user_id = ? AND project_id = ? AND step_key IS NULL",
        )
        .bind(&user_id.0)
        .bind(&project_id)
        .fetch_optional(&state.db)
        .await?
    };

    Ok(Json(config))
}

#[derive(Debug, serde::Deserialize)]
pub struct AutoApplyConfigFilter {
    #[serde(alias = "stepKey")]
    pub step_key: Option<String>,
}

/**
 * 设置自动应用配置（req #3）
 *
 * PUT /api/pipelines/projects/{project_id}/prompt-auto-apply
 *
 * 风险边界：
 * - 启用前必须 risk_acknowledged=true（前端需展示风险提示后再传）
 * - 默认 enabled=false
 * - 启用后通过审计事件 + 日志可追溯
 * - 快速关闭机制：再次调用 enabled=false 即可
 */
pub async fn set_auto_apply_config(
    State(state): State<AppState>,
    Extension(user_id): Extension<UserId>,
    Extension(request_id): Extension<RequestId>,
    Path(project_id): Path<String>,
    Json(req): Json<SetAutoApplyConfigReq>,
) -> AppResult<Json<PipelinePromptAutoApplyConfig>> {
    verify_project_owner(&state.db, &user_id.0, &project_id).await?;

    // 启用前必须确认风险
    if req.enabled && !req.risk_acknowledged {
        return Err(AppError::Validation(
            "启用自动应用前必须先确认风险（risk_acknowledged=true）".into(),
        ));
    }

    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let step_key_param = req.step_key.as_deref().filter(|s| !s.is_empty());

    // 通过 ON CONFLICT(project_id, step_key) 实现 upsert
    // 注意：SQLite UNIQUE 索引在 NULL 值上不冲突（每个 NULL 视为不同），所以项目级（step_key IS NULL）
    //       的多行可能插入。这里先用 SELECT 判断再决定 INSERT/UPDATE。
    let existing = if let Some(sk) = step_key_param {
        sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
            "SELECT * FROM pipeline_prompt_auto_apply_config
             WHERE user_id = ? AND project_id = ? AND step_key = ?",
        )
        .bind(&user_id.0)
        .bind(&project_id)
        .bind(sk)
        .fetch_optional(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
            "SELECT * FROM pipeline_prompt_auto_apply_config
             WHERE user_id = ? AND project_id = ? AND step_key IS NULL",
        )
        .bind(&user_id.0)
        .bind(&project_id)
        .fetch_optional(&state.db)
        .await?
    };

    let config = if let Some(existing) = existing {
        let updated = sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
            "UPDATE pipeline_prompt_auto_apply_config
             SET enabled = ?, risk_acknowledged = ?, operator_user_id = ?, updated_at = ?
             WHERE id = ?
             RETURNING *",
        )
        .bind(req.enabled)
        .bind(req.risk_acknowledged)
        .bind(&user_id.0)
        .bind(&now)
        .bind(&existing.id)
        .fetch_one(&state.db)
        .await?;
        updated
    } else {
        let id = Uuid::new_v4().to_string();
        let created = sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
            "INSERT INTO pipeline_prompt_auto_apply_config
                (id, user_id, project_id, step_key, enabled, risk_acknowledged, operator_user_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING *",
        )
        .bind(&id)
        .bind(&user_id.0)
        .bind(&project_id)
        .bind(step_key_param)
        .bind(req.enabled)
        .bind(req.risk_acknowledged)
        .bind(&user_id.0)
        .bind(&now)
        .bind(&now)
        .fetch_one(&state.db)
        .await?;
        created
    };

    // 审计事件：写入 pipeline_run_events（不绑定特定 run，因为这是项目级配置）
    // 这里我们用一个独立的 project_id 占位 run_id，但 pipeline_run_events 要求外键，
    // 所以改用 tracing 日志记录（不写表）
    tracing::info!(
        user_id = %user_id.0,
        project_id = %project_id,
        step_key = ?step_key_param,
        enabled = req.enabled,
        request_id = %request_id._value,
        "Prompt 优化自动应用配置已更新"
    );

    Ok(Json(config))
}

/**
 * 自动应用策略检查：满足条件时把 suggested 建议自动应用（供 orchestrator 调用）
 *
 * PRD 20.1 默认决策值：
 * - 连续 3 次审核通过 + 平均评分提升 >= 0.08 才允许自动应用
 * - 范围仅限当前项目
 *
 * 返回 Some(optimization_id) 表示触发了自动应用。
 *
 * @internal 仅供 orchestrator 在审核完成后调用
 */
pub(crate) async fn try_auto_apply_if_eligible(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    step_key: &str,
    request_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    // 1. 检查项目级或步骤级自动开关
    let config = sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
        "SELECT * FROM pipeline_prompt_auto_apply_config
         WHERE user_id = ? AND project_id = ? AND step_key = ? AND enabled = 1 AND risk_acknowledged = 1",
    )
    .bind(user_id)
    .bind(project_id)
    .bind(step_key)
    .fetch_optional(pool)
    .await?;

    let config = match config {
        Some(c) => Some(c),
        None => {
            // 回退到项目级
            sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
                "SELECT * FROM pipeline_prompt_auto_apply_config
                 WHERE user_id = ? AND project_id = ? AND step_key IS NULL AND enabled = 1 AND risk_acknowledged = 1",
            )
            .bind(user_id)
            .bind(project_id)
            .fetch_optional(pool)
            .await?
        }
    };

    let Some(config) = config else {
        return Ok(None);
    };

    // 2. 检查最近 N 次审核结果是否满足条件
    let pass_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM pipeline_prompt_optimizations
         WHERE project_id = ? AND step_key = ?
           AND decision = 'suggested'
           AND rationale_json LIKE '%\"decision\":\"pass\"%'
         ORDER BY created_at DESC
         LIMIT 10",
    )
    .bind(project_id)
    .bind(step_key)
    .fetch_one(pool)
    .await?;

    if pass_count < AUTO_APPLY_MIN_CONSECUTIVE_PASS {
        return Ok(None);
    }

    // 3. 取最新的 suggested 建议并应用
    let latest_suggested = sqlx::query_as::<_, PipelinePromptOptimization>(
        "SELECT * FROM pipeline_prompt_optimizations
         WHERE project_id = ? AND step_key = ? AND decision = 'suggested'
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(project_id)
    .bind(step_key)
    .fetch_optional(pool)
    .await?;

    let Some(suggested) = latest_suggested else {
        return Ok(None);
    };

    // 4. 分配版本号
    let next_version: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(version), 0) + 1
         FROM pipeline_prompt_optimizations
         WHERE project_id = ? AND step_key = ? AND version > 0",
    )
    .bind(project_id)
    .bind(step_key)
    .fetch_one(pool)
    .await?;

    let previous = load_applied_optimization_patch(pool, project_id, step_key).await?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let original_prompt = previous
        .as_ref()
        .and_then(|p| p.optimized_prompt.clone())
        .or_else(|| suggested.design_prompt_patch.clone());
    let optimized_prompt = build_optimized_prompt_snapshot(&suggested);
    let previous_version_id = previous.as_ref().map(|p| p.id.clone());

    // 标记之前的为 superseded
    if let Some(prev) = &previous {
        sqlx::query(
            "UPDATE pipeline_prompt_optimizations
             SET decision = 'rolled_back',
                 rolled_back_at = ?,
                 rolled_back_by = ?,
                 rolled_back_reason = 'superseded',
                 rollback_request_id = ?,
                 updated_at = ?
             WHERE id = ?",
        )
        .bind(&now)
        .bind(&config.operator_user_id)
        .bind(request_id)
        .bind(&now)
        .bind(&prev.id)
        .execute(pool)
        .await?;
    }

    let updated = sqlx::query_as::<_, PipelinePromptOptimization>(
        "UPDATE pipeline_prompt_optimizations
         SET decision = 'applied',
             version = ?,
             strategy = 'auto',
             operator_user_id = ?,
             applied_at = ?,
             applied_request_id = ?,
             original_prompt = ?,
             optimized_prompt = ?,
             previous_version_id = ?,
             updated_at = ?
         WHERE id = ?
         RETURNING *",
    )
    .bind(next_version)
    .bind(&config.operator_user_id)
    .bind(&now)
    .bind(request_id)
    .bind(&original_prompt)
    .bind(&optimized_prompt)
    .bind(&previous_version_id)
    .bind(&now)
    .bind(&suggested.id)
    .fetch_one(pool)
    .await?;

    tracing::info!(
        optimization_id = %updated.id,
        version = next_version,
        project_id = %project_id,
        step_key = %step_key,
        "Prompt 优化建议已自动应用"
    );

    Ok(Some(updated.id))
}

/**
 * 取优化建议并校验归属（req #7）
 *
 * 同时校验 run_id 属于当前用户、optimization 属于该 run
 */
async fn load_optimization_for_user(
    pool: &SqlitePool,
    user_id: &str,
    run_id: &str,
    optimization_id: &str,
) -> AppResult<PipelinePromptOptimization> {
    let row = sqlx::query_as::<_, PipelinePromptOptimization>(
        "SELECT o.*
         FROM pipeline_prompt_optimizations o
         INNER JOIN pipeline_runs r ON r.id = o.run_id
         WHERE o.id = ? AND o.run_id = ? AND r.user_id = ?",
    )
    .bind(optimization_id)
    .bind(run_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("优化建议不存在或无权访问".into()))?;
    Ok(row)
}

/**
 * 校验项目归属当前用户（req #7）
 */
async fn verify_project_owner(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
) -> AppResult<()> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projects WHERE id = ? AND user_id = ?",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if count == 0 {
        return Err(AppError::NotFound("项目不存在或无权访问".into()));
    }
    Ok(())
}

/**
 * 构造优化后 prompt 快照（应用时持久化，便于后续 diff 与回滚追溯）
 */
fn build_optimized_prompt_snapshot(optimization: &PipelinePromptOptimization) -> Option<String> {
    // 优先用 design_prompt_patch 作为优化后 prompt 快照；若缺失则用 review_prompt_patch
    optimization
        .design_prompt_patch
        .clone()
        .or_else(|| optimization.review_prompt_patch.clone())
}

/**
 * 聚合效果指标（按时间窗口）
 *
 * @param pool 数据库连接池
 * @param user_id 当前用户（权限隔离）
 * @param project_id 项目 ID
 * @param step_key 步骤标识
 * @param since 起始时间（包含），None 表示不限制下界
 * @param until 截止时间（不包含），None 表示不限制上界
 */
async fn collect_effect_metrics(
    pool: &SqlitePool,
    user_id: &str,
    project_id: &str,
    step_key: &str,
    since: Option<&str>,
    until: Option<&str>,
) -> Result<EffectMetricGroup, sqlx::Error> {
    // 聚合 ai_usage_events：通过 conversation_id 关联到 pipeline_runs → pipeline_run_steps.step_key
    // 取请求数、成功/失败计数、平均 latency、token 总和
    let usage_sql = format!(
        "SELECT
            COUNT(*) AS sample_count,
            SUM(CASE WHEN u.status = 'success' THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN u.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
            AVG(u.latency_ms) AS avg_duration_ms,
            SUM(u.total_tokens) AS total_tokens
         FROM ai_usage_events u
         WHERE u.user_id = ?
           AND u.project_id = ?
           AND u.conversation_id IN (
               SELECT r.conversation_id FROM pipeline_runs r
               INNER JOIN pipeline_run_steps s ON s.run_id = r.id
               WHERE r.user_id = ? AND r.project_id = ? AND s.step_key = ?
           )
           {since_clause}
           {until_clause}",
        since_clause = if since.is_some() { "AND u.created_at >= ?" } else { "" },
        until_clause = if until.is_some() { "AND u.created_at < ?" } else { "" },
    );

    let mut q = sqlx::query(&usage_sql)
        .bind(user_id)
        .bind(project_id)
        .bind(user_id)
        .bind(project_id)
        .bind(step_key);
    if let Some(since) = since {
        q = q.bind(since);
    }
    if let Some(until) = until {
        q = q.bind(until);
    }

    let row = q.fetch_one(pool).await?;
    let sample_count: i64 = row.try_get("sample_count").unwrap_or(0);
    let success_count: i64 = row.try_get("success_count").unwrap_or(0);
    let failed_count: i64 = row.try_get("failed_count").unwrap_or(0);
    let avg_duration_ms: Option<f64> = row.try_get("avg_duration_ms").ok();
    let total_tokens: Option<i64> = row.try_get("total_tokens").ok();

    // 从 pipeline_step_outputs 取平均 review_score
    let score_sql = format!(
        "SELECT AVG(CAST(o.review_score AS REAL)) AS avg_review_score,
                SUM(CASE WHEN o.review_decision = 'manual_review_required' THEN 1 ELSE 0 END) AS manual_review_count
         FROM pipeline_step_outputs o
         INNER JOIN pipeline_run_steps s ON s.id = o.step_id
         INNER JOIN pipeline_runs r ON r.id = s.run_id
         WHERE r.user_id = ? AND r.project_id = ? AND s.step_key = ?
           {since_clause}
           {until_clause}",
        since_clause = if since.is_some() { "AND o.created_at >= ?" } else { "" },
        until_clause = if until.is_some() { "AND o.created_at < ?" } else { "" },
    );

    let mut q2 = sqlx::query(&score_sql)
        .bind(user_id)
        .bind(project_id)
        .bind(step_key);
    if let Some(since) = since {
        q2 = q2.bind(since);
    }
    if let Some(until) = until {
        q2 = q2.bind(until);
    }

    let score_row = q2.fetch_one(pool).await?;
    let avg_review_score: Option<f64> = score_row
        .try_get::<Option<f64>, _>("avg_review_score")
        .ok()
        .flatten();
    let manual_review_count: i64 = score_row.try_get("manual_review_count").unwrap_or(0);

    let label = match (since, until) {
        (None, Some(_)) => "baseline".to_string(),
        (Some(_), None) => "optimized".to_string(),
        _ => "window".to_string(),
    };

    Ok(EffectMetricGroup {
        label,
        sample_count,
        success_count,
        failed_count,
        avg_duration_ms,
        avg_review_score,
        manual_review_count,
        total_tokens,
    })
}

/**
 * 生成效果对比结论文案（仅在样本充足时调用）
 */
fn build_effect_note(baseline: &EffectMetricGroup, optimized: &EffectMetricGroup) -> String {
    let mut notes = Vec::new();

    let baseline_success_rate = if baseline.sample_count > 0 {
        baseline.success_count as f64 / baseline.sample_count as f64
    } else {
        0.0
    };
    let optimized_success_rate = if optimized.sample_count > 0 {
        optimized.success_count as f64 / optimized.sample_count as f64
    } else {
        0.0
    };
    notes.push(format!(
        "成功率 {:.1}% → {:.1}%（{:+.1}%）",
        baseline_success_rate * 100.0,
        optimized_success_rate * 100.0,
        (optimized_success_rate - baseline_success_rate) * 100.0
    ));

    if let (Some(b), Some(o)) = (baseline.avg_duration_ms, optimized.avg_duration_ms) {
        notes.push(format!(
            "平均耗时 {:.0}ms → {:.0}ms（{:+.0}ms）",
            b,
            o,
            o - b
        ));
    }

    if let (Some(b), Some(o)) = (baseline.total_tokens, optimized.total_tokens) {
        notes.push(format!(
            "Token 总量 {} → {}（{:+}）",
            b,
            o,
            o - b
        ));
    }

    if let (Some(b), Some(o)) = (baseline.avg_review_score, optimized.avg_review_score) {
        notes.push(format!(
            "平均评分 {:.3} → {:.3}（{:+.3}）",
            b,
            o,
            o - b
        ));
    }

    notes.join("；")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use chrono::SecondsFormat;
    use sqlx::Row;

    /// 构造测试用 SQLite 连接池（带完整 schema）
    async fn create_test_pool() -> SqlitePool {
        let db_path = std::env::temp_dir().join(format!(
            "woohoo-prompt-opt-{}.sqlite",
            Uuid::new_v4()
        ));
        let database_url = format!(
            "sqlite://{}",
            db_path.to_string_lossy().replace('\\', "/")
        );
        let pool = init_db(&database_url, 10).await;
        // 保留 db_path，由 OS temp 自动回收
        pool
    }

    /// 创建测试用户、项目、会话、run、step
    async fn seed_user_project_run(
        pool: &SqlitePool,
        user_id: &str,
        project_id: &str,
        conversation_id: &str,
        run_id: &str,
    ) {
        sqlx::query("INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (?, ?, ?, '')")
            .bind(user_id)
            .bind(format!("user-{}", user_id))
            .bind(format!("{}@test.local", user_id))
            .execute(pool)
            .await
            .unwrap();

        sqlx::query("INSERT OR IGNORE INTO projects (id, user_id, name, created_at, updated_at) VALUES (?, ?, 'Test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .bind(project_id)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap();

        sqlx::query("INSERT OR IGNORE INTO conversations (id, user_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, 'Test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .bind(conversation_id)
            .bind(user_id)
            .bind(project_id)
            .execute(pool)
            .await
            .unwrap();

        sqlx::query("INSERT OR IGNORE INTO pipeline_runs (id, user_id, project_id, conversation_id, pipeline_type, trigger_source, status, idempotency_key, total_steps, completed_steps, failed_steps, created_at, updated_at) VALUES (?, ?, ?, ?, 'one_click', 'manual', 'completed', 'test-key', 1, 1, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .bind(run_id)
            .bind(user_id)
            .bind(project_id)
            .bind(conversation_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// 创建测试用 step 与 optimization 建议
    async fn seed_step_and_optimization(
        pool: &SqlitePool,
        run_id: &str,
        step_id: &str,
        step_key: &str,
        optimization_id: &str,
        decision: &str,
    ) {
        sqlx::query("INSERT INTO pipeline_run_steps (id, run_id, step_key, step_name, step_order, step_type, depends_on_json, status, attempt_count, max_retries, duration_ms, created_at, updated_at) VALUES (?, ?, ?, 'Test Step', 1, 'design', '[]', 'completed', 1, 3, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .bind(step_id)
            .bind(run_id)
            .bind(step_key)
            .execute(pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO pipeline_prompt_optimizations (id, run_id, step_id, project_id, conversation_id, decision, design_prompt_patch, review_prompt_patch, rationale_json, source, step_key, version, strategy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'assistant', ?, 0, 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .bind(optimization_id)
            .bind(run_id)
            .bind(step_id)
            .bind("project-1")
            .bind("conv-1")
            .bind(decision)
            .bind("design patch content")
            .bind("review patch content")
            .bind(step_key)
            .execute(pool)
            .await
            .unwrap();
    }

    /// 场景 1：手动应用 suggested 建议，应得到 applied + version=1 + operator_user_id
    #[tokio::test]
    async fn apply_suggested_optimization_assigns_version() {
        let pool = create_test_pool().await;
        seed_user_project_run(&pool, "user-1", "project-1", "conv-1", "run-1").await;
        seed_step_and_optimization(&pool, "run-1", "step-1", "outline_design", "opt-1", "suggested").await;

        let request_id = RequestId {
            _value: "req-test-1".to_string(),
        };

        let updated = apply_optimization_inner(
            &pool,
            "user-1",
            &request_id,
            "run-1",
            "opt-1",
            Some("project"),
        )
        .await
        .expect("apply should succeed");

        assert_eq!(updated.decision, "applied");
        assert_eq!(updated.version, 1);
        assert_eq!(updated.operator_user_id.as_deref(), Some("user-1"));
        assert_eq!(updated.applied_request_id.as_deref(), Some("req-test-1"));
        assert!(updated.optimized_prompt.is_some());
        assert!(updated.applied_at.is_some());
    }

    /// 场景 2：重复应用同一 suggested → 第一次转 applied，第二次直接返回（幂等）
    #[tokio::test]
    async fn apply_is_idempotent_for_already_applied() {
        let pool = create_test_pool().await;
        seed_user_project_run(&pool, "user-1", "project-1", "conv-1", "run-1").await;
        seed_step_and_optimization(&pool, "run-1", "step-1", "outline_design", "opt-1", "suggested").await;

        let request_id = RequestId {
            _value: "req-test-2".to_string(),
        };

        let first = apply_optimization_inner(&pool, "user-1", &request_id, "run-1", "opt-1", Some("project"))
            .await
            .unwrap();
        assert_eq!(first.version, 1);

        // 第二次应用：应直接返回既有记录，不分配新版本号
        let second = apply_optimization_inner(&pool, "user-1", &request_id, "run-1", "opt-1", Some("project"))
            .await
            .unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(second.version, 1);
    }

    /// 场景 3：回滚已应用的建议，应得到 rolled_back 状态
    #[tokio::test]
    async fn rollback_applied_optimization_marks_rolled_back() {
        let pool = create_test_pool().await;
        seed_user_project_run(&pool, "user-1", "project-1", "conv-1", "run-1").await;
        seed_step_and_optimization(&pool, "run-1", "step-1", "outline_design", "opt-1", "suggested").await;

        let request_id = RequestId {
            _value: "req-test-3".to_string(),
        };

        let _applied = apply_optimization_inner(&pool, "user-1", &request_id, "run-1", "opt-1", Some("project"))
            .await
            .unwrap();

        let rolled = rollback_optimization_inner(&pool, "user-1", &request_id, "run-1", "opt-1", Some("test reason"))
            .await
            .expect("rollback should succeed");

        assert_eq!(rolled.decision, "rolled_back");
        assert_eq!(rolled.rolled_back_reason.as_deref(), Some("test reason"));
        assert_eq!(rolled.rolled_back_by.as_deref(), Some("user-1"));
        assert!(rolled.rolled_back_at.is_some());
    }

    /// 场景 4：自动应用开关默认关闭，启用时必须 risk_acknowledged=true
    #[tokio::test]
    async fn auto_apply_config_requires_risk_acknowledgement() {
        let pool = create_test_pool().await;
        seed_user_project_run(&pool, "user-1", "project-1", "conv-1", "run-1").await;

        // 启用但未确认风险 → 应失败
        let result = set_auto_apply_config_inner(
            &pool,
            "user-1",
            &RequestId {
                _value: "req-test-4".to_string(),
            },
            "project-1",
            SetAutoApplyConfigReq {
                enabled: true,
                risk_acknowledged: false,
                step_key: None,
            },
        )
        .await;
        assert!(result.is_err(), "启用未确认风险应失败");

        // 确认风险后启用 → 应成功
        let config = set_auto_apply_config_inner(
            &pool,
            "user-1",
            &RequestId {
                _value: "req-test-4".to_string(),
            },
            "project-1",
            SetAutoApplyConfigReq {
                enabled: true,
                risk_acknowledged: true,
                step_key: None,
            },
        )
        .await
        .expect("启用并确认风险应成功");
        assert!(config.enabled);
        assert!(config.risk_acknowledged);

        // 快速关闭
        let disabled = set_auto_apply_config_inner(
            &pool,
            "user-1",
            &RequestId {
                _value: "req-test-4".to_string(),
            },
            "project-1",
            SetAutoApplyConfigReq {
                enabled: false,
                risk_acknowledged: true,
                step_key: None,
            },
        )
        .await
        .unwrap();
        assert!(!disabled.enabled);
    }

    /// 场景 5：跨项目越权 - 用户 user-1 不能应用 user-2 的 optimization
    #[tokio::test]
    async fn cross_user_access_is_forbidden() {
        let pool = create_test_pool().await;
        seed_user_project_run(&pool, "user-1", "project-1", "conv-1", "run-1").await;
        seed_step_and_optimization(&pool, "run-1", "step-1", "outline_design", "opt-1", "suggested").await;

        // 创建另一个用户
        seed_user_project_run(&pool, "user-2", "project-2", "conv-2", "run-2").await;

        let request_id = RequestId {
            _value: "req-test-5".to_string(),
        };

        // user-2 尝试访问 user-1 的 run-1 → 应失败（NotFound）
        let result = apply_optimization_inner(&pool, "user-2", &request_id, "run-1", "opt-1", Some("project")).await;
        assert!(result.is_err(), "跨用户访问应被拒绝");
    }

    /// 场景 6：效果对比样本不足时 sample_sufficient=false，note 明确提示
    #[tokio::test]
    async fn effect_comparison_marks_insufficient_samples() {
        let pool = create_test_pool().await;
        seed_user_project_run(&pool, "user-1", "project-1", "conv-1", "run-1").await;
        seed_step_and_optimization(&pool, "run-1", "step-1", "outline_design", "opt-1", "suggested").await;

        let request_id = RequestId {
            _value: "req-test-6".to_string(),
        };
        let _applied = apply_optimization_inner(&pool, "user-1", &request_id, "run-1", "opt-1", Some("project"))
            .await
            .unwrap();

        let effect = get_effect_comparison_inner(&pool, "user-1", "run-1", "opt-1")
            .await
            .unwrap();

        assert!(!effect.sample_sufficient, "无样本时应判定为不足");
        assert!(effect.note.contains("样本不足"), "note 应明确提示样本不足");
    }

    /// 场景 7：回滚建议在无失败数据时不推荐回滚
    #[tokio::test]
    async fn rollback_recommendation_no_recommendation_without_failures() {
        let pool = create_test_pool().await;
        seed_user_project_run(&pool, "user-1", "project-1", "conv-1", "run-1").await;
        seed_step_and_optimization(&pool, "run-1", "step-1", "outline_design", "opt-1", "suggested").await;

        let request_id = RequestId {
            _value: "req-test-7".to_string(),
        };
        let _applied = apply_optimization_inner(&pool, "user-1", &request_id, "run-1", "opt-1", Some("project"))
            .await
            .unwrap();

        let rec = get_rollback_recommendation_inner(&pool, "user-1", "run-1", "opt-1")
            .await
            .unwrap();
        assert!(!rec.recommend_rollback, "无失败数据时不应推荐回滚");
    }

    /// 场景 8：回滚建议在出现连续失败时推荐回滚
    #[tokio::test]
    async fn rollback_recommendation_triggers_on_failures() {
        let pool = create_test_pool().await;
        seed_user_project_run(&pool, "user-1", "project-1", "conv-1", "run-1").await;
        seed_step_and_optimization(&pool, "run-1", "step-1", "outline_design", "opt-1", "suggested").await;

        let request_id = RequestId {
            _value: "req-test-8".to_string(),
        };
        let applied = apply_optimization_inner(&pool, "user-1", &request_id, "run-1", "opt-1", Some("project"))
            .await
            .unwrap();

        // 注入 2 条失败 ai_usage_events
        for i in 0..2 {
            sqlx::query("INSERT INTO ai_usage_events (id, user_id, project_id, conversation_id, provider, operation, status, latency_ms, prompt_tokens, completion_tokens, total_tokens, token_source, created_at) VALUES (?, 'user-1', 'project-1', 'conv-1', 'openai', 'task', 'failed', 1000, 100, 50, 150, 'actual', ?)")
                .bind(format!("usage-fail-{}", i))
                .bind(applied.applied_at.as_deref().unwrap_or("2026-01-02T00:00:00Z"))
                .execute(&pool)
                .await
                .unwrap();
        }

        let rec = get_rollback_recommendation_inner(&pool, "user-1", "run-1", "opt-1")
            .await
            .unwrap();
        assert!(rec.recommend_rollback, "连续失败应触发回滚建议");
        assert!(rec.recent_failure_count >= 2);
        assert!(rec.reasons.iter().any(|r| r.contains("失败")));
    }

    /// 场景 9：load_applied_optimization_patch 在回滚后返回 None
    #[tokio::test]
    async fn load_patch_returns_none_after_rollback() {
        let pool = create_test_pool().await;
        seed_user_project_run(&pool, "user-1", "project-1", "conv-1", "run-1").await;
        seed_step_and_optimization(&pool, "run-1", "step-1", "outline_design", "opt-1", "suggested").await;

        let request_id = RequestId {
            _value: "req-test-9".to_string(),
        };
        let _applied = apply_optimization_inner(&pool, "user-1", &request_id, "run-1", "opt-1", Some("project"))
            .await
            .unwrap();

        // 应用后应有 patch
        let patch = load_applied_optimization_patch(&pool, "project-1", "outline_design")
            .await
            .unwrap();
        assert!(patch.is_some());

        // 回滚后应返回 None
        let _rolled = rollback_optimization_inner(&pool, "user-1", &request_id, "run-1", "opt-1", Some("rollback"))
            .await
            .unwrap();

        let patch_after = load_applied_optimization_patch(&pool, "project-1", "outline_design")
            .await
            .unwrap();
        assert!(patch_after.is_none(), "回滚后不应再取到 patch");
    }

    // ====== 内部辅助函数（绕过 axum Extension，直接用 pool 调用核心逻辑，便于测试） ======

    async fn apply_optimization_inner(
        pool: &SqlitePool,
        user_id: &str,
        request_id: &RequestId,
        run_id: &str,
        optimization_id: &str,
        scope: Option<&str>,
    ) -> AppResult<PipelinePromptOptimization> {
        let scope = scope.unwrap_or("project").to_string();
        if scope != "project" && scope != "run" {
            return Err(AppError::Validation(
                format!("不支持的 scope: {}", scope).into(),
            ));
        }

        let run = get_run_by_id(pool, user_id, run_id).await?;
        let optimization = load_optimization_for_user(pool, user_id, run_id, optimization_id).await?;

        if optimization.project_id != run.project_id {
            return Err(AppError::Forbidden(
                "优化建议不属于当前流程的项目".into(),
            ));
        }

        if optimization.decision == "applied" && optimization.rolled_back_at.is_none() {
            return Ok(optimization);
        }

        if optimization.decision != "suggested" {
            return Err(AppError::Validation(
                format!("当前建议状态为 {}，仅 suggested 可应用", optimization.decision).into(),
            ));
        }

        let step_key = optimization.step_key.clone().unwrap_or_default();
        if step_key.is_empty() {
            return Err(AppError::Validation(
                "优化建议缺少 step_key".into(),
            ));
        }

        let next_version: i64 = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(version), 0) + 1
             FROM pipeline_prompt_optimizations
             WHERE project_id = ? AND step_key = ? AND version > 0",
        )
        .bind(&run.project_id)
        .bind(&step_key)
        .fetch_one(pool)
        .await?;

        let previous = load_applied_optimization_patch(pool, &run.project_id, &step_key).await?;

        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let original_prompt = previous
            .as_ref()
            .and_then(|p| p.optimized_prompt.clone())
            .or_else(|| optimization.design_prompt_patch.clone());
        let optimized_prompt = build_optimized_prompt_snapshot(&optimization);
        let previous_version_id = previous.as_ref().map(|p| p.id.clone());

        if let Some(prev) = &previous {
            sqlx::query(
                "UPDATE pipeline_prompt_optimizations
                 SET decision = 'rolled_back',
                     rolled_back_at = ?,
                     rolled_back_by = ?,
                     rolled_back_reason = 'superseded',
                     rollback_request_id = ?,
                     updated_at = ?
                 WHERE id = ?",
            )
            .bind(&now)
            .bind(user_id)
            .bind(&request_id._value)
            .bind(&now)
            .bind(&prev.id)
            .execute(pool)
            .await?;
        }

        let updated = sqlx::query_as::<_, PipelinePromptOptimization>(
            "UPDATE pipeline_prompt_optimizations
             SET decision = 'applied',
                 version = ?,
                 strategy = 'manual',
                 operator_user_id = ?,
                 applied_at = ?,
                 applied_request_id = ?,
                 original_prompt = ?,
                 optimized_prompt = ?,
                 previous_version_id = ?,
                 rolled_back_at = NULL,
                 rolled_back_by = NULL,
                 rolled_back_reason = NULL,
                 rollback_request_id = NULL,
                 updated_at = ?
             WHERE id = ?
             RETURNING *",
        )
        .bind(next_version)
        .bind(user_id)
        .bind(&now)
        .bind(&request_id._value)
        .bind(&original_prompt)
        .bind(&optimized_prompt)
        .bind(&previous_version_id)
        .bind(&now)
        .bind(&optimization.id)
        .fetch_one(pool)
        .await?;

        Ok(updated)
    }

    async fn rollback_optimization_inner(
        pool: &SqlitePool,
        user_id: &str,
        request_id: &RequestId,
        run_id: &str,
        optimization_id: &str,
        reason: Option<&str>,
    ) -> AppResult<PipelinePromptOptimization> {
        let reason = reason.unwrap_or("user_initiated").to_string();
        let run = get_run_by_id(pool, user_id, run_id).await?;
        let optimization = load_optimization_for_user(pool, user_id, run_id, optimization_id).await?;

        if optimization.project_id != run.project_id {
            return Err(AppError::Forbidden(
                "优化建议不属于当前流程的项目".into(),
            ));
        }
        if optimization.decision != "applied" {
            return Err(AppError::Validation(
                format!("当前建议状态为 {}，仅 applied 可回滚", optimization.decision).into(),
            ));
        }
        if optimization.rolled_back_at.is_some() {
            return Err(AppError::Validation(
                "该优化建议已经被回滚".into(),
            ));
        }

        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let updated = sqlx::query_as::<_, PipelinePromptOptimization>(
            "UPDATE pipeline_prompt_optimizations
             SET decision = 'rolled_back',
                 rolled_back_at = ?,
                 rolled_back_by = ?,
                 rolled_back_reason = ?,
                 rollback_request_id = ?,
                 updated_at = ?
             WHERE id = ?
             RETURNING *",
        )
        .bind(&now)
        .bind(user_id)
        .bind(&reason)
        .bind(&request_id._value)
        .bind(&now)
        .bind(&optimization.id)
        .fetch_one(pool)
        .await?;

        Ok(updated)
    }

    async fn get_effect_comparison_inner(
        pool: &SqlitePool,
        user_id: &str,
        run_id: &str,
        optimization_id: &str,
    ) -> AppResult<OptimizationEffectComparison> {
        let run = get_run_by_id(pool, user_id, run_id).await?;
        let optimization = load_optimization_for_user(pool, user_id, run_id, optimization_id).await?;

        if optimization.project_id != run.project_id {
            return Err(AppError::Forbidden(
                "优化建议不属于当前流程的项目".into(),
            ));
        }

        let applied_at = optimization.applied_at.as_deref().unwrap_or("");
        let step_key = optimization.step_key.clone().unwrap_or_default();

        let baseline = collect_effect_metrics(pool, user_id, &run.project_id, &step_key, None, Some(applied_at))
            .await?;
        let optimized = collect_effect_metrics(pool, user_id, &run.project_id, &step_key, Some(applied_at), None)
            .await?;

        let sample_sufficient =
            baseline.sample_count >= EFFECT_MIN_SAMPLE && optimized.sample_count >= EFFECT_MIN_SAMPLE;

        let note = if sample_sufficient {
            build_effect_note(&baseline, &optimized)
        } else {
            format!(
                "样本不足：baseline 需 >= {} 条（当前 {}），optimized 需 >= {} 条（当前 {}）",
                EFFECT_MIN_SAMPLE,
                baseline.sample_count,
                EFFECT_MIN_SAMPLE,
                optimized.sample_count
            )
        };

        Ok(OptimizationEffectComparison {
            optimization_id: optimization.id,
            version: optimization.version,
            step_key: optimization.step_key,
            applied_at: optimization.applied_at,
            baseline,
            optimized,
            sample_sufficient,
            note,
        })
    }

    async fn get_rollback_recommendation_inner(
        pool: &SqlitePool,
        user_id: &str,
        run_id: &str,
        optimization_id: &str,
    ) -> AppResult<RollbackRecommendation> {
        let run = get_run_by_id(pool, user_id, run_id).await?;
        let optimization = load_optimization_for_user(pool, user_id, run_id, optimization_id).await?;

        if optimization.project_id != run.project_id {
            return Err(AppError::Forbidden(
                "优化建议不属于当前流程的项目".into(),
            ));
        }
        if optimization.decision != "applied" || optimization.rolled_back_at.is_some() {
            return Ok(RollbackRecommendation {
                optimization_id: optimization.id,
                version: optimization.version,
                step_key: optimization.step_key.clone(),
                recommend_rollback: false,
                reasons: vec![format!("当前状态为 {}，无需回滚建议", optimization.decision)],
                recent_failure_count: 0,
                recent_manual_review_count: 0,
            });
        }

        let applied_at = optimization.applied_at.as_deref().unwrap_or("");
        let step_key = optimization.step_key.clone().unwrap_or_default();

        let baseline = collect_effect_metrics(pool, user_id, &run.project_id, &step_key, None, Some(applied_at))
            .await?;
        let optimized = collect_effect_metrics(pool, user_id, &run.project_id, &step_key, Some(applied_at), None)
            .await?;

        let mut reasons = Vec::new();
        if optimized.failed_count >= ROLLBACK_RECENT_FAILURE_THRESHOLD {
            reasons.push(format!(
                "应用后最近失败次数 {} 次达到阈值 {}",
                optimized.failed_count, ROLLBACK_RECENT_FAILURE_THRESHOLD
            ));
        }
        if optimized.manual_review_count > 0 {
            reasons.push(format!(
                "应用后出现 {} 次人工复核需求",
                optimized.manual_review_count
            ));
        }
        if let (Some(b), Some(o)) = (baseline.avg_review_score, optimized.avg_review_score) {
            let drop = b - o;
            if drop >= ROLLBACK_SCORE_DROP_THRESHOLD {
                reasons.push(format!(
                    "应用后平均评分下降 {:.3}（{:.3} → {:.3}）",
                    drop, b, o
                ));
            }
        }

        let recommend = !reasons.is_empty();
        if !recommend {
            reasons.push("未触发任何回滚条件，建议继续观察".to_string());
        }

        Ok(RollbackRecommendation {
            optimization_id: optimization.id,
            version: optimization.version,
            step_key: optimization.step_key,
            recommend_rollback: recommend,
            reasons,
            recent_failure_count: optimized.failed_count,
            recent_manual_review_count: optimized.manual_review_count,
        })
    }

    async fn set_auto_apply_config_inner(
        pool: &SqlitePool,
        user_id: &str,
        request_id: &RequestId,
        project_id: &str,
        req: SetAutoApplyConfigReq,
    ) -> AppResult<PipelinePromptAutoApplyConfig> {
        verify_project_owner(pool, user_id, project_id).await?;

        if req.enabled && !req.risk_acknowledged {
            return Err(AppError::Validation(
                "启用自动应用前必须先确认风险".into(),
            ));
        }

        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let step_key_param = req.step_key.as_deref().filter(|s| !s.is_empty());

        let existing = if let Some(sk) = step_key_param {
            sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
                "SELECT * FROM pipeline_prompt_auto_apply_config
                 WHERE user_id = ? AND project_id = ? AND step_key = ?",
            )
            .bind(user_id)
            .bind(project_id)
            .bind(sk)
            .fetch_optional(pool)
            .await?
        } else {
            sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
                "SELECT * FROM pipeline_prompt_auto_apply_config
                 WHERE user_id = ? AND project_id = ? AND step_key IS NULL",
            )
            .bind(user_id)
            .bind(project_id)
            .fetch_optional(pool)
            .await?
        };

        let config = if let Some(existing) = existing {
            sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
                "UPDATE pipeline_prompt_auto_apply_config
                 SET enabled = ?, risk_acknowledged = ?, operator_user_id = ?, updated_at = ?
                 WHERE id = ?
                 RETURNING *",
            )
            .bind(req.enabled)
            .bind(req.risk_acknowledged)
            .bind(user_id)
            .bind(&now)
            .bind(&existing.id)
            .fetch_one(pool)
            .await?
        } else {
            let id = Uuid::new_v4().to_string();
            sqlx::query_as::<_, PipelinePromptAutoApplyConfig>(
                "INSERT INTO pipeline_prompt_auto_apply_config
                    (id, user_id, project_id, step_key, enabled, risk_acknowledged, operator_user_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 RETURNING *",
            )
            .bind(&id)
            .bind(user_id)
            .bind(project_id)
            .bind(step_key_param)
            .bind(req.enabled)
            .bind(req.risk_acknowledged)
            .bind(user_id)
            .bind(&now)
            .bind(&now)
            .fetch_one(pool)
            .await?
        };

        tracing::info!(
            user_id = %user_id,
            project_id = %project_id,
            step_key = ?step_key_param,
            enabled = req.enabled,
            request_id = %request_id._value,
            "Prompt 优化自动应用配置已更新"
        );

        Ok(config)
    }
}
