import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  ConfigProvider,
  Empty,
  Input,
  InputNumber,
  Message,
  Modal,
  Select,
  Tag,
  Typography,
} from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import {
  Clock3,
  Copy,
  Download,
  Image as ImageIcon,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Sparkles,
  WalletCards,
} from 'lucide-react';
import {
  clearStoredSession,
  createImageGeneration,
  ensureServerSession,
  getImageCredits,
  listImageGenerations,
  type ImageGeneration,
  type ImageGenerationStatus,
  type UserCredits,
} from '../src/lib/serverApi';
import { useAppStore } from '../src/store';
import styles from './App.module.css';

const AuthModal = lazy(() =>
  import('../src/components/Auth/AuthModal').then((module) => ({ default: module.AuthModal })),
);

const { Text, Title } = Typography;

const STATUS_LABELS: Record<ImageGenerationStatus, string> = {
  pending: '排队中',
  processing: '生成中',
  completed: '已完成',
  failed: '失败',
};

const STATUS_COLORS: Record<ImageGenerationStatus, string> = {
  pending: 'arcoblue',
  processing: 'orange',
  completed: 'green',
  failed: 'red',
};

const SIZE_OPTIONS = [
  { label: '方图 1024 x 1024', value: '1024x1024' },
  { label: '竖图 1024 x 1792', value: '1024x1792' },
  { label: '横图 1792 x 1024', value: '1792x1024' },
];

function imageSources(generation: ImageGeneration) {
  return [
    ...generation.b64Data.map((value) =>
      value.startsWith('data:') ? value : `data:image/png;base64,${value}`,
    ),
    ...generation.urls,
  ];
}

function formatTime(value?: string | null) {
  if (!value) {
    return '未完成';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function estimateCost(model: string, size: string, count: number) {
  const base = model === 'dall-e-3' ? 5 : 3;
  const multiplier = size === '1024x1792' || size === '1792x1024' ? 1.5 : 1;
  return base * multiplier * Math.max(1, count);
}

function downloadImage(src: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = src;
  anchor.download = filename;
  anchor.rel = 'noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

const App: React.FC = () => {
  const setIsAuthenticated = useAppStore((state) => state.setIsAuthenticated);
  const [authReady, setAuthReady] = useState(false);
  const [isAuthenticated, setLocalAuthenticated] = useState(false);
  const [credits, setCredits] = useState<UserCredits | null>(null);
  const [generations, setGenerations] = useState<ImageGeneration[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('dall-e-3');
  const [size, setSize] = useState('1024x1024');
  const [count, setCount] = useState(1);
  const [filter, setFilter] = useState<'all' | ImageGenerationStatus>('all');
  const [selected, setSelected] = useState<ImageGeneration | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [nextCredits, nextGenerations] = await Promise.all([
        getImageCredits(),
        listImageGenerations(),
      ]);
      setCredits(nextCredits);
      setGenerations(nextGenerations);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        await ensureServerSession();
        if (cancelled) {
          return;
        }
        setIsAuthenticated(true);
        setLocalAuthenticated(true);
        setAuthReady(true);
        await reload();
      } catch {
        if (cancelled) {
          return;
        }
        setIsAuthenticated(false);
        setLocalAuthenticated(false);
        setAuthReady(true);
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [reload, setIsAuthenticated]);

  const visibleGenerations = useMemo(() => {
    if (filter === 'all') {
      return generations;
    }
    return generations.filter((generation) => generation.status === filter);
  }, [filter, generations]);

  const costPreview = estimateCost(model, size, count);
  const latestCompleted = generations.find((generation) => generation.status === 'completed');

  const handleGenerate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      Message.warning('请输入提示词');
      return;
    }
    setGenerating(true);
    try {
      const generation = await createImageGeneration({
        prompt: trimmed,
        model,
        size,
        n: count,
      });
      setGenerations((items) => [generation, ...items.filter((item) => item.id !== generation.id)]);
      setSelected(generation);
      setPrompt('');
      const nextCredits = await getImageCredits();
      setCredits(nextCredits);
      Message.success('图片生成完成');
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '生成失败');
      void reload();
    } finally {
      setGenerating(false);
    }
  };

  const handleLogout = () => {
    clearStoredSession();
    setIsAuthenticated(false);
    setLocalAuthenticated(false);
    setCredits(null);
    setGenerations([]);
  };

  if (!authReady) {
    return (
      <ConfigProvider locale={zhCN}>
        <div className={styles.loadingScreen}>
          <LoaderCircle className={styles.spin} size={30} />
          <span>正在连接 Woohoo 服务</span>
        </div>
      </ConfigProvider>
    );
  }

  if (!isAuthenticated) {
    return (
      <ConfigProvider locale={zhCN}>
        <Suspense fallback={null}>
          <AuthModal />
        </Suspense>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider locale={zhCN}>
      <div className={styles.shell}>
        <aside className={styles.historyPanel}>
          <div className={styles.panelHeader}>
            <div>
              <Text className={styles.eyebrow}>Image Studio</Text>
              <Title heading={5} className={styles.panelTitle}>
                生成历史
              </Title>
            </div>
            <Button
              size="small"
              icon={<RefreshCw size={14} />}
              onClick={() => void reload()}
              loading={loading}
              title="刷新"
            />
          </div>

          <Select
            value={filter}
            onChange={(value) => setFilter(value as 'all' | ImageGenerationStatus)}
            className={styles.filterSelect}
          >
            <Select.Option value="all">全部记录</Select.Option>
            <Select.Option value="completed">已完成</Select.Option>
            <Select.Option value="processing">生成中</Select.Option>
            <Select.Option value="failed">失败</Select.Option>
          </Select>

          <div className={styles.historyList}>
            {visibleGenerations.length === 0 ? (
              <Empty description="暂无生成记录" />
            ) : (
              visibleGenerations.map((generation) => (
                <button
                  key={generation.id}
                  className={`${styles.historyItem} ${
                    selected?.id === generation.id ? styles.historyItemActive : ''
                  }`}
                  type="button"
                  onClick={() => setSelected(generation)}
                >
                  <span className={styles.historyPrompt}>{generation.prompt}</span>
                  <span className={styles.historyMeta}>
                    <Tag size="small" color={STATUS_COLORS[generation.status]}>
                      {STATUS_LABELS[generation.status]}
                    </Tag>
                    {formatTime(generation.createdAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <main className={styles.workspace}>
          <header className={styles.topbar}>
            <div>
              <Title heading={3} className={styles.title}>
                Woohoo Image Studio
              </Title>
              <Text className={styles.subtitle}>文生图工作台</Text>
            </div>
            <div className={styles.topbarActions}>
              <div className={styles.creditBadge}>
                <WalletCards size={16} />
                <span>{credits ? credits.balance.toFixed(1) : '--'} Credits</span>
              </div>
              <Button size="small" icon={<LogOut size={14} />} onClick={handleLogout}>
                退出
              </Button>
            </div>
          </header>

          <section className={styles.gallery}>
            {generations.length === 0 ? (
              <div className={styles.emptyState}>
                <ImageIcon size={40} />
                <Title heading={5}>还没有图片</Title>
                <Text>输入提示词后生成第一张图。</Text>
              </div>
            ) : (
              generations.map((generation) => {
                const sources = imageSources(generation);
                const primary = sources[0];
                return (
                  <article key={generation.id} className={styles.resultCard}>
                    <button
                      className={styles.imageButton}
                      type="button"
                      onClick={() => setSelected(generation)}
                    >
                      {primary ? (
                        <img src={primary} alt={generation.prompt} />
                      ) : (
                        <div className={styles.imagePlaceholder}>
                          {generation.status === 'failed' ? (
                            <span>生成失败</span>
                          ) : (
                            <LoaderCircle className={styles.spin} size={22} />
                          )}
                        </div>
                      )}
                    </button>
                    <div className={styles.cardBody}>
                      <div className={styles.cardMeta}>
                        <Tag size="small" color={STATUS_COLORS[generation.status]}>
                          {STATUS_LABELS[generation.status]}
                        </Tag>
                        <span>{generation.size}</span>
                      </div>
                      <p>{generation.prompt}</p>
                      <div className={styles.cardActions}>
                        <Button
                          size="mini"
                          icon={<ImageIcon size={13} />}
                          onClick={() => setSelected(generation)}
                        >
                          预览
                        </Button>
                        {primary && (
                          <Button
                            size="mini"
                            icon={<Download size={13} />}
                            onClick={() => downloadImage(primary, `${generation.id}.png`)}
                          >
                            下载
                          </Button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </section>
        </main>

        <aside className={styles.controlPanel}>
          <div className={styles.panelHeader}>
            <div>
              <Text className={styles.eyebrow}>Prompt</Text>
              <Title heading={5} className={styles.panelTitle}>
                生成参数
              </Title>
            </div>
            {generating && <LoaderCircle className={styles.spin} size={18} />}
          </div>

          <label className={styles.field}>
            <span>提示词</span>
            <Input.TextArea
              value={prompt}
              onChange={setPrompt}
              placeholder="描述画面主体、风格、构图、光线和用途"
              autoSize={{ minRows: 6, maxRows: 10 }}
              maxLength={1200}
              showWordLimit
            />
          </label>

          <label className={styles.field}>
            <span>模型</span>
            <Select value={model} onChange={(value) => setModel(value)}>
              <Select.Option value="dall-e-3">DALL-E 3</Select.Option>
            </Select>
          </label>

          <label className={styles.field}>
            <span>尺寸</span>
            <Select value={size} onChange={(value) => setSize(value)}>
              {SIZE_OPTIONS.map((option) => (
                <Select.Option key={option.value} value={option.value}>
                  {option.label}
                </Select.Option>
              ))}
            </Select>
          </label>

          <label className={styles.field}>
            <span>数量</span>
            <InputNumber
              min={1}
              max={4}
              value={count}
              onChange={(value) => setCount(Number(value) || 1)}
            />
          </label>

          <div className={styles.costBox}>
            <span>预计消耗</span>
            <strong>{costPreview.toFixed(1)} Credits</strong>
          </div>

          <Button
            type="primary"
            size="large"
            icon={<Sparkles size={18} />}
            loading={generating}
            disabled={generating}
            long
            onClick={() => void handleGenerate()}
          >
            生成图片
          </Button>

          {latestCompleted && (
            <div className={styles.latestBlock}>
              <div className={styles.latestHeader}>
                <Clock3 size={14} />
                <span>最近完成</span>
              </div>
              <button type="button" onClick={() => setSelected(latestCompleted)}>
                {latestCompleted.prompt}
              </button>
            </div>
          )}
        </aside>

        <Modal
          visible={Boolean(selected)}
          onCancel={() => setSelected(null)}
          footer={null}
          title="图片详情"
          className={styles.detailModal}
        >
          {selected && (
            <div className={styles.detailContent}>
              <div className={styles.detailImages}>
                {imageSources(selected).length > 0 ? (
                  imageSources(selected).map((src, index) => (
                    <img key={`${selected.id}-${index}`} src={src} alt={selected.prompt} />
                  ))
                ) : (
                  <div className={styles.imagePlaceholder}>
                    {selected.errorMessage || '暂无图片结果'}
                  </div>
                )}
              </div>
              <div className={styles.detailMeta}>
                <Tag color={STATUS_COLORS[selected.status]}>{STATUS_LABELS[selected.status]}</Tag>
                <span>{selected.model}</span>
                <span>{selected.size}</span>
                <span>{selected.costCredits.toFixed(1)} Credits</span>
              </div>
              <p className={styles.detailPrompt}>{selected.prompt}</p>
              {selected.revisedPrompt && (
                <div className={styles.revisedPrompt}>
                  <div>
                    <span>Revised Prompt</span>
                    <Button
                      size="mini"
                      icon={<Copy size={13} />}
                      onClick={() => {
                        void navigator.clipboard.writeText(selected.revisedPrompt || '');
                        Message.success('已复制');
                      }}
                    >
                      复制
                    </Button>
                  </div>
                  <p>{selected.revisedPrompt}</p>
                </div>
              )}
              {selected.errorMessage && <p className={styles.errorText}>{selected.errorMessage}</p>}
            </div>
          )}
        </Modal>
      </div>
    </ConfigProvider>
  );
};

export default App;
