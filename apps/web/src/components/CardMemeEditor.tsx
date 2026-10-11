import { useEffect, useState } from 'react';
import type { MediaResourceV1, PostCardMeme } from '@reelforge/core';

import { ResourcePicker } from './ResourcePicker';
import styles from './CardMemeEditor.module.css';

export interface CardMemeEditorProps {
  readonly value?: PostCardMeme;
  readonly resources: readonly MediaResourceV1[];
  readonly isFinal?: boolean;
  readonly onApply: (meme: PostCardMeme) => void;
  readonly onClear: () => void;
}

export function CardMemeEditor({ value, resources, isFinal = false, onApply, onClear }: CardMemeEditorProps) {
  const selectedImagePath = value && 'imagePath' in value ? value.imagePath : undefined;
  const selectedVideoPath = value && 'videoPath' in value ? value.videoPath : undefined;
  const [imagePath, setImagePath] = useState(selectedImagePath ?? '');
  const [videoPath, setVideoPath] = useState(selectedVideoPath ?? '');
  const [soundPath, setSoundPath] = useState(value?.soundPath ?? '');

  useEffect(() => {
    setImagePath(selectedImagePath ?? '');
    setVideoPath(selectedVideoPath ?? '');
    setSoundPath(value?.soundPath ?? '');
  }, [selectedImagePath, selectedVideoPath, value?.soundPath]);

  const complete = imagePath ? Boolean(soundPath) : Boolean(videoPath);

  const clear = () => {
    setImagePath('');
    setVideoPath('');
    setSoundPath('');
    onClear();
  };

  const apply = () => {
    if (!complete) return;
    if (imagePath) {
      onApply({ imagePath, soundPath, ...getLayoutOverride(value, imagePath, undefined) });
      return;
    }
    if (videoPath) {
      const layoutOverride = getLayoutOverride(value, undefined, videoPath);
      onApply(soundPath ? { videoPath, soundPath, ...layoutOverride } : { videoPath, ...layoutOverride });
    }
  };

  return (
    <section className={styles.editor} aria-label="Sau card này">
      <div className={styles.header}>
        <div>
          <strong>Sau card này</strong>
          <p>{isFinal ? 'Meme kết thúc video' : 'Image cần sound; video có thể kèm sound'}</p>
        </div>
        {value && <span className={styles.applied}>Đã chọn</span>}
      </div>
      <div className={styles.fields}>
        <ResourcePicker label="Meme image" kind="meme-image" value={imagePath} resources={resources} onChange={(path) => { setImagePath(path ?? ''); if (path) setVideoPath(''); }} />
        <ResourcePicker label="Meme video" kind="meme-video" value={videoPath} resources={resources} onChange={(path) => { setVideoPath(path ?? ''); if (path) setImagePath(''); }} />
        <ResourcePicker label="Meme sound" kind="meme-sound" value={soundPath} resources={resources} onChange={(path) => setSoundPath(path ?? '')} />
      </div>
      <div className={styles.actions}>
        <button type="button" onClick={apply} disabled={!complete}>Áp dụng meme</button>
        <button type="button" onClick={clear} disabled={!value && !imagePath && !videoPath && !soundPath}>Xoá meme</button>
      </div>
    </section>
  );
}

function getLayoutOverride(value: PostCardMeme | undefined, imagePath: string | undefined, videoPath: string | undefined) {
  if (!value) return {};
  if ('imagePath' in value) return value.imagePath === imagePath && value.layout ? { layout: value.layout } : {};
  return value.videoPath === videoPath && value.layout ? { layout: value.layout } : {};
}
