import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clapperboard, Download, PauseCircle, PlayCircle, Scissors, Sparkles } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import { useToast } from '../../../../../context/useToast';
import { useAppActions } from '../../../../../context/useAppActions';
import {
  composeFinalCutVideo,
  getFfmpegStatus,
  listProjectVideoShotAssets,
} from '../../../../../lib/serverApi';
import type { Asset } from '../../../../../types';
import styles from './PipelineSteps.module.css';
import { createProjectSnapshot, exportFinalCutPlan } from '../workspaceMvp';

const VIDEO_STEP_KEY_PREFIX = 'video_shot_';

export const EditView: React.FC = () => {
  const { activeProject, activeScript, activeStoryboard, activeAssets } = useAppStore(
    useShallow((state) => ({
      activeProject: state.projects.find((project) => project.id === state.activeState.projectId) ?? null,
      activeScript: state.activeScript,
      activeStoryboard: state.activeStoryboard,
      activeAssets: state.activeAssets,
    })),
  );
  const { showToast } = useToast();
  const { refreshWorkspace } = useAppActions();
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [composing, setComposing] = useState(false);
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null);
  /** shotId -> 已生成视频资产（跨 run，按 stepKey 解析，重复生成取最新） */
  const [shotVideoAssets, setShotVideoAssets] = useState<Map<string, Asset>>(new Map());

  const snapshot = useMemo(() => {
    if (!activeProject) {
      return null;
    }

    return createProjectSnapshot({
      project: activeProject,
      script: activeScript,
      scriptText: activeScript?.content ?? '',
      storyboard: activeStoryboard,
      assets: activeAssets,
    });
  }, [activeAssets, activeProject, activeScript, activeStoryboard]);

  useEffect(() => {
    if (!activeProject) {
      setShotVideoAssets(new Map());
      return undefined;
    }
    let cancelled = false;
    listProjectVideoShotAssets(activeProject.id)
      .then((items) => {
        if (cancelled) {
          return;
        }
        const next = new Map<string, Asset>();
        items.forEach((item) => {
          if (item.stepKey.startsWith(VIDEO_STEP_KEY_PREFIX)) {
            next.set(item.stepKey.slice(VIDEO_STEP_KEY_PREFIX.length), item.asset);
          }
        });
        setShotVideoAssets(next);
      })
      .catch(() => {
        // 视频素材列表加载失败不阻塞剪辑预览（文本预览仍可用）
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject]);

  useEffect(() => {
    if (!activeProject) {
      return;
    }
    void getFfmpegStatus()
      .then((status) => setFfmpegAvailable(status.available))
      .catch(() => setFfmpegAvailable(null));
  }, [activeProject]);

  useEffect(() => {
    if (!snapshot || snapshot.finalCut.shots.length === 0) {
      setSelectedShotId(null);
      setIsPlaying(false);
      return;
    }

    setSelectedShotId((current) => current ?? snapshot.finalCut.shots[0].id);
  }, [snapshot]);

  /** 顺序播放推进：优先跳到下一个"有视频产物"的镜头 */
  const advanceToNextShot = useCallback(() => {
    if (!snapshot) {
      return;
    }
    const shots = snapshot.finalCut.shots;
    if (shots.length <= 1) {
      setIsPlaying(false);
      return;
    }
    setSelectedShotId((current) => {
      const currentIndex = shots.findIndex((shot) => shot.id === current);
      for (let offset = 1; offset <= shots.length; offset += 1) {
        const next = shots[(currentIndex + offset + shots.length) % shots.length];
        if (shotVideoAssets.has(next.id)) {
          return next.id;
        }
      }
      // 没有任何下一个镜头带视频：退回首镜头并停止
      setIsPlaying(false);
      return shots[0].id;
    });
  }, [snapshot, shotVideoAssets]);

  // 纯文本镜头（无视频产物）在播放模式下按 1.5s 节奏推进；有视频的镜头由 onEnded 推进
  useEffect(() => {
    if (!isPlaying || !snapshot) {
      return undefined;
    }
    if (selectedShotId && shotVideoAssets.has(selectedShotId)) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      advanceToNextShot();
    }, 1500);

    return () => window.clearInterval(intervalId);
  }, [isPlaying, snapshot, selectedShotId, advanceToNextShot, shotVideoAssets]);

  const selectedShot = snapshot?.finalCut.shots.find((shot) => shot.id === selectedShotId) ?? null;
  const selectedVideoAsset = selectedShotId ? shotVideoAssets.get(selectedShotId) ?? null : null;
  const totalDuration = snapshot?.finalCut.totalDurationSeconds ?? 0;
  const clipsWithVideo = useMemo(
    () =>
      (snapshot?.finalCut.shots ?? []).filter((shot) => shotVideoAssets.has(shot.id)),
    [snapshot, shotVideoAssets],
  );

  const handleExportPlan = () => {
    if (!activeProject || !snapshot) {
      return;
    }

    const filename = exportFinalCutPlan(activeProject, snapshot.finalCut);
    showToast({
      type: 'success',
      title: '成片方案已导出',
      message: `${filename} 已生成，可直接交给后续渲染或人工剪辑环节。`,
    });
  };

  const handleComposeVideo = async () => {
    if (!activeProject) {
      return;
    }
    const clipAssetIds = clipsWithVideo
      .map((shot) => shotVideoAssets.get(shot.id)?.id)
      .filter((id): id is string => Boolean(id));
    if (clipAssetIds.length === 0) {
      showToast({
        type: 'warning',
        title: '暂无可合成的镜头视频',
        message: '请先在「视频镜头生成」中完成至少一个镜头的视频生成。',
      });
      return;
    }

    setComposing(true);
    try {
      const asset = await composeFinalCutVideo({
        projectId: activeProject.id,
        clipAssetIds,
      });
      showToast({
        type: 'success',
        title: '成片视频已合成',
        message: `「${asset.name}」已入库（${clipAssetIds.length} 个镜头），可在资产库查看或播放。`,
      });
      void refreshWorkspace('final cut composed', 2).catch(() => {});
    } catch (error) {
      showToast({
        type: 'error',
        title: '合成失败',
        message: error instanceof Error ? error.message : '无法完成成片合成，请确认服务端已安装 ffmpeg。',
      });
    } finally {
      setComposing(false);
    }
  };

  if (!activeProject || !snapshot) {
    return (
      <div className={styles.containerCol}>
        <div className={styles.emptyMarkdownState}>
          <Scissors size={20} />
          <span>请先选择项目，再进入剪辑与合成步骤。</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.containerCol}>
      <div className={styles.areaHeader}>
        <Scissors size={18} />
        <div style={{ flex: 1 }}>
          <h3>剪辑与合成</h3>
          <p className={styles.subText}>
            预览已生成的镜头视频并按时间线合成成片
            {ffmpegAvailable === false ? '（未检测到 ffmpeg，仅可预览与导出方案）' : ''}
          </p>
        </div>
        <button className={styles.btnSecondary} onClick={() => setIsPlaying((value) => !value)}>
          {isPlaying ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
          {isPlaying ? '停止预览' : '预览镜头'}
        </button>
        <button className={styles.btnSecondary} onClick={handleExportPlan}>
          <Download size={14} /> 导出成片方案
        </button>
        <button
          className={styles.btnPrimary}
          onClick={() => void handleComposeVideo()}
          disabled={composing || ffmpegAvailable === false || clipsWithVideo.length === 0}
          title={
            ffmpegAvailable === false
              ? '未检测到 ffmpeg，请先在服务端安装'
              : `将按时间线顺序拼接 ${clipsWithVideo.length} 个已生成的镜头视频`
          }
        >
          <Clapperboard size={14} />
          {composing ? '合成中...' : '合成成片视频'}
        </button>
      </div>

      {snapshot.finalCut.shots.length === 0 ? (
        <div className={styles.emptyMarkdownState}>
          <span>当前还没有可用镜头，无法生成成片时间线。</span>
        </div>
      ) : (
        <div className={styles.editorTimelineView}>
          <div className={styles.videoPreviewArea}>
            {selectedVideoAsset ? (
              <video
                key={selectedVideoAsset.id}
                className={styles.previewVideo}
                src={selectedVideoAsset.url}
                controls
                autoPlay={isPlaying}
                onEnded={() => {
                  if (isPlaying) {
                    advanceToNextShot();
                  }
                }}
              />
            ) : (
              <div className={styles.previewScreen}>
                <strong style={{ fontSize: '1.1rem' }}>{selectedShot?.title ?? '待选择镜头'}</strong>
                <span>{selectedShot?.location ?? '暂无场景信息'}</span>
                <span>{selectedShot ? `${selectedShot.durationSeconds}s` : '--'}</span>
                <p
                  style={{
                    maxWidth: '80%',
                    textAlign: 'center',
                    lineHeight: 1.5,
                    color: 'rgba(255, 255, 255, 0.82)',
                    margin: 0,
                  }}
                >
                  {selectedShot?.prompt ?? '当前项目还没有生成镜头提示。'}
                </p>
                <span style={{ fontSize: '0.85rem', color: 'rgba(255, 255, 255, 0.68)' }}>
                  该镜头还没有已生成的视频，文本预览仅供参考。
                </span>
              </div>
            )}
          </div>

          <div className={styles.timelineTracks}>
            <div className={styles.track}>
              <div className={styles.trackLabel}>画面</div>
              <div className={styles.trackItems}>
                {snapshot.finalCut.shots.map((shot) => (
                  <button
                    key={shot.id}
                    type="button"
                    className={styles.trackClip}
                    onClick={() => setSelectedShotId(shot.id)}
                    style={{
                      width: `${Math.max(12, (shot.durationSeconds / Math.max(1, totalDuration)) * 100)}%`,
                      border:
                        selectedShotId === shot.id
                          ? '2px solid rgba(255, 255, 255, 0.8)'
                          : '1px solid rgba(0, 0, 0, 0.2)',
                    }}
                    title={
                      shotVideoAssets.has(shot.id)
                        ? '已生成视频，点击预览'
                        : '尚未生成视频'
                    }
                  >
                    {shot.title}
                    {shotVideoAssets.has(shot.id) ? ' ●' : ' ○'}
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.track}>
              <div className={styles.trackLabel}>配音</div>
              <div className={styles.trackItems}>
                {snapshot.finalCut.voiceoverTracks.map((track) => (
                  <div
                    key={track.id}
                    className={styles.trackAudio}
                    style={{
                      width: `${Math.max(12, (track.durationSeconds / Math.max(1, totalDuration)) * 100)}%`,
                    }}
                  >
                    {track.label}
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.track}>
              <div className={styles.trackLabel}>音效/BGM</div>
              <div className={styles.trackItems}>
                <div className={styles.trackBGM} style={{ width: '100%' }}>
                  {snapshot.finalCut.bgmTrack.label}
                </div>
              </div>
            </div>

            {selectedShot && (
              <div className={styles.infoText}>
                当前选中 {selectedShot.title}：{selectedShot.prompt}
                <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                  （已生成视频 {clipsWithVideo.length}/{snapshot.finalCut.shots.length}）
                </span>
              </div>
            )}
            {clipsWithVideo.length === 0 && (
              <div className={styles.infoText} style={{ color: 'var(--text-muted)' }}>
                <Sparkles size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                先在「视频镜头生成」中生成镜头视频，回到这里即可预览与一键合成成片。
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
