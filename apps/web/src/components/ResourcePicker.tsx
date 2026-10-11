import { useId } from 'react';
import type { MediaResourceKind, MediaResourceV1 } from '@reelforge/core';

import { assetUrl } from '../lib/api';
import styles from './ResourcePicker.module.css';

export interface ResourcePickerProps {
  readonly label: string;
  readonly kind: MediaResourceKind;
  readonly value?: string;
  readonly resources: readonly MediaResourceV1[];
  readonly allowNone?: boolean;
  readonly onChange: (assetPath: string | undefined) => void;
}

export function ResourcePicker({ label, kind, value, resources, allowNone = true, onChange }: ResourcePickerProps) {
  const options = resources.filter((resource) => resource.kind === kind);
  const selected = options.find((resource) => resource.assetPath === value);
  const uniqueId = useId();
  const inputId = `resource-${kind}-${uniqueId.replaceAll(':', '')}`;

  return (
    <div className={styles.picker}>
      <label className={styles.label} htmlFor={inputId}>{label}</label>
      <select
        id={inputId}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">{allowNone ? 'Không chọn' : 'Chọn tài nguyên'}</option>
        {options.map((resource) => <option key={resource.id} value={resource.assetPath}>{resource.name}</option>)}
      </select>
      {selected?.kind === 'meme-image' && <img className={styles.thumbnail} src={assetUrl(selected.assetPath)} alt={selected.name} />}
      {selected?.kind === 'meme-video' && <video className={styles.thumbnail} muted playsInline preload="metadata" src={assetUrl(selected.assetPath)} aria-label={`${label} preview`} />}
      {selected && selected.kind !== 'meme-image' && selected.kind !== 'meme-video' && <audio className={styles.audio} controls preload="metadata" src={assetUrl(selected.assetPath)} aria-label={`${label} preview`} />}
      {!selected && options.length === 0 && <p className={styles.empty}>Chưa có tài nguyên trong thư mục.</p>}
    </div>
  );
}
