export type ProjectConfiguratorValues = {
  address?: string | null;
}

export interface ProjectConfiguratorRpc {
  /** The canonical address of the Project typed in, or throws when it isn't one. */
  resourceUrl(address: string | null | undefined): Promise<string>;
}
