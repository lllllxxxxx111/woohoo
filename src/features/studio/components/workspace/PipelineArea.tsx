import React, { useMemo, useState } from 'react';
import {
  LayoutList,
  FileText,
  ListTree,
  Users,
  Layers,
  Film,
  Scissors,
  Sparkles,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './PipelineArea.module.css';
import { useAppStore } from '../../../../store';

// Subcomponents for the pipeline
import { OutlineView } from './PipelineSteps/OutlineView';
import { ScriptView } from './PipelineSteps/ScriptView';
import { ChaptersView } from './PipelineSteps/ChaptersView';
import { CharSceneView } from './PipelineSteps/CharSceneView';
import { KeyframeView } from './PipelineSteps/KeyframeView';
import { VideoView } from './PipelineSteps/VideoView';
import { EditView } from './PipelineSteps/EditView';

type Step = 'outline' | 'script' | 'chapters' | 'char_scene' | 'keyframes' | 'video' | 'edit';

export const PipelineArea: React.FC = () => {
  const [activeStep, setActiveStep] = useState<Step>('outline');
  const collaborationSession = useAppStore((state) => state.activeCollaborationSession);
  const collaborationMessages = useAppStore((state) => state.activeCollaborationMessages);
  const collaborationDeliverable = useMemo(() => {
    if (
      !collaborationSession ||
      !['workspace_execution', 'completed'].includes(collaborationSession.state)
    ) {
      return null;
    }

    const statusMessages = collaborationMessages.filter(
      (message) => message.messageKind === 'status' && message.content.trim(),
    );
    return (
      statusMessages
        .slice()
        .reverse()
        .find(
          (message) =>
            message.sourceAgentId &&
            message.sourceAgentId === collaborationSession.orchestratorAgentId,
        ) ?? statusMessages.at(-1)
    );
  }, [collaborationMessages, collaborationSession]);

  const steps: { id: Step; label: string; icon: React.ReactNode }[] = [
    { id: 'outline', label: '大纲生成', icon: <LayoutList size={16} /> },
    { id: 'script', label: '剧本生成', icon: <FileText size={16} /> },
    { id: 'chapters', label: '章节拆解', icon: <ListTree size={16} /> },
    { id: 'char_scene', label: '人物与场景', icon: <Users size={16} /> },
    { id: 'keyframes', label: '首尾关键帧', icon: <Layers size={16} /> },
    { id: 'video', label: '视频分镜生成', icon: <Film size={16} /> },
    { id: 'edit', label: '视频剪辑', icon: <Scissors size={16} /> },
  ];

  const renderCurrentStep = () => {
    switch (activeStep) {
      case 'outline':
        return <OutlineView onAdvanceToScript={() => setActiveStep('script')} />;
      case 'script':
        return <ScriptView />;
      case 'chapters':
        return <ChaptersView />;
      case 'char_scene':
        return <CharSceneView />;
      case 'keyframes':
        return <KeyframeView />;
      case 'video':
        return <VideoView />;
      case 'edit':
        return <EditView />;
      default:
        return null;
    }
  };

  return (
    <div className={styles.container}>
      {/* Pipeline Navigation */}
      <div className={styles.pipelineNav}>
        {steps.map((step, index) => (
          <React.Fragment key={step.id}>
            <button
              className={`${styles.stepBtn} ${activeStep === step.id ? styles.active : ''}`}
              onClick={() => setActiveStep(step.id)}
            >
              <span className={styles.stepIcon}>{step.icon}</span>
              <span className={styles.stepLabel}>{step.label}</span>
            </button>
            {index < steps.length - 1 && <div className={styles.stepConnector}></div>}
          </React.Fragment>
        ))}
      </div>

      {collaborationDeliverable && (
        <details className={styles.collaborationDeliverable} open>
          <summary className={styles.collaborationDeliverableHeader}>
            <Sparkles size={16} />
            多智能体协同交付
          </summary>
          <div className={styles.collaborationDeliverableBody}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {collaborationDeliverable.content}
            </ReactMarkdown>
          </div>
        </details>
      )}

      {/* Main Content Area */}
      <div className={styles.stepContent}>{renderCurrentStep()}</div>
    </div>
  );
};
