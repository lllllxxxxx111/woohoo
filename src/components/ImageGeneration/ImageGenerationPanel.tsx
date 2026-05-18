import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  Image as ImageIcon,
  ImageOff,
  Library,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  WandSparkles,
  ZoomIn,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store';
import type { Asset } from '../../types';
import {
  bootstrapWorkspace,
  createImageGeneration,
  getImageGeneration,
  getServerAssetBlob,
  listImageGenerations,
  listServerAiEndpoints,
  type ImageGeneration,
} from '../../lib/serverApi';
import { isProtectedAssetUrl, useAssetPreviewUrl } from '../../hooks/useAssetPreviewUrl';
import { notifyBillingCreditsChanged } from '../../hooks/useBillingCredits';
import { useToast } from '../../context/useToast';
import { useAppActions } from '../../context/useAppActions';
import styles from './ImageGenerationPanel.module.css';

type ImageSize = '1024x1024' | '1024x1536' | '1536x1024';
type ImageGenerationTurnStatus = 'generating' | 'completed' | 'failed';

type ImageGenerationTurnParams = {
  endpointId: string;
  endpointName: string;
  model: string;
  size: ImageSize;
  count: number;
  estimatedCost: number;
};

type ImageGenerationTurn = {
  id: string;
  prompt: string;
  params: ImageGenerationTurnParams;
  status: ImageGenerationTurnStatus;
  assetIds: string[];
  b64Data: string[];
  error?: string;
  generationId?: string;
  creditsCost?: number;
  revisedPrompt?: string | null;
  createdAt: number;
  completedAt?: number;
};

type ServerAiEndpoint = Awaited<ReturnType<typeof listServerAiEndpoints>>[number];

type PreviewImage = {
  src: string;
  name: string;
  caption?: string;
};

const SIZE_OPTIONS: Array<{ value: ImageSize; ratio: string; label: string }> = [
  { value: '1024x1024', ratio: '1:1', label: '方图' },
  { value: '1024x1536', ratio: '2:3', label: '竖图' },
  { value: '1536x1024', ratio: '3:2', label: '横图' },
];

const MODEL_OPTIONS = ['gpt-image-1', 'dall-e-3'];
const DEFAULT_IMAGE_MODEL = 'gpt-image-1';
const MAX_IMAGE_COUNT = 4;
const POLL_INTERVAL_MS = 2500;

const PROMPT_EXAMPLES = [
  '一个雨夜的赛博朋克街角，霓虹招牌反射在湿漉漉的路面上，电影感构图',
  '面向年轻品牌的夏季饮品海报，清爽光线，产品在画面中心，背景干净',
  '国风奇幻角色设定图，白色长袍，竹林薄雾，细节丰富但画面克制',
];

function isImageGenerationAsset(asset: Asset) {
  return asset.metadata?.origin === 'image_generation';
}

function getImageGenerationModel(endpoint?: ServerAiEndpoint | null) {
  return endpoint?.defaultModel?.trim() || DEFAULT_IMAGE_MODEL;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function endpointMatchesSettings(
  endpoint: ServerAiEndpoint,
  settings: { provider: string; baseUrl: string; model: string },
) {
  return (
    endpoint.provider.trim().toLowerCase() === settings.provider.trim().toLowerCase() &&
    normalizeBaseUrl(endpoint.baseUrl) === normalizeBaseUrl(settings.baseUrl) &&
    (endpoint.defaultModel?.trim() || '') === settings.model.trim()
  );
}

function uniq(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function clampImageCount(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_IMAGE_COUNT, Math.max(1, value));
}

function calculateCost(model: string, size: ImageSize, count: number) {
  const baseCost = model === 'dall-e-3' ? 5 : 3;
  const sizeMultiplier = size === '1024x1024' ? 1 : 1.5;
  return baseCost * sizeMultiplier * count;
}

function getSizeOption(size: ImageSize) {
  return SIZE_OPTIONS.find((option) => option.value === size) ?? SIZE_OPTIONS[0];
}

function normalizeImageSize(value: string): ImageSize {
  return value === '1024x1536' || value === '1536x1024' ? value : '1024x1024';
}

function parseServerTime(value?: string | null, fallback = Date.now()) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function generationStatusToTurnStatus(status: ImageGeneration['status']): ImageGenerationTurnStatus {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return 'generating';
}

function toImageDataUrl(b64Data: string) {
  const normalized = b64Data.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith('data:')) {
    return normalized;
  }
  return `data:image/png;base64,${normalized}`;
}

function cleanGenerationErrorMessage(message?: string | null) {
  const raw = (message || '').trim();
  if (!raw) {
    return {
      title: '生成没有完成',
      message: '请求没有完成，失败不会扣积分，请稍后重试。',
      detail: '',
    };
  }

  const withoutPrefixes = raw
    .replace(/^内部错误:\s*/g, '')
    .replace(/^图片生成失败:\s*/g, '')
    .replace(/^图片生成 API 调用失败:\s*/g, '')
    .trim();
  const lowered = withoutPrefixes.toLowerCase();

  if (
    withoutPrefixes.includes('os error 10013') ||
    withoutPrefixes.includes('访问权限不允许') ||
    withoutPrefixes.includes('访问套接字')
  ) {
    return {
      title: '后端网络权限被拦截',
      message: '本地后端没有外网 socket 权限。已用正常网络权限重启后端，失败不会扣积分，可以直接重试。',
      detail: withoutPrefixes,
    };
  }

  if (lowered.includes('timeout') || lowered.includes('timed out') || withoutPrefixes.includes('超时')) {
    return {
      title: '上游生成超时',
      message: '生成耗时过长或连接中断。失败不会扣积分，稍后重试即可。',
      detail: withoutPrefixes,
    };
  }

  if (lowered.includes('bad gateway') || withoutPrefixes.includes('502')) {
    return {
      title: '上游通道暂时不可用',
      message: '上游返回 502，通常是算力或代理短暂不可用。失败不会扣积分，请稍后重试。',
      detail: withoutPrefixes,
    };
  }

  if (
    lowered.includes('connect') ||
    lowered.includes('error sending request for url') ||
    withoutPrefixes.includes('无法连接')
  ) {
    return {
      title: '无法连接图片生成通道',
      message: '请检查后端网络权限、代理和 API 地址配置。失败不会扣积分。',
      detail: withoutPrefixes,
    };
  }

  return {
    title: '生成失败',
    message: withoutPrefixes,
    detail: withoutPrefixes,
  };
}

function shouldCompactTurn(turn: ImageGenerationTurn, index: number, total: number) {
  if (turn.status !== 'failed') {
    return false;
  }
  return index < total - 1;
}

function createOptimisticTurnId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `image-turn-${crypto.randomUUID()}`;
  }
  return `image-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generationToTurn(
  generation: ImageGeneration,
  endpointNameById: Map<string, string>,
): ImageGenerationTurn {
  const size = normalizeImageSize(generation.size);
  const count = clampImageCount(generation.n);
  return {
    id: generation.id,
    generationId: generation.id,
    prompt: generation.prompt,
    params: {
      endpointId: '',
      endpointName: endpointNameById.get('') ?? '历史通道',
      model: generation.model || DEFAULT_IMAGE_MODEL,
      size,
      count,
      estimatedCost: calculateCost(generation.model || DEFAULT_IMAGE_MODEL, size, count),
    },
    status: generationStatusToTurnStatus(generation.status),
    assetIds: generation.assetIds,
    b64Data: generation.b64Data,
    error: generation.errorMessage ?? undefined,
    creditsCost: generation.costCredits,
    revisedPrompt: generation.revisedPrompt,
    createdAt: parseServerTime(generation.createdAt),
    completedAt: generation.completedAt ? parseServerTime(generation.completedAt) : undefined,
  };
}

const AssetImage: React.FC<{ asset: Asset; onPreview: (preview: PreviewImage) => void }> = ({
  asset,
  onPreview,
}) => {
  const { previewUrl, status, error } = useAssetPreviewUrl(asset);

  if (status === 'ready' && previewUrl) {
    return (
      <button
        type="button"
        className={styles.assetImageButton}
        onClick={() => onPreview({ src: previewUrl, name: asset.name })}
        title="放大预览"
      >
        <img src={previewUrl} alt={asset.name} loading="lazy" />
        <span className={styles.zoomHint}>
          <ZoomIn size={16} />
        </span>
      </button>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.assetImagePlaceholder} title={error ?? '资产文件无法预览'}>
        <ImageOff size={28} />
        <span>无法预览</span>
      </div>
    );
  }

  return (
    <div className={styles.assetImagePlaceholder} aria-label={`${asset.name} 正在加载预览`}>
      <Loader2 size={26} className={styles.assetImageSpinner} />
    </div>
  );
};

export const ImageGenerationPanel: React.FC = () => {
  const {
    activeState,
    activeAssets,
    aiSettings,
    serverAiEndpointId,
    projects,
    switchTab,
    setActiveProject,
    setSettingsOpen,
  } = useAppStore(
    useShallow((state) => ({
      activeState: state.activeState,
      activeAssets: state.activeAssets,
      aiSettings: state.aiSettings,
      serverAiEndpointId: state.serverAiEndpointId,
      projects: state.projects,
      switchTab: state.switchTab,
      setActiveProject: state.setActiveProject,
      setSettingsOpen: state.setSettingsOpen,
    })),
  );
  const { showToast } = useToast();
  const { createProject, suggestProjectName } = useAppActions();
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(DEFAULT_IMAGE_MODEL);
  const [endpointId, setEndpointId] = useState('');
  const [endpoints, setEndpoints] = useState<ServerAiEndpoint[]>([]);
  const [endpointsLoading, setEndpointsLoading] = useState(false);
  const [endpointsError, setEndpointsError] = useState<string | null>(null);
  const [size, setSize] = useState<ImageSize>('1024x1024');
  const [count, setCount] = useState(1);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ImageGenerationTurn[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [parameterSheetOpen, setParameterSheetOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const missingAssetRefreshKeyRef = useRef('');
  const projectPickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!projectPickerOpen) {
      return undefined;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (
        projectPickerRef.current &&
        !projectPickerRef.current.contains(event.target as Node)
      ) {
        setProjectPickerOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [projectPickerOpen]);

  useEffect(() => {
    let cancelled = false;
    setEndpointsLoading(true);
    setEndpointsError(null);

    void listServerAiEndpoints(true)
      .then((items) => {
        if (cancelled) {
          return;
        }
        setEndpoints(items.filter((endpoint) => endpoint.isActive));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setEndpoints([]);
        setEndpointsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setEndpointsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const endpointNameById = useMemo(() => {
    const nextMap = new Map<string, string>();
    for (const endpoint of endpoints) {
      nextMap.set(endpoint.id, endpoint.name);
    }
    return nextMap;
  }, [endpoints]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeState.projectId) ?? null,
    [activeState.projectId, projects],
  );

  const imageAssets = useMemo(
    () =>
      activeAssets
        .filter((asset) => asset.type === 'image')
        .sort((left, right) => right.createdAt - left.createdAt),
    [activeAssets],
  );

  const generatedAssets = useMemo(() => imageAssets.filter(isImageGenerationAsset), [imageAssets]);

  const assetById = useMemo(() => {
    const nextMap = new Map<string, Asset>();
    for (const asset of imageAssets) {
      nextMap.set(asset.id, asset);
    }
    return nextMap;
  }, [imageAssets]);

  const latestGeneratedAsset = useMemo(() => {
    if (selectedAssetId) {
      return generatedAssets.find((asset) => asset.id === selectedAssetId) ?? generatedAssets[0] ?? null;
    }
    return generatedAssets[0] ?? null;
  }, [selectedAssetId, generatedAssets]);

  const selectedEndpoint = useMemo(
    () => endpoints.find((endpoint) => endpoint.id === endpointId) ?? endpoints[0] ?? null,
    [endpointId, endpoints],
  );

  const modelOptions = useMemo(
    () => uniq([getImageGenerationModel(selectedEndpoint), selectedEndpoint?.defaultModel || '', model, ...MODEL_OPTIONS]),
    [model, selectedEndpoint],
  );

  const estimatedCost = calculateCost(model, size, count);
  const hasProject = Boolean(activeState.projectId);
  const trimmedPrompt = prompt.trim();
  const hasImageEndpoint = endpoints.length > 0;
  const isGenerating = turns.some((turn) => turn.status === 'generating');
  const missingCompletedAssetIds = useMemo(() => {
    const missingIds = new Set<string>();
    for (const turn of turns) {
      if (turn.status !== 'completed') {
        continue;
      }
      for (const assetId of turn.assetIds) {
        if (!assetById.has(assetId)) {
          missingIds.add(assetId);
        }
      }
    }
    return Array.from(missingIds);
  }, [assetById, turns]);
  const missingCompletedAssetKey = useMemo(
    () =>
      activeState.projectId && missingCompletedAssetIds.length > 0
        ? `${activeState.projectId}:${[...missingCompletedAssetIds].sort().join(',')}`
        : '',
    [activeState.projectId, missingCompletedAssetIds],
  );

  useEffect(() => {
    if (!hasImageEndpoint) {
      if (endpointId) {
        setEndpointId('');
      }
      return;
    }

    const preferredEndpoint =
      endpoints.find((endpoint) => endpoint.id === serverAiEndpointId) ??
      endpoints.find((endpoint) => endpointMatchesSettings(endpoint, aiSettings));
    const currentExists = endpoints.some((endpoint) => endpoint.id === endpointId);
    if (!currentExists) {
      setEndpointId((preferredEndpoint ?? endpoints[0]).id);
    }
  }, [aiSettings, endpointId, endpoints, hasImageEndpoint, serverAiEndpointId]);

  useEffect(() => {
    const defaultModel = getImageGenerationModel(selectedEndpoint);
    if (!defaultModel) {
      return;
    }
    setModel((currentModel) =>
      !currentModel || MODEL_OPTIONS.includes(currentModel) ? defaultModel : currentModel,
    );
  }, [selectedEndpoint]);

  const refreshWorkspace = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const workspace = await bootstrapWorkspace(true);
      useAppStore.setState((state) => {
        const activeProjectId = state.activeState.projectId;
        return {
          projects: workspace.projects,
          assets: workspace.assets,
          activeAssets: workspace.assets.filter((asset) => asset.projectId === activeProjectId),
          scripts: workspace.scripts,
          storyboards: workspace.storyboards,
          allAgentContacts:
            Array.isArray(workspace.agents) && workspace.agents.length > 0
              ? workspace.agents
              : state.allAgentContacts,
        };
      });
      notifyBillingCreditsChanged();
      return workspace;
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!missingCompletedAssetKey || isRefreshing) {
      return;
    }

    if (missingAssetRefreshKeyRef.current === missingCompletedAssetKey) {
      return;
    }
    missingAssetRefreshKeyRef.current = missingCompletedAssetKey;

    void refreshWorkspace().catch((error) => {
      setHistoryError(error instanceof Error ? error.message : '同步资产库失败');
    });
  }, [isRefreshing, missingCompletedAssetKey, refreshWorkspace]);

  const mergeGenerationTurn = useCallback(
    (generation: ImageGeneration) => {
      const nextTurn = generationToTurn(generation, endpointNameById);
      setTurns((currentTurns) => {
        const existingIndex = currentTurns.findIndex((turn) => turn.generationId === generation.id || turn.id === generation.id);
        if (existingIndex < 0) {
          return [...currentTurns, nextTurn].sort((left, right) => left.createdAt - right.createdAt);
        }
        const nextTurns = [...currentTurns];
        nextTurns[existingIndex] = {
          ...nextTurns[existingIndex],
          ...nextTurn,
          params: {
            ...nextTurn.params,
            endpointId: nextTurns[existingIndex].params.endpointId,
            endpointName: nextTurns[existingIndex].params.endpointName || nextTurn.params.endpointName,
          },
        };
        return nextTurns;
      });
      if (generation.assetIds[0]) {
        setSelectedAssetId(generation.assetIds[0]);
      }
    },
    [endpointNameById],
  );

  const loadGenerationHistory = useCallback(async () => {
    if (!activeState.projectId) {
      setTurns([]);
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const generations = await listImageGenerations();
      const projectGenerations = generations
        .filter((generation) => generation.projectId === activeState.projectId)
        .slice(0, 8)
        .reverse();
      setTurns(projectGenerations.map((generation) => generationToTurn(generation, endpointNameById)));
      const latestAssetId = projectGenerations
        .slice()
        .reverse()
        .find((generation) => generation.assetIds.length > 0)?.assetIds[0];
      if (latestAssetId) {
        setSelectedAssetId(latestAssetId);
      }
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '读取生成记录失败');
    } finally {
      setHistoryLoading(false);
    }
  }, [activeState.projectId, endpointNameById]);

  useEffect(() => {
    void loadGenerationHistory();
  }, [loadGenerationHistory]);

  useEffect(() => {
    const runningGenerationIds = turns
      .filter((turn) => turn.status === 'generating' && turn.generationId)
      .map((turn) => turn.generationId as string);
    if (runningGenerationIds.length === 0) {
      return undefined;
    }

    let cancelled = false;
    const poll = async () => {
      await Promise.all(
        runningGenerationIds.map(async (generationId) => {
          try {
            const generation = await getImageGeneration(generationId);
            if (cancelled) {
              return;
            }
            mergeGenerationTurn(generation);
            if (generation.status === 'completed' || generation.status === 'failed') {
              await refreshWorkspace();
            }
          } catch (error) {
            if (!cancelled) {
              setHistoryError(error instanceof Error ? error.message : '同步生成状态失败');
            }
          }
        }),
      );
    };

    const intervalId = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    void poll();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [mergeGenerationTurn, refreshWorkspace, turns]);

  const buildCurrentParams = (): ImageGenerationTurnParams => ({
    endpointId: selectedEndpoint?.id ?? endpointId,
    endpointName: selectedEndpoint?.name ?? '默认通道',
    model: model.trim() || DEFAULT_IMAGE_MODEL,
    size,
    count,
    estimatedCost,
  });

  const runGeneration = async (
    promptText: string,
    params: ImageGenerationTurnParams,
    options: { clearPrompt?: boolean } = {},
  ) => {
    const projectId = activeState.projectId;
    const cleanPrompt = promptText.trim();
    const endpoint =
      endpoints.find((item) => item.id === params.endpointId) ??
      endpoints.find((item) => item.id === endpointId) ??
      selectedEndpoint;

    if (!projectId) {
      showToast({
        type: 'warning',
        title: '请选择项目',
        message: '图片生成结果必须保存到当前项目资产库。',
      });
      return;
    }

    if (!cleanPrompt) {
      showToast({
        type: 'warning',
        title: '提示词不能为空',
        message: '先描述画面主体、风格或用途，再开始生成。',
      });
      return;
    }

    if (!endpoint) {
      showToast({
        type: 'warning',
        title: '缺少可用 API 通道',
        message: '请先在设置里配置一个可用通道，前端不会选择底层接口路径。',
      });
      return;
    }

    const optimisticTurnId = createOptimisticTurnId();
    const turnParams: ImageGenerationTurnParams = {
      ...params,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      model: params.model.trim() || getImageGenerationModel(endpoint),
      count: clampImageCount(params.count),
      estimatedCost: calculateCost(params.model, params.size, clampImageCount(params.count)),
    };

    setTurns((currentTurns) => [
      ...currentTurns,
      {
        id: optimisticTurnId,
        prompt: cleanPrompt,
        params: turnParams,
        status: 'generating',
        assetIds: [],
        b64Data: [],
        createdAt: Date.now(),
      },
    ]);
    setParameterSheetOpen(false);

    try {
      const generation = await createImageGeneration({
        projectId,
        endpointId: endpoint.id,
        prompt: cleanPrompt,
        model: turnParams.model,
        size: turnParams.size,
        n: turnParams.count,
      });

      setTurns((currentTurns) => {
        const existingIndex = currentTurns.findIndex((turn) => turn.id === optimisticTurnId);
        const nextTurn: ImageGenerationTurn = {
          ...generationToTurn(generation, endpointNameById),
          prompt: cleanPrompt,
          params: turnParams,
        };

        if (existingIndex < 0) {
          return [...currentTurns, nextTurn].sort((left, right) => left.createdAt - right.createdAt);
        }

        const nextTurns = [...currentTurns];
        nextTurns[existingIndex] = {
          ...currentTurns[existingIndex],
          ...nextTurn,
        };
        return nextTurns;
      });
      if (options.clearPrompt) {
        setPrompt('');
      }
      notifyBillingCreditsChanged();
      showToast({
        type: 'success',
        title: '任务已开始',
        message: '生成状态会自动同步，刷新页面后也会继续显示。',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片生成失败';
      setTurns((currentTurns) =>
        currentTurns.map((turn) =>
          turn.id === optimisticTurnId
            ? {
                ...turn,
                status: 'failed',
                error: message,
                completedAt: Date.now(),
              }
            : turn,
        ),
      );
      notifyBillingCreditsChanged();
      showToast({
        type: 'error',
        title: '生成失败',
        message,
      });
    }
  };

  const handleGenerate = () => {
    void runGeneration(trimmedPrompt, buildCurrentParams(), { clearPrompt: true });
  };

  const handleSelectProject = (projectId: string) => {
    setActiveProject(projectId);
    setProjectPickerOpen(false);
    const projectName = projects.find((project) => project.id === projectId)?.name || '当前项目';
    showToast({
      type: 'success',
      title: '已设置当前项目',
      message: `后续图片会保存到「${projectName}」。`,
    });
  };

  const handleCreateProjectForGeneration = async () => {
    try {
      const project = await createProject(suggestProjectName());
      setActiveProject(project.id);
      setProjectPickerOpen(false);
      showToast({
        type: 'success',
        title: '项目已创建',
        message: `后续图片会保存到「${project.name}」。`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '创建项目失败',
        message: error instanceof Error ? error.message : '无法创建项目',
      });
    }
  };

  const handleRetryTurn = (turn: ImageGenerationTurn) => {
    void runGeneration(turn.prompt, turn.params);
  };

  const handleReuseTurn = (turn: ImageGenerationTurn) => {
    setPrompt(turn.prompt);
    setEndpointId(turn.params.endpointId);
    setModel(turn.params.model);
    setSize(turn.params.size);
    setCount(turn.params.count);
  };

  const handleDownload = async (asset: Asset) => {
    try {
      const link = window.document.createElement('a');
      link.download = asset.name;
      link.target = '_blank';
      link.rel = 'noreferrer';

      if (isProtectedAssetUrl(asset.id, asset.url)) {
        const blob = await getServerAssetBlob(asset.id);
        const objectUrl = window.URL.createObjectURL(blob);
        link.href = objectUrl;
        link.click();
        window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1_000);
      } else {
        link.href = asset.url;
        link.click();
      }
    } catch (error) {
      showToast({
        type: 'error',
        title: '下载失败',
        message: error instanceof Error ? error.message : '资产下载失败',
      });
    }
  };

  const handleViewInAssets = (asset?: Asset | null) => {
    if (asset) {
      setSelectedAssetId(asset.id);
      showToast({
        type: 'info',
        title: '已切换到资产库',
        message: `可在公共资产库中查看 ${asset.name}。`,
      });
    }
    switchTab('assets');
  };

  return (
    <div className={styles.container}>
      <header className={styles.topBar}>
        <div className={styles.topBarTitle}>
          <span className={styles.productMark}>
            <WandSparkles size={18} />
          </span>
          <div>
            <h2>图片生成</h2>
            <p>{activeProject ? activeProject.name : '选择项目后，结果会保存到公共资产库'}</p>
          </div>
        </div>
        <div className={styles.topBarMeta}>
          <div className={styles.projectPicker} ref={projectPickerRef}>
            <button
              type="button"
              className={`${styles.projectSelectButton} ${!activeProject ? styles.projectSelectMissing : ''}`}
              onClick={() => setProjectPickerOpen((prev) => !prev)}
            >
              <span>{activeProject ? '当前项目' : '设置当前项目'}</span>
              <strong>{activeProject?.name || '未选择'}</strong>
              <ChevronDown size={14} />
            </button>
            {projectPickerOpen && (
              <div className={styles.projectPickerMenu}>
                {projects.length === 0 ? (
                  <div className={styles.projectPickerEmpty}>还没有项目，先新建后再生成图片。</div>
                ) : (
                  projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className={project.id === activeState.projectId ? styles.activeProjectItem : undefined}
                      onClick={() => handleSelectProject(project.id)}
                    >
                      <span>{project.name}</span>
                      <small>{project.assetsCount} 个资产</small>
                    </button>
                  ))
                )}
                <button
                  type="button"
                  className={styles.createProjectButton}
                  onClick={() => void handleCreateProjectForGeneration()}
                >
                  <Plus size={14} />
                  新建项目
                </button>
              </div>
            )}
          </div>
          <button
            className={styles.iconButton}
            onClick={() => void refreshWorkspace()}
            disabled={isRefreshing}
            title="刷新资产和状态"
          >
            <RefreshCw size={16} className={isRefreshing ? styles.spin : undefined} />
          </button>
        </div>
      </header>

      <ImageGenerationThread
        turns={turns}
        latestGeneratedAsset={latestGeneratedAsset}
        assetById={assetById}
        historyLoading={historyLoading}
        historyError={historyError}
        onUsePrompt={setPrompt}
        onDownload={(asset) => void handleDownload(asset)}
        onRetry={handleRetryTurn}
        onReuse={handleReuseTurn}
        onViewInAssets={handleViewInAssets}
        onPreview={setPreviewImage}
      />

      <PromptComposer
        prompt={prompt}
        onPromptChange={setPrompt}
        size={size}
        onSizeChange={setSize}
        count={count}
        onCountChange={(value) => setCount(clampImageCount(value))}
        model={model}
        onModelChange={setModel}
        endpointId={endpointId}
        onEndpointChange={(nextEndpointId) => {
          const nextEndpoint = endpoints.find((endpoint) => endpoint.id === nextEndpointId);
          setEndpointId(nextEndpointId);
          setModel(getImageGenerationModel(nextEndpoint));
        }}
        endpoints={endpoints}
        endpointsLoading={endpointsLoading}
        endpointsError={endpointsError}
        hasImageEndpoint={hasImageEndpoint}
        modelOptions={modelOptions}
        estimatedCost={estimatedCost}
        isGenerating={isGenerating}
        hasProject={hasProject}
        projectCount={projects.length}
        canGenerate={hasProject && Boolean(trimmedPrompt) && Boolean(selectedEndpoint) && !isGenerating}
        parameterSheetOpen={parameterSheetOpen}
        onParameterSheetOpenChange={setParameterSheetOpen}
        onGenerate={handleGenerate}
        onOpenProjectPicker={() => setProjectPickerOpen(true)}
        onCreateProject={() => void handleCreateProjectForGeneration()}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {previewImage && (
        <ImagePreviewDialog preview={previewImage} onClose={() => setPreviewImage(null)} />
      )}
    </div>
  );
};

type ImageGenerationThreadProps = {
  turns: ImageGenerationTurn[];
  latestGeneratedAsset: Asset | null;
  assetById: Map<string, Asset>;
  historyLoading: boolean;
  historyError: string | null;
  onUsePrompt: (prompt: string) => void;
  onDownload: (asset: Asset) => void;
  onRetry: (turn: ImageGenerationTurn) => void;
  onReuse: (turn: ImageGenerationTurn) => void;
  onViewInAssets: (asset?: Asset | null) => void;
  onPreview: (preview: PreviewImage) => void;
};

const ImageGenerationThread: React.FC<ImageGenerationThreadProps> = ({
  turns,
  latestGeneratedAsset,
  assetById,
  historyLoading,
  historyError,
  onUsePrompt,
  onDownload,
  onRetry,
  onReuse,
  onViewInAssets,
  onPreview,
}) => {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({
      behavior: turns.length > 1 ? 'smooth' : 'auto',
      block: 'end',
    });
  }, [turns]);

  return (
    <main className={styles.threadScroller}>
      <div className={styles.thread}>
        {turns.length === 0 ? (
          <EmptyThread
            latestGeneratedAsset={latestGeneratedAsset}
            historyLoading={historyLoading}
            historyError={historyError}
            onUsePrompt={onUsePrompt}
            onDownload={onDownload}
            onViewInAssets={onViewInAssets}
            onPreview={onPreview}
          />
        ) : (
          <>
            {historyError && <div className={styles.inlineError}>{historyError}</div>}
            {turns.map((turn, index) => {
              const assets = turn.assetIds
                .map((assetId) => assetById.get(assetId))
                .filter((asset): asset is Asset => Boolean(asset));
              const compact = shouldCompactTurn(turn, index, turns.length);
              return (
                <section
                  key={turn.id}
                  className={`${styles.turn} ${compact ? styles.compactTurn : ''}`}
                >
                  {!compact && (
                    <div className={styles.userMessage}>
                      <div className={styles.messageLabel}>本轮提示词</div>
                      <p>{turn.prompt}</p>
                      <ParameterSummary params={turn.params} />
                    </div>
                  )}
                  <GenerationResultCard
                    turn={turn}
                    assets={assets}
                    compact={compact}
                    onDownload={onDownload}
                    onRetry={() => onRetry(turn)}
                    onReuse={() => onReuse(turn)}
                    onViewInAssets={onViewInAssets}
                    onPreview={onPreview}
                  />
                </section>
              );
            })}
          </>
        )}
        <div ref={endRef} />
      </div>
    </main>
  );
};

const EmptyThread: React.FC<{
  latestGeneratedAsset: Asset | null;
  historyLoading: boolean;
  historyError: string | null;
  onUsePrompt: (prompt: string) => void;
  onDownload: (asset: Asset) => void;
  onViewInAssets: (asset?: Asset | null) => void;
  onPreview: (preview: PreviewImage) => void;
}> = ({
  latestGeneratedAsset,
  historyLoading,
  historyError,
  onUsePrompt,
  onDownload,
  onViewInAssets,
  onPreview,
}) => {
  return (
    <div className={styles.emptyThread}>
      <div className={styles.emptyHero}>
        <div className={styles.emptyIcon}>
          <Sparkles size={28} />
        </div>
        <h3>{historyLoading ? '正在恢复生成状态' : '用一句话开始创作'}</h3>
        <p>
          {historyLoading
            ? '正在读取后端生成记录，刷新页面后的任务也会回到这里。'
            : '输入画面、风格和用途即可生成。尺寸、数量、模型都在下方输入器里调整。'}
        </p>
        {historyError && <div className={styles.inlineError}>{historyError}</div>}
      </div>
      <div className={styles.promptExamples}>
        {PROMPT_EXAMPLES.map((example) => (
          <button key={example} type="button" onClick={() => onUsePrompt(example)}>
            {example}
          </button>
        ))}
      </div>
      {latestGeneratedAsset && (
        <div className={styles.recentResult}>
          <div className={styles.recentCopy}>
            <span>最近一次生成</span>
            <strong>{latestGeneratedAsset.name}</strong>
          </div>
          <GenerationAssetGrid
            assets={[latestGeneratedAsset]}
            onDownload={onDownload}
            onViewInAssets={onViewInAssets}
            onPreview={onPreview}
          />
        </div>
      )}
    </div>
  );
};

const ParameterSummary: React.FC<{ params: ImageGenerationTurnParams }> = ({ params }) => {
  const sizeOption = getSizeOption(params.size);
  return (
    <div className={styles.summaryChips}>
      <span>{params.model}</span>
      <span>{sizeOption.ratio}</span>
      <span>{params.count} 张</span>
      <span>{params.estimatedCost} 积分</span>
      <span>{params.endpointName}</span>
    </div>
  );
};

const GenerationResultCard: React.FC<{
  turn: ImageGenerationTurn;
  assets: Asset[];
  compact?: boolean;
  onDownload: (asset: Asset) => void;
  onRetry: () => void;
  onReuse: () => void;
  onViewInAssets: (asset?: Asset | null) => void;
  onPreview: (preview: PreviewImage) => void;
}> = ({ turn, assets, compact = false, onDownload, onRetry, onReuse, onViewInAssets, onPreview }) => {
  if (turn.status === 'generating') {
    return (
      <div className={styles.systemCard}>
        <div className={styles.cardHeader}>
          <span className={styles.statusIcon}>
            <Loader2 size={18} className={styles.spin} />
          </span>
          <div>
            <strong>正在生成图片</strong>
            <p>
              {turn.params.model} / {getSizeOption(turn.params.size).ratio} / {turn.params.count} 张
            </p>
          </div>
        </div>
        <div className={styles.generatingPlaceholder}>
          {Array.from({ length: turn.params.count }).map((_, index) => (
            <div key={index} className={styles.placeholderTile}>
              <ImageIcon size={28} />
              <span>生成中</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (turn.status === 'failed') {
    const errorInfo = cleanGenerationErrorMessage(turn.error);
    return (
      <div className={`${styles.systemCard} ${styles.failedCard} ${compact ? styles.compactFailedCard : ''}`}>
        <div className={styles.cardHeader}>
          <span className={styles.errorIcon}>
            <AlertTriangle size={18} />
          </span>
          <div>
            <strong>{errorInfo.title}</strong>
            <p>{errorInfo.message}</p>
          </div>
        </div>
        {!compact && errorInfo.detail && errorInfo.detail !== errorInfo.message && (
          <details className={styles.errorDetails}>
            <summary>技术细节</summary>
            <p>{errorInfo.detail}</p>
          </details>
        )}
        {!compact && (
          <div className={styles.failureNote}>失败任务不会扣积分；如果保存资产失败导致临时扣费，后端会自动退款。</div>
        )}
        <div className={styles.resultActions}>
          <button type="button" onClick={onRetry}>
            <RotateCcw size={15} />
            重试
          </button>
          <button type="button" onClick={onReuse}>
            <Settings2 size={15} />
            复用参数
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.systemCard}>
      <div className={styles.cardHeader}>
        <span className={styles.successIcon}>
          <CheckCircle2 size={18} />
        </span>
        <div>
          <strong>已保存到公共资产库</strong>
          <p>
            {turn.creditsCost ?? turn.params.estimatedCost} 积分 / {assets.length || turn.assetIds.length} 张结果
          </p>
        </div>
      </div>
      {assets.length > 0 ? (
        <GenerationAssetGrid
          assets={assets}
          onDownload={onDownload}
          onViewInAssets={onViewInAssets}
          onPreview={onPreview}
        />
      ) : turn.b64Data.length > 0 ? (
        <GenerationInlineImageGrid
          images={turn.b64Data.map((b64, index) => ({
            src: toImageDataUrl(b64),
            name: `${turn.prompt.slice(0, 24) || '生成图片'}-${index + 1}.png`,
          }))}
          onPreview={onPreview}
        />
      ) : (
        <div className={styles.assetRefreshHint}>
          <ImageIcon size={22} />
          图片已写入资产库，正在刷新预览。
        </div>
      )}
      {turn.revisedPrompt && (
        <p className={styles.revisedPrompt}>模型改写提示词：{turn.revisedPrompt}</p>
      )}
      <div className={styles.resultActions}>
        <button type="button" onClick={onRetry}>
          <RotateCcw size={15} />
          再次生成
        </button>
        <button type="button" onClick={onReuse}>
          <Settings2 size={15} />
          复用参数
        </button>
        <button type="button" onClick={() => onViewInAssets(assets[0] ?? null)}>
          <Library size={15} />
          在资产库查看
        </button>
      </div>
    </div>
  );
};

const GenerationInlineImageGrid: React.FC<{
  images: Array<{ src: string | null; name: string }>;
  onPreview: (preview: PreviewImage) => void;
}> = ({ images, onPreview }) => {
  const validImages = images.filter((image): image is { src: string; name: string } =>
    Boolean(image.src),
  );

  if (validImages.length === 0) {
    return null;
  }

  return (
    <div className={validImages.length > 1 ? styles.assetGrid : styles.singleAssetGrid}>
      {validImages.map((image) => (
        <figure key={image.src} className={styles.assetFigure}>
          <div className={styles.assetImageFrame}>
            <button
              type="button"
              className={styles.assetImageButton}
              onClick={() => onPreview({ src: image.src, name: image.name })}
              title="放大预览"
            >
              <img src={image.src} alt={image.name} loading="lazy" />
              <span className={styles.zoomHint}>
                <ZoomIn size={16} />
              </span>
            </button>
          </div>
          <figcaption>
            <span title={image.name}>{image.name}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
};

const GenerationAssetGrid: React.FC<{
  assets: Asset[];
  onDownload: (asset: Asset) => void;
  onViewInAssets: (asset?: Asset | null) => void;
  onPreview: (preview: PreviewImage) => void;
}> = ({ assets, onDownload, onViewInAssets, onPreview }) => {
  return (
    <div className={assets.length > 1 ? styles.assetGrid : styles.singleAssetGrid}>
      {assets.map((asset) => (
        <figure key={asset.id} className={styles.assetFigure}>
          <div className={styles.assetImageFrame}>
            <AssetImage asset={asset} onPreview={onPreview} />
          </div>
          <figcaption>
            <span title={asset.name}>{asset.name}</span>
            <div className={styles.assetActions}>
              <button type="button" onClick={() => onDownload(asset)} title="下载">
                <Download size={15} />
              </button>
              <button type="button" onClick={() => onViewInAssets(asset)} title="在资产库查看">
                <Library size={15} />
              </button>
            </div>
          </figcaption>
        </figure>
      ))}
    </div>
  );
};

const ImagePreviewDialog: React.FC<{
  preview: PreviewImage;
  onClose: () => void;
}> = ({ preview, onClose }) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className={styles.previewOverlay} role="dialog" aria-modal="true" onClick={onClose}>
      <div className={styles.previewDialog} onClick={(event) => event.stopPropagation()}>
        <div className={styles.previewHeader}>
          <div>
            <strong>{preview.name}</strong>
            {preview.caption && <span>{preview.caption}</span>}
          </div>
          <button type="button" onClick={onClose} title="关闭预览">
            <X size={18} />
          </button>
        </div>
        <div className={styles.previewCanvas}>
          <img src={preview.src} alt={preview.name} />
        </div>
      </div>
    </div>
  );
};

type PromptComposerProps = {
  prompt: string;
  onPromptChange: (value: string) => void;
  size: ImageSize;
  onSizeChange: (value: ImageSize) => void;
  count: number;
  onCountChange: (value: number) => void;
  model: string;
  onModelChange: (value: string) => void;
  endpointId: string;
  onEndpointChange: (value: string) => void;
  endpoints: ServerAiEndpoint[];
  endpointsLoading: boolean;
  endpointsError: string | null;
  hasImageEndpoint: boolean;
  modelOptions: string[];
  estimatedCost: number;
  isGenerating: boolean;
  hasProject: boolean;
  projectCount: number;
  canGenerate: boolean;
  parameterSheetOpen: boolean;
  onParameterSheetOpenChange: (open: boolean) => void;
  onGenerate: () => void;
  onOpenProjectPicker: () => void;
  onCreateProject: () => void;
  onOpenSettings: () => void;
};

const PromptComposer: React.FC<PromptComposerProps> = ({
  prompt,
  onPromptChange,
  size,
  onSizeChange,
  count,
  onCountChange,
  model,
  onModelChange,
  endpointId,
  onEndpointChange,
  endpoints,
  endpointsLoading,
  endpointsError,
  hasImageEndpoint,
  modelOptions,
  estimatedCost,
  isGenerating,
  hasProject,
  projectCount,
  canGenerate,
  parameterSheetOpen,
  onParameterSheetOpenChange,
  onGenerate,
  onOpenProjectPicker,
  onCreateProject,
  onOpenSettings,
}) => {
  const currentSize = getSizeOption(size);
  const selectedEndpoint = endpoints.find((endpoint) => endpoint.id === endpointId) ?? endpoints[0] ?? null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (canGenerate) {
        onGenerate();
      }
    }
  };

  return (
    <footer className={styles.composerDock}>
      <div className={styles.composer}>
        {parameterSheetOpen && (
          <ComposerParameterSheet
            size={size}
            onSizeChange={onSizeChange}
            count={count}
            onCountChange={onCountChange}
            model={model}
            onModelChange={onModelChange}
            endpointId={endpointId}
            onEndpointChange={onEndpointChange}
            endpoints={endpoints}
            endpointsLoading={endpointsLoading}
            hasImageEndpoint={hasImageEndpoint}
            modelOptions={modelOptions}
            estimatedCost={estimatedCost}
            onClose={() => onParameterSheetOpenChange(false)}
            onOpenSettings={onOpenSettings}
          />
        )}

        <div className={styles.composerTextareaRow}>
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="描述你想生成的画面、风格、构图或用途..."
            rows={3}
          />
          <button
            type="button"
            className={styles.generateButton}
            disabled={!canGenerate}
            onClick={onGenerate}
            title={hasProject ? '生成图片' : '请先选择或新建项目'}
          >
            {isGenerating ? <Loader2 size={18} className={styles.spin} /> : <Send size={18} />}
            <span>{isGenerating ? '生成中' : hasProject ? '生成' : '先选项目'}</span>
          </button>
        </div>

        <div className={styles.composerControls}>
          <div className={styles.inlineControls}>
            <div className={styles.sizeSegment} aria-label="图片比例">
              {SIZE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={option.value === size ? styles.activeSegment : undefined}
                  onClick={() => onSizeChange(option.value)}
                  title={`${option.label} ${option.value}`}
                >
                  {option.ratio}
                </button>
              ))}
            </div>
            <div className={styles.countStepper} aria-label="生成数量">
              <button type="button" onClick={() => onCountChange(count - 1)} disabled={count <= 1}>
                <Minus size={13} />
              </button>
              <span>{count} 张</span>
              <button
                type="button"
                onClick={() => onCountChange(count + 1)}
                disabled={count >= MAX_IMAGE_COUNT}
              >
                <Plus size={13} />
              </button>
            </div>
            <button
              type="button"
              className={styles.paramChip}
              onClick={() => onParameterSheetOpenChange(true)}
              title="模型和通道"
            >
              <WandSparkles size={14} />
              <span>{model || '模型'}</span>
              <ChevronDown size={14} />
            </button>
            <span className={styles.costChip}>
              {estimatedCost} 积分
            </span>
            <button
              type="button"
              className={styles.paramChip}
              onClick={() => onParameterSheetOpenChange(!parameterSheetOpen)}
            >
              <Settings2 size={14} />
              <span>更多</span>
            </button>
          </div>
          <div className={styles.composerStatus}>
            {endpointsLoading && <span>读取 API 通道中</span>}
            {!endpointsLoading && !hasImageEndpoint && (
              <button type="button" onClick={onOpenSettings}>
                配置 API 通道
              </button>
            )}
            {selectedEndpoint && <span>{selectedEndpoint.name}</span>}
            {currentSize && <span>{currentSize.label}</span>}
          </div>
        </div>

        {!hasProject && (
          <div className={styles.composerWarning}>
            <AlertTriangle size={15} />
            <span>图片必须保存到明确项目，先选择或新建项目后再生成。</span>
            <button
              type="button"
              onClick={projectCount > 0 ? onOpenProjectPicker : onCreateProject}
            >
              {projectCount > 0 ? '设置项目' : '新建项目'}
            </button>
          </div>
        )}

        {endpointsError && (
          <div className={styles.composerWarning}>
            <AlertTriangle size={15} />
            <span>{endpointsError}</span>
          </div>
        )}
      </div>
    </footer>
  );
};

const ComposerParameterSheet: React.FC<{
  size: ImageSize;
  onSizeChange: (value: ImageSize) => void;
  count: number;
  onCountChange: (value: number) => void;
  model: string;
  onModelChange: (value: string) => void;
  endpointId: string;
  onEndpointChange: (value: string) => void;
  endpoints: ServerAiEndpoint[];
  endpointsLoading: boolean;
  hasImageEndpoint: boolean;
  modelOptions: string[];
  estimatedCost: number;
  onClose: () => void;
  onOpenSettings: () => void;
}> = ({
  size,
  onSizeChange,
  count,
  onCountChange,
  model,
  onModelChange,
  endpointId,
  onEndpointChange,
  endpoints,
  endpointsLoading,
  hasImageEndpoint,
  modelOptions,
  estimatedCost,
  onClose,
  onOpenSettings,
}) => {
  return (
    <div className={styles.parameterSheet}>
      <div className={styles.sheetHeader}>
        <div>
          <strong>生成参数</strong>
          <span>只管理创作参数，底层接口由后端通道处理。</span>
        </div>
        <button type="button" onClick={onClose} title="关闭">
          <X size={17} />
        </button>
      </div>

      <div className={styles.sheetGrid}>
        <label className={styles.sheetField}>
          <span>API 通道</span>
          <select
            value={endpointId}
            disabled={endpointsLoading || !hasImageEndpoint}
            onChange={(event) => onEndpointChange(event.target.value)}
          >
            {hasImageEndpoint ? (
              endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>
                  {endpoint.name}
                </option>
              ))
            ) : (
              <option value="">{endpointsLoading ? '读取通道中' : '没有可用通道'}</option>
            )}
          </select>
        </label>

        <label className={styles.sheetField}>
          <span>模型</span>
          <input
            value={model}
            list="image-generation-model-options"
            onChange={(event) => onModelChange(event.target.value)}
            placeholder={DEFAULT_IMAGE_MODEL}
          />
          <datalist id="image-generation-model-options">
            {modelOptions.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </label>

        <div className={styles.sheetField}>
          <span>比例</span>
          <div className={styles.sheetSegments}>
            {SIZE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={option.value === size ? styles.activeSegment : undefined}
                onClick={() => onSizeChange(option.value)}
              >
                {option.ratio}
                <small>{option.label}</small>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.sheetField}>
          <span>数量</span>
          <div className={styles.sheetCount}>
            <button type="button" onClick={() => onCountChange(count - 1)} disabled={count <= 1}>
              <Minus size={14} />
            </button>
            <strong>{count} 张</strong>
            <button
              type="button"
              onClick={() => onCountChange(count + 1)}
              disabled={count >= MAX_IMAGE_COUNT}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className={styles.sheetFooter}>
        <span>预计消耗 {estimatedCost} 积分</span>
        {!hasImageEndpoint && (
          <button type="button" onClick={onOpenSettings}>
            打开设置
          </button>
        )}
      </div>
    </div>
  );
};
