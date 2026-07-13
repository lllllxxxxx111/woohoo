import React, { useEffect, useMemo, useState } from 'react';
import { Download, PauseCircle, PlayCircle, Scissors } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import { useToast } from '../../../../../context/useToast';
import styles from './PipelineSteps.module.css';
import { createProjectSnapshot, exportFinalCutPlan } from '../workspaceMvp';

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
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

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
    if (!snapshot || snapshot.finalCut.shots.length === 0) {
      setSelectedShotId(null);
      setIsPlaying(false);
      return;
    }

    setSelectedShotId((current) => current ?? snapshot.finalCut.shots[0].id);
  }, [snapshot]);

  useEffect(() => {
    if (!isPlaying || !snapshot || snapshot.finalCut.shots.length <= 1) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setSelectedShotId((current) => {
        const shots = snapshot.finalCut.shots;
        const currentIndex = shots.findIndex((shot) => shot.id === current);
        const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % shots.length;
        return shots[nextIndex].id;
      });
    }, 1500);

    return () => window.clearInterval(intervalId);
  }, [isPlaying, snapshot]);

  const selectedShot = snapshot?.finalCut.shots.find((shot) => shot.id === selectedShotId) ?? null;
  const totalDuration = snapshot?.finalCut.totalDurationSeconds ?? 0;

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
          <p className={styles.subText}>这里先提供最小可用的成片预览和时间线导出，不再是纯静态时间轴壳子。</p>
        </div>
        <button className={styles.btnSecondary} onClick={() => setIsPlaying((value) => !value)}>
          {isPlaying ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
          {isPlaying ? '停止预览' : '预览镜头'}
        </button>
        <button className={styles.btnPrimary} onClick={handleExportPlan}>
          <Download size={14} /> 导出成片方案
        </button>
      </div>

      {snapshot.finalCut.shots.length === 0 ? (
        <div className={styles.emptyMarkdownState}>
          <span>当前还没有可用镜头，无法生成成片时间线。</span>
        </div>
      ) : (
        <div className={styles.editorTimelineView}>
          <div className={styles.videoPreviewArea}>
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
                全片 {snapshot.finalCut.totalShots} 镜头 / 总时长 {totalDuration}s / 资产 {snapshot.finalCut.totalAssets}
              </span>
            </div>
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
                  >
                    {shot.title}
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
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
