import { useEffect, useState } from 'react';

import { getServerAssetBlob } from '../lib/serverApi';
import type { Asset } from '../types';

export type AssetPreviewStatus = 'loading' | 'ready' | 'error';

export function isProtectedAssetUrl(assetId: string, assetUrl: string) {
  return assetUrl.includes(`/api/assets/${assetId}/file`) || assetUrl.includes('/uploads/');
}

export function useAssetPreviewUrl(asset: Pick<Asset, 'id' | 'url'>) {
  const protectedAsset = isProtectedAssetUrl(asset.id, asset.url);
  const [previewUrl, setPreviewUrl] = useState<string | null>(protectedAsset ? null : asset.url);
  const [status, setStatus] = useState<AssetPreviewStatus>(protectedAsset ? 'loading' : 'ready');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isProtectedAssetUrl(asset.id, asset.url)) {
      setPreviewUrl(asset.url);
      setStatus('ready');
      setError(null);
      return undefined;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    setPreviewUrl(null);
    setStatus('loading');
    setError(null);

    void getServerAssetBlob(asset.id)
      .then((blob) => {
        if (cancelled) {
          return;
        }
        objectUrl = window.URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
        setStatus('ready');
      })
      .catch((caughtError) => {
        if (cancelled) {
          return;
        }
        setPreviewUrl(null);
        setStatus('error');
        setError(caughtError instanceof Error ? caughtError.message : '资产文件无法预览');
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        window.URL.revokeObjectURL(objectUrl);
      }
    };
  }, [asset.id, asset.url]);

  return { previewUrl, status, error, protectedAsset };
}
