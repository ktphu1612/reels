import type { TtsSynthesisRequest } from '@reelforge/core';

export function createBaseSynthesisRequest(request: TtsSynthesisRequest): TtsSynthesisRequest {
  return { ...request, speakingRate: 1 };
}
