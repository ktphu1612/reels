import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { MediaResourceV1, PostCardMeme } from '@reelforge/core';
import { CardMemeEditor } from './CardMemeEditor';

const resources: MediaResourceV1[] = [
  {
    schemaVersion: 1,
    id: 'meme-image-1',
    name: 'Confused.png',
    kind: 'meme-image',
    assetPath: 'assets/confused.png',
  },
  {
    schemaVersion: 1,
    id: 'meme-sound-1',
    name: 'Bonk.mp3',
    kind: 'meme-sound',
    assetPath: 'assets/bonk.mp3',
  },
  {
    schemaVersion: 1,
    id: 'meme-video-1',
    name: 'Reaction.mp4',
    kind: 'meme-video',
    assetPath: 'assets/reaction.mp4',
  },
  {
    schemaVersion: 1,
    id: 'meme-sound-2',
    name: 'Whoosh.mp3',
    kind: 'meme-sound',
    assetPath: 'assets/whoosh.mp3',
  },
];

describe('CardMemeEditor', () => {
  it('applies a meme only after both image and sound are selected', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<(meme: PostCardMeme) => void>();

    render(<CardMemeEditor value={undefined} resources={resources} onApply={onApply} onClear={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('Meme image'), 'assets/confused.png');
    expect(screen.getByRole('button', { name: 'Áp dụng meme' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Meme sound'), 'assets/bonk.mp3');
    await user.click(screen.getByRole('button', { name: 'Áp dụng meme' }));

    expect(onApply).toHaveBeenCalledWith({ imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3' });
  });

  it('clears the complete pair atomically', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <CardMemeEditor
        value={{ imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3' }}
        resources={resources}
        onApply={vi.fn()}
        onClear={onClear}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Xoá meme' }));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Meme image')).toHaveValue('');
    expect(screen.getByLabelText('Meme sound')).toHaveValue('');
  });

  it('applies a video meme without requiring an extra sound', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<(meme: PostCardMeme) => void>();

    render(<CardMemeEditor value={undefined} resources={resources} onApply={onApply} onClear={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('Meme video'), 'assets/reaction.mp4');
    expect(screen.getByRole('button', { name: 'Áp dụng meme' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Áp dụng meme' }));

    expect(onApply).toHaveBeenCalledWith({ videoPath: 'assets/reaction.mp4' });
  });

  it('preserves the existing layout when only a meme sound changes', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<(meme: PostCardMeme) => void>();
    const existingLayout = { x: 0.2, y: 0.25, width: 0.45, height: 0.3 };

    render(
      <CardMemeEditor
        value={{ videoPath: 'assets/reaction.mp4', soundPath: 'assets/bonk.mp3', layout: existingLayout }}
        resources={resources}
        onApply={onApply}
        onClear={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Meme sound'), 'assets/whoosh.mp3');
    await user.click(screen.getByRole('button', { name: 'Áp dụng meme' }));

    expect(onApply).toHaveBeenCalledWith({
      videoPath: 'assets/reaction.mp4',
      soundPath: 'assets/whoosh.mp3',
      layout: existingLayout,
    });
  });

  it('drops the existing layout when the selected visual path changes', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<(meme: PostCardMeme) => void>();
    const existingLayout = { x: 0.2, y: 0.25, width: 0.45, height: 0.3 };

    render(
      <CardMemeEditor
        value={{ videoPath: 'assets/reaction.mp4', soundPath: 'assets/bonk.mp3', layout: existingLayout }}
        resources={resources}
        onApply={onApply}
        onClear={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Meme image'), 'assets/confused.png');
    await user.click(screen.getByRole('button', { name: 'Áp dụng meme' }));

    expect(onApply).toHaveBeenCalledWith({ imagePath: 'assets/confused.png', soundPath: 'assets/bonk.mp3' });
  });
});
