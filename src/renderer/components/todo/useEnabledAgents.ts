export interface ResolvedAgent {
  agentId: 'pi';
  name: 'Pi';
  command: 'pi';
  isDefault: true;
  environment: 'native';
}

export function resolveAgent(): ResolvedAgent {
  return {
    agentId: 'pi',
    name: 'Pi',
    command: 'pi',
    isDefault: true,
    environment: 'native',
  };
}

/** The terminal agent surface is Pi-only; availability is guaranteed by packaged resources. */
export function useEnabledAgents(): ResolvedAgent[] {
  return [resolveAgent()];
}
