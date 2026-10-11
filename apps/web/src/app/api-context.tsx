import { createContext, useContext, type ReactNode } from 'react';

import { createApiClient, type ApiClient } from '../lib/api';

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { readonly client: ApiClient; readonly children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error('ApiProvider is missing');
  return client;
}

export const defaultApiClient = createApiClient();
